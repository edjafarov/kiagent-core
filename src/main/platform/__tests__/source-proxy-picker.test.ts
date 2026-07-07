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
  const bySourceId = (id: string) =>
    proxySet.makeSource(
      contributions.sources.find((s) => s.descriptor.id === id)!,
    );
  return { bySourceId, proxySet, mainEp };
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
    const { bySourceId } = await setup();
    const source = bySourceId('picker-basic');

    let seen: {
      modes: FolderPickerSpec['modes'];
      multiSelect: boolean | undefined;
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
    expect(seen).toEqual({
      modes: [{ key: 'drive', label: 'My Drive' }],
      multiSelect: true,
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
});
