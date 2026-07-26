import fs from 'fs';
import os from 'os';
import path from 'path';

import { openDb, type AppDb } from '../../../db/app-db';

describe('outbox schema (migration v4)', () => {
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
});
