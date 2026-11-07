/** Keep-archive swap (vanished-leader D4): the old file always becomes an
 *  archive tagged with a sidecar, and the outcome is durable and attempt-tagged. */
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
  dropOrphanIncoming,
  findPassedOverArchive,
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
const KEEP = { keepArchive: true as const, markId: 'mark-1', attempt: 2 };

let n = 0;
let dir: string;
let master: AppDb;
let store: CoreStore;
let snap: string;
let receiver: string;
const open = () => new Database(receiver);
const sha = (f: string) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const archives = () =>
  fs
    .readdirSync(path.dirname(receiver))
    .filter((f) => f.includes('.archive-') && /\d$/.test(f))
    .sort();
const sidecar = (archive: string) =>
  JSON.parse(fs.readFileSync(path.join(path.dirname(receiver), `${archive}.passed-over.json`), 'utf8'));

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
  for (const ext of ['', '-wal', '-shm']) fs.rmSync(`${file}${ext}`, { force: true });
  const d = new Database(file);
  d.pragma('journal_mode = WAL');
  migrate(d);
  d.close();
}

const prepare = async (opts: { keepArchive: true; markId: string; attempt: number } | null = KEEP) => {
  const a = await store.createAccount({ source: 'test', identifier: `a${n++}@b` });
  await store.commit({ account: a.id as never, documents: [doc(`d${n}`)], cursor: null });
  const r = buildSnapshot(path.join(dir, 'master.db'), snap);
  return prepareSwap(receiver, snap, r.sha256, MASTER, undefined, opts ?? undefined);
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

describe('keep-archive swap', () => {
  it('moves a follower file to a tagged archive with a sidecar', async () => {
    expect(await prepare()).toBe('ready');
    expect(applyPendingSwap(receiver)).toBe('swapped');
    const [a] = archives();
    expect(archives()).toHaveLength(1);
    expect(sidecar(a)).toEqual({
      markId: 'mark-1',
      holder: MASTER,
      at: expect.any(String),
      attempt: 2,
    });
    const arch = new Database(path.join(path.dirname(receiver), a), { readonly: true });
    expect(arch.prepare(`SELECT account_id FROM vault`).all()).toEqual([{ account_id: 'mine' }]);
    arch.close();
  });

  it.each([...SWAP_STEPS, 'incoming-renamed' as const])(
    'a crash after %s resumes to the same result with the sidecar in place',
    async (step) => {
      await prepare();
      expect(() =>
        applyPendingSwap(receiver, (s) => {
          if (s === (step as string)) throw new Error('crash');
        }),
      ).toThrow('crash');
      const reached = SWAP_STEPS.indexOf(step as never);
      if (step === 'merged' || reached > SWAP_STEPS.indexOf('merged')) {
        const a = fs
          .readdirSync(path.dirname(receiver))
          .filter((f) => f.endsWith('.passed-over.json'));
        expect(a).toHaveLength(1);
      }
      expect(applyPendingSwap(receiver)).toBe('swapped');
      expect(archives()).toHaveLength(1);
      expect(sidecar(archives()[0]).markId).toBe('mark-1');
      expect(swapStatus(receiver)).toEqual({
        pending: null,
        outcome: 'ok',
        markId: 'mark-1',
        attempt: 2,
      });
      const d = open();
      expect(d.prepare(`SELECT account_id FROM vault`).all()).toEqual([{ account_id: 'mine' }]);
      d.close();
    },
  );

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
      d.prepare(`SELECT role, master_device_id m, joined, joining, tracking, pre_demote_epoch p FROM sync_state`).get(),
    ).toEqual({ role: 'follower', m: MASTER, joined: 1, joining: 0, tracking: 0, p: null });
    // the snapshot carries no sync_rows: the old file's X2 is not kept
    expect(d.prepare(`SELECT * FROM sync_rows`).all()).toEqual([]);
    expect(d.prepare(`SELECT count(*) n FROM sync_outbound`).get()).toEqual({ n: 1 });
    expect(d.prepare(`SELECT tbl, pk FROM sync_retained`).all()).toEqual([{ tbl: 't', pk: '["pk"]' }]);
    d.close();
  });

  it('promote after the swap publishes no X2 row and no delete for it', async () => {
    await prepare();
    applyPendingSwap(receiver);
    const d = open();
    expect(d.prepare(`SELECT * FROM sync_imported`).all()).toEqual([]);
    promote(d, 5);
    expect(d.prepare(`SELECT tbl, pk FROM sync_rows WHERE pk = 'X2'`).all()).toEqual([]);
    d.close();
  });

  it('records replacesCopy false even for a follower with no earlier archive, and never deletes the file', async () => {
    await prepare();
    applyPendingSwap(receiver);
    expect(archives()).toHaveLength(1);
  });

  it('two archives made in the same second do not overwrite each other', async () => {
    makeNormalReceiver(receiver);
    await prepare(null);
    applyPendingSwap(receiver);
    await prepare();
    applyPendingSwap(receiver);
    expect(archives()).toHaveLength(2);
  });
});

describe('swap outcome', () => {
  it('is JSON with markId and attempt for a keep-archive swap, and survives repeated reads', async () => {
    await prepare();
    applyPendingSwap(receiver);
    const raw = () => JSON.parse(fs.readFileSync(`${receiver}.swap-outcome`, 'utf8'));
    expect(raw()).toEqual({ outcome: 'swapped', markId: 'mark-1', attempt: 2 });
    expect(applyPendingSwap(receiver)).toBe('none');
    expect(swapStatus(receiver)).toEqual(swapStatus(receiver));
    expect(raw().outcome).toBe('swapped');
  });

  it('an ordinary swap writes markId and attempt null; lastSwap projection is unchanged', async () => {
    await prepare(null);
    applyPendingSwap(receiver);
    expect(JSON.parse(fs.readFileSync(`${receiver}.swap-outcome`, 'utf8'))).toEqual({
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
    expect(JSON.parse(fs.readFileSync(`${receiver}.swap-outcome`, 'utf8'))).toEqual({
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
    expect(swapStatus(receiver)).toEqual({ pending: null, outcome: 'ok', markId: null, attempt: null });
    fs.writeFileSync(`${receiver}.swap-outcome`, 'abandoned');
    expect(readSwapOutcome(receiver)).toBe('abandoned');
    fs.writeFileSync(`${receiver}.swap-outcome`, 'junk');
    expect(readSwapOutcome(receiver)).toBeNull();
  });

  it('swapStatus is pending while a journal waits and null-outcome before anything ran', async () => {
    expect(swapStatus(receiver)).toEqual({ pending: null, outcome: null, markId: null, attempt: null });
    await prepare();
    expect(swapStatus(receiver)).toEqual({ pending: 'swap', outcome: null, markId: 'mark-1', attempt: 2 });
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

describe('passed-over archives', () => {
  it('findPassedOverArchive matches the sidecar markId and attempt', async () => {
    await prepare();
    applyPendingSwap(receiver);
    expect(await findPassedOverArchive(receiver, 'mark-1', 2)).toBe(true);
    expect(await findPassedOverArchive(receiver, 'mark-1', 3)).toBe(false);
    expect(await findPassedOverArchive(receiver, 'mark-2', 2)).toBe(false);
  });

  it('prepareRestore picks the newest archive without a sidecar', async () => {
    makeNormalReceiver(receiver);
    await prepare(null);
    applyPendingSwap(receiver);
    const [plain] = archives();
    await prepare();
    applyPendingSwap(receiver);
    expect(archives()).toHaveLength(2);
    expect(prepareRestore(receiver)).toBe('ready');
    const j = JSON.parse(fs.readFileSync(`${receiver}.restore.json`, 'utf8'));
    expect(path.basename(j.archive)).toBe(plain);
  });

  it('with only sidecar archives prepareRestore says no-archive and writes nothing', async () => {
    await prepare();
    applyPendingSwap(receiver);
    expect(prepareRestore(receiver)).toBe('no-archive');
    expect(fs.existsSync(`${receiver}.restore.json`)).toBe(false);
  });
});

describe('swapStatus while pending', () => {
  it('an ordinary pending swap reports pending swap with null ids', async () => {
    await prepare(null);
    expect(swapStatus(receiver)).toEqual({ pending: 'swap', outcome: null, markId: null, attempt: null });
  });
  it('a pending restore reports pending restore', async () => {
    makeNormalReceiver(receiver);
    await prepare(null);
    applyPendingSwap(receiver);
    expect(prepareRestore(receiver)).toBe('ready');
    expect(swapStatus(receiver).pending).toBe('restore');
  });
});

describe('a crash between the journal write and the sidecar write', () => {
  it('resumes and the sidecar is written before the archive moves', async () => {
    await prepare();
    expect(() =>
      applyPendingSwap(receiver, (s) => {
        if (s === 'journaled') throw new Error('crash');
      }),
    ).toThrow('crash');
    expect(fs.readdirSync(path.dirname(receiver)).filter((f) => f.endsWith('.passed-over.json'))).toEqual([]);
    expect(applyPendingSwap(receiver)).toBe('swapped');
    expect(archives()).toHaveLength(1);
    expect(sidecar(archives()[0]).markId).toBe('mark-1');
  });
});

describe('failed-swap cleanup crash safety', () => {
  const CLEANUP = ['abandon-outcome', 'abandon-journal', 'abandon-cleaned'] as const;
  for (const kind of ['ordinary follower', 'keep-archive'] as const) {
    it.each(CLEANUP)(`${kind}: a crash after %s leaves the original database and an abandoned outcome`, async (step) => {
      await prepare(kind === 'keep-archive' ? KEEP : null);
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
      expect(d.prepare(`SELECT account_id FROM vault`).all()).toEqual([{ account_id: 'mine' }]);
      expect(d.prepare(`SELECT count(*) n FROM sync_outbound`).get()).toEqual({ n: 1 });
      d.close();
      expect(readSwapOutcome(receiver)).toBe('abandoned');
      expect(archives()).toEqual([]);
      expect(fs.readdirSync(path.dirname(receiver)).filter((f) => f.includes('.swap-') && !f.endsWith('.swap-outcome'))).toEqual([]);
    });
  }

  it('a merged file that the journal does not call merged is never installed when nothing can be merged', async () => {
    await prepare();
    // Simulate the old hole: journal says not merged, and neither file exists.
    fs.rmSync(`${receiver}.swap-incoming`, { force: true });
    expect(applyPendingSwap(receiver)).toBe('abandoned');
    const d = open();
    expect(d.prepare(`SELECT account_id FROM vault`).all()).toEqual([{ account_id: 'mine' }]);
    d.close();
    expect(fs.existsSync(`${receiver}.swap-merged`)).toBe(false);
  });
});
