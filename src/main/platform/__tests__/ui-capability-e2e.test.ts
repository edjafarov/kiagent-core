/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type {
  ExtensionSnapshot,
  McpTool,
  Sender,
  Source,
} from '@shared/contracts';
import { openDb } from '@main/db/app-db';
import { openStore, type CoreStore } from '@main/core/store/store';

import {
  createExtensionPlatform,
  type ExtensionPlatform,
} from '../extension-platform';
import { runExtensionHost } from '../extension-host-entry';
import { createInMemoryHostPair, nodeForkTransport } from '../transport';
import { createExtInvokeHandler } from '../ext-invoke';

jest.setTimeout(240_000);

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CHILD_ENTRY = path.resolve(__dirname, '../extension-host-entry.ts');
const FIXTURE = path.join(__dirname, 'fixtures', 'ext-ui');

const attentionStub = {
  publish: async () => ({ rejected: [] }),
  resolve: async () => ({ rejected: [] }),
} as never;

type TransportMode = 'in-process' | 'forked';

function buildPlatform(
  tmp: string,
  store: CoreStore,
  mode: TransportMode,
  onChange: (s: ExtensionSnapshot[]) => void,
): { platform: ExtensionPlatform; tools: Map<string, McpTool> } {
  const registry = new Map<string, Source>();
  const senders = new Map<string, Sender>();
  const tools = new Map<string, McpTool>();
  const platform = createExtensionPlatform({
    extDir: path.join(tmp, 'extensions'),
    // Loaded as BUNDLED (auto-consented, tier 'bundled') rather than
    // installed via installPreview/installCommit — a 'dev'/'marketplace'
    // origin is 'external' tier, which host-surfaces.ts denies
    // ui.handle/unhandle/broadcast, and this fixture needs all three.
    // Tier gating itself (external denies handle, notify still works) is
    // covered by ui-surface.test.ts's unit tests — this file's job is the
    // full bridge for an ALLOWED tier, in both transports.
    bundledDir: path.join(tmp, 'bundled'),
    store,
    attention: attentionStub,
    sources: {
      register: (s) => void registry.set(s.descriptor.id, s),
      get: (id) => registry.get(id),
      list: () => [...registry.values()].map((s) => s.descriptor),
      unregister: (id) => void registry.delete(id),
    },
    senders: {
      register: (id, s) => void senders.set(id, s),
      get: (id) => senders.get(id),
      ids: () => [...senders.keys()],
      unregister: (id) => void senders.delete(id),
    },
    scheduler: {
      register: jest.fn(),
      unregister: jest.fn(),
      jobs: jest.fn(async () => []),
      trigger: jest.fn(),
      env: {},
    } as never,
    registerTool: (tool) => {
      tools.set(tool.name, tool);
      return () => tools.delete(tool.name);
    },
    inference: {
      complete: async () => '',
      see: async () => '',
      read: async () => '',
      hear: async () => '',
    },
    laneState: () => 'open',
    onLaneChange: () => () => {},
    logSink: { log: () => {} },
    notify: () => {},
    transportFactory:
      mode === 'forked'
        ? () =>
            nodeForkTransport(CHILD_ENTRY, {
              cwd: REPO_ROOT,
              execArgv: [
                '-r',
                'ts-node/register/transpile-only',
                '-r',
                'tsconfig-paths/register',
              ],
              env: {
                ...process.env,
                KIA_EXT_HOST_CHILD: '1',
                TS_NODE_TRANSPILE_ONLY: '1',
                TS_NODE_PROJECT: path.join(REPO_ROOT, 'tsconfig.json'),
              },
            })
        : () => {
            const pair = createInMemoryHostPair();
            runExtensionHost(pair.child, {
              // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require, import/no-dynamic-require
              requireModule: (p: string) => require(p),
              exit: (code) => pair.simulateExit(code),
            });
            return pair.main;
          },
    onChange,
    hostTimeouts: { readyTimeoutMs: 180_000, activateTimeoutMs: 180_000 },
  });
  return { platform, tools };
}

describe.each<TransportMode>(['in-process', 'forked'])(
  'B1 ui capability end-to-end (%s child)',
  (mode) => {
    let tmp: string;
    let store: CoreStore;
    let platform: ExtensionPlatform;
    let tools: Map<string, McpTool>;
    const broadcasts: unknown[] = [];

    beforeAll(async () => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), `kia-ui-e2e-${mode}-`));
      fs.cpSync(FIXTURE, path.join(tmp, 'bundled', 'ext-ui'), {
        recursive: true,
      });
      store = openStore(await openDb(path.join(tmp, 'kiagent.db')), {
        encrypt: (s) => Buffer.from(s, 'utf8'),
        decrypt: (b) => b.toString('utf8'),
        detectLanguages: () => [],
      });
      const built = buildPlatform(tmp, store, mode, () => {});
      platform = built.platform;
      tools = built.tools;
      platform.onUiBroadcast((evt) => broadcasts.push(evt));
      await platform.start();
      const snap = platform.snapshot().find((e) => e.id === 'test.ui');
      if (snap?.status !== 'activated')
        throw new Error(`fixture did not activate: ${JSON.stringify(snap)}`);
    });

    afterAll(async () => {
      await platform.stop();
      await store.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('registered during activate(): ext:invoke-equivalent dispatch (platform.callUi) resolves a success envelope', async () => {
      await expect(
        platform.callUi('test.ui', 'echo', { hello: 'world' }),
      ).resolves.toEqual({ ok: true, value: { echoed: { hello: 'world' } } });
    });

    it('an unregistered name resolves EXT_UNKNOWN_DESTINATION — never rejects', async () => {
      await expect(platform.callUi('test.ui', 'nope', null)).resolves.toEqual({
        ok: false,
        code: 'EXT_UNKNOWN_DESTINATION',
        message: expect.stringContaining('nope'),
      });
    });

    it('an unrunning extension resolves EXT_UNKNOWN_DESTINATION', async () => {
      await expect(
        platform.callUi('test.no-such-extension', 'echo', null),
      ).resolves.toEqual({
        ok: false,
        code: 'EXT_UNKNOWN_DESTINATION',
        message: expect.any(String),
      });
    });

    it('full-bridge error fidelity: a handler that throws crosses extension -> RPC -> main -> ext:invoke envelope with code + message intact', async () => {
      const envelope = await platform.callUi('test.ui', 'boom', null);
      expect(envelope.ok).toBe(false);
      if (!envelope.ok) {
        expect(envelope.message).toBe('boom from ext');
      }
      // Same assertion through the ACTUAL ext:invoke handler (sender check
      // + validation + platform.callUi), proving the whole boundary — not
      // just callUi in isolation.
      const handler = createExtInvokeHandler({
        isTrustedSender: () => true,
        platform,
      });
      const viaIpc = await handler(
        { sender: {} },
        { extensionId: 'test.ui', name: 'boom', payload: null },
      );
      expect(viaIpc).toEqual(envelope);
    });

    it('an untrusted sender resolves EXT_UNTRUSTED_SENDER through the real platform, never reaching the extension', async () => {
      const handler = createExtInvokeHandler({
        isTrustedSender: () => false,
        platform,
      });
      const result = await handler(
        { sender: {} },
        { extensionId: 'test.ui', name: 'echo', payload: null },
      );
      expect(result).toEqual({
        ok: false,
        code: 'EXT_UNTRUSTED_SENDER',
        message: 'untrusted renderer',
      });
    });

    it('C1: an unclonable ui-handler result (a resolved function) resolves EXT_HANDLER_FAILED through the REAL ext:invoke handler, never hangs, and the SAME incarnation keeps serving afterward', async () => {
      // The actual boundary under test — `createExtInvokeHandler` — is what
      // stands in for `ipcMain.handle`, the thing that would otherwise hang
      // forever trying to clone an unclonable result (in-process) or, over
      // a forked child, crash the process trying to SEND one (see
      // transport.ts). `platform.callUi` itself is deliberately NOT
      // asserted here: in-process, it legitimately hands back the live
      // value by reference (no serialization boundary exists at that
      // layer) — that reference is exactly what this guard exists to
      // intercept one layer up.
      const handler = createExtInvokeHandler({
        isTrustedSender: () => true,
        platform,
      });
      const viaIpc = await handler(
        { sender: {} },
        { extensionId: 'test.ui', name: 'unclonableFn', payload: null },
      );
      expect(viaIpc.ok).toBe(false);
      if (!viaIpc.ok) expect(viaIpc.code).toBe('EXT_HANDLER_FAILED');
      // The final returned value must ITSELF always be clone-safe — the
      // real thing `ipcMain.handle` would serialize.
      expect(() => structuredClone(viaIpc)).not.toThrow();
      // The unclonable result must not have crashed/respawned the
      // extension host — same incarnation still serves a subsequent good
      // call (in forked mode this also proves the child did NOT exit: a
      // respawn would still eventually re-activate and answer, but only
      // after tearing down and losing this incarnation's registrations —
      // 'echo' would briefly 503 as EXT_UNKNOWN_DESTINATION mid-respawn,
      // which this synchronous-enough follow-up call would catch). Run
      // BEFORE the 'unhandle()' test below, which deliberately removes
      // 'echo' — this must observe it still live.
      await expect(
        platform.callUi('test.ui', 'echo', 'still alive'),
      ).resolves.toEqual({ ok: true, value: { echoed: 'still alive' } });
    });

    it('C1: an unclonable ui-handler result (an unresolved Promise) resolves EXT_HANDLER_FAILED through the REAL ext:invoke handler, never hangs', async () => {
      const handler = createExtInvokeHandler({
        isTrustedSender: () => true,
        platform,
      });
      const viaIpc = await handler(
        { sender: {} },
        { extensionId: 'test.ui', name: 'unclonablePromise', payload: null },
      );
      expect(viaIpc.ok).toBe(false);
      if (!viaIpc.ok) expect(viaIpc.code).toBe('EXT_HANDLER_FAILED');
      expect(() => structuredClone(viaIpc)).not.toThrow();
      await expect(
        platform.callUi('test.ui', 'echo', 'still alive 2'),
      ).resolves.toEqual({ ok: true, value: { echoed: 'still alive 2' } });
    });

    it('duplicate handle() names reject inside the real extension — the fixture reports its own caught rejection', async () => {
      await expect(
        tools.get('ui.handleDuplicate')!.call({}),
      ).resolves.toMatchObject({
        ok: false,
        message: expect.stringMatching(/already registered/),
      });
      // The original registration is unaffected.
      await expect(platform.callUi('test.ui', 'echo', 1)).resolves.toEqual({
        ok: true,
        value: { echoed: 1 },
      });
    });

    it('unhandle() makes the name an EXT_UNKNOWN_DESTINATION afterward', async () => {
      await expect(tools.get('ui.unhandleEcho')!.call({})).resolves.toEqual({
        ok: true,
      });
      await expect(platform.callUi('test.ui', 'echo', 1)).resolves.toEqual({
        ok: false,
        code: 'EXT_UNKNOWN_DESTINATION',
        message: expect.any(String),
      });
    });

    it('broadcast() reaches onUiBroadcast subscribers as ext:push would relay it', async () => {
      broadcasts.length = 0;
      await expect(
        tools.get('ui.broadcast')!.call({ name: 'evt', payload: { x: 1 } }),
      ).resolves.toEqual({ ok: true });
      expect(broadcasts).toEqual([
        { extensionId: 'test.ui', name: 'evt', payload: { x: 1 } },
      ]);
    });
  },
);
