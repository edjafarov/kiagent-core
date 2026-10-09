/** @jest-environment node */
import type { Session } from '@shared/contracts';
import type { Contributions } from '@shared/extension-rpc';

import { createSourceProxySet, type ProxyBinding } from '../source-proxy';
import type { RpcEndpoint } from '../transport';

type Notify = (m: { kind: string } & Record<string, unknown>) => void;

function fakeEndpoint(
  call: RpcEndpoint['call'] = jest.fn(async () => undefined),
) {
  const notifies = new Set<Notify>();
  const ep = {
    call,
    onCall: jest.fn(),
    post: jest.fn(),
    onNotify: jest.fn((cb: Notify) => {
      notifies.add(cb);
      return () => notifies.delete(cb);
    }),
    dispose: jest.fn(),
  } as unknown as RpcEndpoint;
  const emit = (m: { kind: string } & Record<string, unknown>) =>
    [...notifies].forEach((cb) => cb(m));
  return { ep, emit, notifies };
}

const entry = {
  descriptor: { id: 'src', name: 'Src', documentTypes: ['x'], auth: 'none' },
  hasFetchBytes: false,
  hasReconcile: false,
  hasManageFolders: false,
  hasReauthenticate: false,
} as Contributions['sources'][number];

function binding(ep: RpcEndpoint, live: () => Promise<void> = async () => {}) {
  let open = 0;
  const b: ProxyBinding & { open(): number } = {
    ensureLive: jest.fn(live),
    endpoint: () => ep,
    begin: () => {
      open += 1;
      let ended = false;
      return () => {
        if (!ended) open -= 1;
        ended = true;
      };
    },
    open: () => open,
  };
  return b;
}

describe('createSourceProxySet over a ProxyBinding (#137)', () => {
  it('a verb waits for ensureLive, then calls the current endpoint, and is in flight meanwhile', async () => {
    const { ep } = fakeEndpoint(jest.fn(async () => ({ identifier: 'me' })));
    let release!: () => void;
    const b = binding(
      ep,
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    );
    const set = createSourceProxySet(b);
    const pending = set.makeSource(entry).connect({} as never);
    await Promise.resolve();
    expect(b.open()).toBe(1);
    expect(ep.call).not.toHaveBeenCalled();
    release();
    await expect(pending).resolves.toEqual({ identifier: 'me' });
    expect(ep.call).toHaveBeenCalledWith('source', 'connect', [1, 'src']);
    expect(b.open()).toBe(0);
  });

  it('an ensureLive rejection rejects the verb and ends its in-flight mark', async () => {
    const { ep } = fakeEndpoint();
    const b = binding(ep, async () => {
      throw new Error('extension is not running');
    });
    const set = createSourceProxySet(b);
    await expect(set.makeSource(entry).connect({} as never)).rejects.toThrow(
      'extension is not running',
    );
    expect(b.open()).toBe(0);
  });

  it('the connect flow survives an abortAll that lands while it waits for the wake', async () => {
    let set!: ReturnType<typeof createSourceProxySet>;
    const status = jest.fn(async () => undefined);
    const { ep } = fakeEndpoint(
      jest.fn(async (_ns: string, _m: string, args: unknown[]) => {
        await set.handleCall('auth', 'status', [args[0], 'hi']);
        return { identifier: 'me' };
      }),
    );
    let release!: () => void;
    const b = binding(
      ep,
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    );
    set = createSourceProxySet(b);
    const pending = set.makeSource(entry).connect({ status } as never);
    set.abortAll('extension process exited'); // the soft stop's teardown
    release();
    await expect(pending).resolves.toEqual({ identifier: 'me' });
    expect(status).toHaveBeenCalledWith('hi');
  });

  it('a pull stays in flight from open until the stream ends', async () => {
    const { ep, emit } = fakeEndpoint();
    const b = binding(ep);
    const set = createSourceProxySet(b);
    set.bind(ep);
    (ep.post as jest.Mock).mockImplementation(
      (m: { kind: string; pullId: number }) => {
        if (m.kind !== 'src-next') return;
        queueMicrotask(() =>
          emit(
            (ep.post as jest.Mock).mock.calls.filter(
              (c) => c[0].kind === 'src-next',
            ).length === 1
              ? {
                  kind: 'src-batch',
                  pullId: m.pullId,
                  batch: { phase: 'live', items: [], cursor: 1 },
                }
              : { kind: 'src-done', pullId: m.pullId },
          ),
        );
      },
    );
    const session = {
      account: { id: 'a1' },
      signal: new AbortController().signal,
      credentials: async () => null,
      log: () => {},
    } as unknown as Session;
    const it = set
      .makeSource(entry)
      .pull(session, null)
      [Symbol.asyncIterator]();
    await it.next(); // first batch
    expect(b.open()).toBe(1);
    await it.next(); // done
    expect(b.open()).toBe(0);
  });

  it('bind() moves the notify subscription to the new endpoint', () => {
    const one = fakeEndpoint();
    const two = fakeEndpoint();
    const set = createSourceProxySet(binding(one.ep));
    set.bind(one.ep);
    set.bind(two.ep);
    expect(one.notifies.size).toBe(0);
    expect(two.notifies.size).toBe(1);
    set.unbind(one.ep); // not the bound one: no-op
    expect(two.notifies.size).toBe(1);
    set.unbind(two.ep);
    expect(two.notifies.size).toBe(0);
  });

  it('a bare endpoint keeps today’s behaviour (bound at construction)', () => {
    const { ep, notifies } = fakeEndpoint();
    const set = createSourceProxySet(ep);
    expect(notifies.size).toBe(1);
    set.dispose();
    expect(notifies.size).toBe(0);
  });
});
