/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { AccountId, Change, DocumentInput } from '@shared/contracts';

import { openDb, type AppDb } from '../../../db/app-db';
import { openStore, type CoreStore } from '../store';

const doc = (externalId: string): DocumentInput => ({
  externalId,
  type: 'note',
  title: externalId,
  markdown: `body ${externalId}`,
  metadata: {},
  createdAt: '2026-01-01T00:00:00Z',
});
const settle = () =>
  new Promise((r) => {
    setTimeout(r, 30);
  });

describe('account change coalescing (#135)', () => {
  let dir: string;
  let file: string;
  let db: AppDb;
  let store: CoreStore;
  let accountId: AccountId;
  let clock = Date.parse('2026-10-09T10:00:00.000Z');
  const deps = {
    encrypt: (s: string) => Buffer.from(s, 'utf8'),
    decrypt: (b: Buffer) => b.toString('utf8'),
    detectLanguages: () => ['eng'],
    now: () => new Date(clock).toISOString(),
  };
  const at = (sec: number) => {
    clock = Date.parse('2026-10-09T10:00:00.000Z') + sec * 1000;
  };

  beforeEach(async () => {
    at(0);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-acc-'));
    file = path.join(dir, 'test.db');
    db = await openDb(file);
    store = openStore(db, deps);
    // Created two minutes earlier: createAccount's own row also moves the
    // last-published time, so the first commit at t = 0 is due.
    at(-120);
    accountId = (
      await store.createAccount({ source: 'test', identifier: 'me' })
    ).id;
    at(0);
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const accountRows = async () =>
    (
      (await db.all(
        `SELECT COUNT(*) AS c FROM changes WHERE kind = 'account' AND ref_id = ?`,
        [accountId],
      )) as Array<{ c: number }>
    )[0].c;
  const commitAt = (sec: number, extra: Record<string, unknown> = {}) => {
    at(sec);
    return store.commit({
      account: accountId,
      documents: [],
      cursor: sec,
      ...extra,
    } as never);
  };

  it('the first commit publishes; an unchanged commit inside the tick appends nothing and wakes no feed', async () => {
    await commitAt(0);
    const before = await accountRows();
    const it = store.feed(await store.headSeq())[Symbol.asyncIterator]();
    const next = it.next();
    await settle();
    const spy = jest.spyOn(db, 'all');
    await commitAt(10);
    await settle();
    expect(await accountRows()).toBe(before);
    expect(
      spy.mock.calls.filter(([sql]) =>
        /FROM changes WHERE seq > \?/.test(sql as string),
      ),
    ).toHaveLength(0);
    // The row itself still moved.
    expect((await store.account(accountId))?.cursor).toBe(10);
    await store.commit({
      account: accountId,
      documents: [doc('wake')],
      cursor: 11,
    });
    await next;
    await it.return?.();
  });

  it('a doc-only commit inside the tick logs its document, not an account row', async () => {
    await commitAt(0);
    const before = await accountRows();
    at(10);
    await store.commit({
      account: accountId,
      documents: [doc('a')],
      cursor: 10,
    });
    expect(await accountRows()).toBe(before);
    expect(
      await db.all(`SELECT COUNT(*) AS c FROM changes WHERE kind = 'document'`),
    ).toEqual([{ c: 1 }]);
  });

  it('a status change and a last_error change publish at once; a no-op scoped clear does not', async () => {
    await commitAt(0, { status: 'live' });
    const base = await accountRows();
    await commitAt(5, { status: 'backfilling' });
    expect(await accountRows()).toBe(base + 1);
    await commitAt(10, { error: 'boom' });
    expect(await accountRows()).toBe(base + 2);
    // 'boom' is not a reconcile error: a reconcile-scoped clear keeps it.
    await commitAt(15, { error: null, errorScope: 'reconcile' });
    expect(await accountRows()).toBe(base + 2);
    await commitAt(20, { error: null });
    expect(await accountRows()).toBe(base + 3);
    expect((await store.account(accountId))?.lastError ?? null).toBeNull();
  });

  it('continuous commits every 10 s publish exactly once per 60 s', async () => {
    const before = await accountRows();
    for (let s = 0; s <= 180; s += 10) {
      // eslint-disable-next-line no-await-in-loop
      await commitAt(s, { progress: { done: s } });
    }
    // t = 0, 60, 120, 180
    expect((await accountRows()) - before).toBe(4);
  });

  it('a feed sees the latest progress within 60 s of continuous commits', async () => {
    await commitAt(0, { progress: { done: 0 } });
    const it = store.feed(await store.headSeq())[Symbol.asyncIterator]();
    const next = it.next();
    for (let s = 10; s <= 60; s += 10) {
      // eslint-disable-next-line no-await-in-loop
      await commitAt(s, { progress: { done: s } });
    }
    const r = await next;
    const acc = (r.value as Change[]).find(
      (c): c is Extract<Change, { kind: 'account' }> => c.kind === 'account',
    );
    expect(acc?.account.progress?.done).toBe(60);
    await it.return?.();
  });

  it('the first qualifying commit after a DB-worker restart publishes, without a changes lookup', async () => {
    await commitAt(0);
    await store.close();
    db = await openDb(file); // a fresh writer connection = fresh map
    store = openStore(db, deps);
    const before = await accountRows(); // measured OUTSIDE the spy window
    const prepare = jest.spyOn(db._conn!, 'prepare');
    await commitAt(10);
    const seen = prepare.mock.calls.map(([sql]) => sql);
    prepare.mockRestore(); // the window is exactly the commit
    expect(seen.filter((sql) => /FROM changes\s+WHERE/i.test(sql))).toEqual([]);
    expect(await accountRows()).toBe(before + 1);
  });

  it('status and config publications from store.ts move the tick, interleaved with commits', async () => {
    await commitAt(0); // publishes (t = 0)
    const base = await accountRows();
    at(55);
    await store.setAccountConfig(accountId, { scoped: 1 });
    expect(await accountRows()).toBe(base + 1);
    await commitAt(60, { progress: { done: 1 } }); // 5 s after the config row
    expect(await accountRows()).toBe(base + 1);
    await commitAt(115, { progress: { done: 2 } }); // 60 s after it
    expect(await accountRows()).toBe(base + 2);
    at(150);
    await store.setAccountStatus(accountId, { status: 'backfilling' });
    expect(await accountRows()).toBe(base + 3);
    await commitAt(175, { progress: { done: 3 } }); // 25 s after the status row
    expect(await accountRows()).toBe(base + 3);
    await commitAt(210, { progress: { done: 4 } });
    expect(await accountRows()).toBe(base + 4);
  });

  // ── the write-tx.test.ts folder-scope failure fixture ───────────────────
  // Two docs under root X; `armScopeFailure` aborts the SECOND archive,
  // AFTER applyFolderScope already appended its `account` change in the same
  // transaction.
  const SCOPED_CURSOR = {
    page_token: 'p1',
    backfill_done: true,
    scope_roots: ['root', 'X'],
  };
  const scopedAccount = async (): Promise<AccountId> => {
    at(-120);
    const { id } = await store.createAccount({
      source: 'google-docs',
      identifier: 'scoped@example.com',
      config: {
        folderRoots: [
          { id: 'root', name: 'My Drive' },
          { id: 'X', name: 'Reports' },
        ],
      },
    });
    const fileDoc = (externalId: string): DocumentInput => ({
      ...doc(externalId),
      type: 'file',
      scopeRootId: 'X',
    });
    at(0);
    await store.commit({
      account: id,
      documents: [fileDoc('b'), fileDoc('c')],
      cursor: SCOPED_CURSOR,
    }); // publishes at t = 0
    return id;
  };
  const scopedRows = async (id: AccountId) =>
    (
      (await db.all(
        `SELECT COUNT(*) AS c FROM changes WHERE kind = 'account' AND ref_id = ?`,
        [id],
      )) as Array<{ c: number }>
    )[0].c;
  const armScopeFailure = () =>
    db._conn!.exec(
      `CREATE TRIGGER folder_scope_boom
         BEFORE UPDATE OF archived_at ON documents
         WHEN (SELECT COUNT(*) FROM documents
                WHERE account_id = NEW.account_id
                  AND archived_at IS NOT NULL) >= 1
         BEGIN SELECT RAISE(ABORT, 'forced-archive-failure'); END`,
    );
  const failingScope = async (id: AccountId) =>
    store
      .applyFolderScope({
        accountId: id,
        config: { folderRoots: [{ id: 'root', name: 'My Drive' }] },
        cursor: {
          page_token: 'p2',
          backfill_done: false,
          scope_roots: ['root'],
        },
        archiveScopeRootIds: ['X'],
        reattributeScopeRoots: [],
        archiveRefs: [],
        expectedConfigJson: JSON.stringify((await store.account(id))!.config),
      })
      .then(
        () => null,
        (e: unknown) => e as { message?: string },
      );
  const progressAt = (id: AccountId, sec: number) => {
    at(sec);
    return store.commit({
      account: id,
      documents: [],
      cursor: SCOPED_CURSOR,
      progress: { done: sec },
    } as never);
  };
  /** After a rolled-back append at t = 55 the deadline is still t = 60
   *  (from the t = 0 publication), not 115. */
  const expectDeadlineSixty = async (id: AccountId, base: number) => {
    expect(await scopedRows(id)).toBe(base); // rolled back
    await progressAt(id, 50);
    expect(await scopedRows(id)).toBe(base);
    await progressAt(id, 60);
    expect(await scopedRows(id)).toBe(base + 1);
  };

  it('a rolled-back account append (failed applyFolderScope) keeps the original deadline', async () => {
    const id = await scopedAccount();
    const base = await scopedRows(id);
    armScopeFailure();
    at(55);
    expect((await failingScope(id))?.message).toMatch(/forced-archive-failure/);
    db._conn!.exec(`DROP TRIGGER folder_scope_boom`);
    await expectDeadlineSixty(id, base);
  });

  it('a read in flight while a write fails and rolls back does not publish the failed append', async () => {
    const id = await scopedAccount();
    const base = await scopedRows(id);
    armScopeFailure();
    at(55);
    // 1. Everything the scope call needs is read BEFORE the competing read.
    const expectedConfigJson = JSON.stringify(
      (await store.account(id))!.config,
    );
    // Hold the in-process AppDb queue so the competing read is GUARANTEED
    // to stay pending across the transaction (no reliance on microtask order).
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const held = db.withExclusive!(() => gate);
    let readSettled = false;
    const read = db.all(`SELECT COUNT(*) AS c FROM documents`).then((rows) => {
      readSettled = true;
      return rows;
    });
    // 2. Next microtask, no await in between: the in-process applyFolderScope
    //    runs its synchronous transaction inside the call, which throws
    //    (rolls back) before the call returns its rejected promise.
    let pendingAtThrow: boolean | null = null;
    const failed = Promise.resolve().then(() => {
      const p = store.applyFolderScope({
        accountId: id,
        config: { folderRoots: [{ id: 'root', name: 'My Drive' }] },
        cursor: {
          page_token: 'p2',
          backfill_done: false,
          scope_roots: ['root'],
        },
        archiveScopeRootIds: ['X'],
        reattributeScopeRoots: [],
        archiveRefs: [],
        expectedConfigJson,
      });
      pendingAtThrow = !readSettled; // the transaction has already thrown here
      return p.then(
        () => null,
        (e: unknown) => e as { message?: string },
      );
    });
    const err = await failed;
    // 3. The competing read was still pending when the transaction threw.
    expect(err?.message).toMatch(/forced-archive-failure/);
    expect(pendingAtThrow).toBe(true);
    expect(readSettled).toBe(false);
    release();
    await held;
    await read;
    expect(readSettled).toBe(true);
    db._conn!.exec(`DROP TRIGGER folder_scope_boom`);
    await expectDeadlineSixty(id, base);
  });

  // Every account-publication path must mark: if one stops, the t = 60
  // commit (5 s after that writer's row) publishes again and its case fails.
  // (commitTx itself is pinned by the tick tests above.)
  it.each([
    [
      'createAccount',
      async () =>
        (await store.createAccount({ source: 'test', identifier: 'fresh' })).id,
    ],
    [
      'getOrCreateAccount (create)',
      async () => (await store.getOrCreateAccount('test', 'fresh2')).id,
    ],
    [
      'setAccountCadence',
      async () => {
        await store.setAccountCadence(accountId, { every: '15m' });
        return accountId;
      },
    ],
    [
      'setAccountConfig',
      async () => {
        await store.setAccountConfig(accountId, { marks: 1 });
        return accountId;
      },
    ],
    [
      'setAccountStatus',
      async () => {
        await store.setAccountStatus(accountId, { status: 'backfilling' });
        return accountId;
      },
    ],
    [
      'applyFolderScope',
      async () => {
        const id = await scopedAccount();
        at(55);
        const r = await store.applyFolderScope({
          accountId: id,
          config: {
            folderRoots: [
              { id: 'root', name: 'My Drive' },
              { id: 'X', name: 'Reports' },
            ],
            marks: 1,
          },
          cursor: SCOPED_CURSOR,
          archiveScopeRootIds: [],
          reattributeScopeRoots: [],
          archiveRefs: [],
          expectedConfigJson: JSON.stringify((await store.account(id))!.config),
        });
        expect(r.stale).toBe(false);
        return id;
      },
    ],
  ] as Array<[string, () => Promise<AccountId>]>)(
    'marks: %s publishing at t = 55 holds the next progress row until t >= 115',
    async (_name, write) => {
      await commitAt(0); // accountId published at t = 0
      at(55);
      const id = await write();
      const afterWrite = await scopedRows(id);
      await progressAt(id, 60); // 5 s after the writer's own row
      expect(await scopedRows(id)).toBe(afterWrite);
      await progressAt(id, 115);
      expect(await scopedRows(id)).toBe(afterWrite + 1);
    },
  );
});
describe('cadence, config and getOrCreateAccount log only real changes (#135)', () => {
  let dir: string;
  let db: AppDb;
  let store: CoreStore;
  let accountId: AccountId;
  const deps = {
    encrypt: (s: string) => Buffer.from(s, 'utf8'),
    decrypt: (b: Buffer) => b.toString('utf8'),
    detectLanguages: () => ['eng'],
  };

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-acc2-'));
    db = await openDb(path.join(dir, 'test.db'));
    store = openStore(db, deps);
    accountId = (
      await store.createAccount({ source: 'test', identifier: 'me' })
    ).id;
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const rows = async () =>
    (
      (await db.all(
        `SELECT COUNT(*) AS c FROM changes WHERE kind = 'account'`,
      )) as Array<{
        c: number;
      }>
    )[0].c;

  it('setAccountCadence: a change logs once, the same value again logs nothing', async () => {
    const r0 = await rows();
    await store.setAccountCadence(accountId, { every: '15m' });
    expect(await rows()).toBe(r0 + 1);
    await store.setAccountCadence(accountId, { every: '15m' });
    expect(await rows()).toBe(r0 + 1);
    await store.setAccountCadence(accountId, null);
    await store.setAccountCadence(accountId, null);
    expect(await rows()).toBe(r0 + 2);
  });

  it('setAccountConfig: a change logs once, the same config again logs nothing', async () => {
    const r0 = await rows();
    await store.setAccountConfig(accountId, { a: 1 });
    await store.setAccountConfig(accountId, { a: 1 });
    expect(await rows()).toBe(r0 + 1);
    expect((await store.account(accountId))?.config).toEqual({ a: 1 });
  });

  it('getOrCreateAccount: found appends nothing and wakes no feed; created appends one', async () => {
    const r0 = await rows();
    const it = store.feed(await store.headSeq())[Symbol.asyncIterator]();
    const next = it.next();
    await settle();
    const spy = jest.spyOn(db, 'all');
    await store.getOrCreateAccount('test', 'me');
    await settle();
    expect(await rows()).toBe(r0);
    expect(
      spy.mock.calls.filter(([sql]) =>
        /FROM changes WHERE seq > \?/.test(sql as string),
      ),
    ).toHaveLength(0);
    await store.getOrCreateAccount('test', 'new');
    expect(await rows()).toBe(r0 + 1);
    await next;
    await it.return?.();
  });
});
