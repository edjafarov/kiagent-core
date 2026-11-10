/** The manifest row of a path. On macOS and Windows (where `key` folds case)
 *  any spelling of the name matches, a live row before a tombstone; the row's
 *  own spelling is what the caller should use as the file's identity. */
import type { AppDb } from '../../db/app-db';
import type { NameKey, SharedRoot } from './paths';

export type FoundRow = {
  rel_path: string;
  sha256: string;
  deleted: number;
  missing_here: number;
  parked: number;
};

export async function rowAt(db: AppDb, key: NameKey, root: SharedRoot, rel: string): Promise<FoundRow | undefined> {
  const COLS = `rel_path, sha256, deleted, missing_here, parked`;
  const exact = (await db.all(`SELECT ${COLS} FROM shared_files WHERE root = ? AND rel_path = ?`, [root, rel]))[0] as
    | FoundRow
    | undefined;
  if (key('Ab') === 'Ab' || (exact && !exact.deleted)) return exact;
  const k = key(rel);
  const all = (await db.all(`SELECT ${COLS} FROM shared_files WHERE root = ?`, [root])) as unknown as FoundRow[];
  const hits = all.filter((r) => key(r.rel_path) === k);
  return hits.find((r) => !r.deleted) ?? hits[0];
}
