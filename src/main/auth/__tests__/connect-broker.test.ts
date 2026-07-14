/** @jest-environment node */
import type {
  AuthChannel,
  FolderNode,
  FolderPickerSpec,
  Source,
} from '@shared/contracts';
import type { ConnectEvent } from '@shared/ipc';

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
