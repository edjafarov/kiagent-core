/** Spec 7.4: one writer transaction with its cursor; rows verbatim. */
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

import type { DocumentInput } from '@shared/contracts';

import { openDb, type AppDb } from '../../../db/app-db';
import { migrate } from '../../store/schema';
import { openStore, type CoreStore } from '../../store/store';
import { createWriteTx, type WriteTx } from '../../store/write-tx';
import { buildDelta, SyncStageInvalid, type SyncCursor } from '../delta';
import { disableTracking, enableTracking } from '../tracking';
import { SyncReadOnly } from '../role';
import { addAttention, addDraft, addOutbox, physical, registerPlugin } from './synced-plugin';

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
  metadata: { k: externalId },
  createdAt: null,
});

let dir: string;
let source: AppDb;
let sourceStore: CoreStore;
let dest: AppDb;
let destTx: WriteTx;
let reader: Database.Database;
let stage: string;
let after: SyncCursor;

const src = () => source._conn!;
const dst = () => dest._conn!;
const account = (identifier = 'a@b') =>
  sourceStore.createAccount({ source: 'test', identifier });
const commit = (id: string, documents: DocumentInput[]) =>
  sourceStore.commit({ account: id as never, documents, cursor: null });
const sync = () => {
  const r = buildDelta(reader, after, 0, stage, 250 * 1024 * 1024);
  if (r.status !== 'ok') throw new Error(r.status);
  const res = destTx.applyDelta(stage);
  after = res.target;
  return res;
};
const rows = (c: Database.Database, tbl: string) =>
  c.prepare(`SELECT * FROM ${tbl} ORDER BY id`).all();
const search = (c: Database.Database, term: string) =>
  (c.prepare(`SELECT doc_id FROM documents_fts WHERE documents_fts MATCH ?`).all(term) as {
    doc_id: string;
  }[]).map((r) => r.doc_id);
const searchRowCount = (c: Database.Database) =>
  (c.prepare(`SELECT count(*) n FROM documents_tri`).get() as { n: number }).n;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-apply-'));
  const file = path.join(dir, 'src.db');
  source = await openDb(file);
  migrate(src());
  sourceStore = openStore(source, deps);
  enableTracking(src());
  dest = await openDb(path.join(dir, 'dst.db'));
  migrate(dst());
  dst().prepare(`UPDATE sync_state SET role = 'follower'`).run();
  destTx = createWriteTx(dst(), { detectLanguages: () => ['eng'], now: () => new Date().toISOString() });
  reader = new Database(file, { readonly: true });
  stage = path.join(dir, 'stage');
  after = { seq: 0, cursor: 0 };
});
afterEach(async () => {
  reader.close();
  await source.close();
  await dest.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

it('after applying, copied tables and search match the source', async () => {
  const a = await account();
  await commit(a.id, [doc('d1', 'alpha'), doc('d2', 'bravo')]);
  sync();
  expect(rows(dst(), 'documents')).toEqual(rows(src(), 'documents'));
  expect(rows(dst(), 'accounts')).toEqual(rows(src(), 'accounts'));
  expect(search(dst(), 'alpha')).toEqual(search(src(), 'alpha'));
  await commit(a.id, [doc('d1', 'charlie')]);
  sync();
  expect(search(dst(), 'alpha')).toEqual([]);
  expect(search(dst(), 'charlie')).toEqual(search(src(), 'charlie'));
});

it('writes content_hash, seq and metadata verbatim', async () => {
  const a = await account();
  await commit(a.id, [doc('d1')]);
  src().prepare(`UPDATE documents SET content_hash='custom', metadata='{"e":1}'`).run();
  sync();
  expect(dst().prepare(`SELECT content_hash, metadata, seq FROM documents`).get()).toEqual(
    src().prepare(`SELECT content_hash, metadata, seq FROM documents`).get(),
  );
});

it('adds a changes row per document with INSERT OR IGNORE', async () => {
  const a = await account();
  await commit(a.id, [doc('d1')]);
  sync();
  const d = dst().prepare(`SELECT id, seq FROM documents`).get() as { id: string; seq: number };
  expect(dst().prepare(`SELECT kind, ref_id FROM changes WHERE seq=?`).get(d.seq)).toEqual({
    kind: 'document',
    ref_id: d.id,
  });
  expect(() => destTx.applyDelta(stage)).not.toThrow();
});

it('deletes a tracked key with no row, including its search rows', async () => {
  const a = await account();
  await commit(a.id, [doc('d1', 'alpha')]);
  sync();
  const id = (src().prepare(`SELECT id FROM documents`).get() as { id: string }).id;
  src().prepare(`DELETE FROM documents_fts WHERE rowid=(SELECT rowid FROM documents WHERE id=?)`).run(id);
  src().prepare(`DELETE FROM documents_tri WHERE rowid=(SELECT rowid FROM documents WHERE id=?)`).run(id);
  src().prepare(`DELETE FROM documents WHERE id=?`).run(id);
  sync();
  expect(rows(dst(), 'documents')).toEqual([]);
  expect(search(dst(), 'alpha')).toEqual([]);
  expect(searchRowCount(dst())).toBe(0);
});

it('a truncated stage or wrong sha256 throws and moves nothing', async () => {
  const a = await account();
  await commit(a.id, [doc('d1')]);
  const r = buildDelta(reader, after, 0, stage, 1e9);
  if (r.status !== 'ok') throw new Error(r.status);
  const bytes = fs.readFileSync(stage);
  fs.writeFileSync(stage, bytes.subarray(0, bytes.length - 10));
  expect(() => destTx.applyDelta(stage)).toThrow(SyncStageInvalid);
  expect(rows(dst(), 'documents')).toEqual([]);
  expect(dst().prepare(`SELECT after_seq s FROM sync_state`).get()).toEqual({ s: 0 });
});

it('a failure mid-apply rolls back rows and cursor together', async () => {
  const a = await account();
  await commit(a.id, [doc('d1'), doc('d2')]);
  const r = buildDelta(reader, after, 0, stage, 1e9);
  if (r.status !== 'ok') throw new Error(r.status);
  dst().exec(`CREATE TRIGGER boom BEFORE INSERT ON changes WHEN NEW.ref_id IN
    (SELECT id FROM documents WHERE external_id='d2') BEGIN SELECT RAISE(ABORT,'boom'); END`);
  expect(() => destTx.applyDelta(stage)).toThrow(/boom/);
  expect(rows(dst(), 'documents')).toEqual([]);
  expect(dst().prepare(`SELECT after_seq s FROM sync_state`).get()).toEqual({ s: 0 });
});

it('an interrupted then repeated apply of the same stage converges', async () => {
  const a = await account();
  await commit(a.id, [doc('d1', 'alpha')]);
  sync();
  destTx.applyDelta(stage);
  expect(rows(dst(), 'documents')).toEqual(rows(src(), 'documents'));
  expect(search(dst(), 'alpha')).toHaveLength(1);
});

it('writes no sync_rows while applying, even with triggers present', async () => {
  const a = await account();
  await commit(a.id, [doc('d1')]);
  // Triggers remain on a device that was tracking before it became a follower.
  dst().prepare(`UPDATE sync_state SET role = 'normal'`).run();
  enableTracking(dst());
  disableTracking(dst());
  dst().prepare(`UPDATE sync_state SET role = 'follower'`).run();
  dst().prepare(`DELETE FROM sync_rows`).run();
  sync();
  expect(dst().prepare(`SELECT count(*) n FROM sync_rows`).get()).toEqual({ n: 0 });
});

it('updating an account keeps its documents and updating a document keeps its rowid', async () => {
  const a = await account();
  await commit(a.id, [doc('d1', 'alpha')]);
  sync();
  const before = dst().prepare(`SELECT rowid r FROM documents`).get();
  src().prepare(`UPDATE accounts SET cursor='"x"' WHERE id=?`).run(a.id);
  await commit(a.id, [doc('d1', 'bravo')]);
  sync();
  expect(dst().prepare(`SELECT rowid r FROM documents`).get()).toEqual(before);
  expect(search(dst(), 'bravo')).toHaveLength(1);
});

it('removing an account leaves no search rows, and new rows can follow in the same delta', async () => {
  const gone = await account('gone');
  await commit(gone.id, [doc('old', 'alpha')]);
  sync();
  await sourceStore.commit({ removeAccount: gone.id } as never);
  const a = await account('new');
  await commit(a.id, [doc('fresh', 'bravo')]);
  sync();
  expect(search(dst(), 'alpha')).toEqual([]);
  expect(search(dst(), 'bravo')).toHaveLength(1);
  expect(searchRowCount(dst())).toBe(1);
  expect(rows(dst(), 'accounts')).toEqual(rows(src(), 'accounts'));
});

it('a delete and re-ingest under a new id with the same natural key applies', async () => {
  const a = await account();
  await commit(a.id, [doc('d1', 'alpha')]);
  sync();
  await sourceStore.commit({ removeAccount: a.id } as never);
  const again = await account();
  await commit(again.id, [doc('d1', 'bravo')]);
  sync();
  expect(rows(dst(), 'documents')).toEqual(rows(src(), 'documents'));
  expect(search(dst(), 'bravo')).toHaveLength(1);
});

it('a damaged target in the trailer is refused, and the position does not move', () => {
  const r = buildDelta(reader, after, 0, stage, 250 * 1024 * 1024);
  if (r.status !== 'ok') throw new Error(r.status);
  const text = fs.readFileSync(stage, 'utf8').trimEnd().split('\n');
  const trailer = JSON.parse(text[text.length - 1]);
  trailer.target.seq += 1000;
  text[text.length - 1] = JSON.stringify(trailer);
  fs.writeFileSync(stage, `${text.join('\n')}\n`);
  expect(() => destTx.applyDelta(stage)).toThrow(SyncStageInvalid);
});

it('a master refuses to apply a delta', () => {
  dst().prepare(`UPDATE sync_state SET role = 'normal'`).run();
  const r = buildDelta(reader, after, 0, stage, 250 * 1024 * 1024);
  if (r.status !== 'ok') throw new Error(r.status);
  expect(() => destTx.applyDelta(stage)).toThrow('only a follower');
});

it('a follower cannot turn tracking on', () => {
  expect(() => enableTracking(dst())).toThrow(SyncReadOnly);
});

it('reset all makes a follower a normal device with nothing to resume', async () => {
  const a = await account();
  await commit(a.id, [doc('d1')]);
  sync();
  const destStore = openStore(dest, deps);
  await destStore.maintenance.resetAll();
  expect(dst().prepare(`SELECT role, tracking, after_seq, after_cursor, history_id, master_device_id FROM sync_state`).get()).toEqual({
    role: 'normal', tracking: 0, after_seq: 0, after_cursor: 0, history_id: null, master_device_id: null,
  });
});

it('reset all on a tracking master starts a new history and leaves no tracked rows', async () => {
  const a = await account();
  await commit(a.id, [doc('d1')]);
  enableTracking(src());
  await sourceStore.maintenance.resetAll();
  expect(src().prepare(`SELECT history_id, tracking FROM sync_state`).get()).toEqual({ history_id: null, tracking: 0 });
  expect(src().prepare(`SELECT count(*) n FROM sync_rows`).get()).toEqual({ n: 0 });
});

describe('rewind (step 2)', () => {
  it('writes the master epoch into sync_state in the apply transaction', async () => {
    const a = await account();
    await commit(a.id, [doc('d1')]);
    src().prepare(`UPDATE sync_state SET epoch = 4`).run();
    sync();
    expect((dst().prepare(`SELECT epoch FROM sync_state`).get() as { epoch: number }).epoch).toBe(4);
  });

  it('a follower ahead of the new master converges to its rows', async () => {
    const a = await account();
    await commit(a.id, [doc('d1', 'old master wrote this'), doc('d2')]);
    sync();
    // The follower heard more from the old master than the new one ever had.
    const stale = dst().prepare(`UPDATE documents SET markdown = 'only on the old master', seq = 900 WHERE external_id = 'd1'`);
    stale.run();
    dst().prepare(`UPDATE sync_state SET after_seq = 900, after_cursor = 900, epoch = 1`).run();
    after = { seq: 900, cursor: 900 };
    src().prepare(`UPDATE sync_state SET epoch = 2`).run();
    src().prepare(`INSERT INTO sync_epochs(epoch, grant_seq, grant_cursor) VALUES(2, 0, 0)`).run();
    const r = buildDelta(reader, after, 1, stage, 250 * 1024 * 1024);
    if (r.status !== 'ok') throw new Error(r.status);
    destTx.applyDelta(stage);
    const md = (c: Database.Database) =>
      c.prepare(`SELECT external_id, markdown FROM documents ORDER BY external_id`).all();
    expect(md(dst())).toEqual(md(src()));
    expect((dst().prepare(`SELECT epoch FROM sync_state`).get() as { epoch: number }).epoch).toBe(2);
  });
});

describe('more copied tables (step 2)', () => {
  it('outbox and event_drafts rows travel and apply', async () => {
    const a = await account();
    addOutbox(src(), a.id, 'o1', 'sent');
    addDraft(src(), a.id, 'e1');
    sync();
    expect(rows(dst(), 'outbox')).toEqual(rows(src(), 'outbox'));
    expect(rows(dst(), 'event_drafts')).toEqual(rows(src(), 'event_drafts'));
    src().prepare(`UPDATE outbox SET status='failed' WHERE id='o1'`).run();
    src().prepare(`DELETE FROM event_drafts`).run();
    sync();
    expect(rows(dst(), 'outbox')).toEqual(rows(src(), 'outbox'));
    expect(rows(dst(), 'event_drafts')).toEqual([]);
  });

  it('attention rows and epochs travel and apply', async () => {
    addAttention(src(), 'att1');
    src().prepare(`INSERT INTO sync_epochs(epoch, grant_seq, grant_cursor) VALUES(2, 5, 6)`).run();
    sync();
    expect(rows(dst(), 'attention_items')).toEqual(rows(src(), 'attention_items'));
    expect(rows(dst(), 'attention_revisions')).toEqual(rows(src(), 'attention_revisions'));
    expect(dst().prepare(`SELECT * FROM sync_epochs`).all()).toEqual([{ epoch: 2, grant_seq: 5, grant_cursor: 6 }]);
  });

  it('apply upserts on the table primary key, blobs included, and deletes by it', async () => {
    await registerPlugin(path.join(dir, 'src.db'), src());
    await registerPlugin(path.join(dir, 'dst.db'), dst());
    const n = physical('notes');
    const b = physical('blobs');
    src().prepare(`INSERT INTO "${n}"(account_id, key, body) VALUES('a','k','one'),('a','j','two')`).run();
    src().prepare(`INSERT INTO "${b}"(id, data) VALUES('x', ?)`).run(Buffer.from([0, 1, 2, 255]));
    sync();
    src().prepare(`UPDATE "${n}" SET body='three' WHERE key='k'`).run();
    src().prepare(`DELETE FROM "${n}" WHERE key='j'`).run();
    sync();
    expect(dst().prepare(`SELECT account_id, key, body FROM "${n}"`).all()).toEqual([
      { account_id: 'a', key: 'k', body: 'three' },
    ]);
    const got = dst().prepare(`SELECT data FROM "${b}"`).get() as { data: Buffer };
    expect(Buffer.compare(got.data, Buffer.from([0, 1, 2, 255]))).toBe(0);
  });

  it('a table that is not copied on this device is refused', async () => {
    await registerPlugin(path.join(dir, 'src.db'), src());
    src().prepare(`INSERT INTO "${physical('notes')}"(account_id, key, body) VALUES('a','k','one')`).run();
    const r = buildDelta(reader, after, 0, stage, 1e9);
    if (r.status !== 'ok') throw new Error(r.status);
    expect(() => destTx.applyDelta(stage)).toThrow(SyncStageInvalid);
  });
});
