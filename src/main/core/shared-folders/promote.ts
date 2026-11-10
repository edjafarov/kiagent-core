/** A Mac that takes the lead reconciles its disk, its mirror and the manifest
 *  once, before it sorts or scans, so that it neither publishes an older
 *  version of a file nor brings back what the previous leader removed. */
import fs from 'node:fs';

import type { BatchStep } from '../../db/app-db';
import {
  readDisk,
  type DiskFile,
  UPSERT_MIRROR,
  UPSERT_ROW,
  type FileRow,
  type MirrorRow,
} from './leader-scan';
import { nameKey, safeAbs, type SharedRoot } from './paths';
import { groupByName, type Group } from './groups';
import { explainedRels, loadOps } from './pending';
import { checkRoot, ROOT_NAMES, type GateDeps } from './root-state';
import { NEXT_REV } from './schema';
import type { Roots, SharedFoldersDeps } from './service';

export type PromoteDeps = Pick<SharedFoldersDeps, 'db' | 'hashFile' | 'trash' | 'log' | 'platform'> & Pick<GateDeps, 'gateChanged'> & {
  roots: Roots;
  /** False once the role this pass started under has changed. */
  still?: () => boolean;
  /** Only these roots are reconciled (the ones still owed); default both. */
  only?: ReadonlySet<SharedRoot>;
};

/** `done`: the root was reconciled completely. `owed`: it could not be trusted
 *  (unset, missing, unreadable, or empty while the manifest has live files and
 *  this Mac had files here), its listing was incomplete, or a required action
 *  failed: the reconcile is still owed, and the root stays gated (no scan, no
 *  sorting, no serving, no source) until a later try completes. */
export type ReconcileResult = 'done' | 'owed';

type Row = FileRow & { parked: number };
type Disk = DiskFile & { rel: string };
type G = Group<Disk, MirrorRow, Row>;

async function reconcileRoot(d: PromoteDeps, root: SharedRoot, base: string): Promise<ReconcileResult> {
  if ((await checkRoot(d, root, base)) !== 'ok') return 'owed';
  const key = nameKey(d.platform);
  const rowList = (await d.db.all(
    `SELECT rel_path, sha256, bytes, missing_here, deleted, parked FROM shared_files WHERE root = ?`,
    [root],
  )) as unknown as Row[];
  const mirrorList = (await d.db.all(
    `SELECT rel_path, sha256, bytes, mtime_ms, capture_id FROM shared_mirror WHERE root = ?`,
    [root],
  )) as unknown as MirrorRow[];
  const disk = await readDisk(d, base, new Map(mirrorList.map((m) => [key(m.rel_path), m])), key);
  const gone = explainedRels(await loadOps(d.db, root), key);
  const explained = (rel: string): boolean => gone.has(key(rel));
  // The listing counts only if the root was really here while it was made.
  if ((await checkRoot(d, root, base)) !== 'ok') return 'owed';
  const steps: BatchStep[] = [];
  const alive = (): boolean => d.still?.() ?? true;
  const seenKeys = new Set([...disk.seen].map(key));
  /** Something this try could not decide or do: the root is still owed, so the
   *  ordinary scan never sees it half reconciled (it would publish an older
   *  version over a newer row, or revive a tombstone). */
  let unfinished = disk.incomplete;

  /** The leader's file now, under the manifest's spelling when it has one.
   *  `parked` is only for a new row: an existing row keeps its flag. */
  const fromDisk = (g: G, f: Disk): void => {
    steps.push(
      { sql: UPSERT_ROW, params: [root, g.r?.rel_path ?? f.rel, f.sha, f.stats.size, f.iso, 0] },
      {
        sql: UPSERT_MIRROR,
        params: [root, g.m?.rel_path ?? f.rel, f.sha, f.stats.size, f.mtimeMs, g.m?.capture_id ?? null],
      },
    );
  };
  const setMirror = (g: G, f: Disk): void => {
    const { m } = g;
    if (m && m.sha256 === f.sha && m.bytes === f.stats.size && m.mtime_ms === f.mtimeMs) return;
    steps.push({
      sql: UPSERT_MIRROR,
      params: [root, m?.rel_path ?? f.rel, f.sha, f.stats.size, f.mtimeMs, m?.capture_id ?? null],
    });
  };
  const dropMirror = (g: G): void => {
    if (g.m)
      steps.push({ sql: `DELETE FROM shared_mirror WHERE root = ? AND rel_path = ?`, params: [root, g.m.rel_path] });
  };
  const markMissing = (r: Row): void => {
    steps.push({
      sql: `UPDATE shared_files SET missing_here = 1, rev = ${NEXT_REV} WHERE root = ? AND rel_path = ?`,
      params: [root, r.rel_path],
    });
  };

  const groups = groupByName(key, [...disk.files].map(([rel, f]) => ({ ...f, rel })), mirrorList, rowList);
  for (const [k, g] of groups) {
    const { r, m, f } = g;
    // A file that exists but could not be read, or that may sit in a folder
    // that could not be listed, is not proof of absence.
    if (!f && (seenKeys.has(k) || disk.incomplete)) continue;

    if (!r || (r.deleted && f && !(m && m.sha256 === f.sha))) {
      if (f) fromDisk(g, f);
      else dropMirror(g);
    } else if (r.deleted) {
      if (!f) {
        dropMirror(g);
        continue;
      }
      // Unchanged since it was last in agreement: the tombstone applies.
      // eslint-disable-next-line no-await-in-loop
      const now = await fs.promises.stat(f.abs).catch(() => null);
      if (!now || now.size !== f.stats.size || Math.floor(now.mtimeMs) !== f.mtimeMs) {
        unfinished = true; // changed while we looked: decided on the next try
        continue;
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        await safeAbs(base, f.rel);
        if (!alive()) return 'owed'; // the last look, right before the Trash
        // eslint-disable-next-line no-await-in-loop
        await d.trash(f.abs);
        dropMirror(g);
      } catch (err) {
        d.log('warn', `could not move ${root}/${f.rel} to the Trash: ${String(err)}`);
        unfinished = true;
      }
    } else if (!f) {
      // A file this device itself moved or removed is not "never fetched": the
      // scan that follows tombstones its row and uses up the explanation.
      if (explained(r.rel_path)) continue;
      if (!r.missing_here) markMissing(r);
      dropMirror(g);
    } else if (f.sha === r.sha256) {
      if (r.missing_here) {
        steps.push({
          sql: `UPDATE shared_files SET missing_here = 0, rev = ${NEXT_REV} WHERE root = ? AND rel_path = ?`,
          params: [root, r.rel_path],
        });
      }
      setMirror(g, f);
    } else if (m && m.sha256 === f.sha) {
      if (!r.missing_here) markMissing(r); // an older version: the file stays, the row is not ours to publish
    } else fromDisk(g, f);
  }
  for (let i = 0; i < steps.length; i += 400) {
    if (!alive()) return 'owed'; // no longer the leader: the reconcile is still owed
    // eslint-disable-next-line no-await-in-loop
    await d.db.batch(steps.slice(i, i + 400));
  }
  if (unfinished) d.log('info', `the ${root} folder could not be reconciled completely; reconcile pending`);
  return unfinished ? 'owed' : 'done';
}

export async function reconcileAtPromotion(d: PromoteDeps): Promise<Record<SharedRoot, ReconcileResult>> {
  const out: Record<SharedRoot, ReconcileResult> = { incoming: 'owed', sorted: 'owed' };
  for (const root of ROOT_NAMES) {
    if (d.only && !d.only.has(root)) {
      out[root] = 'done'; // not owed: an ordinary root of a leader, the scan's business
      continue;
    }
    const base = d.roots[root];
    // eslint-disable-next-line no-await-in-loop
    if (base) out[root] = await reconcileRoot(d, root, base);
  }
  return out;
}

/** The absolute paths of the Incoming rows a leader may sort: live, present
 *  here, and (unless `parkedToo`) not parked. Parking decides only whether the
 *  sorter starts on a file by itself, not whether its bytes are safe to sort. */
export async function listSortable(
  d: Pick<SharedFoldersDeps, 'db'>,
  incomingAbs: string,
  parkedToo = false,
): Promise<string[]> {
  const rows = await d.db.all(
    `SELECT rel_path FROM shared_files
      WHERE root = 'incoming' AND deleted = 0 AND missing_here = 0${parkedToo ? '' : ' AND parked = 0'} ORDER BY rel_path`,
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
