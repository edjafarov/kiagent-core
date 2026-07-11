import fs from 'fs';
import path from 'path';
import fsp, { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import type { Prefs } from '@shared/contracts';
import { CapabilityUnsupportedError } from '@main/core/inference';
import { createLocalLlmProvider } from '../provider';
import type { ServerLike } from '../provider';
import type { ModelDescriptor } from '../models';
import { CURATED_MODEL, E4B_MODEL } from '../models';

jest.mock('../api');
jest.mock('../capability');

// Mock the API module
const mockApi = jest.mocked(require('../api'), { shallow: true });
const mockCapability = jest.mocked(require('../capability'), { shallow: true });

function fakePrefs(overrides?: {
  models?: { override?: string; autoInstall?: boolean };
}): Prefs {
  const defaults = {
    theme: 'system' as const,
    logLevel: 'info' as const,
    launchAtLogin: false,
    showInMenuBar: false,
    processing: { enabled: true, window: 'always' as const },
    privacy: { browserHistory: false, sendDiagnostics: false },
    models: { override: 'auto', autoInstall: true, ...overrides?.models },
  };

  let current = defaults as any;
  return {
    get: () => current,
    patch: async (p) => {
      current = { ...current, ...p };
    },
    onChange: () => () => {},
  };
}

function makeDeps(over = {} as Record<string, any>) {
  const server: ServerLike = {
    start: jest.fn(async () => {}),
    stop: jest.fn(async () => {}),
    baseUrl: () => 'http://x',
  };
  const { prefs: prefOverrides, ...otherOverrides } = over;
  return {
    server,
    deps: {
      llamaBinaryPath: '/bin/llama-server',
      modelsDir: over.modelsDir as string,
      prefs: fakePrefs(prefOverrides),
      log: jest.fn(),
      detect: async () => ({
        accel: 'metal' as const,
        capacityBytes: 64 * 1024 ** 3,
      }),
      download: jest.fn(async (_m, _d, opts) => {
        opts.onProgress?.(50, 100);
      }),
      makeServer: () => server,
      idleStopMs: 1000,
      filesPresent: (m: ModelDescriptor, dir: string) => {
        return fs.existsSync(dir);
      },
      ...otherOverrides,
    },
  };
}

describe('LocalLlmProvider', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), 'provider-test-'));
    jest.clearAllMocks();
    // Default: capability is OK
    mockCapability.checkCapability.mockReturnValue({ ok: true });
    mockCapability.readHostProbes.mockReturnValue({
      platform: 'darwin',
      arch: 'arm64',
      totalMemBytes: 64 * 1024 ** 3,
    });
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('standby before install', () => {
    const { deps } = makeDeps({ modelsDir: tmpDir });
    const provider = createLocalLlmProvider(deps);
    expect(provider.status()).toBe('standby');
  });

  it('ensureInstalled downloads the tier model', async () => {
    const { deps } = makeDeps({
      modelsDir: tmpDir,
      prefs: { models: { override: 'auto', autoInstall: true } },
    });

    const provider = createLocalLlmProvider(deps);

    // Before calling ensureInstalled, status should be standby
    expect(provider.status()).toBe('standby');

    // Call ensureInstalled
    provider.ensureInstalled();

    // Give the async operations a chance to settle
    await new Promise((r) => setTimeout(r, 50));

    // Check that download was called
    expect(deps.download).toHaveBeenCalled();

    // Create the model directory and files to simulate successful download
    const modelDir = path.join(tmpDir, CURATED_MODEL.id);
    await fsp.mkdir(modelDir, { recursive: true });
    for (const file of CURATED_MODEL.files) {
      await fsp.writeFile(path.join(modelDir, file.name), 'mock-content');
    }

    // Wait for the download to complete
    await new Promise((r) => setTimeout(r, 100));

    // Now status should be ready
    expect(provider.status()).toBe('ready');
  });

  it('respects autoInstall=false', async () => {
    const { deps } = makeDeps({
      modelsDir: tmpDir,
      prefs: { models: { override: 'auto', autoInstall: false } },
    });

    const provider = createLocalLlmProvider(deps);
    provider.ensureInstalled();

    await new Promise((r) => setTimeout(r, 50));

    // No download should happen
    expect(deps.download).not.toHaveBeenCalled();

    // Now patch prefs to enable autoInstall
    await deps.prefs.patch({ models: { override: 'auto', autoInstall: true } });
    provider.ensureInstalled();

    await new Promise((r) => setTimeout(r, 50));

    // Now download should be called
    expect(deps.download).toHaveBeenCalled();
  });

  it('unsupported hardware', async () => {
    // Test with insufficient RAM on non-darwin
    mockCapability.checkCapability.mockReturnValue({
      ok: false,
      reason: 'insufficient_ram',
    });

    const { deps } = makeDeps({
      modelsDir: tmpDir,
    });

    const provider = createLocalLlmProvider(deps);
    expect(provider.status()).toBe('unsupported');
  });

  it('download error surfaces', async () => {
    const downloadError = new Error('Network error');
    const { deps } = makeDeps({
      modelsDir: tmpDir,
      download: jest.fn(async () => {
        throw downloadError;
      }),
    });

    const provider = createLocalLlmProvider(deps);
    provider.ensureInstalled();

    await new Promise((r) => setTimeout(r, 100));

    const status = provider.status();
    expect(status).toMatchObject({ error: expect.any(String) });
  });

  it('cancelInstall aborts', async () => {
    const { deps } = makeDeps({
      modelsDir: tmpDir,
      download: jest.fn(async (_m, _d, _opts) => {
        // Simulate a long-running download
        await new Promise((r) => setTimeout(r, 1000));
      }),
    });

    const provider = createLocalLlmProvider(deps);
    provider.ensureInstalled();

    await new Promise((r) => setTimeout(r, 50));

    // Cancel the install
    await provider.cancelInstall();

    // Status should be back to standby
    expect(provider.status()).toBe('standby');
  });

  it('lazy server + idle stop', async () => {
    jest.useFakeTimers();
    try {
      const { deps, server } = makeDeps({ modelsDir: tmpDir });

      // Create model directory and files to simulate ready state
      const modelDir = path.join(tmpDir, CURATED_MODEL.id);
      await fsp.mkdir(modelDir, { recursive: true });
      for (const file of CURATED_MODEL.files) {
        await fsp.writeFile(path.join(modelDir, file.name), 'mock-content');
      }

      const provider = createLocalLlmProvider(deps);

      // Manually set installed model since we created the files
      expect(provider.status()).toBe('ready');

      // First handle call should start the server
      await provider.handle({
        kind: 'complete',
        payload: { prompt: 'test' },
        lane: 'interactive',
      });

      expect(server.start).toHaveBeenCalledTimes(1);

      // Second handle call should reuse the server
      await provider.handle({
        kind: 'complete',
        payload: { prompt: 'test2' },
        lane: 'interactive',
      });

      expect(server.start).toHaveBeenCalledTimes(1);

      // Advance time past idle timeout
      jest.advanceTimersByTime(2000);

      // Stop should have been called
      expect(server.stop).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('handle routes kinds', async () => {
    const { deps } = makeDeps({ modelsDir: tmpDir });

    // Create model directory and files to simulate ready state
    const modelDir = path.join(tmpDir, CURATED_MODEL.id);
    await fsp.mkdir(modelDir, { recursive: true });
    for (const file of CURATED_MODEL.files) {
      await fsp.writeFile(path.join(modelDir, file.name), 'mock-content');
    }

    const provider = createLocalLlmProvider(deps);

    // Mock the API functions
    mockApi.chatText.mockResolvedValue('response');
    mockApi.describeImage.mockResolvedValue('description');

    // Test complete
    const completeResult = await provider.handle({
      kind: 'complete',
      payload: { prompt: 'test' },
      lane: 'interactive',
    });
    expect(completeResult).toBe('response');

    // Test see
    const seeResult = await provider.handle({
      kind: 'see',
      payload: { image: new Uint8Array([1, 2, 3]), prompt: 'describe' },
      lane: 'interactive',
    });
    expect(seeResult).toBe('description');

    // Test read (should reject)
    await expect(
      provider.handle({
        kind: 'read',
        payload: { image: new Uint8Array([1, 2, 3]) },
        lane: 'interactive',
      }),
    ).rejects.toThrow(/does not support 'read'/);
  });

  it('advertises hear (audio support is decided per-model in handle)', () => {
    const { deps } = makeDeps({ modelsDir: tmpDir });
    const provider = createLocalLlmProvider(deps);
    expect(provider.supports).toContain('hear');
  });

  it('handle(hear) transcribes on an audio-capable model (E-series)', async () => {
    const dir = path.join(tmpDir, E4B_MODEL.id);
    await fsp.mkdir(dir, { recursive: true });
    for (const file of E4B_MODEL.files) {
      await fsp.writeFile(path.join(dir, file.name), 'mock-content');
    }
    const { deps } = makeDeps({
      modelsDir: tmpDir,
      prefs: { models: { override: E4B_MODEL.id, autoInstall: true } },
    });
    const provider = createLocalLlmProvider(deps);
    mockApi.transcribeAudio.mockResolvedValue('the transcript');

    const out = await provider.handle({
      kind: 'hear',
      payload: { audio: new Uint8Array([1, 2, 3]), format: 'wav' },
      lane: 'background',
    });
    expect(out).toBe('the transcript');
    expect(mockApi.transcribeAudio).toHaveBeenCalledWith(
      'http://x',
      expect.any(Uint8Array),
      'wav',
    );
  });

  it('handle(hear) throws CapabilityUnsupportedError on a vision-only model (12B), without starting a server', async () => {
    const dir = path.join(tmpDir, CURATED_MODEL.id); // 12B — hasAudio absent
    await fsp.mkdir(dir, { recursive: true });
    for (const file of CURATED_MODEL.files) {
      await fsp.writeFile(path.join(dir, file.name), 'mock-content');
    }
    const { deps, server } = makeDeps({
      modelsDir: tmpDir,
      prefs: { models: { override: CURATED_MODEL.id, autoInstall: true } },
    });
    const provider = createLocalLlmProvider(deps);

    await expect(
      provider.handle({
        kind: 'hear',
        payload: { audio: new Uint8Array([1]), format: 'wav' },
        lane: 'background',
      }),
    ).rejects.toBeInstanceOf(CapabilityUnsupportedError);
    expect(mockApi.transcribeAudio).not.toHaveBeenCalled();
    expect(server.start).not.toHaveBeenCalled();
  });

  it('selectedModel', async () => {
    const { deps } = makeDeps({ modelsDir: tmpDir });
    const provider = createLocalLlmProvider(deps);

    const model = await provider.selectedModel();
    expect(model).toMatchObject({ id: expect.any(String) });
  });

  it('installedModelIds lists installed models', async () => {
    const { deps } = makeDeps({ modelsDir: tmpDir });

    // Create a model directory with files
    const modelDir = path.join(tmpDir, CURATED_MODEL.id);
    await fsp.mkdir(modelDir, { recursive: true });
    for (const file of CURATED_MODEL.files) {
      await fsp.writeFile(path.join(modelDir, file.name), 'mock-content');
    }

    const provider = createLocalLlmProvider(deps);
    const ids = provider.installedModelIds();
    expect(ids).toContain(CURATED_MODEL.id);
  });

  it('fresh construction over same dir finds installed model', async () => {
    const { deps } = makeDeps({ modelsDir: tmpDir });

    // Create model directory and files
    const modelDir = path.join(tmpDir, CURATED_MODEL.id);
    await fsp.mkdir(modelDir, { recursive: true });
    for (const file of CURATED_MODEL.files) {
      await fsp.writeFile(path.join(modelDir, file.name), 'mock-content');
    }

    // Create first provider
    const provider1 = createLocalLlmProvider(deps);
    expect(provider1.status()).toBe('ready');

    // Create second provider over the same directory
    const provider2 = createLocalLlmProvider(deps);
    expect(provider2.status()).toBe('ready');
  });

  // Finding 1: two concurrent first-handle() calls must single-flight the
  // server start — only one server may ever be constructed, and both calls
  // resolve against it. Before the fix, `serverStarting` was assigned only
  // after `await detect()`, so a second concurrent call slipped past the
  // `if (server)` guard (still null) and built + started a second server,
  // orphaning the first (leaked multi-GB llama-server process).
  it('single-flights concurrent handle() calls — only one server is constructed', async () => {
    const modelDir = path.join(tmpDir, CURATED_MODEL.id);
    await fsp.mkdir(modelDir, { recursive: true });
    for (const file of CURATED_MODEL.files) {
      await fsp.writeFile(path.join(modelDir, file.name), 'mock-content');
    }

    let resolveStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });
    let constructCount = 0;
    const makeServer = jest.fn(() => {
      constructCount += 1;
      return {
        start: jest.fn(() => startGate),
        stop: jest.fn(async () => {}),
        baseUrl: () => 'http://x',
      };
    });

    const { deps } = makeDeps({ modelsDir: tmpDir, makeServer });
    const provider = createLocalLlmProvider(deps);

    mockApi.chatText.mockResolvedValue('ok');

    // Two concurrent handle() calls, neither awaited before the other starts.
    const p1 = provider.handle({
      kind: 'complete',
      payload: { prompt: 'a' },
      lane: 'interactive',
    });
    const p2 = provider.handle({
      kind: 'complete',
      payload: { prompt: 'b' },
      lane: 'interactive',
    });

    // Give both in-flight ensureServer() calls a chance to reach makeServer().
    await new Promise((r) => setTimeout(r, 20));
    expect(makeServer).toHaveBeenCalledTimes(1);
    expect(constructCount).toBe(1);

    resolveStart();

    await expect(p1).resolves.toBe('ok');
    await expect(p2).resolves.toBe('ok');
    expect(makeServer).toHaveBeenCalledTimes(1);
  });

  // Finding 2: cancelInstall() clobbering a subsequent install's state.
  // Sequence: install A starts (download in flight) → cancelInstall() aborts
  // A and resets shared state to standby → install B starts (installing=B) →
  // A's `finally` finally runs and used to unconditionally null out
  // `installing`/`downloadPct`, clobbering B's in-flight state and allowing a
  // THIRD concurrent install to start. The fix guards those writes with an
  // ownership check (`installing === abort`).
  it('cancelInstall does not let the aborted run clobber a newer install', async () => {
    let resolveA!: (v: void) => void;
    let rejectA!: (e: unknown) => void;
    const gateA = new Promise<void>((resolve, reject) => {
      resolveA = resolve;
      rejectA = reject;
    });
    const gateB = new Promise<void>(() => {}); // never settles in this test
    const gates = [gateA, gateB];
    let callIndex = 0;
    const download = jest.fn(() => {
      const gate = gates[callIndex];
      callIndex += 1;
      return gate;
    });

    const { deps } = makeDeps({ modelsDir: tmpDir, download });
    const provider = createLocalLlmProvider(deps);

    // Run A starts and reaches the (gated) download call.
    provider.ensureInstalled();
    await new Promise((r) => setTimeout(r, 20));
    expect(download).toHaveBeenCalledTimes(1);

    // Cancel A: resets to standby.
    await provider.cancelInstall();
    expect(provider.status()).toBe('standby');

    // Run B starts (installing is null again, so this is allowed).
    provider.ensureInstalled();
    await new Promise((r) => setTimeout(r, 20));
    expect(download).toHaveBeenCalledTimes(2);
    expect(provider.status()).toMatchObject({
      downloading: { pct: expect.any(Number) },
    });

    // A's aborted download settles late (rejects, as a real aborted fetch
    // would) — this must NOT clobber B's in-flight state.
    rejectA(new Error('aborted'));
    await new Promise((r) => setTimeout(r, 20));
    expect(provider.status()).toMatchObject({
      downloading: { pct: expect.any(Number) },
    });

    // A third ensureInstalled() must be a no-op: B is still installing.
    provider.ensureInstalled();
    await new Promise((r) => setTimeout(r, 20));
    expect(download).toHaveBeenCalledTimes(2);

    // Cleanup: settle gateA already done; nothing else to await (gateB never
    // settles, which is fine — the provider is discarded at test end).
    void resolveA;
  });

  // Finding-round-2: rejected serverStarting is cached forever.
  // ensureServer memoizes serverStarting but never clears it when the IIFE
  // rejects. First handle() rejects; second handle() returns the same rejected
  // promise forever instead of attempting a fresh start.
  it('clears failed server start memo on rejection, allowing retry', async () => {
    const modelDir = path.join(tmpDir, CURATED_MODEL.id);
    await fsp.mkdir(modelDir, { recursive: true });
    for (const file of CURATED_MODEL.files) {
      await fsp.writeFile(path.join(modelDir, file.name), 'mock-content');
    }

    const startError = new Error('start failed');
    let startAttempts = 0;
    const makeServer = jest.fn(() => {
      startAttempts += 1;
      if (startAttempts === 1) {
        // First attempt: start() rejects
        return {
          start: jest.fn(async () => {
            throw startError;
          }),
          stop: jest.fn(async () => {}),
          baseUrl: () => 'http://x',
        };
      }
      // Second attempt: start() succeeds
      return {
        start: jest.fn(async () => {}),
        stop: jest.fn(async () => {}),
        baseUrl: () => 'http://x',
      };
    });

    const { deps } = makeDeps({ modelsDir: tmpDir, makeServer });
    const provider = createLocalLlmProvider(deps);

    mockApi.chatText.mockResolvedValue('ok');

    // First handle() should reject with the start error
    await expect(
      provider.handle({
        kind: 'complete',
        payload: { prompt: 'a' },
        lane: 'interactive',
      }),
    ).rejects.toThrow('start failed');
    expect(makeServer).toHaveBeenCalledTimes(1);

    // Second handle() should attempt a fresh start (makeServer called again)
    // and succeed this time
    const result = await provider.handle({
      kind: 'complete',
      payload: { prompt: 'b' },
      lane: 'interactive',
    });
    expect(result).toBe('ok');
    expect(makeServer).toHaveBeenCalledTimes(2);
  });

  // Finding 2: the model override must not be a silent no-op once ANY model is
  // installed. ensureInstalled must download the SELECTED model even though a
  // different model is already on disk.
  it('ensureInstalled downloads the selected override model even when another is installed', async () => {
    // CURATED installed on disk; override pins the (not-installed) E4B.
    const curatedDir = path.join(tmpDir, CURATED_MODEL.id);
    await fsp.mkdir(curatedDir, { recursive: true });
    for (const file of CURATED_MODEL.files) {
      await fsp.writeFile(path.join(curatedDir, file.name), 'mock-content');
    }

    const { deps } = makeDeps({
      modelsDir: tmpDir,
      prefs: { models: { override: E4B_MODEL.id, autoInstall: true } },
    });
    const provider = createLocalLlmProvider(deps);

    // The selected model isn't installed → standby (a fallback could serve,
    // but status tracks the selection), which permits the download to start.
    expect(provider.status()).toBe('standby');

    provider.ensureInstalled();
    await new Promise((r) => setTimeout(r, 50));

    expect(deps.download).toHaveBeenCalledTimes(1);
    expect((deps.download as jest.Mock).mock.calls[0][0].id).toBe(E4B_MODEL.id);
  });

  // Finding 2: handle must PREFER the selected model when it's installed,
  // rather than serving whichever model was seeded first from a readdir scan.
  it('handle serves the selected override model when it is installed', async () => {
    for (const model of [CURATED_MODEL, E4B_MODEL]) {
      const dir = path.join(tmpDir, model.id);
      await fsp.mkdir(dir, { recursive: true });
      for (const file of model.files) {
        await fsp.writeFile(path.join(dir, file.name), 'mock-content');
      }
    }

    let startedModelPath: string | undefined;
    const makeServer = jest.fn((args: { modelPath: string }) => {
      startedModelPath = args.modelPath;
      return {
        start: jest.fn(async () => {}),
        stop: jest.fn(async () => {}),
        baseUrl: () => 'http://x',
      };
    });

    const { deps } = makeDeps({
      modelsDir: tmpDir,
      makeServer,
      prefs: { models: { override: E4B_MODEL.id, autoInstall: true } },
    });
    const provider = createLocalLlmProvider(deps);

    // Selected model is installed → ready.
    expect(provider.status()).toBe('ready');

    mockApi.chatText.mockResolvedValue('ok');
    await provider.handle({
      kind: 'complete',
      payload: { prompt: 'x' },
      lane: 'interactive',
    });

    expect(startedModelPath).toContain(E4B_MODEL.id);
  });

  // Finding 1: on app quit, dispose() must stop a running llama-server child
  // and abort any in-flight install — WITHOUT flipping the persisted
  // autoInstall pref (quitting isn't the user disabling auto-install).
  it('dispose stops a running server + aborts an in-flight download, leaving autoInstall untouched', async () => {
    // CURATED installed (a fallback the server serves); override pins the
    // not-yet-installed E4B so ensureInstalled has a real download to abort.
    const curatedDir = path.join(tmpDir, CURATED_MODEL.id);
    await fsp.mkdir(curatedDir, { recursive: true });
    for (const file of CURATED_MODEL.files) {
      await fsp.writeFile(path.join(curatedDir, file.name), 'mock-content');
    }

    let capturedSignal: AbortSignal | undefined;
    const download = jest.fn(
      (_m: unknown, _d: unknown, opts: { signal: AbortSignal }) => {
        capturedSignal = opts.signal;
        return new Promise<void>((_resolve, reject) => {
          opts.signal.addEventListener(
            'abort',
            () => reject(new Error('aborted')),
            {
              once: true,
            },
          );
        });
      },
    );

    const { deps, server } = makeDeps({
      modelsDir: tmpDir,
      download,
      prefs: { models: { override: E4B_MODEL.id, autoInstall: true } },
    });
    const provider = createLocalLlmProvider(deps);
    mockApi.chatText.mockResolvedValue('ok');

    // Start the server (serves the fallback CURATED while E4B isn't installed).
    await provider.handle({
      kind: 'complete',
      payload: { prompt: 'x' },
      lane: 'interactive',
    });
    expect(server.start).toHaveBeenCalledTimes(1);

    // Kick off the gated install of the selected E4B model.
    provider.ensureInstalled();
    await new Promise((r) => setTimeout(r, 20));
    expect(download).toHaveBeenCalledTimes(1);
    expect(capturedSignal?.aborted).toBe(false);

    await provider.dispose();

    expect(server.stop).toHaveBeenCalledTimes(1);
    expect(capturedSignal?.aborted).toBe(true);
    // autoInstall must NOT be flipped — quitting isn't the user disabling it.
    expect(deps.prefs.get().models.autoInstall).toBe(true);
  });

  /** Every server makeServer minted, with the modelPath it was started for. */
  function trackingMakeServer(made: Array<{ modelPath: string; server: any }>) {
    return jest.fn((args: { modelPath: string }) => {
      const server = {
        start: jest.fn(async () => {}),
        stop: jest.fn(async () => {}),
        baseUrl: () => 'http://x',
      };
      made.push({ modelPath: args.modelPath, server });
      return server;
    });
  }

  async function installModel(dir: string, model: ModelDescriptor) {
    const d = path.join(dir, model.id);
    await fsp.mkdir(d, { recursive: true });
    for (const file of model.files) {
      await fsp.writeFile(path.join(d, file.name), 'mock-content');
    }
  }

  // Issue #18: the ensureServer memo never compared models, so a completed
  // override switch kept serving the OLD model until idle-stop — which never
  // fires under steady traffic (every handle() re-arms the timer).
  it('restarts onto the new model when the override flips between two installed models', async () => {
    await installModel(tmpDir, CURATED_MODEL);
    await installModel(tmpDir, E4B_MODEL);

    const made: Array<{ modelPath: string; server: any }> = [];
    const { deps } = makeDeps({
      modelsDir: tmpDir,
      makeServer: trackingMakeServer(made),
      prefs: { models: { override: CURATED_MODEL.id, autoInstall: false } },
    });
    const provider = createLocalLlmProvider(deps);
    mockApi.chatText.mockResolvedValue('ok');

    await provider.handle({
      kind: 'complete',
      payload: { prompt: 'a' },
      lane: 'interactive',
    });
    expect(made).toHaveLength(1);
    expect(made[0].modelPath).toContain(CURATED_MODEL.id);

    // Status stays 'ready' throughout this switch, so the routing layer keeps
    // sending traffic — the most-trafficked variant of the stale-model bug.
    await deps.prefs.patch({
      models: { override: E4B_MODEL.id, autoInstall: false },
    });

    await provider.handle({
      kind: 'complete',
      payload: { prompt: 'b' },
      lane: 'interactive',
    });
    expect(made).toHaveLength(2);
    expect(made[1].modelPath).toContain(E4B_MODEL.id);
    expect(made[0].server.stop).toHaveBeenCalledTimes(1); // old child stopped, not leaked
  });

  it('restarts onto the selected model once its install completes (was serving the fallback)', async () => {
    // Only CURATED on disk; the override selects the not-yet-installed E4B,
    // so handle() serves CURATED as the fallback.
    await installModel(tmpDir, CURATED_MODEL);

    const made: Array<{ modelPath: string; server: any }> = [];
    const { deps } = makeDeps({
      modelsDir: tmpDir,
      makeServer: trackingMakeServer(made),
      prefs: { models: { override: E4B_MODEL.id, autoInstall: false } },
    });
    const provider = createLocalLlmProvider(deps);
    mockApi.chatText.mockResolvedValue('ok');

    await provider.handle({
      kind: 'complete',
      payload: { prompt: 'a' },
      lane: 'interactive',
    });
    expect(made).toHaveLength(1);
    expect(made[0].modelPath).toContain(CURATED_MODEL.id);

    // The E4B download completes within the idle window.
    await installModel(tmpDir, E4B_MODEL);

    await provider.handle({
      kind: 'complete',
      payload: { prompt: 'b' },
      lane: 'interactive',
    });
    expect(made).toHaveLength(2);
    expect(made[1].modelPath).toContain(E4B_MODEL.id);
    expect(made[0].server.stop).toHaveBeenCalledTimes(1);
  });

  it('a switch detected while the first start is in flight settles it before stopping (no leaked child)', async () => {
    await installModel(tmpDir, CURATED_MODEL);
    await installModel(tmpDir, E4B_MODEL);

    let releaseFirstStart!: () => void;
    const firstStartGate = new Promise<void>((r) => {
      releaseFirstStart = r;
    });
    const made: Array<{ modelPath: string; server: any }> = [];
    const makeServer = jest.fn((args: { modelPath: string }) => {
      const isFirstChild = made.length === 0;
      const server = {
        // First child's start() hangs until released — the switch lands
        // while it is still spawning.
        start: jest.fn(() =>
          isFirstChild ? firstStartGate : Promise.resolve(),
        ),
        stop: jest.fn(async () => {}),
        baseUrl: () => 'http://x',
      };
      made.push({ modelPath: args.modelPath, server });
      return server;
    });

    const { deps } = makeDeps({
      modelsDir: tmpDir,
      makeServer,
      prefs: { models: { override: CURATED_MODEL.id, autoInstall: false } },
    });
    const provider = createLocalLlmProvider(deps);
    mockApi.chatText.mockResolvedValue('ok');

    const first = provider.handle({
      kind: 'complete',
      payload: { prompt: 'a' },
      lane: 'interactive',
    });
    await new Promise((r) => setTimeout(r, 20)); // first start now in flight
    await deps.prefs.patch({
      models: { override: E4B_MODEL.id, autoInstall: false },
    });
    const second = provider.handle({
      kind: 'complete',
      payload: { prompt: 'b' },
      lane: 'interactive',
    });

    // The switch must WAIT for the in-flight start — stopping now would
    // orphan the still-spawning multi-GB child.
    await new Promise((r) => setTimeout(r, 20));
    expect(made).toHaveLength(1);
    expect(made[0].server.stop).not.toHaveBeenCalled();

    releaseFirstStart();
    await expect(second).resolves.toBe('ok');
    expect(made).toHaveLength(2);
    expect(made[1].modelPath).toContain(E4B_MODEL.id);
    expect(made[0].server.stop).toHaveBeenCalledTimes(1);
    await expect(first).resolves.toBe('ok'); // served by the old child before it stopped
  });
});
