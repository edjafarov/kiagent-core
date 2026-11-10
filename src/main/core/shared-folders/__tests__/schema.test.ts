import fs from 'fs';
import os from 'os';
import path from 'path';

import { openDb, type AppDb } from '../../../db/app-db';
import { migrate } from '../../store/schema';
import { COPIED_CORE_TABLES, LOCAL_CORE_TABLES } from '../../sync/tables';
import { disableTracking, enableTracking } from '../../sync/tracking';

let db: AppDb;
let dir: string;
const conn = () => db._conn!;
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-schema-'));
  db = await openDb(path.join(dir, 'a.db'));
  migrate(conn());
});
afterEach(async () => {
  await db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

it('classifies the three tables', () => {
  expect(COPIED_CORE_TABLES).toEqual(expect.arrayContaining(['shared_files', 'shared_capture_files']));
  expect(LOCAL_CORE_TABLES).toContain('shared_mirror');
});

it('has the columns the plan names', () => {
  const cols = (t: string) =>
    (conn().prepare(`SELECT name FROM pragma_table_info(?)`).all(t) as { name: string }[]).map((c) => c.name);
  expect(cols('shared_files')).toEqual([
    'root', 'rel_path', 'sha256', 'bytes', 'mtime', 'missing_here', 'deleted', 'parked', 'rev',
  ]);
  expect(cols('shared_capture_files')).toEqual(['capture_id', 'sha256']);
  expect(cols('shared_mirror')).toEqual(['root', 'rel_path', 'sha256', 'bytes', 'mtime_ms', 'capture_id']);
});

it('a write to a copied shared table is tracked for followers; the mirror is not', () => {
  enableTracking(conn());
  conn()
    .prepare(`INSERT INTO shared_files(root, rel_path, sha256, bytes, mtime, rev) VALUES('incoming','a.pdf','h',1,'t',1)`)
    .run();
  conn().prepare(`INSERT INTO shared_capture_files(capture_id, sha256) VALUES('c','h')`).run();
  conn()
    .prepare(`INSERT INTO shared_mirror(root, rel_path, sha256, bytes, mtime_ms) VALUES('incoming','a.pdf','h',1,1)`)
    .run();
  const tbls = (conn().prepare(`SELECT tbl FROM sync_rows ORDER BY cursor`).all() as { tbl: string }[]).map((r) => r.tbl);
  expect(tbls).toEqual(['shared_files', 'shared_capture_files']);
  disableTracking(conn());
});
