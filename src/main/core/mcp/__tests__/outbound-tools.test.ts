import fs from 'fs';
import os from 'os';
import path from 'path';

import type {
  AccountId,
  ConfirmMode,
  DocumentInput,
  Prefs,
  Sender,
} from '@shared/contracts';

import { openDb } from '../../../db/app-db';
import { openStore, type CoreStore } from '../../store/store';
import { createOutboundService } from '../../../outbound/service';
import { buildBuiltinTools } from '../tools';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};
const logSink = { log: () => {} };
// Chat confirmation is a GLOBAL Settings opt-in (decision 2026-07-27), so the
// prefs fake — not per-account config — is how these tests turn it on. Mutable
// and reset to 'review' in beforeEach so one chat test can't leak into the
// page-confirm ones.
let defaultMode: ConfirmMode = 'review';
const fakePrefs = {
  get: () => ({ outbound: { defaultMode } }) as ReturnType<Prefs['get']>,
  patch: async () => {},
  onChange: () => () => {},
} as unknown as Prefs;

describe('outbound MCP tools', () => {
  let dir: string;
  let store: CoreStore;
  let accountId: AccountId;
  let docId: string;
  let tools: ReturnType<typeof buildBuiltinTools>;

  const call = (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`no such tool ${name}`);
    return tool.call(args);
  };

  beforeEach(async () => {
    defaultMode = 'review';
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-outtools-'));
    store = openStore(await openDb(path.join(dir, 'test.db')), deps);
    const account = await store.createAccount({
      source: 'imap',
      identifier: 'me@example.com@imap.example.com',
      config: {
        host: 'imap.example.com',
        port: 993,
        secure: true,
        user: 'me@example.com',
      },
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

    const sender: Sender = { send: async () => ({}) };
    const outbound = createOutboundService({
      store,
      prefs: fakePrefs,
      senders: new Map([['imap', sender]]),
      logSink,
    });
    outbound.setBaseUrl('http://127.0.0.1:7421');
    tools = buildBuiltinTools(store.read, outbound);
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('registers the three outbound tools', () => {
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(['draft_reply', 'draft_message', 'list_outbox']),
    );
  });

  it('draft_reply creates a draft and returns a confirm url', async () => {
    const r = (await call('draft_reply', {
      document_id: docId,
      body: 'Thanks!',
    })) as { draft_id: string; confirm_url: string };
    expect(r.confirm_url).toContain('/outbox/confirm/');
    expect((await store.outbox.get(r.draft_id))?.status).toBe('draft');
  });

  it('draft_reply declares and forwards the optional target key', async () => {
    const t = tools.find((x) => x.name === 'draft_reply');
    expect(
      (t!.inputSchema as { properties: Record<string, unknown> }).properties,
    ).toHaveProperty('target');
    // The imap doc stores no per-message targets, so the forwarded key must
    // surface the service's refusal — proving target reaches the service.
    await expect(
      call('draft_reply', { document_id: docId, body: 'x', target: '1719.1' }),
    ).rejects.toThrow(/no per-message reply targets/);
  });

  it('draft_message requires valid recipients', async () => {
    await expect(
      call('draft_message', {
        account_id: accountId,
        to: ['nope'],
        subject: 's',
        body: 'b',
      }),
    ).rejects.toThrow(/nope/);
  });

  it('list_outbox lists drafts newest-first', async () => {
    await call('draft_reply', { document_id: docId, body: 'one' });
    const listing = (await call('list_outbox', {})) as Array<{
      status: string;
    }>;
    expect(listing.length).toBe(1);
    expect(listing[0].status).toBe('draft');
  });

  it('tools are registered but unavailable without an outbound service', async () => {
    const cold = buildBuiltinTools(store.read);
    const names = cold.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['draft_reply']));
    const t = cold.find((x) => x.name === 'draft_reply');
    await expect(t!.call({ document_id: docId, body: 'x' })).rejects.toThrow(
      /unavailable on this transport/i,
    );
  });

  it('digital_memory_info exposes account ids for draft_message', async () => {
    const info = (await call('digital_memory_info')) as {
      accounts: Array<{ id: string; identifier: string }>;
    };
    expect(info.accounts[0].id).toBe(accountId);
  });

  it('send_draft sends a chat-mode draft end to end', async () => {
    defaultMode = 'chat'; // global opt-in
    const draft = (await call('draft_reply', {
      document_id: docId,
      body: 'Yes, works for me.',
    })) as { draft_id: string; confirm_url?: string };
    expect(draft.confirm_url).toBeUndefined();
    const sent = (await call('send_draft', { draft_id: draft.draft_id })) as {
      status: string;
    };
    expect(sent.status).toBe('sent');
    expect((await store.outbox.get(draft.draft_id))?.status).toBe('sent');
  });

  it('send_draft names the mode for non-chat drafts', async () => {
    const draft = (await call('draft_reply', {
      document_id: docId,
      body: 'Hi',
    })) as { draft_id: string };
    await expect(
      call('send_draft', { draft_id: draft.draft_id }),
    ).rejects.toThrow(/chat-mode/);
  });

  it('send_draft is registered but unavailable without an outbound service', async () => {
    const cold = buildBuiltinTools(store.read);
    const t = cold.find((x) => x.name === 'send_draft');
    expect(t).toBeDefined();
    await expect(t!.call({ draft_id: 'x' })).rejects.toThrow(
      /unavailable on this transport/i,
    );
  });
});
