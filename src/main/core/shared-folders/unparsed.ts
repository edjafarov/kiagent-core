/** Rows the `shared-folder` source could not turn into a document. The source
 *  moves its cursor past a row whether or not it could parse it, so a row that
 *  failed (its file was locked, or held other bytes than the row names) would
 *  never be looked at again. The source reports such a row here; the leader's
 *  pass gives it a new revision, so the source sees it again, as soon as the
 *  file can be opened and the file's stat has changed or at least a minute has
 *  passed since it was reported (a file that stays unreadable is tried once a
 *  minute at most, and costs nothing while it cannot be opened). */
import fs from 'node:fs';

import type { AppDb } from '../../db/app-db';
import { safeAbs, type SharedRoot } from './paths';
import { NEXT_REV } from './schema';
import type { Roots, SharedFoldersDeps } from './service';

export interface UnparsedEntry {
  key: string;
  root: SharedRoot;
  rel: string;
  /** The row's hash when it was reported: a row that changed since was re-listed by the scan. */
  sha: string;
  /** `size:mtimeMs` of the file when it was reported. */
  sig: string;
  /** When it was reported or last re-stamped. */
  at: number;
}
export type Unparsed = Map<string, UnparsedEntry>;

const KEY = 'shared-folders:unparsed';
const EVERY_MS = 60_000;

export async function loadUnparsed(db: AppDb): Promise<Unparsed> {
  const m: Unparsed = new Map();
  try {
    const j: unknown = JSON.parse(String((await db.all(`SELECT value FROM meta WHERE key = ?`, [KEY]))[0]?.value ?? '[]'));
    if (Array.isArray(j)) for (const e of j) if (e && typeof e.key === 'string') m.set(e.key, e as UnparsedEntry);
  } catch {
    // an unreadable note is the same as none
  }
  return m;
}

const persist = async (db: AppDb, m: Unparsed): Promise<void> => {
  if (m.size === 0) await db.run(`DELETE FROM meta WHERE key = ?`, [KEY]);
  else
    await db.run(`INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [
      KEY,
      JSON.stringify([...m.values()]),
    ]);
};

const sigOf = async (abs: string): Promise<string> => {
  try {
    const st = await fs.promises.stat(abs);
    return `${st.size}:${Math.floor(st.mtimeMs)}`;
  } catch {
    return '';
  }
};

export async function reportUnparsed(
  d: Pick<SharedFoldersDeps, 'db' | 'now'> & { roots: Roots },
  m: Unparsed,
  refs: { root: SharedRoot; relPath: string }[],
): Promise<void> {
  for (const ref of refs) {
    const base = d.roots[ref.root];
    if (!base) continue;
    // eslint-disable-next-line no-await-in-loop
    const row = (await d.db.all(`SELECT sha256, deleted, missing_here FROM shared_files WHERE root = ? AND rel_path = ?`, [
      ref.root,
      ref.relPath,
    ]))[0];
    if (!row || row.deleted || row.missing_here) continue;
    let abs: string;
    try {
      // eslint-disable-next-line no-await-in-loop
      abs = await safeAbs(base, ref.relPath);
    } catch {
      continue;
    }
    const key = `${ref.root}/${ref.relPath}`;
    // eslint-disable-next-line no-await-in-loop
    m.set(key, { key, root: ref.root, rel: ref.relPath, sha: String(row.sha256), sig: await sigOf(abs), at: d.now() });
  }
  await persist(d.db, m);
}

/** One round: give the reported rows that can be tried again a new revision. */
export async function restamp(
  d: Pick<SharedFoldersDeps, 'db' | 'now'> & { roots: Roots; usable(root: SharedRoot): boolean; still(): boolean },
  m: Unparsed,
): Promise<void> {
  if (m.size === 0) return;
  let changed = false;
  for (const e of [...m.values()]) {
    const base = d.roots[e.root];
    if (!base || !d.usable(e.root)) continue; // not now; kept
    // eslint-disable-next-line no-await-in-loop
    const row = (await d.db.all(`SELECT sha256, deleted, missing_here FROM shared_files WHERE root = ? AND rel_path = ?`, [
      e.root,
      e.rel,
    ]))[0];
    if (!row || row.deleted || row.missing_here || String(row.sha256) !== e.sha) {
      m.delete(e.key); // gone, or the scan has listed a newer version already
      changed = true;
      continue;
    }
    let abs: string;
    try {
      // eslint-disable-next-line no-await-in-loop
      abs = await safeAbs(base, e.rel);
      // eslint-disable-next-line no-await-in-loop
      const fh = await fs.promises.open(abs, 'r');
      // eslint-disable-next-line no-await-in-loop
      await fh.close();
    } catch {
      continue; // cannot be opened: tried again later, at no cost
    }
    // eslint-disable-next-line no-await-in-loop
    const sig = await sigOf(abs);
    if (sig === e.sig && d.now() - e.at < EVERY_MS) continue;
    if (!d.still()) return;
    // eslint-disable-next-line no-await-in-loop
    await d.db.run(
      `UPDATE shared_files SET rev = ${NEXT_REV} WHERE root = ? AND rel_path = ? AND deleted = 0 AND missing_here = 0`,
      [e.root, e.rel],
    );
    m.delete(e.key); // the source reports it again if it fails again
    changed = true;
  }
  if (changed) await persist(d.db, m);
}
