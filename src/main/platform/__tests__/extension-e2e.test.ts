/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type {
  AuthChannel,
  ExtensionSnapshot,
  McpTool,
  Sender,
  Source,
} from '@shared/contracts';
import { ModelChangedError } from '@shared/contracts';

import { createEngine } from '@main/core/engine/engine';
import { LaneClosedError } from '@main/core/inference';
import { openDb } from '@main/db/app-db';
import { openStore, type CoreStore } from '@main/core/store/store';

import {
  createExtensionPlatform,
  type ExtensionPlatform,
} from '../extension-platform';
import { nodeForkTransport } from '../transport';

jest.setTimeout(240_000);

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CHILD_ENTRY = path.resolve(__dirname, '../extension-host-entry.ts');
const FIXTURE = path.join(__dirname, 'fixtures', 'ext-basic');

describe('extension runtime e2e (real forked child)', () => {
  let tmp: string;
  let store: CoreStore;
  let platform: ExtensionPlatform;
  const registry = new Map<string, Source>();
  const senderRegistry = new Map<string, Sender>();
  const snapshots: ExtensionSnapshot[][] = [];

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kia-e2e-'));
    store = openStore(await openDb(path.join(tmp, 'kiagent.db')), {
      encrypt: (s) => Buffer.from(s, 'utf8'),
      decrypt: (b) => b.toString('utf8'),
      detectLanguages: () => [],
    });
    platform = createExtensionPlatform({
      extDir: path.join(tmp, 'extensions'),
      store,
      sources: {
        register: (s) => void registry.set(s.descriptor.id, s),
        get: (id) => registry.get(id),
        list: () => [...registry.values()].map((s) => s.descriptor),
        unregister: (id) => void registry.delete(id),
      },
      senders: {
        register: (id, s) => void senderRegistry.set(id, s),
        get: (id) => senderRegistry.get(id),
        ids: () => [...senderRegistry.keys()],
        unregister: (id) => void senderRegistry.delete(id),
      },
      scheduler: {
        register: jest.fn(),
        unregister: jest.fn(),
        jobs: jest.fn(async () => []),
        trigger: jest.fn(),
        env: {},
      } as never,
      registerTool: () => () => {},
      inference: {
        complete: async () => '',
        see: async () => '',
        read: async () => '',
        hear: async () => '',
      },
      laneState: () => 'open',
      onLaneChange: () => () => {},
      logSink: {
        log: (...a) => process.stderr.write(`${JSON.stringify(a)}\n`),
      },
      notify: () => {},
      transportFactory: () =>
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
        }),
      onChange: (s) => snapshots.push(s),
      hostTimeouts: { readyTimeoutMs: 180_000, activateTimeoutMs: 180_000 },
    });
  });

  afterAll(async () => {
    await platform.stop();
    await store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('installs, activates in a real child, and the engine syncs its documents', async () => {
    await platform.start();
    const preview = await platform.installPreview(FIXTURE);
    expect(preview).toMatchObject({ ok: true, id: 'test.basic' });
    const commit = await platform.installCommit(
      (preview as { token: string }).token,
    );
    expect(commit).toEqual({ ok: true, id: 'test.basic' });
    expect(registry.has('basicsrc')).toBe(true);

    const engine = createEngine({
      store,
      sources: {
        get: (id: string) => registry.get(id),
        list: () => [],
        register: () => {},
      } as never,
      inference: {
        complete: async () => '',
        see: async () => '',
        read: async () => '',
      } as never,
      convert: async (d) => d,
      logs: { log: () => {} },
      refreshers: new Map(),
    });
    const auth = {
      prompt: async () => ({}),
      oauth: async () => ({}),
      showQr: () => {},
      status: () => {},
    } as never as AuthChannel;
    const account = await engine.connect(registry.get('basicsrc')!, auth);
    expect(account.identifier).toBe('basic-account');

    const handle = engine.run(account);
    const deadline = Date.now() + 60_000;
    // eslint-disable-next-line no-await-in-loop
    while (
      (await store.read.count({ account: account.id })) < 2 &&
      Date.now() < deadline
    ) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => {
        setTimeout(r, 200);
      });
    }
    await handle.stop();
    const docs = await store.read.search({ account: account.id });
    expect(docs.map((d) => d.externalId).sort()).toEqual([
      'basic-0',
      'basic-1',
    ]);

    // Reconcile over RPC: a second engine cycle diffs the child's listing
    // (only basic-0 lives upstream) against the store and archives basic-1.
    // Cycle 1 above archived nothing — both docs committed after reconcile's
    // startSeq snapshot (the engine's TOCTOU guard) — which this implicitly
    // proves too: count was 2 at the end of cycle 1.
    const handle2 = engine.run(account);
    const deadline2 = Date.now() + 60_000;
    // eslint-disable-next-line no-await-in-loop
    while (
      (await store.read.count({ account: account.id })) > 1 &&
      Date.now() < deadline2
    ) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => {
        setTimeout(r, 200);
      });
    }
    await handle2.stop();
    expect(await store.read.count({ account: account.id })).toBe(1);
    const live = await store.read.search({ account: account.id });
    expect(live.map((d) => d.externalId)).toEqual(['basic-0']);

    // uninstall is refused while the account lives, then succeeds after removal
    await expect(platform.uninstall('test.basic')).resolves.toMatchObject({
      ok: false,
    });
    await engine.remove(account.id);
    await expect(platform.uninstall('test.basic')).resolves.toEqual({
      ok: true,
    });
    expect(registry.has('basicsrc')).toBe(false);
  });
});

const FIXTURE_EVENTS_A = path.join(__dirname, 'fixtures', 'ext-events-a');
const FIXTURE_EVENTS_B = path.join(__dirname, 'fixtures', 'ext-events-b');

// Issue #112: two independent extensions, each in its own real forked
// child, exercising the host-stamped event metadata across the actual RPC
// wire (extension-rpc.ts -> host-process.ts -> extension-host-entry.ts) —
// not just the in-memory bus tested in host-surfaces.test.ts.
describe('extension runtime e2e — host-stamped event identity (real forked children, #112)', () => {
  let tmp: string;
  let store: CoreStore;
  let platform: ExtensionPlatform;
  const registry = new Map<string, Source>();
  const senderRegistry = new Map<string, Sender>();
  const tools = new Map<string, McpTool>();

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kia-e2e-events-'));
    store = openStore(await openDb(path.join(tmp, 'kiagent.db')), {
      encrypt: (s) => Buffer.from(s, 'utf8'),
      decrypt: (b) => b.toString('utf8'),
      detectLanguages: () => [],
    });
    platform = createExtensionPlatform({
      extDir: path.join(tmp, 'extensions'),
      store,
      sources: {
        register: (s) => void registry.set(s.descriptor.id, s),
        get: (id) => registry.get(id),
        list: () => [...registry.values()].map((s) => s.descriptor),
        unregister: (id) => void registry.delete(id),
      },
      senders: {
        register: (id, s) => void senderRegistry.set(id, s),
        get: (id) => senderRegistry.get(id),
        ids: () => [...senderRegistry.keys()],
        unregister: (id) => void senderRegistry.delete(id),
      },
      scheduler: {
        register: jest.fn(),
        unregister: jest.fn(),
        jobs: jest.fn(async () => []),
        trigger: jest.fn(),
        env: {},
      } as never,
      registerTool: (t) => {
        tools.set(t.name, t);
        return () => tools.delete(t.name);
      },
      inference: {
        complete: async () => '',
        see: async () => '',
        read: async () => '',
        hear: async () => '',
      },
      laneState: () => 'open',
      onLaneChange: () => () => {},
      logSink: {
        log: (...a) => process.stderr.write(`${JSON.stringify(a)}\n`),
      },
      notify: () => {},
      transportFactory: () =>
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
        }),
      onChange: () => {},
      hostTimeouts: { readyTimeoutMs: 180_000, activateTimeoutMs: 180_000 },
    });
  });

  afterAll(async () => {
    await platform.stop();
    await store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("A's forged producer claim is overridden by the host-stamped from; platform.activated names 'platform' (#112)", async () => {
    await platform.start();

    // B installs first, so its `host.events.on('extension.activated', …)`
    // subscription exists before A activates.
    const previewB = await platform.installPreview(FIXTURE_EVENTS_B);
    expect(previewB).toMatchObject({ ok: true, id: 'test.eventsb' });
    await expect(
      platform.installCommit((previewB as { token: string }).token),
    ).resolves.toEqual({ ok: true, id: 'test.eventsb' });

    const previewA = await platform.installPreview(FIXTURE_EVENTS_A);
    expect(previewA).toMatchObject({ ok: true, id: 'test.eventsa' });
    await expect(
      platform.installCommit((previewA as { token: string }).token),
    ).resolves.toEqual({ ok: true, id: 'test.eventsa' });

    // Give B's 'extension.activated' subscription time to receive A's
    // activation emit before asserting on it.
    const deadlineActivated = Date.now() + 10_000;
    let activationsSeen: unknown[] = [];
    // eslint-disable-next-line no-await-in-loop
    while (Date.now() < deadlineActivated) {
      // eslint-disable-next-line no-await-in-loop
      const res = (await tools.get('eventsB.getActivations')!.call({})) as {
        activations: Array<{ payload: { id: string }; meta: unknown }>;
      };
      activationsSeen = res.activations.filter(
        (a) => a.payload.id === 'test.eventsa',
      );
      if (activationsSeen.length > 0) break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => {
        setTimeout(r, 200);
      });
    }
    expect(activationsSeen).toEqual([
      {
        payload: { id: 'test.eventsa' },
        meta: { from: 'platform', at: expect.any(Number) },
      },
    ]);

    // A emits 'x.record' with a payload FORGING producer: 'test.eventsb'.
    await tools.get('eventsA.emitRecord')!.call({});

    const deadlineRecord = Date.now() + 10_000;
    let recordsSeen: unknown[] = [];
    // eslint-disable-next-line no-await-in-loop
    while (Date.now() < deadlineRecord) {
      // eslint-disable-next-line no-await-in-loop
      const res = (await tools.get('eventsB.getRecords')!.call({})) as {
        records: unknown[];
      };
      recordsSeen = res.records;
      if (recordsSeen.length > 0) break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => {
        setTimeout(r, 200);
      });
    }
    // B observes meta.from === 'test.eventsa' — the host's own record of
    // who really called emit() — NOT the payload's forged 'producer' claim.
    expect(recordsSeen).toEqual([
      {
        payload: { producer: 'test.eventsb' },
        meta: { from: 'test.eventsa', at: expect.any(Number) },
      },
    ]);
  });
});

const FIXTURE_INFERENCE = path.join(__dirname, 'fixtures', 'ext-inference');

// Issue #107: a fixture extension in a REAL forked child calls
// host.inference.complete/describe. Both LaneClosedError and
// ModelChangedError have to survive `extension-rpc.ts`/`transport.ts` and
// still be discriminable by NAME (never `instanceof` — class identity does
// not survive the fork) once the rejection reaches this process.
describe('extension runtime e2e — lane and model-identity errors across the RPC boundary (#107)', () => {
  let tmp: string;
  let store: CoreStore;
  let platform: ExtensionPlatform;
  const registry = new Map<string, Source>();
  const senderRegistry = new Map<string, Sender>();
  const tools = new Map<string, McpTool>();

  // Fake plane state, mutated directly by the tests below — stands in for
  // the real InferencePlane (covered elsewhere: src/main/core/__tests__/
  // inference.test.ts). What this describe block proves is orthogonal:
  // that whatever the plane throws still reads correctly on the far side
  // of a real process fork.
  let backgroundOpen = true;
  let generation = 1;
  const modelId = 'fake-model-a';

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kia-e2e-inference-'));
    store = openStore(await openDb(path.join(tmp, 'kiagent.db')), {
      encrypt: (s) => Buffer.from(s, 'utf8'),
      decrypt: (b) => b.toString('utf8'),
      detectLanguages: () => [],
    });
    platform = createExtensionPlatform({
      extDir: path.join(tmp, 'extensions'),
      store,
      sources: {
        register: (s) => void registry.set(s.descriptor.id, s),
        get: (id) => registry.get(id),
        list: () => [...registry.values()].map((s) => s.descriptor),
        unregister: (id) => void registry.delete(id),
      },
      senders: {
        register: (id, s) => void senderRegistry.set(id, s),
        get: (id) => senderRegistry.get(id),
        ids: () => [...senderRegistry.keys()],
        unregister: (id) => void senderRegistry.delete(id),
      },
      scheduler: {
        register: jest.fn(),
        unregister: jest.fn(),
        jobs: jest.fn(async () => []),
        trigger: jest.fn(),
        env: {},
      } as never,
      registerTool: (t) => {
        tools.set(t.name, t);
        return () => tools.delete(t.name);
      },
      inference: {
        complete: async (
          prompt: string,
          opts?: { lane?: string; generation?: number },
        ) => {
          if (opts?.lane === 'background' && !backgroundOpen) {
            throw new LaneClosedError();
          }
          if (
            opts?.generation !== undefined &&
            opts.generation !== generation
          ) {
            throw new ModelChangedError(
              opts.generation,
              generation,
              modelId,
              'generation',
            );
          }
          return 'ok';
        },
        see: async () => '',
        read: async () => '',
        hear: async () => '',
        describe: async () => ({ providerId: 'fake', modelId, generation }),
      } as never,
      laneState: () => 'open',
      onLaneChange: () => () => {},
      logSink: {
        log: (...a) => process.stderr.write(`${JSON.stringify(a)}\n`),
      },
      notify: () => {},
      transportFactory: () =>
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
        }),
      onChange: () => {},
      hostTimeouts: { readyTimeoutMs: 180_000, activateTimeoutMs: 180_000 },
    });
    await platform.start();
    // Plain imperative checks, not `expect` — this setup runs in beforeAll,
    // shared by both `it`s below, and `jest/no-standalone-expect` rightly
    // forbids assertions outside a test block. A malformed install here
    // throws, which fails both tests loudly rather than silently.
    const preview = (await platform.installPreview(FIXTURE_INFERENCE)) as {
      ok: boolean;
      id?: string;
      token?: string;
    };
    if (!preview.ok || preview.id !== 'test.inference') {
      throw new Error(
        `fixture install preview failed: ${JSON.stringify(preview)}`,
      );
    }
    const commit = await platform.installCommit(preview.token!);
    if (!commit.ok || commit.id !== 'test.inference') {
      throw new Error(
        `fixture install commit failed: ${JSON.stringify(commit)}`,
      );
    }
  });

  afterAll(async () => {
    await platform.stop();
    await store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('delivers LaneClosedError to a forked extension', async () => {
    backgroundOpen = false;
    await expect(
      tools.get('infTest.completeBackground')!.call({}),
    ).rejects.toMatchObject({
      name: 'LaneClosedError',
    });
    backgroundOpen = true;
  });

  it('delivers ModelChangedError to a forked extension', async () => {
    const described = (await tools
      .get('infTest.describeComplete')!
      .call({})) as { providerId: string; modelId: string; generation: number };
    expect(described).toEqual({
      providerId: 'fake',
      modelId,
      generation,
    });

    // The model moves on underneath the caller, between describe() and the
    // eventual complete() — exactly the window ModelChangedError exists to
    // catch.
    generation += 1;

    await expect(
      tools
        .get('infTest.completeWithGeneration')!
        .call({ generation: described.generation }),
    ).rejects.toMatchObject({
      name: 'ModelChangedError',
      expected: described.generation,
      actual: generation,
      modelId,
      source: 'generation',
    });
  });
});
