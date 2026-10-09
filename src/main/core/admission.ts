/**
 * The ONE owner of background admission (#147 spec §2, §5). It admits
 * background UNITS — `ingest | convert | reconcile | redrive`, each "work in
 * hand plus one bounded write" — and owns the enrichment lane, which
 * `backgroundLaneState` (boot.ts) projects, the inference gate waits on
 * (`foregroundIdle`), and the worker pre-flights read. No other module
 * decides whether background work may run.
 *
 * Vision and audio are NOT units here: they are enrichment, lane-gated, and
 * their heavy work runs in demoted helper processes.
 */
import type { AppPrefs, LaneState, SchedulerEnv } from '@shared/contracts';

import { abortError } from './abort';

export type UnitKind = 'ingest' | 'convert' | 'reconcile' | 'redrive';

export const FOREGROUND_GRACE_MS = 300;
export const MAX_FOREGROUND_WAIT_MS = 10_000;
export const KIND_AGING_MS = 5_000;
export const SLOW_MODE_MAX_HOLD_MS = 2_000;

const RANK: Record<UnitKind, number> = {
  ingest: 0,
  convert: 1,
  reconcile: 2,
  redrive: 3,
};

/** What the enrichment lane is computed from — read live on every call. */
export interface EnrichmentInputs {
  processing(): AppPrefs['processing'];
  env(): Pick<SchedulerEnv, 'onBattery' | 'userActive'>;
  weak(): boolean;
  syncing(): boolean;
}

export interface AdmissionSnapshot {
  slots: number;
  /** Units in flight, slow-mode holds included. */
  running: number;
  held: number;
  foregroundInFlight: number;
  foregroundBusy: boolean;
  waiting: Record<UnitKind, number>;
  admitted: Record<UnitKind, number>;
  /** Cumulative ms waited, by kind. */
  waitMs: Record<UnitKind, number>;
  starvationEscapes: number;
  slowModeHoldMs: number;
  enrichmentWaits: number;
  enrichmentWaitMs: number;
}

export interface Admission {
  /** Resolves, once a slot is free, to `release()` (idempotent). Rejects
   *  `AbortError` when `signal` fires first. Never call it while holding an
   *  account-flow lock or inside a transaction. */
  acquire(kind: UnitKind, signal: AbortSignal): Promise<() => void>;
  /** Enter a foreground call; returns its (idempotent) leave. */
  foreground(): () => void;
  /** A foreground call is in flight, or left less than the grace ago. */
  foregroundBusy(): boolean;
  /** Resolves when not busy, or after MAX_FOREGROUND_WAIT_MS; rejects on abort. */
  foregroundIdle(signal?: AbortSignal): Promise<void>;
  /** The enrichment lane (was boot.ts backgroundLaneState's body). */
  enrichmentLane(now?: Date): LaneState;
  snapshot(): AdmissionSnapshot;
}

export interface AdmissionDeps {
  /** hostBudget().ingestSlots. */
  slots: number;
  /** scheduler.env.userActive — slow mode. */
  userActive(): boolean;
  enrichment: EnrichmentInputs;
  now?(): number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(t: unknown): void;
}

interface Waiter {
  kind: UnitKind;
  enq: number;
  resolve(release: () => void): void;
  reject(e: Error): void;
  signal: AbortSignal;
  onAbort(): void;
}

interface IdleWaiter {
  finish(err?: Error): void;
}

const byKind = (): Record<UnitKind, number> => ({
  ingest: 0,
  convert: 0,
  reconcile: 0,
  redrive: 0,
});

export function createAdmission(deps: AdmissionDeps): Admission {
  const now = deps.now ?? Date.now;
  const setTimer =
    deps.setTimer ??
    ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return t;
    });
  const clearTimer =
    deps.clearTimer ??
    ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));

  const waiters: Waiter[] = [];
  const idleWaiters = new Set<IdleWaiter>();
  let running = 0;
  let held = 0;
  let escapedRunning = 0;
  let fgInFlight = 0;
  let fgLastLeave = Number.NEGATIVE_INFINITY;
  let wake: unknown = null;
  const admitted = byKind();
  const waitMs = byKind();
  let starvationEscapes = 0;
  let slowModeHoldMs = 0;
  let enrichmentWaits = 0;
  let enrichmentWaitMs = 0;

  const foregroundBusy = (): boolean =>
    fgInFlight > 0 || now() - fgLastLeave < FOREGROUND_GRACE_MS;

  /** Which waiter (if any) may start now. */
  function pickNext(): { index: number; escaped: boolean } | null {
    const t = now();
    let best = -1;
    if (foregroundBusy()) {
      // Rule 1 anti-starvation: one escaped unit at a time.
      if (escapedRunning > 0) return null;
      waiters.forEach((w, i) => {
        if (
          t - w.enq >= MAX_FOREGROUND_WAIT_MS &&
          (best < 0 || w.enq < waiters[best].enq)
        )
          best = i;
      });
      return best < 0 ? null : { index: best, escaped: true };
    }
    // Rule 2 aging: a waiter past KIND_AGING_MS goes ahead of every younger one.
    waiters.forEach((w, i) => {
      if (t - w.enq >= KIND_AGING_MS && (best < 0 || w.enq < waiters[best].enq))
        best = i;
    });
    if (best >= 0) return { index: best, escaped: false };
    waiters.forEach((w, i) => {
      if (
        best < 0 ||
        RANK[w.kind] < RANK[waiters[best].kind] ||
        (RANK[w.kind] === RANK[waiters[best].kind] && w.enq < waiters[best].enq)
      )
        best = i;
    });
    return best < 0 ? null : { index: best, escaped: false };
  }

  function admit(w: Waiter, escaped: boolean): void {
    w.signal.removeEventListener('abort', w.onAbort);
    running += 1;
    if (escaped) {
      escapedRunning += 1;
      starvationEscapes += 1;
    }
    const t0 = now();
    waitMs[w.kind] += t0 - w.enq;
    admitted[w.kind] += 1;
    let released = false;
    w.resolve(() => {
      if (released) return;
      released = true;
      if (escaped) escapedRunning -= 1;
      // Rule 3 slow mode: sync slows for an active user but never stops.
      const factor = deps.slots === 1 ? 1 : 0.25;
      const hold = deps.userActive()
        ? Math.min(SLOW_MODE_MAX_HOLD_MS, factor * (now() - t0))
        : 0;
      if (hold > 0) {
        held += 1;
        slowModeHoldMs += hold;
        setTimer(() => {
          held -= 1;
          running -= 1;
          pump();
        }, hold);
      } else {
        running -= 1;
        pump();
      }
    });
  }

  function pump(): void {
    while (running < deps.slots && waiters.length > 0) {
      const pick = pickNext();
      if (!pick) break;
      const [w] = waiters.splice(pick.index, 1);
      admit(w, pick.escaped);
    }
    armWake();
  }

  /** One timer at the next moment something may change: the grace ending
   *  (idle waiters resolve, units may start) or a waiter's starvation
   *  deadline. Aging needs no timer — it only reorders at a release. */
  function armWake(): void {
    if (wake !== null) {
      clearTimer(wake);
      wake = null;
    }
    if (waiters.length === 0 && idleWaiters.size === 0) return;
    if (!foregroundBusy()) return;
    let at = Number.POSITIVE_INFINITY;
    if (fgInFlight === 0) at = fgLastLeave + FOREGROUND_GRACE_MS;
    if (escapedRunning === 0 && running < deps.slots)
      for (const w of waiters)
        at = Math.min(at, w.enq + MAX_FOREGROUND_WAIT_MS);
    if (!Number.isFinite(at)) return;
    wake = setTimer(
      () => {
        wake = null;
        if (!foregroundBusy()) for (const iw of [...idleWaiters]) iw.finish();
        pump();
      },
      Math.max(0, at - now()),
    );
  }

  function enrichmentLane(at = new Date()): LaneState {
    const p = deps.enrichment.processing();
    if (!p.enabled) return 'disabled';
    const env = deps.enrichment.env();
    if (env.onBattery) return 'battery';
    if (deps.enrichment.weak() && deps.enrichment.syncing())
      return 'until-synced';
    switch (p.window) {
      case 'always':
        return 'open';
      case 'night': {
        const h = at.getHours();
        return h >= 22 || h < 7 ? 'open' : 'until-night';
      }
      case 'idle':
      default:
        return env.userActive ? 'until-idle' : 'open';
    }
  }

  return {
    acquire(kind, signal) {
      if (signal.aborted) return Promise.reject(abortError());
      return new Promise<() => void>((resolve, reject) => {
        const w: Waiter = {
          kind,
          enq: now(),
          resolve,
          reject,
          signal,
          onAbort: () => {
            const i = waiters.indexOf(w);
            if (i < 0) return;
            waiters.splice(i, 1);
            reject(abortError());
            armWake();
          },
        };
        signal.addEventListener('abort', w.onAbort, { once: true });
        waiters.push(w);
        pump();
      });
    },

    foreground() {
      fgInFlight += 1;
      armWake();
      let left = false;
      return () => {
        if (left) return;
        left = true;
        fgInFlight -= 1;
        if (fgInFlight === 0) fgLastLeave = now();
        armWake();
      };
    },

    foregroundBusy,

    foregroundIdle(signal) {
      if (signal?.aborted) return Promise.reject(abortError());
      if (!foregroundBusy()) return Promise.resolve();
      enrichmentWaits += 1;
      const t0 = now();
      return new Promise<void>((resolve, reject) => {
        let cap: unknown = null;
        const onAbort = () => entry.finish(abortError());
        const entry: IdleWaiter = {
          finish(err) {
            if (!idleWaiters.delete(entry)) return;
            if (cap !== null) clearTimer(cap);
            signal?.removeEventListener('abort', onAbort);
            enrichmentWaitMs += now() - t0;
            if (err) reject(err);
            else resolve();
          },
        };
        idleWaiters.add(entry);
        cap = setTimer(() => entry.finish(), MAX_FOREGROUND_WAIT_MS);
        signal?.addEventListener('abort', onAbort, { once: true });
        armWake();
      });
    },

    enrichmentLane,

    snapshot() {
      const waiting = byKind();
      for (const w of waiters) waiting[w.kind] += 1;
      return {
        slots: deps.slots,
        running,
        held,
        foregroundInFlight: fgInFlight,
        foregroundBusy: foregroundBusy(),
        waiting,
        admitted: { ...admitted },
        waitMs: { ...waitMs },
        starvationEscapes,
        slowModeHoldMs,
        enrichmentWaits,
        enrichmentWaitMs,
      };
    },
  };
}

const EMPTY_SNAPSHOT: AdmissionSnapshot = {
  slots: 0,
  running: 0,
  held: 0,
  foregroundInFlight: 0,
  foregroundBusy: false,
  waiting: byKind(),
  admitted: byKind(),
  waitMs: byKind(),
  starvationEscapes: 0,
  slowModeHoldMs: 0,
  enrichmentWaits: 0,
  enrichmentWaitMs: 0,
};

/** The default for every optional `admission` dep: admits at once. */
export const NOOP_ADMISSION: Admission = {
  acquire: (_kind, signal) =>
    signal.aborted ? Promise.reject(abortError()) : Promise.resolve(() => {}),
  foreground: () => () => {},
  foregroundBusy: () => false,
  foregroundIdle: (signal) =>
    signal?.aborted ? Promise.reject(abortError()) : Promise.resolve(),
  enrichmentLane: () => 'open',
  snapshot: () => EMPTY_SNAPSHOT,
};

/** Run `fn` as one foreground call (MCP tools/call, resources/read, the
 *  renderer's search/get/children). Leaves on throw too. */
export async function inForeground<T>(
  admission: Pick<Admission, 'foreground'> | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const leave = admission?.foreground();
  try {
    return await fn();
  } finally {
    leave?.();
  }
}
