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
import { copiedSetDigest } from '../tables';
import { addAttention, addOutbox, descriptor, physical, registerPlugin } from './synced-plugin';

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
    const d = buildDelta(reader, r.target, 0, stage, 1e9);
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
    expect(fs.readdirSync(path.dirname(receiver)).filter((f) => f.includes('.swap') && !f.endsWith('.swap-outcome'))).toEqual([]);
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

  it('copying again replaces the old copy, keeps one archive, and restore finds the original', async () => {
    await ready();
    expect(applyPendingSwap(receiver)).toBe('swapped');
    // Archive names carry the second, and a real second copy comes much later.
    await new Promise((res) => setTimeout(res, 1100));
    const r = snapshot();
    expect(prepareSwap(receiver, snap, r.sha256, MASTER_ID)).toBe('ready');
    expect(applyPendingSwap(receiver)).toBe('swapped');
    const archives = fs
      .readdirSync(path.dirname(receiver))
      .filter((f) => f.includes('.archive-') && !/-(wal|shm)$/.test(f));
    expect(archives).toHaveLength(1);
    expect(prepareRestore(receiver)).toBe('ready');
    expect(applyPendingSwap(receiver)).toBe('restored');
    const d = open();
    expect(d.prepare(`SELECT role FROM sync_state`).get()).toEqual({ role: 'normal' });
    expect(d.prepare(`SELECT count(*) n FROM accounts WHERE id='old'`).get()).toEqual({ n: 1 });
    d.close();
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

  it('merge clears joining, so the copy is a plain follower', async () => {
    const d0 = new Database(receiver);
    d0.prepare(`UPDATE sync_state SET joining = 1`).run();
    d0.close();
    await ready();
    expect(applyPendingSwap(receiver)).toBe('swapped');
    const d = open();
    expect(d.prepare(`SELECT role, joining FROM sync_state`).get()).toEqual({ role: 'follower', joining: 0 });
    d.close();
  });

  it('the swap outcome is written before the journal goes, and survives a crash after the swap', async () => {
    await ready();
    expect(() =>
      applyPendingSwap(receiver, (s) => {
        if (s === 'outcome') throw new Error('crash');
      }),
    ).toThrow('crash');
    expect(fs.readFileSync(`${receiver}.swap-outcome`, 'utf8')).toBe('swapped');
    expect(applyPendingSwap(receiver)).toBe('swapped');
    expect(fs.readFileSync(`${receiver}.swap-outcome`, 'utf8')).toBe('swapped');
  });

  it('an abandoned swap leaves an outcome too, and the next prepareSwap clears the old one', async () => {
    await ready();
    fs.writeFileSync(`${receiver}.swap-incoming`, 'not a database');
    expect(applyPendingSwap(receiver)).toBe('abandoned');
    expect(fs.readFileSync(`${receiver}.swap-outcome`, 'utf8')).toBe('abandoned');
    const r = snapshot();
    expect(prepareSwap(receiver, snap, r.sha256, MASTER_ID)).toBe('ready');
    expect(fs.existsSync(`${receiver}.swap-outcome`)).toBe(false);
  });

  describe('restore after a join', () => {
    const joined = async () => {
      const d0 = new Database(receiver);
      d0.exec(`
        UPDATE sync_state SET joining = 1;
        INSERT INTO sync_moved(account_id, to_device) VALUES('old', 'seed-device');
        INSERT INTO meta(key, value) VALUES('archive-only', 'yes');
      `);
      d0.close();
      await ready();
      expect(applyPendingSwap(receiver)).toBe('swapped');
      const c = open();
      c.exec(`
        INSERT INTO plugin_notes(doc_id, body) VALUES('since', 'written after joining');
        CREATE TABLE meetings_rows(id INTEGER PRIMARY KEY, title TEXT);
        INSERT INTO meetings_rows(title) VALUES('standup');
        INSERT INTO vault(account_id, blob) VALUES('later', x'6c61746572');
        INSERT INTO meta(key, value) VALUES('copy-only', 'yes');
        INSERT INTO accounts(id, source, identifier, status, created_at) VALUES('seeds', 's', 'seed', 'idle', 'x');
      `);
      c.close();
    };

    it('keeps plugin and meeting rows written since joining, and the archive\'s vault', async () => {
      await joined();
      expect(prepareRestore(receiver)).toBe('ready');
      expect(applyPendingSwap(receiver)).toBe('restored');
      const d = open();
      expect(d.prepare(`SELECT body FROM plugin_notes ORDER BY id`).all()).toEqual([
        { body: 'keep me' },
        { body: 'written after joining' },
      ]);
      expect(d.prepare(`SELECT title FROM meetings_rows`).all()).toEqual([{ title: 'standup' }]);
      expect(d.prepare(`SELECT account_id FROM vault`).all()).toEqual([{ account_id: 'mine' }]);
      expect(d.prepare(`SELECT value FROM meta WHERE key IN ('archive-only','copy-only') ORDER BY key`).all()).toEqual([
        { value: 'yes' },
      ]);
      expect(d.prepare(`SELECT id FROM accounts ORDER BY id`).all()).toEqual([{ id: 'old' }]);
      d.close();
    });

    it('restore clears joining and the device is normal again', async () => {
      await joined();
      prepareRestore(receiver);
      applyPendingSwap(receiver);
      const d = open();
      expect(d.prepare(`SELECT role, joining, master_device_id FROM sync_state`).get()).toEqual({
        role: 'normal',
        joining: 0,
        master_device_id: null,
      });
      d.close();
    });

    it('restored moved accounts boot paused with the reason, and the list is kept', async () => {
      await joined();
      prepareRestore(receiver);
      applyPendingSwap(receiver);
      const d = open();
      expect(d.prepare(`SELECT status, last_error FROM accounts WHERE id = 'old'`).get()).toEqual({
        status: 'paused',
        last_error: 'Moved to seed-device',
      });
      expect(d.prepare(`SELECT account_id FROM sync_moved`).all()).toEqual([{ account_id: 'old' }]);
      d.close();
    });

    it('a crash after the merge and before the move leaves one complete database, and retry finishes', async () => {
      await joined();
      prepareRestore(receiver);
      expect(() =>
        applyPendingSwap(receiver, (s) => {
          if (s === 'restore-merged') throw new Error('crash');
        }),
      ).toThrow('crash');
      const mid = openRead(receiver);
      expect(mid.prepare(`SELECT role FROM sync_state`).get()).toEqual({ role: 'follower' });
      expect(mid.prepare(`SELECT count(*) n FROM documents`).get()).toEqual({ n: 1 });
      mid.close();
      expect(applyPendingSwap(receiver)).toBe('restored');
      const d = open();
      expect(d.prepare(`SELECT role FROM sync_state`).get()).toEqual({ role: 'normal' });
      expect(d.prepare(`SELECT count(*) n FROM meetings_rows`).get()).toEqual({ n: 1 });
      d.close();
    });

    it('an archive that cannot be merged leaves the current database in use', async () => {
      await joined();
      const archive = fs
        .readdirSync(path.dirname(receiver))
        .find((f) => /\.archive-\d+$/.test(f))!;
      fs.writeFileSync(path.join(path.dirname(receiver), archive), 'junk');
      prepareRestore(receiver);
      expect(applyPendingSwap(receiver)).toBe('abandoned');
      const d = open();
      expect(d.prepare(`SELECT role FROM sync_state`).get()).toEqual({ role: 'follower' });
      d.close();
      expect(applyPendingSwap(receiver)).toBe('none');
    });
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

describe('the snapshot carries the master epoch and copied set (step 2 corrections)', () => {
  it('a swap sets sync_state.epoch to the master epoch', async () => {
    conn().prepare(`UPDATE sync_state SET epoch = 3`).run();
    const r = snapshot();
    expect(prepareSwap(receiver, snap, r.sha256, 'm')).toBe('ready');
    expect(applyPendingSwap(receiver)).toBe('swapped');
    const d = new Database(receiver, { readonly: true });
    expect(d.prepare(`SELECT epoch FROM sync_state`).get()).toEqual({ epoch: 3 });
    d.close();
  });

  it('a table the master syncs but this device held as local is replaced, not created twice', async () => {
    await registerPlugin(masterFile, conn());
    conn().prepare(`INSERT INTO "${physical('notes')}"(account_id, key, body) VALUES('a','k','master')`).run();
    // The receiver has the same plugin, but its descriptor syncs nothing.
    const rc = new Database(receiver);
    await registerPlugin(receiver, rc, descriptor({ synced: [] }));
    rc.prepare(`INSERT INTO "${physical('notes')}"(account_id, key, body) VALUES('z','own','mine')`).run();
    rc.close();
    const r = snapshot();
    expect(prepareSwap(receiver, snap, r.sha256, 'm')).toBe('ready');
    expect(applyPendingSwap(receiver)).toBe('swapped');
    const d = new Database(receiver);
    expect(d.prepare(`SELECT account_id, key, body FROM "${physical('notes')}"`).all()).toEqual([
      { account_id: 'a', key: 'k', body: 'master' },
    ]);
    // A boot registers the running build's descriptor; then the digests agree.
    const reg = conn()
      .prepare(`SELECT descriptor_digest, descriptor_json FROM plugin_storage WHERE plugin_id = ?`)
      .get('test.syncplug') as { descriptor_digest: string; descriptor_json: string };
    d.prepare(`UPDATE plugin_storage SET descriptor_digest = ?, descriptor_json = ? WHERE plugin_id = ?`).run(
      reg.descriptor_digest,
      reg.descriptor_json,
      'test.syncplug',
    );
    expect(copiedSetDigest(d)).toBe(copiedSetDigest(conn()));
    d.close();
  });
});

describe('owner-capture rows survive the swap (step 3)', () => {
  const capture = { ownerCapture: ['notes'] };
  it('keeps the joiner rows of an ownerCapture table, lists their keys, and replaces other synced tables', async () => {
    await registerPlugin(masterFile, conn(), descriptor(capture));
    conn().prepare(`INSERT INTO "${physical('notes')}"(account_id, key, body) VALUES('a','master-note','m')`).run();
    conn().prepare(`INSERT INTO "${physical('blobs')}"(id, data) VALUES('b-master', x'01')`).run();
    const rc = new Database(receiver);
    await registerPlugin(receiver, rc, descriptor(capture));
    rc.prepare(`INSERT INTO "${physical('notes')}"(account_id, key, body) VALUES('z','my-meeting','mine')`).run();
    rc.prepare(`INSERT INTO "${physical('blobs')}"(id, data) VALUES('b-mine', x'02')`).run();
    rc.close();
    const r = snapshot();
    expect(prepareSwap(receiver, snap, r.sha256, 'm')).toBe('ready');
    expect(applyPendingSwap(receiver)).toBe('swapped');
    const d = new Database(receiver);
    expect(d.prepare(`SELECT key FROM "${physical('notes')}" ORDER BY key`).all()).toEqual([
      { key: 'master-note' },
      { key: 'my-meeting' },
    ]);
    expect(d.prepare(`SELECT id FROM "${physical('blobs')}"`).all()).toEqual([{ id: 'b-master' }]);
    expect(d.prepare(`SELECT tbl, pk FROM sync_retained`).all()).toEqual([
      { tbl: physical('notes'), pk: JSON.stringify(['z', 'my-meeting']) },
    ]);
    d.close();
  });

  it('a table that is not ownerCapture retains nothing', async () => {
    await registerPlugin(masterFile, conn());
    const rc = new Database(receiver);
    await registerPlugin(receiver, rc);
    rc.prepare(`INSERT INTO "${physical('notes')}"(account_id, key, body) VALUES('z','k','mine')`).run();
    rc.close();
    const r = snapshot();
    prepareSwap(receiver, snap, r.sha256, 'm');
    expect(applyPendingSwap(receiver)).toBe('swapped');
    const d = new Database(receiver);
    expect(d.prepare(`SELECT count(*) n FROM "${physical('notes')}"`).get()).toEqual({ n: 0 });
    expect(d.prepare(`SELECT count(*) n FROM sync_retained`).get()).toEqual({ n: 0 });
    d.close();
  });
});

describe('more copied tables (step 2)', () => {
  it('an unlisted plugin table is dropped from the snapshot, a synced one is kept', async () => {
    await registerPlugin(masterFile, conn());
    conn().prepare(`INSERT INTO "${physical('notes')}"(account_id, key, body) VALUES('a','k','kept')`).run();
    conn().prepare(`INSERT INTO "${physical('local_x')}"(id, v) VALUES('1','secretlocal')`).run();
    snapshot();
    const s = openRead(snap);
    const names = (s.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map((r) => r.name);
    expect(names).toContain(physical('notes'));
    expect(names).not.toContain(physical('local_x'));
    expect(s.prepare(`SELECT body FROM "${physical('notes')}"`).all()).toEqual([{ body: 'kept' }]);
    s.close();
  });

  it('outbox, drafts and attention rows are in the snapshot, and a swap replaces the follower own', async () => {
    const a = await account();
    addOutbox(conn(), a.id, 'o1', 'sent');
    addAttention(conn(), 'att');
    const d = new Database(receiver);
    d.prepare(`INSERT INTO accounts(id, source, identifier, status, created_at) VALUES('acc2','s','i2','idle','x')`).run();
    d.prepare(
      `INSERT INTO outbox(id, account_id, kind, recipient_display, body_markdown, confirm_mode, status, created_via, created_at, expires_at)
       VALUES('mine','old','reply','r','b','review','draft','t','x','y')`,
    ).run();
    d.close();
    const r = snapshot();
    expect(prepareSwap(receiver, snap, r.sha256, 'm')).toBe('ready');
    expect(applyPendingSwap(receiver)).toBe('swapped');
    const after = new Database(receiver);
    expect(after.prepare(`SELECT id, status FROM outbox`).all()).toEqual([{ id: 'o1', status: 'sent' }]);
    expect(after.prepare(`SELECT count(*) n FROM attention_items`).get()).toEqual({ n: 1 });
    after.close();
  });
});
