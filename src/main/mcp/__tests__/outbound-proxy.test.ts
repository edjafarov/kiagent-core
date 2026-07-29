/**
 * @jest-environment node
 */
import http from 'http';
import net from 'net';

import { OUTBOUND_TOOL_OPS } from '../../outbound/ops';
import { createOutboundRoutes } from '../../outbound/routes';
import type { OutboundService } from '../../outbound/service';
import { createOutboundProxy } from '../outbound-proxy';

let server: http.Server;
let hits: Array<{ op: string }>;

// Deliberately does NOT use the real PORT_CANDIDATES: those are shared with
// every other suite's `listenOnFirstFree` (server.test.ts, routes tests,
// etc.) — run in parallel jest workers, those race this test's fixed-port
// stub for the same handful of ports and produce EADDRINUSE flakes (and on
// a dev machine with the real app running, one of those candidates may
// already be squatted). An ephemeral port bound then released is dead by
// construction and not shared with any other suite.
function ephemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function startStub(port: number, behave: 'ok' | 'error'): Promise<void> {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const parsed = JSON.parse(body) as { op: string };
      hits.push(parsed);
      res.setHeader('content-type', 'application/json');
      if (parsed.op === 'ping') {
        res.end(
          JSON.stringify({ ok: true, result: { pong: 'kiagent-outbox' } }),
        );
      } else if (behave === 'ok') {
        res.end(JSON.stringify({ ok: true, result: { draft_id: 'd1' } }));
      } else {
        res.end(JSON.stringify({ ok: false, error: 'no sender for gmail' }));
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
}

afterEach(
  () => new Promise<void>((r) => (server ? server.close(() => r()) : r())),
);

beforeEach(() => {
  hits = [];
});

describe('outbound proxy', () => {
  it('probes candidates, then forwards ops to the discovered port', async () => {
    const deadPort = await ephemeralPort(); // freed, nothing listens here
    const stubPort = await ephemeralPort();
    await startStub(stubPort, 'ok'); // deadPort free → probe advances
    const proxy = createOutboundProxy(undefined, [deadPort, stubPort]);
    const r = (await proxy.draftReply({ documentId: 'x', body: 'b' })) as {
      draft_id: string;
    };
    expect(r.draft_id).toBe('d1');
    expect(hits.map((h) => h.op)).toEqual(['ping', 'draftReply']);
  });

  it('surfaces app-side errors verbatim', async () => {
    const stubPort = await ephemeralPort();
    await startStub(stubPort, 'error');
    const proxy = createOutboundProxy(undefined, [stubPort]);
    await expect(
      proxy.draftMessage({
        accountId: 'a',
        to: ['b@x.co'],
        subject: 's',
        body: 'b',
      }),
    ).rejects.toThrow('no sender for gmail');
  });

  it('explains when the app is not running', async () => {
    const deadPortA = await ephemeralPort();
    const deadPortB = await ephemeralPort();
    const proxy = createOutboundProxy(undefined, [deadPortA, deadPortB]);
    await expect(proxy.listOutbox({})).rejects.toThrow(/app is not running/i);
  });
});

/**
 * The stub above answers every op the same way, so it cannot catch the
 * failure this plane is actually prone to: an op one SIDE knows and the
 * other doesn't. These drive the proxy against the REAL `/outbox/api`
 * dispatcher (createOutboundRoutes) with only the service faked out.
 */
describe('outbound proxy ↔ the real /outbox/api dispatcher', () => {
  /** Every OutboundToolApi method, recording its args and echoing an
   *  identifiable result. Nothing else on OutboundService is reachable over
   *  this plane — reaching for one would throw rather than pass silently. */
  function fakeService() {
    const calls: Array<{ method: string; args: unknown }> = [];
    const record = (method: string) => async (args: unknown) => {
      calls.push({ method, args });
      return { echoed: method, args } as never;
    };
    const service = {
      draftReply: record('draftReply'),
      draftMessage: record('draftMessage'),
      listOutbox: record('listOutbox'),
      sendDraft: record('sendDraft'),
    } as unknown as OutboundService;
    return { calls, service };
  }

  async function startRoutes(service: OutboundService): Promise<number> {
    const routes = createOutboundRoutes(service);
    const port = await ephemeralPort();
    server = http.createServer((req, res) => {
      // The in-app server hands the routes a pre-parsed URL; the origin is
      // irrelevant to matching, only the pathname is read.
      void routes
        .handle(req, res, new URL(req.url ?? '/', 'http://127.0.0.1'))
        .then((handled) => {
          if (!handled) {
            res.writeHead(404);
            res.end();
          }
        });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve());
    });
    return port;
  }

  it('round-trips draftMessage: args reach the service and the result comes back', async () => {
    const { calls, service } = fakeService();
    const proxy = createOutboundProxy(undefined, [await startRoutes(service)]);
    const out = await proxy.draftMessage({
      accountId: 'acc1',
      to: ['a@x.co'],
      subject: 's',
      body: 'b',
    });
    expect(calls).toEqual([
      {
        method: 'draftMessage',
        args: { accountId: 'acc1', to: ['a@x.co'], subject: 's', body: 'b' },
      },
    ]);
    expect(out).toMatchObject({ echoed: 'draftMessage' });
  });

  it('round-trips listOutbox, and a payload-less call still arrives as {}', async () => {
    const { calls, service } = fakeService();
    const proxy = createOutboundProxy(undefined, [await startRoutes(service)]);
    await expect(proxy.listOutbox({ limit: 5 })).resolves.toMatchObject({
      echoed: 'listOutbox',
    });
    // listOutbox's payload is the one all-optional arg on the interface, and
    // JSON.stringify DROPS an undefined `args` — so the dispatcher's `?? {}`
    // is what stands between that call and a TypeError on the service side.
    await proxy.listOutbox(undefined as never);
    expect(calls.map((c) => c.args)).toEqual([{ limit: 5 }, {}]);
  });

  it('both sides agree on the op set — every OUTBOUND_TOOL_OPS entry dispatches, and the proxy uses no other', async () => {
    const { service } = fakeService();
    const port = await startRoutes(service);

    // Route side: no op in the shared list may be rejected as unknown.
    const rejected: string[] = [];
    for (const op of OUTBOUND_TOOL_OPS) {
      const res = await fetch(`http://127.0.0.1:${port}/outbox/api`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op, args: {} }),
      });
      const parsed = (await res.json()) as { ok: boolean; error?: string };
      if (!parsed.ok && /unknown op/.test(parsed.error ?? ''))
        rejected.push(op);
    }
    expect(rejected).toEqual([]);
    // ...and a genuinely unknown op still is.
    const bogus = await fetch(`http://127.0.0.1:${port}/outbox/api`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'nukeEverything' }),
    });
    expect(await bogus.json()).toEqual({
      ok: false,
      error: "unknown op 'nukeEverything'",
    });

    // Proxy side: the ops it actually puts on the wire (probe included) are
    // exactly the shared list — no extra, no stale spelling.
    const seen: string[] = [];
    const spy: typeof fetch = async (input, init) => {
      seen.push(JSON.parse(String(init?.body)).op);
      return fetch(input as string, init);
    };
    const proxy = createOutboundProxy(spy, [port]);
    await proxy.draftReply({ documentId: 'd', body: 'b' });
    await proxy.draftMessage({ accountId: 'a', to: [], subject: '', body: '' });
    await proxy.listOutbox({});
    await proxy.sendDraft({ draftId: 'd' });
    expect([...new Set(seen)].sort()).toEqual([...OUTBOUND_TOOL_OPS].sort());
  });
});
