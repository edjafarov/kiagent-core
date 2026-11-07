/** @jest-environment node */
// Projection.leadKinds: account changes reach the state while the main feed
// is still stuck behind a backlog.
import { EventEmitter, once } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { Change, Projection } from '@shared/contracts';

import { openDb } from '../../../db/app-db';
import { DB_WORKER_CRASHED } from '../../../db/worker-client';
import { openStore, type CoreStore } from '../../store/store';
import { createEngine } from '../engine';

type State = { accounts: string[]; docs: number };

/** Whoever changes something a test waits on (a fake, a callback) calls
 *  `bump()`; `waitUntil` re-checks its condition on each bump, with one
 *  timer that only fires on failure. */
const changed = new EventEmitter();
const bump = () => changed.emit('change');
const waitUntil = async (cond: () => boolean, ms = 2000) => {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    while (!cond()) {
      // eslint-disable-next-line no-await-in-loop
      await once(changed, 'change', { signal: ac.signal });
    }
  } catch {
    // aborted: the condition did not come true in time
  } finally {
    clearTimeout(timer);
  }
  expect(cond()).toBe(true);
};
/** An onDiff callback that records the state and wakes the waiters. */
const record = (states: State[]) => (s: State) => {
  states.push(s);
  bump();
};

describe('engine.project leadKinds', () => {
  let dir: string;
  let store: CoreStore;
  let feeds: Array<{ kinds?: Change['kind'][]; noBody?: boolean }>;
  let releaseMain: () => void;
  let failLead: number;
  let leadClosed: number;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-project-lead-'));
    const real = openStore(await openDb(path.join(dir, 'test.db')), {
      encrypt: (s: string) => Buffer.from(s, 'utf8'),
      decrypt: (b: Buffer) => b.toString('utf8'),
      detectLanguages: () => [],
    });
    feeds = [];
    failLead = 0;
    leadClosed = 0;
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
        bump();
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
        if (opts?.kinds)
          return {
            [Symbol.asyncIterator]() {
              const it = inner[Symbol.asyncIterator]();
              return {
                next: () => it.next(),
                async return(v?: unknown) {
                  leadClosed += 1;
                  return it.return ? it.return(v) : { done: true, value: v };
                },
              };
            },
          };
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
      record(states),
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
      record(states),
    );
    await waitUntil(() => states.length > 0);
    await handle.stop();
    expect(feeds).toEqual([{ kinds: undefined, noBody: true }]);
  });

  it('stop() ends the lead feed too', async () => {
    const states: State[] = [];
    const handle = engine().project(
      projection({ leadKinds: ['account'] }),
      record(states),
    );
    await waitUntil(() => states.length > 0);
    await handle.stop();
    // The lead feed's iterator was closed, so nothing can reach the state.
    expect(leadClosed).toBe(1);
    const n = states.length;
    await store.createAccount({ source: 's', identifier: 'late' });
    expect(states).toHaveLength(n);
  });

  it('the main feed does not re-apply what the lead already applied', async () => {
    const applied: string[] = [];
    const docsSeen: string[] = [];
    const base = projection({ leadKinds: ['account', 'accountRemoved'] });
    const handle = engine().project(
      {
        ...base,
        apply(state, changes) {
          for (const c of changes) {
            if (c.kind === 'account') applied.push(c.account.id);
            if (c.kind === 'document') docsSeen.push(c.document.externalId);
          }
          bump();
          return base.apply(state, changes);
        },
      },
      () => {},
    );
    // Both feeds are open before the account is created.
    await waitUntil(() => feeds.some((f) => f.kinds) && feeds.some((f) => !f.kinds));
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
    // The main feed has now replayed everything up to the document 'y', which
    // follows the account in the log: the account was offered to it by then.
    await waitUntil(() => docsSeen.includes('y'));
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
          bump();
          return base.init(read);
        },
      },
      record(states),
    );
    await waitUntil(() => inits === 2, 4000);
    const acc = await store.createAccount({ source: 's', identifier: 'after' });
    await waitUntil(() => states.at(-1)!.accounts.includes(acc.id));
    await handle.stop();
  });

  it('stop() during init() ends the projection once init returns', async () => {
    let releaseInit = () => {};
    const initGate = new Promise<void>((resolve) => {
      releaseInit = resolve;
    });
    let started = false;
    const base = projection({ leadKinds: ['account'] });
    const handle = engine().project(
      {
        ...base,
        async init(read) {
          started = true;
          bump();
          await initGate;
          return base.init(read);
        },
      },
      () => {},
    );
    await waitUntil(() => started);
    let stopped = false;
    const stopping = handle.stop().then(() => {
      stopped = true;
      bump();
    });
    releaseInit();
    await waitUntil(() => stopped);
    await stopping;
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
          bump();
          return s;
        },
      },
      record(states),
    );
    await waitUntil(() => created !== '');
    await waitUntil(() => states.at(-1)?.accounts.includes(created) ?? false);
    await handle.stop();
  });
});
