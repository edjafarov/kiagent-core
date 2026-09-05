/** @jest-environment node */
import type {
  Account,
  AuthChannel,
  Cap,
  FolderNode,
  FolderPickerSpec,
  FolderScopeUpdate,
  FolderSelectionChannel,
  Session,
} from '@shared/contracts';
import type { Contributions } from '@shared/extension-rpc';

import { runExtensionHost } from '../extension-host-entry';
import { createSourceProxySet } from '../source-proxy';
import { createInMemoryHostPair, createRpcEndpoint } from '../transport';

/**
 * manageFolders / reauthenticate across the extension RPC boundary.
 *
 * Before this, makeSource attached optional methods ONLY behind
 * hasFetchBytes / hasReconcile, so `typeof proxy.manageFolders === 'function'`
 * could never be true and folder scope could not reach either cloud connector
 * (spec-reality-diff A4). These tests pin: the two capability flags, the two
 * new source verbs, the NARROW 'auth'-namespace channel a manage flow gets,
 * the opaque `selected` payload surviving child → wire → main unchanged, and
 * R8's `archiveScopeRootIds` crossing back untouched.
 */

const BOOT = {
  kind: 'bootstrap' as const,
  v: 1 as const,
  extensionId: 'test.manage',
  entryAbsPath: '/virtual/e.js',
  dataDir: '/virtual/d',
  caps: [] as Cap[],
};

/** Opaque provider ids that break every naive path/key assumption: a
 *  Drive-style id, one carrying '/' and '%' (FolderNode.id no longer bans
 *  separators), and a Windows-style backslash. They must arrive
 *  byte-identical or the renderer pre-checks the wrong rows. */
const SELECTED: FolderNode[] = [
  {
    id: '0B246AxIx6hdAeTBrQ0xLbVhuRTQ',
    name: 'Shared drive',
    hasChildren: true,
  },
  { id: 'drives/b!x%2Fy/items/01ABC', name: 'a/b 100%', hasChildren: true },
  { id: 'C:\\Users\\ed\\Docs', name: 'Docs', hasChildren: false },
];

const account = {
  id: 'acc-manage',
  source: 'managesrc',
  identifier: 'ed@example.com',
  config: { folderRoots: [{ id: 'old-root', name: 'Old' }] },
  status: 'idle',
  cursor: { page_token: 'tok', backfill_done: true },
  createdAt: 'now',
} as unknown as Account;

/** What the CHILD half observed — the fixture runs in this realm, so it can
 *  report back directly. Reset per test; a holder object (not a bare `let`)
 *  keeps TS from narrowing it to `null` at the read sites. */
const childSeen: {
  manage?: { accountId: string; cursor: unknown; credentials: unknown };
  reauth?: { accountId: string; identifier: string };
} = {};

function descriptor(id: string, folderScope = false) {
  return {
    id,
    name: id,
    documentTypes: ['t'],
    auth: 'none' as const,
    ...(folderScope ? { folderScope: true } : {}),
  };
}

const fixtureModule = {
  async activate() {
    return {
      sources: [
        {
          descriptor: descriptor('managesrc', true),
          async connect() {
            return { identifier: 'ed@example.com' };
          },
          // eslint-disable-next-line no-empty-function, @typescript-eslint/no-empty-function
          async *pull() {},
          toDocument: () => null,
          async manageFolders(
            session: Session,
            channel: FolderSelectionChannel,
          ): Promise<FolderScopeUpdate> {
            channel.status('listing folders');
            const picked = await channel.pickFolders({
              modes: [{ key: 'drive', label: 'My Drive' }],
              multiSelect: true,
              selected: SELECTED,
              purpose: 'manage',
              roots: async () => SELECTED,
              children: async () => [],
            });
            childSeen.manage = {
              accountId: session.account.id,
              cursor: session.account.cursor,
              credentials: await session.credentials(),
            };
            return {
              config: {
                folderRoots: picked.map((n) => ({ id: n.id, name: n.name })),
              },
              cursor: { page_token: 'tok', backfill_done: false },
              // R8: computed BY THE SOURCE, which alone knows containment.
              // Core forwards it; it must never re-derive it.
              archiveScopeRootIds: SELECTED.filter(
                (s) => !picked.some((p) => p.id === s.id),
              ).map((s) => s.id),
            };
          },
          async reauthenticate(acct: Account, auth: AuthChannel) {
            childSeen.reauth = {
              accountId: acct.id,
              identifier: acct.identifier,
            };
            await auth.oauth(['drive.readonly']);
          },
        },
        {
          // Claims folderScope but ships no manageFolders — the two signals
          // must stay INDEPENDENTLY observable so the IPC layer can refuse.
          descriptor: descriptor('liarsrc', true),
          async connect() {
            return { identifier: 'liar' };
          },
          // eslint-disable-next-line no-empty-function, @typescript-eslint/no-empty-function
          async *pull() {},
          toDocument: () => null,
        },
        {
          descriptor: descriptor('plainsrc'),
          async connect() {
            return { identifier: 'plain' };
          },
          // eslint-disable-next-line no-empty-function, @typescript-eslint/no-empty-function
          async *pull() {},
          toDocument: () => null,
        },
      ],
    };
  },
};

/** One recorded child→main RPC, captured BEFORE main gets to interpret it —
 *  this is the literal wire payload (A-10 hop 2). */
interface WireCall {
  ns: string;
  method: string;
  args: unknown[];
}

async function setup() {
  const { main, child } = createInMemoryHostPair();
  const mainEp = createRpcEndpoint(main);
  const proxySet = createSourceProxySet(mainEp);
  const wireCalls: WireCall[] = [];
  // Two things at once. (1) Record the raw child→main payload so a test can
  // assert what actually crossed, not just what main re-synthesized.
  // (2) structuredClone both legs: the real utilityProcess transport clones
  // every payload, the in-memory pair passes references, so without this an
  // id that does not survive a clone would only fail in production.
  // NOTE the main→child leg (which carries `account`) is NOT cloned — that
  // would mean wrapping the WireChannel; the ids under test all travel
  // child→main.
  mainEp.onCall(async (ns, m, a) => {
    const args = structuredClone(a);
    wireCalls.push({ ns, method: m, args: structuredClone(args) });
    return structuredClone(await proxySet.handleCall(ns, m, args));
  });
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
  const bySourceId = (id: string) =>
    proxySet.makeSource(
      contributions.sources.find((s) => s.descriptor.id === id)!,
    );
  return { bySourceId, contributions, proxySet, mainEp, wireCalls };
}

function makeSession(): Session {
  return {
    account,
    signal: new AbortController().signal,
    credentials: async () => ({ accessToken: 'at' }),
    log: jest.fn(),
  } as never as Session;
}

beforeEach(() => {
  delete childSeen.manage;
  delete childSeen.reauth;
});

describe('manageFolders / reauthenticate over the extension RPC boundary', () => {
  it('activate() reports hasManageFolders/hasReauthenticate per source, independently of descriptor.folderScope', async () => {
    const { contributions } = await setup();
    const entry = (id: string) =>
      contributions.sources.find((s) => s.descriptor.id === id)!;

    expect(entry('managesrc').hasManageFolders).toBe(true);
    expect(entry('managesrc').hasReauthenticate).toBe(true);
    expect(entry('plainsrc').hasManageFolders).toBe(false);
    expect(entry('plainsrc').hasReauthenticate).toBe(false);
    // The disagreement Task 7 must refuse on: the descriptor claims folder
    // scope, the implementation does not back it.
    expect(entry('liarsrc').descriptor.folderScope).toBe(true);
    expect(entry('liarsrc').hasManageFolders).toBe(false);
  });

  it('manage-folders: the channel rides "auth", selected crosses unchanged, and R8s archiveScopeRootIds comes back verbatim', async () => {
    const { bySourceId, mainEp, wireCalls } = await setup();
    const source = bySourceId('managesrc');
    expect(typeof source.manageFolders).toBe('function');
    expect(bySourceId('plainsrc').manageFolders).toBeUndefined();

    const status = jest.fn();
    const got: { spec?: FolderPickerSpec; roots?: FolderNode[] } = {};
    const channel: FolderSelectionChannel = {
      status,
      async pickFolders(spec) {
        got.spec = spec;
        // Read the tree HERE, while the child's slot is still live: the
        // manage picker parked in its OWN slot and main's callbacks resolve
        // against it without a connectId. After pickFolders settles the
        // child's `finally` frees the slot (see the last assertion).
        got.roots = await spec.roots('drive');
        // Only the first two survive the user's edit.
        return (spec.selected ?? []).slice(0, 2);
      },
    };

    const update = await source.manageFolders!(makeSession(), channel);

    expect(status).toHaveBeenCalledWith('listing folders');

    // A-10 hops 1-3 on the MANAGE path: the literal wire payload…
    const wire = wireCalls.find(
      (c) => c.ns === 'auth' && c.method === 'pickFolders',
    )!;
    expect(wire.args[1]).toEqual({
      modes: [{ key: 'drive', label: 'My Drive' }],
      multiSelect: true,
      hasCount: false,
      selected: SELECTED,
      purpose: 'manage',
    });
    // …and what main handed the FolderSelectionChannel.
    const spec = got.spec!;
    expect(spec.purpose).toBe('manage');
    expect(spec.multiSelect).toBe(true);
    expect(spec.selected).toEqual(SELECTED);
    expect(got.roots).toEqual(SELECTED);

    // The child saw the account main supplied — never one of its choosing —
    // and could resolve credentials through the same id.
    expect(childSeen.manage).toEqual({
      accountId: 'acc-manage',
      cursor: { page_token: 'tok', backfill_done: true },
      credentials: { accessToken: 'at' },
    });

    // R8: the archive set is the SOURCE's answer. This layer forwards it as
    // an opaque payload — it must not derive, filter, sort or default it.
    expect(update).toEqual({
      config: {
        folderRoots: [
          { id: '0B246AxIx6hdAeTBrQ0xLbVhuRTQ', name: 'Shared drive' },
          { id: 'drives/b!x%2Fy/items/01ABC', name: 'a/b 100%' },
        ],
      },
      cursor: { page_token: 'tok', backfill_done: false },
      archiveScopeRootIds: ['C:\\Users\\ed\\Docs'],
    });

    // THIS flow's slot is freed on settle. Id 1 is the manage flow's own id
    // (fresh proxy set, `nextId` starts at 1 — source-proxy.ts:71; makeSource
    // allocates none), so this asserts the manage slot was released, not
    // merely that some unrelated id misses. Mirrors the connect-side "the
    // child slot is freed" test in source-proxy-picker.test.ts.
    await expect(
      mainEp.call('source', 'picker-roots', [1, 'drive']),
    ).rejects.toThrow('no active folder picker for this connect flow');
  });

  it('a manage-folders flow can never authenticate: oauth/prompt/showQr on its id are refused main-side', async () => {
    const { bySourceId, proxySet } = await setup();
    const source = bySourceId('managesrc');

    let release: (n: FolderNode[]) => void = () => {};
    const gate = new Promise<FolderNode[]>((r) => {
      release = r;
    });
    const channel: FolderSelectionChannel = {
      status: jest.fn(),
      pickFolders: () => gate,
    };
    // manageFolders registers its id synchronously, before its first await —
    // and this is a fresh proxy set, so that id is 1.
    const running = source.manageFolders!(makeSession(), channel);

    await expect(
      proxySet.handleCall('auth', 'oauth', [1, ['scope']]),
    ).rejects.toThrow('unknown auth verb oauth');
    await expect(
      proxySet.handleCall('auth', 'prompt', [1, {}]),
    ).rejects.toThrow('unknown auth verb prompt');
    await expect(
      proxySet.handleCall('auth', 'showQr', [1, 'qr']),
    ).rejects.toThrow('unknown auth verb showQr');

    release([]);
    await running;
    // Settled: the id is gone, so even an allowed verb no longer resolves.
    await expect(
      proxySet.handleCall('auth', 'status', [1, 'late']),
    ).rejects.toThrow('no active connect flow for this call');
  });

  it('reauthenticate hands the child the stored account and routes AuthChannel verbs back to the caller', async () => {
    const { bySourceId } = await setup();
    const source = bySourceId('managesrc');
    expect(typeof source.reauthenticate).toBe('function');
    expect(bySourceId('plainsrc').reauthenticate).toBeUndefined();

    const oauth = jest.fn(async () => ({ accessToken: 'fresh' }));
    const auth = {
      oauth,
      showQr: jest.fn(),
      prompt: jest.fn(),
      status: jest.fn(),
      pickFolders: jest.fn(),
    } as never as AuthChannel;

    await expect(
      source.reauthenticate!(account, auth),
    ).resolves.toBeUndefined();
    expect(oauth).toHaveBeenCalledWith(['drive.readonly']);
    // Reconnect targets the EXACT stored account — it is an argument, not a
    // child-chosen identifier fed to createAccount's upsert.
    expect(childSeen.reauth).toEqual({
      accountId: 'acc-manage',
      identifier: 'ed@example.com',
    });
  });
});
