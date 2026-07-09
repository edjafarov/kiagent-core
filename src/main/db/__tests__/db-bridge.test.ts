/**
 * @jest-environment node
 */
import { MessageChannel } from 'node:worker_threads';
import { openDb, type AppDb } from '@main/db/app-db';
import { createDbClient, attachDbHost } from '@main/db/bridge';

// The bridge is exercised over a real worker_threads MessageChannel: messages
// cross a structured-clone boundary exactly as they do between the main thread
// and the DB worker (integers return as number, Buffer arrives as Uint8Array, Error
// objects not cloneable). Only the thread spawn itself is not covered here.
describe('db bridge (client <-> host over MessageChannel)', () => {
  let host: AppDb;
  let client: AppDb & { _markDead(err: Error): void };
  let channel: MessageChannel;

  beforeEach(async () => {
    host = await openDb(':memory:');
    await host.exec(
      `CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT, blob BLOB);`,
    );
    channel = new MessageChannel();
    attachDbHost(channel.port1, host);
    client = createDbClient(channel.port2);
  });

  afterEach(() => {
    channel.port1.close();
    channel.port2.close();
    if (host.isOpen()) host._conn!.close();
  });

  it('round-trips run + all with integers returned as number', async () => {
    await client.run(`INSERT INTO t (v) VALUES (?)`, ['hello']);
    const rows = await client.all(`SELECT id, v FROM t`);
    expect(rows).toEqual([{ id: 1, v: 'hello' }]);
  });

  it('exec works', async () => {
    await client.exec(`INSERT INTO t (v) VALUES ('x')`);
    const rows = await client.all(`SELECT COUNT(*) AS c FROM t`);
    expect(Number(rows[0].c)).toBe(1);
  });

  it('preserves Buffer params and returns BLOB columns as Buffer', async () => {
    const buf = Buffer.from([1, 2, 3, 250]);
    await client.run(`INSERT INTO t (v, blob) VALUES ('b', ?)`, [buf]);
    const rows = await client.all(`SELECT blob FROM t WHERE v='b'`);
    expect(Buffer.isBuffer(rows[0].blob)).toBe(true);
    expect(rows[0].blob).toEqual(buf);
  });

  it('coerces Date params to ISO strings', async () => {
    await client.run(`INSERT INTO t (v) VALUES (?)`, [
      new Date('2026-06-11T00:00:00.000Z'),
    ]);
    const rows = await client.all(`SELECT v FROM t`);
    expect(rows[0].v).toBe('2026-06-11T00:00:00.000Z');
  });

  it('runs batch atomically with $fromStep piping', async () => {
    const res = await client.batch([
      { sql: `INSERT INTO t (v) VALUES ('parent') RETURNING id` },
      {
        sql: `INSERT INTO t (v) VALUES (?)`,
        params: [{ $fromStep: 0, column: 'id' }],
      },
    ]);
    expect((res[0].row as { id: number }).id).toBe(1);
    expect(res[1].changes).toBe(1);
    // failing batch rolls back
    await expect(
      client.batch([
        { sql: `INSERT INTO t (v) VALUES ('doomed')` },
        { sql: `INSERT INTO no_such_table (v) VALUES (1)` },
      ]),
    ).rejects.toThrow();
    const rows = await client.all(
      `SELECT COUNT(*) AS c FROM t WHERE v='doomed'`,
    );
    expect(Number(rows[0].c)).toBe(0);
  });

  it('propagates SQL errors as rejections with the message', async () => {
    await expect(client.all(`SELECT * FROM missing_table`)).rejects.toThrow(
      /missing_table/,
    );
    // and the client stays usable afterwards
    const rows = await client.all(`SELECT COUNT(*) AS c FROM t`);
    expect(Number(rows[0].c)).toBe(0);
  });

  it('close() closes the hosted connection and flips isOpen', async () => {
    expect(client.isOpen()).toBe(true);
    await client.close();
    expect(client.isOpen()).toBe(false);
    expect(host.isOpen()).toBe(false);
  });

  it('_markDead rejects in-flight requests and future ones', async () => {
    const dead = new Error('worker exited');
    const pending = client.all(`SELECT 1 AS x`);
    client._markDead(dead);
    await expect(pending).rejects.toThrow('worker exited');
    await expect(client.run(`SELECT 1`)).rejects.toThrow('worker exited');
    expect(client.isOpen()).toBe(false);
  });

  it('serves many interleaved in-flight requests in order', async () => {
    const inserts = Array.from({ length: 50 }, (_, i) =>
      client.run(`INSERT INTO t (v) VALUES (?)`, [`v${i}`]),
    );
    await Promise.all(inserts);
    const rows = await client.all(`SELECT v FROM t ORDER BY id`);
    expect(rows.map((r) => r.v)).toEqual(
      Array.from({ length: 50 }, (_, i) => `v${i}`),
    );
  });
});
