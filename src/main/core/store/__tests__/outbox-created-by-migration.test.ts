import Database from 'better-sqlite3';

import { migrate } from '../schema';

// v8 records which MCP client drafted each outbox row.
describe('outbox.created_by migration (v8)', () => {
  it('adds the column; rows drafted before it read NULL, and a re-run is a no-op', () => {
    const db = new Database(':memory:');
    try {
      migrate(db);
      db.exec('ALTER TABLE outbox DROP COLUMN created_by');
      db.prepare(`UPDATE meta SET value='7' WHERE key='schemaVersion'`).run();
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
      const version = () =>
        db.prepare(`SELECT value FROM meta WHERE key='schemaVersion'`).get();
      expect(version()).toEqual({ value: '8' });
      expect(
        db.prepare(`SELECT created_by FROM outbox WHERE id='old'`).get(),
      ).toEqual({ created_by: null });

      migrate(db);
      expect(version()).toEqual({ value: '8' });
    } finally {
      db.close();
    }
  });
});
