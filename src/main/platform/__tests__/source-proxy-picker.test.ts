/** @jest-environment node */
import type {
  AuthChannel,
  Cap,
  FolderNode,
  FolderPickerSpec,
} from '@shared/contracts';
import type { Contributions } from '@shared/extension-rpc';

import { runExtensionHost } from '../extension-host-entry';
import { createSourceProxySet } from '../source-proxy';
import { createInMemoryHostPair, createRpcEndpoint } from '../transport';

/**
 * pickFolders across the RPC boundary: the child's connect() suspends on
 * auth.pickFolders while main drives the synthesized spec's roots/children/
 * count callbacks BACK into the child (picker-roots/-children/-count), then
 * resolves — the symmetric-transport property the connect-time picker
 * depends on.
 */

const BOOT = {
  kind: 'bootstrap' as const,
  v: 1 as const,
  extensionId: 'test.picker',
  entryAbsPath: '/virtual/e.js',
  dataDir: '/virtual/d',
  caps: [] as Cap[],
};

const childSpec: FolderPickerSpec = {
  modes: [{ key: 'drive', label: 'My Drive' }],
  multiSelect: true,
  roots: async (modeKey) => [
    { id: `root-${modeKey}`, name: 'Root', hasChildren: true },
  ],
  children: async (id) => [
    { id: `${id}.child`, name: 'Child', hasChildren: false },
  ],
  count: async (id) =>
    id === 'root-drive' ? { count: 7, capped: true } : null,
};

const noCountSpec: FolderPickerSpec = {
  modes: [{ key: 'only', label: 'Only' }],
  roots: async () => [],
  children: async () => [],
};

/** Opaque provider ids that break every naive path/key assumption: a
 *  Drive-style id, one carrying '/' and '%' (the FolderNode.id contract no
 *  longer bans separators), and a Windows-style backslash. They must arrive
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

const preselectedSpec: FolderPickerSpec = {
  modes: [{ key: 'drive', label: 'My Drive' }],
  multiSelect: true,
  selected: SELECTED,
  purpose: 'manage',
  roots: async () => SELECTED,
  children: async () => [],
};

function descriptor(id: string) {
  return { id, name: id, documentTypes: ['t'], auth: 'none' as const };
}

const fixtureModule = {
  async activate() {
    return {
      sources: [
        {
          descriptor: descriptor('picker-basic'),
          async connect(auth: AuthChannel) {
            const picked = await auth.pickFolders(childSpec);
            return { identifier: picked.map((n) => n.id).join('+') };
          },
          // eslint-disable-next-line no-empty-function, @typescript-eslint/no-empty-function
          async *pull() {},
          toDocument: () => null,
        },
        {
          descriptor: descriptor('picker-nocount'),
          async connect(auth: AuthChannel) {
            await auth.pickFolders(noCountSpec);
            return { identifier: 'nocount-ok' };
          },
          // eslint-disable-next-line no-empty-function, @typescript-eslint/no-empty-function
          async *pull() {},
          toDocument: () => null,
        },
        {
          descriptor: descriptor('picker-double'),
          async connect(auth: AuthChannel) {
            const first = auth.pickFolders(childSpec);
            let secondError = '';
            try {
              await auth.pickFolders(childSpec);
            } catch (e) {
              secondError = e instanceof Error ? e.message : String(e);
            }
            const picked = await first;
            return { identifier: `${picked[0]?.id}|${secondError}` };
          },
          // eslint-disable-next-line no-empty-function, @typescript-eslint/no-empty-function
          async *pull() {},
          toDocument: () => null,
        },
        {
          descriptor: descriptor('picker-preselected'),
          async connect(auth: AuthChannel) {
            const picked = await auth.pickFolders(preselectedSpec);
            return { identifier: picked.map((n) => n.id).join('|') };
          },
          // eslint-disable-next-line no-empty-function, @typescript-eslint/no-empty-function
          async *pull() {},
          toDocument: () => null,
        },
      ],
    };
  },
};

async function setup() {
  const { main, child } = createInMemoryHostPair();
  const mainEp = createRpcEndpoint(main);
  const proxySet = createSourceProxySet(mainEp);
  const wireCalls: Array<{ ns: string; method: string; args: unknown[] }> = [];
  // Record the raw child→main payload BEFORE main interprets it — that is
  // A-10 hop 2, the literal WirePickerSpec — and structuredClone both legs,
  // because the real utilityProcess transport clones every payload while the
  // in-memory pair passes references: an id that cannot survive a clone must
  // fail HERE, not in production.
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
  return { bySourceId, proxySet, mainEp, wireCalls };
}

function baseAuth(overrides: Partial<AuthChannel>): AuthChannel {
  return {
    oauth: jest.fn(),
    showQr: jest.fn(),
    prompt: jest.fn(),
    status: jest.fn(),
    pickFolders: jest.fn(),
    ...overrides,
  } as never as AuthChannel;
}

describe('pickFolders over the extension RPC boundary', () => {
  it('suspends the child connect; main drives roots/children/count through the wire; confirm resolves it', async () => {
    const { bySourceId, wireCalls } = await setup();
    const source = bySourceId('picker-basic');

    let seen: {
      modes: FolderPickerSpec['modes'];
      multiSelect: boolean | undefined;
      selected: FolderNode[] | undefined;
      expand: string[] | undefined;
      purpose: string | undefined;
      roots: FolderNode[];
      kids: FolderNode[];
      count: unknown;
      missCount: unknown;
    } | null = null;
    const auth = baseAuth({
      async pickFolders(spec: FolderPickerSpec) {
        const roots = await spec.roots('drive');
        const kids = await spec.children(roots[0].id);
        seen = {
          modes: spec.modes,
          multiSelect: spec.multiSelect,
          selected: spec.selected,
          expand: spec.expand,
          purpose: spec.purpose,
          roots,
          kids,
          count: await spec.count?.(roots[0].id),
          missCount: await spec.count?.('other'),
        };
        return [roots[0], kids[0]];
      },
    });

    await expect(source.connect(auth)).resolves.toEqual({
      identifier: 'root-drive+root-drive.child',
    });

    // A-10 hop 2 — the literal payload that crossed the wire. A spec that
    // sets neither field arrives DEFAULTED, never undefined: the renderer's
    // "nothing is selected" state must be a real [] it can trust, and the
    // defaulting happens once, child-side, in toWirePickerSpec.
    const wire = wireCalls.find(
      (c) => c.ns === 'auth' && c.method === 'pickFolders',
    )!;
    expect(wire.args[1]).toEqual({
      modes: [{ key: 'drive', label: 'My Drive' }],
      multiSelect: true,
      hasCount: true,
      selected: [],
      expand: [],
      purpose: 'connect',
    });

    // A-10 hop 3 — what main re-synthesized and handed to the picker.
    expect(seen).toEqual({
      modes: [{ key: 'drive', label: 'My Drive' }],
      multiSelect: true,
      selected: [],
      expand: [],
      purpose: 'connect',
      roots: [{ id: 'root-drive', name: 'Root', hasChildren: true }],
      kids: [{ id: 'root-drive.child', name: 'Child', hasChildren: false }],
      count: { count: 7, capped: true },
      missCount: null,
    });
  });

  it('hasCount:false → the synthesized main-side spec has no count', async () => {
    const { bySourceId } = await setup();
    const source = bySourceId('picker-nocount');

    let countFn: unknown = 'unset';
    const auth = baseAuth({
      async pickFolders(spec: FolderPickerSpec) {
        countFn = spec.count;
        return [];
      },
    });

    await expect(source.connect(auth)).resolves.toEqual({
      identifier: 'nocount-ok',
    });
    expect(countFn).toBeUndefined();
  });

  it('a second concurrent pickFolders on the same connect throws child-side', async () => {
    const { bySourceId } = await setup();
    const source = bySourceId('picker-double');

    const auth = baseAuth({
      async pickFolders(spec: FolderPickerSpec) {
        const roots = await spec.roots('drive');
        return [roots[0]];
      },
    });

    await expect(source.connect(auth)).resolves.toEqual({
      identifier:
        'root-drive|a folder picker is already open for this connect flow',
    });
  });

  it('the picker rejection propagates to the child and out of connect; the child slot is freed', async () => {
    const { bySourceId, mainEp } = await setup();
    const source = bySourceId('picker-basic');

    const auth = baseAuth({
      pickFolders: async () => {
        throw new Error('folder selection cancelled');
      },
    });
    await expect(source.connect(auth)).rejects.toThrow(
      'folder selection cancelled',
    );

    // The finally in the child deleted the spec — a stray tree read for that
    // connectId now fails cleanly instead of hitting a stale spec.
    await expect(
      mainEp.call('source', 'picker-roots', [1, 'drive']),
    ).rejects.toThrow('no active folder picker for this connect flow');
  });

  it('tree reads for an unknown connectId throw child-side', async () => {
    const { mainEp } = await setup();
    await expect(
      mainEp.call('source', 'picker-roots', [99, 'drive']),
    ).rejects.toThrow('no active folder picker');
    await expect(
      mainEp.call('source', 'picker-children', [99, 'x']),
    ).rejects.toThrow('no active folder picker');
    await expect(
      mainEp.call('source', 'picker-count', [99, 'x']),
    ).rejects.toThrow('no active folder picker');
  });

  it('A-10 hops 1-3: selected/purpose cross the wire unchanged, including ids with /, % and backslash', async () => {
    const { bySourceId, wireCalls } = await setup();
    const source = bySourceId('picker-preselected');

    const got: { spec?: FolderPickerSpec } = {};
    const auth = baseAuth({
      async pickFolders(spec: FolderPickerSpec) {
        got.spec = spec;
        return spec.selected ?? [];
      },
    });

    await expect(source.connect(auth)).resolves.toEqual({
      identifier:
        '0B246AxIx6hdAeTBrQ0xLbVhuRTQ|drives/b!x%2Fy/items/01ABC|C:\\Users\\ed\\Docs',
    });

    // Hop 2: the ids survived the structured clone byte-identical.
    const wire = wireCalls.find(
      (c) => c.ns === 'auth' && c.method === 'pickFolders',
    )!;
    expect(wire.args[1]).toEqual({
      modes: [{ key: 'drive', label: 'My Drive' }],
      multiSelect: true,
      hasCount: false,
      selected: SELECTED,
      expand: [],
      purpose: 'manage',
    });

    // Hop 3: main handed the picker the same set, not a re-synthesized one.
    const spec = got.spec!;
    expect(spec.purpose).toBe('manage');
    expect(spec.selected).toEqual(SELECTED);
  });
});
