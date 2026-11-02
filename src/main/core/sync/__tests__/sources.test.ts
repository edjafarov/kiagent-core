/** Multi-device sync step 1 (spec 7.7): which sources move, which stay, and
 *  what leaves this device in an offer. */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { openDb, type AppDb } from '../../../db/app-db';
import { migrate } from '../../store/schema';
import { openStore, type CoreStore } from '../../store/store';
import { gateFrom, readSyncGate } from '../role';
import {
  DEVICE_OWNED_SOURCES,
  exportSources,
  isDeviceOwned,
  isStableIdentity,
  STABLE_IDENTITY_SOURCES,
} from '../sources';
import { readSyncStatus } from '../status';

const SECRET = 'PLANTEDLOGINVALUE';
const ME = 'deviceAAAA-1111-2222';
const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};

let dir: string;
let db: AppDb;
let store: CoreStore;
const conn = () => db._conn!;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-sources-'));
  db = await openDb(path.join(dir, 'a.db'));
  migrate(conn());
  store = openStore(db, deps);
});
afterEach(async () => {
  await db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const add = async (source: string, identifier: string, login?: unknown) => {
  const a = await store.createAccount({ source, identifier, config: { k: 1 } });
  if (login !== undefined) await store.vault.save(a.id, login as never);
  return a;
};

describe('the two lists', () => {
  it('device-owned sources are the plan list plus the agent-session sources', () => {
    expect([...DEVICE_OWNED_SOURCES].sort()).toEqual(
      ['assistant', 'claude-code', 'codex', 'local-folder', 'meetings', 'whatsapp'],
    );
    expect(isDeviceOwned('whatsapp')).toBe(true);
    expect(isDeviceOwned('gmail')).toBe(false);
  });

  it('telegram has a stable identity, a display-name source does not, nothing is in both', () => {
    expect(isStableIdentity('telegram')).toBe(true);
    expect(isStableIdentity('notion')).toBe(false);
    expect(isStableIdentity('never-heard-of-it')).toBe(false);
    for (const s of STABLE_IDENTITY_SOURCES) expect(isDeviceOwned(s)).toBe(false);
  });
});

describe('exportSources', () => {
  it('exports moveable accounts with their vault row', async () => {
    const a = await add('gmail', 'me@x.com', { accessToken: SECRET });
    const out = await exportSources(store, ME);
    expect(out).toEqual([
      {
        source: 'gmail',
        identifier: 'me@x.com',
        config: JSON.stringify({ k: 1 }),
        cadence: null,
        credentials: { accessToken: SECRET },
        owner_device_id: null,
      },
    ]);
    expect(a.id).toBeTruthy();
  });

  it('telegram with a vault row is exported with its secret', async () => {
    await add('telegram', '42', { apiId: 1, apiHash: 'h', session: SECRET });
    const [t] = await exportSources(store, ME);
    expect(t).toMatchObject({ source: 'telegram', credentials: { session: SECRET } });
  });

  it('a device-owned account is exported as a row with owner_device_id and no credentials', async () => {
    await add('local-folder', '/Users/me/docs');
    await add('whatsapp', '491700000', { keys: SECRET });
    const out = await exportSources(store, ME);
    expect(out.map((o) => o.source).sort()).toEqual(['local-folder', 'whatsapp']);
    for (const o of out) {
      expect(o.credentials).toBeNull();
      expect(o.owner_device_id).toBe(ME);
    }
    expect(JSON.stringify(out)).not.toContain(SECRET);
  });

  it('a device-owned identifier gets the suffix once: only while it has no owner yet', async () => {
    const a = await add('local-folder', '/Users/me/docs');
    const b = await add('whatsapp', '491700000');
    conn().prepare(`UPDATE accounts SET owner_device_id = ? WHERE id = ?`).run('someoneElse', b.id);
    const out = Object.fromEntries((await exportSources(store, ME)).map((o) => [o.source, o]));
    expect(out['local-folder'].identifier).toBe('/Users/me/docs#deviceAA');
    expect(out['whatsapp'].identifier).toBe('491700000');
    expect(out['whatsapp'].owner_device_id).toBe('someoneElse');
    expect(a.id).toBeTruthy();
  });

  it('a moveable account is not suffixed here: the seed decides on a match', async () => {
    await add('notion', 'Acme', { token: 'n' });
    const [n] = await exportSources(store, ME);
    expect(n.identifier).toBe('Acme');
  });

  it('skips the synthetic worker account', async () => {
    await add('worker', 'w');
    expect(await exportSources(store, ME)).toEqual([]);
  });

  it('an identifier with a device suffix is stored and read back unchanged', async () => {
    const a = await add('notion', 'Acme#deviceAA', { token: 'n' });
    expect((await store.account(a.id))!.identifier).toBe('Acme#deviceAA');
  });

  it('no credentials in logs', async () => {
    await add('gmail', 'me@x.com', { accessToken: SECRET });
    const lines: string[] = [];
    await exportSources(store, ME, (level, msg) => lines.push(`${level} ${msg}`));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain(SECRET);
  });
});

describe('the gate', () => {
  it('a joining device is read-only like a follower; a plain one is not', () => {
    expect(gateFrom({ role: 'normal', joining: false })).toBe(false);
    expect(gateFrom({ role: 'follower', joining: false })).toBe(true);
    expect(gateFrom({ role: 'normal', joining: true })).toBe(true);
  });

  it('boot gates a joining device', async () => {
    expect(await readSyncGate(db)).toEqual({ role: 'normal', joining: false, joined: false });
    conn().prepare(`UPDATE sync_state SET joining = 1`).run();
    const g = await readSyncGate(db);
    expect(g.joining).toBe(true);
    expect(gateFrom(g)).toBe(true);
  });
});

describe('status', () => {
  it('counts documents that are not archived, and reports joining, joined and the swap outcome', async () => {
    const a = await add('gmail', 'me@x.com');
    const d = (e: string) => ({ externalId: e, type: 'file', title: e, markdown: 'b', metadata: {}, createdAt: null });
    await store.commit({ account: a.id, documents: [d('1'), d('2'), d('3')], cursor: null });
    conn().prepare(`UPDATE documents SET archived_at = 'x' WHERE external_id = '3'`).run();
    let s = readSyncStatus(conn());
    expect(s).toMatchObject({ documents: 2, joining: false, joined: false, lastSwap: null });
    conn().prepare(`UPDATE sync_state SET joining = 1, joined = 1`).run();
    fs.writeFileSync(`${conn().name}.swap-outcome`, 'abandoned');
    s = readSyncStatus(conn());
    expect(s).toMatchObject({ joining: true, joined: true, lastSwap: 'abandoned' });
  });
});
