import type { Account, AccountId, Connected } from '@shared/contracts';

import { AccountFlowBusyError } from '../../engine/flow-errors';
import { accountKey, createAccountOps } from '../account-ops';
import {
  BAD_REQUEST_SENTENCE,
  BUSY_SENTENCE,
  createCopyRelay,
  createLeaderRunners,
  KEEP_EVERY_MS,
  LEADER_CHANGED_SENTENCE,
  NOT_SAVED_SENTENCE,
  UNKNOWN_SOURCE_SENTENCE,
  wrapAccountChannels,
} from '../accounts-relay';
import { LeadsNow, SyncReadOnly } from '../role';
import type { ForwardRequest, ForwardResult } from '../service';

const SENTINEL = 'SENTINEL-refresh-token-9f3a';
const NO_MASTER: ForwardResult = {
  ok: false,
  code: 'no-master',
  message: 'no leader is reachable',
};
const connected: Connected = {
  sourceId: 'gmail',
  identifier: 'me@example.com',
  config: { a: 1 },
  credentials: { refreshToken: SENTINEL },
  usedPicker: false,
};
const account = (id: string, over: Partial<Account> = {}): Account =>
  ({
    id: id as AccountId,
    source: 'gmail',
    identifier: 'me@example.com',
    status: 'connecting',
    config: {},
    ...over,
  }) as Account;

describe('the copy side', () => {
  const setup = (answers: ForwardResult[]) => {
    const sent: ForwardRequest[] = [];
    let now = 0;
    const slept: number[] = [];
    let n = 0;
    const relay = createCopyRelay({
      sync: {
        forward: async (req) => {
          sent.push(req);
          return answers.shift() ?? NO_MASTER;
        },
        masterName: () => 'Server',
      },
      newId: () => {
        n += 1;
        return `op${n}`;
      },
      now: () => now,
      sleep: async (ms) => {
        slept.push(ms);
        now += ms;
      },
    });
    return { relay, sent, slept };
  };

  it('probe passes when the leader has the connector', async () => {
    const { relay, sent } = setup([
      { ok: true, value: { ok: true, hasSource: true } },
    ]);
    await relay.probe('gmail');
    expect(sent[0]).toEqual({
      kind: 'core',
      name: 'accounts:probe',
      payload: { sourceId: 'gmail' },
    });
  });

  it('probe names an unreachable leader', async () => {
    const { relay } = setup([NO_MASTER]);
    await expect(relay.probe('gmail')).rejects.toThrow(
      "Can't reach Server. Try again when it is online.",
    );
  });

  it('probe names a leader on an older build', async () => {
    const { relay } = setup([
      {
        ok: false,
        code: 'handler',
        message: 'accounts:probe is not a forwarded channel',
      },
    ]);
    await expect(relay.probe('gmail')).rejects.toThrow(
      'Server needs an update before sources can be connected from this device.',
    );
  });

  it('probe names a leader without the connector', async () => {
    const { relay } = setup([
      { ok: true, value: { ok: true, hasSource: false } },
    ]);
    await expect(relay.probe('gmail')).rejects.toThrow(
      'Server does not have this connector yet. Try again in a minute.',
    );
  });

  it('a finished sign-in waits for the leader and is sent with one operation id', async () => {
    const { relay, sent, slept } = setup([
      NO_MASTER,
      NO_MASTER,
      { ok: true, value: account('a1') },
    ]);
    const status: string[] = [];
    const got = await relay.adopt(connected, { status: (m) => status.push(m) });
    expect(got.id).toBe('a1');
    expect(sent).toHaveLength(3);
    expect(
      new Set(sent.map((s) => (s.payload as { opId: string }).opId)),
    ).toEqual(new Set(['op1']));
    expect(slept).toEqual([KEEP_EVERY_MS, KEEP_EVERY_MS]);
    expect(status).toEqual(['Waiting for Server…', 'Waiting for Server…']);
  });

  it('after three minutes the person is asked to sign in again', async () => {
    const { relay, sent } = setup([]);
    await expect(
      relay.commitReauth({ accountId: 'a1' as AccountId, credentials: null }),
    ).rejects.toThrow(
      "Couldn't reach Server. Sign in again when it is online.",
    );
    expect(sent.length).toBe(37);
  });

  it("the leader's refusal ends the wait at once with its sentence", async () => {
    const { relay, sent } = setup([
      { ok: false, code: 'handler', message: BUSY_SENTENCE },
    ]);
    await expect(relay.adopt(connected)).rejects.toThrow(BUSY_SENTENCE);
    expect(sent).toHaveLength(1);
  });

  it('a leader that stopped leading before the commit ran is tried again', async () => {
    const { relay, sent } = setup([
      { ok: false, code: 'handler', message: LEADER_CHANGED_SENTENCE },
      { ok: true, value: account('a1') },
    ]);
    await expect(relay.adopt(connected)).resolves.toMatchObject({ id: 'a1' });
    expect(sent).toHaveLength(2);
  });

  it('a device that leads by now sends nothing and says so', async () => {
    const { relay, sent } = setup([{ ok: true, value: account('a1') }]);
    await expect(
      relay.adopt(connected, { stillCopy: () => false }),
    ).rejects.toBeInstanceOf(LeadsNow);
    expect(sent).toHaveLength(0);
  });

  it('a sign-in cancelled before it was sent is never sent', async () => {
    const ctl = new AbortController();
    const { relay, sent } = setup([{ ok: true, value: account('a1') }]);
    ctl.abort();
    await expect(
      relay.adopt(connected, { signal: ctl.signal }),
    ).rejects.toThrow('cancelled');
    expect(sent).toHaveLength(0);
  });

  it('a cancel ends the wait for the leader', async () => {
    const ctl = new AbortController();
    const sent: ForwardRequest[] = [];
    const relay = createCopyRelay({
      sync: {
        forward: async (req) => {
          sent.push(req);
          return NO_MASTER;
        },
        masterName: () => 'Server',
      },
      newId: () => 'op',
      now: () => 0,
      sleep: async () => {
        ctl.abort();
      },
    });
    await expect(
      relay.adopt(connected, { signal: ctl.signal }),
    ).rejects.toThrow('cancelled');
    expect(sent).toHaveLength(1);
  });

  it('a folder-scope change and a login request go once', async () => {
    const { relay, sent } = setup([
      { ok: true, value: { archived: 2 } },
      { ok: true, value: { accessToken: 't' } },
    ]);
    await expect(
      relay.applyScope('a1' as AccountId, { config: {} } as never, '{}'),
    ).resolves.toEqual({ archived: 2 });
    await expect(relay.credentials('a1' as AccountId)).resolves.toEqual({
      accessToken: 't',
    });
    expect(sent.map((s) => s.name)).toEqual([
      'accounts:apply-scope',
      'accounts:fresh-credentials',
    ]);
  });
});

describe('the leader side', () => {
  const setup = (over: Record<string, unknown> = {}) => {
    const log: string[] = [];
    let writable = true;
    const started: Account[] = [];
    const claims = new Map<string, string>();
    const rows: Account[] = [];
    const engine = {
      adopt: jest.fn(async (c: Connected, started?: (a: Account) => void) => {
        const a = account(`acc-${rows.length + 1}`, {
          source: c.sourceId,
          identifier: c.identifier,
        });
        rows.push(a);
        started?.(a);
        return a;
      }),
      commitReauth: jest.fn(
        async (r: { accountId: string }, started?: (a: Account) => void) => {
          const row = rows.find((x) => x.id === r.accountId);
          if (row) started?.(row);
        },
      ),
      applyScope: jest.fn(async () => ({ archived: 1 })),
      claimAccountFlow: (id: AccountId, flow: string) => {
        const held = claims.get(id);
        if (held && held !== flow) throw new AccountFlowBusyError(held);
        claims.set(id, flow);
      },
      releaseAccountFlow: (id: AccountId, flow: string) => {
        if (claims.get(id) === flow) claims.delete(id);
      },
      freshCredentialsQuiet: jest.fn(async () => ({ accessToken: 'fresh' })),
      ...over,
    };
    const run = createLeaderRunners({
      engine: engine as never,
      account: async (id) => rows.find((r) => r.id === id) ?? null,
      hasSource: (id) => id === 'gmail',
      writable: () => writable,
      ops: createAccountOps({ now: () => 0 }),
      runAccount: (a) => started.push(a),
      log: (l) => log.push(l),
    });
    return {
      run,
      engine,
      log,
      started,
      claims,
      rows,
      stopLeading: () => {
        writable = false;
      },
    };
  };

  it('probe says whether the connector is here', async () => {
    const { run } = setup();
    await expect(run['accounts:probe']({ sourceId: 'gmail' })).resolves.toEqual(
      { ok: true, hasSource: true },
    );
    await expect(run['accounts:probe']({ sourceId: 'nope' })).resolves.toEqual({
      ok: true,
      hasSource: false,
    });
  });

  it('adopt creates the account and starts it', async () => {
    const { run, engine, started } = setup();
    const a = (await run['accounts:adopt']({
      opId: 'o1',
      connected,
    })) as Account;
    expect(engine.adopt).toHaveBeenCalledWith(connected, expect.any(Function));
    expect(started.map((s) => s.id)).toEqual([a.id]);
  });

  it('the same operation twice runs once', async () => {
    const { run, engine, started } = setup();
    const a = await run['accounts:adopt']({ opId: 'o1', connected });
    const b = await run['accounts:adopt']({ opId: 'o1', connected });
    expect(b).toBe(a);
    expect(engine.adopt).toHaveBeenCalledTimes(1);
    expect(started).toHaveLength(1);
  });

  it.each([
    ['no operation id', { connected }],
    ['no source', { opId: 'o', connected: { ...connected, sourceId: '' } }],
    [
      'a config that is a list',
      { opId: 'o', connected: { ...connected, config: [] } },
    ],
    [
      'a login that is text',
      { opId: 'o', connected: { ...connected, credentials: 'x' } },
    ],
    ['nothing', null],
  ])('a request with %s is refused before the engine', async (_n, body) => {
    const { run, engine } = setup();
    await expect(run['accounts:adopt'](body)).rejects.toThrow(
      BAD_REQUEST_SENTENCE,
    );
    expect(engine.adopt).not.toHaveBeenCalled();
  });

  it('a failure carrying the login reaches neither the answer nor the log', async () => {
    const { run, log } = setup({
      adopt: jest.fn(async () => {
        throw new TypeError(`could not store ${SENTINEL}`);
      }),
    });
    const err = await run['accounts:adopt']({ opId: 'o1', connected }).catch(
      (e: Error) => e,
    );
    expect((err as Error).message).toBe(NOT_SAVED_SENTENCE);
    expect(log).toEqual(['adopt failed (TypeError)']);
    expect(JSON.stringify(log)).not.toContain(SENTINEL);
  });

  it('a connector the leader lacks is named', async () => {
    const { run } = setup({
      adopt: jest.fn(async () => {
        throw new Error('unknown source: gmail');
      }),
    });
    await expect(
      run['accounts:adopt']({ opId: 'o1', connected }),
    ).rejects.toThrow(UNKNOWN_SOURCE_SENTENCE);
  });

  it('commit-reauth saves the login and restarts the account', async () => {
    const { run, engine, started, rows, claims } = setup();
    rows.push(account('a1'));
    await run['accounts:commit-reauth']({
      opId: 'o1',
      accountId: 'a1',
      credentials: { accessToken: 't' },
    });
    expect(engine.commitReauth).toHaveBeenCalledWith(
      {
        accountId: 'a1',
        credentials: { accessToken: 't' },
      },
      expect.any(Function),
    );
    expect(started.map((s) => s.id)).toEqual(['a1']);
    expect(claims.size).toBe(0);
  });

  it("a commit while the leader's own flow holds the account is refused", async () => {
    const { run, engine, claims } = setup();
    claims.set('a1', 'flow-in-the-ui');
    await expect(
      run['accounts:commit-reauth']({
        opId: 'o1',
        accountId: 'a1',
        credentials: null,
      }),
    ).rejects.toThrow(BUSY_SENTENCE);
    expect(engine.commitReauth).not.toHaveBeenCalled();
    await expect(
      run['accounts:apply-scope']({
        opId: 'o2',
        accountId: 'a1',
        update: { config: {} },
        configAtOpen: '{}',
      }),
    ).rejects.toThrow(BUSY_SENTENCE);
    expect(claims.get('a1')).toBe('flow-in-the-ui');
  });

  it('two copies committing to one account run one after the other', async () => {
    const order: string[] = [];
    let open!: () => void;
    const first = new Promise<void>((r) => {
      open = r;
    });
    const { run, rows } = setup({
      commitReauth: jest.fn(
        async (r: { credentials: { accessToken: string } }) => {
          order.push(`start ${r.credentials.accessToken}`);
          if (r.credentials.accessToken === 'A') await first;
          order.push(`end ${r.credentials.accessToken}`);
        },
      ),
    });
    rows.push(account('a1'));
    const a = run['accounts:commit-reauth']({
      opId: 'oA',
      accountId: 'a1',
      credentials: { accessToken: 'A' },
    });
    const b = run['accounts:commit-reauth']({
      opId: 'oB',
      accountId: 'a1',
      credentials: { accessToken: 'B' },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(['start A']);
    open();
    await Promise.all([a, b]);
    expect(order).toEqual(['start A', 'end A', 'start B', 'end B']);
  });

  it('a folder-scope change keeps the engine sentence', async () => {
    const { run } = setup({
      applyScope: jest.fn(async () => {
        throw new Error('the folder selection changed elsewhere');
      }),
    });
    await expect(
      run['accounts:apply-scope']({
        opId: 'o1',
        accountId: 'a1',
        update: { config: {} },
        configAtOpen: '{}',
      }),
    ).rejects.toThrow('the folder selection changed elsewhere');
  });

  it('a login request whose turn comes after this device stopped leading refreshes nothing', async () => {
    const { run, engine, stopLeading } = setup();
    stopLeading();
    await expect(
      run['accounts:fresh-credentials']({ accountId: 'a1' }),
    ).rejects.toThrow(LEADER_CHANGED_SENTENCE);
    expect(engine.freshCredentialsQuiet).not.toHaveBeenCalled();
  });

  it('a commit the engine refused because this device stopped leading says the leader changed', async () => {
    const { run } = setup({
      commitReauth: jest.fn(async () => {
        throw new SyncReadOnly('commitReauth');
      }),
    });
    await expect(
      run['accounts:commit-reauth']({
        opId: 'o1',
        accountId: 'a1',
        credentials: null,
      }),
    ).rejects.toThrow(LEADER_CHANGED_SENTENCE);
  });

  it('a commit refused because this device had stopped leading runs when it comes again', async () => {
    let leads = false;
    const commitReauth = jest.fn(
      async (_r: unknown, started?: (a: Account) => void) => {
        if (!leads) throw new SyncReadOnly('commitReauth');
        started?.(account('a1'));
      },
    );
    const { run, started } = setup({ commitReauth });
    const body = {
      opId: 'o1',
      accountId: 'a1',
      credentials: { accessToken: 't' },
    };
    await expect(run['accounts:commit-reauth'](body)).rejects.toThrow(
      LEADER_CHANGED_SENTENCE,
    );
    leads = true;
    await run['accounts:commit-reauth'](body);
    expect(commitReauth).toHaveBeenCalledTimes(2);
    expect(started).toHaveLength(1);
    // And once it ran, the same operation runs no more.
    await run['accounts:commit-reauth'](body);
    expect(commitReauth).toHaveBeenCalledTimes(2);
  });

  it('a refresh failure carrying the login reaches neither the answer nor the log', async () => {
    const { run, log } = setup({
      freshCredentialsQuiet: jest.fn(async () => {
        throw new Error(
          `token refresh failed and the token has expired: ${SENTINEL}`,
        );
      }),
    });
    const err = await run['accounts:fresh-credentials']({
      accountId: 'a1',
    }).catch((e: Error) => e);
    expect((err as Error).message).toBe(NOT_SAVED_SENTENCE);
    expect(JSON.stringify(log)).not.toContain(SENTINEL);
  });
});

describe('the plain account channels', () => {
  const setup = (readOnly: boolean, answer: ForwardResult = NO_MASTER) => {
    const sent: ForwardRequest[] = [];
    const pause = jest.fn(
      async (req: { accountId: string }) => `paused ${req.accountId}`,
    );
    const table: Record<string, ((req: never) => unknown) | undefined> = {
      'accounts:pause': pause as never,
    };
    let n = 0;
    const runners = wrapAccountChannels(table, {
      sync: {
        readOnly: () => readOnly,
        ownsAccount: (id) => id === 'mine',
        masterName: () => 'Server',
        forward: async (req) => {
          sent.push(req);
          return answer;
        },
      },
      ops: createAccountOps({ now: () => 0 }),
      account: async () => null,
      newId: () => {
        n += 1;
        return `op${n}`;
      },
    });
    const call = (req: unknown) =>
      (table['accounts:pause'] as unknown as (r: unknown) => Promise<unknown>)(
        req,
      );
    return { call, pause, sent, runners };
  };

  it('a copy sends the request to the leader with an operation id', async () => {
    const { call, pause, sent } = setup(true, {
      ok: true,
      value: 'from-leader',
    });
    await expect(call({ accountId: 'acc' })).resolves.toBe('from-leader');
    expect(sent).toEqual([
      {
        kind: 'core',
        name: 'accounts:pause',
        payload: { opId: 'op1', req: { accountId: 'acc' } },
      },
    ]);
    expect(pause).not.toHaveBeenCalled();
  });

  it("a copy's own account runs here", async () => {
    const { call, pause, sent } = setup(true);
    await expect(call({ accountId: 'mine' })).resolves.toBe('paused mine');
    expect(sent).toEqual([]);
    expect(pause).toHaveBeenCalledTimes(1);
  });

  it('a device that may write runs it here', async () => {
    const { call, sent } = setup(false);
    await expect(call({ accountId: 'acc' })).resolves.toBe('paused acc');
    expect(sent).toEqual([]);
  });

  it('with no leader the copy says so', async () => {
    const { call } = setup(true);
    await expect(call({ accountId: 'acc' })).rejects.toThrow(
      "Can't reach Server. Try again when it is online.",
    );
  });

  it('the leader runs a forwarded request once per operation id', async () => {
    const { runners, pause } = setup(false);
    const run = runners.get('accounts:pause')!;
    await run({ opId: 'o1', req: { accountId: 'acc' } });
    await run({ opId: 'o1', req: { accountId: 'acc' } });
    expect(pause).toHaveBeenCalledTimes(1);
    await expect(run({ req: { accountId: 'acc' } })).rejects.toThrow(
      BAD_REQUEST_SENTENCE,
    );
  });

  it("a handler waits behind the leader's own commit to the same account", async () => {
    const ops = createAccountOps({ now: () => 0 });
    const row = { source: 'gmail', identifier: 'me@example.com' };
    const order: string[] = [];
    const table: Record<string, ((req: never) => unknown) | undefined> = {
      'accounts:update-outbound': (async () => {
        order.push('outbound');
      }) as never,
    };
    wrapAccountChannels(table, {
      sync: {
        readOnly: () => false,
        ownsAccount: () => false,
        masterName: () => null,
        forward: async () => NO_MASTER,
      },
      ops,
      account: async () => row,
      newId: () => 'op',
    });
    let open!: () => void;
    const held = new Promise<void>((r) => {
      open = r;
    });
    // What the engine gate does for a folder-scope commit made on the leader.
    const scope = ops.serial(
      accountKey('gmail', 'me@example.com'),
      async () => {
        order.push('scope:start');
        await held;
        order.push('scope:end');
      },
    );
    const outbound = (
      table['accounts:update-outbound'] as unknown as (
        r: unknown,
      ) => Promise<unknown>
    )({ accountId: 'acc-1' });
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(['scope:start']);
    open();
    await Promise.all([scope, outbound]);
    expect(order).toEqual(['scope:start', 'scope:end', 'outbound']);
  });
});
