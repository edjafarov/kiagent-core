/** Step 2 Task 4: logins travel as versioned vault values (alpha-cent spec 7.8). */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { openDb, type AppDb } from '../../../db/app-db';
import { migrate } from '../../store/schema';
import { openStore, type CoreStore } from '../../store/store';
import { promote } from '../promote';
import { createSyncService, type SyncService } from '../service';
import { enableTracking } from '../tracking';

const SECRET = 'PLANTEDLOGINTEXT';
const keystore = (tag: string) => ({
  encrypt: (s: string) => Buffer.from(`${tag}:${s}`, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8').slice(tag.length + 1),
});

interface Device {
  dir: string;
  db: AppDb;
  store: CoreStore;
  svc: SyncService;
  logs: string[];
  conn: () => import('better-sqlite3').Database;
}
const devices: Device[] = [];

async function device(tag: string, opts: { failStrict?: (n: number) => boolean } = {}): Promise<Device> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sync-secrets-${tag}-`));
  const db = await openDb(path.join(dir, 'a.db'));
  migrate(db._conn!);
  const ks = keystore(tag);
  const store = openStore(db, { ...ks, detectLanguages: () => ['eng'] });
  const logs: string[] = [];
  let calls = 0;
  const svc = createSyncService({
    db,
    store,
    dbPath: path.join(dir, 'a.db'),
    workerFile: '',
    decrypt: ks.decrypt,
    encryptStrict: (s) => {
      calls += 1;
      if (opts.failStrict?.(calls)) throw new Error('keystore went away');
      return ks.encrypt(s);
    },
    keystoreAvailable: () => true,
    log: (_l, m) => void logs.push(m),
  });
  await svc.setDeviceId(`${tag}-device`);
  const d = { dir, db, store, svc, logs, conn: () => db._conn! };
  devices.push(d);
  return d;
}
const stamp = (d: Device, id: string) =>
  d.conn().prepare(`SELECT epoch, n FROM vault WHERE account_id = ?`).get(id);
const asFollower = (d: Device) => d.conn().prepare(`UPDATE sync_state SET role = 'follower'`).run();

afterEach(async () => {
  for (const d of devices.splice(0)) {
    await d.db.close();
    fs.rmSync(d.dir, { recursive: true, force: true });
  }
});

it('save stamps the current epoch and the next n', async () => {
  const a = await device('a');
  a.conn().prepare(`UPDATE sync_state SET epoch = 2`).run();
  enableTracking(a.conn());
  await a.store.vault.save('x', { t: 1 } as never);
  await a.store.vault.save('y', { t: 1 } as never);
  await a.store.vault.save('x', { t: 2 } as never);
  expect(stamp(a, 'x')).toEqual({ epoch: 2, n: 3 });
  expect(stamp(a, 'y')).toEqual({ epoch: 2, n: 2 });
});

it('logins saved before tracking travel on the first pull', async () => {
  const a = await device('a');
  const b = await device('b');
  await a.store.vault.save('x', { token: SECRET } as never);
  await a.store.vault.save('y', { token: 'two' } as never);
  expect(stamp(a, 'x')).toEqual({ epoch: 0, n: 0 });
  enableTracking(a.conn());
  const got = await a.svc.exportSecrets({ epoch: 0, n: 0 });
  expect(got.map((s) => s.accountId).sort()).toEqual(['x', 'y']);
  asFollower(b);
  await expect(b.svc.importSecrets(got)).resolves.toEqual({ applied: 2 });
  expect(await b.store.vault.load('x')).toEqual({ token: SECRET });
});

it('logins of device-owned accounts are never exported', async () => {
  const a = await device('a');
  const folder = await a.store.createAccount({ source: 'local-folder', identifier: '/tmp/x', config: {} } as never);
  const mail = await a.store.createAccount({ source: 'gmail', identifier: 'me@x.com', config: {} } as never);
  await a.store.vault.save(folder.id, { token: 'FOLDER' } as never);
  await a.store.vault.save(mail.id, { token: 'MAIL' } as never);
  enableTracking(a.conn());
  const got = await a.svc.exportSecrets({ epoch: 0, n: 0 });
  expect(got.map((s) => s.accountId)).toEqual([mail.id]);
});

it('promotion stamps the logins that were copied at (0, 0) under the new epoch', async () => {
  const b = await device('b');
  asFollower(b);
  b.conn().prepare(`INSERT INTO vault(account_id, blob) VALUES('x', x'01'), ('y', x'02')`).run();
  promote(b.conn(), 4);
  const rows = b.conn().prepare(`SELECT account_id, epoch, n FROM vault ORDER BY n`).all();
  expect(rows).toEqual([
    { account_id: 'x', epoch: 4, n: 1 },
    { account_id: 'y', epoch: 4, n: 2 },
  ]);
});

it('a newer stamp replaces, an older or equal one is ignored', async () => {
  const a = await device('a');
  asFollower(a);
  const s = (epoch: number, n: number, value: string | null) => ({ accountId: 'x', epoch, n, value });
  await a.svc.importSecrets([s(1, 5, JSON.stringify({ v: 'one' }))]);
  await expect(a.svc.importSecrets([s(1, 4, JSON.stringify({ v: 'older' }))])).resolves.toEqual({ applied: 0 });
  await expect(a.svc.importSecrets([s(1, 5, JSON.stringify({ v: 'same' }))])).resolves.toEqual({ applied: 0 });
  expect(await a.store.vault.load('x')).toEqual({ v: 'one' });
  await a.svc.importSecrets([s(2, 1, JSON.stringify({ v: 'newer epoch' }))]);
  expect(await a.store.vault.load('x')).toEqual({ v: 'newer epoch' });
  expect(stamp(a, 'x')).toEqual({ epoch: 2, n: 1 });
});

it('delete travels as an empty blob and loads as absent', async () => {
  const a = await device('a');
  const b = await device('b');
  enableTracking(a.conn());
  await a.store.vault.save('x', { v: 1 } as never);
  asFollower(b);
  await b.svc.importSecrets(await a.svc.exportSecrets({ epoch: 0, n: 0 }));
  await a.store.vault.delete('x');
  expect(await a.store.vault.load('x')).toBeNull();
  expect(a.conn().prepare(`SELECT count(*) c FROM vault`).get()).toEqual({ c: 1 });
  const sent = await a.svc.exportSecrets({ epoch: 0, n: 1 });
  expect(sent).toEqual([{ accountId: 'x', epoch: 0, n: 2, value: null }]);
  await b.svc.importSecrets(sent);
  expect(await b.store.vault.load('x')).toBeNull();
});

it('encryptStrict failing writes nothing, not even one row', async () => {
  const b = await device('b', { failStrict: (n) => n === 2 });
  asFollower(b);
  const list = [
    { accountId: 'x', epoch: 1, n: 1, value: JSON.stringify({ v: SECRET }) },
    { accountId: 'y', epoch: 1, n: 2, value: JSON.stringify({ v: SECRET }) },
  ];
  await expect(b.svc.importSecrets(list)).rejects.toThrow(/keystore/);
  expect(b.conn().prepare(`SELECT count(*) c FROM vault`).get()).toEqual({ c: 0 });
});

it('export then import round-trips under a different keystore', async () => {
  const a = await device('a');
  const b = await device('b');
  enableTracking(a.conn());
  await a.store.vault.save('x', { refresh: SECRET, nested: { a: [1, 2] } } as never);
  asFollower(b);
  await b.svc.importSecrets(await a.svc.exportSecrets({ epoch: 0, n: 0 }));
  const raw = b.conn().prepare(`SELECT blob FROM vault`).get() as { blob: Buffer };
  expect(raw.blob.toString('utf8').startsWith('b:')).toBe(true);
  expect(await b.store.vault.load('x')).toEqual({ refresh: SECRET, nested: { a: [1, 2] } });
});

it("a follower's own save never stamps", async () => {
  const b = await device('b');
  asFollower(b);
  await b.store.vault.save('own', { v: 1 } as never);
  expect(stamp(b, 'own')).toEqual({ epoch: 0, n: 0 });
  await b.svc.importSecrets([{ accountId: 'own', epoch: 1, n: 1, value: JSON.stringify({ v: 2 }) }]);
  await b.store.vault.save('own', { v: 3 } as never);
  expect(stamp(b, 'own')).toEqual({ epoch: 1, n: 1 });
});

it('only a follower takes logins from a sibling', async () => {
  const a = await device('a');
  enableTracking(a.conn());
  await expect(
    a.svc.importSecrets([{ accountId: 'x', epoch: 1, n: 1, value: '{}' }]),
  ).rejects.toThrow(/leader|follower/);
});

it('no credential text reaches a log or an error message', async () => {
  const a = await device('a');
  const b = await device('b', { failStrict: (n) => n === 2 });
  enableTracking(a.conn());
  await a.store.vault.save('x', { token: SECRET } as never);
  await a.store.vault.save('y', { token: SECRET } as never);
  const sent = await a.svc.exportSecrets({ epoch: 0, n: 0 });
  asFollower(b);
  let message = '';
  try {
    await b.svc.importSecrets(sent);
  } catch (e) {
    message = (e as Error).message;
  }
  expect(message).not.toContain(SECRET);
  for (const line of [...a.logs, ...b.logs]) expect(line).not.toContain(SECRET);
});

it('status reports the highest stamp held', async () => {
  const a = await device('a');
  asFollower(a);
  await a.svc.importSecrets([
    { accountId: 'x', epoch: 1, n: 9, value: '{}' },
    { accountId: 'y', epoch: 2, n: 1, value: '{}' },
  ]);
  const { readSyncStatus } = await import('../status');
  expect(readSyncStatus(a.conn()).secretsAfter).toEqual({ epoch: 2, n: 1 });
});

it('v16 adds the stamp columns to a vault that has none, once', async () => {
  const a = await device('a');
  const c = a.conn();
  c.exec(`ALTER TABLE vault DROP COLUMN epoch; ALTER TABLE vault DROP COLUMN n;`);
  c.prepare(`INSERT INTO vault(account_id, blob) VALUES('x', x'01')`).run();
  c.prepare(`UPDATE meta SET value = '15' WHERE key = 'schemaVersion'`).run();
  migrate(c);
  migrate(c);
  expect(c.prepare(`SELECT epoch, n FROM vault`).get()).toEqual({ epoch: 0, n: 0 });
  expect(c.prepare(`SELECT value FROM meta WHERE key = 'schemaVersion'`).get()).toEqual({ value: '22' });
});
