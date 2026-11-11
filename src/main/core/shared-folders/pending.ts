/** The pending operations table (see `SHARED_PENDING_DDL`). */
import type { AppDb } from '../../db/app-db';
import type { NameKey, SharedRoot } from './paths';

export interface PendingOp {
  id: number;
  kind: 'moved' | 'removed' | 'note';
  root: SharedRoot;
  rel_path: string;
  sha256: string;
  capture_id: string | null;
}

export const DELETE_OP = `DELETE FROM shared_pending WHERE id = ?`;
const MAX_NOTES = 2000;

export async function loadOps(db: AppDb, root: SharedRoot): Promise<PendingOp[]> {
  return (await db.all(
    `SELECT id, kind, root, rel_path, sha256, capture_id FROM shared_pending WHERE root = ? ORDER BY id`,
    [root],
  )) as unknown as PendingOp[];
}

/** The files of `root` whose disappearance this device explains. */
export const explainedRels = (ops: readonly PendingOp[], key: NameKey = (rel) => rel): Set<string> =>
  new Set(ops.filter((o) => o.kind !== 'note').map((o) => key(o.rel_path)));

export async function recordGone(
  db: AppDb,
  kind: 'moved' | 'removed',
  from: { root: SharedRoot; rel: string },
  sha: string,
  to: { root: SharedRoot; rel: string } | null,
): Promise<void> {
  await db.run(
    `INSERT INTO shared_pending(kind, root, rel_path, sha256, to_root, to_rel) VALUES(?, ?, ?, ?, ?, ?)`,
    [kind, from.root, from.rel, sha, to?.root ?? null, to?.rel ?? null],
  );
}

/** One note per file: a later note for the same path replaces the earlier. */
export async function recordNote(
  db: AppDb,
  at: { root: SharedRoot; rel: string },
  sha: string,
  captureId: string,
): Promise<void> {
  await db.batch([
    { sql: `DELETE FROM shared_pending WHERE kind = 'note' AND root = ? AND rel_path = ?`, params: [at.root, at.rel] },
    {
      sql: `INSERT INTO shared_pending(kind, root, rel_path, sha256, capture_id) VALUES('note', ?, ?, ?, ?)`,
      params: [at.root, at.rel, sha, captureId],
    },
    {
      sql: `DELETE FROM shared_pending WHERE kind = 'note' AND id <= (
              SELECT id FROM shared_pending WHERE kind = 'note' ORDER BY id DESC LIMIT 1 OFFSET ${MAX_NOTES})`,
    },
  ]);
}

/** The note for this file, when its bytes are the ones the note was made for. */
export async function noteFor(
  db: AppDb,
  root: SharedRoot,
  rel: string,
  sha: string,
): Promise<{ id: number; capture_id: string } | null> {
  const row = (await db.all(
    `SELECT id, capture_id FROM shared_pending WHERE kind = 'note' AND root = ? AND rel_path = ? AND sha256 = ?`,
    [root, rel, sha],
  ))[0];
  return row ? { id: Number(row.id), capture_id: String(row.capture_id) } : null;
}
