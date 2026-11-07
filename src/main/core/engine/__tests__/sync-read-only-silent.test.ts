/**
 * A closed role gate mid-commit (the lease was lost and the device fenced) is
 * not an account failure: the loop returns with no log line, no retry and no
 * status commit. The hold that follows the fence stops the run. The error
 * arrives through the worker bridge as a plain Error carrying `code`.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { Source, Worker } from '@shared/contracts';

import { openDb } from '../../../db/app-db';
import { openStore } from '../../store/store';
import type { CoreStore } from '../../store/store';
import { createEngine } from '../engine';

jest.setTimeout(20_000);

const roError = () =>
  Object.assign(new Error('read-only copy'), { code: 'SYNC_READ_ONLY' });

describe('a SyncReadOnly during a fence', () => {
  let dir: string;
  let store: CoreStore;
  let fenced: boolean;
  let lines: string[];

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-ro-'));
    fenced = false;
    lines = [];
    store = openStore(await openDb(path.join(dir, 'test.db')), {
      encrypt: (s: string) => Buffer.from(s, 'utf8'),
      decrypt: (b: Buffer) => b.toString('utf8'),
      detectLanguages: () => [],
    });
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A store whose commit throws once the fence flag flips. */
  const fencedStore = (): CoreStore =>
    new Proxy(store, {
      get(t, k, r) {
        if (k === 'commit')
          return (b: unknown) => {
            if (fenced) throw roError();
            return (t.commit as (x: unknown) => unknown)(b);
          };
        return Reflect.get(t, k, r);
      },
    });

  const engineOver = (source?: Source) =>
    createEngine({
      store: fencedStore(),
      sources: { get: (id) => (source && id === 'ro' ? source : undefined) },
      inference: {
        complete: async () => '',
        see: async () => '',
        read: async () => '',
        hear: async () => '',
      },
      convert: async (input) => input,
      logs: { log: (_s, level, msg) => void lines.push(`${level}: ${msg}`) },
    });

  const bad = () => lines.filter((l) => /^(error|warn)/.test(l));

  it('a SyncReadOnly mid-commit during a fence returns silently: no error/warn line, retries unchanged, status not committed to error', async () => {
    let pulls = 0;
    const source: Source = {
      descriptor: {
        id: 'ro',
        name: 'Ro',
        documentTypes: ['note'],
        auth: 'none',
      },
      async connect() {
        return { identifier: 'ro@test' };
      },
      async *pull() {
        pulls += 1;
        fenced = true; // the fence lands; the batch's commit is refused
        yield { phase: 'live', items: [], cursor: { n: 1 } };
      },
      toDocument: () => null,
    };
    const account = await store.createAccount({
      source: 'ro',
      identifier: 'ro@test',
    });
    const handle = engineOver(source).run(account) as unknown as {
      active(): boolean;
    };
    const deadline = Date.now() + 10_000;
    while (handle.active() && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 25));
    expect(fenced).toBe(true);
    expect(handle.active()).toBe(false);
    expect(pulls).toBe(1);
    expect(bad()).toEqual([]);
    const fresh = await store.account(account.id);
    expect(fresh?.status).not.toBe('error');
    expect(fresh?.lastError ?? null).toBeNull();
  });

  it('the seed consumer stops silently when its commit hits the closed gate', async () => {
    const account = await store.createAccount({
      source: 'test',
      identifier: 'me',
    });
    await store.commit({
      account: account.id,
      documents: [
        {
          externalId: 'a',
          type: 'note',
          title: 'a',
          markdown: 'body a',
          metadata: {},
          createdAt: null,
        },
      ],
      cursor: 1,
    });
    fenced = true;
    const worker: Worker = {
      name: 'ro-seed',
      version: 1,
      matches: (c) => c.kind === 'document',
      async work(c, session) {
        if (c.kind !== 'document') return 'skip';
        session.enrich({ documentId: c.document.id, metadata: { x: true } });
        return 'done';
      },
    };
    const handle = engineOver().attach(worker);
    await new Promise((r) => setTimeout(r, 800));
    expect(bad()).toEqual([]);
    await handle.stop();
  });
});
