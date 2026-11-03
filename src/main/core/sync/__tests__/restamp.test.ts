/** A leader that caught up from the interim leader and then promotes re-sends
 *  its own rows the interim leader never saw: they were numbered in the old
 *  epoch, below the interim leader's range, so a pull after the new head would
 *  skip them forever. */
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

import type { DocumentInput } from '@shared/contracts';

import { openDb, type AppDb } from '../../../db/app-db';
import { migrate } from '../../store/schema';
import { openStore, type CoreStore } from '../../store/store';
import { createWriteTx, type WriteTx } from '../../store/write-tx';
import { buildDelta } from '../delta';
import { demote, EPOCH_GAP, promote } from '../promote';
import { enableTracking } from '../tracking';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};
const doc = (externalId: string, markdown = 'body'): DocumentInput => ({
  externalId,
  type: 'file',
  title: externalId,
  markdown,
  metadata: {},
  createdAt: null,
});

interface Dev {
  db: AppDb;
  store: CoreStore;
  tx: WriteTx;
  reader: Database.Database;
  conn: () => Database.Database;
}
let dir: string;
let mac: Dev;
let vm: Dev;
let stage: string;

const open = async (name: string): Promise<Dev> => {
  const file = path.join(dir, `${name}.db`);
  const db = await openDb(file);
  migrate(db._conn!);
  return {
    db,
    store: openStore(db, deps),
    tx: createWriteTx(db._conn!, {
      detectLanguages: () => ['eng'],
      now: () => new Date().toISOString(),
    }),
    reader: new Database(file, { readonly: true }),
    conn: () => db._conn!,
  };
};
const state = (d: Dev) =>
  d
    .conn()
    .prepare(
      `SELECT role, epoch, after_seq AS seq, after_cursor AS cursor FROM sync_state`,
    )
    .get() as {
    role: string;
    epoch: number;
    seq: number;
    cursor: number;
  };
/** One pull as the follower does it: from its own position and epoch. */
const pull = (from: Dev, to: Dev) => {
  const s = state(to);
  const r = buildDelta(
    from.reader,
    { seq: s.seq, cursor: s.cursor },
    s.epoch,
    stage,
    250 * 1024 * 1024,
  );
  if (r.status !== 'ok') throw new Error(r.status);
  to.tx.applyDelta(stage);
};
const markdownOf = (d: Dev) =>
  Object.fromEntries(
    (
      d
        .conn()
        .prepare(`SELECT external_id AS e, markdown AS m FROM documents`)
        .all() as { e: string; m: string }[]
    ).map((r) => [r.e, r.m]),
  );
const names = (d: Dev) =>
  (
    d
      .conn()
      .prepare(`SELECT identifier FROM accounts ORDER BY identifier`)
      .all() as { identifier: string }[]
  ).map((r) => r.identifier);

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-restamp-'));
  stage = path.join(dir, 'stage');
  mac = await open('mac');
  vm = await open('vm');
});
afterEach(async () => {
  for (const d of [mac, vm]) {
    d.reader.close();
    await d.db.close();
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Mac leads at epoch 0, VM follows, Mac quits, VM leads at 14 and writes;
 *  Mac, back, wrote more rows at its old numbering. */
async function scenario() {
  enableTracking(mac.conn());
  const a = await mac.store.createAccount({
    source: 'test',
    identifier: 'shared',
  });
  await mac.store.commit({
    account: a.id as never,
    documents: [doc('d1', 'one'), doc('d2', 'two')],
    cursor: null,
  });
  vm.conn().prepare(`UPDATE sync_state SET role = 'follower'`).run();
  pull(mac, vm);
  promote(vm.conn(), 14);
  await vm.store.commit({
    account: a.id as never,
    documents: [doc('v1', 'interim')],
    cursor: null,
  });
  // The Mac wrote while away, below the VM's grant range.
  const b = await mac.store.createAccount({
    source: 'test',
    identifier: 'mac-only',
  });
  await mac.store.commit({
    account: b.id as never,
    documents: [doc('m1', 'unseen'), doc('d1', 'one edited')],
    cursor: null,
  });
  return { a, b };
}

it('the rows the interim leader never saw reach it after the returning leader promotes', async () => {
  await scenario();
  // Catch-up: the Mac reads the interim leader as a follower, then leads.
  demote(mac.conn(), 'vm');
  pull(vm, mac);
  expect(state(mac).epoch).toBe(14);
  expect(markdownOf(mac).v1).toBe('interim');
  promote(mac.conn(), 15);

  // The VM follows the Mac again, from its own head.
  demote(vm.conn(), 'mac');
  pull(mac, vm);
  expect(markdownOf(vm)).toEqual(markdownOf(mac));
  expect(markdownOf(vm).m1).toBe('unseen');
  expect(markdownOf(vm).d1).toBe('one edited');
  expect(names(vm)).toEqual(names(mac));
  expect(names(vm)).toContain('mac-only');
});

it('re-numbers only the rows above the interim grant and below its range', async () => {
  await scenario();
  const grant = vm
    .conn()
    .prepare(
      `SELECT grant_seq AS seq, grant_cursor AS cursor FROM sync_epochs WHERE epoch = 14`,
    )
    .get() as {
    seq: number;
    cursor: number;
  };
  demote(mac.conn(), 'vm');
  pull(vm, mac);
  promote(mac.conn(), 15);
  const seqs = mac
    .conn()
    .prepare(`SELECT external_id AS e, seq FROM documents`)
    .all() as { e: string; seq: number }[];
  const seq = Object.fromEntries(seqs.map((r) => [r.e, r.seq]));
  expect(seq.m1).toBeGreaterThan(15 * EPOCH_GAP);
  expect(seq.d1).toBeGreaterThan(15 * EPOCH_GAP);
  // d2 was copied before the grant, v1 is the interim leader's own.
  expect(seq.d2).toBeLessThanOrEqual(grant.seq);
  expect(seq.v1).toBeGreaterThan(14 * EPOCH_GAP);
  expect(seq.v1).toBeLessThan(15 * EPOCH_GAP);
  const cursors = mac
    .conn()
    .prepare(`SELECT cursor FROM sync_rows WHERE cursor > ? AND cursor < ?`)
    .all(grant.cursor, 14 * EPOCH_GAP);
  expect(cursors).toEqual([]);
});

it('a plain takeover by a follower re-numbers nothing', async () => {
  enableTracking(mac.conn());
  const a = await mac.store.createAccount({
    source: 'test',
    identifier: 'shared',
  });
  await mac.store.commit({
    account: a.id as never,
    documents: [doc('d1')],
    cursor: null,
  });
  vm.conn().prepare(`UPDATE sync_state SET role = 'follower'`).run();
  pull(mac, vm);
  const before = vm.conn().prepare(`SELECT seq FROM documents`).all();
  promote(vm.conn(), 14);
  expect(vm.conn().prepare(`SELECT seq FROM documents`).all()).toEqual(before);
});

describe('the restamp bound survives more than one takeover', () => {
  let third: Dev;
  beforeEach(async () => {
    third = await open('third');
  });
  afterEach(async () => {
    third.reader.close();
    await third.db.close();
  });

  /** Mac leads at 0, VM and the third device follow; the VM leads at 14 and the
   *  third device at 15; the Mac, away, wrote m1 at its old numbering. */
  async function twoTakeovers() {
    enableTracking(mac.conn());
    const a = await mac.store.createAccount({ source: 'test', identifier: 'shared' });
    await mac.store.commit({
      account: a.id as never,
      documents: [doc('d1', 'one'), doc('d2', 'two')],
      cursor: null,
    });
    for (const d of [vm, third]) d.conn().prepare(`UPDATE sync_state SET role = 'follower'`).run();
    pull(mac, vm);
    pull(mac, third);
    promote(vm.conn(), 14);
    await vm.store.commit({ account: a.id as never, documents: [doc('v1', 'vm')], cursor: null });
    pull(vm, third);
    expect(state(third).epoch).toBe(14);
    promote(third.conn(), 15);
    await third.store.commit({ account: a.id as never, documents: [doc('t1', 'third')], cursor: null });
    const b = await mac.store.createAccount({ source: 'test', identifier: 'mac-only' });
    await mac.store.commit({ account: b.id as never, documents: [doc('m1', 'unseen')], cursor: null });
    return { a, b };
  }

  it("the old leader's unseen row reaches the device that led last", async () => {
    await twoTakeovers();
    demote(mac.conn(), 'third');
    pull(third, mac);
    expect(state(mac).epoch).toBe(15);
    promote(mac.conn(), 16);
    // The third device follows the Mac again, from its own head.
    demote(third.conn(), 'mac');
    pull(mac, third);
    expect(markdownOf(third).m1).toBe('unseen');
    expect(markdownOf(third)).toEqual(markdownOf(mac));
    expect(names(third)).toContain('mac-only');
  });

  it('a demote remembers the epoch it left, once, and a promotion clears it', async () => {
    await twoTakeovers();
    const pre = () =>
      (mac.conn().prepare(`SELECT pre_demote_epoch AS e FROM sync_state`).get() as { e: number | null }).e;
    expect(pre()).toBeNull();
    demote(mac.conn(), 'third');
    expect(pre()).toBe(0);
    pull(third, mac);
    // Demoting again (a restart, a repeated notice) keeps the first one.
    demote(mac.conn(), 'third');
    expect(pre()).toBe(0);
    promote(mac.conn(), 16);
    expect(pre()).toBeNull();
  });
});

describe('a follower that skipped an epoch asks a relaying leader', () => {
  it('is served from the lowest grant it skipped, not told to re-copy', async () => {
    // Mac leads at 0; the VM leads at 14 (a grant at the Mac's position) and
    // writes; the Mac, never told, asks the VM with a position above that grant.
    enableTracking(mac.conn());
    const a = await mac.store.createAccount({ source: 'test', identifier: 'shared' });
    await mac.store.commit({ account: a.id as never, documents: [doc('d1')], cursor: null });
    vm.conn().prepare(`UPDATE sync_state SET role = 'follower'`).run();
    pull(mac, vm);
    promote(vm.conn(), 14);
    await mac.store.commit({ account: a.id as never, documents: [doc('m1')], cursor: null });
    const s = state(mac);
    const r = buildDelta(vm.reader, { seq: s.seq + 50, cursor: s.cursor + 50 }, 0, stage, 250 * 1024 * 1024);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    const grant = vm
      .conn()
      .prepare(`SELECT grant_seq AS seq, grant_cursor AS cursor FROM sync_epochs WHERE epoch = 14`)
      .get() as { seq: number; cursor: number };
    expect(r.from).toEqual(grant);
  });
});

describe('relaying to a third device (codex review point 5)', () => {
  it('a device that merely applied an interim leader\'s changes sends them on: an account, a pref change and a deletion', async () => {
    const third = await open('relay-third');
    try {
      enableTracking(mac.conn());
      const a = await mac.store.createAccount({ source: 'test', identifier: 'shared' });
      const gone = await mac.store.createAccount({ source: 'test', identifier: 'doomed' });
      await mac.store.commit({ account: a.id as never, documents: [doc('d1')], cursor: null });
      mac.conn().prepare(`INSERT INTO user_prefs(key, value_json) VALUES('p1', '1')`).run();
      for (const d of [vm, third]) d.conn().prepare(`UPDATE sync_state SET role = 'follower'`).run();
      pull(mac, vm);
      pull(mac, third);
      expect(names(third)).toContain('doomed');
      // The VM leads at 14 and changes things that are not documents.
      promote(vm.conn(), 14);
      await vm.store.createAccount({ source: 'test', identifier: 'vm-only' });
      vm.conn().prepare(`UPDATE user_prefs SET value_json = '2' WHERE key = 'p1'`).run();
      vm.conn().prepare(`DELETE FROM accounts WHERE id = ?`).run(gone.id);
      // The Mac applies it as a follower, then leads at 15.
      demote(mac.conn(), 'vm');
      pull(vm, mac);
      promote(mac.conn(), 15);
      expect(names(mac)).toContain('vm-only');
      // The third device, away through epoch 14, asks the Mac.
      demote(third.conn(), 'mac');
      pull(mac, third);
      expect(state(third).epoch).toBe(15);
      expect(names(third)).toContain('vm-only');
      expect(names(third)).not.toContain('doomed');
      expect(
        third.conn().prepare(`SELECT value_json AS v FROM user_prefs WHERE key = 'p1'`).get(),
      ).toEqual({ v: '2' });
      // The imported set is spent: a second promotion has nothing left to send.
      expect(
        mac.conn().prepare(`SELECT count(*) AS n FROM sync_imported`).get(),
      ).toEqual({ n: 0 });
    } finally {
      third.reader.close();
      await third.db.close();
    }
  });

  it('an update to a document that keeps its seq travels on too', async () => {
    const third = await open('relay-third-doc');
    try {
      enableTracking(mac.conn());
      const a = await mac.store.createAccount({ source: 'test', identifier: 'shared' });
      await mac.store.commit({ account: a.id as never, documents: [doc('d1')], cursor: null });
      for (const d of [vm, third]) d.conn().prepare(`UPDATE sync_state SET role = 'follower'`).run();
      pull(mac, vm);
      pull(mac, third);
      promote(vm.conn(), 14);
      // Updates that leave seq alone (and a deletion) are tracked, not seq-fed.
      vm.conn().prepare(`UPDATE documents SET title = 'renamed' WHERE external_id = 'd1'`).run();
      await vm.store.commit({ account: a.id as never, documents: [doc('d2')], cursor: null });
      vm.conn().prepare(`DELETE FROM documents WHERE external_id = 'd2'`).run();
      demote(mac.conn(), 'vm');
      pull(vm, mac);
      promote(mac.conn(), 15);
      demote(third.conn(), 'mac');
      pull(mac, third);
      const titles = (d: Dev) =>
        d.conn().prepare(`SELECT external_id AS e, title AS t FROM documents ORDER BY e`).all();
      expect(titles(third)).toEqual(titles(mac));
      expect(titles(third)).toEqual([{ e: 'd1', t: 'renamed' }]);
    } finally {
      third.reader.close();
      await third.db.close();
    }
  });
});
