/** @jest-environment node */
import type {
  AuthChannel,
  Batch,
  Cap,
  DocumentInput,
  Session,
} from '@shared/contracts';
import type { Contributions } from '@shared/extension-rpc';

import { runExtensionHost } from '../extension-host-entry';
import { createSourceProxySet } from '../source-proxy';
import { createInMemoryHostPair, createRpcEndpoint } from '../transport';

const BOOT = {
  kind: 'bootstrap' as const,
  v: 1 as const,
  extensionId: 'test.basic',
  entryAbsPath: '/virtual/e.js',
  dataDir: '/virtual/d',
  caps: [] as Cap[],
};
const account = {
  id: 'acc1',
  source: 'basicsrc',
  identifier: 'x',
  config: {},
  status: 'connecting',
  cursor: null,
  createdAt: 'now',
} as never;

const fixtureModule = {
  async activate() {
    return {
      sources: [
        {
          descriptor: {
            id: 'basicsrc',
            name: 'Basic',
            documentTypes: ['t'],
            auth: 'password' as const,
          },
          async connect(auth: AuthChannel) {
            const a = await auth.prompt({});
            auth.status('connected');
            return { identifier: String(a.user) };
          },
          async *pull(session: Session, cursor: { n: number } | null) {
            let n = cursor?.n ?? 0;
            while (n < 3) {
              if (session.signal.aborted) return;
              yield {
                phase: 'backfill',
                items: [{ n }],
                cursor: { n: n + 1 },
                estimateTotal: 3,
              };
              n += 1;
            }
          },
          toDocument(item: { n: number }) {
            return {
              externalId: `e${item.n}`,
              type: 't',
              title: `t${item.n}`,
              markdown: 'm',
              metadata: {},
              createdAt: null,
            };
          },
        },
      ],
    };
  },
};

async function setup() {
  const { main, child } = createInMemoryHostPair();
  const mainEp = createRpcEndpoint(main);
  const proxySet = createSourceProxySet(mainEp);
  mainEp.onCall((ns, m, a) => proxySet.handleCall(ns, m, a));
  const activated = new Promise<Contributions>((resolve) => {
    const off = mainEp.onNotify((msg) => {
      if (msg.kind === 'activated') {
        off();
        resolve(msg.contributions as Contributions);
      }
    });
  });
  runExtensionHost(child, {
    requireModule: () => fixtureModule,
    exit: jest.fn(),
  });
  mainEp.post(BOOT);
  const contributions = await activated;
  const source = proxySet.makeSource(contributions.sources[0]);
  return { source, proxySet, mainEp };
}

function makeSession(signal?: AbortSignal): Session {
  return {
    account,
    signal: signal ?? new AbortController().signal,
    credentials: async () => ({ password: 'pw' }),
    log: jest.fn(),
  } as never;
}

describe('source proxy ↔ real child runtime', () => {
  it('connect routes AuthChannel verbs back to the caller', async () => {
    const { source } = await setup();
    const prompt = jest.fn(async () => ({ user: 'eve' }));
    const status = jest.fn();
    const auth = {
      prompt,
      status,
      oauth: jest.fn(),
      showQr: jest.fn(),
    } as never as AuthChannel;
    await expect(source.connect(auth)).resolves.toEqual({ identifier: 'eve' });
    expect(prompt).toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith('connected');
  });

  it('pull yields identity-mapped DocumentInput batches in demand order and resumes from a cursor', async () => {
    const { source } = await setup();
    const got: Array<Batch<unknown, DocumentInput>> = [];
    for await (const b of source.pull(makeSession(), { n: 1 }))
      got.push(b as never);
    expect(got).toHaveLength(2);
    expect((got[0].items[0] as DocumentInput).externalId).toBe('e1');
    expect(source.toDocument(got[0].items[0] as never)).toBe(got[0].items[0]); // identity
  });

  it('aborting the session signal ends the pull promptly', async () => {
    const { source } = await setup();
    const ac = new AbortController();
    const got: unknown[] = [];
    for await (const b of source.pull(makeSession(ac.signal), null)) {
      got.push(b);
      ac.abort();
    }
    expect(got.length).toBeLessThanOrEqual(2);
  });

  it('abortAll fails an in-flight pull with the given reason', async () => {
    const { source, proxySet } = await setup();
    const it = source.pull(makeSession(), null)[Symbol.asyncIterator]();
    await it.next(); // one batch through
    const second = it.next();
    proxySet.abortAll('extension process exited');
    await expect(second).rejects.toThrow('extension process exited');
  });

  it('auth verb "valueOf" is rejected cleanly instead of returning the channel unserializably (F5)', async () => {
    const { source, proxySet } = await setup();
    const auth = {
      prompt: jest.fn(),
      status: jest.fn(),
      oauth: jest.fn(),
      showQr: jest.fn(),
    } as never as AuthChannel;
    // source.connect(auth) runs synchronously up to auths.set(id, auth) before
    // its first await — no need to await/resolve the connect roundtrip itself
    // to exercise handleCall's auth dispatch for that id.
    void source.connect(auth).catch(() => {});
    await expect(proxySet.handleCall('auth', 'valueOf', [1])).rejects.toThrow(
      'unknown auth verb valueOf',
    );
  });

  it("a child pull failure's taxonomy code survives the wire", async () => {
    // Drives the REAL child runtime: the fixture throws a SourceAuthError in
    // the child, the entry posts src-error with code:'auth', and the proxy
    // must rehydrate an Error whose `code` PROPERTY carries it — that
    // property (not instanceof) is what the engine's catch classifies on.
    const throwingFixture = {
      async activate() {
        return {
          sources: [
            {
              descriptor: {
                id: 'authfail',
                name: 'AuthFail',
                documentTypes: ['t'],
                auth: 'oauth' as const,
              },
              async connect() {
                return { identifier: 'x' };
              },
              // eslint-disable-next-line require-yield
              async *pull() {
                const err = new Error('401 token revoked') as Error & {
                  code: string;
                };
                err.code = 'auth'; // same shape SourceAuthError carries
                throw err;
              },
              toDocument(item: unknown) {
                return item as never;
              },
            },
          ],
        };
      },
    };
    const { main, child } = createInMemoryHostPair();
    const mainEp = createRpcEndpoint(main);
    const proxySet = createSourceProxySet(mainEp);
    mainEp.onCall((ns, m, a) => proxySet.handleCall(ns, m, a));
    const activated = new Promise<Contributions>((resolve) => {
      const off = mainEp.onNotify((msg) => {
        if (msg.kind === 'activated') {
          off();
          resolve(msg.contributions as Contributions);
        }
      });
    });
    runExtensionHost(child, {
      requireModule: () => throwingFixture,
      exit: jest.fn(),
    });
    mainEp.post({ ...BOOT, extensionId: 'test.authfail' });
    const contributions = await activated;
    const source = proxySet.makeSource(contributions.sources[0]);

    const failure = await (async () => {
      try {
        // eslint-disable-next-line no-unused-vars, @typescript-eslint/no-unused-vars
        for await (const b of source.pull(makeSession(), null)) {
          /* never yields */
        }
        throw new Error('expected pull to reject');
      } catch (e) {
        return e as Error & { code?: string };
      }
    })();
    expect(failure.message).toContain('401 token revoked');
    expect(failure.code).toBe('auth');
  });
});
