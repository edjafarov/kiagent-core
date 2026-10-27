/** @jest-environment node */
// Projection.leadKinds: account changes reach the state while the main feed
// is still stuck behind a backlog.
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { Change, Projection } from '@shared/contracts';

import { openDb } from '../../../db/app-db';
import { DB_WORKER_CRASHED } from '../../../db/worker-client';
import { openStore, type CoreStore } from '../../store/store';
import { createEngine } from '../engine';

type State = { accounts: string[]; docs: number };

const waitUntil = async (cond: () => boolean, ms = 2000) => {
  for (let i = 0; i < ms / 10 && !cond(); i += 1)
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
  let failLead: number;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-project-lead-'));
    const real = openStore(await openDb(path.join(dir, 'test.db')), {
      encrypt: (s: string) => Buffer.from(s, 'utf8'),
      decrypt: (b: Buffer) => b.toString('utf8'),
      detectLanguages: () => [],
    });
    feeds = [];
    failLead = 0;
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
        if (opts?.kinds && failLead > 0) {
          failLead -= 1;
          return {
            [Symbol.asyncIterator]: () => ({
              next: () =>
                Promise.reject(
                  Object.assign(new Error('worker died'), {
                    code: DB_WORKER_CRASHED,
                  }),
                ),
            }),
          };
        }
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

  it('the main feed does not re-apply what the lead already applied', async () => {
    const applied: string[] = [];
    const base = projection({ leadKinds: ['account', 'accountRemoved'] });
    const handle = engine().project(
      {
        ...base,
        apply(state, changes) {
          for (const c of changes)
            if (c.kind === 'account') applied.push(c.account.id);
          return base.apply(state, changes);
        },
      },
      () => {},
    );
    await new Promise((r) => {
      setTimeout(r, 50);
    });
    const acc = await store.createAccount({ source: 's', identifier: 'once' });
    await waitUntil(() => applied.includes(acc.id));
    releaseMain();
    await store.commit({
      account: acc.id,
      cursor: null,
      documents: [
        {
          externalId: 'y',
          type: 'note',
          title: 'y',
          markdown: 'y',
          metadata: {},
          createdAt: null,
        },
      ],
    });
    await new Promise((r) => {
      setTimeout(r, 200);
    });
    await handle.stop();
    expect(applied.filter((id) => id === acc.id)).toHaveLength(1);
  });

  it('a failed lead feed re-initializes the projection instead of dying', async () => {
    failLead = 1;
    let inits = 0;
    const states: State[] = [];
    const base = projection({ leadKinds: ['account'] });
    const handle = engine().project(
      {
        ...base,
        async init(read) {
          inits += 1;
          return base.init(read);
        },
      },
      (s) => states.push(s),
    );
    await waitUntil(() => inits === 2, 4000);
    const acc = await store.createAccount({ source: 's', identifier: 'after' });
    await waitUntil(() => states.at(-1)!.accounts.includes(acc.id));
    await handle.stop();
  });

  it('an account created while init() runs still arrives', async () => {
    const states: State[] = [];
    let created = '';
    const base = projection({ leadKinds: ['account'] });
    const handle = engine().project(
      {
        ...base,
        async init(read) {
          const s = await base.init(read); // its snapshot misses the account
          created = (
            await store.createAccount({ source: 's', identifier: 'mid' })
          ).id;
          return s;
        },
      },
      (s) => states.push(s),
    );
    await waitUntil(() => created !== '');
    await waitUntil(() => states.at(-1)?.accounts.includes(created) ?? false);
    await handle.stop();
  });
});
