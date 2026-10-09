/**
 * @jest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { openStore } from '@main/core/store/store';
import { openDb } from '@main/db/app-db';
import { createWorkerEnv, REPO_ROOT } from '@main/db/__tests__/worker-test-env';

jest.setTimeout(90_000);

const STDIO_ENTRY = path.join(__dirname, '..', 'stdio-entry.ts');

describe('stdio MCP sibling (real process)', () => {
  const env = createWorkerEnv('stdio');
  let dir: string;
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  afterAll(() => env.cleanup());

  /** Seeds a one-document corpus and connects a stdio client to the sibling. */
  async function connectSeeded(): Promise<Client> {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-stdio-'));
    const dbPath = path.join(dir, 'kiagent.db');
    const store = openStore(await openDb(dbPath), {
      encrypt: (s: string) => Buffer.from(s, 'utf8'),
      decrypt: (b: Buffer) => b.toString('utf8'),
      detectLanguages: () => ['eng'],
    });
    const acc = await store.createAccount({
      source: 'gmail',
      identifier: 'me@example.com',
    });
    await store.commit({
      account: acc.id,
      cursor: null,
      documents: [
        {
          externalId: 'd1',
          type: 'email.message',
          title: 'Quarterly invoice',
          markdown: 'the invoice is due',
          metadata: {},
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    await store.close();

    client = new Client({ name: 'stdio-test', version: '0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [...env.execArgv, STDIO_ENTRY, '--db', dbPath],
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          TS_NODE_PROJECT: path.join(REPO_ROOT, 'tsconfig.json'),
          TS_NODE_TRANSPILE_ONLY: '1',
        } as Record<string, string>,
      }),
    );
    return client;
  }

  it('serves search and query_sql from a query-only connection', async () => {
    const live = await connectSeeded();

    const search = (await live.callTool({
      name: 'search',
      arguments: { query: 'invoice' },
    })) as { content: Array<{ text: string }> };
    const hits = JSON.parse(search.content[0].text) as Array<{
      title: string;
      snippet: string;
    }>;
    expect(hits.map((h) => h.title)).toEqual(['Quarterly invoice']);
    expect(hits[0].snippet).toContain('invoice');

    const sql = (await live.callTool({
      name: 'query_sql',
      arguments: { sql: 'SELECT title FROM documents' },
    })) as { content: Array<{ text: string }> };
    expect(JSON.parse(sql.content[0].text).rows).toEqual([
      { title: 'Quarterly invoice' },
    ]);
  });

  it('applies the same query_sql bounds as the in-app runner', async () => {
    const live: Client = await connectSeeded(); // definite local: no `Client | undefined` deref in the closure
    const callSql = async (sql: string) => {
      const r = (await live.callTool({
        name: 'query_sql',
        arguments: { sql },
      })) as { content: Array<{ text: string }> };
      return JSON.parse(r.content[0].text) as {
        rows: Array<Record<string, unknown>>;
        truncated: boolean;
        hint?: string;
      };
    };
    const series = (n: number, cols: string) =>
      `WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i < ${n}) SELECT ${cols} FROM c`;

    // 1. row cap
    const rowsCut = await callSql(series(600, 'i'));
    expect(rowsCut.rows).toHaveLength(500);
    expect(rowsCut.truncated).toBe(true);

    // 2. oversized text value (> 64 KiB): cut, marked, truncated
    const valueCut = await callSql(`SELECT hex(randomblob(40000)) AS big`);
    const big = valueCut.rows[0].big as string;
    expect(big.endsWith('…[truncated]')).toBe(true);
    expect(
      Buffer.byteLength(big.slice(0, -'…[truncated]'.length)),
    ).toBeLessThanOrEqual(65536);
    expect(valueCut.truncated).toBe(true);

    // 3. 1 MiB aggregate cap (the whole serialized rows array)
    const aggCut = await callSql(
      series(600, 'i, hex(randomblob(100000)) AS big'),
    );
    expect(aggCut.truncated).toBe(true);
    expect(aggCut.rows.length).toBeGreaterThan(0);
    expect(aggCut.rows.length).toBeLessThan(500);
    expect(Buffer.byteLength(JSON.stringify(aggCut.rows))).toBeLessThanOrEqual(
      1024 * 1024,
    );
    expect(aggCut.hint).toMatch(/1 MiB/);
  });
});
