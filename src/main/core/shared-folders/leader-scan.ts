/** The leader keeps `shared_files` equal to what is on its disk under the two
 *  roots, and `shared_mirror` equal to what it just wrote there, so a Mac that
 *  stops leading already has a correct baseline. */
import fs from 'node:fs';

import type { BatchStep } from '../../db/app-db';
import { walkRoot, type WalkTrouble } from '../../sources/local-folder/scanner';
import { toRel, type SharedRoot } from './paths';
import type { SharedFoldersDeps } from './service';

export type ScanDeps = Pick<SharedFoldersDeps, 'db' | 'hashFile' | 'log'> & {
  /** A capture note waiting for a file with this hash to be listed (it was moved between roots). */
  takeNote?: (sha: string) => string | null;
  /** `<root>/<rel>` of files this device itself moved or removed since the last
   *  scan (sorting, a mirrored deletion). Their disappearance is explained. */
  explained?: ReadonlySet<string>;
};

export const INCOMING_SCANNED_KEY = 'shared-folders:incoming-scanned';

export interface FileRow {
  rel_path: string; sha256: string; missing_here: number; deleted: number;
}
export interface MirrorRow {
  rel_path: string; sha256: string; bytes: number; mtime_ms: number; capture_id: string | null;
}

const complained = new WeakMap<object, Set<string>>();

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
  VALUES(?, ?, ?, ?, ?, 0, 0, ?, ?)
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
  const told = complained.get(d.db) ?? complained.set(d.db, new Set()).get(d.db)!;
  if (!(await readable(rootAbs))) {
    if (!told.has(root)) d.log('warn', `${root} folder is missing or unreadable; its listing is left as it is`);
    told.add(root);
    return;
  }
  told.delete(root);

  const rows = new Map(
    ((await d.db.all(
      `SELECT rel_path, sha256, missing_here, deleted FROM shared_files WHERE root = ?`, [root],
    )) as unknown as FileRow[]).map((r) => [r.rel_path, r]),
  );
  const mirror = new Map(
    ((await d.db.all(
      `SELECT rel_path, sha256, bytes, mtime_ms, capture_id FROM shared_mirror WHERE root = ?`, [root],
    )) as unknown as MirrorRow[]).map((r) => [r.rel_path, r]),
  );
  const flagged = (await d.db.all(`SELECT 1 FROM meta WHERE key = ?`, [INCOMING_SCANNED_KEY])).length > 0;
  const park = root === 'incoming' && rows.size === 0 && !flagged ? 1 : 0;
  let rev = Number(
    (await d.db.all(`SELECT coalesce(max(rev), 0) AS m FROM shared_files`))[0]?.m ?? 0,
  );

  const disk = await readDisk(d, rootAbs, mirror);
  // An empty root is not believed: an unmounted volume leaves an empty mount
  // point. A root that has live rows and now lists no file at all changes
  // nothing (no tombstone, no mirror change) until a file shows up again.
  // Unless every one of them left through this device's own hands (the sorter
  // empties Incoming by moving files out).
  const unexplained = [...rows.values()].some(
    (r) => !r.deleted && !r.missing_here && !d.explained?.has(`${root}/${r.rel_path}`),
  );
  if (disk.seen.size === 0 && !disk.incomplete && unexplained) {
    if (!told.has(`empty:${root}`))
      d.log('warn', `${root} folder lists no file at all; its listing is left as it is`);
    told.add(`empty:${root}`);
    return;
  }
  told.delete(`empty:${root}`);
  const trouble = { incomplete: disk.incomplete };
  const seen = disk.seen;
  const units: BatchStep[][] = [];
  const fresh: { rel: string; sha: string; bytes: number; mtimeMs: number; step: number }[] = [];
  const noted = new Map<string, string>();

  for (const [rel, f] of disk.files) {
    const { sha, stats, mtimeMs } = f;
    const m = mirror.get(rel);
    const r = rows.get(rel);
    const write = (mirrorCapture: string | null = m?.capture_id ?? null): BatchStep[] => {
      rev += 1;
      return [
        { sql: UPSERT_ROW, params: [root, rel, sha, stats.size, f.iso, r ? 0 : park, rev] },
        { sql: UPSERT_MIRROR, params: [root, rel, sha, stats.size, mtimeMs, mirrorCapture] },
      ];
    };
    const mirrorOnly = (): BatchStep[] =>
      m && m.sha256 === sha && m.bytes === stats.size && m.mtime_ms === mtimeMs
        ? []
        : [{ sql: UPSERT_MIRROR, params: [root, rel, sha, stats.size, mtimeMs, m?.capture_id ?? null] }];

    if (!r) {
      fresh.push({ rel, sha, bytes: stats.size, mtimeMs, step: units.length });
      units.push(write());
    } else if (r.deleted) units.push(write());
    else if (r.missing_here) {
      if (sha === r.sha256) units.push(write());
      else if (m && m.sha256 === sha) continue; // an older version of the row's file: not the leader's to publish
      else units.push(write());
    } else if (sha === r.sha256) {
      const step = mirrorOnly();
      if (step.length) units.push(step);
    } else units.push(write());
  }

  if (!trouble.incomplete) {
    const gone: MirrorRow[] = [];
    for (const [rel, m] of mirror) if (!seen.has(rel)) gone.push(m);
    for (const [rel, r] of rows) {
      if (seen.has(rel) || r.deleted || r.missing_here) continue;
      rev += 1;
      units.push([
        { sql: `UPDATE shared_files SET deleted = 1, rev = ? WHERE root = ? AND rel_path = ?`, params: [rev, root, rel] },
      ]);
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
    const capture = noted.get(f.sha) ?? d.takeNote?.(f.sha);
    if (!capture) continue;
    noted.delete(f.sha);
    units[f.step][1] = { sql: UPSERT_MIRROR, params: [root, f.rel, f.sha, f.bytes, f.mtimeMs, capture] };
  }

  for (let i = 0; i < units.length; i += 200) {
    // eslint-disable-next-line no-await-in-loop
    await d.db.batch(units.slice(i, i + 200).flat());
  }
}
