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
      senders: new Map<string, Sender>([['imap', { send: sendMock }]]),
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
    const gmail = await store.createAccount({
      source: 'gmail',
      identifier: 'g@example.com',
    });
    await expect(
      service.draftMessage({
        accountId: gmail.id,
        to: ['b@x.com'],
        subject: 's',
        body: 'b',
      }),
    ).rejects.toThrow(/not supported yet/);
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
    const token = r.confirm_url.split('/outbox/confirm/')[1];
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
    const token = r.confirm_url.split('/outbox/confirm/')[1];
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
    ).rejects.toThrow(/local-only/i);
    await expect(
      runWithTransport('remote', () => service.listOutbox({})),
    ).rejects.toThrow(/local-only/i);
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
    const reviewToken = review.confirm_url.split('/outbox/confirm/')[1];
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
    const linkToken = link.confirm_url.split('/outbox/confirm/')[1];
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

  const tokenOf = (r: { confirm_url: string }) =>
    r.confirm_url.split('/outbox/confirm/')[1];

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
});
