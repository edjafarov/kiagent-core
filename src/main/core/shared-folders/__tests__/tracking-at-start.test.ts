/** A leader that already tracks gets the triggers of the two copied tables the
 *  first time this build opens it, and a factory reset clears all three. */
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

import { openDb } from '../../../db/app-db';
import { resetCoreStoreTables } from '../../../db/repositories/core-maintenance';
import { buildDelta, readStage } from '../../sync/delta';
import { enableTracking } from '../../sync/tracking';
import { migrate } from '../../store/schema';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-trk-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

it('a tracking leader that upgrades ships the shared rows in its next delta', async () => {
  const file = path.join(dir, 'a.db');
  const db = await openDb(file);
  const conn = db._conn!;
  migrate(conn);
  enableTracking(conn);
  // The state of a leader that tracked before this build: no triggers on the new tables.
  for (const t of ['shared_files', 'shared_capture_files'])
    for (const k of ['i', 'u', 'd']) conn.exec(`DROP TRIGGER IF EXISTS "sync_${k}_${t}"`);
  migrate(conn); // the start path
  conn.exec(`INSERT INTO shared_files(root, rel_path, sha256, bytes, mtime, rev) VALUES('incoming','a.jpg','h',1,'2026-01-01T00:00:00Z',1)`);
  conn.exec(`INSERT INTO shared_capture_files(capture_id, sha256) VALUES('c1','h')`);
  const reader = new Database(file, { readonly: true });
  const out = path.join(dir, 'stage');
  buildDelta(reader, { seq: 0, cursor: 0 }, 0, out, 1e9);
  const tables = new Set<string>();
  for (const e of readStage(out).entries) tables.add((e as { tbl: string }).tbl);
  reader.close();
  expect(tables.has('shared_files')).toBe(true);
  expect(tables.has('shared_capture_files')).toBe(true);
  await db.close();
});

it('a factory reset clears the manifest, the captures and the mirror', async () => {
  const db = await openDb(path.join(dir, 'b.db'));
  const conn = db._conn!;
  migrate(conn);
  conn.exec(`INSERT INTO shared_files(root, rel_path, sha256, bytes, mtime, rev) VALUES('incoming','a.jpg','h',1,'x',1)`);
  conn.exec(`INSERT INTO shared_capture_files(capture_id, sha256) VALUES('c1','h')`);
  conn.exec(`INSERT INTO shared_mirror(root, rel_path, sha256, bytes, mtime_ms) VALUES('incoming','a.jpg','h',1,1)`);
  await resetCoreStoreTables(db, [], () => 'now');
  for (const t of ['shared_files', 'shared_capture_files', 'shared_mirror'])
    expect((conn.prepare(`SELECT count(*) n FROM ${t}`).get() as { n: number }).n).toBe(0);
  await db.close();
});
