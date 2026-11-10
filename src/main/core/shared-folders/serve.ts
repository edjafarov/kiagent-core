/** The leader's side of the three routes (fetch, offer, remove). Every path,
 *  root and device name here comes from another machine: all are checked, and
 *  a user's file is only ever removed through the injected `trash`. */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { SyncReadOnly } from '../sync/role';
import { UPSERT_MIRROR } from './leader-scan';
import { normalizeRel, STAGING_DIR, toAbs, type SharedRoot } from './paths';
import type { FileQuery, OfferAnswer, OfferMeta, Roots, SharedFoldersApi, SharedFoldersDeps } from './service';

export interface ServeCtx {
  deps: Pick<SharedFoldersDeps, 'db' | 'hashFile' | 'trash' | 'log'>;
  roots(): Roots;
  /** True while this device is the writable leader. */
  leader(): boolean;
  /** Resolves when a promotion reconcile that is owed has finished. */
  ready(): Promise<void>;
  /** Throws `SharedRootPaused` while the root may not be touched. */
  refuse(root: SharedRoot): void;
  kick(): void;
  /** Paths this device made go away (see the scan's empty-root rule). */
  explained: Set<string>;
}

type Serve = SharedFoldersApi['serve'];

/** The root folder and the absolute path of a path from outside. Throws on
 *  anything else: an unknown root, `..`, an absolute path, an empty segment,
 *  the staging directory. */
function locate(ctx: ServeCtx, root: unknown, relPath: unknown): { root: SharedRoot; base: string; rel: string; abs: string } {
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
  const maxRev = async (): Promise<number> =>
    Number((await ctx.deps.db.all(`SELECT coalesce(max(rev), 0) AS m FROM shared_files`))[0]?.m ?? 0);

  const place = async (tmp: string, dest: string): Promise<void> => {
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.rename(tmp, dest);
  };

  return {
    open: async (q: FileQuery) => {
      need('serve.open');
      await ctx.ready();
      const { root, rel, abs } = locate(ctx, q.root, q.relPath);
      ctx.refuse(root);
      if ((await shaAt(ctx, root, rel, abs)) !== q.sha256) return null;
      return { path: abs, bytes: (await fs.promises.stat(abs)).size };
    },

    stagingFile: async (root) => {
      need('serve.stagingFile');
      if (root !== 'incoming' && root !== 'sorted') throw new Error('shared-folders: unknown root');
      const base = ctx.roots()[root];
      if (!base) throw new Error(`shared-folders: the ${root} folder is not set on this Mac`);
      ctx.refuse(root);
      const dir = path.join(base, STAGING_DIR);
      await fs.promises.mkdir(dir, { recursive: true });
      return path.join(dir, `in-${randomUUID()}`);
    },

    offer: async (meta: OfferMeta, tmpFile: string, fromDeviceName: string): Promise<OfferAnswer> => {
      need('serve.offer');
      if (!inStaging(tmpFile)) throw new Error('shared-folders: an offer must be received into .kia-sync');
      const drop = (): Promise<void> => fs.promises.rm(tmpFile, { force: true });
      let target: ReturnType<typeof locate>;
      try {
        target = locate(ctx, meta.root, meta.relPath);
      } catch (err) {
        await drop();
        throw err;
      }
      const { root, rel, abs } = target;
      if ((await ctx.deps.hashFile(tmpFile)) !== meta.sha256) {
        await drop();
        throw new Error('shared-folders: the offered bytes do not match their hash');
      }
      await ctx.ready();
      ctx.refuse(root);
      const db = ctx.deps.db;
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
            let held: ReturnType<typeof locate>;
            try {
              held = locate(ctx, row.root, row.rel_path);
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
        let held: ReturnType<typeof locate>;
        try {
          held = locate(ctx, row.root, row.rel_path);
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
        // eslint-disable-next-line no-await-in-loop
        await place(tmpFile, held.abs);
        const st = await fs.promises.stat(held.abs);
        const rev = (await maxRev()) + 1;
        await db.batch([
          {
            sql: `UPDATE shared_files SET missing_here = 0, rev = ? WHERE root = ? AND rel_path = ?`,
            params: [rev, held.root, held.rel],
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
        await place(tmpFile, abs);
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
        // eslint-disable-next-line no-await-in-loop
        await place(tmpFile, dest);
        ctx.kick();
        return 'kept-both';
      }
    },

    remove: async (q: FileQuery) => {
      need('serve.remove');
      await ctx.ready();
      const { root, rel, abs } = locate(ctx, q.root, q.relPath);
      ctx.refuse(root);
      if ((await shaAt(ctx, root, rel, abs)) !== q.sha256) return false;
      await ctx.deps.trash(abs);
      ctx.explained.add(`${root}/${rel}`);
      ctx.kick();
      return true;
    },
  };
}
