/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { openDb } from '@main/db/app-db';
import { openStore, type CoreStore } from '@main/core/store/store';

import { SYNC_SURFACE_METHODS } from '@shared/contracts';
import { PLATFORM_API_VERSION } from '@shared/extension-rpc';

import {
  createExtensionPlatform,
  type ExtensionPlatform,
} from '../extension-platform';
import { parseManifest } from '../manifest';
import { nodeForkTransport } from '../transport';

jest.setTimeout(240_000);
const LEASE = {
  isMaster: true,
  reason: 'holder',
  multiDevice: true,
  approved: true,
  holder: 'dev',
  epoch: 2,
  priorRenewedAt: null,
};
const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CHILD_ENTRY = path.resolve(__dirname, '../extension-host-entry.ts');
const FIXTURE = path.join(__dirname, 'fixtures', 'ext-sync');

const manifest = JSON.parse(
  fs.readFileSync(path.join(FIXTURE, 'manifest.json'), 'utf8'),
);

it('the platform API is 2.19.0: 2.18.0 added the join methods, 2.19.0 the queued-settings methods', () => {
  expect(PLATFORM_API_VERSION).toBe('2.19.0');
});

it('a marketplace extension declaring sync is refused, a bundled one is accepted', () => {
  expect(() => parseManifest(manifest, { tier: 'external' })).toThrow(
    /only extensions bundled/,
  );
  expect(parseManifest(manifest, { tier: 'bundled' }).caps).toContain('sync');
});

describe('through a real forked extension host', () => {
  let tmp: string;
  let store: CoreStore;
  let platform: ExtensionPlatform;
  const seen: Record<string, unknown[]> = {};
  const note =
    <T>(m: string, r: T) =>
    (...args: unknown[]) => {
      seen[m] = args;
      return Promise.resolve(r);
    };

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kia-sync-e2e-'));
    const bundled = path.join(tmp, 'bundled');
    fs.cpSync(FIXTURE, path.join(bundled, 'test.sync'), { recursive: true });
    process.env.KIA_SYNC_FIXTURE_OUT = path.join(tmp, 'calls.json');
    store = openStore(await openDb(path.join(tmp, 'kiagent.db')), {
      encrypt: (s) => Buffer.from(s, 'utf8'),
      decrypt: (b) => b.toString('utf8'),
      detectLanguages: () => [],
    });
    platform = createExtensionPlatform({
      extDir: path.join(tmp, 'extensions'),
      bundledDir: bundled,
      store,
      attention: {} as never,
      sync: {
        status: note('status', { role: 'normal' }),
        buildDelta: note('buildDelta', { status: 'too-large' }),
        buildSnapshot: note('buildSnapshot', { bytes: 1 }),
        applyDelta: note('applyDelta', { applied: 2 }),
        prepareSwap: note('prepareSwap', 'ready'),
        prepareRestore: note('prepareRestore', 'no-archive'),
        setDeviceId: note('setDeviceId', undefined),
        beginJoin: note('beginJoin', undefined),
        exportSources: note('exportSources', [{ source: 'gmail' }]),
        hasMoveableLogins: note('hasMoveableLogins', true),
        exportSettings: note('exportSettings', {
          prefs: { 'a.b': 1 },
          extensions: {},
        }),
        importSettings: note('importSettings', {
          prefs: ['a.b'],
          extensions: [],
        }),
        finishJoin: note('finishJoin', undefined),
        leaveJoin: note('leaveJoin', undefined),
        forgetMoved: note('forgetMoved', undefined),
        canAcceptSources: note('canAcceptSources', true),
        importSources: note('importSources', {
          created: ['a'],
          existing: [],
          needsConnector: [],
        }),
        isBusy: note('isBusy', null),
        exportSecrets: note('exportSecrets', [
          { accountId: 'a', epoch: 1, n: 3, value: null },
        ]),
        importSecrets: note('importSecrets', { applied: 1 }),
        setLease: note('setLease', undefined),
        lead: note('lead', undefined),
        open: note('open', undefined),
        demote: note('demote', undefined),
        readOnly: note('readOnly', true),
        deleteArchive: note('deleteArchive', undefined),
        queuedSettings: note('queuedSettings', [
          { rowId: 3, key: 'core.theme', value: 'dark', stuck: false },
        ]),
        discardQueued: note('discardQueued', undefined),
        setDeviceNames: note('setDeviceNames', undefined),
        setForwarder: note('setForwarder', undefined),
        runForwarded: note('runForwarded', { ok: true }),
        drainOutbound: note('drainOutbound', { sent: 0, waiting: 0 }),
        retained: note('retained', ['x']),
        close: async () => undefined,
      } as never,
      sources: {
        register: () => {},
        get: () => undefined,
        list: () => [],
        unregister: () => {},
      },
      senders: {
        register: () => {},
        get: () => undefined,
        ids: () => [],
        unregister: () => {},
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
      onChange: () => {},
      hostTimeouts: { readyTimeoutMs: 180_000, activateTimeoutMs: 180_000 },
    } as never);
    await platform.start();
  });

  afterAll(async () => {
    await platform.stop();
    await store.close();
    delete process.env.KIA_SYNC_FIXTURE_OUT;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('every method reaches the service from an activated extension', async () => {
    const out = process.env.KIA_SYNC_FIXTURE_OUT!;
    for (let i = 0; i < 1800 && !fs.existsSync(out); i += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(JSON.parse(fs.readFileSync(out, 'utf8'))).toMatchObject({
      status: { role: 'normal' },
      buildDelta: { status: 'too-large' },
      applyDelta: { applied: 2 },
      prepareSwap: 'ready',
      exportSources: [{ source: 'gmail' }],
      exportSettings: { prefs: { 'a.b': 1 }, extensions: {} },
      importSettings: { prefs: ['a.b'], extensions: [] },
      importSources: { created: ['a'], existing: [], needsConnector: [] },
      canAcceptSources: true,
      hasMoveableLogins: true,
      exportSecrets: [{ accountId: 'a', epoch: 1, n: 3, value: null }],
      importSecrets: { applied: 1 },
      readOnly: true,
      queuedSettings: [
        { rowId: 3, key: 'core.theme', value: 'dark', stuck: false },
      ],
    });
    // onQueueChange and enqueue are core-internal: no extension can reach them.
    expect(seen.discardQueued).toEqual([7]);
    expect(seen.applyDelta).toEqual(['stage', { pullStartedAt: 5 }]);
    expect(seen.setLease).toEqual([LEASE]);
    expect(seen.lead).toEqual([{ epoch: 2 }]);
    expect(seen.open).toEqual(['head-acked']);
    expect(seen.demote).toEqual(['m1']);
    expect(seen.exportSecrets).toEqual([{ epoch: 1, n: 2 }]);
    expect(seen.importSources).toEqual(['offer', [], 'from']);
    expect(seen.importSettings).toEqual([
      'offer',
      { prefs: { 'a.b': 1 }, extensions: {} },
    ]);
    expect(seen.buildDelta).toEqual([{ seq: 1, cursor: 2 }, 'out', 5, 3]);
    expect(seen.prepareSwap).toEqual(['f', 'h', 'm']);
    expect(Object.keys(seen).sort()).toEqual([...SYNC_SURFACE_METHODS].sort());
  });
});
