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
      ).toEqual({ value: '10' });
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

  it('normalizeSnapshot is stable under attachment order', () => {
    const a = { filename: 'a', mime: 'x', size: 1 };
    const b = { filename: 'b', mime: 'x', size: 2 };
    expect(normalizeSnapshot(snapshot({ attachments: [a, b] }))).toBe(
      normalizeSnapshot(snapshot({ attachments: [b, a] })),
    );
  });
});
