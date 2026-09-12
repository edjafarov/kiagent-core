/**
 * @jest-environment node
 */
import { openDb, type AppDb } from '@main/db/app-db';
import * as fs from 'node:fs';

describe('AppDb.batch', () => {
  let db: AppDb;

  beforeEach(async () => {
    db = await openDb(':memory:');
    await db.exec(
      `CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT);
       CREATE TABLE child (t_id INTEGER, note TEXT);`,
    );
  });

  afterEach(async () => {
    await db.close();
  });

  it('runs steps and returns first row + changes per step', async () => {
    const res = await db.batch([
      { sql: `INSERT INTO t (v) VALUES (?)`, params: ['a'] },
      { sql: `SELECT v FROM t WHERE v=?`, params: ['a'] },
      { sql: `UPDATE t SET v='b'` },
    ]);
    expect(res).toHaveLength(3);
    expect(res[0].changes).toBe(1);
    expect(res[1].row).toEqual({ v: 'a' });
    expect(res[2].changes).toBe(1);
  });

  it('pipes a RETURNING column into later steps via $fromStep', async () => {
    const res = await db.batch([
      { sql: `INSERT INTO t (v) VALUES (?) RETURNING id`, params: ['x'] },
      {
        sql: `INSERT INTO child (t_id, note) VALUES (?, ?)`,
        params: [{ $fromStep: 0, column: 'id' }, 'linked'],
      },
    ]);
    const { id } = res[0].row as { id: number };
    const rows = await db.all(`SELECT t_id FROM child WHERE note='linked'`);
    expect(rows[0].t_id).toEqual(id);
  });

  it('is atomic: a failing step rolls back the whole batch', async () => {
    // Assert the rejection by message, NOT `.rejects.toThrow()`. The batch
    // rejects with a better-sqlite3 `SqliteError`, a class from a native addon.
    // jest gives each test FILE its own realm (its own `Error`), but the native
    // binding is cached process-wide, so `SqliteError` is bound to whichever
    // test file loaded better-sqlite3 first. In every other file
    // `sqliteError instanceof Error` is false — and every `.toThrow(...)` form
    // is instanceof-gated, so it spuriously reports "did not throw" whenever a
    // sibling suite loaded the addon first (flaky under `--maxWorkers` sharding).
    // `toMatchObject` checks properties without instanceof, so it is realm-safe.
    await expect(
      db.batch([
        { sql: `INSERT INTO t (v) VALUES (?)`, params: ['keep?'] },
        { sql: `INSERT INTO nonexistent_table (v) VALUES (1)` },
      ]),
    ).rejects.toMatchObject({
      message: expect.stringContaining('no such table'),
    });
    expect(await db.all(`SELECT COUNT(*) AS c FROM t`)).toEqual([
      { c: expect.anything() },
    ]);
    const [{ c }] = await db.all(`SELECT COUNT(*) AS c FROM t`);
    expect(Number(c)).toBe(0);
  });

  it('rejects a $fromStep reference to a missing column', async () => {
    await expect(
      db.batch([
        { sql: `INSERT INTO t (v) VALUES ('y')` },
        {
          sql: `INSERT INTO child (t_id, note) VALUES (?, 'z')`,
          params: [{ $fromStep: 0, column: 'id' }],
        },
      ]),
    ).rejects.toThrow(/\$fromStep/);
  });

  it('drains an in-flight direct backup and coalesces concurrent closes', async () => {
    let release!: () => void;
    let started!: () => void;
    const backupStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const backupGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const nativeBackup = db._conn!.backup.bind(db._conn!);
    jest.spyOn(db._conn!, 'backup').mockImplementation(async (destination) => {
      started();
      await backupGate;
      return nativeBackup(destination);
    });
    const nativeClose = jest.spyOn(db._conn!, 'close');
    const destination = `/tmp/app-db-direct-close-${process.pid}-${Date.now()}.sqlite`;

    try {
      const backup = db.backup!(destination);
      await backupStarted;
      const firstClose = db.close();
      const secondClose = db.close();
      expect(nativeClose).not.toHaveBeenCalled();
      release();
      await expect(backup).resolves.toBeUndefined();
      await expect(Promise.all([firstClose, secondClose])).resolves.toEqual([
        undefined,
        undefined,
      ]);
      expect(nativeClose).toHaveBeenCalledTimes(1);
    } finally {
      for (const file of [
        destination,
        `${destination}-wal`,
        `${destination}-shm`,
      ])
        if (fs.existsSync(file)) fs.rmSync(file, { force: true });
    }
  });

  it('coerces Date and boolean params like run()', async () => {
    const d = new Date('2026-01-02T03:04:05.000Z');
    await db.batch([
      { sql: `INSERT INTO t (v) VALUES (?)`, params: [d] },
      { sql: `INSERT INTO t (v) VALUES (?)`, params: [true] },
    ]);
    // Reference behavior: identical inserts through run().
    await db.run(`INSERT INTO t (v) VALUES (?)`, [d]);
    await db.run(`INSERT INTO t (v) VALUES (?)`, [true]);
    const rows = await db.all(`SELECT v FROM t ORDER BY id`);
    expect(rows[0].v).toBe('2026-01-02T03:04:05.000Z');
    expect(rows[0].v).toEqual(rows[2].v);
    expect(rows[1].v).toEqual(rows[3].v);
  });
});

describe('AppDb.isOpen', () => {
  it('reflects the connection state', async () => {
    const db = await openDb(':memory:');
    expect(db.isOpen()).toBe(true);
    await db.close();
    expect(db.isOpen()).toBe(false);
  });
});
