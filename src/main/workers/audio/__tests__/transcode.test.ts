import { AudioUnsupportedFormatError, prepareAudio } from '../transcode';

const BYTES = new Uint8Array([1, 2, 3, 4]);

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
