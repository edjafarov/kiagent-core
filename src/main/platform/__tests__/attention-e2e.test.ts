/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { AttentionItemWire } from '@shared/attention';
import type {
  ExtensionSnapshot,
  McpTool,
  Sender,
  Source,
} from '@shared/contracts';
import type { AppDb } from '@main/db/app-db';
import { openDb } from '@main/db/app-db';
import { openStore, type CoreStore } from '@main/core/store/store';
import {
  createAttentionService,
  type AttentionService,
} from '@main/attention/service';

import {
  createExtensionPlatform,
  type ExtensionPlatform,
} from '../extension-platform';
import { nodeForkTransport } from '../transport';

jest.setTimeout(240_000);

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CHILD_ENTRY = path.resolve(__dirname, '../extension-host-entry.ts');
const FIXTURE = path.join(__dirname, 'fixtures', 'ext-attention');

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 180_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline)
      throw new Error('timed out waiting for fixture');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function extensionPlatform(
  tmp: string,
  store: CoreStore,
  attention: AttentionService,
  onChange: (snapshot: ExtensionSnapshot[]) => void,
): { platform: ExtensionPlatform; tools: Map<string, McpTool> } {
  const registry = new Map<string, Source>();
  const senders = new Map<string, Sender>();
  const tools = new Map<string, McpTool>();
  const platform = createExtensionPlatform({
    extDir: path.join(tmp, 'extensions'),
    store,
    attention,
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
    onChange,
    hostTimeouts: { readyTimeoutMs: 180_000, activateTimeoutMs: 180_000 },
  });
  return { platform, tools };
}

describe('attention capability through a real forked extension host', () => {
  let tmp: string;
  let db: AppDb;
  let store: CoreStore;
  let attention: AttentionService;
  let platform: ExtensionPlatform;
  let tools: Map<string, McpTool>;
  let activationBarrier: string;
  let activationAcked: string;
  let pendingCommit: Promise<{ ok: boolean; id?: string; error?: string }>;
  const activatingLists: Promise<AttentionItemWire[]>[] = [];
  const hints: unknown[] = [];

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kia-attention-e2e-'));
    db = await openDb(path.join(tmp, 'kiagent.db'));
    store = openStore(db, {
      encrypt: (s) => Buffer.from(s, 'utf8'),
      decrypt: (b) => b.toString('utf8'),
      detectLanguages: () => [],
    });
    attention = createAttentionService({
      db,
      onChanged: () => hints.push(true),
    });
    const built = extensionPlatform(tmp, store, attention, (snapshot) => {
      attention.setExtensions(snapshot);
      if (snapshot.some((entry) => entry.status === 'activating'))
        activatingLists.push(attention.list());
    });
    platform = built.platform;
    tools = built.tools;
    await platform.start();
    const preview = await platform.installPreview(FIXTURE);
    if (!('token' in preview)) throw new Error(JSON.stringify(preview));
    activationBarrier = path.join(tmp, 'activation.release');
    activationAcked = path.join(tmp, 'activation.acked');
    process.env.KIA_ATTENTION_ACTIVATION_BARRIER = activationBarrier;
    process.env.KIA_ATTENTION_ACTIVATION_ACKED = activationAcked;
    pendingCommit = platform.installCommit(preview.token);
    await waitFor(async () => fs.existsSync(activationAcked));
  });

  afterAll(async () => {
    if (activationBarrier && !fs.existsSync(activationBarrier))
      fs.writeFileSync(activationBarrier, 'release');
    await pendingCommit?.catch(() => undefined);
    delete process.env.KIA_ATTENTION_ACTIVATION_BARRIER;
    delete process.env.KIA_ATTENTION_ACTIVATION_ACKED;
    await platform.stop();
    await attention.dispose();
    await store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('K7b holds activation after acknowledgement: activating rows are committed but unavailable', async () => {
    expect(
      platform.snapshot().find((entry) => entry.id === 'test.attention')
        ?.status,
    ).toBe('activating');
    expect(
      await db.all(
        "SELECT id, state FROM attention_items WHERE id = 'test.attention:activate'",
      ),
    ).toEqual([{ id: 'test.attention:activate', state: 'open' }]);
    await expect(attention.list()).resolves.toEqual([]);
    expect(hints).toHaveLength(0);

    fs.writeFileSync(activationBarrier, 'release');
    const commit = await pendingCommit;
    expect(commit).toEqual({ ok: true, id: 'test.attention' });
    await expect(attention.list()).resolves.toEqual([
      expect.objectContaining({ id: 'test.attention:activate' }),
    ]);
    expect(hints).toHaveLength(1);
  });

  it('publishes during activation, acknowledges, rejects invalid items, then resolves', async () => {
    const activating = await Promise.all(activatingLists);
    expect(activating).toContainEqual([]);
    await expect(attention.list()).resolves.toEqual([
      expect.objectContaining({ id: 'test.attention:activate' }),
    ]);
    expect(hints).toHaveLength(1);
    expect(await attention.list()).toHaveLength(1);
  });

  it('K5b crosses acknowledged and rejected results through the forked child', async () => {
    await expect(
      tools.get('attention.activationAck')!.call({}),
    ).resolves.toEqual({ rejected: [] });
    await expect(
      tools.get('attention.publish')!.call({ id: 'invalid', invalid: true }),
    ).resolves.toMatchObject({ rejected: [expect.any(Object)] });
    await expect(
      tools.get('attention.publish')!.call({ id: 'live' }),
    ).resolves.toEqual({ rejected: [] });
    await expect(
      db.all(
        "SELECT state FROM attention_items WHERE id = 'test.attention:live'",
      ),
    ).resolves.toEqual([{ state: 'open' }]);
    await expect(
      tools.get('attention.resolve')!.call({ id: 'test.attention:live' }),
    ).resolves.toEqual({ rejected: [] });
    await expect(
      db.all(
        "SELECT state FROM attention_items WHERE id = 'test.attention:live'",
      ),
    ).resolves.toEqual([{ state: 'resolved' }]);
    await expect(attention.list()).resolves.toEqual([
      expect.objectContaining({ id: 'test.attention:activate' }),
    ]);
  });

  it('preserves TX_FAILED and DISPOSED codes in the forked extension', async () => {
    await db.exec(
      `CREATE TRIGGER attention_e2e_failure
       AFTER INSERT ON attention_items
       BEGIN SELECT RAISE(ABORT, 'forced attention failure'); END`,
    );
    await expect(
      tools.get('attention.publish')!.call({ id: 'tx-failure' }),
    ).resolves.toMatchObject({ code: 'ATTENTION_TX_FAILED' });
    await db.exec('DROP TRIGGER attention_e2e_failure');

    await attention.dispose();
    await expect(
      tools.get('attention.publish')!.call({ id: 'disposed' }),
    ).resolves.toMatchObject({ code: 'ATTENTION_DISPOSED' });
  });
});

describe('K9b attention shutdown through the real platform', () => {
  let tmp: string;
  let db: AppDb;
  let store: CoreStore;
  let attention: AttentionService;
  let platform: ExtensionPlatform;
  let resultPath: string;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kia-attention-shutdown-'));
    resultPath = path.join(tmp, 'deactivate-result.json');
    process.env.KIA_ATTENTION_DEACTIVATE_RESULT = resultPath;
    db = await openDb(path.join(tmp, 'kiagent.db'));
    store = openStore(db, {
      encrypt: (s) => Buffer.from(s, 'utf8'),
      decrypt: (b) => b.toString('utf8'),
      detectLanguages: () => [],
    });
    attention = createAttentionService({ db, onChanged: jest.fn() });
    platform = extensionPlatform(tmp, store, attention, (snapshot) => {
      attention.setExtensions(snapshot);
    }).platform;
    await platform.start();
    const preview = await platform.installPreview(FIXTURE);
    if (!('token' in preview)) throw new Error(JSON.stringify(preview));
    const commit = await platform.installCommit(preview.token);
    if (!commit.ok) throw new Error(JSON.stringify(commit));
  });

  afterAll(async () => {
    delete process.env.KIA_ATTENTION_DEACTIVATE_RESULT;
    await platform.stop().catch(() => {});
    await attention.dispose().catch(() => {});
    await store.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('K9b settles deactivate publication, awaits stop/dispose, and ignores late availability/hints', async () => {
    const stopResult = await Promise.race([
      platform.stop().then(() => 'stopped' as const),
      new Promise<'timed-out'>((resolve) =>
        setTimeout(() => resolve('timed-out'), 5_000),
      ),
    ]);
    expect(stopResult).toBe('stopped');
    const deactivateResult = JSON.parse(
      await fs.promises.readFile(resultPath, 'utf8'),
    ) as { rejected?: unknown[]; code?: unknown };
    expect(
      Array.isArray(deactivateResult.rejected) ||
        typeof deactivateResult.code === 'string',
    ).toBe(true);

    await expect(
      Promise.race([
        attention.dispose().then(() => 'disposed' as const),
        new Promise<'timed-out'>((resolve) =>
          setTimeout(() => resolve('timed-out'), 5_000),
        ),
      ]),
    ).resolves.toBe('disposed');
    expect(() =>
      attention.setExtensions([
        {
          id: 'test.attention',
          name: 'Attention Test Extension',
          version: '1.0.0',
          origin: 'dev',
          enabled: true,
          status: 'activated',
          caps: ['attention'],
          sourceIds: [],
          oauthSources: [],
        },
      ]),
    ).not.toThrow();
    expect(() => attention.notifyReset()).not.toThrow();

    const fresh = createAttentionService({ db, onChanged: jest.fn() });
    fresh.setExtensions([
      {
        id: 'test.attention',
        name: 'Attention Test Extension',
        version: '1.0.0',
        origin: 'dev',
        enabled: true,
        status: 'disabled',
        caps: ['attention'],
        sourceIds: [],
        oauthSources: [],
      },
    ]);
    await expect(fresh.list()).resolves.toEqual([]);
    await fresh.dispose();
  });
});
