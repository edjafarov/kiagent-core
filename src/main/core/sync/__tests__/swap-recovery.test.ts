/** A set-aside device's recovery swap (vanished-leader D4; no-recovery-archives
 *  spec): the old file is deleted, never archived, and the outcome is durable
 *  and attempt-tagged. */
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

import type { DocumentInput } from '@shared/contracts';

import { openDb, type AppDb } from '../../../db/app-db';
import { migrate } from '../../store/schema';
import { openStore, type CoreStore } from '../../store/store';
import { promote } from '../promote';
import { buildSnapshot } from '../snapshot';
import { readSwapOutcome } from '../status';
import {
  applyPendingSwap,
  clearSwapStatus,
  discardForeignPending,
  dropOrphanIncoming,
  prepareRestore,
  prepareSwap,
  SWAP_STEPS,
  swapStatus,
} from '../swap';
import { enableTracking } from '../tracking';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};
const doc = (externalId: string): DocumentInput => ({
  externalId,
  type: 'file',
  title: externalId,
  markdown: 'body',
  metadata: {},
  createdAt: null,
});
const MASTER = 'master-device';
const KEEP = { markId: 'mark-1', attempt: 2 };

let n = 0;
let dir: string;
let master: AppDb;
let store: CoreStore;
let snap: string;
let receiver: string;
const open = () => new Database(receiver);
const sha = (f: string) =>
  createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const archives = () =>
  fs
    .readdirSync(path.dirname(receiver))
    .filter((f) => f.includes('.archive-') && /\d$/.test(f))
    .sort();
const sidecars = () =>
  fs
    .readdirSync(path.dirname(receiver))
    .filter((f) => f.includes('.passed-over.json'));

/** A follower of an earlier master that also holds queued work and a row (X2)
 *  that only its own file ever published. */
function makeFollowerReceiver(file: string): void {
  const d = new Database(file);
  d.pragma('journal_mode = WAL');
  migrate(d);
  d.exec(`
    UPDATE sync_state SET role='follower', tracking=1, joined=1, epoch=3, pre_demote_epoch=2;
    INSERT INTO sync_rows(tbl, pk) VALUES('documents', 'X2');
    INSERT INTO sync_outbound(kind, payload, created_at) VALUES('k', x'00', 'x');
    INSERT INTO sync_retained(tbl, pk) VALUES('t', '["pk"]');
    INSERT INTO vault(account_id, blob) VALUES('mine', x'6d696e65');
    INSERT INTO sync_imported(tbl, pk) VALUES('documents', 'X2');
  `);
  d.close();
}

/** A device with its own database (role normal): a plain swap archives it. */
function makeNormalReceiver(file: string): void {
  for (const ext of ['', '-wal', '-shm'])
    fs.rmSync(`${file}${ext}`, { force: true });
  const d = new Database(file);
  d.pragma('journal_mode = WAL');
  migrate(d);
  d.close();
}

const prepare = async (
  opts: { markId: string; attempt: number } | null = KEEP,
) => {
  const a = await store.createAccount({
    source: 'test',
    identifier: `a${n++}@b`,
  });
  await store.commit({
    account: a.id as never,
    documents: [doc(`d${n}`)],
    cursor: null,
  });
  const r = buildSnapshot(path.join(dir, 'master.db'), snap);
  return prepareSwap(
    receiver,
    snap,
    r.sha256,
    MASTER,
    undefined,
    opts ?? undefined,
  );
};

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-keep-'));
  snap = path.join(dir, 'snap.db');
  master = await openDb(path.join(dir, 'master.db'));
  migrate(master._conn!);
  store = openStore(master, deps);
  enableTracking(master._conn!);
  fs.mkdirSync(path.join(dir, 'r'));
  receiver = path.join(dir, 'r', 'kiagent.db');
  makeFollowerReceiver(receiver);
});
afterEach(async () => {
  await master.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('recovery swap', () => {
  it('deletes the old file and leaves no archive and no sidecar', async () => {
    const before = sha(receiver);
    expect(await prepare()).toBe('ready');
    expect(applyPendingSwap(receiver)).toBe('swapped');
    expect(archives()).toEqual([]);
    expect(sidecars()).toEqual([]);
    expect(sha(receiver)).not.toBe(before);
    expect(swapStatus(receiver)).toEqual({
      pending: null,
      outcome: 'ok',
      markId: 'mark-1',
      attempt: 2,
    });
    // The device's own local tables are carried into the new file.
    const d = open();
    expect(d.prepare(`SELECT account_id FROM vault`).all()).toEqual([
      { account_id: 'mine' },
    ]);
    d.close();
  });

  it('a journal in the shape earlier versions wrote takes the same path', async () => {
    await prepare();
    const jp = `${receiver}.swap.json`;
    // The journal as v0.136.0 wrote it: an archive name, the flag and a time.
    fs.writeFileSync(
      jp,
      JSON.stringify({
        ...JSON.parse(fs.readFileSync(jp, 'utf8')),
        replacesCopy: false,
        archive: `${receiver}.archive-20261124120000`,
        keepArchive: true,
        at: '2026-11-24T12:00:00.000Z',
      }),
    );
    expect(applyPendingSwap(receiver)).toBe('swapped');
    expect(archives()).toEqual([]);
    expect(sidecars()).toEqual([]);
    const d = open();
    expect(d.prepare(`SELECT joined FROM sync_state`).get()).toEqual({
      joined: 1,
    });
    expect(d.prepare(`SELECT * FROM sync_rows`).all()).toEqual([]);
    d.close();
  });

  it.each([...SWAP_STEPS, 'incoming-renamed' as const])(
    'a crash after %s resumes to the same result with no archive',
    async (step) => {
      await prepare();
      expect(() =>
        applyPendingSwap(receiver, (s) => {
          if (s === (step as string)) throw new Error('crash');
        }),
      ).toThrow('crash');
      expect(applyPendingSwap(receiver)).toBe('swapped');
      expect(archives()).toEqual([]);
      expect(sidecars()).toEqual([]);
      expect(swapStatus(receiver)).toEqual({
        pending: null,
        outcome: 'ok',
        markId: 'mark-1',
        attempt: 2,
      });
      const d = open();
      expect(d.prepare(`SELECT account_id FROM vault`).all()).toEqual([
        { account_id: 'mine' },
      ]);
      expect(
        d.prepare(`SELECT master_device_id m FROM sync_state`).get(),
      ).toEqual({ m: MASTER });
      d.close();
    },
  );

  it('a replay after the install does not delete the installed database', async () => {
    await prepare();
    expect(() =>
      applyPendingSwap(receiver, (s) => {
        if (s === 'replaced') throw new Error('crash');
      }),
    ).toThrow('crash');
    expect(applyPendingSwap(receiver)).toBe('swapped');
    expect(fs.existsSync(receiver)).toBe(true);
    const d = open();
    expect(
      d.prepare(`SELECT master_device_id m FROM sync_state`).get(),
    ).toEqual({ m: MASTER });
    d.close();
  });

  it('an orphan .swap-incoming with no journal is dropped by dropOrphanIncoming', () => {
    fs.writeFileSync(`${receiver}.swap-incoming`, 'x');
    expect(dropOrphanIncoming(receiver)).toBe(true);
    expect(fs.existsSync(`${receiver}.swap-incoming`)).toBe(false);
    expect(dropOrphanIncoming(receiver)).toBe(false);
  });

  it('dropOrphanIncoming leaves an incoming file that has a journal', async () => {
    await prepare();
    expect(dropOrphanIncoming(receiver)).toBe(false);
    expect(fs.existsSync(`${receiver}.swap-incoming`)).toBe(true);
  });

  it('after apply the file is a joined follower of the master, queued work carried, sync_rows not', async () => {
    await prepare();
    applyPendingSwap(receiver);
    const d = open();
    expect(
      d
        .prepare(
          `SELECT role, master_device_id m, joined, joining, tracking, pre_demote_epoch p FROM sync_state`,
        )
        .get(),
    ).toEqual({
      role: 'follower',
      m: MASTER,
      joined: 1,
      joining: 0,
      tracking: 0,
      p: null,
    });
    // the snapshot carries no sync_rows: the old file's X2 is not kept
    expect(d.prepare(`SELECT * FROM sync_rows`).all()).toEqual([]);
    expect(d.prepare(`SELECT count(*) n FROM sync_outbound`).get()).toEqual({
      n: 1,
    });
    expect(d.prepare(`SELECT tbl, pk FROM sync_retained`).all()).toEqual([
      { tbl: 't', pk: '["pk"]' },
    ]);
    d.close();
  });

  it('promote after the swap publishes no X2 row and no delete for it', async () => {
    await prepare();
    applyPendingSwap(receiver);
    const d = open();
    expect(d.prepare(`SELECT * FROM sync_imported`).all()).toEqual([]);
    promote(d, 5);
    expect(
      d.prepare(`SELECT tbl, pk FROM sync_rows WHERE pk = 'X2'`).all(),
    ).toEqual([]);
    d.close();
  });

  it('a join archive made earlier is untouched and still restorable', async () => {
    makeNormalReceiver(receiver);
    await prepare(null);
    applyPendingSwap(receiver);
    const [plain] = archives();
    const h = sha(path.join(path.dirname(receiver), plain));
    await prepare();
    expect(applyPendingSwap(receiver)).toBe('swapped');
    expect(archives()).toEqual([plain]);
    expect(sidecars()).toEqual([]);
    expect(sha(path.join(path.dirname(receiver), plain))).toBe(h);
    expect(prepareRestore(receiver)).toBe('ready');
    const j = JSON.parse(fs.readFileSync(`${receiver}.restore.json`, 'utf8'));
    expect(path.basename(j.archive)).toBe(plain);
  });
});

describe('swap outcome', () => {
  it('is JSON with markId and attempt for a recovery swap, and survives repeated reads', async () => {
    await prepare();
    applyPendingSwap(receiver);
    const raw = () =>
      JSON.parse(fs.readFileSync(`${receiver}.swap-outcome`, 'utf8'));
    expect(raw()).toEqual({ outcome: 'swapped', markId: 'mark-1', attempt: 2 });
    expect(applyPendingSwap(receiver)).toBe('none');
    expect(swapStatus(receiver)).toEqual(swapStatus(receiver));
    expect(raw().outcome).toBe('swapped');
  });

  it('an ordinary swap writes markId and attempt null; lastSwap projection is unchanged', async () => {
    await prepare(null);
    applyPendingSwap(receiver);
    expect(
      JSON.parse(fs.readFileSync(`${receiver}.swap-outcome`, 'utf8')),
    ).toEqual({
      outcome: 'swapped',
      markId: null,
      attempt: null,
    });
    expect(readSwapOutcome(receiver)).toBe('swapped');
  });

  it('a failed merge writes an abandoned JSON outcome carrying the ids', async () => {
    await prepare();
    fs.writeFileSync(`${receiver}.swap-incoming`, 'not a database');
    expect(applyPendingSwap(receiver)).toBe('abandoned');
    expect(
      JSON.parse(fs.readFileSync(`${receiver}.swap-outcome`, 'utf8')),
    ).toEqual({
      outcome: 'abandoned',
      markId: 'mark-1',
      attempt: 2,
    });
    expect(swapStatus(receiver)).toEqual({
      pending: null,
      outcome: 'failed',
      markId: 'mark-1',
      attempt: 2,
    });
    expect(readSwapOutcome(receiver)).toBe('abandoned');
    expect(archives()).toEqual([]);
  });

  it('readSwapOutcome reads the legacy bare strings', () => {
    fs.writeFileSync(`${receiver}.swap-outcome`, 'swapped');
    expect(readSwapOutcome(receiver)).toBe('swapped');
    expect(swapStatus(receiver)).toEqual({
      pending: null,
      outcome: 'ok',
      markId: null,
      attempt: null,
    });
    fs.writeFileSync(`${receiver}.swap-outcome`, 'abandoned');
    expect(readSwapOutcome(receiver)).toBe('abandoned');
    fs.writeFileSync(`${receiver}.swap-outcome`, 'junk');
    expect(readSwapOutcome(receiver)).toBeNull();
  });

  it('swapStatus is pending while a journal waits and null-outcome before anything ran', async () => {
    expect(swapStatus(receiver)).toEqual({
      pending: null,
      outcome: null,
      markId: null,
      attempt: null,
    });
    await prepare();
    expect(swapStatus(receiver)).toEqual({
      pending: 'swap',
      outcome: null,
      markId: 'mark-1',
      attempt: 2,
    });
  });

  it('clearSwapStatus clears only a matching markId and attempt', async () => {
    await prepare();
    applyPendingSwap(receiver);
    await clearSwapStatus(receiver, 'other', 2);
    await clearSwapStatus(receiver, 'mark-1', 1);
    expect(swapStatus(receiver).outcome).toBe('ok');
    await clearSwapStatus(receiver, 'mark-1', 2);
    expect(swapStatus(receiver).outcome).toBeNull();
    expect(fs.existsSync(`${receiver}.swap-outcome`)).toBe(false);
  });
});

describe('archives left by earlier versions', () => {
  /** What an earlier version left: an archive with its tag beside it. */
  const leaveTagged = (stamp: string): string => {
    const a = `${receiver}.archive-${stamp}`;
    fs.copyFileSync(receiver, a);
    fs.writeFileSync(
      `${a}.passed-over.json`,
      JSON.stringify({ markId: 'old', attempt: 1 }),
    );
    return a;
  };

  it('prepareRestore never picks a tagged archive, even a newer one', async () => {
    makeNormalReceiver(receiver);
    await prepare(null);
    applyPendingSwap(receiver);
    const [plain] = archives();
    leaveTagged('99991231235959');
    expect(prepareRestore(receiver)).toBe('ready');
    const j = JSON.parse(fs.readFileSync(`${receiver}.restore.json`, 'utf8'));
    expect(path.basename(j.archive)).toBe(plain);
  });

  it('with only a tagged archive prepareRestore says no-archive and writes nothing', () => {
    leaveTagged('20260101000000');
    expect(prepareRestore(receiver)).toBe('no-archive');
    expect(fs.existsSync(`${receiver}.restore.json`)).toBe(false);
  });

  it('a recovery swap leaves a former leader with nothing to go back to', async () => {
    await prepare();
    applyPendingSwap(receiver);
    expect(prepareRestore(receiver)).toBe('no-archive');
  });
});

describe('swapStatus while pending', () => {
  it('an ordinary pending swap reports pending swap with null ids', async () => {
    await prepare(null);
    expect(swapStatus(receiver)).toEqual({
      pending: 'swap',
      outcome: null,
      markId: null,
      attempt: null,
    });
  });
  it('a pending restore reports pending restore', async () => {
    makeNormalReceiver(receiver);
    await prepare(null);
    applyPendingSwap(receiver);
    expect(prepareRestore(receiver)).toBe('ready');
    expect(swapStatus(receiver).pending).toBe('restore');
  });
});

describe('failed-swap cleanup crash safety', () => {
  const CLEANUP = [
    'abandon-outcome',
    'abandon-journal',
    'abandon-cleaned',
  ] as const;
  for (const kind of ['ordinary follower', 'recovery'] as const) {
    it.each(CLEANUP)(
      `${kind}: a crash after %s leaves the original database and an abandoned outcome`,
      async (step) => {
        await prepare(kind === 'recovery' ? KEEP : null);
        fs.writeFileSync(`${receiver}.swap-incoming`, 'not a database');
        expect(() =>
          applyPendingSwap(receiver, (s) => {
            if (s === step) throw new Error('crash');
          }),
        ).toThrow('crash');
        const first = applyPendingSwap(receiver);
        expect(['abandoned', 'none']).toContain(first);
        expect(applyPendingSwap(receiver)).toBe('none');
        const d = open();
        expect(d.prepare(`SELECT account_id FROM vault`).all()).toEqual([
          { account_id: 'mine' },
        ]);
        expect(d.prepare(`SELECT count(*) n FROM sync_outbound`).get()).toEqual(
          { n: 1 },
        );
        d.close();
        expect(readSwapOutcome(receiver)).toBe('abandoned');
        expect(archives()).toEqual([]);
        expect(
          fs
            .readdirSync(path.dirname(receiver))
            .filter(
              (f) => f.includes('.swap-') && !f.endsWith('.swap-outcome'),
            ),
        ).toEqual([]);
      },
    );
  }

  it('a merged file that the journal does not call merged is never installed when nothing can be merged', async () => {
    await prepare();
    // Simulate the old hole: journal says not merged, and neither file exists.
    fs.rmSync(`${receiver}.swap-incoming`, { force: true });
    expect(applyPendingSwap(receiver)).toBe('abandoned');
    const d = open();
    expect(d.prepare(`SELECT account_id FROM vault`).all()).toEqual([
      { account_id: 'mine' },
    ]);
    d.close();
    expect(fs.existsSync(`${receiver}.swap-merged`)).toBe(false);
  });
});

describe('a merged file counts only with positive evidence', () => {
  const kinds = [
    ['ordinary follower', null],
    ['recovery', KEEP],
  ] as const;
  const tables = (d: Database.Database) =>
    (
      d.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as {
        name: string;
      }[]
    ).map((r) => r.name);
  const intact = () => {
    const d = open();
    expect(d.prepare(`SELECT account_id FROM vault`).all()).toEqual([
      { account_id: 'mine' },
    ]);
    expect(d.prepare(`SELECT count(*) n FROM documents`).get()).toEqual({
      n: 0,
    });
    d.close();
  };
  const swappedRight = () => {
    const d = open();
    expect(d.prepare(`SELECT count(*) n FROM documents`).get()).toEqual({
      n: 1,
    });
    expect(
      d.prepare(`SELECT master_device_id m FROM sync_state`).get(),
    ).toEqual({ m: MASTER });
    expect(d.prepare(`SELECT account_id FROM vault`).all()).toEqual([
      { account_id: 'mine' },
    ]);
    expect(tables(d)).not.toContain('sync_swap_merged');
    d.close();
  };

  for (const [kind, opts] of kinds) {
    it(`${kind}: an empty .swap-merged with the incoming present is discarded and re-merged`, async () => {
      await prepare(opts);
      fs.writeFileSync(`${receiver}.swap-merged`, '');
      expect(applyPendingSwap(receiver)).toBe('swapped');
      swappedRight();
    });

    it(`${kind}: an empty .swap-merged with no incoming is abandoned and the original is intact`, async () => {
      await prepare(opts);
      fs.rmSync(`${receiver}.swap-incoming`);
      fs.writeFileSync(`${receiver}.swap-merged`, '');
      expect(applyPendingSwap(receiver)).toBe('abandoned');
      expect(readSwapOutcome(receiver)).toBe('abandoned');
      intact();
      expect(fs.existsSync(`${receiver}.swap-merged`)).toBe(false);
    });

    it(`${kind}: a merged file with a wrong marker is not installed`, async () => {
      await prepare(opts);
      fs.rmSync(`${receiver}.swap-incoming`);
      const m = new Database(`${receiver}.swap-merged`);
      m.exec(`CREATE TABLE sync_swap_merged(sha256 TEXT); INSERT INTO sync_swap_merged VALUES('wrong');
              CREATE TABLE sync_state(role TEXT)`);
      m.close();
      expect(applyPendingSwap(receiver)).toBe('abandoned');
      intact();
    });

    it(`${kind}: a merged snapshot without a marker (hash-matching, no merge) is not installed`, async () => {
      await prepare(opts);
      fs.renameSync(`${receiver}.swap-incoming`, `${receiver}.swap-merged`);
      expect(applyPendingSwap(receiver)).toBe('abandoned');
      intact();
    });

    it(`${kind}: a crash after the merge commit and before the journal write still resumes as merged`, async () => {
      await prepare(opts);
      expect(() =>
        applyPendingSwap(receiver, (s) => {
          if (s === 'committed') throw new Error('crash');
        }),
      ).toThrow('crash');
      expect(
        JSON.parse(fs.readFileSync(`${receiver}.swap.json`, 'utf8')).merged,
      ).toBe(false);
      expect(applyPendingSwap(receiver)).toBe('swapped');
      swappedRight();
    });
  }
});

describe('discardForeignPending', () => {
  const files = () => fs.readdirSync(path.dirname(receiver)).sort();
  const debris = () => files().filter((f) => /swap|restore/.test(f));

  it('drops a pending ordinary swap: journal, incoming and merged files', async () => {
    await prepare(null);
    fs.writeFileSync(`${receiver}.swap-merged`, 'x');
    fs.writeFileSync(`${receiver}.swap.json.tmp`, 'x');
    expect(discardForeignPending(receiver, 'mark-1', 2)).toBe('dropped-swap');
    expect(debris()).toEqual([]);
    expect(swapStatus(receiver).pending).toBeNull();
  });

  it('drops a pending recovery swap of another mark or attempt', async () => {
    await prepare({ markId: 'other', attempt: 1 });
    expect(discardForeignPending(receiver, 'mark-1', 2)).toBe('dropped-swap');
    expect(debris()).toEqual([]);
    await prepare({ markId: 'mark-1', attempt: 1 });
    expect(discardForeignPending(receiver, 'mark-1', 2)).toBe('dropped-swap');
    expect(debris()).toEqual([]);
  });

  it('drops a pending restore journal and its tmp, leaving archives', async () => {
    makeNormalReceiver(receiver);
    await prepare(null);
    applyPendingSwap(receiver);
    expect(prepareRestore(receiver)).toBe('ready');
    fs.writeFileSync(`${receiver}.restore.json.tmp`, 'x');
    const before = archives();
    expect(discardForeignPending(receiver, 'mark-1', 2)).toBe(
      'dropped-restore',
    );
    expect(fs.existsSync(`${receiver}.restore.json`)).toBe(false);
    expect(fs.existsSync(`${receiver}.restore.json.tmp`)).toBe(false);
    expect(archives()).toEqual(before);
    expect(swapStatus(receiver).pending).toBeNull();
  });

  it('says none when nothing is pending and touches no file', async () => {
    await prepare();
    applyPendingSwap(receiver);
    const before = files();
    expect(discardForeignPending(receiver, 'mark-9', 1)).toBe('none');
    expect(files()).toEqual(before);
  });

  it('refuses its own journal and touches nothing', async () => {
    await prepare();
    const before = files();
    expect(discardForeignPending(receiver, 'mark-1', 2)).toBe('own');
    expect(files()).toEqual(before);
    expect(applyPendingSwap(receiver)).toBe('swapped');
  });

  it('a crash after the journal is gone leaves orphans that boot drops', async () => {
    await prepare(null);
    fs.rmSync(`${receiver}.swap.json`);
    expect(fs.existsSync(`${receiver}.swap-incoming`)).toBe(true);
    expect(applyPendingSwap(receiver)).toBe('none');
    expect(debris()).toEqual([]);
  });

  it('never touches the live database', async () => {
    await prepare(null);
    const h = sha(receiver);
    discardForeignPending(receiver, 'mark-1', 2);
    expect(sha(receiver)).toBe(h);
  });
});

describe('a recovery prepareSwap over a pending journal', () => {
  it('refuses over a foreign pending ordinary swap and leaves it intact', async () => {
    await prepare(null);
    const j = fs.readFileSync(`${receiver}.swap.json`, 'utf8');
    expect(await prepare()).toBe('pending');
    expect(fs.readFileSync(`${receiver}.swap.json`, 'utf8')).toBe(j);
  });

  it('refuses over a pending restore', async () => {
    makeNormalReceiver(receiver);
    await prepare(null);
    applyPendingSwap(receiver);
    prepareRestore(receiver);
    expect(await prepare()).toBe('pending');
    expect(fs.existsSync(`${receiver}.restore.json`)).toBe(true);
    expect(fs.existsSync(`${receiver}.swap.json`)).toBe(false);
  });

  it('refuses over another mark, but retries its own', async () => {
    await prepare({ markId: 'other', attempt: 1 });
    expect(await prepare()).toBe('pending');
    discardForeignPending(receiver, 'mark-1', 2);
    expect(await prepare()).toBe('ready');
    expect(await prepare()).toBe('ready');
  });

  it('after a discard the recovery swap replaces the current (divergent) database and keeps no archive', async () => {
    await prepare(null); // a prepared ordinary follower re-copy
    const d = open();
    d.exec(`INSERT INTO vault(account_id, blob) VALUES('divergent', x'01')`);
    d.close();
    expect(await prepare()).toBe('pending');
    expect(discardForeignPending(receiver, 'mark-1', 2)).toBe('dropped-swap');
    expect(await prepare()).toBe('ready');
    expect(applyPendingSwap(receiver)).toBe('swapped');
    expect(archives()).toEqual([]);
    expect(sidecars()).toEqual([]);
    // Local tables are this device's own and are carried.
    const now = open();
    expect(
      now.prepare(`SELECT account_id FROM vault ORDER BY 1`).all(),
    ).toEqual([{ account_id: 'divergent' }, { account_id: 'mine' }]);
    now.close();
  });
});
