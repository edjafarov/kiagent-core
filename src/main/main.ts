import fs from 'fs';
import path from 'path';
import v8 from 'v8';

import {
  BrowserWindow,
  Notification,
  app,
  crashReporter,
  dialog,
  ipcMain,
  nativeImage,
  powerMonitor,
  safeStorage,
  screen,
  shell,
} from 'electron';
import type { Tray } from 'electron';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log/main';

import type { AccountId, SchedulerEnv } from '@shared/contracts';
import type {
  CoreInvokeChannel,
  InvokeHandlers,
  Invokes,
  PushChannel,
  Pushes,
} from '@shared/ipc';
import { INVOKE_CHANNELS, isProductInvokeChannel } from '@shared/ipc';
import { windowChrome } from './window-chrome';
import { installQuitSignalHandlers } from './quit-signals';

import { installCrashHandlers, type CrashDeps } from './crash-handlers';
import { startHeapWatch } from './heap-watch';
import { removeAccountFully, runAccount, setAccountCadence } from './core/boot';
import { inForeground } from './core/admission';
import { markOnboardingOnce } from './core/prefs';
import { maybeOfferMoveToApplications } from './move-to-applications';
import { createInstallLinks } from './install-links';
import { SYNC_REFUSED_PUSH } from './core/sync/forward-core';
import { installSettingsSync } from './core/sync/settings-sync';
import { newId } from './core/ids';
import {
  createLeaderRunners,
  wrapAccountChannels,
} from './core/sync/accounts-relay';
import { runCommitBatch, type CommitInput } from './core/sync/owned';
import {
  validateAttentionActRequest,
  validateAttentionListRequest,
} from './attention/ipc-request';
import { createTrustedRendererPredicate, guardIpcHandler } from './ipc-sender';
import { createUpdater } from './updater/updater';
import { createUpdateNotifier } from './updater/native-notify';
import { subscribeUpdaterState, updaterInvokeHandlers } from './updater/ipc';
import { runFactoryReset } from './factory-reset';
import { corpusRefusalDialog, handleBootFailure } from './corpus-recovery';
import { createExtInvokeHandler } from './platform/ext-invoke';
import { createBootTimer } from './core/boot-timing';
import { outboundInvokeHandlers } from './outbound/ipc';
import { calendarOutInvokeHandlers } from './calendar-out/ipc';
import { loadProductConfig } from './product';
import {
  createRuntime,
  EXTENSION_RETRY_MS,
  RuntimeStopped,
  syncExtensions,
  type Runtime,
  type RuntimeHandles,
  type RuntimeHost,
} from './runtime';
import { createInstallRegistry } from './providers/install-registry';
import { CURATED_TIERS, modelTotalBytes } from './providers/local-llm/models';
import { countFiles } from './sources/local-folder/scanner';
import {
  listChildren,
  listDrives,
  quickLinks,
} from './sources/local-folder/tree';
import { createTray } from './tray';
import type { TrayMenuController } from './tray-menu';
import { installCloseToTray } from './close-to-tray';
import { resolveHtmlPath } from './util';
import { makeNativeImageDownscaler } from './workers/vision/downscale';

let mainWindow: BrowserWindow | null = null;
let runtime: Runtime | null = null;
/** The runtime's services, once built. */
let handles: RuntimeHandles | null = null;
// Must stay referenced for the app's lifetime or GC destroys the icon.
let tray: Tray | null = null;
let trayMenu: TrayMenuController | null = null;
// Set the moment a quit starts (before-quit, below): close-to-tray reads it
// so the teardown's own app.quit() closes the window instead of hiding it.
let quitting = false;
const bootTimer = createBootTimer((line) => log.info(line));

// Test/dev escape hatch: point ALL app storage somewhere disposable.
if (process.env.KIAGENT_USER_DATA) {
  app.setPath('userData', process.env.KIAGENT_USER_DATA);
} else if (!app.isPackaged) {
  // Pin a dedicated dev dir (the default would be the package.json app
  // name's dir), distinct from the packaged app's 'KIAgent' so a real
  // install and a dev tree never share state.
  app.setPath('userData', path.join(app.getPath('appData'), 'KIAgent-dev'));
}

// Crash visibility is wired before anything else can fail. In a packaged build
// console output goes nowhere, so without this a boot failure is "no window
// appeared" and an uncaught exception is a silent disappearance. Placed after
// the userData overrides above so the log path follows them.
/** Read lazily: the crash handlers are installed before the product loads. */
function headless(): boolean {
  try {
    return product.headless === true;
  } catch {
    return false;
  }
}

const crashDeps: CrashDeps = {
  logDir: path.join(app.getPath('userData'), 'data', 'logs'),
  sink: () => handles?.platform.logSink ?? null,
  showErrorBox: (title, content) => {
    // No display to draw a box on: the crash log already has it.
    if (headless()) log.error(`${title}: ${content}`);
    else dialog.showErrorBox(title, content);
  },
  exit: (code) => app.exit(code),
  onAppEvent: (event, handler) => {
    app.on(event as never, handler as never);
  },
};
installCrashHandlers(crashDeps);
// Native crashes (renderer/GPU/utility) never reach a JS handler. Minidumps
// stay on the machine — nothing is uploaded — and land in app.getPath('crashDumps').
crashReporter.start({ uploadToServer: false });
// A V8 out-of-memory abort leaves no JS trace at all — only Crashpad
// annotations, after the fact. The periodic sample is what turns "it died
// overnight" into a growth curve. Snapshots stay behind an env gate: the write
// freezes the main thread and the file is heap-sized.
startHeapWatch({
  logDir: crashDeps.logDir,
  dataDir: path.join(app.getPath('userData'), 'data'),
  sink: () => handles?.platform.logSink ?? null,
  getHeapStatistics: () => v8.getHeapStatistics(),
  rss: () => process.memoryUsage.rss(),
  writeHeapSnapshot: (file) => {
    v8.writeHeapSnapshot(file);
  },
  snapshotEnabled: process.env.KIA_HEAP_SNAPSHOT === '1',
});

// Product identity (spec 2026-07-07 §3.1.4): OSS ships no product.json and
// runs on DEFAULT_PRODUCT; a product build drops one into resources. Loaded
// once, early, so both the bundled-extensions dir and user-facing strings
// (e.g. Notification titles) derive from the same resolved config.
const product = loadProductConfig(
  [
    process.env.KIA_PRODUCT_CONFIG,
    app.isPackaged ? process.resourcesPath : null,
    app.getAppPath(),
  ],
  (msg) => console.warn(msg),
);
const resourceRoot = app.isPackaged ? process.resourcesPath : app.getAppPath();
const bundledExtensionsDir = path.resolve(
  resourceRoot,
  product.bundledExtensionsDir ?? 'bundled-extensions',
);

// The launchAtLogin pref maps to an OS login item (macOS/Windows). Packaged
// builds only: in dev this would register the bare Electron binary to run at
// every sign-in. Read-before-write so an unchanged pref never re-registers
// (macOS 13+ surfaces a "runs in the background" notice on registration).
function applyLoginItemSettings(launchAtLogin: boolean): void {
  if (!app.isPackaged) return;
  if (app.getLoginItemSettings().openAtLogin !== launchAtLogin)
    app.setLoginItemSettings({ openAtLogin: launchAtLogin });
}

// `kiagent://install` links (spec §8), product-gated. Created before the
// single-instance lock so a link on the very first launch is kept.
const installLinks = createInstallLinks({
  scheme: product.urlScheme,
  show: () => showMainWindow(),
  nudge: () => broadcast('push:install-link', undefined),
  log: (m) => log.info(m),
});
if (product.urlScheme && app.isPackaged)
  app.setAsDefaultProtocolClient(product.urlScheme);
// macOS delivers links here, possibly before `ready`: registered at load.
app.on('open-url', (event, url) => {
  event.preventDefault();
  installLinks.offer(url);
});
// Windows/Linux: a link that launched the app is an argument.
installLinks.offerArgv(process.argv);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // Launching the app again is how a user asks for the window back once it is
  // hidden in the tray (close-to-tray, Windows/Linux) — without this the
  // second launch would just exit and nothing would appear. On
  // Windows/Linux a clicked link arrives this way too.
  app.on('second-instance', (_e, argv) => {
    installLinks.offerArgv(argv);
    showMainWindow();
  });
}

function broadcast<C extends PushChannel>(
  channel: C,
  payload: Pushes[C],
): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}

function schedulerEnv(): SchedulerEnv {
  const thermalMap: Record<string, SchedulerEnv['thermal']> = {
    nominal: 'nominal',
    fair: 'fair',
    serious: 'serious',
    critical: 'serious',
    unknown: 'nominal',
  };
  let thermal: SchedulerEnv['thermal'] = 'nominal';
  try {
    thermal = thermalMap[powerMonitor.getCurrentThermalState()] ?? 'nominal';
  } catch {
    // not supported on this platform
  }
  const focused = mainWindow?.isFocused() ?? false;
  const visible = mainWindow?.isVisible() ?? false;
  return {
    onBattery: powerMonitor.isOnBatteryPower(),
    thermal,
    appFocus: focused ? 'focused' : visible ? 'unfocused' : 'hidden',
    userActive: powerMonitor.getSystemIdleTime() < 60,
  };
}

function makeEncryption() {
  const canEncrypt = safeStorage.isEncryptionAvailable();
  if (!canEncrypt) {
    // NOT a dev-only path: on macOS a locked login keychain (IT password
    // rotation) or a denied Keychain prompt lands here in production
    // (observed in the wild 2026-08-07). Deliberate fail-open: source
    // credentials keep working, stored obfuscated rather than encrypted —
    // disclosed on localkiagent.com/data. Loud so it is never invisible:
    // this line is the difference between a documented tradeoff and a
    // hidden one.
    log.warn(
      '[encryption] OS keystore unavailable (locked keychain or denied prompt) — ' +
        'credentials will be stored obfuscated, NOT encrypted, until the app ' +
        'restarts with the keystore accessible',
    );
  }
  return {
    encrypt(plain: string): Buffer {
      if (canEncrypt) {
        try {
          return safeStorage.encryptString(plain);
        } catch (e) {
          // isEncryptionAvailable() lied (keystore revoked mid-session) —
          // same documented fallback, same loud trail.
          log.warn(
            '[encryption] encryptString failed — storing obfuscated:',
            e,
          );
        }
      }
      return Buffer.from(`plain:${plain}`, 'utf8');
    },
    /** For logins that arrive from another device: no obfuscation fallback.
     *  Availability can lie (a keystore revoked mid-session), so this throws
     *  from the real call too, and the offer is refused whole. */
    encryptStrict(plain: string): Buffer {
      if (!canEncrypt) throw new Error('OS keystore unavailable');
      return safeStorage.encryptString(plain);
    },
    keystoreAvailable(): boolean {
      return canEncrypt;
    },
    decrypt(blob: Buffer): string {
      const s = blob.toString('utf8');
      if (s.startsWith('plain:')) return s.slice('plain:'.length);
      try {
        return safeStorage.decryptString(blob);
      } catch (e) {
        // Never silent: a keystore refusal here surfaces to the caller (the
        // source shows a reconnect error) but leaves a diagnosable trail —
        // the absence of exactly this line cost a day of broker-side
        // forensics on 2026-08-07.
        log.warn('[encryption] decryptString failed (OS keystore):', e);
        throw e;
      }
    },
  };
}

const noTray: TrayMenuController = { addItems: () => () => {} };

/** What the runtime asks of the process around it. A headless product has no
 *  window, tray or dialogs: questions get the answer that changes nothing. */
function runtimeHost(): RuntimeHost {
  return {
    userDataDir: app.getPath('userData'),
    isPackaged: app.isPackaged,
    product,
    bundledExtensionsDir,
    assetPath: getAssetPath,
    app,
    encryption: makeEncryption(),
    env: schedulerEnv,
    // Built HERE so the worker and its module stay Electron-free.
    downscale: makeNativeImageDownscaler(nativeImage),
    notifyRenderer: broadcast,
    tray: () => trayMenu ?? noTray,
    openWindow: showMainWindow,
    notify: (msg) => {
      if (headless()) log.info(`[notify] ${msg}`);
      else new Notification({ title: product.productName, body: msg }).show();
    },
    trashItem: (file) => shell.trashItem(file),
    confirm: async (o) => {
      if (headless()) return false;
      const res = await dialog.showMessageBox({
        type: 'warning',
        message: o.message,
        detail: o.detail,
        buttons: [o.confirmLabel, o.cancelLabel],
        defaultId: 0,
        cancelId: 1,
      });
      return res.response === 0;
    },
    inform: (o) => {
      if (headless()) log.info(`[inform] ${o.message}: ${o.detail}`);
      else void dialog.showMessageBox(o);
    },
    onPrefs: (prefs) => applyLoginItemSettings(prefs.launchAtLogin),
    bootTimer,
    log,
  };
}

function getAssetPath(...paths: string[]): string {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'assets')
    : path.join(__dirname, '../../assets');
  return path.join(base, ...paths);
}

/** Grace period for compositing before we show the window regardless. Long
 *  enough that a healthy-but-slow machine still shows a painted frame first,
 *  short enough that a broken GL stack does not look like a hung app. */
const WINDOW_SHOW_FALLBACK_MS = 5000;

async function createWindow(): Promise<void> {
  if (headless()) return;
  mainWindow = new BrowserWindow({
    show: false,
    ...windowChrome(process.platform, screen.getPrimaryDisplay().workAreaSize),
    backgroundColor: '#fafafa',
    icon: getAssetPath('icon.png'),
    titleBarStyle: 'hidden',
    webPreferences: {
      // Packaged and unpackaged-prod runs have preload.js beside main.js;
      // the dev server serves it from the dll dir.
      preload: [
        path.join(__dirname, 'preload.js'),
        path.join(__dirname, '../../.erb/dll/preload.js'),
      ].find((f) => fs.existsSync(f)),
    },
  });
  // Normal path: Chromium fires ready-to-show once the first frame has been
  // composited, so the window never appears as an empty white rectangle.
  //
  // Fallback: that event depends on the GPU/compositor actually delivering a
  // frame. Where the GL stack is broken but the app is otherwise healthy —
  // a VM with a non-functional virtio-gpu/Mesa, a remote session, a headless
  // compositor — no frame ever arrives, ready-to-show never fires, and the
  // window stays hidden forever with no error anywhere. did-finish-load means
  // the renderer has loaded the page, so showing is safe from then on; we give
  // compositing a grace period first and only then force it visible.
  // showOnce() is idempotent, so on a healthy machine (every normal macOS and
  // Windows run) ready-to-show wins the race and the timer is a no-op.
  let shown = false;
  const showOnce = (): void => {
    if (shown || !mainWindow || mainWindow.isDestroyed()) return;
    shown = true;
    mainWindow.show();
    bootTimer.mark('window shown');
  };
  let showFallback: NodeJS.Timeout | undefined;
  mainWindow.on('ready-to-show', showOnce);
  mainWindow.webContents.once('did-finish-load', () => {
    showFallback = setTimeout(showOnce, WINDOW_SHOW_FALLBACK_MS);
  });
  mainWindow.on('closed', () => {
    if (showFallback) clearTimeout(showFallback);
    mainWindow = null;
  });
  // Windows/Linux: X hides to the tray instead of quitting the app.
  installCloseToTray(mainWindow, {
    platform: process.platform,
    isQuitting: () => quitting,
  });
  // Guidance-step "Open ↗" buttons (and marketplace README links) call
  // window.open — route https to the system browser, never spawn a child
  // BrowserWindow. Deny everything else (extension-supplied URLs are
  // filtered to https at parse time, but this is the backstop).
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  // Block in-window navigation away from the app (e.g. a dragged link).
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow?.webContents.getURL()) {
      event.preventDefault();
      if (url.startsWith('https://')) void shell.openExternal(url);
    }
  });
  await mainWindow.loadURL(resolveHtmlPath('index.html'));
}

/**
 * Bring the window back. Shared by the tray's "Open KIAgent",
 * MainProcessApi.ui.openWindow (extension escape hatches like remote-mcp's
 * "Fix connection…") and a second launch of the app.
 */
function showMainWindow(): void {
  if (headless()) return;
  if (!mainWindow) {
    void createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** Everything the renderer can ask for, over the typed contract. */
function registerIpc(h: RuntimeHandles): void {
  const {
    platform: p,
    patchState,
    bundled,
    extensions,
    catalog,
    broker,
    outbound,
    calendarOut,
    attention,
    refreshWaiting,
    mcp,
    activity,
  } = h;
  const getLastPush = h.lastPush;
  // Hoisted above the handler map only because the map needs `updater`;
  // extracting the rest of the updater bootstrap out of registerIpc is #20.
  log.transports.file.level = 'info';
  if (product.updateFeedUrl) {
    try {
      autoUpdater.setFeedURL(product.updateFeedUrl);
    } catch (e) {
      log.warn('[updater] setFeedURL failed', e);
    }
  }
  const updater = createUpdater({
    autoUpdater,
    log,
    isPackaged: app.isPackaged,
    platform: process.platform,
    currentVersion: app.getVersion(),
    devUpdates: process.env.KIAGENT_DEV_UPDATES === '1',
    macUpdatesEnabled: product.macUpdatesEnabled === true,
  });

  // Built once, near where the bundled providers are registered — the
  // dispatch map behind inference:install/cancel (install-registry.ts).
  const installable = createInstallRegistry({
    'local-llm': bundled.localLlm,
    'local-asr': bundled.localAsr,
  });

  /**
   * One handler per declared channel — the completeness check itself. An
   * `InvokeChannel` with no entry here is a tsc error (TS2740) rather than
   * Electron's runtime "No handler registered", which is what a channel
   * declared in `Invokes` and then forgotten used to cost.
   *
   * The two seams contribute `Pick`s rather than registering their own
   * channels; spreads into an annotated literal are completeness-checked, so
   * they compose without opening a hole.
   */
  const handlers: InvokeHandlers = {
    'app:get-state': () => getLastPush(),
    // Account-scoped siblings of accounts:add. They take an accountId, so the
    // broker claims the account's flow slot BEFORE doing any work — and their
    // cancel path never calls engine.remove.
    'accounts:start-reconnect': ({ accountId, oauthClient }) =>
      broker.startReconnect(accountId, { oauthClient }),
    'accounts:start-manage-folders': ({ accountId }) =>
      broker.startManageFolders(accountId),
    'sources:list': () => p.sources.list(),
    'sources:count-files': async ({ path: rawPath }) => {
      const resolved = path.resolve(rawPath);
      try {
        const st = await fs.promises.stat(resolved);
        if (!st.isDirectory()) return null;
      } catch {
        return null;
      }
      return countFiles(resolved);
    },
    'sources:list-folders': async (req) => {
      if ('special' in req) {
        return {
          entries:
            req.special === 'quick' ? await quickLinks() : await listDrives(),
        };
      }
      return { entries: await listChildren(path.resolve(req.path)) };
    },

    'accounts:add': ({ sourceId, oauthClient }) =>
      broker.start(sourceId, { oauthClient }),
    'accounts:add-group': ({ sourceIds, scopes, oauthClient }) =>
      broker.startGroup(sourceIds, { scopes, oauthClient }),
    'accounts:prompt-answer': ({ requestId, answers }) => {
      broker.answer(requestId, answers);
    },
    'accounts:cancel-flow': ({ flowId }) => {
      broker.cancel(flowId);
    },
    'accounts:picker-roots': ({ requestId, mode }) =>
      broker.pickerRoots(requestId, mode),
    'accounts:picker-children': ({ requestId, id }) =>
      broker.pickerChildren(requestId, id),
    'accounts:picker-count': ({ requestId, id }) =>
      broker.pickerCount(requestId, id),
    'accounts:picker-confirm': ({ requestId, nodes }) => {
      broker.pickerConfirm(requestId, nodes);
    },
    'accounts:picker-cancel': ({ requestId }) => {
      broker.pickerCancel(requestId);
    },
    'accounts:remove': async ({ accountId }) => {
      await removeAccountFully(p, accountId);
    },
    'accounts:pause': async ({ accountId }) => {
      // Delegate to engine.pause: it aborts any in-flight sync loop before
      // committing 'paused', so an active backfill can't flip the status back on
      // its next batch commit. A bare status-only commit here caused the account
      // to silently resume mid-backfill.
      await p.engine.pause(accountId);
    },
    'accounts:resume': async ({ accountId }) => {
      // Delegate to engine.resume: it clears any in-flight pause intent and
      // commits 'connecting' BEFORE the loop starts — engine.run refuses
      // paused/pausing accounts, and an explicit user resume is the one door
      // back in.
      const account = await p.engine.resume(accountId);
      if (account) h.startAccount(account);
    },
    'accounts:sync-now': async ({ accountId }) => {
      const account = await p.store.account(accountId);
      // Never start a paused account: sync-now must not undo an explicit pause
      // (resume is the only door), and this also keeps the cadence job from
      // being registered for it. engine.run re-checks the pause intent and the
      // committed status, so a pause landing between this read and the run is
      // still refused.
      if (account && account.status !== 'paused') h.startAccount(account);
    },
    'accounts:set-cadence': ({ accountId, cadence }) =>
      // Delegates to core/boot so the resting-state rule ('paused' AND
      // 'needsReauth' persist the cadence but start nothing) lives in one
      // place, next to the cadence tick's identical gate.
      setAccountCadence(p, accountId, cadence),
    'accounts:update-config': ({ accountId, config }) =>
      p.engine.updateConfig(accountId, config),
    'accounts:set-option': ({ accountId, key, value }) =>
      p.engine.setOption(accountId, key, value),
    'accounts:update-outbound': async ({
      accountId,
      outbound: outboundCfg,
    }) => {
      const account = await p.store.account(accountId);
      if (!account) return;
      // Store-direct on purpose: engine.updateConfig would restart a running
      // pull and grant a reconcile allowance — outbound settings are invisible
      // to sources, so neither is wanted.
      await p.store.setAccountConfig(accountId, {
        ...account.config,
        outbound: outboundCfg,
      });
    },

    // Renderer reads are foreground (#147 §2): sync units wait meanwhile.
    'search:query': (req) =>
      inForeground(p.admission, () => p.readsFor('renderer').search(req ?? {})),
    'docs:get': ({ id }) =>
      inForeground(p.admission, () => p.readsFor('renderer').document(id)),
    'docs:children': ({ id }) =>
      inForeground(p.admission, () => p.readsFor('renderer').children(id)),

    'attention:list': (req) =>
      attention.list(validateAttentionListRequest(req)),
    'attention:act': (req) => attention.act(validateAttentionActRequest(req)),

    // B1: NOT actually reached through `dispatch` in production — this
    // channel is registered directly below, past its own never-reject
    // handler (`createExtInvokeHandler`), because `guardIpcHandler`'s
    // generic sender gate THROWS on an untrusted sender and `ext:invoke`
    // must always resolve an envelope instead. This entry exists only so
    // `handlers` stays a complete, tsc-checked `InvokeHandlers` map — see
    // the `INVOKE_CHANNELS` loop below, which skips this one channel.
    //
    // Deliberately INERT rather than a working fallback: if the loop's
    // `channel === 'ext:invoke' ? extInvokeHandler : …` ternary is ever
    // removed, `ext:invoke` would fall through to `guardIpcHandler`, which
    // calls straight into THIS function on a trusted sender — and if this
    // called `extensions.callUi` directly, that would bypass
    // `createExtInvokeHandler`'s own request validation and its
    // structured-clone guard on the result (see ext-invoke.ts), reintroducing
    // exactly the hang that guard exists to prevent. A fixed, harmless
    // envelope here means that mutant fails loudly (every ext:invoke calls
    // through this message) instead of silently reopening the hole.
    'ext:invoke': () => ({
      ok: false,
      code: 'EXT_MALFORMED_REQUEST',
      message: 'ext:invoke is served by its dedicated handler',
    }),

    'prefs:get': () => p.prefs.get(),
    'prefs:patch': async (patch) => {
      await p.prefs.patch(patch ?? {});
      return p.prefs.get();
    },

    'identity:get': () => p.store.identity.get(),
    'identity:set': async (identity) => {
      await p.store.identity.set(identity);
      // Identity lives outside the feed — re-push state or the sign-in gate
      // would never open.
      patchState({ identity });
    },

    'logs:recent': async (req) => {
      const it = p.logs.tail(req ?? undefined)[Symbol.asyncIterator]();
      const first = await it.next(); // first yield = the in-memory ring
      await it.return?.(undefined as never);
      return first.done ? [] : first.value;
    },
    'logs:export': () => p.logs.export(),
    'mcp-activity:recent': async () => activity.recent() ?? [],

    'mcp:info': async () => ({
      port: mcp.port ?? null,
      clients: (await mcp.clients()) ?? [],
    }),
    'mcp:connect-client': async ({ id }) => {
      await mcp.connectClient(id);
      markOnboardingOnce(p.prefs, 'mcpConnectedAt').catch(() => {});
    },
    'mcp:disconnect-client': async ({ id }) => {
      await mcp.disconnectClient(id);
    },

    'scheduler:jobs': () => p.scheduler.jobs(),
    'scheduler:trigger': ({ id }) => p.scheduler.trigger(id),

    'storage:stats': async () => {
      const dataDir = path.join(app.getPath('userData'), 'data');
      let dbBytes = 0;
      for (const f of ['kiagent.db', 'kiagent.db-wal']) {
        try {
          dbBytes += fs.statSync(path.join(dataDir, f)).size;
        } catch {
          // file may not exist yet
        }
      }
      const accounts = await p.store.read.accounts();
      return {
        dbBytes,
        docCount: await p.store.read.count({ includeArchived: true }),
        accountCount: accounts.filter((a) => a.source !== 'worker').length,
        dataDir,
        dbDiagnostics: (await p.db.plugin?.({ op: 'diagnostics' })) ?? null,
        readDiagnostics: await p.readDiagnostics(mcp.sqlDiagnostics() ?? null),
      };
    },
    'storage:added-24h': () =>
      p.store.addedSince(new Date(Date.now() - 24 * 3_600_000).toISOString()),
    'maintenance:compact': () => p.store.maintenance.compact(),
    'maintenance:export': async ({ destDir }) => {
      let dir = destDir;
      if (!dir) {
        const res = await dialog.showOpenDialog({
          properties: ['openDirectory', 'createDirectory'],
        });
        if (res.canceled || !res.filePaths[0]) return;
        [dir] = res.filePaths;
      }
      await p.store.maintenance.export(dir);
    },
    'maintenance:reset-all': () => runFactoryReset(h.factoryResetDeps()),

    'inference:routes': () => p.inference.routes(),
    'inference:providers': () =>
      p.inference.providers().map((prov) => ({
        id: prov.id,
        supports: prov.supports,
        status: prov.status(),
        remote: prov.remote === true,
        installable: installable.installable(prov.id),
        ...(bundled.missingBinaries.includes(prov.id)
          ? { notInstalled: { devBuild: !app.isPackaged } }
          : {}),
        ...(prov.id === 'local-asr'
          ? { variants: bundled.localAsr.variants() }
          : {}),
      })),
    'inference:install': async ({ providerId, variant }) => {
      if (!installable.installable(providerId)) return; // unknown id: no-op
      await p.prefs.patch({
        models: { ...p.prefs.get().models, autoInstall: true },
      });
      if (variant === 'accuracy') {
        // Explicit-only: never reached from ensureInstalled(); local-asr is
        // the only provider with a variant today.
        if (providerId === 'local-asr')
          bundled.localAsr.ensureAccuracyInstalled();
        return;
      }
      installable.install(providerId);
    },
    'inference:cancel': async () => {
      await installable.cancelAll();
      await p.prefs.patch({
        models: { ...p.prefs.get().models, autoInstall: false },
      });
    },
    'inference:stats': async () => {
      // One waiting computation for both surfaces: recompute and push, so
      // opening Settings also refreshes the sidebar row.
      void refreshWaiting();
      return p.store.extractionStats();
    },
    'inference:models': async () => {
      const installed = bundled.localLlm.installedModelIds();
      const sel = await bundled.localLlm.selectedModel();
      return {
        options: CURATED_TIERS.map((t) => ({
          id: t.model.id,
          label: t.model.label,
          totalBytes: modelTotalBytes(t.model),
          installed: installed.includes(t.model.id),
        })),
        selectedId: sel.id,
      };
    },

    'app:info': () => ({
      version: app.getVersion(),
      platform: process.platform,
      productName: product.productName,
    }),
    'app:open-path': ({ path: target }) => {
      shell.showItemInFolder(target);
    },

    'marketplace:list': () => catalog.list(),
    'marketplace:detail': ({ owner, repo }) => catalog.detail(owner, repo),
    'marketplace:check-updates': () => catalog.checkUpdates(),

    'extension:install-preview': ({ ref }) => extensions.installPreview(ref),
    'extension:install-commit': ({ token }) => extensions.installCommit(token),
    'extension:install-link-take': () => installLinks.take(),
    'extension:install': ({ ref, integrity }) =>
      extensions.installFromRef(ref, {
        grantConsent: true,
        integrity,
        context: 'forward',
      }),
    'extension:uninstall': ({ id }) => extensions.uninstall(id),
    'extension:set-enabled': ({ id, enabled }) =>
      extensions.setEnabled(id, enabled),
    'extension:failed': () => ({ failed: extensions.failedExtensions() }),
    'extension:grant-consent': ({ id }) => extensions.grantConsent(id),
    'extensions:ui-source': ({ extensionId, contributionId }) =>
      extensions.uiSource(extensionId, contributionId),

    // The two seams: the updater's three channels and the Outbox history
    // panel's five (spec §10). Both hand back a `Pick<InvokeHandlers, …>`
    // instead of registering anything, which is what lets them live in their
    // own modules and still be counted here.
    ...updaterInvokeHandlers(updater),
    ...outboundInvokeHandlers({
      service: outbound,
      store: p.store,
      openExternal: (url) => shell.openExternal(url),
      pickFiles: async () => {
        const res = await dialog.showOpenDialog({
          title: 'Attach files',
          properties: ['openFile', 'multiSelections'],
        });
        return res.canceled ? [] : res.filePaths;
      },
    }),
    ...calendarOutInvokeHandlers({ service: calendarOut, store: p.store }),
  };

  // Multi-device sync (step 3): on a follower the writing channels run on the
  // leader, read now on every call; on the leader they run here unchanged. The
  // map is wrapped in place, not `dispatch`, so the app overlay's patch of
  // `dispatch` still finds its text.
  // A setting changed with no leader applies here and waits in the queue
  // (`installSettingsSync`); the data verbs below still refuse.
  // Account changes: on a copy they go to the leader for an account it runs;
  // on the leader each runs in the account's queue, once per operation id.
  const { accountOps } = p;
  const accountChannelRunners = wrapAccountChannels(
    handlers as unknown as Record<
      string,
      ((req: never) => unknown) | undefined
    >,
    {
      sync: p.sync,
      ops: accountOps,
      account: (id) => p.store.account(id as AccountId),
      newId: () => newId(),
    },
  );
  const accountRelayRunners = createLeaderRunners({
    engine: p.engine,
    account: (id) => p.store.account(id),
    hasSource: (id) => p.sources.get(id) !== undefined,
    writable: () => !p.sync.readOnly(),
    ops: accountOps,
    runAccount: (account) => runAccount(p, account),
    log: (line) => p.logSink.log('sync', 'warn', `accounts relay: ${line}`),
  });
  const settings = installSettingsSync({
    prefs: p.prefs,
    sync: p.sync,
    extensions,
    extraRunner: (name) =>
      accountChannelRunners.get(name) ??
      (Object.prototype.hasOwnProperty.call(accountRelayRunners, name)
        ? accountRelayRunners[name as keyof typeof accountRelayRunners]
        : undefined),
    handlers: handlers as unknown as Record<string, (req: unknown) => unknown>,
    afterPromote: (hook) => p.afterPromote(hook),
    syncExtensions: () => syncExtensions(extensions, p),
    onNoMaster: (message) =>
      broadcast('ext:push', { ...SYNC_REFUSED_PUSH, payload: { message } }),
    log: (category, level, msg) => p.logSink.log(category, level, msg),
    retryEveryMs: EXTENSION_RETRY_MS,
    nowMs: Date.now,
    setInterval,
  });
  p.sync.setRunners({
    ui: async (extensionId, name, payload) => {
      const r = await extensions.callUi(extensionId, name, payload);
      if (r.ok) return r.value;
      throw new Error(r.message);
    },
    core: settings.coreRunner,
    commit: async (input) => {
      const r = await runCommitBatch(
        { db: p.db, store: p.store },
        input as CommitInput,
      );
      // A follower's account just landed: it belongs to that device, so this
      // one must know before any tick or boot path asks to run it.
      await p.sync.loadOwned();
      return r;
    },
  });

  // The loop is the point: it registers exactly the declared channels, and
  // `handlers` cannot be missing one of them without failing tsc. The
  // generic `dispatch` keeps `req` tied to its channel instead of collapsing
  // to a union call signature at the indexing site.
  const dispatch = <C extends CoreInvokeChannel>(
    channel: C,
    req: Invokes[C]['req'],
  ) => handlers[channel](req);
  const isTrustedSender = createTrustedRendererPredicate({
    app,
    BrowserWindow,
  });
  // B1: `ext:invoke` is registered through this SAME loop (never a second,
  // hand-written registration call for that one channel — see
  // ipc-handler-coverage.test.ts's "registered in exactly one place" gate),
  // just with a different per-channel handler: `guardIpcHandler`'s sender
  // gate THROWS on an untrusted sender, and `ext:invoke` must always
  // resolve an envelope instead, so this one channel calls
  // `createExtInvokeHandler` directly rather than going through that
  // shared gate.
  const extInvokeHandler = createExtInvokeHandler({
    isTrustedSender,
    platform: extensions,
  });
  for (const channel of INVOKE_CHANNELS) {
    // A product extension registers its own handler for these when it
    // activates; a second registration would throw.
    if (isProductInvokeChannel(channel)) continue;
    ipcMain.handle(
      channel,
      channel === 'ext:invoke'
        ? extInvokeHandler
        : guardIpcHandler(
            channel,
            (req) => dispatch(channel, req),
            isTrustedSender,
          ),
    );
  }
  // B1's other fixed channel: an extension's host.ui.broadcast(name,
  // payload) fans out to every renderer window verbatim, same precedent as
  // every other push:* broadcast in this file.
  extensions.onUiBroadcast((evt) => broadcast('ext:push', evt));

  // --- Auto-updater (ported from the alpha-cent overlay) ---------------------
  // Restart-and-reinstall is a whole-app, main-process concern, so it lives in
  // core. The manager itself is built above the handler map (which needs it);
  // everything below is side-effect wiring and stays after registration, so a
  // state change can never land before the channels exist.
  subscribeUpdaterState(updater, (s) => broadcast('push:update-state', s));
  // Gentle native nudge: a one-shot OS notification the moment an update
  // finishes downloading (click → restart & install).
  const notifier = createUpdateNotifier({
    notify: ({ title, body, onClick }) => {
      if (!Notification.isSupported()) return;
      const n = new Notification({ title, body });
      n.on('click', onClick);
      n.show();
    },
    quitAndInstall: () => updater.quitAndInstall(),
    log,
  });
  updater.onStateChange((s) => notifier.handle(s));
  updater.start();
}

app
  .whenReady()
  .then(async () => {
    // Dev-mode dock icon (macOS) — ported from the legacy main.ts. Packaged
    // builds embed assets/icon.icns via electron-builder; in dev the
    // Electron-default icon shows unless set explicitly (BrowserWindow.icon
    // is Windows/Linux-only). setIcon before whenReady is a no-op, hence
    // here. .icns isn't reliably loadable via nativeImage, so use the 1024
    // PNG, which macOS downsizes cleanly.
    if (process.platform === 'darwin' && !app.isPackaged) {
      app.dock?.setIcon(getAssetPath('icons', '1024x1024.png'));
    }
    // MUST run before the first keystore touch (makeEncryption below): a
    // quarantine-translocated first run would otherwise create the
    // "<name> Safe Storage" keychain item under a throwaway app identity,
    // dooming every later launch to a macOS password prompt.
    const move = headless()
      ? 'skipped'
      : await maybeOfferMoveToApplications({
          platform: process.platform,
          isPackaged: app.isPackaged,
          userDataDir: app.getPath('userData'),
          productName: product.productName,
          isInApplicationsFolder: () => app.isInApplicationsFolder(),
          moveToApplicationsFolder: (opts) =>
            app.moveToApplicationsFolder(opts),
          showMessageBox: (opts) =>
            dialog.showMessageBox(opts as Electron.MessageBoxOptions),
          log,
        });
    if (move === 'moving') return; // quitting; relaunches from /Applications
    const rt = createRuntime(runtimeHost());
    runtime = rt;
    const h = await rt.ready;
    handles = h;
    // After the services exist and before any extension activates: bundled
    // `unsafe.mainProcess` extensions splice tray items from their very first
    // activate(), and the tray's own items need the runtime.
    if (!headless()) {
      ({ tray, menu: trayMenu } = createTray(
        getAssetPath('icons', 'tray', 'trayTemplate.png'),
        {
          openWindow: showMainWindow,
          syncNow: h.syncNow,
          quit: () => app.quit(),
        },
      ));
    }
    registerIpc(h);
    bootTimer.mark('ipc');
    // #140 window-first boot: the order lives in boot-tail.ts. Utility-process
    // extensions start AFTER the window.
    await rt.start({
      afterInProcessExtensions: async () => {
        if (headless()) return;
        app.on('activate', () => {
          showMainWindow();
        });
        await createWindow();
        installLinks.markReady();
      },
    });
  })
  .catch((err) => {
    // A quit during startup: stop() already tore down what existed.
    if (err instanceof RuntimeStopped) return undefined;
    return handleBootFailure(
      {
        crash: crashDeps,
        dataDir: path.join(app.getPath('userData'), 'data'),
        productName: product.productName,
        now: () => new Date(),
        confirmRebuild: async (backupDir) =>
          !headless() &&
          (
            await dialog.showMessageBox(
              corpusRefusalDialog(product.productName, backupDir),
            )
          ).response === 1,
        relaunch: () => {
          app.relaunch();
          app.exit(0);
        },
      },
      err,
    );
  });

// Reached on Windows/Linux only when the window is really closing (a quit is
// underway — close-to-tray hides it in every other case), and never on macOS,
// where the app outlives its window by design.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Clean shutdown must actually COMPLETE before the process exits, or the
// llama-server/whisper-cli children (non-detached, idle-stopped up to 10 min
// later) outlive the app. Take over the quit: dispose the local-llm and
// local-asr providers (stops their children + aborts any in-flight install)
// BEFORE tearing down the platform, then re-quit. Every step is bounded, so
// quit can't hang: LlamaServer.stop escalates to SIGKILL after a grace window,
// and localAsr.dispose() awaits the signalled whisper-cli child whose own
// SIGTERM→SIGKILL escalation is capped at ~2s (whisper-cli.ts).
installQuitSignalHandlers(app);
app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  void (async () => {
    tray?.destroy();
    tray = null;
    await runtime?.stop();
    app.quit();
  })();
});
