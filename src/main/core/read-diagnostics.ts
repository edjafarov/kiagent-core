/**
 * Internal diagnosis for the read plane (spec §3.6) — NOT acceptance: the
 * acceptance numbers come from the external probe (scripts/mcp-latency-probe.mjs).
 * Shows whether a reader statement (count/countBy/broad search) is the slow
 * part, whether the writer fallback fired, what the SQL runner is doing, and
 * whether the WAL is growing because a reader snapshot is blocking checkpoints.
 */
import fs from 'node:fs';

import type { SqlRunnerDiagnostics } from './mcp/sql-runner';
import type { ReadStats, ReadStatsSnapshot } from './store/read-proxy';

export interface ReadDiagnostics {
  /** Includes `reads.fuzzyRuns`: the reader's cumulative fuzzy-pass executions. */
  reads: ReadStatsSnapshot;
  sql: SqlRunnerDiagnostics | null;
  walBytes: number | null;
}

export async function buildReadDiagnostics(deps: {
  stats: ReadStats;
  walPath: string;
  sql?: SqlRunnerDiagnostics | null;
  statFile?: (p: string) => Promise<{ size: number }>;
  now?: number;
}): Promise<ReadDiagnostics> {
  const statFile = deps.statFile ?? ((p: string) => fs.promises.stat(p));
  let walBytes: number | null = null;
  try {
    walBytes = (await statFile(deps.walPath)).size;
  } catch {
    walBytes = null;
  }
  return {
    reads: deps.stats.snapshot(deps.now),
    sql: deps.sql ?? null,
    walBytes,
  };
}

/** Acceptance aid (KIA_READ_DIAG_FILE): rewrite `file` with a fresh snapshot
 *  every `intervalMs`. Each file carries `snapshotAt` (ms epoch, taken BEFORE
 *  the snapshot), so a reader can wait for a snapshot that reflects calls it
 *  made earlier. Failures are swallowed — diagnostics never break the app. */
export function startReadDiagnosticsDump(
  file: string,
  snapshot: () => Promise<unknown>,
  intervalMs: number,
): () => void {
  const write = async () => {
    try {
      const snapshotAt = Date.now();
      const snap = (await snapshot()) as Record<string, unknown>;
      // tmp + rename: a reader never sees a truncated file mid-write.
      const tmp = `${file}.tmp`;
      await fs.promises.writeFile(
        tmp,
        JSON.stringify({ ...snap, snapshotAt }, null, 2),
      );
      await fs.promises.rename(tmp, file);
    } catch {
      /* best effort */
    }
  };
  void write();
  const timer = setInterval(() => void write(), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
