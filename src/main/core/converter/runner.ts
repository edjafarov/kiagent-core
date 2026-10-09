/**
 * Supervisor of the ONE `kia-converter` child (#136, spec §1), modelled on
 * the #146 SQL runner (mcp/sql-runner.ts) but with per-job attribution: a
 * crash or timeout fails only the ACTIVE job; queued jobs wait for the
 * replacement child. One job runs at a time; the queue is bounded by input
 * bytes. Spawn/infrastructure failures are transient
 * (ConverterUnavailableError) and pause spawning for SPAWN_BACKOFF_MS so a
 * missing or blocked bundle never respawns a process per document.
 */
import { abortError } from '../abort';
import type { RunnerChild } from '../mcp/sql-runner';
import {
  ConverterCrashedError,
  ConverterTimeoutError,
  ConverterUnavailableError,
  p95,
  pushRecent,
  type Converter,
  type ParseResult,
} from './converter';
import type { RasterResult } from './parsers';
import type { ConverterJob, ConverterReply } from './protocol';

export const CONVERTER_TIMEOUT_MS = 120_000;
export const CONVERTER_IDLE_MS = 300_000;
export const MAX_QUEUED_BYTES = 128 * 1024 * 1024;
export const SPAWN_BACKOFF_MS = 30_000;

export interface ConverterRunnerOptions {
  spawn(): RunnerChild;
  /** Wall clock per job (bootCore doubles it on 1-slot hosts). */
  timeoutMs?: number;
  idleMs?: number;
  maxQueuedBytes?: number;
  /** Child must say ready within this (default 20 s). */
  startTimeoutMs?: number;
  /** SIGTERM → SIGKILL grace (default 2 s). */
  termGraceMs?: number;
  /** No exit this long after SIGKILL → drop the child and move on (default 5 s). */
  killGraceMs?: number;
  spawnBackoffMs?: number;
  log?(level: 'info' | 'warn' | 'error', msg: string): void;
  now?(): number;
}

type State = 'none' | 'starting' | 'ready' | 'stopping';

interface Job {
  job: ConverterJob;
  bytes: number;
  resolve(v: unknown): void;
  reject(e: Error): void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface SpaceWaiter {
  bytes: number;
  resolve(): void;
  reject(e: Error): void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export function createConverterRunner(opts: ConverterRunnerOptions): Converter {
  const timeoutMs = opts.timeoutMs ?? CONVERTER_TIMEOUT_MS;
  const idleMs = opts.idleMs ?? CONVERTER_IDLE_MS;
  const maxQueuedBytes = opts.maxQueuedBytes ?? MAX_QUEUED_BYTES;
  const startTimeoutMs = opts.startTimeoutMs ?? 20_000;
  const termGraceMs = opts.termGraceMs ?? 2_000;
  const killGraceMs = opts.killGraceMs ?? 5_000;
  const spawnBackoffMs = opts.spawnBackoffMs ?? SPAWN_BACKOFF_MS;
  const log = opts.log ?? (() => {});
  const now = opts.now ?? Date.now;

  let state: State = 'none';
  let child: RunnerChild | null = null;
  let closed = false;
  let nextId = 1;
  let unavailableUntil = 0;
  const queue: Job[] = [];
  const spaceWaiters: SpaceWaiter[] = [];
  let queuedBytes = 0; // queued + active
  let active: {
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
  const stats = {
    jobs: 0,
    crashes: 0,
    timeouts: 0,
    cancels: 0,
    unavailable: 0,
  };
  const recent: number[] = [];

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
    const w = exitWaiters;
    exitWaiters = [];
    for (const f of w) f();
  };

  const fits = (bytes: number) =>
    queuedBytes === 0 || queuedBytes + bytes <= maxQueuedBytes;

  /** Grants capacity to waiters in FIFO order. The bytes are reserved HERE,
   *  synchronously with the grant, so a later grant in the same loop (or a
   *  concurrent submit) never sees space a woken waiter is about to use. */
  function wakeSpaceWaiters(): void {
    while (spaceWaiters.length > 0 && fits(spaceWaiters[0].bytes)) {
      const w = spaceWaiters.shift()!;
      if (w.onAbort) w.signal?.removeEventListener('abort', w.onAbort);
      queuedBytes += w.bytes;
      w.resolve();
    }
  }

  /** Give back a reservation that never became a queued job. */
  function unreserve(bytes: number): void {
    queuedBytes -= bytes;
    wakeSpaceWaiters();
  }

  /** A job leaves the books (finished, failed, cancelled). */
  function settle(j: Job): void {
    if (j.onAbort) j.signal?.removeEventListener('abort', j.onAbort);
    queuedBytes -= j.bytes;
    wakeSpaceWaiters();
  }

  function failQueued(err: Error): void {
    for (const j of queue.splice(0)) {
      settle(j);
      j.reject(err);
    }
  }

  function armIdle(): void {
    clearIdle();
    idleTimer = setTimeout(() => {
      if (state === 'ready' && !active && queue.length === 0) beginStop();
    }, idleMs);
    idleTimer.unref?.();
  }

  function beginStop(): void {
    if (!child || state === 'stopping') return;
    state = 'stopping';
    clearIdle();
    if (startTimer) clearTimeout(startTimer);
    startTimer = undefined;
    const c = child;
    c.kill('SIGTERM');
    termTimer = setTimeout(() => {
      c.kill('SIGKILL');
      killTimer = setTimeout(() => {
        if (child !== c) return;
        log(
          'error',
          `[converter] child pid=${c.pid} did not exit after SIGKILL — abandoning it`,
        );
        child = null;
        state = 'none';
        flushExitWaiters();
        pump();
      }, killGraceMs);
    }, termGraceMs);
  }

  function unavailable(reason: string): void {
    stats.unavailable += 1;
    unavailableUntil = now() + spawnBackoffMs;
    log('error', `[converter] unavailable: ${reason}`);
    failQueued(
      new ConverterUnavailableError(`converter unavailable: ${reason}`),
    );
  }

  function onChildExit(c: RunnerChild, code: number | null): void {
    if (c !== child) return;
    clearStop();
    const was = state;
    child = null;
    state = 'none';
    if (active) {
      const { job, timer } = active;
      clearTimeout(timer);
      active = null;
      stats.crashes += 1;
      settle(job);
      log(
        'warn',
        `[converter] child exited (code ${code}) mid-job — failing that job only`,
      );
      job.reject(
        new ConverterCrashedError(
          `converter exited (code ${code}) while converting`,
        ),
      );
    } else if (was === 'starting') {
      unavailable(`child exited (code ${code}) before it was ready`);
    } else if (was !== 'stopping') {
      log('warn', `[converter] child exited unexpectedly (code ${code})`);
    }
    flushExitWaiters();
    pump();
  }

  function startNext(): void {
    clearIdle();
    const job = queue.shift()!;
    const id = nextId;
    nextId += 1;
    const timer = setTimeout(() => onTimeout(id), timeoutMs);
    active = { id, job, startedAt: now(), timer };
    child!.send({ id, ...job.job });
  }

  function onTimeout(id: number): void {
    if (!active || active.id !== id) return;
    const { job } = active;
    active = null;
    stats.timeouts += 1;
    settle(job);
    job.reject(
      new ConverterTimeoutError(
        `converter timed out after ${timeoutMs / 1000} s`,
      ),
    );
    beginStop();
  }

  function onMessage(c: RunnerChild, raw: unknown): void {
    if (c !== child) return;
    const m = raw as ConverterReply;
    if ('t' in m && m.t === 'ready' && state === 'starting') {
      if (startTimer) clearTimeout(startTimer);
      startTimer = undefined;
      state = 'ready';
      pump();
      return;
    }
    if (!('id' in m) || !active || active.id !== m.id) return;
    const { job, timer, startedAt } = active;
    clearTimeout(timer);
    active = null;
    stats.jobs += 1;
    pushRecent(recent, now() - startedAt);
    settle(job);
    if (m.ok) job.resolve(m.result);
    else {
      const e = new Error(m.message);
      e.name = m.name;
      job.reject(e);
    }
    if (queue.length > 0) startNext();
    else armIdle();
  }

  function spawnChild(): void {
    let c: RunnerChild;
    try {
      c = opts.spawn();
    } catch (e) {
      unavailable(
        `spawn failed: ${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    }
    child = c;
    state = 'starting';
    c.onMessage((m) => onMessage(c, m));
    c.onExit((code) => onChildExit(c, code));
    startTimer = setTimeout(() => {
      unavailable(`child not ready within ${startTimeoutMs} ms`);
      beginStop();
    }, startTimeoutMs);
  }

  function pump(): void {
    if (closed || queue.length === 0) return;
    if (state === 'none') {
      if (now() < unavailableUntil) {
        failQueued(
          new ConverterUnavailableError('converter unavailable (backing off)'),
        );
        return;
      }
      spawnChild();
    } else if (state === 'ready' && !active) startNext();
  }

  function cancel(j: Job): void {
    const i = queue.indexOf(j);
    if (i >= 0) {
      queue.splice(i, 1);
      stats.cancels += 1;
      settle(j);
      j.reject(abortError());
      return;
    }
    if (active?.job === j) {
      clearTimeout(active.timer);
      active = null;
      stats.cancels += 1;
      settle(j);
      j.reject(abortError());
      beginStop(); // abandon the work; the next job respawns
    }
  }

  /** Resolves once `bytes` of capacity are RESERVED for the caller (counted
   *  in queuedBytes). The immediate path reserves synchronously too, so N
   *  submits in one tick can never all see the same free space. A rejected
   *  wait holds no reservation. */
  function reserveSpace(bytes: number, signal?: AbortSignal): Promise<void> {
    if (fits(bytes) && spaceWaiters.length === 0) {
      queuedBytes += bytes;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const w: SpaceWaiter = { bytes, resolve, reject, signal };
      if (signal) {
        w.onAbort = () => {
          const i = spaceWaiters.indexOf(w);
          if (i >= 0) spaceWaiters.splice(i, 1);
          stats.cancels += 1;
          reject(abortError());
        };
        signal.addEventListener('abort', w.onAbort, { once: true });
      }
      spaceWaiters.push(w);
    });
  }

  async function submit(
    job: ConverterJob,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (closed) throw new ConverterUnavailableError('converter stopped');
    if (signal?.aborted) {
      stats.cancels += 1;
      throw abortError();
    }
    if (state === 'none' && now() < unavailableUntil)
      throw new ConverterUnavailableError(
        'converter unavailable (backing off)',
      );
    const bytes = job.bytes.byteLength;
    await reserveSpace(bytes, signal);
    // The grant resolved before this continuation ran, and the waiter's abort
    // listener is already gone: a stop() or an abort in between is seen only
    // here. Give the reservation back instead of queueing into a closed or
    // cancelled runner.
    if (closed) {
      unreserve(bytes);
      throw new ConverterUnavailableError('converter stopped');
    }
    if (signal?.aborted) {
      unreserve(bytes);
      stats.cancels += 1;
      throw abortError();
    }
    return new Promise((resolve, reject) => {
      const j: Job = { job, bytes, resolve, reject, signal };
      if (signal) {
        j.onAbort = () => cancel(j);
        signal.addEventListener('abort', j.onAbort, { once: true });
      }
      queue.push(j); // its bytes were reserved by reserveSpace
      pump();
    });
  }

  return {
    parseDetailed: (bytes, mime, filename, signal) =>
      submit(
        { op: 'parseDetailed', bytes, mime, filename },
        signal,
      ) as Promise<ParseResult>,
    parsePdfPages: (bytes, signal) =>
      submit({ op: 'parsePdfPages', bytes }, signal) as Promise<string[]>,
    rasterizePdf: (bytes, pages, o) =>
      submit(
        { op: 'rasterizePdf', bytes, pages, maxEdge: o?.maxEdge },
        o?.signal,
      ) as Promise<RasterResult>,
    stats: () => ({
      mode: 'child',
      state,
      pid: child?.pid ?? null,
      ...stats,
      queued: queue.length,
      queuedBytes,
      p95Ms: p95(recent),
    }),
    async stop() {
      closed = true;
      const err = new ConverterUnavailableError('converter stopped');
      // Waiters first: failQueued's settle() would otherwise grant them
      // reservations only to have submit() give them back.
      for (const w of spaceWaiters.splice(0)) {
        if (w.onAbort) w.signal?.removeEventListener('abort', w.onAbort);
        w.reject(err);
      }
      failQueued(err);
      if (active) {
        const { job, timer } = active;
        clearTimeout(timer);
        active = null;
        settle(job);
        job.reject(err);
      }
      clearIdle();
      if (!child) return;
      const done = new Promise<void>((resolve) => exitWaiters.push(resolve));
      beginStop();
      await done;
    },
  };
}
