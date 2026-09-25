/**
 * alpha-cent#192: a factory reset must report what it actually deleted. The
 * core wipe is ONE transaction that runs after every extension's data reset;
 * VACUUM and extension restarts follow it and can still fail, so neither a
 * rejection nor `ok: false` says whether the main index is gone.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { openDb } from '../db/app-db';
import { openStore } from '../core/store/store';
import { runFactoryReset } from '../factory-reset';
import type { FactoryResetDeps } from '../factory-reset';

/** A store whose resetAll announces the deletion boundary like the real one.
 *  'lost-ack' commits the deletion and rejects without announcing it, as a
 *  DB worker that dies before replying does. */
function fakeStore(
  opts: {
    wipe?: 'ok' | 'before' | 'after' | 'lost-ack';
    accounts?: number;
    /** The store stops answering once the reset settles. */
    goneAfter?: boolean;
  } = {},
) {
  const listeners = new Set<() => void>();
  const off = jest.fn();
  let accounts = Array.from({ length: opts.accounts ?? 1 }, (_, i) => ({
    id: `a${i}`,
  }));
  let settled = false;
  const store = {
    read: {
      accounts: jest.fn(async () => {
        if (settled && opts.goneAfter) throw new Error('db worker exited');
        return accounts;
      }),
    },
    onReset: jest.fn((l: () => void) => {
      listeners.add(l);
      return () => {
        off();
        listeners.delete(l);
      };
    }),
    maintenance: {
      resetAll: jest.fn(async () => {
        settled = true;
        if (opts.wipe === 'before') throw new Error('reset batch failed');
        accounts = [];
        if (opts.wipe === 'lost-ack') throw new Error('db worker exited');
        for (const l of listeners) l();
        if (opts.wipe === 'after') throw new Error('vacuum unavailable');
      }),
    },
  };
  return { store, off, wipe: () => store.maintenance.resetAll() };
}

function deps(
  over: Partial<FactoryResetDeps> & Pick<FactoryResetDeps, 'store'>,
) {
  const calls: string[] = [];
  const d: FactoryResetDeps = {
    platform: null,
    pauseSources: jest.fn(async () => {
      calls.push('pause');
    }),
    afterCoreWipe: jest.fn(async () => {
      calls.push('afterCoreWipe');
    }),
    ...over,
  };
  return { d, calls };
}

const failure = (pluginId: string) => ({
  pluginId,
  code: 'PLUGIN_RECOVERY_REQUIRED' as const,
  error: `${pluginId}: needs recovery`,
});

describe('runFactoryReset', () => {
  it('a clean reset wipes everything and clears the app state that described it', async () => {
    const { store, wipe } = fakeStore();
    const { d, calls } = deps({
      store,
      platform: {
        resetAll: async () => {
          calls.push('platform');
          await wipe();
          return { ok: true, failed: [] };
        },
      },
    });
    await expect(runFactoryReset(d)).resolves.toEqual({
      ok: true,
      coreWiped: true,
      failed: [],
      error: null,
    });
    expect(calls).toEqual(['pause', 'platform', 'afterCoreWipe']);
  });

  it('an extension that cannot be reset stops the reset before the core wipe — nothing else is cleared', async () => {
    const { store } = fakeStore();
    const { d } = deps({
      store,
      // The platform stops at the failing namespace and never wipes core.
      platform: {
        resetAll: async () => ({
          ok: false,
          failed: [failure('kiagent.documents')],
        }),
      },
    });
    await expect(runFactoryReset(d)).resolves.toEqual({
      ok: false,
      coreWiped: false,
      failed: [
        {
          pluginId: 'kiagent.documents',
          error: 'kiagent.documents: needs recovery',
        },
      ],
      error: null,
    });
    expect(d.afterCoreWipe).not.toHaveBeenCalled();
  });

  it('core wiped, then an extension did not start again: the wipe still counts', async () => {
    const { store, wipe } = fakeStore();
    const { d } = deps({
      store,
      platform: {
        resetAll: async () => {
          await wipe();
          return { ok: false, failed: [failure('kiagent.meetings')] };
        },
      },
    });
    const outcome = await runFactoryReset(d);
    expect(outcome).toMatchObject({ ok: false, coreWiped: true, error: null });
    expect(outcome.failed.map((f) => f.pluginId)).toEqual(['kiagent.meetings']);
    expect(d.afterCoreWipe).toHaveBeenCalledTimes(1);
  });

  it('core wiped, then VACUUM failed: resolves with the error instead of rejecting', async () => {
    const { store, wipe } = fakeStore({ wipe: 'after' });
    const { d } = deps({
      store,
      platform: {
        resetAll: async () => {
          await wipe();
          return { ok: true, failed: [] };
        },
      },
    });
    await expect(runFactoryReset(d)).resolves.toEqual({
      ok: false,
      coreWiped: true,
      failed: [],
      error: 'vacuum unavailable',
    });
    expect(d.afterCoreWipe).toHaveBeenCalledTimes(1);
  });

  it('a failure before the core wipe leaves the app state alone', async () => {
    const { store, wipe } = fakeStore({ wipe: 'before' });
    const { d } = deps({
      store,
      platform: {
        resetAll: async () => {
          await wipe();
          return { ok: true, failed: [] };
        },
      },
    });
    await expect(runFactoryReset(d)).resolves.toEqual({
      ok: false,
      coreWiped: false,
      failed: [],
      error: 'reset batch failed',
    });
    expect(d.afterCoreWipe).not.toHaveBeenCalled();
  });

  it('without the extension platform it wipes through the store directly', async () => {
    const { store } = fakeStore();
    const { d } = deps({ store });
    await expect(runFactoryReset(d)).resolves.toMatchObject({
      ok: true,
      coreWiped: true,
    });
    expect(store.maintenance.resetAll).toHaveBeenCalledTimes(1);
  });

  it('stops listening for the wipe once the reset settles', async () => {
    const { store, off } = fakeStore({ wipe: 'before' });
    const { d } = deps({ store });
    await runFactoryReset(d);
    expect(off).toHaveBeenCalledTimes(1);
  });

  it('a failing app-state cleanup is reported, not thrown', async () => {
    const { store } = fakeStore();
    const { d } = deps({
      store,
      afterCoreWipe: async () => {
        throw new Error('prefs write failed');
      },
    });
    await expect(runFactoryReset(d)).resolves.toEqual({
      ok: false,
      coreWiped: true,
      failed: [],
      error: 'prefs write failed',
    });
  });

  describe('a deletion that committed without saying so', () => {
    it('is found by asking the store, and counts as wiped', async () => {
      const { store } = fakeStore({ wipe: 'lost-ack' });
      const { d } = deps({ store });
      await expect(runFactoryReset(d)).resolves.toEqual({
        ok: false,
        coreWiped: true,
        failed: [],
        error: 'db worker exited',
      });
      expect(d.afterCoreWipe).toHaveBeenCalledTimes(1);
    });

    it('is unknown when the store no longer answers — nothing is cleared', async () => {
      const { store } = fakeStore({ wipe: 'lost-ack', goneAfter: true });
      const { d } = deps({ store });
      await expect(runFactoryReset(d)).resolves.toEqual({
        ok: false,
        coreWiped: null,
        failed: [],
        error: 'db worker exited',
      });
      expect(d.afterCoreWipe).not.toHaveBeenCalled();
    });

    it('is unknown when there were no accounts to go by', async () => {
      const { store } = fakeStore({ wipe: 'before', accounts: 0 });
      const { d } = deps({ store });
      await expect(runFactoryReset(d)).resolves.toMatchObject({
        ok: false,
        coreWiped: null,
      });
      expect(d.afterCoreWipe).not.toHaveBeenCalled();
    });
  });

  describe('against the real store', () => {
    let dir: string;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-factory-reset-'));
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('a VACUUM failure after the wipe is reported as wiped', async () => {
      const db = await openDb(path.join(dir, 'test.db'));
      const store = openStore(db, {
        encrypt: (s: string) => Buffer.from(s, 'utf8'),
        decrypt: (b: Buffer) => b.toString('utf8'),
        detectLanguages: () => [],
      });
      await store.createAccount({ source: 'test', identifier: 'me@x.com' });
      const exec = jest.spyOn(db, 'exec').mockImplementation(async (sql) => {
        if (sql === 'VACUUM') throw new Error('vacuum unavailable');
      });
      try {
        const outcome = await runFactoryReset({
          store,
          platform: null,
          pauseSources: async () => {},
          afterCoreWipe: async () => {},
        });
        expect(outcome).toEqual({
          ok: false,
          coreWiped: true,
          failed: [],
          error: 'vacuum unavailable',
        });
        expect(await store.read.accounts()).toEqual([]);
      } finally {
        exec.mockRestore();
        await store.close();
      }
    });

    it('a worker that dies after committing the wipe is reported as wiped', async () => {
      const db = await openDb(path.join(dir, 'test.db'));
      const store = openStore(db, {
        encrypt: (s: string) => Buffer.from(s, 'utf8'),
        decrypt: (b: Buffer) => b.toString('utf8'),
        detectLanguages: () => [],
      });
      await store.createAccount({ source: 'test', identifier: 'me@x.com' });
      const realBatch = db.batch.bind(db);
      const batch = jest.spyOn(db, 'batch').mockImplementation(async (ops) => {
        const committed = await realBatch(ops);
        if (ops.some((op) => op.sql === 'DELETE FROM accounts'))
          throw new Error('db worker exited');
        return committed;
      });
      const afterCoreWipe = jest.fn(async () => {});
      try {
        const outcome = await runFactoryReset({
          store,
          platform: null,
          pauseSources: async () => {},
          afterCoreWipe,
        });
        expect(outcome).toEqual({
          ok: false,
          coreWiped: true,
          failed: [],
          error: 'db worker exited',
        });
        expect(afterCoreWipe).toHaveBeenCalledTimes(1);
      } finally {
        batch.mockRestore();
        await store.close();
      }
    });
  });
});
