import fs from 'fs';
import os from 'os';
import path from 'path';

import type { AccountId, Change, DocumentInput } from '@shared/contracts';

import { openStore } from '../store';
import type { CoreStore } from '../store';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};

function doc(externalId: string, over: Partial<DocumentInput> = {}): DocumentInput {
  return {
    externalId,
    type: 'note',
    title: `Title ${externalId}`,
    markdown: `Body of ${externalId} with searchable words`,
    metadata: {},
    createdAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

describe('store', () => {
  let dir: string;
  let store: CoreStore;
  let accountId: AccountId;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-store-'));
    store = openStore(path.join(dir, 'test.db'), deps);
    const account = await store.createAccount({
      source: 'test',
      identifier: 'me@example.com',
    });
    accountId = account.id;
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('commits documents with cursor atomically and feeds them in order', async () => {
    await store.commit({
      account: accountId,
      documents: [doc('a'), doc('b', { parent: { externalId: 'a', type: 'note' } })],
      cursor: { page: 1 },
      status: 'backfilling',
    });

    const acc = await store.account(accountId);
    expect(acc?.cursor).toEqual({ page: 1 });
    expect(acc?.status).toBe('backfilling');

    const a = await store.read.byExternalId(accountId, 'a', 'note');
    const b = await store.read.byExternalId(accountId, 'b', 'note');
    expect(a).not.toBeNull();
    expect(b?.parentId).toBe(a?.id); // parent resolved in-transaction
    expect(a?.languages).toEqual(['eng']);
  });

  it('is idempotent: unchanged content produces no feed churn', async () => {
    await store.commit({ account: accountId, documents: [doc('a')], cursor: 1 });
    const head1 = store.headSeq();
    await store.commit({ account: accountId, documents: [doc('a')], cursor: 2 });
    const head2 = store.headSeq();
    // Only the account-cursor change row lands; the document row does not.
    expect(head2 - head1).toBe(1);
  });

  it('archives upstream deletions and hides them from default queries', async () => {
    await store.commit({ account: accountId, documents: [doc('a'), doc('b')], cursor: 1 });
    await store.commit({
      account: accountId,
      documents: [],
      deletions: [{ externalId: 'a', type: 'note' }],
      cursor: 2,
    });
    expect(await store.read.count({ account: accountId })).toBe(1);
    expect(await store.read.count({ account: accountId, includeArchived: true })).toBe(2);
    const gone = await store.read.byExternalId(accountId, 'a', 'note');
    expect(gone?.archivedAt).not.toBeNull();
  });

  it('liveRefs: lists (externalId, type, seq) for non-archived documents only — the reconcile diff surface', async () => {
    await store.commit({
      account: accountId,
      documents: [doc('a'), doc('b'), doc('c', { type: 'attachment' })],
      cursor: 1,
    });
    await store.commit({
      account: accountId,
      documents: [],
      deletions: [{ externalId: 'a', type: 'note' }],
      cursor: 2,
    });

    const refs = store.liveRefs(accountId);
    const stripped = refs
      .map(({ externalId, type }) => ({ externalId, type }))
      .sort((x, y) => x.externalId.localeCompare(y.externalId));
    expect(stripped).toEqual([
      { externalId: 'b', type: 'note' },
      { externalId: 'c', type: 'attachment' },
    ]);
    // seq lets reconcilePass exclude documents committed after its listing
    // snapshot was taken (the TOCTOU guard in engine.ts) — every live ref
    // must carry one.
    expect(refs.every((r) => typeof r.seq === 'number' && r.seq > 0)).toBe(true);
  });

  it('purges archived documents with tombstones into the feed', async () => {
    await store.commit({ account: accountId, documents: [doc('a')], cursor: 1 });
    await store.commit({
      account: accountId,
      documents: [],
      deletions: [{ externalId: 'a', type: 'note' }],
      cursor: 2,
    });
    await store.commit({ purgeArchived: { before: '2999-01-01' } });
    expect(await store.read.count({ account: accountId, includeArchived: true })).toBe(0);

    const changes: Change[] = [];
    for await (const batch of store.feed(0)) {
      changes.push(...batch);
      if (changes.some((c) => c.kind === 'purge')) break;
    }
    expect(changes.some((c) => c.kind === 'purge')).toBe(true);
  });

  it('removeAccount cascades: documents, vault, account, FTS rows, one tombstone', async () => {
    await store.vault.save(accountId, { accessToken: 'tok' });
    await store.commit({
      account: accountId,
      documents: [doc('a', { markdown: 'zanzibar expedition ledger' })],
      cursor: 1,
    });
    expect(await store.read.search({ text: 'zanzibar' })).toHaveLength(1);
    await store.commit({ removeAccount: accountId });

    expect(await store.account(accountId)).toBeNull();
    expect(await store.vault.load(accountId)).toBeNull();
    expect(await store.read.count({ includeArchived: true })).toBe(0);
    expect(await store.read.search({ text: 'zanzibar' })).toHaveLength(0);

    const changes: Change[] = [];
    for await (const batch of store.feed(0)) {
      changes.push(...batch);
      if (changes.some((c) => c.kind === 'accountRemoved')) break;
    }
    expect(changes.some((c) => c.kind === 'accountRemoved')).toBe(true);
  });

  it('searches with FTS and returns snippets', async () => {
    await store.commit({
      account: accountId,
      documents: [
        doc('a', { markdown: 'the quarterly budget review meeting notes' }),
        doc('b', { markdown: 'photos from the beach holiday' }),
      ],
      cursor: 1,
    });
    const hits = await store.read.search({ text: 'budget review' });
    expect(hits).toHaveLength(1);
    expect(hits[0].externalId).toBe('a');
    expect(hits[0].snippet).toContain('budget');
  });

  it('search: no-text listing orders by document date, not write order', async () => {
    // Commit in newest-first order — exactly what a Gmail backfill does —
    // so write order (updated_at) is the REVERSE of document date.
    await store.commit({
      account: accountId,
      documents: [doc('new', { createdAt: '2026-07-01T00:00:00Z' })],
      cursor: 1,
    });
    await store.commit({
      account: accountId,
      documents: [doc('old', { createdAt: '2026-01-05T00:00:00Z' })],
      cursor: 2,
    });
    await store.commit({
      account: accountId,
      documents: [doc('mid', { createdAt: '2026-03-15T00:00:00Z' })],
      cursor: 3,
    });
    const hits = await store.read.search({});
    expect(hits.map((h) => h.externalId)).toEqual(['new', 'mid', 'old']);
  });

  it('search: fromDate/toDate bound the document origin date', async () => {
    await store.commit({
      account: accountId,
      documents: [
        doc('jan', { createdAt: '2026-01-10T00:00:00Z' }),
        doc('jun', { createdAt: '2026-06-25T00:00:00Z', markdown: 'budget' }),
        doc('jul', { createdAt: '2026-07-02T00:00:00Z' }),
        // Undated → falls back to ingested_at (now), outside the range below.
        doc('undated', { createdAt: null }),
      ],
      cursor: 1,
    });
    const listed = await store.read.search({
      fromDate: '2026-06-23T00:00:00Z',
      toDate: '2026-06-30T00:00:00Z',
    });
    expect(listed.map((h) => h.externalId)).toEqual(['jun']);

    const fts = await store.read.search({
      text: 'budget',
      fromDate: '2026-06-23T00:00:00Z',
      toDate: '2026-06-30T00:00:00Z',
    });
    expect(fts.map((h) => h.externalId)).toEqual(['jun']);

    const ftsExcluded = await store.read.search({
      text: 'budget',
      toDate: '2026-06-01T00:00:00Z',
    });
    expect(ftsExcluded).toEqual([]);
  });

  it('search: boolean query syntax — OR, negation, phrase, prefix, groups', async () => {
    await store.commit({
      account: accountId,
      documents: [
        doc('a', { markdown: 'the quarterly budget review meeting' }),
        doc('b', { markdown: 'photos from the beach holiday' }),
        doc('c', { markdown: 'budget for the beach house' }),
      ],
      cursor: 1,
    });
    const ids = async (text: string) =>
      (await store.read.search({ text })).map((h) => h.externalId).sort();

    expect(await ids('budget beach')).toEqual(['c']); // implicit AND
    expect(await ids('budget OR beach')).toEqual(['a', 'b', 'c']);
    expect(await ids('budget -beach')).toEqual(['a']);
    expect(await ids('budget NOT beach')).toEqual(['a']);
    expect(await ids('"budget review"')).toEqual(['a']); // adjacent phrase
    expect(await ids('"review budget"')).toEqual([]); // reversed — not adjacent
    expect(await ids('budg*')).toEqual(['a', 'c']); // prefix
    expect(await ids('(budget OR holiday) -review')).toEqual(['b', 'c']);
    // lowercase or/and/not are plain terms, not operators
    expect(await ids('budget or beach')).toEqual([]);
  });

  it('search: malformed queries throw descriptive errors, never FTS5 ones', async () => {
    await store.commit({ account: accountId, documents: [doc('a')], cursor: 1 });
    await expect(store.read.search({ text: '-beach' })).rejects.toThrow(
      /needs at least one positive term/,
    );
    await expect(store.read.search({ text: '(budget' })).rejects.toThrow(
      /missing closing/,
    );
    await expect(store.read.search({ text: 'budget)' })).rejects.toThrow(
      /unmatched/,
    );
    // Raw FTS5 footguns are neutralized by quoting, not thrown:
    const hits = await store.read.search({ text: 'colon: near "unclosed' });
    expect(Array.isArray(hits)).toBe(true);
  });

  it('worker emissions commit atomically with the consumer cursor', async () => {
    await store.commit({
      consumer: 'worker:summarizer:v1',
      cursor: 42,
      documents: [doc('summary-1', { type: 'summary' })],
    });
    expect(store.consumerCursor('worker:summarizer:v1')).toBe(42);
    const synthetic = (await store.read.accounts()).find((a) => a.source === 'worker');
    expect(synthetic?.identifier).toBe('worker:summarizer:v1');
    expect(await store.read.count({ type: 'summary' })).toBe(1);
  });

  it('persists credentials encrypted and consents append-only', async () => {
    await store.vault.save(accountId, { accessToken: 't1', refreshToken: 'r1' });
    expect(await store.vault.load(accountId)).toEqual({ accessToken: 't1', refreshToken: 'r1' });

    await store.consents.record({
      extensionId: 'ext-1',
      caps: ['query'],
      manifestVersion: '1.0.0',
      grantedAt: '2026-01-01T00:00:00Z',
    });
    await store.consents.record({
      extensionId: 'ext-1',
      caps: ['query', 'net'],
      manifestVersion: '1.1.0',
      grantedAt: '2026-02-01T00:00:00Z',
    });
    const latest = await store.consents.latest('ext-1');
    expect(latest?.caps).toEqual(['query', 'net']);
  });

  it('enrich: updates markdown + merged metadata, reindexes FTS, one feed change', async () => {
    await store.commit({
      account: accountId,
      documents: [doc('scan', { markdown: null, metadata: { mime: 'application/pdf' } })],
      cursor: 1,
    });
    const before = await store.read.byExternalId(accountId, 'scan', 'note');
    const head = store.headSeq();

    await store.commit({
      consumer: 'worker:vision:v1',
      cursor: 7,
      enrich: [
        {
          documentId: before!.id,
          markdown: 'invoice total 42 EUR',
          metadata: { extraction: { engine: 'local-ocr' } },
        },
      ],
    });

    const after = await store.read.document(before!.id);
    expect(after?.markdown).toBe('invoice total 42 EUR');
    expect((after?.metadata as { mime?: string }).mime).toBe('application/pdf'); // merged, not replaced
    expect((after?.metadata as { extraction?: { engine: string } }).extraction?.engine).toBe('local-ocr');
    expect(after?.contentHash).toBe(before?.contentHash); // untouched — source content still dedupes
    expect(store.consumerCursor('worker:vision:v1')).toBe(7);
    expect(store.headSeq()).toBe(head + 1); // exactly one 'document' change

    const hits = await store.read.search({ text: 'invoice' });
    expect(hits.map((h) => h.externalId)).toEqual(['scan']);
  });

  it('enrich: unknown documentId is skipped silently (doc purged since worker read it)', async () => {
    await store.commit({
      consumer: 'worker:vision:v1',
      cursor: 8,
      enrich: [{ documentId: 'no-such-id', markdown: 'x' }],
    });
    expect(store.consumerCursor('worker:vision:v1')).toBe(8);
  });

  it('extractionStats: counts exclude archived/non-image; recent carries filename', async () => {
    await store.commit({
      account: accountId,
      documents: [
        // OCR-eligible, not yet processed: two images + one PDF.
        doc('img-1', {
          metadata: { mime: 'image/png', filename: 'scan-1.png' },
        }),
        doc('img-2', {
          metadata: { mime: 'image/jpeg', filename: 'scan-2.jpg' },
        }),
        doc('pdf-1', {
          metadata: { mime: 'application/pdf', filename: 'doc.pdf' },
        }),
        // Already processed — nested marker, as the vision worker writes it.
        doc('done-1', {
          title: null,
          metadata: {
            mime: 'image/png',
            filename: 'receipt.png',
            extraction: { engine: 'local-ocr', at: '2026-01-02T00:00:00Z' },
          },
        }),
        // Processed but archived — excluded from counts AND recent.
        doc('done-archived', {
          metadata: {
            mime: 'image/png',
            extraction: { engine: 'local-ocr+vlm', at: '2026-01-02T00:00:00Z' },
          },
        }),
        // Non-image doc — not OCR-eligible.
        doc('note-1'),
      ],
      cursor: 1,
    });
    await store.commit({
      account: accountId,
      documents: [],
      deletions: [{ externalId: 'done-archived', type: 'note' }],
      cursor: 2,
    });

    const stats = store.extractionStats();
    expect(stats.pendingOcr).toBe(3); // img-1, img-2, pdf-1 — note-1 and processed docs excluded
    expect(stats.processed).toBe(1); // done-1 only — the archived processed doc excluded
    expect(stats.recent).toHaveLength(1);
    const done = await store.read.byExternalId(accountId, 'done-1', 'note');
    expect(stats.recent[0]).toMatchObject({
      id: done!.id,
      title: null,
      filename: 'receipt.png',
      type: 'note',
      engine: 'local-ocr',
    });
    expect(stats.recent[0].updatedAt).toBe(done!.updatedAt);
  });

  it('extractionStats: recent is newest-first and capped at 10', async () => {
    for (let i = 1; i <= 12; i += 1) {
      // Sequential commits: updated_at is non-decreasing and seq strictly
      // increases, so "newest" is deterministically the last commit.
      // eslint-disable-next-line no-await-in-loop
      await store.commit({
        account: accountId,
        documents: [
          doc(`p-${i}`, {
            metadata: {
              mime: 'image/png',
              extraction: {
                engine: i % 2 ? 'local-ocr' : 'local-ocr+vlm',
                at: '2026-01-02T00:00:00Z',
              },
            },
          }),
        ],
        cursor: i,
      });
    }
    const stats = store.extractionStats();
    expect(stats.processed).toBe(12);
    expect(stats.recent).toHaveLength(10);
    expect(stats.recent.map((r) => r.title)).toEqual(
      [12, 11, 10, 9, 8, 7, 6, 5, 4, 3].map((i) => `Title p-${i}`),
    );
    expect(stats.recent[0].engine).toBe('local-ocr+vlm'); // 12 is even
    expect(stats.recent[0].filename).toBeNull(); // no filename in metadata
  });

  it('createAccount upserts on (source, identifier): same id, config replaced, status updated, one change appended', async () => {
    const first = await store.createAccount({
      source: 'imap',
      identifier: 'me@example.com',
      config: { host: 'a' },
      status: 'connecting',
    });
    const headBefore = store.headSeq();

    const second = await store.createAccount({
      source: 'imap',
      identifier: 'me@example.com',
      config: { host: 'b' },
      status: 'live',
    });

    expect(second.id).toBe(first.id); // existing row's id, not a new one
    expect(second.config).toEqual({ host: 'b' }); // replaced by the second call's config
    expect(second.status).toBe('live');
    expect(second.createdAt).toBe(first.createdAt); // not clobbered on conflict
    expect(store.headSeq()).toBe(headBefore + 1); // exactly one change appended

    const rows = (await store.read.accounts()).filter((a) => a.source === 'imap');
    expect(rows).toHaveLength(1); // one row, not two
  });

  it('createAccount: a different identifier for the same source creates a separate account', async () => {
    const a = await store.createAccount({ source: 'imap', identifier: 'a@example.com' });
    const b = await store.createAccount({ source: 'imap', identifier: 'b@example.com' });
    expect(a.id).not.toBe(b.id);
    const rows = (await store.read.accounts()).filter((r) => r.source === 'imap');
    expect(rows).toHaveLength(2);
  });

  it('setAccountConfig: updates config and appends an account change', async () => {
    const headBefore = store.headSeq();
    await store.setAccountConfig(accountId, { roots: ['/a', '/b'] });
    const acc = await store.account(accountId);
    expect(acc?.config).toEqual({ roots: ['/a', '/b'] });
    expect(store.headSeq()).toBe(headBefore + 1);

    const changes: Change[] = [];
    for await (const batch of store.feed(0)) {
      changes.push(...batch);
      if (changes.length >= store.headSeq()) break;
    }
    const last = changes[changes.length - 1];
    expect(last.kind).toBe('account');
    expect((last as { account: { id: AccountId } }).account.id).toBe(accountId);
  });

  it('resetAll empties the corpus AND reclaims disk (checkpoint + vacuum)', async () => {
    // ~2MB of markdown so the on-disk footprint is unambiguous.
    const big = 'x'.repeat(10_000);
    for (let i = 0; i < 20; i += 1) {
      await store.commit({
        account: accountId,
        documents: Array.from({ length: 10 }, (_, j) =>
          doc(`bulk-${i}-${j}`, { markdown: big }),
        ),
        cursor: i,
      });
    }
    const dbFile = path.join(dir, 'test.db');
    const walFile = `${dbFile}-wal`;
    const sizeOf = (): number =>
      fs.statSync(dbFile).size +
      (fs.existsSync(walFile) ? fs.statSync(walFile).size : 0);
    const before = sizeOf();

    await store.maintenance.resetAll();

    expect(await store.read.count({ includeArchived: true })).toBe(0);
    expect(await store.read.accounts()).toEqual([]);
    // DELETE alone leaves freed pages in the file (and a fat WAL) — the
    // Storage screen's "Database size" tile reads file sizes, so a reset
    // must actually shrink them.
    expect(sizeOf()).toBeLessThan(before / 2);
  });

  it('resetAll preserves extension consents', async () => {
    // Installed extensions live on disk outside the DB and survive a factory
    // reset; their consent grants must survive with them, or every installed
    // extension comes back needs-consent and its sources vanish from Add
    // Sources while the Marketplace still shows it installed.
    await store.consents.record({
      extensionId: 'ext-1',
      caps: ['query'],
      manifestVersion: '1.0.0',
      grantedAt: '2026-01-01T00:00:00Z',
    });

    await store.maintenance.resetAll();

    const latest = await store.consents.latest('ext-1');
    expect(latest?.caps).toEqual(['query']);
    expect(latest?.manifestVersion).toBe('1.0.0');
  });
});
