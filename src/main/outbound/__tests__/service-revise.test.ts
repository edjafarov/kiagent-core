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
import { verifyConfirmToken } from '../tokens';
import { runWithTransport } from '../../core/mcp/transport-context';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};

function fakePrefs(defaultMode?: string): Prefs {
  const p = {
    outbound: defaultMode ? { defaultMode } : undefined,
  } as unknown as ReturnType<Prefs['get']>;
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

describe('outbound service — revisions', () => {
  let dir: string;
  let store: CoreStore;
  let accountId: AccountId;
  let service: OutboundService;
  let docId: string;
  let sendMock: jest.Mock;

  const make = (mode?: string) => {
    service = createOutboundService({
      store,
      prefs: fakePrefs(mode),
      senders: new Map<string, Sender>([['imap', { send: sendMock }]]),
      logSink: { log: () => {} },
    });
    service.setBaseUrl('http://127.0.0.1:7421');
  };

  const tokenOf = (url: string) => url.split('/outbox/confirm/')[1];

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-outrev-'));
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
    docId = (await store.read.search({ limit: 10 }))[0].id as string;
    sendMock = jest.fn(async () => ({ externalMessageId: '<sent@x>' }));
    make();
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each(['review', 'link', 'chat'])(
    'draft results carry revision 1 and the full draft in %s mode',
    async (mode) => {
      make(mode);
      const r = await service.draftReply({
        documentId: docId,
        body: 'Thanks!',
      });
      expect(r.revision).toBe(1);
      expect(r.body).toBe('Thanks!');
      expect(r.to).toEqual(['Alice <alice@example.com>']);
      expect(r.subject).toBe('Re: Numbers');
      expect(r.attachments).toEqual([]);
    },
  );

  it('revises the same draft in place', async () => {
    const r = await service.draftReply({
      documentId: docId,
      body: 'Long text',
    });
    const v = await service.reviseDraft({
      draftId: r.draft_id,
      revision: 1,
      body: 'Short',
    });
    expect(v.draft_id).toBe(r.draft_id);
    expect(v.revision).toBe(2);
    expect(v.body).toBe('Short');
    expect(await store.outbox.listRecent(10)).toHaveLength(1);
  });

  it('refuses a revise at an old revision and returns the current draft', async () => {
    const r = await service.draftReply({ documentId: docId, body: 'One' });
    await service.reviseDraft({
      draftId: r.draft_id,
      revision: 1,
      body: 'Two',
    });
    await expect(
      service.reviseDraft({ draftId: r.draft_id, revision: 1, body: 'Three' }),
    ).rejects.toThrow(/this draft changed[\s\S]*revision 2[\s\S]*Two/);
  });

  it('keeps the grounded recipients of a reply', async () => {
    const r = await service.draftReply({ documentId: docId, body: 'One' });
    await expect(
      service.reviseDraft({
        draftId: r.draft_id,
        revision: 1,
        to: ['evil@example.com'],
      }),
    ).rejects.toThrow(/recipients of a reply/);
  });

  it('changes recipients of a new message', async () => {
    const r = await service.draftMessage({
      accountId,
      to: ['bob@example.com'],
      subject: 'Hi',
      body: 'Hello',
    });
    const v = await service.reviseDraft({
      draftId: r.draft_id,
      revision: 1,
      to: ['ann@example.com'],
    });
    expect(v.to).toEqual(['ann@example.com']);
    expect(v.recipient_display).toBe('ann@example.com');
  });

  it('refuses to revise a draft that is no longer pending', async () => {
    const r = await service.draftReply({ documentId: docId, body: 'One' });
    await service.discardById(r.draft_id);
    await expect(
      service.reviseDraft({ draftId: r.draft_id, revision: 1, body: 'x' }),
    ).rejects.toThrow(/discarded[\s\S]*create a new draft/);
  });

  it('serializes two concurrent revises of one revision: one wins', async () => {
    const r = await service.draftReply({ documentId: docId, body: 'One' });
    const results = await Promise.allSettled([
      service.reviseDraft({ draftId: r.draft_id, revision: 1, body: 'A' }),
      service.reviseDraft({ draftId: r.draft_id, revision: 1, body: 'B' }),
    ]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect((await store.outbox.get(r.draft_id))?.revision).toBe(2);
  });

  it('a confirm at an old revision answers changed and sends nothing', async () => {
    const r = await service.draftReply({ documentId: docId, body: 'One' });
    const token = tokenOf(r.confirm_url!);
    await service.reviseDraft({
      draftId: r.draft_id,
      revision: 1,
      body: 'Two',
    });
    const out = await service.confirmByToken(token, 1);
    expect(out.kind).toBe('changed');
    expect(sendMock).not.toHaveBeenCalled();
    expect((await service.confirmByToken(token, null)).kind).toBe('changed');
    const ok = await service.confirmByToken(token, 2);
    expect(ok.kind).toBe('sent');
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ bodyMarkdown: 'Two' }),
    );
  });

  it('sendById needs the shown revision', async () => {
    const r = await service.draftReply({ documentId: docId, body: 'One' });
    expect((await service.sendById(r.draft_id, 0)).kind).toBe('changed');
    expect((await service.sendById(r.draft_id, 1)).kind).toBe('sent');
  });

  it('send_draft (chat mode) refuses an old revision with the current draft', async () => {
    make('chat');
    await store.setAccountConfig(accountId, {
      ...IMAP_CFG,
      outbound: { mode: 'chat' },
    });
    const r = await service.draftReply({ documentId: docId, body: 'One' });
    await service.reviseDraft({
      draftId: r.draft_id,
      revision: 1,
      body: 'Two',
    });
    await expect(
      service.sendDraft({ draftId: r.draft_id, revision: 1 }),
    ).rejects.toThrow(/this draft changed[\s\S]*Two/);
    expect(sendMock).not.toHaveBeenCalled();
    const sent = await service.sendDraft({ draftId: r.draft_id, revision: 2 });
    expect(sent.status).toBe('sent');
  });

  it('reopens a provably failed draft as a new revision; an uncertain one stays', async () => {
    sendMock.mockRejectedValueOnce(new Error('rate-limited: slow down'));
    const r = await service.draftReply({ documentId: docId, body: 'One' });
    expect((await service.sendById(r.draft_id, 1)).kind).toBe('failed');
    const back = await service.reopenById(r.draft_id);
    expect(back).toMatchObject({ status: 'draft', revision: 2, error: null });

    sendMock.mockRejectedValueOnce(new Error('socket hang up'));
    expect((await service.sendById(r.draft_id, 2)).kind).toBe('failed');
    expect(await service.reopenById(r.draft_id)).toBeNull();
  });

  it('a failed row is not re-sent by a confirm; Try again goes through reopen', async () => {
    sendMock.mockRejectedValueOnce(new Error('rate-limited: slow down'));
    const r = await service.draftReply({ documentId: docId, body: 'One' });
    await service.sendById(r.draft_id, 1);
    expect((await service.sendById(r.draft_id, 1)).kind).toBe('already');
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('list_outbox gives pending drafts their revision and full draft', async () => {
    const r = await service.draftReply({ documentId: docId, body: 'One' });
    const [item] = await service.listOutbox({});
    expect(item.draft_id).toBe(r.draft_id);
    expect(item.revision).toBe(1);
    expect(item.draft).toMatchObject({ body: 'One', revision: 1 });
    expect(verifyConfirmToken).toBeDefined();
  });

  it('the chat instruction says to revise, never to draft again', async () => {
    make('chat');
    await store.setAccountConfig(accountId, {
      ...IMAP_CFG,
      outbound: { mode: 'chat' },
    });
    const r = await service.draftReply({ documentId: docId, body: 'One' });
    expect(r.instruction).toMatch(/revise_draft/);
    expect(r.instruction).not.toMatch(/create a new draft/i);
  });

  it('the agent transport can revise but still never holds a confirm link', async () => {
    const r = await runWithTransport('agent', () =>
      service.draftReply({ documentId: docId, body: 'One' }),
    );
    const v = await runWithTransport('agent', () =>
      service.reviseDraft({ draftId: r.draft_id, revision: 1, body: 'Two' }),
    );
    expect(v.revision).toBe(2);
    expect(v.confirm_url).toBeUndefined();
  });
});
