import Database from 'better-sqlite3';

import { migrate } from '../schema';

// #265 (alpha-cent): v7 records which change inserted each document.
describe('documents.ingest_seq migration (v7)', () => {
  it('adds the column; rows ingested before it read 0, and a re-run is a no-op', () => {
    const db = new Database(':memory:');
    try {
      migrate(db);
      db.exec('ALTER TABLE documents DROP COLUMN ingest_seq');
      db.prepare(`UPDATE meta SET value='6' WHERE key='schemaVersion'`).run();
      db.prepare(
        `INSERT INTO accounts(id, source, identifier, config, status, created_at)
         VALUES('acc', 'test', 'me@x', '{}', 'live', '2026-01-01')`,
      ).run();
      db.prepare(
        `INSERT INTO documents(id, account_id, external_id, type, title, markdown,
           metadata, content_hash, seq, languages, ingested_at, updated_at)
         VALUES('old', 'acc', 'ext', 'note', 'Old', 'body', '{}', 'h', 3, '[]',
           '2026-01-01', '2026-01-01')`,
      ).run();

      migrate(db);
      expect(
        db.prepare(`SELECT value FROM meta WHERE key='schemaVersion'`).get(),
      ).toEqual({ value: '7' });
      expect(
        db
          .prepare(
            `SELECT ingest_seq, seq, title FROM documents WHERE id='old'`,
          )
          .get(),
      ).toEqual({ ingest_seq: 0, seq: 3, title: 'Old' });

      migrate(db);
      expect(
        db.prepare(`SELECT value FROM meta WHERE key='schemaVersion'`).get(),
      ).toEqual({ value: '7' });
    } finally {
      db.close();
    }
  });
});
