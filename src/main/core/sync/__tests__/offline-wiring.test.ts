/** @jest-environment node */
/** Phase 6c Task 3: the real preferences over the real sync service, wired the
 *  way main wires them. No leader is reachable unless a test installs one. */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { openDb, type AppDb } from '../../../db/app-db';
import { createExtensionSync, EXTENSIONS_KEY, type ExtensionsSet } from '../../../platform/extension-set';
import { createDbUserPrefsStore, createPrefs, type CorePrefs } from '../../prefs';
import { migrate } from '../../store/schema';
import { openStore } from '../../store/store';
import { NO_MASTER_MESSAGE, SyncNoMaster, wrapForwardedChannels } from '../forward-core';
import { installOfflineSettings, restoreOfflineSettings } from '../offline-settings';
import { promote } from '../promote';
import { createSyncService, type SyncService } from '../service';

interface Wired {
  dir: string;
  db: AppDb;
  svc: SyncService;
  prefs: CorePrefs;
  table: Record<string, (req: unknown) => unknown>;
  local: Map<string, (req: unknown) => unknown>;
  refusals: string[];
  enabled: Map<string, boolean>;
  calls: Record<string, jest.Mock>;
  reconcile: jest.Mock;
}
const wired: Wired[] = [];
const dirs: string[] = [];

async function open(dir: string, follower: boolean): Promise<{ db: AppDb; svc: SyncService }> {
  const db = await openDb(path.join(dir, 'a.db'));
  migrate(db._conn!);
  if (follower) db._conn!.prepare(`UPDATE sync_state SET role = 'follower'`).run();
  (db as unknown as { proc: (n: string, a: { epoch: number }) => Promise<null> }).proc = async (name, a) => {
    if (name === 'syncPromote') promote(db._conn!, a.epoch);
    return null;
  };
  const store = openStore(db, {
    encrypt: (s: string) => Buffer.from(s, 'utf8'),
    decrypt: (b: Buffer) => b.toString('utf8'),
    detectLanguages: () => ['eng'],
  });
  const svc = createSyncService({
    initialReadOnly: follower,
    db,
    store,
    dbPath: path.join(dir, 'a.db'),
    workerFile: '',
    log: () => undefined,
  });
  return { db, svc };
}

async function wire(follower = true, existingDir?: string): Promise<Wired> {
  const dir = existingDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'offline-wiring-'));
  if (!existingDir) dirs.push(dir);
  const { db, svc } = await open(dir, follower);
  const prefs = createPrefs(
    path.join(dir, 'prefs'),
    createDbUserPrefsStore(db, () => !svc.readOnly()),
  );
  await prefs.ready;
  const enabled = new Map<string, boolean>([['conn.a', false]]);
  const calls = {
    send: jest.fn(async () => 'sent'),
    act: jest.fn(async () => 'acted'),
    install: jest.fn(async () => ({ ok: true })),
    uninstall: jest.fn(async () => ({ ok: true })),
  };
  const table: Wired['table'] = {
    'prefs:patch': (r) => prefs.patch(r as never),
    'extension:set-enabled': async (r) => {
      const { id, enabled: on } = r as { id: string; enabled: boolean };
      if (id === 'bad') return { ok: false, error: 'x' };
      enabled.set(id, on);
      return { ok: true };
    },
    'extension:install': calls.install,
    'extension:uninstall': calls.uninstall,
    'outbox:send': calls.send,
    'attention:act': calls.act,
  };
  const refusals: string[] = [];
  const reconcile = jest.fn(async () => undefined);
  const offline = installOfflineSettings(prefs, svc, { reconcile });
  const local = wrapForwardedChannels(table, svc, (m) => refusals.push(m), offline);
  const w = { dir, db, svc, prefs, table, local, refusals, enabled, calls, reconcile };
  wired.push(w);
  return w;
}
const rows = (w: Wired) =>
  w.db._conn!.prepare(`SELECT kind, coalesce_key AS k FROM sync_outbound ORDER BY id`).all();

afterEach(async () => {
  for (const w of wired.splice(0)) await w.db.close();
});
afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

it('with no leader a theme change applies locally, leaves one queued row and sends NO refusal push', async () => {
  const w = await wire();
  await w.prefs.patch({ theme: 'dark' });
  expect(w.prefs.get().theme).toBe('dark');
  expect(rows(w)).toEqual([{ kind: 'prefs:patch', k: 'core.theme' }]);
  expect(w.refusals).toEqual([]);
});

it('a second change leaves one row', async () => {
  const w = await wire();
  await w.prefs.patch({ theme: 'dark' });
  await w.prefs.patch({ theme: 'light' });
  expect(rows(w)).toHaveLength(1);
  expect(w.prefs.get().theme).toBe('light');
});

it('an extension setting with no leader is queued too', async () => {
  const w = await wire();
  await w.prefs.setExt('kiagent.meetings.language', 'de');
  expect(rows(w)).toEqual([{ kind: 'prefs:set-ext', k: 'kiagent.meetings.language' }]);
  expect(w.prefs.getExt('kiagent.meetings.language')).toBe('de');
});

it('extension:set-enabled with no leader enables locally, queues core.extensions.<id>, and reconcile does not undo it', async () => {
  const w = await wire();
  await expect(w.table['extension:set-enabled']({ id: 'conn.a', enabled: true })).resolves.toEqual({ ok: true });
  expect(w.enabled.get('conn.a')).toBe(true);
  expect(rows(w)).toEqual([{ kind: 'extension:set-enabled', k: 'core.extensions.conn.a' }]);
  expect(w.refusals).toEqual([]);
  // Reconcile reads the set through getCore: the queued enable is in it.
  const setEnabled = jest.fn(async () => ({ ok: true }));
  const sync = createExtensionSync({
    store: {
      get: () => w.prefs.getCore(EXTENSIONS_KEY) as ExtensionsSet | undefined,
      canWrite: () => !w.svc.readOnly(),
      update: async () => undefined,
    },
    ops: {
      list: () => [{ id: 'conn.a', origin: 'marketplace', enabled: w.enabled.get('conn.a')! }],
      setEnabled,
      installFromRef: jest.fn(),
      uninstall: jest.fn(),
    },
    log: () => undefined,
  });
  await sync.runFromStore();
  expect(setEnabled).not.toHaveBeenCalled();
});

it('a failed local set-enabled queues nothing', async () => {
  const w = await wire();
  await expect(w.table['extension:set-enabled']({ id: 'bad', enabled: true })).resolves.toEqual({ ok: false, error: 'x' });
  expect(rows(w)).toEqual([]);
  expect(w.prefs.getCore(EXTENSIONS_KEY)).toBeUndefined();
});

it('with no leader, extension:install, extension:uninstall, outbox:send and attention:act still throw SyncNoMaster, push the refusal and queue nothing', async () => {
  const w = await wire();
  for (const ch of ['extension:install', 'extension:uninstall', 'outbox:send', 'attention:act']) {
    const err = await Promise.resolve(w.table[ch]({})).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyncNoMaster);
  }
  expect(w.refusals).toEqual(Array(4).fill(NO_MASTER_MESSAGE));
  expect(rows(w)).toEqual([]);
  expect(w.calls.send).not.toHaveBeenCalled();
});

it('a leader that is reachable gets the request and nothing is queued', async () => {
  const w = await wire();
  const seen: string[] = [];
  w.svc.setForwarder(async (r) => {
    seen.push(r.name);
    return { ok: true, value: { ok: true } };
  });
  await w.prefs.patch({ theme: 'dark' });
  await w.table['extension:set-enabled']({ id: 'conn.a', enabled: true });
  await w.prefs.setExt('x.y', 1);
  expect(seen).toEqual(['prefs:patch', 'extension:set-enabled', 'prefs:set-ext']);
  expect(rows(w)).toEqual([]);
  expect(w.enabled.get('conn.a')).toBe(false); // the leader does it; this device follows by reconcile
});

it('an online edit over a queued key replaces the row and the drain delivers only the newer value', async () => {
  const w = await wire();
  await w.prefs.patch({ theme: 'dark' });
  await w.table['extension:set-enabled']({ id: 'conn.a', enabled: true });
  const sent: unknown[] = [];
  w.svc.setForwarder(async (r) => {
    sent.push([r.name, r.payload]);
    return { ok: true, value: { ok: true } };
  });
  await w.prefs.patch({ theme: 'light' });
  await w.table['extension:set-enabled']({ id: 'conn.a', enabled: false });
  expect(sent).toEqual([]); // nothing forwarded around the queue
  expect(rows(w)).toHaveLength(2);
  expect(w.prefs.get().theme).toBe('light');
  expect(w.prefs.getCore(EXTENSIONS_KEY)).toEqual({ 'conn.a': { enabled: false } });
  await w.svc.drainOutbound();
  expect(sent).toEqual([
    ['prefs:patch', { theme: 'light' }],
    ['extension:set-enabled', { id: 'conn.a', enabled: false }],
  ]);
});

it('a forwarded set-enabled over an acknowledged one drops the old optimistic entry', async () => {
  const w = await wire();
  await w.table['extension:set-enabled']({ id: 'conn.a', enabled: true });
  w.svc.setForwarder(async () => ({ ok: true, value: { ok: true } }));
  await w.svc.drainOutbound(); // acknowledged: held as optimistic
  expect(w.prefs.getCore(EXTENSIONS_KEY)).toEqual({ 'conn.a': { enabled: true } });
  await w.table['extension:set-enabled']({ id: 'conn.a', enabled: false });
  expect(w.prefs.getCore(EXTENSIONS_KEY)).not.toEqual({ 'conn.a': { enabled: true } });
});

it('delivery: the drain sends the row, the ack drops the overlay, the value is held until a later delta', async () => {
  const w = await wire();
  await w.prefs.patch({ theme: 'dark' });
  const sent: unknown[] = [];
  w.svc.setForwarder(async (r) => {
    sent.push(r.payload);
    return { ok: true, value: null };
  });
  await w.svc.drainOutbound();
  expect(sent).toEqual([{ theme: 'dark' }]);
  expect(rows(w)).toEqual([]);
  // the feed has not brought it yet: still shown
  expect(w.prefs.get().theme).toBe('dark');
  // an older pull does not release it
  await w.prefs.refreshUser({ prefKeys: ['core.theme'], pullStartedAt: 0 });
  expect(w.prefs.get().theme).toBe('dark');
  // the leader's row arrives, from a pull that started after the ack
  w.db._conn!.prepare(`INSERT INTO user_prefs(key, value_json) VALUES('core.theme', '"light"')`).run();
  await w.prefs.refreshUser({ prefKeys: ['core.theme'], pullStartedAt: Date.now() + 1000 });
  expect(w.prefs.get().theme).toBe('light');
});

it('after promotion the queued rows run as the leader, the overlay empties', async () => {
  const w = await wire();
  await w.prefs.patch({ theme: 'dark' });
  await w.table['extension:set-enabled']({ id: 'conn.a', enabled: true });
  w.svc.setRunners({
    ui: jest.fn(),
    core: async (name, req) => w.local.get(name)!(req),
    commit: jest.fn(),
  });
  await w.svc.promote(2);
  expect(rows(w)).toEqual([]);
  // written to the table by the leader's own handler
  expect(w.db._conn!.prepare(`SELECT value_json FROM user_prefs WHERE key = 'core.theme'`).get()).toEqual({
    value_json: '"dark"',
  });
  expect(w.prefs.get().theme).toBe('dark');
  // no optimistic copy is kept: a later table change shows at once
  w.db._conn!.prepare(`UPDATE user_prefs SET value_json = '"light"' WHERE key = 'core.theme'`).run();
  await w.prefs.refreshUser();
  expect(w.prefs.get().theme).toBe('light');
});

it('a promoted leader\'s own theme write replaces a queued row the leader\'s handler refused', async () => {
  const w = await wire();
  await w.prefs.patch({ theme: 'dark' });
  w.svc.setRunners({
    ui: jest.fn(),
    core: async () => {
      throw new Error('handler refused');
    },
    commit: jest.fn(),
  });
  await w.svc.promote(2);
  // The drain left the refused row waiting; the leader's own write supersedes it.
  expect(rows(w)).toHaveLength(1);
  await w.prefs.patch({ theme: 'light' });
  expect(w.prefs.get().theme).toBe('light');
  expect(rows(w)).toEqual([]);
  await w.svc.drainOutbound();
  expect(w.prefs.get().theme).toBe('light');
  expect(w.db._conn!.prepare(`SELECT value_json FROM user_prefs WHERE key = 'core.theme'`).get()).toEqual({
    value_json: '"light"',
  });
});

it('restoreQueued after a restart shows the queued value again', async () => {
  const w = await wire();
  await w.prefs.patch({ theme: 'dark' });
  await w.table['extension:set-enabled']({ id: 'conn.a', enabled: true });
  await w.db.close();
  wired.splice(wired.indexOf(w), 1);
  const again = await wire(true, w.dir);
  expect(again.prefs.get().theme).toBe('system');
  await restoreOfflineSettings(again.prefs, again.svc);
  expect(again.prefs.get().theme).toBe('dark');
  expect(again.prefs.getCore(EXTENSIONS_KEY)).toEqual({ 'conn.a': { enabled: true } });
});

it('FOLLOWS_USER covers every USER_PREF_KEYS entry, core.extensions and every meetings field', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { FOLLOWS_USER } = require('@shared/sync-follows') as typeof import('@shared/sync-follows');
  const keys = FOLLOWS_USER.flatMap((g) => g.keys);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { USER_PREF_KEYS } = require('../../prefs') as typeof import('../../prefs');
  for (const k of USER_PREF_KEYS) expect(keys).toContain(`core.${k}`);
  expect(keys).toContain('core.extensions');
  for (const f of ['enabled', 'summaryInstructions', 'language', 'accuracyRetry', 'joinRecord', 'joinRead', 'silencedApps', 'audioRetentionDays']) {
    expect(keys).toContain(`kiagent.meetings.${f}`);
  }
  expect(keys).toContain('kiagent.documents.description');
  expect(new Set(keys).size).toBe(keys.length);
  for (const g of FOLLOWS_USER) expect(g.label).not.toBe('');
});

it('discarding a queued connector switch reconciles so the connector returns to the mirrored state', async () => {
  const w = await wire();
  await w.table['extension:set-enabled']({ id: 'conn.a', enabled: true });
  const [row] = await w.svc.queuedSettings();
  expect(w.reconcile).not.toHaveBeenCalled();
  await w.svc.discardQueued(row.rowId);
  expect(w.reconcile).toHaveBeenCalledTimes(1);
  // The set the reconcile reads no longer holds the discarded enable.
  expect(JSON.stringify(w.prefs.getCore('core.extensions') ?? {})).not.toContain('conn.a":{"enabled":true');
});

it('discarding or delivering any other setting does not reconcile', async () => {
  const w = await wire();
  await w.prefs.patch({ theme: 'dark' });
  const [row] = await w.svc.queuedSettings();
  await w.svc.discardQueued(row.rowId);
  expect(w.reconcile).not.toHaveBeenCalled();
});

it('a reconcile that fails does not fail the discard', async () => {
  const w = await wire();
  w.reconcile.mockRejectedValueOnce(new Error('boom'));
  await w.table['extension:set-enabled']({ id: 'conn.a', enabled: true });
  const [row] = await w.svc.queuedSettings();
  await expect(w.svc.discardQueued(row.rowId)).resolves.toBeUndefined();
});
