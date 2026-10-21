/**
 * Outbound backend for the stdio sibling process (spec §4): the sibling has
 * a read-only corpus connection and no senders/secret, so draft ops are
 * forwarded to the RUNNING app's loopback server (/outbox/api). If the app
 * isn't running the tools explain that instead of failing mysteriously —
 * draft creation fundamentally needs the app (confirm pages + senders live
 * there).
 */
import { withLogMessage } from '../core/mcp/log-safe';
import { PORT_CANDIDATES } from '../core/mcp/server';
import type { OutboundToolOp } from '../outbound/ops';
import type { CalendarToolApi } from '../calendar-out/service';
import type { OutboundToolApi } from '../outbound/service';

type ApiResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: string; logMessage?: string };

/** An op may wait on Gmail/Outlook (a send's deadline is 60 s). */
const OP_TIMEOUT_MS = 90_000;

// A DOMException, not always an Error in this realm: match by name.
const timedOut = (e: unknown) =>
  ['TimeoutError', 'AbortError'].includes((e as { name?: string })?.name ?? '');

export function createOutboundProxy(
  fetchFn: typeof fetch = fetch,
  ports: readonly number[] = PORT_CANDIDATES,
  opTimeoutMs = OP_TIMEOUT_MS,
): OutboundToolApi & CalendarToolApi {
  let cachedPort: number | null = null;

  const post = async (port: number, body: unknown): Promise<ApiResponse> => {
    const res = await fetchFn(`http://127.0.0.1:${port}/outbox/api`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opTimeoutMs),
    });
    return (await res.json()) as ApiResponse;
  };

  const probe = async (): Promise<number> => {
    for (const port of ports) {
      try {
        const res = await fetchFn(`http://127.0.0.1:${port}/outbox/api`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ op: 'ping' satisfies OutboundToolOp }),
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

  // `op: OutboundToolOp` (not `string`) is what keeps this client's
  // forwards below spelled the way the route dispatcher reads them — the
  // shared list in ops.ts is the referee for both.
  const call = async (op: OutboundToolOp, args: unknown): Promise<unknown> => {
    if (cachedPort === null) cachedPort = await probe();
    let response: ApiResponse;
    try {
      response = await post(cachedPort, { op, args });
    } catch (e) {
      // The app got the request and is still working on it: sending it
      // again could create a second draft or reschedule a batch.
      if (timedOut(e))
        throw new Error(
          'KIAgent did not answer in time; the action may still complete — ' +
            'call list_outbox to see where it stands before trying again.',
        );
      // The app may have restarted onto another candidate port — once.
      cachedPort = await probe();
      response = await post(cachedPort, { op, args });
    }
    if (!response.ok) {
      const err = new Error(response.error);
      throw response.logMessage
        ? withLogMessage(err, response.logMessage)
        : err;
    }
    return response.result;
  };

  return {
    draftReply: (a) => call('draftReply', a) as never,
    draftMessage: (a) => call('draftMessage', a) as never,
    listOutbox: (a) => call('listOutbox', a) as never,
    sendDraft: (a) => call('sendDraft', a) as never,
    reviseDraft: (a) => call('reviseDraft', a) as never,
    scheduleDrafts: (a) => call('scheduleDrafts', a) as never,
    listCalendars: (a) => call('listCalendars', a) as never,
    findFreeTime: (a) => call('findFreeTime', a) as never,
    draftEvent: (a) => call('draftEvent', a) as never,
  };
}
