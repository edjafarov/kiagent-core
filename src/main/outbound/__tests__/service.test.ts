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
import { createOutboundService, type OutboundService } from '../service';
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

    const sender: Sender = { send: async () => ({}) };
    service = createOutboundService({
      store,
      prefs: fakePrefs(),
      senders: new Map([['imap', sender]]),
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
});
