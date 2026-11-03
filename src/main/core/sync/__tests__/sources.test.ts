/** Multi-device sync step 1 (spec 7.7): which sources move, which stay, and
 *  what leaves this device in an offer. */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { openDb, type AppDb } from '../../../db/app-db';
import { migrate } from '../../store/schema';
import { openStore, type CoreStore } from '../../store/store';
import type { Account } from '@shared/contracts';

import { resumeAccounts, startWhenInstalled, type CorePlatform } from '../../boot';
import { isResting } from '../../engine/resting';
import { gateFrom, readSyncGate } from '../role';
import { createSyncService, type SyncService } from '../service';
import { applyPendingSwap } from '../swap';
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

  it('a telegram vault row with a session in secret is exported with it', async () => {
    await add('telegram', '42', { secret: JSON.stringify({ session: SECRET }) });
    const [t] = await exportSources(store, ME);
    expect(JSON.parse((t.credentials as { secret: string }).secret).session).toBe(SECRET);
  });

  it('a telegram row holding only a 2FA password still exports (the seed starts it unpaired)', async () => {
    await add('telegram', '42', { password: 'twofa' });
    const [t] = await exportSources(store, ME);
    expect(t).toMatchObject({ source: 'telegram', credentials: { password: 'twofa' } });
    expect(t.credentials).not.toHaveProperty('secret');
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

  it('a moveable account with no vault row is not exported', async () => {
    await add('gmail', 'nologin@x.com');
    await add('gmail', 'login@x.com', { t: 1 });
    await add('local-folder', '/p');
    const out = await exportSources(store, ME);
    expect(out.map((o) => o.identifier).sort()).toEqual(['/p#deviceAA', 'login@x.com']);
  });

  it('prepareExport runs for each account before its vault is read, and what it writes is exported', async () => {
    const a = await add('telegram', '42');
    const order: string[] = [];
    const sources = {
      get: (id: string) =>
        id === 'telegram'
          ? {
              prepareExport: async (ctx: { account: { id: string }; save(c: unknown): Promise<void> }) => {
                order.push(`prepare ${ctx.account.id === a.id}`);
                await ctx.save({ session: SECRET });
              },
            }
          : undefined,
    };
    const [t] = await exportSources(store, ME, undefined, sources as never);
    expect(order).toEqual(['prepare true']);
    expect(t).toMatchObject({ source: 'telegram', credentials: { session: SECRET } });
  });

  it('a prepareExport that throws is logged without its message and the export goes on', async () => {
    await add('telegram', '42', { session: 'old' });
    const lines: string[] = [];
    const sources = { get: () => ({ prepareExport: async () => { throw new Error(SECRET); } }) };
    const out = await exportSources(store, ME, (l, m) => lines.push(`${l} ${m}`), sources as never);
    expect(out).toHaveLength(1);
    expect(lines.join('\n')).not.toContain(SECRET);
  });

  describe('a connector that has not registered yet', () => {
    type Reg = {
      get(id: string): { prepareExport?: (c: { save(c: unknown): Promise<void> }) => Promise<void> } | undefined;
      advertisesPrepareExport(id: string): boolean;
      onRegister(cb: (id: string) => void): () => void;
    };
    const registry = (advertised: string[]) => {
      const live = new Map<string, { prepareExport?: (c: { save(c: unknown): Promise<void> }) => Promise<void> }>();
      const listeners = new Set<(id: string) => void>();
      const reg: Reg = {
        get: (id) => live.get(id),
        advertisesPrepareExport: (id) => advertised.includes(id),
        onRegister: (cb) => {
          listeners.add(cb);
          return () => void listeners.delete(cb);
        },
      };
      const register = (id: string) => {
        live.set(id, { prepareExport: async (c) => c.save({ session: SECRET }) });
        for (const l of [...listeners]) l(id);
      };
      return { reg, register, listening: () => listeners.size };
    };

    afterEach(() => jest.useRealTimers());

    it('is waited for, and its hook then runs before the vault is read', async () => {
      jest.useFakeTimers();
      await add('telegram', '42', { session: 'old' });
      const { reg, register, listening } = registry(['telegram']);
      let done = false;
      const p = exportSources(store, ME, undefined, reg as never).then((o) => {
        done = true;
        return o;
      });
      await jest.advanceTimersByTimeAsync(30_000);
      expect(done).toBe(false);
      register('telegram');
      const [t] = await p;
      expect(t).toMatchObject({ source: 'telegram', credentials: { session: SECRET } });
      expect(listening()).toBe(0);
    });

    it('after 60 s the export goes on and the log names the source, not the login', async () => {
      jest.useFakeTimers();
      await add('telegram', '42', { session: SECRET });
      const lines: string[] = [];
      const { reg } = registry(['telegram']);
      const p = exportSources(store, ME, (l, m) => lines.push(`${l} ${m}`), reg as never);
      await jest.advanceTimersByTimeAsync(60_000);
      const out = await p;
      expect(out).toHaveLength(1);
      expect(lines.filter((l) => l.includes('telegram') && l.startsWith('warn'))).toHaveLength(1);
      expect(lines.join('\n')).not.toContain(SECRET);
    });

    it('is not waited for when it never advertised a hook', async () => {
      await add('gmail', 'a@x.com', { t: 1 });
      const { reg } = registry([]);
      const out = await exportSources(store, ME, undefined, reg as never);
      expect(out).toHaveLength(1);
    });
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
    expect(await readSyncGate(db)).toEqual({ role: 'normal', joining: false, joined: false, tracking: false });
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


describe('hasMoveableLogins', () => {
  let hooks: Set<string>;
  let prepared: number;
  let sync: SyncService;
  beforeEach(() => {
    hooks = new Set();
    prepared = 0;
    sync = createSyncService({
      db,
      store,
      dbPath: conn().name,
      workerFile: '',
      deviceId: () => ME,
      sources: {
        get: (id: string) =>
          hooks.has(id)
            ? {
                prepareExport: async () => {
                  prepared += 1;
                },
              }
            : undefined,
        advertisesPrepareExport: (id: string) => hooks.has(id),
      } as never,
    });
  });

  it('is false with no accounts, with only device-owned accounts, and with accounts that have no vault row and no hook', async () => {
    expect(await sync.hasMoveableLogins()).toBe(false);
    await add('local-folder', '/p', { t: 1 });
    await add('whatsapp', 'w', { t: 1 });
    await add('gmail', 'nologin@x.com');
    expect(await sync.hasMoveableLogins()).toBe(false);
  });

  it('is true for a vault row not in DEVICE_OWNED_SOURCES', async () => {
    await add('gmail', 'a@x.com', { t: 1 });
    expect(await sync.hasMoveableLogins()).toBe(true);
  });

  it('is true for an account without a vault row whose source advertises prepareExport', async () => {
    await add('telegram', '42');
    expect(await sync.hasMoveableLogins()).toBe(false);
    hooks.add('telegram');
    expect(await sync.hasMoveableLogins()).toBe(true);
  });

  it('does not call prepareExport, write sync_moved or open the vault blob', async () => {
    await add('gmail', 'a@x.com', { t: 1 });
    await add('telegram', '42');
    hooks.add('telegram');
    const loads = jest.spyOn(store.vault, 'load');
    expect(await sync.hasMoveableLogins()).toBe(true);
    expect(prepared).toBe(0);
    expect(loads).not.toHaveBeenCalled();
    expect((conn().prepare(`SELECT count(*) n FROM sync_moved`).get() as { n: number }).n).toBe(0);
  });

  it('status.accounts counts non-worker accounts, device-owned ones included, and ignores worker', async () => {
    expect(readSyncStatus(conn()).accounts).toBe(0);
    await add('gmail', 'a@x.com');
    await add('local-folder', '/p');
    await add('worker', 'w');
    expect(readSyncStatus(conn()).accounts).toBe(2);
  });
});

// ── Task 2: import ─────────────────────────────────────────────────────────
describe('importSources', () => {
  const JOINER = 'abcdefgh-0000-1111';
  const SEED = 'seedseed-9999';
  let sync: SyncService;
  let started: string[];
  let installed: (s: string) => boolean;
  let keystore: boolean;
  let strict: (s: string) => Buffer;
  const logs: string[] = [];

  beforeEach(() => {
    started = [];
    installed = () => true;
    keystore = true;
    strict = (s) => Buffer.from(s, 'utf8');
    logs.length = 0;
    sync = createSyncService({
      db,
      store,
      dbPath: conn().name,
      workerFile: '',
      deviceId: () => SEED,
      encryptStrict: (s) => strict(s),
      keystoreAvailable: () => keystore,
      isInstalled: (src) => installed(src),
      start: async (id) => {
        started.push(id);
      },
      busy: () => null,
      log: (l, m) => logs.push(`${l} ${m}`),
    });
  });

  const offer = (over: Record<string, unknown> = {}) => ({
    source: 'gmail',
    identifier: 'me@x.com',
    config: JSON.stringify({ k: 2 }),
    cadence: null,
    credentials: { accessToken: 'joiner-token' },
    owner_device_id: null,
    ...over,
  });
  const accounts = () => conn().prepare(`SELECT * FROM accounts ORDER BY identifier`).all() as Record<string, unknown>[];
  const vaultCount = () => (conn().prepare(`SELECT count(*) n FROM vault`).get() as { n: number }).n;

  it('stable source match keeps the seed\'s token', async () => {
    const a = await add('gmail', 'me@x.com', { accessToken: 'seed-token' });
    const r = await sync.importSources('o1', [offer()] as never, JOINER);
    expect(r).toEqual({ created: [], existing: [a.id], needsConnector: [] });
    expect(accounts()).toHaveLength(1);
    expect(await store.vault.load(a.id)).toEqual({ accessToken: 'seed-token' });
  });

  it('unstable source match imports as identifier#device8, the same on retry', async () => {
    const seed = await add('notion', 'Acme', { token: 'seed' });
    const r1 = await sync.importSources('o1', [offer({ source: 'notion', identifier: 'Acme', credentials: { token: 'joiner' } })] as never, JOINER);
    expect(r1.created).toHaveLength(1);
    const r2 = await sync.importSources('o2', [offer({ source: 'notion', identifier: 'Acme', credentials: { token: 'joiner' } })] as never, JOINER);
    expect(r2.created).toEqual([]);
    expect(r2.existing).toEqual(r1.created);
    expect(accounts().map((a) => a.identifier)).toEqual(['Acme', 'Acme#abcdefgh']);
    expect(await store.vault.load(r1.created[0] as never)).toEqual({ token: 'joiner' });
    expect(await store.vault.load(seed.id)).toEqual({ token: 'seed' });
  });

  it('a device-owned row imports with its owner, no login, resting, and no admission path runs it', async () => {
    const r = await sync.importSources('o1', [
      offer({ source: 'local-folder', identifier: '/p#abcdefgh', credentials: null, owner_device_id: JOINER }),
    ] as never, JOINER);
    expect(r.created).toHaveLength(1);
    const row = accounts()[0];
    expect(row).toMatchObject({ owner_device_id: JOINER, status: 'paused' });
    expect(vaultCount()).toBe(0);
    expect(started).toEqual([]);
    const acct = (await store.read.accounts())[0] as Account;
    expect(acct.ownerDeviceId).toBe(JOINER);
    expect(isResting(acct.status)).toBe(true);
    const runs: string[] = [];
    const p = {
      store: { read: { accounts: async () => [acct] } },
      sources: { get: () => ({ descriptor: { id: 'local-folder' } }) },
      logSink: { log: () => undefined },
      engine: { run: (a: Account) => (runs.push(a.id), {}) },
      scheduler: { register: jest.fn() },
    } as unknown as CorePlatform;
    await resumeAccounts(p);
    expect(runs).toEqual([]);
  });

  it('an unstable source imports as identifier#device8 even with no collision, the same on retry', async () => {
    const r1 = await sync.importSources('o1', [offer({ source: 'notion', identifier: 'Acme', credentials: { token: 'j' } })] as never, JOINER);
    const r2 = await sync.importSources('o2', [offer({ source: 'notion', identifier: 'Acme', credentials: { token: 'j' } })] as never, JOINER);
    expect(accounts().map((a) => a.identifier)).toEqual(['Acme#abcdefgh']);
    expect(r2).toEqual({ created: [], existing: r1.created, needsConnector: [] });
  });

  it('two workspaces with one display name both survive', async () => {
    await add('notion', 'Acme', { token: 'a' });
    await sync.importSources('o1', [offer({ source: 'notion', identifier: 'Acme', credentials: { token: 'b' } })] as never, JOINER);
    expect(accounts()).toHaveLength(2);
    expect(vaultCount()).toBe(2);
  });

  it('a new account starts from a null cursor with its login', async () => {
    const r = await sync.importSources('o1', [offer()] as never, JOINER);
    const row = accounts()[0];
    expect(row).toMatchObject({ cursor: null, status: 'connecting', owner_device_id: null, config: JSON.stringify({ k: 2 }) });
    expect(await store.vault.load(r.created[0] as never)).toEqual({ accessToken: 'joiner-token' });
  });

  it('new account starts after commit, without a restart', async () => {
    const seen: number[] = [];
    sync = createSyncService({
      db, store, dbPath: conn().name, workerFile: '', deviceId: () => SEED,
      encryptStrict: (s) => Buffer.from(s), keystoreAvailable: () => true,
      start: async (id) => {
        seen.push(accounts().filter((a) => a.id === id).length);
        started.push(id);
      },
    });
    const r = await sync.importSources('o1', [offer()] as never, JOINER);
    expect(started).toEqual(r.created);
    expect(seen).toEqual([1]);
  });

  it('same offer_id twice changes nothing', async () => {
    const r1 = await sync.importSources('o1', [offer()] as never, JOINER);
    const before = JSON.stringify(accounts());
    const r2 = await sync.importSources('o1', [offer()] as never, JOINER);
    expect(r2).toEqual({ created: [], existing: r1.created, needsConnector: [] });
    expect(JSON.stringify(accounts())).toBe(before);
    expect(vaultCount()).toBe(1);
    expect(started).toEqual(r1.created);
  });

  it('two concurrent offers for one account: one account, one login', async () => {
    await Promise.all([
      sync.importSources('o1', [offer()] as never, JOINER),
      sync.importSources('o2', [offer()] as never, JOINER),
    ]);
    expect(accounts()).toHaveLength(1);
    expect(vaultCount()).toBe(1);
  });

  it('crash inside the import leaves neither account nor login', async () => {
    conn().exec(`CREATE TRIGGER boom BEFORE INSERT ON vault WHEN NEW.account_id IN (SELECT id FROM accounts WHERE identifier = 'second') BEGIN SELECT RAISE(ABORT, 'boom'); END`);
    // The driver's error can come from another realm, so it is read by shape.
    const err = await sync
      .importSources('o1', [offer(), offer({ identifier: 'second' })] as never, JOINER)
      .then(() => null, (e: unknown) => e as { message?: string });
    expect(String(err?.message)).toMatch(/boom/);
    expect(accounts()).toHaveLength(0);
    expect(vaultCount()).toBe(0);
    expect((conn().prepare(`SELECT count(*) n FROM sync_offers`).get() as { n: number }).n).toBe(0);
    expect(started).toEqual([]);
  });

  it('encrypt failing refuses the offer, even when availability said true: no obfuscated row', async () => {
    strict = () => {
      throw new Error('keystore revoked');
    };
    await expect(sync.importSources('o1', [offer()] as never, JOINER)).rejects.toThrow(/keystore/);
    expect(accounts()).toHaveLength(0);
    expect(vaultCount()).toBe(0);
  });

  it('no keystore refuses', async () => {
    keystore = false;
    expect(sync.canAcceptSources()).toBe(false);
    await expect(sync.importSources('o1', [offer()] as never, JOINER)).rejects.toThrow(/keystore/);
    expect(accounts()).toHaveLength(0);
  });

  it('unknown connector: needs-connector with the login kept, and no admission path runs it', async () => {
    installed = () => false;
    const r = await sync.importSources('o1', [offer({ source: 'notion', identifier: 'Acme', credentials: { token: 'n' } })] as never, JOINER);
    expect(r.needsConnector).toEqual(r.created);
    expect(accounts()[0].status).toBe('needs-connector');
    expect(await store.vault.load(r.created[0] as never)).toEqual({ token: 'n' });
    expect(started).toEqual([]);
    expect(isResting('needs-connector')).toBe(true);
    const acct = (await store.read.accounts())[0] as Account;
    const runs: string[] = [];
    const p = {
      store: { read: { accounts: async () => [acct] } },
      sources: { get: () => undefined },
      logSink: { log: () => undefined },
      engine: { run: (a: Account) => (runs.push(a.id), {}) },
      scheduler: { register: jest.fn() },
    } as unknown as CorePlatform;
    await resumeAccounts(p);
    expect(runs).toEqual([]);
  });

  it('installing the connector starts it', async () => {
    installed = () => false;
    const r = await sync.importSources('o1', [offer({ source: 'notion', identifier: 'Acme', credentials: { token: 'n' } })] as never, JOINER);
    const runs: string[] = [];
    const p = {
      store,
      sources: { get: (id: string) => (id === 'notion' ? { descriptor: { id } } : undefined) },
      logSink: { log: () => undefined },
      engine: { run: (a: Account) => (runs.push(`${a.id}:${a.status}`), {}) },
      scheduler: { register: jest.fn() },
    } as unknown as CorePlatform;
    await startWhenInstalled(p, 'gmail');
    expect(runs).toEqual([]);
    await startWhenInstalled(p, 'notion');
    expect(runs).toEqual([`${r.created[0]}:connecting`]);
    expect(accounts()[0].status).toBe('connecting');
  });

  it('no credentials in logs', async () => {
    await sync.importSources('o1', [offer({ credentials: { accessToken: SECRET } })] as never, JOINER);
    expect(logs.join('\n')).not.toContain(SECRET);
  });

  it('a follower or joining device refuses an offer', async () => {
    conn().prepare(`UPDATE sync_state SET joining = 1`).run();
    sync = createSyncService({
      db, store, dbPath: conn().name, workerFile: '', deviceId: () => SEED,
      encryptStrict: (s) => Buffer.from(s), keystoreAvailable: () => true, readOnly: () => true,
    });
    expect(sync.canAcceptSources()).toBe(false);
    await expect(sync.importSources('o1', [offer()] as never, JOINER)).rejects.toThrow();
  });
});

describe('what an offer reports for a connector the seed lacks', () => {
  it('names the source and identifier, and only when there is one', async () => {
    const sync = createSyncService({
      db, store, dbPath: conn().name, workerFile: '', deviceId: () => 'seedseed-9999',
      encryptStrict: (x) => Buffer.from(x), keystoreAvailable: () => true,
      isInstalled: (s) => s !== 'notion',
    });
    const entry = (source: string, identifier: string) => ({
      source, identifier, config: '{}', cadence: null, credentials: { t: 1 }, owner_device_id: null,
    });
    const r = await sync.importSources('o1', [entry('gmail', 'a@x.com'), entry('notion', 'Acme')] as never, 'abcdefgh-1');
    expect(r.needsConnector).toHaveLength(1);
    expect(r.needsConnectorSources).toEqual([{ source: 'notion', identifier: 'Acme' }]);
    const again = await sync.importSources('o1', [entry('gmail', 'a@x.com'), entry('notion', 'Acme')] as never, 'abcdefgh-1');
    expect(again.needsConnectorSources).toEqual([{ source: 'notion', identifier: 'Acme' }]);
    const none = await sync.importSources('o2', [entry('gmail', 'b@x.com')] as never, 'abcdefgh-1');
    expect(none.needsConnectorSources).toBeUndefined();
  });
});

describe('the archive a join leaves behind', () => {
  it('reports its size and deletes it', async () => {
    const sync = createSyncService({ db, store, dbPath: conn().name, workerFile: '', deviceId: () => 'x' });
    expect(readSyncStatus(conn()).archiveBytes).toBe(0);
    fs.writeFileSync(`${conn().name}.archive-20261102000000`, Buffer.alloc(1000));
    fs.writeFileSync(`${conn().name}.archive-20261102000000-wal`, Buffer.alloc(24));
    expect(readSyncStatus(conn()).archiveBytes).toBe(1024);
    await sync.deleteArchive();
    expect(readSyncStatus(conn()).archiveBytes).toBe(0);
    expect(fs.existsSync(conn().name)).toBe(true);
  });
});

describe('readOnly is read at each call', () => {
  it('a promotion needs no new wiring', async () => {
    let ro = true;
    const sync = createSyncService({
      db, store, dbPath: conn().name, workerFile: '', deviceId: () => 'seedseed-9999',
      encryptStrict: (x) => Buffer.from(x), keystoreAvailable: () => true, readOnly: () => ro,
    });
    expect(sync.canAcceptSources()).toBe(false);
    ro = false;
    expect(sync.canAcceptSources()).toBe(true);
  });
});

describe('the join journal', () => {
  const SEED = 'seedseed-9999';
  const ME = 'abcdefgh-0000-1111';
  let sync: SyncService;
  let busyReason: string | null;
  beforeEach(() => {
    busyReason = null;
    sync = createSyncService({
      db, store, dbPath: conn().name, workerFile: '',
      deviceId: () => ME,
      busy: () => busyReason,
    });
  });

  it('beginJoin sets joining and nothing else', async () => {
    await add('gmail', 'me@x.com', { t: 1 });
    await sync.beginJoin();
    expect(conn().prepare(`SELECT joining, joined, role FROM sync_state`).get()).toEqual({ joining: 1, joined: 0, role: 'normal' });
    expect(conn().prepare(`SELECT count(*) n FROM sync_moved`).get()).toEqual({ n: 0 });
    expect((await store.read.accounts())[0].status).toBe('connecting');
  });

  it('exportSources records only the moveable accounts in sync_moved', async () => {
    const g = await add('gmail', 'me@x.com', { t: 1 });
    await add('local-folder', '/p');
    const out = await sync.exportSources(SEED);
    expect(out.map((o) => o.source).sort()).toEqual(['gmail', 'local-folder']);
    expect(conn().prepare(`SELECT account_id, to_device FROM sync_moved`).all()).toEqual([{ account_id: g.id, to_device: SEED }]);
  });

  it('finishJoin deletes the moved logins, sets joined, resumes its own device-owned rows, and is safe to repeat', async () => {
    const g = await add('gmail', 'me@x.com', { t: 1 });
    const other = await add('notion', 'Other', { t: 2 });
    const mine = await add('local-folder', '/p');
    const theirs = await add('whatsapp', '49170');
    conn().prepare(`UPDATE accounts SET owner_device_id = ?, status = 'paused', last_error = 'Owned by abcdefgh' WHERE id = ?`).run(ME, mine.id);
    conn().prepare(`UPDATE accounts SET owner_device_id = 'zzzz', status = 'paused' WHERE id = ?`).run(theirs.id);
    conn().prepare(`INSERT INTO sync_moved(account_id, to_device) VALUES(?, ?)`).run(g.id, SEED);
    fs.writeFileSync(`${conn().name}.swap-outcome`, 'swapped');
    await sync.finishJoin();
    await sync.finishJoin();
    expect(await store.vault.load(g.id)).toBeNull();
    expect(await store.vault.load(other.id)).toEqual({ t: 2 });
    expect(conn().prepare(`SELECT joined, joining FROM sync_state`).get()).toEqual({ joined: 1, joining: 0 });
    const rows = Object.fromEntries((conn().prepare(`SELECT id, status, last_error FROM accounts`).all() as { id: string; status: string; last_error: string | null }[]).map((r) => [r.id, r]));
    expect(rows[mine.id]).toMatchObject({ status: 'connecting', last_error: null });
    expect(rows[theirs.id].status).toBe('paused');
    expect(fs.existsSync(`${conn().name}.swap-outcome`)).toBe(false);
  });

  it('leaveJoin drops a pending swap, clears joining, keeps sync_moved and pauses what moved', async () => {
    const g = await add('gmail', 'me@x.com', { t: 1 });
    conn().prepare(`UPDATE sync_state SET joining = 1`).run();
    conn().prepare(`INSERT INTO sync_moved(account_id, to_device) VALUES(?, ?)`).run(g.id, SEED);
    fs.writeFileSync(`${conn().name}.swap.json`, JSON.stringify({ masterDeviceId: SEED, merged: false, archive: 'x' }));
    fs.writeFileSync(`${conn().name}.swap-incoming`, 'bytes');
    await sync.leaveJoin();
    expect(conn().prepare(`SELECT joining FROM sync_state`).get()).toEqual({ joining: 0 });
    expect(conn().prepare(`SELECT status, last_error FROM accounts WHERE id = ?`).get(g.id)).toEqual({ status: 'paused', last_error: `Moved to ${SEED}` });
    expect(conn().prepare(`SELECT count(*) n FROM sync_moved`).get()).toEqual({ n: 1 });
    expect(fs.existsSync(`${conn().name}.swap-incoming`)).toBe(false);
    expect(applyPendingSwap(conn().name)).toBe('none');
  });

  it('forgetMoved clears sync_moved and lets the accounts run again', async () => {
    const g = await add('gmail', 'me@x.com', { t: 1 });
    const kept = await add('notion', 'Paused', { t: 2 });
    conn().prepare(`UPDATE accounts SET status = 'paused', last_error = 'by user' WHERE id = ?`).run(kept.id);
    conn().prepare(`INSERT INTO sync_moved(account_id, to_device) VALUES(?, ?), (?, ?)`).run(g.id, SEED, kept.id, SEED);
    conn().prepare(`UPDATE accounts SET status = 'paused', last_error = ? WHERE id = ?`).run(`Moved to ${SEED}`, g.id);
    await sync.forgetMoved();
    expect(conn().prepare(`SELECT count(*) n FROM sync_moved`).get()).toEqual({ n: 0 });
    expect(conn().prepare(`SELECT status, last_error FROM accounts WHERE id = ?`).get(g.id)).toEqual({ status: 'connecting', last_error: null });
    expect(conn().prepare(`SELECT status FROM accounts WHERE id = ?`).get(kept.id)).toEqual({ status: 'paused' });
  });

  it('isBusy names what is busy, else null', () => {
    expect(sync.isBusy()).toBeNull();
    busyReason = 'recording a meeting';
    expect(sync.isBusy()).toBe('recording a meeting');
  });
});

describe('the database size a joiner weighs its disk against', () => {
  it('is the file plus its journal, read without building anything', () => {
    const base = fs.statSync(conn().name).size;
    expect(readSyncStatus(conn()).dbBytes).toBeGreaterThanOrEqual(base);
    fs.writeFileSync(`${conn().name}-wal`, Buffer.alloc(4096));
    const withWal = readSyncStatus(conn()).dbBytes;
    expect(withWal).toBeGreaterThanOrEqual(base + 4096);
    fs.rmSync(`${conn().name}-wal`);
  });
});
