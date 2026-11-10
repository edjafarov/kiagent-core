/** Whether a shared root may be trusted right now. A root that is not there,
 *  not readable, or that suddenly lists nothing while the manifest holds live
 *  files (an unmounted volume leaves an empty mount point) is not an empty
 *  folder: nothing is tombstoned, marked, dropped, sent or accepted for it. */
import type { AppDb } from '../../db/app-db';
import type { SharedRoot } from './paths';

export const ROOT_NAMES: readonly SharedRoot[] = ['incoming', 'sorted'];

/** The roots whose reconcile at promotion has not run yet. Local. A value of
 *  `1` (older builds) means both. */
export const OWED_KEY = 'shared-folders:reconcile-pending';

/** Thrown by `serve.*` for a root that is owed its reconcile or paused: the
 *  route turns it into "try again later" (HTTP 503 with `Retry-After`). */
export class SharedRootPaused extends Error {
  readonly code = 'SHARED_ROOT_PAUSED';

  constructor(
    readonly root: SharedRoot,
    readonly reason: 'owed' | 'paused',
  ) {
    super(
      `shared-folders: the ${root} folder is ${reason === 'owed' ? 'waiting for its first check' : 'paused'}; try again later`,
    );
  }
}

const isRoot = (s: unknown): s is SharedRoot => s === 'incoming' || s === 'sorted';

export async function loadRootSet(db: AppDb, key: string): Promise<Set<SharedRoot>> {
  const row = (await db.all(`SELECT value FROM meta WHERE key = ?`, [key]))[0];
  if (!row) return new Set();
  try {
    const j: unknown = JSON.parse(String(row.value));
    if (Array.isArray(j)) return new Set(j.filter(isRoot));
  } catch {
    // an unreadable note is the strictest one
  }
  return new Set(ROOT_NAMES);
}

export async function saveRootSet(db: AppDb, key: string, set: ReadonlySet<SharedRoot>): Promise<void> {
  if (set.size === 0) {
    await db.run(`DELETE FROM meta WHERE key = ?`, [key]);
    return;
  }
  await db.run(
    `INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, JSON.stringify([...set].sort())],
  );
}

/** A listing that is empty while the manifest has live files here that nothing
 *  explains. `explained(rel)` is true for a file this device itself moved or
 *  removed. A walk that could not read every folder proves nothing. */
export function emptyIsSuspect(
  rows: Iterable<{ rel_path: string; deleted: number; missing_here: number }>,
  disk: { seen: ReadonlySet<string>; incomplete: boolean },
  explained: (rel: string) => boolean,
): boolean {
  if (disk.seen.size > 0 || disk.incomplete) return false;
  for (const r of rows) if (!r.deleted && !r.missing_here && !explained(r.rel_path)) return true;
  return false;
}
