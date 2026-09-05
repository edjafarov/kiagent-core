import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Change, Document, WorkerSession } from '@shared/contracts';

import { workerConsumerName } from '@main/core/engine/engine';
import { NoProviderError } from '@main/core/inference';
import { AsrInputRejectedError } from '@main/providers/local-asr/whisper-cli';

import { createAudioWorker, maxDecodedBytes } from '../audio-worker';
import { MAX_SOURCE_BYTES } from '../classify';
import {
  AudioUnsupportedFormatError,
  type PreparedAudioFile,
} from '../transcode';

const GiB = 1024 ** 3;
const MiB = 1024 * 1024;

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
  scopeRootId: null,
} as Document;

const change = (doc: Partial<Document> = {}): Change =>
  ({ seq: 1, kind: 'document', document: { ...baseDoc, ...doc } }) as Change;

// ── temp-file plumbing ──────────────────────────────────────────────────────
// Every stub `prepareFile` writes a REAL (tiny) file in its own REAL mkdtemp
// directory — exactly what production's prepareAudioFile hands back — so the
// deletion assertions test the worker's `finally`, not a mock. The mkdtemp is
// not optional: the worker removes `prepared.dir` RECURSIVELY, so a stub that
// reported `dir: os.tmpdir()` would wipe the machine's temp directory.

const madeDirs: string[] = [];

async function makeTempFile(): Promise<{ path: string; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiagent-asr-wtest-'));
  madeDirs.push(dir);
  const p = path.join(dir, 'audio.bin');
  await fs.writeFile(p, Buffer.alloc(4));
  return { path: p, dir };
}

/** The worker must remove the prepared file AND the temp DIRECTORY it lives
 *  in: prepare owns a fresh 0700 dir per call, so a file-only `rm` leaks one
 *  empty directory per transcribed document. */
async function expectCleaned(
  p: { paths: string[]; dirs: string[] },
  i = 0,
): Promise<void> {
  expect(await isGone(p.paths[i])).toBe(true);
  expect(await isGone(p.dirs[i])).toBe(true);
}

async function isGone(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return false;
  } catch {
    return true;
  }
}

afterEach(async () => {
  await Promise.all(
    madeDirs
      .splice(0)
      .map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => {})),
  );
});

interface PrepareSpec {
  format: 'wav' | 'mp3';
  sizeBytes: number;
}

/**
 * A `prepareFile` stub that writes a real temp file in its own real temp
 * directory per call and reports the given format/size. `onForceWav` drives
 * the re-probe branch: a spec (the re-prepare succeeds) or an Error (the
 * re-prepare rejects). `.paths` records every path handed out, in order, and
 * `.dirs` the directory each one lived in.
 */
function preparer(first: PrepareSpec, onForceWav?: PrepareSpec | Error) {
  const paths: string[] = [];
  const dirs: string[] = [];
  const fn = jest.fn(
    async (
      _bytes: Uint8Array,
      _meta: { mime?: string; ext?: string },
      opts?: { forceWav?: boolean },
    ): Promise<PreparedAudioFile> => {
      if (opts?.forceWav) {
        if (onForceWav === undefined) {
          throw new Error('unexpected forceWav re-prepare');
        }
        if (onForceWav instanceof Error) throw onForceWav;
        const p = await makeTempFile();
        paths.push(p.path);
        dirs.push(p.dir);
        return { ...p, ...onForceWav };
      }
      const p = await makeTempFile();
      paths.push(p.path);
      dirs.push(p.dir);
      return { ...p, ...first };
    },
  );
  return Object.assign(fn, { paths, dirs });
}

type Deps = Parameters<typeof createAudioWorker>[0];

/** Worker + fake session, with every gate recorded into a shared `order`. */
function setup(
  over: { deps?: Partial<Deps>; session?: Partial<WorkerSession> } = {},
) {
  const order: string[] = [];
  const state = { hearReady: true, laneOpen: true };
  const logs: Array<{ level: string; msg: string }> = [];
  const enriched: unknown[] = [];

  const requestAsr = jest.fn(() => {
    order.push('requestAsr');
  });
  const hearReady = jest.fn(() => {
    order.push('hearReady');
    return state.hearReady;
  });
  const laneOpen = jest.fn(() => {
    order.push('laneOpen');
    return state.laneOpen;
  });
  const transcribeFile = jest.fn(
    async (_p: string, _o: { format: 'wav' | 'mp3' }) => {
      order.push('transcribeFile');
      return 'the transcript';
    },
  );
  const fetchBytes = jest.fn(async () => {
    order.push('fetchBytes');
    return new Uint8Array([1, 2, 3]);
  });
  // The v2 worker NEVER routes audio through WorkerSession (spec §3).
  const hear = jest.fn(async () => 'from session.hear — must never happen');

  const deps: Deps = {
    laneOpen,
    requestAsr,
    hearReady,
    transcribeFile,
    prepareFile: preparer({ format: 'wav', sizeBytes: 4 }),
    mp3Duration: () => null,
    totalMemBytes: 32 * GiB,
    ...over.deps,
  };
  const session = {
    signal: new AbortController().signal,
    inference: async () => 'x',
    see: async () => '',
    read: async () => '',
    hear,
    fetchBytes,
    emit: () => {},
    enrich: (e: unknown) => enriched.push(e),
    log: (level: string, msg: string) => logs.push({ level, msg }),
    ...over.session,
  } as unknown as WorkerSession;

  return {
    worker: createAudioWorker(deps),
    session,
    order,
    state,
    logs,
    enriched,
    requestAsr,
    hearReady,
    laneOpen,
    transcribeFile,
    fetchBytes,
    hear,
    prepareFile: deps.prepareFile as ReturnType<typeof preparer>,
  };
}

const mp3Doc = {
  title: 'long.mp3',
  metadata: { mime: 'audio/mpeg', filename: 'long.mp3' },
} as Partial<Document>;

describe('maxDecodedBytes', () => {
  it('tiers on total RAM: 512 / 256 / 128 MiB', () => {
    expect(maxDecodedBytes(32 * GiB)).toBe(512 * MiB);
    expect(maxDecodedBytes(16 * GiB)).toBe(512 * MiB);
    expect(maxDecodedBytes(16 * GiB - 1)).toBe(256 * MiB);
    expect(maxDecodedBytes(8 * GiB)).toBe(256 * MiB);
    expect(maxDecodedBytes(8 * GiB - 1)).toBe(128 * MiB);
    expect(maxDecodedBytes(4 * GiB)).toBe(128 * MiB);
  });
});

describe('createAudioWorker — identity', () => {
  it('is audio v2, and the re-drive consumer moves with the bump', () => {
    const { worker } = setup();
    expect(worker.name).toBe('audio');
    expect(worker.version).toBe(2);
    expect(workerConsumerName(worker)).toBe('worker:audio:v2');
  });

  it('matches audio documents and skips non-audio ones', () => {
    const { worker } = setup();
    expect(worker.matches(change())).toBe(true);
    expect(
      worker.matches(
        change({ metadata: { mime: 'image/png', filename: 'a.png' } }),
      ),
    ).toBe(false);
  });
});

describe('createAudioWorker — call order and gates', () => {
  it('requests the ASR install on EVERY candidate, even when no hear provider is ready', async () => {
    const h = setup();
    h.state.hearReady = false;
    const outcome = await h.worker.work(change(), h.session);
    expect(outcome).toBe('defer');
    expect(h.requestAsr).toHaveBeenCalledTimes(1);
  });

  it('requests the install before anything else, on the happy path too', async () => {
    const h = setup();
    await h.worker.work(change(), h.session);
    expect(h.order[0]).toBe('requestAsr');
  });

  it('defers BEFORE fetching bytes when no hear provider is ready (no 200 MB materialisation)', async () => {
    const h = setup();
    h.state.hearReady = false;
    const outcome = await h.worker.work(change(), h.session);
    expect(outcome).toBe('defer');
    expect(h.fetchBytes).not.toHaveBeenCalled();
    expect(h.laneOpen).not.toHaveBeenCalled();
    expect(h.order).toEqual(['requestAsr', 'hearReady']);
  });

  it('defers when the processing window is closed — after the hearReady gate', async () => {
    const h = setup();
    h.state.laneOpen = false;
    const outcome = await h.worker.work(change(), h.session);
    expect(outcome).toBe('defer');
    expect(h.fetchBytes).not.toHaveBeenCalled();
    expect(h.order).toEqual(['requestAsr', 'hearReady', 'laneOpen']);
  });

  it('never routes audio through session.hear', async () => {
    const h = setup();
    await h.worker.work(change(), h.session);
    expect(h.hear).not.toHaveBeenCalled();
    expect(h.transcribeFile).toHaveBeenCalled();
  });
});

describe('createAudioWorker — fetch and prepare', () => {
  it('skips when the source cannot serve the bytes', async () => {
    const h = setup({ session: { fetchBytes: async () => null } });
    expect(await h.worker.work(change(), h.session)).toBe('skip');
  });

  it('the fetch backstop rejects over MAX_SOURCE_BYTES when metadata carried no size', async () => {
    // Duck-typed, not a real ~200 MB allocation: only `.length` is read.
    const oversized = { length: MAX_SOURCE_BYTES + 1 } as unknown as Uint8Array;
    const h = setup({ session: { fetchBytes: async () => oversized } });
    expect(await h.worker.work(change(), h.session)).toBe('skip');
    expect(h.prepareFile).not.toHaveBeenCalled();
  });

  it('skips (permanent) when the host cannot decode the format', async () => {
    const h = setup({
      deps: {
        prepareFile: async () => {
          throw new AudioUnsupportedFormatError('no transcoder on linux');
        },
      },
    });
    expect(await h.worker.work(change(), h.session)).toBe('skip');
    expect(h.transcribeFile).not.toHaveBeenCalled();
  });

  it('defers on a transient transcode fault (temp I/O)', async () => {
    const h = setup({
      deps: {
        prepareFile: async () => {
          throw new Error('ENOSPC');
        },
      },
    });
    expect(await h.worker.work(change(), h.session)).toBe('defer');
  });
});

describe('createAudioWorker — decoded-size caps', () => {
  it.each([
    ['16 GiB', 16 * GiB, 512 * MiB],
    ['8 GiB', 8 * GiB, 256 * MiB],
    ['4 GiB', 4 * GiB, 128 * MiB],
  ])(
    'skips an over-cap decoded WAV at the %s tier — no throw, no transcribe, temp file deleted',
    async (_label, totalMemBytes, cap) => {
      const prepareFile = preparer({ format: 'wav', sizeBytes: cap + 1 });
      const h = setup({ deps: { prepareFile, totalMemBytes } });
      const outcome = await h.worker.work(change(), h.session);
      expect(outcome).toBe('skip');
      expect(h.transcribeFile).not.toHaveBeenCalled();
      await expectCleaned(prepareFile);
    },
  );

  it('transcribes a WAV exactly at the cap', async () => {
    const prepareFile = preparer({ format: 'wav', sizeBytes: 256 * MiB });
    const h = setup({ deps: { prepareFile, totalMemBytes: 8 * GiB } });
    expect(await h.worker.work(change(), h.session)).toBe('done');
    expect(h.transcribeFile).toHaveBeenCalledWith(prepareFile.paths[0], {
      format: 'wav',
    });
  });

  it('skips a LONG compressed mp3 on the probed duration, not the tiny on-disk stat', async () => {
    // 1 MiB on disk, 20 000 s long: 20 000 × 32 000 B/s = 640 MB > 256 MiB.
    const prepareFile = preparer({ format: 'mp3', sizeBytes: 1 * MiB });
    const h = setup({
      deps: {
        prepareFile,
        mp3Duration: () => 20_000,
        totalMemBytes: 8 * GiB,
      },
    });
    const outcome = await h.worker.work(mp3Change(), h.session);
    expect(outcome).toBe('skip');
    expect(h.transcribeFile).not.toHaveBeenCalled();
    expect(h.logs.some((l) => /exceeds decoded cap/.test(l.msg))).toBe(true);
    await expectCleaned(prepareFile);
  });

  it('transcribes an mp3 whose probed duration fits the cap (passthrough, no re-prepare)', async () => {
    const prepareFile = preparer({ format: 'mp3', sizeBytes: 1 * MiB });
    const h = setup({
      deps: { prepareFile, mp3Duration: () => 60, totalMemBytes: 8 * GiB },
    });
    expect(await h.worker.work(mp3Change(), h.session)).toBe('done');
    expect(prepareFile).toHaveBeenCalledTimes(1);
    expect(h.transcribeFile).toHaveBeenCalledWith(prepareFile.paths[0], {
      format: 'mp3',
    });
  });
});

describe('createAudioWorker — unprobeable mp3 WITH a transcoder', () => {
  it('re-prepares as WAV and skips when the exact WAV size is over cap (both temp files gone)', async () => {
    const prepareFile = preparer(
      { format: 'mp3', sizeBytes: 1 * MiB },
      { format: 'wav', sizeBytes: 256 * MiB + 1 },
    );
    const h = setup({
      deps: { prepareFile, mp3Duration: () => null, totalMemBytes: 8 * GiB },
    });
    const outcome = await h.worker.work(mp3Change(), h.session);
    expect(outcome).toBe('skip');
    expect(prepareFile).toHaveBeenCalledTimes(2);
    expect(prepareFile.mock.calls[1][2]).toEqual({ forceWav: true });
    expect(h.transcribeFile).not.toHaveBeenCalled();
    // The ORIGINAL mp3 temp file must not leak when `prepared` is replaced.
    await expectCleaned(prepareFile);
    await expectCleaned(prepareFile, 1);
  });

  it('re-prepares as WAV and transcribes the NEW path when it fits (original mp3 deleted, the replacement still on disk)', async () => {
    const prepareFile = preparer(
      { format: 'mp3', sizeBytes: 1 * MiB },
      { format: 'wav', sizeBytes: 10 * MiB },
    );
    // Deleting the SUPERSEDED mp3 must not take the replacement's directory
    // with it — whisper is about to read that file.
    let presentAtTranscribe: boolean | undefined;
    const transcribeFile = jest.fn(async (p: string) => {
      presentAtTranscribe = !(await isGone(p));
      return 'the transcript';
    });
    const h = setup({
      deps: {
        prepareFile,
        transcribeFile,
        mp3Duration: () => null,
        totalMemBytes: 8 * GiB,
      },
    });
    expect(await h.worker.work(mp3Change(), h.session)).toBe('done');
    expect(presentAtTranscribe).toBe(true);
    expect(transcribeFile).toHaveBeenCalledWith(prepareFile.paths[1], {
      format: 'wav',
    });
    await expectCleaned(prepareFile);
    await expectCleaned(prepareFile, 1);
  });

  it('defers when the forceWav re-prepare fails transiently', async () => {
    const prepareFile = preparer(
      { format: 'mp3', sizeBytes: 1 * MiB },
      new Error('ENOSPC'),
    );
    const h = setup({
      deps: { prepareFile, mp3Duration: () => null, totalMemBytes: 8 * GiB },
    });
    expect(await h.worker.work(mp3Change(), h.session)).toBe('defer');
    expect(h.transcribeFile).not.toHaveBeenCalled();
    await expectCleaned(prepareFile);
  });
});

describe('createAudioWorker — unprobeable mp3 with NO transcoder (/32 floor)', () => {
  const noTranscoder = new AudioUnsupportedFormatError(
    'cannot transcode audio on linux',
  );

  it('skips when source bytes × 32 exceed the cap', async () => {
    // 4 GiB tier → 128 MiB cap → floor is 4 MiB of source.
    const bytes = { length: 5 * MiB } as unknown as Uint8Array;
    const prepareFile = preparer(
      { format: 'mp3', sizeBytes: 5 * MiB },
      noTranscoder,
    );
    const h = setup({
      deps: { prepareFile, mp3Duration: () => null, totalMemBytes: 4 * GiB },
      session: { fetchBytes: async () => bytes },
    });
    const outcome = await h.worker.work(mp3Change(), h.session);
    expect(outcome).toBe('skip');
    expect(h.transcribeFile).not.toHaveBeenCalled();
    expect(h.logs.some((l) => /\/32 floor/.test(l.msg))).toBe(true);
    await expectCleaned(prepareFile);
  });

  it('lets a small unprobeable mp3 through as a passthrough', async () => {
    const bytes = { length: 1024 } as unknown as Uint8Array;
    const prepareFile = preparer(
      { format: 'mp3', sizeBytes: 1024 },
      noTranscoder,
    );
    const h = setup({
      deps: { prepareFile, mp3Duration: () => null, totalMemBytes: 4 * GiB },
      session: { fetchBytes: async () => bytes },
    });
    expect(await h.worker.work(mp3Change(), h.session)).toBe('done');
    expect(h.transcribeFile).toHaveBeenCalledWith(prepareFile.paths[0], {
      format: 'mp3',
    });
    await expectCleaned(prepareFile);
  });
});

describe('createAudioWorker — transcribe outcomes', () => {
  it('skips (permanent) when whisper rejects the input (AsrInputRejectedError, status 400)', async () => {
    const prepareFile = preparer({ format: 'wav', sizeBytes: 4 });
    const h = setup({
      deps: {
        prepareFile,
        transcribeFile: async () => {
          throw new AsrInputRejectedError('failed to read audio data');
        },
      },
    });
    expect(await h.worker.work(change(), h.session)).toBe('skip');
    expect(h.logs.some((l) => /input rejected/.test(l.msg))).toBe(true);
    // Cleanup covers the failure path too.
    await expectCleaned(prepareFile);
  });

  it('defers on a plain transcribe failure (spawn fault, exit-by-signal…)', async () => {
    const prepareFile = preparer({ format: 'wav', sizeBytes: 4 });
    const h = setup({
      deps: {
        prepareFile,
        transcribeFile: async () => {
          throw new Error('whisper-cli exited by signal SIGKILL');
        },
      },
    });
    expect(await h.worker.work(change(), h.session)).toBe('defer');
    await expectCleaned(prepareFile);
  });

  it('defers on the NoProviderError race backstop', async () => {
    const h = setup({
      deps: {
        transcribeFile: async () => {
          throw new NoProviderError('hear');
        },
      },
    });
    expect(await h.worker.work(change(), h.session)).toBe('defer');
  });

  it('throws on an empty transcript so the engine retries (bounded), not skips', async () => {
    const prepareFile = preparer({ format: 'wav', sizeBytes: 4 });
    const h = setup({
      deps: { prepareFile, transcribeFile: async () => '   ' },
    });
    await expect(h.worker.work(change(), h.session)).rejects.toThrow(
      /empty transcript/,
    );
    await expectCleaned(prepareFile);
  });

  it('enriches with the transcript and deletes the temp file on success', async () => {
    const prepareFile = preparer({ format: 'wav', sizeBytes: 4 });
    const h = setup({ deps: { prepareFile } });
    expect(await h.worker.work(change(), h.session)).toBe('done');
    expect(h.enriched).toHaveLength(1);
    expect(h.enriched[0]).toMatchObject({
      documentId: 'd',
      markdown: 'the transcript',
      metadata: { extraction: { engine: 'local-asr' } },
    });
    const { at } = (
      h.enriched[0] as { metadata: { extraction: { at: string } } }
    ).metadata.extraction;
    expect(Number.isNaN(Date.parse(at))).toBe(false);
    await expectCleaned(prepareFile);
  });
});

function mp3Change(): Change {
  return change(mp3Doc);
}
