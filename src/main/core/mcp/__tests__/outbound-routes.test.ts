/**
 * @jest-environment node
 */
import { EventEmitter } from 'events';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import type {
  AccountId,
  DocumentInput,
  OutboxRow,
  Prefs,
  Sender,
} from '@shared/contracts';

import { openDb } from '../../../db/app-db';
import { openStore, type CoreStore } from '../../store/store';
import {
  createOutboundService,
  type ConfirmOutcome,
  type OutboundService,
  type PeekResult,
} from '../../../outbound/service';
import { createOutboundRoutes } from '../../../outbound/routes';
import { startMcp, type McpServerHandle } from '../server';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};
const logSink = { log: () => {} };
const fakePrefs = {
  get: () => ({}),
  patch: async () => {},
  onChange: () => () => {},
} as unknown as Prefs;

let dir: string;
let store: CoreStore;
let accountId: AccountId;
let docId: string;
let service: OutboundService;
let mcp: McpServerHandle;
let sendMock: jest.Mock;
let base: string;

const IMAP_CFG = {
  host: 'imap.example.com',
  port: 993,
  secure: true,
  user: 'me@example.com',
};

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-outroutes-'));
  // startMcp wires createRawSqlTools(dbPath), which opens <dataDir>/kiagent.db
  // readonly and requires the file to already exist (see server.test.ts's
  // same fixture note) — name the real store's db file to match so the raw-
  // sql tools and the outbound store/service share the SAME on-disk db
  // rather than needing a second throwaway seed file.
  store = openStore(await openDb(path.join(dir, 'kiagent.db')), deps);
  const account = await store.createAccount({
    source: 'imap',
    identifier: 'me@example.com@imap.example.com',
    config: IMAP_CFG,
  });
  accountId = account.id;
  const doc: DocumentInput = {
    externalId: 'INBOX:1:1',
    type: 'email.message',
    title: 'Hello',
    markdown: 'hi',
    metadata: {
      from: 'Alice <alice@example.com>',
      to: ['me@example.com'],
      mailbox: 'INBOX',
      uid: 1,
      messageId: 'm1@x',
    },
    createdAt: '2026-07-01T00:00:00Z',
  };
  await store.commit({ account: accountId, documents: [doc], cursor: null });
  docId = (await store.read.search({ limit: 1 }))[0].id as string;

  sendMock = jest.fn(async () => ({ externalMessageId: '<sent@x>' }));
  service = createOutboundService({
    store,
    prefs: fakePrefs,
    senders: new Map([['imap', { send: sendMock } as Sender]]),
    logSink,
  });
  mcp = await startMcp({
    query: store.read,
    logSink,
    dataDir: dir,
    outbound: service,
    // Ephemeral (OS-assigned) port — this suite's subject is /outbox/*
    // routing, not the candidate walk, so avoid racing every other parallel
    // jest worker's startMcp() over the same fixed PORT_CANDIDATES list.
    portCandidates: [0],
  });
  base = `http://127.0.0.1:${mcp.port}`;
});

afterAll(async () => {
  await mcp.stop();
  await store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const draftUrl = async () => {
  const r = await service.draftReply({ documentId: docId, body: 'Yo' });
  return r.confirm_url;
};

describe('outbox confirm routes', () => {
  it('startMcp injected the base url into the service', async () => {
    expect(await draftUrl()).toContain(base);
  });

  it('GET renders the review page and does NOT send', async () => {
    const url = await draftUrl();
    const res = await fetch(url);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Alice');
    expect(html).toContain('Yo');
    expect(html).toContain('method="POST"');
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('escapes recipient/subject/body on the review page — a dropped esc() would leak raw <script> here', async () => {
    const evilDoc: DocumentInput = {
      externalId: 'INBOX:1:evil',
      type: 'email.message',
      title: '<script>alert(1)</script>',
      markdown: 'hi',
      metadata: {
        from: '"><img src=x> <eve@example.com>',
        to: ['me@example.com'],
        mailbox: 'INBOX',
        uid: 2,
        messageId: 'm2@x',
      },
      // Later than the fixture doc's createdAt so search({limit:1}) (ORDER
      // BY created_at DESC) deterministically returns THIS row.
      createdAt: '2026-07-02T00:00:00Z',
    };
    await store.commit({
      account: accountId,
      documents: [evilDoc],
      cursor: null,
    });
    const evilDocId = (await store.read.search({ limit: 1 }))[0].id as string;

    const r = await service.draftReply({
      documentId: evilDocId,
      body: '<script>alert(1)</script>',
    });
    const html = await (await fetch(r.confirm_url)).text();

    // Escaped forms present...
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&quot;&gt;&lt;img src=x&gt;');
    // ...and the raw, unescaped payloads absent — this is the property the
    // whole confirm surface's XSS safety rests on.
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('"><img src=x>');
  });

  it('POST confirm sends exactly once; the link then dies', async () => {
    const url = await draftUrl();
    const res = await fetch(url, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/sent/i);
    expect(sendMock).toHaveBeenCalledTimes(1);
    sendMock.mockClear();
    const again = await fetch(url, { method: 'POST' });
    expect(await again.text()).toMatch(/already/i);
    expect(sendMock).not.toHaveBeenCalled();
    const getAfter = await fetch(url);
    expect(await getAfter.text()).toMatch(/already|sent/i);
  });

  it('POST cancel discards without sending', async () => {
    const url = await draftUrl();
    const cancel = url.replace('/outbox/confirm/', '/outbox/cancel/');
    const res = await fetch(cancel, { method: 'POST' });
    expect(await res.text()).toMatch(/cancel/i);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('link mode serves the minimal page', async () => {
    await store.setAccountConfig(accountId, {
      ...IMAP_CFG,
      outbound: { mode: 'link' },
    });
    const url = await draftUrl();
    const html = await (await fetch(url)).text();
    expect(html).toContain('Alice');
    expect(html).not.toContain('Yo'); // minimal page: recipient + button only
    expect(html).toContain('method="POST"');
    await store.setAccountConfig(accountId, IMAP_CFG);
  });

  it('a bad token 404s', async () => {
    const res = await fetch(`${base}/outbox/confirm/garbage`);
    expect(res.status).toBe(404);
  });

  it('/outbox/api answers ping', async () => {
    const res = await fetch(`${base}/outbox/api`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'ping' }),
    });
    expect(await res.json()).toEqual({
      ok: true,
      result: { pong: 'kiagent-outbox' },
    });
  });

  it('/outbox/api proxies draftReply', async () => {
    const res = await fetch(`${base}/outbox/api`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        op: 'draftReply',
        args: { documentId: docId, body: 'via api' },
      }),
    });
    const body = (await res.json()) as {
      ok: boolean;
      result: { confirm_url: string };
    };
    expect(body.ok).toBe(true);
    expect(body.result.confirm_url).toContain('/outbox/confirm/');
  });

  // fakeRes() in the unit-level suite below discards writeHead's header
  // arg entirely — only a real fetch over real HTTP catches a header
  // regression, so this pins the actual wire response.
  it('pins response headers: no-store HTML pages, nosniff JSON', async () => {
    const url = await draftUrl();
    const page = await fetch(url);
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');

    const api = await fetch(`${base}/outbox/api`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'ping' }),
    });
    expect(api.headers.get('content-type')).toContain('application/json');
    expect(api.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

// Confirms the ALS transport tag server.ts wires through createMcpHandler()
// actually reaches the outbound service — not just by reading the code, but
// by driving a real tools/call for draft_reply over BOTH transports sharing
// the SAME live registry/service instance. This is the property that makes
// confirmByToken/cancelByToken skipping assertReady() safe: a remote session
// must be refused before it ever mints a 127.0.0.1 link.
describe('createMcpHandler() tags every call transport=remote', () => {
  let productServer: http.Server;
  let productUrl: URL;
  const clients: Client[] = [];

  beforeAll(async () => {
    const mcpHandler = mcp.createMcpHandler();
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
  });

  async function connect(url: URL): Promise<Client> {
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(url));
    clients.push(client);
    return client;
  }

  it('a draft_reply over the product/remote handler is refused local-only', async () => {
    const client = await connect(productUrl);
    const result = await client.callTool({
      name: 'draft_reply',
      arguments: { document_id: docId, body: 'from remote' },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? '';
    expect(text).toMatch(/local-only|running kiagent/i);
  });

  it('the SAME draft_reply over loopback (local) succeeds', async () => {
    const client = await connect(new URL(`${base}/mcp`));
    const result = await client.callTool({
      name: 'draft_reply',
      arguments: { document_id: docId, body: 'from loopback' },
    });
    expect(result.isError).toBeFalsy();
  });
});

// Unit-level: drive createOutboundRoutes directly against a fake
// OutboundService (no real store/HTTP server) so the honest-error and
// terminal-status rendering can be pinned down for cases the integration
// suite above can't easily force (an unexpected throw from confirmByToken;
// every OutboxStatus the 'gone'/'already' branches must cover).
function baseRow(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: 'draft-1',
    accountId: 'acc-1' as AccountId,
    kind: 'new',
    replyToDocumentId: null,
    outboundRef: null,
    recipientDisplay: 'Bob <bob@example.com>',
    to: ['bob@example.com'],
    cc: [],
    subject: 'Hi',
    bodyMarkdown: 'body',
    threading: null,
    confirmMode: 'review',
    status: 'draft',
    error: null,
    externalMessageId: null,
    createdVia: 'mcp-local',
    createdAt: '2026-07-01T00:00:00Z',
    sentAt: null,
    expiresAt: '2026-07-02T00:00:00Z',
    ...overrides,
  };
}

function fakeReq(method: string): http.IncomingMessage {
  return { method } as unknown as http.IncomingMessage;
}

// A streaming POST req for readJsonBody (routes.ts): a real EventEmitter so
// 'data'/'end'/'error' listeners behave like the genuine IncomingMessage
// they attach to, but with no real socket underneath — driving this at the
// unit level (rather than over a live loopback fetch()) tests the exact
// same size-cap code path without adding another real TCP server+client to
// an already server-heavy suite; a same-process HTTP req that gets
// genuinely destroy()'d (as the 64 KB cap does) proved to make the ambient
// jest run flaky (macOS ephemeral-port/TIME_WAIT churn across the many
// http.Server instances this file and its siblings spin up), independent of
// whether the destroy() call itself was correct.
function fakeStreamingPostReq(): http.IncomingMessage & {
  destroy: jest.Mock;
} {
  const req = new EventEmitter() as unknown as http.IncomingMessage & {
    method: string;
    destroy: jest.Mock;
  };
  req.method = 'POST';
  req.destroy = jest.fn();
  return req;
}

function fakeRes(): {
  res: http.ServerResponse;
  status(): number;
  body(): string;
} {
  let status = 0;
  let chunks = '';
  const res = {
    writeHead(code: number) {
      status = code;
      return res;
    },
    end(chunk?: string) {
      if (chunk) chunks += chunk;
    },
  } as unknown as http.ServerResponse;
  return { res, status: () => status, body: () => chunks };
}

function fakeService(overrides: Partial<OutboundService>): OutboundService {
  const notImplemented = async (): Promise<never> => {
    throw new Error('not implemented in this fake');
  };
  return {
    draftReply: notImplemented,
    draftMessage: notImplemented,
    listOutbox: notImplemented,
    peekByToken: notImplemented,
    confirmByToken: notImplemented,
    cancelByToken: notImplemented,
    setBaseUrl: () => {},
    ...overrides,
  } as OutboundService;
}

describe('outbox routes — honest errors and terminal statuses (unit, fake service)', () => {
  it('an unexpected throw from confirmByToken renders unknown-state, never "failed"', async () => {
    const routes = createOutboundRoutes(
      fakeService({
        confirmByToken: async () => {
          throw new Error('bookkeeping exploded after sender.send() resolved');
        },
      }),
    );
    const { res, status, body } = fakeRes();
    const handled = await routes.handle(
      fakeReq('POST'),
      res,
      new URL('http://x/outbox/confirm/tok'),
    );
    expect(handled).toBe(true);
    expect(status()).toBe(500);
    expect(body()).not.toMatch(/failed to send|send failed/i);
    expect(body()).toMatch(/sent folder|may have|unknown/i);
  });

  it('an unexpected throw from cancelByToken renders unknown-state, never claims cancellation', async () => {
    const routes = createOutboundRoutes(
      fakeService({
        cancelByToken: async () => {
          throw new Error('db closed mid-transition');
        },
      }),
    );
    const { res, status, body } = fakeRes();
    await routes.handle(
      fakeReq('POST'),
      res,
      new URL('http://x/outbox/cancel/tok'),
    );
    expect(status()).toBe(500);
    // "This draft was cancelled" is the honest-success copy for a CLEAN
    // cancelByToken outcome (see the 'cancelled' branch below) — a throw
    // must never render that same confident claim.
    expect(body()).not.toMatch(/this draft was cancelled/i);
    expect(body()).toMatch(/status unknown|something went wrong/i);
  });

  it('an unexpected throw from peekByToken (GET) renders a 500, not a crash', async () => {
    const routes = createOutboundRoutes(
      fakeService({
        peekByToken: async () => {
          throw new Error('store unavailable');
        },
      }),
    );
    const { res, status } = fakeRes();
    const handled = await routes.handle(
      fakeReq('GET'),
      res,
      new URL('http://x/outbox/confirm/tok'),
    );
    expect(handled).toBe(true);
    expect(status()).toBe(500);
  });

  const goneCases: Array<{ status: OutboxRow['status']; expect: RegExp }> = [
    { status: 'sent', expect: /already sent/i },
    { status: 'discarded', expect: /cancel/i },
    { status: 'failed', expect: /send failed/i },
    { status: 'delivery_unknown', expect: /sent folder/i },
    { status: 'expired', expect: /expired/i },
  ];

  for (const c of goneCases) {
    it(`peekByToken 'gone' with row.status=${c.status} renders the matching terminal page`, async () => {
      const routes = createOutboundRoutes(
        fakeService({
          peekByToken: async (): Promise<PeekResult> => ({
            kind: 'gone',
            row: baseRow({ status: c.status, error: 'boom' }),
          }),
        }),
      );
      const { res, status, body } = fakeRes();
      await routes.handle(
        fakeReq('GET'),
        res,
        new URL('http://x/outbox/confirm/tok'),
      );
      expect(status()).toBe(200);
      expect(body()).toMatch(c.expect);
    });
  }

  it("confirmByToken 'already' (a raced/reused link) renders the same terminal page as 'gone'", async () => {
    const routes = createOutboundRoutes(
      fakeService({
        confirmByToken: async (): Promise<ConfirmOutcome> => ({
          kind: 'already',
          row: baseRow({ status: 'sent' }),
        }),
      }),
    );
    const { res, status, body } = fakeRes();
    await routes.handle(
      fakeReq('POST'),
      res,
      new URL('http://x/outbox/confirm/tok'),
    );
    expect(status()).toBe(200);
    expect(body()).toMatch(/already sent/i);
  });

  it('a failed row cannot get a fresh link — the failed page never renders a confirm form', async () => {
    const routes = createOutboundRoutes(
      fakeService({
        peekByToken: async (): Promise<PeekResult> => ({
          kind: 'gone',
          row: baseRow({ status: 'failed', error: 'SMTP auth rejected' }),
        }),
      }),
    );
    const { res, body } = fakeRes();
    await routes.handle(
      fakeReq('GET'),
      res,
      new URL('http://x/outbox/confirm/tok'),
    );
    expect(body()).toContain('SMTP auth rejected');
    expect(body()).not.toContain('method="POST"');
  });

  it('/outbox/api caps the buffered body at 64 KB — an oversized POST gets a clean 413, never unbounded buffering or a hang', async () => {
    const routes = createOutboundRoutes(fakeService({}));
    const req = fakeStreamingPostReq();
    const { res, status, body } = fakeRes();
    const handled = routes.handle(req, res, new URL('http://x/outbox/api'));
    // Two 40 KB chunks comfortably clear the 64 KB cap in routes.ts.
    req.emit('data', Buffer.alloc(40 * 1024, 'a'));
    req.emit('data', Buffer.alloc(40 * 1024, 'a'));
    expect(await handled).toBe(true);
    expect(status()).toBe(413);
    const parsed = JSON.parse(body()) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/exceeds/i);
    // The connection is only destroyed AFTER the 413 was written (never
    // before — that would race the response itself) — and it IS destroyed,
    // so an oversized/never-ending client can't hold the request open
    // forever once it's over cap.
    expect(req.destroy).toHaveBeenCalledTimes(1);
  });
});
