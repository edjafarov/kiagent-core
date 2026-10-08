# Background helpers yield to the user — design

**Status:** IMPLEMENTED (local, not released) — APPROVED rev 6 (2026-10-08) — fable SATISFIED rev 4; codex astra round-5 item folded in · **Issue:** #145 · **Related:** #146 (MCP read worker), #147 (converter off main + background-admission policy)

Rev 2 folds in fable + codex astra round 1: lane input read synchronously by every consumer; classify children by request lane, not API; foreground ASR must not wait behind a throttled background job; one host model (probes migrated, not promised); one launcher that owns wrapping + demotion + logging; whisper default is already 4 threads; CPU-only hosts count as weak; measurable acceptance; Windows prerequisites stated.

Rev 3 (round 2): truthful initial-backfill signal (a durable per-account stamp, not the in-memory `connecting` status every run starts with); inference admission reads the live lane function instead of a cached boolean; PDF rasterization classified and its timeout deferred; `-np` left at auto (pinning it disables the unified KV cache); #147 rail made kind-aware.

Rev 4 (round 3): the durable stamp is dropped — progress JSON is replaced whole and a multi-root folder can report `live` for one root before backfilling the next, so a one-way stamp lies. The signal is now "this account's last *successfully committed* batch was a backfill batch", held in memory by the engine. `onLaneChange` is removed together with `setBackgroundOpen`; the tick is the single publisher.

Rev 5 (round 4): a closure that opens and closes entirely between two ticks no longer strands deferred work — the lane policy records a coalesced pending wake on every background refusal, and the tick wakes workers whenever the lane is open and a wake is pending.

Rev 6 (round 5): the pending wake lives in the policy function itself, so worker pre-flight refusals (`laneOpen()` in vision/audio, which never reach `gate()`) set it too.

## 1. Problem

On weak machines the initial sync freezes the whole machine and MCP calls crawl. One cause: every helper process core spawns runs at normal OS priority with tool defaults.

- `llama-server` (`providers/local-llm/server.ts` `launch()`, b9585): no `-t`/`-tb` → threads = all logical cores; `--poll` default 50 (busy-waits between ops); `-np` default auto. One process serves interactive and background requests.
- `whisper-cli` (b5130, `providers/local-asr/whisper-cli.ts`): default `-t 4`; one job at a time via the ASR provider FIFO (`providers/local-asr/provider.ts:~126`), shared by `transcribeFile` (audio worker, always background) and `hear` (inference route, lane given by caller — meetings use interactive).
- OCR helpers (`apple-vision/vision-helper.ts` 120 s deadline, `windows-ocr/windows-ocr-helper.ts` 60 s) serve the inference `read` route, whose lane is the caller's (vision worker = background; interactive callers exist). `afconvert` (`workers/audio/transcode.ts:193`) only runs for the audio worker (background).
- Extension hosts (`platform/transport.ts` `utilityProcess.fork`): pulls plus small interactive calls (send, consent). Meetings runs in the main process, so host demotion never touches capture.
- New users auto-download the local model (three-card setup), so on a weak machine initial sync and local enrichment run together.

Founder ask: background sync runs "slower than someone actively working on the machine".

## 2. Goals / non-goals

**Goals**
- G1 Background-lane helper processes leave CPU (and, on macOS, disk I/O) to the user.
- G2 `llama-server` never takes every core.
- G3 On weak machines (incl. CPU-only local model), local enrichment waits until initial sync is done.
- G4 Interactive requests (meeting `hear`, interactive `read`/`complete`) keep today's priority and do not wait behind throttled background work.
- G5 One host model, one child launcher, one lane-policy function — the seams #146/#147 build on.

**Non-goals** — read isolation (#146); converters off main, global admission, MCP-in-flight pause, commit sizing (#147); native addons (per-thread QoS, Windows background mode, memory-pressure notifications).

## 3. Design

### 3.1 One host model — `src/main/core/host-profile.ts`

```ts
export interface HostFacts {          // immutable raw facts, read once at boot
  platform: NodeJS.Platform;
  arch: string;
  cores: number;                      // os.availableParallelism() — LOGICAL cores
  totalMemBytes: number;
}
export function readHostFacts(probes?: Partial<HostFacts>): HostFacts;

export interface HostBudget {         // derived; pure
  weak: boolean;
  backgroundThreads: number;
}
export function hostBudget(f: HostFacts, llmAccel: 'metal' | 'vulkan' | 'cpu' | null): HostBudget;
```

- `weak = cores <= 4 || totalMemBytes <= 8 GiB || localModelOnCpu`, where `localModelOnCpu = llmAccel === 'cpu' || (llmAccel === null && platform !== 'darwin')`. Named constants `WEAK_MAX_CORES = 4`, `WEAK_MAX_MEM = 8 GiB`. Today production supplies no Vulkan probe (`backend.ts`), so every non-Mac counts as CPU-only, i.e. weak — intended until a GPU probe ships.
- `backgroundThreads = max(1, floor(cores / 2))`. `cores` is logical: on a 4c/8t laptop this is every physical core — accepted, measured (§5).
- `KIA_HOST_WEAK=1|0` overrides `weak` for testing.
- **Migration (in scope):** `local-llm/capability.ts readHostProbes`, `local-llm/backend.ts`, `local-asr/provider.ts` probes and `workers/audio/audio-worker.ts` `os.totalmem()` take `HostFacts` from deps instead of reading `os` themselves. `checkCapability` logic is unchanged (its `slow` flag stays a capability label, not the weak signal).
- `CorePlatform` carries `host: HostFacts`; the local-llm provider exposes `accel(): 'metal'|'vulkan'|'cpu'|null` (null until `detect()` ran).
- Boot logs once: `[host] cores=8 mem=16.0GB accel=cpu weak=true backgroundThreads=4`.

### 3.2 One child launcher — `src/main/core/child-priority.ts`

Callers state a class; the launcher owns wrapping, demotion, fallback and logging.

```ts
export type ChildClass = 'interactive' | 'background' | 'host';
export function spawnChild(cls: ChildClass, cmd: string, args: string[], opts: SpawnOptions): ChildProcess;
export function execFileChild(cls: ChildClass, cmd: string, args: string[], opts: ExecFileOptions, cb: ...): ChildProcess;
export function onUtilityProcessSpawned(child: { pid?: number }): void; // class 'host'
```

- `interactive`: plain spawn/execFile, unchanged.
- `background`, macOS: exec through `/usr/sbin/taskpolicy -b <cmd> …` — taskpolicy sets `PRIO_DARWIN_BG` and execs in place (same pid, verified), giving low CPU priority, throttled I/O, efficiency cores. If `/usr/sbin/taskpolicy` is absent: plain spawn + `os.setPriority(pid, 19)`.
- `background`, Windows: plain spawn + `os.setPriority(pid, PRIORITY_LOW)` → `IDLE_PRIORITY_CLASS` (CPU only, inherited by its children).
- `host` (utility processes, not spawned by us): `os.setPriority(pid, PRIORITY_BELOW_NORMAL)` on the `spawn` event — nice 10 / `BELOW_NORMAL_PRIORITY_CLASS`. Below-normal, not low, because hosts also serve small interactive calls.
- `os.setPriority` errors (`ESRCH`, `EPERM`) are swallowed. First use per (cmd basename, class) logs `info` once: `[priority] whisper-cli background via taskpolicy`.
- A missing binary under taskpolicy surfaces as exit 66 + `posix_spawn: No such file…`, not ENOENT. Callers that pre-check binaries (`binaryPresent`) keep doing so; the whisper stderr classifier must not treat that line as `AsrInputRejectedError` (test).
- Rule: no other spawn site hand-rolls priority; each spawn site comment points here.

### 3.3 Apply it — class follows the request lane

Providers already receive `lane` on `handle()` (`core/inference.ts` `read`/`hear`).

| Child | Class |
|---|---|
| OCR helper for a `read` request | `request.lane === 'background' ? 'background' : 'interactive'` |
| PDF rasterization helper on macOS (`workers/vision/rasterize.ts` `pickRasterizer`; other platforms rasterize in-process) | `background` |
| `afconvert` (audio worker) | `background` |
| `whisper-cli` for `transcribeFile` | `background`, `-t min(4, backgroundThreads)` |
| `whisper-cli` for `hear` | by request lane; interactive keeps default threads |
| extension hosts | `host` |
| `llama-server` | `interactive` (shared process) + args below |

**llama-server args** (via the existing `extraArgs` seam): `-t N -tb N` with `N = backgroundThreads`, and `--poll 0`. `-np` stays at auto: in b9585 an explicit `-np` turns off the unified KV cache (`--kv-unified` defaults on only with auto slots), which would split `-c 24576` into 4 × 6k and break the 8k interactive request the `contextSize` comment is sized for. A test asserts no `-np` is passed without `-kvu`. `--poll 0` trades some per-op latency on CPU hosts for no busy-waiting — measured (§5). No process-wide demotion and no `--prio`, since interactive answers share the process.

**ASR FIFO — foreground never waits behind background.** The provider runs one whisper at a time (memory bound kept). Jobs carry their class. Queue order: interactive before background. When an interactive job is enqueued while a background job is running, the running background job is aborted (its existing `AbortController`); the audio worker sees an abort-classified error and returns `'defer'` (re-driven later from the start — files are re-transcribed, never half-committed). Test: background `transcribeFile` running + interactive `hear` arrives → hear starts within one process-kill, background job deferred, not failed.

**Deadlines.** A demoted helper can exceed its 60/120 s deadline under user load. OCR `read` timeouts already defer (`vision-worker.ts:~265/325`). The first-pass PDF rasterization await (`vision-worker.ts:~309`) is not guarded: a timeout there must also return `'defer'` (not consume engine retries into terminal `failed`). Tests for both.

### 3.4 Weak machines: enrichment waits for initial sync — one lane function

`backgroundLaneState(platform, now)` (`core/boot.ts`) stays the single lane decision and keeps its synchronous signature. It is called from the 5 s tick (`main.ts:~1335`), the initial push (`main.ts:~1050`), the extension `laneState` resolver (`main.ts:~1217`), and indirectly by workers via `backgroundLaneOpen` (`workers/index.ts`). All of them read the same in-memory inputs:

```ts
if (!p.enabled) return 'disabled';
if (env.onBattery) return 'battery';
if (hostBudget(platform.host, platform.llmAccel()).weak && platform.engine.syncing()) return 'until-synced';
// window check unchanged
```

- **Truthful sync signal.** Every `engine.run()` starts its handle at `'connecting'` (resumed and cadence runs too), a quiet local-folder run can sit in its watcher without a batch, and in-memory `status` flips to `'live'` before the commit lands — so `status` alone cannot say "syncing". Instead each account loop keeps `backfillCommitted: boolean`, set **after** `store.commit` succeeds to `batch.phase === 'backfill'` (and left unchanged by a rejected commit). It starts `false` on every run. No persistence: a resumed backfill sets it again on its first committed batch; a multi-root folder that commits `live` for one root and then backfills the next flips back to `true`; a re-backfill after a scope change counts as syncing again (intended — it is heavy).
- `engine.syncing(): boolean` — new, synchronous, no DB read: true when any `running` entry keyed `account:*` (worker handles share the map and are excluded explicitly) is still active, has `backfillCommitted`, and its status is not `'error'`, `'paused'` or `'needsReauth'`. A broken or paused account therefore never holds enrichment.
- Accepted gap: between a run's start and its first committed backfill batch, enrichment may run — a new account has nothing to enrich yet.
- **Admission reads the live policy.** `InferencePlane.gate()` today reads a cached boolean (initially `true`) set only by the 5 s tick, so a background request just after sync starts could still load the model. The plane takes a late-bound `setLanePolicy(fn: () => boolean)` (the plane is built before `CorePlatform`; until set, background is closed) and `gate()` calls `fn()`; boot sets it to `() => backgroundLaneOpen(p)`. `setBackgroundOpen`, `onLaneChange`, its `laneSubs` and the `ExtensionPlatformDeps.onLaneChange` wiring are removed: the 5 s tick is the single publisher (`refreshLane()` → `platform.lane`, `processingStatus.tick()` → status + worker wake).
- **No stranded deferrals.** Today `processingStatus.tick` (`core/processing-status.ts:~128`) wakes workers only when two consecutive samples go closed → open; with direct admission a sync can start, defer documents and finish between ticks (or before the first one), and deferred OCR/audio would wait for their 30-min cadence. `backgroundLaneOpen(platform)` — the one function both `gate()` and the workers' `laneOpen()` pre-flight call — sets a coalesced `wakePending` flag whenever it answers `false`; `tick()` wakes workers when the lane is `open` and `wakePending` (or on the closed → open edge), then clears it. Still one publisher, no new timer. Tests: admission before the first tick and right after a sync starts.
- Precedence: `disabled` > `battery` > `until-synced` > window.
- Transitions: the 5 s tick already re-evaluates and pushes reason-only changes (`extension-platform.ts:~469` emits on reason change too); sync completion therefore reopens the lane within one tick. No new event wiring.
- `LaneState` gains `'until-synced'` (`shared/contracts.ts:~1693`). `PLATFORM_API_VERSION` 2.7.0 → 2.8.0 with the contract stated in the type's doc comment and the SDK docs: **only `'open'` permits background admission; any other value, including ones added later, means closed.**
- UI copy, both places that switch on `LaneState`:
  - core `renderer/screens/Settings/LocalProcessing.tsx` (`pausedLine`, which today maps unknown values to "waiting to be idle");
  - alpha-cent overlay `src/overlay/renderer/components/LocalAi/local-ai-state.ts` (companion change in the app repo, same release).
  - Copy: "Waits until your accounts finish syncing" / detail "On this computer, reading starts after the first sync so it doesn't slow you down."
- Effect: vision/OCR/audio/LLM extraction defer via the existing `LaneClosedError` → `'defer'` path; `gate()` throws before `ensureServer`, so the local model is not loaded for background work during first sync on weak machines. Interactive calls are untouched. Pull/convert/commit are untouched (#147).

## 4. Future rails

- **One policy owner (#147), kind-aware.** After this change there is one synchronous policy function that inference admission calls directly. #147 grows it into one owner that answers per work kind — `enrichment` (today's `LaneState`, kept as the enrichment-facing projection), and `ingest` (pull/convert/reconcile) — with its own rules: ingest is never closed by `until-synced` (that would deadlock first sync) nor by the idle/night window; user activity slows it, MCP-in-flight pauses admission. Inputs (`host`, `llmAccel()`, `engine.syncing()`, env) are shared; no second policy subsystem.
- **One child launcher.** #147's converter process and any future helper use `child-priority.ts`. Thread-level demotion is out of scope; it would need a native addon and a different (thread-handle) API.
- **One host model.** `HostFacts` is the only place that reads `os` for hardware; `hostBudget` is where #146 sizes the read connection's cache and #147 sizes its admission limit.

## 5. Testing and acceptance

Unit:
- `host-profile.test.ts`: weak by cores, by memory, by CPU-only accel, null accel on win32/darwin; `backgroundThreads` floor; env override.
- `child-priority.test.ts`: macOS background wraps with taskpolicy; fallback when absent; Windows background → `setPriority(PRIORITY_LOW)`; host → below-normal; interactive untouched; errors swallowed; log-once.
- whisper: background args include `-t min(4,N)` and the wrapper; interactive `hear` unchanged; exit-66 stderr is not `AsrInputRejectedError`.
- ASR queue: interactive overtakes queued background; running background aborted → audio worker `'defer'`.
- llama-server args: `-t`, `-tb`, `--poll 0`; no `-np` without `-kvu`.
- Wake: sync starts, defers documents and completes between two ticks → next tick wakes workers; same before the first tick; covered for a `gate()` refusal AND for vision/audio `laneOpen()` pre-flight refusals with no inference call.
- Sync signal: backfill batch committed → syncing; live batch committed → not; quiet local-folder restart → not; cadence run → not; multi-root resume (live root, then backfill root) → syncing again; rejected commit leaves the flag unchanged; delayed commit keeps the previous value until it resolves; paused/error account → not.
- Lane: weak+backfilling → `'until-synced'` from all three call sites, `backgroundLaneOpen`, and `gate()` before the first tick; sync completion reopens admission immediately and publication on the next tick; `battery → until-synced` reason-only change emits `platform.lane`; precedence.
- Migrated probes: capability/backend/ASR/audio tests inject `HostFacts`.

Live (owed, measured, not guaranteed):
- macOS: during audio/OCR backfill `ps -o pid,pri,nice,command` shows taskpolicy'd helpers at PRI 4 and extension hosts at nice 10.
- Windows VM: Task Manager shows Low / Below normal.
- Weak profile (`KIA_HOST_WEAK=1`) during a Gmail + Drive initial sync: lane shows "Waits until your accounts finish syncing"; no llama-server process for background work; reopens after sync.
- Interactive local-model latency and foreground responsiveness before/after on the Windows VM (CPU) and a Mac; record CPU/RSS of llama-server under background extraction.
- A demoted OCR job under synthetic user load: deadline hits defer, then succeed when idle.
- Background whisper during a meeting: deferred, not failed, and re-driven later.

**Windows prerequisite:** `resolveLlamaBinary` (`providers/index.ts:~20`) resolves an accel-less `win32-<arch>` slug while vendoring uses accel-suffixed directories, and production has no Vulkan probe. The Windows live check needs a working llama-server launch first; if it is broken today, fix it as a separate prerequisite (out of scope here).

## 6. Implementation notes

- `backfillCommitted` lives at run scope beside `let status` (`engine.ts:~966`), not inside the per-retry iteration (`progressDone`, `~1025`), and is assigned on the line after the awaited `store.commit`.
- Removing `onLaneChange`: also prune the dual-trigger comments in `extension-platform.ts` and the `contracts.ts:~1396` reference.

## 7. Risks

- Throttled background OCR/transcode/whisper get much slower while the user is busy — intended.
- Windows `IDLE_PRIORITY_CLASS` helpers can starve under sustained load; deadlines defer and retry.
- Thread cap may slow interactive local-model answers on CPU hosts; measured before release.
- Treating every non-Mac as weak delays enrichment on strong Windows machines until first sync completes — acceptable until a GPU probe ships.
