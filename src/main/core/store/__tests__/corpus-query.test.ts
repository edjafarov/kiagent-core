/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { AccountId } from '@shared/contracts';

import {
  openCorpusReadConnection,
  openDb,
  type AppDb,
} from '../../../db/app-db';
import {
  CORPUS_LANGUAGES_SQL,
  createCorpusQuery,
  QUERY_METHODS,
} from '../corpus-query';
import { openStore, type CoreStore } from '../store';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: (text: string) =>
    /[äöüß]|Rechnung/i.test(text) ? ['deu'] : ['eng'],
};

describe('createCorpusQuery', () => {
  let dir: string;
  let dbPath: string;
  let writerDb: AppDb;
  let store: CoreStore;
  let accountId: AccountId;
  let readDb: AppDb | undefined;

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
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-corpus-query-'));
    dbPath = path.join(dir, 'test.db');
    writerDb = await openDb(dbPath);
    store = openStore(writerDb, deps);
    accountId = (
      await store.createAccount({
        source: 'test',
        identifier: 'me@example.com',
      })
    ).id;
  });

  afterEach(async () => {
    if (readDb) await readDb.close();
    readDb = undefined;
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('exposes exactly the QUERY_METHODS surface', () => {
    const { query } = createCorpusQuery(writerDb);
    expect(Object.keys(query).sort()).toEqual([...QUERY_METHODS].sort());
  });

  it('data-version mode: a second connection sees a language added by the writer', async () => {
    await commitDoc('en1', 'we run daily');
    readDb = await openCorpusReadConnection(dbPath);
    const { query } = createCorpusQuery(readDb, {
      languageCache: 'data-version',
    });
    // Fills the cache with { eng } only.
    expect(await query.search({ text: 'Rechnungen' })).toHaveLength(0);
    await commitDoc('de1', 'Die Rechnung ist offen');
    // German is now in the corpus: the inflected query must stem to it.
    expect(await query.search({ text: 'Rechnungen' })).toHaveLength(1);
  });

  it('data-version mode: a fill that started before a commit is recomputed after it', async () => {
    await commitDoc('en1', 'we run daily');
    readDb = await openCorpusReadConnection(dbPath);
    const real = readDb;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let started!: () => void;
    const startedP = new Promise<void>((r) => {
      started = r;
    });
    // Holds the languages lookup open AFTER its rows were read, so the
    // writer's commit lands between "fill started" and "fill stored".
    const slow = {
      ...real,
      all: async (sql: string, params?: never) => {
        const rows = await real.all(sql, params);
        if (sql === CORPUS_LANGUAGES_SQL) {
          started();
          await gate;
        }
        return rows;
      },
    } as AppDb;
    const { query } = createCorpusQuery(slow, {
      languageCache: 'data-version',
    });
    const first = query.search({ text: 'Rechnungen' });
    await startedP;
    await commitDoc('de1', 'Die Rechnung ist offen');
    release();
    await first; // may legitimately be stale
    expect(await query.search({ text: 'Rechnungen' })).toHaveLength(1);
  });

  it('explicit mode keeps the cache until invalidateLanguages()', async () => {
    await commitDoc('en1', 'we run daily');
    const calls: string[] = [];
    const spy = {
      ...writerDb,
      all: (sql: string, params?: never) => {
        calls.push(sql);
        return writerDb.all(sql, params);
      },
    } as AppDb;
    const { query, invalidateLanguages } = createCorpusQuery(spy);
    await query.search({ text: 'run' });
    await query.search({ text: 'run' });
    expect(calls.filter((s) => s === CORPUS_LANGUAGES_SQL)).toHaveLength(1);
    invalidateLanguages();
    await query.search({ text: 'run' });
    expect(calls.filter((s) => s === CORPUS_LANGUAGES_SQL)).toHaveLength(2);
  });
});
