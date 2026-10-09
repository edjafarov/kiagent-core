/**
 * @jest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AccountId } from '@shared/contracts';

import { openDb, type AppDb } from '../../db/app-db';
import {
  createWorkerEnv,
  WORKER_ENTRY,
} from '../../db/__tests__/worker-test-env';
import { openReads, readCacheKiB, type Reads } from '../reads';
import { openStore, type CoreStore } from '../store/store';

jest.setTimeout(90_000);

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: (text: string) =>
    /[äöüß]|Rechnung/i.test(text) ? ['deu'] : ['eng'],
};

describe('openReads (real reader worker)', () => {
  const env = createWorkerEnv('reads');
  let dir: string;
  let dbPath: string;
  let writerDb: AppDb;
  let store: CoreStore;
  let accountId: AccountId;
  let plane: Reads | undefined;
  const log = jest.fn();

  const commitDoc = (externalId: string, markdown: string) =>
    store.commit({
      account: accountId,
      cursor: null,
      documents: [
        {
          externalId,
          type: 'note',
          title: `T ${externalId}`,
          markdown,
          metadata: {},
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
    });

  beforeEach(async () => {
    log.mockReset();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-reads-'));
    dbPath = path.join(dir, 'kiagent.db');
    writerDb = await openDb(dbPath);
    store = openStore(writerDb, deps);
    accountId = (
      await store.createAccount({ source: 'test', identifier: 'me@x' })
    ).id;
  });

  afterEach(async () => {
    await plane?.close();
    plane = undefined;
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  afterAll(() => env.cleanup());

  it('a resolved commit is visible to the next read, including a new language', async () => {
    await commitDoc('en1', 'we run daily');
    plane = await openReads({
      dbPath,
      workerFile: WORKER_ENTRY,
      execArgv: env.execArgv,
      writer: store.read,
      weak: false,
      log,
    });
    expect(plane.mode()).toBe('reader');
    expect(await plane.reads.search({ text: 'Rechnungen' })).toHaveLength(0);
    await commitDoc('de1', 'Die Rechnung ist offen');
    const hits = await plane.reads.search({ text: 'Rechnungen' });
    expect(hits).toHaveLength(1);
    const doc = await plane.readsFor('mcp').document(hits[0].id);
    expect(doc?.externalId).toBe('de1');
    const { groups } = plane.stats.snapshot();
    expect(
      groups.find((g) => g.caller === 'other' && g.method === 'search'),
    ).toMatchObject({
      via: 'reader',
      count: 2,
    });
    expect(
      groups.find((g) => g.caller === 'mcp' && g.method === 'document'),
    ).toBeDefined();
  });

  it('falls back to the writer when the reader cannot open (logged once, stats kept)', async () => {
    await commitDoc('en1', 'we run daily');
    plane = await openReads({
      dbPath,
      workerFile: path.join(dir, 'no-such-worker.js'),
      writer: store.read,
      weak: false,
      log,
    });
    expect(plane.mode()).toBe('writer');
    expect(log).toHaveBeenCalledTimes(1);
    const [level, msg] = log.mock.calls[0];
    expect(level).toBe('warn');
    expect(msg).toMatch(
      /^\[db\] read worker unavailable: .* — reads use the writer$/,
    );
    expect(await plane.reads.accounts()).toHaveLength(1);
    expect(plane.stats.snapshot().fallbacks['open-failed']).toBe(1);
  });

  it('weak hosts get SQLite-default page cache', () => {
    expect(readCacheKiB(false)).toBe(8192);
    expect(readCacheKiB(true)).toBe(2048);
  });
});
