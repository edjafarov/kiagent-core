import fs from 'fs';
import path from 'path';
import fsp, { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import type { Prefs } from '@shared/contracts';
import { createLocalLlmProvider } from '../provider';
import type { ServerLike } from '../provider';
import { E4B_MODEL, EMBEDDING_MODEL } from '../models';

jest.mock('../api');
jest.mock('../capability');
const mockApi = jest.mocked(require('../api'), { shallow: true });
const mockCapability = jest.mocked(require('../capability'), { shallow: true });

const flush = () => new Promise((r) => setTimeout(r, 0));
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

function prefs(autoInstall = true): Prefs {
  const current = {
    processing: { enabled: true, window: 'always' },
    models: { override: E4B_MODEL.id, autoInstall },
  } as any;
  return {
    get: () => current,
    patch: async () => {},
    onChange: () => () => {},
  };
}

interface Made {
  args: { modelPath: string; mmprojPath?: string; embeddings?: boolean };
  server: ServerLike & { stop: jest.Mock };
}

function setup(opts: {
  chat?: boolean;
  embed?: boolean;
  autoInstall?: boolean;
  tmp: string;
}) {
  if (opts.chat)
    fs.mkdirSync(path.join(opts.tmp, E4B_MODEL.id), { recursive: true });
  if (opts.embed)
    fs.mkdirSync(path.join(opts.tmp, EMBEDDING_MODEL.id), { recursive: true });
  const made: Made[] = [];
  const stopHold: { next: Promise<void> | null } = { next: null };
  const download = jest.fn(async (m: { id: string }, dest: string) => {
    fs.mkdirSync(dest, { recursive: true });
  });
  const provider = createLocalLlmProvider({
    llamaBinaryPath: '/bin/llama-server',
    modelsDir: opts.tmp,
    prefs: prefs(opts.autoInstall ?? true),
    log: () => {},
    host: {
      platform: 'darwin',
      arch: 'arm64',
      cores: 10,
      totalMemBytes: 64 * 1024 ** 3,
    } as any,
    detect: async () => ({
      accel: 'metal' as const,
      capacityBytes: 64 * 1024 ** 3,
    }),
    download: download as any,
    filesPresent: (_m, dir) => fs.existsSync(dir),
    makeServer: (args) => {
      const hold = stopHold.next;
      stopHold.next = null;
      const server = {
        start: jest.fn(async () => {}),
        stop: jest.fn(async () => {
          if (hold) await hold;
        }),
        baseUrl: () => `http://s${made.length}`,
      };
      made.push({ args, server });
      return server;
    },
    idleStopMs: 60_000,
  });
  return { provider, made, download, stopHold };
}

const complete = (lane: 'interactive' | 'background') => ({
  kind: 'complete' as const,
  payload: { prompt: 'hi' },
  lane,
});
const embed = {
  kind: 'embed' as const,
  payload: { texts: ['a'] },
  lane: 'background' as const,
};

describe('local-embed provider', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'embed-provider-'));
    jest.clearAllMocks();
    mockCapability.checkCapability.mockReturnValue({ ok: true });
    mockApi.chatText.mockResolvedValue({ text: 'ok' });
    mockApi.embedTexts.mockResolvedValue([new Float32Array([1])]);
  });
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it('reports its own readiness, independent of the chat model', () => {
    const { provider } = setup({ tmp, embed: true });
    expect(provider.embedProvider.status()).toBe('ready');
    expect(provider.status()).toBe('standby');
    expect(provider.embedProvider.describe?.('embed')).toEqual({
      modelId: EMBEDDING_MODEL.id,
    });
  });

  it('an embedding model on disk never becomes the chat model', () => {
    const { provider } = setup({ tmp, embed: true });
    expect(provider.describe?.('complete')).toBeNull();
  });

  it('embeds on an embeddings-mode server without an mmproj, then holds the server', async () => {
    const { provider, made } = setup({ tmp, chat: true, embed: true });
    await provider.embedProvider.handle(embed);
    expect(made[0].args).toMatchObject({ embeddings: true });
    expect(made[0].args.mmprojPath).toBeUndefined();
    expect(made[0].args.modelPath).toContain(EMBEDDING_MODEL.files[0].name);
    await expect(provider.handle(complete('background'))).rejects.toMatchObject(
      {
        name: 'LaneClosedError',
      },
    );
  });

  it('an interactive call swaps back to the chat model', async () => {
    const { provider, made } = setup({ tmp, chat: true, embed: true });
    await provider.embedProvider.handle(embed);
    await provider.handle(complete('interactive'));
    expect(made).toHaveLength(2);
    expect(made[0].server.stop).toHaveBeenCalled();
    expect(made[1].args.embeddings).toBeUndefined();
    expect(made[1].args.modelPath).toContain(E4B_MODEL.files[0].name);
  });

  it('an embed swap is not a model change', async () => {
    const { provider } = setup({ tmp, chat: true, embed: true });
    const onChange = jest.fn();
    provider.onChange?.(onChange);
    const before = provider.describe?.('complete');
    await provider.embedProvider.handle(embed);
    expect(onChange).not.toHaveBeenCalled();
    expect(provider.describe?.('complete')).toEqual(before);
  });

  it('keeps the chat gate until the chat request settles', async () => {
    const { provider, made } = setup({ tmp, chat: true, embed: true });
    const answer = deferred<{ text: string }>();
    mockApi.chatText.mockReturnValueOnce(answer.promise);
    const chat = provider.handle(complete('background'));
    await flush();
    const emb = provider.embedProvider.handle(embed);
    await flush();
    expect(made).toHaveLength(1); // no embed server while chat is answering
    answer.resolve({ text: 'ok' });
    await chat;
    await emb;
    expect(made).toHaveLength(2);
    expect(made[1].args.embeddings).toBe(true);
  });

  it('never starts the chat server while the embed server is still stopping', async () => {
    const { provider, made, stopHold } = setup({
      tmp,
      chat: true,
      embed: true,
    });
    const stopped = deferred<void>();
    stopHold.next = stopped.promise; // the embed server's stop() hangs
    await provider.embedProvider.handle(embed);
    const a = provider.handle(complete('interactive'));
    const b = provider.handle(complete('interactive'));
    await flush();
    expect(made).toHaveLength(1);
    stopped.resolve();
    await Promise.all([a, b]);
    expect(made).toHaveLength(2); // exactly one chat server for both callers
  });

  it('an idle stop in progress delays the next start (never two children)', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    try {
      const { provider, made, stopHold } = setup({
        tmp,
        chat: true,
        embed: true,
      });
      const stopped = deferred<void>();
      stopHold.next = stopped.promise;
      await provider.embedProvider.handle(embed); // server 0 (embed), idle armed
      await jest.advanceTimersByTimeAsync(60_000); // idle stop starts, hangs
      expect(made[0].server.stop).toHaveBeenCalled();
      const next = provider.embedProvider.handle(embed);
      await jest.advanceTimersByTimeAsync(0);
      expect(made).toHaveLength(1);
      stopped.resolve();
      await next;
      expect(made).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('after dispose nothing starts: a queued embed is refused, no server', async () => {
    const { provider, made } = setup({ tmp, chat: true, embed: true });
    const answer = deferred<{ text: string }>();
    mockApi.chatText.mockReturnValueOnce(answer.promise);
    const chat = provider.handle(complete('background'));
    await flush();
    const emb = provider.embedProvider.handle(embed); // waits behind chat
    const disposing = provider.dispose();
    answer.resolve({ text: 'ok' });
    await chat;
    await expect(emb).rejects.toThrow(/shut down/);
    await disposing;
    expect(made).toHaveLength(1);
  });

  it('dispose waits for an idle stop still in progress', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    try {
      const { provider, stopHold } = setup({ tmp, chat: true, embed: true });
      const stopped = deferred<void>();
      stopHold.next = stopped.promise;
      await provider.embedProvider.handle(embed);
      await jest.advanceTimersByTimeAsync(60_000); // idle stop hangs
      let done = false;
      const d = provider.dispose().then(() => {
        done = true;
      });
      await jest.advanceTimersByTimeAsync(0);
      expect(done).toBe(false);
      stopped.resolve();
      await d;
      expect(done).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('nothing downloads after dispose', async () => {
    const { provider, download } = setup({ tmp });
    await provider.dispose();
    provider.ensureInstalled();
    provider.ensureEmbedInstalled();
    await flush();
    expect(download).not.toHaveBeenCalled();
  });

  it('a chat download cancelled mid-way does not start the embedding download', async () => {
    const { provider, download } = setup({ tmp });
    const gate = deferred<void>();
    download.mockImplementationOnce(async () => gate.promise);
    provider.ensureInstalled();
    await flush();
    await provider.cancelInstall();
    gate.resolve();
    await flush();
    await flush();
    expect(download.mock.calls.map((c) => c[0].id)).toEqual([E4B_MODEL.id]);
  });

  it('downloads the embedding model when the chat model is already installed', async () => {
    const { provider, download } = setup({ tmp, chat: true });
    expect(provider.embedProvider.status()).toBe('standby');
    expect(provider.embedProvider.mayBecomeReady?.()).toBe(true);
    provider.ensureEmbedInstalled();
    expect(provider.embedProvider.status()).toEqual({
      downloading: { pct: 0 },
    });
    expect(provider.status()).toBe('ready'); // chat unaffected
    await flush();
    await flush();
    expect(download.mock.calls.map((c) => c[0].id)).toEqual([
      EMBEDDING_MODEL.id,
    ]);
    expect(provider.embedProvider.status()).toBe('ready');
  });

  it('downloads nothing when Local AI may not install models', async () => {
    const { provider, download } = setup({
      tmp,
      chat: true,
      autoInstall: false,
    });
    provider.ensureEmbedInstalled();
    provider.ensureInstalled();
    await flush();
    expect(download).not.toHaveBeenCalled();
    expect(provider.embedProvider.mayBecomeReady?.()).toBe(false);
  });
});
