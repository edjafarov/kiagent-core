/** @jest-environment node */
import type { AddressedQuery, Cap, Session } from '@shared/contracts';
import type { Contributions } from '@shared/extension-rpc';

import { runExtensionHost } from '../extension-host-entry';
import { createSourceProxySet } from '../source-proxy';
import { createInMemoryHostPair, createRpcEndpoint } from '../transport';

const BOOT = {
  kind: 'bootstrap' as const,
  v: 1 as const,
  extensionId: 'test.addressed',
  entryAbsPath: '/virtual/e.js',
  dataDir: '/virtual/d',
  caps: [] as Cap[],
};
const account = {
  id: 'acc1',
  source: 'mailsrc',
  identifier: 'me@x.com',
  config: {},
  status: 'idle',
  cursor: null,
  createdAt: 'now',
} as never;

const descriptor = (id: string) => ({
  id,
  name: id,
  documentTypes: ['t'],
  auth: 'none' as const,
});
const base = (id: string) => ({
  descriptor: descriptor(id),
  async connect() {
    return { identifier: 'x' };
  },
  // eslint-disable-next-line require-yield
  async *pull() {
    return undefined;
  },
  toDocument: () => null,
});

function moduleWith(rows: unknown) {
  const seen: Array<{ q: AddressedQuery; creds: unknown }> = [];
  const mod = {
    async activate() {
      return {
        sources: [
          {
            ...base('mailsrc'),
            async listAddressedTo(session: Session, q: AddressedQuery) {
              seen.push({ q, creds: await session.credentials() });
              return rows;
            },
          },
          base('plainsrc'),
        ],
      };
    },
  };
  return { mod, seen };
}

async function setup(rows: unknown) {
  const { mod, seen } = moduleWith(rows);
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
  runExtensionHost(child, { requireModule: () => mod, exit: jest.fn() });
  mainEp.post(BOOT);
  const contributions = await activated;
  const entry = (id: string) =>
    contributions.sources.find((s) => s.descriptor.id === id)!;
  return { proxySet, entry, seen };
}

const session = {
  account,
  signal: new AbortController().signal,
  credentials: async () => ({ accessToken: 'tok' }),
  log: jest.fn(),
} as never as Session;

const row = {
  providerId: 'p1',
  messageId: '<m@x>',
  references: [],
  sent: true,
  from: 'me@x.com',
  subject: 's',
  date: 1,
  to: ['me+kia@x.com'],
  cc: [],
  text: 'hello',
  ownChannel: false,
  automated: false,
};

it('reports hasListAddressedTo per source and proxies the call with a live session', async () => {
  const { proxySet, entry, seen } = await setup([row]);
  expect(entry('mailsrc').hasListAddressedTo).toBe(true);
  expect(entry('plainsrc').hasListAddressedTo).toBe(false);
  expect(
    proxySet.makeSource(entry('plainsrc')).listAddressedTo,
  ).toBeUndefined();
  const src = proxySet.makeSource(entry('mailsrc'));
  const q = { toAddress: 'me+kia@x.com', since: 5, auditSince: 2 };
  await expect(src.listAddressedTo!(session, q)).resolves.toEqual([row]);
  expect(seen).toEqual([{ q, creds: { accessToken: 'tok' } }]);
});

it('rejects malformed rows from the connector', async () => {
  const { proxySet, entry } = await setup([{ providerId: 'p', sent: 'yes' }]);
  const src = proxySet.makeSource(entry('mailsrc'));
  await expect(
    src.listAddressedTo!(session, { toAddress: 'a+kia@x.com', since: 0 }),
  ).rejects.toThrow(/invalid addressed mail from connector/);
});
