/** A Mac that takes the lead reconciles its disk, its mirror and the manifest
 *  once, before it sorts or scans, so that it neither publishes an older
 *  version of a file nor brings back what the previous leader removed. */
import fs from 'node:fs';

import type { BatchStep } from '../../db/app-db';
import {
  readable,
  readDisk,
  UPSERT_MIRROR,
  UPSERT_ROW,
  type FileRow,
  type MirrorRow,
} from './leader-scan';
import { safeAbs, type SharedRoot } from './paths';
import { explainedRels, loadOps } from './pending';
import { judgeRoot, ROOT_NAMES, type GateDeps } from './root-state';
import { NEXT_REV } from './schema';
import type { Roots, SharedFoldersDeps } from './service';

export type PromoteDeps = Pick<SharedFoldersDeps, 'db' | 'hashFile' | 'trash' | 'log'> & Pick<GateDeps, 'gateChanged'> & {
  roots: Roots;
  /** False once the role this pass started under has changed. */
  still?: () => boolean;
};

/** `done`: the root was reconciled. `owed`: it could not be trusted (unset,
 *  missing, unreadable, or empty while the manifest has live files and this
 *  Mac had files here); nothing was touched and the reconcile is still owed. */
export type ReconcileResult = 'done' | 'owed';

type Row = FileRow & { parked: number };

async function reconcileRoot(d: PromoteDeps, root: SharedRoot, base: string): Promise<ReconcileResult> {
  if (!(await readable(base))) {
    await judgeRoot(d, root, { readable: false, rows: [], explained: () => false, evidence: true });
    return 'owed';
  }
  const rows = new Map(
    ((await d.db.all(`SELECT rel_path, sha256, bytes, missing_here, deleted, parked FROM shared_files WHERE root = ?`, [
      root,
    ])) as unknown as Row[]).map((r) => [r.rel_path, r]),
  );
  const mirror = new Map(
    ((await d.db.all(
      `SELECT rel_path, sha256, bytes, mtime_ms, capture_id FROM shared_mirror WHERE root = ?`, [root],
    )) as unknown as MirrorRow[]).map((r) => [r.rel_path, r]),
  );
  const disk = await readDisk(d, base, mirror);
  const gone = explainedRels(await loadOps(d.db, root));
  const explained = (rel: string): boolean => gone.has(rel);
  // An empty mount point is not an empty folder: this Mac had files here and
  // now lists none while the manifest has live ones.
  if (
    (await judgeRoot(d, root, { readable: true, rows: rows.values(), disk, explained, evidence: mirror.size > 0 })) ===
    'paused'
  )
    return 'owed';
  const steps: BatchStep[] = [];
  const alive = (): boolean => d.still?.() ?? true;

  /** The leader's file now. `parked` is only for a new row: an existing row keeps its flag. */
  const fromDisk = (rel: string): void => {
    const f = disk.files.get(rel)!;
    steps.push(
      { sql: UPSERT_ROW, params: [root, rel, f.sha, f.stats.size, f.iso, 0] },
      { sql: UPSERT_MIRROR, params: [root, rel, f.sha, f.stats.size, f.mtimeMs, mirror.get(rel)?.capture_id ?? null] },
    );
  };
  const setMirror = (rel: string): void => {
    const f = disk.files.get(rel)!;
    const m = mirror.get(rel);
    if (m && m.sha256 === f.sha && m.bytes === f.stats.size && m.mtime_ms === f.mtimeMs) return;
    steps.push({
      sql: UPSERT_MIRROR,
      params: [root, rel, f.sha, f.stats.size, f.mtimeMs, m?.capture_id ?? null],
    });
  };
  const dropMirror = (rel: string): void => {
    if (mirror.has(rel))
      steps.push({ sql: `DELETE FROM shared_mirror WHERE root = ? AND rel_path = ?`, params: [root, rel] });
  };
  const markMissing = (rel: string): void => {
    steps.push({
      sql: `UPDATE shared_files SET missing_here = 1, rev = ${NEXT_REV} WHERE root = ? AND rel_path = ?`,
      params: [root, rel],
    });
  };

  const rels = new Set([...rows.keys(), ...mirror.keys(), ...disk.files.keys()]);
  for (const rel of rels) {
    const r = rows.get(rel);
    const m = mirror.get(rel);
    const f = disk.files.get(rel);
    // A file that exists but could not be read, or that may sit in a folder
    // that could not be listed, is not proof of absence.
    if (!f && (disk.seen.has(rel) || disk.incomplete)) continue;

    if (!r || (r.deleted && f && !(m && m.sha256 === f.sha))) {
      if (f) fromDisk(rel);
      else dropMirror(rel);
    } else if (r.deleted) {
      if (!f) {
        dropMirror(rel);
        continue;
      }
      // Unchanged since it was last in agreement: the tombstone applies.
      // eslint-disable-next-line no-await-in-loop
      const now = await fs.promises.stat(f.abs).catch(() => null);
      if (!now || now.size !== f.stats.size || Math.floor(now.mtimeMs) !== f.mtimeMs) continue;
      if (!alive()) return 'owed';
      try {
        // eslint-disable-next-line no-await-in-loop
        await safeAbs(base, rel);
        // eslint-disable-next-line no-await-in-loop
        await d.trash(f.abs);
        dropMirror(rel);
      } catch (err) {
        d.log('warn', `could not move ${root}/${rel} to the Trash: ${String(err)}`);
      }
    } else if (!f) {
      // A file this device itself moved or removed is not "never fetched": the
      // scan that follows tombstones its row and uses up the explanation.
      if (explained(rel)) continue;
      if (!r.missing_here) markMissing(rel);
      dropMirror(rel);
    } else if (f.sha === r.sha256) {
      if (r.missing_here) {
        steps.push({
          sql: `UPDATE shared_files SET missing_here = 0, rev = ${NEXT_REV} WHERE root = ? AND rel_path = ?`,
          params: [root, rel],
        });
      }
      setMirror(rel);
    } else if (m && m.sha256 === f.sha) {
      if (!r.missing_here) markMissing(rel); // an older version: the file stays, the row is not ours to publish
    } else fromDisk(rel);
  }
  for (let i = 0; i < steps.length; i += 400) {
    if (!alive()) return 'owed'; // no longer the leader: the reconcile is still owed
    // eslint-disable-next-line no-await-in-loop
    await d.db.batch(steps.slice(i, i + 400));
  }
  return 'done';
}

export async function reconcileAtPromotion(d: PromoteDeps): Promise<Record<SharedRoot, ReconcileResult>> {
  const out: Record<SharedRoot, ReconcileResult> = { incoming: 'owed', sorted: 'owed' };
  for (const root of ROOT_NAMES) {
    const base = d.roots[root];
    // eslint-disable-next-line no-await-in-loop
    if (base) out[root] = await reconcileRoot(d, root, base);
  }
  return out;
}

/** The absolute paths of the Incoming rows a leader may sort: live, present
 *  here, not parked. */
export async function listSortable(d: Pick<SharedFoldersDeps, 'db'>, incomingAbs: string): Promise<string[]> {
  const rows = await d.db.all(
    `SELECT rel_path FROM shared_files
      WHERE root = 'incoming' AND deleted = 0 AND missing_here = 0 AND parked = 0 ORDER BY rel_path`,
  );
  const out: string[] = [];
  for (const r of rows) {
    try {
      // eslint-disable-next-line no-await-in-loop
      out.push(await safeAbs(incomingAbs, String(r.rel_path)));
    } catch {
      // a row with a path that cannot be on disk
    }
  }
  return out;
}
