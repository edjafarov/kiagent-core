/**
 * The outward MCP surface — Streamable HTTP on loopback, ported from
 * kiagent-ref's src/main/mcp/server.ts. Loopback bind is the ENTIRE auth
 * model (no bearer token): the legacy server's own comment says as much
 * (`bearerToken: null` → `authOk()` always passes), so this port keeps that
 * posture rather than inventing one.
 *
 * One `McpServer` + `StreamableHTTPServerTransport` per client session (the
 * SDK's documented pattern for stateful transports — see
 * createMcpRequestHandler in kiagent-ref), but all sessions read the SAME
 * `ToolRegistry` (registry.ts) at request time, so `registerTool()` reaches
 * already-connected clients immediately — no per-session bookkeeping needed.
 */
import { randomUUID } from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import type { McpActivityRecord, McpTool, Query } from '@shared/contracts';

import type { LogSink } from '../engine/engine';
import {
  applyConfigChange,
  buildClientRegistry,
  buildStdioLaunchDescriptor,
  type ClientAdapter,
} from './clients';
import { makeMcpServer } from './make-server';
import { attachToolHandlers, createToolRegistry } from './registry';
import { attachResourceHandlers } from './resources';
import { buildBuiltinTools } from './tools';

export interface McpDeps {
  query: Query;
  logSink: LogSink;
  dataDir: string;
  /** Receives one enriched activity record per tools/call served in-process
   *  (HTTP sessions — transport 'http' is stamped here). The stdio sibling
   *  produces its own records; see mcp/stdio-entry.ts. */
  onActivity?: (rec: McpActivityRecord) => void;
}

export interface McpServerHandle {
  readonly port: number | null;
  registerTool(tool: McpTool): () => void;
  clients(): Promise<Array<{ id: string; name: string; connected: boolean }>>;
  connectClient(id: string): Promise<void>;
  disconnectClient(id: string): Promise<void>;
  stop(): Promise<void>;
}

const HOST = '127.0.0.1';
const PORT_CANDIDATES = [7421, 7422, 7423, 7424, 7425];
const IDLE_TIMEOUT_MS = 45 * 60 * 1000; // evict a session idle past this
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

interface SessionEntry {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : null);
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function sendJsonRpcError(
  res: http.ServerResponse,
  status: number,
  message: string,
): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: status === 400 ? -32600 : -32603, message },
      id: null,
    }),
  );
}

/** Bind `server` to the first free port in `candidates`, retrying on the same
 *  instance after EADDRINUSE (never bound, so re-listening is safe). */
function listenOnFirstFree(
  server: http.Server,
  host: string,
  candidates: number[],
): Promise<number> {
  return new Promise((resolve, reject) => {
    let i = 0;
    const tryNext = () => {
      if (i >= candidates.length) {
        reject(
          new Error(
            `MCP server: all candidate ports in use (${candidates.join(', ')})`,
          ),
        );
        return;
      }
      const port = candidates[i];
      i += 1;
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener('listening', onListening);
        if (err.code === 'EADDRINUSE') {
          tryNext();
        } else {
          reject(err);
        }
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve(port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    };
    tryNext();
  });
}

export async function startMcp(deps: McpDeps): Promise<McpServerHandle> {
  const registry = createToolRegistry(buildBuiltinTools(deps.query));
  const dbPath = path.join(deps.dataDir, 'kiagent.db');

  const sessions = new Map<string, SessionEntry>();

  function makeSession(): {
    server: McpServer;
    transport: StreamableHTTPServerTransport;
  } {
    const server = makeMcpServer();
    attachToolHandlers(server, registry, deps.logSink, (rec) =>
      deps.onActivity?.({ ...rec, transport: 'http' }),
    );
    attachResourceHandlers(server, deps.query);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (sid) => {
        sessions.set(sid, { server, transport, lastActivity: Date.now() });
      },
    });
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) sessions.delete(sid);
    };
    return { server, transport };
  }

  const handler: http.RequestListener = async (req, res) => {
    try {
      if (req.url === '/healthz') {
        res.writeHead(200);
        res.end('ok');
        return;
      }

      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname !== '/mcp') {
        res.writeHead(404);
        res.end();
        return;
      }

      const sessionId =
        (req.headers['mcp-session-id'] as string | undefined) ?? undefined;
      if (sessionId && sessions.has(sessionId)) {
        const entry = sessions.get(sessionId)!;
        entry.lastActivity = Date.now();
        await entry.transport.handleRequest(req, res);
        return;
      }

      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        if (!isInitializeRequest(body)) {
          sendJsonRpcError(
            res,
            400,
            'Bad Request: missing mcp-session-id (and not an initialize request)',
          );
          return;
        }
        const { server, transport } = makeSession();
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }

      sendJsonRpcError(res, 400, 'Bad Request: missing mcp-session-id');
    } catch (err) {
      deps.logSink.log('mcp', 'error', 'request failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) {
        sendJsonRpcError(
          res,
          500,
          err instanceof Error ? err.message : 'internal error',
        );
      } else {
        try {
          res.end();
        } catch {
          /* socket likely already gone */
        }
      }
    }
  };

  const httpServer = http.createServer(handler);
  const port = await listenOnFirstFree(httpServer, HOST, PORT_CANDIDATES);
  deps.logSink.log('mcp', 'info', `listening on http://${HOST}:${port}/mcp`);

  const sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [sid, entry] of sessions) {
      if (now - entry.lastActivity < IDLE_TIMEOUT_MS) continue;
      void Promise.resolve(entry.transport.close()).catch(() => {});
      sessions.delete(sid);
    }
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  // Built once: the launch descriptor + client registry used by clients()/
  // connectClient()/disconnectClient(). `__dirname` resolves to wherever the
  // main bundle runs
  // from (webpack leaves it untouched — `node: { __dirname: false }` in both
  // main webpack configs), and the `mcpStdio` entry is emitted alongside it:
  // `dist/main/mcpStdio.js` in prod, `.erb/dll/mcpStdio.bundle.dev.js` in dev
  // (the dev config suffixes every entry with `.bundle.dev.js`).
  const stdioEntryScript = [
    path.join(__dirname, 'mcpStdio.js'),
    path.join(__dirname, 'mcpStdio.bundle.dev.js'),
  ].find((p) => fs.existsSync(p));
  const stdioEntry = buildStdioLaunchDescriptor({
    exePath: process.execPath,
    entryScriptPath: stdioEntryScript ?? path.join(__dirname, 'mcpStdio.js'),
    dbPath,
  });
  const clientAdapters: ClientAdapter[] = buildClientRegistry({
    localUrl: `http://${HOST}:${port}/mcp`,
    stdioEntry,
  });

  return {
    port,

    registerTool(tool: McpTool) {
      registry.set(tool.name, tool);
      return () => {
        registry.delete(tool.name);
      };
    },

    async clients(): Promise<
      Array<{ id: string; name: string; connected: boolean }>
    > {
      const results: Array<{
        id: string;
        name: string;
        connected: boolean;
      } | null> = clientAdapters.map((adapter) => {
        if (!fs.existsSync(adapter.detectPath)) return null;
        const text = fs.existsSync(adapter.configPath)
          ? fs.readFileSync(adapter.configPath, 'utf8')
          : null;
        return {
          id: adapter.id,
          name: adapter.label,
          connected: adapter.isConnected(text),
        };
      });
      return results.filter(
        (r): r is { id: string; name: string; connected: boolean } =>
          r !== null,
      );
    },

    async connectClient(id: string) {
      const adapter = clientAdapters.find((a) => a.id === id);
      if (!adapter) throw new Error(`connectClient: unknown client '${id}'`);
      // Never write a launch command pointing at a script that isn't on
      // disk — the client would crash with MODULE_NOT_FOUND on every start.
      if (adapter.transport === 'stdio' && !stdioEntryScript) {
        throw new Error(
          `connectClient(${id}): stdio entry script not found next to the main bundle (${__dirname}) — rebuild the app`,
        );
      }
      const result = applyConfigChange(adapter.configPath, (text) =>
        adapter.connect(text),
      );
      if (!result.ok) throw new Error(`connectClient(${id}): ${result.error}`);
      deps.logSink.log('mcp', 'info', `connected client ${id}`, {
        path: result.path,
        backup: result.backupPath,
      });
    },

    async disconnectClient(id: string) {
      const adapter = clientAdapters.find((a) => a.id === id);
      if (!adapter) throw new Error(`disconnectClient: unknown client '${id}'`);
      const result = applyConfigChange(adapter.configPath, (text) =>
        adapter.disconnect(text),
      );
      if (!result.ok)
        throw new Error(`disconnectClient(${id}): ${result.error}`);
      deps.logSink.log('mcp', 'info', `disconnected client ${id}`, {
        path: result.path,
        backup: result.backupPath,
      });
    },

    async stop() {
      clearInterval(sweepTimer);
      for (const { transport, server } of sessions.values()) {
        try {
          await transport.close();
        } catch {
          /* ignore */
        }
        try {
          await server.close();
        } catch {
          /* ignore */
        }
      }
      sessions.clear();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
        // Idle keep-alive sockets (from a client that never explicitly closed
        // its connection) would otherwise hold `close()` open indefinitely —
        // force them shut so teardown is prompt and the port is free right
        // after `stop()` resolves (important for tests that start a fresh
        // server per case on the same candidate ports).
        httpServer.closeAllConnections?.();
      });
    },
  };
}
