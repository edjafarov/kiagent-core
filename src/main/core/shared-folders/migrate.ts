/** When a folder becomes a shared root, the documents a Mac's `local-folder`
 *  account already holds under it are archived once, by exact ref, through the
 *  engine's folder-scope door. They are indexed again under the shared
 *  account. A shrinking reconcile would not do: the engine refuses one that
 *  archives most of an account at once. */
import path from 'node:path';

import type { ExternalRef } from '@shared/contracts';
import { isUnder, normalizePathSeparators } from '@shared/folder-paths';

import type { AppDb } from '../../db/app-db';

/** What the migration needs of the Mac's `local-folder` accounts. */
export interface LocalFolderAccess {
  /** The Mac's `local-folder` accounts with the folders each tracks (absolute). */
  accounts(): Promise<{ id: string; roots: string[] }[]>;
  /** Stops the account's running pull and starts it again, so that the
   *  exclusions now in force are the ones it walks with and nothing built under
   *  the old ones can commit afterwards. Resolves once the old pull is gone. */
  quiesce(accountId: string): Promise<void>;
  /** Archives exactly `refs` of the account and nothing else (its scope and
   *  cursor stay as they are). */
  archive(accountId: string, refs: ExternalRef[]): Promise<void>;
}

export const MIGRATED_PREFIX = 'shared-folders:migrated:';
const PAGE = 1000;
const caseFold = process.platform === 'win32' || process.platform === 'darwin';
const posix = (p: string): string => normalizePathSeparators(path.resolve(p));

export interface MigrateDeps {
  db: AppDb;
  localFolders: LocalFolderAccess;
  log(level: 'info' | 'warn' | 'error', msg: string): void;
}

/** The migration of one shared root, once per account. A failure is logged and
 *  left for the next time the roots are set (archiving is idempotent). */
export async function migrateLocalFolders(d: MigrateDeps, rootAbs: string): Promise<void> {
  const root = posix(rootAbs);
  const accounts = await d.localFolders.accounts();
  for (const account of accounts) {
    const covers = account.roots.some((r) => isUnder(root, posix(r)) || isUnder(posix(r), root));
    if (!covers) continue;
    const key = `${MIGRATED_PREFIX}${account.id}:${rootAbs}`;
    // eslint-disable-next-line no-await-in-loop
    if ((await d.db.all(`SELECT 1 FROM meta WHERE key = ?`, [key])).length > 0) continue;
    try {
      // First the pull: one under way with the old (empty) exclusions could
      // otherwise commit a document under the root after it was looked for.
      // eslint-disable-next-line no-await-in-loop
      await d.localFolders.quiesce(account.id);
      // eslint-disable-next-line no-await-in-loop
      const archived = await archiveUnder(d, account.id, root);
      // eslint-disable-next-line no-await-in-loop
      await d.db.run(`INSERT OR IGNORE INTO meta(key, value) VALUES(?, '1')`, [key]);
      d.log('info', `moved ${archived} local-folder document(s) under ${rootAbs} to the shared folders`);
    } catch (err) {
      d.log('warn', `could not move the local-folder documents under ${rootAbs}: ${String(err)}`);
    }
  }
}

async function archiveUnder(d: MigrateDeps, accountId: string, root: string): Promise<number> {
  const prefix = `${root}/`;
  const fold = (col: string): string => (caseFold ? `lower(${col})` : col);
  let afterId = '';
  let afterType = '';
  let total = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const rows = (await d.db.all(
      `SELECT external_id, type FROM documents
        WHERE account_id = ? AND archived_at IS NULL
          AND (external_id, type) > (?, ?)
          AND ${fold('substr(external_id, 1, ?)')} = ${caseFold ? 'lower(?)' : '?'}
        ORDER BY external_id, type LIMIT ?`,
      [accountId, afterId, afterType, prefix.length, prefix, PAGE],
    )) as unknown as { external_id: string; type: string }[];
    if (rows.length === 0) return total;
    const refs = rows.map((r): ExternalRef => ({ externalId: r.external_id, type: r.type }));
    // eslint-disable-next-line no-await-in-loop
    await d.localFolders.archive(accountId, refs);
    total += refs.length;
    afterId = rows[rows.length - 1].external_id;
    afterType = rows[rows.length - 1].type;
  }
}
