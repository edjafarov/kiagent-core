/** A copy mirrors the leader's two folders. For each path it compares three
 *  things: the file on disk (D), what this Mac last had in agreement with the
 *  leader (M, the `shared_mirror` entry) and the leader's row (R). A user's
 *  file is only ever removed through the injected `trash`, and only while it
 *  still equals M. */
import fs from 'node:fs';
import path from 'node:path';

import type { BatchStep } from '../../db/app-db';
import {
  readDisk,
  UPSERT_MIRROR,
  type DiskFile,
  type FileRow,
  type MirrorRow,
} from './leader-scan';
import { groupByName, type Group as G } from './groups';
import { nameKey, safeAbs, STAGING_DIR, type SharedRoot } from './paths';
import { DELETE_OP, noteFor } from './pending';
import { checkRoot, type GateDeps } from './root-state';
import type { Roots, SharedFoldersDeps, SharedTransport } from './service';

export type MirrorDeps = Pick<
  SharedFoldersDeps,
  'db' | 'hashFile' | 'trash' | 'log' | 'platform'
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
type Group = G<DiskFile & { rel: string }, MirrorRow, Row>;
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
  if ((await checkRoot(d, root, base)) !== 'ok') return;
  const key = nameKey(d.platform);
  const rowList = (await d.db.all(
    `SELECT rel_path, sha256, bytes, mtime, missing_here, deleted FROM shared_files WHERE root = ?`,
    [root],
  )) as unknown as Row[];
  const mirrorList = (await d.db.all(
    `SELECT rel_path, sha256, bytes, mtime_ms, capture_id FROM shared_mirror WHERE root = ?`,
    [root],
  )) as unknown as MirrorRow[];
  const mirrorByKey = new Map(mirrorList.map((r) => [key(r.rel_path), r]));
  const disk = await readDisk(d, base, mirrorByKey, key);

  // The listing counts only if the root was really here while it was made.
  if ((await checkRoot(d, root, base)) !== 'ok') return;

  const groups = groupByName(key, [...disk.files].map(([rel, f]) => ({ ...f, rel })), mirrorList, rowList);
  const seenKeys = new Set([...disk.seen].map(key));

  const dropMirror = async (rel: string): Promise<void> => {
    await d.db.run(
      `DELETE FROM shared_mirror WHERE root = ? AND rel_path = ?`,
      [root, rel],
    );
  };

  const offers: Group[] = [];
  const trashes: Group[] = [];
  const removals: Group[] = [];
  const fetches: Group[] = [];
  const refresh: BatchStep[] = [];
  const drops: Group[] = [];

  for (const k of [...groups.keys()].sort()) {
    const g = groups.get(k)!;
    const { f, m, r } = g;
    // Unreadable, or possibly in a folder that could not be listed: no proof of absence.
    if (!f && (seenKeys.has(k) || disk.incomplete)) continue;
    const live = r && !r.deleted;
    const here = live && !r.missing_here; // the leader holds these bytes
    const mrel = m?.rel_path ?? f?.rel ?? r?.rel_path ?? ''; // a mirror entry keeps its spelling

    if (f && m) {
      if (f.sha !== m.sha256)
        offers.push(g); // changed here: offered first, nothing else for this path
      else if (!r)
        offers.push(g); // the leader has never seen it
      else if (r.deleted) trashes.push(g);
      else if (r.missing_here) {
        if (r.sha256 === f.sha) offers.push(g); // the leader lacks these bytes: supply them
      } else {
        if (r.sha256 !== f.sha) fetches.push(g);
        if (m.bytes !== f.stats.size || m.mtime_ms !== f.mtimeMs)
          refresh.push({
            sql: UPSERT_MIRROR,
            params: [root, mrel, f.sha, f.stats.size, f.mtimeMs, m.capture_id],
          });
      }
    } else if (f) {
      if (!live) offers.push(g);
      else if (r.sha256 === f.sha && !r.missing_here) {
        refresh.push({
          sql: UPSERT_MIRROR,
          params: [root, mrel, f.sha, f.stats.size, f.mtimeMs, null],
        }); // adopt
      } else offers.push(g);
    } else if (m) {
      if (here && r.sha256 === m.sha256) removals.push(g);
      else if (here) fetches.push(g);
      else if (!live) drops.push(g);
    } else if (here) fetches.push(g);
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

  // What this Mac found out is written before the network is asked for
  // anything: a failing transport must not lose it, or every retry (the timer
  // fires every minute) would hash all those files again.
  check(d);
  if (refresh.length) await d.db.batch(refresh);

  for (const g of offers) {
    const f = g.f!;
    // eslint-disable-next-line no-await-in-loop
    await forPath(f.rel, async () => {
      const { m, r } = g;
      // A scan this Mac filed itself has no mirror entry yet: its capture id
      // is in a note for these very bytes at this very path.
      const note = m?.capture_id ? null : await noteFor(d.db, root, f.rel, f.sha);
      const captureId = m?.capture_id ?? note?.capture_id ?? null;
      const answer = await viaTransport(
        transport.offer(
          {
            root,
            // the leader's own spelling when it has the file, else ours
            relPath: r?.rel_path ?? f.rel,
            sha256: f.sha,
            base: m?.sha256 ?? null,
            captureId,
          },
          f.abs,
        ),
      );
      check(d);
      const mrel = m?.rel_path ?? f.rel;
      if (answer === 'have-it') {
        if ((await d.hashFile(f.abs)) !== f.sha) return;
        check(d);
        await d.trash(f.abs);
        await dropMirror(mrel);
        if (note) await d.db.run(DELETE_OP, [note.id]);
        return;
      }
      await d.db.batch([
        { sql: UPSERT_MIRROR, params: [root, mrel, f.sha, f.stats.size, f.mtimeMs, captureId] },
        ...(note ? [{ sql: DELETE_OP, params: [note.id] }] : []),
      ]);
    });
  }
  check(d);
  for (const g of drops) {
    // eslint-disable-next-line no-await-in-loop
    await dropMirror(g.m!.rel_path);
  }

  for (const g of trashes) {
    const f = g.f!;
    // eslint-disable-next-line no-await-in-loop
    await forPath(f.rel, async () => {
      const abs = await safeAbs(base, f.rel);
      // D = M proves the user did not touch it, also when this Mac missed an
      // edit before the deletion. Checked again just before it goes.
      const now = await stillMirrored(d, abs, g.m);
      if (now === 'changed') return;
      check(d);
      if (now === 'same') await d.trash(abs);
      await dropMirror(g.m!.rel_path);
    });
  }

  for (const g of removals) {
    const m = g.m!;
    // eslint-disable-next-line no-await-in-loop
    await forPath(m.rel_path, async () => {
      if ((await stillMirrored(d, await safeAbs(base, m.rel_path), m)) !== 'absent') return;
      check(d);
      await viaTransport(
        transport.remove({ root, relPath: g.r!.rel_path, sha256: m.sha256 }),
      );
      await dropMirror(m.rel_path);
    });
  }

  for (const g of fetches) {
    // eslint-disable-next-line no-await-in-loop
    await forPath(g.r!.rel_path, () => fetchOne(d, root, base, g, transport));
  }
}

async function fetchOne(
  d: MirrorDeps,
  root: SharedRoot,
  base: string,
  g: Group,
  transport: SharedTransport,
): Promise<void> {
  const r = g.r!;
  const { m } = g;
  // A file that is there keeps its own spelling; a new one gets the manifest's.
  const rel = g.f?.rel ?? r.rel_path;
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
      transport.fetch({ root, relPath: r.rel_path, sha256: r.sha256 }, tmp, offset),
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
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await safeAbs(base, rel); // again, now that the folders exist
  check(d); // the last look, right before the downloaded file replaces anything
  await fs.promises.rename(tmp, dest);
  const st = await fs.promises.stat(dest);
  await d.db.run(UPSERT_MIRROR, [
    root,
    m?.rel_path ?? rel,
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
