/**
 * Owns the ONE killable process `query_sql` runs in (spec §3.4). A running
 * SQLite statement cannot be interrupted from JS (better-sqlite3 has no
 * sqlite3_interrupt; `worker.terminate()` waits for the native call), so the
 * only real stop is a process kill. States:
 *
 *   none → starting → ready → stopping → none      (+ stuck)
 *
 * At most ONE child exists and it is owned until its `exit` is confirmed.
 * The child is injected as a `RunnerChild` so the same machine runs over
 * Electron's utilityProcess in the app and child_process.fork in jest.
 */
import type { QuerySqlExecutor, QuerySqlResult } from './tools/query-sql';

export interface RunnerChild {
  readonly pid: number | undefined;
  send(msg: unknown): void;
  onMessage(cb: (msg: unknown) => void): void;
  onExit(cb: (code: number | null) => void): void;
  kill(signal: 'SIGTERM' | 'SIGKILL'): void;
}

export type SqlRunnerState =
  | 'none'
  | 'starting'
  | 'ready'
  | 'stopping'
  | 'stuck';

export const SQL_UNAVAILABLE = 'query_sql is unavailable right now.';
export const SQL_STILL_STOPPING =
  'query_sql is still stopping the previous query. Try again in a few seconds.';
export const sqlStoppedMessage = (timeoutMs: number): string =>
  `query_sql stopped after ${timeoutMs / 1000} s. Narrow it: filter by account or created_at, avoid LIKE over markdown, or use search.`;

export interface SqlRunRecord {
  execMs: number;
  totalMs: number;
  rows: number;
  bytes: number;
  truncated: boolean;
  timedOut: boolean;
  at: number;
}

export interface SqlRunnerDiagnostics {
  state: SqlRunnerState;
  pid: number | null;
  timeouts: number;
  recent: SqlRunRecord[];
}

export interface SqlExecutorHandle {
  exec: QuerySqlExecutor;
  stop(): Promise<void>;
  diagnostics?(): SqlRunnerDiagnostics;
}

export interface SqlRunner extends SqlExecutorHandle {
  diagnostics(): SqlRunnerDiagnostics;
}

export interface SqlRunnerOptions {
  spawn(): RunnerChild;
  /** Per statement, counted from when ITS statement starts. */
  timeoutMs: number;
  idleMs: number;
  /** Child must say ready within this (default 20 s). */
  startTimeoutMs?: number;
  /** SIGTERM → SIGKILL grace (default 2 s). */
  termGraceMs?: number;
  /** No exit this long after SIGKILL → `stuck` (default 5 s). */
  killGraceMs?: number;
  log?(level: 'info' | 'warn' | 'error', msg: string): void;
  now?(): number;
}

interface Job {
  sql: string;
  resolve(r: QuerySqlResult): void;
  reject(e: Error): void;
  enqueuedAt: number;
}

interface ChildReply {
  t?: string;
  id?: number;
  ok?: boolean;
  message?: string;
  result?: QuerySqlResult;
  bytes?: number;
  execMs?: number;
}

const RECENT = 64;

export function createSqlRunner(opts: SqlRunnerOptions): SqlRunner {
  const startTimeoutMs = opts.startTimeoutMs ?? 20_000;
  const termGraceMs = opts.termGraceMs ?? 2_000;
  const killGraceMs = opts.killGraceMs ?? 5_000;
  const log = opts.log ?? (() => {});
  const now = opts.now ?? Date.now;

  let state: SqlRunnerState = 'none';
  let child: RunnerChild | null = null;
  let closed = false;
  let nextId = 1;
  let timeouts = 0;
  const recent: SqlRunRecord[] = [];
  const queue: Job[] = [];
  let current: {
    id: number;
    job: Job;
    startedAt: number;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let startTimer: ReturnType<typeof setTimeout> | undefined;
  let termTimer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let exitWaiters: Array<() => void> = [];

  const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
  const record = (r: SqlRunRecord) => {
    recent.push(r);
    if (recent.length > RECENT) recent.shift();
  };
  const clearIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
  };
  const clearStop = () => {
    for (const t of [startTimer, termTimer, killTimer]) if (t) clearTimeout(t);
    startTimer = undefined;
    termTimer = undefined;
    killTimer = undefined;
  };
  const flushExitWaiters = () => {
    const waiters = exitWaiters;
    exitWaiters = [];
    for (const w of waiters) w();
  };

  function failAll(err: Error): void {
    if (current) {
      clearTimeout(current.timer);
      const { job } = current;
      current = null;
      job.reject(err);
    }
    for (const j of queue.splice(0)) j.reject(err);
  }

  function armIdle(): void {
    clearIdle();
    idleTimer = setTimeout(() => {
      if (state === 'ready' && !current && queue.length === 0) beginStop();
    }, opts.idleMs);
  }

  /** SIGTERM now; SIGKILL after the grace; `stuck` if it still does not exit. */
  function beginStop(): void {
    if (!child || state === 'stopping' || state === 'stuck') return;
    state = 'stopping';
    clearIdle();
    if (startTimer) clearTimeout(startTimer);
    startTimer = undefined;
    const c = child;
    c.kill('SIGTERM');
    termTimer = setTimeout(() => {
      c.kill('SIGKILL');
      killTimer = setTimeout(() => {
        state = 'stuck';
        log(
          'error',
          `[sql-runner] child pid=${c.pid} did not exit after SIGKILL — query_sql is unavailable until it does`,
        );
        failAll(new Error(SQL_UNAVAILABLE));
        flushExitWaiters();
      }, killGraceMs);
    }, termGraceMs);
  }

  function onChildExit(c: RunnerChild): void {
    if (c !== child) return;
    clearStop();
    const was = state;
    child = null;
    state = 'none';
    if (was === 'stuck') {
      log('info', '[sql-runner] stuck child finally exited — recovered');
    } else if (was !== 'stopping') {
      log('error', `[sql-runner] child exited unexpectedly (state ${was})`);
      failAll(new Error(SQL_UNAVAILABLE));
    }
    flushExitWaiters();
    pump();
  }

  function startNext(): void {
    clearIdle();
    const job = queue.shift()!;
    const id = nextId;
    nextId += 1;
    const startedAt = now();
    const timer = setTimeout(() => onTimeout(id), opts.timeoutMs);
    current = { id, job, startedAt, timer };
    child!.send({ id, sql: job.sql });
  }

  function onTimeout(id: number): void {
    if (!current || current.id !== id) return;
    const { job, startedAt } = current;
    current = null;
    timeouts += 1;
    record({
      execMs: now() - startedAt,
      totalMs: now() - job.enqueuedAt,
      rows: 0,
      bytes: 0,
      truncated: false,
      timedOut: true,
      at: now(),
    });
    job.reject(new Error(sqlStoppedMessage(opts.timeoutMs)));
    beginStop();
  }

  function finish(m: ChildReply): void {
    const { job, startedAt, timer } = current!;
    clearTimeout(timer);
    current = null;
    if (m.ok && m.result) {
      record({
        execMs: m.execMs ?? now() - startedAt,
        totalMs: now() - job.enqueuedAt,
        rows: m.result.rows.length,
        bytes: m.bytes ?? 0,
        truncated: m.result.truncated,
        timedOut: false,
        at: now(),
      });
      job.resolve(m.result);
    } else {
      job.reject(new Error(m.message ?? SQL_UNAVAILABLE));
    }
    if (queue.length > 0) startNext();
    else armIdle();
  }

  function onMessage(c: RunnerChild, raw: unknown): void {
    if (c !== child) return;
    const m = raw as ChildReply;
    if (m.t === 'ready' && state === 'starting') {
      if (startTimer) clearTimeout(startTimer);
      startTimer = undefined;
      state = 'ready';
      pump();
    } else if (m.t === 'open-error') {
      log(
        'error',
        `[sql-runner] child could not open the corpus: ${m.message ?? 'unknown'}`,
      );
      failAll(new Error(SQL_UNAVAILABLE));
      beginStop();
    } else if (typeof m.id === 'number' && current && current.id === m.id) {
      finish(m);
    }
  }

  function spawnChild(): void {
    let c: RunnerChild;
    try {
      c = opts.spawn();
    } catch (e) {
      log('error', `[sql-runner] spawn failed: ${msg(e)}`);
      failAll(new Error(SQL_UNAVAILABLE));
      return;
    }
    child = c;
    state = 'starting';
    c.onMessage((m) => onMessage(c, m));
    c.onExit(() => onChildExit(c));
    startTimer = setTimeout(() => {
      log(
        'error',
        `[sql-runner] child did not become ready within ${startTimeoutMs} ms`,
      );
      failAll(new Error(SQL_UNAVAILABLE));
      beginStop();
    }, startTimeoutMs);
  }

  function pump(): void {
    if (closed || queue.length === 0) return;
    if (state === 'none') spawnChild();
    else if (state === 'ready' && !current) startNext();
  }

  const exec: QuerySqlExecutor = (sql) =>
    new Promise<QuerySqlResult>((resolve, reject) => {
      if (closed || state === 'stuck') {
        reject(new Error(SQL_UNAVAILABLE));
        return;
      }
      if (state === 'stopping') {
        reject(new Error(SQL_STILL_STOPPING));
        return;
      }
      queue.push({ sql, resolve, reject, enqueuedAt: now() });
      pump();
    });

  return {
    exec,
    async stop() {
      closed = true;
      failAll(new Error(SQL_UNAVAILABLE));
      if (!child) return;
      beginStop();
      if (state === 'stuck') return;
      await new Promise<void>((resolve) => {
        exitWaiters.push(resolve);
      });
    },
    diagnostics: () => ({
      state,
      pid: child?.pid ?? null,
      timeouts,
      recent: recent.slice(),
    }),
  };
}
