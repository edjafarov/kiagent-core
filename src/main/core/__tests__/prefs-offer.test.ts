import fs from 'fs';
import os from 'os';
import path from 'path';

import { createPrefs, type UserPrefsStore } from '../prefs';

function fakeStore(initial: Record<string, unknown> = {}, writable = true) {
  const rows: Record<string, unknown> = { ...initial };
  const s: UserPrefsStore & { rows: Record<string, unknown>; writable: boolean } = {
    rows,
    writable,
    all: async () => JSON.parse(JSON.stringify(rows)),
    set: async (k, v) => {
      rows[k] = v;
    },
    canWrite: () => s.writable,
  };
  return s;
}

describe('a join offer carries user settings (spec 7.9 rule 6)', () => {
  let dir: string;
  const writeFile = (o: unknown): void =>
    fs.writeFileSync(path.join(dir, 'prefs.json'), JSON.stringify(o));
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-prefs-offer-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('offerable lists table keys and extension keys, never device keys or the extension set', async () => {
    writeFile({ launchAtLogin: false, processing: { enabled: false, window: 'always' } });
    const store = fakeStore(
      {
        'core.theme': 'dark',
        'kiagent.meetings.summaryInstructions': 'X',
        'core.extensions': { a: { enabled: true } },
      },
      false,
    );
    const p = createPrefs(dir, store);
    await p.ready;
    expect(await p.offerable()).toEqual({
      'core.theme': 'dark',
      'kiagent.meetings.summaryInstructions': 'X',
    });
  });

  it('offerable includes a user key still in prefs.json that no seed has moved', async () => {
    writeFile({ outbound: { defaultMode: 'chat' }, theme: 'system' });
    const store = fakeStore({}, false); // a joiner can't write, so it never seeded
    const p = createPrefs(dir, store);
    await p.ready;
    expect(await p.offerable()).toEqual({ 'core.outbound': { defaultMode: 'chat' } });
  });

  it('addMissing writes only keys the table lacks and returns them', async () => {
    const store = fakeStore({
      'core.theme': 'light',
      'kiagent.meetings.language': 'de',
    });
    const p = createPrefs(dir, store);
    await p.ready;
    const added = await p.addMissing({
      'core.theme': 'dark',
      'kiagent.meetings.language': 'en',
      'kiagent.meetings.summaryInstructions': 'X',
    });
    expect(added).toEqual(['kiagent.meetings.summaryInstructions']);
    expect(store.rows['core.theme']).toBe('light');
    expect(store.rows['kiagent.meetings.language']).toBe('de');
    expect(store.rows['kiagent.meetings.summaryInstructions']).toBe('X');
    expect(p.get().theme).toBe('light');
    expect(await p.addMissing({ 'kiagent.meetings.summaryInstructions': 'Y' })).toEqual([]);
  });

  it('addMissing refuses what is not a user setting and rejects bad values', async () => {
    const store = fakeStore();
    const p = createPrefs(dir, store);
    await p.ready;
    const added = await p.addMissing({
      'core.extensions': { x: { enabled: true } },
      'core.launchAtLogin': false,
      'core.theme': 'dark',
      '': 1,
      'ext.fn': (() => 1) as unknown,
    });
    expect(added).toEqual(['core.theme']);
    expect(Object.keys(store.rows)).toEqual(['core.theme']);
    expect(p.get().theme).toBe('dark');
  });

  it('addMissing applies a master file value first: master wins over an unseeded file key', async () => {
    writeFile({ theme: 'light' });
    const store = fakeStore();
    const p = createPrefs(dir, store);
    await p.ready; // seeded: core.theme = light
    await p.addMissing({ 'core.theme': 'dark' });
    expect(store.rows['core.theme']).toBe('light');
  });

  it('addMissing fires the extension and app listeners for what it adds', async () => {
    const store = fakeStore();
    const p = createPrefs(dir, store);
    await p.ready;
    const ext: string[] = [];
    p.onExtChange((k) => ext.push(k));
    let changes = 0;
    p.onChange(() => (changes += 1));
    await p.addMissing({ 'a.b': 1, 'core.theme': 'dark' });
    expect(ext).toEqual(['a.b']);
    expect(changes).toBe(1);
  });

  it('addMissing rejects on a device that can not write the table', async () => {
    const p = createPrefs(dir, fakeStore({}, false));
    await p.ready;
    await expect(p.addMissing({ 'a.b': 1 })).rejects.toThrow(/read-only/);
  });
});
