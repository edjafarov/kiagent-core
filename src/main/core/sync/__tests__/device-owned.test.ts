/** @jest-environment node */
/** Step 3 Task 2: device-owned accounts run on their owner whatever its role
 *  (alpha-cent spec 7.8, r16 rulings 4, 5 and 8). */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { CommitBatch } from '@shared/contracts';

import { openDb, type AppDb } from '../../../db/app-db';
import { migrate } from '../../store/schema';
import { openStore, type CoreStore } from '../../store/store';
import { SyncReadOnly } from '../role';
import { createSyncService, type ForwardRequest, type SyncService } from '../service';
import { runCommitBatch, splitBatch } from '../owned';

const DEVICE = 'devicea1-0000-0000-0000-000000000000';
const SUFFIX = 'devicea1';

interface Dev {
  dir: string;
  db: AppDb;
  store: CoreStore;
  svc: SyncService;
  after: CommitBatch[];
  conn: () => import('better-sqlite3').Database;
}
const devs: Dev[] = [];

async function device(opts: { follower?: boolean; joined?: boolean } = {}): Promise<Dev> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-owned-'));
  const db = await openDb(path.join(dir, 'a.db'));
  migrate(db._conn!);
  const conn = () => db._conn!;
  if (opts.follower)
    conn().prepare(`UPDATE sync_state SET role = 'follower', joined = ?`).run(opts.joined === false ? 0 : 1);
  let svc!: SyncService;
  const after: CommitBatch[] = [];
  const store = openStore(db, {
    encrypt: (s: string) => Buffer.from(s, 'utf8'),
    decrypt: (b: Buffer) => b.toString('utf8'),
    detectLanguages: () => ['eng'],
  } as never);
  svc = createSyncService({
    db,
    store,
    dbPath: path.join(dir, 'a.db'),
    workerFile: '',
    initialReadOnly: !!opts.follower,
    log: () => undefined,
  });
  const d = { dir, db, store, svc, after, conn };
  devs.push(d);
  return d;
}
afterEach(async () => {
  for (const d of devs.splice(0)) {
    await d.db.close();
    fs.rmSync(d.dir, { recursive: true, force: true });
  }
});

const addAccount = (d: Dev, id: string, source: string, identifier: string, owner: string | null = null) =>
  d
    .conn()
    .prepare(
      `INSERT INTO accounts(id, source, identifier, status, created_at, owner_device_id) VALUES(?, ?, ?, 'idle', 'x', ?)`,
    )
    .run(id, source, identifier, owner);
const doc = (externalId: string) => ({
  externalId,
  type: 'file',
  title: externalId,
  markdown: `body ${externalId}`,
  metadata: {},
  createdAt: null,
});
const queued = (d: Dev) =>
  (d.conn().prepare(`SELECT payload FROM sync_outbound ORDER BY id`).all() as { payload: Buffer }[]).map(
    (r) => JSON.parse(Buffer.from(r.payload).toString('utf8')) as ForwardRequest,
  );

describe('adopting device-owned accounts', () => {
  it('setDeviceId on an unjoined device suffixes every device-owned identifier once', async () => {
    const d = await device();
    addAccount(d, 'f', 'local-folder', 'this-machine');
    addAccount(d, 'm', 'meetings', 'local');
    addAccount(d, 'g', 'gmail', 'me@x.com');
    await d.svc.setDeviceId(DEVICE);
    await d.svc.setDeviceId(DEVICE);
    const rows = d.conn().prepare(`SELECT id, identifier, owner_device_id AS o FROM accounts ORDER BY id`).all();
    expect(rows).toEqual([
      { id: 'f', identifier: `this-machine#${SUFFIX}`, o: DEVICE },
      { id: 'g', identifier: 'me@x.com', o: null },
      { id: 'm', identifier: `local#${SUFFIX}`, o: DEVICE },
    ]);
    expect(d.conn().prepare(`SELECT adopted_at FROM sync_state`).get()).toEqual({ adopted_at: expect.any(String) });
  });

  it('setDeviceId on a joined device changes no accounts row', async () => {
    const d = await device({ follower: true });
    addAccount(d, 'f', 'local-folder', `this-machine#other123`, 'other-device');
    await d.svc.setDeviceId(DEVICE);
    expect(d.conn().prepare(`SELECT identifier, owner_device_id AS o FROM accounts`).all()).toEqual([
      { identifier: 'this-machine#other123', o: 'other-device' },
    ]);
  });

  it('a restart after adoption adopts nothing again', async () => {
    const d = await device();
    addAccount(d, 'f', 'local-folder', 'this-machine');
    await d.svc.setDeviceId(DEVICE);
    // A device-owned account made later is not adopted by a second boot.
    addAccount(d, 'n', 'local-folder', 'later');
    const again = createSyncService({
      db: d.db,
      store: d.store,
      dbPath: path.join(d.dir, 'a.db'),
      workerFile: '',
    });
    await again.setDeviceId(DEVICE);
    expect(d.conn().prepare(`SELECT identifier FROM accounts WHERE id = 'n'`).get()).toEqual({ identifier: 'later' });
  });

  it('status reports the device id', async () => {
    const d = await device();
    await d.svc.setDeviceId(DEVICE);
    const { readSyncStatus } = await import('../status');
    expect(readSyncStatus(d.conn()).deviceId).toBe(DEVICE);
  });
});

describe('the writer guard on a follower', () => {
  const setup = async () => {
    const d = await device({ follower: true });
    await d.svc.setDeviceId(DEVICE);
    addAccount(d, 'own', 'local-folder', `this-machine#${SUFFIX}`, DEVICE);
    addAccount(d, 'theirs', 'local-folder', 'this-machine#zzzzzzzz', 'zzzzzzzz-device');
    addAccount(d, 'mail', 'gmail', 'me@x.com');
    return d;
  };

  it('an owned commit writes locally and queues the batch', async () => {
    const d = await setup();
    await d.store.commit({ account: 'own' as never, documents: [doc('a')], cursor: { n: 1 } });
    expect(d.conn().prepare(`SELECT count(*) n FROM documents WHERE account_id = 'own'`).get()).toEqual({ n: 1 });
    const q = queued(d);
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ kind: 'commit', name: 'core.commitBatch' });
  });

  it('any other account still throws SyncReadOnly and queues nothing', async () => {
    const d = await setup();
    for (const id of ['theirs', 'mail']) {
      await expect(
        d.store.commit({ account: id as never, documents: [doc('a')], cursor: null }),
      ).rejects.toThrow(SyncReadOnly);
    }
    expect(queued(d)).toEqual([]);
  });

  it('reconcile and status writes pass for an owned account and throw for any other', async () => {
    const d = await setup();
    await expect(d.store.setAccountStatus('own' as never, { status: 'live' } as never)).resolves.toBeUndefined();
    await expect(d.store.setAccountStatus('mail' as never, { status: 'live' } as never)).rejects.toThrow(
      SyncReadOnly,
    );
    await expect(d.store.reconcileBegin('own' as never)).resolves.toBeUndefined();
    await expect(d.store.reconcileBegin('theirs' as never)).rejects.toThrow(SyncReadOnly);
    await expect(d.store.reconcileEnd('mail' as never)).rejects.toThrow(SyncReadOnly);
  });

  it('a consumer commit (a worker) is refused on a follower', async () => {
    const d = await setup();
    await expect(d.store.commit({ consumer: 'vision', documents: [] } as never)).rejects.toThrow(SyncReadOnly);
  });

  it('removing an owned account queues the removal', async () => {
    const d = await setup();
    await d.store.commit({ removeAccount: 'own' as never });
    expect(d.conn().prepare(`SELECT count(*) n FROM accounts WHERE id = 'own'`).get()).toEqual({ n: 0 });
    expect(queued(d)[0].payload).toMatchObject({ batch: { removeAccount: 'own' } });
  });

  it('a device that is not yet joined stays fully read-only, owned or not', async () => {
    const d = await device({ follower: true, joined: false });
    await d.svc.setDeviceId(DEVICE);
    addAccount(d, 'own', 'local-folder', 'x', DEVICE);
    await expect(
      d.store.commit({ account: 'own' as never, documents: [doc('a')], cursor: null }),
    ).rejects.toThrow(SyncReadOnly);
  });
});

describe('an owned commit and its queue row are one transaction', () => {
  it('a queue write that fails rolls the documents back', async () => {
    const d = await device({ follower: true });
    await d.svc.setDeviceId(DEVICE);
    addAccount(d, 'own', 'local-folder', `this-machine#${SUFFIX}`, DEVICE);
    d.conn().exec(
      `CREATE TRIGGER refuse_queue BEFORE INSERT ON sync_outbound BEGIN SELECT RAISE(ABORT, 'queue full'); END`,
    );
    await expect(
      d.store.commit({ account: 'own' as never, documents: [doc('a')], cursor: { n: 1 } }),
    ).rejects.toThrow();
    expect(d.conn().prepare(`SELECT count(*) n FROM documents WHERE account_id = 'own'`).get()).toEqual({ n: 0 });
  });

  it('a removal queue write that fails keeps the account', async () => {
    const d = await device({ follower: true });
    await d.svc.setDeviceId(DEVICE);
    addAccount(d, 'own', 'local-folder', `this-machine#${SUFFIX}`, DEVICE);
    d.conn().exec(
      `CREATE TRIGGER refuse_queue BEFORE INSERT ON sync_outbound BEGIN SELECT RAISE(ABORT, 'queue full'); END`,
    );
    await expect(d.store.commit({ removeAccount: 'own' as never })).rejects.toThrow();
    expect(d.conn().prepare(`SELECT count(*) n FROM accounts WHERE id = 'own'`).get()).toEqual({ n: 1 });
  });

  it('a master commit queues nothing', async () => {
    const d = await device();
    await d.svc.setDeviceId(DEVICE);
    addAccount(d, 'own', 'local-folder', `this-machine#${SUFFIX}`, DEVICE);
    await d.store.commit({ account: 'own' as never, documents: [doc('a')], cursor: { n: 1 } });
    expect(queued(d)).toEqual([]);
  });
});

describe('connecting a device-owned account after the device id is known', () => {
  it('local-folder, meetings and the other device-owned sources get the suffix and the owner', async () => {
    const d = await device();
    await d.svc.setDeviceId(DEVICE);
    for (const source of ['local-folder', 'meetings', 'whatsapp', 'codex']) {
      const a = await d.store.createAccount({ source, identifier: source === 'local-folder' ? 'this-machine' : 'local' });
      expect(a.identifier).toMatch(new RegExp(`#${SUFFIX}$`));
      expect(a.ownerDeviceId).toBe(DEVICE);
    }
    const g = await d.store.getOrCreateAccount('assistant', 'local');
    expect(g.identifier).toBe(`local#${SUFFIX}`);
    expect(g.ownerDeviceId).toBe(DEVICE);
  });

  it('connecting again upserts the one suffixed row', async () => {
    const d = await device();
    await d.svc.setDeviceId(DEVICE);
    const a = await d.store.createAccount({ source: 'local-folder', identifier: 'this-machine' });
    const b = await d.store.createAccount({ source: 'local-folder', identifier: 'this-machine' });
    const c = await d.store.createAccount({ source: 'local-folder', identifier: `this-machine#${SUFFIX}` });
    expect(new Set([a.id, b.id, c.id]).size).toBe(1);
    expect(d.conn().prepare(`SELECT count(*) n FROM accounts WHERE source = 'local-folder'`).get()).toEqual({ n: 1 });
  });

  it('another source keeps its identifier and no owner; no device id keeps the bare identifier', async () => {
    const d = await device();
    const bare = await d.store.createAccount({ source: 'local-folder', identifier: 'this-machine' });
    expect(bare.identifier).toBe('this-machine');
    expect(bare.ownerDeviceId ?? null).toBeNull();
    await d.svc.setDeviceId(DEVICE);
    const mail = await d.store.createAccount({ source: 'gmail', identifier: 'me@x.com' });
    expect(mail.identifier).toBe('me@x.com');
    expect(mail.ownerDeviceId ?? null).toBeNull();
  });

  it('a follower device-owned connect is suffixed too', async () => {
    const d = await device({ follower: true });
    await d.svc.setDeviceId(DEVICE);
    const a = await d.store.createAccount({ source: 'local-folder', identifier: 'this-machine' });
    expect(a.identifier).toBe(`this-machine#${SUFFIX}`);
  });
});

describe('delivery to the leader', () => {
  it('runCommitBatch creates the owner account once and commits the documents', async () => {
    const leader = await device();
    const input = {
      account: {
        id: 'own',
        source: 'local-folder',
        identifier: `this-machine#${SUFFIX}`,
        config: { folderRoots: ['/x'] },
        cadence: null,
        ownerDeviceId: DEVICE,
      },
      batch: { account: 'own', documents: [doc('a'), doc('b')], cursor: { n: 2 } } as unknown as CommitBatch,
    };
    await runCommitBatch(leader, input as never);
    await runCommitBatch(leader, input as never);
    const c = leader.conn();
    expect(c.prepare(`SELECT id, owner_device_id AS o FROM accounts`).all()).toEqual([{ id: 'own', o: DEVICE }]);
    expect(c.prepare(`SELECT count(*) n FROM documents`).get()).toEqual({ n: 2 });
    expect(c.prepare(`SELECT count(*) n FROM documents_fts WHERE documents_fts MATCH 'body'`).get()).toEqual({ n: 2 });
  });

  it('an account the leader already holds under another id is used, not duplicated', async () => {
    const leader = await device();
    addAccount(leader, 'leader-id', 'local-folder', `this-machine#${SUFFIX}`, DEVICE);
    await runCommitBatch(leader, {
      account: { id: 'owner-id', source: 'local-folder', identifier: `this-machine#${SUFFIX}`, config: {}, cadence: null, ownerDeviceId: DEVICE },
      batch: { account: 'owner-id', documents: [doc('a')], cursor: null } as unknown as CommitBatch,
    } as never);
    expect(leader.conn().prepare(`SELECT account_id FROM documents`).all()).toEqual([{ account_id: 'leader-id' }]);
  });

  it('a removal is delivered as a removal', async () => {
    const leader = await device();
    addAccount(leader, 'own', 'local-folder', 'x', DEVICE);
    await runCommitBatch(leader, {
      account: { id: 'own', source: 'local-folder', identifier: 'x', config: {}, cadence: null, ownerDeviceId: DEVICE },
      batch: { removeAccount: 'own' } as unknown as CommitBatch,
    } as never);
    expect(leader.conn().prepare(`SELECT count(*) n FROM accounts`).get()).toEqual({ n: 0 });
  });

  it('owned commit with no leader stays queued and goes out when one appears', async () => {
    const d = await device({ follower: true });
    await d.svc.setDeviceId(DEVICE);
    addAccount(d, 'own', 'local-folder', `this-machine#${SUFFIX}`, DEVICE);
    await d.store.commit({ account: 'own' as never, documents: [doc('a')], cursor: null });
    await expect(d.svc.drainOutbound()).resolves.toEqual({ sent: 0, waiting: 1 });
    const got: ForwardRequest[] = [];
    d.svc.setForwarder(async (r) => {
      got.push(r);
      return { ok: true, value: null };
    });
    await expect(d.svc.drainOutbound()).resolves.toEqual({ sent: 1, waiting: 0 });
    expect(got[0].kind).toBe('commit');
  });

  it('a batch queued as a follower is delivered to itself after promote', async () => {
    const d = await device({ follower: true });
    (d.db as unknown as { proc: (n: string, a: { epoch: number }) => Promise<null> }).proc = async (name, a) => {
      if (name === 'syncPromote') (await import('../promote')).promote(d.conn(), a.epoch);
      return null;
    };
    await d.svc.setDeviceId(DEVICE);
    addAccount(d, 'own', 'local-folder', `this-machine#${SUFFIX}`, DEVICE);
    await d.store.commit({ account: 'own' as never, documents: [doc('a')], cursor: { n: 1 } });
    const seen: unknown[] = [];
    d.svc.setRunners({
      ui: jest.fn(),
      core: jest.fn(),
      commit: async (p) => {
        seen.push(p);
        await runCommitBatch(d, p as never);
      },
    });
    await d.svc.promote(2);
    expect(seen).toHaveLength(1);
    expect(d.conn().prepare(`SELECT count(*) n FROM documents WHERE account_id = 'own'`).get()).toEqual({ n: 1 });
    expect(d.conn().prepare(`SELECT count(*) n FROM sync_outbound`).get()).toEqual({ n: 0 });
  });
});

describe('splitBatch', () => {
  const big = (n: number) => ({ ...doc(`d${n}`), markdown: 'x'.repeat(100) });
  it('splits documents at item boundaries under the cap; only the last piece carries the cursor and status', () => {
    const batch = {
      account: 'own',
      documents: [big(1), big(2), big(3), big(4)],
      cursor: { n: 4 },
      status: 'live',
    } as unknown as CommitBatch;
    const parts = splitBatch(batch, 400) as unknown as { documents: unknown[]; cursor?: unknown; status?: string }[];
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.flatMap((p) => p.documents)).toHaveLength(4);
    expect(parts.slice(0, -1).every((p) => p.cursor === undefined && p.status === undefined)).toBe(true);
    expect(parts[parts.length - 1].cursor).toEqual({ n: 4 });
    expect(parts[parts.length - 1].status).toBe('live');
    for (const p of parts) expect(JSON.stringify(p).length).toBeLessThan(900);
  });

  it('a batch under the cap, and a removal, stay whole', () => {
    const small = { account: 'own', documents: [doc('a')], cursor: null } as unknown as CommitBatch;
    expect(splitBatch(small, 16 * 1024 * 1024)).toEqual([small]);
    const rm = { removeAccount: 'own' } as unknown as CommitBatch;
    expect(splitBatch(rm, 10)).toEqual([rm]);
  });
});
