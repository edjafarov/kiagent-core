/** The leader keeps `shared_files` equal to what is on its disk under the two
 *  roots, and `shared_mirror` equal to what it just wrote there, so a Mac that
 *  stops leading already has a correct baseline. */
import fs from 'node:fs';

import type { BatchStep } from '../../db/app-db';
import { walkRoot, type WalkTrouble } from '../../sources/local-folder/scanner';
import { toRel, type SharedRoot } from './paths';
import { DELETE_OP, explainedRels, loadOps } from './pending';
import { judgeRoot, type GateDeps } from './root-state';
import { NEXT_REV } from './schema';
import type { SharedFoldersDeps } from './service';

export type ScanDeps = Pick<SharedFoldersDeps, 'db' | 'hashFile' | 'log'> & Pick<GateDeps, 'gateChanged'> & {
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

export async function readable(rootAbs: string): Promise<boolean> {
  try {
    if (!(await fs.promises.stat(rootAbs)).isDirectory()) return false;
    await fs.promises.readdir(rootAbs);
    return true;
  } catch {
    return false;
  }
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

/** Every admitted file under the root with its hash. A file whose size and
 *  mtime equal its mirror entry is not hashed again. `seen` holds every path
 *  the walk reached, also those it could not hash; `incomplete` says the
 *  listing is not proof that anything is gone. */
export async function readDisk(
  d: Pick<ScanDeps, 'hashFile'>,
  rootAbs: string,
  mirror: ReadonlyMap<string, { sha256: string; bytes: number; mtime_ms: number }>,
): Promise<{ files: Map<string, DiskFile>; seen: Set<string>; incomplete: boolean }> {
  const trouble: WalkTrouble = { incomplete: false };
  const files = new Map<string, DiskFile>();
  const seen = new Set<string>();
  for await (const { absPath, stats } of walkRoot(rootAbs, trouble)) {
    const rel = toRel(rootAbs, absPath);
    if (rel === null) continue;
    seen.add(rel);
    const mtimeMs = Math.floor(stats.mtimeMs);
    const m = mirror.get(rel);
    let sha: string;
    if (m && m.bytes === stats.size && m.mtime_ms === mtimeMs) sha = m.sha256;
    else {
      try {
        sha = await d.hashFile(absPath);
      } catch {
        trouble.incomplete = true; // vanished or locked: not proof of anything
        continue;
      }
    }
    files.set(rel, { abs: absPath, sha, stats, mtimeMs, iso: new Date(stats.mtimeMs).toISOString() });
  }
  return { files, seen, incomplete: trouble.incomplete };
}

/** One pass over one root. Does nothing when the root is missing or unreadable
 *  (an unmounted volume is not an empty folder), and tombstones nothing when
 *  the walk could not read every folder. */
export async function scanRoot(d: ScanDeps, root: SharedRoot, rootAbs: string): Promise<void> {
  if (!(await readable(rootAbs))) {
    await judgeRoot(d, root, { readable: false, rows: [], explained: () => false, evidence: true });
    return;
  }
  // What this device moved or removed, and the capture notes not attached yet:
  // remembered in the database until the transaction that commits what they explain.
  const ops = await loadOps(d.db, root);
  const explainedSet = explainedRels(ops);
  const explained = (rel: string): boolean => explainedSet.has(rel);
  const notes = new Map(ops.filter((o) => o.kind === 'note').map((o) => [`${o.rel_path}\0${o.sha256}`, o]));

  const rows = new Map(
    ((await d.db.all(
      `SELECT rel_path, sha256, bytes, missing_here, deleted FROM shared_files WHERE root = ?`, [root],
    )) as unknown as FileRow[]).map((r) => [r.rel_path, r]),
  );
  const mirror = new Map(
    ((await d.db.all(
      `SELECT rel_path, sha256, bytes, mtime_ms, capture_id FROM shared_mirror WHERE root = ?`, [root],
    )) as unknown as MirrorRow[]).map((r) => [r.rel_path, r]),
  );
  const flagged = (await d.db.all(`SELECT 1 FROM meta WHERE key = ?`, [INCOMING_SCANNED_KEY])).length > 0;
  const park = root === 'incoming' && rows.size === 0 && !flagged ? 1 : 0;

  const disk = await readDisk(d, rootAbs, mirror);
  // A root that is not trusted right now (see `judgeRoot`: an unmounted volume
  // leaves an empty mount point) changes nothing: no tombstone, no mirror change.
  if ((await judgeRoot(d, root, { readable: true, rows: rows.values(), disk, explained, evidence: true })) === 'paused')
    return;
  const trouble = { incomplete: disk.incomplete };
  const seen = disk.seen;
  const units: BatchStep[][] = [];
  const unitOf = new Map<string, number>();
  const put = (rel: string, steps: BatchStep[]): void => {
    unitOf.set(rel, units.length);
    units.push(steps);
  };
  const fresh: { rel: string; sha: string; bytes: number; mtimeMs: number; step: number }[] = [];
  const noted = new Map<string, string>();

  for (const [rel, f] of disk.files) {
    const { sha, stats, mtimeMs } = f;
    const m = mirror.get(rel);
    const r = rows.get(rel);
    const write = (mirrorCapture: string | null = m?.capture_id ?? null): BatchStep[] => {
      return [
        { sql: UPSERT_ROW, params: [root, rel, sha, stats.size, f.iso, r ? 0 : park] },
        { sql: UPSERT_MIRROR, params: [root, rel, sha, stats.size, mtimeMs, mirrorCapture] },
      ];
    };
    const mirrorOnly = (): BatchStep[] =>
      m && m.sha256 === sha && m.bytes === stats.size && m.mtime_ms === mtimeMs
        ? []
        : [{ sql: UPSERT_MIRROR, params: [root, rel, sha, stats.size, mtimeMs, m?.capture_id ?? null] }];

    if (!r) {
      fresh.push({ rel, sha, bytes: stats.size, mtimeMs, step: units.length });
      put(rel, write());
    } else if (r.deleted) put(rel, write());
    else if (r.missing_here) {
      if (sha === r.sha256) put(rel, write());
      else if (m && m.sha256 === sha) {
        // an older version of the row's file: not the leader's to publish
      } else put(rel, write());
    } else if (sha === r.sha256) {
      const step = mirrorOnly();
      if (step.length) put(rel, step);
    } else put(rel, write());

    // A capture note for these very bytes at this very path joins the mirror
    // entry in the transaction that writes (or finds) it, and is used up there.
    const note = notes.get(`${rel}\0${sha}`);
    if (note) {
      const steps: BatchStep[] = [];
      if (!m?.capture_id)
        steps.push({
          sql: `UPDATE shared_mirror SET capture_id = ? WHERE root = ? AND rel_path = ? AND capture_id IS NULL`,
          params: [note.capture_id, root, rel],
        });
      steps.push({ sql: DELETE_OP, params: [note.id] });
      const at = unitOf.get(rel);
      if (at !== undefined) units[at].push(...steps);
      else put(rel, steps);
    }
  }

  if (!trouble.incomplete) {
    const gone: MirrorRow[] = [];
    for (const [rel, m] of mirror) if (!seen.has(rel)) gone.push(m);
    const used = new Set<number>();
    for (const [rel, r] of rows) {
      if (seen.has(rel) || r.deleted || r.missing_here) continue;
      // The move or removal that explains this absence is used up with the tombstone.
      const why = ops.filter((o) => o.kind !== 'note' && o.rel_path === rel);
      for (const o of why) used.add(o.id);
      units.push([
        { sql: `UPDATE shared_files SET deleted = 1, rev = ${NEXT_REV} WHERE root = ? AND rel_path = ?`, params: [root, rel] },
        ...why.map((o) => ({ sql: DELETE_OP, params: [o.id] })),
      ]);
    }
    // An explanation with nothing left to explain (the row is not live, or the
    // file is back) is dropped.
    for (const o of ops) {
      if (o.kind === 'note' || used.has(o.id)) continue;
      const r = rows.get(o.rel_path);
      if (!r || r.deleted || r.missing_here || seen.has(o.rel_path)) units.push([{ sql: DELETE_OP, params: [o.id] }]);
    }
    for (const m of gone) {
      const row = rows.get(m.rel_path);
      if (row?.missing_here) continue;
      units.push([{ sql: `DELETE FROM shared_mirror WHERE root = ? AND rel_path = ?`, params: [root, m.rel_path] }]);
    }
    // A rename is a deleted row and a new one; the capture note follows the bytes.
    for (const m of gone) if (m.capture_id && !noted.has(m.sha256)) noted.set(m.sha256, m.capture_id);
    if (root === 'incoming' && !flagged) {
      units.push([
        { sql: `INSERT OR IGNORE INTO meta(key, value) VALUES(?, '1')`, params: [INCOMING_SCANNED_KEY] },
      ]);
    }
  }

  // A file that came from another root has its note in the service's hands.
  for (const f of fresh) {
    if (mirror.has(f.rel)) continue;
    const capture = noted.get(f.sha);
    if (!capture) continue;
    noted.delete(f.sha);
    units[f.step][1] = { sql: UPSERT_MIRROR, params: [root, f.rel, f.sha, f.bytes, f.mtimeMs, capture] };
  }

  for (let i = 0; i < units.length; i += 200) {
    if (!(d.still?.() ?? true)) return; // no longer the leader: nothing more is written
    // eslint-disable-next-line no-await-in-loop
    await d.db.batch(units.slice(i, i + 200).flat());
  }
}
