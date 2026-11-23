import fs from 'fs';
import os from 'os';
import path from 'path';

import type {
  Change,
  DocumentInput,
  LentJob,
  LentJobIo,
  LentJobResult,
  Source,
  Worker,
  WorkLender,
} from '@shared/contracts';
import { LaneClosedError } from '@shared/contracts';

import { openDb } from '../../../db/app-db';
import { openStore } from '../../store/store';
import type { CoreStore } from '../../store/store';
import { createEngine } from '../engine';

// The leader's side of a lent job: the engine hands the attempt to the work
// lender, serves it bytes, and writes what comes back.

const BYTES = new Uint8Array([7, 7, 7]);

function doc(externalId: string): DocumentInput {
  return {
    externalId,
    type: 'note',
    title: externalId,
    markdown: '',
    metadata: {},
    createdAt: null,
  };
}

const source: Source<number, DocumentInput> = {
  descriptor: {
    id: 'fake',
    name: 'Fake',
    documentTypes: ['note'],
    auth: 'none',
  },
  async connect() {
    return { identifier: 'fake@test' };
  },
  async *pull() {
    // nothing: documents are committed by the test
  },
  toDocument: (item) => item,
  fetchBytes: async () => BYTES,
};

function fakeLender(
  answer: (job: LentJob, io: LentJobIo) => Promise<LentJobResult>,
) {
  const state = { takes: true, ready: true };
  const jobs: LentJob[] = [];
  const lender: WorkLender = {
    takes: () => state.takes,
    ready: () => state.ready,
    run: async (job, io) => {
      jobs.push(job);
      return answer(job, io);
    },
    onChange: () => () => {},
  };
  return { lender, state, jobs };
}

async function until(cond: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await cond()) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => {
      setTimeout(r, 20);
    });
  }
  throw new Error('condition never held');
}

describe('a lendable worker whose jobs another device takes', () => {
  let dir: string;
  let store: CoreStore;
  let localRuns: string[];
  let allowed: boolean;
  let routed: string[];

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-lent-'));
    store = await openStore(await openDb(path.join(dir, 'test.db')), {
      encrypt: (s: string) => Buffer.from(s, 'utf8'),
      decrypt: (b: Buffer) => b.toString('utf8'),
      detectLanguages: () => [],
    });
    localRuns = [];
    allowed = true;
    routed = [];
  });
  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const worker = (over: Partial<Worker> = {}): Worker => ({
    name: 'parse',
    version: 4,
    lendable: true,
    tasks: ['parse.describe'],
    // Its own write-back is not matched again (the re-entrancy obligation).
    matches: (c: Change) =>
      c.kind === 'document' &&
      c.document.type === 'note' &&
      c.document.markdown === '',
    async work(change) {
      if (change.kind === 'document')
        localRuns.push(change.document.externalId);
      return 'done';
    },
    ...over,
  });

  async function setup(lender: WorkLender, ids: string[]) {
    const engine = createEngine({
      store,
      sources: { get: (id) => (id === 'fake' ? source : undefined) },
      inference: {
        complete: async () => '',
        see: async () => '',
        read: async () => '',
        hear: async () => '',
      },
      convert: async (input) => input,
      logs: { log: () => {} },
      lendingAllowed: () => allowed,
      routedTasks: () => routed,
    });
    engine.setWorkLender(lender);
    const account = await engine.connect(source, {
      oauth: async () => ({}),
      showQr: () => {},
      prompt: async () => ({}),
      status: () => {},
      pickFolders: async () => [],
    });
    await store.commit({
      account: account.id,
      documents: ids.map(doc),
      cursor: 1,
    });
    return engine;
  }

  it('the job runs on the helper: it gets the bytes and the attempt counter from here, and its results are written here', async () => {
    const seen: { bytes: number[]; other: unknown; bump: number } = {
      bytes: [],
      other: 'unset',
      bump: 0,
    };
    const l = fakeLender(async (job, io) => {
      if (job.change.kind !== 'document') throw new Error('not a document');
      const { id } = job.change.document;
      seen.bytes = Array.from((await io.fetchBytes(id)) ?? []);
      seen.other = await io.fetchBytes('some-other-document');
      seen.bump = await io.bump('step');
      return {
        outcome: 'done',
        docs: [],
        enrich: [{ documentId: id, markdown: 'parsed on the helper' }],
      };
    });
    const engine = await setup(l.lender, ['a']);
    const w = worker();
    const handle = engine.attach(w);
    await until(async () => (await handle.stats()).done === 1);
    await handle.stop();

    expect(l.jobs).toHaveLength(1);
    expect(l.jobs[0]).toMatchObject({ worker: 'parse', version: 4 });
    expect(seen.bytes).toEqual([7, 7, 7]);
    // Bytes of no other document leave this device with the job.
    expect(seen.other).toBeNull();
    expect(seen.bump).toBe(1);
    expect(localRuns).toEqual([]);
    if (l.jobs[0].change.kind !== 'document') throw new Error('unreachable');
    const written = await store.read.document(l.jobs[0].change.document.id);
    expect(written?.markdown).toBe('parsed on the helper');
  });

  it('with no helper there the change is parked without spending an attempt', async () => {
    const l = fakeLender(async () => ({
      outcome: 'done',
      docs: [],
      enrich: [],
    }));
    l.state.ready = false;
    const engine = await setup(l.lender, ['a']);
    const handle = engine.attach(worker());
    await until(async () => (await handle.stats()).deferred === 1);
    await handle.stop();
    expect(l.jobs).toEqual([]);
    expect(localRuns).toEqual([]);
  });

  it("a helper whose own lane is closed parks the change, and a helper's defer is a defer", async () => {
    let n = 0;
    const l = fakeLender(async () => {
      n += 1;
      if (n === 1) throw new LaneClosedError('the helper is busy');
      return { outcome: 'defer', docs: [], enrich: [] };
    });
    const engine = await setup(l.lender, ['a', 'b']);
    const handle = engine.attach(worker());
    await until(async () => (await handle.stats()).deferred === 2);
    await handle.stop();
    expect((await handle.stats()).failed).toBe(0);
    expect(localRuns).toEqual([]);
  });

  it.each([
    ['a worker that is not lendable', { lendable: undefined }, true, []],
    ['processing turned off', {}, false, []],
    ['a task routed to another provider here', {}, true, ['parse.describe']],
  ] as const)(
    'runs here, not on a helper: %s',
    async (_n, over, allow, routes) => {
      allowed = allow;
      routed = [...routes];
      const l = fakeLender(async () => ({
        outcome: 'done',
        docs: [],
        enrich: [],
      }));
      const engine = await setup(l.lender, ['a']);
      const handle = engine.attach(worker(over as Partial<Worker>));
      await until(async () => (await handle.stats()).done === 1);
      await handle.stop();
      expect(l.jobs).toEqual([]);
      expect(localRuns).toEqual(['a']);
    },
  );
});
