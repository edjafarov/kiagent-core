/**
 * A closed role gate mid-commit (the lease was lost and the device fenced) is
 * not an account failure: the loop returns with no log line, no retry and no
 * status commit. The hold that follows the fence stops the run.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { Source } from '@shared/contracts';

import { openDb } from '../../../db/app-db';
import { openStore } from '../../store/store';
import type { CoreStore } from '../../store/store';
import { createEngine } from '../engine';
import { SyncReadOnly } from '../../sync/role';

jest.setTimeout(20_000);

describe('a SyncReadOnly during a fence', () => {
  let dir: string;
  let store: CoreStore;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-ro-'));
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

  it('a SyncReadOnly mid-commit during a fence returns silently: no error/warn line, retries unchanged, status not committed to error', async () => {
    let fenced = false;
    let pulls = 0;
    const source: Source = {
      descriptor: { id: 'ro', name: 'Ro', documentTypes: ['note'], auth: 'none' },
      async connect() {
        return { identifier: 'ro@test' };
      },
      // eslint-disable-next-line require-yield
      async *pull() {
        pulls += 1;
        fenced = true;
        // What the guarded writer throws once the fence flag flips.
        throw Object.assign(new SyncReadOnly('write'), {});
      },
      toDocument: () => null,
    };
    const lines: string[] = [];
    const engine = createEngine({
      store,
      sources: { get: (id) => (id === 'ro' ? source : undefined) },
      inference: {
        complete: async () => '',
        see: async () => '',
        read: async () => '',
        hear: async () => '',
      },
      convert: async (input) => input,
      logs: { log: (_s, level, msg) => void lines.push(`${level}: ${msg}`) },
    });
    const account = await store.createAccount({ source: 'ro', identifier: 'ro@test' });
    const handle = engine.run(account) as ReturnType<typeof engine.run> & {
      active(): boolean;
    };
    const deadline = Date.now() + 10_000;
    while (handle.active() && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 25));
    expect(fenced).toBe(true);
    expect(handle.active()).toBe(false);
    expect(pulls).toBe(1);
    expect(lines.filter((l) => /^(error|warn)/.test(l))).toEqual([]);
    expect((await store.account(account.id))?.status).not.toBe('error');
    expect((await store.account(account.id))?.lastError ?? null).toBeNull();
  });
});
