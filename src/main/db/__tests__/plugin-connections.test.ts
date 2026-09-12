/** @jest-environment node */
import { openPluginConnection } from '../plugin-connections';
import Database from 'better-sqlite3';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

describe('scoped plugin connection', () => {
  it('only executes registered owned tables and exposes normalized rows', async () => {
    const file = path.join(os.tmpdir(), `plugin-scope-${process.pid}-${Date.now()}.sqlite`);
    const host = new Database(file);
    host.exec('CREATE TABLE "p_6578616d706c652e706c7567696e__items" (id INTEGER PRIMARY KEY, value TEXT); CREATE TABLE "p_6578616d706c652e706c7567696e__new_table"(id INTEGER); CREATE TABLE core_items(v INTEGER); CREATE VIEW "p_6578616d706c652e706c7567696e__items_view" AS SELECT * FROM "p_6578616d706c652e706c7567696e__items"');
    host.close();
    const db = await openPluginConnection(file, {
      pluginId: 'example.plugin',
      tables: ['items', 'new_table'],
      indexes: ['items_idx'],
      views: ['items_view'],
    });
    await db.schemaExec?.('CREATE INDEX {{items_idx}} ON {{items}} (value)');
    await db.schemaExec?.('ALTER TABLE {{items}} ADD COLUMN extra TEXT');
    await db.exec('INSERT INTO {{items}} (id, value) VALUES (?, ?)', [1, 'ok']);
    await expect(db.exec('/*x*/ CREATE TABLE "p_6578616d706c652e706c7567696e__new_table" (id INTEGER)')).rejects.toMatchObject({ code: 'PLUGIN_SQL_DDL_FORBIDDEN' });
    await expect(db.exec('/*x*/ DROP TABLE "p_6578616d706c652e706c7567696e__new_table"')).rejects.toMatchObject({ code: 'PLUGIN_SQL_DDL_FORBIDDEN' });
    await expect(db.exec('/*x*/ ALTER TABLE "p_6578616d706c652e706c7567696e__items" ADD COLUMN extra TEXT')).rejects.toMatchObject({ code: 'PLUGIN_SQL_DDL_FORBIDDEN' });
    await expect(db.exec('/*x*/ SELECT * FROM sqlite_schema')).rejects.toMatchObject({ code: 'PLUGIN_SQL_UNAUTHORIZED' });
    await expect(db.exec('/*x*/ COMMIT')).rejects.toMatchObject({ code: 'PLUGIN_SQL_TRANSACTION_CONTROL' });
    await expect(db.schemaExec?.('CREATE TRIGGER "p_6578616d706c652e706c7567696e__owned_tr" AFTER INSERT ON core_items BEGIN SELECT 1; END')).rejects.toThrow();
    await expect(db.query('SELECT * FROM {{items}}')).resolves.toEqual([
      { id: 1, value: 'ok', extra: null },
    ]);
    await expect(db.query('SELECT * FROM sqlite_master')).rejects.toThrow();
    await expect(db.query('SELECT * FROM {{items_view}}')).resolves.toEqual([{ id: 1, value: 'ok', extra: null }]);
    await expect(db.query('WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < 3) SELECT max(x) AS m, count(*) AS c FROM n')).resolves.toEqual([{ m: 3, c: 3 }]);
    await db.exec('DELETE FROM {{items}} WHERE id=?', [1]);
    await expect(db.query('SELECT COUNT(*) AS c FROM {{items}}')).resolves.toEqual([{ c: 0 }]);
    await expect(db.exec('BEGIN')).rejects.toMatchObject({ code: 'PLUGIN_SQL_TRANSACTION_CONTROL' });
    await db.close();
    for (const p of [file, `${file}-wal`, `${file}-shm`]) if (fs.existsSync(p)) fs.rmSync(p);
  });
});
