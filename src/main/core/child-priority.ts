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
  sink?.(`[priority] ${name} ${cls} ${how}`);
}

function demote(
  pid: number | undefined,
  priority: number,
  deps: PriorityDeps,
  onFail?: (code: string) => void,
): boolean {
  if (pid === undefined) return false;
  try {
    (deps.setPriority ?? os.setPriority)(pid, priority);
    return true;
  } catch (err) {
    // ESRCH (already exited) / EPERM: demotion is best effort.
    onFail?.(String((err as { code?: unknown })?.code ?? 'error'));
    return false;
  }
}

/** Demote, then log the OUTCOME (once per name|class). */
function demoteAndNote(
  name: string,
  cls: string,
  pid: number | undefined,
  priority: number,
  deps: PriorityDeps,
): void {
  if (pid === undefined) return;
  let code = '';
  const ok = demote(pid, priority, deps, (c) => {
    code = c;
  });
  note(name, cls, ok ? 'via setPriority' : `setPriority failed: ${code}`);
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
    note(name, cls, 'via taskpolicy');
    return start(TASKPOLICY, ['-b', cmd, ...args]);
  }
  const child = start(cmd, args);
  demoteAndNote(
    name,
    cls,
    (child as { pid?: number } | undefined)?.pid,
    os.constants.priority.PRIORITY_LOW,
    deps,
  );
  return child;
}

/** Extension hosts are Electron utility processes we don't spawn ourselves:
 *  demote on their 'spawn' event. */
export function demoteHost(
  pid: number | undefined,
  deps: PriorityDeps = {},
): void {
  if (pid === undefined) return;
  demoteAndNote(
    'extension-host',
    'below-normal',
    pid,
    os.constants.priority.PRIORITY_BELOW_NORMAL,
    deps,
  );
}
