/** @jest-environment node */
import { openPluginConnection } from '../plugin-connections';

describe('scoped plugin connection', () => {
  it('only executes registered owned tables and exposes normalized rows', async () => {
    const db = await openPluginConnection(':memory:', {
      pluginId: 'example.plugin',
      tables: ['items'],
      views: ['items_view'],
    });
    await db.exec('CREATE TABLE {{items}} (id INTEGER PRIMARY KEY, value TEXT)');
    await db.exec('INSERT INTO {{items}} VALUES (?, ?)', [1, 'ok']);
    await expect(db.query('SELECT * FROM {{items}}')).resolves.toEqual([
      { id: 1, value: 'ok' },
    ]);
    await expect(db.query('SELECT * FROM sqlite_master')).rejects.toThrow();
    await db.exec('CREATE VIEW {{items_view}} AS SELECT * FROM {{items}}');
    await expect(db.query('SELECT * FROM {{items_view}}')).resolves.toEqual([{ id: 1, value: 'ok' }]);
    await expect(db.exec('BEGIN')).rejects.toMatchObject({ code: 'PLUGIN_SQL_TRANSACTION_CONTROL' });
    await db.close();
  });
});
