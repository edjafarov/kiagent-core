# Backend Surface — kiagent-core main process

Reference document for replacing the Electron main-process backend with a new architecture
(event-log/engine design). Everything below is derived from the code as of this commit; every
key claim cites `file:line`. **No secret values appear in this document** — where credentials
exist, only their location is referenced.

Scope: `src/main/**`, `src/shared/**`, `packages/**`, `assets/bundled-connectors/**`.

Quick numbers:

- **IPC**: 78 invoke channels + 7 push channels = 85, all declared in one typed contract file (`src/main/ipc/channels.ts`).
- **DB**: 12 ordinary SQLite tables + 2 FTS5 virtual tables (`src/main/db/schema.sql`); 2 tables dormant.
- **Connectors**: 7 built-in (gmail, google-docs, ms365, onedrive, imap, browser, local-folder) + 1 bundled extension-class (kia.whatsapp).
- **MCP tools**: 7 (`search`, `get`, `count`, `get_related`, `digital_memory_info`, `query_sql`, `get_schema`), HTTP on `127.0.0.1:7421` + a stdio sibling process.
- **Extension host**: out-of-process `child_process.fork()` with `ELECTRON_RUN_AS_NODE=1`, 38-method Host API, 9 permission strings.

---

## 1. Boot sequence

Source: `src/main/main.ts`, `src/main/boot/*.ts`.

### 1.1 Module load (before `app.whenReady()`)

- `main.ts:190` — `app.setName(DEFAULT_BRAND.appName)` (must precede single-instance lock / whenReady).
- `main.ts:211` — `app.setAsDefaultProtocolClient(DEFAULT_BRAND.deeplinkScheme)` registers the `kia://` protocol for OAuth deeplinks.
- `main.ts:215-219` — `app.requestSingleInstanceLock()`; if not acquired: `app.quit()` + `process.exit(0)`.
- `main.ts:229-234` — global `uncaughtException`/`unhandledRejection` handlers log and keep the process alive (tray app with hide-on-close; must never hard-crash).
- `main.ts:238-243` — macOS `open-url` deeplinks arriving before ready are buffered into `pendingDeeplinks[]`.
- `main.ts:108-185` — console patch: wraps `console.*` to (a) prefix a timestamp, (b) parse a `[source]` prefix, (c) batch into `logBroadcastBatcher` (250 ms windows) flushed via `broadcast('push:log', records)`, (d) persist via `consoleLogPersist` (wired in core-services). Installed at module load so every later import inherits it.
- `main.ts:555-565` — prod installs `source-map-support`; dev/`DEBUG_PROD=1` installs `electron-debug`.

### 1.2 `app.whenReady()` — `main.ts:873-1235`, in order

**Section 0 — HostExtensions bootstrap** (`main.ts:881-884`): `host = createHostExtensions({...})`. In this OSS tree, `createHostExtensions` returns only `{ brand: DEFAULT_BRAND }` (`src/main/host/host-defaults.ts:16-22`) — the remote-MCP stack is a proprietary overlay and is inert here.

**Section 1 — Core services** (`main.ts:886-926` → `boot/core-services.ts:70-167`):

1. `defaultBaseDir(userData)` → `appPaths(base)`; `mkdirSync(base)`.
2. `PrefsStore` over `prefsFile(base)`; wires `setBrowserPrivacyProvider`.
3. Rotating log sink at `<logsDir>/app.log`, shared by both the console patch (`setConsoleLogPersist`) and the structured `createLogger` (one sink instance — see §9.3).
4. `prefsStore.onChange` re-applies log level/verbosity + `broadcast('push:prefs-updated', p)`.
5. Deletes stale legacy DuckDB file (one-time migration artifact, best-effort).
6. **`db = await openDbInWorker(paths.sqliteFile, dbWorkerFile)`** — the writable SQLite connection lives in a `worker_threads` Worker (webpack sibling bundle `dbWorker`). This await **must** complete before anything captures `db` by value (a past bug: an adapter closing over `undefined`).
7. `watchStdioActivity(...)` — watches the stdio-MCP marker file next to the sqlite file (§8.4).
8. Back in `main.ts:926` — `openStampConnection(paths.sqliteFile)`: a second, read-only better-sqlite3 connection used only for `PRAGMA data_version` (snapshot freshness gate).

**Remote-MCP bootstrap** (`main.ts:928-1002`): wires deeplink handlers (`open-url`, `second-instance`, initial argv) and drains `pendingDeeplinks`; the actual remote stack is proprietary and absent here.

**Section 2 — Connector services** (`main.ts:1020-1038` → `boot/connector-services.ts:47-84`):

1. `migrateConnectorsDir(userData)` — one-time rename `userData/connectors` → `userData/extensions`; **must run before the installer reads the dir**.
2. `reg = new ConnectorRegistry()` — starts **empty**; built-ins register only when their extension activates (Section 2b).
3. `registerConnectorByteSources(reg)` — byte sources for deep extraction (independent of registry population).
4. `converter = new Converter({ queueSize: 500 })` — shared doc-conversion pool, `min(4, cores-1)` workers.
5. `scheduler = new Scheduler(db, reg, { ctxFor, windowState })`; `ctxFor(id)` builds a per-account `ConnectorContextImpl(db, id, converter, { dataDir, safeStorage, emitStreamEvent, enqueueExtraction })`.

**Section 2b — Extension platform kernel** (`main.ts:1040-1069` → `boot/extension-platform.ts:88-345`):

1. `extDir = userData/extensions`; `ExtensionStateStore(extDir)`; `migrateExtensionState(extDir)`.
2. `seedBundledExtensions(...)` — copies `assets/bundled-connectors/*` (kia.whatsapp) into `userData/extensions` **before discovery** (idempotent, semver-gated).
3. `extRegistry = new ExtensionRegistry()`; `bridge = new ConnectorHostBridge({ registry: reg, scheduler, db })`.
4. `extManager = new ExtensionProcessManager({...})` — out-of-process fork supervisor; `onErrored` transitions the registry entry to `'errored'` and invalidates live remote-connector instances.
5. `registerConnectorExtensions({ modules: BUILTIN_MODULES, ... })` — registers the 7 built-ins as platform extensions (bare ids like `gmail`); failure is caught, boot continues.
6. `discoverExtensions(extDir, isEnabled)` + `registerDiscoveredExtensions({...})` — third-party extensions discovered (manifest-only, no code executed) and registered with lazy fork-backed modules; activation deferred to `fireActivationEvent('onStartup')`.

**Section 2c — Inference services** (`main.ts:1071-1100` → `boot/inference-services.ts:97-371`):

1. Host probes → `detectHostBackend` (cpu/vulkan/metal, cached per launch) → `selectCuratedModel` (RAM/VRAM tier).
2. `windowsOcrHelper` (win32 only, gated by `selftest()`); computes `singleModelRuntime` (true on Linux and helper-less Windows).
3. `deepRuntime = new RuntimeManager({...})` — owns llama.cpp server lifecycle.
4. `registerRuntimeIpc(deepRuntime, ...)` — the `deep-runtime:*` channels.
5. `inferenceService = new InferenceService({ db, extractor, sources, signals, ... })` — the adaptive OCR/VLM drain scheduler.

**Section 2d — Start sequence** (`main.ts:1102-1116` → `boot/start-sequence.ts:41-212`) — **order is load-bearing** (asserted by `start-sequence.test.ts`):

1. One-shot heals (each independently try/caught): `recomputeMissingDocCounts`, `gcOrphanedInferenceJobs` (**must precede `inferenceService.start()`**), `recomputeMissingTrackedRoots`, `backfillLanguages`, `correctEmptyBodyLanguages`, browser-profile refresh (never *creates* the Browsers account), `reapAbandonedPendingPairings` (**must precede `scheduler.start()`** or the scheduler revives zombie `pending-%` pairing accounts).
2. `await scheduler.start()`.
3. `deepRuntime.resumeStandby()`.
4. `inferenceService.start()`.
5. `await fireActivationEvent('onStartup')` — activates enabled third-party extensions.
6. Fire-and-forget: `inferenceService.backfillOnce(db)` and `reprocessUnsupportedAttachments(db, converter, upsertAdapter)`.

**Section 3 — MCP server** (`main.ts:1118-1132`): `mcp = await startMcpServer({ db, dbFilePath, host: '127.0.0.1', port: 7421, bearerToken: null, onSessionInitialized })`. `onSessionInitialized` latches the `mcpConnectedAt` onboarding pref.

**Section 4 — IPC handlers** (`main.ts:1134-1182` → `boot/ipc-services.ts:93-232`): runs **after** the MCP server (needs `mcpPort`) and after the extension kernel (needs registry/lifecycle/state/extManager).

**Section 5 — Periodic push** (`main.ts:1184-1197`): every 5 s, if `stateGate.isCachedFresh()` is false, `broadcast('push:state-updated', await snapshot())` — the catch-up path for passive corpus changes; mutating IPC handlers call `publishState()` directly.

**Section 6 — Tray + window** (`main.ts:1199-1233`): `applyLaunchAndTrayPrefs`, `createWindow()` (fire-and-forget), macOS `activate` handler.

### 1.3 `createWindow()` (`main.ts:580-777`)

- `BrowserWindow` 1024×728 (min 720×480), `titleBarStyle:'hidden'`, preload = `preload.js` sibling in packaged/E2E builds, else dev DLL preload.
- 4 s fallback `show()` if `ready-to-show` never fires.
- **Hide-on-close**: `close` is `preventDefault()`ed and hides; only tray "Quit" sets `isQuitting`. `window-all-closed` is a deliberate no-op (`main.ts:867-871`).
- `focus/blur/show/hide/minimize/restore` → `scheduler.onWindowStateChange()` (drives 30 s / 120 s / 600 s delta cadence).
- Constructs `updater` via `host.createUpdater(...)` + `registerUpdaterIpc` (host-provided; proprietary overlay in prod).

### 1.4 Teardown (`app.on('before-quit')`, `main.ts:790-865`) — drain order matters

1. clear the 5 s broadcast interval → stop updater → stop stdio-activity watcher → `logBroadcastBatcher.flushNow()`.
2. `scheduler.shutdown()` → `converter.shutdown()` → `extManager.shutdownAll()` → `inferenceService.stop()` (fired) → `deepRuntime.stop()` (kills llama-server so an in-flight VLM call fails fast) → await inference stop → `stopByteSourceWorkers()` → `mcp.stop()` → `remoteStack.stop()` → `db.close()` → `stampConn.close()`.

### 1.5 Env vars / flags

`NODE_ENV=development` / `DEBUG_PROD=1` (isDebug), `UPGRADE_EXTENSIONS` (devtools re-download), `E2E=1` (built-asset paths while unpackaged), `START_MINIMIZED`, `KIAGENT_DEV_UPDATES=1`, `GOOGLE_OAUTH_CLIENT_ID`/`GOOGLE_OAUTH_CLIENT_SECRET`, `MICROSOFT_OAUTH_CLIENT_ID` (§4.2).

---

## 2. Complete IPC surface

**Single source of truth**: `src/main/ipc/channels.ts`. `BaseContractMap` (`channels.ts:53-305`) types every invoke channel's `req`/`res`; `BasePushMap` (`channels.ts:311-319`) types every push payload. Compile-time assertions (`channels.ts:419-439`) force the runtime arrays (`BaseInvokeChannels`/`BasePushChannels`, re-exported by `base-channel-registry.ts`) into bijection with the type maps and keep the invoke/push namespaces disjoint. `preload.ts:8-26` exposes exactly two functions on `window[DEFAULT_BRAND.ipcBridgeGlobal]`: `invoke(channel, payload?)` and `on(channel, listener)` (returns unsubscribe), both throwing on unknown channels. **No IPC exists outside this file.** A rebuild should treat `channels.ts` as the IPC spec rather than reverse-engineering handlers.

`ContractRegistry`/`PushRegistry` (`channels.ts:27-28`) are empty augmentable interfaces for a proprietary overlay (`ipc-ext/*`) not present in this repo — `BaseContractMap`/`BasePushMap` are the complete set here: **78 invoke + 7 push**.

All handlers register through the `handle`/`handleSafe` wrappers in `src/main/ipc/handlers.ts` (error envelope + logging). `broadcast()` (`handlers.ts:56-62`) loops all `BrowserWindow.getAllWindows()`.

### 2.1 Invoke channels (renderer → main)

#### App / system / auth / prefs / logs

| Channel | Request | Response | File:line | Purpose |
|---|---|---|---|---|
| `app:get-state` | `void` | `AppState` (see `snapshot.ts`) | `app-system-handlers.ts:69` | Full app-state snapshot (accounts, sync state, mcp port, auth, cadence) |
| `app:get-version` | `void` | `string` | `app-system-handlers.ts:70` | `app.getVersion()` |
| `app:get-log-path` | `void` | `string` | `app-system-handlers.ts:71` | Absolute path to `app.log` |
| `app:read-recent-logs` | `{ limit?: number }` | `LogRecord[]` (oldest first, clamp 1–5000, default 1000) | `app-system-handlers.ts:78` | Rehydrate Logs screen |
| `app:open-path` | `{ kind?: 'log-file'\|'data-folder'\|'logs-dir'\|'claude-desktop-config' }` | `{ok:true,path}` \| `{ok:false,error}` | `app-system-handlers.ts:93` | Open allow-listed path in Finder/editor (channels.ts types only the first two kinds; handler accepts four) |
| `app:show-main-window` | `string` (route, optional) | void | `app-system-handlers.ts:178` | Focus/show window, optionally navigate |
| `app:quit` | `void` | `void` | `app-system-handlers.ts:173` | Quit |
| `auth:sign-in` | `{ provider?: 'google'\|'microsoft', withGmail?: boolean }` | `RunSignInResult` = `{ok:true,email}` \| `{ok:false,error,message}` | `auth-handlers.ts:90` | App identity OAuth (optionally also connects Gmail) |
| `auth:sign-out` | `void` | `unknown` | `app-system-handlers.ts:152` | Clear identity + lifecycle hook |
| `auth:use-locally` | `void` | `{ok:boolean,error?}` | `prefs-handlers.ts:44` | "Use locally" — sets `usingLocally:true` pref |
| `prefs:get` | `void` | `AppPrefs \| null` | `prefs-handlers.ts:29` | Read prefs |
| `prefs:set` | `PrefsPatch` | `{ok:true,prefs}` \| `{ok:false,error}` | `prefs-handlers.ts:30` | Patch prefs (shallow merge; deep-merges `onboarding`/`deepExtraction`) |
| `suggestions:get` | `void` | `Suggestion[]` | `prefs-handlers.ts:54` | Deterministic FTS-based prompt suggestions (no LLM) |
| `storage:get-stats` | `void` | `StorageStats` | `app-system-handlers.ts:163` | DB size, per-source counts, extraction status |
| `logs:export-zip` | `void` | `{ok:true,path,bytes,fileCount}` \| `{ok:false,canceled?,error?}` | `app-system-handlers.ts:184` | Save-dialog + zip logs dir |

#### Connector lifecycle

| Channel | Request | Response | File:line | Purpose |
|---|---|---|---|---|
| `connector:list` | `void` | account rows (`AccountsRepository.listAll()`) | `connector-lifecycle-handlers.ts:36` | List connector accounts |
| `connector:sync-now` | `{ accountId?: string\|null }` | void | `connector-lifecycle-handlers.ts:38` | Immediate delta tick; no id = all enabled (tray "Sync now") |
| `connector:pause` | `{ accountId?: string\|null }` | void | `connector-lifecycle-handlers.ts:51` | No id = process-wide pause/resume toggle (not persisted); with id = per-account pause (persists `status='paused'`) |
| `connector:resume` | `{ accountId: string }` | `{ok,error?}` | `connector-lifecycle-handlers.ts:72` | `status→pending`, `scheduler.restartAccount` |
| `connector:set-cadence` | `{ accountId, focusedMs, unfocusedMs }` | `{ok:true}` \| `{ok:false,error}` | `connector-lifecycle-handlers.ts:102` | Per-account poll cadence (min 5 s, max 24 h) |
| `connector:remove-account` | `{ accountId, purge?: boolean }` | `{ok:true,purged:false}` \| `{ok:true,purged:true,deleted}` | `connector-lifecycle-handlers.ts:120` | Soft-disable, or hard-delete (docs one-by-one, then tracked_roots/sync_state/cadence/account) |
| `connector:retry-backfill` | `{ accountId? }` | `{ok,error?}` | `connector-lifecycle-handlers.ts:171` | Reset `backfill_done_count` (cursor survives), rerun backfill |
| `mcp:activity:get` | `void` | `ActivitySnapshot` = `{state:'idle'\|'mcp'\|'error'\|'paused', pulseSeq, lastCallAt, lastErrorAt}` | `connector-lifecycle-handlers.ts:118`; shape `mcp/activity.ts:5-10` | MCP activity indicator snapshot |

#### Add-account / wizard dispatch

| Channel | Request | Response | File:line | Purpose |
|---|---|---|---|---|
| `connector:add-gmail-account` | `void` | `{ok:true,accountId,email}` \| `{ok:false,error,message}` | `connector-add-account-handlers.ts:78` | Interactive Gmail OAuth + persist |
| `connector:add-google-docs-account` | `void` | same | `connector-add-account-handlers.ts:103` | Drive OAuth; token blob under `oauthDir`; `configJson:{clientId,clientSecret}` |
| `connector:add-ms365-account` | `void` | same | `connector-add-account-handlers.ts:177` | MS365 PKCE OAuth + persist |
| `connector:add-onedrive-account` | `void` | same | `connector-add-account-handlers.ts:269` | OneDrive OAuth; decodes `tenantId` from id_token; `configJson:{clientId,tenantId}` |
| `connector:list-manifests` | `void` | `ConnectorManifest[]` | `connector-add-account-handlers.ts:243` | All 7 built-in manifests + registered third-party modules (de-duped) |
| `connector:add-account` | `{ connectorId, payload?: Record<string,unknown> }` | hook result | `connector-add-account-handlers.ts:246` | Generic dispatch: `registry.getModule(id).manifest.submit` hook, invoked with `SetupCtx` |
| `connector:stream-begin` | `{ connectorId }` | hook result | `connector-add-account-handlers.ts:253` | Starts a manifest `live-stream` step (e.g. WhatsApp QR pairing) |
| `connector:account-action` | `{ connectorId, action, payload? }` | hook result | `connector-add-account-handlers.ts:262` | Post-setup action dispatch via `hooks[action]` |

Note: IPC never hardcodes per-connector logic here — hooks are resolved by name off the manifest. Preserve (or deliberately replace) this manifest-driven indirection.

#### Folder pickers / tracked roots (handlers in `folder-picker-handlers.ts`)

| Channel | Request | Response | File:line |
|---|---|---|---|
| `connector:list-drive-folders` | `{accountId?,parentId?,pageToken?}` | `{ok,folders,nextPageToken}` \| `{ok:false,error}` | `:231` |
| `connector:count-drive-folder-files` | `{accountId?,folderId?}` | `{ok:true,count,capped}` \| err | `:266` |
| `connector:search-drive-folders` | `{accountId?,query?,sourceTab?:'all'\|'mydrive'\|'shared'}` | `{ok:true,hits:{id,name,path}[]}` \| err | `:303` |
| `connector:add-drive-folder` | `{accountId?,folderId?,displayPath?}` | `{ok:true,rootId}` \| err | `:356` |
| `connector:remove-drive-folder` | `{accountId?,rootId?}` | `{ok:true}` \| err | `:401` |
| `connector:list-onedrive-folders` | `{accountId?,parentId?,pageToken?}` | `{ok,folders,nextPageToken}` \| err | `:26` |
| `connector:add-onedrive-folder` | `{accountId?,itemId?,displayPath?}` | `{ok:true,rootId}` \| err | `:66` |
| `connector:remove-onedrive-folder` | `{accountId?,rootId?}` | `{ok:true}` \| err | `:182` |
| `connector:ensure-local-account` | `void` | `{ok:true,accountId}` \| err | `:464` |
| `connector:list-local-folders` | `{path?, special?:'quick'\|'drives'}` | `{ok:true,entries}` \| err | `:433` |
| `connector:count-local-files` | `{path?}` | `{ok:true,count,capped}` \| err | `:450` |
| `connector:add-local-folder` | `{accountId?,path?}` | `{ok:true,rootId}` \| err | `:499` |
| `connector:remove-local-folder` | `{accountId?,rootId?}` | `{ok:true}` | `:526` |

#### Browser privacy

| Channel | Request | Response | File:line |
|---|---|---|---|
| `connector:browser-detect-and-add` | `void` | `{ok:true,added}` \| err | `browser-privacy-handlers.ts:21` |
| `connector:browser-get-privacy` | `void` | `BrowserHistoryPrefs` | `browser-privacy-handlers.ts:48` |
| `connector:browser-set-privacy` | `{windowDays?, blocklist?: string[]}` | `{ok:true,browserHistory}` | `browser-privacy-handlers.ts:52` |

#### Extension install / marketplace

| Channel | Request | Response | File:line | Purpose |
|---|---|---|---|---|
| `connector:install-preview` | `{ ref: string, hash?: string }` | `{ok:true,token,manifest,version,integrity,sizeBytes,permissions[]}` \| `{ok:false,error}` | `extension-install-handlers.ts:496`; type `channels.ts:114-127` | Download + verify + stage (consent gate), no commit |
| `connector:install-commit` | `{ token }` | `{ok:true,id}` \| `{ok:false,error}` | `extension-install-handlers.ts:499` | Commit staged install; **hot-registers + activates out-of-process with no restart** |
| `connector:list-installed` | `void` | `{id,version,ref,enabled,displayName,loadError?}[]` | `extension-install-handlers.ts:502` | Installed third-party list |
| `connector:uninstall` | `{ id }` | `{ok,error?}` | `extension-install-handlers.ts:503` | Built-ins refuse; third-party: fork teardown + dir removal |
| `connector:set-connector-enabled` | `{ id, enabled }` | `{ok,error?}` | `extension-install-handlers.ts:506` | Branches solely on `manifest.entry === 'builtin'`: in-process lifecycle vs out-of-process fork; persists via `ExtensionStateStore` |
| `extension:install-preview` / `install-commit` / `list-installed` / `uninstall` / `set-enabled` | aliases of the five above | same | `extension-install-handlers.ts:511-521`; `channels.ts:153-158` | UI-facing aliases, identical impls |
| `marketplace:list` | `void` | `MarketplaceListItem[]` = `{owner,repo,fullName,displayName,description,origin:'official'\|'user',installed?:{id,version,enabled,grantedPermissions}}` | `marketplace/ipc.ts:85` | GitHub org+topic catalog + user sources |
| `marketplace:detail` | `{ owner, repo }` | `PluginDetail` | `marketplace/ipc.ts:86` | README/screenshots detail |
| `marketplace:add-source` | `{ owner, repo }` | `UserSource[]` | `marketplace/ipc.ts:89` | Add user GitHub source |
| `marketplace:list-sources` | `void` | `UserSource[]` | `marketplace/ipc.ts:92` | List user sources |
| `marketplace:remove-source` | `{ owner, repo }` | `UserSource[]` | `marketplace/ipc.ts:93` | Remove user source |
| `marketplace:check-updates` | `void` | `UpdateInfo[]` | `marketplace/ipc.ts:96` | Installed versions vs latest refs |

#### MCP connection wiring

| Channel | Request | Response | File:line | Purpose |
|---|---|---|---|---|
| `mcp-stdio:get-config` | `void` | `StdioLaunchDescriptor` | `boot/ipc-services.ts:183` | Manual Claude-Desktop stdio snippet |
| `connection:list-clients` | `void` | `ClientInfo[]` = `{id,label,transport,configPath,detected,connected}` (`clients/types.ts:35-42`) | `connection-handlers.ts:37` | Known MCP clients + state |
| `connection:connect` | `{ clientId }` | `{ok:true,path,backupPath}` \| `{ok:false,error}` | `connection-handlers.ts:39` | Write client MCP config (§8.3) |
| `connection:disconnect` | `{ clientId }` | same | `connection-handlers.ts:47` | Remove entry from client config |

#### Data maintenance

| Channel | Request | Response | File:line | Purpose |
|---|---|---|---|---|
| `data:purge-archived` | `void` | `{ok:true,purged}` | `data-maintenance-handlers.ts:82` | Hard-delete soft-archived docs |
| `data:compact` | `void` | `{ok:true,beforeBytes,afterBytes}` \| err | `data-maintenance-handlers.ts:89` | VACUUM |
| `data:rebuild-fts` | `void` | `{ok:true,indexed}` \| err | `data-maintenance-handlers.ts:107` | Rebuild FTS from source rows |
| `data:clear-backfill-cache` | `void` | `{ok:true,cleared}` \| err | `data-maintenance-handlers.ts:121` | Reset backfill counters |
| `data:reset-all` | `void` | `{ok:true}` | `data-maintenance-handlers.ts:137` | Factory reset. **Order is safety-critical** (`:150-156`): stop scheduler per account → `lifecycle.resetAll.beforeDataWipe` (remote-MCP transport) → `resetAllData(db)` → delete all `oauthDir` files → `afterDataWipe` (cert/token) → `clearIdentity()` → `resetPrefs()` → `clearStdioActivityMarker()` |

#### Deep-extraction runtime (registered by `registerRuntimeIpc`, `inference/runtime/ipc.ts`)

| Channel | Request | Response | File:line | Purpose |
|---|---|---|---|---|
| `deep-runtime:get-status` | `void` | `RuntimeStatus` (+ `installedModelIds: string[]`) | `ipc.ts:38-42` | Runtime state, model, download progress |
| `deep-runtime:enable` | `void` | `void` | `ipc.ts:43` | Enable local runtime (persists pref) |
| `deep-runtime:disable` | `void` | `void` | `ipc.ts:44` | Disable |
| `deep-runtime:cancel` | `void` | `void` | `ipc.ts:45` | Cancel in-flight download/start |
| `deep-runtime:set-model` | `{ modelId?: string }` (default `'auto'`) | `RuntimeStatus` | `ipc.ts:47-50` | Persist model override + restart onto it |
| `deep-runtime:process-now` | `void` | `void` | `ipc.ts:51-53` | Session-scoped bypass of the schedule gate (not the battery/thermal gate), immediate pass |

### 2.2 Push channels (main → renderer)

| Channel | Payload | Emitted from | Trigger |
|---|---|---|---|
| `push:state-updated` | `AppState` | `main.ts:442` (`publishState()`), `main.ts:1193` (5 s interval) | Any mutating handler; periodic catch-up |
| `push:log` | `LogRecord[]` (250 ms batches, max 200/flush) | `main.ts:98` via `logBroadcastBatcher` | Every log emit |
| `push:prefs-updated` | `AppPrefs` | `boot/core-services.ts` via `main.ts:916` | Any `prefsStore.set()` |
| `app:navigate` | `string` (route) | `main.ts:448` (`showMainWindow(route)`) | Deeplink / tray / notification click |
| `push:connector-stream` | connector stream event (`{connectorId, accountId: string, qr?, status?, error?}` per SDK) | `connector-services.ts:76`, `extension-platform.ts:149`, `platform/connector-host-deps.ts:78` | Live-stream wizard steps (QR pairing etc.) |
| `push:mcp-activity` | `ActivitySnapshot` | `main.ts:271-277` | MCP tool-call pulses; also latches `firstQueryAt` |
| `push:deep-runtime-status` | `RuntimeStatus` | `inference/runtime/ipc.ts:55-57` | Runtime/download state changes |

---

## 3. Database

### 3.1 Engine & access model

- **Engine**: `better-sqlite3` (synchronous native binding). File: `<userData>/alpha-cent/mail.sqlite` (`src/main/paths.ts:12-21`). `paths.ts:16` still defines `legacyDuckdbFile: mail.duckdb` — dead constant, no consumer; safe to drop.
- **Worker-hosted writes**: the only writable connection lives in a `node:worker_threads` Worker (`src/main/db/worker-entry.ts`, client `worker-client.ts`); rationale (`worker-client.ts:6-9`): better-sqlite3 is synchronous, so VACUUM/checkpoints/large transactions would freeze the UI thread.
- **Secondary readers**: `openCorpusReadConnection()` (`db/index.ts:196-210`) for the stdio MCP server & tests — opens the same file read-write (not `readonly:true`, so WAL recovery works) but callers issue only SELECT; does not run migrations or set journal_mode. Additionally the main process holds a read-only "stamp" connection just for `PRAGMA data_version` (`main.ts:926`).
- **Bridge protocol** (`db/bridge.ts`): `{op:'exec'|'all'|'run'|'batch'|'close', id}` → `{id, ok, value|error}`. `Date` is coerced to ISO strings (cross-realm `[object Date]` sniffing, not `instanceof`); `Buffer` crosses as `Uint8Array` and is rewrapped (`bridge.ts:71-88`).
- **Atomicity primitive**: `AppDb.batch(steps)` (`db/index.ts:21-40`) — the *only* multi-statement transaction mechanism. A step's params can reference an earlier step's returned row via `{ $fromStep: n, column: 'id' }`, used pervasively by `DocumentsRepository.upsert`. `_conn.transaction()` is unavailable to production main-process code.
- **Pragmas** (`db/index.ts:172-176`): `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`, and `defaultSafeIntegers(true)` — **every INTEGER comes back as `bigint`** throughout the repository layer (except `tracked_roots.id`, which is a TEXT UUID).
- Prepared-statement cache: 512 entries by SQL text, wholesale-cleared on overflow (`index.ts:92-143`).

### 3.2 Tables (schema: `src/main/db/schema.sql`; 12 ordinary + 2 FTS5)

#### `documents` (schema.sql:2-22) — ACTIVE, central table
One row per ingested item across all connectors.

| Column | Type / constraint |
|---|---|
| `id` | INTEGER PRIMARY KEY |
| `source` | TEXT NOT NULL (connector id: `gmail`, `google-docs`, `ms365`, `onedrive`, `imap`, `browser`, `local-folder`, plus historical `slack`/`whatsapp`/`notion` seen in migrations) |
| `source_id` | TEXT NOT NULL (natural key within source) |
| `type` | TEXT NOT NULL (`email_thread`, `attachment`, `file`, `doc`, …) |
| `parent_id` | INTEGER (no FK; attachment → thread) |
| `title`, `markdown`, `metadata` (JSON), `source_url` (NOT NULL), `content_hash`, `from_address` | TEXT |
| `account_id` | INTEGER — added by migration `addDocumentsAccountId` (`migrations.ts:41-53`); NULL when legacy ownership underivable |
| `created_at`, `ingested_at` (DEFAULT strftime), `updated_at` | TEXT |
| `UNIQUE(source, source_id, type)` | |

Indexes: `idx_documents_content_hash`, `idx_documents_source_type(source,type)`, `idx_documents_from_address`, and `idx_documents_account_id(source, account_id)` (created by migration, not schema.sql). Written by `DocumentsRepository.upsert` (`repositories/documents.ts:283-330`) as one atomic batch that also rewrites FTS/trigram/language rows. Archival is a metadata-JSON rewrite, **not a column**.

#### `accounts` (schema.sql:29-39) — ACTIVE
`id` INTEGER PK; `source` TEXT NOT NULL; `identifier` TEXT NOT NULL; `UNIQUE(source, identifier)`; `display_name`; `config_json` (non-secret config); `credentials_blob_path` (path to encrypted blob on disk — the blob is NOT in the DB); `enabled` INTEGER DEFAULT 1; `created_at`. Owned by `AccountsRepository` (`repositories/accounts.ts`, ~780 lines, also owns sync_state + cadence SQL).

#### `sync_state` (schema.sql:41-49) — ACTIVE
1:1 with accounts: `account_id` INTEGER PK; `status` TEXT (`pending`/`backfilling`/`live`/`error`/`paused`/`needs_reauth`); `backfill_total_estimate`, `backfill_done_count` INTEGER; `cursor_json` TEXT (opaque per-connector cursor); `last_sync_at`, `last_error` TEXT. All writes go through named `AccountsRepository` methods (`resetForBackfill`, `stampDeltaSuccess`, `setDeltaNeedsReauth`, `upsertPaused`, `saveSyncState`, …) — a deliberate design (`db/sync-state.ts:1-10`) after ad-hoc upserts caused a column-wipe regression.

#### `tracked_roots` (schema.sql:51-68) — ACTIVE
Polymorphic synced root: `id` **TEXT PK (UUID — the only non-integer PK)**; `account_id` INTEGER; `kind` TEXT DEFAULT 'fs' CHECK in (`fs`,`drive`,`ms-drive`,`browser`); `abs_path`, `external_id`, `display_path`, `include_glob`, `exclude_glob`, `last_full_scan_at`, `added_at`. CHECK: fs/browser need `abs_path`, drive/ms-drive need `external_id`. UNIQUE index `idx_tracked_roots_unique_per_account (account_id, kind, COALESCE(external_id, abs_path))` (created by migration).

#### `drive_folder_index` (schema.sql:69-81) — ACTIVE
Drive/OneDrive folder-tree mirror: `account_id`, `file_id`, `parent_id`, `is_folder`, `tracked_root_id`; composite PK `(account_id, file_id, parent_id)` (multi-parent files = multiple rows). Indexes: `idx_drive_folder_index_parent(account_id,parent_id)`, partial `idx_drive_folder_index_root(...) WHERE tracked_root_id IS NOT NULL`. `walkAncestors` is a bounded 64-hop BFS, deliberately not a recursive CTE.

#### `document_embeddings` (schema.sql:83-87) — **DORMANT**
`document_id` INTEGER PK, `model` TEXT, `embedding` BLOB. Zero production INSERTs anywhere; only DELETE cascades (`documents.ts:95-118`) and a COUNT for storage stats. Placeholder for a never-wired vector feature.

#### `inference_jobs` (schema.sql:94-110) — ACTIVE
OCR/extraction backlog: `document_id` INTEGER PK; `state` TEXT NOT NULL (`pending`/`processing`/`ocr_done`/`done`/`skipped`/`failed`); `reason`, `attempts` (DEFAULT 0), `last_error`, `engine`, `content_hash`, `created_at`, `updated_at`. Indexes: `idx_inference_jobs_state(state)`, `idx_inference_jobs_state_created(state, created_at)`. Renamed from `deep_extractions` by `renameDeepExtractionsToInferenceJobs` (`migrations.ts:101-119`). `claim()` is a single atomic `UPDATE … RETURNING` — the sole double-claim prevention; **never decompose into SELECT-then-UPDATE**. `enqueue()` is deliberately non-transactional (`INSERT OR IGNORE` race-tolerant).

#### `inference_meta` (schema.sql:115-118) — ACTIVE (narrow)
`key` TEXT PK, `value` TEXT. Exists because there is no general KV store in the DB; holds the one-time inference backfill marker (`inference-jobs.ts:255-270`).

#### `annotations` (schema.sql:120-129) — **DORMANT**
`id` PK, `document_id`, `kind`, `author`, `content`, `metadata`, `created_at`, `expires_at`. No production INSERT (only test fixtures); production only DELETE-cascades it.

#### `documents_fts` (schema.sql:131-136) — FTS5, ACTIVE
```sql
CREATE VIRTUAL TABLE documents_fts USING fts5(
  title, from_address, body, tokenize = 'unicode61 remove_diacritics 2');
```
`rowid` = `documents.id`. **No triggers** — kept in sync application-side inside `DocumentsRepository.upsert`'s batch (DELETE + INSERT per upsert, `documents.ts:304-313`). Content is a **stemmed search view** (`search/stemming.ts`), not raw text. Ranked via `bm25(documents_fts, 5.0, 3.0, 1.0)`. After bulk wipes, `INSERT INTO documents_fts(documents_fts) VALUES('optimize')` is required to reclaim space (`documents.ts:255-260`).

#### `documents_tri` (schema.sql:138-142) — FTS5 trigram, ACTIVE
`body, tokenize='trigram'`; `rowid` = `documents.id`; stores **raw** markdown. Fallback recall widened via RRF merge with bm25 in the caller (MCP `search`). Query builders: `toFtsMatch()` / `toTrigramMatch()` (`search/fts-query.ts:12-29`; trigram tokens ≥ 3 chars).

#### `document_languages` (schema.sql:149-155) — ACTIVE
`document_id`, `lang` (ISO 639-3 or `'und'`), `score` REAL; PK `(document_id, lang)`; index `idx_document_languages_lang`. Detection: `franc-min`, paragraph-segmented, `MIN_SCORE=0.1` (`search/language.ts`). Written in the same upsert batch.

#### `connector_cadence` (schema.sql:164-169) — ACTIVE
`account_id` INTEGER PK, `focused_ms`, `unfocused_ms` INTEGER NOT NULL, `updated_at`. Written by `connector:set-cadence`; missing row = compiled-in defaults. Re-keyed from `source`-PK by `rekeyConnectorCadenceToAccount` (`migrations.ts:71-89`).

#### `imap_message_index` (schema.sql:175-191) — ACTIVE (IMAP only)
`account_id`, `folder`, `uid`, `uidvalidity`, `message_id`, `thread_key`, `date`, `has_attachments`; PK `(account_id, folder, uid)`; indexes `idx_imap_thread(account_id,thread_key)`, `idx_imap_msgid(account_id,message_id)`, `idx_imap_subject(account_id,thread_key,date)`. Owned by `ImapMessageIndexRepository` — the only account-scoped repository (`repositories/index.ts:49-57`). Subject-fallback grouping is **in-memory only**, does not survive restart mid-backfill.

#### `oidc_payload` — DOES NOT EXIST here
Contributed via the `DbExtension.onSchemaLoaded` seam, but `OidcPayloadRepository` (`src/main/oidc/oidc-payload.ts`) is an OSS stub: empty `schemaSql()`, `hasGrant()` always false. Do not reimplement unless restoring the proprietary remote-MCP OAuth server; **do** preserve the `DbExtension` seam (schema hook + `resetSteps()` + `hasGrant()`).

### 3.3 Migrations (`src/main/db/migrations.ts:16-30`)

No numbered migration list. Mechanism: (1) re-exec the entire `schema.sql` every boot (all `IF NOT EXISTS`); (2) a fixed hand-ordered sequence of idempotent one-off functions for what `IF NOT EXISTS` can't do: `dropLegacyLocalFolderSingleton` → `addTrackedRootsDiscriminator` → `relaxTrackedRootsAbsPathNotNull` (table rebuild) → `mergeLocalFolderAccounts` → `dropLegacyBrowserProfileAccounts` → `addDocumentsAccountId` (+ per-source ownership backfill) → `rekeyConnectorCadenceToAccount` (table rebuild) → `renameDeepExtractionsToInferenceJobs`. Idempotency via marker checks or try/catch on SQLite's "duplicate column name" message; rebuilds run in a single `BEGIN…COMMIT` exec block.

---

## 4. Connectors

### 4.1 Module contract (`src/main/connectors/types.ts`, `module-types.ts`)

```
ConnectorModule = { manifest: ConnectorManifest, connector: Connector,
                    hooks: Record<string, Hook>, makeByteSource?(deps) => ByteSource }
```

- `Connector` (`types.ts:33-43`): `id`, `displayName`, `capabilities` (`multiAccount`, `requiresAuth`, `supportsBackfill`, `supportsDelta`, `supportsRealtime`), `getAccountSchema()`, `validateAccount(input)`, `createInstance(account, ctx)`.
- `ConnectorInstance` (`types.ts:45-65`): `startBackfill(progress)`, `pollDelta()`, optional `startRealtime()`/`stopRealtime()`/`reconcile()`/`requestStop()`, `shutdown()`, `buildSourceUrl(sourceId, type, metadata)`.
- Hooks (`module-types.ts:46-74`): `ValidateHook`, `SubmitHook`, `OAuthIdentityHook`, `GenerateHook`, `BeginStreamHook`/`CancelStreamHook`, `FieldRuleHook` — dispatched by name from generic wizard IPC.
- `SetupCtx` (`module-types.ts:25-44`): `db`, `scheduler`, `oauthDir`, `publishState()`, `getConverter()`, `safeStorage`, `pickFile()`, `hostFor(accountId)`, `restartAccount`, `removeAccount`, `restartAccountAndBroadcast`.
- Manifest (zod, `connectors/manifest.ts`): `id`, `displayName`, `icon`, `capabilities`, `inAddSource`, `pollable`, `submit?`, `steps[]` (union: `instruction`, `show-copyable`, `input-fields`, `oauth`, `live-stream`, `resource-picker`, `auto`), `configPanel?`, `actions?`, `permissions?`; extension-class extras: `version`, `hostApi`, `entry`, `scopeNote`, `addLabel`.
- `BUILTIN_MODULES` (`connectors/index.ts`) = the 7 first-party connectors; boot-validated by `validateBackendModule` (`module-types.ts:126-149`).
- Host API gate: `HOST_API_VERSION = '2.0.0'` (`connectors/host-api.ts`), semver-range checked against manifest `hostApi`.

Runtime context: `ConnectorContextImpl` (`src/main/context/connector-context.ts`) — per-account; exposes `dataDir` (`<userData>/alpha-cent/connector-data`), `safeStorage`, `db`, `converter`, `emitStreamEvent`, `enqueueExtraction(documentId)`, `upsertDocument` (stamps `account_id`, language detection, FTS views; **yields every ~8 ms/64 upserts and backs off further while user is interactive**), `deleteDocument`, `archiveDocument`, `findBySourceId`, `findByContentHash`, `saveSyncState`/`loadSyncState`, `listTrackedRoots`.

### 4.2 Shared OAuth / credential infrastructure

- **Loopback capture — not a real server** (`oauth-shared/capture-auth-code.ts`): `REDIRECT_URI = 'http://127.0.0.1:34123/oauth/callback'` (fixed port **34123**) is only a registered redirect *string*; an Electron `BrowserWindow` (520×720, partition `persist:oauth`) intercepts the navigation via `session.webRequest.onBeforeRequest`, cancels the request, and extracts `code`/`error`/`state` from the URL. **Nothing ever listens on 34123.** CSRF state check per RFC 8252 §8.9. Used by both Google and Microsoft flows.
- **Token storage** (`oauth-shared/safe-storage-blob.ts`): `StoredToken = { access_token, refresh_token, expires_at, scope, token_type:'Bearer' }`, encrypted with Electron `safeStorage` (Keychain/DPAPI/libsecret) and written as a file (mode 0600) at `accounts.credentials_blob_path` (a random-UUID filename under `<baseDir>/oauth/`). Same blob format reused for IMAP passwords (`imap/token.ts`).
- **Refresh** (`oauth-shared/token-refresh-worker.ts`): `TokenRefreshWorker` refreshes on a 60 s interval and on-demand when `expires_at - now < 5 min`; on failure calls `onNeedsReauth()` → `sync_state.status='needs_reauth'` and stops. `createOAuthInstance` (`oauth-shared/create-instance.ts`) is the shared `ConnectorInstance` skeleton for gmail/google-docs/ms365/onedrive. `withAccountTokenWorker()` gives one-shot handlers (folder pickers) a short-lived token.
- **Google client credentials**: bundled installed-app client id + secret constants at `google-shared/client-credentials.ts:13-14` (**values not reproduced here**; Google documents this as non-sensitive for installed apps). Overridable via env `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` (`client-credentials.ts:23-26`). Flow: `google-shared/oauth-store.ts` (`OAuth2Client`, `access_type:'offline'`, `prompt:'consent'`, requires refresh_token in response); refresh via `google-shared/refresh.ts`.
- **Microsoft client credentials**: bundled **public-client** Entra app id at `ms365/client-credentials.ts:11` (no secret — PKCE per RFC 7636); overridable via env `MICROSOFT_OAUTH_CLIENT_ID`. `ms-shared/oauth.ts`: authority `login.microsoftonline.com/common`, S256 PKCE, `offline_access` required, tenant kind derived from the id_token `tid` claim (decoded unverified). OneDrive reuses the same app registration.
- `http-shared/bearer-fetch.ts`: shared retry core (4 attempts, exp backoff cap 60 s, 90 s per-attempt AbortController spanning header+body). **The error string format `${errorPrefix} ${status} ${url} ${body}` is a load-bearing contract** — delta loops regex it to detect invalid-cursor conditions (onedrive `/410/`, ms365 `/410.*syncStateNotFound/i`, google-docs invalid-page-token).
- `pending-reaper.ts`: `reapAbandonedPendingPairings(db)` deletes crashed `pending-%` pairing accounts at boot, before the scheduler starts.
- `installer.ts`: 3-phase install — `preview({ref, hash?})` (resolve https/`github:owner/repo[@tag]`/npm-name → tarball → SRI/TOFU integrity pin → staged extract, max 8 pending → validate against the *extension* manifest schema → return `token` + `permissions[]` for consent), `commit({token})` (move to `<extensionsDir>/<id>`, record `installed.json` with `grantedPermissions`), `uninstall(id)` (blocked while accounts exist).

### 4.3 Connector inventory

| Connector | Data | Lifecycle | Cursor (`sync_state.cursor_json`) | Auth / credentials |
|---|---|---|---|---|
| **gmail** | Threads (`email_thread`) + `attachment` docs | backfill + delta | `{history_id, page_token}` (saved per page; resumable) | Google OAuth, scope `gmail.readonly` (`gmail/oauth.ts:16`); token blob; `config_json:{clientId,clientSecret}` |
| **google-docs** | Drive files under tracked roots (`doc`/`file`), folder tree in `drive_folder_index` | backfill (BFS walk, baseline `changes/startPageToken` captured first) + delta (`drive/v3/changes`; invalid token → `runFullRescan()`) | `{page_token, backfill:{root_id, page_token}}` | Google OAuth, scope `drive.readonly` (`google-docs/oauth.ts:1`) |
| **ms365** | Outlook mail conversations (`email_thread`), inbox+sentitems | backfill = two-phase cursor state machine; delta per folder | `Ms365Cursor {phase:'enumerate'\|'ingest'\|'live', folders:{[f]:{next}\|{delta}}, pending?: conversationId[]}` | Microsoft PKCE, scopes `openid,email,profile,offline_access,Mail.Read,User.Read` (`ms365/oauth.ts:31-38`); `config_json:{clientId,tenantId}` |
| **onedrive** | Files under tracked roots | backfill = per-root delta-walk (Graph delta *is* enumeration); delta re-walks tokens; 410 → transparent re-prime | `OneDriveCursor {delta_tokens:{[rootId]:token}, backfill?:{root_id,next_link}}` | Microsoft PKCE, scopes `...Files.Read.All,User.Read` (`onedrive/oauth.ts:7-14`) |
| **imap** | Any IMAP mailbox → threads | backfill = per-folder UID pages (BATCH 50, resumable per chunk); delta = UIDs since lastUid; `uidValidity` change purges folder index; full reconcile ≤ 1/24 h (`RECONCILE_INTERVAL_MS`) piggy-backed on delta | `{folders:{[path]:{uidValidity,lastUid}}, last_reconcile_at}` | Password (`input-fields` step) stored as safeStorage blob (`imap/token.ts`); own threading impl (`imap/threading.ts`) distinct from email-shared |
| **browser** | Chromium history (Chrome/Edge/Brave/Arc) — reads the browser's own `History` SQLite directly | backfill + polled delta; no realtime; profiles = `kind='browser'` tracked_roots | per-profile progress in cursor | No auth; single machine account `identifier='browsers'`; privacy filter (`browser/privacy.ts`, prefs `browserHistory.{windowDays,blocklist}`) |
| **local-folder** | Local files under picked roots; `metadata.paths[]` = `{absolute_path, root_id, size, mtime}[]` | backfill = `scanRoot()`; **`supportsDelta:false, supportsRealtime:true`** — chokidar watcher per root is the only ongoing sync; `reconcile()` on live-restart diffs size+mtime vs disk | n/a (path index lives in doc metadata) | No auth; single account `LOCAL_MACHINE_IDENTIFIER`; overlap-rejecting root add; removal archives (not deletes); `DEFAULT_EXCLUDE_GLOBS` unioned at use-time |
| **kia.whatsapp** (bundled, extension-class) | WhatsApp chats | out-of-process extension; `live-stream` QR pairing (`start:'begin-pairing'`, `timeoutMs:25000`), `whatsapp-import` action | — | Permissions `["db:write","db:read","net","secrets","files:read"]`; `activationEvents:["onStartup"]`; seeded from `assets/bundled-connectors/kia.whatsapp` |

Backfill failure classification: HTTP 401 / `invalid_grant` / `unauthenticated` / `invalid credentials` in the error → `needs_reauth` (timer stopped); anything else → `error` (retried next tick) (`scheduler.ts:22`).

### 4.4 Published SDKs (`packages/`)

- `@alpha-cent/connector-sdk` v1.1.0 — **types-only** (zero runtime deps; `main`/`types` → `src/index.ts`). Exports `PendingDocument`, `Document`, `SyncStateRow`, `ConnectorCapabilities`, `ProgressSink`, `ByteSource`, `ConnectorHost`, `ConnectorSetupHost`, `ConnectorInstance`, `Connector`, `ConnectorEntry`, `defineConnector()`. Conformance guarded by `src/__tests__/connector-sdk-conformance.test.ts`. Marked `@deprecated — import from @alpha-cent/extension-sdk` (`index.ts:216`); being folded into extension-sdk.
- `@alpha-cent/extension-sdk` v2.0.0 — re-exports connector-sdk plus `protocol.ts` (wire messages, `HOST_RPC_PROTOCOL_VERSION`), `host-surface.ts` (`HOST_SURFACE` map + drift guards), `extension-host-proxy.ts` (child-side `createRemoteHost()`), `errors.ts`, `defineExtension()`.

---

## 5. Scheduler

One app-wide `Scheduler` (`src/main/scheduler/scheduler.ts:69`), constructed in `boot/connector-services.ts:71`.

- **Cadence**: window-state tiered delta polling — `DEFAULT_CADENCE_MS = { focused: 30_000, unfocused: 120_000, tray: 600_000 }` (`scheduler.ts:41-45`). Per-account override in `connector_cadence` (loaded into an in-memory Map at `start()`); `setCadence` validates `MIN_MS=5_000` … `MAX_MS=86_400_000` (`scheduler.ts:179`). Tray cadence is never overridable. `onWindowStateChange()` reschedules all live timers (`scheduler.ts:509`).
- **Start**: loads enabled accounts, `startAccount()` each. `sync_state.status` routing (`scheduler.ts:335-373`): `error|paused|needs_reauth` → do nothing; `pending|backfilling|undefined` → **detached** `runBackfillTask` (not awaited — boot must not block on a multi-hour backfill); `live` → `startRealtime()` if present, fire-and-forget `reconcile()`, `scheduleDelta()`.
- **Failure handling**: `isAuthError()` (`scheduler.ts:22`) → `needs_reauth` + timer stopped; else `error` persisted, retried on next fixed-interval tick — **no backoff, no retry counter** for delta; backfills persist `last_error`.
- **Pause/resume/remove/restart**: `pauseAccount` (teardown, keeps rows; 30 s ceiling on in-flight backfill wait), `removeAccount` (also evicts cadence cache), `restartAccount`, idempotent `registerAccount` (`scheduler.ts:211-320`). Global `pauseAll()/resumeAll()` is a **process-local, unpersisted flag** affecting only delta ticks (`scheduler.ts:95-98, 466-503`).
- **Progress/ETA**: `createProgressSink` (`progress.ts:4`) → `persistProgress` writes `status='backfilling'`, `backfill_done_count`, `backfill_total_estimate` (`scheduler.ts:519-535`). ETA: in-memory rolling window of 24 samples per account (`backfill-eta.ts:6-46`), `(total-done)/rate`.
- **Concurrency**: no cap on simultaneous backfills — bounded indirectly by the shared converter pool (4 workers, queue 500).
- **Registry**: `ConnectorRegistry` (`scheduler/registry.ts`) is a plain Map, populated as connector extensions activate (`bridge.attach`), **not** at construction.

---

## 6. Extraction / inference

Two systems under `src/main/inference/`: `InferenceService` (`index.ts:14`, façade + interactive `request()` text path) wrapping `InferenceScheduler` (`scheduler.ts:164`, the claim/extract/settle loop over `inference_jobs`).

### 6.1 Job lifecycle

- **Enqueue**: `ConnectorContextImpl.enqueueExtraction` fires on connector upserts; plus one-time `backfillOnce()` (`inference/backfill.ts:18`) gated by `inference_meta` marker `'backfill_v1'`. `classifyDocument` (`classify.ts:33`): candidate iff `type ∈ {attachment, file}`, mime/filename says PDF or image, and underprocessed (`metadata.extraction_status='unsupported'` OR markdown < `MIN_MARKDOWN_CHARS=16`); images < `TINY_IMAGE_BYTES=8192` → `skipped`.
- **Two passes**: pass 1 OCR claims `pending`; pass 2 VLM description claims `ocr_done`. Pass-1 results with `ocrChars < OCR_SUFFICIENT_CHARS=200` park as `ocr_done` for pass 2 (`extractor.ts:22`).
- **Claim**: atomic `UPDATE…RETURNING` (`scheduler.ts:705`); per-pass attempted-exclusion capped at 2000 ids. **Settle** guarded by `AND state='processing'`; terminal `done`/`skipped`/`failed` (`DEFAULT_MAX_ATTEMPTS=3`, `scheduler.ts:46`). Crash recovery: `resetStaleProcessing()` once per process (`scheduler.ts:314`).
- **Write-back**: `applyExtractionResult` (`apply.ts:25`) clears `content_hash`, re-upserts the doc with new markdown + `metadata.deep_extraction={engine,extracted_at}` + `extraction_status='ok'` (FTS/language rebuilt in the same transaction).

### 6.2 Models & engines (`providers.ts:32`)

| Platform | OCR | Rasterizer | VLM |
|---|---|---|---|
| macOS | Apple Vision via bundled `kia-vision` Swift helper (`ocr/native-vision.ts:11`; source `native/vision-helper/main.swift`) | CoreGraphics (same helper) | local llama-server Gemma VLM |
| Windows + working native OCR | Windows.Media.Ocr via `windows-ocr.exe` (`ocr/windows-ocr.ts:13`; source `native/windows-ocr/Program.cs`), gated by `selftest()` | pdfium WASM (`rasterize/wasm.ts:29`, `@hyzyla/pdfium`, scale 2, max 20 pages) | local llama-server VLM (model swap) |
| Windows w/o native OCR, Linux | GLM-OCR model on llama-server (`ocr/glm-ocr.ts:33`) | pdfium WASM | local llama-server VLM (model swap) |

- **Runtime**: supervised `llama-server` child process (`runtime/server.ts:118`), `-ngl 999|0`, `--cache-ram 0`, ctx 4096, `/health`-polled, exponential respawn backoff 250 ms → 30 s. Endpoint: `http://127.0.0.1:<dynamic-port>/v1/chat/completions` (`pickFreePort()`, `server.ts:40`). **No cloud inference anywhere.**
- **Catalog** (`runtime/models.ts`), all pinned to HF commits: `gemma-4-12b-it-Q4_K_M` (≥48 GB tier, `unsloth/gemma-4-12b-it-GGUF`), `gemma-4-E4B-it-Q4_K_M` (≥24 GB), `gemma-4-E2B-it-Q4_K_M` (default / CPU-forced), `glm-ocr-Q8_0` (`ggml-org/GLM-OCR-GGUF`, OCR-only, non-Mac). Selection `selectCuratedModel({accel, capacityBytes})` (`models.ts:178`); user override pref `deepExtractionModelOverride`.
- **Single-model swap policy** (Win/Linux): one model loaded at a time; `decidePassRole()` (`scheduler.ts:31`) stays on the loaded model while it has work, prefers OCR from cold; `RuntimeManager.useModel(role)` stop→start swaps (`runtime/manager.ts:271`). macOS never swaps.
- Binaries: llama-server fetched by `scripts/fetch-llama-server.mjs` (pinned tag/sha in `scripts/llama-assets.mjs`) into `assets/llama/<slug>/`; helpers built into `assets/vision/<platform-arch>/kia-vision` and `assets/ocr/win32-<arch>/windows-ocr.exe`.

### 6.3 Timing / gating (`policy.ts`)

- Timer: first pass after `DEFAULT_STARTUP_DELAY_MS=15_000`, then every `DEFAULT_INTERVAL_MS=30_000`; also immediately on power-signal change; single-flight.
- **Power gate** (`decidePolicy`, `policy.ts:34`): thermal serious/critical → pause; on battery → pause; thermal fair → concurrency 1; else concurrency 2 (llama-server is single-slot). Fed by Electron `powerMonitor` (`power-signals.ts`).
- **Schedule gate** (`scheduleAllows`, `policy.ts:76`): pref `deepExtractionSchedule` = `always` | `idle` (needs `idleSeconds ≥ 300`) | `night` (22:00–07:00). An `interactive` flag (focus + input within 30 s) blocks **every** mode; `deep-runtime:process-now` sets a session bypass overriding everything.
- Master consent: pref `deepExtraction.enabled` — when false nothing is claimed (deep extraction rewrites document bodies).
- VLM demand-start / idle-stop after `DEFAULT_VLM_IDLE_STOP_MS = 600_000` (10 min) (`scheduler.ts:53`). Gates block only *claiming*; in-flight work always settles.

### 6.4 Converter pool (`src/main/converter/`) — the first-pass pipeline

Synchronous doc→markdown conversion connectors call for every attachment/file (precedes deep extraction). `Converter` (`index.ts:24`) over a `WorkerPool` (`pool.ts:48`) of `child_process.fork()` workers (`serialization:'advanced'`), `min(4, cores-1)` workers, queue 500, 60 s per-job timeout, worker recycled after 8 jobs (pdfjs state), 512 MB heap cap per child, respawn backoff 250 ms → 30 s. Handlers: text/plain, text/markdown, text/html, application/pdf, docx, xlsx, text/csv (`index.ts:121`; `handlers/*.ts`). **Images intentionally unsupported here** (deep extraction handles them). Output capped at 1 MB UTF-8-safe (`MAX_MARKDOWN_BYTES`). `resolveMimeType()` falls back to file extension for `''`/`application/octet-stream` (Gmail behavior).

---

## 7. Extension host

### 7.1 Process model

Two modes behind one `ExtensionModule { activate, deactivate }` interface:

1. **Built-ins (in-process)**: `connectorModuleToExtension()` (`platform/connector-adapter.ts:24-79`) — `activate/deactivate` = `ConnectorHostBridge.attach/detach` (`connector-host-bridge.ts:30-68`); `manifest.entry` is the sentinel `'builtin'`. Fully trusted (granted = declared permissions). They never receive a real `Host` (get `inertConnectorHostDeps()`, `host.ts:525-576` — every surface throws/no-ops).
2. **Third-party (out-of-process)**: one **`node:child_process.fork()`** per extension (`extension-process-manager.ts:404-425`) — *not* utilityProcess, *not* worker_threads. Forked with `serialization:'advanced'`, `execArgv:['--max-old-space-size=512']`, `env.ELECTRON_RUN_AS_NODE='1'` (Electron binary in pure-Node mode; never enters main.ts). Fork target = the app's own extension-host entry (`resolveHostEntryPath()`, dev → `extension-host-entry.ts` via ts-node, prod → sibling `extensionHost.js` bundle); the extension's entry path arrives in the bootstrap message.

`ExtensionProcessManager` states: `spawning | running | parking | parked | restarting` (`extension-process-manager.ts:83-88`). Crash-loop breaker: ≥3 crashes / 60 s → stop respawning, report errored (backoff 250 ms·2ⁿ, cap 30 s). **Idle-park** after 10 min with no in-flight calls and no keepAwake pin; re-forked on demand. Deactivate ack timeout 5 s → SIGTERM → SIGKILL after 2 s. Spawn/handshake timeout 10 s. A monotonic fork **incarnation counter** lets `RemoteConnector` detect re-forks. `LiveAccountRefcount` (`keep-awake-refcount.ts`) pins the child awake while any realtime account socket is live (0↔1 edge-triggered).

### 7.2 RPC protocol

Transport: Node child-process IPC, tagged structured-clone messages; versioned by `HOST_RPC_PROTOCOL_VERSION` + `hostApi` semver check on handshake (`handshake.ts:18-32`).

Handshake: main sends `{kind:'bootstrap', bootstrap:{v, extensionId, entryAbsPath, dataDir, grantedPermissions, hostApi}}` → child validates, `nodeRequire()`s the entry (a `connector` export ⇒ connector-class, wired to a child-side `ConnectorRunner`) → `{kind:'ready'}` → main sends `{kind:'lifecycle', op:'activate'}` → child runs `module.activate(remoteHost)` → `{kind:'activated'}` | `{kind:'errored', message}`.

Steady state:
- **Direction A (host API)**: child → main `call {ns, method, id, args}` → `reply {id, ok, value|error}`; subscriptions get `subId` + `event {subId, payload}` pushes + `dispose {subId}`. Reverse invoke: `invoke {id, localId, args}` → `invoke-reply`.
- **Direction B (connector RPC)**, connector-class only: `conn-static | conn-create | conn-call | conn-hook | conn-bytesource | conn-stop` → `conn-reply {callId, ok, value|error}`, plus streamed `conn-progress {instanceId, startCallId, sink:'update'|'log', ...}` during backfill (`connector-rpc.ts:9-18`; routed by `RemoteConnectorRouter`, a separate correlator from `HostRouter`).
- Graceful deactivate is ACKed by the child calling `process.exit(0)`. Child converts `uncaughtException`/`unhandledRejection` into `{kind:'errored'}` + exit 1.

`HostRouter` (`extension-host-router.ts`) is the main-side enforcement seam: per call it resolves `requiredPermission(ns, method)` from `PERMISSION_MAP` (deny → wire error `code:'PERMISSION_DENIED'` + `permission.violation` bus event) and dispatches by `SurfaceKind` (`async|event|disposable|fire`) from `HOST_SURFACE`.

### 7.3 Manifest (`platform/manifest.ts:51-63`, zod)

`id` (must match `/^[a-z0-9-]+\.[a-z0-9-]+$/`, i.e. `publisher.name`; built-ins bypass with bare ids), `displayName`, `version` (semver), `hostApi` (semver range), `entry` (must resolve inside the extension dir — path-traversal guard), `icon`, `permissions[]` (default `[]`, each `/^[a-z]+(:[a-z]+)?$/`), `contributes { sources?, commands?, automations?, views? }`, `activationEvents[]` (`onStartup`, `onCommand:<id>`, …). `contributes.sources[]` = the first-party `ConnectorManifest` shape minus version/hostApi/entry/permissions.

### 7.4 Permissions (`platform/permissions.ts:16-85`)

9 strings: `db:read`, `db:write` (elevated — also gates ALL raw SQL and all `connector.*` account mutations), `files:read`, `files:write` (elevated), `process` (elevated, stub), `net` (stub), `llm`, `secrets`, `clipboard` (stub). Permission-free: `events.*`, `commands.*`, `ui.*`, `self.*`, `safeStorage.isEncryptionAvailable`, `connector.emitStreamEvent/publishState/oauthDir`. Enforcement is at `HostRouter` for forks; the in-process `check()` is advisory-only (warn + event). Compile-time drift guards force every Host member to have exactly one `PERMISSION_MAP` row.

### 7.5 Host API surface (38 methods; `packages/extension-sdk/src/index.ts:54-133`, kinds in `host-surface.ts:65-125`)

| Namespace | Methods (permission) |
|---|---|
| `db` | `upsert` (db:write), `findBySourceId`/`findByContentHash`/`loadSyncState` (db:read), `delete`/`archive`/`saveSyncState` (db:write), raw `run`/`all`/`exec`/`batch` (all db:write, wholesale) |
| `llm` | `enqueue({documentId, mode:'ocr'\|'full'})`, `onResult(cb)` [event], `request({prompt}) → {text}` (all `llm`) |
| `files` | `read`/`list` (files:read), `write` (files:write), `watch` [event] (files:read) — confined to `extensions/<id>/data/` via `createExternalFiles` (`external-files.ts`); no delete method |
| `process` | `exec` — **stub, throws NotImplementedError** |
| `net` | `fetch` — **stub** |
| `clipboard` | `read`/`write` — **stubs** |
| `secrets` | `get`/`set` — **stubs** |
| `safeStorage` | `isEncryptionAvailable` (free), `encryptString`/`decryptString` (secrets) — Electron passthrough |
| `ui` | `registerView`/`registerWizardStep` [disposable] — **v1 no-ops**; `notify` [fire] — no-op |
| `events` | `on` [event] / `emit` [fire] — platform events: `document.indexed`, `source.synced`, `extension.activated/deactivated`, `permission.violation`, `inference.completed` |
| `commands` | `register` [disposable] (global id `${extensionId}.${id}`), `execute` |
| `self` | `id` / `dataDir` / `hasPermission` — resolved locally in the child proxy, never cross RPC |
| `connector` | `emitStreamEvent` [fire, ownership-checked fail-closed], `pickFile` (files:read), `publishState`, `oauthDir`, `restartAccount`/`removeAccount`/`restartAccountAndBroadcast`/`hostFor` (db:write + ownership check via `ConnectorOwnership.accountSource()`) |

`Host['db']` delegates to `ConnectorContextImpl`; the gate lives above it in `host.ts`.

### 7.6 Lifecycle & registry

`ExtensionRegistry` statuses (`registry.ts:4-33`): `disabled | enabled | activating | activated | errored`; transitions: disabled→enabled; enabled→activating|disabled; activating→activated|errored; activated→disabled|errored; errored→enabled|disabled. `ExtensionLifecycle.fire(event)` activates enabled extensions matching `activationEvents`; freshly installed extensions treat `onStartup` as already fired (`activateOnInstall()`).

### 7.7 Connector-as-extension bridge

The Scheduler/wizard/byte-source pipeline **cannot tell** whether a connector is in-process or forked: `RemoteConnector` (`remote-connector.ts`) implements the same `Connector`/`ConnectorInstance` contract, marshalling every call over Direction-B RPC; it exposes only the optional instance methods the child reports having (`MethodPresence`). Crash self-heal: `onErrored` → `RemoteConnector.handleChildErrored()` bumps a generation counter; the next call transparently re-creates the child instance. Setup hooks and `makeByteSource` marshal via `conn-hook`/`conn-bytesource`.

### 7.8 Discovery / seeding / state

- Bundled: `assets/bundled-connectors/<publisher.name>/` (packaged: `<resourcesPath>/assets/bundled-connectors`); `seedBundledExtensions()` (`seed-bundled-extensions.ts:37-74`) copies into `userData/extensions/<id>/` only when strictly newer semver, preserving `data/`.
- Discovery: `discoverExtensions()` (`discover-extensions.ts:22-61`) scans `userData/extensions/*/manifest.json` — **manifest-only, never executes code**; skips bad manifests.
- Enabled-state: `ExtensionStateStore` — single JSON `<extensionsDir>/state.json`, `Record<extensionId, {enabled:boolean}>`, mode 0600; absent = enabled.
- Legacy migrations each boot: `migrateConnectorsDir` (`connectors`→`extensions`), `migrateExtensionState` (`builtin.<id>` keys → bare `<id>`; imports old `installed.json` disabled flags).

---

## 8. MCP server

### 8.1 Transports

- **Local Streamable HTTP** (MCP spec rev 2025-03-26): `127.0.0.1:7421`, hardcoded at `main.ts:1124-1125`; server in `src/main/mcp/server.ts:249-271`. `bearerToken: null` → `authOk()` (`server.ts:132-135`) always passes — **no auth**, isolation relies on the loopback bind. Endpoints (`server.ts:79-96`): `POST /mcp` (JSON-RPC; first POST must be `initialize`, mints `mcp-session-id`), `GET /mcp` (SSE, needs session header), `DELETE /mcp` (end session), `GET /healthz`. One `McpServer` + transport per session in an in-memory Map; idle sessions swept every 5 min, evicted after 45 min (`server.ts:57-77`).
- **Remote HTTPS router (port 7422)** exists only as a comment (`server.ts:52-53`) — proprietary overlay, absent in this repo; do not reimplement from here.
- **Bundled stdio server** (`stdio-entry.ts` → `dist/main/mcpStdio.js`): launched by stdio clients as a separate process via the app's own binary: `ELECTRON_RUN_AS_NODE=1 <exe> <mcpStdio.js> --db <sqliteFile>` (`buildStdioLaunchDescriptor`, `stdio-config.ts:25-35`). Console redirected to stderr so stdout stays pure JSON-RPC. Shares `makeMcpServer()`/`registerTools()` with the HTTP path (`register.ts`) so tools cannot drift between transports. Reads the DB via `openCorpusReadConnection()` (§3.1).
- Server identity: protocol name = `DEFAULT_BRAND.mcpProtocolName`; config key `MCP_SERVER_KEY = 'Kia'` (`src/shared/mcp-identity.ts:20`) shared by both processes.

### 8.2 Tools (registered in `register.ts:172-243`; wrapped by `dispatchTool` + `wrapHandlerForActivity`)

| Tool | Input | Output |
|---|---|---|
| `search` (`tools/search.ts`) | `{ query?, source?, type?, from_date?, to_date?, limit?, context_lines?, queries?: SearchArgs[] }` (batch `queries` mutually exclusive with top-level filters) | `SearchHit[]` (or `SearchHit[][]`): `{id: bigint, title, source, type, snippet, source_url, created_at, score}` — bm25 + trigram RRF merge |
| `get` (`tools/get.ts`) | `{ id?: string }` XOR `{ ids?: string[] }` (bigint ids as strings) | `Document \| null` or array: `{id, source, type, title, markdown, metadata, source_url, content_hash, parent_id, created_at}` |
| `count` (`tools/count.ts`) | `{ source?, type?, group_by?: 'source'\|'type'\|'language'\|'sender_address'\|'month'\|'label'\|'tracked_root'\|'mime_type' }` | `{key, count}[]` |
| `get_related` (`tools/get-related.ts`) | `{ document_id: string, relation: 'thread_messages'\|'attachments' }` | messages from `metadata.messages`, or child doc rows |
| `digital_memory_info` (`tools/digital-memory-info.ts`) | `{}` | `{ accounts: {source,identifier,status,backfill_done_count,backfill_total_estimate,last_sync_at,last_error}[], counts:{by_source,by_type,by_language}, date_range:{oldest,newest} }` |
| `query_sql` (`tools/query-sql.ts`) | `{ sql }` (must start `select`/`with`; opens its own read-only handle) | `{ rows: Record<string,unknown>[], truncated }` — capped 500 rows |
| `get_schema` (`tools/get-schema.ts`) | `{}` | markdown of `SCHEMA_DOC` (`tools/schema-doc.ts`; drift-tested against the live schema) |

Resources: no listables; one template `doc://{id}` → `text/markdown` (`register.ts:336-359`, `resources.ts`).

### 8.3 Client config writers (`mcp/clients/`)

`buildClientRegistry` (`registry.ts:36-91`); writes via `applyConfigChange` (`write.ts`): no-op if parent dir missing; timestamped `.bak-<ts>` backup; write `.tmp` + atomic rename; throws on malformed existing config rather than clobbering.

| Client | Transport | File (user machine) | Container key | Entry |
|---|---|---|---|---|
| claude-desktop | stdio | `<appData>/Claude/claude_desktop_config.json` | `mcpServers` | `{command: exePath, args:[mcpStdio.js,'--db',dbPath], env:{ELECTRON_RUN_AS_NODE:'1'}}` |
| claude-code | http | `~/.claude.json` | `mcpServers` | `{type:'http', url}` |
| cursor | http | cursor config path | `mcpServers` | `{url}` (bare) |
| vscode | http | `mcp.json` | **`servers`** (not `mcpServers`) | `{type:'http', url}` |
| codex | stdio | `~/.codex/config.toml` (TOML; round-trip loses comments) | `mcp_servers` | `{command,args,env}` |

`url = http://127.0.0.1:<mcpPort>/mcp`.

### 8.4 Activity feed

In-process singleton `mcpActivity` (`activity.ts`): state `idle|mcp|error|paused`; success pulses `mcp` for 800 ms, failure `error` for 5000 ms; snapshot `{state, pulseSeq, lastCallAt, lastErrorAt}`. Drives the tray icon and `push:mcp-activity`. The **out-of-process stdio server** can't touch it — it writes a marker file `mcp-stdio-activity.json` (shape `{connectedAt?, lastQueryAt?}`, first-seen only) next to `mail.sqlite` (`stdio-activity-signal.ts:34`); the GUI watches it via `watchStdioActivity()` (fs.watch) — this is the only channel by which the app learns a Claude-Desktop stdio session happened.

---

## 9. Identity, prefs, logs

### 9.1 Identity (`src/main/auth/`)

App-level sign-in (who owns this install) — entirely distinct from per-connector OAuth. Providers: `'google' | 'microsoft'` only (`identity-store.ts:12`).

- **Storage**: `<userData>/alpha-cent/identity.json`, mode 0600 (`identity-store.ts:74`). Shape (`SignedInIdentity`, `identity-store.ts:14-25`): `{ email: string, name?: string|null, avatarUrl?: string|null, provider?: 'google'|'microsoft' }`. `avatarUrl` is always an inlined `data:` URL (≤128 KB, `profile.ts` `MAX_AVATAR_BYTES`; fetch timeout 6 s). Legacy files default `provider` to `'google'`. In-memory cache in main.ts avoids re-reads on the ~5 s state poll. Sign-out = `rmSync` the file.
- **Flow** (`sign-in-orchestrator.ts:35-94`): `strategy.performOAuth(nonce, scopes)` → `{token, idToken}`; with `opts.connectSource` also persists a mail account (this is how `auth:sign-in {withGmail:true}` connects Gmail in one consent); else derives email from id_token claims only; best-effort `fetchProfile` (never blocks); `writeIdentity` + `broadcastState`. Strategies: `google-strategy.ts`, `microsoft-strategy.ts` (reuse connector OAuth plumbing). Result: `{ok:true,email}` | `{ok:false, error:'oauth-failed'|'identity-failed', message}`.
- JWT claims decoded **without signature verification** (`profile.ts` — trusted because fetched directly from the provider token endpoint over TLS).

### 9.2 Prefs (`src/main/prefs.ts`)

File `<userData>/alpha-cent/prefs.json` (pretty JSON). `PrefsStore` (`prefs.ts:221-287`): corrupt file → defaults (never crashes boot); `.set()` shallow-merges except deep-merge of `onboarding` and `deepExtraction`; `.reset()` for the wipe flow. Full `AppPrefs` (`prefs.ts:39-84`):

```
logLevel: 'debug'|'info'|'warn'|'error'          // 'info'
verboseConnectorLogs: boolean                     // false
devToolsEnabled: boolean                          // false
launchAtLogin: boolean                            // false → app.setLoginItemSettings
showInMenuBar: boolean                            // true → tray
hideDockIcon: boolean                             // false (macOS accessory mode)
theme: 'light'|'system'|'dark'                    // 'system' (presentational only)
sendDiagnostics: boolean                          // false (no telemetry backend exists)
remoteEnabled: boolean                            // false (proprietary remote-MCP opt-in)
usingLocally: boolean                             // false
remoteMigratedAt: string|null                     // null
onboarding: { sourceBackfilledAt, mcpConnectedAt, firstQueryAt, dismissedAt }  // latched-once ISO|null
deepExtraction: { enabled: boolean }              // {enabled:true}
deepExtractionSchedule: 'always'|'idle'|'night'   // 'idle' (flat key, pinned by test)
deepExtractionModelOverride: 'auto'|string        // 'auto'
browserHistory: { windowDays: number, blocklist: string[] }  // {365, []}
```

Effects (`app-prefs-effects.ts`): `applyLaunchAndTrayPrefs` (login item + tray create/destroy); `applyDockPref` (macOS: hides Dock only if `hideDockIcon && showInMenuBar && trayActive` — never leaves the app unreachable; must not run before first window shown).

### 9.3 Logging

- Format: JSON-lines; `LogRecord = { ts, level, msg, ...fields }` (`logger.ts:8-13`).
- Files: `<userData>/alpha-cent/logs/app.log` + `.1/.2/.3`; size rotation at 10 MiB, 3 generations (`log-rotation.ts`). **Console patch and structured logger must share ONE sink instance** — two rotators on the same path race the rename chain (`log-rotation.ts:1-6`).
- Level gate + connector-noise suppression: debug/info records with a `connector` field are dropped unless `verboseConnectorLogs` (warn/error always pass) (`logger.ts:30-102`).
- Renderer push: `createLogBatcher({intervalMs:250, maxBuffer:200})` (`log-batcher.ts`) → `push:log`.
- Recent: `readRecentLogRecords` reads only the trailing 1 MB, skips non-JSON lines (`logs/recent.ts:9-41`). Export: JSZip of the logs dir (`logs/export.ts:6-28`).

---

## 10. File / asset storage layout

Two independent roots under Electron `userData`:

```
<userData>/
├── alpha-cent/                       # defaultBaseDir() (paths.ts)
│   ├── mail.sqlite                   # the DB (+ -wal/-shm)
│   ├── mail.duckdb                   # legacy path constant only — dead
│   ├── identity.json                 # mode 0600
│   ├── prefs.json
│   ├── mcp-stdio-activity.json       # stdio-MCP cross-process marker
│   ├── oauth/<uuid>.bin              # safeStorage-encrypted token blobs; filename is a random UUID,
│   │                                 # mapping lives in accounts.credentials_blob_path
│   ├── logs/app.log(.1/.2/.3)
│   ├── cert/                         # remote-MCP TLS material — inert/empty in OSS
│   ├── deep-extraction/models/<modelId>/   # downloaded GGUF models (runtime/catalog.ts:10-20)
│   └── connector-data/<connectorId>/media/<hash>   # cached raw media bytes (data-dir.ts:8-10) —
│                                     # a re-processing CACHE, not source of truth
└── extensions/                       # SIBLING of alpha-cent/, NOT nested
    └── <extensionId>/
        ├── manifest.json (+ entry file per manifest.entry)
        └── data/                     # per-extension sandboxed storage (Host.files confinement)
    └── state.json                    # ExtensionStateStore {id:{enabled}}
```

Document bodies (markdown) live **inside SQLite**, not on disk; `connector-data/` is only a byte cache for OCR/re-conversion.

---

## Appendix: top rebuild traps

1. **`channels.ts` is the IPC spec** — a typed contract map with compile-time bijection checks against the runtime allowlist; preload exposes exactly `invoke`/`on`. Don't reverse-engineer handlers, and don't lose the compile-time guarantee.
2. **Boot ordering invariants**: db-worker open **before** anything captures `db`; `migrateConnectorsDir` before installer reads; heals (`gcOrphanedInferenceJobs`, `reapAbandonedPendingPairings`) before `inferenceService.start()` / `scheduler.start()`; IPC registration after MCP server (port) and extension kernel. `data:reset-all` teardown order is crash-critical.
3. **`defaultSafeIntegers(true)`** — all SQLite INTEGERs are `bigint` in JS (ids cross IPC as strings); `tracked_roots.id` is a TEXT UUID. FTS tables are synced application-side in `upsert`'s batch (no SQL triggers) and store a *stemmed view*, not raw text.
4. **The OAuth "loopback" never listens** — port 34123 is only a redirect-URI string intercepted inside an Electron BrowserWindow via `webRequest.onBeforeRequest`. A rebuild using a real HTTP listener changes the security posture and may conflict with the registered client redirect config.
5. **Two storage roots**: `userData/alpha-cent/` vs sibling `userData/extensions/` — consolidating them breaks existing installs' extension discovery and enabled-state.
6. **`manifest.entry === 'builtin'` is the single branch point** between in-process and forked-extension execution; the Scheduler cannot tell `RemoteConnector` from an in-process connector. Built-ins get inert Host deps — they never call `host.*`.
7. **Load-bearing string contracts**: `bearer-fetch` error format (`prefix status url body`) is regexed by delta loops to detect invalid cursors; SQLite "duplicate column name" message drives migration idempotency; scheduler's `isAuthError()` substring-matches error text.
