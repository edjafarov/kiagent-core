/** A copy mirrors the leader's two folders. For each path it compares three
 *  things: the file on disk (D), what this Mac last had in agreement with the
 *  leader (M, the `shared_mirror` entry) and the leader's row (R). A user's
 *  file is only ever removed through the injected `trash`, and only while it
 *  still equals M. */
import fs from 'node:fs';
import path from 'node:path';

import type { BatchStep } from '../../db/app-db';
import {
  readable,
  readDisk,
  UPSERT_MIRROR,
  type DiskFile,
  type FileRow,
  type MirrorRow,
} from './leader-scan';
import { safeAbs, STAGING_DIR, type SharedRoot } from './paths';
import { DELETE_OP, noteFor } from './pending';
import { judgeRoot, type GateDeps } from './root-state';
import type { Roots, SharedFoldersDeps, SharedTransport } from './service';

export type MirrorDeps = Pick<
  SharedFoldersDeps,
  'db' | 'hashFile' | 'trash' | 'log'
> &
  Pick<GateDeps, 'gateChanged'> & {
    roots: Roots;
    /** False once this Mac is no longer a copy; checked before every action. */
    still?: () => boolean;
  };

/** The pass was told to stop (the role changed): it ends without side effects. */
class Stopped extends Error {}
const check = (d: MirrorDeps): void => {
  if (!(d.still?.() ?? true)) throw new Stopped('shared-folders: the role changed');
};

type Row = FileRow & { bytes: number; mtime: string };

/** The network failed: the pass ends and is retried later. Anything else that
 *  goes wrong is about one path, and only that path is skipped. */
class TransportFailed extends Error {
  constructor(readonly inner: unknown) {
    super(String(inner));
  }
}
const viaTransport = async <T>(p: Promise<T>): Promise<T> => {
  try {
    return await p;
  } catch (err) {
    throw new TransportFailed(err);
  }
};

/** Does the path still hold exactly what M describes (or nothing)? Used just
 *  before a downloaded file replaces it and before a mirrored removal. */
async function stillMirrored(
  d: MirrorDeps,
  abs: string,
  m: MirrorRow | undefined,
): Promise<'absent' | 'same' | 'changed'> {
  let st: fs.Stats;
  try {
    st = await fs.promises.stat(abs);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'absent'
      : 'changed';
  }
  if (!st.isFile() || !m) return 'changed';
  if (st.size === m.bytes && Math.floor(st.mtimeMs) === m.mtime_ms)
    return 'same';
  try {
    return (await d.hashFile(abs)) === m.sha256 ? 'same' : 'changed';
  } catch {
    return 'changed';
  }
}

async function mirrorRoot(
  d: MirrorDeps,
  root: SharedRoot,
  base: string,
  transport: SharedTransport,
): Promise<void> {
  const explained = (): boolean => false; // a copy never sorts, and its own removals leave no live row
  if (!(await readable(base))) {
    await judgeRoot(d, root, { readable: false, rows: [], explained, evidence: true });
    return;
  }
  const rows = new Map(
    (
      (await d.db.all(
        `SELECT rel_path, sha256, bytes, mtime, missing_here, deleted FROM shared_files WHERE root = ?`,
        [root],
      )) as unknown as Row[]
    ).map((r) => [r.rel_path, r]),
  );
  const mirror = new Map(
    (
      (await d.db.all(
        `SELECT rel_path, sha256, bytes, mtime_ms, capture_id FROM shared_mirror WHERE root = ?`,
        [root],
      )) as unknown as MirrorRow[]
    ).map((r) => [r.rel_path, r]),
  );
  const disk = await readDisk(d, base, mirror);

  // A root that is not trusted right now (an unmounted volume leaves an empty
  // mount point) sends nothing and removes nothing; a new copy with no file
  // yet is not that, it fetches.
  if (
    (await judgeRoot(d, root, { readable: true, rows: rows.values(), disk, explained, evidence: mirror.size > 0 })) ===
    'paused'
  )
    return;

  const dropMirror = async (rel: string): Promise<void> => {
    await d.db.run(
      `DELETE FROM shared_mirror WHERE root = ? AND rel_path = ?`,
      [root, rel],
    );
  };

  const offers: string[] = [];
  const trashes: string[] = [];
  const removals: string[] = [];
  const fetches: string[] = [];
  const refresh: BatchStep[] = [];
  const drops: string[] = [];

  const rels = new Set([
    ...disk.files.keys(),
    ...mirror.keys(),
    ...rows.keys(),
  ]);
  for (const rel of [...rels].sort()) {
    const f = disk.files.get(rel);
    const m = mirror.get(rel);
    const r = rows.get(rel);
    // Unreadable, or possibly in a folder that could not be listed: no proof of absence.
    if (!f && (disk.seen.has(rel) || disk.incomplete)) continue;
    const live = r && !r.deleted;
    const here = live && !r.missing_here; // the leader holds these bytes

    if (f && m) {
      if (f.sha !== m.sha256)
        offers.push(rel); // changed here: offered first, nothing else for this path
      else if (!r)
        offers.push(rel); // the leader has never seen it
      else if (r.deleted) trashes.push(rel);
      else if (r.missing_here) {
        if (r.sha256 === f.sha) offers.push(rel); // the leader lacks these bytes: supply them
      } else {
        if (r.sha256 !== f.sha) fetches.push(rel);
        if (m.bytes !== f.stats.size || m.mtime_ms !== f.mtimeMs)
          refresh.push({
            sql: UPSERT_MIRROR,
            params: [root, rel, f.sha, f.stats.size, f.mtimeMs, m.capture_id],
          });
      }
    } else if (f) {
      if (!live) offers.push(rel);
      else if (r.sha256 === f.sha && !r.missing_here) {
        refresh.push({
          sql: UPSERT_MIRROR,
          params: [root, rel, f.sha, f.stats.size, f.mtimeMs, null],
        }); // adopt
      } else offers.push(rel);
    } else if (m) {
      if (here && r.sha256 === m.sha256) removals.push(rel);
      else if (here) fetches.push(rel);
      else if (!live) drops.push(rel);
    } else if (here) fetches.push(rel);
  }

  const forPath = async (
    rel: string,
    act: () => Promise<void>,
  ): Promise<void> => {
    try {
      check(d);
      await act();
    } catch (err) {
      if (err instanceof TransportFailed || err instanceof Stopped) throw err;
      d.log('warn', `${root}/${rel}: ${String(err)}`);
    }
  };

  for (const rel of offers) {
    // eslint-disable-next-line no-await-in-loop
    await forPath(rel, async () => {
      const f = disk.files.get(rel)!;
      const m = mirror.get(rel);
      // A scan this Mac filed itself has no mirror entry yet: its capture id
      // is in a note for these very bytes at this very path.
      const note = m?.capture_id ? null : await noteFor(d.db, root, rel, f.sha);
      const captureId = m?.capture_id ?? note?.capture_id ?? null;
      const answer = await viaTransport(
        transport.offer(
          {
            root,
            relPath: rel,
            sha256: f.sha,
            base: m?.sha256 ?? null,
            captureId,
          },
          f.abs,
        ),
      );
      check(d);
      if (answer === 'have-it') {
        if ((await d.hashFile(f.abs)) !== f.sha) return;
        check(d);
        await d.trash(f.abs);
        await dropMirror(rel);
        if (note) await d.db.run(DELETE_OP, [note.id]);
        return;
      }
      await d.db.batch([
        { sql: UPSERT_MIRROR, params: [root, rel, f.sha, f.stats.size, f.mtimeMs, captureId] },
        ...(note ? [{ sql: DELETE_OP, params: [note.id] }] : []),
      ]);
    });
  }
  check(d);
  if (refresh.length) await d.db.batch(refresh);
  for (const rel of drops) {
    // eslint-disable-next-line no-await-in-loop
    await dropMirror(rel);
  }

  for (const rel of trashes) {
    // eslint-disable-next-line no-await-in-loop
    await forPath(rel, async () => {
      const abs = await safeAbs(base, rel);
      const m = mirror.get(rel);
      // D = M proves the user did not touch it, also when this Mac missed an
      // edit before the deletion. Checked again just before it goes.
      const now = await stillMirrored(d, abs, m);
      if (now === 'changed') return;
      check(d);
      if (now === 'same') await d.trash(abs);
      await dropMirror(rel);
    });
  }

  for (const rel of removals) {
    // eslint-disable-next-line no-await-in-loop
    await forPath(rel, async () => {
      const m = mirror.get(rel)!;
      if ((await stillMirrored(d, await safeAbs(base, rel), m)) !== 'absent') return;
      check(d);
      await viaTransport(
        transport.remove({ root, relPath: rel, sha256: m.sha256 }),
      );
      await dropMirror(rel);
    });
  }

  for (const rel of fetches) {
    // eslint-disable-next-line no-await-in-loop
    await forPath(rel, () =>
      fetchOne(d, root, base, rel, rows.get(rel)!, mirror.get(rel), transport),
    );
  }
}

async function fetchOne(
  d: MirrorDeps,
  root: SharedRoot,
  base: string,
  rel: string,
  r: Row,
  m: MirrorRow | undefined,
  transport: SharedTransport,
): Promise<void> {
  const dest = await safeAbs(base, rel);
  const stage = path.join(base, STAGING_DIR);
  // Named by the hash, so a restart resumes at the length already there.
  const tmp = path.join(stage, `${r.sha256}.part`);
  await fs.promises.mkdir(stage, { recursive: true });
  let offset = 0;
  try {
    offset = (await fs.promises.stat(tmp)).size;
  } catch {
    // none yet
  }
  if (offset > r.bytes) {
    await fs.promises.rm(tmp, { force: true });
    offset = 0;
  }
  if (offset < r.bytes) {
    check(d);
    const got = await viaTransport(
      transport.fetch({ root, relPath: rel, sha256: r.sha256 }, tmp, offset),
    );
    if (got === 'gone') return; // the leader moved on: wait for the next rows
  }
  if ((await d.hashFile(tmp)) !== r.sha256) {
    await fs.promises.rm(tmp, { force: true });
    return;
  }
  const when = new Date(r.mtime);
  if (!Number.isNaN(when.getTime())) await fs.promises.utimes(tmp, when, when);
  // The user may have changed the file while this one downloaded.
  if ((await stillMirrored(d, dest, m)) === 'changed') {
    await fs.promises.rm(tmp, { force: true });
    return;
  }
  check(d); // the last look before the downloaded file replaces anything
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await safeAbs(base, rel); // again, now that the folders exist
  await fs.promises.rename(tmp, dest);
  const st = await fs.promises.stat(dest);
  await d.db.run(UPSERT_MIRROR, [
    root,
    rel,
    r.sha256,
    st.size,
    Math.floor(st.mtimeMs),
    m?.capture_id ?? null,
  ]);
}

/** One pass over both roots. Ends quietly when the transport fails. */
export async function mirrorPass(
  d: MirrorDeps,
  transport: SharedTransport,
): Promise<void> {
  for (const root of ['incoming', 'sorted'] as const) {
    const base = d.roots[root];
    if (!base) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      await mirrorRoot(d, root, base, transport);
    } catch (err) {
      if (err instanceof Stopped) return;
      if (err instanceof TransportFailed) {
        d.log('info', `mirroring paused: ${String(err.inner)}`);
        return;
      }
      throw err;
    }
  }
}
