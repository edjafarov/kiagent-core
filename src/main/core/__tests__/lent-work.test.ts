import type { Change, Document, LentJobIo, Worker } from '@shared/contracts';
import { LaneClosedError } from '@shared/contracts';

import { createLentWork, WorkVersionError } from '../lent-work';

// The helper's side of a lent job: the unchanged worker runs against a
// session that reaches the leader for bytes and attempts and writes nothing.

const document = {
  id: 'd1',
  type: 'note',
  metadata: {},
} as unknown as Document;
const change: Change = { seq: 5, kind: 'document', document };

function setup(laneOpen = true) {
  const lent = createLentWork({
    inference: {
      complete: async () => 'completed here',
      see: async () => 'seen here',
      read: async () => 'read here',
      hear: async () => 'heard here',
    },
    laneOpen: () => laneOpen,
    log: () => {},
  });
  const asked: string[] = [];
  const io: LentJobIo = {
    fetchBytes: async (id) => {
      asked.push(`bytes:${id}`);
      return new Uint8Array([1, 2]);
    },
    bump: async (key) => {
      asked.push(`bump:${key}`);
      return 3;
    },
    signal: new AbortController().signal,
  };
  return { lent, io, asked };
}

const worker: Worker = {
  name: 'parse',
  version: 2,
  lendable: true,
  matches: (c) => c.kind === 'document',
  async work(c, session) {
    if (c.kind !== 'document') return 'skip';
    const bytes = await session.fetchBytes(c.document);
    const other = await session.fetchBytes({
      ...c.document,
      id: 'someone-else',
    });
    const n = await session.bump('ocr');
    session.enrich({
      documentId: c.document.id,
      markdown: `${bytes?.length} bytes, other ${other}, attempt ${n}, ${await session.read(new Uint8Array())}`,
      metadata: { progress: undefined },
    });
    session.emit({
      externalId: 'child',
      type: 'note',
      title: null,
      markdown: 'x',
      metadata: {},
      createdAt: null,
    });
    return 'done';
  },
};

const abilities = () => ({ ready: true, can: ['read'], now: ['read'] });

describe('answering a lent job', () => {
  it('runs the worker here; bytes and attempts come from the leader, results go back unwritten', async () => {
    const { lent, io, asked } = setup();
    lent.register(worker, abilities);
    const r = await lent.run({ worker: 'parse', version: 2, change }, io);
    expect(r.outcome).toBe('done');
    expect(r.enrich).toHaveLength(1);
    expect(r.enrich[0].markdown).toBe(
      '2 bytes, other null, attempt 3, read here',
    );
    // An explicit undefined is the store's "remove this key": it must survive.
    expect('progress' in (r.enrich[0].metadata ?? {})).toBe(true);
    expect(r.docs.map((d) => d.externalId)).toEqual(['child']);
    // Only the job's own document is ever asked of the leader.
    expect(asked).toEqual(['bytes:d1', 'bump:ocr']);
  });

  it('refuses a worker it does not have at that version', async () => {
    const { lent, io } = setup();
    lent.register(worker, abilities);
    await expect(
      lent.run({ worker: 'parse', version: 3, change }, io),
    ).rejects.toBeInstanceOf(WorkVersionError);
    await expect(
      lent.run({ worker: 'unknown', version: 2, change }, io),
    ).rejects.toBeInstanceOf(WorkVersionError);
  });

  it("refuses while this device's own lane is closed", async () => {
    const { lent, io, asked } = setup(false);
    lent.register(worker, abilities);
    await expect(
      lent.run({ worker: 'parse', version: 2, change }, io),
    ).rejects.toBeInstanceOf(LaneClosedError);
    expect(asked).toEqual([]);
  });

  it('reports each lendable worker with what it can do here', () => {
    const { lent } = setup();
    lent.register(worker, abilities);
    expect(lent.fitness()).toEqual([
      {
        worker: 'parse',
        version: 2,
        ready: true,
        can: ['read'],
        now: ['read'],
      },
    ]);
    expect(() =>
      lent.register({ ...worker, lendable: undefined }, abilities),
    ).toThrow();
  });
});
