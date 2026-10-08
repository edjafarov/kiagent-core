# Background helpers yield to the user — design

**Status:** DRAFT rev 1 (2026-10-08) · **Issue:** #145 · **Related:** #146 (MCP read worker), #147 (converter off main + background-admission policy)

## 1. Problem

On weak machines the initial sync freezes the whole machine and MCP calls crawl. One cause is that every helper process core spawns runs at normal OS priority with tool defaults:

- `llama-server` (`providers/local-llm/server.ts` `launch()`): no `-t`/`-tb` → all cores; no `--poll` → idle workers spin (default 50); shared by interactive and background requests.
- `whisper-cli` (`providers/local-asr/whisper-cli.ts`): no `-t`; one job at a time (provider queue), used by the indexing route `transcribeFile` (audio worker, background) and by `hear` (meetings extension, user-facing).
- OCR helpers (`providers/apple-vision/vision-helper.ts`, `providers/windows-ocr/windows-ocr-helper.ts`) and `afconvert` (`workers/audio/transcode.ts`): only ever run for background-lane workers.
- Extension hosts (`platform/transport.ts` `utilityProcess.fork`): Drive/OneDrive/ms365 pulls, plus small interactive calls (send, consent).

And on a weak machine new users now auto-download the local model (three-card setup), so initial sync and local enrichment (vision/OCR/LLM/audio) run at the same time.

Founder ask: background sync runs "slower than someone actively working on the machine".

## 2. Goals / non-goals

**Goals**
- G1 Background helper processes leave CPU (and, on macOS, disk I/O) to the user.
- G2 The local model server never takes every core or spins idle.
- G3 On weak machines, local enrichment waits until initial sync is done.
- G4 Interactive paths (meeting transcription via `hear`, interactive local-model calls) keep today's priority.
- G5 Leave one seam each for "what kind of machine is this" and "launch a background child", so #146/#147 build on them instead of inventing their own.

**Non-goals** — read isolation (#146); converters off main, global admission, MCP-in-flight pause, commit sizing (#147); native addons (per-thread QoS, Windows background mode, memory-pressure notifications).

## 3. Design

### 3.1 `HostProfile` — one answer to "what machine is this" (new `src/main/core/host-profile.ts`)

```ts
export interface HostProfile {
  platform: NodeJS.Platform;
  cores: number;            // os.availableParallelism()
  totalMemBytes: number;    // os.totalmem()
  weak: boolean;            // cores <= 4 || totalMemBytes <= 8 GiB
  backgroundThreads: number;// max(1, floor(cores / 2))
}
export function readHostProfile(probes?: Partial<HostProfile>): HostProfile;
```

- Pure function over probes (tests inject). Computed once at boot, passed by deps — never re-read ad hoc.
- `weak` thresholds are named constants (`WEAK_MAX_CORES = 4`, `WEAK_MAX_MEM = 8 GiB`) with a one-line rationale. An env override `KIA_HOST_WEAK=1|0` exists for testing on a strong machine.
- Existing ad-hoc probes (`local-llm/capability.ts`, `backend.ts`, `local-asr/provider.ts`, `audio-worker.ts`) are **not** migrated in this change; a code comment at `readHostProfile` names them as the future consolidation. (Rail, not refactor.)

### 3.2 `childPriority` — one way to launch a background child (new `src/main/core/child-priority.ts`)

```ts
export type ChildClass = 'interactive' | 'background';
/** Wrap a spawn so a background child starts demoted. */
export function backgroundCommand(cmd: string, args: string[], platform = process.platform): { cmd: string; args: string[] };
/** Demote an already-running child (pid we don't spawn ourselves). Best effort, never throws. */
export function demote(pid: number | undefined, level: 'below-normal' | 'low'): void;
```

- **macOS, background child we spawn:** `backgroundCommand` returns `{ cmd: '/usr/sbin/taskpolicy', args: ['-b', cmd, ...args] }`. `taskpolicy` sets `PRIO_DARWIN_BG` then execs the command (same pid, so kill/abort/stdio behave as before): low CPU priority, I/O throttled like Spotlight/Time Machine, efficiency cores on Apple silicon. If `/usr/sbin/taskpolicy` is missing, fall back to the plain command + `demote(pid, 'low')` (nice 19).
- **Windows, background child we spawn:** plain command, then `demote(child.pid, 'low')` → `os.setPriority(pid, PRIORITY_LOW)` = `IDLE_PRIORITY_CLASS` (CPU only; inherited by its children).
- **Children we don't spawn directly** (Electron `utilityProcess`): `demote(child.pid, 'below-normal')` after the `spawn` event → nice 10 / `BELOW_NORMAL_PRIORITY_CLASS`. Below-normal, not low, because hosts also serve small interactive calls.
- Every demotion logs once per child kind at `debug` (`[priority] whisper-cli background via taskpolicy`) so a field log shows what ran demoted.
- `demote` swallows `EPERM`/`ESRCH` (process already exited) and logs at `debug`.

### 3.3 Apply it

| Child | Class | Change |
|---|---|---|
| OCR helpers (Apple Vision, Windows OCR) | background | spawn through `backgroundCommand` / `demote` |
| `afconvert` (audio transcode) | background | same |
| `whisper-cli` via `transcribeFile` (indexing) | background | same + `-t backgroundThreads` |
| `whisper-cli` via `hear` (meetings) | interactive | unchanged priority; `-t` stays default |
| extension hosts (`utilityProcess`) | below-normal | `demote(pid, 'below-normal')` on spawn |
| `llama-server` | shared | **no priority change**; add `-t backgroundThreads -tb backgroundThreads --poll 0` |

- `runWhisperCli` gains `{ priority?: ChildClass; threads?: number }`; the ASR provider's `runTranscribe` threads it through; `transcribeFile` passes `'background'`, `hear` passes nothing (today's behaviour). The provider still runs one whisper at a time.
- `llama-server` is one process serving both lanes, so process-wide demotion would slow interactive answers; the thread cap leaves half the cores to the user and `--poll 0` stops idle spinning. Slot count (`-np`, 4 today via the unified 24k cache) is unchanged; the context comment explains why it is sized for four.
- `--prio`/`--prio-batch` are not used (they raise or lower llama's own worker threads, and `-1` maps differently per OS); revisit with measurement.

### 3.4 Weak machines: enrichment waits for initial sync

`backgroundLaneState` (`core/boot.ts`) is the single function that decides whether background inference may run. It gains one condition, evaluated before the window check:

```ts
if (host.weak && syncing) return 'until-synced';
```

- `syncing` = any account whose status is `'connecting'` or `'backfilling'`. The 5 s lane tick in `main.ts` already awaits a store read; it reads `store.accounts()` once per tick and passes `syncing` in, so `backgroundLaneState` stays a pure function of (prefs, env, host, syncing, now).
- `LaneState` gains `'until-synced'` (`shared/contracts.ts`). Additive union member → `PLATFORM_API_VERSION` minor bump (2.7.0 → 2.8.0). Extensions that switch on `LaneState` must treat unknown values as closed (already the documented contract for `host.inference.lane()`; verify in implementation).
- Renderer copy (core `Settings/LocalProcessing.tsx` + overlay `LocalAi/local-ai-state.ts`): "Waits until your accounts finish syncing" / detail "On this computer, reading starts after the first sync so it doesn't slow you down."
- Effect: vision/OCR/audio/LLM extraction defer (existing `LaneClosedError` → `'defer'` path), and the local model is not loaded for background work during first sync on weak machines. Interactive calls are untouched.
- Not affected: pull/convert/commit (that is #147).

### 3.5 Measurement hook (seed for #147)

- On boot, log the profile once: `[host] cores=4 mem=8.0GB weak=true backgroundThreads=2`.
- No new telemetry pipeline. #147's "measure first" step adds event-loop delay and end-to-end timings next to this line.

## 4. Future rails (explicitly left for later)

- **One policy owner.** #147 replaces "lane boolean + per-worker `laneOpen()`" with a single admission policy. `backgroundLaneState` stays its pure core; `HostProfile` and `syncing` are already its inputs.
- **One child launcher.** Any future helper (converter worker process from #147, embeddings, new OCR) uses `backgroundCommand`/`demote` — no other `spawn` should hand-roll priority. A lint-free convention: a code comment at each spawn site points to `child-priority.ts`.
- **One host model.** Migrate the four ad-hoc `os.totalmem()` probes to `HostProfile` when next touched.
- **Native upgrade path.** If measurement shows threads/main process matter (#147), a native addon can implement `demote` for threads behind the same interface.

## 5. Testing

- `host-profile.test.ts`: thresholds (4 cores/16 GB → weak; 8 cores/8 GiB → weak; 8 cores/16 GB → not), `backgroundThreads` floor, env override.
- `child-priority.test.ts`: macOS wraps with taskpolicy; missing taskpolicy falls back; Windows returns plain command; `demote` swallows `ESRCH`/`EPERM`; `undefined` pid is a no-op.
- `whisper-cli` args: background job includes `-t N` and the wrapped command; `hear` job unchanged (existing arg-contract tests extended).
- `llama-server` args: `-t`, `-tb`, `--poll 0` present (extend `server.test.ts` args assertion).
- `backgroundLaneState`: weak+backfilling → `'until-synced'`; weak+all live → falls through to window; strong+backfilling → unchanged; `'disabled'`/`'battery'` precedence unchanged.
- Transport: `utilityProcessTransport` calls `demote(pid,'below-normal')` after spawn (mocked electron, existing test file).
- Live check (owed, manual): macOS — `ps -o pid,nice,command` and `taskpolicy -G -p <pid>` (or Activity Monitor "Kind"/QoS) show demoted helpers during an audio/OCR backfill; Windows VM — Task Manager priority column shows Low/Below normal; llama-server CPU stays ≤ half the cores during background extraction.

## 6. Risks

- `taskpolicy -b` I/O throttling can make OCR/transcode much slower while the user is busy — intended; they're background-lane work.
- Windows `IDLE_PRIORITY_CLASS` helpers can starve under sustained user load — acceptable for background work; they resume when the machine is idle.
- Thread cap slows interactive local-model answers on CPU-only hosts by up to ~2×; on Metal/Vulkan (`-ngl 999`) the effect is small. Measure on the Windows VM (CPU) before release.
- `'until-synced'` on a weak machine with a never-finishing account (stuck `backfilling`) would hold enrichment forever. Mitigation: `'error'`/`'paused'`/`'needsReauth'` don't count as syncing; a stuck backfill is a bug to see in the UI, which now says so.
