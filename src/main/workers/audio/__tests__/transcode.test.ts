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

/** A fake file-returning transcoder: writes `size` bytes INTO THE CALLER'S
 *  temp dir (as the real afconvert route now does) and returns the path. */
function fakeTranscodeToFile(size: number, written: string[]) {
  return jest.fn(async (_input: Uint8Array, _ext: string, dir: string) => {
    const p = path.join(dir, 'audio.wav');
    await fs.writeFile(p, Buffer.alloc(size, 0x7f));
    written.push(p);
    return p;
  });
}

/** Recursive so it covers both a prepared file and its owning temp dir. */
async function rmrf(p: string): Promise<void> {
  await fs.rm(p, { recursive: true, force: true }).catch(() => {});
}

describe('prepareAudioFile', () => {
  const cleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map(rmrf));
  });

  it('passthrough writes the bytes to a temp file and stats it', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const p = await prepareAudioFile(bytes, { mime: 'audio/mpeg' });
    cleanup.push(p.dir);
    expect(p.format).toBe('mp3');
    expect(p.sizeBytes).toBe(4);
    expect(new Uint8Array(await fs.readFile(p.path))).toEqual(bytes);
  });

  it('wav passthrough writes a .wav temp file', async () => {
    const p = await prepareAudioFile(BYTES, { ext: 'wav' });
    cleanup.push(p.dir);
    expect(p.format).toBe('wav');
    expect(p.path.endsWith('.wav')).toBe(true);
    expect(p.sizeBytes).toBe(4);
  });

  it('the prepared file lives in a fresh 0700 dir and is itself 0600 (unguessable, unreadable by other users on a shared /tmp)', async () => {
    const a = await prepareAudioFile(BYTES, { ext: 'wav' });
    const b = await prepareAudioFile(BYTES, { ext: 'wav' });
    cleanup.push(a.dir, b.dir);
    // A fresh mkdtemp dir per prepare: no predictable name to pre-plant a
    // symlink at, and one prepare can never clobber another's file.
    expect(a.dir).not.toBe(b.dir);
    expect(path.dirname(a.path)).toBe(a.dir);
    expect((await fs.stat(a.dir)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(a.path)).mode & 0o777).toBe(0o600);
    expect(path.basename(a.dir).startsWith('kiagent-asr-')).toBe(true);
  });

  it('transcode branch returns the WAV PATH without reading it back (injected transcoder)', async () => {
    const transcode = fakeTranscodeToFile(10, cleanup);
    const p = await prepareAudioFile(
      BYTES,
      { mime: 'audio/mp4', ext: 'm4a' },
      { transcode },
    );
    cleanup.push(p.dir);
    // The transcoder is handed the prepare's OWN dir to work in — nothing
    // lands at a caller-guessable path in the bare tmpdir.
    expect(transcode).toHaveBeenCalledWith(BYTES, 'm4a', p.dir);
    expect(p.path).toBe(await transcode.mock.results[0].value);
    expect(p.format).toBe('wav');
    expect(p.sizeBytes).toBe(10);
    // The returned path is the transcoder's own file — still on disk, not read
    // back into the heap by prepareAudioFile.
    await expect(fs.stat(p.path)).resolves.toBeDefined();
  });

  it('hints the transcoder with a mime-derived extension when the filename has none', async () => {
    const transcode = fakeTranscodeToFile(2, cleanup);
    const p = await prepareAudioFile(
      BYTES,
      { mime: 'audio/ogg' },
      {
        transcode,
      },
    );
    cleanup.push(p.dir);
    expect(transcode).toHaveBeenCalledWith(BYTES, 'ogg', p.dir);
  });

  it('forceWav routes an mp3 through the transcoder instead of passthrough', async () => {
    const transcode = fakeTranscodeToFile(10, cleanup);
    const p = await prepareAudioFile(
      BYTES,
      { mime: 'audio/mpeg' },
      { transcode },
      { forceWav: true },
    );
    cleanup.push(p.dir);
    expect(transcode).toHaveBeenCalledWith(BYTES, 'mp3', p.dir);
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
    cleanup.push(p.dir);
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
      cleanup.push(p.dir);
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
    // The whole temp DIRECTORY goes, not just the file inside it.
    expect(await isGone(path.dirname(produced[0]))).toBe(true);
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
    expect(await isGone(path.dirname(written[0]))).toBe(true);
  });
});

describe('afconvertToWavFile', () => {
  const cleanup: string[] = [];

  /** The caller-owned 0700 dir afconvert now works inside. */
  async function tempDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiagent-asr-aftest-'));
    cleanup.push(dir);
    return dir;
  }

  afterEach(async () => {
    await Promise.all(cleanup.splice(0).map(rmrf));
  });

  it('leaves the WAV on disk on success and deletes only the input', async () => {
    const dir = await tempDir();
    let seen: { inPath: string; outPath: string } | undefined;
    const out = await afconvertToWavFile(
      BYTES,
      'm4a',
      dir,
      async (inPath, outPath) => {
        seen = { inPath, outPath };
        // The real afconvert reads inPath; prove we actually wrote the source.
        expect(new Uint8Array(await fs.readFile(inPath))).toEqual(BYTES);
        await fs.writeFile(outPath, Buffer.alloc(64));
      },
    );
    expect(seen).toBeDefined();
    expect(out).toBe(seen?.outPath);
    // Both temp files stay INSIDE the caller's dir — nothing at a guessable
    // name in the bare tmpdir — and the source is written 0600.
    expect(path.dirname(out)).toBe(dir);
    expect(path.dirname(seen?.inPath as string)).toBe(dir);
    expect(await isGone(seen?.inPath as string)).toBe(true);
    expect((await fs.stat(out)).size).toBe(64);
  });

  it('writes the decoder input 0600 and refuses to follow a pre-planted name', async () => {
    const dir = await tempDir();
    let mode = 0;
    await afconvertToWavFile(BYTES, 'm4a', dir, async (inPath, outPath) => {
      mode = (await fs.stat(inPath)).mode & 0o777;
      await fs.writeFile(outPath, Buffer.alloc(1));
    });
    expect(mode).toBe(0o600);

    // `wx` — a name that already exists is an error, never a write-through.
    const dir2 = await tempDir();
    await fs.writeFile(path.join(dir2, 'source.m4a'), Buffer.alloc(1));
    await expect(
      afconvertToWavFile(BYTES, 'm4a', dir2, async () => {}),
    ).rejects.toThrow(/EEXIST/);
  });

  it('deletes BOTH temp files when the transcode fails', async () => {
    const dir = await tempDir();
    let seen: { inPath: string; outPath: string } | undefined;
    await expect(
      afconvertToWavFile(BYTES, 'm4a', dir, async (inPath, outPath) => {
        seen = { inPath, outPath };
        // afconvert can leave a partial output behind before it exits non-zero.
        await fs.writeFile(outPath, Buffer.alloc(64));
        throw new AudioUnsupportedFormatError('afconvert exited 1');
      }),
    ).rejects.toBeInstanceOf(AudioUnsupportedFormatError);
    expect(seen).toBeDefined();
    expect(await isGone(seen?.inPath as string)).toBe(true);
    expect(await isGone(seen?.outPath as string)).toBe(true);
  });
});
