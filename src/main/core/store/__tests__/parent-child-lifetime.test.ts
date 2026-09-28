/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { DocumentInput } from '@shared/contracts';

import { openDb } from '../../../db/app-db';
import { openStore } from '../store';
import type { CoreStore } from '../store';

/** Children (attachments) live and die with their parent: a mail source
 *  never lists them in reconcile, and deleting the message must not orphan
 *  them. */
describe('parent/child lifetime', () => {
  let dir: string;
  let store: CoreStore;
  let accountId: string;

  const msg = (id: string): DocumentInput => ({
    externalId: id,
    type: 'email.message',
    title: id,
    markdown: `body ${id}`,
    metadata: {},
    createdAt: null,
  });
  const att = (id: string, parent: string): DocumentInput => ({
    externalId: id,
    type: 'attachment',
    title: `${id}.docx`,
    markdown: null,
    metadata: { filename: `${id}.docx` },
    createdAt: null,
    parent: { externalId: parent, type: 'email.message' },
  });
  const archived = async (externalId: string, type: string) =>
    (await store.read.byExternalId(accountId, externalId, type))!.archivedAt !==
    null;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-lifetime-'));
    store = await openStore(await openDb(path.join(dir, 't.db')), {
      encrypt: (s: string) => Buffer.from(s, 'utf8'),
      decrypt: (b: Buffer) => b.toString('utf8'),
      detectLanguages: () => [],
    });
    accountId = (await store.createAccount({ source: 'imap', identifier: 'x' }))
      .id;
    await store.commit({
      account: accountId,
      documents: [msg('m1'), att('m1#0', 'm1'), msg('m2'), att('m2#0', 'm2')],
      cursor: 1,
    });
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function reconcile(listed: string[]) {
    const startSeq = await store.headSeq();
    await store.reconcileBegin(accountId);
    await store.reconcileStage(
      accountId,
      listed.map((externalId) => ({ externalId, type: 'email.message' })),
    );
    const diff = await store.reconcileDiff(accountId, startSeq);
    const n = await store.reconcileArchive(accountId, startSeq);
    await store.reconcileEnd(accountId);
    return { diff, n };
  }

  it('reconcile keeps an unlisted child whose parent is listed, and archives both when the parent is gone', async () => {
    await reconcile(['m1']);
    expect(await archived('m1', 'email.message')).toBe(false);
    expect(await archived('m1#0', 'attachment')).toBe(false); // covered by m1
    expect(await archived('m2', 'email.message')).toBe(true);
    expect(await archived('m2#0', 'attachment')).toBe(true);
  });

  it('reconcile archives a child with its parent even when the child changed mid-pass', async () => {
    const startSeq = await store.headSeq();
    await store.reconcileBegin(accountId);
    await store.reconcileStage(accountId, [
      { externalId: 'm1', type: 'email.message' },
    ]);
    // The convert worker enriches m2's attachment during the pass: its seq
    // is now past the snapshot, so it is not itself eligible.
    const child = await store.read.byExternalId(
      accountId,
      'm2#0',
      'attachment',
    );
    await store.commit({
      consumer: 'worker:convert:v1',
      cursor: 0,
      enrich: [
        { documentId: child!.id, metadata: { conversion: { status: 'ok' } } },
      ],
    } as never);
    await store.reconcileArchive(accountId, startSeq);
    await store.reconcileEnd(accountId);
    expect(await archived('m2', 'email.message')).toBe(true);
    expect(await archived('m2#0', 'attachment')).toBe(true);
  });

  it('a deletion archives the message and its attachments together', async () => {
    await store.commit({
      account: accountId,
      documents: [],
      deletions: [{ externalId: 'm1', type: 'email.message' }],
      cursor: 2,
    });
    expect(await archived('m1', 'email.message')).toBe(true);
    expect(await archived('m1#0', 'attachment')).toBe(true);
    expect(await archived('m2#0', 'attachment')).toBe(false);
  });
});
