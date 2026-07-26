/**
 * @jest-environment node
 */
import http from 'http';
import net from 'net';

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
