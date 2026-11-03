/** Device-owned accounts (alpha-cent spec 7.8, r16 rulings 4 and 8): what an
 *  owner sends to the leader, and how the leader takes it. */
import type { CommitBatch } from '@shared/contracts';

import type { AppDb } from '../../db/app-db';
import type { CoreStore } from '../store/store';
import type { FolderScopeInput } from '../store/write-tx';

/** The account an owner's batch belongs to. The leader may never have heard of
 *  it, so the row travels with every batch. */
export interface OwnedAccount {
  id: string;
  source: string;
  identifier: string;
  config: Record<string, unknown>;
  cadence: unknown;
  ownerDeviceId: string | null;
}

/** An owner's folder-scope edit, delivered as `core.folderScope`. */
export interface ScopeInput {
  account: OwnedAccount;
  scope: FolderScopeInput;
}

export interface CommitInput {
  account: OwnedAccount;
  batch: CommitBatch;
}

/** 16 MiB: the cap on a forwarded request. */
export const MAX_BATCH_BYTES = 16 * 1024 * 1024;

/** Splits an account batch at item boundaries so each piece stays under
 *  `maxBytes`. Only the last piece carries the cursor, status, progress,
 *  error, deletions and relink, so a crash between pieces never moves the
 *  cursor past documents the leader has not seen. Anything that is not an
 *  account batch with documents stays whole. */
export function splitBatch(batch: CommitBatch, maxBytes = MAX_BATCH_BYTES): CommitBatch[] {
  const b = batch as unknown as { account?: string; documents?: unknown[] } & Record<string, unknown>;
  if (!('account' in b) || !Array.isArray(b.documents) || b.documents.length < 2) return [batch];
  if (JSON.stringify(batch).length <= maxBytes) return [batch];
  const { documents, ...tail } = b;
  const parts: unknown[][] = [];
  let cur: unknown[] = [];
  let size = 0;
  // Room for the envelope around the documents.
  const budget = Math.max(1, maxBytes - JSON.stringify({ ...tail, documents: [] }).length);
  for (const d of documents) {
    const n = JSON.stringify(d).length + 1;
    if (cur.length > 0 && size + n > budget) {
      parts.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(d);
    size += n;
  }
  if (cur.length) parts.push(cur);
  return parts.map((docs, i) =>
    (i === parts.length - 1
      ? { ...tail, documents: docs }
      : { account: b.account, documents: docs, cursor: undefined }) as unknown as CommitBatch,
  );
}

/** Leader side of `core.commitBatch`: makes sure the owner's account row is
 *  here, then commits. Both steps are idempotent, so a resend leaves one row
 *  and one document per natural key. The account is matched on
 *  `(source, identifier)`, and if the leader already holds it under another
 *  id the batch is moved to that id. The leader never runs the account: a new
 *  row rests as `paused`, as an offered one does (step 1). */
export async function runCommitBatch(
  deps: { db: Pick<AppDb, 'all' | 'run'>; store: Pick<CoreStore, 'commit' | 'applyFolderScope'> },
  input: CommitInput | ScopeInput,
): Promise<void> {
  if ('scope' in input) {
    // A folder-scope edit the owner made. The owner is the authority on its
    // own account, so the stale-config guard compares against what this
    // device holds now; the roots and the archive list are the owner's.
    const row = (await deps.db.all(`SELECT id, config FROM accounts WHERE source = ? AND identifier = ?`, [
      input.account.source,
      input.account.identifier,
    ])) as { id: string; config: string }[];
    if (!row[0]) return;
    await deps.store.applyFolderScope({
      ...input.scope,
      accountId: row[0].id as never,
      expectedConfigJson: row[0].config,
    });
    return;
  }
  const a = input.account;
  const found = (await deps.db.all(`SELECT id FROM accounts WHERE source = ? AND identifier = ?`, [
    a.source,
    a.identifier,
  ])) as { id: string }[];
  let id = found[0]?.id;
  if (!id) {
    if ('removeAccount' in input.batch) return;
    await deps.db.run(
      `INSERT INTO accounts(id, source, identifier, config, status, cadence, created_at, owner_device_id)
       VALUES(?, ?, ?, ?, 'paused', ?, ?, ?)
       ON CONFLICT(source, identifier) DO NOTHING`,
      [
        a.id,
        a.source,
        a.identifier,
        JSON.stringify(a.config ?? {}),
        a.cadence ? JSON.stringify(a.cadence) : null,
        new Date().toISOString(),
        a.ownerDeviceId,
      ],
    );
    id = a.id;
  }
  const moved =
    'removeAccount' in input.batch
      ? ({ removeAccount: id } as unknown as CommitBatch)
      : ({ ...(input.batch as object), account: id } as unknown as CommitBatch);
  await deps.store.commit(moved);
}
