# Window-first boot and dormant extension hosts (#140, #137)

Status: APPROVED rev 5 (2026-10-09). Astra r4 and fable r4 SATISFIED.
and codex astra.
Issues: kiagent-core #140, #137. Tracking: #138. Base: core v0.106.0.

Two parts, each landed and tested on its own: A (#140) first, then B (#137).

## Part A: the window does not wait for utility-process extensions (#140)

### Problem (corrected)

`createWindow()` runs last in `whenReady` (`main.ts:1445`). Before it, three
steps run in order:

1. `startAfterInterruptedReset()`, which always ends with `await
   extensions.start()`. That is a `Promise.all` of every enabled
   extension's activation.
2. `resumeAccounts()`.
3. `scheduler.start()`.

`host.start()` settles once the host activates, or once its first handshake
retry is scheduled (`host-process.ts:436–443`). The worst case is therefore
one ready timeout (30 s) plus one activated timeout (30 s), run in parallel
across extensions. On a contended Windows machine that means a 30–60 s blank
screen before the window exists.

`query_sql` is no longer on main (#146), so it plays no part here.

### What first paint needs (from code)

- **IPC handlers and the initial `lastPush`.** This covers identity
  (SignIn vs shell), prefs and `ready: false`.
- **The extension snapshot.** The overlay's Sidebar and registry build nav
  from `state.extensions`. All four overlay bundled extensions contribute UI:
  - assistant;
  - documents;
  - meetings;
  - remote-mcp.
- **remote-mcp's IPC channels.** The overlay `SignIn` reads
  `auth:expected-account` / `auth:skip-allowed` once on mount. remote-mcp
  registers those channels during its own activation.

All four bundled extensions declare `unsafe.mainProcess`. They do **not**
fork, but they still go through the same supervisor and child runtime
(`extension-platform.ts`), and `host.start()` resolves as soon as a handshake
retry is *scheduled*. So awaiting their start does **not** guarantee that
remote-mcp's handlers exist. Marketplace connectors are utility processes,
and those are the slow ones that stall today.

### Design

#### A1. Boot order

The steps up to `registerIpc` and `engine.project(...)` are unchanged, except
that `ledgerCountsAll` and `identity.get()` now run in `Promise.all`. After
that:

1. **If an interrupted reset is journaled**, keep today's fully sequential
   path: reset dialog → reset → extensions → resume → scheduler → window.
   This is the rare path, and it keeps "nothing syncs before the reset
   finishes" trivially true.
2. **Otherwise:**
   1. `extensions.load()` runs discovery only: a synchronous fs scan, no
      spawn. It is wrapped in `inert`, exactly like today's
      `startExtensions` wrapper, so a discovery failure (for example the
      extension directory cannot be created) degrades to "no extensions"
      and the window still opens. It never reaches `handleBootFailure`.
      - Enabled entries get `status: 'activating'`, not `'disabled'`, so
        `ContributedUnavailable` shows the "starting" copy.
      - The `running` flag that gates `onWorkerRespawn` re-activation moves
        from `loadEntries` into `start()`.
   2. `extensions.startInProcess()` starts the enabled
      **`unsafe.mainProcess`** entries only, wrapped in `inert`. It waits
      until each entry reports **`activated`** (not merely `start()`
      resolving), bounded by `IN_PROCESS_READY_MS = 5_000` overall. Each
      activation logs its duration; on the bound it logs which entries are
      still pending and continues. The window is never held longer than
      5 s. Activation keeps going in the background, as today.
   3. **Renderer readiness, so the window never depends on that bound.** The
      overlay `SignIn` (alpha-cent) re-runs its one-shot initialisation of
      `auth:expected-account` / `auth:skip-allowed` when the `remote-mcp`
      entry in `state.extensions` transitions to `activated`. So a remote-mcp
      that activates after first paint (a handshake retry, or a slow
      machine) still fixes the initial state.

      SignIn **gates its init on the remote-mcp entry** in
      `state.extensions`:
      - no snapshot yet, or `activating` → `expected` stays `undefined`,
        the component's existing no-actions loading state. A returning
        device never sees the fresh two-provider state flash, and no invoke
        hits a channel with no handler registered;
      - `activated` → read both channels;
      - `errored`, `disabled` or absent → `null`, as today's catch path
        does.
   4. `app.on('activate', showMainWindow)` is registered here, no longer
      last.
   5. `await createWindow()`.
   6. `void startBackground()` (A2).

Boot failures before `createWindow` keep using `handleBootFailure`.

`startAfterInterruptedReset` splits along option (b):

- `finishInterruptedReset()` takes `loadExtensions` only, with no
  `startExtensions` dep.
- The caller orders extension start explicitly.

`factory-reset.test.ts` is updated so it asserts the reset completes before
the caller's next step.

#### A2. `startBackground()`: utility extensions, then resume per source

`src/main/core/boot-background.ts` is a pure function over injected deps, so
it can be unit-tested without Electron:

```
startBackground({ resumeReady, startUtilityExtensions, sources, accounts,
                  scheduler, onSourceRegistered, log, signal })
  1. resumeReady()                 // accounts whose source is registered now
                                   // (bundled + in-process) start
  2. scheduler.start()
  3. startUtilityExtensions()      // per extension, not awaited as a whole
  4. on each sources.onRegister(id): resume the boot-pending accounts of id
```

**Boot-pending.** An account is boot-pending only when its source id is
declared in `contributes.sources` by a loaded entry that is enabled and not
`errored` at load. `needs-consent` is only learned during activation, so an
entry that turns out to need consent keeps its queued ids. They drain when
consent is granted and the source registers. The only visible difference
from today: `sync-now` on such an account writes no `no source registered`
error.

Every other unregistered-source account keeps today's behaviour, including
the `no source registered` error log line (a log entry, not an account status).

**Queueing.** The queue holds **account ids** per source. When a source
registers:

1. Each id is re-read with `store.read.account(id)`.
2. Entries are filtered by intent (see "Explicit start actions" below).
3. The rest are dispatched once.
4. The queue entry for that source is then deleted.

Re-registrations after a crash rely on the cadence supervisor, as today.

**Explicit start actions: one run-or-queue path.** Every user-initiated
start goes through a single `runOrQueue(accountId, intent)`:

- `sync-now` (IPC and tray), which is the explicit Retry;
- Resume of a paused account.

If the account's source is registered, it calls `runAccount` exactly as
today. If the source is boot-pending, the account joins the queue as
`{id, intent}`, with no error status written.

On registration, a queued entry is re-read. Then:

- removed → dropped;
- `intent: 'auto'` (boot resume) → dropped if paused or `needsReauth`, as the
  cadence contract requires for automatic resume;
- `intent: 'explicit'` → today's sync-now/Resume semantics apply.
  `needsReauth` is allowed, as explicit Retry is today; Resume has already
  cleared `paused`.

An explicit entry upgrades an auto entry for the same id; it is never
downgraded.

**Release on failure.** A queue entry can be stranded if its extension never
registers the source. The chain watches the platform snapshot
(`deps.onChange`); `setStatus` emits no bus event. When an entry with queued
ids turns `errored`, or is disabled or uninstalled before registering, the
chain:

1. dispatches each queued id **once through today's path** (`runAccount`),
   which logs today's `no source registered` error (a log line on the Logs
   screen; the account row is unchanged, exactly as today). Explicit intents
   therefore get today's outcome, not silence;
2. deletes the queue entry.

**`signal`.** It aborts on quit (`before-quit`, before
`extensionsPlatform.stop()`) and on an interactive factory reset. That flow
calls `chain.stop()` first. After abort, nothing further is resumed or
started.

**Errors.** Every step is logged and never rejects unhandled.

`resumeAccounts` gains `onRegister` / `offRegister` on the source registry.
`resumeReady` is today's resume, restricted to registered sources.

#### A3. Boot timing

The `[boot] <step> +<ms>` lines are added at these points:

- `bootCore`;
- mcp;
- ipc;
- extensions loaded;
- in-process extensions active, with a per-extension ms;
- `createWindow` start;
- window shown;
- scheduler started;
- each utility extension activated;
- all settled.

These lines are the acceptance evidence.

### Testing (Part A)

- **`boot-background.test.ts`:**
  - order;
  - a late source resumes its queued accounts exactly once;
  - a removed or paused account is not resumed;
  - a slow or never-settling extension delays only its own accounts;
  - abort halts the chain;
  - a thrown step is logged.
- **`boot-tail.test.ts`:** a 20-line `bootTail(deps)` is extracted from
  `whenReady` and asserts:
  - the journal path stays sequential;
  - the normal path runs load → in-process start → window → background;
  - the window is created before any utility extension activation settles.
- **Source registry:** `onRegister` behaves as specified.
- **`sync-now`:** for a boot-pending account it writes no `error`.
- **Explicit actions before registration:**
  - a manual Retry on a `needsReauth` boot-pending account runs on
    registration;
  - Resume of a paused account before registration runs it on registration;
  - an auto entry for a `needsReauth` account is dropped.
- **In-process readiness:**
  - an in-process entry whose first handshake times out and whose retry
    succeeds: `startInProcess()` returns at the 5 s bound, and the entry
    reaches `activated` later;
  - overlay `SignIn` shows no actions while remote-mcp is `activating`,
    reads both channels on `activated`, and degrades to fresh on `errored`
    (overlay test).
- **Release on failure:** an entry that errors after load releases its
  queued accounts (auto and explicit) through `runAccount` (assert the
  dispatch and the log line, not an account status).
- **Discovery failure:** `load()` rejecting still opens the window with
  zero extensions, and `handleBootFailure` is not called.
- **Factory reset:** the tests are updated for the split.
- **Extension snapshot:** enabled entries show `'activating'` after `load()`.
- **Manual (recorded):** time-to-window on the Mac dev app and the Windows
  VM, before and after, with one connector delayed via
  `KIA_TEST_HANG_EXT=<id>` (honoured only when `!app.isPackaged`).

## Part B: dormant utility hosts (#137)

### Scope and expected saving

Bundled extensions are in-process and are never dormant. Marketplace
connectors' default cadences:

| Cadence | Connectors |
|---|---|
| 5 min | google-calendar |
| 15 min | agent-sessions, google-docs, instagram, ms365, onedrive |
| 30 min | hubspot, notion |

whatsapp, telegram and slack (socket mode) hold live pulls.

With `DORMANT_AFTER_MS = 5 min` and pulls of a few seconds:

- a 15-minute connector is dormant about 60% of the time;
- a 30-minute connector about 80%;
- 5-minute and live connectors never go dormant.

On the founder machine the expected steady-state saving is about 4–6
utility processes' RSS, not 13. The issue's "after boot, only persistent
extensions run" is restated as "15 minutes after boot".

This part is about RAM and process count. Start latency on wake is
acceptable (the founder said so, 2026-09-27).

### Design

#### B1. Eligibility is explicit, and observed again at runtime

- **Allowlist.** A utility extension may go dormant only if its id is in the
  product config's `dormantExtensions` list. That list is owned by the
  overlay's `product.json`. It is empty by default, so core alone changes
  nothing.
  - The overlay lists audited connectors only: no timers, sockets or file
    watchers outside pulls.
  - No manifest change is needed, but **core's product config schema
    changes**. `product.ts` is `z.object({...}).strict()`, and
    `loadProductConfig` falls back to defaults on any parse failure. An
    unknown key would therefore silently drop `productName`,
    `macUpdatesEnabled` and `bundledExtensionsDir`. So the change is:
    - core adds `dormantExtensions?: string[]` to the schema and to
      `ProductConfig`, and threads it into the extension platform deps;
    - core releases that;
    - alpha-cent adds the key to `product.json` **in the same commit** that
      pins that core, never before;
    - a core test confirms that a `product.json` with `dormantExtensions`
      parses and keeps its other keys.
- **Runtime pins.** Even an allowlisted host is **pinned**, sticky for that
  incarnation, if it uses any of:
  - `host.events.on`;
  - attention publish or ask;
  - a host fs watcher (`host-surfaces.ts` watch);
  - `unsafe.mainProcess`.

#### B2. In-flight tracking

Each host counts its in-flight operations:

- source verbs, with an **open pull session** counted from `open` until the
  stream ends, errors or aborts;
- tool calls;
- sender calls;
- connect and picker flows.

A live pull never ends, so its host never idles. A batch pull ends, and the
idle timer starts then.

#### B3. Host-level lazy endpoint (the core refactor)

- **Proxy lifetime.** The source proxy set, and the bindings for tools,
  senders and UI handlers, live for the **host**, not the incarnation.
  - They call through `host.ensureLive()` and then the current endpoint.
  - They no longer use a captured per-incarnation endpoint.
  - `createSourceProxySet` is constructed once per host and rebound to the
    new endpoint on each incarnation. Its stream table starts empty.
- **`ensureLive()`.**
  - When live, it returns immediately.
  - When dormant, it spawns through the normal activation path and resolves
    **only when the host reports `activated`** with its contributions
    installed. `start()` resolving is not enough, because it also resolves
    when a retry is merely scheduled.
  - Concurrent callers share one promise.
  - It is bounded at 60 s, then rejects with the existing `extension is not
    running` error.
  - Disable, uninstall, reset or quit cancel it.

#### B4. Soft stop, wake, hard stop

**Soft stop.** It applies to an eligible, unpinned host that has had nothing
in flight for `DORMANT_AFTER_MS`. The soft stop:

1. deactivates the child and kills it;
2. **keeps** the registered contributions and their disposer in memory;
3. sets the snapshot to `status: 'activated'`, `dormant: true`.

There is no ui-registry path. `ui.handle` is denied for the external tier,
and only non-bundled (external-tier) hosts can go dormant, so a dormant host
never owns a ui-registry entry.

**Wake.** The first call of any kind goes through `ensureLive()`. Once the
host is activated, its new `Contributions` payload, which includes all wire
capability flags, is deep-compared with the kept one.

- **Equal:** registration is skipped and only the endpoint is rebound. No
  duplicate tool, OAuth profile or refresher is registered, and no
  `extension.activated` event is emitted.
- **Different:** the kept disposer runs first, then the new set is
  registered and `extension.activated` is emitted, as on a real activation.

**Hard stop of a dormant host** (disable, uninstall, update, reset all,
consent revoke, quit). It runs the kept disposer and `unregisterCadence`,
emits `extension.deactivated`, and sets the status as today.

**Kill switch.** `KIA_DORMANT_HOSTS=0` disables dormancy.

### Testing (Part B)

**Unit tests:**

- the allowlist gate;
- each pin trigger;
- in-flight accounting, including a pull session open → end and a live pull
  that never idles;
- the idle timer;
- soft stop keeps `tools/list` identical;
- a wake from each call kind (source verb, tool, sender);
- concurrent wakes share one spawn;
- `ensureLive()` waits for `activated` across a handshake retry;
- the 60 s bound;
- cancellation on disable;
- equal contributions skip registration;
- different contributions re-register;
- hard stop of a dormant host;
- `product.json` with `dormantExtensions` parses and keeps its other keys.

**e2e test:** over the in-memory host pair with the real child runtime
(`runExtensionHost`):

1. activate;
2. go dormant (short timer);
3. a tool call wakes the host and returns the right result.

**Manual (recorded):** utility process count and RSS 15 minutes after boot,
before and after, on the founder Mac with the overlay allowlist set.

## Overlay impact

- **Part A** has one overlay follow-up: the `SignIn` shadow re-initialises on
  remote-mcp `activated`. It ships with the core bump.
- **Part A** touches `main.ts` and `factory-reset.ts`, neither near the
  `apply-overlay` anchors (`INVOKE_CHANNELS` import, handlers map, dispatch,
  `ipcMain.handle` loop). The plan re-verifies the anchors. `smoke-boot`
  polls activation beacons, and Part A does not delay those.
- **Part B** needs a follow-up alpha-cent change that adds `dormantExtensions`
  to `product.json` with the audited ids, in the same commit as the core pin
  that knows the key (see B1).
  - The dev app's `product.json` is **generated** by
    `build/dev-product.mjs` as a literal. That script must copy
    `dormantExtensions` from `product/product.json`. Otherwise the
    founder-Mac measurement runs with dormancy off.
- **Overlay anchor to re-verify:** `patchQuitSignals` anchors on
  `app.on('before-quit', (event) => {`. A2's abort goes inside that body,
  and the signature line stays untouched. The plan lists the audit for each
  connector: timers, sockets, watchers.
