/**
 * alpha-cent#93: a corpus written by a newer build is refused at boot. Instead
 * of a dead app and a terminal session, the user gets a choice — quit (and
 * update), or move the index aside and start fresh.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

import { openDb } from '../db/app-db';
import { isCorpusRefusal } from '../core/store/corpus-refusal';
import { backupCorpus, handleBootFailure } from '../corpus-recovery';
import type { BootFailureDeps } from '../corpus-recovery';

const REFUSED =
  'corpus schema v99 is newer than this build supports (v7). Update the app to the latest version to open this database, or erase and re-sync it.';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-corpus-recovery-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('isCorpusRefusal', () => {
  it('matches the refusal as migrate() throws it and as the DB worker re-wraps it', () => {
    expect(isCorpusRefusal(new Error(REFUSED))).toBe(true);
    expect(
      isCorpusRefusal(new Error(`db worker failed to open: ${REFUSED}`)),
    ).toBe(true);
  });

  it('matches nothing else', () => {
    expect(
      isCorpusRefusal(
        new Error('SQLITE_CORRUPT: database disk image is malformed'),
      ),
    ).toBe(false);
    expect(
      isCorpusRefusal(new Error('db worker exited before ready (code 1)')),
    ).toBe(false);
    expect(isCorpusRefusal(undefined)).toBe(false);
  });

  it('matches what the real migrate() throws for a newer corpus — and the file is released', async () => {
    const file = path.join(dir, 'kiagent.db');
    const raw = new Database(file);
    raw.exec(
      `CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta VALUES('schemaVersion', '9999');`,
    );
    raw.close();
    const close = jest.spyOn(Database.prototype, 'close');
    try {
      const err = await openDb(file).then(
        () => null,
        (e: unknown) => e,
      );
      expect(isCorpusRefusal(err)).toBe(true);
      // openDb released its handle — Windows will not rename an open file.
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore();
    }
  });
});

/** A real, tiny corpus file: the backup checkpoints it before moving. */
function realCorpus(file: string): void {
  const conn = new Database(file);
  conn.pragma('journal_mode = WAL');
  conn.exec('CREATE TABLE t(x INTEGER); INSERT INTO t VALUES (1);');
  conn.close();
}

describe('backupCorpus', () => {
  // The move tests use plain files; the checkpoint has its own test below.
  const noCheckpoint = () => {};
  const put = (...names: string[]) => {
    for (const n of names) fs.writeFileSync(path.join(dir, n), n);
  };

  it('moves the database and its WAL pair into one backup folder, names intact', async () => {
    put('kiagent.db', 'kiagent.db-wal', 'kiagent.db-shm', 'prefs.json');
    const backupDir = path.join(dir, 'corpus-backup-x');
    const moved = await backupCorpus(dir, backupDir, noCheckpoint);
    expect(moved.sort()).toEqual(
      ['kiagent.db', 'kiagent.db-shm', 'kiagent.db-wal'].map((n) =>
        path.join(backupDir, n),
      ),
    );
    expect(
      fs.readFileSync(path.join(backupDir, 'kiagent.db-wal'), 'utf8'),
    ).toBe('kiagent.db-wal');
    expect(fs.existsSync(path.join(dir, 'kiagent.db'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'prefs.json'))).toBe(true); // not ours
  });

  it('a database without a WAL pair moves on its own', async () => {
    put('kiagent.db');
    const moved = await backupCorpus(dir, path.join(dir, 'b'), noCheckpoint);
    expect(moved).toEqual([path.join(dir, 'b', 'kiagent.db')]);
  });

  it('the backed-up database holds every committed row on its own — the WAL is folded in first', async () => {
    const file = path.join(dir, 'kiagent.db');
    const writer = new Database(file);
    writer.pragma('journal_mode = WAL');
    writer.pragma('wal_autocheckpoint = 0'); // leave the rows in the WAL
    writer.exec('CREATE TABLE t(x INTEGER)');
    const insert = writer.prepare('INSERT INTO t(x) VALUES (?)');
    for (let i = 0; i < 50; i += 1) insert.run(i);
    expect(fs.statSync(`${file}-wal`).size).toBeGreaterThan(0);
    writer.close(); // (closing checkpoints too — reopen to keep a live WAL)
    const holder = new Database(file);
    holder.pragma('wal_autocheckpoint = 0');
    holder.prepare('INSERT INTO t(x) VALUES (?)').run(50);
    expect(fs.statSync(`${file}-wal`).size).toBeGreaterThan(0);

    const backupDir = path.join(dir, 'b');
    try {
      await backupCorpus(dir, backupDir);
    } finally {
      holder.close();
    }
    // Only the database file, WAL left behind on purpose: still every row.
    const lone = path.join(dir, 'lone.db');
    fs.copyFileSync(path.join(backupDir, 'kiagent.db'), lone);
    const check = new Database(lone, { readonly: true });
    try {
      expect(check.prepare('SELECT COUNT(*) AS n FROM t').get()).toEqual({
        n: 51,
      });
    } finally {
      check.close();
    }
  });

  it('a WAL left by a crashed run is folded in, then the database moves alone', async () => {
    // Snapshot a database mid-run, as a crash leaves it: rows only in the WAL.
    const live = path.join(dir, 'live.db');
    const writer = new Database(live);
    writer.pragma('journal_mode = WAL');
    writer.pragma('wal_autocheckpoint = 0');
    writer.exec('CREATE TABLE t(x INTEGER); INSERT INTO t VALUES (7);');
    fs.copyFileSync(live, path.join(dir, 'kiagent.db'));
    fs.copyFileSync(`${live}-wal`, path.join(dir, 'kiagent.db-wal'));
    writer.close();

    const backupDir = path.join(dir, 'b');
    const moved = await backupCorpus(dir, backupDir);
    expect(moved).toEqual([path.join(backupDir, 'kiagent.db')]);
    const check = new Database(path.join(backupDir, 'kiagent.db'), {
      readonly: true,
    });
    try {
      expect(check.prepare('SELECT x FROM t').all()).toEqual([{ x: 7 }]);
    } finally {
      check.close();
    }
  });

  it('an empty database file keeps its WAL — nothing opens it before the move', async () => {
    fs.writeFileSync(path.join(dir, 'kiagent.db'), '');
    fs.writeFileSync(path.join(dir, 'kiagent.db-wal'), 'frames');
    const backupDir = path.join(dir, 'b');
    const moved = await backupCorpus(dir, backupDir);
    expect(moved.sort()).toEqual([
      path.join(backupDir, 'kiagent.db'),
      path.join(backupDir, 'kiagent.db-wal'),
    ]);
    expect(
      fs.readFileSync(path.join(backupDir, 'kiagent.db-wal'), 'utf8'),
    ).toBe('frames');
  });

  it('a move that fails puts back what already moved — never a database split from its WAL', async () => {
    put('kiagent.db', 'kiagent.db-wal', 'kiagent.db-shm');
    const real = fs.renameSync;
    const rename = jest
      .spyOn(fs, 'renameSync')
      .mockImplementation((from, to) => {
        if (String(from).endsWith('kiagent.db-wal')) {
          throw Object.assign(new Error('EACCES: permission denied'), {
            code: 'EACCES',
          });
        }
        return real(from, to);
      });
    try {
      await expect(
        backupCorpus(dir, path.join(dir, 'b'), noCheckpoint),
      ).rejects.toThrow('EACCES');
    } finally {
      rename.mockRestore();
    }
    for (const f of ['kiagent.db', 'kiagent.db-wal', 'kiagent.db-shm']) {
      expect(fs.readFileSync(path.join(dir, f), 'utf8')).toBe(f);
    }
  });

  it('nothing to move is an empty result, not an error', async () => {
    await expect(backupCorpus(dir, path.join(dir, 'b'))).resolves.toEqual([]);
  });
});

describe('handleBootFailure', () => {
  function deps(choice: 'rebuild' | 'quit' | 'throws') {
    const events: string[] = [];
    const d: BootFailureDeps = {
      crash: {
        logDir: path.join(dir, 'logs'),
        sink: () => null,
        showErrorBox: (title) => {
          events.push(`errorBox:${title}`);
        },
        exit: (code) => {
          events.push(`exit:${code}`);
        },
      },
      dataDir: dir,
      productName: 'KIAgent',
      now: () => new Date('2026-09-25T10:11:12.000Z'),
      confirmRebuild: async (backupDir) => {
        events.push(`ask:${path.basename(backupDir)}`);
        if (choice === 'throws') throw new Error('no dialog');
        return choice === 'rebuild';
      },
      relaunch: () => {
        events.push('relaunch');
      },
    };
    return { d, events };
  }

  it('any other boot failure keeps the plain error box', async () => {
    const { d, events } = deps('rebuild');
    await handleBootFailure(d, new Error('SQLITE_CORRUPT'));
    expect(events).toEqual(['errorBox:kiagent could not start', 'exit:1']);
  });

  it('refused corpus, Quit: nothing is moved, the app quits', async () => {
    fs.writeFileSync(path.join(dir, 'kiagent.db'), 'x');
    const { d, events } = deps('quit');
    await handleBootFailure(
      d,
      new Error(`db worker failed to open: ${REFUSED}`),
    );
    expect(events).toEqual([
      'ask:corpus-backup-2026-09-25T10-11-12-000Z',
      'exit:1',
    ]);
    expect(fs.existsSync(path.join(dir, 'kiagent.db'))).toBe(true);
  });

  it('refused corpus, Back up & rebuild: the index moves aside and the app restarts', async () => {
    realCorpus(path.join(dir, 'kiagent.db'));
    const { d, events } = deps('rebuild');
    await handleBootFailure(d, new Error(REFUSED));
    expect(events).toEqual([
      'ask:corpus-backup-2026-09-25T10-11-12-000Z',
      'relaunch',
    ]);
    expect(fs.existsSync(path.join(dir, 'kiagent.db'))).toBe(false);
    const backup = path.join(dir, 'corpus-backup-2026-09-25T10-11-12-000Z');
    expect(fs.readdirSync(backup)).toEqual(['kiagent.db']);
    const check = new Database(path.join(backup, 'kiagent.db'), {
      readonly: true,
    });
    try {
      expect(check.prepare('SELECT x FROM t').all()).toEqual([{ x: 1 }]);
    } finally {
      check.close();
    }
    // The refusal is on record in the crash log.
    const log = fs.readFileSync(
      path.join(dir, 'logs', 'kiagent.log.jsonl'),
      'utf8',
    );
    expect(log).toMatch(/newer than this build supports/);
  });

  it('never restarts when there was nothing to move — no relaunch loop', async () => {
    const { d, events } = deps('rebuild');
    await handleBootFailure(d, new Error(REFUSED));
    expect(events).toEqual([
      'ask:corpus-backup-2026-09-25T10-11-12-000Z',
      'errorBox:kiagent could not start',
      'exit:1',
    ]);
  });

  it('a dialog that fails falls back to the plain error box', async () => {
    fs.writeFileSync(path.join(dir, 'kiagent.db'), 'x');
    const { d, events } = deps('throws');
    await handleBootFailure(d, new Error(REFUSED));
    expect(events.slice(-2)).toEqual([
      'errorBox:kiagent could not start',
      'exit:1',
    ]);
    expect(fs.existsSync(path.join(dir, 'kiagent.db'))).toBe(true);
  });
});
