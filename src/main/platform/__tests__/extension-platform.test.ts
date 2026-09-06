/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type {
  ExtensionSnapshot,
  LaneState,
  McpTool,
  Sender,
  Source,
} from '@shared/contracts';

import { openDb } from '@main/db/app-db';
import { openStore, type CoreStore } from '@main/core/store/store';

import { googleOAuthProfile, googleRefresher } from '@main/sources/gmail/oauth';

import {
  createExtensionPlatform,
  createLaneGate,
  type ExtensionPlatform,
  type ExtensionPlatformDeps,
} from '../extension-platform';
import { runExtensionHost } from '../extension-host-entry';
import { createInMemoryHostPair } from '../transport';

const FIXTURE = path.join(__dirname, 'fixtures', 'ext-basic');
const FIXTURE_UNDECLARED = path.join(
  __dirname,
  'fixtures',
  'ext-undeclared-source',
);
const FIXTURE_OAUTH = path.join(__dirname, 'fixtures', 'ext-oauth');
const FIXTURE_SENDER = path.join(__dirname, 'fixtures', 'ext-sender');
const FIXTURE_SENDER_NOCAP = path.join(
  __dirname,
  'fixtures',
  'ext-sender-nocap',
);
const FIXTURE_SENDER_UNDECLARED = path.join(
  __dirname,
  'fixtures',
  'ext-sender-undeclared',
);
const FIXTURE_EVENTS_A = path.join(__dirname, 'fixtures', 'ext-events-a');
const FIXTURE_EVENTS_B = path.join(__dirname, 'fixtures', 'ext-events-b');

describe('createLaneGate', () => {
  it('closed -> open emits once, with the resolved state in the payload', () => {
    const emit = jest.fn();
    let state: LaneState = 'disabled';
    const gate = createLaneGate(
      () => state,
      emit,
      () => {},
    );
    gate.check(); // baseline: null -> 'disabled', not the transition under test
    emit.mockClear();

    state = 'open';
    gate.check();

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('open');
  });

  it("'battery' -> 'disabled' — both closed, so the boolean never flips — still emits once", () => {
    const emit = jest.fn();
    let state: LaneState = 'battery';
    const gate = createLaneGate(
      () => state,
      emit,
      () => {},
    );
    gate.check(); // baseline
    emit.mockClear();

    state = 'disabled';
    gate.check();

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('disabled');
  });

  it('the same resolved state re-resolved on a later tick emits nothing', () => {
    const emit = jest.fn();
    const gate = createLaneGate(
      () => 'open',
      emit,
      () => {},
    );
    gate.check();
    emit.mockClear();

    gate.check();
    gate.check();

    expect(emit).not.toHaveBeenCalled();
  });

  it('an emit that throws does not propagate out of the tick', () => {
    const onError = jest.fn();
    let state: LaneState = 'open';
    const emit = jest.fn(() => {
      throw new Error('boom');
    });
    const gate = createLaneGate(() => state, emit, onError);

    expect(() => gate.check()).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);

    // The gate is not wedged by the throw: a later real transition is
    // still attempted (and, this time, succeeds) rather than being
    // silently skipped because the failed attempt never updated `last`.
    emit.mockReset();
    state = 'disabled';
    gate.check();
    expect(emit).toHaveBeenCalledWith('disabled');
  });
});

describe('createExtensionPlatform', () => {
  let tmp: string;
  let store: CoreStore;
  let platform: ExtensionPlatform;
  let snapshots: ExtensionSnapshot[][];
  let registry: Map<string, Source>;
  // The SenderRegistry fake — same role `registry` plays for sources: the
  // real one lives on CorePlatform (boot.ts) and is a plain Map behind the
  // same four methods, so asserting on this map is asserting on what the
  // platform registered.
  let senderRegistry: Map<string, Sender>;
  let tools: Map<string, McpTool>;
  // Proxy for the internal 'extension.activated' bus emit: registerContributions()
  // calls registerTool() for the fixture's one tool and unconditionally
  // bus.emit()s 'extension.activated' right after — the two happen exactly
  // once per genuine, completed activation. The bus itself is an internal
  // (unexported) implementation detail of createExtensionPlatform, so this
  // count is how the tests observe it without reaching into private state.
  let activationsCount: number;
  // Captures logSink.log(scope, level, msg) calls — used to assert the
  // undeclared-source warn (F6) without reaching into private state.
  let logs: Array<{ scope: string; level: string; msg: string }>;

  function makePlatform(
    overrides?: Partial<ExtensionPlatformDeps>,
  ): ExtensionPlatform {
    return createExtensionPlatform({
      extDir: path.join(tmp, 'extensions'),
      store,
      sources: {
        register: (s: Source) => void registry.set(s.descriptor.id, s),
        get: (id: string) => registry.get(id),
        list: () => [...registry.values()].map((s) => s.descriptor),
        unregister: (id: string) => void registry.delete(id),
      },
      senders: {
        register: (id: string, s: Sender) => void senderRegistry.set(id, s),
        get: (id: string) => senderRegistry.get(id),
        ids: () => [...senderRegistry.keys()],
        unregister: (id: string) => void senderRegistry.delete(id),
      },
      scheduler: {
        register: jest.fn(),
        unregister: jest.fn(),
        jobs: jest.fn(async () => []),
        trigger: jest.fn(),
        env: {},
      } as never,
      registerTool: (t) => {
        activationsCount += 1;
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
        log: (scope: string, level: string, msg: string) =>
          logs.push({ scope, level, msg }),
      } as never,
      notify: jest.fn(),
      // In-process "fork": the real child runtime over the in-memory pair,
      // loading the fixture with jest's own require.
      transportFactory: () => {
        const pair = createInMemoryHostPair();
        runExtensionHost(pair.child, { exit: (c) => pair.simulateExit(c) });
        return pair.main;
      },
      onChange: (snap) => snapshots.push(snap),
      ...overrides,
    });
  }

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kia-extplat-'));
    store = openStore(await openDb(path.join(tmp, 'kiagent.db')), {
      encrypt: (s) => Buffer.from(s, 'utf8'),
      decrypt: (b) => b.toString('utf8'),
      detectLanguages: () => [],
    });
    snapshots = [];
    registry = new Map();
    senderRegistry = new Map();
    tools = new Map();
    activationsCount = 0;
    logs = [];
    platform = makePlatform();
  });

  afterEach(async () => {
    await platform.stop();
    await store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function installFixture(): Promise<string> {
    const preview = await platform.installPreview(FIXTURE);
    if (!('token' in preview))
      throw new Error(`preview failed: ${JSON.stringify(preview)}`);
    expect(preview.caps).toEqual(['net']);
    const commit = await platform.installCommit(preview.token);
    expect(commit).toEqual({ ok: true, id: 'test.basic' });
    return preview.token;
  }

  it('install → consent recorded → activated: source + tool registered, snapshot correct', async () => {
    await platform.start(); // empty dir — no-op
    await installFixture();
    expect(registry.has('basicsrc')).toBe(true);
    expect(tools.has('basic_echo')).toBe(true);
    const consent = await store.consents.latest('test.basic' as never);
    expect(consent?.caps).toEqual(['net']);
    const last = snapshots.at(-1)!;
    expect(last).toEqual([
      expect.objectContaining({
        id: 'test.basic',
        status: 'activated',
        enabled: true,
        sourceIds: ['basicsrc'],
      }),
    ]);
  });

  it('installCommit on an already-active extension deactivates the running host before commit touches disk (F4)', async () => {
    await platform.start();
    await installFixture();
    expect(activationsCount).toBe(1);
    expect(registry.has('basicsrc')).toBe(true);

    // Re-install the SAME extension while its host is still live (an
    // update landing on a running extension). The id is known pre-commit
    // via installer.peek(); the whole [deactivate existing → commit →
    // consent → activate] sequence runs under one lock, deactivation
    // before commit touches disk.
    const preview2 = await platform.installPreview(FIXTURE);
    if (!('token' in preview2))
      throw new Error(`preview failed: ${JSON.stringify(preview2)}`);
    await expect(platform.installCommit(preview2.token)).resolves.toEqual({
      ok: true,
      id: 'test.basic',
    });

    // Exactly one entry, freshly re-activated (a second genuine activation
    // happened — the old host was torn down, not left running alongside).
    expect(activationsCount).toBe(2);
    expect(platform.snapshot()).toEqual([
      expect.objectContaining({
        id: 'test.basic',
        status: 'activated',
        enabled: true,
        sourceIds: ['basicsrc'],
      }),
    ]);
    expect(registry.has('basicsrc')).toBe(true);
    expect(tools.has('basic_echo')).toBe(true);
  });

  it('setEnabled(false) unregisters and persists; a restarted platform respects it', async () => {
    await platform.start();
    await installFixture();
    await expect(platform.setEnabled('test.basic', false)).resolves.toEqual({
      ok: true,
    });
    expect(registry.has('basicsrc')).toBe(false);
    expect(tools.has('basic_echo')).toBe(false);

    await platform.stop();
    registry.clear();
    platform = makePlatform();
    await platform.start();
    expect(platform.snapshot()).toEqual([
      expect.objectContaining({
        id: 'test.basic',
        status: 'disabled',
        enabled: false,
      }),
    ]);
    expect(registry.has('basicsrc')).toBe(false);
  });

  it('an installed extension with no consent parks in needs-consent at boot', async () => {
    await platform.start();
    await installFixture();
    await platform.stop();
    // Drop the consent history by swapping in a fresh DB (resetAll
    // deliberately preserves consents) — the install record lives on disk
    // in extDir, so the extension is still "installed" without a grant.
    await store.close();
    store = openStore(await openDb(path.join(tmp, 'kiagent-fresh.db')), {
      encrypt: (s) => Buffer.from(s, 'utf8'),
      decrypt: (b) => b.toString('utf8'),
      detectLanguages: () => [],
    });
    registry.clear();
    platform = makePlatform();
    await platform.start();
    expect(platform.snapshot()).toEqual([
      expect.objectContaining({ id: 'test.basic', status: 'needs-consent' }),
    ]);
    expect(registry.has('basicsrc')).toBe(false);
  });

  it('a hand-edited installed.json origin of "bundled" is clamped to "dev" — no auto-consent from a forged record', async () => {
    await platform.start();
    await installFixture();
    await platform.stop();
    // Drop the consent history exactly as the sibling test above does, so
    // the only path to 'activated' would be the bundled auto-consent
    // bypass (`e.origin !== 'bundled' && !(await consentCovers(...))`) —
    // proving that path is unreachable via a forged installed.json record.
    await store.close();
    store = openStore(await openDb(path.join(tmp, 'kiagent-fresh2.db')), {
      encrypt: (s) => Buffer.from(s, 'utf8'),
      decrypt: (b) => b.toString('utf8'),
      detectLanguages: () => [],
    });
    registry.clear();
    const installedPath = path.join(tmp, 'extensions', 'installed.json');
    const records = JSON.parse(fs.readFileSync(installedPath, 'utf8')) as Array<
      Record<string, unknown>
    >;
    records.forEach((r) => {
      r.origin = 'bundled';
    });
    fs.writeFileSync(installedPath, JSON.stringify(records, null, 2));
    platform = makePlatform();
    await platform.start();
    expect(platform.snapshot()).toEqual([
      expect.objectContaining({
        id: 'test.basic',
        origin: 'dev',
        status: 'needs-consent',
      }),
    ]);
    expect(registry.has('basicsrc')).toBe(false);
  });

  it('uninstall refuses while accounts exist, then removes everything', async () => {
    await platform.start();
    await installFixture();
    await store.createAccount({
      source: 'basicsrc',
      identifier: 'a',
      config: {},
      status: 'live',
    });
    await expect(platform.uninstall('test.basic')).resolves.toEqual({
      ok: false,
      error: "Remove this connector's sources before uninstalling it.",
    });
    const acct = (await store.read.accounts()).find(
      (a) => a.source === 'basicsrc',
    )!;
    await store.commit({ removeAccount: acct.id });
    await expect(platform.uninstall('test.basic')).resolves.toEqual({
      ok: true,
    });
    expect(fs.existsSync(path.join(tmp, 'extensions', 'test.basic'))).toBe(
      false,
    );
    expect(registry.has('basicsrc')).toBe(false);
    expect(platform.snapshot()).toEqual([]);
  });

  it('double setEnabled(true) does not orphan a second host: redundant and concurrent re-enables are no-ops', async () => {
    await platform.start();
    await installFixture();
    expect(activationsCount).toBe(1);
    expect(platform.snapshot()).toEqual([
      expect.objectContaining({
        id: 'test.basic',
        status: 'activated',
        enabled: true,
      }),
    ]);

    // Redundant enable while already activated (e.g. a UI double-click):
    // activate()'s idempotency guard must make this a pure no-op — no
    // second host, no second contribution registration/bus emit.
    await expect(platform.setEnabled('test.basic', true)).resolves.toEqual({
      ok: true,
    });
    expect(activationsCount).toBe(1);
    expect(platform.snapshot()).toEqual([
      expect.objectContaining({
        id: 'test.basic',
        status: 'activated',
        enabled: true,
      }),
    ]);

    // Deactivate, then fire two un-awaited setEnabled(true) calls back to
    // back — deliberately not awaiting the first before issuing the
    // second. Per JS's run-to-first-await semantics, activate()'s guard
    // check + host construction + `e.host = host` assignment all execute
    // synchronously (no await between them) as part of evaluating the
    // first call, so by the time the second call is issued on the very
    // next line, `e.host` is already reserved and its own activate() call
    // no-ops immediately. This is the same window the reviewer flagged:
    // against the pre-fix code (which awaited consentCovers() BEFORE
    // creating/assigning the host) both calls would race past the guard
    // and each spin up their own host, orphaning one.
    await platform.setEnabled('test.basic', false);
    expect(registry.has('basicsrc')).toBe(false);
    const p1 = platform.setEnabled('test.basic', true);
    const p2 = platform.setEnabled('test.basic', true);
    await expect(Promise.all([p1, p2])).resolves.toEqual([
      { ok: true },
      { ok: true },
    ]);

    // Exactly one genuine activation happened for this re-enable (total
    // across the whole test: 1 at install + 1 here = 2) — the concurrent
    // second call contributed zero.
    expect(activationsCount).toBe(2);
    expect(registry.has('basicsrc')).toBe(true);
    expect(tools.has('basic_echo')).toBe(true);
    expect(platform.snapshot()).toEqual([
      expect.objectContaining({
        id: 'test.basic',
        status: 'activated',
        enabled: true,
      }),
    ]);

    // Full teardown must be clean: no stray running host left un-stopped
    // behind the one that "won" the race.
    await expect(platform.setEnabled('test.basic', false)).resolves.toEqual({
      ok: true,
    });
    expect(registry.has('basicsrc')).toBe(false);
    await expect(platform.uninstall('test.basic')).resolves.toEqual({
      ok: true,
    });
    expect(platform.snapshot()).toEqual([]);
  });

  it('a manifest version bump without fresh consent parks back in needs-consent (updates always re-consent)', async () => {
    await platform.start();
    await installFixture();
    await platform.stop();

    const manifestPath = path.join(
      tmp,
      'extensions',
      'test.basic',
      'manifest.json',
    );
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    expect(manifest.caps).toEqual(['net']); // same caps as the original consent
    manifest.version = '1.0.1'; // bumped version — the old consent's manifestVersion no longer matches
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    registry.clear();
    platform = makePlatform();
    await platform.start();

    expect(platform.snapshot()).toEqual([
      expect.objectContaining({
        id: 'test.basic',
        status: 'needs-consent',
        version: '1.0.1',
        enabled: true,
      }),
    ]);
    expect(registry.has('basicsrc')).toBe(false);

    // Recording fresh consent for the bumped manifest — and only that —
    // restores activation on the next activation attempt.
    await store.consents.record({
      extensionId: 'test.basic',
      caps: manifest.caps,
      manifestVersion: manifest.version,
      grantedAt: new Date().toISOString(),
    } as never);
    await platform.setEnabled('test.basic', false);
    await expect(platform.setEnabled('test.basic', true)).resolves.toEqual({
      ok: true,
    });
    expect(platform.snapshot()).toEqual([
      expect.objectContaining({
        id: 'test.basic',
        status: 'activated',
        version: '1.0.1',
      }),
    ]);
    expect(registry.has('basicsrc')).toBe(true);
  });

  it('grant-consent records the on-disk manifest caps and activates a needs-consent extension', async () => {
    await platform.start(); // empty dir — no-op

    // 1. install-preview + install-commit the basic fixture -> status 'activated'
    await installFixture();
    expect(platform.snapshot()).toEqual([
      expect.objectContaining({
        id: 'test.basic',
        status: 'activated',
        enabled: true,
      }),
    ]);

    // 2. setEnabled(id, false)
    await expect(platform.setEnabled('test.basic', false)).resolves.toEqual({
      ok: true,
    });
    expect(platform.snapshot()).toEqual([
      expect.objectContaining({
        id: 'test.basic',
        status: 'disabled',
        enabled: false,
      }),
    ]);

    // 3. Record a stale consent row (latest-wins: this stale row no longer
    // covers the current on-disk manifest's version, so the next activation
    // attempt must park in needs-consent again).
    await store.consents.record({
      extensionId: 'test.basic',
      caps: [],
      manifestVersion: '0.0.0-stale',
      grantedAt: new Date().toISOString(),
    } as never);

    // 4. setEnabled(id, true) -> snapshot status 'needs-consent'
    await expect(platform.setEnabled('test.basic', true)).resolves.toEqual({
      ok: true,
    });
    expect(platform.snapshot()).toEqual([
      expect.objectContaining({
        id: 'test.basic',
        status: 'needs-consent',
        enabled: true,
      }),
    ]);
    expect(registry.has('basicsrc')).toBe(false);

    // 5. grantConsent(id) -> { ok: true }; snapshot status 'activated'
    await expect(platform.grantConsent('test.basic')).resolves.toEqual({
      ok: true,
    });
    expect(platform.snapshot()).toEqual([
      expect.objectContaining({
        id: 'test.basic',
        status: 'activated',
        enabled: true,
      }),
    ]);
    expect(registry.has('basicsrc')).toBe(true);
    expect(tools.has('basic_echo')).toBe(true);

    // 6. store.consents.latest(id) now matches manifest caps + version
    const consent = await store.consents.latest('test.basic' as never);
    expect(consent).toEqual(
      expect.objectContaining({
        extensionId: 'test.basic',
        caps: ['net'],
        manifestVersion: '1.0.0',
      }),
    );

    // grantConsent on an unknown id fails cleanly with no side effects.
    await expect(platform.grantConsent('nope.nope')).resolves.toEqual({
      ok: false,
      error: 'no such extension: nope.nope',
    });
  });

  it('a disable racing an in-flight enable serializes: final state disabled, real host stopped, no orphan', async () => {
    await platform.start();
    await installFixture();
    expect(activationsCount).toBe(1);
    await expect(platform.setEnabled('test.basic', false)).resolves.toEqual({
      ok: true,
    });
    expect(registry.has('basicsrc')).toBe(false);

    // Fire an enable, then — deliberately without awaiting it first — fire
    // a disable for the SAME extension right behind it. This is exactly
    // the window the reviewer flagged: activate() assigns `e.host`
    // synchronously but then awaits a long stretch (consent read +
    // host.start()'s spawn/ready/activate handshake) before it's done. Per
    // JS's run-to-first-await semantics, both calls are issued before
    // either's internal await resolves, so — without serialization — the
    // disable would land mid-activation, call stop() on a host that
    // hasn't started yet (a no-op against the pre-fix host-process fast
    // path), null out `e.host`, and then the suspended activate() would
    // go on to finish spawning and set 'activated' anyway: a live,
    // now-unstoppable orphan with status silently flipped back from
    // 'disabled'. With per-extension operation serialization, the
    // disable is instead queued behind the enable and runs only once the
    // enable has genuinely completed — so it stops the real, running host.
    const p1 = platform.setEnabled('test.basic', true);
    const p2 = platform.setEnabled('test.basic', false);
    await expect(Promise.all([p1, p2])).resolves.toEqual([
      { ok: true },
      { ok: true },
    ]);

    // Exactly one genuine activation happened (the enable), and the
    // disable queued behind it genuinely tore that same host back down —
    // not a silent no-op against a not-yet-started host.
    expect(activationsCount).toBe(2);
    expect(platform.snapshot()).toEqual([
      expect.objectContaining({
        id: 'test.basic',
        status: 'disabled',
        enabled: false,
      }),
    ]);
    expect(registry.has('basicsrc')).toBe(false);
    expect(tools.has('basic_echo')).toBe(false);

    // No orphaned/unstoppable host survives: a subsequent enable works
    // normally and yields exactly one further activation — an orphan from
    // the old bug would have left `e.host` pointing at a stray live child,
    // making this enable's idempotency guard wrongly no-op, or would have
    // left a second host's registrations corrupting the source registry.
    await expect(platform.setEnabled('test.basic', true)).resolves.toEqual({
      ok: true,
    });
    expect(activationsCount).toBe(3);
    expect(platform.snapshot()).toEqual([
      expect.objectContaining({
        id: 'test.basic',
        status: 'activated',
        enabled: true,
      }),
    ]);
    expect(registry.has('basicsrc')).toBe(true);
    expect(tools.has('basic_echo')).toBe(true);

    // Full teardown must be clean — jest output pristine, no stray running
    // host left un-stopped behind whichever call "won" the race.
    await expect(platform.setEnabled('test.basic', false)).resolves.toEqual({
      ok: true,
    });
    expect(registry.has('basicsrc')).toBe(false);
    await expect(platform.uninstall('test.basic')).resolves.toEqual({
      ok: true,
    });
    expect(platform.snapshot()).toEqual([]);
  });

  it('a consent-read rejection during activate is recoverable: status errored, then a retry succeeds', async () => {
    await platform.start();
    await installFixture();
    await expect(platform.setEnabled('test.basic', false)).resolves.toEqual({
      ok: true,
    });
    expect(registry.has('basicsrc')).toBe(false);

    // Inject a one-time rejection from the consent store read that
    // activate()'s consentCovers() awaits. Before the fix, this exception
    // would propagate out of activate() with `e.host` left pointing at a
    // reserved-but-never-started host forever, wedging the entry: every
    // future activate() would see `e.host` truthy and silently no-op on
    // the idempotency guard, with no way to recover short of restarting
    // the whole platform.
    const latestSpy = jest
      .spyOn(store.consents, 'latest')
      .mockRejectedValueOnce(new Error('consent store unavailable'));

    await expect(platform.setEnabled('test.basic', true)).resolves.toEqual({
      ok: true,
    });
    expect(platform.snapshot()).toEqual([
      expect.objectContaining({
        id: 'test.basic',
        status: 'errored',
        error: 'consent store unavailable',
      }),
    ]);
    expect(registry.has('basicsrc')).toBe(false);
    expect(tools.has('basic_echo')).toBe(false);

    // The spy's one-time rejection is now consumed — `store.consents.latest`
    // falls through to its real implementation again. Because the failed
    // attempt reset `e.host` to null instead of leaving it wedged, a retry
    // is not a no-op: it activates cleanly.
    await expect(platform.setEnabled('test.basic', true)).resolves.toEqual({
      ok: true,
    });
    expect(platform.snapshot()).toEqual([
      expect.objectContaining({
        id: 'test.basic',
        status: 'activated',
        enabled: true,
      }),
    ]);
    expect(registry.has('basicsrc')).toBe(true);
    expect(tools.has('basic_echo')).toBe(true);

    latestSpy.mockRestore();
  });

  it('host.start() failure is recoverable: status errored, then a retry succeeds without intervening disable', async () => {
    // Install and activate the extension with the original platform
    await platform.start();
    await installFixture();
    expect(activationsCount).toBe(1);
    // Disable it before stopping so failablePlatform won't auto-activate on start()
    await platform.setEnabled('test.basic', false);
    await platform.stop();

    // Create a test-specific platform with a conditional transportFactory
    // to simulate a host.start() failure on the first activation attempt.
    let failNextTransport = false;
    const failablePlatform = createExtensionPlatform({
      extDir: path.join(tmp, 'extensions'),
      store,
      sources: {
        register: (s: Source) => void registry.set(s.descriptor.id, s),
        get: (id: string) => registry.get(id),
        list: () => [...registry.values()].map((s) => s.descriptor),
        unregister: (id: string) => void registry.delete(id),
      },
      senders: {
        register: (id: string, s: Sender) => void senderRegistry.set(id, s),
        get: (id: string) => senderRegistry.get(id),
        ids: () => [...senderRegistry.keys()],
        unregister: (id: string) => void senderRegistry.delete(id),
      },
      scheduler: {
        register: jest.fn(),
        unregister: jest.fn(),
        jobs: jest.fn(async () => []),
        trigger: jest.fn(),
        env: {},
      } as never,
      registerTool: (t) => {
        activationsCount += 1;
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
      logSink: { log: jest.fn() },
      notify: jest.fn(),
      transportFactory: () => {
        const pair = createInMemoryHostPair();
        if (failNextTransport) {
          failNextTransport = false;
          // Simulate an immediate child process exit (e.g., crash on spawn).
          // This causes host.start() to fail waiting for the ready handshake.
          pair.simulateExit(1);
          return pair.main;
        }
        runExtensionHost(pair.child, { exit: (c) => pair.simulateExit(c) });
        return pair.main;
      },
      onChange: (snap) => snapshots.push(snap),
    });

    // Start the failable platform so it discovers the installed extension
    await failablePlatform.start();
    await expect(
      failablePlatform.setEnabled('test.basic', false),
    ).resolves.toEqual({ ok: true });
    expect(registry.has('basicsrc')).toBe(false);
    expect(activationsCount).toBe(1); // Still one; failable platform hasn't activated yet

    // Trigger a host.start() failure by setting the flag, then activate
    failNextTransport = true;
    await expect(
      failablePlatform.setEnabled('test.basic', true),
    ).resolves.toEqual({ ok: true });
    expect(failablePlatform.snapshot()).toEqual([
      expect.objectContaining({
        id: 'test.basic',
        status: 'errored',
      }),
    ]);
    expect(registry.has('basicsrc')).toBe(false);
    expect(tools.has('basic_echo')).toBe(false);
    // activationsCount should still be 1: the failed activation
    // never reached registerTool because host.start() failed

    // Before the fix, this retry would silently no-op (idempotency guard
    // sees e.host still set to the dead host). With the fix, e.host is
    // reset in the .catch(), so the retry activates cleanly.
    await expect(
      failablePlatform.setEnabled('test.basic', true),
    ).resolves.toEqual({ ok: true });
    expect(failablePlatform.snapshot()).toEqual([
      expect.objectContaining({
        id: 'test.basic',
        status: 'activated',
        enabled: true,
      }),
    ]);
    expect(registry.has('basicsrc')).toBe(true);
    expect(tools.has('basic_echo')).toBe(true);
    expect(activationsCount).toBe(2); // One more genuine activation

    // Cleanup
    await failablePlatform.stop();
  }, 15000); // Longer timeout: simulating host.start() failure is slower than other scenarios

  it('registerContributions skips a source id not declared in the manifest (F6): declared ones still register, undeclared ones warn+skip', async () => {
    await platform.start(); // empty dir — no-op
    const preview = await platform.installPreview(FIXTURE_UNDECLARED);
    if (!('token' in preview))
      throw new Error(`preview failed: ${JSON.stringify(preview)}`);
    expect(preview.id).toBe('test.undeclared');
    await expect(platform.installCommit(preview.token)).resolves.toEqual({
      ok: true,
      id: 'test.undeclared',
    });

    // Declared source registers normally; the undeclared one (which could
    // otherwise squat another extension's source id) is skipped.
    expect(registry.has('declaredsrc')).toBe(true);
    expect(registry.has('sneakysrc')).toBe(false);
    expect(logs).toContainEqual(
      expect.objectContaining({
        scope: 'extension:test.undeclared',
        level: 'warn',
        msg: expect.stringContaining("source id 'sneakysrc' is not declared"),
      }),
    );
    expect(platform.snapshot()).toEqual([
      expect.objectContaining({
        id: 'test.undeclared',
        status: 'activated',
        sourceIds: ['declaredsrc'],
      }),
    ]);

    await expect(platform.uninstall('test.undeclared')).resolves.toEqual({
      ok: true,
    });
  });

  it('a crash respawn keeps cadence jobs registered; only a deliberate deactivate stops them (F3)', async () => {
    const pairs: ReturnType<typeof createInMemoryHostPair>[] = [];
    const schedulerUnregister = jest.fn();
    const crashPlatform = createExtensionPlatform({
      extDir: path.join(tmp, 'extensions'),
      store,
      sources: {
        register: (s: Source) => void registry.set(s.descriptor.id, s),
        get: (id: string) => registry.get(id),
        list: () => [...registry.values()].map((s) => s.descriptor),
        unregister: (id: string) => void registry.delete(id),
      },
      senders: {
        register: (id: string, s: Sender) => void senderRegistry.set(id, s),
        get: (id: string) => senderRegistry.get(id),
        ids: () => [...senderRegistry.keys()],
        unregister: (id: string) => void senderRegistry.delete(id),
      },
      scheduler: {
        register: jest.fn(),
        unregister: schedulerUnregister,
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
      logSink: { log: jest.fn() },
      notify: jest.fn(),
      transportFactory: () => {
        const pair = createInMemoryHostPair();
        pairs.push(pair);
        runExtensionHost(pair.child, { exit: (c) => pair.simulateExit(c) });
        return pair.main;
      },
      onChange: (snap) => snapshots.push(snap),
    });

    await crashPlatform.start();
    const preview = await crashPlatform.installPreview(FIXTURE);
    if (!('token' in preview))
      throw new Error(`preview failed: ${JSON.stringify(preview)}`);
    await expect(crashPlatform.installCommit(preview.token)).resolves.toEqual({
      ok: true,
      id: 'test.basic',
    });
    expect(pairs).toHaveLength(1);

    const account = await store.createAccount({
      source: 'basicsrc',
      identifier: 'a',
      config: {},
      status: 'live',
    });
    const jobId = `source:basicsrc:${account.id}`;

    // Crash the running host — its transport exits unexpectedly (not via
    // deactivate/uninstall/setEnabled).
    pairs[0].simulateExit(1);

    // Wait for the crash-driven respawn to re-activate.
    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const iv = setInterval(() => {
        const s = crashPlatform.snapshot().find((x) => x.id === 'test.basic');
        if (s?.status === 'activated' && pairs.length === 2) {
          clearInterval(iv);
          resolve();
        } else if (Date.now() - start > 4000) {
          clearInterval(iv);
          reject(new Error('respawn did not re-activate in time'));
        }
      }, 5);
    });

    // The crash-cleanup disposer must NOT have stopped this account's
    // cadence job — only the source registration was torn down, and the
    // respawn's re-registration already self-healed it.
    expect(schedulerUnregister).not.toHaveBeenCalledWith(jobId);
    expect(registry.has('basicsrc')).toBe(true);

    // A deliberate, orchestrator-initiated deactivation (disable) still
    // stops the cadence job exactly as before the fix.
    await crashPlatform.setEnabled('test.basic', false);
    await new Promise((r) => setTimeout(r, 20)); // flush the fire-and-forget scheduler.unregister
    expect(schedulerUnregister).toHaveBeenCalledWith(jobId);

    await crashPlatform.stop();
  }, 10000);

  it("host-stamped event identity: A's forged producer claim is overridden by the host, platform.activated names 'platform' (#112, bundled/in-memory transport tier)", async () => {
    // Same two fixtures, same assertions as the real-forked-child e2e test
    // (extension-e2e.test.ts) — proving the two transport tiers agree, per
    // the issue's acceptance criteria.
    await platform.start();

    const previewB = await platform.installPreview(FIXTURE_EVENTS_B);
    if (!('token' in previewB))
      throw new Error(`preview failed: ${JSON.stringify(previewB)}`);
    expect(previewB.id).toBe('test.eventsb');
    await expect(platform.installCommit(previewB.token)).resolves.toEqual({
      ok: true,
      id: 'test.eventsb',
    });

    const previewA = await platform.installPreview(FIXTURE_EVENTS_A);
    if (!('token' in previewA))
      throw new Error(`preview failed: ${JSON.stringify(previewA)}`);
    expect(previewA.id).toBe('test.eventsa');
    await expect(platform.installCommit(previewA.token)).resolves.toEqual({
      ok: true,
      id: 'test.eventsa',
    });

    const activations = (
      (await tools.get('eventsB.getActivations')!.call({})) as {
        activations: Array<{ payload: { id: string }; meta: unknown }>;
      }
    ).activations.filter((a) => a.payload.id === 'test.eventsa');
    expect(activations).toEqual([
      {
        payload: { id: 'test.eventsa' },
        meta: { from: 'platform', at: expect.any(Number) },
      },
    ]);

    // A emits 'x.record' with a payload FORGING producer: 'test.eventsb'.
    await tools.get('eventsA.emitRecord')!.call({});
    await new Promise((r) => {
      setTimeout(r, 20);
    });

    const { records } = (await tools.get('eventsB.getRecords')!.call({})) as {
      records: unknown[];
    };
    expect(records).toEqual([
      {
        payload: { producer: 'test.eventsb' },
        meta: { from: 'test.eventsa', at: expect.any(Number) },
      },
    ]);
  });

  describe('oauth-bound source contributions', () => {
    let registeredProfiles: Array<{ sourceId: string; profile: unknown }>;
    let unregisteredProfiles: string[];
    let refreshers: Map<string, (creds: never) => Promise<unknown>>;
    let oauthPlatform: ExtensionPlatform;

    beforeEach(() => {
      registeredProfiles = [];
      unregisteredProfiles = [];
      refreshers = new Map();
      oauthPlatform = makePlatform({
        oauth: {
          registerProfile: (sourceId, profile) =>
            void registeredProfiles.push({ sourceId, profile }),
          unregisterProfile: (sourceId) =>
            void unregisteredProfiles.push(sourceId),
          refreshers: refreshers as never,
        },
      });
    });

    afterEach(async () => {
      await oauthPlatform.stop();
    });

    async function installOAuthFixture(): Promise<void> {
      const preview = await oauthPlatform.installPreview(FIXTURE_OAUTH);
      if (!('token' in preview))
        throw new Error(`preview failed: ${JSON.stringify(preview)}`);
      await expect(oauthPlatform.installCommit(preview.token)).resolves.toEqual(
        {
          ok: true,
          id: 'test.oauth',
        },
      );
    }

    it('registers the Google profile + refresher under the contributed source id', async () => {
      await oauthPlatform.start();
      await installOAuthFixture();

      expect(registry.has('oauthsrc')).toBe(true);
      expect(registeredProfiles).toEqual([
        { sourceId: 'oauthsrc', profile: googleOAuthProfile },
      ]);
      expect(refreshers.get('oauthsrc')).toBe(googleRefresher);
      // sourceIds stay plain ids; the oauth binding rides separately as
      // oauthSources so the marketplace/consent UI can disclose it.
      expect(oauthPlatform.snapshot()).toEqual([
        expect.objectContaining({
          id: 'test.oauth',
          status: 'activated',
          sourceIds: ['oauthsrc'],
          oauthSources: [{ id: 'oauthsrc', provider: 'google' }],
        }),
      ]);
    });

    it('installPreview surfaces the oauth binding for install consent', async () => {
      await oauthPlatform.start();
      const preview = await oauthPlatform.installPreview(FIXTURE_OAUTH);
      if (!('token' in preview))
        throw new Error(`preview failed: ${JSON.stringify(preview)}`);
      expect(preview.oauthSources).toEqual([
        { id: 'oauthsrc', provider: 'google' },
      ]);
    });

    it('deactivation (disable) unregisters the profile and deletes the refresher', async () => {
      await oauthPlatform.start();
      await installOAuthFixture();

      await expect(
        oauthPlatform.setEnabled('test.oauth', false),
      ).resolves.toEqual({ ok: true });
      expect(unregisteredProfiles).toEqual(['oauthsrc']);
      expect(refreshers.has('oauthsrc')).toBe(false);
      expect(refreshers.size).toBe(0);

      // Re-enable re-registers both — no dead connect/refresh after a
      // disable/enable cycle.
      await expect(
        oauthPlatform.setEnabled('test.oauth', true),
      ).resolves.toEqual({ ok: true });
      expect(registeredProfiles).toHaveLength(2);
      expect(refreshers.get('oauthsrc')).toBe(googleRefresher);
    });

    it('uninstall unregisters the profile and deletes the refresher', async () => {
      await oauthPlatform.start();
      await installOAuthFixture();

      await expect(oauthPlatform.uninstall('test.oauth')).resolves.toEqual({
        ok: true,
      });
      expect(unregisteredProfiles).toEqual(['oauthsrc']);
      expect(refreshers.size).toBe(0);
      expect(registry.has('oauthsrc')).toBe(false);
    });

    it('upgrade (re-install over a running extension) leaves exactly one fresh registration — no stale entries', async () => {
      await oauthPlatform.start();
      await installOAuthFixture();
      await installOAuthFixture();

      // Old activation's profile/refresher were torn down before the new
      // activation re-registered them.
      expect(unregisteredProfiles).toEqual(['oauthsrc']);
      expect(registeredProfiles).toEqual([
        { sourceId: 'oauthsrc', profile: googleOAuthProfile },
        { sourceId: 'oauthsrc', profile: googleOAuthProfile },
      ]);
      expect(refreshers.size).toBe(1);
      expect(refreshers.get('oauthsrc')).toBe(googleRefresher);
    });

    it('string-form sources register nothing oauth-related', async () => {
      await oauthPlatform.start();
      const preview = await oauthPlatform.installPreview(FIXTURE);
      if (!('token' in preview))
        throw new Error(`preview failed: ${JSON.stringify(preview)}`);
      expect(preview.oauthSources).toEqual([]);
      await expect(oauthPlatform.installCommit(preview.token)).resolves.toEqual(
        {
          ok: true,
          id: 'test.basic',
        },
      );

      expect(registry.has('basicsrc')).toBe(true);
      expect(registeredProfiles).toEqual([]);
      expect(refreshers.size).toBe(0);
      expect(oauthPlatform.snapshot()).toEqual([
        expect.objectContaining({ id: 'test.basic', oauthSources: [] }),
      ]);
      await expect(oauthPlatform.uninstall('test.basic')).resolves.toEqual({
        ok: true,
      });
      expect(unregisteredProfiles).toEqual([]);
    });

    it('a crash respawn unregisters then re-registers the profile + refresher — no stale or duplicate entries', async () => {
      const pairs: ReturnType<typeof createInMemoryHostPair>[] = [];
      const crashPlatform = makePlatform({
        oauth: {
          registerProfile: (sourceId, profile) =>
            void registeredProfiles.push({ sourceId, profile }),
          unregisterProfile: (sourceId) =>
            void unregisteredProfiles.push(sourceId),
          refreshers: refreshers as never,
        },
        transportFactory: () => {
          const pair = createInMemoryHostPair();
          pairs.push(pair);
          runExtensionHost(pair.child, { exit: (c) => pair.simulateExit(c) });
          return pair.main;
        },
      });

      await crashPlatform.start();
      const preview = await crashPlatform.installPreview(FIXTURE_OAUTH);
      if (!('token' in preview))
        throw new Error(`preview failed: ${JSON.stringify(preview)}`);
      await expect(crashPlatform.installCommit(preview.token)).resolves.toEqual(
        { ok: true, id: 'test.oauth' },
      );
      expect(pairs).toHaveLength(1);
      expect(registeredProfiles).toHaveLength(1);

      // Crash the running host — cleanup must remove profile + refresher
      // BEFORE the supervisor respawns and re-registers them.
      pairs[0].simulateExit(1);
      await new Promise<void>((resolve, reject) => {
        const start = Date.now();
        const iv = setInterval(() => {
          const s = crashPlatform.snapshot().find((x) => x.id === 'test.oauth');
          if (s?.status === 'activated' && pairs.length === 2) {
            clearInterval(iv);
            resolve();
          } else if (Date.now() - start > 4000) {
            clearInterval(iv);
            reject(new Error('respawn did not re-activate in time'));
          }
        }, 5);
      });

      // Exactly one crash-cleanup unregister, exactly one fresh
      // re-registration on top of the install-time one, and the live maps
      // hold a single, correct entry.
      expect(unregisteredProfiles).toEqual(['oauthsrc']);
      expect(registeredProfiles).toEqual([
        { sourceId: 'oauthsrc', profile: googleOAuthProfile },
        { sourceId: 'oauthsrc', profile: googleOAuthProfile },
      ]);
      expect(refreshers.size).toBe(1);
      expect(refreshers.get('oauthsrc')).toBe(googleRefresher);

      // A deliberate stop still tears everything down cleanly.
      await crashPlatform.stop();
      expect(unregisteredProfiles).toEqual(['oauthsrc', 'oauthsrc']);
      expect(refreshers.size).toBe(0);
    }, 10000);
  });

  describe('bundled extensions', () => {
    const BUNDLED_FIXTURE = path.join(__dirname, 'fixtures', 'ext-bundled');
    const BUNDLED_SHADOW_FIXTURE = path.join(
      __dirname,
      'fixtures',
      'ext-bundled-shadow',
    );

    function makeBundledPlatform(
      mainApi?: unknown,
      overrides?: Partial<ExtensionPlatformDeps>,
    ): ExtensionPlatform {
      fs.cpSync(BUNDLED_FIXTURE, path.join(tmp, 'bundled', 'ext-bundled'), {
        recursive: true,
      });
      return makePlatform({
        bundledDir: path.join(tmp, 'bundled'),
        mainApi,
        ...overrides,
      });
    }

    it('discovers, auto-consents, and activates a bundled extension', async () => {
      platform = makeBundledPlatform({ marker: 7 });
      await platform.start();
      const snap = platform.snapshot().find((e) => e.id === 'test.bundled');
      expect(snap?.origin).toBe('bundled');
      expect(snap?.status).toBe('activated'); // no ConsentRecord ever written
    });

    it('a bundled extension dataDir lives under a bundled-extensions-data root, never its own install dir', async () => {
      platform = makeBundledPlatform({ marker: 7 });
      await platform.start();
      const result = (await tools.get('bundled.dataDir')!.call({})) as {
        dataDir: string;
      };
      const expectedDataDir = path.join(
        tmp,
        'bundled-extensions-data',
        'test.bundled',
      );
      expect(result.dataDir).toBe(expectedDataDir);
      expect(
        result.dataDir.startsWith(path.join(tmp, 'bundled', 'ext-bundled')),
      ).toBe(false);
    });

    it('honors an explicit bundledDataDir override', async () => {
      const customRoot = path.join(tmp, 'custom-bundled-data-root');
      platform = makeBundledPlatform(
        { marker: 7 },
        { bundledDataDir: customRoot },
      );
      await platform.start();
      const result = (await tools.get('bundled.dataDir')!.call({})) as {
        dataDir: string;
      };
      expect(result.dataDir).toBe(path.join(customRoot, 'test.bundled'));
    });

    it('a bundled extension shadows an installed copy with the same id — bundled wins, and the shadow is logged', async () => {
      // A regular (non-privileged) "marketplace-installed" extension that
      // happens to share the bundled fixture's id.
      await platform.start(); // empty dir — no-op
      const preview = await platform.installPreview(BUNDLED_SHADOW_FIXTURE);
      if (!('token' in preview))
        throw new Error(`preview failed: ${JSON.stringify(preview)}`);
      await expect(platform.installCommit(preview.token)).resolves.toEqual({
        ok: true,
        id: 'test.bundled',
      });
      // installPreview/installCommit against a local filesystem path (not a
      // github ref) records origin 'dev' — same convention as every other
      // fixture-backed install in this file.
      expect(
        platform.snapshot().find((e) => e.id === 'test.bundled')?.origin,
      ).toBe('dev');
      await platform.stop();

      // Restart with the SAME extDir (still holding the installed copy on
      // disk) plus a bundledDir carrying the privileged fixture under the
      // identical id — the bundled copy must win.
      platform = makeBundledPlatform({ marker: 7 });
      await platform.start();
      expect(
        platform.snapshot().find((e) => e.id === 'test.bundled')?.origin,
      ).toBe('bundled');
      expect(logs).toContainEqual(
        expect.objectContaining({
          scope: 'extensions',
          level: 'warn',
          msg: expect.stringContaining(
            'test.bundled shadows an installed copy — bundled wins — the installed copy remains on disk and is ignored',
          ),
        }),
      );
    });

    // These two assert the in-process transport branch that actually
    // delivers extras.mainProcess and busts the require cache on exit.
    it('runs the privileged extension in-process and delivers mainApi (tool round-trip)', async () => {
      platform = makeBundledPlatform({ marker: 7 });
      await platform.start();
      const tool = tools.get('bundled.probe');
      expect(tool).toBeDefined();
      await expect(tool!.call({})).resolves.toEqual({
        marker: 7,
        activations: 1,
      });
    });

    it('loads a FRESH module instance on re-enable (require cache busted on exit)', async () => {
      platform = makeBundledPlatform({ marker: 7 });
      await platform.start();
      await platform.setEnabled('test.bundled', false);
      await platform.setEnabled('test.bundled', true);
      // A cached module instance would report activations: 2.
      await expect(tools.get('bundled.probe')!.call({})).resolves.toEqual({
        marker: 7,
        activations: 1,
      });
    });

    it('refuses to uninstall a bundled extension', async () => {
      platform = makeBundledPlatform();
      await platform.start();
      const r = await platform.uninstall('test.bundled');
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/bundled/i);
    });

    it('setEnabled(false) disables a bundled extension', async () => {
      platform = makeBundledPlatform();
      await platform.start();
      const r = await platform.setEnabled('test.bundled', false);
      expect(r.ok).toBe(true);
      expect(
        platform.snapshot().find((e) => e.id === 'test.bundled')?.status,
      ).toBe('disabled');
    });

    it('installCommit refuses to replace a live bundled extension, which keeps running', async () => {
      platform = makeBundledPlatform({ marker: 7 });
      await platform.start();
      // Same preview/commit sequence the shadow test uses, targeting the
      // SAME id ('test.bundled') as the already-active bundled entry — this
      // exercises the installCommit-time guard (extension-platform.ts
      // installCommit's `existing?.origin === 'bundled'` check), distinct
      // from the boot-time shadow-wins precedence covered above.
      const preview = await platform.installPreview(BUNDLED_SHADOW_FIXTURE);
      if (!('token' in preview))
        throw new Error(`preview failed: ${JSON.stringify(preview)}`);
      await expect(platform.installCommit(preview.token)).resolves.toEqual({
        ok: false,
        error: expect.stringContaining('cannot be replaced'),
      });
      const snap = platform.snapshot().find((e) => e.id === 'test.bundled');
      expect(snap?.origin).toBe('bundled');
      expect(snap?.status).toBe('activated');
      // The live host was never torn down by the refused commit attempt.
      await expect(tools.get('bundled.probe')!.call({})).resolves.toEqual({
        marker: 7,
        activations: 1,
      });
    });

    it('a bundled extension without unsafe.mainProcess activates via the injected transportFactory, not in-process', async () => {
      const NONPRIV_FIXTURE = path.join(
        __dirname,
        'fixtures',
        'ext-bundled-nonpriv',
      );
      fs.cpSync(
        NONPRIV_FIXTURE,
        path.join(tmp, 'bundled', 'ext-bundled-nonpriv'),
        { recursive: true },
      );
      const transportCalls: string[] = [];
      platform = makePlatform({
        bundledDir: path.join(tmp, 'bundled'),
        transportFactory: (id) => {
          transportCalls.push(id);
          const pair = createInMemoryHostPair();
          runExtensionHost(pair.child, { exit: (c) => pair.simulateExit(c) });
          return pair.main;
        },
      });
      await platform.start();
      expect(transportCalls).toContain('test.bundled-nonpriv');
      const snap = platform
        .snapshot()
        .find((e) => e.id === 'test.bundled-nonpriv');
      expect(snap?.origin).toBe('bundled');
      expect(snap?.status).toBe('activated');
    });
  });

  describe('extension sender contributions', () => {
    async function installSenderFixture(fixture: string, id: string) {
      const preview = await platform.installPreview(fixture);
      if (!('token' in preview))
        throw new Error(`preview failed: ${JSON.stringify(preview)}`);
      await expect(platform.installCommit(preview.token)).resolves.toEqual({
        ok: true,
        id,
      });
    }

    it('registers a cap-gated sender proxy that resolves credentials from the vault and forwards them as SenderContext', async () => {
      await platform.start(); // empty dir — no-op
      await installSenderFixture(FIXTURE_SENDER, 'test.sender');

      expect(registry.has('fixsrc')).toBe(true);
      expect([...senderRegistry.keys()]).toContain('fixsrc');

      // A real credential blob in the vault under the intent's account id —
      // an out-of-process sender has no vault access, so the ONLY way this
      // can reach the child is the host resolving it and passing it in ctx.
      const account = await store.createAccount({
        source: 'fixsrc',
        identifier: 'fix-account',
        config: {},
        status: 'live',
      });
      await store.vault.save(account.id, {
        accessToken: 'FAKE-VAULT-TOKEN-NOT-REAL',
      });
      const loadSpy = jest.spyOn(store.vault, 'load');

      await expect(
        senderRegistry.get('fixsrc')!.send({
          accountId: account.id,
          kind: 'new',
          to: ['someone@example.com'],
          bodyMarkdown: 'hi',
        }),
      ).resolves.toEqual({ externalMessageId: 'fix-1' });

      expect(loadSpy).toHaveBeenCalledWith(account.id);
      // Sender.send's `ctx` is optional in the contract, so a host that
      // forgot to pass it would compile and still return this same green
      // result — the fixture echoes back what it actually received.
      await expect(tools.get('sender_last_ctx')!.call({})).resolves.toEqual({
        ctx: { credentials: { accessToken: 'FAKE-VAULT-TOKEN-NOT-REAL' } },
      });

      loadSpy.mockRestore();
    });

    it('refuses to register a sender from an extension without the send cap: warns, registers nothing, source still registers', async () => {
      await platform.start(); // empty dir — no-op
      await installSenderFixture(FIXTURE_SENDER_NOCAP, 'test.sender-nocap');

      // contributes.senders alone is not a grant — the cap is.
      expect([...senderRegistry.keys()]).not.toContain('fixsrc');
      expect(senderRegistry.size).toBe(0);
      // The rest of the extension activates normally.
      expect(registry.has('fixsrc')).toBe(true);
      expect(platform.snapshot()).toEqual([
        expect.objectContaining({
          id: 'test.sender-nocap',
          status: 'activated',
          sourceIds: ['fixsrc'],
        }),
      ]);
      expect(logs).toContainEqual(
        expect.objectContaining({
          scope: 'extension:test.sender-nocap',
          level: 'warn',
          msg: expect.stringContaining("'send' cap"),
        }),
      );
    });

    it('skips sender ids the manifest never declared and ids with no source behind them (the gate the child cannot see)', async () => {
      await platform.start(); // empty dir — no-op
      await installSenderFixture(
        FIXTURE_SENDER_UNDECLARED,
        'test.sender-undeclared',
      );

      // Only the id that is BOTH declared in contributes.senders and backed
      // by a source this activation registered survives.
      expect([...senderRegistry.keys()]).toEqual(['okaysrc']);
      expect(logs).toContainEqual(
        expect.objectContaining({
          scope: 'extension:test.sender-undeclared',
          level: 'warn',
          msg: expect.stringContaining(
            "sender id 'sneakysrc' is not declared in contributes.senders",
          ),
        }),
      );
      expect(logs).toContainEqual(
        expect.objectContaining({
          scope: 'extension:test.sender-undeclared',
          level: 'warn',
          msg: expect.stringContaining(
            "sender id 'ghostsrc' has no registered source",
          ),
        }),
      );
    });

    it('deactivation unregisters the sender — a disabled extension can no longer send', async () => {
      await platform.start(); // empty dir — no-op
      await installSenderFixture(FIXTURE_SENDER, 'test.sender');
      expect(senderRegistry.get('fixsrc')).toBeDefined();

      await expect(platform.setEnabled('test.sender', false)).resolves.toEqual({
        ok: true,
      });
      expect(senderRegistry.get('fixsrc')).toBeUndefined();
      expect(registry.has('fixsrc')).toBe(false);

      // Re-enabling re-registers it — no dead sender after a disable/enable
      // cycle (same lifecycle as the source registration).
      await expect(platform.setEnabled('test.sender', true)).resolves.toEqual({
        ok: true,
      });
      expect(senderRegistry.get('fixsrc')).toBeDefined();
    });

    it('a crash respawn re-registers exactly one working sender — the old disposer never clobbers the fresh one', async () => {
      const pairs: ReturnType<typeof createInMemoryHostPair>[] = [];
      const crashPlatform = makePlatform({
        transportFactory: () => {
          const pair = createInMemoryHostPair();
          pairs.push(pair);
          runExtensionHost(pair.child, { exit: (c) => pair.simulateExit(c) });
          return pair.main;
        },
      });
      await crashPlatform.start();
      const preview = await crashPlatform.installPreview(FIXTURE_SENDER);
      if (!('token' in preview))
        throw new Error(`preview failed: ${JSON.stringify(preview)}`);
      await expect(crashPlatform.installCommit(preview.token)).resolves.toEqual(
        { ok: true, id: 'test.sender' },
      );
      expect(pairs).toHaveLength(1);
      expect(senderRegistry.size).toBe(1);

      // Crash the running host. Unlike a deliberate disable, deactivate()
      // never runs and the Entry is never rebuilt — the disposer fires from
      // the supervisor's own crash cleanup. If it landed AFTER the respawn's
      // registerContributions, it would unregister the FRESH sender and
      // leave a live extension with no outbound transport at all.
      pairs[0].simulateExit(1);
      await new Promise<void>((resolve, reject) => {
        const start = Date.now();
        const iv = setInterval(() => {
          const s = crashPlatform
            .snapshot()
            .find((x) => x.id === 'test.sender');
          if (s?.status === 'activated' && pairs.length === 2) {
            clearInterval(iv);
            resolve();
          } else if (Date.now() - start > 4000) {
            clearInterval(iv);
            reject(new Error('respawn did not re-activate in time'));
          }
        }, 5);
      });

      // Exactly one entry (a duplicate would show as a stale registration
      // surviving alongside the fresh one), and it is genuinely usable: the
      // proxy's `e.host!` must resolve to the NEW incarnation, not the dead
      // one — a send is the only thing that proves that.
      expect(senderRegistry.size).toBe(1);
      const account = await store.createAccount({
        source: 'fixsrc',
        identifier: 'fix-account',
        config: {},
        status: 'live',
      });
      await expect(
        senderRegistry.get('fixsrc')!.send({
          accountId: account.id,
          kind: 'new',
          bodyMarkdown: 'after the crash',
        }),
      ).resolves.toEqual({ externalMessageId: 'fix-1' });

      // A deliberate stop still tears it down cleanly.
      await crashPlatform.stop();
      expect(senderRegistry.size).toBe(0);
    }, 10000);

    it('a consent that predates the send cap no longer covers the manifest: same version, narrower caps → needs-consent', async () => {
      await platform.start(); // empty dir — no-op
      await installSenderFixture(FIXTURE_SENDER, 'test.sender');
      await expect(platform.setEnabled('test.sender', false)).resolves.toEqual({
        ok: true,
      });

      // Consent for the SAME manifest version but WITHOUT 'send' — the
      // version prong (covered by the sibling '0.0.0-stale' test) passes
      // here, so only the caps-subset prong can refuse this activation.
      await store.consents.record({
        extensionId: 'test.sender',
        caps: [],
        manifestVersion: '1.0.0',
        grantedAt: new Date().toISOString(),
      } as never);

      await expect(platform.setEnabled('test.sender', true)).resolves.toEqual({
        ok: true,
      });
      expect(platform.snapshot()).toEqual([
        expect.objectContaining({
          id: 'test.sender',
          status: 'needs-consent',
          caps: ['send'],
        }),
      ]);
      expect(senderRegistry.size).toBe(0);
      expect(registry.has('fixsrc')).toBe(false);

      // Granting consent for the on-disk manifest (which declares 'send')
      // restores both the source and the sender.
      await expect(platform.grantConsent('test.sender')).resolves.toEqual({
        ok: true,
      });
      expect(senderRegistry.get('fixsrc')).toBeDefined();
    });
  });
});
