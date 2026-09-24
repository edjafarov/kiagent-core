import Database from 'better-sqlite3';

import { migrate } from '../schema';

describe('attention schema migration', () => {
  it('x: creates exact attention schemas and records the head version', () => {
    const db = new Database(':memory:');
    try {
      migrate(db);
      const names = (
        db
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name LIKE 'attention_%'
             ORDER BY name`,
          )
          .all() as Array<{ name: string }>
      ).map((row) => row.name);
      expect(names).toEqual(['attention_items', 'attention_revisions']);
      expect(
        (
          db.prepare(`PRAGMA table_info(attention_items)`).all() as Array<{
            name: string;
          }>
        ).map((row) => row.name),
      ).toEqual([
        'id',
        'producer',
        'payload_json',
        'state',
        'revision',
        'transition_at',
      ]);
      expect(
        (
          db.prepare(`PRAGMA table_info(attention_revisions)`).all() as Array<{
            name: string;
          }>
        ).map((row) => row.name),
      ).toEqual([
        'id',
        'producer',
        'revision',
        'state',
        'resolved_by',
        'transition_at',
      ]);
      expect(
        (
          db.prepare(`PRAGMA table_info(attention_items)`).all() as Array<{
            name: string;
            type: string;
            notnull: number;
            pk: number;
          }>
        ).map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk })),
      ).toEqual([
        { name: 'id', type: 'TEXT', notnull: 0, pk: 1 },
        { name: 'producer', type: 'TEXT', notnull: 1, pk: 0 },
        { name: 'payload_json', type: 'TEXT', notnull: 1, pk: 0 },
        { name: 'state', type: 'TEXT', notnull: 1, pk: 0 },
        { name: 'revision', type: 'INTEGER', notnull: 1, pk: 0 },
        { name: 'transition_at', type: 'INTEGER', notnull: 1, pk: 0 },
      ]);
      expect(
        (
          db.prepare(`PRAGMA table_info(attention_revisions)`).all() as Array<{
            name: string;
            type: string;
            notnull: number;
            pk: number;
          }>
        ).map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk })),
      ).toEqual([
        { name: 'id', type: 'TEXT', notnull: 0, pk: 1 },
        { name: 'producer', type: 'TEXT', notnull: 1, pk: 0 },
        { name: 'revision', type: 'INTEGER', notnull: 1, pk: 0 },
        { name: 'state', type: 'TEXT', notnull: 1, pk: 0 },
        { name: 'resolved_by', type: 'TEXT', notnull: 0, pk: 0 },
        { name: 'transition_at', type: 'INTEGER', notnull: 1, pk: 0 },
      ]);
      expect(
        db.prepare(`SELECT value FROM meta WHERE key='schemaVersion'`).get(),
      ).toEqual({ value: '5' });
    } finally {
      db.close();
    }
  });

  it('x: upgrades a v3 corpus without losing data and is a no-op at v4', () => {
    const db = new Database(':memory:');
    try {
      migrate(db);
      db.prepare(
        `INSERT INTO accounts (id, source, identifier, status, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        'acc-migration',
        'local-folder',
        'migration',
        'active',
        '2026-01-01',
      );
      db.prepare(
        `INSERT INTO documents
          (id, account_id, external_id, type, title, markdown, metadata,
           content_hash, ingested_at, updated_at, scope_root_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'doc-migration',
        'acc-migration',
        'external-migration',
        'note',
        'Migration corpus row',
        'Preserve me',
        '{}',
        'hash-migration',
        '2026-01-01',
        '2026-01-01',
        null,
      );
      db.exec('DROP TABLE attention_revisions; DROP TABLE attention_items;');
      db.prepare(`UPDATE meta SET value='3' WHERE key='schemaVersion'`).run();

      migrate(db);
      expect(
        db.prepare(`SELECT value FROM meta WHERE key='schemaVersion'`).get(),
      ).toEqual({ value: '5' });
      expect(
        db
          .prepare(
            `SELECT title, markdown, scope_root_id FROM documents WHERE id=?`,
          )
          .get('doc-migration'),
      ).toEqual({
        title: 'Migration corpus row',
        markdown: 'Preserve me',
        scope_root_id: null,
      });
      const firstSchema = db
        .prepare(
          `SELECT name, sql FROM sqlite_master WHERE name LIKE 'attention_%' ORDER BY name`,
        )
        .all();
      const firstDocument = db
        .prepare(`SELECT * FROM documents WHERE id=?`)
        .get('doc-migration');

      migrate(db);
      expect(
        db.prepare(`SELECT value FROM meta WHERE key='schemaVersion'`).get(),
      ).toEqual({ value: '5' });
      expect(
        db
          .prepare(
            `SELECT name, sql FROM sqlite_master WHERE name LIKE 'attention_%' ORDER BY name`,
          )
          .all(),
      ).toEqual(firstSchema);
      expect(
        db.prepare(`SELECT * FROM documents WHERE id=?`).get('doc-migration'),
      ).toEqual(firstDocument);
    } finally {
      db.close();
    }
  });
});
