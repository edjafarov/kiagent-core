/** @jest-environment node */
import type { Account, Cap, Credentials, ExportContext } from '@shared/contracts';
import type { Contributions } from '@shared/extension-rpc';

import { runExtensionHost } from '../extension-host-entry';
import { createSourceProxySet } from '../source-proxy';
import { createInMemoryHostPair, createRpcEndpoint } from '../transport';

const BOOT = {
  kind: 'bootstrap' as const,
  v: 1 as const,
  extensionId: 'test.prepare-export',
  entryAbsPath: '/virtual/e.js',
  dataDir: '/virtual/d',
  caps: [] as Cap[],
};
const account = {
  id: 'acc1',
  source: 'hosted',
  identifier: 'me',
  config: {},
  status: 'idle',
  cursor: null,
  createdAt: 'now',
} as never as Account;

const base = (id: string) => ({
  descriptor: { id, name: id, documentTypes: ['t'], auth: 'none' as const },
  async connect() {
    return { identifier: 'x' };
  },
  // eslint-disable-next-line require-yield
  async *pull() {
    return undefined;
  },
  toDocument: () => null,
});

async function setup(prepare: (ctx: ExportContext) => Promise<void>) {
  const mod = {
    async activate() {
      return { sources: [{ ...base('hosted'), prepareExport: prepare }, base('plain')] };
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
  runExtensionHost(child, { requireModule: () => mod, exit: jest.fn() });
  mainEp.post(BOOT);
  const contributions = await activated;
  return { proxySet, entry: (id: string) => contributions.sources.find((s) => s.descriptor.id === id)! };
}

const ctxFor = (vault: { value: Credentials | null }, logs: string[]): ExportContext => ({
  account,
  credentials: async () => vault.value,
  save: async (c) => {
    vault.value = c;
  },
  log: (l, m) => void logs.push(`${l}:${m}`),
});

it('advertises prepareExport per source, and a plain source has none', async () => {
  const { proxySet, entry } = await setup(async () => undefined);
  expect(entry('hosted').hasPrepareExport).toBe(true);
  expect(entry('plain').hasPrepareExport).toBe(false);
  expect(proxySet.makeSource(entry('plain')).prepareExport).toBeUndefined();
  expect(proxySet.makeSource(entry('hosted')).prepareExport).toBeDefined();
});

it('runs the hosted hook with the account, and its save reaches the main-side vault', async () => {
  const seen: unknown[] = [];
  const { proxySet, entry } = await setup(async (ctx) => {
    seen.push(ctx.account.id, await ctx.credentials());
    await ctx.save({ session: 'migrated' } as never);
    ctx.log('info', 'moved the session file');
  });
  const vault = { value: { token: 't0' } as never as Credentials | null };
  const logs: string[] = [];
  await proxySet.makeSource(entry('hosted')).prepareExport!(ctxFor(vault, logs));
  expect(seen).toEqual(['acc1', { token: 't0' }]);
  expect(vault.value).toEqual({ session: 'migrated' });
  expect(logs).toEqual(['info:moved the session file']);
});

it('a hook that throws rejects on the main side', async () => {
  const { proxySet, entry } = await setup(async () => {
    throw new Error('disk full');
  });
  await expect(
    proxySet.makeSource(entry('hosted')).prepareExport!(ctxFor({ value: null }, [])),
  ).rejects.toThrow();
});

it('a resumed export waits for a hosted connector to register, then its hook runs across the host', async () => {
  const { createSourceRegistry } = await import('../../core/boot');
  const { exportSources } = await import('../../core/sync/sources');
  const { proxySet, entry } = await setup(async (ctx) => {
    await ctx.save({ session: 'from-the-host' } as never);
  });
  const registry = createSourceRegistry();
  registry.setPrepareExportAdvertiser!((id) => id === 'hosted');
  const vault = new Map<string, Credentials>([['acc1', { session: 'old' } as never]]);
  const store = {
    read: { accounts: async () => [{ ...account, config: {} }] },
    vault: {
      load: async (id: string) => vault.get(id) ?? null,
      save: async (id: string, c: Credentials) => void vault.set(id, c),
    },
  };
  let done = false;
  const out = exportSources(store as never, 'device-aaaa', undefined, registry as never, {
    waitMs: 5_000,
  }).then((o) => {
    done = true;
    return o;
  });
  await new Promise((r) => setTimeout(r, 30));
  expect(done).toBe(false);
  registry.register(proxySet.makeSource(entry('hosted')));
  const [offered] = await out;
  expect(offered).toMatchObject({ source: 'hosted', credentials: { session: 'from-the-host' } });
});
