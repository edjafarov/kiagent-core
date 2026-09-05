import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type {
  Change,
  Document,
  Worker,
  WorkerSession,
} from '@shared/contracts';

import { attachBundledWorkers } from '../index';

/**
 * attachBundledWorkers is the ONE seam binding the audio worker's three
 * callbacks — requestAsr, hearReady, transcribeFile — to concrete providers.
 * Nothing else asserts that wiring, so swapping `deps.localAsr.x` for
 * `deps.localLlm.x` (the exact bug found one function below, in
 * registerRedrive) would otherwise leave the whole suite green. Every test
 * here therefore asserts BOTH directions: the right provider was called AND
 * the wrong one was not.
 */

interface FakeProvider {
  ensureInstalled: jest.Mock;
  transcribeFile: jest.Mock;
  status: jest.Mock;
}

function fakeProvider(over: Partial<FakeProvider> = {}): FakeProvider {
  return {
    ensureInstalled: jest.fn(),
    transcribeFile: jest.fn(async () => 'from the WRONG provider'),
    status: jest.fn(() => 'standby'),
    ...over,
  };
}

/** Minimal CorePlatform stub: attach captures workers, providers() is the
 *  inference plane the hearReady gate is supposed to read. */
function makePlatform(
  providers: Array<{ supports: string[]; status: unknown }>,
) {
  const attached: Worker[] = [];
  const platform = {
    prefs: { get: () => ({ processing: { enabled: true, window: 'always' } }) },
    scheduler: {
      env: { onBattery: false, userActive: false },
      register: () => {},
    },
    store: { ledgerDeferred: async () => [] },
    engine: {
      attach: (w: Worker) => {
        attached.push(w);
        return { stop: () => {} };
      },
      rerunDeferred: async () => {},
    },
    inference: { providers: () => providers },
  };
  return { platform: platform as never, attached };
}

function attach(
  providers: Array<{ supports: string[]; status: unknown }>,
  localAsr: FakeProvider,
  localLlm: FakeProvider,
) {
  const { platform, attached } = makePlatform(providers);
  attachBundledWorkers(platform, {
    visionHelper: null,
    localLlm: localLlm as never,
    localAsr: localAsr as never,
  });
  const audio = attached.find((w) => w.name === 'audio');
  if (!audio) throw new Error('audio worker was never attached');
  return audio;
}

const madeDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    madeDirs
      .splice(0)
      .map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => {})),
  );
});

/** A real (tiny) wav on disk, so the default production prepareAudioFile runs
 *  end to end and hands the worker a real path to transcribe. */
async function wavBytes(): Promise<Uint8Array> {
  return new Uint8Array([1, 2, 3, 4]);
}

const doc = {
  id: 'd',
  accountId: 'a',
  externalId: 'x',
  type: 'attachment',
  title: 'note.wav',
  markdown: null,
  metadata: { mime: 'audio/wav', filename: 'note.wav' },
  createdAt: null,
  parentId: null,
  contentHash: 'h',
  seq: 1,
  archivedAt: null,
  languages: [],
  ingestedAt: '2026-01-01',
  updatedAt: '2026-01-01',
  scopeRootId: null,
} as Document;

const change = { seq: 1, kind: 'document', document: doc } as Change;

function fakeSession(bytes: Uint8Array | null) {
  const enriched: unknown[] = [];
  const fetchBytes = jest.fn(async () => bytes);
  const session = {
    signal: new AbortController().signal,
    inference: async () => 'x',
    see: async () => '',
    read: async () => '',
    hear: async () => 'must never happen',
    fetchBytes,
    emit: () => {},
    enrich: (e: unknown) => enriched.push(e),
    log: () => {},
  } as unknown as WorkerSession;
  return { session, fetchBytes, enriched };
}

const READY_HEAR = { supports: ['hear'], status: () => 'ready' };
const READY_SEE = { supports: ['see'], status: () => 'ready' };

describe('attachBundledWorkers — audio worker dep wiring', () => {
  it('requestAsr demands the ASR install, never the LLM one', async () => {
    const localAsr = fakeProvider();
    const localLlm = fakeProvider();
    const audio = attach([], localAsr, localLlm);

    const { session, fetchBytes } = fakeSession(await wavBytes());
    // No hear provider on the plane → defer, but the install is still demanded.
    expect(await audio.work(change, session)).toBe('defer');
    expect(localAsr.ensureInstalled).toHaveBeenCalledTimes(1);
    expect(localLlm.ensureInstalled).not.toHaveBeenCalled();
    expect(fetchBytes).not.toHaveBeenCalled();
  });

  it('hearReady reads the INFERENCE PLANE generically, not localAsr.status()', async () => {
    // The discriminator: the ASR provider itself is NOT ready, while an
    // unrelated provider on the plane serves `hear`. A wiring that reached for
    // deps.localAsr.status() would defer here.
    const localAsr = fakeProvider({ status: jest.fn(() => 'standby') });
    const localLlm = fakeProvider();
    const audio = attach([READY_HEAR], localAsr, localLlm);

    const { session, fetchBytes } = fakeSession(await wavBytes());
    await audio.work(change, session);
    expect(fetchBytes).toHaveBeenCalled(); // got past the hearReady gate
    expect(localAsr.status).not.toHaveBeenCalled();
  });

  it('hearReady ignores providers that do not support hear', async () => {
    // A ready SEE-only provider (local-llm's vision model) must not open the
    // audio gate — `.some(p => p.supports.includes('hear') && …)`, not
    // `.some(p => p.status() === 'ready')`.
    const localAsr = fakeProvider({ status: jest.fn(() => 'ready') });
    const audio = attach([READY_SEE], localAsr, fakeProvider());

    const { session, fetchBytes } = fakeSession(await wavBytes());
    expect(await audio.work(change, session)).toBe('defer');
    expect(fetchBytes).not.toHaveBeenCalled();
  });

  it('transcribeFile routes the prepared PATH to local-asr, never to local-llm', async () => {
    const seen: Array<[string, { format: string }]> = [];
    const localAsr = fakeProvider({
      transcribeFile: jest.fn(async (p: string, o: { format: string }) => {
        seen.push([p, o]);
        // The file the worker prepared must still be on disk for whisper.
        expect((await fs.stat(p)).size).toBe(4);
        return 'the transcript';
      }),
    });
    const localLlm = fakeProvider();
    const audio = attach([READY_HEAR], localAsr, localLlm);

    const { session, enriched } = fakeSession(await wavBytes());
    expect(await audio.work(change, session)).toBe('done');
    expect(localAsr.transcribeFile).toHaveBeenCalledTimes(1);
    expect(localLlm.transcribeFile).not.toHaveBeenCalled();
    expect(localLlm.ensureInstalled).not.toHaveBeenCalled();
    expect(seen[0][1]).toEqual({ format: 'wav' });
    expect(enriched[0]).toMatchObject({
      documentId: 'd',
      markdown: 'the transcript',
      metadata: { extraction: { engine: 'local-asr' } },
    });
    // The real prepare ran (a per-call temp dir under tmpdir), and the worker
    // cleaned it up afterwards.
    expect(path.dirname(path.dirname(seen[0][0]))).toBe(os.tmpdir());
    await expect(fs.stat(path.dirname(seen[0][0]))).rejects.toThrow();
  });
});
