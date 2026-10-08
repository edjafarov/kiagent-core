/**
 * Main-side half of the read worker (spec §3.3 / §3.5 / §3.6): a thin proxy
 * whose methods call the reader's `read` procedure, one wrapper that turns
 * every reader failure mode into "use the writer", and the per
 * caller x method statistics that diagnose it.
 */
import type { Query } from '@shared/contracts';

import type { AppDb } from '../../db/app-db';
import { DB_WORKER_CRASHED, DB_WORKER_DEAD } from '../../db/worker-client';
import { QUERY_METHODS, type QueryMethod } from './corpus-query';

export type ReadCaller = 'mcp' | 'renderer' | 'other';
export type ReadVia = 'reader' | 'writer';
export type FallbackReason = 'open-failed' | 'crashed' | 'dead';
export type ReadMode = 'reader' | 'writer';

export interface ReadRecord {
  caller: ReadCaller;
  method: QueryMethod;
  via: ReadVia;
  /** Time inside the reader's statement(s); equals totalMs on the writer. */
  execMs: number;
  /** Request to answer, as main saw it (includes queueing on either side). */
  totalMs: number;
  at: number;
  /** The reader worker's cumulative fuzzy-pass executions (reader path only). */
  fuzzyRuns?: number;
}

export interface ReadGroupStats {
  caller: ReadCaller;
  method: QueryMethod;
  via: ReadVia;
  count: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  execP95Ms: number;
  newestAgeMs: number;
}

export interface ReadStatsSnapshot {
  mode: ReadMode;
  groups: ReadGroupStats[];
  fallbacks: Record<FallbackReason, number>;
  /** Latest cumulative fuzzy-pass count reported by the reader (0 until a read ran). */
  fuzzyRuns: number;
}

export interface ReadStats {
  record(r: ReadRecord): void;
  fallback(reason: FallbackReason): void;
  setMode(mode: ReadMode): void;
  snapshot(now?: number): ReadStatsSnapshot;
}

const STATS_WINDOW = 256;

const percentile = (sorted: number[], p: number): number =>
  sorted.length === 0
    ? 0
    : sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];

export function createReadStats(window = STATS_WINDOW): ReadStats {
  const ring: ReadRecord[] = [];
  const fallbacks: Record<FallbackReason, number> = {
    'open-failed': 0,
    crashed: 0,
    dead: 0,
  };
  let mode: ReadMode = 'reader';
  let fuzzyRuns = 0;
  return {
    record(r) {
      if (r.fuzzyRuns !== undefined) fuzzyRuns = r.fuzzyRuns;
      ring.push(r);
      if (ring.length > window) ring.shift();
    },
    fallback(reason) {
      fallbacks[reason] += 1;
    },
    setMode(m) {
      mode = m;
    },
    snapshot(now = Date.now()) {
      const byKey = new Map<string, ReadRecord[]>();
      for (const r of ring) {
        const key = `${r.caller}|${r.method}|${r.via}`;
        const list = byKey.get(key);
        if (list) list.push(r);
        else byKey.set(key, [r]);
      }
      const groups: ReadGroupStats[] = [...byKey.values()].map((list) => {
        const total = list.map((r) => r.totalMs).sort((a, b) => a - b);
        const exec = list.map((r) => r.execMs).sort((a, b) => a - b);
        const newest = Math.max(...list.map((r) => r.at));
        return {
          caller: list[0].caller,
          method: list[0].method,
          via: list[0].via,
          count: list.length,
          p50Ms: percentile(total, 0.5),
          p95Ms: percentile(total, 0.95),
          maxMs: total[total.length - 1],
          execP95Ms: percentile(exec, 0.95),
          newestAgeMs: now - newest,
        };
      });
      return { mode, groups, fallbacks: { ...fallbacks }, fuzzyRuns };
    },
  };
}

/** A `Query` whose every method goes through one async invoker. */
export function queryFromInvoker(
  invoke: (method: QueryMethod, args: unknown[]) => Promise<unknown>,
): Query {
  const q: Record<string, unknown> = {};
  for (const m of QUERY_METHODS) {
    q[m] = (...args: unknown[]) => invoke(m, args);
  }
  return q as unknown as Query;
}

export function createReadProxy(
  readDb: AppDb,
  stats: ReadStats,
  caller: ReadCaller,
): Query {
  return queryFromInvoker(async (method, args) => {
    const t0 = performance.now();
    const res = (await readDb.proc!('read', { method, args })) as {
      value: unknown;
      execMs: number;
      fuzzyRuns?: number;
    };
    stats.record({
      caller,
      method,
      via: 'reader',
      execMs: res.execMs,
      totalMs: performance.now() - t0,
      at: Date.now(),
      fuzzyRuns: res.fuzzyRuns,
    });
    return res.value;
  });
}

type Invokable = Record<QueryMethod, (...a: unknown[]) => Promise<unknown>>;

export function withWriterFallback(deps: {
  proxy: ((caller: ReadCaller) => Query) | null;
  writer: Query;
  stats: ReadStats;
  log(level: 'warn' | 'error', msg: string): void;
  /** Why the reader could not be opened (only with `proxy: null`). */
  openError?: string;
}): { for(caller: ReadCaller): Query; mode(): ReadMode } {
  const { proxy, writer, stats, log } = deps;
  let sticky = proxy === null;
  if (proxy === null) {
    stats.fallback('open-failed');
    stats.setMode('writer');
    log(
      'warn',
      `[db] read worker unavailable: ${deps.openError ?? 'unknown error'} — reads use the writer`,
    );
  }
  const goSticky = (): void => {
    if (sticky) return;
    sticky = true;
    stats.setMode('writer');
    log('error', '[db] read worker is dead — reads use the writer');
  };
  const viaWriter = writer as unknown as Invokable;

  return {
    mode: () => (sticky ? 'writer' : 'reader'),
    for(caller) {
      const viaProxy = proxy ? (proxy(caller) as unknown as Invokable) : null;
      return queryFromInvoker(async (method, args) => {
        if (!sticky && viaProxy) {
          try {
            return await viaProxy[method](...args);
          } catch (e) {
            const code = (e as { code?: string } | null)?.code;
            if (code !== DB_WORKER_CRASHED && code !== DB_WORKER_DEAD) throw e;
            stats.fallback(code === DB_WORKER_DEAD ? 'dead' : 'crashed');
            if (code === DB_WORKER_DEAD) goSticky();
            // fall through: the writer answers this call, once
          }
        }
        const t0 = performance.now();
        const value = await viaWriter[method](...args);
        const ms = performance.now() - t0;
        stats.record({
          caller,
          method,
          via: 'writer',
          execMs: ms,
          totalMs: ms,
          at: Date.now(),
        });
        return value;
      });
    },
  };
}
