/** @jest-environment node */
import type { Account, AccountId } from '@shared/contracts';

import { resumeAccounts } from '../boot';
import type { CorePlatform } from '../boot';

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

/** The slice of CorePlatform resumeAccounts → runAccount touches. */
function fakePlatform(accounts: Account[], registered: string[]) {
  const logs: string[] = [];
  const runs: string[] = [];
  const p = {
    store: { read: { accounts: async () => accounts } },
    sources: {
      get: (id: string) =>
        registered.includes(id) ? { descriptor: { id } } : undefined,
    },
    logSink: { log: (_s: string, _l: string, msg: string) => logs.push(msg) },
    engine: {
      run: (a: Account) => {
        runs.push(a.id);
        return {};
      },
    },
    scheduler: { register: jest.fn() },
  } as unknown as CorePlatform;
  return { p, logs, runs };
}

describe('resumeAccounts — defer (#140)', () => {
  it('runs registered sources and warns for unregistered ones, as before', async () => {
    const { p, logs, runs } = fakePlatform(
      [account('a1', 'gmail'), account('a2', 'kia.notion')],
      ['gmail'],
    );
    await resumeAccounts(p);
    expect(runs).toEqual(['a1']);
    expect(logs).toEqual([
      "account a2@example.com: source 'kia.notion' not registered — skipping",
    ]);
  });

  it('a deferred account is skipped silently; an undeferred one still warns', async () => {
    const { p, logs, runs } = fakePlatform(
      [account('a2', 'notion'), account('a3', 'gone')],
      [],
    );
    const deferred: string[] = [];
    await resumeAccounts(p, {
      defer: (a) => {
        if (a.source !== 'notion') return false;
        deferred.push(a.id);
        return true;
      },
    });
    expect(runs).toEqual([]);
    expect(deferred).toEqual(['a2']);
    expect(logs).toEqual([
      "account a3@example.com: source 'gone' not registered — skipping",
    ]);
  });

  it('an abort while the account read is unresolved starts nothing', async () => {
    const { p, runs } = fakePlatform([], ['gmail']);
    let release!: (a: Account[]) => void;
    (p.store.read as { accounts: () => Promise<Account[]> }).accounts = () =>
      new Promise<Account[]>((r) => {
        release = r;
      });
    const ac = new AbortController();
    const resumed = resumeAccounts(p, { signal: ac.signal });
    ac.abort(); // quit / Reset all while the read is in flight
    release([account('a1', 'gmail')]);
    await expect(resumed).resolves.toEqual(new Map());
    expect(runs).toEqual([]);
  });

  it('an abort between dispatches stops the remaining accounts', async () => {
    const { p, runs } = fakePlatform(
      [account('a1', 'gmail'), account('a2', 'gmail')],
      ['gmail'],
    );
    const ac = new AbortController();
    (p.engine as { run: (a: Account) => unknown }).run = (a: Account) => {
      runs.push(a.id);
      ac.abort();
      return {};
    };
    await resumeAccounts(p, { signal: ac.signal });
    expect(runs).toEqual(['a1']);
  });

  it('never offers paused or needsReauth accounts to defer', async () => {
    const { p } = fakePlatform(
      [
        account('a1', 'notion', 'paused'),
        account('a2', 'notion', 'needsReauth'),
      ],
      [],
    );
    const defer = jest.fn(() => true);
    await resumeAccounts(p, { defer });
    expect(defer).not.toHaveBeenCalled();
  });
});
