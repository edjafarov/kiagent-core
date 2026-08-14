import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  AudioUnsupportedFormatError,
  prepareAudio,
  prepareAudioFile,
} from '../transcode';

const BYTES = new Uint8Array([1, 2, 3, 4]);

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

describe('prepareAudio', () => {
  it('passes wav through untouched (by mime or extension)', async () => {
    await expect(prepareAudio(BYTES, { mime: 'audio/wav' })).resolves.toEqual({
      data: BYTES,
      format: 'wav',
    });
    await expect(prepareAudio(BYTES, { ext: 'wav' })).resolves.toEqual({
      data: BYTES,
      format: 'wav',
    });
  });

  it('passes mp3 through untouched (native input_audio format)', async () => {
    await expect(prepareAudio(BYTES, { mime: 'audio/mpeg' })).resolves.toEqual({
      data: BYTES,
      format: 'mp3',
    });
    await expect(prepareAudio(BYTES, { ext: 'mp3' })).resolves.toEqual({
      data: BYTES,
      format: 'mp3',
    });
  });

  it('transcodes every other format to wav via the platform transcoder', async () => {
    const out = new Uint8Array([9, 9]);
    const transcode = jest.fn(async () => out);
    await expect(
      prepareAudio(BYTES, { mime: 'audio/mp4', ext: 'm4a' }, { transcode }),
    ).resolves.toEqual({ data: out, format: 'wav' });
    // The decoder gets the source extension as a hint.
    expect(transcode).toHaveBeenCalledWith(BYTES, 'm4a');
  });

  it('hints the transcoder with a mime-derived extension when the filename has none', async () => {
    const transcode = jest.fn(async () => new Uint8Array([0]));
    await prepareAudio(BYTES, { mime: 'audio/ogg' }, { transcode });
    expect(transcode).toHaveBeenCalledWith(BYTES, 'ogg');
  });

  it('throws AudioUnsupportedFormatError when no transcoder is available (e.g. non-macOS)', async () => {
    await expect(
      prepareAudio(
        BYTES,
        { mime: 'audio/ogg', ext: 'opus' },
        { platform: 'linux' },
      ),
    ).rejects.toBeInstanceOf(AudioUnsupportedFormatError);
    // wav/mp3 still pass on every platform.
    await expect(
      prepareAudio(BYTES, { ext: 'wav' }, { platform: 'linux' }),
    ).resolves.toEqual({ data: BYTES, format: 'wav' });
  });

  it('surfaces a transcoder failure as AudioUnsupportedFormatError', async () => {
    const transcode = jest.fn(async () => {
      throw new AudioUnsupportedFormatError('afconvert exited 1');
    });
    await expect(
      prepareAudio(BYTES, { ext: 'aiff' }, { transcode }),
    ).rejects.toBeInstanceOf(AudioUnsupportedFormatError);
  });
});

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
});
