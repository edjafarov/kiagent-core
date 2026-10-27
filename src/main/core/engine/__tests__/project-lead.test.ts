/** @jest-environment node */
// Projection.leadKinds: account changes reach the state while the main feed
// is still stuck behind a backlog.
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { Change, Projection } from '@shared/contracts';

import { openDb } from '../../../db/app-db';
import { openStore, type CoreStore } from '../../store/store';
import { createEngine } from '../engine';

type State = { accounts: string[]; docs: number };

const waitUntil = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i += 1)
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => {
      setTimeout(r, 10);
    });
  expect(cond()).toBe(true);
};

describe('engine.project leadKinds', () => {
  let dir: string;
  let store: CoreStore;
  let feeds: Array<{ kinds?: Change['kind'][]; noBody?: boolean }>;
  let releaseMain: () => void;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-project-lead-'));
    const real = openStore(await openDb(path.join(dir, 'test.db')), {
      encrypt: (s: string) => Buffer.from(s, 'utf8'),
      decrypt: (b: Buffer) => b.toString('utf8'),
      detectLanguages: () => [],
    });
    feeds = [];
    const gate = new Promise<void>((resolve) => {
      releaseMain = resolve;
    });
    // The main feed (no kinds) is held back, like one working through a
    // backfill; the lead feed runs free.
    store = Object.assign(Object.create(real), {
      feed(
        after: number,
        opts?: { kinds?: Change['kind'][]; noBody?: boolean },
      ) {
        feeds.push({ kinds: opts?.kinds, noBody: opts?.noBody });
        const inner = real.feed(after, opts);
        if (opts?.kinds) return inner;
        return {
          async *[Symbol.asyncIterator]() {
            await gate;
            yield* inner;
          },
        };
      },
    }) as CoreStore;
  });

  afterEach(() => {
    releaseMain();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const engine = () =>
    createEngine({
      store,
      sources: { get: () => undefined },
      inference: {
        complete: async () => '',
        see: async () => '',
        read: async () => '',
        hear: async () => '',
      },
      convert: async (d: unknown) => d,
      logs: { log: () => {} },
    } as never);

  const projection = (
    extra: Partial<Projection<State>> = {},
  ): Projection<State> => ({
    async init(read) {
      return { accounts: [], docs: await read.count({}) };
    },
    apply(state, changes) {
      let { accounts, docs } = state;
      for (const c of changes) {
        if (c.kind === 'account' && !accounts.includes(c.account.id))
          accounts = [...accounts, c.account.id];
        if (c.kind === 'accountRemoved')
          accounts = accounts.filter((a) => a !== c.accountId);
        if (c.kind === 'document') docs += 1;
      }
      return { accounts, docs };
    },
    ...extra,
  });

  it('a new account reaches the state while the main feed is held back', async () => {
    const states: State[] = [];
    const handle = engine().project(
      projection({ leadKinds: ['account', 'accountRemoved'] }),
      (s) => states.push(s),
    );
    await waitUntil(() => states.length > 0);
    const acc = await store.createAccount({ source: 's', identifier: 'new' });
    await waitUntil(() => states.at(-1)!.accounts.includes(acc.id));

    await store.commit({ removeAccount: acc.id });
    await waitUntil(() => !states.at(-1)!.accounts.includes(acc.id));
    releaseMain();
    await store.commit({
      account: (await store.createAccount({ source: 's', identifier: 'b' })).id,
      cursor: null,
      documents: [
        {
          externalId: 'x',
          type: 'note',
          title: 'x',
          markdown: 'x',
          metadata: {},
          createdAt: null,
        },
      ],
    });
    // Replays through the main feed are idempotent; the document counts once.
    await waitUntil(() => states.at(-1)!.docs === 1);
    await handle.stop();
  });

  it('without leadKinds only the main feed runs; documentBodies false asks for no bodies', async () => {
    const states: State[] = [];
    const handle = engine().project(
      projection({ documentBodies: false }),
      (s) => states.push(s),
    );
    await waitUntil(() => states.length > 0);
    await handle.stop();
    expect(feeds).toEqual([{ kinds: undefined, noBody: true }]);
  });

  it('stop() ends the lead feed too', async () => {
    const states: State[] = [];
    const handle = engine().project(
      projection({ leadKinds: ['account'] }),
      (s) => states.push(s),
    );
    await waitUntil(() => states.length > 0);
    await handle.stop();
    const n = states.length;
    await store.createAccount({ source: 's', identifier: 'late' });
    await new Promise((r) => {
      setTimeout(r, 100);
    });
    expect(states).toHaveLength(n);
  });
});
