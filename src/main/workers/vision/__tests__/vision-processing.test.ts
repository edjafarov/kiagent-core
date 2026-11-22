import fs from 'fs';
import os from 'os';
import path from 'path';

import type {
  AccountId,
  Change,
  Document,
  WorkerSession,
} from '@shared/contracts';
import { openDb } from '@main/db/app-db';
import { openStore } from '@main/core/store/store';
import { createEngine } from '@main/core/engine/engine';
import { VISION_CONSUMER } from '@main/workers';
import { createVisionWorker } from '@main/workers/vision/vision-worker';
import { FetchDeferredError } from '@main/core/engine/fetch-deferred';
import { pruneChangesOnce } from '@main/core/changes-maintenance';

// Core OCRs a PDF only after its parser found it text-poor (a scan).
const SCANNED = { status: 'text-poor', at: '2026-01-01' };

const document = {
  id: 'd',
  accountId: 'a',
  externalId: 'scan',
  type: 'attachment',
  title: 'scan.pdf',
  markdown: null,
  metadata: {
    mime: 'application/pdf',
    sizeBytes: 50_000,
    conversion: SCANNED,
  },
  createdAt: null,
  parentId: null,
  contentHash: 'hash',
  seq: 1,
  ingestSeq: 1,
  archivedAt: null,
  languages: [],
  ingestedAt: '2026-01-01',
  updatedAt: '2026-01-01',
  scopeRootId: null,
} as Document;

function session(over: Partial<WorkerSession> = {}): WorkerSession {
  return {
    signal: new AbortController().signal,
    inference: async () => '',
    see: async () => '',
    seeWithMeta: async () => ({ text: '', providerId: 'local', modelId: 'm' }),
    read: async () => 'thin',
    hear: async () => '',
    fetchBytes: async () => new Uint8Array(100_000),
    emit: () => {},
    enrich: () => {},
    log: () => {},
    bump: async () => 1,
    mayBecomeReady: () => false,
    ...over,
  };
}

const scan = (externalId: string) => ({
  externalId,
  type: 'attachment',
  title: `${externalId}.pdf`,
  markdown: null,
  metadata: { mime: 'application/pdf', sizeBytes: 50_000, conversion: SCANNED },
  createdAt: '2026-01-01T00:00:00Z',
});

const recoverWorker = (worked: string[] = []) => ({
  name: 'vision',
  version: 1,
  matches: (change: Change) =>
    change.kind === 'document' && !change.document.metadata.extraction,
  work: async (change: Change, workerSession: WorkerSession) => {
    if (change.kind !== 'document') return 'skip' as const;
    worked.push(change.document.externalId);
    workerSession.enrich({
      documentId: change.document.id,
      markdown: 'Recovered text from scan',
      metadata: {
        extraction: { engine: 'local-ocr', at: '2026-01-01T00:00:00Z' },
      },
    });
    return 'done' as const;
  },
});

async function visionFixture(
  prep?: (db: Awaited<ReturnType<typeof openDb>>) => Promise<void>,
  admission?: Parameters<typeof createEngine>[0]['admission'],
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kia-vision-59-'));
  const db = await openDb(path.join(dir, 'test.db'));
  await prep?.(db);
  const store = openStore(db, {
    encrypt: (s: string) => Buffer.from(s),
    decrypt: (b: Buffer) => b.toString(),
    detectLanguages: () => ['eng'],
  });
  const engine = createEngine({
    store,
    sources: { get: () => undefined },
    inference: {
      complete: async () => '',
      see: async () => '',
      read: async () => '',
      hear: async () => '',
    },
    convert: async (input) => input,
    logs: { log: () => {} },
    admission,
  });
  const account = await store.createAccount({
    source: 'test',
    identifier: 'local',
  });
  const cleanup = async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { db, store, engine, account, cleanup };
}

it('bounds a failing OCR helper rather than deferring it forever', async () => {
  const worker = createVisionWorker({
    rasterizer: {
      pdfToPngs: async () => ({
        pageCount: 1,
        pages: [{ page: 1, png: new Uint8Array([1]) }],
      }),
    },
    laneOpen: () => true,
  });
  const change = { seq: 1, kind: 'document', document } as Change;
  const outcome = await worker.work(
    change,
    session({
      read: async () => {
        throw new Error('helper crashed');
      },
    }),
  );
  expect(outcome).toBe('retry');
});

it('leaves a failed download to core, which parks it without spending retries', async () => {
  const worker = createVisionWorker({
    rasterizer: {
      pdfToPngs: async () => ({
        pageCount: 1,
        pages: [{ page: 1, png: new Uint8Array([1]) }],
      }),
    },
    laneOpen: () => true,
  });
  const change = { seq: 1, kind: 'document', document } as Change;
  const offline = new FetchDeferredError('gmail fetchBytes failed: offline');
  await expect(
    worker.work(
      change,
      session({
        fetchBytes: async () => {
          throw offline;
        },
      }),
    ),
  ).rejects.toBe(offline);
});

it('eventually removes a document from retryable work and can repair missed work', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kia-vision-queue-'));
  const db = await openDb(path.join(dir, 'test.db'));
  const store = openStore(db, {
    encrypt: (s: string) => Buffer.from(s),
    decrypt: (b: Buffer) => b.toString(),
    detectLanguages: () => ['eng'],
  });
  const queue = store as typeof store & {
    ledgerMissingVision(
      consumer: string,
      after: number,
      limit: number,
    ): Promise<number[]>;
    ledgerRetry(
      consumer: string,
      seq: number,
    ): Promise<{ attempts: number; outcome: 'deferred' | 'failed' }>;
  };
  try {
    const account = await store.createAccount({
      source: 'test',
      identifier: 'local',
    });
    const id = account.id as AccountId;
    await store.commit({
      account: id,
      documents: [
        {
          externalId: 'scan',
          type: 'attachment',
          title: 'scan.pdf',
          markdown: null,
          metadata: {
            mime: 'application/pdf',
            sizeBytes: 50_000,
            conversion: SCANNED,
          },
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
      cursor: 1,
    });
    const [doc] = await store.read.documentPage!({
      limit: 10,
      types: ['attachment'],
    });
    const consumer = 'worker:vision:v1';
    await store.commit({ consumer, cursor: doc.seq });
    expect(await queue.ledgerMissingVision(consumer, 0, 10)).toEqual([doc.seq]);
    expect(await store.visualWaitingCount(VISION_CONSUMER)).toBe(1);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      expect(await queue.ledgerRetry(consumer, doc.seq)).toEqual({
        attempts: attempt,
        outcome: 'deferred',
      });
    }
    expect(await store.ledgerHasDeferred(consumer)).toBe(false);
    await db.run(
      "UPDATE work_ledger SET updated_at='2020-01-01T00:00:00Z' WHERE consumer=? AND seq=?",
      [consumer, doc.seq],
    );
    expect(await store.ledgerDeferred(consumer, 0, 10)).toEqual([doc.seq]);
    expect(await queue.ledgerRetry(consumer, doc.seq)).toEqual({
      attempts: 4,
      outcome: 'failed',
    });
    expect(await queue.ledgerMissingVision(consumer, 0, 10)).toEqual([]);
    expect(await store.visualWaitingCount(VISION_CONSUMER)).toBe(0);
    expect(
      await db.all(
        'SELECT attempts, outcome FROM work_ledger WHERE consumer=? AND seq=?',
        [consumer, doc.seq],
      ),
    ).toEqual([{ attempts: 4, outcome: 'failed' }]);
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it('repairs a visual document missed by the feed without reprocessing it later', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kia-vision-repair-'));
  const db = await openDb(path.join(dir, 'test.db'));
  const store = openStore(db, {
    encrypt: (s: string) => Buffer.from(s),
    decrypt: (b: Buffer) => b.toString(),
    detectLanguages: () => ['eng'],
  });
  try {
    const account = await store.createAccount({
      source: 'test',
      identifier: 'local',
    });
    await store.commit({
      account: account.id,
      documents: [
        {
          externalId: 'missed',
          type: 'attachment',
          title: 'missed.pdf',
          markdown: null,
          metadata: {
            mime: 'application/pdf',
            sizeBytes: 50_000,
            conversion: SCANNED,
          },
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
      cursor: 1,
    });
    const [doc] = await store.read.documentPage!({
      limit: 10,
      types: ['attachment'],
    });
    await store.commit({ consumer: 'worker:vision:v1', cursor: doc.seq });
    const engine = createEngine({
      store,
      sources: { get: () => undefined },
      inference: {
        complete: async () => '',
        see: async () => '',
        read: async () => '',
        hear: async () => '',
      },
      convert: async (input) => input,
      logs: { log: () => {} },
    });
    const worker = {
      name: 'vision',
      version: 1,
      matches: (change: Change) =>
        change.kind === 'document' && !change.document.metadata.extraction,
      work: async (change: Change, workerSession: WorkerSession) => {
        if (change.kind !== 'document') return 'skip' as const;
        workerSession.enrich({
          documentId: change.document.id,
          markdown: 'Recovered text from scan',
          metadata: {
            extraction: { engine: 'local-ocr', at: '2026-01-01T00:00:00Z' },
          },
        });
        return 'done' as const;
      },
    };
    await engine.rerunMissingVision(worker);
    expect((await store.read.document(doc.id))?.markdown).toBe(
      'Recovered text from scan',
    );
    expect(await store.ledgerMissingVision('worker:vision:v1', 0, 10)).toEqual(
      [],
    );
    // The repair writes its own ledger row (core's workOne no longer does).
    expect(
      await db.all(
        'SELECT attempts, outcome FROM work_ledger WHERE consumer=? AND seq=?',
        ['worker:vision:v1', doc.seq],
      ),
    ).toEqual([{ attempts: 1, outcome: 'done' }]);
    expect(await store.visualWaitingCount(VISION_CONSUMER)).toBe(0);
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it('keeps the queue count truthful if its optional visual index is unavailable', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kia-vision-index-'));
  const db = await openDb(path.join(dir, 'test.db'));
  const store = openStore(db, {
    encrypt: (s: string) => Buffer.from(s),
    decrypt: (b: Buffer) => b.toString(),
    detectLanguages: () => ['eng'],
  });
  try {
    await db.exec('DROP INDEX docs_pending_visual');
    const account = await store.createAccount({
      source: 'test',
      identifier: 'local',
    });
    await store.commit({
      account: account.id,
      documents: [
        {
          externalId: 'failed',
          type: 'attachment',
          title: 'failed.pdf',
          markdown: null,
          metadata: {
            mime: 'application/pdf',
            sizeBytes: 50_000,
            conversion: SCANNED,
          },
          createdAt: '2026-01-01T00:00:00Z',
        },
        {
          externalId: 'missed',
          type: 'attachment',
          title: 'missed.pdf',
          markdown: null,
          metadata: {
            mime: 'application/pdf',
            sizeBytes: 50_000,
            conversion: SCANNED,
          },
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
      cursor: 1,
    });
    const docs = await store.read.documentPage!({
      limit: 10,
      types: ['attachment'],
    });
    const failed = docs.find((doc) => doc.externalId === 'failed')!;
    const missed = docs.find((doc) => doc.externalId === 'missed')!;
    await store.commit({ consumer: 'worker:vision:v1', cursor: missed.seq });
    await store.ledgerRecord('worker:vision:v1', failed.seq, 4, 'failed');
    expect(await store.visualWaitingCount(VISION_CONSUMER)).toBe(1);
    expect(
      await db.all(
        'SELECT outcome FROM work_ledger WHERE consumer=? AND seq=?',
        ['worker:vision:v1', failed.seq],
      ),
    ).toEqual([{ outcome: 'failed' }]);
    expect(await store.ledgerMissingVision('worker:vision:v1', 0, 10)).toEqual([
      missed.seq,
    ]);
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it('holds the missed-vision repair until the ledger re-key repair is done', async () => {
  // An upgraded profile: the re-key marker is absent until the repair runs.
  const f = await visionFixture(async (db) => {
    await db.run(`DELETE FROM meta WHERE key = 'ledgerRekeyed'`);
  });
  try {
    await f.store.commit({
      account: f.account.id,
      documents: [scan('missed')],
      cursor: 1,
    });
    await f.store.commit({
      consumer: VISION_CONSUMER,
      cursor: await f.store.headSeq(),
    });
    const worked: string[] = [];
    expect(await f.engine.rerunMissingVision(recoverWorker(worked))).toEqual({
      skipped: 'rekey-pending',
    });
    expect(worked).toEqual([]);
    while (!(await f.store.ledgerRekeyPage()).done) {
      // drain the repair
    }
    expect(
      await f.engine.rerunMissingVision(recoverWorker(worked)),
    ).toBeUndefined();
    expect(worked).toEqual(['missed']);
  } finally {
    await f.cleanup();
  }
});

it('never treats documents past the seed cursor as missed while a seed runs', async () => {
  const f = await visionFixture();
  try {
    await f.store.commit({
      account: f.account.id,
      documents: [scan('first'), scan('second')],
      cursor: 1,
    });
    const seqs = (
      (await f.db.all(
        `SELECT seq FROM documents WHERE type = 'attachment' ORDER BY seq`,
      )) as Array<{ seq: number }>
    ).map((r) => r.seq);
    await f.store.beginSeed(VISION_CONSUMER, await f.store.headSeq());
    expect(await f.store.ledgerMissingVision(VISION_CONSUMER, 0, 10)).toEqual(
      [],
    );
    await f.store.commit({
      consumer: VISION_CONSUMER,
      cursor: await f.store.headSeq(),
      seedCursor: seqs[0],
    });
    expect(await f.store.ledgerMissingVision(VISION_CONSUMER, 0, 10)).toEqual([
      seqs[0],
    ]);
    await f.store.endSeed(VISION_CONSUMER);
    expect(await f.store.ledgerMissingVision(VISION_CONSUMER, 0, 10)).toEqual(
      seqs,
    );
  } finally {
    await f.cleanup();
  }
});

it('repairs a missed visual document after its change row was pruned', async () => {
  const f = await visionFixture();
  try {
    await f.store.commit({
      account: f.account.id,
      documents: [scan('old')],
      cursor: 1,
    });
    await f.store.commit({
      account: f.account.id,
      documents: [scan('newer')],
      cursor: 2,
    });
    const [old] = (await f.db.all(
      `SELECT id, seq FROM documents WHERE external_id = 'old'`,
    )) as Array<{ id: string; seq: number }>;
    await f.store.commit({
      consumer: VISION_CONSUMER,
      cursor: await f.store.headSeq(),
    });
    // Mark 'newer' handled so only 'old' is missed.
    const [newer] = (await f.db.all(
      `SELECT seq FROM documents WHERE external_id = 'newer'`,
    )) as Array<{ seq: number }>;
    await f.store.ledgerRecord(VISION_CONSUMER, newer.seq, 1, 'done');
    const r = await pruneChangesOnce({
      store: f.store,
      activeConsumers: () => [VISION_CONSUMER],
      now: () => new Date(Date.now() + 72 * 3_600_000),
      yieldTurn: async () => {},
    });
    expect(r).toMatchObject({ limit: await f.store.headSeq() });
    expect(
      await f.db.all(`SELECT 1 FROM changes WHERE seq = ?`, [old.seq]),
    ).toEqual([]);
    await f.engine.rerunMissingVision(recoverWorker());
    expect((await f.store.read.document(old.id as never))?.markdown).toBe(
      'Recovered text from scan',
    );
  } finally {
    await f.cleanup();
  }
});

it('moves the idle ledger generation on an overlay retry and never rewinds the consumer cursor', async () => {
  const f = await visionFixture();
  try {
    await f.store.commit({
      account: f.account.id,
      documents: [scan('missed')],
      cursor: 1,
    });
    const [doc] = (await f.db.all(
      `SELECT seq FROM documents WHERE external_id = 'missed'`,
    )) as Array<{ seq: number }>;
    const gen = f.store.ledgerGen();
    await f.store.ledgerRetry(VISION_CONSUMER, doc.seq);
    expect(f.store.ledgerGen()).not.toBe(gen);
    // The repair commits its output but never the consumer cursor: a
    // read-then-write of the cursor could rewind a live tail (#147 §4).
    await f.store.commit({ consumer: VISION_CONSUMER, cursor: doc.seq });
    await f.db.run(`DELETE FROM work_ledger WHERE consumer = ?`, [
      VISION_CONSUMER,
    ]);
    const commit = jest.spyOn(f.store, 'commit');
    await f.engine.rerunMissingVision(recoverWorker());
    const repairCommits = commit.mock.calls
      .map(([batch]) => batch)
      .filter((batch) => 'consumer' in batch);
    expect(repairCommits).toHaveLength(1);
    expect(repairCommits[0]).not.toHaveProperty('cursor');
    expect(await f.store.consumerCursor(VISION_CONSUMER)).toBe(doc.seq);
  } finally {
    await f.cleanup();
  }
});

it('stopAll drains a missed-vision repair blocked on admission, and a later run does nothing', async () => {
  let acquired!: () => void;
  const waiting = new Promise<void>((r) => {
    acquired = r;
  });
  // An admission that never grants: only the re-drive's abort ends the wait.
  const admission = {
    acquire: (_kind: string, signal: AbortSignal) =>
      new Promise<() => void>((_resolve, reject) => {
        acquired();
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
  } as unknown as Parameters<typeof createEngine>[0]['admission'];
  const f = await visionFixture(undefined, admission);
  try {
    await f.store.commit({
      account: f.account.id,
      documents: [scan('missed')],
      cursor: 1,
    });
    await f.store.commit({
      consumer: VISION_CONSUMER,
      cursor: await f.store.headSeq(),
    });
    let settled = false;
    const repair = f.engine.rerunMissingVision(recoverWorker()).then((r) => {
      settled = true;
      return r;
    });
    await waiting;
    await f.engine.stopAll();
    // stopAll returned only after the repair let go.
    expect(settled).toBe(true);
    await expect(repair).resolves.toBeUndefined();
    // Nothing of the aborted page was committed or recorded.
    expect(
      await f.db.all('SELECT 1 FROM work_ledger WHERE consumer = ?', [
        VISION_CONSUMER,
      ]),
    ).toEqual([]);
    // After shutdown the repair does not start at all.
    const worked: string[] = [];
    await expect(
      f.engine.rerunMissingVision(recoverWorker(worked)),
    ).resolves.toBeUndefined();
    expect(worked).toEqual([]);
  } finally {
    await f.cleanup();
  }
});
