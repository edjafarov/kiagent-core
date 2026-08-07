import fs from 'fs';
import os from 'os';
import path from 'path';

import type { DocumentInput, Prefs, Sender } from '@shared/contracts';
import type { Invokes } from '@shared/ipc';

import { openDb } from '../../db/app-db';
import { openStore, type CoreStore } from '../../core/store/store';
import { outboundInvokeHandlers } from '../ipc';
import { createOutboundService, type OutboundService } from '../service';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};

const logSink = { log: () => {} };

function fakePrefs(): Prefs {
  const p = {} as unknown as ReturnType<Prefs['get']>;
  return { get: () => p, patch: async () => {}, onChange: () => () => {} };
}

const emailDoc = (): DocumentInput => ({
  externalId: 'INBOX:1:100',
  type: 'email.message',
  title: 'Numbers',
  markdown: 'body',
  metadata: {
    from: 'Alice <alice@example.com>',
    to: ['me@example.com'],
    date: '2026-07-01T00:00:00Z',
    mailbox: 'INBOX',
    uid: 100,
    messageId: 'orig@x',
  },
  createdAt: '2026-07-01T00:00:00Z',
});

const IMAP_CFG = {
  host: 'imap.example.com',
  port: 993,
  secure: true,
  user: 'me@example.com',
};

type Handler = (req: unknown) => Promise<unknown> | unknown;

describe('outbound ipc delegate', () => {
  let dir: string;
  let store: CoreStore;
  let service: OutboundService;
  let docId: string;
  let sendMock: jest.Mock;
  let handlers: Map<string, Handler>;
  let opened: string[];

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-outipc-'));
    store = openStore(await openDb(path.join(dir, 'test.db')), deps);
    const account = await store.createAccount({
      source: 'imap',
      identifier: 'me@example.com@imap.example.com',
      config: IMAP_CFG,
    });
    await store.commit({
      account: account.id,
      documents: [emailDoc()],
      cursor: null,
    });
    const hits = await store.read.search({ limit: 10 });
    docId = hits[0].id as string;

    sendMock = jest.fn(async () => ({ externalMessageId: '<sent@x>' }));
    service = createOutboundService({
      store,
      prefs: fakePrefs(),
      senders: new Map<string, Sender>([['imap', { send: sendMock }]]),
      logSink,
    });
    service.setBaseUrl('http://127.0.0.1:7421');

    opened = [];
    handlers = new Map(
      Object.entries(
        outboundInvokeHandlers({
          service,
          store,
          openExternal: async (url) => {
            opened.push(url);
          },
        }),
      ) as Array<[string, Handler]>,
    );
  });

  afterEach(async () => {
    // The brief's harness omits this; service.test.ts:100-104 (its stated
    // source) has it. `openDb` is the worker-thread AppDb — leaking one
    // worker per test is a jest "failed to exit gracefully" warning.
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const invoke = <C extends keyof Invokes>(c: C, req: Invokes[C]['req']) =>
    handlers.get(c)!(req) as Promise<Invokes[C]['res']>;

  const tokenOf = (r: { confirm_url?: string }) =>
    r.confirm_url!.split('/outbox/confirm/')[1];

  it('registers the four outbox channels', () => {
    expect([...handlers.keys()].sort()).toEqual([
      'outbox:discard',
      'outbox:list',
      'outbox:open-confirm',
      'outbox:redraft',
    ]);
  });

  it('outbox:list maps rows to the panel shape', async () => {
    await service.draftReply({
      documentId: docId,
      body: 'A long body \n with newlines '.repeat(30),
    });
    const rows = await invoke('outbox:list', {});
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('draft');
    expect(rows[0].kind).toBe('reply');
    expect(rows[0].accountLabel).toBe('me@example.com@imap.example.com');
    expect(rows[0].bodyPreview.length).toBeLessThanOrEqual(140);
    expect(rows[0].bodyPreview).not.toMatch(/\n/);
    // A pending row carries no error projection at all.
    expect(rows[0].error).toBeNull();
    expect(rows[0].errorDetail).toBeNull();
    expect(rows[0].canRetry).toBe(false);
    expect(rows[0].deliveryUncertain).toBe(false);
  });

  it('outbox:list clamps the limit (a negative LIMIT is UNBOUNDED in SQLite)', async () => {
    await service.draftReply({ documentId: docId, body: 'a' });
    await service.draftReply({ documentId: docId, body: 'b' });
    expect(await invoke('outbox:list', { limit: -1 })).toHaveLength(1);
    expect(await invoke('outbox:list', { limit: 9999 })).toHaveLength(2);
  });

  it('outbox:list survives a payload-less invoke and a NaN limit', async () => {
    // `{ limit?: number }` is the only all-optional req in `Invokes`, and the
    // contextBridge erases types — `window.kiagent.invoke('outbox:list')`
    // reaches the handler as `undefined`. Destructuring in the parameter list
    // would TypeError on the panel's primary read.
    await service.draftReply({ documentId: docId, body: 'a' });
    expect(await handlers.get('outbox:list')!(undefined)).toHaveLength(1);
    // Number.isFinite guard: NaN/Infinity fall back to 50, they do not
    // poison Math.floor/min/max into a NaN LIMIT.
    expect(await invoke('outbox:list', { limit: NaN })).toHaveLength(1);
    expect(await invoke('outbox:list', { limit: Infinity })).toHaveLength(1);
  });

  it('outbox:list sweeps overdue drafts before reading (no stale "draft" row)', async () => {
    // Without `expireOverdue()` first, the panel shows a 'draft' row whose
    // "Review & send" then dies with a status error. `create()` runs its own
    // sweep BEFORE its insert, so a past expiresAt survives creation — which
    // is exactly what makes this row a faithful stale-draft fixture.
    const account = (await store.read.accounts())[0];
    await store.outbox.create({
      accountId: account.id,
      kind: 'new',
      recipientDisplay: 'bob@example.com',
      to: ['bob@example.com'],
      cc: [],
      subject: 'stale',
      bodyMarkdown: 'body',
      confirmMode: 'review',
      createdVia: 'mcp-local',
      expiresAt: '2020-01-01T00:00:00Z',
    });

    const [row] = await invoke('outbox:list', {});
    expect(row.status).toBe('expired'); // 'draft' if the sweep is dropped
  });

  it('outbox:list shapes failed rows and marks ambiguity', async () => {
    sendMock.mockRejectedValueOnce(new Error('socket hang up'));
    const r = await service.draftReply({ documentId: docId, body: 'x' });
    await service.confirmByToken(tokenOf(r));

    const [row] = await invoke('outbox:list', {});
    expect(row.status).toBe('failed');
    expect(row.canRetry).toBe(false);
    expect(row.deliveryUncertain).toBe(true);
    // Human sentence up front, technical one-liner behind <details>.
    expect(row.error).toMatch(/could not confirm delivery/i);
    expect(row.errorDetail).toContain('socket hang up');
    expect(row.error).not.toBe(row.errorDetail);
  });

  it('outbox:list marks a provably-not-sent failure retryable', async () => {
    sendMock.mockRejectedValueOnce(
      new Error('smtp transient 421: mailbox busy'),
    );
    const r = await service.draftReply({ documentId: docId, body: 'x' });
    await service.confirmByToken(tokenOf(r));

    const [row] = await invoke('outbox:list', {});
    expect(row.canRetry).toBe(true);
    expect(row.deliveryUncertain).toBe(false);
  });

  it('outbox:list does not mark an unsupported-class failure uncertain', async () => {
    // THE posture gate. Both other failure fixtures agree under either rule,
    // so `deliveryUncertain = shaped.kind === 'unknown'` and the tempting
    // `!shaped.canRetry` are indistinguishable without this case: an
    // unsupported-source failure is canRetry:false but PROVABLY not sent, so
    // it keeps its one-click "Draft again". `!canRetry` would hide it.
    sendMock.mockRejectedValueOnce(
      new Error(
        `sending from 'x' accounts is not supported yet — supported: imap`,
      ),
    );
    const r = await service.draftReply({ documentId: docId, body: 'x' });
    await service.confirmByToken(tokenOf(r));

    const [row] = await invoke('outbox:list', {});
    expect(row.status).toBe('failed');
    expect(row.canRetry).toBe(false);
    expect(row.deliveryUncertain).toBe(false);
  });

  it('outbox:list passes a delivery_unknown sentence through verbatim', async () => {
    const r = await service.draftReply({ documentId: docId, body: 'x' });
    const sentence =
      'the app closed while sending — the message may have been sent; ' +
      'check the Sent folder before re-drafting';
    await store.outbox.transition(r.draft_id, ['draft'], 'delivery_unknown', {
      error: sentence,
    });

    const [row] = await invoke('outbox:list', {});
    expect(row.status).toBe('delivery_unknown');
    // Re-shaping would wrap this perfectly good sentence in `send failed: `.
    expect(row.error).toBe(sentence);
    expect(row.errorDetail).toBeNull();
    expect(row.canRetry).toBe(false);
    expect(row.deliveryUncertain).toBe(true);
  });

  it('outbox:list never shows a stale error on a retried row', async () => {
    // The regression this gate exists for: `transition` only ever SETs patch
    // fields (outbox.ts:42-48), so a failed→sent row keeps its old error
    // string in the DB by design. Reading it ungated paints red text on a
    // green row.
    sendMock.mockRejectedValueOnce(
      new Error('smtp transient 421: mailbox busy'),
    );
    const r = await service.draftReply({ documentId: docId, body: 'x' });
    await service.confirmByToken(tokenOf(r));
    expect((await invoke('outbox:list', {}))[0].canRetry).toBe(true);

    // Try again: re-confirm the SAME row via a freshly minted panel URL.
    const retryUrl = await service.confirmUrlFor(r.draft_id);
    const outcome = await service.confirmByToken(
      retryUrl!.split('/outbox/confirm/')[1],
    );
    expect(outcome.kind).toBe('sent');

    const [row] = await invoke('outbox:list', {});
    expect(row.status).toBe('sent');
    expect(row.error).toBeNull();
    expect(row.errorDetail).toBeNull();
    expect(row.canRetry).toBe(false);
    expect(row.deliveryUncertain).toBe(false);
    expect((await store.outbox.get(r.draft_id))?.error).not.toBeNull(); // audit trail intact
  });

  it('outbox:discard discards pending drafts and tolerates races', async () => {
    const r = await service.draftReply({ documentId: docId, body: 'x' });
    await invoke('outbox:discard', { draftId: r.draft_id });
    expect((await store.outbox.get(r.draft_id))?.status).toBe('discarded');
    await invoke('outbox:discard', { draftId: r.draft_id }); // second: no throw
  });

  it('outbox:open-confirm opens actionable rows and names the status otherwise', async () => {
    const r = await service.draftReply({ documentId: docId, body: 'x' });
    await invoke('outbox:open-confirm', { draftId: r.draft_id });
    expect(opened[0]).toContain('/outbox/confirm/');

    await invoke('outbox:discard', { draftId: r.draft_id });
    await expect(
      invoke('outbox:open-confirm', { draftId: r.draft_id }),
    ).rejects.toThrow(/status is 'discarded'/);
  });

  it('outbox:redraft creates a fresh draft and opens its page', async () => {
    sendMock.mockRejectedValueOnce(new Error('socket hang up'));
    const r = await service.draftReply({ documentId: docId, body: 'orig' });
    await service.confirmByToken(tokenOf(r));

    const { draftId } = await invoke('outbox:redraft', { draftId: r.draft_id });
    expect(draftId).not.toBe(r.draft_id);
    expect((await store.outbox.get(draftId))?.status).toBe('draft');
    expect((await store.outbox.get(draftId))?.createdVia).toBe('panel');
    expect(opened.some((u) => u.includes('/outbox/confirm/'))).toBe(true);
  });

  it('reports a cold local server in human words', async () => {
    const cold = createOutboundService({
      store,
      prefs: fakePrefs(),
      senders: new Map<string, Sender>([['imap', { send: sendMock }]]),
      logSink,
    }); // never setBaseUrl'd
    const coldHandlers = new Map(
      Object.entries(
        outboundInvokeHandlers({
          service: cold,
          store,
          openExternal: async () => {},
        }),
      ) as Array<[string, Handler]>,
    );
    const r = await service.draftReply({ documentId: docId, body: 'x' });
    await expect(
      coldHandlers.get('outbox:open-confirm')!({ draftId: r.draft_id }),
    ).rejects.toThrow(/local server is not running/);
  });
});
