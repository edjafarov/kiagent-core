/**
 * Entry point for the MCP stdio transport: a sibling process MCP clients
 * spawn directly (Claude Desktop config style, `ELECTRON_RUN_AS_NODE=1 <exe>
 * mcpStdio.js --db <path>` — see core/mcp/clients.ts's
 * buildStdioLaunchDescriptor, which is what writes that command line into a
 * client's config). Mirrors kiagent-ref's src/main/mcp/stdio-entry.ts: it
 * NEVER enters main.ts — no window, no single-instance lock — and shares the
 * exact same tool registry/dispatch as the HTTP transport
 * (core/mcp/registry.ts) so tools cannot drift between the two.
 *
 * Reads the corpus via `openStore` opened on the same `<userData>/data/
 * kiagent.db` the running app writes to; only `store.read` (the `Query`
 * surface) is ever touched here — this process never commits.
 * Every served call is also appended (transport 'stdio') to
 * `<dataDir>/mcp-activity.jsonl` via core/mcp/activity.ts — the app's
 * activity feed and onboarding first-query latch read it at next boot.
 */
import path from 'path';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import type { LogLevel } from '@shared/contracts';

import { createActivityLog } from '../core/mcp/activity';
import { makeMcpServer } from '../core/mcp/make-server';
import { attachToolHandlers, createToolRegistry } from '../core/mcp/registry';
import { attachResourceHandlers } from '../core/mcp/resources';
import { buildBuiltinTools } from '../core/mcp/tools';
import { openCorpusReadConnection } from '../db/app-db';
import { openStore, type CoreStore } from '../core/store/store';

function parseDbArg(argv: string[]): string | null {
  const i = argv.indexOf('--db');
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  return null;
}

/**
 * Under stdio, stdout IS the JSON-RPC channel. Reroute anything that might
 * write there (console.log/info/debug) to stderr — console.error is already
 * stderr and is left alone. MUST run before anything else can log.
 */
function redirectConsoleToStderr(): void {
  // eslint-disable-next-line no-console
  const stderrWrite = console.error.bind(console);
  // eslint-disable-next-line no-console
  console.log = (...args: unknown[]) => stderrWrite(...args);
  // eslint-disable-next-line no-console
  console.info = (...args: unknown[]) => stderrWrite(...args);
  // eslint-disable-next-line no-console
  console.debug = (...args: unknown[]) => stderrWrite(...args);
}

/**
 * The MCP call audit rides the app's one `LogSink` everywhere else
 * (registry.ts's `attachToolHandlers` calls `logSink.log('mcp.call', …)`).
 * This standalone process has no shared sink to ride — it writes the same
 * JSON-lines shape straight to stderr instead (stdout stays pure JSON-RPC).
 */
function stderrLogSink(): {
  log(
    scope: string,
    level: LogLevel,
    msg: string,
    fields?: Record<string, unknown>,
  ): void;
} {
  return {
    log(scope, level, msg, fields) {
      process.stderr.write(
        `${JSON.stringify({ ts: new Date().toISOString(), level, scope, msg, fields })}\n`,
      );
    },
  };
}

async function main(): Promise<void> {
  redirectConsoleToStderr();

  const dbPath = parseDbArg(process.argv.slice(2));
  if (!dbPath) {
    process.stderr.write('[mcp-stdio] missing required --db <path>\n');
    process.exit(2);
    return;
  }

  let store: CoreStore;
  try {
    // Read-only sibling: openCorpusReadConnection gives an in-process AppDb
    // (with `_conn`), so the store builds a writeTx that this process never
    // invokes — only `store.read` is ever touched here.
    store = openStore(await openCorpusReadConnection(dbPath), {
      // Vault is unreachable from the Query surface this process serves —
      // any codec typechecks; these never actually run.
      encrypt: (s: string) => Buffer.from(s, 'utf8'),
      decrypt: (b: Buffer) => b.toString('utf8'),
      detectLanguages: () => [],
    });
  } catch (err) {
    process.stderr.write(
      `[mcp-stdio] failed to open corpus: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
    return;
  }

  // The activity feed rides the same directory as the db — main tails it.
  // Append failures are swallowed inside createActivityLog: an unwritable
  // feed must never break serving a call.
  const activity = createActivityLog(path.dirname(dbPath));

  const logSink = stderrLogSink();
  const registry = createToolRegistry(buildBuiltinTools(store.read));
  const server = makeMcpServer();
  attachToolHandlers(server, registry, logSink, (rec) =>
    activity.append({ ...rec, transport: 'stdio' }),
  );
  attachResourceHandlers(server, store.read);

  const transport = new StdioServerTransport();
  let shuttingDown = false;
  const shutdown = async (code: number): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await server.close();
    } catch {
      /* ignore */
    }
    try {
      await store.close();
    } finally {
      process.exit(code);
    }
  };

  // stdin EOF (client disconnected) → transport closes → exit cleanly.
  transport.onclose = () => {
    void shutdown(0);
  };
  process.on('SIGTERM', () => void shutdown(0));
  process.on('SIGINT', () => void shutdown(0));

  await server.connect(transport);
  process.stderr.write('[mcp-stdio] ready\n');
}

main().catch((err) => {
  process.stderr.write(
    `[mcp-stdio] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
