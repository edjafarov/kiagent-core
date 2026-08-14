import type { Change, Document, WorkerSession } from '@shared/contracts';

import {
  CapabilityUnsupportedError,
  LaneClosedError,
  NoProviderError,
} from '@main/core/inference';

import { createAudioWorker } from '../audio-worker';
import { MAX_SOURCE_BYTES } from '../classify';
import { AudioUnsupportedFormatError } from '../transcode';

const baseDoc = {
  id: 'd',
  accountId: 'a',
  externalId: 'x',
  type: 'attachment',
  title: 'voice-note.m4a',
  markdown: null,
  metadata: { mime: 'audio/mp4', filename: 'voice-note.m4a' },
  createdAt: null,
  parentId: null,
  contentHash: 'h',
  seq: 1,
  archivedAt: null,
  languages: [],
  ingestedAt: '2026-01-01',
  updatedAt: '2026-01-01',
} as Document;

function fakeSession(
  over: Partial<WorkerSession> = {},
): WorkerSession & { enriched: any[] } {
  const enriched: any[] = [];
  return {
    enriched,
    signal: new AbortController().signal,
    inference: async () => 'x',
    see: async () => '',
    read: async () => '',
    hear: async () => 'the transcript',
    fetchBytes: async () => new Uint8Array([1, 2, 3]),
    emit: () => {},
    enrich: (e) => enriched.push(e),
    log: () => {},
    ...over,
  };
}

const change = (doc: Partial<Document> = {}): Change =>
  ({ seq: 1, kind: 'document', document: { ...baseDoc, ...doc } }) as Change;

// A default worker whose transcode is a no-op passthrough (wav), so tests
// exercise the worker's control flow without spawning afconvert.
const worker = (over: Partial<Parameters<typeof createAudioWorker>[0]> = {}) =>
  createAudioWorker({
    laneOpen: () => true,
    prepare: async (data) => ({ data, format: 'wav' }),
    ...over,
  });

describe('createAudioWorker', () => {
  it('matches audio documents and skips non-audio ones', () => {
    const w = worker();
    expect(w.matches(change())).toBe(true);
    expect(
      w.matches(change({ metadata: { mime: 'image/png', filename: 'a.png' } })),
    ).toBe(false);
  });

  it('transcribes and enriches the document body with the transcript', async () => {
    const session = fakeSession();
    const outcome = await worker().work(change(), session);
    expect(outcome).toBe('done');
    expect(session.enriched).toHaveLength(1);
    expect(session.enriched[0]).toMatchObject({
      documentId: 'd',
      markdown: 'the transcript',
      metadata: { extraction: { engine: 'local-asr' } },
    });
  });

  it('defers (no work) when the processing window is closed', async () => {
    const fetchBytes = jest.fn(async () => new Uint8Array([1]));
    const outcome = await worker({ laneOpen: () => false }).work(
      change(),
      fakeSession({ fetchBytes }),
    );
    expect(outcome).toBe('defer');
    expect(fetchBytes).not.toHaveBeenCalled();
  });

  it('skips when the source cannot serve the bytes', async () => {
    const outcome = await worker().work(
      change(),
      fakeSession({ fetchBytes: async () => null }),
    );
    expect(outcome).toBe('skip');
  });

  it('a ~30 MB no-size-metadata doc passes the fetch backstop (the old 25 MiB cap is gone)', async () => {
    const prepare = jest.fn(async (data: Uint8Array) => ({
      data,
      format: 'wav' as const,
    }));
    const bytes = new Uint8Array(30 * 1024 * 1024);
    const outcome = await worker({ prepare }).work(
      change(),
      fakeSession({ fetchBytes: async () => bytes }),
    );
    expect(outcome).toBe('done');
    expect(prepare).toHaveBeenCalled();
  });

  it('the fetch backstop still rejects over MAX_SOURCE_BYTES when metadata carried no size', async () => {
    const prepare = jest.fn(async (data: Uint8Array) => ({
      data,
      format: 'wav' as const,
    }));
    // Duck-typed, not a real ~200 MB allocation: only `.length` is read by
    // the backstop check, so a real buffer would just be a flake-prone
    // allocation under this suite's concurrent-load runs for no coverage
    // gain.
    const oversized = { length: MAX_SOURCE_BYTES + 1 } as unknown as Uint8Array;
    const outcome = await worker({ prepare }).work(
      change(),
      fakeSession({ fetchBytes: async () => oversized }),
    );
    expect(outcome).toBe('skip');
    expect(prepare).not.toHaveBeenCalled();
  });

  it('skips (permanent) when the host cannot decode the format', async () => {
    const outcome = await worker({
      prepare: async () => {
        throw new AudioUnsupportedFormatError('no transcoder on linux');
      },
    }).work(change(), fakeSession());
    expect(outcome).toBe('skip');
  });

  it('skips (permanent) when the loaded model has no audio encoder', async () => {
    const outcome = await worker().work(
      change(),
      fakeSession({
        hear: async () => {
          throw new CapabilityUnsupportedError('model has no audio encoder');
        },
      }),
    );
    expect(outcome).toBe('skip');
  });

  it('defers when no audio provider is ready yet (model still installing)', async () => {
    const outcome = await worker().work(
      change(),
      fakeSession({
        hear: async () => {
          throw new NoProviderError('hear');
        },
      }),
    );
    expect(outcome).toBe('defer');
  });

  it('defers when the inference lane closes mid-run', async () => {
    const outcome = await worker().work(
      change(),
      fakeSession({
        hear: async () => {
          throw new LaneClosedError();
        },
      }),
    );
    expect(outcome).toBe('defer');
  });

  it('skips (permanent) when the server rejects the input with a 4xx (e.g. clip too long for the context)', async () => {
    const outcome = await worker().work(
      change(),
      fakeSession({
        hear: async () => {
          const e = new Error('asr request failed: HTTP 400') as Error & {
            status?: number;
          };
          e.status = 400;
          throw e;
        },
      }),
    );
    expect(outcome).toBe('skip');
  });

  it('defers on a transient 5xx server fault', async () => {
    const outcome = await worker().work(
      change(),
      fakeSession({
        hear: async () => {
          const e = new Error('asr request failed: HTTP 503') as Error & {
            status?: number;
          };
          e.status = 503;
          throw e;
        },
      }),
    );
    expect(outcome).toBe('defer');
  });

  it('throws on an empty transcript so the engine retries (bounded), not skips', async () => {
    await expect(
      worker().work(change(), fakeSession({ hear: async () => '   ' })),
    ).rejects.toThrow(/empty transcript/);
  });
});
