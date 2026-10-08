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

  it('serves search and query_sql from a query-only connection', async () => {
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

    const search = (await client.callTool({
      name: 'search',
      arguments: { query: 'invoice' },
    })) as { content: Array<{ text: string }> };
    const hits = JSON.parse(search.content[0].text) as Array<{
      title: string;
      snippet: string;
    }>;
    expect(hits.map((h) => h.title)).toEqual(['Quarterly invoice']);
    expect(hits[0].snippet).toContain('invoice');

    const sql = (await client.callTool({
      name: 'query_sql',
      arguments: { sql: 'SELECT title FROM documents' },
    })) as { content: Array<{ text: string }> };
    expect(JSON.parse(sql.content[0].text).rows).toEqual([
      { title: 'Quarterly invoice' },
    ]);
  });
});

// (Task 6 Step 11 extends this file with the bounded-result call.)
