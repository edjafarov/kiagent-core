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
  const r = buildDelta(reader, after, stage, 250 * 1024 * 1024);
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
  const r = buildDelta(reader, after, stage, 1e9);
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
  const r = buildDelta(reader, after, stage, 1e9);
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
  enableTracking(dst());
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
