/**
 * @jest-environment node
 */
import http from 'http';

import { PORT_CANDIDATES } from '../../core/mcp/server';
import { createOutboundProxy } from '../outbound-proxy';

let server: http.Server;
let hits: Array<{ op: string }>;

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
    await startStub(PORT_CANDIDATES[1], 'ok'); // 7421 free → probe advances
    const proxy = createOutboundProxy();
    const r = (await proxy.draftReply({ documentId: 'x', body: 'b' })) as {
      draft_id: string;
    };
    expect(r.draft_id).toBe('d1');
    expect(hits.map((h) => h.op)).toEqual(['ping', 'draftReply']);
  });

  it('surfaces app-side errors verbatim', async () => {
    // Brief's verbatim test bound PORT_CANDIDATES[0] (7421). Deviation: this
    // dev machine has a real app already listening on 7421 (a long-running
    // sibling product's dev instance, unrelated to this checkout), so the
    // stub can't bind there — EADDRINUSE. The probe walks PORT_CANDIDATES in
    // order regardless of which index answers with the outbox pong (proven
    // by the test above, which already relies on the stub sitting at index
    // 1), so binding the stub at PORT_CANDIDATES[1] instead exercises the
    // exact same mechanism and keeps the assertion intact.
    await startStub(PORT_CANDIDATES[1], 'error');
    const proxy = createOutboundProxy();
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
    const proxy = createOutboundProxy();
    await expect(proxy.listOutbox({})).rejects.toThrow(/app is not running/i);
  });
});
