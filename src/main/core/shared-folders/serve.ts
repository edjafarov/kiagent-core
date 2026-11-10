/** The leader's side of the three routes (fetch, offer, remove). Every path,
 *  root and device name here comes from another machine: all are checked, and
 *  a user's file is only ever removed through the injected `trash`. */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { SyncReadOnly } from '../sync/role';
import { UPSERT_MIRROR } from './leader-scan';
import { recordGone } from './pending';
import { NEXT_REV } from './schema';
import { normalizeRel, safeAbs, STAGING_DIR, toAbs, type SharedRoot } from './paths';
import type { FileQuery, OfferAnswer, OfferMeta, Roots, SharedFoldersApi, SharedFoldersDeps } from './service';

export interface ServeCtx {
  deps: Pick<SharedFoldersDeps, 'db' | 'hashFile' | 'trash' | 'log'>;
  roots(): Roots;
  /** True while this device is the writable leader. */
  leader(): boolean;
  /** Runs `fn` after everything queued before it (scans, mirror passes, other
   *  requests), as the leader. `still()` turns false when the role changes;
   *  it is checked immediately before each manifest write and file change. */
  run<T>(fn: (still: () => boolean) => Promise<T>): Promise<T>;
  /** Runs the promotion reconcile if one is owed. Only inside `run`. */
  ready(): Promise<void>;
  /** Throws `SharedRootPaused` while the root may not be touched. */
  refuse(root: SharedRoot): void;
  /** The check a request gets before anything is read or written: throws
   *  `SharedRootPaused` when the root is not there or has just emptied. */
  quick(root: SharedRoot): Promise<void>;
  kick(): void;
}

type Serve = SharedFoldersApi['serve'];

/** The root folder and the absolute path of a path from outside. Throws on
 *  anything else: an unknown root, `..`, an absolute path, an empty segment,
 *  the staging directory. */
type Located = { root: SharedRoot; base: string; rel: string; abs: string };

function locateLexical(ctx: ServeCtx, root: unknown, relPath: unknown): Located {
  if (root !== 'incoming' && root !== 'sorted') throw new Error(`shared-folders: unknown root ${JSON.stringify(root)}`);
  ctx.refuse(root);
  const base = ctx.roots()[root];
  if (!base) throw new Error(`shared-folders: the ${root} folder is not set on this Mac`);
  if (typeof relPath !== 'string') throw new Error('shared-folders: bad path');
  const rel = normalizeRel(relPath);
  const abs = toAbs(base, rel);
  if (rel === STAGING_DIR || rel.startsWith(`${STAGING_DIR}/`)) throw new Error('shared-folders: bad path');
  return { root, base, rel, abs };
}

/** `locateLexical`, and the proof that no segment on the way is a symlink (a
 *  path from another device must not reach a file outside the root). */
async function locate(ctx: ServeCtx, root: unknown, relPath: unknown): Promise<Located> {
  const at = locateLexical(ctx, root, relPath);
  await safeAbs(at.base, at.rel);
  return at;
}

/** The hash of the file at `abs`, or null when nothing is there. A folder or
 *  an unreadable file has no hash that anyone could ask for. */
async function shaAt(ctx: ServeCtx, root: SharedRoot, rel: string, abs: string): Promise<string | null> {
  let st: fs.Stats;
  try {
    st = await fs.promises.stat(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ENOTDIR') return null;
    return '<unreadable>';
  }
  if (!st.isFile()) return '<not a file>';
  const m = (await ctx.deps.db.all(
    `SELECT sha256, bytes, mtime_ms FROM shared_mirror WHERE root = ? AND rel_path = ?`,
    [root, rel],
  ))[0];
  if (m && Number(m.bytes) === st.size && Number(m.mtime_ms) === Math.floor(st.mtimeMs)) return String(m.sha256);
  try {
    return await ctx.deps.hashFile(abs);
  } catch {
    return '<unreadable>';
  }
}

/** ` (from <device>)` made safe for a file name on every platform. */
export const safeDeviceName = (name: string): string =>
  // eslint-disable-next-line no-control-regex
  name.replace(/[\u0000-\u001f\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').replace(/^[\s.]+|[\s.]+$/g, '').slice(0, 60) || 'another Mac';

export function createServe(ctx: ServeCtx): Serve {
  const need = (what: string): void => {
    if (!ctx.leader()) throw new SyncReadOnly(what);
  };
  const inStaging = (tmp: string): boolean =>
    (['incoming', 'sorted'] as const).some((r) => {
      const base = ctx.roots()[r];
      if (!base) return false;
      const rel = path.relative(path.join(base, STAGING_DIR), tmp);
      return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
    });
  const stillLeader = (still: () => boolean, what: string): void => {
    if (!still()) throw new SyncReadOnly(what);
  };

  const place = async (tmp: string, base: string, dest: string): Promise<void> => {
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await safeAbs(base, path.relative(base, dest)); // again, now that the folders exist
    await fs.promises.rename(tmp, dest);
  };

  return {
    open: async (q: FileQuery) => {
      need('serve.open');
      return ctx.run(async (still) => {
        stillLeader(still, 'serve.open');
        await ctx.ready();
        const { root, rel, abs } = await locate(ctx, q.root, q.relPath);
        await ctx.quick(root);
        if ((await shaAt(ctx, root, rel, abs)) !== q.sha256) return null;
        return { path: abs, bytes: (await fs.promises.stat(abs)).size };
      });
    },

    stagingFile: async (root) => {
      need('serve.stagingFile');
      if (root !== 'incoming' && root !== 'sorted') throw new Error('shared-folders: unknown root');
      const base = ctx.roots()[root];
      if (!base) throw new Error(`shared-folders: the ${root} folder is not set on this Mac`);
      ctx.refuse(root);
      await ctx.quick(root);
      const dir = path.join(base, STAGING_DIR);
      await fs.promises.mkdir(dir, { recursive: true });
      return path.join(dir, `in-${randomUUID()}`);
    },

    offer: async (meta: OfferMeta, tmpFile: string, fromDeviceName: string): Promise<OfferAnswer> => {
      need('serve.offer');
      if (!inStaging(tmpFile)) throw new Error('shared-folders: an offer must be received into .kia-sync');
      const drop = (): Promise<void> => fs.promises.rm(tmpFile, { force: true });
      let target: Located;
      try {
        target = await locate(ctx, meta.root, meta.relPath);
      } catch (err) {
        await drop();
        throw err;
      }
      const { root, rel, abs } = target;
      if ((await ctx.deps.hashFile(tmpFile)) !== meta.sha256) {
        await drop();
        throw new Error('shared-folders: the offered bytes do not match their hash');
      }
      return ctx.run(async (still) => {
      try {
        stillLeader(still, 'serve.offer');
        await ctx.ready();
        ctx.refuse(root);
        await ctx.quick(root);
      } catch (err) {
        await drop();
        throw err;
      }
      const db = ctx.deps.db;
      const guard = (): void => stillLeader(still, 'serve.offer');
      const withSha = (await db.all(
        `SELECT root, rel_path, missing_here FROM shared_files
          WHERE sha256 = ? AND deleted = 0 ORDER BY missing_here, (root = ? AND rel_path = ?) DESC, rev DESC`,
        [meta.sha256, root, rel],
      )) as unknown as { root: SharedRoot; rel_path: string; missing_here: number }[];

      // 1. "Have it": a registered capture whose bytes the leader holds.
      if (meta.captureId) {
        const reg = (await db.all(`SELECT sha256 FROM shared_capture_files WHERE capture_id = ?`, [meta.captureId]))[0];
        if (reg && String(reg.sha256) === meta.sha256) {
          for (const row of withSha) {
            if (row.missing_here) continue;
            let held: Located;
            try {
              held = await locate(ctx, row.root, row.rel_path);
            } catch {
              continue;
            }
            // eslint-disable-next-line no-await-in-loop
            if ((await shaAt(ctx, held.root, held.rel, held.abs)) === meta.sha256) {
              await drop();
              return 'have-it';
            }
          }
        }
      }

      // 2. The leader lacks these bytes for a live row: the offer supplies them.
      for (const row of withSha.filter((r) => r.missing_here)) {
        let held: Located;
        try {
          held = await locate(ctx, row.root, row.rel_path);
        } catch {
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        const there = await shaAt(ctx, held.root, held.rel, held.abs);
        // Only an empty spot or the older version this very row left behind:
        // anything else there is somebody's file.
        const mirror = (await db.all(`SELECT sha256 FROM shared_mirror WHERE root = ? AND rel_path = ?`, [
          held.root,
          held.rel,
        ]))[0];
        if (there !== null && there !== meta.sha256 && String(mirror?.sha256) !== there) continue;
        guard();
        // eslint-disable-next-line no-await-in-loop
        await place(tmpFile, held.base, held.abs);
        const st = await fs.promises.stat(held.abs);
        guard();
        await db.batch([
          {
            sql: `UPDATE shared_files SET missing_here = 0, rev = ${NEXT_REV} WHERE root = ? AND rel_path = ?`,
            params: [held.root, held.rel],
          },
          { sql: UPSERT_MIRROR, params: [held.root, held.rel, meta.sha256, st.size, Math.floor(st.mtimeMs), null] },
        ]);
        ctx.kick();
        return 'filled';
      }

      // 3. The leader's file at that path is the same file.
      const here = await shaAt(ctx, root, rel, abs);
      if (here === meta.sha256) {
        await drop();
        return 'same';
      }

      // 4. The path is free, or still holds the version the offering Mac started from.
      if (here === null || (meta.base !== null && here === meta.base)) {
        guard();
        await place(tmpFile, target.base, abs);
        ctx.kick();
        return 'written';
      }

      // 5. Both stay: the offered file gets the device's name.
      const ext = path.extname(rel);
      const stem = rel.slice(0, rel.length - ext.length);
      const tag = ` (from ${safeDeviceName(fromDeviceName)})`;
      for (let n = 1; ; n += 1) {
        const candidate = `${stem}${tag}${n === 1 ? '' : ` ${n}`}${ext}`;
        const dest = toAbs(ctx.roots()[root]!, candidate);
        // eslint-disable-next-line no-await-in-loop
        const taken = await fs.promises.lstat(dest).then(
          () => true,
          () => false,
        );
        // eslint-disable-next-line no-await-in-loop
        const listed = (await db.all(`SELECT 1 FROM shared_files WHERE root = ? AND rel_path = ? AND deleted = 0`, [
          root,
          candidate,
        ])).length > 0;
        if (taken || listed) continue;
        guard();
        // eslint-disable-next-line no-await-in-loop
        await place(tmpFile, ctx.roots()[root]!, dest);
        ctx.kick();
        return 'kept-both';
      }
      });
    },

    remove: async (q: FileQuery) => {
      need('serve.remove');
      return ctx.run(async (still) => {
        stillLeader(still, 'serve.remove');
        await ctx.ready();
        const { root, rel, abs } = await locate(ctx, q.root, q.relPath);
        await ctx.quick(root);
        if ((await shaAt(ctx, root, rel, abs)) !== q.sha256) return false;
        stillLeader(still, 'serve.remove');
        await ctx.deps.trash(abs);
        await recordGone(ctx.deps.db, 'removed', { root, rel }, q.sha256, null);
        ctx.kick();
        return true;
      });
    },
  };
}
