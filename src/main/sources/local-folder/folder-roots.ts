import fs from 'node:fs';
import path from 'node:path';

import type { Account, FolderRootSelection } from '@shared/contracts';
import { coveringRoots, isUnder } from '@shared/folder-paths';
import { SourcePermanentError } from '@shared/source-errors';

/** Pinned verbatim from the pre-cutover `getRootPaths` — three tests and the
 *  renderer's error surface key on this exact sentence. */
export const NO_ROOTS_ERROR =
  'Local-folder account has no tracked folders — remove this source and re-add its folder.';

/** Display name for an absolute root. `path.basename('/')` and
 *  `path.basename('C:\\')` are both `''`, so a drive root falls back to its
 *  own path rather than rendering as an empty chip. `name` is display-only —
 *  scope logic never identifies a root by it. */
export function rootName(absPath: string): string {
  return path.basename(absPath) || absPath;
}

export function toFolderRoots(absPaths: string[]): FolderRootSelection[] {
  return absPaths.map((id) => ({ id, name: rootName(id) }));
}

/**
 * The canonical scope config, merged ONTO whatever else the account carries.
 * `watch` above all: dropping it would silently re-enable the chokidar
 * watcher on an account that opted out (`isWatchEnabled`).
 *
 * CANONICAL-ONLY, per DECISIONS A-2. The legacy `config.paths` mirror has one
 * owner — core, which derives it from `folderRoots` in the v3 migration and
 * again inside `applyFolderScope`. This source writes it nowhere.
 *
 * It does not STRIP it either. `base` is the account's live config, which on
 * a migrated account already carries `paths` = the OLD root list, and that
 * stale array rides through this spread. That is deliberate and harmless:
 * core rewrites `paths` from `folderRoots` before the durable write, and
 * `readFolderRoots` below prefers `folderRoots` over it in every case.
 *
 * WARNING to any FUTURE writer of `config.paths` (DECISIONS C-36). Whatever
 * writes that mirror must write the `folderRoots[].id` strings VERBATIM (B-7),
 * and every such id must itself have come from `path.resolve` —
 * `validateFolderRoots` below is this source's only producer of one, exactly
 * as the pre-cutover `connect()` was (`local-folder-source.ts:99`,
 * `const abs = path.resolve(raw);`). The reason is `isUnder`
 * (`@shared/folder-paths.ts:14-20`): it is `p === root`, then `startsWith`,
 * then one separator check — **case-sensitive, with no path normalization at
 * all**; its own doc comment says "Case-sensitive and does no path
 * normalization — callers pass paths already resolved by the main process."
 * Two live consumers depend on that: the v3 migration's containment test
 * (Task 2) — the ONE branch in which the migration archives local-folder rows
 * — and `watch.ts:93-94`'s `rootOf`. The other side of the comparison,
 * `metadata.absPath` (written at `to-document.ts:65`), is produced by the
 * scanner's fast-glob walk (`scanner.ts:110-116` — a recursive glob with
 * `cwd: rootPath, absolute: true`) or by chokidar over those same root strings
 * (`watch.ts:88`) — i.e. off the stored root — so it lines up with a resolved
 * root and silently fails to match an unresolved one.
 *
 * WINDOWS FOOTNOTE — `metadata.absPath` IS NOT UNIFORMLY OS-NATIVE, and
 * assuming it was is C-46/D1. fast-glob's `absolute: true` runs `makeAbsolute`
 * then `unixify` (`fast-glob/out/providers/transformers/entry.js:12-16`), and
 * `unixify` is an UNCONDITIONAL `filepath.replace(/\\/g, '/')`
 * (`fast-glob/out/utils/path.js:29-31`) — not platform-gated. So on Windows
 * every SCAN row's `absPath` is forward-slashed, every WATCH row's is
 * backslashed (chokidar emits OS-native, `watch.ts:180-192`), and a
 * `path.resolve`d root is backslashed. One corpus, both spellings.
 *
 * A consumer comparing MIXED provenance must therefore normalize separators
 * on BOTH sides — `normalizePathSeparators` in `@shared/folder-paths`, a pure
 * `\` → `/` rewrite — and stamp/return the CONFIG spelling unchanged (B-7).
 * The v3 migration is exactly such a consumer and now does this
 * (`schema.ts` `v3Attribute`, local-folder branch); before the fix it archived
 * every scan-produced row on Windows. `watch.ts:93`'s `rootOf` is NOT affected
 * — both of its sides are OS-native — and neither is scan-time stamping, which
 * takes `scopeRootId` from the per-root loop and never tests containment
 * (`local-folder-source.ts:188-197`).
 *
 * Do NOT "fix" a mixed pair with `path.resolve`: it is cwd- and
 * platform-dependent, and a corpus may hold paths written on another OS.
 * `fetchBytes`' `path.resolve` (`local-folder-source.ts:409-410`) stays as it
 * is — it resolves a path on the machine that owns it, same-OS, same run.
 *
 * Getting this wrong is not recoverable. Per C-36 a local-folder mis-archive
 * is PERMANENT: there is no paired re-establish, the migration leaves
 * `accounts.cursor` untouched, the incremental branch is mtime-filtered
 * (`local-folder-source.ts:288-289`, `entries.filter((e) => e.stats.mtime
 * .getTime() > sinceMs)`), and `upsertDocument` early-returns on an unchanged
 * live row (`write-tx.ts:170-176`) — so a wrongly archived row comes back only
 * if that file's mtime later changes.
 */
export function folderScopedConfig(
  base: Record<string, unknown>,
  roots: FolderRootSelection[],
): Record<string, unknown> & { folderRoots: FolderRootSelection[] } {
  return { ...base, folderRoots: roots };
}

/** One config entry → a selection. Accepts the canonical `{id, name}` object
 *  and the legacy bare string, so both shapes parse through one function. */
function asSelection(raw: unknown): FolderRootSelection | null {
  if (typeof raw === 'string')
    return raw.length > 0 ? { id: raw, name: rootName(raw) } : null;
  if (raw && typeof raw === 'object') {
    const { id, name } = raw as { id?: unknown; name?: unknown };
    if (typeof id !== 'string' || id.length === 0) return null;
    return {
      id,
      name: typeof name === 'string' && name.length > 0 ? name : rootName(id),
    };
  }
  return null;
}

/**
 * This account's folder scope. Canonical `config.folderRoots` wins; the
 * legacy `config.paths` mirror is read only as the pre-migration fallback, so
 * an account the v3 migration has not touched yet still syncs instead of
 * dying with a "remove this source" error the user cannot act on. Reading the
 * mirror is this source's job; writing it is core's (A-2).
 *
 * TODO(folder-scope-train-2): drop the `config.paths` fallback with the mirror.
 *
 * Anything else is a PERMANENT error — retrying can never fix a malformed
 * config, so the engine surfaces it immediately instead of backing off 5x.
 */
export function readFolderRoots(account: Account): FolderRootSelection[] {
  for (const key of ['folderRoots', 'paths'] as const) {
    const raw = account.config?.[key];
    if (!Array.isArray(raw) || raw.length === 0) continue;
    const parsed = raw.map(asSelection);
    if (parsed.every((r): r is FolderRootSelection => r !== null))
      return parsed;
  }
  throw new SourcePermanentError(NO_ROOTS_ERROR);
}

/**
 * DECISIONS R8, local-folder's rule: the `scope_root_id` values whose live
 * documents genuinely leave scope when `current` becomes `next`.
 *
 * "A removed root contributes its id iff NO retained root satisfies
 * `isUnder(removedRoot, retainedRoot)`." A root that survives verbatim is
 * covered by itself (`isUnder(x, x) === true`), so the single filter below is
 * the whole rule — there is no separate set-difference step, and there must
 * not be one: core NEVER derives this by set-difference (R8).
 *
 * `isUnder` comes from @shared/folder-paths and is NOT re-implemented here.
 * It is separator-aware — `/Users/edjafarov` must not "cover" `/Users/ed` —
 * and handles both `/` and `\` so Windows drive roots work. It does no path
 * normalization, which is safe on both sides here: every id in `next` came
 * from `validateFolderRoots`' `path.resolve`, and every id in `current` was
 * written by a previous `validateFolderRoots` (or by the legacy `connect()`,
 * which resolved too).
 *
 * Returning `[]` is legal, common and safe: it is exactly what a narrowing
 * edit under a still-selected parent must produce (A-1).
 */
export function removedRootIds(
  current: readonly FolderRootSelection[],
  next: readonly FolderRootSelection[],
): string[] {
  return current
    .map((c) => c.id)
    .filter((id) => !next.some((n) => isUnder(id, n.id)));
}

/**
 * Resolve, stat and covering-normalize a picked id set into the canonical
 * antichain. SHARED by `connect()` and `manageFolders()` so an added root is
 * validated identically in both flows; the error strings are the pre-cutover
 * ones. Note this stats every picked root including RETAINED ones — an
 * unplugged external-drive root blocks the save (design step 4, "validates
 * reachability").
 */
export async function validateFolderRoots(
  rawIds: readonly unknown[],
): Promise<FolderRootSelection[]> {
  if (rawIds.length === 0) {
    throw new Error('Local Folder: at least one folder path is required.');
  }
  const resolved: string[] = [];
  for (const raw of rawIds) {
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      throw new Error('Local Folder: a folder path is required.');
    }
    const abs = path.resolve(raw);
    let stat: fs.Stats;
    try {
      // eslint-disable-next-line no-await-in-loop
      stat = await fs.promises.stat(abs);
    } catch {
      throw new Error(`Local Folder: path does not exist: "${abs}"`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Local Folder: path is not a directory: "${abs}"`);
    }
    resolved.push(abs);
  }
  return toFolderRoots(coveringRoots(resolved));
}
