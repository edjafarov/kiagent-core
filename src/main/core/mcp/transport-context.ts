/**
 * Which MCP transport is handling the current call — an AsyncLocalStorage
 * seam so any code deep in the call stack (the outbound service, in
 * particular) can refuse remote callers without threading a flag through
 * every function signature. `server.ts` (Task 8) tags loopback vs remote
 * connections at the point they attach; local/stdio paths never call
 * `runWithTransport` at all, which is why `currentTransport()` defaults to
 * 'local' rather than throwing on an empty store.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export type McpTransport = 'local' | 'remote';

const als = new AsyncLocalStorage<McpTransport>();

export function runWithTransport<T>(
  t: McpTransport,
  fn: () => Promise<T>,
): Promise<T> {
  return als.run(t, fn);
}

/** 'local' when unset — loopback/stdio paths never tag themselves. */
export function currentTransport(): McpTransport {
  return als.getStore() ?? 'local';
}

// The calling MCP client's self-reported name (`clientInfo.name`), for
// records that say which app did something (the outbox's "Drafted by").
// Set by the tool handler on EVERY transport, stdio included.
const clientAls = new AsyncLocalStorage<string | null>();

export function runWithClient<T>(
  name: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  return clientAls.run(name, fn);
}

/** Null outside a tool call, or when the client never named itself. */
export function currentClient(): string | null {
  return clientAls.getStore() ?? null;
}
