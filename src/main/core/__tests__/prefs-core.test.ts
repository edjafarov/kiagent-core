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

describe('core.* rows outside the app preferences (core.extensions)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-prefs-core-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const make = async (store: ReturnType<typeof fakeStore>) => {
    const p = createPrefs(dir, store);
    await p.ready;
    return p;
  };

  it('getCore reads the mirror; updateCore writes inside the serial chain on the leader', async () => {
    const store = fakeStore({ 'core.extensions': { a: { enabled: true } } });
    const p = await make(store);
    expect(p.getCore('core.extensions')).toEqual({ a: { enabled: true } });
    await Promise.all([
      p.updateCore('core.extensions', (c) => ({ ...(c as object), b: { enabled: false } })),
      p.updateCore('core.extensions', (c) => ({ ...(c as object), c: { enabled: true } })),
    ]);
    expect(Object.keys(store.rows['core.extensions'] as object).sort()).toEqual(['a', 'b', 'c']);
    expect(p.getCore('core.extensions')).toEqual(store.rows['core.extensions']);
  });

  it('a function returning undefined leaves the row alone', async () => {
    const store = fakeStore();
    const p = await make(store);
    await p.updateCore('core.extensions', () => undefined);
    expect('core.extensions' in store.rows).toBe(false);
  });

  it('a follower cannot write it, and the feed refreshes what it reads', async () => {
    const store = fakeStore({}, false);
    const p = await make(store);
    await expect(p.updateCore('core.extensions', () => ({}))).rejects.toThrow(/read-only/);
    store.rows['core.extensions'] = { z: { enabled: true } };
    await p.refreshUser();
    expect(p.getCore('core.extensions')).toEqual({ z: { enabled: true } });
  });

  it('does not touch the app preferences', async () => {
    const store = fakeStore();
    const p = await make(store);
    const before = p.get();
    await p.updateCore('core.extensions', () => ({ a: { enabled: true } }));
    expect(p.get()).toEqual(before);
  });
});
