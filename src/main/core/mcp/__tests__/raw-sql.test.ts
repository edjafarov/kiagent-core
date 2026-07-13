/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { openDb } from '../../../db/app-db';
import { openStore } from '../../store/store';
import { createRawSqlTools } from '../tools/raw-sql';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};

async function seedCorpus(dbPath: string): Promise<void> {
  const store = openStore(await openDb(dbPath), deps);
  const acc = await store.createAccount({
    source: 'gmail',
    identifier: 'me@example.com',
  });
  await store.commit({
    account: acc.id,
    cursor: 1,
    documents: [
      {
        externalId: 'd0',
        type: 'email.message',
        title: 'Hello',
        markdown: 'body',
        metadata: {},
        createdAt: '2026-01-01T00:00:00Z',
      },
    ],
  });
  await store.close();
}

describe('createRawSqlTools', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-rawsql-'));
  });

  it('exposes query_sql and get_schema, both tier powerful', async () => {
    const dbPath = path.join(dir, 'test.db');
    await seedCorpus(dbPath);
    const raw = createRawSqlTools(dbPath);
    try {
      const names = raw.tools.map((t) => t.name).sort();
      expect(names).toEqual(['get_schema', 'query_sql']);
      expect(raw.tools.every((t) => t.tier === 'powerful')).toBe(true);
    } finally {
      await raw.dispose();
    }
  });

  it('query_sql reads the corpus; get_schema returns markdown', async () => {
    const dbPath = path.join(dir, 'test.db');
    await seedCorpus(dbPath);
    const raw = createRawSqlTools(dbPath);
    try {
      const q = raw.tools.find((t) => t.name === 'query_sql')!;
      const result = (await q.call({
        sql: 'SELECT title FROM documents',
      })) as { rows: Array<{ title: string }>; truncated: boolean };
      expect(result.rows).toEqual([{ title: 'Hello' }]);

      const s = raw.tools.find((t) => t.name === 'get_schema')!;
      const md = (await s.call({})) as string;
      expect(md).toContain('## documents');
    } finally {
      await raw.dispose();
    }
  });

  it('opens a corpus with a dirty -wal and no live writer', async () => {
    // Seed a corpus and, while a writer still holds an un-checkpointed -wal,
    // copy all three files to a fresh path. The copy has a populated -wal with
    // NO associated connection — exactly the WAL-recovery case a strict
    // readonly open can trip over.
    const src = path.join(dir, 'live.db');
    const store = openStore(await openDb(src), deps);
    const acc = await store.createAccount({
      source: 'gmail',
      identifier: 'me@example.com',
    });
    await store.commit({
      account: acc.id,
      cursor: 1,
      documents: [
        {
          externalId: 'd0',
          type: 'email.message',
          title: 'DirtyWal',
          markdown: 'body',
          metadata: {},
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
    });

    const copyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-copy-'));
    const dst = path.join(copyDir, 'copy.db');
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(src + suffix))
        fs.copyFileSync(src + suffix, dst + suffix);
    }
    await store.close(); // writer for the ORIGINAL goes away; the copy has none

    const raw = createRawSqlTools(dst);
    try {
      const q = raw.tools.find((t) => t.name === 'query_sql')!;
      const result = (await q.call({
        sql: 'SELECT title FROM documents',
      })) as { rows: Array<{ title: string }> };
      // The row lived only in the -wal, so reading it back proves the handle
      // recovered the dirty -wal rather than silently reading a stale main db.
      expect(result.rows).toEqual([{ title: 'DirtyWal' }]);
    } finally {
      await raw.dispose();
    }
  });
});
