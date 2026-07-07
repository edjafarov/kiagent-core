/**
 * @jest-environment node
 *
 * `createMcpHandler()` is the seam a product build uses to serve MCP over its
 * OWN transport (e.g. a remote HTTPS server) while still reading the SAME live
 * ToolRegistry/resources/activity the loopback server uses — no second,
 * independent registry. Unlike a single-transport handler, it MULTIPLEXES:
 * it owns its own session pool (a `mcp-session-id`-keyed map, independent of
 * loopback's) so a product remote server can serve many concurrent sessions
 * and reconnects, not one session for its whole lifetime.
 *
 * Proven here by (a) driving TWO raw `initialize` POSTs through an ephemeral
 * http.Server whose sole handler is the factory's closure and asserting they
 * are handed TWO DISTINCT `mcp-session-id`s (the discriminator against the old
 * single-session impl, which minted one id for its whole life), then (b)
 * confirming session A still answers after session B initialized (the map
 * multiplexes, it doesn't overwrite), and (c) registering a tool AFTER
 * startMcp() returns and seeing it through a real MCP client (the live shared
 * registry, nothing from server.ts's loopback listener involved).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import http from 'http';
import type { AddressInfo } from 'net';

import type { Query } from '@shared/contracts';

import { startMcp } from '../server';
import type { McpServerHandle } from '../server';

function fakeQuery(): Query {
  return {
    async document() {
      return null;
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

/** A raw JSON-RPC `initialize` POST — no SDK Client, so we can read the
 *  transport-assigned `mcp-session-id` response header directly. */
function rawInitialize(
  url: URL,
  sessionId?: string,
): Promise<{ status: number; sessionId?: string; body: string }> {
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'raw', version: '0.0.0' },
    },
  });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // StreamableHTTPServerTransport 406s without BOTH accepts.
          Accept: 'application/json, text/event-stream',
          'Content-Length': Buffer.byteLength(payload),
          ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            sessionId: res.headers['mcp-session-id'] as string | undefined,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

/** A raw non-initialize POST bound to `sessionId` — proves that session still
 *  routes after another session was created. */
function rawPing(
  url: URL,
  sessionId: string,
): Promise<{ status: number; body: string }> {
  const payload = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Content-Length': Buffer.byteLength(payload),
          'mcp-session-id': sessionId,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

describe('McpServerHandle.createMcpHandler', () => {
  let handle: McpServerHandle;
  let dataDir: string;
  let productServer: http.Server;
  let productUrl: URL;
  const clients: Client[] = [];

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-mcp-factory-'));
    handle = await startMcp({
      query: fakeQuery(),
      logSink: { log: () => {} },
      dataDir,
    });

    // A product-owned transport that has NOTHING to do with server.ts's own
    // loopback http.Server — proves the multiplexing handler is usable
    // standalone.
    const mcpHandler = handle.createMcpHandler();
    productServer = http.createServer((req, res) => {
      void mcpHandler(req, res);
    });
    await new Promise<void>((resolve) => productServer.listen(0, resolve));
    const { port } = productServer.address() as AddressInfo;
    productUrl = new URL(`http://127.0.0.1:${port}/mcp`);
  });

  afterAll(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close().catch(() => {})));
    await new Promise<void>((resolve) => productServer.close(() => resolve()));
    await handle.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function connectClient(): Promise<Client> {
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const transport = new StreamableHTTPClientTransport(productUrl);
    await client.connect(transport);
    clients.push(client);
    return client;
  }

  it('multiplexes: two initialize handshakes get two DISTINCT session ids', async () => {
    const a = await rawInitialize(productUrl);
    const b = await rawInitialize(productUrl);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.sessionId).toBeTruthy();
    expect(b.sessionId).toBeTruthy();
    // The discriminator: the OLD single-session handler minted ONE session id
    // for its whole lifetime, so both handshakes would share it.
    expect(a.sessionId).not.toBe(b.sessionId);

    // And session A still routes AFTER session B initialized — the map
    // multiplexes, it does not overwrite.
    const pingA = await rawPing(productUrl, a.sessionId!);
    expect(pingA.status).toBe(200);
  });

  it('is memoized: repeated calls return the same handler (one product pool)', () => {
    expect(handle.createMcpHandler()).toBe(handle.createMcpHandler());
  });

  it('serves the LIVE shared registry, not a duplicate', async () => {
    const dispose = handle.registerTool({
      name: 'factory-echo',
      description: 'proves the live registry is shared',
      inputSchema: {
        type: 'object',
        properties: { msg: { type: 'string' } },
      },
      call: async (args) => ({ echoed: args.msg }),
    });

    try {
      const client = await connectClient();
      const { tools } = await client.listTools();
      expect(tools.some((t) => t.name === 'factory-echo')).toBe(true);

      const result = await client.callTool({
        name: 'factory-echo',
        arguments: { msg: 'hi' },
      });
      expect(result.isError).toBeFalsy();
    } finally {
      dispose();
    }
  });
});
