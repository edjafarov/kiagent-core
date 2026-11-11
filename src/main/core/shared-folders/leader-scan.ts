/** The leader keeps `shared_files` equal to what is on its disk under the two
 *  roots, and `shared_mirror` equal to what it just wrote there, so a Mac that
 *  stops leading already has a correct baseline. */
import fs from 'node:fs';

import type { BatchStep } from '../../db/app-db';
import { walkRoot, type WalkTrouble } from '../../sources/local-folder/scanner';
import { nameKey, toRel, type NameKey, type SharedRoot } from './paths';
import { groupByName } from './groups';
import { DELETE_OP, loadOps } from './pending';
import { checkRoot, type GateDeps } from './root-state';
import { NEXT_REV } from './schema';
import type { SharedFoldersDeps } from './service';

export type ScanDeps = Pick<SharedFoldersDeps, 'db' | 'hashFile' | 'log' | 'platform'> & Pick<GateDeps, 'gateChanged'> & {
  /** False once the role this pass started under has changed. Checked
   *  immediately before every manifest transaction. */
  still?: () => boolean;
};

export const INCOMING_SCANNED_KEY = 'shared-folders:incoming-scanned';

export interface FileRow {
  rel_path: string; sha256: string; bytes: number; missing_here: number; deleted: number;
}
export interface MirrorRow {
  rel_path: string; sha256: string; bytes: number; mtime_ms: number; capture_id: string | null;
}

export const UPSERT_ROW = `INSERT INTO shared_files(root, rel_path, sha256, bytes, mtime, missing_here, deleted, parked, rev)
  VALUES(?, ?, ?, ?, ?, 0, 0, ?, ${NEXT_REV})
  ON CONFLICT(root, rel_path) DO UPDATE SET sha256 = excluded.sha256, bytes = excluded.bytes,
    mtime = excluded.mtime, missing_here = 0, deleted = 0, rev = excluded.rev`;
export const UPSERT_MIRROR = `INSERT INTO shared_mirror(root, rel_path, sha256, bytes, mtime_ms, capture_id)
  VALUES(?, ?, ?, ?, ?, ?)
  ON CONFLICT(root, rel_path) DO UPDATE SET sha256 = excluded.sha256, bytes = excluded.bytes,
    mtime_ms = excluded.mtime_ms`;


export interface DiskFile {
  abs: string;
  sha: string;
  stats: fs.Stats;
  mtimeMs: number;
  iso: string;
}

/** Hashes of files that have no mirror entry (yet), by path, size and mtime:
 *  a copy that cannot reach the leader would otherwise hash them all again on
 *  every retry. In memory; a changed size or mtime is a miss. */
const hashCaches = new WeakMap<object, Map<string, { size: number; mtimeMs: number; sha: string }>>();
const MAX_HASHES = 5000;
const hashes = (db: object): Map<string, { size: number; mtimeMs: number; sha: string }> =>
  hashCaches.get(db) ?? hashCaches.set(db, new Map()).get(db)!;
function remember(db: object, abs: string, v: { size: number; mtimeMs: number; sha: string }): void {
  const m = hashes(db);
  m.delete(abs);
  m.set(abs, v);
  if (m.size > MAX_HASHES) m.delete(m.keys().next().value!);
}

/** Every admitted file under the root with its hash. A file whose size and
 *  mtime equal its mirror entry is not hashed again. `seen` holds every path
 *  the walk reached, also those it could not hash; `incomplete` says the
 *  listing is not proof that anything is gone. */
export async function readDisk(
  d: Pick<ScanDeps, 'hashFile' | 'db'>,
  rootAbs: string,
  /** By `key(rel)`. */
  mirror: ReadonlyMap<string, { sha256: string; bytes: number; mtime_ms: number }>,
  key: NameKey = (rel) => rel,
): Promise<{ files: Map<string, DiskFile>; seen: Set<string>; incomplete: boolean }> {
  const trouble: WalkTrouble = { incomplete: false };
  const files = new Map<string, DiskFile>();
  const seen = new Set<string>();
  for await (const { absPath, stats } of walkRoot(rootAbs, trouble)) {
    const rel = toRel(rootAbs, absPath);
    if (rel === null) continue;
    seen.add(rel);
    const mtimeMs = Math.floor(stats.mtimeMs);
    const m = mirror.get(key(rel));
    let sha: string;
    const known = hashes(d.db).get(absPath);
    if (m && m.bytes === stats.size && m.mtime_ms === mtimeMs) sha = m.sha256;
    else if (known && known.size === stats.size && known.mtimeMs === mtimeMs) sha = known.sha;
    else {
      try {
        sha = await d.hashFile(absPath);
        remember(d.db, absPath, { size: stats.size, mtimeMs, sha });
      } catch {
        trouble.incomplete = true; // vanished or locked: not proof of anything
        continue;
      }
    }
    files.set(rel, { abs: absPath, sha, stats, mtimeMs, iso: new Date(stats.mtimeMs).toISOString() });
  }
  return { files, seen, incomplete: trouble.incomplete };
}

/** One pass over one root. Does nothing while the root is not really here
 *  (see `checkRoot`: an unmounted volume is not an empty folder), and
 *  tombstones nothing when the walk could not read every folder. */
export async function scanRoot(d: ScanDeps, root: SharedRoot, rootAbs: string): Promise<void> {
  if ((await checkRoot(d, root, rootAbs)) !== 'ok') return;
  // What this device moved or removed, and the capture notes not attached yet:
  // remembered in the database until the transaction that commits what they explain.
  const key = nameKey(d.platform);
  const ops = await loadOps(d.db, root);
  const notes = new Map(ops.filter((o) => o.kind === 'note').map((o) => [`${key(o.rel_path)}\0${o.sha256}`, o]));

  const rowList = (await d.db.all(
    `SELECT rel_path, sha256, bytes, missing_here, deleted FROM shared_files WHERE root = ?`, [root],
  )) as unknown as FileRow[];
  const mirrorList = (await d.db.all(
    `SELECT rel_path, sha256, bytes, mtime_ms, capture_id FROM shared_mirror WHERE root = ?`, [root],
  )) as unknown as MirrorRow[];
  const flagged = (await d.db.all(`SELECT 1 FROM meta WHERE key = ?`, [INCOMING_SCANNED_KEY])).length > 0;
  const park = root === 'incoming' && rowList.length === 0 && !flagged ? 1 : 0;

  const disk = await readDisk(d, rootAbs, new Map(mirrorList.map((m) => [key(m.rel_path), m])), key);
  // The listing counts only if the root was really here while it was made.
  if ((await checkRoot(d, root, rootAbs)) !== 'ok') return;
  const trouble = { incomplete: disk.incomplete };
  const seenKeys = new Set([...disk.seen].map(key));
  // One group per file, whatever the case of its name: a name that differs only
  // in case is the same file on macOS and Windows, and gets no second live row.
  const groups = groupByName(key, [...disk.files].map(([rel, f]) => ({ ...f, rel })), mirrorList, rowList);
  const units: BatchStep[][] = [];
  const unitOf = new Map<string, number>();
  const put = (k: string, steps: BatchStep[]): void => {
    unitOf.set(k, units.length);
    units.push(steps);
  };
  const fresh: { rel: string; sha: string; bytes: number; mtimeMs: number; step: number }[] = [];
  const noted = new Map<string, { capture: string; rel: string }>();

  for (const [k, g] of groups) {
    const { f, m, r } = g;
    if (!f) continue;
    const { sha, stats, mtimeMs, rel } = f;
    const rrel = r?.rel_path ?? rel; // the manifest's spelling wins
    const mrel = m?.rel_path ?? rel; // a mirror entry keeps its spelling
    const write = (mirrorCapture: string | null = m?.capture_id ?? null): BatchStep[] => {
      return [
        { sql: UPSERT_ROW, params: [root, rrel, sha, stats.size, f.iso, r ? 0 : park] },
        { sql: UPSERT_MIRROR, params: [root, mrel, sha, stats.size, mtimeMs, mirrorCapture] },
      ];
    };
    const mirrorOnly = (): BatchStep[] =>
      m && m.sha256 === sha && m.bytes === stats.size && m.mtime_ms === mtimeMs
        ? []
        : [{ sql: UPSERT_MIRROR, params: [root, mrel, sha, stats.size, mtimeMs, m?.capture_id ?? null] }];

    if (!r) {
      fresh.push({ rel: mrel, sha, bytes: stats.size, mtimeMs, step: units.length });
      put(k, write());
    } else if (r.deleted) put(k, write());
    else if (r.missing_here) {
      if (sha === r.sha256) put(k, write());
      else if (m && m.sha256 === sha) {
        // an older version of the row's file: not the leader's to publish
      } else put(k, write());
    } else if (sha === r.sha256) {
      const step = mirrorOnly();
      if (step.length) put(k, step);
    } else put(k, write());

    // A capture note for these very bytes at this very path joins the mirror
    // entry in the transaction that writes (or finds) it, and is used up there.
    const note = notes.get(`${key(rel)}\0${sha}`);
    if (note) {
      const steps: BatchStep[] = [];
      if (!m?.capture_id)
        steps.push({
          sql: `UPDATE shared_mirror SET capture_id = ? WHERE root = ? AND rel_path = ? AND capture_id IS NULL`,
          params: [note.capture_id, root, mrel],
        });
      steps.push({ sql: DELETE_OP, params: [note.id] });
      const at = unitOf.get(k);
      if (at !== undefined) units[at].push(...steps);
      else put(k, steps);
    }
  }

  if (!trouble.incomplete) {
    const gone: MirrorRow[] = mirrorList.filter((m) => !seenKeys.has(key(m.rel_path)));
    const used = new Set<number>();
    for (const [k, g] of groups) {
      const r = g.r;
      if (!r || g.f || seenKeys.has(k) || r.deleted || r.missing_here) continue;
      // The move or removal that explains this absence is used up with the tombstone.
      const why = ops.filter((o) => o.kind !== 'note' && key(o.rel_path) === key(r.rel_path));
      for (const o of why) used.add(o.id);
      units.push([
        { sql: `UPDATE shared_files SET deleted = 1, rev = ${NEXT_REV} WHERE root = ? AND rel_path = ?`, params: [root, r.rel_path] },
        ...why.map((o) => ({ sql: DELETE_OP, params: [o.id] })),
      ]);
    }
    // An explanation with nothing left to explain (the row is not live, or the
    // file is back) is dropped.
    for (const o of ops) {
      if (o.kind === 'note' || used.has(o.id)) continue;
      const r = groups.get(key(o.rel_path))?.r;
      if (!r || r.deleted || r.missing_here || seenKeys.has(key(o.rel_path))) units.push([{ sql: DELETE_OP, params: [o.id] }]);
    }
    for (const m of gone) {
      const row = groups.get(key(m.rel_path))?.r;
      if (row?.missing_here) continue;
      units.push([{ sql: `DELETE FROM shared_mirror WHERE root = ? AND rel_path = ?`, params: [root, m.rel_path] }]);
    }
    // A rename is a deleted row and a new one; the capture note follows the bytes.
    for (const m of gone) if (m.capture_id && !noted.has(m.sha256)) noted.set(m.sha256, { capture: m.capture_id, rel: m.rel_path });
    if (root === 'incoming' && !flagged) {
      units.push([
        { sql: `INSERT OR IGNORE INTO meta(key, value) VALUES(?, '1')`, params: [INCOMING_SCANNED_KEY] },
      ]);
    }
  }

  // A rename on this Mac: the note of the entry that vanished follows the bytes.
  for (const f of fresh) {
    const n = noted.get(f.sha);
    if (!n) continue;
    noted.delete(f.sha);
    units[f.step][1] = { sql: UPSERT_MIRROR, params: [root, f.rel, f.sha, f.bytes, f.mtimeMs, n.capture] };
  }
  // The entry's file left this folder (the sorter moved it, and `moved()` has
  // not been called yet): the capture note stays, at the old path, for it.
  for (const [sha, n] of noted) {
    units.push([
      { sql: `INSERT INTO shared_pending(kind, root, rel_path, sha256, capture_id) VALUES('note', ?, ?, ?, ?)`, params: [root, n.rel, sha, n.capture] },
    ]);
  }

  for (let i = 0; i < units.length; i += 200) {
    if (!(d.still?.() ?? true)) return; // no longer the leader: nothing more is written
    // eslint-disable-next-line no-await-in-loop
    await d.db.batch(units.slice(i, i + 200).flat());
  }
}
