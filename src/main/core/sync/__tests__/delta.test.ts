/** Spec 7.3 and 7.6: a delta is one consistent state, deletes before upserts. */
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

import type { DocumentInput } from '@shared/contracts';

import { openDb, type AppDb } from '../../../db/app-db';
import { migrate } from '../../store/schema';
import { openStore, type CoreStore } from '../../store/store';
import { buildDelta, readStage, validateStage, type StageEntry } from '../delta';
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

let db: AppDb;
let store: CoreStore;
let dir: string;
let file: string;
let out: string;
let reader: Database.Database;
const conn = () => db._conn!;
const rowOf = (e: StageEntry) => (e.op === 'upsert' ? e.row : {}) as Record<string, string>;
const START = { seq: 0, cursor: 0 };
const MB = 1024 * 1024;
const account = (identifier = 'a@b') =>
  store.createAccount({ source: 'test', identifier });
const commit = (id: string, documents: DocumentInput[]) =>
  store.commit({ account: id as never, documents, cursor: null });
const docId = (ext: string) =>
  (conn().prepare(`SELECT id FROM documents WHERE external_id=?`).get(ext) as { id: string }).id;
const build = (after = START, cap = 250 * MB, fromEpoch = 0) => buildDelta(reader, after, fromEpoch, out, cap);

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-delta-'));
  file = path.join(dir, 'a.db');
  out = path.join(dir, 'stage');
  db = await openDb(file);
  migrate(conn());
  store = openStore(db, deps);
  reader = new Database(file, { readonly: true });
});
afterEach(async () => {
  jest.restoreAllMocks();
  reader.close();
  await db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

it('returns documents above seq and tracked rows above cursor', async () => {
  const a = await account();
  await commit(a.id, [doc('d1')]);
  enableTracking(conn());
  const first = build();
  if (first.status !== 'ok') throw new Error('expected ok');
  await commit(a.id, [doc('d2')]);
  const second = build(first.target);
  if (second.status !== 'ok') throw new Error('expected ok');
  const { entries } = readStage(out);
  const docs = entries.filter((e) => e.op === 'upsert' && e.tbl === 'documents');
  expect(docs.map((e) => rowOf(e).external_id)).toEqual(['d2']);
  expect(entries.some((e) => e.tbl === 'accounts')).toBe(true); // the commit moved its cursor
});

it('sends a key that is both tracked and in the seq range once, in its current state', async () => {
  const a = await account();
  enableTracking(conn());
  await commit(a.id, [doc('d1')]);
  const id = docId('d1');
  conn().prepare(`UPDATE documents SET scope_root_id='r' WHERE id=?`).run(id);
  build();
  const docs = readStage(out).entries.filter((e) => e.tbl === 'documents');
  expect(docs).toHaveLength(1);
  expect(rowOf(docs[0]).scope_root_id).toBe('r');
});

it('a tracked key with no row is written as a delete', async () => {
  const a = await account();
  await commit(a.id, [doc('d1')]);
  const id = docId('d1');
  enableTracking(conn());
  conn().prepare(`DELETE FROM documents WHERE id=?`).run(id);
  build();
  expect(readStage(out).entries).toContainEqual({ op: 'delete', tbl: 'documents', pk: [id] });
});

it('writes deletes children-first, then upserts parents-first', async () => {
  const gone = await account('gone');
  await commit(gone.id, [doc('old')]);
  enableTracking(conn());
  await store.commit({ removeAccount: gone.id } as never);
  const a = await account('kept');
  await commit(a.id, [doc('new')]);
  build();
  const shape = readStage(out).entries.map((e) => `${e.op}:${e.tbl}`);
  expect(shape).toEqual(['delete:documents', 'delete:accounts', 'upsert:accounts', 'upsert:documents']);
});

it('is one consistent state: a commit during the build is not partly included', async () => {
  const a = await account();
  await commit(a.id, [doc('d1')]);
  enableTracking(conn());
  const realWrite = fs.writeSync;
  let once = true;
  jest.spyOn(fs, 'writeSync').mockImplementation(((...args: unknown[]) => {
    if (once) {
      once = false;
      conn().prepare(`UPDATE documents SET title='late', seq=seq+100 WHERE external_id='d1'`).run();
    }
    return (realWrite as (...x: unknown[]) => number)(...args);
  }) as typeof fs.writeSync);
  const r = build();
  if (r.status !== 'ok') throw new Error('expected ok');
  const docs = readStage(out).entries.filter((e) => e.tbl === 'documents');
  expect(rowOf(docs[0]).title).toBe('d1');
  const head = conn().prepare(`SELECT max(seq) s FROM documents`).get() as { s: number };
  expect(r.target.seq).toBeLessThan(head.s);
});

it('returns too-large over the cap and leaves no file', async () => {
  const a = await account();
  await commit(a.id, [doc('d1', 'x'.repeat(5000))]);
  expect(build(START, 1000)).toEqual({ status: 'too-large' });
  expect(fs.existsSync(out)).toBe(false);
});

it('never emits a row from a table outside the allowlist', async () => {
  const a = await account();
  enableTracking(conn());
  await commit(a.id, [doc('d1')]);
  conn().prepare(`INSERT INTO sync_rows(tbl, pk) VALUES('vault', '["k"]')`).run();
  const r = build();
  if (r.status !== 'ok') throw new Error('expected ok');
  expect(readStage(out).entries.some((e) => e.tbl === 'vault')).toBe(false);
  const max = conn().prepare(`SELECT max(cursor) c FROM sync_rows`).get() as { c: number };
  expect(r.target.cursor).toBe(max.c); // still moves past it
});

it('handles U+2028 in markdown', async () => {
  const a = await account();
  await commit(a.id, [doc('d1', 'one two\nthree')]);
  build();
  const docs = readStage(out).entries.filter((e) => e.tbl === 'documents');
  expect(rowOf(docs[0]).markdown).toBe('one two\nthree');
});

it('readStage refuses a truncated or altered file', async () => {
  const a = await account();
  await commit(a.id, [doc('d1')]);
  build();
  const bytes = fs.readFileSync(out);
  fs.writeFileSync(out, bytes.subarray(0, bytes.length - 20));
  expect(() => readStage(out)).toThrow(/invalid/i);
  const altered = Buffer.from(bytes);
  altered[5] ^= 1;
  fs.writeFileSync(out, altered);
  expect(() => readStage(out)).toThrow(/invalid/i);
});

describe('rewind to the grant (step 2)', () => {
  const lead = (epoch: number, seq: number, cursor: number) => {
    conn().prepare(`UPDATE sync_state SET epoch = ?`).run(epoch);
    conn().prepare(`INSERT INTO sync_epochs(epoch, grant_seq, grant_cursor) VALUES(?, ?, ?)`).run(epoch, seq, cursor);
  };
  const seqs = () =>
    (conn().prepare(`SELECT seq FROM documents ORDER BY seq`).all() as { seq: number }[]).map((r) => r.seq);
  const externalIds = () =>
    readStage(out).entries.filter((e) => e.op === 'upsert' && e.tbl === 'documents').map((e) => rowOf(e).external_id);
  const seed = async () => {
    enableTracking(conn());
    const a = await account();
    await commit(a.id, [doc('d1'), doc('d2'), doc('d3')]);
    return seqs();
  };

  it('a follower from an older epoch is served from the grant', async () => {
    const [s1] = await seed();
    lead(2, s1, 0);
    const ahead = { seq: 1000, cursor: 1000 };
    const r = build(ahead, undefined, 1);
    if (r.status !== 'ok') throw new Error('expected ok');
    expect(r.from).toEqual({ seq: s1, cursor: 0 });
    expect(externalIds().sort()).toEqual(['d2', 'd3']);
  });

  it('a follower already at the current epoch is not rewound', async () => {
    const [s1] = await seed();
    lead(2, s1, 0);
    const at = { seq: 1000, cursor: 1000 };
    const r = build(at, undefined, 2);
    if (r.status !== 'ok') throw new Error('expected ok');
    expect(r.from).toEqual(at);
    expect(r.rows).toBe(0);
  });

  it('a follower behind the grant keeps its own position', async () => {
    const [s1, s2] = await seed();
    lead(2, s2, 0);
    const behind = { seq: s1 - 1, cursor: 0 };
    const r = build(behind, undefined, 1);
    if (r.status !== 'ok') throw new Error('expected ok');
    expect(r.from).toEqual(behind);
  });

  it('two promotions: the lowest later grant wins, and only later epochs count', async () => {
    const [s1, s2, s3] = await seed();
    lead(2, s2, 2);
    lead(3, s3, 3);
    const ahead = { seq: 1000, cursor: 1000 };
    const one = build(ahead, undefined, 1);
    const two = build(ahead, undefined, 2);
    if (one.status !== 'ok' || two.status !== 'ok') throw new Error('expected ok');
    expect(one.from).toEqual({ seq: s2, cursor: 2 });
    expect(two.from).toEqual({ seq: s3, cursor: 3 });
    expect(s1).toBeLessThan(s2);
  });

  it('the stage carries the master epoch', async () => {
    await seed();
    lead(5, 0, 0);
    const r = build(START, undefined, 5);
    if (r.status !== 'ok') throw new Error('expected ok');
    expect(r.epoch).toBe(5);
    expect(validateStage(out).epoch).toBe(5);
  });
});
