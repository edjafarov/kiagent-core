# Background Helpers Yield — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Background helper processes (OCR, PDF raster, afconvert, background whisper, extension hosts) run demoted, llama-server is thread-capped, and on weak hosts enrichment waits until first sync finishes — with one host model, one child launcher and one synchronous lane policy (#145).

**Architecture:** `core/host-profile.ts` owns hardware facts + derived budget. `core/child-priority.ts` is the only place a child is demoted (`taskpolicy -b` on macOS, `os.setPriority` elsewhere). `backgroundLaneState`/`backgroundLaneOpen` in `core/boot.ts` stay the single lane decision; they gain `until-synced` (weak host + `engine.syncing()`) and a coalesced pending-wake. The inference plane reads that policy directly (`setLanePolicy`), and the 5 s tick in `main.ts` becomes the only publisher.

**Tech Stack:** TypeScript, Electron main process, Node `child_process`/`os`, jest.

**Spec:** `docs/superpowers/specs/2026-10-08-background-helpers-yield-design.md` (APPROVED rev 6). Issue #145; follow-ups #146, #147.

**Plan rev 2** (fable + codex astra round 1): real fixture names; worker test stubs migrated; every `os` hardware read routed through `host-profile`; `HelperTimeoutError` lives in `workers/vision/rasterize.ts`; `launch` has two classes (`demoteHost` covers hosts, with log-once); OCR/raster tests pinned to a platform; SDK doc + boot-log fields; connected wake tests; typecheck before every commit; live acceptance before release (Task 10).

## Global Constraints

- Repo: kiagent-core worktree `~/work/kcore-yield`, branch `design/background-yield` (from v0.103.0 `cc78998f`). All paths below are relative to it.
- Worktree setup (once, before Task 1): `ln -sfn ~/work/kcore-setup3/node_modules node_modules && ln -sfn ~/work/kcore-setup3/release/app/node_modules release/app/node_modules`. Both are gitignored; unlink them before any `git worktree remove`.
- Run jest as `npx jest <paths>`; typecheck `npx tsc -p tsconfig.typecheck.json`; lint `npx eslint <files>`. One heavy command at a time — never run builds/tests in parallel.
- **Every task's Step 4 ends with `npx tsc -p tsconfig.typecheck.json` clean before its commit.** Each task must leave the tree typechecking.
- Tests that exercise `launch('background', …)` must inject `platform`/`exists` (or `taskpolicyExists`) — never depend on the machine running jest.
- Task order: 1 → 2 → 3 (uses 1, 2) → 4 (uses 3) → 5 (uses 1, 3) → 6 (uses 1, 2) → 7 (uses 2, 3) → 8 (uses 2, 3) → 9 → 10.
- Commits: `git commit -F <msgfile> -- <paths>`; message ends WITHOUT any Co-Authored-By line. Never `git stash`, `--amend`, rebase, reset, or `--no-verify`.
- Copy (verbatim): core `pausedLine('until-synced')` = `Paused — waits until your accounts finish syncing.`; overlay title `Waits until your accounts finish syncing`, detail `On this computer, reading starts after the first sync so it doesn't slow you down.`
- Constants (verbatim): `WEAK_MAX_CORES = 4`, `WEAK_MAX_MEM_BYTES = 8 * 1024 ** 3`, `backgroundThreads = Math.max(1, Math.floor(cores / 2))`, whisper background threads `Math.min(4, backgroundThreads)`, `TASKPOLICY = '/usr/sbin/taskpolicy'`, `PLATFORM_API_VERSION = '2.8.0'`.
- llama-server: add `-t N -tb N --poll 0`; NEVER pass `-np` (an explicit `-np` disables the unified KV cache in b9585).
- Log levels are only `'info' | 'warn' | 'error'`.

## Review Focus

1. A weak Mac in first sync: the local model must not load for background work, and once every account commits its last backfill batch, deferred OCR/audio wake on the next tick, not 30 min later.
2. A meeting `hear` while a background `transcribeFile` runs: the meeting starts after one process kill; the background job defers, never fails.
3. A demoted PDF raster helper timing out under user load: the doc defers, it does not burn engine retries into `failed`.
4. Missing `/usr/sbin/taskpolicy` or a child that exits before demotion: the spawn still works (fallback / swallowed `ESRCH`).
5. Interactive calls (assistant, MCP-driven `complete`, interactive `read`) are never refused by the new `until-synced` state or by the plane's policy binding.

---

### Task 1: Host model — `core/host-profile.ts`

**Files:**
- Create: `src/main/core/host-profile.ts`
- Test: `src/main/core/__tests__/host-profile.test.ts`
- Modify: `src/main/providers/local-llm/backend.ts` (reuse the accel type)

**Interfaces:**
- Produces: `LlmAccel`, `HostFacts`, `HostBudget`, `readHostFacts(probes?)`, `hostBudget(facts, accel, env?)`, `describeHost(facts)`, `WEAK_MAX_CORES`, `WEAK_MAX_MEM_BYTES`.

- [ ] **Step 1: Write the failing test** — `src/main/core/__tests__/host-profile.test.ts`

```ts
import {
  describeHost,
  hostBudget,
  readHostFacts,
  WEAK_MAX_MEM_BYTES,
  type HostFacts,
} from '../host-profile';

const GiB = 1024 ** 3;
const mac = (o: Partial<HostFacts> = {}): HostFacts => ({
  platform: 'darwin',
  arch: 'arm64',
  cores: 8,
  totalMemBytes: 16 * GiB,
  ...o,
});

describe('hostBudget', () => {
  it('a strong Mac on Metal is not weak', () => {
    expect(hostBudget(mac(), 'metal', {})).toEqual({
      weak: false,
      backgroundThreads: 4,
    });
  });
  it('4 logical cores is weak', () => {
    expect(hostBudget(mac({ cores: 4 }), 'metal', {}).weak).toBe(true);
  });
  it('exactly 8 GiB is weak', () => {
    expect(
      hostBudget(mac({ totalMemBytes: WEAK_MAX_MEM_BYTES }), 'metal', {}).weak,
    ).toBe(true);
  });
  it('a local model on CPU is weak', () => {
    expect(hostBudget(mac({ platform: 'win32' }), 'cpu', {}).weak).toBe(true);
  });
  it('unknown accel off darwin counts as CPU (no GPU probe yet)', () => {
    expect(hostBudget(mac({ platform: 'win32' }), null, {}).weak).toBe(true);
  });
  it('unknown accel on darwin is Metal', () => {
    expect(hostBudget(mac(), null, {}).weak).toBe(false);
  });
  it('vulkan off darwin with enough cores/RAM is not weak', () => {
    expect(hostBudget(mac({ platform: 'win32' }), 'vulkan', {}).weak).toBe(
      false,
    );
  });
  it('backgroundThreads floors at 1', () => {
    expect(hostBudget(mac({ cores: 1 }), 'metal', {}).backgroundThreads).toBe(
      1,
    );
  });
  it('KIA_HOST_WEAK overrides both ways', () => {
    expect(hostBudget(mac(), 'metal', { KIA_HOST_WEAK: '1' }).weak).toBe(true);
    expect(
      hostBudget(mac({ cores: 2 }), 'cpu', { KIA_HOST_WEAK: '0' }).weak,
    ).toBe(false);
  });
});

describe('readHostFacts', () => {
  it('takes injected probes verbatim', () => {
    expect(
      readHostFacts({ platform: 'linux', arch: 'x64', cores: 2, totalMemBytes: 1 }),
    ).toEqual({ platform: 'linux', arch: 'x64', cores: 2, totalMemBytes: 1 });
  });
  it('fills missing probes from the live host', () => {
    const f = readHostFacts();
    expect(f.cores).toBeGreaterThan(0);
    expect(f.totalMemBytes).toBeGreaterThan(0);
  });
});

it('describeHost renders one boot log line with the budget', () => {
  expect(describeHost(mac(), null, {})).toBe(
    'cores=8 mem=16.0GB platform=darwin-arm64 accel=unknown weak=false backgroundThreads=4',
  );
  expect(describeHost(mac({ platform: 'win32' }), 'cpu', {})).toContain(
    'accel=cpu weak=true',
  );
});
```

- [ ] **Step 2: Run it — expect FAIL** (`Cannot find module '../host-profile'`)

Run: `npx jest src/main/core/__tests__/host-profile.test.ts`

- [ ] **Step 3: Implement** — `src/main/core/host-profile.ts`

```ts
import os from 'node:os';

/** Acceleration backend of the local model server. */
export type LlmAccel = 'metal' | 'vulkan' | 'cpu';

/** Immutable hardware facts, read once at boot. The ONLY place core reads
 *  `os` for hardware; providers and workers receive these via deps. */
export interface HostFacts {
  platform: NodeJS.Platform;
  arch: string;
  /** LOGICAL cores (os.availableParallelism). */
  cores: number;
  totalMemBytes: number;
}

/** Derived, pure. #146 sizes its read connection and #147 its admission
 *  limit from here — not from their own `os` reads. */
export interface HostBudget {
  weak: boolean;
  backgroundThreads: number;
}

export const WEAK_MAX_CORES = 4;
/** 8 GiB and below: a resident local model plus first-sync parsing swaps. */
export const WEAK_MAX_MEM_BYTES = 8 * 1024 ** 3;

export function readHostFacts(probes: Partial<HostFacts> = {}): HostFacts {
  const cores =
    probes.cores ??
    (typeof os.availableParallelism === 'function'
      ? os.availableParallelism()
      : os.cpus().length);
  return {
    platform: probes.platform ?? process.platform,
    arch: probes.arch ?? process.arch,
    cores,
    totalMemBytes: probes.totalMemBytes ?? os.totalmem(),
  };
}

/** `accel` null = not detected yet: Metal on darwin, CPU elsewhere (there is
 *  no production Vulkan probe yet, so every non-Mac is weak until one ships).
 *  `KIA_HOST_WEAK=1|0` overrides `weak` for testing. */
export function hostBudget(
  f: HostFacts,
  accel: LlmAccel | null,
  env: NodeJS.ProcessEnv = process.env,
): HostBudget {
  const onCpu = accel === 'cpu' || (accel === null && f.platform !== 'darwin');
  let weak =
    f.cores <= WEAK_MAX_CORES || f.totalMemBytes <= WEAK_MAX_MEM_BYTES || onCpu;
  if (env.KIA_HOST_WEAK === '1') weak = true;
  else if (env.KIA_HOST_WEAK === '0') weak = false;
  return { weak, backgroundThreads: Math.max(1, Math.floor(f.cores / 2)) };
}

/** One boot log line. At boot `accel` is unknown (detected lazily). */
export function describeHost(
  f: HostFacts,
  accel: LlmAccel | null,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const gb = (f.totalMemBytes / 1024 ** 3).toFixed(1);
  const b = hostBudget(f, accel, env);
  return `cores=${f.cores} mem=${gb}GB platform=${f.platform}-${f.arch} accel=${accel ?? 'unknown'} weak=${b.weak} backgroundThreads=${b.backgroundThreads}`;
}
```

In `src/main/providers/local-llm/backend.ts` replace `export type Accel = 'metal' | 'vulkan' | 'cpu';` (keep its doc comment) with:

```ts
export type { LlmAccel as Accel } from '../../core/host-profile';
```

and add `import type { LlmAccel as Accel } from '../../core/host-profile';` at the top if `Accel` is used inside the file (it is, in `BackendInfo`).

- [ ] **Step 4: Run — expect PASS**

Run: `npx jest src/main/core/__tests__/host-profile.test.ts src/main/providers/local-llm`

- [ ] **Step 5: Commit**

```bash
printf 'feat(core): host model — HostFacts + hostBudget (#145)\n' > /tmp/msg-t1
git add src/main/core/host-profile.ts src/main/core/__tests__/host-profile.test.ts
git commit -F /tmp/msg-t1 -- src/main/core/host-profile.ts src/main/core/__tests__/host-profile.test.ts src/main/providers/local-llm/backend.ts
```

---

### Task 2: One child launcher — `core/child-priority.ts`

**Files:**
- Create: `src/main/core/child-priority.ts`
- Test: `src/main/core/__tests__/child-priority.test.ts`

**Interfaces:**
- Produces: `ChildClass = 'interactive' | 'background'`, `TASKPOLICY`, `launch(cls, cmd, args, start, deps?)`, `demoteHost(pid, deps?)`, `setChildPriorityLog(fn)`, `__resetChildPriorityLog()` (test-only). (Spec §3.2's `host` class is `demoteHost` — utility processes are never started through `launch`.)

- [ ] **Step 1: Write the failing test** — `src/main/core/__tests__/child-priority.test.ts`

```ts
import os from 'node:os';

import {
  __resetChildPriorityLog,
  demoteHost,
  launch,
  setChildPriorityLog,
  TASKPOLICY,
} from '../child-priority';

const LOW = os.constants.priority.PRIORITY_LOW;
const BELOW = os.constants.priority.PRIORITY_BELOW_NORMAL;

function harness(platform: NodeJS.Platform, hasTaskpolicy = true) {
  const started: Array<{ cmd: string; args: string[] }> = [];
  const setPriority = jest.fn();
  const start = (cmd: string, args: string[]) => {
    started.push({ cmd, args });
    return { pid: 4242 };
  };
  const deps = { platform, exists: () => hasTaskpolicy, setPriority };
  return { started, setPriority, start, deps };
}

beforeEach(() => __resetChildPriorityLog());

it('interactive runs the command untouched', () => {
  const h = harness('darwin');
  launch('interactive', '/bin/x', ['-a'], h.start, h.deps);
  expect(h.started).toEqual([{ cmd: '/bin/x', args: ['-a'] }]);
  expect(h.setPriority).not.toHaveBeenCalled();
});

it('background on macOS execs through taskpolicy -b (same pid, no setPriority)', () => {
  const h = harness('darwin');
  const child = launch('background', '/bin/x', ['-a'], h.start, h.deps);
  expect(h.started).toEqual([{ cmd: TASKPOLICY, args: ['-b', '/bin/x', '-a'] }]);
  expect(child.pid).toBe(4242);
  expect(h.setPriority).not.toHaveBeenCalled();
});

it('background on macOS without taskpolicy falls back to PRIORITY_LOW', () => {
  const h = harness('darwin', false);
  launch('background', '/bin/x', [], h.start, h.deps);
  expect(h.started[0].cmd).toBe('/bin/x');
  expect(h.setPriority).toHaveBeenCalledWith(4242, LOW);
});

it('background on Windows sets PRIORITY_LOW after spawn', () => {
  const h = harness('win32');
  launch('background', 'C:\\x.exe', [], h.start, h.deps);
  expect(h.started[0].cmd).toBe('C:\\x.exe');
  expect(h.setPriority).toHaveBeenCalledWith(4242, LOW);
});

it('a start returning no pid (void execFile fake) is a no-op demotion', () => {
  const setPriority = jest.fn();
  launch('background', '/bin/x', [], () => undefined, {
    platform: 'win32',
    setPriority,
  });
  expect(setPriority).not.toHaveBeenCalled();
});

it('setPriority errors (child already exited) are swallowed', () => {
  const setPriority = jest.fn(() => {
    throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
  });
  expect(() =>
    launch('background', '/bin/x', [], () => ({ pid: 1 }), {
      platform: 'win32',
      setPriority,
    }),
  ).not.toThrow();
});

it('demoteHost sets below-normal, tolerates undefined pid, logs once', () => {
  const lines: string[] = [];
  setChildPriorityLog((m) => lines.push(m));
  const setPriority = jest.fn();
  demoteHost(undefined, { setPriority });
  demoteHost(7, { setPriority });
  demoteHost(8, { setPriority });
  expect(setPriority).toHaveBeenCalledTimes(2);
  expect(setPriority).toHaveBeenCalledWith(7, BELOW);
  expect(lines).toEqual(['[priority] extension-host below-normal via setPriority']);
});

it('logs once per (binary, class)', () => {
  const lines: string[] = [];
  setChildPriorityLog((m) => lines.push(m));
  const h = harness('darwin');
  launch('background', '/a/whisper-cli', [], h.start, h.deps);
  launch('background', '/b/whisper-cli', [], h.start, h.deps);
  launch('interactive', '/a/whisper-cli', [], h.start, h.deps);
  expect(lines).toEqual(['[priority] whisper-cli background via taskpolicy']);
});
```

- [ ] **Step 2: Run — expect FAIL** (module missing)

Run: `npx jest src/main/core/__tests__/child-priority.test.ts`

- [ ] **Step 3: Implement** — `src/main/core/child-priority.ts`

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Who a child works for. `background` = background-lane work (yields CPU and,
 *  on macOS, disk I/O to the user); `interactive` = untouched. Extension hosts
 *  (Electron utility processes we don't spawn) go through `demoteHost`.
 *  EVERY spawn site that runs background work goes through `launch` — no
 *  other code hand-rolls priority. Thread-level demotion is out of scope
 *  (it needs a native addon and a thread-handle API). */
export type ChildClass = 'interactive' | 'background';

export const TASKPOLICY = '/usr/sbin/taskpolicy';

export interface PriorityDeps {
  platform?: NodeJS.Platform;
  exists?: (p: string) => boolean;
  setPriority?: (pid: number, priority: number) => void;
}

let sink: ((msg: string) => void) | null = null;
const logged = new Set<string>();

/** Boot wires this to the log sink ('info'). */
export function setChildPriorityLog(fn: (msg: string) => void): void {
  sink = fn;
}

/** Test-only. */
export function __resetChildPriorityLog(): void {
  sink = null;
  logged.clear();
}

function note(name: string, cls: string, how: string): void {
  const key = `${name}|${cls}`;
  if (logged.has(key)) return;
  logged.add(key);
  sink?.(`[priority] ${name} ${cls} via ${how}`);
}

function demote(
  pid: number | undefined,
  priority: number,
  deps: PriorityDeps,
): void {
  if (pid === undefined) return;
  try {
    (deps.setPriority ?? os.setPriority)(pid, priority);
  } catch {
    // ESRCH (already exited) / EPERM: demotion is best effort.
  }
}

/** Start a child in its class. `start` does the real spawn/execFile (so test
 *  fakes and each site's own options keep working); `launch` owns wrapping,
 *  demotion, fallback and logging. macOS background children exec through
 *  `taskpolicy -b`, which sets PRIO_DARWIN_BG then execs in place — same pid,
 *  so kill/abort/stdio behave as before. */
export function launch<C extends { pid?: number } | void>(
  cls: ChildClass,
  cmd: string,
  args: string[],
  start: (cmd: string, args: string[]) => C,
  deps: PriorityDeps = {},
): C {
  const platform = deps.platform ?? process.platform;
  if (cls === 'interactive') return start(cmd, args);
  const name = path.basename(cmd);
  if (platform === 'darwin' && (deps.exists ?? fs.existsSync)(TASKPOLICY)) {
    note(name, cls, 'taskpolicy');
    return start(TASKPOLICY, ['-b', cmd, ...args]);
  }
  const child = start(cmd, args);
  note(name, cls, 'setPriority');
  demote(
    (child as { pid?: number } | undefined)?.pid,
    os.constants.priority.PRIORITY_LOW,
    deps,
  );
  return child;
}

/** Extension hosts are Electron utility processes we don't spawn ourselves:
 *  demote on their 'spawn' event. */
export function demoteHost(pid: number | undefined, deps: PriorityDeps = {}): void {
  if (pid === undefined) return;
  note('extension-host', 'below-normal', 'setPriority');
  demote(pid, os.constants.priority.PRIORITY_BELOW_NORMAL, deps);
}
```


- [ ] **Step 4: Run — expect PASS**

Run: `npx jest src/main/core/__tests__/child-priority.test.ts`

- [ ] **Step 5: Commit**

```bash
printf 'feat(core): one child launcher with background/host priority (#145)\n' > /tmp/msg-t2
git add src/main/core/child-priority.ts src/main/core/__tests__/child-priority.test.ts
git commit -F /tmp/msg-t2 -- src/main/core/child-priority.ts src/main/core/__tests__/child-priority.test.ts
```

---

### Task 3: Lane policy — `until-synced`, `engine.syncing()`, pending wake

**Files:**
- Modify: `src/shared/contracts.ts` (`LaneState` ~1693)
- Modify: `src/shared/extension-rpc.ts:29` (`PLATFORM_API_VERSION`)
- Modify: `src/main/core/engine/engine.ts` (running map type ~510, `run()` ~966 and ~1099-1117, handle ~1229, return-type intersection ~400, engine object)
- Modify: `src/main/core/boot.ts` (`CorePlatform`, `bootCore`, `backgroundLaneState`, `backgroundLaneOpen`, new `takeLaneWake`)
- Modify: `docs/architecture/extension-platform.md:82` (the `inference` row: lane contract)
- Test: `src/main/core/__tests__/boot-lane.test.ts`, `src/main/core/engine/__tests__/engine.test.ts`, `src/main/workers/__tests__/redrive.test.ts`, `src/main/workers/__tests__/attach-bundled-workers.test.ts`

**Interfaces:**
- Consumes: Task 1 `HostFacts`, `LlmAccel`, `hostBudget`, `readHostFacts`, `describeHost`; Task 2 `setChildPriorityLog`.
- Produces: `LaneState | 'until-synced'`; `engine.syncing(): boolean`; `CorePlatform.host: HostFacts`; `CorePlatform.llmAccel: () => LlmAccel | null` (assignable; main.ts binds it in Task 5); `takeLaneWake(platform): boolean`.

- [ ] **Step 1: Failing tests**

Replace the fixture in `src/main/core/__tests__/boot-lane.test.ts` and add cases:

```ts
import { backgroundLaneOpen, backgroundLaneState, takeLaneWake } from '../boot';
import type { CorePlatform } from '../boot';

const GiB = 1024 ** 3;

function platform(over: {
  enabled?: boolean;
  window?: 'always' | 'idle' | 'night';
  onBattery?: boolean;
  userActive?: boolean;
  weak?: boolean;
  syncing?: boolean;
}): CorePlatform {
  return {
    prefs: {
      get: () => ({
        processing: {
          enabled: over.enabled ?? true,
          window: over.window ?? 'always',
        },
      }),
    },
    scheduler: {
      env: {
        onBattery: over.onBattery ?? false,
        thermal: 'nominal',
        appFocus: 'focused',
        userActive: over.userActive ?? false,
      },
    },
    host: over.weak
      ? { platform: 'darwin', arch: 'arm64', cores: 4, totalMemBytes: 8 * GiB }
      : { platform: 'darwin', arch: 'arm64', cores: 8, totalMemBytes: 16 * GiB },
    llmAccel: () => 'metal',
    engine: { syncing: () => over.syncing ?? false },
  } as unknown as CorePlatform;
}
```

Keep the existing `it.each` rows unchanged and append rows:

```ts
  ['weak + syncing waits for sync', { weak: true, syncing: true }, NOON, 'until-synced'],
  ['weak, sync done → window decides', { weak: true, syncing: false }, NOON, 'open'],
  ['strong + syncing is unaffected', { syncing: true }, NOON, 'open'],
  ['battery beats until-synced', { weak: true, syncing: true, onBattery: true }, NOON, 'battery'],
  ['disabled beats until-synced', { weak: true, syncing: true, enabled: false }, NOON, 'disabled'],
  [
    'until-synced beats the idle window',
    { weak: true, syncing: true, window: 'idle' as const, userActive: true },
    NOON,
    'until-synced',
  ],
```

Add after the table:

```ts
describe('pending wake', () => {
  it('a refusal leaves one pending wake; taking it clears it', () => {
    const p = platform({ weak: true, syncing: true });
    expect(takeLaneWake(p)).toBe(false);
    expect(backgroundLaneOpen(p)).toBe(false);
    expect(backgroundLaneOpen(p)).toBe(false);
    expect(takeLaneWake(p)).toBe(true);
    expect(takeLaneWake(p)).toBe(false);
  });
  it('an open answer never sets it', () => {
    const p = platform({});
    expect(backgroundLaneOpen(p)).toBe(true);
    expect(takeLaneWake(p)).toBe(false);
  });
});
```

In `src/main/core/engine/__tests__/engine.test.ts` add a `describe('syncing()')` block. Use the file's existing fake-source/store helpers (read the top of the file and reuse its `makeEngine`/fake source pattern — do not invent a new harness). Cases, each asserting `engine.syncing()`:

1. Source yields one `phase: 'backfill'` batch and then blocks on a never-resolving promise → after the commit resolves, `true`.
2. Same, but the batch is `phase: 'live'` → `false`.
3. A run whose source yields nothing and blocks (quiet watcher) → `false`.
4. Source yields `live` then `backfill` (multi-root resume) → `true` after the second commit.
5. Store `commit` rejects for a `backfill` batch → stays `false` (flag only moves on success).
6. Backfill batch committed, then `engine.pause(id)` → `false`.
7. Stream ends after a backfill batch (loop settles) → `false`.
8. A delayed commit: hold the store's `commit` promise for a backfill batch; before releasing → `false`; after → `true`.
9. Backfill batch committed, then a `live` batch committed → `false` (backfill → live clears it).
10. Backfill batch committed, then a `live` batch whose commit is held → stays `true` until it resolves; if that `live` commit rejects → stays `true` (previous value kept) until the loop's error handling settles it.
11. Backfill batch committed, then the source throws an `auth`-coded error (→ `'needsReauth'`) → `false`; a non-auth error that exhausts retries (→ `'error'`) → `false`.

- [ ] **Step 2: Run — expect FAIL**

Run: `npx jest src/main/core/__tests__/boot-lane.test.ts src/main/core/engine/__tests__/engine.test.ts -t "syncing|until-synced|pending wake"`

- [ ] **Step 3: Implement**

`src/shared/contracts.ts` — replace the `LaneState` union:

```ts
/** Why background work may or may not run right now. Contract (platform
 *  2.8.0): ONLY `'open'` permits background admission — every other value,
 *  including values added in later versions, means closed. */
export type LaneState =
  | 'open'
  | 'disabled'
  | 'battery'
  | 'until-idle'
  | 'until-night'
  /** Weak host (few cores / ≤8 GiB / local model on CPU) while any account
   *  is still in its initial backfill. */
  | 'until-synced';
```

`src/shared/extension-rpc.ts:29`: `export const PLATFORM_API_VERSION = '2.8.0';`

`src/main/core/engine/engine.ts`:

- Running map value type (~510):

```ts
  const running = new Map<
    string,
    { stop(): Promise<void>; active(): boolean; syncing?(): boolean }
  >();
```

- In `run()`, directly below `let status: SyncStatus = 'connecting';` (~966, RUN scope — not inside the per-retry `for (;;)` where `progressDone` lives):

```ts
      /** This run's last SUCCESSFULLY committed batch was a backfill batch.
       *  The truthful "still syncing" signal: every run starts at
       *  'connecting', quiet watchers never yield, and `status` flips to
       *  'live' before its commit lands. Only moves after a commit resolves. */
      let backfillCommitted = false;
```

- Immediately after the batch `await store.commit({...});` (~1117), before `retries = 0;`:

```ts
                backfillCommitted = batch.phase === 'backfill';
```

- On the account handle (~1229) add:

```ts
        syncing: () =>
          !settled &&
          backfillCommitted &&
          status !== 'error' &&
          status !== 'paused' &&
          status !== 'needsReauth',
```

and widen its type annotation to `Handle & { active(): boolean; syncing(): boolean }`.

- In the `createEngine` return-type intersection (~400) add:

```ts
  /** True while any ACCOUNT loop is in its initial (or re-)backfill —
   *  synchronous, no DB read. Worker handles share `running` and are
   *  excluded by key. */
  syncing(): boolean;
```

- In the returned engine object, next to `isRunning`:

```ts
    syncing(): boolean {
      for (const [key, h] of running) {
        if (key.startsWith('account:') && h.syncing?.() === true) return true;
      }
      return false;
    },
```

`src/main/core/boot.ts`:

- Imports: `import { describeHost, hostBudget, readHostFacts, type HostFacts, type LlmAccel } from './host-profile';` and `import { setChildPriorityLog } from './child-priority';`.
- `CorePlatform` add:

```ts
  /** Hardware facts, read once at boot (host-profile.ts). */
  host: HostFacts;
  /** The local model's acceleration once detected; null before. Bound by
   *  main.ts after the bundled providers register. */
  llmAccel: () => LlmAccel | null;
```

- In `bootCore`, after `const { store: logStore, sink } = createLogs(...)`:

```ts
  const host = readHostFacts();
  // accel is detected lazily by the local-llm provider; unknown at boot.
  sink.log('host', 'info', describeHost(host, null));
  setChildPriorityLog((msg) => sink.log('priority', 'info', msg));
```

- Replace the final `return { ... }` with building the object, binding the plane's policy (Task 4 adds `setLanePolicy`; in THIS task only build the object), and returning it:

```ts
  const platform: CorePlatform = {
    db,
    store,
    engine,
    scheduler,
    inference,
    prefs,
    logs: logStore,
    logSink: sink,
    sources,
    senders,
    refreshers,
    convert,
    host,
    llmAccel: () => null,
    createAppProjection,
    shutdown: async () => {
      scheduler.stop();
      await engine.stopAll();
      await store.close();
    },
  };
  return platform;
```

- Replace `backgroundLaneState` / `backgroundLaneOpen` with:

```ts
/** Evaluate the processing window and say WHY it's closed when it is. The ONE
 *  lane decision: inference admission, worker pre-flight, the extension
 *  `lane()` resolver and the 5 s publisher all read it. #147 grows this into
 *  a kind-aware owner (enrichment vs ingest); ingest must never be closed by
 *  'until-synced'. */
export function backgroundLaneState(
  platform: CorePlatform,
  now = new Date(),
): LaneState {
  const p = platform.prefs.get().processing;
  if (!p.enabled) return 'disabled';
  const { env } = platform.scheduler;
  if (env.onBattery) return 'battery';
  if (
    hostBudget(platform.host, platform.llmAccel()).weak &&
    platform.engine.syncing()
  )
    return 'until-synced';
  switch (p.window) {
    case 'always':
      return 'open';
    case 'night': {
      const h = now.getHours();
      return h >= 22 || h < 7 ? 'open' : 'until-night';
    }
    case 'idle':
    default:
      return env.userActive ? 'until-idle' : 'open';
  }
}

/** Platforms that refused background work since the publisher last woke the
 *  deferred workers. Coalesced: one wake covers any number of refusals. */
const pendingWake = new WeakSet<CorePlatform>();

/** Is the background lane open? A `false` answer records a pending wake, so
 *  a closure that opens and closes between two publisher ticks still wakes
 *  the deferred workers on the next tick (instead of their 30-min cadence). */
export function backgroundLaneOpen(
  platform: CorePlatform,
  now = new Date(),
): boolean {
  const open = backgroundLaneState(platform, now) === 'open';
  if (!open) pendingWake.add(platform);
  return open;
}

/** Consume the pending wake (the 5 s publisher calls this only while open). */
export function takeLaneWake(platform: CorePlatform): boolean {
  const had = pendingWake.has(platform);
  pendingWake.delete(platform);
  return had;
}
```

- **Untyped `CorePlatform` stubs** reach the policy at runtime and are invisible to tsc (cast objects). Add to both `src/main/workers/__tests__/redrive.test.ts` (`makePlatform`, ~13) and `src/main/workers/__tests__/attach-bundled-workers.test.ts` (`makePlatform`, ~39-47):

```ts
    host: { platform: 'darwin', arch: 'arm64', cores: 8, totalMemBytes: 16 * 1024 ** 3 },
    llmAccel: () => null,
```
and add `syncing: () => false,` to their `engine` object (redrive's stub needs an `engine` key if it lacks `syncing`). Typed fixtures that fail `tsc` on missing `host`/`llmAccel` get the same two fields.

- `docs/architecture/extension-platform.md:82`: in the `inference` row, after "(the background lane's current `LaneState`, …)" add: "**Contract (platform 2.8.0): only `'open'` permits background admission — every other value, including values added later, means closed.** `'until-synced'` (2.8.0) = a weak host while an account is still in its first sync." and change "the first time either of its two triggers runs" to "the first time its trigger runs (main.ts's 5 s publisher)".

- [ ] **Step 4: Run — expect PASS**

Run: `npx jest src/main/core/__tests__/boot-lane.test.ts src/main/core/engine/__tests__/engine.test.ts src/main/workers/__tests__`
Then: `npx tsc -p tsconfig.typecheck.json` (renderer `pausedLine` uses `default:`, so it compiles; Task 8 adds the case).

- [ ] **Step 5: Commit**

```bash
printf 'feat(core): until-synced lane on weak hosts + engine.syncing() (#145)\n' > /tmp/msg-t3
git commit -F /tmp/msg-t3 -- src/shared/contracts.ts src/shared/extension-rpc.ts src/main/core/engine/engine.ts src/main/core/boot.ts src/main/core/__tests__/boot-lane.test.ts src/main/core/engine/__tests__/engine.test.ts src/main/workers/__tests__/redrive.test.ts src/main/workers/__tests__/attach-bundled-workers.test.ts docs/architecture/extension-platform.md
```
(plus any fixture files Step 3 touched — list them explicitly.)

---

### Task 4: Admission reads the policy; the tick is the only publisher

**Files:**
- Modify: `src/main/core/inference.ts` (interface ~117-127, state ~243-244, `gate` ~301, `setBackgroundOpen`/`onLaneChange` ~607-618)
- Modify: `src/main/core/boot.ts` (`bootCore`: bind the policy)
- Modify: `src/main/core/processing-status.ts` (`tick`)
- Modify: `src/main/main.ts` (~1218 dep, ~1335-1343 tick)
- Modify: `src/main/platform/extension-platform.ts` (deps ~291-296, comments ~410-418 / ~448-462 / ~505-511, `offLane` ~524/574/1296-1297)
- Modify: `src/shared/contracts.ts:~1396` (comment only)
- Test: `src/main/core/__tests__/inference.test.ts`, `src/main/core/__tests__/inference-active-calls.test.ts`, `src/main/core/__tests__/processing-status.test.ts`, `src/main/platform/__tests__/{extension-platform,extension-e2e,attention-e2e,extension-outbound-e2e,ui-capability-e2e}.test.ts`

**Interfaces:**
- Consumes: Task 3 `backgroundLaneOpen`, `takeLaneWake`.
- Produces: `InferencePlane.setLanePolicy(fn: () => boolean): void`; `ProcessingStatus.tick(lane: LaneState, wakePending?: boolean)`. Removed: `setBackgroundOpen`, `onLaneChange`, `ExtensionPlatformDeps.onLaneChange`.

**Ruling recorded here:** the spec says "background is closed until set". The plane's default policy is `() => false`; `bootCore` binds the real policy synchronously right after building the platform object (no await between `createInference` and the bind), so production never observes the default. Unit tests that construct a bare plane and exercise background calls bind `() => true` explicitly.

- [ ] **Step 1: Failing tests**

In `src/main/core/__tests__/inference.test.ts` (helpers: `noopLogs`, `provider(id, kinds, tag)`) replace the three tests at ~134-165 ("background lane fails fast…", "interactive lane flows…", "notifies lane subscribers…") with:

```ts
  it('background calls are refused until a lane policy is bound', async () => {
    const plane = createInference(noopLogs);
    plane.register(provider('ocr', ['read'], 'ocr'));
    await expect(
      plane.read(new Uint8Array([1]), { lane: 'background' }),
    ).rejects.toThrow(LaneClosedError);
    await expect(plane.read(new Uint8Array([1]))).resolves.toBe('ocr:read');
  });

  it('gate reads the policy on every call (no cached boolean)', async () => {
    const plane = createInference(noopLogs);
    plane.register(provider('ocr', ['read'], 'ocr'));
    let open = false;
    plane.setLanePolicy(() => open);
    await expect(
      plane.read(new Uint8Array([1]), { lane: 'background' }),
    ).rejects.toThrow(LaneClosedError);
    open = true;
    await expect(
      plane.read(new Uint8Array([1]), { lane: 'background' }),
    ).resolves.toBe('ocr:read');
  });

  it('interactive calls flow while the policy says closed', async () => {
    const plane = createInference(noopLogs);
    plane.register(provider('ocr', ['read'], 'ocr'));
    plane.setLanePolicy(() => false);
    await expect(plane.read(new Uint8Array([1]))).resolves.toBe('ocr:read');
  });
```

In the `setup()` helper (~644) add `plane.setLanePolicy(() => true);` right after `const plane = createInference(fakeLogs(), { generationSeed: 1 });` (it feeds the background `seeWithMeta` test ~738), and replace `planeRef!.setBackgroundOpen(false);` (~738) with `planeRef!.setLanePolicy(() => false);`. In `inference-active-calls.test.ts` (~91) replace `plane.setBackgroundOpen(false)` with `plane.setLanePolicy(() => false)`; if any test there makes a background call expecting success, bind `() => true` first.

Connected wake tests — add to `src/main/core/__tests__/boot-lane.test.ts` (reuse its `platform()` fixture; import `createInference`, `LaneClosedError` from `../inference` and `createProcessingStatus` from `../processing-status`):

```ts
describe('refusal → pending wake → publisher tick', () => {
  function status() {
    const wakeWorkers = jest.fn(async () => {});
    const s = createProcessingStatus({
      countWaiting: async () => 0,
      providers: () => [],
      activeCalls: { list: () => [], onChange: () => () => {} },
      wakeWorkers,
      patch: () => {},
      warn: () => {},
    });
    return { s, wakeWorkers };
  }
  const flush = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };

  it('an inference-admission refusal before the first tick wakes on the first open tick', async () => {
    let syncing = true;
    const p = platform({ weak: true });
    (p as any).engine = { syncing: () => syncing };
    const plane = createInference({ log: () => {} } as never);
    plane.register({ id: 'x', supports: ['read'], status: () => 'ready', handle: async () => 't' } as never);
    plane.setLanePolicy(() => backgroundLaneOpen(p));
    await expect(plane.read(new Uint8Array([1]), { lane: 'background' })).rejects.toThrow(LaneClosedError);
    syncing = false; // sync finished before any tick ran
    const { s, wakeWorkers } = status();
    const lane = backgroundLaneState(p);
    s.tick(lane, lane === 'open' && takeLaneWake(p));
    await flush();
    expect(wakeWorkers).toHaveBeenCalledTimes(1);
  });

  it('a worker pre-flight refusal between two open ticks wakes on the next tick', async () => {
    let syncing = false;
    const p = platform({ weak: true });
    (p as any).engine = { syncing: () => syncing };
    const { s, wakeWorkers } = status();
    s.tick(backgroundLaneState(p), takeLaneWake(p)); // open, nothing pending
    syncing = true;
    expect(backgroundLaneOpen(p)).toBe(false);     // worker laneOpen() refuses
    syncing = false;                                // …and sync ends before the next tick
    const lane = backgroundLaneState(p);
    s.tick(lane, lane === 'open' && takeLaneWake(p));
    await flush();
    expect(wakeWorkers).toHaveBeenCalledTimes(1);
  });
});
```

(Adjust the `createInference` logs argument to the `noopLogs` shape exported/used by `inference.test.ts`, and the provider literal to the `InferenceProvider` shape — copy `provider()` from that file.)

In `src/main/core/__tests__/processing-status.test.ts` add:

```ts
test('an open tick with a pending wake wakes workers even without a closed→open edge', async () => {
  const t = setup();
  t.status.tick('open');
  t.status.tick('open', true);
  await flush();
  expect(t.wakeWorkers).toHaveBeenCalledTimes(1);
});

test('the very first tick wakes when a wake is pending (closure before the first tick)', async () => {
  const t = setup();
  t.status.tick('open', true);
  await flush();
  expect(t.wakeWorkers).toHaveBeenCalledTimes(1);
});
```

In `src/main/platform/__tests__/extension-platform.test.ts` rewrite the test at ~1724 ("re-registers worker and lane lifecycle listeners after stop/start") to drop every `onLaneChange`/`laneListeners` line, keeping the worker-listener assertions. Delete `onLaneChange: () => () => {},` from the deps fixtures in `extension-platform.test.ts` (~200, ~1646, ~1878), `extension-e2e.test.ts` (~82, ~262, ~451), `attention-e2e.test.ts` (~85), `extension-outbound-e2e.test.ts` (~135), `ui-capability-e2e.test.ts` (~87). In the existing `describe('createLaneGate')` (~60) add:

```ts
  it('emits a reason-only change between two closed states exactly once', () => {
    let state: LaneState = 'battery';
    const emit = jest.fn();
    const gate = createLaneGate(() => state, emit, jest.fn());
    gate.check();
    state = 'until-synced';
    gate.check();
    gate.check();
    expect(emit.mock.calls.map((c) => c[0])).toEqual(['battery', 'until-synced']);
  });
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npx jest src/main/core/__tests__/inference.test.ts src/main/core/__tests__/processing-status.test.ts src/main/core/__tests__/boot-lane.test.ts`

- [ ] **Step 3: Implement**

`src/main/core/inference.ts` — interface: replace `setBackgroundOpen` and `onLaneChange` (and their doc comments) with:

```ts
  /** Bind the ONE background-lane policy (boot.ts `backgroundLaneOpen`).
   *  `gate()` calls it on every background request — no cached boolean, so
   *  admission is never staler than the policy's inputs. Unbound = closed. */
  setLanePolicy(fn: () => boolean): void;
```

State: replace `let backgroundOpen = true;` and `const laneSubs = ...` with `let lanePolicy: () => boolean = () => false;`.

Gate:

```ts
  const gate = (lane: Lane): void => {
    if (lane !== 'interactive' && !lanePolicy()) throw new LaneClosedError();
  };
```

Object: replace `setBackgroundOpen(open) {...}` and `onLaneChange(cb) {...}` with:

```ts
    setLanePolicy(fn) {
      lanePolicy = fn;
    },
```

Update the `LaneClosedError` / `createInference` doc comments that mention "the scheduler holds the lane open" to say "the bound lane policy answers open".

`src/main/core/boot.ts` `bootCore`, between building `platform` and `return platform;`:

```ts
  // Bound synchronously before anything can call: production never sees the
  // plane's closed default.
  inference.setLanePolicy(() => backgroundLaneOpen(platform));
```

(`backgroundLaneOpen` is declared later in the same module — function declarations are hoisted, fine.)

`src/main/core/processing-status.ts` — change the `tick` signature and wake logic (keep the rest of `tick` after the lane block unchanged):

```ts
    tick(lane, wakePending = false) {
      const prev = lastLane;
      if (lane !== lastLane) {
        lastLane = lane;
        deps.patch({ lane });
      }
      const edge = prev !== null && prev !== 'open' && lane === 'open';
      if (edge || (lane === 'open' && wakePending)) {
        void deps
          .wakeWorkers()
          .then(refreshWaiting, (e) =>
            deps.warn(`worker wake failed: ${String(e)}`),
          );
      }
```

and its type: `tick(lane: LaneState, wakePending?: boolean): void;` with a doc line: "`wakePending`: a background refusal happened since the last wake (boot.ts `takeLaneWake`)".

`src/main/main.ts`:
- import `takeLaneWake` from `./core/boot` beside `backgroundLaneState`.
- delete the line `onLaneChange: (cb) => p.inference.onLaneChange(cb),` (~1218).
- in the 5 s interval replace

```ts
        const lane = backgroundLaneState(p);
        p.inference.setBackgroundOpen(lane === 'open');
```
with
```ts
        // Publication only: admission reads the policy directly (setLanePolicy).
        const lane = backgroundLaneState(p);
```
and `processingStatus.tick(lane);` with `processingStatus.tick(lane, lane === 'open' && takeLaneWake(p));`. Update the comment block above `refreshLane()` to say the tick is the single publisher.

`src/main/platform/extension-platform.ts`:
- delete the `onLaneChange` member and its doc comment from `ExtensionPlatformDeps`.
- delete `let offLane...`, the `offLane ??= deps.onLaneChange(...)` line, and the two `offLane?.(); offLane = undefined;` lines.
- rewrite the comments at ~410-418, ~448-462 and ~505-511 to: `refreshLane()` (called by main.ts's 5 s publisher) is the only trigger; `createLaneGate` dedups so reason-only changes (e.g. `'battery' → 'until-synced'`) emit exactly once.

`src/shared/contracts.ts:~1396`: change "see `InferencePlane.onLaneChange`" to "see `InferencePlane.setLanePolicy`".

- [ ] **Step 4: Run — expect PASS**

Run: `npx jest src/main/core src/main/platform/__tests__/extension-platform.test.ts src/main/platform/__tests__/extension-e2e.test.ts src/main/platform/__tests__/attention-e2e.test.ts src/main/platform/__tests__/extension-outbound-e2e.test.ts src/main/platform/__tests__/ui-capability-e2e.test.ts`
Then: `npx tsc -p tsconfig.typecheck.json` and `git grep -n "setBackgroundOpen\|onLaneChange" -- src docs/architecture` → no matches.

Coverage note: the `bootCore` bind itself has no unit test (bootCore needs a real DB worker); the connected tests above bind the same `() => backgroundLaneOpen(p)` closure by hand.

- [ ] **Step 5: Commit**

```bash
printf 'refactor(core): admission reads the lane policy; tick is the single publisher (#145)\n' > /tmp/msg-t4
git commit -F /tmp/msg-t4 -- <every file listed in this task, plus src/main/core/__tests__/boot-lane.test.ts>
```

---

### Task 5: llama-server thread cap + host model in local-llm

**Files:**
- Modify: `src/main/providers/local-llm/provider.ts` (deps ~39-53, `capability` ~64, `makeServer` default ~59, `ensureServer` ~281-291, interface: add `accel()`)
- Modify: `src/main/providers/local-llm/capability.ts` (delete `readHostProbes`; keep `HostProbes` type + `checkCapability`)
- Modify: `src/main/providers/local-llm/index.ts:5` (drop the `readHostProbes` re-export)
- Modify: `src/main/providers/local-llm/backend.ts` (`detectHostBackend` takes required `platform` + `totalMemBytes`; no `os` import)
- Modify: `src/main/providers/index.ts` (pass `host`)
- Modify: `src/main/main.ts` (bind `p.llmAccel`)
- Test: `src/main/providers/local-llm/__tests__/server.test.ts`, the local-llm provider test file (find with `ls src/main/providers/local-llm/__tests__`)

**Interfaces:**
- Consumes: `HostFacts`, `hostBudget` (Task 1); `CorePlatform.host`, `llmAccel` (Task 3).
- Produces: `llamaThreadArgs(host: HostFacts, accel: LlmAccel): string[]`; `LocalLlmProvider.accel(): LlmAccel | null`.

- [ ] **Step 1: Failing tests**

`server.test.ts`, inside `describe('LlamaServer launch args')` (existing pattern: `capture()` + `(srv as any).launch()`):

```ts
  it('appends extraArgs after the fixed args', () => {
    const { calls, spawnFn } = capture();
    const srv = new LlamaServer({
      binaryPath: 'unused',
      modelPath: 'm',
      mmprojPath: 'mm',
      gpuLayers: 999,
      log: noopLog,
      spawnFn,
      extraArgs: ['-t', '2', '-tb', '2', '--poll', '0'],
    });
    (srv as any).launch();
    expect(calls[0].args.slice(-6)).toEqual(['-t', '2', '-tb', '2', '--poll', '0']);
    expect(calls[0].args).not.toContain('-np');
  });
```

`local-llm/__tests__/provider.test.ts`: delete the `mockCapability.readHostProbes.mockReturnValue({...})` block in `beforeEach` (~84-88); add to `makeDeps`'s `deps` a default `host: { platform: 'darwin' as NodeJS.Platform, arch: 'arm64', cores: 10, totalMemBytes: 64 * 1024 ** 3 },`. New cases (use the file's existing install-then-handle flow that other tests use to reach `makeServer`, e.g. the test around ~473):

```ts
it('starts llama-server with -t/-tb = backgroundThreads and --poll 0, never -np', async () => {
  const seen: string[][] = [];
  const { deps, server } = makeDeps({ modelsDir: tmpDir });
  const provider = createLocalLlmProvider({
    ...deps,
    makeServer: (a: { extraArgs?: string[] }) => {
      seen.push(a.extraArgs ?? []);
      return server;
    },
  });
  /* install + one interactive handle(), exactly as the existing makeServer tests do */
  expect(seen[0]).toEqual(['-t', '5', '-tb', '5', '--poll', '0']);
});

it('accel() is null before detection and the detected accel after', async () => {
  const { deps } = makeDeps({ modelsDir: tmpDir, detect: async () => ({ accel: 'cpu' as const, capacityBytes: 1 }) });
  const provider = createLocalLlmProvider(deps);
  expect(provider.accel()).toBeNull();
  /* install + one handle(), as above */
  expect(provider.accel()).toBe('cpu');
});
```

Write the `/* … */` lines by copying the concrete install/handle sequence from the existing test that asserts `makeServer` was called (~473-508). Update `capability`'s own tests to pass probes explicitly, and any `detectHostBackend` test to pass `{ platform, totalMemBytes }`.

- [ ] **Step 2: Run — expect FAIL**

Run: `npx jest src/main/providers/local-llm`

- [ ] **Step 3: Implement**

`provider.ts`:
- deps: add `host?: HostFacts;` and extend the `makeServer?` args type with `extraArgs?: string[];`.
- top of `createLocalLlmProvider`: `const host = deps.host ?? readHostFacts();`
- `const detect = deps.detect ?? (() => detectHostBackend({ platform: host.platform, totalMemBytes: host.totalMemBytes }));`
- `const capability = checkCapability({ platform: host.platform, arch: host.arch, totalMemBytes: host.totalMemBytes });`
- add and export:

```ts
/** Leave half the logical cores to the user and stop idle busy-waiting.
 *  NEVER add -np here: an explicit slot count disables b9585's unified KV
 *  cache and splits the 24k context (see server.ts contextSize). */
export function llamaThreadArgs(host: HostFacts, accel: LlmAccel): string[] {
  const n = String(hostBudget(host, accel).backgroundThreads);
  return ['-t', n, '-tb', n, '--poll', '0'];
}
```

- in `ensureServer`'s `makeServer({...})` add `extraArgs: llamaThreadArgs(host, backend.accel),`.
- returned object: `accel: () => backend?.accel ?? null,`; interface `LocalLlmProvider`: `/** Detected acceleration; null until the first detect(). */ accel(): LlmAccel | null;`

`backend.ts`: `detectHostBackend(opts: { platform: string; totalMemBytes: number; listDevices?(): Promise<string> })` — required facts, `os` import removed (host-profile is the only hardware reader).

`capability.ts`: delete `readHostProbes` and make `checkCapability(probes: HostProbes)` take a required argument; remove the now-unused `os` import. `index.ts`: drop `readHostProbes` from the re-export.

`providers/index.ts`: pass `host: platform.host` to `createLocalLlmProvider`.

`main.ts`: right after `registerBundledProviders(...)` returns `bundled`, add `p.llmAccel = () => bundled.localLlm.accel();`.

- [ ] **Step 4: Run — expect PASS**

Run: `npx jest src/main/providers/local-llm src/main/core/__tests__/boot-lane.test.ts` then `npx tsc -p tsconfig.typecheck.json`.

- [ ] **Step 5: Commit**

```bash
printf 'feat(local-llm): thread-capped llama-server, host model, accel() (#145)\n' > /tmp/msg-t5
git commit -F /tmp/msg-t5 -- src/main/providers/local-llm src/main/providers/index.ts src/main/main.ts
```

---

### Task 6: whisper — class by lane, thread cap, interactive-first queue

**Files:**
- Modify: `src/main/providers/local-asr/whisper-cli.ts` (`WhisperChildProcess` ~168, `runWhisperCli` args ~201-218, spawn ~234-277)
- Modify: `src/main/providers/local-asr/provider.ts` (deps/probes ~70-95, `QueuedJob`, `pump` ~133-147, `runTranscribe` ~180-232, `transcribeFile` ~241, `handle` hear ~444)
- Modify: `src/main/providers/index.ts` (pass `host`)
- Test: `src/main/providers/local-asr/__tests__/whisper-cli.test.ts`, `src/main/providers/local-asr/__tests__/provider.test.ts`

**Interfaces:**
- Consumes: `launch`, `ChildClass` (Task 2); `HostFacts`, `hostBudget` (Task 1).
- Produces: `runWhisperCli({ ..., priority?: ChildClass, threads?: number })`.

- [ ] **Step 1: Failing tests**

`whisper-cli.test.ts`:

```ts
  it('a background run execs through taskpolicy with -t (darwin)', async () => {
    const { spawnFn, child, argv } = fakeSpawn();
    const p = runWhisperCli({ ...ARGS, spawnFn, priority: 'background', threads: 2, platform: 'darwin', taskpolicyExists: () => true });
    child.emit('close', 0, null);
    await p;
    // fakeSpawn records [cmd, ...args]
    expect(argv[0].slice(0, 3)).toEqual(['/usr/sbin/taskpolicy', '-b', ARGS.binaryPath]);
    expect(argv[0][argv[0].indexOf('-t') + 1]).toBe('2');
  });

  it('an interactive run is unchanged (no wrapper, no -t)', async () => {
    const { spawnFn, child, argv } = fakeSpawn();
    const p = runWhisperCli({ ...ARGS, spawnFn });
    child.emit('close', 0, null);
    await p;
    expect(argv[0][0]).toBe(ARGS.binaryPath);
    expect(argv[0]).not.toContain('-t');
  });

  it('taskpolicy exit 66 (binary missing) is a plain Error, not AsrInputRejectedError', async () => {
    const { spawnFn, child } = fakeSpawn();
    const p = runWhisperCli({ ...ARGS, spawnFn, priority: 'background', platform: 'darwin', taskpolicyExists: () => true });
    child.stderr.emit('data', Buffer.from('taskpolicy: posix_spawn: /x/whisper-cli: No such file or directory\n'));
    child.emit('close', 66, null);
    await expect(p).rejects.not.toBeInstanceOf(AsrInputRejectedError);
  });
```

(`argv` in `fakeSpawn` records the args passed to `spawnFn`; with the wrapper the first two are `-b <binary>`.)

`provider.test.ts`:

```ts
  it('an interactive hear preempts a running background transcribeFile, which rejects (worker defers)', async () => {
    const order: string[] = [];
    const signals: AbortSignal[] = [];
    const runCli = jest.fn((a: any) => {
      order.push(a.priority);
      signals.push(a.signal);
      return new Promise<string>((resolve, reject) => {
        if (a.priority === 'background')
          a.signal.addEventListener('abort', () => reject(new Error('whisper-cli killed by SIGTERM')));
        else resolve('meeting text');
      });
    });
    const provider = createLocalAsrProvider(makeDeps({ asrModelsDir: tmpDir, filesPresent: () => true, runCli }));
    const bg = provider.transcribeFile('/tmp/a.wav', { format: 'wav' });
    await tick();
    const hear = provider.handle({ kind: 'hear', payload: { audio: new Uint8Array(4) }, lane: 'interactive' } as never);
    await expect(bg).rejects.toThrow('SIGTERM');
    await expect(hear).resolves.toBe('meeting text');
    expect(order).toEqual(['background', 'interactive']);
    expect(signals[0].aborted).toBe(true);
  });

  it('a queued interactive job overtakes queued background jobs', async () => { /* bg1 running, bg2 queued, then interactive → order bg1(aborted), interactive, bg2 */ });

  it('background jobs pass threads = min(4, backgroundThreads)', async () => {
    const runCli = jest.fn(async (_a: unknown) => 'x');
    const provider = createLocalAsrProvider(makeDeps({
      asrModelsDir: tmpDir, filesPresent: () => true, runCli,
      host: { platform: 'darwin', arch: 'arm64', cores: 16, totalMemBytes: 32 * 1024 ** 3 },
    }));
    await provider.transcribeFile('/tmp/a.wav', { format: 'wav' });
    expect(runCli.mock.calls[0][0]).toMatchObject({ priority: 'background', threads: 4 });
  });

  it('a background-lane hear runs as background', async () => { /* lane: 'background' → priority 'background' */ });
```

Write the two stubbed cases fully in the same style (the second: three jobs, assert `order` is `['background','interactive','background']`).

- [ ] **Step 2: Run — expect FAIL**

Run: `npx jest src/main/providers/local-asr`

- [ ] **Step 3: Implement**

`whisper-cli.ts`:
- `WhisperChildProcess`: add `readonly pid?: number;`.
- `runWhisperCli` args add:

```ts
  /** Background (indexing / background-lane) runs execute demoted
   *  (child-priority.ts) with a thread cap; interactive runs are untouched. */
  priority?: ChildClass;
  /** `-t N`; omitted → whisper's own default (4). */
  threads?: number;
  /** Test seams for child-priority on a non-mac CI host. */
  platform?: NodeJS.Platform;
  taskpolicyExists?: (p: string) => boolean;
```

- build the argv array into `const argv = [ ...existing items..., ...(args.threads !== undefined ? ['-t', String(args.threads)] : []) ];` and replace `const child = spawnFn(args.binaryPath, [ ... ], { stdio: ['ignore','pipe','pipe'] });` with:

```ts
    const child = launch(
      args.priority ?? 'interactive',
      args.binaryPath,
      argv,
      (cmd, a) => spawnFn(cmd, a, { stdio: ['ignore', 'pipe', 'pipe'] }),
      { platform: args.platform, exists: args.taskpolicyExists },
    );
```

`provider.ts`:
- deps: replace `probes?: { platform; totalMemBytes }` with `host?: HostFacts;` and the probes default (~89-91) with `const host = deps.host ?? readHostFacts();`; use `host.platform` / `host.totalMemBytes` where `probes.*` was used (~97-104). One host-fact channel. In `provider.test.ts` change `makeDeps`'s `probes: {...}` to `host: { platform: 'darwin' as NodeJS.Platform, arch: 'arm64', cores: 8, totalMemBytes: 32 * 1024 ** 3 }` and every per-test `probes: { platform, totalMemBytes }` override to `host: { platform, arch: 'x64', cores: 8, totalMemBytes }` — ALL sites: `provider.test.ts` ~85, ~243, ~920 (`win32`, 64 GiB), ~926 (`darwin`, 8 GiB), ~1014 (`win32`, 64 GiB), ~1055 (`linux`, 64 GiB) — preserving each platform/memory value — and `active-calls.test.ts` ~36 (→ `host: { platform: 'darwin', arch: 'arm64', cores: 8, totalMemBytes: 32 * 1024 ** 3 }`). These fixtures are behind `as any`, so tsc will not find them — verify with `git grep -n "probes" -- src/main/providers/local-asr` → nothing.
- `interface QueuedJob { cls: 'interactive' | 'background'; run(): Promise<void>; reject(e: Error): void; }`
- state: `let activeCls: QueuedJob['cls'] | null = null;`
- `pump`: after `if (!job) return;` (NOT before it) set `activeCls = job.cls;`; in the `finally` set `activeCls = null;`.
- `runTranscribe(p, opts, vadModelPath, which = defaultModel, cls: QueuedJob['cls'] = 'interactive')`; the queued object gets `cls`; enqueue with

```ts
      const job: QueuedJob = { cls, reject, async run() { /* unchanged body, but pass to runCli: */ } };
      if (cls === 'interactive') {
        const i = queue.findIndex((j) => j.cls === 'background');
        if (i < 0) queue.push(job);
        else queue.splice(i, 0, job);
        // Foreground never waits behind a throttled background run: kill it.
        // It rejects as a plain Error → the audio worker defers and re-drives.
        if (activeCls === 'background') active?.abort();
      } else {
        queue.push(job);
      }
      pump();
```

  and inside `run()` pass to `runCli`: `priority: cls, threads: cls === 'background' ? Math.min(4, hostBudget(host, null).backgroundThreads) : undefined,`.
- `transcribeFile` → `runTranscribe(p, opts, undefined, defaultModel, 'background')`.
- `handle` hear → final arg `req.lane === 'background' ? 'background' : 'interactive'` on its `runTranscribe(...)` call.

`providers/index.ts`: pass `host: platform.host` to `createLocalAsrProvider`.

- [ ] **Step 4: Run — expect PASS**

Run: `npx jest src/main/providers/local-asr src/main/workers/audio` then `npx tsc -p tsconfig.typecheck.json`

- [ ] **Step 5: Commit**

```bash
printf 'feat(local-asr): demoted thread-capped background whisper; interactive preempts (#145)\n' > /tmp/msg-t6
git commit -F /tmp/msg-t6 -- src/main/providers/local-asr src/main/providers/index.ts
```

---

### Task 7: OCR helpers, PDF raster, afconvert, audio worker host facts

**Files:**
- Modify: `src/main/workers/vision/rasterize.ts` (new `HelperTimeoutError`, beside `Rasterizer`)
- Modify: `src/main/providers/apple-vision/vision-helper.ts` (`ExecFileFn`, `VisionHelper`, `runJson`, `ocrImage`, `rasterizePdf`)
- Modify: `src/main/workers/audio/audio-worker.ts` (`totalMemBytes` required, `os` import removed)
- Modify: `src/main/providers/apple-vision/provider.ts:~36`
- Modify: `src/main/providers/windows-ocr/windows-ocr-helper.ts` (`run`, `ocrImage`)
- Modify: `src/main/providers/windows-ocr/provider.ts:~58`
- Modify: `src/main/workers/vision/vision-worker.ts:~309`
- Modify: `src/main/workers/audio/transcode.ts:~193`
- Modify: `src/main/workers/index.ts` (audio worker `totalMemBytes`)
- Test: `src/main/providers/apple-vision/__tests__/vision-helper.test.ts`, `src/main/providers/windows-ocr/__tests__/windows-ocr.test.ts`, `src/main/workers/vision/__tests__/vision-worker.test.ts`, `src/main/workers/audio/__tests__/transcode.test.ts`

**Interfaces:**
- Consumes: `launch`, `ChildClass` (Task 2).
- Produces: `HelperTimeoutError` (from `workers/vision/rasterize.ts`); `VisionHelper.ocrImage(bytes, mime?, cls?)`; Windows helper `ocrImage(bytes, mime?, cls?)`.

- [ ] **Step 1: Failing tests**

`vision-helper.test.ts` (it injects `execFileFn`): pass `taskpolicyExists: () => false` in every EXISTING `makeVisionHelper(…, { execFileFn: exec })` call (~33, 65, 87, 104, 121) so their `seenArgs[0] === 'rasterize'|'ocr'` assertions stay host-independent. Then add

```ts
it('background OCR and every rasterize exec through taskpolicy -b on darwin', async () => {
  const files: string[] = [];
  const execFileFn: ExecFileFn = (file, args, _o, cb) => { files.push(file); cb(null, JSON.stringify({ text: 'x', width: 1, height: 1, confidence: 1, pages: [], pageCount: 0 }), ''); };
  const h = makeVisionHelper('/v/kia-vision', () => {}, { execFileFn, platform: 'darwin', taskpolicyExists: () => true });
  await h.ocrImage(new Uint8Array([1]), 'image/png', 'background');
  await h.ocrImage(new Uint8Array([1]), 'image/png');            // interactive default
  await h.rasterizePdf(new Uint8Array([1]), [1]);
  expect(files).toEqual(['/usr/sbin/taskpolicy', '/v/kia-vision', '/usr/sbin/taskpolicy']);
});

it('a helper timeout rejects with HelperTimeoutError', async () => {
  const execFileFn: ExecFileFn = (_f, _a, _o, cb) => cb(Object.assign(new Error('t'), { killed: true }), '', '');
  const h = makeVisionHelper('/v/kia-vision', () => {}, { execFileFn });
  await expect(h.rasterizePdf(new Uint8Array([1]), [1])).rejects.toBeInstanceOf(HelperTimeoutError);
});
```

`vision-worker.test.ts`: a rasterizer whose `pdfToPngs` rejects with `new HelperTimeoutError('kia-vision rasterize timed out after 120000ms')` → `work()` resolves `'defer'`; one rejecting with a plain `Error('corrupt')` → still rejects (unchanged).

`windows-ocr.test.ts`: add a test through the new `opts.setPriority` seam (the existing tests use a real fake exe and stay unchanged):

```ts
  // needs: import os from 'os';
  it('a background OCR run is demoted to PRIORITY_LOW', async () => {
    const setPriority = jest.fn();
    await makeWindowsOcrHelper(FAKE, log, { setPriority }).ocrImage(new Uint8Array([1]), 'image/png', 'background');
    expect(setPriority).toHaveBeenCalledWith(expect.any(Number), os.constants.priority.PRIORITY_LOW);
  });
```
(use the same FAKE/arrangement as the existing passing `ocrImage` test).

`audio-worker.test.ts`: every `createAudioWorker`/`setup` call already passes or defaults `totalMemBytes`; make the test default explicit where it relied on `os.totalmem()`.

- [ ] **Step 2: Run — expect FAIL**

Run: `npx jest src/main/providers/apple-vision src/main/providers/windows-ocr src/main/workers/vision src/main/workers/audio`

- [ ] **Step 3: Implement**

`workers/vision/rasterize.ts` (beside `Rasterizer`; `vision-helper.ts` already imports from here):

```ts
/** A helper ran past its deadline. Under background priority this is load,
 *  not a broken input: callers defer instead of burning retries. */
export class HelperTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HelperTimeoutError';
  }
}
```

`vision-helper.ts` (import `HelperTimeoutError` from `../../workers/vision/rasterize`, `launch`/`ChildClass` from `../../core/child-priority`):

- `ExecFileFn` return type `void` → `{ pid?: number } | void`.
- `VisionHelper.ocrImage(bytes: Uint8Array, mime?: string, cls?: ChildClass): Promise<string>;` (doc: "`cls` follows the request lane; rasterizePdf is always background (vision worker only)").
- `VisionHelperOptions` add `platform?: NodeJS.Platform; taskpolicyExists?: (p: string) => boolean;` and `makeVisionHelper` opts the same.
- `runJson<T>(args: string[], cls: ChildClass)`: replace `exec(this.o.binaryPath, args, {...}, cb)` with

```ts
      launch(
        cls,
        this.o.binaryPath,
        args,
        (cmd, a) => exec(cmd, a, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, cb),
        { platform: this.o.platform, exists: this.o.taskpolicyExists },
      );
```
  hoisting the existing callback into `const cb: Parameters<ExecFileFn>[3] = (err, stdout, stderr) => { … };` inside the `new Promise` executor; the timeout branch becomes `reject(new HelperTimeoutError(\`kia-vision ${args[0]} timed out after ${timeoutMs}ms\`));` (reject, never throw — the callback is asynchronous).
- `ocr(imagePath, cls)` → `runJson(['ocr', imagePath], cls)`; `rasterize(...)` → `runJson(args, 'background')`; `ocrImage(bytes, mime, cls = 'interactive')` passes `cls`.

`apple-vision/provider.ts` and `windows-ocr/provider.ts` handle: `return deps.helper.ocrImage(image, mime, req.lane === 'background' ? 'background' : 'interactive');`

`windows-ocr-helper.ts`: `opts` add `setPriority?: (pid: number, p: number) => void`; `run(args, cls: ChildClass = 'interactive')` wraps its existing `execFile(exe, args, {...}, cb)` as `launch(cls, exe, args, (c, a) => execFile(c, a, {...}, cb), { platform: 'win32', setPriority: opts.setPriority })` — `platform: 'win32'` is fixed because this helper only runs on Windows, which also keeps the test host-independent; `ocrImage(bytes, mime = 'image/png', cls: ChildClass = 'interactive')` calls `run(['ocr', file], cls)`; `selftest` stays interactive.

`vision-worker.ts` (~309) replace

```ts
    const raster = next.length
      ? await deps.rasterizer.pdfToPngs(bytes, { pages: next })
      : null;
```
with
```ts
    let raster: RasterResult | null = null;
    if (next.length) {
      try {
        raster = await deps.rasterizer.pdfToPngs(bytes, { pages: next });
      } catch (err) {
        // A demoted raster helper past its deadline is load, not a bad PDF:
        // defer (re-driven when idle) instead of exhausting engine retries.
        if (err instanceof HelperTimeoutError) return 'defer';
        throw err;
      }
    }
```
(import `HelperTimeoutError` and `type RasterResult` from `./rasterize`).

`transcode.ts`: `export const AFCONVERT = '/usr/bin/afconvert';` and `runAfconvert` spawns via
```ts
    const proc = launch('background', AFCONVERT, ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', inPath, outPath], (c, a) =>
      spawn(c, a, { stdio: ['ignore', 'ignore', 'pipe'] }),
    );
```

`workers/index.ts`: pass `totalMemBytes: platform.host.totalMemBytes` into `createAudioWorker({...})`. `audio-worker.ts`: `totalMemBytes: number` (required) and `const totalMem = deps.totalMemBytes;`; remove `import os`.

- [ ] **Step 4: Run — expect PASS**

Run: `npx jest src/main/providers/apple-vision src/main/providers/windows-ocr src/main/workers` then `npx tsc -p tsconfig.typecheck.json`

- [ ] **Step 5: Commit**

```bash
printf 'feat(vision,audio): demoted OCR/raster/afconvert by lane; raster timeout defers (#145)\n' > /tmp/msg-t7
git commit -F /tmp/msg-t7 -- src/main/providers/apple-vision src/main/providers/windows-ocr src/main/workers
```

---

### Task 8: Extension hosts below-normal + core UI copy

**Files:**
- Modify: `src/main/platform/transport.ts:~121`
- Modify: `src/renderer/screens/Settings/LocalProcessing.tsx` (`pausedLine`)
- Test: `src/main/platform/__tests__/transport.test.ts`, `src/renderer/screens/Settings/__tests__/LocalProcessing.test.tsx`

**Interfaces:**
- Consumes: `demoteHost` (Task 2).

- [ ] **Step 1: Failing tests**

`transport.test.ts`: give `FakeChild` a `pid = 9001;` field; mock `../../core/child-priority` partially:

```ts
jest.mock('../../core/child-priority', () => ({
  ...jest.requireActual('../../core/child-priority'),
  demoteHost: jest.fn(),
}));
import { demoteHost } from '../../core/child-priority';

it('demotes the utility process to below-normal once it spawns', () => {
  utilityProcessTransport('/x.js', 'svc');
  const child = (jest.requireMock('electron') as any).__children.at(-1);
  expect(demoteHost).not.toHaveBeenCalled();
  child.emit('spawn');
  expect(demoteHost).toHaveBeenCalledWith(9001);
});
```

`LocalProcessing.test.tsx`: `expect(pausedLine('until-synced')).toBe('Paused — waits until your accounts finish syncing.');`

- [ ] **Step 2: Run — expect FAIL**

Run: `npx jest src/main/platform/__tests__/transport.test.ts src/renderer/screens/Settings/__tests__/LocalProcessing.test.tsx`

- [ ] **Step 3: Implement**

`transport.ts`, right after `utilityProcess.fork(...)`:

```ts
  // Extension hosts mostly pull in the background but also serve small
  // interactive calls (send, consent): below-normal, not low.
  child.once('spawn', () => demoteHost(child.pid));
```
(import `demoteHost` from `../core/child-priority`).

`LocalProcessing.tsx` `pausedLine`, add before `case 'until-idle':`:

```ts
    case 'until-synced':
      return 'Paused — waits until your accounts finish syncing.';
```

- [ ] **Step 4: Run — expect PASS** (same command), then `npx tsc -p tsconfig.typecheck.json`

- [ ] **Step 5: Commit**

```bash
printf 'feat(platform): extension hosts below-normal; until-synced copy (#145)\n' > /tmp/msg-t8
git commit -F /tmp/msg-t8 -- src/main/platform/transport.ts src/main/platform/__tests__/transport.test.ts src/renderer/screens/Settings/LocalProcessing.tsx src/renderer/screens/Settings/__tests__/LocalProcessing.test.tsx
```

---

### Task 9: Gates + spec status

- [ ] **Step 1:** `npx eslint` on every file changed on the branch (`git diff --name-only cc78998f -- '*.ts' '*.tsx' | xargs npx eslint`). Fix findings.
- [ ] **Step 2:** `npx tsc -p tsconfig.typecheck.json` — clean.
- [ ] **Step 3:** Full jest: `npx jest` (sequential, alone). Record failures; compare against the same run on `cc78998f` to separate pre-existing reds (run the baseline in `~/work/kcore-setup3`, which is at `cc78998f`). New reds must be fixed.
- [ ] **Step 4:** `git grep -n "setBackgroundOpen\|onLaneChange\|readHostProbes" -- src` → nothing. `git grep -n "os.totalmem()\|availableParallelism\|os.cpus()" -- src/main ':!*__tests__*'` → only `src/main/core/host-profile.ts`.
- [ ] **Step 5:** Set the spec status line to `IMPLEMENTED (local, not released)` and commit `docs(spec): background yield implemented (#145)`.

### Task 10: Live acceptance (before any core release)

Run in a dev app built from this branch (dedicated worktree, never the shared checkout; one profile — do NOT create fresh profiles, see the cert-mint limit). Record results in the spec §5.

- [ ] macOS: during an audio/OCR backfill, `ps -o pid,pri,nice,command | grep -E 'kia-vision|whisper-cli|afconvert|Helper'` shows taskpolicy'd helpers at PRI 4 and extension hosts at nice 10; the log has the `[priority]` and `[host]` lines.
- [ ] `KIA_HOST_WEAK=1` during a Gmail + Drive first sync: Settings shows "Paused — waits until your accounts finish syncing."; no llama-server process for background work; the lane reopens and deferred OCR/audio start within one tick after the last backfill batch.
- [ ] A meeting `hear` while a background transcription runs: meeting transcript arrives promptly; the background doc is deferred, not failed, and re-driven later.
- [ ] Demoted OCR/raster under synthetic load (e.g. `yes > /dev/null` × cores): deadline hits defer, then succeed when idle — no doc ends `failed`.
- [ ] On BOTH macOS and the Windows VM, before vs after this branch: llama-server CPU/RSS during background extraction, interactive local-model latency, and foreground responsiveness (time to open Settings / run an in-app search while backfill runs).
- [ ] Windows VM prerequisite: llama-server must launch (`resolveLlamaBinary` vs accel-suffixed vendored dirs). If it does not, fix it as separate work first; this acceptance stays INCOMPLETE (no release) until the Windows CPU measurements above have run. Also check Task Manager priorities (Low / Below normal) for OCR and extension hosts.

### Task 11 (after the core release — NOT in this branch): overlay copy in alpha-cent

Runs only after core is released with this branch and `core.lock` in alpha-cent pins it (the `'until-synced'` literal does not typecheck against older core).

- File: `~/work/alpha-cent/src/overlay/renderer/components/LocalAi/local-ai-state.ts`.
- Add `'synced'` to `LocalAiKind`; before the `if (p.lane === 'until-idle')` block add:

```ts
  if (p.lane === 'until-synced') {
    return mk(
      'synced',
      'clock',
      'neutral',
      'Waits until your accounts finish syncing',
      "On this computer, reading starts after the first sync so it doesn't slow you down.",
      { right },
    );
  }
```
- Test in `src/__tests__/local-ai-state.test.ts`: `lane: 'until-synced'` → kind `'synced'`, that title.
- Typecheck + the overlay test, then commit in alpha-cent with the `core.lock` bump.
