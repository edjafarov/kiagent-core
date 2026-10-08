/**
 * @jest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { openStore } from '@main/core/store/store';
import { openDb, type AppDb } from '../app-db';
import { openDbInWorker } from '../worker-client';
import { createWorkerEnv, WORKER_ENTRY } from './worker-test-env';

jest.setTimeout(60_000);

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};

describe('DB worker read role (real spawn)', () => {
  let dir: string;
  let dbPath: string;
  const env = createWorkerEnv('read-role');
  let reader: AppDb | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-read-role-'));
    dbPath = path.join(dir, 'kiagent.db');
  });

  afterEach(async () => {
    if (reader?.isOpen()) await reader.close();
    reader = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  afterAll(() => env.cleanup());

  async function seed(): Promise<void> {
    const store = openStore(await openDb(dbPath), deps);
    const acc = await store.createAccount({
      source: 'test',
      identifier: 'me@example.com',
    });
    await store.commit({
      account: acc.id,
      cursor: null,
      documents: [
        {
          externalId: 'd1',
          type: 'note',
          title: 'Hello',
          markdown: 'invoice body',
          metadata: {},
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    await store.close();
  }

  const open = (cacheKiB = 4096) =>
    openDbInWorker(dbPath, WORKER_ENTRY, {
      execArgv: env.execArgv,
      role: 'read',
      cacheKiB,
    });

  it('serves the read procedure with the specified pragmas', async () => {
    await seed();
    reader = await open(4096);
    const res = (await reader.proc!('read', {
      method: 'accounts',
      args: [],
    })) as {
      value: Array<{ identifier: string }>;
      execMs: number;
      fuzzyRuns: number;
    };
    expect(res.value.map((a) => a.identifier)).toEqual(['me@example.com']);
    expect(typeof res.execMs).toBe('number');
    expect(res.fuzzyRuns).toBe(0);
    expect(await reader.all('PRAGMA cache_size')).toEqual([
      { cache_size: -4096 },
    ]);
    expect(await reader.all('PRAGMA query_only')).toEqual([{ query_only: 1 }]);
    expect(await reader.all('PRAGMA mmap_size')).toEqual([{ mmap_size: 0 }]);
  });

  it('runs search (stemming, fuzzy, projection) inside the worker', async () => {
    await seed();
    reader = await open();
    const res = (await reader.proc!('read', {
      method: 'search',
      args: [{ text: 'invoice', project: 'snippet' }],
    })) as {
      value: Array<{ title: string; markdown: string; snippet: string }>;
    };
    expect(res.value).toHaveLength(1);
    expect(res.value[0].markdown).toBe('');
    expect(res.value[0].snippet).toContain('<b>invoice</b>');
  });

  it('returns the worker-side fuzzyRuns counter with every read result', async () => {
    await seed();
    reader = await open();
    const read = async (text: string) =>
      (await reader!.proc!('read', { method: 'search', args: [{ text }] })) as {
        fuzzyRuns: number;
      };
    expect((await read('invoice')).fuzzyRuns).toBe(1); // page short -> fuzzy statement ran
    expect((await read('invoice')).fuzzyRuns).toBe(2); // cumulative across calls
    const acc = (await reader.proc!('read', {
      method: 'accounts',
      args: [],
    })) as {
      fuzzyRuns: number;
    };
    expect(acc.fuzzyRuns).toBe(2); // other methods leave it alone
  });

  it('refuses writes (query_only) and registers no write procedure', async () => {
    await seed();
    reader = await open();
    await expect(reader.run('DELETE FROM documents')).rejects.toThrow(
      /readonly/i,
    );
    await expect(reader.proc!('commit', {})).rejects.toThrow(
      /unknown db procedure/,
    );
    await expect(
      reader.proc!('read', { method: 'exec', args: [] }),
    ).rejects.toThrow(/unknown read method/);
  });

  it('does not migrate: a bare file stays bare', async () => {
    const bare = new Database(dbPath);
    bare.exec('CREATE TABLE only_me(x)');
    bare.close();
    reader = await open();
    const names = (await reader.all(
      `SELECT name FROM sqlite_master WHERE type = 'table'`,
    )) as Array<{ name: string }>;
    expect(names.map((n) => n.name)).toEqual(['only_me']);
  });
});
