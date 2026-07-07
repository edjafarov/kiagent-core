/**
 * Local-folder's persisted Cursor shape.
 *
 * One account now tracks several folder ROOTS (see local-folder-source.ts's
 * `connect()`/`getRootPaths()`), so the watermark distinguishing "still
 * catching up" from "caught up, watch for changes" is PER ROOT rather than a
 * single value for the whole account — mirrors imap's per-mailbox cursor
 * (`imap/types.ts`'s `ImapCursor`/`FolderCursorEntry`).
 *
 * - `null`: no root has EVER completed a pass (freshly connected account,
 *   before its very first batch commits).
 * - `{ roots: { [absRootPath]: { completedAt } } }`: one entry per root that
 *   has completed at least one full pass, keyed by the root's own absolute
 *   path.
 *   - Entry ABSENT for a configured root (not yet seen, or configured but
 *     still mid-backfill) → that root is backfilled from scratch: walk the
 *     whole tree, yielding ~50-file batches. Every INTERMEDIATE batch keeps
 *     that root's entry absent from the snapshot (still catching up); only
 *     the FINAL batch of that root's walk stamps `{ completedAt }`, taken
 *     from BEFORE the walk started so nothing that changed during the walk
 *     is missed once incremental mode takes over. A crash/restart mid-walk
 *     simply restarts that one root's walk from scratch — safe because
 *     `externalId` is the stable absolute path (see to-document.ts), so
 *     re-ingesting the same file is an idempotent upsert, never a
 *     duplicate. This is a deliberate simplification over kiagent-ref, which
 *     paginated resumably by content-addressing every file with a SHA-256
 *     `source_id` (kiagent-ref scanner.ts:124) — a scheme the new
 *     `externalId` vocabulary has no room for (see concept/gaps.md #11); the
 *     redesign accepts "recompute on restart" instead of "resume exactly".
 *   - Entry PRESENT → that root is incrementally rescanned by mtime from its
 *     `completedAt` watermark, refreshed on every subsequent rescan / live
 *     watch event — kiagent-ref's analogous restart-catch-up step is
 *     `reconcileRoot()` (kiagent-ref instance.ts:68-85).
 *   - A root removed from config is dropped from this map the next time a
 *     batch commits (see `pull()`'s pruning step in local-folder-source.ts).
 */
export type LocalFolderCursor = { roots: Record<string, { completedAt: string }> } | null;

/**
 * Return a new cursor with one root's entry replaced — every OTHER root's
 * entry is carried over unchanged (each Batch.cursor is a full,
 * self-consistent snapshot, per the Source contract). Mirrors
 * `imap/cursor.ts`'s `advanceCursor`.
 */
export function advanceCursor(
  cur: LocalFolderCursor,
  root: string,
  completedAt: string,
): LocalFolderCursor {
  return { roots: { ...(cur?.roots ?? {}), [root]: { completedAt } } };
}
