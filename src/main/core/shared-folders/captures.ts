/** Phone scans: a capture is recognised by the hash of its bytes, wherever
 *  sorting has put the file. The note ("this file is that capture") lives on
 *  the local mirror entry and follows the file when it moves. */
import { SyncReadOnly } from '../sync/role';
import { toAbs, toRel, type SharedRoot } from './paths';
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
  /** Capture notes waiting for the scan to write the mirror entry of a moved file, by hash. */
  pendingNotes: Map<string, string>;
  /** Paths this device made go away; the scan believes an emptied folder when they explain it. */
  explained: Set<string>;
}

type Captures = Pick<
  SharedFoldersApi,
  'registerCapture' | 'noteCapture' | 'moved' | 'fileOfCapture'
>;

const MAX_PENDING = 1000;

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
      if (!m || String(m.sha256) !== sha256) return false;
      await db.run(
        `UPDATE shared_mirror SET capture_id = ? WHERE root = ? AND rel_path = ?`,
        [captureId, at.root, at.rel],
      );
      return true;
    },

    moved: async (fromAbs, toAbsPath) => {
      const roots = ctx.roots();
      const from = locate(roots, fromAbs);
      const to = locate(roots, toAbsPath);
      if (from) ctx.explained.add(`${from.root}/${from.rel}`);
      if (from && to) {
        const old = (
          await db.all(
            `SELECT sha256, capture_id FROM shared_mirror WHERE root = ? AND rel_path = ?`,
            [from.root, from.rel],
          )
        )[0];
        if (old?.capture_id) {
          const sha = String(old.sha256);
          const now = (
            await db.all(
              `SELECT sha256 FROM shared_mirror WHERE root = ? AND rel_path = ?`,
              [to.root, to.rel],
            )
          )[0];
          if (now && String(now.sha256) === sha) {
            await db.run(
              `UPDATE shared_mirror SET capture_id = ? WHERE root = ? AND rel_path = ?`,
              [String(old.capture_id), to.root, to.rel],
            );
          } else {
            // The scan has not listed the new path yet; it takes the note when it does.
            ctx.pendingNotes.set(sha, String(old.capture_id));
            if (ctx.pendingNotes.size > MAX_PENDING)
              ctx.pendingNotes.delete(ctx.pendingNotes.keys().next().value!);
          }
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
          absPath = toAbs(base, rel);
        } catch {
          absPath = null;
        }
      }
      return { ref, absPath, missingHere };
    },
  };
}
