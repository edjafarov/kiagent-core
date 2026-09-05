/** @jest-environment node */
import type {
  Account,
  AccountId,
  AuthChannel,
  FolderNode,
  FolderPickerSpec,
  FolderScopeUpdate,
  FolderSelectionChannel,
  Source,
} from '@shared/contracts';
import type { ConnectEvent } from '@shared/ipc';
import { IdentityMismatchError } from '@shared/source-errors';

import { createConnectBroker } from '../connect-broker';
import { runOAuthLoopback } from '../oauth-window';
import { runAccount } from '../../core/boot';
import type { CorePlatform } from '../../core/boot';

// oauth-window pulls in electron at require time; boot pulls in the whole
// core. Neither is exercised here — the broker only needs engine.connect and
// sources.get, both stubbed below.
jest.mock('../oauth-window', () => ({ runOAuthLoopback: jest.fn() }));
jest.mock('../../core/boot', () => ({ runAccount: jest.fn() }));

const flush = () => new Promise((r) => setImmediate(r));

function makeSource(
  connect: (auth: AuthChannel) => Promise<{ identifier: string }>,
): Source {
  return {
    descriptor: {
      id: 'picky',
      name: 'Picky',
      documentTypes: ['t'],
      auth: 'none',
    },
    connect,
    // eslint-disable-next-line no-empty-function, @typescript-eslint/no-empty-function
    async *pull() {},
    toDocument: () => null,
  } as never;
}

function makeBroker(source: Source) {
  const events: ConnectEvent[] = [];
  const engineRemove = jest.fn(async () => {});
  const platform = {
    sources: {
      get: (id: string) => (id === source.descriptor.id ? source : undefined),
    },
    engine: {
      connect: async (s: Source, auth: AuthChannel) => {
        const { identifier } = await s.connect(auth);
        return { id: 'acc1', source: s.descriptor.id, identifier } as never;
      },
      remove: engineRemove,
    },
  } as unknown as CorePlatform;
  const broker = createConnectBroker(platform, (e) => events.push(e));
  return { broker, events, engineRemove };
}

const ACCOUNT: Account = {
  id: 'acc1' as AccountId,
  source: 'picky',
  identifier: 'me@example.com',
  config: { folderRoots: [{ id: 'a', name: 'Alpha' }] },
  status: 'needsReauth',
  cursor: { page_token: 'p1' },
  createdAt: '2026-01-01T00:00:00.000Z',
};

function makeAccountBroker(
  source: Source,
  seed: Account = ACCOUNT,
  opts: { cancelGraceMs?: number } = {},
) {
  const events: ConnectEvent[] = [];
  let stored: Account = seed;
  const engineRemove = jest.fn(async () => {});
  // Typed explicitly: an untyped `jest.fn(async () => {})` infers a
  // zero-parameter mock, and `mockImplementation((id, auth) => …)` below
  // would then be a TS error rather than a working stub.
  const reconnect = jest.fn(
    async (
      _accountId: string,
      _auth: AuthChannel,
      _signal?: AbortSignal,
    ): Promise<void> => {},
  );
  const applyScope = jest.fn(
    async (
      _accountId: string,
      _update: unknown,
      _expectedConfigJson: string,
    ) => ({ archived: 4 }),
  );
  const log = jest.fn();
  const held = new Map<string, string>();
  const platform = {
    sources: {
      get: (id: string) => (id === source.descriptor.id ? source : undefined),
    },
    store: {
      account: async (id: string) => (id === stored.id ? stored : null),
    },
    logSink: { log },
    engine: {
      remove: engineRemove,
      reconnect,
      applyScope,
      session: () => ({
        account: stored,
        signal: new AbortController().signal,
        credentials: async () => null,
        log: () => {},
      }),
      claimAccountFlow: (accountId: string, flowId: string) => {
        const owner = held.get(accountId);
        if (owner !== undefined && owner !== flowId)
          throw new Error(
            'another folder or reconnect flow is already running for this ' +
              'account — finish or cancel it first',
          );
        held.set(accountId, flowId);
      },
      releaseAccountFlow: (accountId: string, flowId: string) => {
        if (held.get(accountId) === flowId) held.delete(accountId);
      },
    },
  } as unknown as CorePlatform;
  const broker = createConnectBroker(platform, (e) => events.push(e), opts);
  return {
    broker,
    events,
    engineRemove,
    reconnect,
    applyScope,
    log,
    setStored: (a: Account) => {
      stored = a;
    },
  };
}

/** The one folder-scope log line of `kind`, or undefined. */
function scopeLog(log: jest.Mock, msg: string) {
  const call = log.mock.calls.find(
    (c) => c[0] === 'folder-scope' && c[2] === msg,
  );
  return call?.[3] as Record<string, unknown> | undefined;
}

const NODE_A: FolderNode = { id: 'a', name: 'Alpha', hasChildren: true };
const NODE_B: FolderNode = { id: 'b', name: 'Beta', hasChildren: false };

function makeSpec(overrides: Partial<FolderPickerSpec> = {}): FolderPickerSpec {
  return {
    modes: [
      { key: 'drive', label: 'My Drive' },
      { key: 'shared', label: 'Shared with me' },
    ],
    multiSelect: true,
    roots: async (modeKey) => (modeKey === 'drive' ? [NODE_A] : []),
    children: async (id) => (id === 'a' ? [NODE_B] : []),
    count: async (id) => (id === 'a' ? { count: 7, capped: false } : null),
    ...overrides,
  };
}

function pickerEvent(events: ConnectEvent[]) {
  const evt = events.find((e) => e.kind === 'folder-picker');
  if (!evt || evt.kind !== 'folder-picker')
    throw new Error('no folder-picker event');
  return evt;
}

describe('connect broker — pickFolders', () => {
  it('emits a folder-picker event with requestId, modes and multiSelect', async () => {
    const spec = makeSpec();
    const { broker, events } = makeBroker(
      makeSource(async (auth) => {
        const picked = await auth.pickFolders(spec);
        return { identifier: picked.map((n) => n.id).join(',') };
      }),
    );
    const { flowId } = broker.start('picky');
    await flush();

    const evt = pickerEvent(events);
    expect(evt.flowId).toBe(flowId);
    expect(typeof evt.requestId).toBe('string');
    expect(evt.multiSelect).toBe(true);
    expect(evt.modes).toEqual(spec.modes);
  });

  it('defaults multiSelect to false when the spec omits it', async () => {
    const spec = makeSpec({ multiSelect: undefined });
    const { broker, events } = makeBroker(
      makeSource(async (auth) => {
        await auth.pickFolders(spec);
        return { identifier: 'x' };
      }),
    );
    broker.start('picky');
    await flush();
    expect(pickerEvent(events).multiSelect).toBe(false);
  });

  it('services roots/children/count through the spec', async () => {
    const { broker, events } = makeBroker(
      makeSource(async (auth) => {
        await auth.pickFolders(makeSpec());
        return { identifier: 'x' };
      }),
    );
    broker.start('picky');
    await flush();
    const { requestId } = pickerEvent(events);

    await expect(broker.pickerRoots(requestId, 'drive')).resolves.toEqual([
      NODE_A,
    ]);
    await expect(broker.pickerRoots(requestId, 'shared')).resolves.toEqual([]);
    await expect(broker.pickerChildren(requestId, 'a')).resolves.toEqual([
      NODE_B,
    ]);
    await expect(broker.pickerCount(requestId, 'a')).resolves.toEqual({
      count: 7,
      capped: false,
    });
  });

  it('resolves count as null when the spec has no count', async () => {
    const { broker, events } = makeBroker(
      makeSource(async (auth) => {
        await auth.pickFolders(makeSpec({ count: undefined }));
        return { identifier: 'x' };
      }),
    );
    broker.start('picky');
    await flush();
    const { requestId } = pickerEvent(events);
    await expect(broker.pickerCount(requestId, 'a')).resolves.toBeNull();
  });

  it('confirm resolves pickFolders with the nodes and settles the flow', async () => {
    const { broker, events } = makeBroker(
      makeSource(async (auth) => {
        const picked = await auth.pickFolders(makeSpec());
        return { identifier: picked.map((n) => n.id).join('+') };
      }),
    );
    broker.start('picky');
    await flush();
    const { requestId } = pickerEvent(events);

    broker.pickerConfirm(requestId, [NODE_A, NODE_B]);
    await flush();

    const done = events.find((e) => e.kind === 'done');
    expect(done && done.kind === 'done' && done.account.identifier).toBe('a+b');
    // Settled pickers are gone — every verb now rejects the requestId.
    expect(() => broker.pickerRoots(requestId, 'drive')).toThrow(
      `unknown picker request: ${requestId}`,
    );
  });

  it('cancel rejects pickFolders with the exact message; the flow errors', async () => {
    const { broker, events } = makeBroker(
      makeSource(async (auth) => {
        const picked = await auth.pickFolders(makeSpec());
        return { identifier: picked.join(',') };
      }),
    );
    broker.start('picky');
    await flush();
    const { requestId } = pickerEvent(events);

    broker.pickerCancel(requestId);
    await flush();

    const error = events.find((e) => e.kind === 'error');
    expect(error && error.kind === 'error' && error.msg).toBe(
      'folder selection cancelled',
    );
    expect(() => broker.pickerCancel(requestId)).toThrow(
      'unknown picker request',
    );
  });

  it('every picker verb throws on an unknown requestId', () => {
    const { broker } = makeBroker(
      makeSource(async () => ({ identifier: 'x' })),
    );
    expect(() => broker.pickerRoots('nope', 'drive')).toThrow(
      'unknown picker request',
    );
    expect(() => broker.pickerChildren('nope', 'a')).toThrow(
      'unknown picker request',
    );
    expect(() => broker.pickerCount('nope', 'a')).toThrow(
      'unknown picker request',
    );
    expect(() => broker.pickerConfirm('nope', [])).toThrow(
      'unknown picker request',
    );
    expect(() => broker.pickerCancel('nope')).toThrow('unknown picker request');
  });

  it('a flow error sweeps its pending pickers', async () => {
    const { broker, events } = makeBroker(
      makeSource(async (auth) => {
        // Open a picker the flow never awaits, then die — the settle sweep
        // must reject+delete it without an unhandled rejection.
        void auth.pickFolders(makeSpec());
        throw new Error('boom');
      }),
    );
    broker.start('picky');
    await flush();
    const { requestId } = pickerEvent(events);

    const error = events.find((e) => e.kind === 'error');
    expect(error && error.kind === 'error' && error.msg).toBe('boom');
    expect(() => broker.pickerRoots(requestId, 'drive')).toThrow(
      'unknown picker request',
    );
  });
});

describe('connect broker — cancel', () => {
  beforeEach(() => {
    (runAccount as jest.Mock).mockClear();
    (runOAuthLoopback as jest.Mock).mockReset();
  });

  function promptEvent(events: ConnectEvent[]) {
    const evt = events.find((e) => e.kind === 'prompt');
    if (!evt || evt.kind !== 'prompt') throw new Error('no prompt event');
    return evt;
  }

  it('cancel during a prompt rejects it: connect() throws, the flow errors, the entry is swept', async () => {
    const { broker, events } = makeBroker(
      makeSource(async (auth) => {
        const answers = await auth.prompt({ fields: [] });
        return { identifier: String(answers.user) };
      }),
    );
    const { flowId } = broker.start('picky');
    await flush();
    const { requestId } = promptEvent(events);

    broker.cancel(flowId);
    await flush();

    const error = events.find((e) => e.kind === 'error');
    expect(error && error.kind === 'error' && error.msg).toBe(
      'connect flow cancelled',
    );
    expect(events.some((e) => e.kind === 'done')).toBe(false);
    expect(runAccount).not.toHaveBeenCalled();
    // The prompt entry is gone — a late answer is a harmless no-op.
    expect(() => broker.answer(requestId, { user: 'x' })).not.toThrow();
  });

  it('cancel during pickFolders rejects the picker and settles the flow', async () => {
    const { broker, events } = makeBroker(
      makeSource(async (auth) => {
        const picked = await auth.pickFolders(makeSpec());
        return { identifier: picked.map((n) => n.id).join(',') };
      }),
    );
    const { flowId } = broker.start('picky');
    await flush();
    const { requestId } = pickerEvent(events);

    broker.cancel(flowId);
    await flush();

    const error = events.find((e) => e.kind === 'error');
    expect(error && error.kind === 'error' && error.msg).toBe(
      'connect flow cancelled',
    );
    expect(() => broker.pickerRoots(requestId, 'drive')).toThrow(
      'unknown picker request',
    );
  });

  it("cancel closes the flow's OAuth loopback server via the abort signal", async () => {
    (runOAuthLoopback as jest.Mock).mockImplementation(
      (_url, _redirect, signal: AbortSignal | undefined) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () =>
            reject(new Error('connect flow cancelled')),
          );
        }),
    );
    const { broker, events } = makeBroker(
      makeSource(async (auth) => {
        const creds = await auth.oauth(['scope']);
        return { identifier: String(creds.accessToken) };
      }),
    );
    broker.registerOAuthProfile('picky', {
      redirectUri: 'http://127.0.0.1/cb',
      authUrl: () => 'https://auth.example',
      exchange: async () => ({ accessToken: 'tok' }),
    });
    const { flowId } = broker.start('picky');
    await flush();
    expect(runOAuthLoopback).toHaveBeenCalledTimes(1);

    broker.cancel(flowId);
    await flush();

    const error = events.find((e) => e.kind === 'error');
    expect(error && error.kind === 'error' && error.msg).toBe(
      'connect flow cancelled',
    );
  });

  it('a cancelled flow whose connect() still resolves removes the account instead of starting it', async () => {
    // The impatient-user case: cancel lands while the source is mid-flight
    // (network validation, QR pairing) with no broker-held promise to
    // reject — connect() completes and persists the account anyway.
    let releaseConnect!: () => void;
    const gate = new Promise<void>((r) => {
      releaseConnect = r;
    });
    const { broker, events, engineRemove } = makeBroker(
      makeSource(async () => {
        await gate;
        return { identifier: 'late@example.com' };
      }),
    );
    const { flowId } = broker.start('picky');
    await flush();

    broker.cancel(flowId);
    releaseConnect();
    await flush();

    expect(engineRemove).toHaveBeenCalledWith('acc1');
    expect(runAccount).not.toHaveBeenCalled();
    expect(events.some((e) => e.kind === 'done')).toBe(false);
    const error = events.find((e) => e.kind === 'error');
    expect(error && error.kind === 'error' && error.msg).toBe(
      'connect flow cancelled',
    );
  });

  it('cancel is a no-op for unknown and already-settled flowIds', async () => {
    const { broker, events, engineRemove } = makeBroker(
      makeSource(async () => ({ identifier: 'ok@example.com' })),
    );
    expect(() => broker.cancel('flow_nope')).not.toThrow();

    const { flowId } = broker.start('picky');
    await flush();
    expect(events.some((e) => e.kind === 'done')).toBe(true);
    expect(runAccount).toHaveBeenCalledTimes(1);

    // The renderer's unmount cleanup racing a settled flow: nothing happens.
    expect(() => broker.cancel(flowId)).not.toThrow();
    await flush();
    expect(engineRemove).not.toHaveBeenCalled();
  });
});

describe('connect broker — oauth client override', () => {
  it('start() threads opts.oauthClient into profile.authUrl', async () => {
    (runOAuthLoopback as jest.Mock).mockResolvedValue('http://cb/?code=c');
    const source = makeSource(async (auth) => {
      await auth.oauth(['scope-x']);
      return { identifier: 'me@x' };
    });
    const { broker } = makeBroker(source);
    const authUrl = jest.fn().mockReturnValue('https://auth');
    const exchange = jest.fn().mockResolvedValue({ accessToken: 't' });
    broker.registerOAuthProfile('picky', {
      redirectUri: 'http://127.0.0.1:1/cb',
      authUrl,
      exchange,
    });
    const client = { clientId: 'byo-id', clientSecret: 'byo-secret' };
    broker.start('picky', { oauthClient: client });
    await flush();
    expect(authUrl).toHaveBeenCalledWith(
      ['scope-x'],
      'http://127.0.0.1:1/cb',
      client,
    );
  });

  it('start() without opts passes undefined (env-client fallback)', async () => {
    (runOAuthLoopback as jest.Mock).mockResolvedValue('http://cb/?code=c');
    const source = makeSource(async (auth) => {
      await auth.oauth(['scope-x']);
      return { identifier: 'me@x' };
    });
    const { broker } = makeBroker(source);
    const authUrl = jest.fn().mockReturnValue('https://auth');
    broker.registerOAuthProfile('picky', {
      redirectUri: 'http://127.0.0.1:1/cb',
      authUrl,
      exchange: jest.fn().mockResolvedValue({ accessToken: 't' }),
    });
    broker.start('picky');
    await flush();
    expect(authUrl).toHaveBeenCalledWith(
      ['scope-x'],
      'http://127.0.0.1:1/cb',
      undefined,
    );
  });
});

describe('connect broker — startReconnect', () => {
  beforeEach(() => {
    // Module mocks are shared across describes and each describe in this file
    // clears its own (see `connect broker — cancel`'s beforeEach at
    // connect-broker.test.ts:238-241) — without this, `runAccount` calls from
    // the earlier describes leak into the counts below and a stale
    // `runOAuthLoopback` resolution leaks in from `oauth client override`.
    (runAccount as jest.Mock).mockClear();
    (runOAuthLoopback as jest.Mock).mockReset();
  });

  it('routes by accountId, restarts the account and emits a reconnected event', async () => {
    const h = makeAccountBroker(makeSource(async () => ({ identifier: 'x' })));
    const { flowId } = h.broker.startReconnect('acc1' as AccountId);
    await flush();

    expect(h.reconnect).toHaveBeenCalledTimes(1);
    expect(h.reconnect.mock.calls[0][0]).toBe('acc1');
    expect(runAccount).toHaveBeenCalledTimes(1);
    expect(h.events).toContainEqual({
      flowId,
      kind: 'reconnected',
      accountId: 'acc1',
    });
    // The connect flow's terminal event carries an Account; these two carry
    // an accountId, so nothing downstream mistakes a reconnect for an add.
    expect(h.events.some((e) => e.kind === 'done')).toBe(false);
  });

  it('a cancel landing while reauth is mid-flight NEVER removes the account', async () => {
    // THE regression this task exists for: connect-broker.ts:166-170
    // compensates a late cancel with engine.remove — which deletes both
    // search indexes, every document row, the vault credentials and the
    // account row with its config, and cascades the outbox history (it
    // APPENDS an accountRemoved change; it does not delete history). On this
    // path the account is the user's existing corpus.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = makeAccountBroker(makeSource(async () => ({ identifier: 'x' })));
    h.reconnect.mockImplementation(
      async (_accountId: string, _auth: AuthChannel, signal?: AbortSignal) => {
        await gate;
        // Exactly what the real engine.reconnect does at its PRE-COMMIT check
        // (Step 11): a cancel that landed before the point of no return throws
        // and nothing durable was written.
        if (signal?.aborted) throw new Error('reconnect cancelled');
      },
    );
    const { flowId } = h.broker.startReconnect('acc1' as AccountId);
    await flush();

    h.broker.cancel(flowId);
    release();
    await flush();

    expect(h.engineRemove).not.toHaveBeenCalled();
    expect(runAccount).not.toHaveBeenCalled();
    const error = h.events.find((e) => e.kind === 'error');
    expect(error && error.kind === 'error' && error.msg).toBe(
      'reconnect cancelled',
    );
    // A user cancel is not a failure — it must not be staged as one.
    expect(scopeLog(h.log, 'folder flow failed')).toBeUndefined();
  });

  it('a cancel that lands after the engine COMMITTED still restarts the account and reports success (C-28.3)', async () => {
    // The mirror image of the test above, and the one that fails without the
    // fix. `engine.reconnect` RESOLVES only once it is past its point of no
    // return — loop stopped, credentials saved, status committed. The broker
    // used to answer that with `if (flow.cancelled) throw new Error('reconnect
    // cancelled')`, which skipped runAccount: the account was left stopped,
    // holding freshly-minted credentials, with the UI reporting "cancelled"
    // and nothing scheduled to start it again. So the rule is now: a resolved
    // reconnect is a COMMITTED reconnect, and a committed reconnect is always
    // restarted and always reported as such.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = makeAccountBroker(makeSource(async () => ({ identifier: 'x' })));
    h.reconnect.mockImplementation(async () => {
      await gate; // resolves DESPITE the cancel — it committed.
    });
    const { flowId } = h.broker.startReconnect('acc1' as AccountId);
    await flush();

    h.broker.cancel(flowId);
    release();
    await flush();

    expect(h.engineRemove).not.toHaveBeenCalled();
    expect(runAccount).toHaveBeenCalledTimes(1);
    expect(h.events).toContainEqual({
      flowId,
      kind: 'reconnected',
      accountId: 'acc1',
    });
  });

  it('threads the gate modal’s oauthClient into the flow’s authUrl (R2)', async () => {
    (runOAuthLoopback as jest.Mock).mockResolvedValue('http://cb/?code=c');
    const h = makeAccountBroker(makeSource(async () => ({ identifier: 'x' })));
    h.reconnect.mockImplementation(
      async (_accountId: string, auth: AuthChannel) => {
        await auth.oauth(['drive.readonly']);
      },
    );
    const authUrl = jest.fn().mockReturnValue('https://auth');
    h.broker.registerOAuthProfile('picky', {
      redirectUri: 'http://127.0.0.1:1/cb',
      authUrl,
      exchange: jest.fn().mockResolvedValue({ accessToken: 't' }),
    });
    const client = { clientId: 'byo-id', clientSecret: 'byo-secret' };

    h.broker.startReconnect('acc1' as AccountId, { oauthClient: client });
    await flush();

    expect(authUrl).toHaveBeenCalledWith(
      ['drive.readonly'],
      'http://127.0.0.1:1/cb',
      client,
    );
  });

  it('stages an identity mismatch as reauth-identity and logs no message (A-7)', async () => {
    const h = makeAccountBroker(makeSource(async () => ({ identifier: 'x' })));
    h.reconnect.mockImplementation(async () => {
      throw new IdentityMismatchError(
        'this reconnect signed in as other@example.com, but this account is me@example.com',
      );
    });

    const { flowId } = h.broker.startReconnect('acc1' as AccountId);
    await flush();

    expect(scopeLog(h.log, 'folder flow failed')).toEqual({
      accountId: 'acc1',
      sourceId: 'picky',
      stage: 'reauth-identity',
      error: 'IdentityMismatchError',
    });
    // The human-readable message reaches the USER, never the log — a provider
    // message can name a folder or a mailbox.
    expect(JSON.stringify(h.log.mock.calls).includes('other@example.com')).toBe(
      false,
    );
    expect(h.events).toContainEqual({
      flowId,
      kind: 'error',
      msg: 'this reconnect signed in as other@example.com, but this account is me@example.com',
    });
    expect(h.engineRemove).not.toHaveBeenCalled();
  });

  it('errors for an unknown account without ever calling reconnect', async () => {
    const h = makeAccountBroker(makeSource(async () => ({ identifier: 'x' })));
    const { flowId } = h.broker.startReconnect('acc-nope' as AccountId);
    await flush();
    expect(h.events).toContainEqual({
      flowId,
      kind: 'error',
      msg: 'unknown account: acc-nope',
    });
    expect(h.reconnect).not.toHaveBeenCalled();
  });
});

describe('connect broker — startManageFolders', () => {
  beforeEach(() => {
    (runAccount as jest.Mock).mockClear();
    (runOAuthLoopback as jest.Mock).mockReset();
  });

  const LIVE: Account = { ...ACCOUNT, status: 'live' };

  function manageSource(
    manageFolders: (
      session: unknown,
      channel: FolderSelectionChannel,
    ) => Promise<unknown>,
  ): Source {
    return {
      ...makeSource(async () => ({ identifier: 'x' })),
      manageFolders,
    } as never;
  }

  const UPDATE_AC: FolderScopeUpdate = {
    config: {
      folderRoots: [
        { id: 'a', name: 'Alpha' },
        { id: 'c', name: 'Gamma' },
      ],
    },
    cursor: { page_token: 'p2', backfill_done: false },
    // 'a' is RETAINED and nothing is removed, so the source names nothing to
    // archive. Core forwards this empty array; it must not invent one.
    archiveScopeRootIds: [],
  };

  it('a cancel landing after manageFolders resolves NEVER removes the account and never applies the scope', async () => {
    // The catastrophic case from spec-reality-diff A7: the connect path
    // answers a late cancel with engine.remove — both search indexes, every
    // document row, the vault credentials, the account row with its config,
    // and the outbox history by cascade. Here that would delete the corpus
    // the user was merely re-scoping.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = makeAccountBroker(
      manageSource(async () => {
        await gate;
        return {
          config: { folderRoots: [{ id: 'b', name: 'Beta' }] },
          cursor: null,
          archiveScopeRootIds: ['a'],
        };
      }),
      LIVE,
    );
    const { flowId } = h.broker.startManageFolders('acc1' as AccountId);
    await flush();

    h.broker.cancel(flowId);
    release();
    await flush();

    expect(h.engineRemove).not.toHaveBeenCalled();
    expect(h.applyScope).not.toHaveBeenCalled();
    const error = h.events.find((e) => e.kind === 'error');
    expect(error && error.kind === 'error' && error.msg).toBe(
      'folder selection cancelled',
    );
  });

  it('forwards the whole update to applyScope, reports root counts, and writes ONE observability record', async () => {
    const h = makeAccountBroker(
      manageSource(async () => UPDATE_AC),
      LIVE,
    );
    const { flowId } = h.broker.startManageFolders('acc1' as AccountId);
    await flush();

    // Verbatim — including archiveScopeRootIds. The broker is a courier.
    // Third argument (C-28.2): the config as it was when the picker OPENED,
    // never a fresher read. This is the value the store's CAS compares
    // against, so a config write that landed while the modal was open makes
    // the Save a refusal instead of a silent overwrite.
    expect(h.applyScope).toHaveBeenCalledWith(
      'acc1',
      UPDATE_AC,
      JSON.stringify(LIVE.config),
    );
    expect(h.events).toContainEqual({
      flowId,
      kind: 'scope-saved',
      accountId: 'acc1',
      added: 1,
      retained: 1,
      removed: 0,
    });
    // A-7: exactly one info record, ids + counts only.
    expect(scopeLog(h.log, 'folder scope changed')).toEqual({
      accountId: 'acc1',
      sourceId: 'picky',
      added: 1,
      retained: 1,
      removed: 0,
    });
    expect(
      h.log.mock.calls.filter((c) => c[2] === 'folder scope changed'),
    ).toHaveLength(1);
    // Never a folder name and never a path.
    expect(JSON.stringify(h.log.mock.calls).includes('Gamma')).toBe(false);
  });

  it('opens the picker with purpose "manage" and the persisted roots preselected', async () => {
    // This flow deliberately NEVER settles: manageFolders parks on a forever
    // promise so the picker event can be inspected while it is still pending.
    // The flow entry is dropped when the test file's module registry is torn
    // down; do NOT "fix" this into a resolve/flush loop — resolving would run
    // applyScope and destroy what the assertions below are reading. C-28.5's
    // watchdog arms only on `cancel()` and nothing cancels here, so no timer
    // is pending either — the never-settling fixture is exercised as a
    // regression subject by the "never settles" test further down, which does
    // cancel it.
    const selected = [{ id: 'a', name: 'Alpha', hasChildren: true }];
    const h = makeAccountBroker(
      manageSource(async (_s, channel) => {
        void channel.pickFolders({
          ...makeSpec(),
          selected,
          purpose: 'manage',
        });
        return new Promise(() => {});
      }),
      LIVE,
    );
    h.broker.startManageFolders('acc1' as AccountId);
    await flush();

    const evt = pickerEvent(h.events);
    expect(evt.purpose).toBe('manage');
    expect(evt.selected).toEqual(selected);
  });

  it('forces a terminal and frees the account when a cancelled flow’s source never settles (C-28.5)', async () => {
    // `cancel()` emits no event of its own — connect-broker.ts:186-198 sets
    // the flag, aborts the controller and rejects broker-held promises, and
    // that is all. So every terminal a flow can produce comes out of its body.
    // A manageFolders that ignores its signal, catches and swallows the picker
    // rejection, or hangs on a provider call therefore produces NO terminal:
    // the renderer's spinner never stops and — the part that actually costs
    // the user something — the account's flow slot is held forever, so both
    // Reconnect and Manage folders are dead for that account and the only
    // remaining move on its detail screen is Remove, which destroys the
    // corpus. The fixture below is the never-settling source this file already
    // uses for the picker-shape test; here it is the regression subject.
    const h = makeAccountBroker(
      manageSource(async () => new Promise(() => {})),
      LIVE,
      { cancelGraceMs: 5 },
    );
    const { flowId } = h.broker.startManageFolders('acc1' as AccountId);
    await flush();

    h.broker.cancel(flowId);
    await new Promise((r) => {
      setTimeout(r, 40);
    });

    expect(h.events).toContainEqual({
      flowId,
      kind: 'error',
      msg: 'folder selection cancelled',
    });
    // Exactly one terminal, ever: the zombie body can still settle later and
    // must not send a second.
    expect(
      h.events.filter((e) => e.flowId === flowId && e.kind === 'error'),
    ).toHaveLength(1);
    // The slot is free — a retry starts immediately instead of being told the
    // account is busy.
    const second = h.broker.startManageFolders('acc1' as AccountId);
    await flush();
    expect(
      h.events.filter((e) => e.flowId === second.flowId && e.kind === 'error'),
    ).toEqual([]);
    // A forced terminal is still not a licence to destroy anything.
    expect(h.engineRemove).not.toHaveBeenCalled();
    expect(h.applyScope).not.toHaveBeenCalled();
  });

  it('refuses a source with no manageFolders, and a needsReauth account', async () => {
    const plain = makeAccountBroker(
      makeSource(async () => ({ identifier: 'x' })),
      LIVE,
    );
    const { flowId: f1 } = plain.broker.startManageFolders('acc1' as AccountId);
    await flush();
    expect(plain.events).toContainEqual({
      flowId: f1,
      kind: 'error',
      msg: 'picky does not support managing folders',
    });
    expect(scopeLog(plain.log, 'folder flow failed')?.stage).toBe(
      'folder-validate',
    );

    // R4: provider browsing needs valid credentials, so needsReauth gets
    // Reconnect instead — enforced here, not only in the renderer.
    const revoked = makeAccountBroker(
      manageSource(async () => UPDATE_AC),
      ACCOUNT,
    );
    const { flowId: f2 } = revoked.broker.startManageFolders(
      'acc1' as AccountId,
    );
    await flush();
    expect(revoked.events).toContainEqual({
      flowId: f2,
      kind: 'error',
      msg: 'reconnect this source before managing its folders',
    });
    expect(revoked.applyScope).not.toHaveBeenCalled();
  });

  it('rejects a result computed against a config that changed while the picker was open', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const h = makeAccountBroker(
      manageSource(async () => {
        await gate;
        return {
          config: { folderRoots: [{ id: 'c', name: 'Gamma' }] },
          cursor: null,
          archiveScopeRootIds: ['a'],
        };
      }),
      LIVE,
    );
    const { flowId } = h.broker.startManageFolders('acc1' as AccountId);
    await flush();

    // Another writer lands while the modal is open. In production this is
    // usually connect-broker.start() — an Add of the same provider account
    // upserts through createAccount — which is exactly why start() being
    // outside the per-account lock is DETECTED here rather than silently lost.
    h.setStored({
      ...LIVE,
      config: { folderRoots: [{ id: 'z', name: 'Zeta' }] },
    });
    release();
    await flush();

    expect(h.applyScope).not.toHaveBeenCalled();
    expect(h.events).toContainEqual({
      flowId,
      kind: 'error',
      msg: 'this account changed while the folder picker was open — reopen Manage folders and choose again',
    });
    expect(scopeLog(h.log, 'folder flow failed')?.stage).toBe('folder-stale');
  });

  it('refuses a SECOND flow on the same account, returning a flowId and an error event', async () => {
    const h = makeAccountBroker(
      manageSource(async () => new Promise(() => {})),
      LIVE,
    );
    h.broker.startManageFolders('acc1' as AccountId);
    await flush();

    const { flowId } = h.broker.startReconnect('acc1' as AccountId);
    await flush();

    expect(h.events).toContainEqual({
      flowId,
      kind: 'error',
      msg:
        'another folder or reconnect flow is already running for this ' +
        'account — finish or cancel it first',
    });
    expect(h.reconnect).not.toHaveBeenCalled();
  });

  it('releases the account slot when the flow settles, so a retry can start', async () => {
    const h = makeAccountBroker(
      manageSource(async () => UPDATE_AC),
      LIVE,
    );
    h.broker.startManageFolders('acc1' as AccountId);
    await flush();
    const { flowId } = h.broker.startManageFolders('acc1' as AccountId);
    await flush();

    expect(
      h.events.filter((e) => e.flowId === flowId && e.kind === 'error'),
    ).toEqual([]);
    expect(h.applyScope).toHaveBeenCalledTimes(2);
  });
});
