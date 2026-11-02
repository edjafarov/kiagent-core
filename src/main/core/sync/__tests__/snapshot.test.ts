/** Spec 7.5 and 7.6: a clean snapshot file, and a crash-safe swap at boot. */
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

import type { DocumentInput } from '@shared/contracts';

import { openDb, type AppDb } from '../../../db/app-db';
import { migrate } from '../../store/schema';
import { openStore, type CoreStore } from '../../store/store';
import { buildDelta } from '../delta';
import { buildSnapshot } from '../snapshot';
import { applyPendingSwap, prepareRestore, prepareSwap, SWAP_STEPS } from '../swap';
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
const SECRET = 'PLANTEDSECRETVALUE';

let dir: string;
let master: AppDb;
let store: CoreStore;
let masterFile: string;
let snap: string;
let receiver: string;
const conn = () => master._conn!;
const commit = (id: string, documents: DocumentInput[]) =>
  store.commit({ account: id as never, documents, cursor: null });
const account = (identifier = 'a@b') => store.createAccount({ source: 'test', identifier });
const openRead = (f: string) => new Database(f, { readonly: true });
const sha = (f: string) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const snapshot = () => buildSnapshot(masterFile, snap);

/** A device with its own data: vault, a plugin table with a search index. */
function makeReceiver(file: string): void {
  const d = new Database(file);
  d.pragma('journal_mode = WAL');
  migrate(d);
  d.exec(`
    INSERT INTO vault(account_id, blob) VALUES('mine', x'6d696e65');
    INSERT INTO accounts(id, source, identifier, status, created_at) VALUES('old', 's', 'i', 'idle', 'x');
    CREATE TABLE plugin_notes(id INTEGER PRIMARY KEY AUTOINCREMENT, doc_id TEXT, body TEXT);
    INSERT INTO plugin_notes(doc_id, body) VALUES('vanished', 'keep me');
    CREATE INDEX plugin_notes_doc ON plugin_notes(doc_id);
    CREATE VIRTUAL TABLE plugin_notes_fts USING fts5(body);
    INSERT INTO plugin_notes_fts(body) VALUES('keep me too');
  `);
  d.prepare(`DELETE FROM sqlite_sequence WHERE name='plugin_notes'`).run();
  d.prepare(`INSERT INTO sqlite_sequence(name, seq) VALUES('plugin_notes', 500)`).run();
  d.close();
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-snap-'));
  masterFile = path.join(dir, 'master.db');
  snap = path.join(dir, 'snap.db');
  master = await openDb(masterFile);
  migrate(conn());
  store = openStore(master, deps);
  enableTracking(conn());
  const rdir = path.join(dir, 'r');
  fs.mkdirSync(rdir);
  receiver = path.join(rdir, 'kiagent.db');
  makeReceiver(receiver);
});
afterEach(async () => {
  await master.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('buildSnapshot', () => {
  it('holds no vault values: planted bytes are absent from the raw file', async () => {
    conn().prepare(`INSERT INTO vault(account_id, blob) VALUES('k', ?)`).run(Buffer.from(SECRET));
    conn().exec(`CREATE TABLE plugin_x(v TEXT); INSERT INTO plugin_x VALUES('${SECRET}');`);
    snapshot();
    expect(fs.readFileSync(snap).includes(SECRET)).toBe(false);
    const s = openRead(snap);
    const names = (s.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map((r) => r.name);
    s.close();
    expect(names).not.toContain('vault');
    expect(names).not.toContain('plugin_x');
  });

  it('secrets and plugin values deleted or overwritten before the snapshot are absent too', async () => {
    conn().prepare(`INSERT INTO vault(account_id, blob) VALUES('k', ?)`).run(Buffer.from(SECRET));
    conn().prepare(`DELETE FROM vault`).run();
    conn().exec(`CREATE TABLE plugin_y(v TEXT); INSERT INTO plugin_y VALUES('${SECRET}'); DROP TABLE plugin_y;`);
    snapshot();
    expect(fs.readFileSync(snap).includes(SECRET)).toBe(false);
  });

  it('search stays tied to the right documents with rowid gaps, including after an update and a delete', async () => {
    const a = await account();
    await commit(a.id, [doc('d1', 'alpha'), doc('gap', 'gamma'), doc('d3', 'bravo')]);
    await store.commit({ removeAccount: a.id } as never);
    const b = await account('b');
    await commit(b.id, [doc('x1', 'alpha'), doc('x2', 'bravo'), doc('x3', 'charlie')]);
    const gone = conn().prepare(`SELECT id FROM documents WHERE external_id='x2'`).get() as { id: string };
    for (const t of ['documents_fts', 'documents_tri']) {
      conn().prepare(`DELETE FROM ${t} WHERE rowid=(SELECT rowid FROM documents WHERE id=?)`).run(gone.id);
    }
    conn().prepare(`DELETE FROM documents WHERE id=?`).run(gone.id);
    snapshot();

    const s = new Database(snap);
    const hit = (term: string) =>
      (s.prepare(`SELECT d.external_id e FROM documents_fts f JOIN documents d ON d.rowid=f.rowid WHERE documents_fts MATCH ?`).all(term) as { e: string }[]).map((r) => r.e);
    expect(hit('alpha')).toEqual(['x1']);
    expect(hit('charlie')).toEqual(['x3']);
    expect(hit('bravo')).toEqual([]);
    s.exec(`INSERT INTO documents_fts(documents_fts) VALUES('integrity-check')`);
    s.close();
  });

  it('its target is read in one transaction, so a later write arrives by delta', async () => {
    const a = await account();
    await commit(a.id, [doc('d1')]);
    const r = snapshot();
    await commit(a.id, [doc('d2')]);
    const reader = openRead(masterFile);
    const stage = path.join(dir, 'stage');
    const d = buildDelta(reader, r.target, stage, 1e9);
    reader.close();
    expect(d.status).toBe('ok');
    const body = fs.readFileSync(stage, 'utf8');
    expect(body).toContain('"external_id":"d2"');
    expect(body).not.toContain('"external_id":"d1"');
  });

  it('the finished file has no -wal, and the hash covers the whole file', async () => {
    const a = await account();
    await commit(a.id, [doc('d1')]);
    const r = snapshot();
    expect(fs.existsSync(`${snap}-wal`)).toBe(false);
    expect(r.sha256).toBe(sha(snap));
    expect(r.bytes).toBe(fs.statSync(snap).size);
  });

  it('leaves the source data unchanged', async () => {
    const a = await account();
    await commit(a.id, [doc('d1')]);
    const before = JSON.stringify(conn().prepare(`SELECT * FROM documents`).all());
    snapshot();
    expect(JSON.stringify(conn().prepare(`SELECT * FROM documents`).all())).toBe(before);
    expect(conn().prepare(`SELECT tracking t FROM sync_state`).get()).toEqual({ t: 1 });
  });
});

describe('swap', () => {
  const MASTER_ID = 'master-device';
  const ready = async () => {
    const a = await account();
    await commit(a.id, [doc('d1', 'alpha')]);
    const r = snapshot();
    return { r, status: prepareSwap(receiver, snap, r.sha256, MASTER_ID) };
  };
  const open = () => new Database(receiver);

  it('prepareSwap refuses a file with the wrong hash and changes nothing', async () => {
    const { r } = await (async () => {
      const a = await account();
      await commit(a.id, [doc('d1')]);
      return { r: snapshot() };
    })();
    expect(prepareSwap(receiver, snap, `${r.sha256}x`, MASTER_ID)).toBe('invalid');
    expect(applyPendingSwap(receiver)).toBe('none');
  });

  it('prepareSwap needs room, else no-disk and nothing changes', async () => {
    const a = await account();
    await commit(a.id, [doc('d1')]);
    const r = snapshot();
    expect(prepareSwap(receiver, snap, r.sha256, MASTER_ID, () => 10)).toBe('no-disk');
    expect(applyPendingSwap(receiver)).toBe('none');
  });

  it('swap replaces copied tables and keeps every local table, including plugin data', async () => {
    const { status } = await ready();
    expect(status).toBe('ready');
    expect(applyPendingSwap(receiver)).toBe('swapped');
    const d = open();
    expect((d.prepare(`SELECT external_id e FROM documents`).all() as { e: string }[]).map((r) => r.e)).toEqual(['d1']);
    expect(d.prepare(`SELECT count(*) n FROM accounts WHERE id='old'`).get()).toEqual({ n: 0 });
    expect(d.prepare(`SELECT account_id FROM vault`).all()).toEqual([{ account_id: 'mine' }]);
    expect(d.prepare(`SELECT doc_id, body FROM plugin_notes`).all()).toEqual([{ doc_id: 'vanished', body: 'keep me' }]);
    expect(d.prepare(`SELECT seq FROM sqlite_sequence WHERE name='plugin_notes'`).get()).toEqual({ seq: 500 });
    expect(d.prepare(`SELECT name FROM sqlite_master WHERE name='plugin_notes_doc'`).get()).toBeTruthy();
    expect(d.prepare(`SELECT body FROM plugin_notes_fts WHERE plugin_notes_fts MATCH 'too'`).all()).toHaveLength(1);
    expect(d.prepare(`SELECT count(*) n FROM documents_fts WHERE documents_fts MATCH 'alpha'`).get()).toEqual({ n: 1 });
    d.close();
  });

  it('swap rebuilds changes from documents.seq without dropping sqlite_sequence', async () => {
    await ready();
    applyPendingSwap(receiver);
    const d = open();
    const row = d.prepare(`SELECT id, seq FROM documents`).get() as { id: string; seq: number };
    expect(d.prepare(`SELECT kind, ref_id FROM changes`).all()).toEqual([{ kind: 'document', ref_id: row.id }]);
    const next = d.prepare(`INSERT INTO changes(kind, ref_id, at) VALUES('document','z','n')`).run();
    expect(Number(next.lastInsertRowid)).toBeGreaterThan(row.seq);
    d.close();
  });

  it('swap sets role=follower, tracking=0, master, history and the cursor', async () => {
    const { r } = await ready();
    applyPendingSwap(receiver);
    const d = open();
    const hist = conn().prepare(`SELECT history_id h FROM sync_state`).get() as { h: string };
    expect(d.prepare(`SELECT role, tracking, after_seq, after_cursor, history_id, master_device_id FROM sync_state`).get()).toEqual({
      role: 'follower',
      tracking: 0,
      after_seq: r.target.seq,
      after_cursor: r.target.cursor,
      history_id: hist.h,
      master_device_id: MASTER_ID,
    });
    d.close();
  });

  it('the old file is kept as an archive that opens with its data', async () => {
    await ready();
    applyPendingSwap(receiver);
    const dirFiles = fs.readdirSync(path.dirname(receiver));
    const archive = dirFiles.find((f) => /^kiagent\.db\.archive-\d/.test(f) && !/-(wal|shm)$/.test(f));
    expect(archive).toBeTruthy();
    const a = openRead(path.join(path.dirname(receiver), archive!));
    expect(a.prepare(`SELECT count(*) n FROM accounts WHERE id='old'`).get()).toEqual({ n: 1 });
    a.close();
    expect(applyPendingSwap(receiver)).toBe('none');
  });

  it('a swap that cannot merge is abandoned: the old database still opens as it was', async () => {
    await ready();
    fs.writeFileSync(`${receiver}.swap-incoming`, 'not a database');
    expect(applyPendingSwap(receiver)).toBe('abandoned');
    const d = open();
    expect(d.prepare(`SELECT role FROM sync_state`).get()).toEqual({ role: 'normal' });
    expect(d.prepare(`SELECT account_id FROM vault`).all()).toEqual([{ account_id: 'mine' }]);
    d.close();
    expect(applyPendingSwap(receiver)).toBe('none');
    expect(fs.readdirSync(path.dirname(receiver)).filter((f) => f.includes('.swap'))).toEqual([]);
  });

  it('room counts an uncheckpointed WAL too', async () => {
    const a = await account();
    await commit(a.id, [doc('d1')]);
    const r = snapshot();
    fs.writeFileSync(`${receiver}-wal`, Buffer.alloc(0));
    const size = fs.statSync(receiver).size;
    fs.writeFileSync(`${receiver}-wal`, Buffer.alloc(4096));
    expect(prepareSwap(receiver, snap, r.sha256, MASTER_ID, () => size + 1024)).toBe('no-disk');
    fs.rmSync(`${receiver}-wal`);
  });

  it('stop copying brings the archive back and the device is normal again', async () => {
    await ready();
    expect(applyPendingSwap(receiver)).toBe('swapped');
    expect(prepareRestore(receiver)).toBe('ready');
    expect(applyPendingSwap(receiver)).toBe('restored');
    const d = open();
    expect(d.prepare(`SELECT role, tracking, master_device_id FROM sync_state`).get()).toEqual({
      role: 'normal', tracking: 0, master_device_id: null,
    });
    expect(d.prepare(`SELECT count(*) n FROM accounts WHERE id='old'`).get()).toEqual({ n: 1 });
    d.close();
    expect(applyPendingSwap(receiver)).toBe('none');
    const kept = fs.readdirSync(path.dirname(receiver)).filter((f) => f.includes('.copy-'));
    expect(kept).toHaveLength(0);
  });

  it('with no archive there is nothing to restore', async () => {
    expect(prepareRestore(receiver)).toBe('no-archive');
    expect(applyPendingSwap(receiver)).toBe('none');
  });

  it('a crash during restore finishes on retry', async () => {
    await ready();
    applyPendingSwap(receiver);
    prepareRestore(receiver);
    expect(() =>
      applyPendingSwap(receiver, (s) => {
        if (s === 'restore-moved') throw new Error('crash');
      }),
    ).toThrow('crash');
    expect(applyPendingSwap(receiver)).toBe('restored');
    const d = open();
    expect(d.prepare(`SELECT role FROM sync_state`).get()).toEqual({ role: 'normal' });
    d.close();
  });

  it.each(SWAP_STEPS)('a crash after %s leaves a database that opens, and the swap finishes on retry', async (step) => {
    await ready();
    expect(() =>
      applyPendingSwap(receiver, (s) => {
        if (s === step) throw new Error('crash');
      }),
    ).toThrow('crash');
    if (fs.existsSync(receiver)) {
      const mid = openRead(receiver);
      expect(mid.prepare(`SELECT count(*) n FROM sync_state`).get()).toEqual({ n: 1 });
      mid.close();
    }
    expect(applyPendingSwap(receiver)).toBe('swapped');
    const d = open();
    expect(d.prepare(`SELECT role FROM sync_state`).get()).toEqual({ role: 'follower' });
    expect(d.prepare(`SELECT account_id FROM vault`).all()).toEqual([{ account_id: 'mine' }]);
    d.close();
  });
});
