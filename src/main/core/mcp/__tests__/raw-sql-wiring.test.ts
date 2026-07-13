/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { openDb } from '../../../db/app-db';
import { openStore } from '../../store/store';
import { startMcp } from '../server';
import type { McpServerHandle } from '../server';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};

const logSink = { log: () => {} };

async function rpc(
  port: number,
  body: unknown,
  sessionId?: string,
): Promise<{ status: number; sessionId: string | null; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  // enableJsonResponse is on, so the body is a single JSON object.
  return {
    status: res.status,
    sessionId: res.headers.get('mcp-session-id'),
    json: text ? JSON.parse(text) : null,
  };
}

describe('raw-sql tools over the HTTP transport', () => {
  let dir: string;
  let handle: McpServerHandle;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-wiring-'));
    const dbPath = path.join(dir, 'kiagent.db');
    const store = openStore(await openDb(dbPath), deps);
    const acc = await store.createAccount({
      source: 'gmail',
      identifier: 'me@example.com',
    });
    await store.commit({
      account: acc.id,
      documents: [
        {
          externalId: 'd0',
          type: 'email.message',
          title: 'Wired',
          markdown: 'body',
          metadata: {},
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
      cursor: 1,
    });
    await store.close();

    handle = await startMcp({ query: store.read, logSink, dataDir: dir });
  });

  afterAll(async () => {
    await handle.stop();
  });

  it('lists query_sql and get_schema and runs query_sql', async () => {
    const port = handle.port!;
    const init = await rpc(port, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test', version: '0' },
      },
    });
    const sid = init.sessionId!;
    expect(sid).toBeTruthy();

    const list = await rpc(
      port,
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      sid,
    );
    const toolNames = list.json.result.tools.map((t: { name: string }) => t.name);
    expect(toolNames).toEqual(expect.arrayContaining(['query_sql', 'get_schema']));

    const call = await rpc(
      port,
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'query_sql', arguments: { sql: 'SELECT title FROM documents' } },
      },
      sid,
    );
    const payload = JSON.parse(call.json.result.content[0].text);
    expect(payload.rows).toEqual([{ title: 'Wired' }]);
  });
});
