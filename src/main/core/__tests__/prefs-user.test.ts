import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  createPrefs,
  DEFAULT_PREFS,
  splitPatch,
  USER_PREF_KEYS,
  type UserPrefsStore,
} from '../prefs';

function fakeStore(initial: Record<string, unknown> = {}, writable = true) {
  const rows: Record<string, unknown> = { ...initial };
  const s: UserPrefsStore & { rows: Record<string, unknown>; writable: boolean; sets: string[] } = {
    rows,
    writable,
    sets: [],
    all: async () => JSON.parse(JSON.stringify(rows)),
    set: async (k, v) => {
      s.sets.push(k);
      rows[k] = v;
    },
    canWrite: () => s.writable,
  };
  return s;
}

describe('user prefs', () => {
  let dir: string;
  const fileJson = (): Record<string, unknown> =>
    JSON.parse(fs.readFileSync(path.join(dir, 'prefs.json'), 'utf8'));
  const writeFile = (o: unknown): void =>
    fs.writeFileSync(path.join(dir, 'prefs.json'), JSON.stringify(o));
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-prefs-user-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('splitPatch separates keys exactly by USER_PREF_KEYS', () => {
    expect([...USER_PREF_KEYS]).toEqual(['outbound', 'calendar', 'features', 'theme']);
    const { user, device } = splitPatch({
      launchAtLogin: false,
      outbound: { defaultMode: 'link' },
      theme: 'dark',
      processing: { enabled: false, window: 'always' },
    });
    expect(Object.keys(user).sort()).toEqual(['outbound', 'theme']);
    expect(Object.keys(device).sort()).toEqual(['launchAtLogin', 'processing']);
  });

  it('get() returns table values for user keys and file values for device keys', async () => {
    writeFile({ launchAtLogin: false, outbound: { defaultMode: 'chat' } });
    const store = fakeStore({ 'core.outbound': { defaultMode: 'link' } }, false);
    const p = createPrefs(dir, store);
    await p.ready;
    expect(p.get().outbound.defaultMode).toBe('link');
    expect(p.get().launchAtLogin).toBe(false);
  });

  it('patch writes the device part to the file and the user part to the store', async () => {
    writeFile({ outbound: { defaultMode: 'chat' } });
    const store = fakeStore();
    const p = createPrefs(dir, store);
    await p.ready;
    await p.patch({ launchAtLogin: false, outbound: { defaultMode: 'link' } });
    expect(fileJson().launchAtLogin).toBe(false);
    expect(fileJson()).not.toHaveProperty('outbound');
    expect(store.rows['core.outbound']).toEqual({ defaultMode: 'link' });
    expect(p.get().outbound.defaultMode).toBe('link');
    expect(createPrefs(dir).get().launchAtLogin).toBe(false);
  });

  it('refreshUser fires onChange once when the store changed, never when it did not', async () => {
    const store = fakeStore();
    const p = createPrefs(dir, store);
    await p.ready;
    const seen: string[] = [];
    p.onChange((v) => seen.push(v.theme));
    await p.refreshUser();
    expect(seen).toEqual([]);
    store.rows['core.theme'] = 'dark';
    await p.refreshUser();
    await p.refreshUser();
    expect(seen).toEqual(['dark']);
    expect(p.get().theme).toBe('dark');
  });

  it('seeds a writable device once: the table gets the key, the file loses it', async () => {
    writeFile({ launchAtLogin: false, outbound: { defaultMode: 'chat' } });
    const store = fakeStore();
    const p = createPrefs(dir, store);
    await p.ready;
    expect(store.rows['core.outbound']).toEqual({ defaultMode: 'chat' });
    expect(Object.keys(store.rows)).toEqual(['core.outbound']); // defaults are not seeded
    expect(fileJson()).not.toHaveProperty('outbound');
    expect(fileJson().launchAtLogin).toBe(false);
    expect(p.get().outbound.defaultMode).toBe('chat');
    // a second boot seeds nothing
    const again = fakeStore(store.rows);
    await createPrefs(dir, again).ready;
    expect(again.sets).toEqual([]);
  });

  it('never seeds over a key the table already has', async () => {
    writeFile({ outbound: { defaultMode: 'chat' } });
    const store = fakeStore({ 'core.outbound': { defaultMode: 'link' } });
    const p = createPrefs(dir, store);
    await p.ready;
    expect(store.sets).toEqual([]);
    expect(p.get().outbound.defaultMode).toBe('link');
  });

  it('a device that cannot write never seeds; the table value (default) wins over the file', async () => {
    writeFile({ outbound: { defaultMode: 'chat' } });
    const store = fakeStore({}, false);
    const p = createPrefs(dir, store);
    await p.ready;
    expect(store.sets).toEqual([]);
    expect(fileJson().outbound).toEqual({ defaultMode: 'chat' });
    expect(p.get().outbound).toEqual(DEFAULT_PREFS.outbound);
  });

  it('a follower applies the device part first, then forwards only the user part', async () => {
    const store = fakeStore({}, false);
    const p = createPrefs(dir, store);
    await p.ready;
    const calls: Array<Partial<unknown>> = [];
    p.setForwardUser(async (u) => {
      // the device part is already on disk when the forward is sent
      expect(fileJson().launchAtLogin).toBe(false);
      calls.push(u);
    });
    await p.patch({ launchAtLogin: false, theme: 'dark' });
    expect(calls).toEqual([{ theme: 'dark' }]);
    expect(store.sets).toEqual([]);
    expect(p.get().launchAtLogin).toBe(false);
    expect(p.get().theme).toBe('system'); // changes only when the feed brings it back
  });

  it('a refused forward rejects but keeps the device part', async () => {
    const store = fakeStore({}, false);
    const p = createPrefs(dir, store);
    await p.ready;
    p.setForwardUser(async () => {
      throw new Error("Can't change this while Mac is offline");
    });
    await expect(p.patch({ launchAtLogin: false, theme: 'dark' })).rejects.toThrow(/offline/);
    expect(fileJson().launchAtLogin).toBe(false);
    expect(p.get().launchAtLogin).toBe(false);
    expect(store.sets).toEqual([]);
  });

  it('a device-only patch on a follower forwards nothing', async () => {
    const store = fakeStore({}, false);
    const p = createPrefs(dir, store);
    await p.ready;
    const fwd = jest.fn(async () => {});
    p.setForwardUser(fwd);
    await p.patch({ launchAtLogin: false });
    expect(fwd).not.toHaveBeenCalled();
  });
});
