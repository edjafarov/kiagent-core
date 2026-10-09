/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type {
  AccountId,
  Change,
  DocumentInput,
  Handle,
  Worker,
} from '@shared/contracts';

import { openDb, type AppDb } from '../../../db/app-db';
import { openStore, type CoreStore } from '../../store/store';
import { createEngine, type EngineDeps } from '../engine';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => [],
};
const doc = (
  externalId: string,
  markdown = `body ${externalId}`,
): DocumentInput => ({
  externalId,
  type: 'note',
  title: externalId,
  markdown,
  metadata: {},
  createdAt: null,
});

async function waitFor(pred: () => Promise<boolean>, timeoutMs = 8_000) {
  const until = Date.now() + timeoutMs;
  while (!(await pred())) {
    if (Date.now() > until) throw new Error('waitFor timed out');
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => {
      setTimeout(r, 20);
    });
  }
}

describe('seeding a new consumer from documents (#59 §3a)', () => {
  let dir: string;
  let db: AppDb;
  let store: CoreStore;
  let accountId: AccountId;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-seed-'));
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

  const makeEngine = (over: Partial<EngineDeps> = {}) =>
    createEngine({
      store,
      sources: { get: () => undefined },
      inference: {
        complete: async () => '',
        see: async () => '',
        read: async () => '',
        hear: async () => '',
      },
      convert: async (d) => d,
      logs: { log: () => {} },
      ...over,
    });
  const seedRow = (name: string) => store.consumerRow(`seed:worker:${name}:v1`);
  const caughtUp = async (name: string) =>
    (await seedRow(name)) === null &&
    (await store.consumerRow(`worker:${name}:v1`)) === (await store.headSeq());
  /** Seeding FINISHED: beginSeed created the real row and endSeed dropped
   *  the progress row. (A bare "no seed row" is also true before seeding
   *  starts.) Only for consumers with no pre-existing row. */
  const seedDone = async (name: string) =>
    (await store.consumerRow(`worker:${name}:v1`)) !== null &&
    (await seedRow(name)) === null;
  /** externalId -> seq, captured BEFORE any enrichment moves documents.seq. */
  const seqsNow = async () =>
    Object.fromEntries(
      (
        (await db.all(`SELECT external_id, seq FROM documents`)) as Array<{
          external_id: string;
          seq: number;
        }>
      ).map((r) => [r.external_id, r.seq]),
    ) as Record<string, number>;
  /** Works live notes once: its enrich marks metadata[name], which un-matches. */
  const marker = (
    name: string,
    worked: string[],
    onWork?: (c: Change) => unknown,
  ): Worker => ({
    name,
    version: 1,
    matches: (c) =>
      c.kind === 'document' &&
      c.document.type === 'note' &&
      !c.document.archivedAt &&
      !(name in c.document.metadata),
    async work(c, session) {
      if (c.kind !== 'document') return 'skip';
      await onWork?.(c);
      worked.push(c.document.externalId);
      session.enrich({ documentId: c.document.id, metadata: { [name]: true } });
      return 'done';
    },
  });
  const archive = (externalId: string, cursor: number) =>
    store.commit({
      account: accountId,
      documents: [],
      deletions: [{ externalId, type: 'note' }],
      cursor,
    });
  const purgeAll = () =>
    store.commit({ purgeArchived: { before: '9999-01-01T00:00:00Z' } });

  it('works the same documents and enrich set as a full replay', async () => {
    await store.commit({
      account: accountId,
      documents: ['a', 'b', 'c', 'd', 'e'].map((x) => doc(x)),
      cursor: 1,
    });
    await store.commit({
      account: accountId,
      documents: [doc('b', 'edited')],
      cursor: 2,
    });
    await archive('c', 3);
    await purgeAll(); // c is gone
    await archive('e', 4); // e is archived, not purged

    const replayed: string[] = [];
    // A row at 0 and no published floor: today's replay from seq 0.
    await store.commit({ consumer: 'worker:replay:v1', cursor: 0 });
    const h1 = makeEngine().attach(marker('replay', replayed));
    await waitFor(() => caughtUp('replay'));
    await h1.stop();

    const seeded: string[] = [];
    const h2 = makeEngine().attach(marker('seed', seeded));
    await waitFor(() => caughtUp('seed'));
    await h2.stop();

    expect([...seeded].sort()).toEqual(['a', 'b', 'd']);
    expect([...seeded].sort()).toEqual([...replayed].sort());
    const enriched = async (key: string) =>
      (
        (await db.all(
          `SELECT external_id FROM documents
            WHERE json_extract(metadata, '$.' || ?) = 1 ORDER BY external_id`,
          [key],
        )) as Array<{ external_id: string }>
      ).map((r) => r.external_id);
    expect(await enriched('seed')).toEqual(await enriched('replay'));
  });

  it('pending is head − h0 from the first moment of a seed', async () => {
    await store.commit({
      account: accountId,
      documents: [doc('a'), doc('b')],
      cursor: 1,
    });
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const h = makeEngine().attach(marker('slow', [], () => held));
    await waitFor(async () => (await seedRow('slow')) !== null);
    expect((await store.ledgerCountsAll(['worker:slow:v1'])).pending).toBe(0);
    await store.commit({
      account: accountId,
      documents: [doc('c')],
      cursor: 2,
    });
    const { pending } = await store.ledgerCountsAll(['worker:slow:v1']);
    expect(pending).toBeGreaterThan(0);
    expect(pending).toBe(
      (await store.headSeq()) - (await store.consumerCursor('worker:slow:v1')),
    );
    release();
    await waitFor(() => seedDone('slow'));
    await h.stop();
  });

  it('seed outputs land under the real worker account', async () => {
    await store.commit({
      account: accountId,
      documents: [doc('a')],
      cursor: 1,
    });
    const worker: Worker = {
      name: 'out',
      version: 1,
      matches: (c) => c.kind === 'document' && c.document.type === 'note',
      async work(c, session) {
        if (c.kind !== 'document') return 'skip';
        session.emit({
          externalId: `sum:${c.document.externalId}`,
          type: 'summary',
          title: null,
          markdown: 'x',
          metadata: {},
          createdAt: null,
        });
        return 'done';
      },
    };
    const h = makeEngine().attach(worker);
    await waitFor(
      async () =>
        (await seedDone('out')) &&
        (await db.all(`SELECT 1 FROM documents WHERE type = 'summary'`))
          .length === 1,
    );
    await h.stop();
    expect(
      await db.all(
        `SELECT a.source, a.identifier FROM documents d
           JOIN accounts a ON a.id = d.account_id WHERE d.type = 'summary'`,
      ),
    ).toEqual([{ source: 'worker', identifier: 'worker:out:v1' }]);
  });

  it('resumes from the seed cursor after a stop mid-seed', async () => {
    await store.commit({
      account: accountId,
      documents: ['a', 'b', 'c', 'd', 'e'].map((x) => doc(x)),
      cursor: 1,
    });
    const seqs = await seqsNow(); // seed progress stores ORIGINAL page seqs
    const worked: string[] = [];
    let handle: Handle | null = null;
    let stopping: Promise<void> | null = null;
    handle = makeEngine({ seedPageSize: 2 }).attach(
      marker('resume', worked, (c) => {
        if (c.kind === 'document' && c.document.externalId === 'c')
          stopping = handle!.stop();
      }),
    );
    await waitFor(async () => stopping !== null);
    await stopping;
    expect(await seedRow('resume')).toBe(seqs.b); // page [a, b] committed
    const before = worked.length;
    const h2 = makeEngine({ seedPageSize: 2 }).attach(marker('resume', worked));
    await waitFor(
      async () => (await seedDone('resume')) && worked.includes('e'),
    );
    await h2.stop();
    expect(worked.slice(0, 2)).toEqual(['a', 'b']);
    expect(worked.slice(before)).toEqual(['c', 'd', 'e']);
  });

  it('a cursor below the published changes floor re-seeds instead of skipping forward', async () => {
    await store.commit({
      account: accountId,
      documents: [doc('a'), doc('b')],
      cursor: 1,
    });
    await store.commit({ consumer: 'worker:back:v1', cursor: 1 });
    const floor = await store.headSeq();
    await db.run(`INSERT INTO meta(key, value) VALUES('changesFloor', ?)`, [
      String(floor),
    ]);
    const worked: string[] = [];
    const h = makeEngine().attach(marker('back', worked));
    // The real row pre-exists, so wait on the work AND the seed row's end.
    await waitFor(
      async () => worked.length === 2 && (await seedRow('back')) === null,
    );
    await h.stop();
    expect([...worked].sort()).toEqual(['a', 'b']);
    expect(await store.consumerCursor('worker:back:v1')).toBeGreaterThanOrEqual(
      floor,
    );
  });

  it('a document purged between seed pages is never worked, and seeding finishes', async () => {
    await store.commit({
      account: accountId,
      documents: [doc('a'), doc('b'), doc('c')],
      cursor: 1,
    });
    const worked: string[] = [];
    const h = makeEngine({ seedPageSize: 1 }).attach(
      marker('vanish', worked, async (c) => {
        if (c.kind === 'document' && c.document.externalId === 'a') {
          await archive('b', 2);
          await purgeAll();
        }
      }),
    );
    await waitFor(
      async () => (await seedDone('vanish')) && worked.includes('c'),
    );
    await h.stop();
    expect(worked).toEqual(['a', 'c']);
  });

  it('a crash at the page-commit boundary never strands a deferral behind the seed cursor (audio-style)', async () => {
    await store.commit({
      account: accountId,
      documents: ['a', 'b', 'c', 'd'].map((x) => doc(x)),
      cursor: 1,
    });
    const seqs = await seqsNow();
    // Audio-style: 'b' defers (no model yet); everything else is done.
    const audio = (deferB: boolean, worked: string[]): Worker => ({
      name: 'hear',
      version: 1,
      matches: (c) =>
        c.kind === 'document' &&
        c.document.type === 'note' &&
        !c.document.archivedAt &&
        !('hear' in c.document.metadata),
      async work(c, session) {
        if (c.kind !== 'document') return 'skip';
        worked.push(c.document.externalId);
        if (deferB && c.document.externalId === 'b') return 'defer';
        session.enrich({ documentId: c.document.id, metadata: { hear: true } });
        return 'done';
      },
    });
    // The process dies IMMEDIATELY AFTER page 1's ([a, b]) underlying commit
    // succeeded, before control returns to the seeder. A two-call design
    // (commit, then a separate ledger write) loses b's deferral right here;
    // the atomic page commit cannot. From then on nothing reaches the DB
    // (the process is gone), so the engine's retry cannot repair it either.
    let crashed = false;
    const crashing = {
      ...store,
      commit: async (batch: Parameters<CoreStore['commit']>[0]) => {
        if (crashed) throw new Error('process is dead');
        const r = await store.commit(batch);
        if ('seedCursor' in batch && batch.seedCursor !== undefined) {
          crashed = true;
          throw new Error('process died after the page commit');
        }
        return r;
      },
      ledgerRecord: async (...a: Parameters<CoreStore['ledgerRecord']>) => {
        if (crashed) throw new Error('process is dead');
        return store.ledgerRecord(...a);
      },
      ledgerRecordMany: async (
        ...a: Parameters<CoreStore['ledgerRecordMany']>
      ) => {
        if (crashed) throw new Error('process is dead');
        return store.ledgerRecordMany(...a);
      },
    } as CoreStore;
    const h = makeEngine({ store: crashing, seedPageSize: 2 }).attach(
      audio(true, []),
    );
    await waitFor(async () => crashed);
    await h.stop();

    // Reopen the database as a restarted app would.
    await store.close();
    db = await openDb(path.join(dir, 'test.db'));
    store = openStore(db, deps);
    // BOTH must be there: the seed cursor past page 1 AND b's deferred row.
    expect(await store.consumerRow('seed:worker:hear:v1')).toBe(seqs.b);
    // Everything at/behind the seed cursor has its ledger row, the deferral too.
    expect(
      await db.all(
        `SELECT seq, outcome FROM work_ledger WHERE consumer = 'worker:hear:v1' ORDER BY seq`,
      ),
    ).toEqual([
      { seq: seqs.a, outcome: 'done' },
      { seq: seqs.b, outcome: 'deferred' },
    ]);

    // Resume re-works only the lost page; the deferral then re-drives.
    const worked: string[] = [];
    const h2 = makeEngine({ seedPageSize: 2 }).attach(audio(false, worked));
    await waitFor(
      async () =>
        worked.includes('d') &&
        (await store.consumerRow('seed:worker:hear:v1')) === null,
    );
    await h2.stop();
    expect(worked).toEqual(['c', 'd']);
    await makeEngine().rerunDeferred(audio(false, worked));
    expect(
      await db.all(
        `SELECT outcome FROM work_ledger WHERE consumer = 'worker:hear:v1' AND seq = ?`,
        [seqs.b],
      ),
    ).toEqual([{ outcome: 'done' }]);
  });

  it('a half-done seed whose h0 fell below the published floor restarts at the current head', async () => {
    await store.commit({
      account: accountId,
      documents: [doc('a'), doc('b')],
      cursor: 1,
    });
    const seqs = await seqsNow();
    // Left by an earlier run: h0 = a's seq, page [a] committed.
    await store.beginSeed('worker:stale:v1', seqs.a);
    await store.commit({
      consumer: 'worker:stale:v1',
      cursor: seqs.a,
      seedCursor: seqs.a,
    });
    await store.commit({
      account: accountId,
      documents: [doc('c')],
      cursor: 2,
    });
    // Pruning passed h0 while the consumer was away.
    const head = await store.headSeq();
    await db.run(`INSERT INTO meta(key, value) VALUES('changesFloor', ?)`, [
      String(head),
    ]);
    await db.run(`DELETE FROM changes WHERE seq < ?`, [head]);
    const worked: string[] = [];
    const h = makeEngine().attach(marker('stale', worked));
    await waitFor(
      async () => worked.length === 3 && (await seedRow('stale')) === null,
    );
    await h.stop();
    expect([...worked].sort()).toEqual(['a', 'b', 'c']);
    expect(
      await store.consumerCursor('worker:stale:v1'),
    ).toBeGreaterThanOrEqual(head);
  });

  it('a seed row whose real row is gone restarts at the current head', async () => {
    await store.commit({
      account: accountId,
      documents: [doc('a'), doc('b')],
      cursor: 1,
    });
    const seqs = await seqsNow();
    // Only the progress row is left (e.g. the real row was swept).
    await db.run(
      `INSERT INTO consumers(name, cursor) VALUES('seed:worker:orphan:v1', ?)`,
      [seqs.a],
    );
    const head = await store.headSeq();
    await db.run(`DELETE FROM changes WHERE seq < ?`, [head]);
    const worked: string[] = [];
    const h = makeEngine().attach(marker('orphan', worked));
    await waitFor(
      async () => worked.length === 2 && (await seedDone('orphan')),
    );
    await h.stop();
    expect([...worked].sort()).toEqual(['a', 'b']);
  });
});
