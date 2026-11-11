/** Phone scans: a capture is recognised by the hash of its bytes, wherever
 *  sorting has put the file. The note ("this file is that capture") lives on
 *  the local mirror entry and follows the file when it moves. */
import { SyncReadOnly } from '../sync/role';
import { DELETE_OP, recordGone, recordNote } from './pending';
import { safeAbs, toRel, type SharedRoot } from './paths';
import type {
  Roots,
  SharedFoldersApi,
  SharedFoldersDeps,
  SharedRef,
} from './service';

export interface CaptureCtx {
  deps: Pick<SharedFoldersDeps, 'db' | 'sync'>;
  roots(): Roots;
  accountId(): Promise<string | null>;
  kick(): void;
}

type Captures = Pick<
  SharedFoldersApi,
  'registerCapture' | 'noteCapture' | 'moved' | 'fileOfCapture'
>;

const locate = (
  roots: Roots,
  abs: string,
): { root: SharedRoot; rel: string } | null => {
  for (const root of ['incoming', 'sorted'] as const) {
    const base = roots[root];
    const rel = base ? toRel(base, abs) : null;
    if (rel) return { root, rel };
  }
  return null;
};

export function createCaptures(ctx: CaptureCtx): Captures {
  const { db } = ctx.deps;
  return {
    registerCapture: async (captureId, sha256) => {
      if (ctx.deps.sync.readOnly()) throw new SyncReadOnly('registerCapture');
      await db.run(
        `INSERT INTO shared_capture_files(capture_id, sha256) VALUES(?, ?)
         ON CONFLICT(capture_id) DO UPDATE SET sha256 = excluded.sha256`,
        [captureId, sha256],
      );
    },

    noteCapture: async (captureId, absPath, sha256) => {
      const at = locate(ctx.roots(), absPath);
      if (!at) return false;
      const m = (
        await db.all(
          `SELECT sha256 FROM shared_mirror WHERE root = ? AND rel_path = ?`,
          [at.root, at.rel],
        )
      )[0];
      if (m && String(m.sha256) === sha256) {
        await db.run(
          `UPDATE shared_mirror SET capture_id = ? WHERE root = ? AND rel_path = ?`,
          [captureId, at.root, at.rel],
        );
        return true;
      }
      // No entry with these bytes yet (a scan has not listed the file, or this
      // Mac is a copy that has not offered it): remembered until one appears.
      await recordNote(db, { root: at.root, rel: at.rel }, sha256, captureId);
      ctx.kick();
      return true;
    },

    moved: async (fromAbs, toAbsPath) => {
      const roots = ctx.roots();
      const from = locate(roots, fromAbs);
      const to = locate(roots, toAbsPath);
      if (from) {
        const old = (
          await db.all(
            `SELECT sha256, capture_id FROM shared_mirror WHERE root = ? AND rel_path = ?`,
            [from.root, from.rel],
          )
        )[0];
        const row = old
          ? null
          : (await db.all(`SELECT sha256 FROM shared_files WHERE root = ? AND rel_path = ?`, [from.root, from.rel]))[0];
        // A scan that saw the file leave first kept its capture note at the old path.
        const left = old
          ? null
          : (await db.all(
              `SELECT id, sha256, capture_id FROM shared_pending WHERE kind = 'note' AND root = ? AND rel_path = ?`,
              [from.root, from.rel],
            ))[0];
        const sha = String(old?.sha256 ?? row?.sha256 ?? left?.sha256 ?? '');
        const capture = old?.capture_id ?? left?.capture_id ?? null;
        await recordGone(db, 'moved', { root: from.root, rel: from.rel }, sha, to);
        // The note follows the bytes to where the file went.
        if (capture && to) {
          await recordNote(db, to, sha, String(capture));
          if (left) await db.run(DELETE_OP, [Number(left.id)]);
        }
      }
      ctx.kick();
    },

    fileOfCapture: async (captureId) => {
      const reg = (
        await db.all(
          `SELECT sha256 FROM shared_capture_files WHERE capture_id = ?`,
          [captureId],
        )
      )[0];
      const account = await ctx.accountId();
      if (!reg || !account) return null;
      const rows = await db.all(
        `SELECT root, rel_path, missing_here FROM shared_files
          WHERE sha256 = ? AND deleted = 0 ORDER BY missing_here, rev DESC`,
        [String(reg.sha256)],
      );
      const row = rows[0];
      if (!row) return null;
      const root = String(row.root) as SharedRoot;
      const rel = String(row.rel_path);
      const ref: SharedRef = {
        accountId: account,
        externalId: `${root}/${rel}`,
        root,
        relPath: rel,
      };
      const missingHere = row.missing_here === 1;
      const base = ctx.roots()[root];
      let absPath: string | null = null;
      if (!missingHere && base) {
        try {
          absPath = await safeAbs(base, rel);
        } catch {
          absPath = null;
        }
      }
      return { ref, absPath, missingHere };
    },
  };
}
