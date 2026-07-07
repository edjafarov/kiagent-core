/**
 * @jest-environment node
 *
 * `createSessionHandler()` is the seam a product build uses to serve MCP
 * over its OWN transport (e.g. a remote HTTPS server) while still reading
 * the SAME live ToolRegistry/resources/activity the loopback server uses —
 * no second, independent registry. Proven here by registering a tool
 * AFTER startMcp() returns, then driving a real MCP client/session through
 * an ephemeral http.Server whose sole handler is the factory's closure
 * (nothing from server.ts's own loopback listener is involved), and
 * asserting the tool shows up.
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

describe('McpServerHandle.createSessionHandler', () => {
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
    // loopback http.Server — proves the factory is usable standalone.
    const sessionHandler = handle.createSessionHandler();
    productServer = http.createServer((req, res) => {
      void sessionHandler(req, res);
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
