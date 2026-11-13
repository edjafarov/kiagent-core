/** @jest-environment node */
import type { Query } from '@shared/contracts';
import { KIA_INSTRUCTIONS } from '../../instructions';
import { buildBuiltinTools } from '../index';
import {
  COOLDOWN_MS,
  WAIT_MS,
  makeRefreshTool,
  type McpSyncApi,
  type RefreshClock,
} from '../refresh';

type Acc = Awaited<ReturnType<McpSyncApi['accounts']>>[number];

const acc = (over: Partial<Acc> & { id: string }): Acc => ({
  source: 'gmail',
  identifier: `${over.id}@x.test`,
  status: 'live',
  lastSyncAt: '2026-01-01T00:00:00.000Z',
  lastError: null,
  ...over,
});

function setup(accounts: Acc[], over: Partial<McpSyncApi> = {}) {
  let t = Date.parse('2026-06-01T12:00:00.000Z');
  const running = new Set<string>();
  const triggers: string[] = [];
  const state = new Map(accounts.map((a) => [a.id, a]));
  const clock: RefreshClock = {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
    started: new Map(),
  };
  const sync: McpSyncApi = {
    accounts: async () => [...state.values()],
    runsHere: () => true,
    syncedOn: () => 'Mac Studio',
    hasJob: () => true,
    isRunning: (id) => running.has(id),
    trigger: async (jobId) => {
      triggers.push(jobId);
      const id = jobId.split(':')[2];
      // The run: starts, then (by default) finishes after 1 s and stamps.
      running.add(id);
      setTimeout(() => {}, 0);
      pending.push(() => {
        running.delete(id);
        state.set(id, {
          ...state.get(id)!,
          lastSyncAt: new Date(t).toISOString(),
        });
      });
    },
    ...over,
  };
  const pending: Array<() => void> = [];
  // Sleeping lets the fake run progress: the first sleep completes the runs.
  const { sleep } = clock;
  clock.sleep = async (ms) => {
    await sleep(ms);
    while (pending.length) pending.shift()!();
  };
  return {
    refresh: makeRefreshTool(sync, clock),
    triggers,
    running,
    state,
    clock,
    pending,
  };
}

describe('refresh tool', () => {
  it('triggers an idle account and reports synced', async () => {
    const s = setup([acc({ id: 'a1' })]);
    const r = await s.refresh({});
    expect(s.triggers).toEqual(['source:gmail:a1']);
    expect(r.accounts).toHaveLength(1);
    expect(r.accounts[0]).toMatchObject({
      account: 'a1@x.test',
      source: 'gmail',
      status: 'synced',
    });
    expect(r.accounts[0].last_sync_at).not.toBe('2026-01-01T00:00:00.000Z');
  });

  it('reports failed with the error sentence when the run stops on an error', async () => {
    const state = new Map<string, Acc>([['a1', acc({ id: 'a1' })]]);
    let running = false;
    const clock: RefreshClock = {
      now: () => 0,
      sleep: async () => {
        running = false;
        state.set('a1', {
          ...state.get('a1')!,
          status: 'error',
          lastError: 'Google says the token is revoked',
        });
      },
      started: new Map(),
    };
    const refresh = makeRefreshTool(
      {
        accounts: async () => [...state.values()],
        runsHere: () => true,
        syncedOn: () => '',
        hasJob: () => true,
        isRunning: () => running,
        trigger: async () => {
          running = true;
        },
      },
      clock,
    );
    const r = await refresh({});
    expect(r.accounts[0]).toMatchObject({
      status: 'failed',
      reason: 'Google says the token is revoked',
    });
  });

  it.each([
    ['paused', 'paused'],
    ['needsReauth', 'needs reconnect'],
    ['needs-connector', 'needs its connector'],
  ])('skips a %s account and never triggers it', async (status, reason) => {
    const s = setup([acc({ id: 'a1', status })]);
    const r = await s.refresh({});
    expect(r.accounts[0]).toMatchObject({ status: 'skipped', reason });
    expect(s.triggers).toEqual([]);
  });

  it('reports already_running without triggering or waiting', async () => {
    const s = setup([acc({ id: 'a1' })]);
    s.running.add('a1');
    const before = s.clock.now();
    const r = await s.refresh({});
    expect(r.accounts[0].status).toBe('already_running');
    expect(s.triggers).toEqual([]);
    expect(s.clock.now()).toBe(before);
  });

  it('a second call inside the cooldown is fresh and triggers nothing', async () => {
    const s = setup([acc({ id: 'a1' })]);
    await s.refresh({});
    const r = await s.refresh({});
    expect(r.accounts[0]).toMatchObject({
      status: 'skipped',
      reason: 'refreshed less than a minute ago',
    });
    expect(s.triggers).toHaveLength(1);
    // After the cooldown it triggers again.
    await s.clock.sleep(COOLDOWN_MS);
    await s.refresh({});
    expect(s.triggers).toHaveLength(2);
  });

  it('a call while the triggered run is still going says already_running, not fresh', async () => {
    const s = setup([acc({ id: 'a1' })]);
    await s.refresh({});
    s.running.add('a1');
    const r = await s.refresh({});
    expect(r.accounts[0].status).toBe('already_running');
  });

  it('an unknown source is an error naming the known sources', async () => {
    const s = setup([acc({ id: 'a1' })]);
    await expect(s.refresh({ source: 'outlook' })).rejects.toThrow(
      /unknown source 'outlook'; known: /,
    );
    expect(s.triggers).toEqual([]);
  });

  it('gives still_running when the run outlives the deadline', async () => {
    const s = setup([acc({ id: 'a1' })], {
      trigger: async () => {
        s.running.add('a1');
      },
    });
    // The clock's sleep (which would end runs) is replaced: nothing ends it.
    const t0 = s.clock.now();
    let t = t0;
    s.clock.now = () => t;
    s.clock.sleep = async (ms) => {
      t += ms;
    };
    const r = await s.refresh({});
    expect(r.accounts[0].status).toBe('still_running');
    expect(t - t0).toBeGreaterThanOrEqual(WAIT_MS);
    expect(t - t0).toBeLessThan(WAIT_MS + 1000);
  });

  it('skips an account that does not run here, naming the other device', async () => {
    const s = setup([acc({ id: 'a1' })], { runsHere: () => false });
    const r = await s.refresh({});
    expect(r.accounts[0]).toMatchObject({
      status: 'skipped',
      reason: 'synced on Mac Studio',
    });
    expect(s.triggers).toEqual([]);
  });

  it('skips an account with no sync job', async () => {
    const s = setup([acc({ id: 'a1' })], { hasJob: () => false });
    const r = await s.refresh({});
    expect(r.accounts[0]).toMatchObject({
      status: 'skipped',
      reason: 'no sync job',
    });
    expect(s.triggers).toEqual([]);
  });

  it('reports could not start when the run never moved last_sync_at', async () => {
    const s = setup([acc({ id: 'a1' })], { trigger: async () => {} });
    const r = await s.refresh({});
    expect(r.accounts[0]).toMatchObject({
      status: 'skipped',
      reason: 'could not start',
    });
  });

  it('the source filter limits which accounts are touched', async () => {
    const s = setup([
      acc({ id: 'a1' }),
      acc({ id: 's1', source: 'slack', identifier: 'team' }),
    ]);
    const r = await s.refresh({ source: 'slack' });
    expect(r.accounts.map((a) => a.source)).toEqual(['slack']);
    expect(s.triggers).toEqual(['source:slack:s1']);
    const all = await s.refresh({});
    expect(all.accounts).toHaveLength(2);
  });
});

describe('refresh registration', () => {
  it('is a builtin that opts out of the foreground slot', () => {
    const tool = buildBuiltinTools({} as Query).find(
      (t) => t.name === 'refresh',
    );
    expect(tool?.foreground).toBe(false);
  });

  it('says so on a transport with no sync backend', async () => {
    const tool = buildBuiltinTools({} as Query).find(
      (t) => t.name === 'refresh',
    )!;
    await expect(tool.call({})).rejects.toThrow(/unavailable/);
  });

  it('is mentioned in the server instructions', () => {
    expect(KIA_INSTRUCTIONS).toMatch(/call refresh first/);
  });
});
