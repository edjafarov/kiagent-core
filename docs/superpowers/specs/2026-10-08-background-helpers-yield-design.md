# Background helpers yield to the user — design

**Status:** DRAFT rev 2 (2026-10-08) · **Issue:** #145 · **Related:** #146 (MCP read worker), #147 (converter off main + background-admission policy)

Rev 2 folds in fable + codex astra round 1: lane input read synchronously by every consumer; classify children by request lane, not API; foreground ASR must not wait behind a throttled background job; one host model (probes migrated, not promised); one launcher that owns wrapping + demotion + logging; whisper default is already 4 threads; CPU-only hosts count as weak; measurable acceptance; Windows prerequisites stated.

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
| `afconvert` (audio worker) | `background` |
| `whisper-cli` for `transcribeFile` | `background`, `-t min(4, backgroundThreads)` |
| `whisper-cli` for `hear` | by request lane; interactive keeps default threads |
| extension hosts | `host` |
| `llama-server` | `interactive` (shared process) + args below |

**llama-server args** (via the existing `extraArgs` seam): `-t N -tb N` with `N = backgroundThreads`, `--poll 0`, and `-np 4` pinned explicitly (the 24k/4-slot sizing comment is load-bearing and b9585 defaults `-np` to auto). `--poll 0` trades some per-op latency on CPU hosts for no busy-waiting — measured (§5). No process-wide demotion and no `--prio`, since interactive answers share the process.

**ASR FIFO — foreground never waits behind background.** The provider runs one whisper at a time (memory bound kept). Jobs carry their class. Queue order: interactive before background. When an interactive job is enqueued while a background job is running, the running background job is aborted (its existing `AbortController`); the audio worker sees an abort-classified error and returns `'defer'` (re-driven later from the start — files are re-transcribed, never half-committed). Test: background `transcribeFile` running + interactive `hear` arrives → hear starts within one process-kill, background job deferred, not failed.

**OCR deadlines.** A demoted OCR helper can exceed its 60/120 s deadline under user load. A deadline hit on a `background` request must classify as retryable (`'defer'`), not a terminal skip — verify the vision worker's handling and add a test.

### 3.4 Weak machines: enrichment waits for initial sync — one lane function

`backgroundLaneState(platform, now)` (`core/boot.ts`) stays the single lane decision and keeps its synchronous signature. It is called from the 5 s tick (`main.ts:~1335`), the initial push (`main.ts:~1050`), the extension `laneState` resolver (`main.ts:~1217`), and indirectly by workers via `backgroundLaneOpen` (`workers/index.ts`). All of them read the same in-memory inputs:

```ts
if (!p.enabled) return 'disabled';
if (env.onBattery) return 'battery';
if (hostBudget(platform.host, platform.llmAccel()).weak && platform.engine.syncing()) return 'until-synced';
// window check unchanged
```

- `engine.syncing(): boolean` — new, synchronous, from the engine's in-memory `running` handles: true when any account handle's `status` is `'connecting'` or `'backfilling'`. `'error'`, `'paused'`, `'needsReauth'`, `'live'` don't count, so a broken account cannot hold enrichment forever. No DB read.
- Precedence: `disabled` > `battery` > `until-synced` > window.
- Transitions: the 5 s tick already re-evaluates and pushes reason-only changes (`extension-platform.ts:~469` emits on reason change too); sync completion therefore reopens the lane within one tick. No new event wiring.
- `LaneState` gains `'until-synced'` (`shared/contracts.ts:~1693`). `PLATFORM_API_VERSION` 2.7.0 → 2.8.0 with the contract stated in the type's doc comment and the SDK docs: **only `'open'` permits background admission; any other value, including ones added later, means closed.**
- UI copy, both places that switch on `LaneState`:
  - core `renderer/screens/Settings/LocalProcessing.tsx` (`pausedLine`, which today maps unknown values to "waiting to be idle");
  - alpha-cent overlay `src/overlay/renderer/components/LocalAi/local-ai-state.ts` (companion change in the app repo, same release).
  - Copy: "Waits until your accounts finish syncing" / detail "On this computer, reading starts after the first sync so it doesn't slow you down."
- Effect: vision/OCR/audio/LLM extraction defer via the existing `LaneClosedError` → `'defer'` path; `gate()` throws before `ensureServer`, so the local model is not loaded for background work during first sync on weak machines. Interactive calls are untouched. Pull/convert/commit are untouched (#147).

## 4. Future rails

- **One policy owner (#147).** `backgroundLaneState` is the pure core of #147's admission policy; `host`, `llmAccel()`, `engine.syncing()` are already its inputs. #147 replaces the boolean plane switch + per-worker `laneOpen()` with one admission call and adds MCP-in-flight and user activity as inputs here — not in a second function.
- **One child launcher.** #147's converter process and any future helper use `child-priority.ts`. Thread-level demotion is out of scope; it would need a native addon and a different (thread-handle) API.
- **One host model.** `HostFacts` is the only place that reads `os` for hardware; `hostBudget` is where #146 sizes the read connection's cache and #147 sizes its admission limit.

## 5. Testing and acceptance

Unit:
- `host-profile.test.ts`: weak by cores, by memory, by CPU-only accel, null accel on win32/darwin; `backgroundThreads` floor; env override.
- `child-priority.test.ts`: macOS background wraps with taskpolicy; fallback when absent; Windows background → `setPriority(PRIORITY_LOW)`; host → below-normal; interactive untouched; errors swallowed; log-once.
- whisper: background args include `-t min(4,N)` and the wrapper; interactive `hear` unchanged; exit-66 stderr is not `AsrInputRejectedError`.
- ASR queue: interactive overtakes queued background; running background aborted → audio worker `'defer'`.
- llama-server args: `-t`, `-tb`, `--poll 0`, `-np 4`.
- Lane: weak+backfilling → `'until-synced'` from all three call sites and `backgroundLaneOpen`; sync completion reopens on next tick; `battery → until-synced` reason-only change emits `platform.lane`; precedence.
- Migrated probes: capability/backend/ASR/audio tests inject `HostFacts`.

Live (owed, measured, not guaranteed):
- macOS: during audio/OCR backfill `ps -o pid,pri,nice,command` shows taskpolicy'd helpers at PRI 4 and extension hosts at nice 10.
- Windows VM: Task Manager shows Low / Below normal.
- Weak profile (`KIA_HOST_WEAK=1`) during a Gmail + Drive initial sync: lane shows "Waits until your accounts finish syncing"; no llama-server process for background work; reopens after sync.
- Interactive local-model latency and foreground responsiveness before/after on the Windows VM (CPU) and a Mac; record CPU/RSS of llama-server under background extraction.
- A demoted OCR job under synthetic user load: deadline hits defer, then succeed when idle.

**Windows prerequisite:** `resolveLlamaBinary` (`providers/index.ts:~20`) resolves an accel-less `win32-<arch>` slug while vendoring uses accel-suffixed directories, and production has no Vulkan probe. The Windows live check needs a working llama-server launch first; if it is broken today, fix it as a separate prerequisite (out of scope here).

## 6. Risks

- Throttled background OCR/transcode/whisper get much slower while the user is busy — intended.
- Windows `IDLE_PRIORITY_CLASS` helpers can starve under sustained load; deadlines defer and retry.
- Thread cap may slow interactive local-model answers on CPU hosts; measured before release.
- Treating every non-Mac as weak delays enrichment on strong Windows machines until first sync completes — acceptable until a GPU probe ships.
