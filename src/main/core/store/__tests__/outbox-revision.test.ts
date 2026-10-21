import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

import type { AccountId } from '@shared/contracts';

import { openDb } from '../../../db/app-db';
import { migrate } from '../schema';
import { openStore, type CoreStore } from '../store';
import { normalizeSnapshot, type OutboxDraftInput } from '../outbox';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};

describe('outbox v10 migration', () => {
  it('adds revision, bcc, attachments, mirror and send_at; old rows read defaults', () => {
    const db = new Database(':memory:');
    try {
      migrate(db);
      for (const c of [
        'revision',
        'bcc_json',
        'attachments_json',
        'mirror_json',
        'send_at',
      ])
        db.exec(`ALTER TABLE outbox DROP COLUMN ${c}`);
      db.prepare(`UPDATE meta SET value='9' WHERE key='schemaVersion'`).run();
      db.prepare(
        `INSERT INTO accounts(id, source, identifier, config, status, created_at)
         VALUES('acc', 'test', 'me@x', '{}', 'live', '2026-01-01')`,
      ).run();
      db.prepare(
        `INSERT INTO outbox (id, account_id, kind, recipient_display, to_json,
           cc_json, body_markdown, confirm_mode, status, created_via,
           created_at, expires_at)
         VALUES ('old', 'acc', 'new', 'Sam', '["sam@x"]', '[]', 'hi',
           'review', 'sent', 'mcp-local', '2026-01-01', '2026-01-02')`,
      ).run();

      migrate(db);
      expect(
        db.prepare(`SELECT value FROM meta WHERE key='schemaVersion'`).get(),
      ).toEqual({ value: '12' });
      expect(
        db
          .prepare(
            `SELECT revision, bcc_json, attachments_json, mirror_json, send_at
               FROM outbox WHERE id='old'`,
          )
          .get(),
      ).toEqual({
        revision: 1,
        bcc_json: '[]',
        attachments_json: '[]',
        mirror_json: null,
        send_at: null,
      });
    } finally {
      db.close();
    }
  });

  it('v11 adds suggested_send_at; old rows read NULL, and a re-run is a no-op', () => {
    const db = new Database(':memory:');
    try {
      migrate(db);
      db.exec(`ALTER TABLE outbox DROP COLUMN suggested_send_at`);
      db.prepare(`UPDATE meta SET value='10' WHERE key='schemaVersion'`).run();
      db.prepare(
        `INSERT INTO accounts(id, source, identifier, config, status, created_at)
         VALUES('acc', 'test', 'me@x', '{}', 'live', '2026-01-01')`,
      ).run();
      db.prepare(
        `INSERT INTO outbox (id, account_id, kind, recipient_display, to_json,
           cc_json, body_markdown, confirm_mode, status, created_via,
           created_at, expires_at)
         VALUES ('old', 'acc', 'new', 'Sam', '["sam@x"]', '[]', 'hi',
           'review', 'draft', 'mcp-local', '2026-01-01', '2026-01-02')`,
      ).run();
      migrate(db);
      migrate(db);
      expect(
        db.prepare(`SELECT value FROM meta WHERE key='schemaVersion'`).get(),
      ).toEqual({ value: '12' });
      expect(
        db.prepare(`SELECT suggested_send_at FROM outbox WHERE id='old'`).get(),
      ).toEqual({ suggested_send_at: null });
    } finally {
      db.close();
    }
  });
});

describe('outbox revisions', () => {
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

  const snapshot = (over: Record<string, unknown> = {}) => ({
    to: ['bob@example.com'],
    cc: [],
    bcc: [],
    subject: 'Hi',
    bodyMarkdown: 'Hello Bob',
    attachments: [],
    ...over,
  });

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-outbox-rev-'));
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

  it('a new row starts at revision 1 with empty bcc/attachments and no mirror', async () => {
    const row = await store.outbox.create(draft());
    expect(row).toMatchObject({
      revision: 1,
      bcc: [],
      attachments: [],
      mirror: null,
      sendAt: null,
    });
  });

  it('applyContent with the same content changes nothing', async () => {
    const row = await store.outbox.create(draft());
    const r = await store.outbox.applyContent(row.id, snapshot());
    expect(r.changed).toBe(false);
    expect(r.row.revision).toBe(1);
  });

  it('ignores whitespace and address case when comparing', async () => {
    const row = await store.outbox.create(
      draft({ bodyMarkdown: 'a\nb', to: ['bob@example.com'] }),
    );
    const r = await store.outbox.applyContent(
      row.id,
      snapshot({ bodyMarkdown: 'a  \r\nb\n', to: ['Bob@Example.com'] }),
    );
    expect(r.changed).toBe(false);
    expect(r.row.revision).toBe(1);
  });

  it('a different body bumps the revision, clears send_at and recomputes the display', async () => {
    const row = await store.outbox.create(draft());
    await store.outbox.schedule(row.id, '2099-01-01T10:00:00.000Z');
    const r = await store.outbox.applyContent(
      row.id,
      snapshot({ bodyMarkdown: 'Shorter', to: ['ann@example.com'] }),
    );
    expect(r.changed).toBe(true);
    expect(r.row).toMatchObject({
      revision: 2,
      bodyMarkdown: 'Shorter',
      to: ['ann@example.com'],
      recipientDisplay: 'ann@example.com',
      sendAt: null,
    });
  });

  it('a reply keeps its display while the recipients stay the same', async () => {
    const row = await store.outbox.create(
      draft({ kind: 'reply', recipientDisplay: 'Bob Builder' }),
    );
    const r = await store.outbox.applyContent(
      row.id,
      snapshot({ bodyMarkdown: 'Changed' }),
    );
    expect(r.row.recipientDisplay).toBe('Bob Builder');
  });

  it("a reply that left its subject to the provider takes the provider's on create, without a new revision", async () => {
    // Outlook replies: Kia sends no subject, createReply writes "RE: …".
    const row = await store.outbox.create(
      draft({ kind: 'reply', subject: null }),
    );
    const ref = { accountId, id: 'ol-1', threadId: 'c-1' };
    const r = await store.outbox.applyContent(
      row.id,
      snapshot({ subject: 'RE: Hi' }),
      ref,
      { from: 'created' },
    );
    expect(r.changed).toBe(false);
    expect(r.row).toMatchObject({ revision: 1, subject: 'RE: Hi' });
    expect(r.row.mirror).toEqual({ ref });
    // Once it has one, a subject edit in the provider is an edit.
    const r2 = await store.outbox.applyContent(
      row.id,
      snapshot({ subject: 'RE: Hi there' }),
      ref,
      { from: 'provider' },
    );
    expect(r2.row).toMatchObject({ revision: 2, subject: 'RE: Hi there' });
    // A later read (the create's own read failed) is an edit: the user may
    // have typed that subject, and an open confirmation must not send it.
    const late = await store.outbox.create(
      draft({ kind: 'reply', subject: null }),
    );
    const r3 = await store.outbox.applyContent(
      late.id,
      snapshot({ subject: 'RE: Hi' }),
      ref,
      { from: 'provider' },
    );
    expect(r3.row.revision).toBe(2);
    // Kia's own edit to a null subject stays an edit.
    const own = await store.outbox.create(
      draft({ kind: 'reply', subject: null }),
    );
    const r4 = await store.outbox.applyContent(
      own.id,
      snapshot({ subject: 'Re: Hi' }),
    );
    expect(r4.row.revision).toBe(2);
  });

  it("a file keeps Kia's size while the provider repeats its own count; another size is a replaced file", async () => {
    const att = {
      filename: 'offer.pdf',
      mime: 'application/pdf',
      size: 6,
      from: { kind: 'document' as const, documentId: 'd1' },
    };
    const row = await store.outbox.create(draft({ attachments: [att] }));
    const ref = { accountId, id: 'ol-1' };
    const seen = (size: number) =>
      snapshot({
        attachments: [{ filename: 'offer.pdf', mime: 'application/pdf', size }],
      });
    // The upload's own read: Kia's file by name, whatever Outlook counts.
    const up = await store.outbox.applyContent(row.id, seen(164), ref, {
      origins: [att],
      from: 'provider',
    });
    expect(up.row).toMatchObject({ revision: 1, attachments: [att] });
    expect(up.row.mirror?.sizes).toEqual({ 'offer.pdf': 164 });
    // A refresh with the same count: still Kia's file.
    const same = await store.outbox.applyContent(row.id, seen(164), ref, {
      from: 'provider',
    });
    expect(same.row).toMatchObject({ revision: 1, attachments: [att] });
    // Replaced in Outlook with another offer.pdf: an edit, not Kia's file.
    const swapped = await store.outbox.applyContent(row.id, seen(900), ref, {
      from: 'provider',
    });
    expect(swapped.row.revision).toBe(2);
    expect(swapped.row.attachments).toEqual([
      { filename: 'offer.pdf', mime: 'application/pdf', size: 900 },
    ]);
  });

  it('a paragraph break is an edit from the provider; a re-wrap is not', () => {
    const key = (bodyMarkdown: string) =>
      normalizeSnapshot(snapshot({ bodyMarkdown }), { provider: true });
    expect(key('Hello Bob, how are you')).toBe(
      key('Hello Bob,\nhow are  you\n'),
    );
    expect(key('Hello Bob, how are you')).not.toBe(
      key('Hello Bob,\n\nhow are you'),
    );
    expect(key('a\n\nb')).toBe(key('a\r\n \r\nb'));
  });

  it('stores a ref without a revision bump when the content is the same', async () => {
    const row = await store.outbox.create(draft());
    const ref = { accountId, id: 'gm-1', threadId: 't-1' };
    const r = await store.outbox.applyContent(row.id, snapshot(), ref);
    expect(r.changed).toBe(false);
    expect(r.row.revision).toBe(1);
    expect(r.row.mirror).toEqual({ ref });
  });

  it('attachments compare by filename and size', async () => {
    const att = { filename: 'a.pdf', mime: 'application/pdf', size: 10 };
    const row = await store.outbox.create(draft({ attachments: [att] }));
    const same = await store.outbox.applyContent(
      row.id,
      snapshot({ attachments: [{ ...att, mime: 'application/octet-stream' }] }),
    );
    expect(same.changed).toBe(false);
    const bigger = await store.outbox.applyContent(
      row.id,
      snapshot({ attachments: [{ ...att, size: 11 }] }),
    );
    expect(bigger.changed).toBe(true);
    expect(bigger.row.attachments).toEqual([{ ...att, size: 11 }]);
  });

  it('a readback without `from` keeps where Kia got each file', async () => {
    const att = {
      filename: 'a.pdf',
      mime: 'application/pdf',
      size: 10,
      from: { kind: 'document' as const, documentId: 'd1' },
    };
    const row = await store.outbox.create(draft({ attachments: [att] }));
    const r = await store.outbox.applyContent(
      row.id,
      snapshot({
        bodyMarkdown: 'changed in Gmail',
        attachments: [
          { filename: 'a.pdf', mime: 'application/pdf', size: 10 },
          { filename: 'b.png', mime: 'image/png', size: 5 },
        ],
      }),
    );
    expect(r.row.attachments).toEqual([
      att,
      { filename: 'b.png', mime: 'image/png', size: 5 },
    ]);
  });

  it('refuses to change a row that is no longer a draft', async () => {
    const row = await store.outbox.create(draft());
    await store.outbox.transition(row.id, ['draft'], 'discarded');
    await expect(
      store.outbox.applyContent(row.id, snapshot({ bodyMarkdown: 'x' })),
    ).rejects.toThrow('outbox: not a draft');
  });

  it('reopen brings a failed row back as a new revision', async () => {
    const row = await store.outbox.create(draft());
    await store.outbox.transition(row.id, ['draft'], 'sending');
    await store.outbox.transition(row.id, ['sending'], 'failed', {
      error: 'rate-limited: try later',
    });
    const back = await store.outbox.reopen(row.id, '2099-02-01T00:00:00.000Z');
    expect(back).toMatchObject({
      status: 'draft',
      error: null,
      revision: 2,
      sendAt: null,
      expiresAt: '2099-02-01T00:00:00.000Z',
    });
  });

  it('reopen leaves a sent row alone', async () => {
    const row = await store.outbox.create(draft());
    await store.outbox.transition(row.id, ['draft'], 'sending');
    await store.outbox.transition(row.id, ['sending'], 'sent');
    expect(await store.outbox.reopen(row.id, '2099-02-01')).toBeNull();
  });

  it('schedule sets send_at without a revision bump, only on drafts', async () => {
    const row = await store.outbox.create(draft());
    expect(await store.outbox.schedule(row.id, '2099-01-01T10:00:00Z')).toBe(
      true,
    );
    const got = await store.outbox.get(row.id);
    expect(got).toMatchObject({ sendAt: '2099-01-01T10:00:00Z', revision: 1 });
    await store.outbox.transition(row.id, ['draft'], 'discarded');
    expect(await store.outbox.schedule(row.id, null)).toBe(false);
  });

  it('a cancelled or edited schedule gives the draft a fresh wait, not a lapsed one', async () => {
    const past = '2000-01-01T00:00:00.000Z';
    const cancelled = await store.outbox.create(draft({ expiresAt: past }));
    await store.outbox.schedule(cancelled.id, '2099-01-01T00:00:00Z');
    await store.outbox.schedule(cancelled.id, null);
    const edited = await store.outbox.create(draft({ expiresAt: past }));
    await store.outbox.schedule(edited.id, '2099-01-01T00:00:00Z');
    await store.outbox.applyContent(
      edited.id,
      snapshot({ bodyMarkdown: 'new' }),
    );
    await store.outbox.expireOverdue();
    for (const id of [cancelled.id, edited.id])
      expect((await store.outbox.get(id))?.status).toBe('draft');
    expect((await store.outbox.get(edited.id))?.error).toBe(
      'Edited — schedule again',
    );
    // An unscheduled draft keeps its own expiry.
    const plain = await store.outbox.create(draft({ expiresAt: past }));
    await store.outbox.schedule(plain.id, null);
    await store.outbox.expireOverdue();
    expect((await store.outbox.get(plain.id))?.status).toBe('expired');
  });

  it('leaving draft drops its schedule note unless the move brings one', async () => {
    const missed = await store.outbox.create(draft());
    await store.outbox.schedule(missed.id, '2099-01-01T00:00:00Z');
    await store.outbox.missSchedule(
      missed.id,
      '2099-01-01T00:00:00Z',
      '2099-02-01T00:00:00Z',
    );
    expect((await store.outbox.get(missed.id))?.error).toBeTruthy();
    await store.outbox.transition(missed.id, ['draft'], 'discarded');
    expect((await store.outbox.get(missed.id))?.error).toBeNull();
    const deleted = await store.outbox.create(draft());
    await store.outbox.transition(deleted.id, ['draft'], 'discarded', {
      error: 'Deleted in Gmail',
    });
    expect((await store.outbox.get(deleted.id))?.error).toBe(
      'Deleted in Gmail',
    );
  });

  it('scheduled and mirrored drafts never expire; mirrored ones skip the cap', async () => {
    const past = '2000-01-01T00:00:00.000Z';
    const plain = await store.outbox.create(draft({ expiresAt: past }));
    const scheduled = await store.outbox.create(draft({ expiresAt: past }));
    await store.outbox.schedule(scheduled.id, '2099-01-01T00:00:00Z');
    const mirrored = await store.outbox.create(draft({ expiresAt: past }));
    await store.outbox.setMirror(mirrored.id, {
      ref: { accountId, id: 'gm-2' },
    });
    await store.outbox.expireOverdue();
    expect((await store.outbox.get(plain.id))?.status).toBe('expired');
    expect((await store.outbox.get(scheduled.id))?.status).toBe('draft');
    expect((await store.outbox.get(mirrored.id))?.status).toBe('draft');
    // scheduled counts (unmirrored), mirrored does not
    expect(await store.outbox.countDrafts(accountId)).toBe(1);
  });

  it('a mirror without a ref (create failed) still expires and counts', async () => {
    const row = await store.outbox.create(
      draft({ expiresAt: '2000-01-01T00:00:00.000Z' }),
    );
    await store.outbox.setMirror(row.id, { ref: null, error: 'offline' });
    expect(await store.outbox.countDrafts(accountId)).toBe(1);
    await store.outbox.expireOverdue();
    expect((await store.outbox.get(row.id))?.status).toBe('expired');
  });

  it('a change of line breaks is an edit from Kia, not from the provider', () => {
    const a = snapshot({
      bodyMarkdown: 'one two\nthree',
      to: ['ann@x.example'],
    });
    const b = snapshot({
      bodyMarkdown: 'one\ntwo three',
      to: ['Ann <ANN@x.example>'],
    });
    expect(normalizeSnapshot(a)).not.toBe(normalizeSnapshot(b));
    expect(normalizeSnapshot(a, { provider: true })).toBe(
      normalizeSnapshot(b, { provider: true }),
    );
    // Addresses compare by mailbox either way.
    expect(normalizeSnapshot(a)).toBe(
      normalizeSnapshot(
        snapshot({
          bodyMarkdown: 'one two\nthree',
          to: ['Ann <ann@x.example>'],
        }),
      ),
    );
  });

  it('normalizeSnapshot is stable under attachment order', () => {
    const a = { filename: 'a', mime: 'x', size: 1 };
    const b = { filename: 'b', mime: 'x', size: 2 };
    expect(normalizeSnapshot(snapshot({ attachments: [a, b] }))).toBe(
      normalizeSnapshot(snapshot({ attachments: [b, a] })),
    );
  });
});
