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
  powerMonitor,
  safeStorage,
  shell,
} from 'electron';
import type { Tray } from 'electron';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log/main';

import type { AppState, SchedulerEnv, Seq } from '@shared/contracts';
import type {
  AppStatePush,
  ConnectEvent,
  InvokeChannel,
  InvokeHandlers,
  Invokes,
  PushChannel,
  Pushes,
} from '@shared/ipc';
import { INVOKE_CHANNELS } from '@shared/ipc';

import { createConnectBroker } from './auth/connect-broker';
import {
  installCrashHandlers,
  reportBootFailure,
  type CrashDeps,
} from './crash-handlers';
import type { ConnectBroker } from './auth/connect-broker';
import { startHeapWatch } from './heap-watch';
import {
  backgroundLaneOpen,
  backgroundLaneState,
  bootCore,
  resumeAccounts,
  runAccount,
  setAccountCadence,
} from './core/boot';
import type { CorePlatform } from './core/boot';
import { createActivityLog, type ActivityLog } from './core/mcp/activity';
import { startMcp } from './core/mcp/server';
import type { McpServerHandle } from './core/mcp/server';
import { markOnboardingOnce } from './core/prefs';
import { maybeOfferMoveToApplications } from './move-to-applications';
import { createGitHubCache } from './marketplace/github-cache';
import { createGitHubSource } from './marketplace/github-source';
import { parseGitHubRef, formatGitHubRef } from './marketplace/github-ref';
import { createMarketplaceCatalog } from './marketplace/catalog';
import type { MarketplaceCatalog } from './marketplace/catalog';
import { buildMainApi } from './main-api';
import { createUpdater } from './updater/updater';
import { createUpdateNotifier } from './updater/native-notify';
import { subscribeUpdaterState, updaterInvokeHandlers } from './updater/ipc';
import { createExtensionPlatform } from './platform/extension-platform';
import type { ExtensionPlatform } from './platform/extension-platform';
import { utilityProcessTransport } from './platform/transport';
import {
  createOutboundService,
  type OutboundService,
} from './outbound/service';
import { outboundInvokeHandlers } from './outbound/ipc';
import { createOutboundRoutes } from './outbound/routes';
import { buildBundledSenders, composeSenders } from './outbound/senders';
import { loadProductConfig } from './product';
import { registerBundledProviders } from './providers';
import type { LocalAsrProvider } from './providers/local-asr';
import { CURATED_TIERS, modelTotalBytes } from './providers/local-llm/models';
import type { LocalLlmProvider } from './providers/local-llm/provider';
import { registerBundledSources } from './sources';
import { countFiles } from './sources/local-folder/scanner';
import {
  listChildren,
  listDrives,
  quickLinks,
} from './sources/local-folder/tree';
import { createTray } from './tray';
import type { TrayMenuController } from './tray-menu';
import { resolveHtmlPath } from './util';
import { attachBundledWorkers } from './workers';

let mainWindow: BrowserWindow | null = null;
let platform: CorePlatform | null = null;
let mcp: McpServerHandle | null = null;
let extensionsPlatform: ExtensionPlatform | null = null;
let bundledProviders: {
  localLlm: LocalLlmProvider;
  localAsr: LocalAsrProvider;
} | null = null;
let activity: ActivityLog | null = null;
let stopActivityWatch: (() => void) | null = null;
// Must stay referenced for the app's lifetime or GC destroys the icon.
let tray: Tray | null = null;
let trayMenu: TrayMenuController | null = null;

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
const crashDeps: CrashDeps = {
  logDir: path.join(app.getPath('userData'), 'data', 'logs'),
  sink: () => platform?.logSink ?? null,
  showErrorBox: (title, content) => dialog.showErrorBox(title, content),
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
  sink: () => platform?.logSink ?? null,
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

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
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

function getAssetPath(...paths: string[]): string {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'assets')
    : path.join(__dirname, '../../assets');
  return path.join(base, ...paths);
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    show: false,
    width: 1024,
    height: 728,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#fafafa',
    icon: getAssetPath('icon.png'),
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 12, y: 18 },
    // Windows/Linux caption buttons only. On macOS a titleBarOverlay
    // OVERRIDES trafficLightPosition and drops the lights below the overlay
    // height, right onto the sidebar brand row.
    ...(process.platform !== 'darwin' && {
      titleBarOverlay: {
        color: '#fafafa',
        symbolColor: '#0f172a',
        height: 30,
      },
    }),
    webPreferences: {
      // Packaged and unpackaged-prod runs have preload.js beside main.js;
      // the dev server serves it from the dll dir.
      preload: [
        path.join(__dirname, 'preload.js'),
        path.join(__dirname, '../../.erb/dll/preload.js'),
      ].find((f) => fs.existsSync(f)),
    },
  });
  mainWindow.on('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
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

/** Everything the renderer can ask for, over the typed contract. */
function registerIpc(
  p: CorePlatform,
  getLastPush: () => AppStatePush,
  patchState: (partial: Partial<AppState>) => void,
  bundled: { localLlm: LocalLlmProvider },
  extensions: ExtensionPlatform,
  catalog: MarketplaceCatalog,
  broker: ConnectBroker,
  outbound: OutboundService,
): void {
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
      await p.engine.remove(accountId);
      for (const job of await p.scheduler.jobs()) {
        if (job.id.endsWith(`:${accountId}`)) p.scheduler.unregister(job.id);
      }
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
      if (account) runAccount(p, account);
    },
    'accounts:sync-now': async ({ accountId }) => {
      const account = await p.store.account(accountId);
      // Never start a paused account: sync-now must not undo an explicit pause
      // (resume is the only door), and this also keeps the cadence job from
      // being registered for it. engine.run re-checks the pause intent and the
      // committed status, so a pause landing between this read and the run is
      // still refused.
      if (account && account.status !== 'paused') runAccount(p, account);
    },
    'accounts:set-cadence': ({ accountId, cadence }) =>
      // Delegates to core/boot so the resting-state rule ('paused' AND
      // 'needsReauth' persist the cadence but start nothing) lives in one
      // place, next to the cadence tick's identical gate.
      setAccountCadence(p, accountId, cadence),
    'accounts:update-config': ({ accountId, config }) =>
      p.engine.updateConfig(accountId, config),
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

    'search:query': (req) => p.store.read.search(req ?? {}),
    'docs:get': ({ id }) => p.store.read.document(id),
    'docs:children': ({ id }) => p.store.read.children(id),

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
    'mcp-activity:recent': async () => activity?.recent() ?? [],

    'mcp:info': async () => ({
      port: mcp?.port ?? null,
      clients: (await mcp?.clients()) ?? [],
    }),
    'mcp:connect-client': async ({ id }) => {
      await mcp?.connectClient(id);
      markOnboardingOnce(p.prefs, 'mcpConnectedAt').catch(() => {});
    },
    'mcp:disconnect-client': async ({ id }) => {
      await mcp?.disconnectClient(id);
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
      };
    },
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
    'maintenance:reset-all': async () => {
      // Stop every real account's sync loop BEFORE the wipe. engine.pause is
      // the one public API that both aborts a running loop and (via its pause
      // intent) blocks the cadence tick from resurrecting it mid-wipe. Without
      // this, still-running loops keep committing against deleted accounts
      // (throwing 'commit: unknown account') while the wipe runs. Worker
      // consumers are deliberately NOT stopped — nothing restarts them until
      // relaunch, and the emptied work ledger idles them out on its own.
      const accounts = await p.store.read.accounts();
      for (const account of accounts) {
        if (account.source === 'worker') continue;
        await p.engine.pause(account.id).catch(() => {});
      }
      await p.store.maintenance.resetAll();
      // A factory reset is THE legitimate un-latch: the get-started checklist
      // must come back for the now-empty app. Configuration prefs (theme,
      // processing) survive — only the onboarding latches reset.
      await p.prefs.patch({
        onboarding: {
          sourceBackfilledAt: null,
          mcpConnectedAt: null,
          firstQueryAt: null,
          dismissedAt: null,
        },
      });
      // The feed names titles of documents the reset just deleted — truncate
      // it with them. No push needed: the panel re-pulls mcp-activity:recent
      // on next mount (reset lives on Settings; Connection isn't mounted).
      activity?.reset();
      patchState({ identity: null, accounts: [] });
    },

    'inference:providers': () =>
      p.inference.providers().map((prov) => ({
        id: prov.id,
        supports: prov.supports,
        status: prov.status(),
      })),
    'inference:install': async () => {
      await p.prefs.patch({
        models: { ...p.prefs.get().models, autoInstall: true },
      });
      bundled.localLlm.ensureInstalled();
    },
    'inference:cancel': async () => {
      await bundled.localLlm.cancelInstall();
      await p.prefs.patch({
        models: { ...p.prefs.get().models, autoInstall: false },
      });
    },
    'inference:stats': async () => ({
      ...(await p.store.extractionStats()),
      lane: backgroundLaneState(p),
    }),
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
    'extension:uninstall': ({ id }) => extensions.uninstall(id),
    'extension:set-enabled': ({ id, enabled }) =>
      extensions.setEnabled(id, enabled),
    'extension:grant-consent': ({ id }) => extensions.grantConsent(id),

    // The two seams: the updater's three channels and the Outbox history
    // panel's four (spec §10). Both hand back a `Pick<InvokeHandlers, …>`
    // instead of registering anything, which is what lets them live in their
    // own modules and still be counted here.
    ...updaterInvokeHandlers(updater),
    ...outboundInvokeHandlers({
      service: outbound,
      store: p.store,
      openExternal: (url) => shell.openExternal(url),
    }),
  };

  // The loop is the point: it registers exactly the declared channels, and
  // `handlers` cannot be missing one of them without failing tsc. The
  // generic `dispatch` keeps `req` tied to its channel instead of collapsing
  // to a union call signature at the indexing site.
  const dispatch = <C extends InvokeChannel>(
    channel: C,
    req: Invokes[C]['req'],
  ) => handlers[channel](req);
  for (const channel of INVOKE_CHANNELS) {
    ipcMain.handle(channel, (_e, req) => dispatch(channel, req));
  }

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
    const move = await maybeOfferMoveToApplications({
      platform: process.platform,
      isPackaged: app.isPackaged,
      userDataDir: app.getPath('userData'),
      productName: product.productName,
      isInApplicationsFolder: () => app.isInApplicationsFolder(),
      moveToApplicationsFolder: (opts) => app.moveToApplicationsFolder(opts),
      showMessageBox: (opts) =>
        dialog.showMessageBox(opts as Electron.MessageBoxOptions),
      log,
    });
    if (move === 'moving') return; // quitting; relaunches from /Applications
    const dataDir = path.join(app.getPath('userData'), 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const act = createActivityLog(dataDir);
    activity = act;
    const enc = makeEncryption();
    // Bundled DB worker (webpack `dbWorker` entry): prod emits `dbWorker.js`,
    // the dev config `dbWorker.bundle.dev.js` — the same existsSync-fallback
    // scheme as extensionHostScript below. Hosting the corpus SQLite connection
    // off the main thread is what keeps backfill from freezing the UI.
    const dbWorkerFile =
      [
        path.join(__dirname, 'dbWorker.js'),
        path.join(__dirname, 'dbWorker.bundle.dev.js'),
      ].find((f) => fs.existsSync(f)) ?? path.join(__dirname, 'dbWorker.js');
    platform = await bootCore({
      dataDir,
      ...enc,
      env: schedulerEnv,
      dbWorkerFile,
    });
    const p = platform;

    const bundled = registerBundledProviders(p, {
      assetsDir: getAssetPath(),
      dataDir,
    });
    bundledProviders = bundled;
    attachBundledWorkers(p, bundled);

    const outbound = createOutboundService({
      store: p.store,
      prefs: p.prefs,
      // Bundled transports SHADOW extension senders on a colliding source
      // id, and both sides are read live on every send — so an extension
      // activating after this point is picked up without re-composing.
      senders: composeSenders(
        buildBundledSenders({ store: p.store, logSink: p.logSink }),
        p.senders,
      ),
      logSink: p.logSink,
    });
    // Rows stuck in 'sending' can only mean a previous process died
    // mid-send. Awaited (not fire-and-forget): this sweep must complete
    // before the MCP server starts serving — the store's db.run crosses the
    // worker-thread bridge, so a floating promise here could still be in
    // flight when the HTTP listener accepts its first confirm request.
    // A transient DB-bridge failure here must not abort boot (mirrors the
    // extensionsPlatform.start() guard below) — startMcp/createTray/
    // resumeAccounts/createWindow must all still run; any 'sending' rows
    // left behind are simply picked up by the next boot's sweep.
    try {
      await p.store.outbox.recoverOrphanedSending();
    } catch (err) {
      p.logSink.log(
        'outbound',
        'error',
        'boot-time recoverOrphanedSending sweep failed — sending rows left in place for the next boot',
        { error: err instanceof Error ? err.message : String(err) },
      );
    }

    mcp = await startMcp({
      query: p.store.read,
      logSink: p.logSink,
      dataDir,
      onActivity: (rec) => act.append(rec),
      // Real app boot: heal HTTP client configs left pointing at a port we
      // no longer hold (candidate-port fallback). Tests never set this.
      reconcileClientConfigs: true,
      outbound,
    });
    // Onboarding step 2 reconciliation: a client connected in an earlier
    // run (config file already carries our entry) counts as done.
    void mcp
      .clients()
      .then((cs) => {
        if (cs.some((c) => c.connected))
          markOnboardingOnce(p.prefs, 'mcpConnectedAt').catch(() => {});
      })
      .catch(() => {});

    // ONE consumer of the activity file, two effects: the live feed push
    // and the onboarding first-query latch. Both transports land here (the
    // stdio sibling appends to the same file), and the boot replay batch
    // covers queries served while the app was closed — which is exactly how
    // stdio clients latch step 3 despite living in another process.
    stopActivityWatch = act.watch((recs) => {
      broadcast('push:mcp-activity', recs);
      if (recs.some((r) => r.ok)) {
        markOnboardingOnce(p.prefs, 'firstQueryAt').catch(() => {});
      }
    });

    // THE canonical projection: one push channel carries all live app state.
    // Ownership split: the projection owns the FEED-derived slice (accounts);
    // identity/prefs/processing/mcp live here and change via patchState —
    // seeded from their real sources so the first diff can't regress them.
    const initialLedger = await p.store.ledgerCountsAll();
    let rev = 0;
    let lastPush: AppStatePush = {
      state: {
        accounts: [],
        processing: {
          pending: initialLedger.pending,
          done: initialLedger.done,
          skipped: initialLedger.skip,
          failed: initialLedger.failed,
        },
        mcp: { port: mcp?.port ?? null, clients: 0 },
        identity: await p.store.identity.get(),
        prefs: p.prefs.get(),
        extensions: [],
        ready: false,
      },
      seq: 0,
      rev,
    };
    const projection = p.createAppProjection({
      prefs: () => p.prefs.get(),
      identity: () => p.store.identity.get(),
      mcp: () => ({ port: mcp?.port ?? null, clients: 0 }),
      processing: async () => {
        const all = await p.store.ledgerCountsAll();
        return {
          pending: all.pending,
          done: all.done,
          skipped: all.skip,
          failed: all.failed,
        };
      },
      extensions: () => extensionsPlatform?.snapshot() ?? [],
    });
    // Coalesce push:app-state broadcasts (#5). Core broadcasts on every feed
    // diff (per DB write) with no throttle, so active backfill re-clones
    // AppState to every window per write and floods the renderer, freezing the
    // UI. Trailing-edge throttle: diffs within the window collapse into one
    // broadcast of the latest lastPush (the renderer already drops out-of-order
    // revs). Interim mitigation; the real fix is DB/projection work off the
    // main thread.
    const APP_STATE_PUSH_THROTTLE_MS = 100;
    let appStatePushScheduled = false;
    const flushAppStatePush = () => {
      appStatePushScheduled = false;
      broadcast('push:app-state', lastPush);
    };
    const scheduleAppStatePush = () => {
      if (appStatePushScheduled) return;
      appStatePushScheduled = true;
      setTimeout(flushAppStatePush, APP_STATE_PUSH_THROTTLE_MS).unref?.();
    };
    const patchState = (partial: Partial<AppState>) => {
      rev += 1;
      lastPush = {
        state: { ...lastPush.state, ...partial },
        seq: lastPush.seq,
        rev,
      };
      scheduleAppStatePush();
    };
    // Prod emits `extensionHost.js`; the dev webpack config (`.erb/configs/
    // webpack.config.main.dev.ts`) suffixes every entry with
    // `.bundle.dev.js`. Resolved once here, same existsSync-fallback
    // pattern as the MCP stdio entry in core/mcp/server.ts.
    const extensionHostScript = [
      path.join(__dirname, 'extensionHost.js'),
      path.join(__dirname, 'extensionHost.bundle.dev.js'),
    ].find((f) => fs.existsSync(f));
    const ghCache = createGitHubCache({
      cacheFile: path.join(
        app.getPath('userData'),
        'extensions',
        'github-cache.json',
      ),
    });
    const ghSource = createGitHubSource({ cache: ghCache });
    // The broker (and bundled-source registration) must exist BEFORE the
    // extension platform: extension-contributed oauth sources register
    // their profile into this broker and their refresher into p.refreshers
    // — the SAME Map instance bootCore handed to the engine deps.
    const broker = createConnectBroker(p, (event: ConnectEvent) =>
      broadcast('push:connect', event),
    );
    const bundledRefreshers = registerBundledSources(
      (s) => p.sources.register(s),
      broker,
    );
    for (const [sourceId, refresher] of bundledRefreshers)
      p.refreshers.set(sourceId, refresher);

    // Shared by the tray's "Open KIAgent" and MainProcessApi.ui.openWindow
    // (extension escape hatches like remote-mcp's "Fix connection…").
    const openMainWindow = (): void => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      } else {
        void createWindow();
      }
    };

    // Built here (rather than at its historical spot right before
    // createWindow) so its TrayMenuController exists in time to hand to
    // buildMainApi below — bundled `unsafe.mainProcess` extensions can
    // splice tray items via `extras.mainProcess.ui.addTrayMenuItems` from
    // their very first activate().
    ({ tray, menu: trayMenu } = createTray(
      getAssetPath('icons', 'tray', 'trayTemplate.png'),
      {
        openWindow: openMainWindow,
        syncNow: () => {
          void (async () => {
            const jobs = await p.scheduler.jobs();
            // Account syncs only — worker:* jobs (vision/OCR sweeps) run on
            // their own cadence. trigger() skips jobs already mid-run.
            await Promise.allSettled(
              jobs
                .filter((j) => j.id.startsWith('source:'))
                .map((j) => p.scheduler.trigger(j.id)),
            );
          })();
        },
        quit: () => app.quit(),
      },
    ));

    // Cheap (a closure over the service, no I/O) — safe to build here even
    // though the loopback server (startMcp above) already built its OWN
    // instance for server.ts's /outbox/* dispatch. Both share all state
    // through `outbound`, so having two instances is intentional, not a
    // duplication bug.
    const outboundRoutes = createOutboundRoutes(outbound);

    extensionsPlatform = createExtensionPlatform({
      extDir: path.join(app.getPath('userData'), 'extensions'),
      bundledDir: bundledExtensionsDir,
      bundledDataDir: path.join(
        app.getPath('userData'),
        'bundled-extensions-data',
      ),
      mainApi: buildMainApi({
        store: p.store,
        // Non-null: startMcp() above is awaited before this point, so
        // `mcp` always holds a live McpServerHandle here.
        mcp: mcp!,
        app,
        dataDir,
        tray: trayMenu,
        ui: { openWindow: openMainWindow },
        outbound: { service: outbound, routes: outboundRoutes },
      }),
      store: p.store,
      sources: p.sources,
      senders: p.senders,
      scheduler: p.scheduler,
      registerTool: (t) => (mcp ? mcp.registerTool(t) : () => {}),
      inference: p.inference,
      logSink: p.logSink,
      notify: (msg) => {
        new Notification({ title: product.productName, body: msg }).show();
      },
      transportFactory: (id) =>
        utilityProcessTransport(
          extensionHostScript ?? path.join(__dirname, 'extensionHost.js'),
          `kia-ext:${id}`,
          // Child console + crash traces into the app log — a crashing host
          // writes '[ext-host] uncaught: …' to stderr as its only trace.
          (stream, line) =>
            p.logSink.log(
              `extension:${id}`,
              stream === 'stderr' ? 'warn' : 'info',
              line,
            ),
        ),
      onChange: (extensions) => patchState({ extensions }),
      download: async (ref) => {
        if (ref.startsWith('github:')) {
          const parsed = parseGitHubRef(ref);
          const resolved = parsed && (await ghSource.resolveGitHubRef(ref));
          if (!parsed || !resolved)
            throw new Error(`no installable release for ${ref}`);
          return {
            bytes: await ghSource.downloadAsset(resolved.tarballUrl),
            pinnedRef: `${formatGitHubRef(parsed.owner, parsed.repo)}@${resolved.tag}`,
          };
        }
        return { bytes: await ghSource.downloadAsset(ref), pinnedRef: ref };
      },
      oauth: {
        registerProfile: (sourceId, profile) =>
          broker.registerOAuthProfile(sourceId, profile),
        unregisterProfile: (sourceId) =>
          broker.unregisterOAuthProfile(sourceId),
        refreshers: p.refreshers,
      },
    });
    const catalog = createMarketplaceCatalog({
      source: ghSource,
      snapshot: () => extensionsPlatform!.snapshot(),
    });
    registerIpc(
      p,
      () => lastPush,
      patchState,
      bundled,
      extensionsPlatform,
      catalog,
      broker,
      outbound,
    );
    p.engine.project(projection, (state: AppState, seq: Seq) => {
      rev += 1;
      // Onboarding step 1: any account that has ever reached 'live'. Also
      // covers startup — the projection's init() snapshot flows through here.
      if (state.accounts.some((a) => a.account.status === 'live'))
        markOnboardingOnce(p.prefs, 'sourceBackfilledAt').catch(() => {});
      // Take ONLY the feed-derived slice from the projection. Its internal
      // state still carries init()-time snapshots of the other slices; using
      // them here would clobber later patches (a signed-in identity would
      // revert to null on the first sync batch — the sign-in bounce bug).
      lastPush = {
        state: {
          ...state,
          identity: lastPush.state.identity,
          prefs: lastPush.state.prefs,
          processing: lastPush.state.processing,
          mcp: lastPush.state.mcp,
          extensions: lastPush.state.extensions,
        },
        seq,
        rev,
      };
      scheduleAppStatePush();
    });

    // Non-feed slices (prefs, processing counters) refresh on their own clock.
    p.prefs.onChange((prefs) => {
      patchState({ prefs });
      applyLoginItemSettings(prefs.launchAtLogin);
    });
    applyLoginItemSettings(p.prefs.get().launchAtLogin);
    setInterval(async () => {
      // ledgerCountsAll is now an async worker RPC — a transient read failure
      // (e.g. a dead/restarting DB worker) must not escape as an unhandled
      // rejection on the timer. Mirrors scheduler.ts's safeTick guard.
      try {
        p.inference.setBackgroundOpen(backgroundLaneOpen(p));
        const all = await p.store.ledgerCountsAll();
        const processing = {
          pending: all.pending,
          done: all.done,
          skipped: all.skip,
          failed: all.failed,
        };
        const prev = lastPush.state.processing;
        if (
          prev.pending !== processing.pending ||
          prev.done !== processing.done ||
          prev.skipped !== processing.skipped ||
          prev.failed !== processing.failed
        ) {
          patchState({ processing });
        }
      } catch (err) {
        log.warn(`processing-counter refresh failed: ${String(err)}`);
      }
    }, 5_000);

    // Live log streaming to the Logs screen.
    void (async () => {
      for await (const records of p.logs.tail()) {
        if (records.length) broadcast('push:logs', records);
      }
    })();

    try {
      // A broken extensions dir (e.g. `extensions` exists as a plain file,
      // so mkdirSync throws) must be fully inert — never abort boot, or
      // resumeAccounts/scheduler.start/createWindow all get skipped and no
      // window ever opens.
      await extensionsPlatform.start();
    } catch (err) {
      p.logSink.log('platform', 'error', 'extension platform failed to start', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await resumeAccounts(p);
    p.scheduler.start();
    await createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow();
    });
  })
  .catch((err) => {
    reportBootFailure(crashDeps, err);
  });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Clean shutdown must actually COMPLETE before the process exits, or the
// llama-server/whisper-cli children (non-detached, idle-stopped up to 10 min
// later) outlive the app. Take over the quit: dispose the local-llm and
// local-asr providers (stops their children + aborts any in-flight install)
// BEFORE tearing down the platform, then re-quit. Every step is bounded
// (LlamaServer.stop escalates to SIGKILL after a grace window), so quit
// can't hang.
let quitting = false;
app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  void (async () => {
    tray?.destroy();
    tray = null;
    stopActivityWatch?.();
    await bundledProviders?.localLlm.dispose().catch(() => {});
    await bundledProviders?.localAsr.dispose().catch(() => {});
    await mcp?.stop().catch(() => {});
    await extensionsPlatform?.stop().catch(() => {});
    await platform?.shutdown().catch(() => {});
    app.quit();
  })();
});
