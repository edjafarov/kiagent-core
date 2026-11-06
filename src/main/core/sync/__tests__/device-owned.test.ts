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
import { gateEngine, SyncReadOnly } from '../role';
import { leadProc } from './lead-proc';
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
    ).rejects.toMatchObject({ message: expect.stringContaining('queue full') });
    expect(d.conn().prepare(`SELECT count(*) n FROM documents WHERE account_id = 'own'`).get()).toEqual({ n: 0 });
  });

  it('a removal queue write that fails keeps the account', async () => {
    const d = await device({ follower: true });
    await d.svc.setDeviceId(DEVICE);
    addAccount(d, 'own', 'local-folder', `this-machine#${SUFFIX}`, DEVICE);
    d.conn().exec(
      `CREATE TRIGGER refuse_queue BEFORE INSERT ON sync_outbound BEGIN SELECT RAISE(ABORT, 'queue full'); END`,
    );
    await expect(d.store.commit({ removeAccount: 'own' as never })).rejects.toMatchObject({
      message: expect.stringContaining('queue full'),
    });
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
    (d.db as unknown as { proc: unknown }).proc = leadProc(d.conn);
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
    await d.svc.lead({ epoch: 2 });
    await d.svc.open('head-acked');
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

describe('one ownership predicate, read per call', () => {
  const engineOver = (d: Dev, connect: (x: unknown) => Promise<unknown>) => {
    const e = {
      run: jest.fn(() => 'real'),
      attach: jest.fn(() => 'real'),
      rerunDeferred: jest.fn(async () => undefined),
      connect: jest.fn(connect),
      reconnect: jest.fn(),
      applyScope: jest.fn(),
      remove: jest.fn(),
      pause: jest.fn(),
      resume: jest.fn(),
      updateConfig: jest.fn(),
      setOption: jest.fn(),
    };
    gateEngine(e as never, () => d.svc.readOnly(), d.svc);
    return e;
  };

  it('a folder connected on a follower actually runs', async () => {
    const d = await device({ follower: true });
    await d.svc.setDeviceId(DEVICE);
    await d.svc.loadOwned();
    const e = engineOver(d, () => d.store.createAccount({ source: 'local-folder', identifier: 'this-machine' }));
    const account = (await e.connect({ descriptor: { id: 'local-folder' } })) as { id: string };
    expect((e.run as unknown as (a: { id: string }) => unknown)({ id: account.id })).toBe('real');
  });

  it.each([
    ['a joined follower', { follower: true, joined: true, joining: false }, true],
    ['a follower that never joined', { follower: true, joined: false, joining: false }, false],
    ['a follower that is joining', { follower: true, joined: true, joining: true }, false],
  ])('the engine and the writer guard agree for %s', async (_n, st, mayRun) => {
    const d = await device({ follower: st.follower, joined: st.joined });
    await d.svc.setDeviceId(DEVICE);
    addAccount(d, 'own', 'local-folder', `this-machine#${SUFFIX}`, DEVICE);
    if (st.joining) await d.svc.beginJoin();
    await d.svc.loadOwned();
    let wrote = true;
    try {
      await d.store.commit({ account: 'own' as never, documents: [doc('a')], cursor: null });
    } catch {
      wrote = false;
    }
    expect(wrote).toBe(mayRun);
    expect(d.svc.ownsAccount('own')).toBe(mayRun);
  });
});

describe('owner deletions converge on the leader', () => {
  const ref = (externalId: string) => ({ externalId, type: 'file' });
  const seqNow = (d: Dev) =>
    (d.conn().prepare(`SELECT max(seq) s FROM documents`).get() as { s: number }).s;
  const deliverAll = async (from: Dev, to: Dev) => {
    to.svc.setRunners({
      ui: jest.fn(),
      core: jest.fn(),
      commit: (p) => runCommitBatch(to, p as never),
    });
    const sentTo = to;
    from.svc.setForwarder(async (r) => {
      try {
        return { ok: true, value: await (sentTo.svc.runForwarded(r) as Promise<{ ok: true; value: unknown }>).then((x) => x.value) };
      } catch (e) {
        return { ok: false, code: 'handler', message: String(e) };
      }
    });
    return from.svc.drainOutbound();
  };

  it('a file deleted and a root removed on the owner disappear from the master', async () => {
    const owner = await device({ follower: true });
    await owner.svc.setDeviceId(DEVICE);
    const identifier = `this-machine#${SUFFIX}`;
    addAccount(owner, 'own', 'local-folder', identifier, DEVICE);
    owner.conn().prepare(`UPDATE accounts SET config = ? WHERE id = 'own'`).run(JSON.stringify({ folderRoots: ['/x', '/y'] }));
    const docs = [
      { ...doc('x1'), scopeRootId: '/x' },
      { ...doc('x2'), scopeRootId: '/x' },
      { ...doc('y1'), scopeRootId: '/y' },
    ];
    await owner.store.commit({ account: 'own' as never, documents: docs, cursor: { n: 1 } });

    const leader = await device();
    await expect(deliverAll(owner, leader)).resolves.toEqual({ sent: 1, waiting: 0 });
    const live = (d: Dev) =>
      (d.conn().prepare(`SELECT external_id e FROM documents WHERE archived_at IS NULL ORDER BY 1`).all() as { e: string }[]).map((r) => r.e);
    expect(live(leader)).toEqual(['x1', 'x2', 'y1']);

    // x2 is deleted from disk: a reconcile pass archives it.
    const start = seqNow(owner);
    await owner.store.reconcileBegin('own' as never);
    await owner.store.reconcileStage('own' as never, [ref('x1'), ref('y1')] as never);
    await owner.store.reconcileArchiveChunk('own' as never, start as never);
    expect(live(owner)).toEqual(['x1', 'y1']);
    // Then the root /y is removed from the folder's scope.
    const expectedConfigJson = (owner.conn().prepare(`SELECT config c FROM accounts WHERE id='own'`).get() as { c: string }).c;
    await owner.store.applyFolderScope({
      accountId: 'own' as never,
      config: { folderRoots: ['/x'] },
      cursor: { n: 2 },
      archiveScopeRootIds: ['/y'],
      reattributeScopeRoots: [],
      archiveRefs: [],
      expectedConfigJson,
    } as never);
    expect(live(owner)).toEqual(['x1']);
    expect(owner.conn().prepare(`SELECT count(*) n FROM sync_outbound`).get()).toEqual({ n: 2 });

    await expect(deliverAll(owner, leader)).resolves.toEqual({ sent: 2, waiting: 0 });
    expect(live(leader)).toEqual(['x1']);
    const cfg = leader.conn().prepare(`SELECT config c FROM accounts WHERE source='local-folder'`).get() as { c: string };
    expect(JSON.parse(cfg.c).folderRoots).toEqual(['/x']);
  });

  it('nothing is queued when a pass archives nothing', async () => {
    const d = await device({ follower: true });
    await d.svc.setDeviceId(DEVICE);
    addAccount(d, 'own', 'local-folder', `this-machine#${SUFFIX}`, DEVICE);
    await d.store.commit({ account: 'own' as never, documents: [doc('a')], cursor: null });
    const start = seqNow(d);
    await d.store.reconcileBegin('own' as never);
    await d.store.reconcileStage('own' as never, [ref('a')] as never);
    await d.store.reconcileArchiveChunk('own' as never, start as never);
    // Only the commit's own row.
    expect(d.conn().prepare(`SELECT count(*) n FROM sync_outbound`).get()).toEqual({ n: 1 });
  });
});

describe('an account owned by another device never runs here (final review)', () => {
  const OTHER = 'otherdev-0000-0000-0000-000000000000';
  const real = jest.fn(() => 'real');
  beforeEach(() => real.mockClear());
  const engineOf = () => ({
    run: real,
    attach: jest.fn(() => 'real'),
    rerunDeferred: jest.fn(async () => 'real'),
  });
  const runOn = (e: ReturnType<typeof engineOf>, id: string) =>
    (e.run as unknown as (a: { id: string }) => unknown)({ id });

  it('a restarted master starts neither a follower-owned folder nor opens its path', async () => {
    const d = await device(); // role normal: the master
    addAccount(d, 'theirs', 'local-folder', `docs#${OTHER.slice(0, 8)}`, OTHER);
    addAccount(d, 'mine', 'local-folder', `docs#${SUFFIX}`, DEVICE);
    addAccount(d, 'free', 'gmail', 'me@x.com', null);
    await d.svc.setDeviceId(DEVICE);
    await d.svc.loadOwned();
    const e = engineOf();
    gateEngine(e as never, () => d.svc.readOnly(), d.svc);
    // The second call is the boot path (resumeAccounts) and the cadence tick.
    expect((runOn(e, 'theirs') as { status: string }).status).toBe('paused');
    expect((runOn(e, 'theirs') as { status: string }).status).toBe('paused');
    expect(real).not.toHaveBeenCalled();
    expect(runOn(e, 'mine')).toBe('real');
    expect(runOn(e, 'free')).toBe('real');
    expect(real).toHaveBeenCalledTimes(2);
  });

  it('a follower does not run it either', async () => {
    const d = await device({ follower: true });
    addAccount(d, 'theirs', 'local-folder', `docs#${OTHER.slice(0, 8)}`, OTHER);
    await d.svc.setDeviceId(DEVICE);
    await d.svc.loadOwned();
    const e = engineOf();
    gateEngine(e as never, () => d.svc.readOnly(), d.svc);
    expect((runOn(e, 'theirs') as { status: string }).status).toBe('paused');
    expect(real).not.toHaveBeenCalled();
  });
});

describe('device names and accounts held elsewhere (final review)', () => {
  const OTHER = 'abcdef01-0000-0000-0000-000000000000';

  it('status lists the accounts another device owns, with the folder suffix off', async () => {
    const d = await device({ follower: true });
    addAccount(d, 'w', 'whatsapp', `+4915#${OTHER.slice(0, 8)}`, OTHER);
    addAccount(d, 'mine', 'local-folder', `docs#${SUFFIX}`, DEVICE);
    addAccount(d, 'g', 'gmail', 'me@x.com', null);
    await d.svc.setDeviceId(DEVICE);
    const { readSyncStatus } = await import('../status');
    expect(readSyncStatus(d.conn()).elsewhere).toEqual([
      { source: 'whatsapp', identifier: '+4915', ownerDeviceId: OTHER },
    ]);
  });

  it('a device is called by its label once told, by its short id before', async () => {
    const d = await device();
    expect(d.svc.deviceName(OTHER)).toBe('abcdef01');
    await d.svc.setDeviceNames([{ deviceId: OTHER, label: 'Work Mac' }]);
    expect(d.svc.deviceName(OTHER)).toBe('Work Mac');
    await d.svc.setDeviceNames([{ deviceId: OTHER, label: '' }]);
    expect(d.svc.deviceName(OTHER)).toBe('abcdef01');
  });

  it('the leader is named from the stored master id', async () => {
    const d = await device({ follower: true });
    d.conn().prepare(`UPDATE sync_state SET master_device_id = ?`).run(OTHER);
    await d.svc.loadOwned();
    await d.svc.setDeviceNames([{ deviceId: OTHER, label: 'Work Mac' }]);
    expect(d.svc.masterName()).toBe('Work Mac');
  });
});
