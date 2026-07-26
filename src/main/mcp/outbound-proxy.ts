/**
 * Outbound backend for the stdio sibling process (spec §4): the sibling has
 * a read-only corpus connection and no senders/secret, so draft ops are
 * forwarded to the RUNNING app's loopback server (/outbox/api). If the app
 * isn't running the tools explain that instead of failing mysteriously —
 * draft creation fundamentally needs the app (confirm pages + senders live
 * there).
 */
import { PORT_CANDIDATES } from '../core/mcp/server';
import type { OutboundToolApi } from '../outbound/service';

type ApiResponse = { ok: true; result: unknown } | { ok: false; error: string };

export function createOutboundProxy(
  fetchFn: typeof fetch = fetch,
  ports: readonly number[] = PORT_CANDIDATES,
): OutboundToolApi {
  let cachedPort: number | null = null;

  const post = async (port: number, body: unknown): Promise<ApiResponse> => {
    const res = await fetchFn(`http://127.0.0.1:${port}/outbox/api`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    return (await res.json()) as ApiResponse;
  };

  const probe = async (): Promise<number> => {
    for (const port of ports) {
      try {
        const res = await fetchFn(`http://127.0.0.1:${port}/outbox/api`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ op: 'ping' }),
          signal: AbortSignal.timeout(1000),
        });
        const parsed = (await res.json()) as ApiResponse;
        if (
          parsed.ok &&
          (parsed.result as { pong?: string })?.pong === 'kiagent-outbox'
        ) {
          return port;
        }
      } catch {
        /* next candidate */
      }
    }
    throw new Error(
      'The KIAgent app is not running — outbound drafting needs the app ' +
        'open. Start KIAgent and try again.',
    );
  };

  const call = async (op: string, args: unknown): Promise<unknown> => {
    if (cachedPort === null) cachedPort = await probe();
    let response: ApiResponse;
    try {
      response = await post(cachedPort, { op, args });
    } catch {
      // The app may have restarted onto another candidate port — once.
      cachedPort = await probe();
      response = await post(cachedPort, { op, args });
    }
    if (!response.ok) throw new Error(response.error);
    return response.result;
  };

  return {
    draftReply: (a) => call('draftReply', a) as never,
    draftMessage: (a) => call('draftMessage', a) as never,
    listOutbox: (a) => call('listOutbox', a) as never,
  };
}
