/** @jest-environment node */
import type {
  AuthChannel,
  FolderNode,
  FolderPickerSpec,
  Source,
} from '@shared/contracts';
import type { ConnectEvent, RendererApi } from '@shared/ipc';
import { createConnectPickerAdapter } from '@renderer/screens/Sources/connect-picker-adapter';

import { createConnectBroker } from '../connect-broker';
import type { CorePlatform } from '../../core/boot';

// A10 hop 4, end to end: a source's FolderPickerSpec.selected → the broker's
// ConnectEvent → the renderer adapter → back through pickerConfirm into the
// source's own awaited pickFolders. Hops 1-3 (descriptor → extension wire →
// source proxy) belong to Task 4; this file is the last hop and the join.
//
// Importing a RENDERER module inside a node-environment suite is safe here:
// all three of connect-picker-adapter's imports are `import type` (fully
// erased), and its only `window` reference is the DEFAULT `invoke` argument,
// which this test overrides. oauth-window pulls in electron at require time
// and boot pulls in the whole core; neither is exercised.
jest.mock('../oauth-window', () => ({ runOAuthLoopback: jest.fn() }));
jest.mock('../../core/boot', () => ({ runAccount: jest.fn() }));

const flush = () => new Promise((r) => setImmediate(r));

/** Local-folder-shaped roots: the id IS an absolute path, so these carry the
 *  separators and the ancestor relationship that make hop 4 worth testing. */
const HOME: FolderNode = { id: '/Users/ed', name: 'ed', hasChildren: true };
const DOCS: FolderNode = {
  id: '/Users/ed/docs',
  name: 'docs',
  hasChildren: false,
};

function makeFlow(spec: FolderPickerSpec) {
  const events: ConnectEvent[] = [];
  let picked: FolderNode[] | undefined;
  const source = {
    descriptor: {
      id: 'picky',
      name: 'Picky',
      documentTypes: ['t'],
      auth: 'none',
    },
    connect: async (auth: AuthChannel) => {
      picked = await auth.pickFolders(spec);
      return { identifier: 'this-machine' };
    },
    async *pull() {},
    toDocument: () => null,
  } as never as Source;
  const platform = {
    sources: { get: (id: string) => (id === 'picky' ? source : undefined) },
    engine: {
      connect: async (s: Source, auth: AuthChannel) => {
        const { identifier } = await s.connect(auth);
        return { id: 'acc1', source: 'picky', identifier } as never;
      },
      remove: jest.fn(async () => {}),
    },
  } as unknown as CorePlatform;
  const broker = createConnectBroker(platform, (e) => events.push(e));
  broker.start('picky');
  return { broker, events, picked: () => picked };
}

function pickerEvent(events: ConnectEvent[]) {
  const evt = events.find((e) => e.kind === 'folder-picker');
  if (!evt || evt.kind !== 'folder-picker')
    throw new Error('no folder-picker event');
  return evt;
}

describe('A10 hop 4 — main → ConnectEvent → renderer adapter', () => {
  it('a preselected root survives the event and confirms by id without ever being listed', async () => {
    const spec: FolderPickerSpec = {
      modes: [{ key: 'fs', label: 'This Mac' }],
      multiSelect: true,
      selected: [HOME, DOCS],
      purpose: 'manage',
      // The Manage modal opened with both roots checked and the user changed
      // nothing: roots() and children() are never called.
      roots: async () => [],
      children: async () => [],
    };
    const { broker, events, picked } = makeFlow(spec);
    await flush();

    // Step 1's pin: the broker bridges spec.selected/spec.purpose onto the
    // event rather than hard-coding them. Replace Step 1's two lines with
    // `selected: []` / `purpose: 'connect'` and the first of these three
    // fails with Expected "manage" / Received "connect".
    const evt = pickerEvent(events);
    expect(evt.purpose).toBe('manage');
    expect(evt.selected).toEqual([HOME, DOCS]);
    // Data, not a re-synthesized copy — the adapter seeds its identity map
    // from exactly these objects.
    expect(evt.selected[0]).toBe(HOME);

    const invoke = (async (channel: string, payload: unknown) => {
      if (channel === 'accounts:picker-confirm') {
        const { requestId, nodes } = payload as {
          requestId: string;
          nodes: FolderNode[];
        };
        broker.pickerConfirm(requestId, nodes);
        return undefined;
      }
      return undefined;
    }) as unknown as RendererApi['invoke'];

    // The ConnectEvent IS a PickerRequest — passed as a variable, so its
    // extra flowId/kind are not excess-property-checked.
    const adapter = createConnectPickerAdapter(evt, invoke);
    await adapter.confirm([HOME.id, DOCS.id]);
    await flush();

    // The covering set the source gets back must be the covering set it
    // offered. Anything less is what Task 3's applyFolderScope archives.
    expect(picked()).toEqual([HOME, DOCS]);
  });
});
