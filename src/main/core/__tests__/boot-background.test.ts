/** @jest-environment node */
import type {
  Account,
  AccountId,
  ExtensionSnapshot,
  ExtensionStatus,
} from '@shared/contracts';

import {
  createBootQueue,
  startBackground,
  type BootQueueDeps,
} from '../boot-background';

function account(
  id: string,
  source: string,
  status: Account['status'] = 'live',
): Account {
  return {
    id: id as AccountId,
    source,
    identifier: `${id}@example.com`,
    config: {},
    status,
    cursor: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function ext(
  id: string,
  sourceIds: string[],
  status: ExtensionStatus = 'activating',
  enabled = true,
): ExtensionSnapshot {
  return {
    id,
    name: id,
    version: '1.0.0',
    origin: 'marketplace',
    enabled,
    status,
    caps: [],
    sourceIds,
    oauthSources: [],
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function harness(accounts: Account[]) {
  const db = new Map(accounts.map((a) => [a.id as string, a]));
  const registered = new Set<string>();
  const listeners = new Set<(id: string) => void>();
  const runs: string[] = [];
  const logs: string[] = [];
  const deps: BootQueueDeps = {
    readAccount: async (id) => db.get(id) ?? null,
    isRegistered: (sid) => registered.has(sid),
    onRegister: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    runAccount: (a) => runs.push(a.id),
    log: (_level, msg) => logs.push(msg),
  };
  const register = (sid: string) => {
    registered.add(sid);
    [...listeners].forEach((cb) => cb(sid));
  };
  return { deps, db, register, runs, logs, listeners };
}

describe('createBootQueue', () => {
  it('a late source resumes its queued accounts exactly once', async () => {
    const h = harness([account('a1', 'notion'), account('a2', 'notion')]);
    const q = createBootQueue(h.deps);
    q.arm([ext('kia.notion', ['notion'])]);
    expect(q.defer(account('a1', 'notion'))).toBe(true);
    expect(q.defer(account('a2', 'notion'))).toBe(true);
    expect(h.runs).toEqual([]);
    h.register('notion');
    await flush();
    expect(h.runs).toEqual(['a1', 'a2']);
  });

  it('a re-registration after drain dispatches nothing (crash respawn)', async () => {
    const h = harness([account('a1', 'notion')]);
    const q = createBootQueue(h.deps);
    q.arm([ext('kia.notion', ['notion'])]);
    q.defer(account('a1', 'notion'));
    h.register('notion');
    await flush();
    h.register('notion');
    await flush();
    expect(h.runs).toEqual(['a1']);
    expect(h.listeners.size).toBe(0); // nothing pending: unsubscribed
  });

  it('a removed or paused account is not resumed', async () => {
    const h = harness([account('a1', 'notion'), account('a2', 'notion')]);
    const q = createBootQueue(h.deps);
    q.arm([ext('kia.notion', ['notion'])]);
    q.defer(account('a1', 'notion'));
    q.defer(account('a2', 'notion'));
    h.db.delete('a1'); // removed while queued
    h.db.set('a2', account('a2', 'notion', 'paused')); // paused while queued
    h.register('notion');
    await flush();
    expect(h.runs).toEqual([]);
  });

  it('a slow extension delays only its own accounts', async () => {
    const h = harness([account('a1', 'notion'), account('b1', 'hubspot')]);
    const q = createBootQueue(h.deps);
    q.arm([ext('kia.notion', ['notion']), ext('kia.hubspot', ['hubspot'])]);
    q.defer(account('a1', 'notion'));
    q.defer(account('b1', 'hubspot'));
    h.register('hubspot'); // notion never registers
    await flush();
    expect(h.runs).toEqual(['b1']);
  });

  it('only declared, enabled, non-errored, unregistered sources are boot-pending', () => {
    const h = harness([]);
    h.register('gmail');
    const q = createBootQueue(h.deps);
    q.arm([
      ext('kia.a', ['a']),
      ext('kia.b', ['b'], 'errored'),
      ext('kia.c', ['c'], 'disabled', false),
      ext('bundled', ['gmail']),
    ]);
    expect(q.defer(account('x', 'a'))).toBe(true);
    expect(q.defer(account('x', 'b'))).toBe(false);
    expect(q.defer(account('x', 'c'))).toBe(false);
    expect(q.defer(account('x', 'gmail'))).toBe(false);
    expect(q.defer(account('x', 'nobody'))).toBe(false);
  });

  it('runOrQueue runs a registered or non-pending source now, writing nothing to the queue', () => {
    const h = harness([]);
    h.register('gmail');
    const q = createBootQueue(h.deps);
    q.arm([ext('kia.notion', ['notion'])]);
    q.runOrQueue(account('g', 'gmail'), 'explicit');
    q.runOrQueue(account('o', 'other'), 'explicit');
    expect(h.runs).toEqual(['g', 'o']);
  });

  it('sync-now on a boot-pending account starts nothing yet, so no "no source registered" error is written', () => {
    const h = harness([account('a1', 'notion')]);
    const q = createBootQueue(h.deps);
    q.arm([ext('kia.notion', ['notion'])]);
    q.runOrQueue(account('a1', 'notion'), 'explicit');
    expect(h.runs).toEqual([]); // runAccount → engine.run is what logs the error
  });

  it('a manual Retry on a needsReauth boot-pending account runs on registration', async () => {
    const h = harness([account('a1', 'notion', 'needsReauth')]);
    const q = createBootQueue(h.deps);
    q.arm([ext('kia.notion', ['notion'])]);
    q.runOrQueue(account('a1', 'notion', 'needsReauth'), 'explicit');
    h.register('notion');
    await flush();
    expect(h.runs).toEqual(['a1']);
  });

  it('an auto entry for a needsReauth account is dropped on registration', async () => {
    const h = harness([account('a1', 'notion')]);
    const q = createBootQueue(h.deps);
    q.arm([ext('kia.notion', ['notion'])]);
    q.defer(account('a1', 'notion'));
    h.db.set('a1', account('a1', 'notion', 'needsReauth'));
    h.register('notion');
    await flush();
    expect(h.runs).toEqual([]);
  });

  it('Resume of a paused account before registration runs it on registration', async () => {
    // accounts:resume has already committed 'connecting' via engine.resume.
    const h = harness([account('a1', 'notion', 'connecting')]);
    const q = createBootQueue(h.deps);
    q.arm([ext('kia.notion', ['notion'])]);
    q.runOrQueue(account('a1', 'notion', 'connecting'), 'explicit');
    h.register('notion');
    await flush();
    expect(h.runs).toEqual(['a1']);
  });

  it('tray Sync now queues boot-pending accounts as explicit and leaves the rest to cadence', async () => {
    const h = harness([
      account('a1', 'notion', 'needsReauth'),
      account('a2', 'notion', 'paused'),
      account('g1', 'gmail'),
    ]);
    h.register('gmail');
    const q = createBootQueue(h.deps);
    q.arm([ext('kia.notion', ['notion'])]);
    q.syncPending([
      account('a1', 'notion', 'needsReauth'),
      account('a2', 'notion', 'paused'),
      account('g1', 'gmail'),
      account('w', 'worker'),
    ]);
    expect(h.runs).toEqual([]); // gmail is the cadence job's, notion waits
    h.register('notion');
    await flush();
    expect(h.runs).toEqual(['a1']); // explicit: needsReauth retried; paused never
  });

  it('an explicit entry upgrades an auto one and is never downgraded', async () => {
    const h = harness([account('a1', 'notion', 'needsReauth')]);
    const q = createBootQueue(h.deps);
    q.arm([ext('kia.notion', ['notion'])]);
    q.runOrQueue(account('a1', 'notion', 'needsReauth'), 'explicit');
    expect(q.defer(account('a1', 'notion', 'needsReauth'))).toBe(true); // auto after explicit
    h.register('notion');
    await flush();
    expect(h.runs).toEqual(['a1']); // still explicit: needsReauth allowed
  });

  it.each([
    ['errored', ext('kia.notion', ['notion'], 'errored')],
    ['disabled', ext('kia.notion', ['notion'], 'disabled', false)],
  ])(
    'an entry %s before registering releases its queued accounts (auto and explicit) through runAccount',
    async (_why, after) => {
      const h = harness([account('a1', 'notion'), account('a2', 'notion')]);
      const q = createBootQueue(h.deps);
      q.arm([ext('kia.notion', ['notion'])]);
      q.defer(account('a1', 'notion'));
      q.runOrQueue(account('a2', 'notion'), 'explicit');
      q.onSnapshot([after]);
      await flush();
      expect(h.runs).toEqual(['a1', 'a2']);
      q.onSnapshot([after]); // released once
      await flush();
      expect(h.runs).toEqual(['a1', 'a2']);
    },
  );

  it('an uninstalled entry (absent from the snapshot) releases its accounts', async () => {
    const h = harness([account('a1', 'notion')]);
    const q = createBootQueue(h.deps);
    q.arm([ext('kia.notion', ['notion'])]);
    q.defer(account('a1', 'notion'));
    q.onSnapshot([]);
    await flush();
    expect(h.runs).toEqual(['a1']);
  });

  it('transient disabled does not release (enabled entry deactivated by a worker respawn or Reset all)', async () => {
    const h = harness([account('a1', 'notion')]);
    const q = createBootQueue(h.deps);
    q.arm([ext('kia.notion', ['notion'])]);
    q.defer(account('a1', 'notion'));
    q.onSnapshot([ext('kia.notion', ['notion'], 'disabled', true)]);
    await flush();
    expect(h.runs).toEqual([]);
  });

  it('needs-consent keeps the queue, silently', async () => {
    const h = harness([account('a1', 'notion')]);
    const q = createBootQueue(h.deps);
    q.arm([ext('kia.notion', ['notion'])]);
    q.defer(account('a1', 'notion'));
    q.onSnapshot([ext('kia.notion', ['notion'], 'needs-consent')]);
    await flush();
    expect(h.runs).toEqual([]);
    expect(h.logs).toEqual([]);
    h.register('notion'); // consent granted later → source registers → drains
    await flush();
    expect(h.runs).toEqual(['a1']);
  });

  it('after stop() nothing queued is ever started and runOrQueue falls back to runAccount', async () => {
    const h = harness([account('a1', 'notion')]);
    const q = createBootQueue(h.deps);
    q.arm([ext('kia.notion', ['notion'])]);
    q.defer(account('a1', 'notion'));
    q.stop();
    h.register('notion');
    q.onSnapshot([]);
    await flush();
    expect(h.runs).toEqual([]);
    expect(q.defer(account('a1', 'notion'))).toBe(false);
    q.runOrQueue(account('a1', 'notion'), 'explicit');
    expect(h.runs).toEqual(['a1']);
  });

  it('a failing re-read is logged and the next account still starts', async () => {
    const h = harness([account('a2', 'notion')]);
    const q = createBootQueue({
      ...h.deps,
      readAccount: async (id) => {
        if (id === 'a1') throw new Error('db gone');
        return h.db.get(id) ?? null;
      },
    });
    q.arm([ext('kia.notion', ['notion'])]);
    q.defer(account('a1', 'notion'));
    q.defer(account('a2', 'notion'));
    h.register('notion');
    await flush();
    expect(h.runs).toEqual(['a2']);
    expect(h.logs[0]).toMatch(/a1.*db gone/);
  });
});

describe('startBackground', () => {
  function deps(
    overrides: Partial<Parameters<typeof startBackground>[0]> = {},
  ) {
    const calls: string[] = [];
    const ac = new AbortController();
    const d = {
      resumeReady: jest.fn(async () => {
        calls.push('resume');
      }),
      startScheduler: jest.fn(() => {
        calls.push('scheduler');
      }),
      startUtilityExtensions: jest.fn(async () => {
        calls.push('utility');
      }),
      mark: jest.fn((step: string) => {
        calls.push(`mark:${step}`);
      }),
      log: jest.fn(),
      signal: ac.signal,
      ...overrides,
    };
    return { d, calls, ac };
  }

  it('runs resume → scheduler → utility extensions, in that order', async () => {
    const { d, calls } = deps();
    await startBackground(d);
    expect(calls).toEqual([
      'resume',
      'scheduler',
      'mark:scheduler started',
      'utility',
      'mark:utility extensions started',
    ]);
  });

  it('hands its signal to resumeReady', async () => {
    const { d } = deps();
    await startBackground(d);
    expect(d.resumeReady).toHaveBeenCalledWith(d.signal);
  });

  it('abort halts the chain', async () => {
    const { d, calls, ac } = deps();
    jest.mocked(d.resumeReady).mockImplementationOnce(async () => {
      calls.push('resume');
      ac.abort();
    });
    await startBackground(d);
    expect(calls).toEqual(['resume']);
  });

  it('a thrown step is logged and the chain goes on', async () => {
    const { d, calls } = deps();
    jest.mocked(d.resumeReady).mockRejectedValueOnce(new Error('db busy'));
    await expect(startBackground(d)).resolves.toBeUndefined();
    expect(d.log).toHaveBeenCalledWith('error', 'boot: resume failed: db busy');
    expect(calls).toContain('scheduler');
    expect(calls).toContain('utility');
  });

  it('a never-settling utility start leaves the scheduler running and never rejects', async () => {
    const { d, calls } = deps({
      startUtilityExtensions: jest.fn(() => new Promise<void>(() => {})),
    });
    void startBackground(d);
    await flush();
    expect(calls).toEqual(['resume', 'scheduler', 'mark:scheduler started']);
  });
});
