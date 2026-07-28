import fs from 'fs';
import os from 'os';
import path from 'path';

import type { AccountId } from '@shared/contracts';

import { openDb, type AppDb } from '../../../db/app-db';
import { openStore, type CoreStore } from '../store';
import { OUTBOX_PENDING_CAP, type OutboxDraftInput } from '../outbox';

describe('outbox schema', () => {
  let dir: string;
  let db: AppDb;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-outbox-'));
    db = await openDb(path.join(dir, 'test.db'));
  });

  afterEach(async () => {
    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates the outbox table with the expected columns', async () => {
    const cols = (await db.all(`PRAGMA table_info(outbox)`)).map(
      (r) => r.name as string,
    );
    expect(cols).toEqual([
      'id',
      'account_id',
      'kind',
      'reply_to_document_id',
      'outbound_ref',
      'recipient_display',
      'to_json',
      'cc_json',
      'subject',
      'body_markdown',
      'threading_json',
      'confirm_mode',
      'status',
      'error',
      'external_message_id',
      'created_via',
      'created_at',
      'sent_at',
      'expires_at',
    ]);
  });

  it('rejects a status outside the state machine', async () => {
    await expect(
      db.run(
        `INSERT INTO outbox (id, account_id, kind, recipient_display,
           body_markdown, confirm_mode, status, created_via, created_at, expires_at)
         VALUES ('x', 'a', 'new', 'r', 'b', 'review', 'bogus', 'mcp-local', 't', 't')`,
      ),
    ).rejects.toThrow(/CHECK/);
  });

  it('accepts chat as a confirm mode', async () => {
    // The only INSERT here that clears every CHECK, so it is also the only one
    // that reaches the account_id foreign key — give it a parent row.
    await db.run(
      `INSERT INTO accounts (id, source, identifier, status, created_at)
       VALUES ('a', 'imap', 'me@example.com', 'idle', 't')`,
    );
    await expect(
      db.run(
        `INSERT INTO outbox (id, account_id, kind, recipient_display,
           body_markdown, confirm_mode, status, created_via, created_at, expires_at)
         VALUES ('c1', 'a', 'new', 'r', 'b', 'chat', 'draft', 'mcp-local', 't', 't')`,
      ),
    ).resolves.not.toThrow();
  });

  it('still rejects unknown confirm modes after the rebuild', async () => {
    await expect(
      db.run(
        `INSERT INTO outbox (id, account_id, kind, recipient_display,
           body_markdown, confirm_mode, status, created_via, created_at, expires_at)
         VALUES ('c2', 'a', 'new', 'r', 'b', 'bogus', 'draft', 'mcp-local', 't', 't')`,
      ),
    ).rejects.toThrow(/CHECK/);
  });

  it('keeps the account-status index across the rebuild', async () => {
    const idx = (await db.all(`PRAGMA index_list(outbox)`)).map(
      (r) => r.name as string,
    );
    expect(idx).toContain('idx_outbox_account_status');
  });
});

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};

describe('outbox store', () => {
  let dir: string;
  let store: CoreStore;
  let accountId: AccountId;

  const draft = (over: Partial<OutboxDraftInput> = {}): OutboxDraftInput => ({
    accountId,
    kind: 'new',
    recipientDisplay: 'bob@example.com',
    to: ['bob@example.com'],
    cc: [],
    subject: 'Hi',
    bodyMarkdown: 'Hello Bob',
    confirmMode: 'review',
    createdVia: 'mcp-local',
    expiresAt: '2099-01-01T00:00:00.000Z',
    ...over,
  });

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-outbox-'));
    store = openStore(await openDb(path.join(dir, 'test.db')), deps);
    const account = await store.createAccount({
      source: 'imap',
      identifier: 'me@example.com@imap.example.com',
    });
    accountId = account.id;
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates and reads back a draft row', async () => {
    const row = await store.outbox.create(draft());
    expect(row.status).toBe('draft');
    expect(row.to).toEqual(['bob@example.com']);
    expect(row.confirmMode).toBe('review');
    const back = await store.outbox.get(row.id);
    expect(back).toEqual(row);
  });

  it('freezes the confirm mode per row', async () => {
    const row = await store.outbox.create(draft({ confirmMode: 'link' }));
    expect((await store.outbox.get(row.id))?.confirmMode).toBe('link');
  });

  it('recoverOrphanedSending moves sending rows to delivery_unknown', async () => {
    const row = await store.outbox.create(draft());
    await store.outbox.transition(row.id, ['draft'], 'sending');
    await store.outbox.recoverOrphanedSending();
    const back = await store.outbox.get(row.id);
    expect(back?.status).toBe('delivery_unknown');
    expect(back?.error).toMatch(/may have been sent/i);
    // Terminal rows are untouched.
    const sent = await store.outbox.create(draft());
    await store.outbox.transition(sent.id, ['draft'], 'sent');
    await store.outbox.recoverOrphanedSending();
    expect((await store.outbox.get(sent.id))?.status).toBe('sent');
  });

  it('round-trips threading and outboundRef JSON', async () => {
    const row = await store.outbox.create(
      draft({
        kind: 'reply',
        outboundRef: { channel: 'C123' },
        threading: { inReplyTo: '<m1@x>' },
      }),
    );
    const back = await store.outbox.get(row.id);
    expect(back?.outboundRef).toEqual({ channel: 'C123' });
    expect(back?.threading).toEqual({ inReplyTo: '<m1@x>' });
  });

  it('transition is an atomic compare-and-set', async () => {
    const row = await store.outbox.create(draft());
    expect(await store.outbox.transition(row.id, ['draft'], 'sending')).toBe(
      true,
    );
    // Second attempt from 'draft' must lose: the row is already 'sending'.
    expect(await store.outbox.transition(row.id, ['draft'], 'sending')).toBe(
      false,
    );
    expect(
      await store.outbox.transition(row.id, ['sending'], 'sent', {
        sentAt: '2026-07-23T12:00:00.000Z',
        externalMessageId: '<out@x>',
      }),
    ).toBe(true);
    const back = await store.outbox.get(row.id);
    expect(back?.status).toBe('sent');
    expect(back?.externalMessageId).toBe('<out@x>');
    expect(back?.sentAt).toBe('2026-07-23T12:00:00.000Z');
  });

  it('a patch field of null leaves the previously stored value unchanged', async () => {
    const row = await store.outbox.create(draft());
    await store.outbox.transition(row.id, ['draft'], 'failed', {
      error: 'boom',
    });
    expect((await store.outbox.get(row.id))?.error).toBe('boom');
    // failed -> discarded is a legal status value per the CHECK constraint;
    // passing error: null must NOT clear the previously recorded error.
    await store.outbox.transition(row.id, ['failed'], 'discarded', {
      error: null,
    });
    const back = await store.outbox.get(row.id);
    expect(back?.status).toBe('discarded');
    expect(back?.error).toBe('boom');
  });

  it('enforces the per-account pending cap', async () => {
    for (let i = 0; i < OUTBOX_PENDING_CAP; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await store.outbox.create(draft());
    }
    await expect(store.outbox.create(draft())).rejects.toThrow(/pending/i);
    // Non-draft rows don't count against the cap.
    const rows = await store.outbox.listRecent(OUTBOX_PENDING_CAP);
    await store.outbox.transition(rows[0].id, ['draft'], 'discarded');
    await expect(store.outbox.create(draft())).resolves.toBeTruthy();
  });

  it('expireOverdue moves overdue drafts to expired', async () => {
    const row = await store.outbox.create(
      draft({ expiresAt: '2000-01-01T00:00:00.000Z' }),
    );
    await store.outbox.expireOverdue();
    expect((await store.outbox.get(row.id))?.status).toBe('expired');
  });

  it('countSentSince counts only sent rows inside the window', async () => {
    const a = await store.outbox.create(draft());
    const b = await store.outbox.create(draft());
    await store.outbox.create(draft()); // stays a draft
    await store.outbox.transition(a.id, ['draft'], 'sending');
    await store.outbox.transition(a.id, ['sending'], 'sent', {
      sentAt: '2026-07-26T10:30:00.000Z',
    });
    await store.outbox.transition(b.id, ['draft'], 'sending');
    await store.outbox.transition(b.id, ['sending'], 'sent', {
      sentAt: '2026-07-26T09:00:00.000Z', // outside the window below
    });
    expect(
      await store.outbox.countSentSince(accountId, '2026-07-26T10:00:00.000Z'),
    ).toBe(1);
    expect(
      await store.outbox.countSentSince(accountId, '2026-07-26T08:00:00.000Z'),
    ).toBe(2);
  });

  it('stores and returns chat confirm mode', async () => {
    const row = await store.outbox.create(draft({ confirmMode: 'chat' }));
    expect((await store.outbox.get(row.id))?.confirmMode).toBe('chat');
  });

  it('secret is stable across calls and 32 bytes', async () => {
    const a = await store.outbox.secret();
    const b = await store.outbox.secret();
    expect(a.length).toBe(32);
    expect(a.equals(b)).toBe(true);
  });
});
