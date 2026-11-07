/** @jest-environment node */
/** Phase 6c Task 1: the vocabulary of the offline settings queue. */
import Database from 'better-sqlite3';

import { USER_PREF_KEYS } from '../../prefs';
import { migrate } from '../../store/schema';
import {
  extensionEnabledKey,
  extensionEnabledRequest,
  extPrefRequest,
  QUEUEABLE_CHANNELS,
  queuedValueOf,
  REFUSED_WHEN_OFFLINE,
  userPrefKey,
  userPrefRequest,
} from '../settings-queue';

it('the queueable channels are exactly the three settings channels (REFUSED_WHEN_OFFLINE is derived from the rest)', () => {
  expect([...QUEUEABLE_CHANNELS].sort()).toEqual(['extension:set-enabled', 'prefs:patch', 'prefs:set-ext']);
});

it('every USER_PREF_KEYS entry has a request whose payload is { [key]: value } and the key core.<key>', () => {
  for (const k of USER_PREF_KEYS) {
    expect(userPrefKey(k)).toBe(`core.${k}`);
    expect(userPrefRequest(k, { x: 1 })).toEqual({
      kind: 'core',
      name: 'prefs:patch',
      payload: { [k]: { x: 1 } },
    });
  }
});

it('queuedValueOf reads the value out of each of the three request shapes and returns undefined for a malformed one', () => {
  expect(queuedValueOf('core.theme', userPrefRequest('theme', 'dark'))).toBe('dark');
  expect(queuedValueOf('kiagent.meetings.language', extPrefRequest('kiagent.meetings.language', { a: 1 }))).toEqual({ a: 1 });
  expect(extensionEnabledKey('a.b')).toBe('core.extensions.a.b');
  expect(queuedValueOf('core.extensions.a.b', extensionEnabledRequest('a.b', false))).toBe(false);
  // malformed
  expect(queuedValueOf('core.theme', { kind: 'core', name: 'prefs:patch', payload: null })).toBeUndefined();
  expect(queuedValueOf('core.theme', { kind: 'core', name: 'prefs:patch', payload: { outbound: 1 } })).toBeUndefined();
  expect(queuedValueOf('k.x', { kind: 'core', name: 'prefs:set-ext', payload: { key: 'other', value: 1 } })).toBeUndefined();
  expect(queuedValueOf('core.extensions.a', { kind: 'core', name: 'extension:set-enabled', payload: { id: 'a', enabled: 'yes' } })).toBeUndefined();
  expect(queuedValueOf('core.extensions.a', { kind: 'core', name: 'attention:act', payload: {} })).toBeUndefined();
});

describe('schema v22', () => {
  it('an existing v21 database gains coalesce_key and the unique index without losing rows', () => {
    const db = new Database(':memory:');
    migrate(db);
    db.prepare(`INSERT INTO sync_outbound(kind, payload, created_at) VALUES('x', x'00', 't')`).run();
    db.exec(`DROP INDEX sync_outbound_coalesce; ALTER TABLE sync_outbound DROP COLUMN coalesce_key`);
    db.prepare(`UPDATE meta SET value='21' WHERE key='schemaVersion'`).run();
    migrate(db);
    expect(db.prepare(`SELECT kind, coalesce_key FROM sync_outbound`).all()).toEqual([{ kind: 'x', coalesce_key: null }]);
    const ins = db.prepare(`INSERT INTO sync_outbound(kind, payload, created_at, coalesce_key) VALUES('y', x'00', 't', ?)`);
    ins.run('k');
    expect(() => ins.run('k')).toThrow(/UNIQUE/);
    // many unkeyed rows are fine
    db.prepare(`INSERT INTO sync_outbound(kind, payload, created_at) VALUES('z', x'00', 't')`).run();
    db.close();
  });
});
