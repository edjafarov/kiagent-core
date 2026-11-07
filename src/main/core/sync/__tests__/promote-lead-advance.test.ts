/** D3: a tracking leader told to lead a newer epoch advances into it. */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { openDb, type AppDb } from '../../../db/app-db';
import { migrate } from '../../store/schema';
import { openStore, type CoreStore } from '../../store/store';
import { EPOCH_GAP as GAP, lead, promote } from '../promote';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};

let db: AppDb;
let store: CoreStore;
let dir: string;
const conn = () => db._conn!;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-lead-adv-'));
  db = await openDb(path.join(dir, 'a.db'));
  migrate(conn());
  store = openStore(db, deps);
  conn()
    .prepare(
      `UPDATE sync_state SET role='follower', master_device_id='m1', tracking=0,
                             history_id='h1', after_seq=7, after_cursor=5, joined=1`,
    )
    .run();
  promote(conn(), 23);
});
afterEach(async () => {
  await db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const seqOf = (name: string) =>
  ((conn().prepare(`SELECT seq FROM sqlite_sequence WHERE name = ?`).get(name) as { seq: number } | undefined)
    ?.seq ?? 0);
const epochOf = () => (conn().prepare(`SELECT epoch FROM sync_state`).get() as { epoch: number }).epoch;

describe('lead on a tracking leader', () => {
  it('advances to a newer epoch, raising counters and recording the raised grant', async () => {
    expect(lead(conn(), 25)).toBe('advanced');
    expect(seqOf('changes')).toBeGreaterThanOrEqual(25 * GAP);
    expect(seqOf('sync_rows')).toBeGreaterThanOrEqual(25 * GAP);
    const row = conn().prepare(`SELECT grant_seq, grant_cursor FROM sync_epochs WHERE epoch = 25`).get() as {
      grant_seq: number;
      grant_cursor: number;
    };
    // Counters were below the range, so the raised value is exactly the start of it.
    expect(row.grant_seq).toBe(25 * GAP);
    expect(row.grant_cursor).toBe(25 * GAP);
    expect(epochOf()).toBe(25);
    await store.createAccount({ source: 's', identifier: 'x' });
    const head = (conn().prepare(`SELECT max(seq) AS m FROM changes`).get() as { m: number }).m;
    expect(head).toBeGreaterThan(25 * GAP);
  });

  it('is a noop for the same or an older epoch', () => {
    expect(lead(conn(), 25)).toBe('advanced');
    expect(lead(conn(), 25)).toBe('noop');
    expect(lead(conn(), 24)).toBe('noop');
    expect(epochOf()).toBe(25);
  });

  it('never lowers a counter that is already above the new range', () => {
    const high = 30 * GAP;
    conn().prepare(`UPDATE sqlite_sequence SET seq = ? WHERE name IN ('changes','sync_rows')`).run(high);
    expect(lead(conn(), 25)).toBe('advanced');
    expect(seqOf('changes')).toBeGreaterThanOrEqual(high);
    expect(seqOf('sync_rows')).toBeGreaterThanOrEqual(high);
    const row = conn().prepare(`SELECT grant_seq, grant_cursor FROM sync_epochs WHERE epoch = 25`).get() as {
      grant_seq: number;
      grant_cursor: number;
    };
    expect(row.grant_seq).toBeGreaterThanOrEqual(high);
    expect(row.grant_cursor).toBeGreaterThanOrEqual(high);
  });
});
