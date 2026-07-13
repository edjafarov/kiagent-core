/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

import { openDb } from '../../../db/app-db';
import { openStore } from '../../store/store';
import { runQuerySql } from '../tools/query-sql';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};

describe('runQuerySql', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-qsql-'));
    dbPath = path.join(dir, 'test.db');
    const store = openStore(await openDb(dbPath), deps);
    const acc = await store.createAccount({
      source: 'gmail',
      identifier: 'me@example.com',
    });
    await store.commit({
      account: acc.id,
      documents: Array.from({ length: 3 }, (_, i) => ({
        externalId: `d${i}`,
        type: 'email.message',
        title: `Doc ${i}`,
        markdown: 'body',
        metadata: {},
        createdAt: '2026-01-01T00:00:00Z',
      })),
      cursor: 1,
    });
    await store.close();
  });

  const ro = () =>
    new Database(dbPath, { readonly: true, fileMustExist: true });

  it('runs a SELECT and returns rows', () => {
    const conn = ro();
    try {
      const { rows, truncated } = runQuerySql(
        conn,
        'SELECT type, title FROM documents ORDER BY title',
      );
      expect(rows).toHaveLength(3);
      expect(rows[0]).toMatchObject({ type: 'email.message', title: 'Doc 0' });
      expect(truncated).toBe(false);
    } finally {
      conn.close();
    }
  });

  it('runs a WITH (CTE) SELECT', () => {
    const conn = ro();
    try {
      const { rows } = runQuerySql(
        conn,
        'WITH t AS (SELECT title FROM documents) SELECT count(*) AS n FROM t',
      );
      expect(rows[0]).toEqual({ n: 3 });
    } finally {
      conn.close();
    }
  });

  it('rejects non-SELECT statements at the textual gate', () => {
    const conn = ro();
    try {
      for (const sql of [
        'INSERT INTO documents DEFAULT VALUES',
        'UPDATE documents SET title=1',
        'DELETE FROM documents',
        'DROP TABLE documents',
        'CREATE TABLE x(y)',
        'PRAGMA journal_mode=DELETE',
      ]) {
        expect(() => runQuerySql(conn, sql)).toThrow(/only SELECT \/ WITH/);
      }
    } finally {
      conn.close();
    }
  });

  it('strips leading -- comments before the gate', () => {
    const conn = ro();
    try {
      const { rows } = runQuerySql(
        conn,
        '-- a note\n-- another\nSELECT count(*) AS n FROM documents',
      );
      expect(rows[0]).toEqual({ n: 3 });
    } finally {
      conn.close();
    }
  });

  it('a WITH … INSERT that passes the textual gate still cannot write', () => {
    const conn = ro();
    try {
      // Starts with `with`, so the textual gate admits it; it then fails —
      // the subquery wrapping makes it invalid SQL, and a readonly driver
      // would reject the write regardless. Either way it throws and the
      // corpus is unchanged.
      expect(() =>
        runQuerySql(conn, 'WITH t AS (SELECT 1) INSERT INTO documents DEFAULT VALUES'),
      ).toThrow();
      const n = (
        conn.prepare('SELECT count(*) AS n FROM documents').get() as { n: number }
      ).n;
      expect(n).toBe(3);
    } finally {
      conn.close();
    }
  });

  it('rejects a stacked-statement injection attempt', () => {
    const conn = ro();
    try {
      // better-sqlite3's prepare() rejects input containing more than one
      // statement, so the wrapped `SELECT * FROM (<sql>) LIMIT 501` throws
      // before the trailing `DROP TABLE` ever runs.
      expect(() =>
        runQuerySql(conn, 'SELECT 1) LIMIT 1; DROP TABLE documents;--'),
      ).toThrow();
      const { n } = conn
        .prepare('SELECT count(*) AS n FROM documents')
        .get() as { n: number };
      expect(n).toBe(3);
    } finally {
      conn.close();
    }
  });

  it('caps at 500 rows and flags truncation', () => {
    const conn = ro();
    try {
      const { rows, truncated } = runQuerySql(
        conn,
        'WITH RECURSIVE seq(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM seq WHERE x < 600) SELECT x FROM seq',
      );
      expect(rows).toHaveLength(500);
      expect(truncated).toBe(true);
    } finally {
      conn.close();
    }
  });
});
