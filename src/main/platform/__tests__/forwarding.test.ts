/** @jest-environment node */
/** Step 3 Task 1: `callUi` is the one forwarding point (alpha-cent spec 7.8). */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { openDb } from '@main/db/app-db';
import { openStore, type CoreStore } from '@main/core/store/store';
import type { SyncService } from '@main/core/sync/service';

import { createExtensionPlatform, type ExtensionPlatform } from '../extension-platform';
import { runExtensionHost } from '../extension-host-entry';
import { createInMemoryHostPair } from '../transport';

jest.setTimeout(120_000);
const FIXTURE = path.join(__dirname, 'fixtures', 'ext-fwd');

/** The members `callUi` and `forwardCore` read, typed against the real service. */
type PlatformSync = Pick<SyncService, 'readOnly' | 'forward' | 'enqueue' | 'onApplied'>;
type FakeSync = {
  [K in keyof PlatformSync]: jest.Mock<ReturnType<PlatformSync[K]>, Parameters<PlatformSync[K]>>;
};

const build = (tmp: string, store: CoreStore, sync: FakeSync, fixture = FIXTURE, id = 'test.fwd') => {
  fs.cpSync(fixture, path.join(tmp, 'bundled', id), { recursive: true });
  return createExtensionPlatform({
    extDir: path.join(tmp, 'extensions'),
    bundledDir: path.join(tmp, 'bundled'),
    store,
    attention: {} as never,
    // The platform's dep is the whole service; the fake carries what it reads.
    sync: sync as unknown as SyncService,
    sources: { register: () => {}, get: () => undefined, list: () => [], unregister: () => {} },
    senders: { register: () => {}, get: () => undefined, ids: () => [], unregister: () => {} },
    scheduler: {
      register: jest.fn(),
      unregister: jest.fn(),
      jobs: jest.fn(async () => []),
      trigger: jest.fn(),
      env: {},
    } as never,
    registerTool: () => () => {},
    inference: { complete: async () => '', see: async () => '', read: async () => '', hear: async () => '' },
    laneState: () => 'open',
    logSink: { log: () => {} },
    notify: () => {},
    transportFactory: () => {
      const pair = createInMemoryHostPair();
      runExtensionHost(pair.child, {
        // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require, import/no-dynamic-require
        requireModule: (p: string) => require(p),
        exit: (code) => pair.simulateExit(code),
      });
      return pair.main;
    },
    onChange: () => {},
    hostTimeouts: { readyTimeoutMs: 60_000, activateTimeoutMs: 60_000 },
  } as never);
};

describe('forwarding through callUi', () => {
  let tmp: string;
  let store: CoreStore;
  let platform: ExtensionPlatform;
  const sync: FakeSync = { readOnly: jest.fn(), forward: jest.fn(), enqueue: jest.fn(), onApplied: jest.fn() };

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kia-fwd-'));
    store = openStore(await openDb(path.join(tmp, 'kiagent.db')), {
      encrypt: (s) => Buffer.from(s, 'utf8'),
      decrypt: (b) => b.toString('utf8'),
      detectLanguages: () => [],
    });
    platform = build(tmp, store, sync);
    await platform.start();
    if (platform.snapshot().find((e) => e.id === 'test.fwd')?.status !== 'activated')
      throw new Error('fixture did not activate');
  });
  afterAll(async () => {
    await platform.stop();
    await store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  beforeEach(() => {
    sync.readOnly.mockReset().mockReturnValue(false);
    sync.forward.mockReset();
    sync.enqueue.mockReset();
  });
  const calls = async () => (await platform.callUi('test.fwd', 'calls', null)) as { ok: true; value: unknown[] };

  it('master runs a declared name locally', async () => {
    await expect(platform.callUi('test.fwd', 'save', { id: 1 })).resolves.toEqual({
      ok: true,
      value: { saved: { id: 1 } },
    });
    expect(sync.forward).not.toHaveBeenCalled();
  });

  it('follower forwards a declared name and returns the master value', async () => {
    sync.readOnly.mockReturnValue(true);
    sync.forward.mockResolvedValue({ ok: true, value: { saved: 'by master' } });
    const before = (await calls()).value.length;
    await expect(platform.callUi('test.fwd', 'save', { id: 2 })).resolves.toEqual({
      ok: true,
      value: { saved: 'by master' },
    });
    expect(sync.forward).toHaveBeenCalledWith({
      kind: 'ui',
      extensionId: 'test.fwd',
      name: 'save',
      payload: { id: 2 },
    });
    // The local handler did not run.
    sync.readOnly.mockReturnValue(false);
    expect((await calls()).value.length).toBe(before);
  });

  it('follower runs an undeclared name locally', async () => {
    sync.readOnly.mockReturnValue(true);
    await expect(platform.callUi('test.fwd', 'plain', 3)).resolves.toEqual({ ok: true, value: { plain: 3 } });
    expect(sync.forward).not.toHaveBeenCalled();
  });

  it('no leader: EXT_SYNC_NO_MASTER, and no handler ran', async () => {
    sync.readOnly.mockReturnValue(true);
    sync.forward.mockResolvedValue({ ok: false, code: 'no-master', message: 'no leader' });
    const before = (await calls()).value.length;
    const r = await platform.callUi('test.fwd', 'save', { id: 4 });
    expect(r).toMatchObject({ ok: false, code: 'EXT_SYNC_NO_MASTER' });
    sync.readOnly.mockReturnValue(false);
    expect((await calls()).value.length).toBe(before);
  });

  it('a handler failure on the leader is EXT_HANDLER_FAILED with its message', async () => {
    sync.readOnly.mockReturnValue(true);
    sync.forward.mockResolvedValue({ ok: false, code: 'handler', message: 'bad label' });
    await expect(platform.callUi('test.fwd', 'save', {})).resolves.toEqual({
      ok: false,
      code: 'EXT_HANDLER_FAILED',
      message: 'bad label',
    });
  });

  it('a deliver name on a follower is queued, not refused', async () => {
    sync.readOnly.mockReturnValue(true);
    await expect(platform.callUi('test.fwd', 'import', { m: 1 })).resolves.toEqual({
      ok: true,
      value: { queued: true },
    });
    expect(sync.enqueue).toHaveBeenCalledWith({
      kind: 'ui',
      extensionId: 'test.fwd',
      name: 'import',
      payload: { m: 1 },
    });
    expect(sync.forward).not.toHaveBeenCalled();
  });

  it('a deliver name on the master runs locally', async () => {
    await expect(platform.callUi('test.fwd', 'import', { m: 2 })).resolves.toEqual({
      ok: true,
      value: { imported: { m: 2 } },
    });
    expect(sync.enqueue).not.toHaveBeenCalled();
  });

  it('host.ui.call goes through callUi, so it forwards', async () => {
    sync.readOnly.mockReturnValue(true);
    sync.forward.mockResolvedValue({ ok: true, value: 'remote' });
    await expect(platform.callUi('test.fwd', 'viaCall', { id: 5 })).resolves.toEqual({
      ok: true,
      value: { viaCall: 'remote' },
    });
    expect(sync.forward).toHaveBeenCalledTimes(1);
  });
});

describe('activation checks the sync names', () => {
  it('a sync name with no registered handler errors the extension', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kia-fwd-bad-'));
    const bad = path.join(tmp, 'fixture');
    fs.cpSync(FIXTURE, bad, { recursive: true });
    const m = JSON.parse(fs.readFileSync(path.join(bad, 'manifest.json'), 'utf8'));
    m.sync = { forward: ['save', 'ghost'] };
    fs.writeFileSync(path.join(bad, 'manifest.json'), JSON.stringify(m));
    const store = openStore(await openDb(path.join(tmp, 'kiagent.db')), {
      encrypt: (s) => Buffer.from(s, 'utf8'),
      decrypt: (b) => b.toString('utf8'),
      detectLanguages: () => [],
    });
    const platform = build(tmp, store, { readOnly: jest.fn(), forward: jest.fn(), enqueue: jest.fn(), onApplied: jest.fn() }, bad);
    try {
      await platform.start();
      const snap = platform.snapshot().find((e) => e.id === 'test.fwd');
      expect(snap?.status).toBe('errored');
      expect(snap?.error).toMatch(/ghost/);
    } finally {
      await platform.stop();
      await store.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
