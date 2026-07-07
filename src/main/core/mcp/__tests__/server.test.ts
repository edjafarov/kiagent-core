/**
 * @jest-environment node
 *
 * End-to-end over real HTTP: starts the Streamable HTTP transport once for
 * the whole file and drives it with the MCP SDK's own client, so the
 * low-level Server request handlers wired in registry.ts (bypassing the
 * zod-based registerTool — see that file's doc comment) are exercised the
 * same way a real MCP client would. One shared server + a fresh client per
 * test (rather than a fresh server per test) — starting many ephemeral
 * servers on the same fixed candidate ports within one Node process makes
 * `fetch`'s keep-alive connection pool flaky (a pooled socket from a just-
 * closed server gets reused against the next one and resets); a single
 * long-lived server across the file matches real usage anyway.
 *
 * Deliberately does NOT exercise connectClient() against a REAL client id:
 * that writes into the developer's actual Claude Desktop/Cursor/VS Code/Codex
 * config files (see clients.ts) — only the safe "unknown client" error path
 * and the read-only clients() listing are covered here.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import type { Document, LogLevel, Query } from '@shared/contracts';

import { startMcp } from '../server';
import type { McpServerHandle } from '../server';

// One canned document so the doc://{id} resource read path has a hit.
const EXISTING_DOC = {
  id: 'doc-existing',
  accountId: 'acc-1',
  externalId: 'ext-1',
  type: 'file',
  title: 'Fixture doc',
  markdown: '# hello resource',
  metadata: {},
  createdAt: '2026-01-01T00:00:00.000Z',
  parentId: null,
  contentHash: 'hash',
  seq: 1,
  archivedAt: null,
  languages: [],
  ingestedAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} as unknown as Document;

function fakeQuery(): Query {
  return {
    async document(id) {
      return (id as string) === (EXISTING_DOC.id as string)
        ? EXISTING_DOC
        : null;
    },
    async children() {
      return [];
    },
    async byExternalId() {
      return null;
    },
    async search() {
      return [];
    },
    async count() {
      return 0;
    },
    async accounts() {
      return [];
    },
  };
}

const BUILTIN_TOOL_NAMES = [
  'count',
  'digital_memory_info',
  'get',
  'get_related',
  'search',
].sort();

describe('startMcp (HTTP transport)', () => {
  let handle: McpServerHandle;
  let dataDir: string;
  let logs: Array<{
    scope: string;
    level: LogLevel;
    msg: string;
    fields?: Record<string, unknown>;
  }>;
  const clients: Client[] = [];

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-mcp-http-'));
    logs = [];
    handle = await startMcp({
      query: fakeQuery(),
      logSink: {
        log: (scope, level, msg, fields) =>
          logs.push({ scope, level, msg, fields }),
      },
      dataDir,
    });
  });

  afterAll(async () => {
    await handle.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})));
    logs.length = 0;
  });

  async function connectClient(): Promise<Client> {
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${handle.port}/mcp`),
    );
    await client.connect(transport);
    clients.push(client);
    return client;
  }

  it('binds to loopback on one of the candidate ports', () => {
    expect(handle.port).not.toBeNull();
    expect([7421, 7422, 7423, 7424, 7425]).toContain(handle.port);
  });

  it('lists the built-in tools over the wire', async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(BUILTIN_TOOL_NAMES);
  });

  it('calls a tool and audits it via the log sink', async () => {
    const client = await connectClient();
    const result = await client.callTool({
      name: 'digital_memory_info',
      arguments: {},
    });
    expect(result.isError).toBeFalsy();

    const auditEntry = logs.find(
      (l) => l.scope === 'mcp.call' && l.msg === 'digital_memory_info',
    );
    expect(auditEntry).toBeDefined();
    expect(auditEntry?.level).toBe('info');
    expect(auditEntry?.fields?.ok).toBe(true);
    expect(typeof auditEntry?.fields?.ms).toBe('number');
  });

  it('audits failed calls too, with ok:false', async () => {
    const client = await connectClient();
    const result = await client.callTool({ name: 'get', arguments: {} }); // missing `id`/`ids`
    expect(result.isError).toBe(true);

    const auditEntry = logs.find(
      (l) => l.scope === 'mcp.call' && l.msg === 'get',
    );
    expect(auditEntry?.fields?.ok).toBe(false);
  });

  it('registerTool adds a live tool visible to an already-connected client; its disposer removes it', async () => {
    const client = await connectClient();

    const dispose = handle.registerTool({
      name: 'echo',
      description: 'echoes input',
      inputSchema: { type: 'object', properties: { msg: { type: 'string' } } },
      call: async (args) => ({ echoed: args.msg }),
    });

    try {
      const { tools } = await client.listTools();
      expect(tools.some((t) => t.name === 'echo')).toBe(true);

      const result = await client.callTool({
        name: 'echo',
        arguments: { msg: 'hi' },
      });
      expect(result.isError).toBeFalsy();
    } finally {
      dispose();
    }

    const { tools: after } = await client.listTools();
    expect(after.some((t) => t.name === 'echo')).toBe(false);
  });

  it('advertises instructions and a server icon in the initialize handshake', async () => {
    const client = await connectClient();
    // The instructions string is what steers the calling LLM — assert it
    // names the tools it teaches, not just that something non-empty came back.
    const instructions = client.getInstructions();
    expect(instructions).toContain('digital_memory_info');
    expect(instructions).toContain('get_related(thread_messages)');

    const serverInfo = client.getServerVersion() as
      | { name: string; icons?: Array<{ src: string; mimeType?: string }> }
      | undefined;
    expect(serverInfo?.name).toBe('kiagent');
    expect(serverInfo?.icons?.[0]?.src).toMatch(/^data:image\/png;base64,/);
    expect(serverInfo?.icons?.[0]?.mimeType).toBe('image/png');
  });

  it('lists the doc://{id} resource template (and no static resources)', async () => {
    const client = await connectClient();
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates).toEqual([
      expect.objectContaining({
        uriTemplate: 'doc://{id}',
        mimeType: 'text/markdown',
      }),
    ]);
    const { resources } = await client.listResources();
    expect(resources).toEqual([]);
  });

  it('reads an existing document through doc://{id}', async () => {
    const client = await connectClient();
    const { contents } = await client.readResource({
      uri: `doc://${EXISTING_DOC.id}`,
    });
    expect(contents).toEqual([
      {
        uri: `doc://${EXISTING_DOC.id}`,
        mimeType: 'text/markdown',
        text: '# hello resource',
      },
    ]);
  });

  it('rejects a doc:// read for a document that does not exist', async () => {
    const client = await connectClient();
    await expect(
      client.readResource({ uri: 'doc://no-such-doc' }),
    ).rejects.toThrow(/not found/);
  });

  it('clients() resolves to an array without writing anything', async () => {
    await expect(handle.clients()).resolves.toEqual(expect.any(Array));
  });

  it('connectClient rejects an unknown client id (never touches a real config file)', async () => {
    await expect(handle.connectClient('not-a-real-client')).rejects.toThrow(
      /unknown client/,
    );
  });
});
