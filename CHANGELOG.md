# Changelog

## [0.47.0](https://github.com/edjafarov/kiagent-core/compare/v0.46.0...v0.47.0) (2026-07-11)

### Features

* **engine:** needsReauth source-error taxonomy and resilient feed consumers ([db2e5f8](https://github.com/edjafarov/kiagent-core/commit/db2e5f8e409272fa312c4b28e2ddb6be31d15e05))
* **workers:** transcribe audio files locally (closes [#8](https://github.com/edjafarov/kiagent-core/issues/8)) ([06e9c37](https://github.com/edjafarov/kiagent-core/commit/06e9c370d7a4e44d8f1a35337fa74f7e0de318a5))

### Bug Fixes

* **about:** point the About page at kiagent-core and name the app KIAcore ([2386b2b](https://github.com/edjafarov/kiagent-core/commit/2386b2b9eab3843502cfbca4da6678f85ce17b23))
* **db:** tag worker crashes retryable and survive close racing a respawn ([9539f36](https://github.com/edjafarov/kiagent-core/commit/9539f36afb372569c4a8f3fa3b2a02725721e9db))
* **store:** pin documents_fts rows to their document rowid ([1b0c1bb](https://github.com/edjafarov/kiagent-core/commit/1b0c1bba0e7714a790accc44f861c959370b097a))
* **test:** add hear() to Inference mocks after merging audio into dev ([84d6d29](https://github.com/edjafarov/kiagent-core/commit/84d6d29601f4198173a4dd250d8cfdd48b296f37))
* **workers:** skip too-long audio instead of deferring forever ([9274a48](https://github.com/edjafarov/kiagent-core/commit/9274a48c0b70d598168898afbf54acbe27a205b1))

## [0.46.0](https://github.com/edjafarov/kiagent-core/compare/v0.45.0...v0.46.0) (2026-07-10)

### Bug Fixes

* **mcp:** close DNS-rebinding hole on the loopback MCP listener ([046bcac](https://github.com/edjafarov/kiagent-core/commit/046bcac))
* **engine:** refuse to (re)start an account that is pausing or paused ([568646c](https://github.com/edjafarov/kiagent-core/commit/568646c))
* **db:** respawn the DB worker on unexpected crash instead of dying forever ([d4abd18](https://github.com/edjafarov/kiagent-core/commit/d4abd18))
* **db:** mark the client dead on clean worker exit so post-close requests reject ([b12ef00](https://github.com/edjafarov/kiagent-core/commit/b12ef00))

The MCP fix validates Origin/Host on the unauthenticated loopback listener
(port 7421) so a malicious web page can't reach it via DNS rebinding. The
engine fix closes a pause/start race (TOCTOU) that could resurrect a paused
account. The two db fixes keep the app alive across DB-worker crashes and
make post-shutdown requests fail fast instead of hanging.

## [0.45.0](https://github.com/edjafarov/kiagent-core/compare/v0.44.0...v0.45.0) (2026-07-09)

### Bug Fixes

* **engine:** pause aborts the in-flight sync loop, not just the status ([7ed1ec3](https://github.com/edjafarov/kiagent-core/commit/7ed1ec3c00c59ba6cc992e31a958a5ce813e15eb))

Pausing a connector no longer lets its backfill resume on its own. `accounts:pause`
committed `status: 'paused'` but left the running pull loop alive, so during an
active backfill the loop's next batch commit flipped the status back to
`backfilling` (and to `live` once the stream ended) — the account silently
resumed with no user action. `engine.pause()` now aborts the in-flight loop
before committing `paused`, and reads the cursor *after* the loop tears down so a
final in-flight batch can't leave a stale cursor that re-pulls on resume. Idle
accounts are unaffected — the abort is a no-op and the status-only pause stands.

## [0.44.0](https://github.com/edjafarov/kiagent-core/compare/v0.43.0...v0.44.0) (2026-07-09)

### Features

* **db:** async AppDb primitive + worker bridge protocol ([fb58138](https://github.com/edjafarov/kiagent-core/commit/fb5813845ab500436a2d3b82b7e9bde820f46c4e))
* **db:** host the corpus SQLite connection in a worker thread ([6098de6](https://github.com/edjafarov/kiagent-core/commit/6098de6d83c0e2ce6522a394a2e34852066af0c8))
* **db:** add a proc op to run host-registered transactions off-thread ([ad252dd](https://github.com/edjafarov/kiagent-core/commit/ad252dd1e9c85f1ba88df70e4605945ec6c77c84))
* **boot:** back the main-process corpus store with the DB worker ([0c141f8](https://github.com/edjafarov/kiagent-core/commit/0c141f87153c9175c6ba054d33b60e33f0b32037))

### Bug Fixes

* **main:** throttle push:app-state broadcasts to unblock backfill UI ([5d8c56f](https://github.com/edjafarov/kiagent-core/commit/5d8c56fb70e72b4ebd0876785472fb93e6946635))
* **store:** arm feed wakeup before the async materialize read ([7143ada](https://github.com/edjafarov/kiagent-core/commit/7143ada2aa1b5e81098d546b02cea7a36328a34e))
* **store:** keep number integer semantics to match core store ([ba61ef1](https://github.com/edjafarov/kiagent-core/commit/ba61ef1d1a44ae9a1017af00c017827521a3553c))
* **engine:** guard the projection boot window against unhandled store rejections ([108c924](https://github.com/edjafarov/kiagent-core/commit/108c924c60f6ff60a96b917d9318416f7cc5cd34))
* **store:** reconcile document parent refs after each commit batch ([fa0dc4b](https://github.com/edjafarov/kiagent-core/commit/fa0dc4b7c0e4095990b0ebd5b7d4a45ebd52d3d1))
* **engine:** isolate worker retry attempts and clean up abort listeners ([e21b253](https://github.com/edjafarov/kiagent-core/commit/e21b25319f547e8d9d5453a36fb72e5470fecf79))
* **renderer:** retry initial app:get-state instead of hanging the loading gate ([5f10d2d](https://github.com/edjafarov/kiagent-core/commit/5f10d2d6e49505ccd7ea58525873317b29866b75))
* **gmail:** abort-aware retry backoff and PKCE+state on OAuth ([6ffc4f2](https://github.com/edjafarov/kiagent-core/commit/6ffc4f23de9b08465f0590889050e32faec77422))
* bound batch and response memory (local-folder, net.fetch, marketplace) ([b80588f](https://github.com/edjafarov/kiagent-core/commit/b80588f354af1a93279e6251441c7524195fc53d))

Backfill no longer freezes the UI. Core opened the corpus SQLite connection
directly on the Electron main process, so every write, `ledgerCountsAll()`
count, FTS tokenization and checkpoint ran on the main event loop — an active
connector backfill saturated it and stalled window drags, tab switches and IPC.
The corpus connection now lives in a worker thread behind an async `AppDb`
bridge (generic `exec`/`all`/`run`/`batch`, plus a `proc` op that runs a
host-registered transaction in the worker as one atomic unit). `store.ts` drives
the async bridge; reads and the change `feed()` stay on main (the in-memory
`nudge` wakeup is armed before each async read so a concurrent commit is never
missed), while the procedural `commit` transaction — read-your-own-writes and
all — is relocated verbatim into the worker via `proc`. `bootCore` opens the
corpus with `openDbInWorker`; the stdio MCP server and tests keep the in-process
synchronous connection. Integer columns stay `number` (core is number-native);
`CoreStore`'s public contract is unchanged apart from the previously-synchronous
methods becoming `async`.

## [0.43.0](https://github.com/edjafarov/kiagent-core/compare/v0.42.0...v0.43.0) (2026-07-08)

### Features

* **updater:** port electron-updater state machine into core ([3369149](https://github.com/edjafarov/kiagent-core/commit/33691498c58fd408219f5898c2751d2a2f4ccd5b))
* **updater:** wire the updater manager into main.ts boot ([c1f193a](https://github.com/edjafarov/kiagent-core/commit/c1f193af5d6e6912f8deff9c7a125e203246373b))
* **updater:** render live UpdateState in the About pane ([bc65c24](https://github.com/edjafarov/kiagent-core/commit/bc65c243c7f24e336f78ca97f766853c9a4d5d41))

Auto-update restarts and reinstalls the whole app — a main-process concern —
so it belongs in core, not a bundled extension. Core already shipped
`electron-updater` (unused), `product.updateFeedUrl` (unconsumed) and two stub
`update:*` IPC handlers; this release wires them to the proven alpha-cent
overlay updater. `src/main/updater/` gains `createUpdater` (the state machine +
eligibility gate + 10s/6h boot check), `createUpdateNotifier` (a one-shot
native notification per downloaded version) and `registerUpdaterIpc`, ported
verbatim (only the `errMsg` seam is inlined — core has no `ipc/handlers`
module). `UpdateStatus`/`UpdateState` move into the shared IPC contract;
`update:get-state`/`update:check` now return `UpdateState` and there are new
`update:quit-and-install` invoke and `push:update-state` push channels.
`main.ts` instantiates the manager once at boot (electron-updater's
`autoUpdater`, electron-log, `app.getVersion/isPackaged`, `process.platform`),
applies `product.updateFeedUrl` via `setFeedURL` when present, subscribes the
native notifier and pushes state to the renderer; the About pane renders the
live state with a "Restart to update" action. macOS auto-update stays gated
(`MAC_UPDATES_ENABLED = false`, reason `unsigned-macos`) until Developer-ID
signing lands.

## [0.42.0](https://github.com/edjafarov/kiagent-core/compare/v0.41.0...v0.42.0) (2026-07-08)

### Features

* **mcp:** multiplexing `createMcpHandler` over a shared session dispatcher ([e0d3f39](https://github.com/edjafarov/kiagent-core/commit/e0d3f39f656879e0c8ddea4ae40fdcbe88dd161c))

The single-session `createSessionHandler()` handed a product build's remote
MCP transport ONE `{server, transport}` for its whole lifetime, so a product
remote server served a single session and reconnect was permanently broken
(the product can't learn the transport-assigned session id to fix it itself),
and that lone session leaked into the loopback `sessions` map. This release
replaces it with a MULTIPLEXING `createMcpHandler()` on `McpServerHandle`
(`core/mcp/server.ts`): the `/mcp` session machinery is extracted into a
reusable `createSessionDispatcher()` — each dispatcher owns its own
`mcp-session-id`-keyed pool, its own `makeSession()`, and its own idle-sweep
timer, while all dispatchers close over the SAME live registry/query/logSink/
onActivity (one tool registry, independent session pools). Loopback runs one
dispatcher; `createMcpHandler()` lazily creates + memoizes a second, product
dispatcher (repeated calls share one product session pool) so a product remote
server can serve many concurrent sessions and reconnects. `stop()` disposes
both dispatchers. The `mainApi` field is renamed `createSessionHandler` →
`createMcpHandler` — additive/opaque to the `apiVersion`-1 contract, only the
multiplex semantics and name change. Auth-free by design: the product's own
JWT middleware runs before `handleMcp`.

## [0.41.0](https://github.com/edjafarov/kiagent-core/compare/v0.40.0...v0.41.0) (2026-07-07)

### Features

* **platform:** wire MainProcessApi (apiVersion 1) to in-process bundled extensions ([59bf162](https://github.com/edjafarov/kiagent-core/commit/59bf162fc64d13c442749dc2f8c3a9e4bceeb2c3))
* **mcp:** createSessionHandler factory for product-owned MCP transports ([1878428](https://github.com/edjafarov/kiagent-core/commit/1878428985460166f332c02d1fefdd18795939a2))

### Bug Fixes

* **mcp:** reserve port 7422 for product remote server ([a76856c](https://github.com/edjafarov/kiagent-core/commit/a76856cdcebc7b42215a4dd8d583afd92bd905da))

`unsafe.mainProcess` bundled extensions (v0.40.0) received `extras
.mainProcess` as `undefined` in practice — `main.ts` never assembled a
`mainApi` to hand `createExtensionPlatform`. This release closes that gap:
`buildMainApi()` (new `main-api.ts`) assembles a concrete
`{ apiVersion: 1, identity, vault, mcp, paths, app, ui }` object from the
product's own store/mcp/app/tray, and `main.ts` passes it as
`ExtensionPlatformDeps.mainApi`. Core still types the field as `unknown` —
the shape is a product-build contract, not something core commits to.
Two additions make the surface usable: `McpServerHandle
.createSessionHandler()` (`core/mcp/server.ts`) hands back a request
handler bound to the SAME live ToolRegistry/resources/activity the
loopback listener uses, for serving MCP over a product-owned transport
(e.g. a remote HTTPS server) instead of a second, independent registry;
and `ui.addTrayMenuItems()` splices extension-contributed items into the
live tray context menu (before the trailing Quit item), backed by a new
Electron-free `tray-menu.ts` template-assembly helper, with a disposer to
remove them again. Port 7422 is now reserved (excluded from
`PORT_CANDIDATES`) for the product's own remote MCP server so the two
transports can never race for the same loopback port.

## [0.40.0](https://github.com/edjafarov/kiagent-core/compare/v0.39.0...v0.40.0) (2026-07-07)

### Features

* **platform:** add `unsafe.mainProcess` cap + `origin: 'bundled'`, bump platform API to 1.1.0 ([048d0db](https://github.com/edjafarov/kiagent-core/commit/048d0db82f088622e65d004841525c02009ab484))
* **platform:** manifest tiers — privileged caps restricted to bundled extensions ([6e09f68](https://github.com/edjafarov/kiagent-core/commit/6e09f6873ba79b6073981af1c4706470cd3e58d4))
* **platform:** child runtime delivers `mainApi` extras to `unsafe.mainProcess` extensions ([000701b](https://github.com/edjafarov/kiagent-core/commit/000701bbdf0ee8fcd753e524128aef4803aa5e6a))
* **platform:** bundled extension discovery — origin, auto-consent, uninstall/replace guards ([cb902f7](https://github.com/edjafarov/kiagent-core/commit/cb902f72db8a0cc29effc79408346454511c9c38))
* **platform:** run `unsafe.mainProcess` extensions in-process over the in-memory transport ([535ac82](https://github.com/edjafarov/kiagent-core/commit/535ac82c4ba6ced4dfb8e7f67e21c4538085b7bb))
* **marketplace:** bundled extensions — badge + no uninstall ([6c86af0](https://github.com/edjafarov/kiagent-core/commit/6c86af049bc16bb0f4ab26a56941c80aae44a85f))
* **product:** `product.json` loader with neutral defaults ([c2ebb4c](https://github.com/edjafarov/kiagent-core/commit/c2ebb4c92dd02a75cdd7ab96526af13e739fb01e))
* **product:** boot wiring — product config + bundled-extensions dir ([3dc0a6d](https://github.com/edjafarov/kiagent-core/commit/3dc0a6dd46956e7b7c80a22957f8145a75d2d5db))

A product build (private overlay, not in this repo) can now ship first-party
"bundled" extensions inside the app package, alongside marketplace/dev
extensions. Bundled extensions are auto-consented (trust = shipped in the
signed bundle), cannot be uninstalled or replaced by the marketplace, and
bundled ids win on a collision with an installed copy. A new privileged cap,
`unsafe.mainProcess`, is restricted to that bundled tier and runs the
extension in-process (over the same in-memory transport used by tests)
instead of forking a host process, handing it `activate(host, extras)` with
`extras.mainProcess` — a temporary escape hatch pending real capabilities in
a later stage. A neutral `product.json` (brand name, update-feed URL,
bundled-extensions dir override) lets a product build customize identity
without forking core; OSS ships no `product.json` and runs on defaults. A
bundled extension's `host.self.dataDir` is rooted outside the app package
(a `bundled-extensions-data` directory, overridable via
`ExtensionPlatformDeps.bundledDataDir`) rather than under its own
read-only, update-replaced install dir, and `origin` read from a
hand-edited `installed.json` is clamped to `'marketplace' | 'dev'` — it can
never forge `'bundled'`. See `docs/architecture/extension-platform.md` §
Bundled extensions (privileged tier) for the full model.

## [0.39.0](https://github.com/edjafarov/alpha-cent/compare/v4.7.0...v0.39.0) (2026-06-17)

### Features

* **accounts:** upsertAccountResumeSync preserves backfill cursor ([3bcd328](https://github.com/edjafarov/alpha-cent/commit/3bcd3280d573cdff7911da5effdcc805e829ef09))
* **auth:** auth:sign-in is identity-only; withGmail opt connects the source ([97525b3](https://github.com/edjafarov/alpha-cent/commit/97525b3ddde632cd7f724a40bc47cbc1fb46e774))
* **auth:** Skip — use kia locally; persisted local-mode opens the app gate ([29aff22](https://github.com/edjafarov/alpha-cent/commit/29aff223d492d5a843527c7e1838c14e89289718))
* **browser:** add browser connector IPC channels ([6a71f6d](https://github.com/edjafarov/alpha-cent/commit/6a71f6d1283986115c4ad3afd5ec55c7384bb633))
* **browser:** allow kind=browser tracked-roots + legacy purge migration ([2b39e56](https://github.com/edjafarov/alpha-cent/commit/2b39e5685f0dcc5100bcaee82cd35abd8386746a))
* **browser:** auto-detect profiles at startup; repurpose detect IPC ([d86efb7](https://github.com/edjafarov/alpha-cent/commit/d86efb7bc7697d4392fcfad64e9ea8256ac0044f))
* **browser:** backfill/delta iterate profiles with per-profile cursor map ([cd8729e](https://github.com/edjafarov/alpha-cent/commit/cd8729edf04390a3f4ee26e8e907b0d4a7df7423))
* **browser:** browserHistory privacy preference ([12894ff](https://github.com/edjafarov/alpha-cent/commit/12894ffbb08903ee980f263f4fe3ea53d84badf1))
* **browser:** chromium timestamp conversion helpers ([2ccca96](https://github.com/edjafarov/alpha-cent/commit/2ccca963313af98db7a0c7a042b7b0b6a17de3ce))
* **browser:** connector glyph + label ([ac3e553](https://github.com/edjafarov/alpha-cent/commit/ac3e553b41e267a156dad590c23be2e911418491))
* **browser:** connector object, registration, account upsert ([d2b3ed3](https://github.com/edjafarov/alpha-cent/commit/d2b3ed334d32d00757d4677a746afd5d7e0bfeef))
* **browser:** Connectors row + privacy panel ([be1e95e](https://github.com/edjafarov/alpha-cent/commit/be1e95e24e2a6077a2a1749d29c9df5f0ac8f899))
* **browser:** detect Chromium browsers and profiles ([8bd3b60](https://github.com/edjafarov/alpha-cent/commit/8bd3b6068b4ce00b9b5cbf83ad6e6bd32bad64e4))
* **browser:** detect-and-add + privacy IPC handlers, provider wiring ([1c1a8a2](https://github.com/edjafarov/alpha-cent/commit/1c1a8a2b2868196f821fd723c2404d22aacb42fa))
* **browser:** history backfill with window + blocklist + cursor ([a214737](https://github.com/edjafarov/alpha-cent/commit/a214737d9d9f588a882c02ba55fdb959310cc880))
* **browser:** incremental delta from saved cursor ([40981c5](https://github.com/edjafarov/alpha-cent/commit/40981c5e5216bac16a9b394629e722bda8d44717))
* **browser:** injectable privacy provider ([2849884](https://github.com/edjafarov/alpha-cent/commit/2849884bf9a918bf29b4331d25faa2659b7dc2b1))
* **browser:** map history rows to corpus documents ([6d91301](https://github.com/edjafarov/alpha-cent/commit/6d91301436f37942d4e7ba68d059752ecd8734e9))
* **browser:** per-profile doc counts in the source snapshot ([4048033](https://github.com/edjafarov/alpha-cent/commit/4048033311467948552fcea8efa3ab0f537ac94d))
* **browser:** render one Browsers row with a read-only profile list ([1b02b25](https://github.com/edjafarov/alpha-cent/commit/1b02b25ef5f4742bff57ffddbf146d5f88ff4f0c))
* **browser:** unified account + auto-track profiles as tracked-roots ([4df470d](https://github.com/edjafarov/alpha-cent/commit/4df470d65922c8b17f6f6ff1ee9cfaed7c380118))
* **connection:** add @iarna/toml dep and client-adapter types ([610b55a](https://github.com/edjafarov/alpha-cent/commit/610b55ac33eb4ef627fdeae90b577789eae8e554))
* **connection:** add connection:* channel contracts, drop stdio write channel ([6fd737a](https://github.com/edjafarov/alpha-cent/commit/6fd737a1f2c3192d7efd9797623db0bfa72168d7))
* **connection:** atomic write + backup helper for client configs ([20b0426](https://github.com/edjafarov/alpha-cent/commit/20b04264f4fe756c7eaafbda0c321325cc9b4c18))
* **connection:** client-adapter registry for the five MCP clients ([9a3509a](https://github.com/edjafarov/alpha-cent/commit/9a3509ae74e86747bfb12cfc63930d118a8ee83d))
* **connection:** Codex TOML mcp-config merge/remove helpers ([0c7ee43](https://github.com/edjafarov/alpha-cent/commit/0c7ee438727eeb4b9efc3fd5ae12823ba2690a97))
* **connection:** connection:* IPC handlers wired into main ([30408fc](https://github.com/edjafarov/alpha-cent/commit/30408fc7072ded585e6e43fe898cf937536be56d))
* **connection:** connection:* IPC handlers wired into main; drop stdio write handler ([2200bde](https://github.com/edjafarov/alpha-cent/commit/2200bdedb8b38daa672ed695eee52fa93fdb86e7))
* **connection:** generic JSON mcp-config merge/remove helpers ([fc32bbf](https://github.com/edjafarov/alpha-cent/commit/fc32bbfe02f46cfbae587c29a51991e47e564117))
* **connection:** Local clients section with connect/disconnect toggle ([fc35043](https://github.com/edjafarov/alpha-cent/commit/fc35043bc5955d227b2c7f44454391fa41b26017))
* **connection:** ManualSetup disclosure + ConnectionHub assembling Local + Remote ([5b5935f](https://github.com/edjafarov/alpha-cent/commit/5b5935f23e9a86b08737b848344d939876011b62))
* **connection:** Remote section module with Start remote CTA + from-anywhere copy ([5b94169](https://github.com/edjafarov/alpha-cent/commit/5b941693353f02b69ab57621cd85066f09fc146b))
* **connection:** rename MCP nav tab + view to Connection; route ConnectionHub ([e8aa576](https://github.com/edjafarov/alpha-cent/commit/e8aa57693474bf2ff912e13c41964afa610a97e4))
* **connectors:** real per-account pause + resume ([27d0f2b](https://github.com/edjafarov/alpha-cent/commit/27d0f2b1b66971df08fe36ba12d5a29691822b61))
* **db:** add documents.account_id ownership column with per-source backfill ([9555f90](https://github.com/edjafarov/alpha-cent/commit/9555f9071d781e739c0f2e079892a17491196fbb)), closes [#45](https://github.com/edjafarov/alpha-cent/issues/45)
* **deep-extraction:** Accel type + pure detectBackend ([06d99bb](https://github.com/edjafarov/alpha-cent/commit/06d99bbab8fd93fa60d5f83abd4edcb6494d2959))
* **deep-extraction:** accel-aware llama-server dir slug ([3e6bd4d](https://github.com/edjafarov/alpha-cent/commit/3e6bd4dd134a773484cc253d304e261995c8f2f0))
* **deep-extraction:** accel-driven -ngl (gpuLayers) in LlamaServer ([ff3d8d0](https://github.com/edjafarov/alpha-cent/commit/ff3d8d0c613a827349d14b3f7cf77e5da41ce5c1))
* **deep-extraction:** adaptive scheduler with atomic claims and power-aware pause ([1376d47](https://github.com/edjafarov/alpha-cent/commit/1376d474f5bb8543da800eaa2244ce4bcf331360))
* **deep-extraction:** add deep_extractions backlog table ([cfe6690](https://github.com/edjafarov/alpha-cent/commit/cfe669003621392a09a7eb5a79bf8e241baf0ad7))
* **deep-extraction:** add OcrProvider interface ([2650596](https://github.com/edjafarov/alpha-cent/commit/2650596ac7d5d5d3d85b5f5868b93d35bf47b37d))
* **deep-extraction:** add per-state backlog count query ([4701709](https://github.com/edjafarov/alpha-cent/commit/4701709cd1bc0f86933f37ced060e945df1a7d64))
* **deep-extraction:** add Rasterizer interface ([a5ccf62](https://github.com/edjafarov/alpha-cent/commit/a5ccf6288c358de88aefe944d45f76f8b523bfc5))
* **deep-extraction:** add underprocessed-document predicate ([22e6952](https://github.com/edjafarov/alpha-cent/commit/22e69527ed8343b60e64ef13d6ae9bbc0d308030))
* **deep-extraction:** apply can settle rows as ocr_done ([6166597](https://github.com/edjafarov/alpha-cent/commit/6166597034a8f98872d0ba962d074751c5a31e7b))
* **deep-extraction:** attribute download corruption + validate resume offset ([f5b235c](https://github.com/edjafarov/alpha-cent/commit/f5b235c415adaead52959ab19fa9ab3b27eaff77))
* **deep-extraction:** backend-aware model tiers + GLM-OCR descriptor ([fb870a6](https://github.com/edjafarov/alpha-cent/commit/fb870a6c38bdffad332d2f258e4e4130b99f0793))
* **deep-extraction:** build windows-ocr for win-arm64 too ([934376a](https://github.com/edjafarov/alpha-cent/commit/934376aa693aabd70394545fecf91f6b1efc5be5))
* **deep-extraction:** buildExtractionProviders platform factory ([28ada8c](https://github.com/edjafarov/alpha-cent/commit/28ada8cca3f30bfb30a39d191b23e59bc5883c3e))
* **deep-extraction:** byte-source registry + local-folder reader ([e0e19a4](https://github.com/edjafarov/alpha-cent/commit/e0e19a4f278759601e7086a636cc111cae9c0c2a))
* **deep-extraction:** capability gate + runtime status types ([3151d01](https://github.com/edjafarov/alpha-cent/commit/3151d01ee7e8cd3660fc5a4c2d739a4e618e7ea9))
* **deep-extraction:** capability result carries accel + slow, drop not_apple_silicon ([c424633](https://github.com/edjafarov/alpha-cent/commit/c42463325743ba4668961db5003b85918fc5e76d))
* **deep-extraction:** CoreGraphicsRasterizer (darwin) ([7caf796](https://github.com/edjafarov/alpha-cent/commit/7caf796ade1c281d3076a2c02e8bbb9386972366))
* **deep-extraction:** curated model catalog + path resolution ([e6a8a48](https://github.com/edjafarov/alpha-cent/commit/e6a8a48626dfcc59c49cbf6d851abb27166dcd7f))
* **deep-extraction:** decidePassRole pure swap policy ([c5fc2e9](https://github.com/edjafarov/alpha-cent/commit/c5fc2e985c25180d0eff9bbb775acb90f1171de6))
* **deep-extraction:** default local processing schedule to idle ([5973c4d](https://github.com/edjafarov/alpha-cent/commit/5973c4da53de9d0dd6c9f4387e3b9224c179566d))
* **deep-extraction:** define DeepExtractor seam + no-op ([5523c1c](https://github.com/edjafarov/alpha-cent/commit/5523c1ccafe6472b1ac3cf6f26efc658786085a8))
* **deep-extraction:** description-only full mode on single-model runtime ([71ab5fe](https://github.com/edjafarov/alpha-cent/commit/71ab5fe1eed673fb8f9479d65dda15b7f8d4b842))
* **deep-extraction:** detect backend at boot, thread accel through runtime ([dab2c23](https://github.com/edjafarov/alpha-cent/commit/dab2c2372f9c0f189306a04be85bcb0d71841235))
* **deep-extraction:** expose backlog counts in storage stats ([0956dc2](https://github.com/edjafarov/alpha-cent/commit/0956dc24a0168db0f56e57509150718924dcb3ed))
* **deep-extraction:** flat schedule + model-override prefs ([07974c9](https://github.com/edjafarov/alpha-cent/commit/07974c93f672de5116193189ba21ff1bceaa157c))
* **deep-extraction:** GlmOcrProvider (llama-server OCR mode) ([458fb2d](https://github.com/edjafarov/alpha-cent/commit/458fb2d597f948ce4d2306abe8c7c6aa06da697b))
* **deep-extraction:** gmail byte source + shared account token worker ([4c40eb0](https://github.com/edjafarov/alpha-cent/commit/4c40eb04a897ebbf8b55521245b93c8782c84c04))
* **deep-extraction:** kia-vision Swift helper (Vision OCR + PDF rasterize) ([192c267](https://github.com/edjafarov/alpha-cent/commit/192c267df98d67a484a9ea89054d6372ac552349))
* **deep-extraction:** live detectHostBackend via --list-devices probe ([eded188](https://github.com/edjafarov/alpha-cent/commit/eded1881fdf4374b5f177f0a2a0edf3d06130e35))
* **deep-extraction:** live model provider + override resolution ([1d2b6eb](https://github.com/edjafarov/alpha-cent/commit/1d2b6ebd1553a8560aa93b69a6658eed79377981))
* **deep-extraction:** llama-server supervisor with crash respawn ([6dcadc8](https://github.com/edjafarov/alpha-cent/commit/6dcadc89dbaba54f86c7770ded7bf8de59c347c9))
* **deep-extraction:** Local processing panel in Settings → Storage ([a4b5495](https://github.com/edjafarov/alpha-cent/commit/a4b5495fccbdbb14405c4a948d9996d5a5077f3c))
* **deep-extraction:** Local processing settings screen ([e337ab5](https://github.com/edjafarov/alpha-cent/commit/e337ab5e2da587987c7c80571d93b81e3154ba86))
* **deep-extraction:** local-runtime status formatter ([79b3518](https://github.com/edjafarov/alpha-cent/commit/79b35187e4ac42d0e2aea900a3aecb19df1d6781))
* **deep-extraction:** LocalDeepExtractor — OCR+VLM per image/PDF page ([829ae0f](https://github.com/edjafarov/alpha-cent/commit/829ae0f8c8c9e2363ec43f514efe1ae8a823082a))
* **deep-extraction:** NativeVisionOcr provider (darwin) ([3bc4070](https://github.com/edjafarov/alpha-cent/commit/3bc40703b1c449eaaa5792ec572ccd8035d0c6b8))
* **deep-extraction:** ocr_done state + OCR-only extract mode ([d38ae50](https://github.com/edjafarov/alpha-cent/commit/d38ae5015ff5344be685f6c9942a3546dc9d0e50))
* **deep-extraction:** OCR-first two-pass scheduling ([f16edaf](https://github.com/edjafarov/alpha-cent/commit/f16edaf2c99226ba8b159d1f814f85b2d1d19dd7))
* **deep-extraction:** OCR+description markdown merge ([1f31788](https://github.com/edjafarov/alpha-cent/commit/1f317887d7dfd3f98582988164cc02c6d95272ba))
* **deep-extraction:** per-account gmail token-worker cache ([ea9e62b](https://github.com/edjafarov/alpha-cent/commit/ea9e62b940dd31190f15929f40eb024a635ea36f))
* **deep-extraction:** periodic ReconcilerService ([5ac62e4](https://github.com/edjafarov/alpha-cent/commit/5ac62e4246ba9d54107e6b47daff3cdc089e81fa))
* **deep-extraction:** persist deepExtraction.enabled pref ([f667ae1](https://github.com/edjafarov/alpha-cent/commit/f667ae1385157dfac8a493b64471cde0856ee3a7))
* **deep-extraction:** power signals adapter over powerMonitor ([a5331d0](https://github.com/edjafarov/alpha-cent/commit/a5331d0f97aeb1d8351bf67c786c89e010db7603))
* **deep-extraction:** pure schedule gate (always/idle/night) ([4948e0c](https://github.com/edjafarov/alpha-cent/commit/4948e0cc1d5f47568add183e4dbeb654ab0271cc))
* **deep-extraction:** RAM-tiered curated models (12B/E4B/E2B) ([917b410](https://github.com/edjafarov/alpha-cent/commit/917b4101cd6a73b09a4ef95f27a6b7f93fecb3c9))
* **deep-extraction:** recent extracted docs in storage stats ([1007980](https://github.com/edjafarov/alpha-cent/commit/10079803729ccfa659ec4f68efeec80a1b9ba3bb))
* **deep-extraction:** reconcile backlog against documents ([a8d2a1e](https://github.com/edjafarov/alpha-cent/commit/a8d2a1ee1b45263aa8036879cb4c8e13bf34b396))
* **deep-extraction:** resumable checksummed model downloader ([56a6e54](https://github.com/edjafarov/alpha-cent/commit/56a6e540d870dccd52b2b255e373fcb8d4d39502))
* **deep-extraction:** runtime IPC channels + injectable wiring ([77b37a3](https://github.com/edjafarov/alpha-cent/commit/77b37a3cf327de006f09d6de466fa080a4470ee3))
* **deep-extraction:** RuntimeManager state machine ([561d320](https://github.com/edjafarov/alpha-cent/commit/561d320cb7f7a7eea591335d193445b7575f6fd2))
* **deep-extraction:** RuntimeManager tracks loaded model role ([0f98eea](https://github.com/edjafarov/alpha-cent/commit/0f98eeaeef554d45cc01ebee9bad8f0ed7cd7bb1))
* **deep-extraction:** RuntimeManager.useModel swaps the served model ([302d8a4](https://github.com/edjafarov/alpha-cent/commit/302d8a4915a887bfe56925f516077abe4d492529))
* **deep-extraction:** scheduler honors the schedule gate; waiting status ([51cf1c4](https://github.com/edjafarov/alpha-cent/commit/51cf1c498dacdc539d156a8af3f9b67e3a115077))
* **deep-extraction:** scheduler policy table + (state,created_at) index ([2bb6157](https://github.com/edjafarov/alpha-cent/commit/2bb6157d640cf80e4b7e7bfddc7855fc3f6b398b))
* **deep-extraction:** select curated model by RAM tier at startup ([729a810](https://github.com/edjafarov/alpha-cent/commit/729a81097036539187ef71738f8b910e953805e4))
* **deep-extraction:** select WindowsOcr on win32 + generalize the GLM gate ([35102d0](https://github.com/edjafarov/alpha-cent/commit/35102d0cbb407bfc8df269d46383650abeaa31df))
* **deep-extraction:** set-model + process-now IPC, schedule gate wiring ([7499d26](https://github.com/edjafarov/alpha-cent/commit/7499d26766173423f73625823eb964b6359e9b66))
* **deep-extraction:** show accel (GPU/CPU) label in local runtime tile ([d44046b](https://github.com/edjafarov/alpha-cent/commit/d44046bb1d84b4ba88df57a88c9dddd1b071ec9c))
* **deep-extraction:** show backlog count in Settings → Storage ([a00aa0c](https://github.com/edjafarov/alpha-cent/commit/a00aa0c352e978e0fed58a07a76cee61db8073d7))
* **deep-extraction:** show scheduler activity on the storage tile ([2363ee5](https://github.com/edjafarov/alpha-cent/commit/2363ee5e9ff8f3cab72137360a46919136469bf0))
* **deep-extraction:** single-model pass path with drain-before-swap ([9b8ef3a](https://github.com/edjafarov/alpha-cent/commit/9b8ef3a2a39e874e2b029d77f0b7a51ac4c29229))
* **deep-extraction:** skip error + elaborated candidate/result types ([64a4be8](https://github.com/edjafarov/alpha-cent/commit/64a4be8cf722dcee715dd2815fd3f0ffdc3d9e68))
* **deep-extraction:** tier-based capability gate over {accel, capacityBytes} ([345396a](https://github.com/edjafarov/alpha-cent/commit/345396a4e6d3e3159591c1943c416bbd91fd950c))
* **deep-extraction:** tile shows docs awaiting visual description ([c48d80b](https://github.com/edjafarov/alpha-cent/commit/c48d80b23eb0e17a5940001faf2d6394ecef302f))
* **deep-extraction:** trivial serial drain loop (claim/extract/apply) ([4ad3ff0](https://github.com/edjafarov/alpha-cent/commit/4ad3ff007597b28d7c7d1c022eab2f2c2a17f786))
* **deep-extraction:** VisionHelper wrapper + path resolution ([a3ef6bf](https://github.com/edjafarov/alpha-cent/commit/a3ef6bfad45651c4b450bb44b07353bd85ba39f7))
* **deep-extraction:** VLM describe client for the local endpoint ([6620c75](https://github.com/edjafarov/alpha-cent/commit/6620c7593bf61bfc1471a1ea73aff633ef5a54b9))
* **deep-extraction:** WasmRasterizer via pdfium WASM ([3db6078](https://github.com/edjafarov/alpha-cent/commit/3db607851b3307184060db8859813afd9ca12586))
* **deep-extraction:** WindowsOcr provider behind the OcrProvider seam ([3c89dd9](https://github.com/edjafarov/alpha-cent/commit/3c89dd999783ca3f4a2e2b0637201501bdcbb1f7))
* **deep-extraction:** WindowsOcrHelper execFile wrapper + path resolver ([9c04a07](https://github.com/edjafarov/alpha-cent/commit/9c04a07fe209d8d2d333255bd14ce88095d6ce92))
* **deep-extraction:** WinRT windows-ocr helper (Windows.Media.Ocr) ([ea10c21](https://github.com/edjafarov/alpha-cent/commit/ea10c21c9c2c1a8327d5eb2e9c7e3286d489462e))
* **deep-extraction:** wire GLM-OCR model-swap through the runtime + scheduler ([be0e8eb](https://github.com/edjafarov/alpha-cent/commit/be0e8ebedd3bdb3458c34d7a17f697c41b935be6))
* **deep-extraction:** wire LocalDeepExtractor + drain into the app lifecycle ([23e6124](https://github.com/edjafarov/alpha-cent/commit/23e61244d63a14654329c9e362c587a4b42c35e8))
* **deep-extraction:** wire platform provider factory into main ([a399202](https://github.com/edjafarov/alpha-cent/commit/a399202193a8bf3e57d99e566147822c3a232bf7))
* **deep-extraction:** wire ReconcilerService into app lifecycle ([c9323e7](https://github.com/edjafarov/alpha-cent/commit/c9323e76c92e56a3f7a408673ecc6927768b66ba))
* **deep-extraction:** wire RuntimeManager into the app lifecycle ([66c3f83](https://github.com/edjafarov/alpha-cent/commit/66c3f8357424da220f3da1ab9b1c1a18e442be68))
* **deep-extraction:** wire the adaptive scheduler, retire the serial drain ([9c0c21c](https://github.com/edjafarov/alpha-cent/commit/9c0c21cddb9e62d707c8d3badd118e1da03ff7a7))
* **deep-extraction:** wire WindowsOcr helper + native-aware GLM gate in main ([7fa50b8](https://github.com/edjafarov/alpha-cent/commit/7fa50b86ae0c623480a67dbe3aef3eef17ebd517))
* **deep-extraction:** write-back via upsert path + done transition ([36d257d](https://github.com/edjafarov/alpha-cent/commit/36d257dbdc483c71cea1c7b4553acc587b52b563))
* **imap:** account-scoped message index store ([e22517a](https://github.com/edjafarov/alpha-cent/commit/e22517a932581e8fefe77ed41c589a086ce0a19b))
* **imap:** add deps + imap_message_index table ([92fe7a7](https://github.com/edjafarov/alpha-cent/commit/92fe7a76d0ca1620a3d46f27ea844af19efe6c51))
* **imap:** add-account IPC channel + handler ([c8785fd](https://github.com/edjafarov/alpha-cent/commit/c8785fd9bd1e43e1d44a04a80b392e2614298ffa))
* **imap:** attachment byte source ([a06244b](https://github.com/edjafarov/alpha-cent/commit/a06244b6157011f345c898e66baa05b6d6781726))
* **imap:** backfill ([6841795](https://github.com/edjafarov/alpha-cent/commit/6841795ea93602e022201fdff927ae3a2d935c08))
* **imap:** connector descriptor + registration ([74474a6](https://github.com/edjafarov/alpha-cent/commit/74474a62c06512c86f59f59713fbce6270b79dd6))
* **imap:** core types and ImapClient interface ([ef73f99](https://github.com/edjafarov/alpha-cent/commit/ef73f9927d8ee04344b068c882881833992e69e3))
* **imap:** credential blob + add-account validation ([e5541dd](https://github.com/edjafarov/alpha-cent/commit/e5541dd7b098ba2e74941a4e1dcf57f16bf96f31))
* **imap:** deletion reconcile ([f25c22e](https://github.com/edjafarov/alpha-cent/commit/f25c22e81ff2a06956f237a4f15ccfe45d0010a7))
* **imap:** delta poll with UIDVALIDITY guard ([5d99b58](https://github.com/edjafarov/alpha-cent/commit/5d99b5848d6d4d117034eca2a74cc4d151912a7e))
* **imap:** document imap source + imap_message_index in MCP schema-doc ([e10a989](https://github.com/edjafarov/alpha-cent/commit/e10a9895ed8372ca91d94b6891daba1f611278e4))
* **imap:** imapflow-backed client ([4f1ad83](https://github.com/edjafarov/alpha-cent/commit/4f1ad83816661c643ae58ae752a05ee096aedaaf))
* **imap:** ingest path (parse + thread key + index) ([7e27dca](https://github.com/edjafarov/alpha-cent/commit/7e27dca33088a24e270f3bc63a5bc36a82803118))
* **imap:** renderer registry entry, connect dialog, dispatch ([9e99ab3](https://github.com/edjafarov/alpha-cent/commit/9e99ab369fdcd16788e04339c6e91f46299029ae))
* **imap:** RFC822 parser to ParsedEmail ([618223e](https://github.com/edjafarov/alpha-cent/commit/618223eccf43d0747f8f13d3d19accfbf8b74836))
* **imap:** special-use folder resolution ([59c2294](https://github.com/edjafarov/alpha-cent/commit/59c229444fb5ec42d2621ffeda728d765ddc6726))
* **imap:** thread builder via email-shared strategy ([8db465b](https://github.com/edjafarov/alpha-cent/commit/8db465b02d41f77043c0ced6f9ea6fa804330dda))
* **imap:** thread rebuild from indexed members ([affc429](https://github.com/edjafarov/alpha-cent/commit/affc4292138dff4250300d2057e3e789524d8b59))
* **imap:** threading primitives ([1189e63](https://github.com/edjafarov/alpha-cent/commit/1189e6370934def9ce8fc944fba5592d2be2674a))
* **instagram:** account validation + connector object ([eec8f64](https://github.com/edjafarov/alpha-cent/commit/eec8f6438c592b15943f487b33d84faa920c91b9))
* **instagram:** chat-day doc builder shared by delta + import ([67c05e4](https://github.com/edjafarov/alpha-cent/commit/67c05e423cd4ee9974be17a2fc437330fc7b6872))
* **instagram:** connect dialog + export import action ([c1cc456](https://github.com/edjafarov/alpha-cent/commit/c1cc45624dfdf67f377ff795638c5a1d9d229770))
* **instagram:** create file docs for export media so deep-extraction OCRs them ([853ad1b](https://github.com/edjafarov/alpha-cent/commit/853ad1bbc7bc33206c4a86d7a7f3abb569acb282))
* **instagram:** DYI export importer with mojibake repair ([022d971](https://github.com/edjafarov/alpha-cent/commit/022d9715c84401e037241faebabc281b3972387b))
* **instagram:** eagerly download live-DM photo media for OCR ([c858cd3](https://github.com/edjafarov/alpha-cent/commit/c858cd30c54418d9e2101395cc7f04d64adec3e6))
* **instagram:** Graph API client over bearerFetch ([3e4fec3](https://github.com/edjafarov/alpha-cent/commit/3e4fec348259e1d691594407c19d87065757f3fc))
* **instagram:** IPC channels + add-account/import handlers ([9be3984](https://github.com/edjafarov/alpha-cent/commit/9be39842a9834829918b3bf970c365c61e5b4ddf))
* **instagram:** polling delta with observed-cursor advance ([2ea1eb9](https://github.com/edjafarov/alpha-cent/commit/2ea1eb9bde9f73cc5bfd80faabef909ad9c3d25a))
* **instagram:** register builtin connector ([e83607e](https://github.com/edjafarov/alpha-cent/commit/e83607e909f55add6cc40f8d23aa701bf3efb9b6))
* **instagram:** register byte source for export media ([b70d871](https://github.com/edjafarov/alpha-cent/commit/b70d87107d0884fe4e9456d5bdf71e4e0a55c297))
* **instagram:** renderer registry entry + glyph/tag tokens ([03d7a92](https://github.com/edjafarov/alpha-cent/commit/03d7a92e6e1fb81b6f82f1e477dfaae5da80c38c))
* **instagram:** token types + encrypted blob round-trip ([4a2feb7](https://github.com/edjafarov/alpha-cent/commit/4a2feb7bbcec0199038d59e98100d6258f56c6e5))
* **instagram:** wire export import action via in-handler folder picker ([4730dcb](https://github.com/edjafarov/alpha-cent/commit/4730dcbaa9337c35ef49a083b3df4362d8bf9750))
* **local-folder:** reconcile offline changes on live restart ([4c7eefb](https://github.com/edjafarov/alpha-cent/commit/4c7eefb1fc409d50eddff29f47f24d0fb1eba996))
* **mcp/search:** intent-first description + configurable snippet context ([ccfef9e](https://github.com/edjafarov/alpha-cent/commit/ccfef9e98717674d43a2e72e260215d191ed257e))
* **mcp:** show loading state until remote status is known ([450c96b](https://github.com/edjafarov/alpha-cent/commit/450c96ba32e95d99e2255d6dbb195664f5222d39))
* **notion:** add-account IPC channel + handler ([3492f03](https://github.com/edjafarov/alpha-cent/commit/3492f03755634cb263c025b377fa7b9c37bb2f3d))
* **notion:** connector definition + registry wiring ([bd37018](https://github.com/edjafarov/alpha-cent/commit/bd37018fd806d45363e4972960d5648533d04e80))
* **notion:** edit-since delta walk + reconcile gate ([0ed143e](https://github.com/edjafarov/alpha-cent/commit/0ed143e91c75d03819494bb98c6d157257962a49))
* **notion:** flip the UI stub live with a paste-token dialog ([ac93a18](https://github.com/edjafarov/alpha-cent/commit/ac93a187dc1081285fbb72c8f00b74e1b3b4d73d))
* **notion:** full-enumeration backfill ([e911231](https://github.com/edjafarov/alpha-cent/commit/e91123117dad5585e042be063260ac3cf6ec7f9e))
* **notion:** nightly deletion reconciliation ([2bc98a0](https://github.com/edjafarov/alpha-cent/commit/2bc98a0ff3fcf2aa075916e61b284f1e980533c5))
* **notion:** page → document builder ([ff5d470](https://github.com/edjafarov/alpha-cent/commit/ff5d470a11e48fc52e99c78d58c3eebc19c5e076))
* **notion:** paste-token validation ([1db021a](https://github.com/edjafarov/alpha-cent/commit/1db021a6254291a721da8973430473a851921666))
* **notion:** rate-limited REST client ([e656193](https://github.com/edjafarov/alpha-cent/commit/e6561933d2fc99410c7e40ca7b9adb13dcd3c818))
* **notion:** rich-text + block-tree markdown renderer ([81c1692](https://github.com/edjafarov/alpha-cent/commit/81c1692431f99815c53f3c2335bf602cf75c15a1))
* **notion:** token codec + connector types ([991ad3f](https://github.com/edjafarov/alpha-cent/commit/991ad3fad149323a14dd2d3bbd43c0ae3057adb2))
* **notion:** user-id directory ([96c0d84](https://github.com/edjafarov/alpha-cent/commit/96c0d8482475da463781ff423f310d0322b8ef6b))
* **onboarding:** latch "Connect your LLM" on local connect + cross-process query signal ([ed75d55](https://github.com/edjafarov/alpha-cent/commit/ed75d5508c0b7055a67c2dbd02e74fe6c3e8b885))
* **pickers:** spinner on expanding nodes + initial-load row ([cfb4a45](https://github.com/edjafarov/alpha-cent/commit/cfb4a459f42808cbbad8e99c42a63f4ae2ff9af6))
* **prefs:** add remoteEnabled (default off) ([0c64ffa](https://github.com/edjafarov/alpha-cent/commit/0c64ffadb8a2adee3c811a593a151d53d44bcb0e))
* **remote-mcp:** rate-limit Dynamic Client Registration ([6a95590](https://github.com/edjafarov/alpha-cent/commit/6a95590a6226d924f98ecf9b590dfd45b2787e91)), closes [#15](https://github.com/edjafarov/alpha-cent/issues/15)
* **remote:** gate tunnel/HTTPS auto-start on remoteEnabled ([08f9294](https://github.com/edjafarov/alpha-cent/commit/08f92944276f3c67ba443464c76b8850cd2bf7fa))
* **remote:** open Start-remote URL, pin OAuth to the signed-in account ([7e12dc8](https://github.com/edjafarov/alpha-cent/commit/7e12dc8e7159cdebf54413310eeb6adca4f56c79))
* **remote:** start-oauth opts in, release opts out + tears down transport ([eddee62](https://github.com/edjafarov/alpha-cent/commit/eddee62e181831c8656201a9bb7266c1929054a5))
* **remote:** wire remoteEnabled into stack + grandfather live certs once ([c3a100b](https://github.com/edjafarov/alpha-cent/commit/c3a100be4b449e9e673b6e9523488abd444a3501))
* **settings:** loading states for prefs/status/stats first load ([ea0322b](https://github.com/edjafarov/alpha-cent/commit/ea0322b50ddd2e3caed7972c1dd00e9fa6f7c307))
* **slack:** account doc counts in dashboard + purge coverage ([3fcab01](https://github.com/edjafarov/alpha-cent/commit/3fcab01299dec3048836043c9d58bdb93cf7a59d))
* **slack:** add-workspace dialog in Settings connectors ([a97b2d3](https://github.com/edjafarov/alpha-cent/commit/a97b2d3918730c95c29a79152778268aaf26e576))
* **slack:** add-workspace IPC flow with token validation ([a144eee](https://github.com/edjafarov/alpha-cent/commit/a144eee80001a54eb6e2c6c1e08fc72707a49813))
* **slack:** budgeted delta polling with active-thread tracking ([9cc8a2d](https://github.com/edjafarov/alpha-cent/commit/9cc8a2d550409d5c6b558b91e73192c4f913b3a4))
* **slack:** connector instance + registration ([421bdb0](https://github.com/edjafarov/alpha-cent/commit/421bdb0d439308b5eb5ba78154ac4f25cf969818))
* **slack:** connector types + internal-app manifest ([63f384c](https://github.com/edjafarov/alpha-cent/commit/63f384c0e21b039ab935bd8c2e1b08c81469ca8d))
* **slack:** deep-extraction byte source for slack files ([b9f65cd](https://github.com/edjafarov/alpha-cent/commit/b9f65cdf563041b4c5dc902413bd5324fc3f7f6a))
* **slack:** mrkdwn to markdown renderer ([e6876b1](https://github.com/edjafarov/alpha-cent/commit/e6876b19817dbcb72e7283acc28e5670ad9c4b73))
* **slack:** rate-limited Web API client ([fcc20ae](https://github.com/edjafarov/alpha-cent/commit/fcc20aebab474158b50af35b70f1d76e6b0b2225))
* **slack:** resumable conversation backfill ([bb48458](https://github.com/edjafarov/alpha-cent/commit/bb484585886a8978a0e57b5104c745a43bfb989e))
* **slack:** Slack tile in the Add-a-source menu ([ad47dd4](https://github.com/edjafarov/alpha-cent/commit/ad47dd4ed65da1908897612f9b898f4a31d31be2))
* **slack:** thread/channel-day/file document builders ([48b9b2b](https://github.com/edjafarov/alpha-cent/commit/48b9b2bcb3fd0b996e9971c81665814fd8344333))
* **slack:** token blob codec + user directory ([80850a9](https://github.com/edjafarov/alpha-cent/commit/80850a9266a9c42105cb705faa7c088be11a9a5d))
* **tray:** 'Restart to update' item when an update is downloaded ([2a93d46](https://github.com/edjafarov/alpha-cent/commit/2a93d4686091e0c2ab8be243056dca7ce0fbafed))
* **tray:** frame menubar icon in the Bracket reticle, edge-flush ([14dc231](https://github.com/edjafarov/alpha-cent/commit/14dc2314dcf29e91357ea209bb5730cf3c1bf61f))
* **tray:** native context menu, retire the React tray popover ([d37373c](https://github.com/edjafarov/alpha-cent/commit/d37373c4c925abbec6b58df0178524e10c2ea807))
* **ui:** branded boot splash instead of bare Loading… on white ([a2ccb58](https://github.com/edjafarov/alpha-cent/commit/a2ccb586170ae7e71ee1b911bc5ca4c8f349ffa5))
* **ui:** identity-only vs index-Gmail sign-in; honest disconnect copy ([83a7867](https://github.com/edjafarov/alpha-cent/commit/83a7867ee00a5f52ff0fdad631834f87478842a8))
* **ui:** restyle Connection screen and rename "corpus" to "digital memory" ([6058070](https://github.com/edjafarov/alpha-cent/commit/6058070298c7701c96cdb830cb663e751eef0d1c))
* **ui:** restyle Local processing screen ([3e31ba7](https://github.com/edjafarov/alpha-cent/commit/3e31ba7dc378f65dd51ded6bc13c564861ed8665))
* **ui:** Spinner + Busy loading primitives with anti-flicker delay ([a74a235](https://github.com/edjafarov/alpha-cent/commit/a74a2356d43d49395770c9bdbeedd490a715553a))
* **updater:** add update state + dependency types ([76ca982](https://github.com/edjafarov/alpha-cent/commit/76ca982ab452987cfbd845b58060f5d9f0acad03))
* **updater:** add update:* invoke + push:update-state channels to the IPC contract ([7f74ae0](https://github.com/edjafarov/alpha-cent/commit/7f74ae06a4b809f7be634f90d8f0a59a372f5968))
* **updater:** event-driven update state machine with eligibility gate ([ea400f5](https://github.com/edjafarov/alpha-cent/commit/ea400f52eae0b12a08b273769fecba77846a1c11))
* **updater:** gentle native notifier — one-shot toast on downloaded ([477018a](https://github.com/edjafarov/alpha-cent/commit/477018a7dbdc7cb05906dbd4e5b649eed10d59bf))
* **updater:** real update UI in About (check / progress / restart) ([559c5ff](https://github.com/edjafarov/alpha-cent/commit/559c5ff53aa23ef656a82ec7d1b9857ff20f8f83))
* **updater:** replace AppUpdater stub with the real updater + IPC wiring ([ee5bce9](https://github.com/edjafarov/alpha-cent/commit/ee5bce9b44ecedc64fb0c9b0443ade5ff061512d))
* **updater:** wire native notifier + tray restart item into main ([0007d8b](https://github.com/edjafarov/alpha-cent/commit/0007d8b9ea4db691ebe4c15e021e75df729000db))
* **updater:** wire update:* IPC channels to the updater manager ([fa438cc](https://github.com/edjafarov/alpha-cent/commit/fa438ccf4b4d56a306ad50b3e34c47c61ed29ae0))
* **whatsapp:** Baileys message normalizer ([62031f3](https://github.com/edjafarov/alpha-cent/commit/62031f3ce2ed9cac95d6ba4a9c9e4c6968675afc))
* **whatsapp:** Baileys socket lifecycle wrapper ([ed3a007](https://github.com/edjafarov/alpha-cent/commit/ed3a00754f46c14590dd96a9bbe7826069db2fc7))
* **whatsapp:** chat-day document builder (merge + render) ([058454c](https://github.com/edjafarov/alpha-cent/commit/058454c93b4a93eb96c8216717bfdff02f2249d4))
* **whatsapp:** connector scaffold, types, registration ([676bd4f](https://github.com/edjafarov/alpha-cent/commit/676bd4f82cf03639849c65bdd4ac38cb21ae6753))
* **whatsapp:** contact/name resolution ([70564ef](https://github.com/edjafarov/alpha-cent/commit/70564efb0237597659124abf87c6ec2af9efb47a))
* **whatsapp:** encrypted Baileys auth-state store (baileys@6.7.23) ([fa33169](https://github.com/edjafarov/alpha-cent/commit/fa3316984af26bb555f4dc9713b38fd04f95a7fc))
* **whatsapp:** export transcript parser adapter ([b013256](https://github.com/edjafarov/alpha-cent/commit/b013256c2a4664f883d85f4224097137a320b65a))
* **whatsapp:** export-file import orchestrator + IPC channel ([623198e](https://github.com/edjafarov/alpha-cent/commit/623198eaacfc206d09753d5266cf31fb0c5283a0))
* **whatsapp:** live connector instance + scheduler lifecycle ([959d4f7](https://github.com/edjafarov/alpha-cent/commit/959d4f7006ee0849e641c16cc4cc27b3ee32517e))
* **whatsapp:** media cache + file-doc emitter + first-pass convert ([291370b](https://github.com/edjafarov/alpha-cent/commit/291370bda26051fcc841e44bcf346a939c3bb61b))
* **whatsapp:** media cache cleanup sweep ([97e09eb](https://github.com/edjafarov/alpha-cent/commit/97e09eb297c669cadf64e00d363c23617c487a21))
* **whatsapp:** pairing IPC + connect dialog + import affordance ([cb72a63](https://github.com/edjafarov/alpha-cent/commit/cb72a631655982894ef3820e5dbf14ea821aeef0))
* **whatsapp:** register media byte source for deep-extraction ([3b82a73](https://github.com/edjafarov/alpha-cent/commit/3b82a73d6ca7dfd3df9ed23513879ead2c8ff058))
* **whatsapp:** set chat-day content_hash for idempotent re-import ([e0d8a6f](https://github.com/edjafarov/alpha-cent/commit/e0d8a6f5dd239012a64efce869fa5424b39b9a7d))
* **whatsapp:** wire export-file import IPC handler ([003309f](https://github.com/edjafarov/alpha-cent/commit/003309f5c1a8ccf42f4d01dd3cb5cb0adb47c691))

### Bug Fixes

* **auth:** derive signedIn from local identity, not the remote kia token ([2bd559b](https://github.com/edjafarov/alpha-cent/commit/2bd559b5870b74ba8055fe9601c659216fc42c06))
* **auth:** Google identity email from id_token claim, not the Gmail endpoint ([7ff60ad](https://github.com/edjafarov/alpha-cent/commit/7ff60adcde2b39ae4b25480509b9d87f9253f022))
* **auth:** re-connecting Gmail resumes sync instead of full re-backfill ([b490ba6](https://github.com/edjafarov/alpha-cent/commit/b490ba6e3511d1a89b8f2f3e64de1c822eabcbe7))
* **broker:** add undici timeouts to denylist fetch and stop silently swallowing pipe errors ([916921d](https://github.com/edjafarov/alpha-cent/commit/916921d24b5bcb6434a8d82a301a202afda21681)), closes [#13](https://github.com/edjafarov/alpha-cent/issues/13) [#12](https://github.com/edjafarov/alpha-cent/issues/12)
* **browser:** avoid temp-dir leak if History copy fails ([5e5f388](https://github.com/edjafarov/alpha-cent/commit/5e5f3883cf8ea50a78b99d1665a50da62620c7fa))
* **browser:** copyHistoryDb cleans temp dir on copy failure; test delta re-upsert ([6e5c810](https://github.com/edjafarov/alpha-cent/commit/6e5c810fba0ae1cad2c2b8f9d26d1060e43d4e42))
* **browser:** make privacy panel robust to partial/absent IPC response ([eda1299](https://github.com/edjafarov/alpha-cent/commit/eda1299b868bd6821c5a5fb2e765aa97e1f0be4a))
* **browser:** show privacy panel pre-detection; wire browser into Sources screen ([7f84c66](https://github.com/edjafarov/alpha-cent/commit/7f84c662cd98e1b5de9623c931b3750e5624565e))
* **ci:** build webpack bundles before jest in dev gate ([0721283](https://github.com/edjafarov/alpha-cent/commit/07212839d87a678f1d0556e3364a75ace779ffbe))
* **ci:** force jest exit and repair cert-provision DNS self-check test ([9a21efb](https://github.com/edjafarov/alpha-cent/commit/9a21efb66196acd1a5e635df42af7e90399bb4c5))
* **ci:** scope dev gate to fast suites via jest.config.dev.js ([adeb936](https://github.com/edjafarov/alpha-cent/commit/adeb936281f010d42653fe576a42e966e107b417))
* **ci:** stop renewal-timer leak and cap jest workers to de-flake ([77a36b1](https://github.com/edjafarov/alpha-cent/commit/77a36b15beca069a5bcb0644f96901fe2d833cf7))
* **ci:** unblock dev typecheck — exclude standalone registration pkg, drop stale test ([80459ff](https://github.com/edjafarov/alpha-cent/commit/80459ffd81d2eded21b4943cdac865c1c8a9f0e0))
* **connectors:** clear needs_reauth/error park on Gmail reconnect ([f345e6b](https://github.com/edjafarov/alpha-cent/commit/f345e6b3de2190dce6630c01f4dd261a07dd4fe7))
* **connectors:** gate browser privacy panel until config loads ([16fd1b7](https://github.com/edjafarov/alpha-cent/commit/16fd1b715ab6eb9cb0f38a31f900081163f4427c))
* **deep-extraction:** contain worker failures; pin settle guards; bound exclusion list ([049b625](https://github.com/edjafarov/alpha-cent/commit/049b625480f5ac92a18fd19a59df0e3d4098ce63))
* **deep-extraction:** copy each download chunk before it enters the write queue ([e687b20](https://github.com/edjafarov/alpha-cent/commit/e687b204baaed7486e5265a4700f43e324291351))
* **deep-extraction:** correct unsupported copy + Vulkan vendor-name parse ([82c018f](https://github.com/edjafarov/alpha-cent/commit/82c018fc2df9c5535e7ad9f7f936a2b8ae425c9a))
* **deep-extraction:** do not skip GLM-OCR images that report no geometry ([9c465ee](https://github.com/edjafarov/alpha-cent/commit/9c465ee5ac27179c44ce9a4369e73035027e9545))
* **deep-extraction:** don't destroy a truncated download as checksum mismatch ([70f59c2](https://github.com/edjafarov/alpha-cent/commit/70f59c2996dd0b1122ed999c7e1a1e82378f0b42))
* **deep-extraction:** dynamic-import ESM-only pdfium from CJS wasm rasterizer ([f159445](https://github.com/edjafarov/alpha-cent/commit/f159445c8e346d8bd98dc6817f617b66b34ffc1f))
* **deep-extraction:** fresh attempts budget on park; cover same-pass enrich ([5a564c0](https://github.com/edjafarov/alpha-cent/commit/5a564c0ffb8bc80cb4f858304caa71635d8acf53))
* **deep-extraction:** gate ALL scheduler passes on the enable pref ([73e5e67](https://github.com/edjafarov/alpha-cent/commit/73e5e67cea9f120192c863045440e89b7eb58bba))
* **deep-extraction:** include ocr_done in the StorageStats contract type ([2e079a5](https://github.com/edjafarov/alpha-cent/commit/2e079a5e19fbf9e8e59b677a2a2686be599a398e))
* **deep-extraction:** log runtime state changes, not every progress tick ([03f917c](https://github.com/edjafarov/alpha-cent/commit/03f917c5d4cde132c88684679325ad375c3a3322))
* **deep-extraction:** map llama-server log severity instead of stderr=error ([0b7127b](https://github.com/edjafarov/alpha-cent/commit/0b7127b365754a96915685ba89f9418b332a6380))
* **deep-extraction:** probe the Windows OCR engine before suppressing GLM-OCR ([7f623d9](https://github.com/edjafarov/alpha-cent/commit/7f623d9b23060fd6cfdc25f223804f93479bbc09))
* **deep-extraction:** raise GLM-OCR timeout to 300s for slow CPU hosts ([0a27c2f](https://github.com/edjafarov/alpha-cent/commit/0a27c2f72f60ec395a5d878112cdb3a70dd36e86))
* **deep-extraction:** re-derive state on terminal-row requeue ([da9bcf8](https://github.com/edjafarov/alpha-cent/commit/da9bcf8720bec705afcb04eed750023465a0d546))
* **deep-extraction:** refresh the UI on scheduler settles ([52690b4](https://github.com/edjafarov/alpha-cent/commit/52690b424bff588a0cc99d5453f63678cbcb01e2))
* **deep-extraction:** route the Local processing settings screen ([b7bc618](https://github.com/edjafarov/alpha-cent/commit/b7bc618c85e47dcb00977703dc6d59bc6a2593b8))
* **deep-extraction:** split node-free model catalog for the renderer bundle ([b2dc233](https://github.com/edjafarov/alpha-cent/commit/b2dc2333b4edfcea08542a764c211fbff4c19634))
* **deep-extraction:** stamp single-model demand after readiness + guard standby ([dddb701](https://github.com/edjafarov/alpha-cent/commit/dddb701eb24cfd2bc404b0c076ef37b61af6c898))
* **deep-extraction:** token cache must not arm the 60s refresh loop ([6c898f9](https://github.com/edjafarov/alpha-cent/commit/6c898f9804e8fd65f4b9d9f8c2cdfb847889708f))
* **dev:** eval devtool blanked the renderer — CSP has no unsafe-eval ([a8ffce9](https://github.com/edjafarov/alpha-cent/commit/a8ffce95f165a4347ff11a96401519c2261e1e18))
* **imap:** address review — uidvalidity gone-check, stable synthetic id, backfill resume, timeouts ([5723f2c](https://github.com/edjafarov/alpha-cent/commit/5723f2c0bfe60ca2b2efe6ebbad89df454469535))
* **imap:** break the backfill mailbox-lock deadlock on multi-batch mailboxes ([ca29d41](https://github.com/edjafarov/alpha-cent/commit/ca29d4122ab32ad5345f711461001534dbb066f2))
* **imap:** stop backfill dropping the connection during long flushes ([ec8470b](https://github.com/edjafarov/alpha-cent/commit/ec8470b0d30b18b73bef79332e96ad6f17c8878c))
* **imap:** surface real server errors, sync INBOX not Archive, survive socket timeouts ([4b68dd4](https://github.com/edjafarov/alpha-cent/commit/4b68dd45d429f23477a8de09228b0ab61bfabf3a))
* **instagram:** drop redundant metadata.account_id (use account_id column, guide §5.1) ([b082b06](https://github.com/edjafarov/alpha-cent/commit/b082b065ac57ca31b3242bec603b6b9fa936599b))
* **instagram:** pass publishState to publishStateQuietly in import handler ([e1c27d4](https://github.com/edjafarov/alpha-cent/commit/e1c27d485f0557fe5224821b6f3df0fb3aed1e9b))
* **instagram:** retry Graph throttle codes, dedup paginated msg ids, align token threshold ([d37d42f](https://github.com/edjafarov/alpha-cent/commit/d37d42fb2747b5938d32035ee1016925fe7fe696))
* let the Add-source panel scroll when connector tiles overflow ([e46ee53](https://github.com/edjafarov/alpha-cent/commit/e46ee530c9ffa28c2aa0ac2284d47c24aad8ea86))
* **local-folder:** always apply default excludes at scan/watch time ([cee30ca](https://github.com/edjafarov/alpha-cent/commit/cee30caaec2e3f86cee50e1460740863ae9410f8)), closes [#29](https://github.com/edjafarov/alpha-cent/issues/29)
* **local-mode:** restore sign-in re-entry, onboarding wizard, true reset, and remove source auto-registration ([a7b2e89](https://github.com/edjafarov/alpha-cent/commit/a7b2e89596afab8deef6daaab8710dd914a7624d))
* **logs:** size-based rotation for app.log ([595bcff](https://github.com/edjafarov/alpha-cent/commit/595bcff819f502c7ba36d692cf4b66dd7b6c2984))
* **main:** publishState recursed into itself instead of broadcasting ([1b30204](https://github.com/edjafarov/alpha-cent/commit/1b30204821a44bf1bd5016fe58a873f510b175ef))
* **mcp:** bring SCHEMA_DOC up to date and make drift detection bidirectional ([9f677cc](https://github.com/edjafarov/alpha-cent/commit/9f677cc6252ea9d6840ae3be1105a0f757cdab86)), closes [#34](https://github.com/edjafarov/alpha-cent/issues/34)
* **mcp:** don't let a late get-status clobber a fresher pushed status ([bec2099](https://github.com/edjafarov/alpha-cent/commit/bec20996cd2b6d3ff1846c318b12dcf4d5eb69c1))
* **mcp:** evict idle MCP sessions to stop abandoned-client leak ([10c6a96](https://github.com/edjafarov/alpha-cent/commit/10c6a96693ccd4527bde6087728f1bd905f2fa24)), closes [#67](https://github.com/edjafarov/alpha-cent/issues/67)
* **notion:** advance delta cursor past trashed pages to avoid stall ([4f1e4a2](https://github.com/edjafarov/alpha-cent/commit/4f1e4a2bcad7db62a7d3d04ac4bb21688d48fab7))
* **notion:** persist epoch cursor for empty workspace so delta never stalls ([8bfc31f](https://github.com/edjafarov/alpha-cent/commit/8bfc31fb5e427996c5bff76e03274fc81cef5b1a))
* **notion:** scope deletion reconcile to its own workspace ([b4da211](https://github.com/edjafarov/alpha-cent/commit/b4da211c3a8b1993eef4009a98e9499e28208d23))
* **notion:** valid GFM tables + flatten container blocks ([cdbcddc](https://github.com/edjafarov/alpha-cent/commit/cdbcddcef5d8e9dba2ef43598b1a474e2a33302b))
* **notion:** wire per-account doc attribution into recompute-counts ([9d43aa2](https://github.com/edjafarov/alpha-cent/commit/9d43aa25c8e9d4e6917d693538173bde3afe6fae))
* **oauth:** dedupe interactive-OAuth capture and add CSRF state to Google flow ([72b62e4](https://github.com/edjafarov/alpha-cent/commit/72b62e4db2556015b47e66a6d16481a7b4614010)), closes [#39](https://github.com/edjafarov/alpha-cent/issues/39)
* **pickers:** guard stale mode-switch responses; pin clear behavior in tests ([9ffbc05](https://github.com/edjafarov/alpha-cent/commit/9ffbc0535195bb7577c62453f6721184d6b74286))
* **registration:** unify accounts.email_hash on one canonical algorithm ([ff68eda](https://github.com/edjafarov/alpha-cent/commit/ff68edaa3cce858f0a5645fa3289a5a4ab7472aa)), closes [#62](https://github.com/edjafarov/alpha-cent/issues/62)
* **remote-mcp:** open the db before the remote-MCP stack bootstraps ([4398a32](https://github.com/edjafarov/alpha-cent/commit/4398a32ccb0cbf0a5bf3d0f47948ef85878d98ed))
* **remote:** restore cert/hostname narrowing past the gate; update prefs/RegisterArgs fixtures ([bda9169](https://github.com/edjafarov/alpha-cent/commit/bda91690f3d3e0bd6c625cec0334838f8c80ee45))
* **remote:** wait for acme-challenge TXT to propagate before LE validation ([4f030d9](https://github.com/edjafarov/alpha-cent/commit/4f030d987cf6a371c88503044dccb8634d5bac0a))
* **scheduler:** don't persist status for deliberately stopped backfills; auth errors park needs_reauth ([#53](https://github.com/edjafarov/alpha-cent/issues/53)) ([57d2dc5](https://github.com/edjafarov/alpha-cent/commit/57d2dc542b6e002516ab13b426875acc7bb0ffa2))
* **security:** npm audit fix (safe, in-range only) ([51c6092](https://github.com/edjafarov/alpha-cent/commit/51c609242a51848d5e61806a7086358da5d83b0c))
* **security:** patch xlsx via official SheetJS CDN build (0.18.5 -> 0.20.3) ([062d6da](https://github.com/edjafarov/alpha-cent/commit/062d6da4ec9134ab69af2919cc7cabe1d6d1498f))
* **settings:** don't fabricate empty stats while Local processing loads ([a9a6e9e](https://github.com/edjafarov/alpha-cent/commit/a9a6e9ea4969fe52490b85a863efad7e86e86850))
* **slack:** clamp non-numeric Retry-After to avoid NaN busy-retry on 429 ([3ef11a8](https://github.com/edjafarov/alpha-cent/commit/3ef11a825c2c8583ed9c73a40057c9709245b035)), closes [#40](https://github.com/edjafarov/alpha-cent/issues/40)
* **slack:** dialog polish — clipboard guard, timer cleanup, primary CTA ([c70c6eb](https://github.com/edjafarov/alpha-cent/commit/c70c6eb18d33ba155496616ebb97082c2d80ba14))
* **slack:** show workspace name, not team_id, in account rows ([41d5f5b](https://github.com/edjafarov/alpha-cent/commit/41d5f5b5a7e04961ceca935275acf44b9c935b34))
* **slack:** stop mixing channel and document units in backfill UI ([01fbea8](https://github.com/edjafarov/alpha-cent/commit/01fbea87004b14bfdc488b8cc9c2627d3ad0bc94))
* **slack:** survive transient 5xx, checkpoint giant channels, log failures ([213a1ee](https://github.com/edjafarov/alpha-cent/commit/213a1ee3fa747d5f865b864a1177ebca138688e5)), closes [#spe-notifier-prod](https://github.com/edjafarov/alpha-cent/issues/spe-notifier-prod)
* **tsconfig:** restore node_modules exclusion to stop global-script leakage ([78ff7bf](https://github.com/edjafarov/alpha-cent/commit/78ff7bf7ad2c1cfe233dc0005752a1e9289be508))
* **tunnel:** cancel in-flight reconnect backoff on stop() ([d600883](https://github.com/edjafarov/alpha-cent/commit/d600883644906fa6979e86e958b8b113ad20c7e4)), closes [#11](https://github.com/edjafarov/alpha-cent/issues/11)
* **ui:** coherent extraction vocabulary across Storage and Local processing ([603dca4](https://github.com/edjafarov/alpha-cent/commit/603dca43152772b9a94957adbe92967f673fd5bb))
* **ui:** consistent status cards for remote connection states ([7310858](https://github.com/edjafarov/alpha-cent/commit/7310858ce53aa0af18876496ce14c0efeaac7749))
* **ui:** drop redundant Settings back-button, square scrollbar ([8343d57](https://github.com/edjafarov/alpha-cent/commit/8343d575913d267e8edfb9f762d1218359d70c05))
* **ui:** persistent topbar, scrollable account list, window min-size ([ce45a6c](https://github.com/edjafarov/alpha-cent/commit/ce45a6cc4f3f35710ae581b25966dffefd0547c7)), closes [#7c3aed](https://github.com/edjafarov/alpha-cent/issues/7c3aed)
* **ui:** repair tray About/Quit and add nav back-history ([13605fc](https://github.com/edjafarov/alpha-cent/commit/13605fcf3b2b07b009d0d13d47fccb8ce03cfef6))
* **ui:** surface local-processing errors and add MCP copy feedback ([53874b9](https://github.com/edjafarov/alpha-cent/commit/53874b935f234e12488e4903f90c47ba63d0ddb1)), closes [#c00](https://github.com/edjafarov/alpha-cent/issues/c00)
* **ui:** typecheck/test fixups after UI-coherence merges ([dacf0fe](https://github.com/edjafarov/alpha-cent/commit/dacf0fef890f3d9d43f01694483f6b8da2ea81d9))
* **ui:** unify folder-picker verbs/summaries and connect-dialog CTAs ([9bdb77a](https://github.com/edjafarov/alpha-cent/commit/9bdb77ad86dc8e13d7038e45646c5e093543adc1))
* **ui:** unify source status labels, pause toggle, and action pending states ([166eb20](https://github.com/edjafarov/alpha-cent/commit/166eb202553b3df9ad49c8d9aeb4a044d644d3d4))
* **updater:** stop pushing push:update-state twice per transition ([0798535](https://github.com/edjafarov/alpha-cent/commit/0798535d81344fe988306d5f7908087ff37280aa))
* **whatsapp:** attribute docs to the account (count, last-doc, purge) ([b77e0ee](https://github.com/edjafarov/alpha-cent/commit/b77e0eea2076e63650f5846622d53147eeaa4961))
* **whatsapp:** bundle qrcode into renderer so the pairing QR renders ([8bfee42](https://github.com/edjafarov/alpha-cent/commit/8bfee42607f56a6464271486316470499a399e1d))
* **whatsapp:** date media docs by message time; atomic cache write ([f2c4971](https://github.com/edjafarov/alpha-cent/commit/f2c49713f0eae69e54e68b8550535a2011f63ab8))
* **whatsapp:** disambiguate same-minute duplicate message ids; tidy parser ([b2042e1](https://github.com/edjafarov/alpha-cent/commit/b2042e12249bd671fd19dcbf0da88d8d36b177b2))
* **whatsapp:** exponential backoff + jitter on socket reconnect (reduce ban risk) ([6606465](https://github.com/edjafarov/alpha-cent/commit/66064654ed687ff1c7ffcde578ca5df6d1fb2c61))
* **whatsapp:** harden auth-state (atomic write, corrupt-blob preservation, encryption guard) ([326b540](https://github.com/edjafarov/alpha-cent/commit/326b540aaa4e63abdf1fcaf4c6cb2bbb4934a1dc))
* **whatsapp:** isolate import success broadcast so it can't mask a committed import ([3e1108b](https://github.com/edjafarov/alpha-cent/commit/3e1108b11a1439955900a092c795c34f1bb96d6a))
* **whatsapp:** make media sweep hash-wide to protect shared cache bytes ([4b1566f](https://github.com/edjafarov/alpha-cent/commit/4b1566f36eb1bcd16d5fa8a25e19bf5e93a4b245))
* **whatsapp:** retry transient FS errors in byte source (ENOENT stays terminal) ([d4a94cd](https://github.com/edjafarov/alpha-cent/commit/d4a94cd87635cb387f37846a1f40db7724d552e6))
* **whatsapp:** robust chat-name keying, dm/group inference, zip error handling ([6e8c923](https://github.com/edjafarov/alpha-cent/commit/6e8c923f903b3ae83748c07292adde9a0f17b9c1))
* **whatsapp:** single live socket + serialized ingest (prevent session corruption & message loss) ([1743323](https://github.com/edjafarov/alpha-cent/commit/174332354976621eacb031f2b2eca74147a60fbb))
* **whatsapp:** tear down abandoned pairings (cancel IPC + boot reaper) to stop orphaned reconnect loops ([e1a51eb](https://github.com/edjafarov/alpha-cent/commit/e1a51eb80bfade8d7429033a0f299dde0f380008))

### Performance Improvements

* **background:** back off ingest and extraction while the user interacts ([7628a1c](https://github.com/edjafarov/alpha-cent/commit/7628a1cde81c3834ff988f2b4097d231241293f2))
* **connectors:** replace sync fs I/O on the main process with async ([fd13990](https://github.com/edjafarov/alpha-cent/commit/fd1399088778f6386dfaf66b2b2719a7be8aba10))
* **db:** host SQLite in a worker thread behind an async bridge ([aa71d98](https://github.com/edjafarov/alpha-cent/commit/aa71d98720725ff4a222f025e7ca4957e8852c12))
* **deep-extraction:** demand-start/idle-stop llama-server ([606d8fb](https://github.com/edjafarov/alpha-cent/commit/606d8fb1d602fecf23051d9e583560566245a731))
* **deep-extraction:** disable llama-server prompt cache ([d175285](https://github.com/edjafarov/alpha-cent/commit/d175285bcdef2f3f7485c0ec0cf95b2e4c1cd112))
* **dev:** faster dev source maps + lazy-load qrcode chunk ([2844d61](https://github.com/edjafarov/alpha-cent/commit/2844d61889605802e1b5225de925a80462ced87c))
* **ingest:** yield to the event loop between upsert transactions ([dd6fd08](https://github.com/edjafarov/alpha-cent/commit/dd6fd085a52cc370f07634306a45fafc32c82282))
* **logs:** batch push:log broadcasts into 250ms windows ([a2dfd25](https://github.com/edjafarov/alpha-cent/commit/a2dfd257806fc82f2a69e3d1626e0d24545827e8))
* **main:** gate state snapshot on a cheap DB change stamp ([4bd9d69](https://github.com/edjafarov/alpha-cent/commit/4bd9d69198c528a60a619893b086ef20bedc334c))
* **renderer:** selector-based state store, memoized rows, stable log keys ([d2b63c1](https://github.com/edjafarov/alpha-cent/commit/d2b63c1e25e34c04a66e41af456206bd64813c6d))
* **renderer:** throttle storage:get-stats refetch to 10s windows ([b05e561](https://github.com/edjafarov/alpha-cent/commit/b05e56102510e1d54cc67e547614435749834316))
* **whatsapp:** incremental flush + background media + contact names ([d679306](https://github.com/edjafarov/alpha-cent/commit/d6793061ec4acace4e04e177b87e9b60c996d410))

All notable changes are recorded here. Entries are generated from
conventional commits by `npm run release` (see [`docs/releasing.md`](docs/releasing.md)).
