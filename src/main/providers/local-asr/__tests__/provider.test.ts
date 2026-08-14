import fs from 'node:fs';
import fsp, { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Prefs } from '@shared/contracts';

import type { ModelDescriptor } from '../../local-llm/models';
import { AsrInputRejectedError, createLocalAsrProvider } from '../index';
import { WHISPER_LARGE_V3_TURBO_Q5_0, WHISPER_SMALL_Q5_1 } from '../models';

const BIN = '/opt/kiagent/whisper/whisper-cli';

/** Mirrors local-llm/__tests__/provider.test.ts's Prefs fake. */
function fakePrefs(overrides?: {
  models?: { override?: string; autoInstall?: boolean };
}): Prefs {
  let current = {
    theme: 'system' as const,
    logLevel: 'info' as const,
    launchAtLogin: false,
    showInMenuBar: false,
    processing: { enabled: true, window: 'always' as const },
    models: { override: 'auto', autoInstall: true, ...overrides?.models },
  } as any;
  return {
    get: () => current,
    patch: async (p) => {
      current = { ...current, ...p };
    },
    onChange: () => () => {},
  };
}

/** All fakes by default: no child process, no network, no real model file. */
function makeDeps(over: Record<string, any> = {}) {
  const { prefs: prefOverrides, ...rest } = over;
  return {
    binaryPath: BIN,
    asrModelsDir: over.asrModelsDir as string,
    prefs: fakePrefs(prefOverrides),
    log: jest.fn(),
    probes: {
      platform: 'darwin' as NodeJS.Platform,
      totalMemBytes: 32 * 1024 ** 3,
    },
    binaryPresent: jest.fn(() => true),
    filesPresent: jest.fn(() => false),
    download: jest.fn(async () => {}),
    runCli: jest.fn(async () => 'the transcript'),
    ...rest,
  } as any;
}

/** A `filesPresent` fake keyed on the EXACT directory it is asked about, which
 *  also records every (modelId, dir) pair the provider ever probes. */
function keyedFilesPresent(presentDirs: string[]) {
  const seen: Array<{ id: string; dir: string }> = [];
  const fn = jest.fn((m: ModelDescriptor, dir: string) => {
    seen.push({ id: m.id, dir });
    return presentDirs.includes(dir);
  });
  return { fn, seen };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

describe('LocalAsrProvider', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), 'asr-provider-test-'));
    jest.clearAllMocks();
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  // ── 1. status machine ──────────────────────────────────────────────────────

  it('is unsupported when the vendored whisper-cli is missing (win32-arm64)', () => {
    const deps = makeDeps({
      asrModelsDir: tmpDir,
      probes: { platform: 'win32', totalMemBytes: 16 * 1024 ** 3 },
      binaryPresent: jest.fn(() => false),
    });
    const provider = createLocalAsrProvider(deps);

    expect(provider.status()).toBe('unsupported');
    expect(deps.binaryPresent).toHaveBeenCalledWith(BIN);

    // The platform gate also suppresses the install entirely.
    provider.ensureInstalled();
    expect(deps.download).not.toHaveBeenCalled();
    expect(provider.status()).toBe('unsupported');
  });

  it('is standby with the binary present and the model absent', () => {
    const provider = createLocalAsrProvider(makeDeps({ asrModelsDir: tmpDir }));
    expect(provider.status()).toBe('standby');
  });

  it('is ready when the selected tier model is present on disk', () => {
    const { fn } = keyedFilesPresent([
      path.join(tmpDir, WHISPER_LARGE_V3_TURBO_Q5_0.id),
    ]);
    const provider = createLocalAsrProvider(
      makeDeps({ asrModelsDir: tmpDir, filesPresent: fn }),
    );
    expect(provider.status()).toBe('ready');
  });

  it('publishes {downloading:{pct:0}} SYNCHRONOUSLY — before ensureInstalled awaits anything', () => {
    // A Settings screen that refreshes on the very next tick after Install
    // must see {downloading} and start polling, never a transient standby.
    let onProgress!: (received: number, total: number) => void;
    const download = jest.fn((_m: any, _d: string, opts: any) => {
      onProgress = opts.onProgress;
      return new Promise<void>(() => {}); // never settles
    });
    const provider = createLocalAsrProvider(
      makeDeps({ asrModelsDir: tmpDir, download }),
    );

    expect(provider.status()).toBe('standby');
    provider.ensureInstalled();
    // NO await here on purpose — this is the assertion the test exists for.
    expect(provider.status()).toEqual({ downloading: { pct: 0 } });

    onProgress(50, 100);
    expect(provider.status()).toEqual({ downloading: { pct: 50 } });
  });

  it('reports {error} after a failed download', async () => {
    const download = jest.fn(async () => {
      throw new Error('network down');
    });
    const provider = createLocalAsrProvider(
      makeDeps({ asrModelsDir: tmpDir, download }),
    );

    provider.ensureInstalled();
    await tick();

    expect(provider.status()).toEqual({ error: 'network down' });
  });

  it('cancelInstall aborts the download and returns to standby', async () => {
    let captured: AbortSignal | undefined;
    const download = jest.fn(
      (_m: any, _d: string, opts: any) =>
        new Promise<void>((_res, rej) => {
          captured = opts.signal;
          opts.signal.addEventListener(
            'abort',
            () => rej(new Error('aborted')),
            { once: true },
          );
        }),
    );
    const provider = createLocalAsrProvider(
      makeDeps({ asrModelsDir: tmpDir, download }),
    );

    provider.ensureInstalled();
    await tick();
    expect(captured?.aborted).toBe(false);

    await provider.cancelInstall();
    expect(captured?.aborted).toBe(true);
    expect(provider.status()).toBe('standby');

    // The aborted run settling late must not resurface as an {error}.
    await tick();
    expect(provider.status()).toBe('standby');
  });

  // ── 2. ensureInstalled gating ──────────────────────────────────────────────

  it('does not install when models.autoInstall is false', async () => {
    const deps = makeDeps({
      asrModelsDir: tmpDir,
      prefs: { models: { autoInstall: false } },
    });
    const provider = createLocalAsrProvider(deps);

    provider.ensureInstalled();
    await tick();
    expect(deps.download).not.toHaveBeenCalled();
    expect(provider.status()).toBe('standby');

    await deps.prefs.patch({ models: { override: 'auto', autoInstall: true } });
    provider.ensureInstalled();
    await tick();
    expect(deps.download).toHaveBeenCalledTimes(1);
  });

  it('does not start a second download while one is in flight', async () => {
    const download = jest.fn(() => new Promise<void>(() => {}));
    const provider = createLocalAsrProvider(
      makeDeps({ asrModelsDir: tmpDir, download }),
    );

    provider.ensureInstalled();
    provider.ensureInstalled();
    await tick();
    provider.ensureInstalled();
    await tick();

    expect(download).toHaveBeenCalledTimes(1);
  });

  it('does not install when the selected model is already installed', async () => {
    const { fn } = keyedFilesPresent([
      path.join(tmpDir, WHISPER_LARGE_V3_TURBO_Q5_0.id),
    ]);
    const deps = makeDeps({ asrModelsDir: tmpDir, filesPresent: fn });
    const provider = createLocalAsrProvider(deps);

    provider.ensureInstalled();
    await tick();
    expect(deps.download).not.toHaveBeenCalled();
    expect(provider.status()).toBe('ready');
  });

  it('downloads the tier model chosen from probes into its own namespaced dir', async () => {
    const deps = makeDeps({ asrModelsDir: tmpDir }); // darwin + 32 GiB
    const provider = createLocalAsrProvider(deps);

    provider.ensureInstalled();
    await tick();

    expect(deps.download).toHaveBeenCalledTimes(1);
    const [model, dest] = deps.download.mock.calls[0];
    expect(model.id).toBe('whisper-large-v3-turbo-q5_0');
    expect(dest).toBe(path.join(tmpDir, 'whisper-large-v3-turbo-q5_0'));
  });

  it('drops to the CPU tier off darwin (no metal-gated large-v3-turbo)', async () => {
    const deps = makeDeps({
      asrModelsDir: tmpDir,
      probes: { platform: 'linux', totalMemBytes: 32 * 1024 ** 3 },
    });
    const provider = createLocalAsrProvider(deps);

    provider.ensureInstalled();
    await tick();

    expect(deps.download.mock.calls[0][0].id).toBe(WHISPER_SMALL_Q5_1.id);
  });

  // ── 3. single-flight ───────────────────────────────────────────────────────

  it('single-flights transcription: a second request queues, it does not spawn a second whisper', async () => {
    const { fn } = keyedFilesPresent([
      path.join(tmpDir, WHISPER_LARGE_V3_TURBO_Q5_0.id),
    ]);
    let releaseFirst!: (text: string) => void;
    const firstGate = new Promise<string>((res) => {
      releaseFirst = res;
    });
    const runCli = jest.fn((args: any) =>
      args.inputPath === '/a.wav' ? firstGate : Promise.resolve('second'),
    );

    const provider = createLocalAsrProvider(
      makeDeps({ asrModelsDir: tmpDir, filesPresent: fn, runCli }),
    );

    const p1 = provider.transcribeFile('/a.wav', { format: 'wav' });
    const p2 = provider.transcribeFile('/b.wav', { format: 'wav' });

    // pump() runs synchronously inside the executor, so job 1 is already
    // running — but job 2 must NOT have reached runCli.
    expect(runCli).toHaveBeenCalledTimes(1);
    await tick();
    expect(runCli).toHaveBeenCalledTimes(1);
    expect(runCli.mock.calls[0][0].inputPath).toBe('/a.wav');

    releaseFirst('first');

    await expect(p1).resolves.toBe('first');
    await expect(p2).resolves.toBe('second');
    expect(runCli).toHaveBeenCalledTimes(2);
    expect(runCli.mock.calls[1][0].inputPath).toBe('/b.wav');
  });

  // ── 4. dispose with one active + one queued ────────────────────────────────

  it('dispose aborts the active child AND rejects the queue (no post-dispose spawn)', async () => {
    // before-quit disposes providers BEFORE it stops the workers, so a queued
    // request taking the freed slot would spawn a whisper child that outlives
    // the app. The permanent `closing` flag is what prevents that.
    const { fn } = keyedFilesPresent([
      path.join(tmpDir, WHISPER_LARGE_V3_TURBO_Q5_0.id),
    ]);
    const signals: AbortSignal[] = [];
    const runCli = jest.fn(
      (args: any) =>
        new Promise<string>((_res, rej) => {
          signals.push(args.signal);
          args.signal.addEventListener(
            'abort',
            () => rej(new Error('whisper-cli killed by SIGTERM')),
            { once: true },
          );
        }),
    );

    const deps = makeDeps({
      asrModelsDir: tmpDir,
      filesPresent: fn,
      runCli,
    });
    const provider = createLocalAsrProvider(deps);

    const p1 = provider.transcribeFile('/active.wav', { format: 'wav' });
    const p2 = provider.transcribeFile('/queued.wav', { format: 'wav' });
    // Attach handlers immediately so neither can register as an unhandled
    // rejection while dispose() settles them.
    const p1Err: Promise<Error> = p1.then(
      () => new Error('expected rejection'),
      (e: Error) => e,
    );
    const p2Err: Promise<Error> = p2.then(
      () => new Error('expected rejection'),
      (e: Error) => e,
    );

    await tick();
    expect(runCli).toHaveBeenCalledTimes(1);
    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(false);

    await provider.dispose();

    // The active child is aborted; the queued job never reached runCli.
    expect(signals[0].aborted).toBe(true);
    expect(runCli).toHaveBeenCalledTimes(1);

    expect((await p2Err).message).toMatch(/disposed/);
    expect((await p1Err).message).toMatch(/SIGTERM/);
    expect(runCli).toHaveBeenCalledTimes(1);

    // A post-dispose request rejects immediately rather than starting work.
    await expect(
      provider.transcribeFile('/late.wav', { format: 'wav' }),
    ).rejects.toThrow(/disposed/);
    await expect(
      provider.handle({
        kind: 'hear',
        payload: { audio: new Uint8Array([1]), format: 'wav' },
        lane: 'background',
      }),
    ).rejects.toThrow(/disposed/);
    expect(runCli).toHaveBeenCalledTimes(1);
    expect(signals).toHaveLength(1);

    // ensureInstalled is dead too, and quitting never flips the pref.
    provider.ensureInstalled();
    await tick();
    expect(deps.download).not.toHaveBeenCalled();
    expect(deps.prefs.get().models.autoInstall).toBe(true);
  });

  it('dispose aborts an in-flight install', async () => {
    let captured: AbortSignal | undefined;
    const download = jest.fn(
      (_m: any, _d: string, opts: any) =>
        new Promise<void>((_res, rej) => {
          captured = opts.signal;
          opts.signal.addEventListener(
            'abort',
            () => rej(new Error('aborted')),
            { once: true },
          );
        }),
    );
    const provider = createLocalAsrProvider(
      makeDeps({ asrModelsDir: tmpDir, download }),
    );

    provider.ensureInstalled();
    await tick();
    expect(captured?.aborted).toBe(false);

    await provider.dispose();
    expect(captured?.aborted).toBe(true);
  });

  // ── 5. handle('hear') byte route ───────────────────────────────────────────

  it("handle('hear') writes the bytes to a temp file, transcribes it, and removes it", async () => {
    const modelPath = path.join(
      tmpDir,
      WHISPER_LARGE_V3_TURBO_Q5_0.id,
      WHISPER_LARGE_V3_TURBO_Q5_0.files[0].name,
    );
    const { fn } = keyedFilesPresent([
      path.join(tmpDir, WHISPER_LARGE_V3_TURBO_Q5_0.id),
    ]);
    const bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]);
    let seen: Buffer | undefined;
    let seenPath: string | undefined;
    const runCli = jest.fn(async (args: any) => {
      // Read SYNCHRONOUSLY: handle()'s finally removes the file the moment
      // transcribeFile settles.
      seenPath = args.inputPath;
      seen = fs.readFileSync(args.inputPath);
      return 'guten morgen';
    });

    const provider = createLocalAsrProvider(
      makeDeps({ asrModelsDir: tmpDir, filesPresent: fn, runCli }),
    );

    const out = await provider.handle({
      kind: 'hear',
      payload: { audio: bytes, format: 'wav' },
      lane: 'background',
    });

    expect(out).toBe('guten morgen');
    expect(seen && Uint8Array.from(seen)).toEqual(bytes);
    expect(seenPath!.endsWith('.wav')).toBe(true);
    expect(fs.existsSync(seenPath!)).toBe(false);
    expect(runCli.mock.calls[0][0]).toMatchObject({
      binaryPath: BIN,
      modelPath,
    });
  });

  it("handle('hear') removes the temp file on the failure path too", async () => {
    const { fn } = keyedFilesPresent([
      path.join(tmpDir, WHISPER_LARGE_V3_TURBO_Q5_0.id),
    ]);
    let seenPath: string | undefined;
    const runCli = jest.fn(async (args: any) => {
      seenPath = args.inputPath;
      expect(fs.existsSync(args.inputPath)).toBe(true);
      throw new AsrInputRejectedError('could not decode');
    });

    const provider = createLocalAsrProvider(
      makeDeps({ asrModelsDir: tmpDir, filesPresent: fn, runCli }),
    );

    await expect(
      provider.handle({
        kind: 'hear',
        payload: { audio: new Uint8Array([9, 9]), format: 'mp3' },
        lane: 'background',
      }),
    ).rejects.toBeInstanceOf(AsrInputRejectedError);

    expect(seenPath!.endsWith('.mp3')).toBe(true);
    expect(fs.existsSync(seenPath!)).toBe(false);
  });

  it('advertises only hear and rejects other kinds', async () => {
    const provider = createLocalAsrProvider(makeDeps({ asrModelsDir: tmpDir }));
    expect(provider.id).toBe('local-asr');
    expect(provider.supports).toEqual(['hear']);
    await expect(
      provider.handle({
        kind: 'complete',
        payload: { prompt: 'x' },
        lane: 'interactive',
      }),
    ).rejects.toThrow(/does not support 'complete'/);
  });

  // ── 6. model not installed ─────────────────────────────────────────────────

  it('rejects with a plain (transient) Error when the model is not installed', async () => {
    const deps = makeDeps({ asrModelsDir: tmpDir }); // filesPresent → false
    const provider = createLocalAsrProvider(deps);

    const err = await provider.transcribeFile('/a.wav', { format: 'wav' }).then(
      () => new Error('expected rejection'),
      (e: Error) => e,
    );

    expect(err.message).toMatch(/not installed/);
    // Plain Error → the audio worker DEFERS. An AsrInputRejectedError here
    // would make the worker permanently skip the file instead.
    expect(err).not.toBeInstanceOf(AsrInputRejectedError);
    expect(deps.runCli).not.toHaveBeenCalled();

    // The failed job must free the single-flight slot for the next request.
    await expect(
      provider.transcribeFile('/b.wav', { format: 'wav' }),
    ).rejects.toThrow(/not installed/);
  });

  // ── 7. models-dir namespacing ──────────────────────────────────────────────

  it('never treats a Gemma install in the ASR models dir as a whisper model', async () => {
    const gemmaDir = path.join(tmpDir, 'gemma-4-12b-it-Q4_K_M');
    await fsp.mkdir(gemmaDir, { recursive: true });
    await fsp.writeFile(path.join(gemmaDir, 'model.gguf'), 'not whisper');

    // Only the Gemma dir "has files" — so a provider that scanned the models
    // dir (or resolved ids loosely) would report ready.
    const { fn, seen } = keyedFilesPresent([gemmaDir]);
    const deps = makeDeps({ asrModelsDir: tmpDir, filesPresent: fn });
    const provider = createLocalAsrProvider(deps);

    expect(provider.status()).toBe('standby');
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((s) => s.dir !== gemmaDir)).toBe(true);
    expect(seen.every((s) => s.id.startsWith('whisper-'))).toBe(true);

    provider.ensureInstalled();
    await tick();
    expect(deps.download.mock.calls[0][1]).toBe(
      path.join(tmpDir, WHISPER_LARGE_V3_TURBO_Q5_0.id),
    );
  });
});
