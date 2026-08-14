import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  afconvertToWavFile,
  AudioUnsupportedFormatError,
  prepareAudioFile,
} from '../transcode';

const BYTES = new Uint8Array([1, 2, 3, 4]);

/** True when nothing exists at `p`. */
async function isGone(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return false;
  } catch {
    return true;
  }
}

let tmpCounter = 0;

/** A fake file-returning transcoder: writes `size` bytes and returns the path. */
function fakeTranscodeToFile(size: number, written: string[]) {
  return jest.fn(async (_input: Uint8Array, _ext: string) => {
    tmpCounter += 1;
    const p = path.join(
      os.tmpdir(),
      `kiagent-asr-test-${process.pid}-${Date.now()}-${tmpCounter}.wav`,
    );
    await fs.writeFile(p, Buffer.alloc(size, 0x7f));
    written.push(p);
    return p;
  });
}

describe('prepareAudioFile', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanup.splice(0).map((p) => fs.rm(p, { force: true }).catch(() => {})),
    );
  });

  it('passthrough writes the bytes to a temp file and stats it', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const p = await prepareAudioFile(bytes, { mime: 'audio/mpeg' });
    cleanup.push(p.path);
    expect(p.format).toBe('mp3');
    expect(p.sizeBytes).toBe(4);
    expect(new Uint8Array(await fs.readFile(p.path))).toEqual(bytes);
  });

  it('wav passthrough writes a .wav temp file', async () => {
    const p = await prepareAudioFile(BYTES, { ext: 'wav' });
    cleanup.push(p.path);
    expect(p.format).toBe('wav');
    expect(p.path.endsWith('.wav')).toBe(true);
    expect(p.sizeBytes).toBe(4);
  });

  it('transcode branch returns the WAV PATH without reading it back (injected transcoder)', async () => {
    const transcode = fakeTranscodeToFile(10, cleanup);
    const p = await prepareAudioFile(
      BYTES,
      { mime: 'audio/mp4', ext: 'm4a' },
      { transcode },
    );
    expect(transcode).toHaveBeenCalledWith(BYTES, 'm4a');
    expect(p.path).toBe(await transcode.mock.results[0].value);
    expect(p.format).toBe('wav');
    expect(p.sizeBytes).toBe(10);
    // The returned path is the transcoder's own file — still on disk, not read
    // back into the heap by prepareAudioFile.
    await expect(fs.stat(p.path)).resolves.toBeDefined();
  });

  it('hints the transcoder with a mime-derived extension when the filename has none', async () => {
    const transcode = fakeTranscodeToFile(2, cleanup);
    await prepareAudioFile(BYTES, { mime: 'audio/ogg' }, { transcode });
    expect(transcode).toHaveBeenCalledWith(BYTES, 'ogg');
  });

  it('forceWav routes an mp3 through the transcoder instead of passthrough', async () => {
    const transcode = fakeTranscodeToFile(10, cleanup);
    const p = await prepareAudioFile(
      BYTES,
      { mime: 'audio/mpeg' },
      { transcode },
      { forceWav: true },
    );
    expect(transcode).toHaveBeenCalledWith(BYTES, 'mp3');
    expect(p.format).toBe('wav');
    expect(p.sizeBytes).toBe(10);
  });

  it('forceWav with no transcoder throws AudioUnsupportedFormatError', async () => {
    await expect(
      prepareAudioFile(
        new Uint8Array(4),
        { mime: 'audio/mpeg' },
        { transcode: null },
        { forceWav: true },
      ),
    ).rejects.toBeInstanceOf(AudioUnsupportedFormatError);
  });

  it('wav passthrough is untouched by forceWav (already PCM)', async () => {
    const transcode = fakeTranscodeToFile(10, cleanup);
    const p = await prepareAudioFile(
      BYTES,
      { mime: 'audio/wav' },
      { transcode },
      { forceWav: true },
    );
    cleanup.push(p.path);
    expect(transcode).not.toHaveBeenCalled();
    expect(p.format).toBe('wav');
    expect(p.sizeBytes).toBe(4);
  });

  it('throws AudioUnsupportedFormatError when no transcoder is available (e.g. non-macOS)', async () => {
    await expect(
      prepareAudioFile(
        BYTES,
        { mime: 'audio/ogg', ext: 'opus' },
        { platform: 'linux' },
      ),
    ).rejects.toBeInstanceOf(AudioUnsupportedFormatError);
  });

  it('NEVER reads the transcoded WAV back into the heap', async () => {
    // The whole point of the path-based API (spec §6): a 2 h voice note is
    // ~230 MB of PCM16. This fails the moment someone reintroduces the
    // fs.readFile(outPath) that afconvertToWav used to do.
    const transcode = fakeTranscodeToFile(10, cleanup);
    const readSpy = jest.spyOn(fs, 'readFile');
    try {
      const p = await prepareAudioFile(BYTES, { ext: 'm4a' }, { transcode });
      expect(readSpy).not.toHaveBeenCalled();
      expect(p.sizeBytes).toBe(10);
    } finally {
      readSpy.mockRestore();
    }
  });

  it('deletes the transcoder output when stat fails (the path never reaches the caller)', async () => {
    const produced: string[] = [];
    const transcode = fakeTranscodeToFile(10, produced);
    const statSpy = jest
      .spyOn(fs, 'stat')
      .mockRejectedValue(new Error('stat boom') as never);
    try {
      await expect(
        prepareAudioFile(BYTES, { ext: 'm4a' }, { transcode }),
      ).rejects.toThrow('stat boom');
    } finally {
      statSpy.mockRestore();
    }
    expect(produced).toHaveLength(1);
    cleanup.push(...produced); // belt-and-braces if the assertion below fails
    expect(await isGone(produced[0])).toBe(true);
  });

  it('passthrough deletes its own temp file when stat fails', async () => {
    const realWriteFile = fs.writeFile;
    const written: string[] = [];
    const writeSpy = jest.spyOn(fs, 'writeFile').mockImplementation((async (
      p: string,
      data: Uint8Array,
    ) => {
      written.push(p);
      await realWriteFile(p, data);
    }) as never);
    const statSpy = jest
      .spyOn(fs, 'stat')
      .mockRejectedValue(new Error('stat boom') as never);
    try {
      await expect(prepareAudioFile(BYTES, { ext: 'wav' })).rejects.toThrow(
        'stat boom',
      );
    } finally {
      writeSpy.mockRestore();
      statSpy.mockRestore();
    }
    expect(written).toHaveLength(1);
    cleanup.push(...written);
    expect(await isGone(written[0])).toBe(true);
  });
});

describe('afconvertToWavFile', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanup.splice(0).map((p) => fs.rm(p, { force: true }).catch(() => {})),
    );
  });

  it('leaves the WAV on disk on success and deletes only the input', async () => {
    let seen: { inPath: string; outPath: string } | undefined;
    const out = await afconvertToWavFile(
      BYTES,
      'm4a',
      async (inPath, outPath) => {
        seen = { inPath, outPath };
        // The real afconvert reads inPath; prove we actually wrote the source.
        expect(new Uint8Array(await fs.readFile(inPath))).toEqual(BYTES);
        await fs.writeFile(outPath, Buffer.alloc(64));
      },
    );
    cleanup.push(out);
    expect(seen).toBeDefined();
    expect(out).toBe(seen?.outPath);
    expect(await isGone(seen?.inPath as string)).toBe(true);
    expect((await fs.stat(out)).size).toBe(64);
  });

  it('deletes BOTH temp files when the transcode fails', async () => {
    let seen: { inPath: string; outPath: string } | undefined;
    await expect(
      afconvertToWavFile(BYTES, 'm4a', async (inPath, outPath) => {
        seen = { inPath, outPath };
        // afconvert can leave a partial output behind before it exits non-zero.
        await fs.writeFile(outPath, Buffer.alloc(64));
        throw new AudioUnsupportedFormatError('afconvert exited 1');
      }),
    ).rejects.toBeInstanceOf(AudioUnsupportedFormatError);
    expect(seen).toBeDefined();
    cleanup.push(seen?.inPath as string, seen?.outPath as string);
    expect(await isGone(seen?.inPath as string)).toBe(true);
    expect(await isGone(seen?.outPath as string)).toBe(true);
  });
});
