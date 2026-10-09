/** @jest-environment node */
/**
 * #59 §0: every writer that moves `documents.seq` appends a `document`-kind
 * change with that same seq (archive and restore included). The feed
 * materializer and `changesAt` rely on it — a ledger seq is always the
 * document's current seq.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { AccountId, DocumentInput } from '@shared/contracts';

import { openDb, type AppDb } from '../../../db/app-db';
import { openStore, type CoreStore } from '../store';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};

const doc = (
  externalId: string,
  over: Partial<DocumentInput> = {},
): DocumentInput => ({
  externalId,
  type: 'note',
  title: externalId,
  markdown: `body ${externalId}`,
  metadata: {},
  createdAt: '2026-01-01T00:00:00Z',
  ...over,
});

describe('documents.seq always has its own document change (#59 §0)', () => {
  let dir: string;
  let db: AppDb;
  let store: CoreStore;
  let accountId: AccountId;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-seqinv-'));
    db = await openDb(path.join(dir, 'test.db'));
    store = openStore(db, deps);
    accountId = (
      await store.createAccount({ source: 'test', identifier: 'me' })
    ).id;
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const orphans = () =>
    db.all(
      `SELECT d.id, d.seq FROM documents d
        WHERE d.seq > 0 AND NOT EXISTS (
          SELECT 1 FROM changes c
           WHERE c.seq = d.seq AND c.kind = 'document' AND c.ref_id = d.id)`,
    );

  const idOf = async (externalId: string): Promise<string> =>
    (
      (await db.all(`SELECT id FROM documents WHERE external_id = ?`, [
        externalId,
      ])) as Array<{ id: string }>
    )[0].id;

  it('insert, update, reparent, archive with children, restore', async () => {
    await store.commit({
      account: accountId,
      documents: [
        doc('parent'),
        doc('child', { parent: { externalId: 'parent', type: 'note' } }),
      ],
      cursor: 1,
    });
    await store.commit({
      account: accountId,
      documents: [doc('parent', { markdown: 'edited' })],
      cursor: 2,
    });
    // Child before its parent in one batch: reconcileParents re-stamps it.
    await store.commit({
      account: accountId,
      documents: [
        doc('orphan', { parent: { externalId: 'later', type: 'note' } }),
        doc('later'),
      ],
      cursor: 3,
    });
    // Upstream deletion archives the parent and its live child.
    await store.commit({
      account: accountId,
      documents: [],
      deletions: [{ externalId: 'parent', type: 'note' }],
      cursor: 4,
    });
    // Same content again restores it (archived_at = NULL).
    await store.commit({
      account: accountId,
      documents: [doc('parent', { markdown: 'edited' })],
      cursor: 5,
    });
    expect(await orphans()).toEqual([]);
  });

  it('worker emissions and both enrich forms', async () => {
    await store.commit({
      account: accountId,
      documents: [doc('a'), doc('b')],
      cursor: 1,
    });
    await store.commit({
      consumer: 'worker:t:v1',
      cursor: 0,
      documents: [doc('emitted')],
      enrich: [
        { documentId: (await idOf('a')) as never, metadata: { tag: 'x' } },
        { documentId: (await idOf('b')) as never, markdown: 'new body' },
      ],
    });
    expect(await orphans()).toEqual([]);
  });

  it('reconcile archive and folder-scope archive', async () => {
    await store.commit({
      account: accountId,
      documents: [doc('keep'), doc('gone')],
      cursor: 1,
    });
    const startSeq = await store.headSeq();
    await store.reconcileBegin(accountId);
    await store.reconcileStage(accountId, [
      { externalId: 'keep', type: 'note' },
    ]);
    await store.reconcileDiff(accountId, startSeq);
    expect(await store.reconcileArchive(accountId, startSeq)).toBe(1);

    const scoped = await store.createAccount({
      source: 'local-folder',
      identifier: '/tmp/x',
      config: { folderRoots: [{ id: 'X', name: 'X' }] },
    });
    await store.commit({
      account: scoped.id,
      documents: [doc('in-x', { type: 'file', scopeRootId: 'X' })],
      cursor: null,
    });
    const r = await store.applyFolderScope({
      accountId: scoped.id,
      config: { folderRoots: [] },
      cursor: null,
      archiveScopeRootIds: ['X'],
      reattributeScopeRoots: [],
      archiveRefs: [],
      expectedConfigJson: JSON.stringify(scoped.config),
    });
    expect(r.archived).toBe(1);
    expect(await orphans()).toEqual([]);
  });
});
