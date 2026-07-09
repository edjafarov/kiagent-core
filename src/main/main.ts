import fs from 'fs';
import path from 'path';

import {
  BrowserWindow,
  Notification,
  app,
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
  Invokes,
  PushChannel,
  Pushes,
} from '@shared/ipc';

import { createConnectBroker } from './auth/connect-broker';
import type { ConnectBroker } from './auth/connect-broker';
import {
  backgroundLaneOpen,
  bootCore,
  resumeAccounts,
  runAccount,
} from './core/boot';
import type { CorePlatform } from './core/boot';
import { createActivityLog, type ActivityLog } from './core/mcp/activity';
import { startMcp } from './core/mcp/server';
import type { McpServerHandle } from './core/mcp/server';
import { markOnboardingOnce } from './core/prefs';
import { createGitHubCache } from './marketplace/github-cache';
import { createGitHubSource } from './marketplace/github-source';
import { parseGitHubRef, formatGitHubRef } from './marketplace/github-ref';
import { createMarketplaceCatalog } from './marketplace/catalog';
import type { MarketplaceCatalog } from './marketplace/catalog';
import { buildMainApi } from './main-api';
import { createUpdater } from './updater/updater';
import { createUpdateNotifier } from './updater/native-notify';
import { registerUpdaterIpc } from './updater/ipc';
import { createExtensionPlatform } from './platform/extension-platform';
import type { ExtensionPlatform } from './platform/extension-platform';
import { utilityProcessTransport } from './platform/transport';
import { loadProductConfig } from './product';
import { registerBundledProviders } from './providers';
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
import { attachBundledWorkers, VISION_CONSUMER } from './workers';

let mainWindow: BrowserWindow | null = null;
let platform: CorePlatform | null = null;
let mcp: McpServerHandle | null = null;
let extensionsPlatform: ExtensionPlatform | null = null;
let bundledProviders: { localLlm: LocalLlmProvider } | null = null;
let activity: ActivityLog | null = null;
let stopActivityWatch: (() => void) | null = null;
// Must stay referenced for the app's lifetime or GC destroys the icon.
let tray: Tray | null = null;
let trayMenu: TrayMenuController | null = null;

// Test/dev escape hatch: point ALL app storage somewhere disposable.
if (process.env.KIAGENT_USER_DATA) {
  app.setPath('userData', process.env.KIAGENT_USER_DATA);
} else if (!app.isPackaged) {
  // Dev runs under the boilerplate app name, which lands userData in
  // '.../electron-react-boilerplate' — a dir nobody associates with this
  // app (resets aimed at "the KIAgent folder" miss it entirely). Pin a
  // dedicated dev dir, distinct from the packaged app's 'KIAgent' so a
  // real install and a dev tree never share state. One-time migration
  // keeps existing dev pairings/extensions; the rename only fires when
  // the legacy dir provably holds OUR data and the new dir doesn't exist.
  const devDir = path.join(app.getPath('appData'), 'KIAgent-dev');
  const legacy = path.join(
    app.getPath('appData'),
    'electron-react-boilerplate',
  );
  if (
    !fs.existsSync(devDir) &&
    fs.existsSync(path.join(legacy, 'data', 'kiagent.db'))
  ) {
    try {
      fs.renameSync(legacy, devDir);
    } catch {
      // Locked by a running instance or cross-device: fall through to a
      // fresh dir; the legacy data stays intact where it was.
    }
  }
  app.setPath('userData', devDir);
}

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
  return {
    encrypt(plain: string): Buffer {
      if (canEncrypt) return safeStorage.encryptString(plain);
      // Dev fallback only — a machine without a keychain stores obfuscated,
      // not encrypted. Production platforms all support safeStorage.
      return Buffer.from(`plain:${plain}`, 'utf8');
    },
    decrypt(blob: Buffer): string {
      const s = blob.toString('utf8');
      if (s.startsWith('plain:')) return s.slice('plain:'.length);
      return safeStorage.decryptString(blob);
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
    trafficLightPosition: { x: 12, y: 10 },
    titleBarOverlay: {
      color: '#2e1065',
      symbolColor: '#ffffff',
      height: 30,
    },
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
): void {
  const handle = <C extends keyof Invokes>(
    channel: C,
    fn: (
      req: Invokes[C]['req'],
    ) => Promise<Invokes[C]['res']> | Invokes[C]['res'],
  ) => {
    ipcMain.handle(channel, (_e, req) => fn(req));
  };

  handle('app:get-state', () => getLastPush());
  handle('sources:list', () => p.sources.list());
  handle('sources:count-files', async ({ path: rawPath }) => {
    const resolved = path.resolve(rawPath);
    try {
      const st = await fs.promises.stat(resolved);
      if (!st.isDirectory()) return null;
    } catch {
      return null;
    }
    return countFiles(resolved);
  });
  handle('sources:list-folders', async (req) => {
    if ('special' in req) {
      return {
        entries:
          req.special === 'quick' ? await quickLinks() : await listDrives(),
      };
    }
    return { entries: await listChildren(path.resolve(req.path)) };
  });

  handle('accounts:add', ({ sourceId }) => broker.start(sourceId));
  handle('accounts:prompt-answer', ({ requestId, answers }) => {
    broker.answer(requestId, answers);
  });
  handle('accounts:picker-roots', ({ requestId, mode }) =>
    broker.pickerRoots(requestId, mode),
  );
  handle('accounts:picker-children', ({ requestId, id }) =>
    broker.pickerChildren(requestId, id),
  );
  handle('accounts:picker-count', ({ requestId, id }) =>
    broker.pickerCount(requestId, id),
  );
  handle('accounts:picker-confirm', ({ requestId, nodes }) => {
    broker.pickerConfirm(requestId, nodes);
  });
  handle('accounts:picker-cancel', ({ requestId }) => {
    broker.pickerCancel(requestId);
  });
  handle('accounts:remove', async ({ accountId }) => {
    await p.engine.remove(accountId);
    for (const job of await p.scheduler.jobs()) {
      if (job.id.endsWith(`:${accountId}`)) p.scheduler.unregister(job.id);
    }
  });
  handle('accounts:pause', async ({ accountId }) => {
    // Delegate to engine.pause: it aborts any in-flight sync loop before
    // committing 'paused', so an active backfill can't flip the status back on
    // its next batch commit. A bare status-only commit here caused the account
    // to silently resume mid-backfill.
    await p.engine.pause(accountId);
  });
  handle('accounts:resume', async ({ accountId }) => {
    const account = await p.store.account(accountId);
    if (!account) return;
    await p.store.commit({
      account: accountId,
      documents: [],
      cursor: account.cursor,
      status: 'connecting',
    });
    runAccount(p, { ...account, status: 'connecting' });
  });
  handle('accounts:sync-now', async ({ accountId }) => {
    const account = await p.store.account(accountId);
    if (account) runAccount(p, account);
  });
  handle('accounts:set-cadence', async ({ accountId, cadence }) => {
    await p.store.setAccountCadence(accountId, cadence);
    const account = await p.store.account(accountId);
    if (account && account.status !== 'paused') runAccount(p, account);
  });
  handle('accounts:update-config', ({ accountId, config }) =>
    p.engine.updateConfig(accountId, config),
  );

  handle('search:query', (req) => p.store.read.search(req ?? {}));
  handle('docs:get', ({ id }) => p.store.read.document(id));
  handle('docs:children', ({ id }) => p.store.read.children(id));

  handle('prefs:get', () => p.prefs.get());
  handle('prefs:patch', async (patch) => {
    await p.prefs.patch(patch ?? {});
    return p.prefs.get();
  });

  handle('identity:get', () => p.store.identity.get());
  handle('identity:set', async (identity) => {
    await p.store.identity.set(identity);
    // Identity lives outside the feed — re-push state or the sign-in gate
    // would never open.
    patchState({ identity });
  });

  handle('logs:recent', async (req) => {
    const it = p.logs.tail(req ?? undefined)[Symbol.asyncIterator]();
    const first = await it.next(); // first yield = the in-memory ring
    await it.return?.(undefined as never);
    return first.done ? [] : first.value;
  });
  handle('logs:export', () => p.logs.export());
  handle('mcp-activity:recent', async () => activity?.recent() ?? []);

  handle('mcp:info', async () => ({
    port: mcp?.port ?? null,
    clients: (await mcp?.clients()) ?? [],
  }));
  handle('mcp:connect-client', async ({ id }) => {
    await mcp?.connectClient(id);
    markOnboardingOnce(p.prefs, 'mcpConnectedAt').catch(() => {});
  });
  handle('mcp:disconnect-client', async ({ id }) => {
    await mcp?.disconnectClient(id);
  });

  handle('scheduler:jobs', () => p.scheduler.jobs());
  handle('scheduler:trigger', ({ id }) => p.scheduler.trigger(id));

  handle('storage:stats', async () => {
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
  });
  handle('maintenance:compact', () => p.store.maintenance.compact());
  handle('maintenance:export', async ({ destDir }) => {
    let dir = destDir;
    if (!dir) {
      const res = await dialog.showOpenDialog({
        properties: ['openDirectory', 'createDirectory'],
      });
      if (res.canceled || !res.filePaths[0]) return;
      [dir] = res.filePaths;
    }
    await p.store.maintenance.export(dir);
  });
  handle('maintenance:reset-all', async () => {
    await p.store.maintenance.resetAll();
    // A factory reset is THE legitimate un-latch: the get-started checklist
    // must come back for the now-empty app. Configuration prefs (theme,
    // processing, privacy) survive — only the onboarding latches reset.
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
  });

  handle('inference:providers', () =>
    p.inference.providers().map((prov) => ({
      id: prov.id,
      supports: prov.supports,
      status: prov.status(),
    })),
  );
  handle('inference:install', async () => {
    await p.prefs.patch({
      models: { ...p.prefs.get().models, autoInstall: true },
    });
    bundled.localLlm.ensureInstalled();
  });
  handle('inference:cancel', async () => {
    await bundled.localLlm.cancelInstall();
    await p.prefs.patch({
      models: { ...p.prefs.get().models, autoInstall: false },
    });
  });
  handle('inference:stats', async () => ({
    ...(await p.store.extractionStats()),
    awaitingVlm: (await p.store.ledgerDeferred(VISION_CONSUMER)).length,
  }));
  handle('inference:models', async () => {
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
  });

  handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
  }));
  handle('app:open-path', ({ path: target }) => {
    shell.showItemInFolder(target);
  });
  // --- Auto-updater (ported from the alpha-cent overlay) ---------------------
  // Restart-and-reinstall is a whole-app, main-process concern, so it lives in
  // core. `product.updateFeedUrl` overrides the electron-builder-baked
  // app-update.yml when present; OSS core with no product.json leaves it
  // undefined and the eligibility gate keeps the updater idle/disabled.
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
  });
  registerUpdaterIpc(updater, {
    handle: (channel, fn) => handle(channel as never, fn as never),
    broadcast: (channel, payload) =>
      broadcast(channel as never, payload as never),
  });
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

  handle('marketplace:list', () => catalog.list());
  handle('marketplace:detail', ({ owner, repo }) =>
    catalog.detail(owner, repo),
  );
  handle('marketplace:check-updates', () => catalog.checkUpdates());

  handle('extension:install-preview', ({ ref }) =>
    extensions.installPreview(ref),
  );
  handle('extension:install-commit', ({ token }) =>
    extensions.installCommit(token),
  );
  handle('extension:uninstall', ({ id }) => extensions.uninstall(id));
  handle('extension:set-enabled', ({ id, enabled }) =>
    extensions.setEnabled(id, enabled),
  );
  handle('extension:grant-consent', ({ id }) => extensions.grantConsent(id));
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

    mcp = await startMcp({
      query: p.store.read,
      logSink: p.logSink,
      dataDir,
      onActivity: (rec) => act.append(rec),
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
    const broker = createConnectBroker(
      p,
      (event: ConnectEvent) => broadcast('push:connect', event),
      () => mainWindow ?? undefined,
    );
    const bundledRefreshers = registerBundledSources(
      (s) => p.sources.register(s),
      broker,
    );
    for (const [sourceId, refresher] of bundledRefreshers)
      p.refreshers.set(sourceId, refresher);

    // Built here (rather than at its historical spot right before
    // createWindow) so its TrayMenuController exists in time to hand to
    // buildMainApi below — bundled `unsafe.mainProcess` extensions can
    // splice tray items via `extras.mainProcess.ui.addTrayMenuItems` from
    // their very first activate().
    ({ tray, menu: trayMenu } = createTray(
      getAssetPath('icons', 'tray', 'trayTemplate.png'),
      {
        openWindow: () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
          } else {
            void createWindow();
          }
        },
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
      }),
      store: p.store,
      sources: p.sources,
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
    p.prefs.onChange((prefs) => patchState({ prefs }));
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
    // eslint-disable-next-line no-console
    console.error('boot failed', err);
  });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Clean shutdown must actually COMPLETE before the process exits, or the
// llama-server child (non-detached, idle-stopped up to 10 min later) outlives
// the app. Take over the quit: dispose the local-llm provider (stops the
// child + aborts any in-flight install) BEFORE tearing down the platform,
// then re-quit. Every step is bounded (LlamaServer.stop escalates to SIGKILL
// after a grace window), so quit can't hang.
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
    await mcp?.stop().catch(() => {});
    await extensionsPlatform?.stop().catch(() => {});
    await platform?.shutdown().catch(() => {});
    app.quit();
  })();
});
