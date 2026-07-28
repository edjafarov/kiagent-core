import fs from 'fs';
import os from 'os';
import path from 'path';

import type {
  AccountId,
  DocumentInput,
  Prefs,
  Sender,
} from '@shared/contracts';

import { openDb } from '../../db/app-db';
import { openStore, type CoreStore } from '../../core/store/store';
import { composeSenders } from '../senders';
import {
  CONFIRM_TTL_MS,
  createOutboundService,
  DRAFT_TTL_MS,
  type OutboundService,
} from '../service';
import { signConfirmToken, verifyConfirmToken } from '../tokens';
import { runWithTransport } from '../../core/mcp/transport-context';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};

const logSink = { log: () => {} };

function fakePrefs(defaultMode?: string): Prefs {
  const p = {
    outbound: defaultMode ? { defaultMode } : undefined,
  } as unknown as ReturnType<Prefs['get']>;
  return { get: () => p, patch: async () => {}, onChange: () => () => {} };
}

const emailDoc = (over: Partial<DocumentInput> = {}): DocumentInput => ({
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
  ...over,
});

// Realistic IMAP account shape: identifier is `${user}@${host}` (NOT an
// address); the sending/self address derives from config.user.
const IMAP_CFG = {
  host: 'imap.example.com',
  port: 993,
  secure: true,
  user: 'me@example.com',
};

describe('outbound service — drafts', () => {
  let dir: string;
  let store: CoreStore;
  let accountId: AccountId;
  let service: OutboundService;
  let docId: string;
  let sendMock: jest.Mock;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-outsvc-'));
    store = openStore(await openDb(path.join(dir, 'test.db')), deps);
    const account = await store.createAccount({
      source: 'imap',
      identifier: 'me@example.com@imap.example.com',
      config: IMAP_CFG,
    });
    accountId = account.id;
    await store.commit({
      account: accountId,
      documents: [emailDoc()],
      cursor: null,
    });
    const hits = await store.read.search({ limit: 10 });
    docId = hits[0].id as string;

    sendMock = jest.fn(async () => ({ externalMessageId: '<sent@x>' }));
    service = createOutboundService({
      store,
      prefs: fakePrefs(),
      senders: new Map<string, Sender>([
        ['imap', { send: sendMock }],
        ['gmail', { send: sendMock }],
      ]),
      logSink,
    });
    service.setBaseUrl('http://127.0.0.1:7421');
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('draftReply resolves recipient from the document, mode review by default', async () => {
    const r = await service.draftReply({ documentId: docId, body: 'Thanks!' });
    expect(r.mode).toBe('review');
    expect(r.recipient_display).toBe('Alice <alice@example.com>');
    expect(r.confirm_url).toMatch(
      /^http:\/\/127\.0\.0\.1:7421\/outbox\/confirm\//,
    );
    expect(r.body).toBeUndefined(); // review mode carries no draft fields
    expect(r.instruction).toMatch(/review/i);
    const row = await store.outbox.get(r.draft_id);
    expect(row?.status).toBe('draft');
    expect(row?.to).toEqual(['Alice <alice@example.com>']);
    expect(row?.threading).toEqual({
      inReplyTo: '<orig@x>',
      references: ['<orig@x>'],
    });
  });

  it('link mode (per-account config) returns the full draft for in-chat review', async () => {
    await store.setAccountConfig(accountId, {
      ...IMAP_CFG,
      outbound: { mode: 'link' },
    });
    const r = await service.draftReply({ documentId: docId, body: 'Hi' });
    expect(r.mode).toBe('link');
    expect(r.to).toEqual(['Alice <alice@example.com>']);
    expect(r.subject).toBe('Re: Numbers');
    expect(r.body).toBe('Hi');
    expect(r.instruction).toMatch(/render the draft/i);
  });

  it('draftReply on a gmail thread resolves via thread metadata and dispatches to the gmail sender', async () => {
    const gmailAccount = await store.createAccount({
      source: 'gmail',
      identifier: 'me@gmail.com',
      config: {},
    });
    await store.commit({
      account: gmailAccount.id,
      documents: [
        {
          externalId: 'thread-1',
          type: 'email.thread',
          title: 'Gmail Thread',
          markdown: 'body',
          metadata: {
            gmailThreadId: 'gt1',
            messages: [
              {
                id: '<gm1@x>',
                from: 'Alice <alice@example.com>',
                date: 'D',
                snippet: 's',
              },
              { id: '<gm2@x>', from: 'me@gmail.com', date: 'D', snippet: 's' },
            ],
          },
          createdAt: '2026-07-02T00:00:00Z',
        },
      ],
      cursor: null,
    });
    const gmailHits = await store.read.search({
      account: gmailAccount.id,
      type: 'email.thread',
    });
    const gmailDocId = gmailHits[0].id as string;

    const r = await service.draftReply({
      documentId: gmailDocId,
      body: 'Thanks!',
    });
    expect(r.recipient_display).toBe('Alice <alice@example.com>');
    const row = await store.outbox.get(r.draft_id);
    expect(row?.to).toEqual(['Alice <alice@example.com>']);
    expect(row?.subject).toBe('Re: Gmail Thread');
    expect(row?.threading).toEqual({
      gmailThreadId: 'gt1',
      inReplyTo: '<gm2@x>',
      references: ['<gm1@x>', '<gm2@x>'],
    });
  });

  it('draftReply on a gmail attachment child doc rejects with a precise type error, not the re-sync message', async () => {
    const gmailAccount = await store.createAccount({
      source: 'gmail',
      identifier: 'me@gmail.com',
      config: {},
    });
    // Mirrors to-document.ts's `attachment` child docs: parented to a
    // thread, but never carrying thread metadata (gmailThreadId/messages).
    await store.commit({
      account: gmailAccount.id,
      documents: [
        {
          externalId: 'att-1',
          type: 'attachment',
          title: 'file.pdf',
          markdown: null,
          metadata: {
            mime: 'application/pdf',
            filename: 'file.pdf',
            sizeBytes: 1234,
            messageId: '<gm1@x>',
            partId: '0.1',
            attachmentId: 'abc',
          },
          createdAt: '2026-07-02T00:00:00Z',
        },
      ],
      cursor: null,
    });
    const hits = await store.read.search({
      account: gmailAccount.id,
      type: 'attachment',
    });
    const attachmentDocId = hits[0].id as string;

    let caught: Error | undefined;
    try {
      await service.draftReply({ documentId: attachmentDocId, body: 'x' });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toMatch(/not replyable/);
    expect(caught?.message).not.toMatch(/missing thread metadata/);
    expect(caught?.message).not.toMatch(/re-sync/);
  });

  it('gmail resolver warnings propagate through draftReply to the tool result', async () => {
    const gmailAccount = await store.createAccount({
      source: 'gmail',
      identifier: 'me@gmail.com',
      config: {},
    });
    await store.commit({
      account: gmailAccount.id,
      documents: [
        {
          externalId: 'thread-2',
          type: 'email.thread',
          title: 'Gmail Thread 2',
          markdown: 'body',
          metadata: {
            gmailThreadId: 'gt2',
            // Every message is self-sent — replying targets the last
            // message's own recipients, with the resolver's warning.
            messages: [
              { id: '<gm3@x>', from: 'me@gmail.com', date: 'D', snippet: 's' },
              {
                id: '<gm4@x>',
                from: 'me@gmail.com',
                to: ['Bob <bob@example.com>'],
                date: 'D',
                snippet: 's',
              },
            ],
          },
          createdAt: '2026-07-02T00:00:00Z',
        },
      ],
      cursor: null,
    });
    const hits = await store.read.search({
      account: gmailAccount.id,
      type: 'email.thread',
    });
    const gmailDocId = hits[0].id as string;

    const r = await service.draftReply({
      documentId: gmailDocId,
      body: 'Thanks!',
    });
    expect(r.recipient_display).toBe('Bob <bob@example.com>');
    expect(r.warnings[0]).toMatch(/you sent the last message/);
  });

  it('draftMessage validates recipients and account source', async () => {
    const r = await service.draftMessage({
      accountId,
      to: ['bob@example.com'],
      subject: 'Yo',
      body: 'Hey',
    });
    expect(r.recipient_display).toBe('bob@example.com');
    await expect(
      service.draftMessage({
        accountId,
        to: ['not-an-email'],
        subject: 's',
        body: 'b',
      }),
    ).rejects.toThrow(/not-an-email/);
  });

  it('rejects drafts for accounts with no sender', async () => {
    // Unregistered source — never in the senders map — still rejects with
    // "not supported yet" regardless of the identity branch above.
    const notion = await store.createAccount({
      source: 'notion',
      identifier: 'n@example.com',
    });
    await expect(
      service.draftMessage({
        accountId: notion.id,
        to: ['b@x.com'],
        subject: 's',
        body: 'b',
      }),
    ).rejects.toThrow(/not supported yet/);

    // A registered source (imap) with no usable From address configured
    // still rejects — this is the case that stays senderless under the new
    // gmail identity rules (gmail's identifier always resolves).
    const bareImap = await store.createAccount({
      source: 'imap',
      identifier: 'bare@imap.example.com',
      config: {},
    });
    await expect(
      service.draftMessage({
        accountId: bareImap.id,
        to: ['b@x.com'],
        subject: 's',
        body: 'b',
      }),
    ).rejects.toThrow(/no usable From address/);
  });

  it("clamps list_outbox limit to [1,100] before it reaches the store's LIMIT ? — SQLite treats a bare -1 as UNBOUNDED", async () => {
    const spy = jest.spyOn(store.outbox, 'listRecent');
    await service.listOutbox({});
    expect(spy).toHaveBeenLastCalledWith(20); // unchanged default
    await service.listOutbox({ limit: -1 });
    expect(spy).toHaveBeenLastCalledWith(1);
    await service.listOutbox({ limit: 10_000 });
    expect(spy).toHaveBeenLastCalledWith(100);
    spy.mockRestore();
  });

  it('listOutbox re-issues confirm URLs for pending drafts only', async () => {
    const a = await service.draftReply({ documentId: docId, body: 'one' });
    await store.outbox.transition(a.draft_id, ['draft'], 'discarded');
    const b = await service.draftReply({ documentId: docId, body: 'two' });
    const listing = await service.listOutbox({});
    const byId = new Map(listing.map((i) => [i.draft_id, i]));
    expect(byId.get(b.draft_id)?.confirm_url).toMatch(/\/outbox\/confirm\//);
    expect(byId.get(a.draft_id)?.confirm_url).toBeNull();
    expect(byId.get(a.draft_id)?.status).toBe('discarded');
  });

  it('peekByToken: ok for pending, gone for handled, invalid for garbage', async () => {
    const r = await service.draftReply({ documentId: docId, body: 'x' });
    const token = r.confirm_url!.split('/outbox/confirm/')[1];
    const peek = await service.peekByToken(token);
    expect(peek.kind).toBe('ok');
    await store.outbox.transition(r.draft_id, ['draft'], 'discarded');
    expect((await service.peekByToken(token)).kind).toBe('gone');
    expect((await service.peekByToken('garbage')).kind).toBe('invalid');
  });

  it('errors before setBaseUrl', async () => {
    const cold = createOutboundService({
      store,
      prefs: fakePrefs(),
      senders: new Map([['imap', { send: async () => ({}) }]]),
      logSink,
    });
    await expect(
      cold.draftReply({ documentId: docId, body: 'x' }),
    ).rejects.toThrow(/not ready/);
  });

  it('freezes the confirm mode at creation — later settings changes do not apply', async () => {
    const r = await service.draftReply({ documentId: docId, body: 'x' });
    await store.setAccountConfig(accountId, {
      ...IMAP_CFG,
      outbound: { mode: 'link' },
    });
    const token = r.confirm_url!.split('/outbox/confirm/')[1];
    const peek = await service.peekByToken(token);
    expect(peek.kind).toBe('ok');
    if (peek.kind === 'ok') expect(peek.mode).toBe('review');
    const listing = await service.listOutbox({});
    expect(listing[0].confirm_url).toBeTruthy();
  });

  it('refuses draft creation from a remote transport before touching the store', async () => {
    const before = await service.listOutbox({});
    await expect(
      runWithTransport('remote', () =>
        service.draftReply({ documentId: docId, body: 'x' }),
      ),
    ).rejects.toThrow(/remote access fully set up/i);
    await expect(
      runWithTransport('remote', () => service.listOutbox({})),
    ).rejects.toThrow(/remote access fully set up/i);
    expect((await service.listOutbox({})).length).toBe(before.length);
  });

  it('self-address never comes from the identifier', async () => {
    // A reply from Alice addressed to config.user must exclude the user in
    // reply_all even though the identifier is user@host gibberish.
    const r = await service.draftReply({
      documentId: docId,
      body: 'x',
      replyAll: true,
    });
    expect(r.mode === 'review' ? true : !r.to?.includes('me@example.com')).toBe(
      true,
    );
    const row = await store.outbox.get(r.draft_id);
    expect(row?.to.some((t) => t.includes('me@example.com'))).toBe(false);
  });

  it('mints confirm-URL TTLs and the draft-row expiry exactly off CONFIRM_TTL_MS/DRAFT_TTL_MS', async () => {
    const fixedNow = 1_753_500_000_000;
    const clocked = createOutboundService({
      store,
      prefs: fakePrefs(),
      senders: new Map([['imap', { send: async () => ({}) }]]),
      logSink,
      nowMs: () => fixedNow,
    });
    clocked.setBaseUrl('http://127.0.0.1:7421');

    const review = await clocked.draftReply({ documentId: docId, body: 'r' });
    expect(review.mode).toBe('review');
    const reviewToken = review.confirm_url!.split('/outbox/confirm/')[1];
    const secret = await store.outbox.secret();
    const reviewParsed = verifyConfirmToken(secret, reviewToken, fixedNow);
    expect(reviewParsed).not.toBeNull();
    expect((reviewParsed?.expiresAtMs ?? 0) - fixedNow).toBe(
      CONFIRM_TTL_MS.review,
    );
    const reviewRow = await store.outbox.get(review.draft_id);
    expect(reviewRow?.expiresAt).toBe(
      new Date(fixedNow + DRAFT_TTL_MS).toISOString(),
    );

    await store.setAccountConfig(accountId, {
      ...IMAP_CFG,
      outbound: { mode: 'link' },
    });
    const link = await clocked.draftReply({ documentId: docId, body: 'l' });
    expect(link.mode).toBe('link');
    const linkToken = link.confirm_url!.split('/outbox/confirm/')[1];
    const linkParsed = verifyConfirmToken(secret, linkToken, fixedNow);
    expect(linkParsed).not.toBeNull();
    expect((linkParsed?.expiresAtMs ?? 0) - fixedNow).toBe(CONFIRM_TTL_MS.link);
  });

  it('falls back to the prefs default mode when the account has no per-account mode', async () => {
    const withDefault = createOutboundService({
      store,
      prefs: fakePrefs('link'),
      senders: new Map([['imap', { send: async () => ({}) }]]),
      logSink,
    });
    withDefault.setBaseUrl('http://127.0.0.1:7421');
    const r = await withDefault.draftReply({ documentId: docId, body: 'x' });
    expect(r.mode).toBe('link');
  });

  const tokenOf = (r: { confirm_url?: string }) =>
    r.confirm_url!.split('/outbox/confirm/')[1];

  it('confirmByToken sends and records the external id', async () => {
    const r = await service.draftReply({ documentId: docId, body: 'Yo' });
    sendMock.mockImplementationOnce(async () => {
      // The row must already be CAS-owned ('sending') at the moment the
      // Sender is invoked — never still 'draft'.
      const inFlight = await store.outbox.get(r.draft_id);
      expect(inFlight?.status).toBe('sending');
      return { externalMessageId: '<sent@x>' };
    });
    const out = await service.confirmByToken(tokenOf(r));
    expect(out.kind).toBe('sent');
    expect(sendMock).toHaveBeenCalledTimes(1);
    const intent = sendMock.mock.calls[0][0];
    expect(intent.to).toEqual(['Alice <alice@example.com>']);
    expect(intent.threading).toEqual({
      inReplyTo: '<orig@x>',
      references: ['<orig@x>'],
    });
    const row = await store.outbox.get(r.draft_id);
    expect(row?.status).toBe('sent');
    expect(row?.externalMessageId).toBe('<sent@x>');
    expect(row?.sentAt).toBeTruthy();
  });

  it('a sender that resolves with no fields still lands in sent, not failed', async () => {
    sendMock.mockResolvedValueOnce(undefined);
    const r = await service.draftReply({ documentId: docId, body: 'Yo' });
    const out = await service.confirmByToken(tokenOf(r));
    expect(out.kind).toBe('sent');
    const row = await store.outbox.get(r.draft_id);
    expect(row?.status).toBe('sent');
    expect(row?.externalMessageId).toBeNull();
  });

  it('a confirm link is single-use', async () => {
    const r = await service.draftReply({ documentId: docId, body: 'Yo' });
    await service.confirmByToken(tokenOf(r));
    const second = await service.confirmByToken(tokenOf(r));
    expect(second.kind).toBe('already');
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('a concurrent second confirm loses the CAS and never double-sends', async () => {
    const r = await service.draftReply({ documentId: docId, body: 'Yo' });
    const token = tokenOf(r);
    const [a, b] = await Promise.all([
      service.confirmByToken(token),
      service.confirmByToken(token),
    ]);
    expect([a.kind, b.kind].sort()).toEqual(['already', 'sent']);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const row = await store.outbox.get(r.draft_id);
    expect(row?.status).toBe('sent');
  });

  it('a sender failure lands in failed with the error recorded', async () => {
    sendMock.mockRejectedValueOnce(new Error('SMTP 535 auth failed'));
    const r = await service.draftReply({ documentId: docId, body: 'Yo' });
    const out = await service.confirmByToken(tokenOf(r));
    expect(out.kind).toBe('failed');
    const row = await store.outbox.get(r.draft_id);
    expect(row?.status).toBe('failed');
    expect(row?.error).toMatch(/535/);
  });

  it('a missing sender at confirm time lands in failed, never stuck in sending', async () => {
    const r = await service.draftReply({ documentId: docId, body: 'Yo' });
    const senderless = createOutboundService({
      store,
      prefs: fakePrefs(),
      senders: new Map<string, Sender>(),
      logSink,
    });
    senderless.setBaseUrl('http://127.0.0.1:7421');
    const out = await senderless.confirmByToken(tokenOf(r));
    expect(out.kind).toBe('failed');
    const row = await store.outbox.get(r.draft_id);
    expect(row?.status).toBe('failed');
    expect(row?.error).toMatch(/not supported yet/);
    expect(sendMock).not.toHaveBeenCalled();
  });

  // Verbatim smoke-test 403 blob from error-copy.test.ts — duplicated here
  // (not exported there) so this file pins the same fixture independently.
  const SMOKE_403 =
    'gmail 403 https://gmail.googleapis.com/gmail/v1/users/me/messages/send ' +
    '{ "error": { "code": 403, "message": "Quota exceeded for quota metric ' +
    "'Queries' and limit 'Previous quota: Units per minute per user'\", " +
    '"errors": [ { "reason": "rateLimitExceeded", "domain": "usageLimits" } ], ' +
    '"status": "PERMISSION_DENIED" } }';

  it('fail() stores the classifier shaped summary, never the raw error blob', async () => {
    sendMock.mockRejectedValueOnce(new Error(SMOKE_403));
    const r = await service.draftReply({ documentId: docId, body: 'Yo' });
    const out = await service.confirmByToken(tokenOf(r));
    expect(out.kind).toBe('failed');
    const row = await store.outbox.get(r.draft_id);
    expect(row?.status).toBe('failed');
    expect(row?.error).toBe(
      'rate-limited: the mail service rejected the send (HTTP 403) — nothing was sent',
    );
  });

  it('a retryable failed row re-confirms through the same token (Try again)', async () => {
    sendMock.mockRejectedValueOnce(new Error(SMOKE_403));
    const r = await service.draftReply({ documentId: docId, body: 'Yo' });
    const token = tokenOf(r);
    const first = await service.confirmByToken(token);
    expect(first.kind).toBe('failed');
    expect((await store.outbox.get(r.draft_id))?.status).toBe('failed');

    sendMock.mockResolvedValueOnce({ externalMessageId: '<retry@x>' });
    const second = await service.confirmByToken(token);
    expect(second.kind).toBe('sent');
    const row = await store.outbox.get(r.draft_id);
    expect(row?.status).toBe('sent');
    expect(row?.externalMessageId).toBe('<retry@x>');
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it('listOutbox reports error:null for a row retried from failed to sent — a stale failure summary must never reach the model surface for a message that has since sent', async () => {
    sendMock.mockRejectedValueOnce(new Error(SMOKE_403));
    const r = await service.draftReply({ documentId: docId, body: 'Yo' });
    const token = tokenOf(r);
    const first = await service.confirmByToken(token);
    expect(first.kind).toBe('failed');

    const failedListing = await service.listOutbox({});
    const failedItem = failedListing.find((i) => i.draft_id === r.draft_id);
    expect(failedItem?.status).toBe('failed');
    expect(failedItem?.error).toBeTruthy();

    sendMock.mockResolvedValueOnce({ externalMessageId: '<retry@x>' });
    const second = await service.confirmByToken(token);
    expect(second.kind).toBe('sent');

    const sentListing = await service.listOutbox({});
    const sentItem = sentListing.find((i) => i.draft_id === r.draft_id);
    expect(sentItem?.status).toBe('sent');
    expect(sentItem?.error).toBeNull();
  });

  it('a permanently failed row stays terminal — Try again is refused, sender never re-invoked', async () => {
    sendMock.mockRejectedValueOnce(new Error('completely novel explosion'));
    const r = await service.draftReply({ documentId: docId, body: 'Yo' });
    const token = tokenOf(r);
    const first = await service.confirmByToken(token);
    expect(first.kind).toBe('failed');

    const second = await service.confirmByToken(token);
    expect(second.kind).toBe('already');
    const row = await store.outbox.get(r.draft_id);
    expect(row?.status).toBe('failed');
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('the first confirm of a plain draft row pins the CAS from-arg to [draft]', async () => {
    const r = await service.draftReply({ documentId: docId, body: 'Yo' });
    const token = tokenOf(r);
    const spy = jest.spyOn(store.outbox, 'transition');
    await service.confirmByToken(token);
    const toSending = spy.mock.calls.find((c) => c[2] === 'sending');
    expect(toSending?.[1]).toEqual(['draft']);
    spy.mockRestore();
  });

  it('the CAS transition uses the OBSERVED status, never the union [draft,failed]', async () => {
    sendMock.mockRejectedValueOnce(new Error(SMOKE_403));
    const r = await service.draftReply({ documentId: docId, body: 'Yo' });
    const token = tokenOf(r);
    await service.confirmByToken(token); // drive draft -> failed (retryable)
    expect((await store.outbox.get(r.draft_id))?.status).toBe('failed');

    const spy = jest.spyOn(store.outbox, 'transition');
    sendMock.mockResolvedValueOnce({ externalMessageId: '<retry@x>' });
    await service.confirmByToken(token);
    const toSending = spy.mock.calls.find((c) => c[2] === 'sending');
    expect(toSending?.[1]).toEqual(['failed']);
    spy.mockRestore();
  });

  it('confirmByToken sweeps an expired-but-unswept draft instead of sending it', async () => {
    // store.outbox.create() only sweeps BEFORE inserting, so a row created
    // with a past expiresAt survives creation still marked 'draft' — it's
    // confirmByToken's own expireOverdue() call that must catch it.
    const secret = await store.outbox.secret();
    const stale = await store.outbox.create({
      accountId,
      kind: 'new',
      recipientDisplay: 'x@example.com',
      to: ['x@example.com'],
      cc: [],
      subject: 's',
      bodyMarkdown: 'b',
      confirmMode: 'review',
      createdVia: 'mcp-local',
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const token = signConfirmToken(secret, stale.id, Date.now() + 60_000);
    const out = await service.confirmByToken(token);
    expect(out.kind).toBe('already');
    const row = await store.outbox.get(stale.id);
    expect(row?.status).toBe('expired');
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('cancelByToken discards without sending', async () => {
    const r = await service.draftReply({ documentId: docId, body: 'Yo' });
    const out = await service.cancelByToken(tokenOf(r));
    expect(out.kind).toBe('cancelled');
    expect(sendMock).not.toHaveBeenCalled();
    expect((await store.outbox.get(r.draft_id))?.status).toBe('discarded');
  });

  it('cancelByToken after a completed confirm loses the CAS and leaves the sent row alone', async () => {
    const r = await service.draftReply({ documentId: docId, body: 'Yo' });
    await service.confirmByToken(tokenOf(r));
    const out = await service.cancelByToken(tokenOf(r));
    expect(out.kind).toBe('already');
    const row = await store.outbox.get(r.draft_id);
    expect(row?.status).toBe('sent');
  });

  it('garbage tokens are invalid for both operations', async () => {
    expect((await service.confirmByToken('nope')).kind).toBe('invalid');
    expect((await service.cancelByToken('nope')).kind).toBe('invalid');
  });

  // ——— mode C: chat confirmation (send_draft) ———
  // The opt-in is GLOBAL (prefs default mode), never per-account config.

  const chatService = (): OutboundService => {
    const s = createOutboundService({
      store,
      prefs: fakePrefs('chat'),
      senders: new Map<string, Sender>([
        ['imap', { send: sendMock }],
        ['gmail', { send: sendMock }],
      ]),
      logSink,
    });
    s.setBaseUrl('http://127.0.0.1:7421');
    return s;
  };

  it('chat global default: draft results carry the body but no confirm url', async () => {
    const svc = chatService();
    const r = await svc.draftReply({ documentId: docId, body: 'Yo' });
    expect(r.mode).toBe('chat');
    expect(r.confirm_url).toBeUndefined();
    expect(r.body).toBe('Yo');
    expect(r.instruction).toMatch(/explicitly agrees/);
    expect((await store.outbox.get(r.draft_id))?.confirmMode).toBe('chat');
  });

  it('per-account config can NEVER opt into chat (global-only opt-in)', async () => {
    await store.setAccountConfig(accountId, {
      ...IMAP_CFG,
      outbound: { mode: 'chat' }, // hand-edited config — must not be honored
    });
    const r = await service.draftReply({ documentId: docId, body: 'Yo' });
    expect(r.mode).toBe('review'); // falls through to the (review) global default
  });

  it('per-account review override beats the chat global default', async () => {
    await store.setAccountConfig(accountId, {
      ...IMAP_CFG,
      outbound: { mode: 'review' },
    });
    const svc = chatService();
    const r = await svc.draftReply({ documentId: docId, body: 'Yo' });
    expect(r.mode).toBe('review');
    expect(r.confirm_url).toContain('/outbox/confirm/');
  });

  it('sendDraft sends a chat-mode draft', async () => {
    const svc = chatService();
    const r = await svc.draftReply({ documentId: docId, body: 'Yo' });
    const out = await svc.sendDraft({ draftId: r.draft_id });
    expect(out.status).toBe('sent');
    expect(out.recipient_display).toBe(r.recipient_display);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect((await store.outbox.get(r.draft_id))?.status).toBe('sent');
  });

  it('sendDraft refuses non-chat drafts, naming the mode', async () => {
    const r = await service.draftReply({ documentId: docId, body: 'Yo' });
    await expect(service.sendDraft({ draftId: r.draft_id })).rejects.toThrow(
      /mode 'review'.*list_outbox/,
    );
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('sendDraft refuses when the global default left chat after drafting', async () => {
    const svc = chatService();
    const r = await svc.draftReply({ documentId: docId, body: 'Yo' });
    // Same store, but the service whose prefs default is 'review' — models
    // the user turning the global setting back off before the model sends.
    await expect(service.sendDraft({ draftId: r.draft_id })).rejects.toThrow(
      /no longer/i,
    );
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('sendDraft refuses when the account overrode back to review', async () => {
    const svc = chatService();
    const r = await svc.draftReply({ documentId: docId, body: 'Yo' });
    await store.setAccountConfig(accountId, {
      ...IMAP_CFG,
      outbound: { mode: 'review' },
    });
    await expect(svc.sendDraft({ draftId: r.draft_id })).rejects.toThrow(
      /no longer/i,
    );
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('sendDraft enforces the per-account hourly rate limit', async () => {
    await store.setAccountConfig(accountId, {
      ...IMAP_CFG,
      outbound: { sendsPerHour: 1 }, // knob only — no mode override
    });
    const svc = chatService();
    const a = await svc.draftReply({ documentId: docId, body: 'one' });
    await svc.sendDraft({ draftId: a.draft_id });
    const b = await svc.draftReply({ documentId: docId, body: 'two' });
    await expect(svc.sendDraft({ draftId: b.draft_id })).rejects.toThrow(
      /rate limit/i,
    );
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('sendDraft is single-use', async () => {
    const svc = chatService();
    const r = await svc.draftReply({ documentId: docId, body: 'Yo' });
    await svc.sendDraft({ draftId: r.draft_id });
    await expect(svc.sendDraft({ draftId: r.draft_id })).rejects.toThrow(
      /'sent'/,
    );
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('sendDraft surfaces a transport failure and records it', async () => {
    const svc = chatService();
    sendMock.mockRejectedValueOnce(new Error('SMTP 550 relay denied'));
    const r = await svc.draftReply({ documentId: docId, body: 'Yo' });
    // Anchored on purpose: the stored summary is ALREADY prefixed
    // `send failed: ` by the classifier, so a naive re-prefix would produce
    // `send failed: send failed: SMTP 550 …` and fail this assertion.
    await expect(svc.sendDraft({ draftId: r.draft_id })).rejects.toThrow(
      /^send failed: SMTP 550/,
    );
    const row = await store.outbox.get(r.draft_id);
    expect(row?.status).toBe('failed');
    expect(row?.error).toMatch(/550/);
  });

  it('list_outbox still re-links pending chat drafts (page fallback)', async () => {
    const svc = chatService();
    const r = await svc.draftReply({ documentId: docId, body: 'Yo' });
    const listing = await svc.listOutbox({});
    const item = listing.find((x) => x.draft_id === r.draft_id);
    expect(item?.confirm_url).toContain('/outbox/confirm/');
  });

  // ——— extension senders (spec §6 universality hook) ———
  // Everything below hands the service a LOOKUP literal, never a Map: that
  // is the shape bundled + extension senders compose into, and the service
  // must accept it unchanged.

  const slackSetup = async (): Promise<{
    svc: OutboundService;
    slackSend: jest.Mock;
    slackAccountId: AccountId;
    hookDocId: string; // written with metadata.outbound
    preHookDocId: string; // no metadata.outbound written for it
  }> => {
    const slackSend: jest.Mock = jest.fn(async () => ({
      externalMessageId: '1719.42',
    }));
    const lookup = {
      get: (id: string) => (id === 'slack' ? { send: slackSend } : undefined),
      ids: () => ['slack'],
    };
    const svc = createOutboundService({
      store,
      prefs: fakePrefs(),
      senders: lookup,
      logSink,
    });
    svc.setBaseUrl('http://127.0.0.1:7421');
    const slackAccount = await store.createAccount({
      source: 'slack',
      identifier: 'T123:me',
      config: {},
    });
    await store.commit({
      account: slackAccount.id,
      documents: [
        {
          externalId: 'C9:1719',
          type: 'slack.thread',
          title: 'thread',
          markdown: 'hi',
          metadata: {
            outbound: {
              ref: { channel: 'C9', thread_ts: '1719.00' },
              display: '#general (thread)',
            },
          },
          createdAt: '2026-07-01T00:00:00Z',
        },
        {
          // A pre-hook document: indexed by a build whose Slack source did
          // not write metadata.outbound yet. These never self-heal in place.
          externalId: 'C9:1600',
          type: 'slack.legacy',
          title: 'old thread',
          markdown: 'hi',
          metadata: {},
          createdAt: '2026-07-01T00:00:00Z',
        },
      ],
      cursor: null,
    });
    const idOf = async (type: string): Promise<string> => {
      const hits = await store.read.search({
        account: slackAccount.id,
        type,
      });
      return hits[0].id as string;
    };
    return {
      svc,
      slackSend,
      slackAccountId: slackAccount.id,
      hookDocId: await idOf('slack.thread'),
      preHookDocId: await idOf('slack.legacy'),
    };
  };

  it('drafts replies for extension-sender sources via metadata.outbound', async () => {
    const { svc, slackSend, hookDocId } = await slackSetup();
    const r = await svc.draftReply({ documentId: hookDocId, body: 'On it!' });
    expect(r.recipient_display).toBe('#general (thread)');
    const out = await svc.confirmByToken(tokenOf(r));
    expect(out.kind).toBe('sent');
    // The opaque ref round-trips to the source's own Sender verbatim —
    // still an object, not the JSON string the outbox column stores.
    expect(slackSend.mock.calls[0][0].outboundRef).toEqual({
      channel: 'C9',
      thread_ts: '1719.00',
    });
  });

  it('draft_message refuses non-email sources honestly', async () => {
    const { svc, slackAccountId } = await slackSetup();
    await expect(
      svc.draftMessage({
        accountId: slackAccountId,
        to: ['x@y.com'],
        subject: 's',
        body: 'b',
      }),
    ).rejects.toThrow(/email-only.*reply-only/);
  });

  it('a pre-hook document rejects with reply copy, never the compose copy', async () => {
    const { svc, slackSend, preHookDocId } = await slackSetup();
    let caught: Error | undefined;
    try {
      await svc.draftReply({ documentId: preHookDocId, body: 'x' });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toMatch(/no reply target/);
    // The compose refusal is true but useless on a reply — and the imap
    // resolver's email-shaped copy is worse still.
    expect(caught?.message).not.toMatch(/email-only/);
    expect(caught?.message).not.toMatch(/From address/);
    expect(slackSend).not.toHaveBeenCalled();
  });

  it('confirmUrlFor mints a link for a pending draft and stops at terminal rows', async () => {
    const r = await service.draftReply({ documentId: docId, body: 'Yo' });
    const url = await service.confirmUrlFor(r.draft_id);
    expect(url).toContain('/outbox/confirm/');
    await service.cancelByToken(tokenOf(r));
    expect(await service.confirmUrlFor(r.draft_id)).toBeNull();
    expect(await service.confirmUrlFor('nope')).toBeNull();
  });

  it('confirmUrlFor re-mints for a provably-not-sent failure (Try again)', async () => {
    // `smtp transient 421: …` matches SMTP_TRANSIENT (error-copy.ts:108-117)
    // → kind 'transient', canRetry true. The stored summary re-shapes to the
    // same verdict (the module is a fixed point), which is what the panel and
    // failedPage both read.
    sendMock.mockRejectedValueOnce(
      new Error('smtp transient 421: mailbox busy'),
    );
    const r = await service.draftReply({ documentId: docId, body: 'Retry me' });
    await service.confirmByToken(tokenOf(r));
    expect((await store.outbox.get(r.draft_id))?.status).toBe('failed');

    const url = await service.confirmUrlFor(r.draft_id);
    expect(url).toContain('/outbox/confirm/');
    // …and that URL really is a live retry: confirming it sends.
    const outcome = await service.confirmByToken(
      url!.split('/outbox/confirm/')[1],
    );
    expect(outcome.kind).toBe('sent');
  });

  it('confirmUrlFor returns null for an ambiguous failure', async () => {
    // No transient/auth/unsupported marker → kind 'unknown', canRetry false:
    // the message MAY have gone out, so no retry affordance.
    sendMock.mockRejectedValueOnce(new Error('socket hang up'));
    const r = await service.draftReply({
      documentId: docId,
      body: 'Uncertain',
    });
    await service.confirmByToken(tokenOf(r));
    expect(await service.confirmUrlFor(r.draft_id)).toBeNull();
  });

  it('redraft duplicates a failed row verbatim under the current mode', async () => {
    sendMock.mockRejectedValueOnce(
      new Error('smtp transient 421: mailbox busy'),
    );
    const r = await service.draftReply({ documentId: docId, body: 'Original' });
    await service.confirmByToken(tokenOf(r));

    const old = await store.outbox.get(r.draft_id);
    const fresh = await service.redraft(r.draft_id);
    expect(fresh.id).not.toBe(r.draft_id);
    expect(fresh.status).toBe('draft');
    expect(fresh.createdVia).toBe('panel');
    expect(fresh.accountId).toBe(old!.accountId);
    expect(fresh.bodyMarkdown).toBe('Original');
    expect(fresh.recipientDisplay).toBe(r.recipient_display);
    expect(fresh.to).toEqual(old!.to);
    expect(fresh.cc).toEqual(old!.cc);
    expect(fresh.subject).toBe(old!.subject);
    expect(fresh.threading).toEqual(old!.threading);
    expect(fresh.replyToDocumentId).toBe(old!.replyToDocumentId);
    // The old row is history, never scrubbed.
    expect((await store.outbox.get(r.draft_id))?.status).toBe('failed');
  });

  it('redraft works on a discarded row', async () => {
    const r = await service.draftReply({
      documentId: docId,
      body: 'Cancelled',
    });
    await service.cancelByToken(tokenOf(r));
    const fresh = await service.redraft(r.draft_id);
    expect(fresh.status).toBe('draft');
    expect(fresh.bodyMarkdown).toBe('Cancelled');
  });

  it('redraft refuses pending and sent rows', async () => {
    const pending = await service.draftReply({ documentId: docId, body: 'a' });
    await expect(service.redraft(pending.draft_id)).rejects.toThrow(/'draft'/);

    const ok = await service.draftReply({ documentId: docId, body: 'b' });
    await service.confirmByToken(tokenOf(ok));
    await expect(service.redraft(ok.draft_id)).rejects.toThrow(/'sent'/);
  });

  it('redraft refuses delivery_unknown rows — check Sent first', async () => {
    const r = await service.draftReply({
      documentId: docId,
      body: 'maybe sent',
    });
    // Simulate a process death mid-send WITHOUT touching either clock:
    // a row parked in 'sending' is what the boot sweep converts.
    await store.outbox.transition(r.draft_id, ['draft'], 'sending');
    await store.outbox.recoverOrphanedSending();
    expect((await store.outbox.get(r.draft_id))?.status).toBe(
      'delivery_unknown',
    );

    await expect(service.redraft(r.draft_id)).rejects.toThrow(
      /delivery_unknown[\s\S]*Sent folder/,
    );
  });

  describe('remote transport', () => {
    const REMOTE = 'https://ig6uj5qu.localkiagent.com';

    it('refuses remote drafting until a remote base url is pushed', async () => {
      await expect(
        runWithTransport('remote', () =>
          service.draftReply({ documentId: docId, body: 'Yo' }),
        ),
      ).rejects.toThrow(/remote access fully set up/i);
    });

    it('mints remote urls and tags createdVia once the base url is set', async () => {
      service.setRemoteBaseUrl(REMOTE);
      const r = await runWithTransport('remote', () =>
        service.draftReply({ documentId: docId, body: 'Yo' }),
      );
      expect(r.confirm_url).toMatch(
        /^https:\/\/ig6uj5qu\.localkiagent\.com\/outbox\/confirm\//,
      );
      expect((await store.outbox.get(r.draft_id))?.createdVia).toBe(
        'mcp-remote',
      );
    });

    it('list_outbox re-links per the CURRENT transport', async () => {
      service.setRemoteBaseUrl(REMOTE);
      const r = await service.draftReply({ documentId: docId, body: 'Yo' });
      expect(r.confirm_url).toContain('http://127.0.0.1');
      const remoteListing = await runWithTransport('remote', () =>
        service.listOutbox({}),
      );
      const item = remoteListing.find((x) => x.draft_id === r.draft_id);
      expect(item?.confirm_url).toContain('ig6uj5qu.localkiagent.com');
      const localListing = await service.listOutbox({});
      expect(
        localListing.find((x) => x.draft_id === r.draft_id)?.confirm_url,
      ).toContain('http://127.0.0.1');
    });

    it('clearing the remote base restores the refusal', async () => {
      service.setRemoteBaseUrl(REMOTE);
      service.setRemoteBaseUrl(null);
      await expect(
        runWithTransport('remote', () => service.listOutbox({})),
      ).rejects.toThrow(/remote access fully set up/i);
    });
  });
});

describe('composeSenders', () => {
  it('bundled senders shadow extension senders on a colliding source id', () => {
    const bundled: Sender = { send: async () => ({}) };
    const extension: Sender = { send: async () => ({}) };
    const lookup = composeSenders(
      new Map<string, Sender>([['gmail', bundled]]),
      {
        // An installed extension claiming 'gmail' must never intercept the
        // bundled transport — bundled wins, and only 'slack' comes from it.
        get: (id) => (id === 'gmail' || id === 'slack' ? extension : undefined),
        ids: () => ['gmail', 'slack'],
      },
    );
    expect(lookup.get('gmail')).toBe(bundled);
    expect(lookup.get('slack')).toBe(extension);
    expect(lookup.get('notion')).toBeUndefined();
    // Deduped, so the service's "supported: …" line never lists one twice.
    expect(lookup.ids().sort()).toEqual(['gmail', 'slack']);
  });
});
