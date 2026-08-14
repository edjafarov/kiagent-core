import { mp3DurationSeconds } from '../mp3-duration';

/** MPEG-1 Layer III frame header: 0xFFFB + bitrate/samplerate indexes. */
function frameHeader(
  bitrateKbps: number,
  sampleRate: 44100 | 48000 | 32000,
): Buffer {
  const BITRATES = [
    0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320,
  ];
  const RATES: Record<number, number> = { 44100: 0, 48000: 1, 32000: 2 };
  const b = BITRATES.indexOf(bitrateKbps);
  if (b < 1) throw new Error(`no MPEG-1 L3 bitrate index for ${bitrateKbps}`);
  return Buffer.from([0xff, 0xfb, (b << 4) | (RATES[sampleRate] << 2), 0x00]);
}

/**
 * MPEG-2 Layer III frame header: 0xFFF3 + MPEG-2 bitrate/samplerate indexes,
 * mono (mode 3). MPEG-2 L3 is where the 8 kbps rates live, and its frames
 * carry 576 samples, not 1152.
 */
function mpeg2MonoFrameHeader(
  bitrateKbps: number,
  sampleRate: 22050 | 24000 | 16000,
): Buffer {
  const BITRATES = [
    0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160,
  ];
  const RATES: Record<number, number> = { 22050: 0, 24000: 1, 16000: 2 };
  const b = BITRATES.indexOf(bitrateKbps);
  if (b < 1) throw new Error(`no MPEG-2 L3 bitrate index for ${bitrateKbps}`);
  return Buffer.from([
    0xff,
    0xf3,
    (b << 4) | (RATES[sampleRate] << 2),
    0xc0, // mode 3 = single channel (mono)
  ]);
}

/** A CBR file: N whole frames of frameSize = floor(144*bitrate/rate). */
function cbrFile(bitrateKbps: number, rate: 44100, frames: number): Uint8Array {
  const frameSize = Math.floor((144 * bitrateKbps * 1000) / rate);
  const buf = Buffer.alloc(frameSize * frames);
  for (let i = 0; i < frames; i += 1)
    frameHeader(bitrateKbps, rate).copy(buf, i * frameSize);
  return new Uint8Array(buf);
}

/** A CBR MPEG-2 mono file: frameSize = floor(72*bitrate/rate). */
function mpeg2CbrFile(
  bitrateKbps: number,
  rate: 22050,
  frames: number,
): Uint8Array {
  const frameSize = Math.floor((72 * bitrateKbps * 1000) / rate);
  const header = mpeg2MonoFrameHeader(bitrateKbps, rate);
  const buf = Buffer.alloc(frameSize * frames);
  for (let i = 0; i < frames; i += 1) header.copy(buf, i * frameSize);
  return new Uint8Array(buf);
}

/** A VBR file: first frame carries a Xing header with a frame count. */
function xingFile(frames: number): Uint8Array {
  const rate = 44100;
  const first = Buffer.alloc(Math.floor((144 * 128 * 1000) / rate));
  frameHeader(128, rate).copy(first, 0);
  // MPEG-1 stereo side info = 32 bytes → Xing at offset 4 + 32.
  first.write('Xing', 36, 'ascii');
  first.writeUInt32BE(0x0001, 40); // flags: frames present
  first.writeUInt32BE(frames, 44);
  return new Uint8Array(first);
}

describe('mp3DurationSeconds', () => {
  it('CBR: size/byterate — 128 kbps, 100 frames ≈ 100×1152/44100 s', () => {
    const d = mp3DurationSeconds(cbrFile(128, 44100, 100));
    expect(d).toBeCloseTo((100 * 1152) / 44100, 0);
  });

  it('VBR: Xing frame count wins over size/byterate', () => {
    const d = mp3DurationSeconds(xingFile(10000));
    expect(d).toBeCloseTo((10000 * 1152) / 44100, 0);
  });

  it('THE 8 kbps REGRESSION: a small low-bitrate file reports its true (long) duration', () => {
    // 8 kbps mono ≈ 1 KB/s: an ~8 MiB file is ~2.3 h. MPEG-2 L3 supports
    // 8 kbps — build with an MPEG-2 header (0xFFF3), samplesPerFrame 576.
    const frames = 330_000; // 26-byte frames → ~8.2 MiB on disk
    const bytes = mpeg2CbrFile(8, 22050, frames);
    expect(bytes.length).toBeGreaterThan(8 * 1000 * 1000);
    const d = mp3DurationSeconds(bytes);
    expect(d).not.toBeNull();
    expect(d as number).toBeGreaterThan(8000);
    // …and the PCM16 16 kHz mono it decodes to (32 000 B/s) dwarfs any
    // MiB-scale cap derived from the on-disk size.
    expect((d as number) * 32000).toBeGreaterThan(256 * 1024 * 1024);
  });

  it('skips a leading ID3v2 tag to find the first frame', () => {
    const body = cbrFile(128, 44100, 100);
    const id3 = Buffer.alloc(10 + 64);
    id3.write('ID3', 0, 'ascii');
    id3[9] = 64; // syncsafe size
    // Tag payloads carry arbitrary binary (album art), which can look exactly
    // like a frame header. Plant one: a probe that scans from byte 0 latches
    // onto this 320 kbps decoy, its predicted second frame lands in the middle
    // of the real stream, and it returns null.
    frameHeader(320, 44100).copy(id3, 10);
    const d = mp3DurationSeconds(
      new Uint8Array(Buffer.concat([id3, Buffer.from(body)])),
    );
    expect(d).not.toBeNull();
    expect(d).toBeCloseTo((body.length * 8) / 128000, 3);
  });

  it('returns null on garbage / no sync word', () => {
    expect(
      mp3DurationSeconds(new Uint8Array(Buffer.alloc(4096, 0x42))),
    ).toBeNull();
    expect(mp3DurationSeconds(new Uint8Array(0))).toBeNull();
  });

  it('returns null when the second frame is not where CBR predicts (inconsistent frames)', () => {
    const f = Buffer.from(cbrFile(128, 44100, 3));
    f[Math.floor((144 * 128000) / 44100)] = 0x00; // corrupt frame 2 sync
    expect(mp3DurationSeconds(new Uint8Array(f))).toBeNull();
  });

  it('returns null for a Layer II / Layer I stream (Layer III only)', () => {
    // Same header but layer bits = 11 (Layer I) / 10 (Layer II).
    const layer1 = Buffer.from(cbrFile(128, 44100, 4));
    for (let i = 0; i < layer1.length; i += 1)
      if (layer1[i] === 0xfb) layer1[i] = 0xff;
    expect(mp3DurationSeconds(new Uint8Array(layer1))).toBeNull();
  });

  it('returns null for reserved bitrate/sample-rate indexes', () => {
    const reservedBitrate = Buffer.from([0xff, 0xfb, 0xf0, 0x00, 0, 0, 0, 0]);
    expect(mp3DurationSeconds(new Uint8Array(reservedBitrate))).toBeNull();
    const freeBitrate = Buffer.from([0xff, 0xfb, 0x00, 0x00, 0, 0, 0, 0]);
    expect(mp3DurationSeconds(new Uint8Array(freeBitrate))).toBeNull();
    const reservedRate = Buffer.from([0xff, 0xfb, 0x9c, 0x00, 0, 0, 0, 0]);
    expect(mp3DurationSeconds(new Uint8Array(reservedRate))).toBeNull();
  });

  it('returns null for the reserved MPEG version', () => {
    // version bits = 01 (reserved) → 0xFF 0xEB.
    const reservedVersion = Buffer.from([0xff, 0xeb, 0x90, 0x00, 0, 0, 0, 0]);
    expect(mp3DurationSeconds(new Uint8Array(reservedVersion))).toBeNull();
  });

  it('accepts an Info (CBR) header but falls back to CBR when no frame count flag', () => {
    const rate = 44100;
    const frameSize = Math.floor((144 * 128 * 1000) / rate);
    const buf = Buffer.alloc(frameSize * 4);
    for (let i = 0; i < 4; i += 1)
      frameHeader(128, rate).copy(buf, i * frameSize);
    buf.write('Info', 36, 'ascii');
    buf.writeUInt32BE(0x0000, 40); // no flags → no frame count
    const d = mp3DurationSeconds(new Uint8Array(buf));
    expect(d).toBeCloseTo((frameSize * 4 * 8) / 128000, 3);
  });

  it('reads a Xing header from an MPEG-2 mono frame (side info = 9 bytes)', () => {
    const frameSize = Math.floor((72 * 64 * 1000) / 22050);
    const buf = Buffer.alloc(frameSize);
    mpeg2MonoFrameHeader(64, 22050).copy(buf, 0);
    buf.write('Xing', 4 + 9, 'ascii');
    buf.writeUInt32BE(0x0001, 4 + 9 + 4);
    buf.writeUInt32BE(5000, 4 + 9 + 8);
    expect(mp3DurationSeconds(new Uint8Array(buf))).toBeCloseTo(
      (5000 * 576) / 22050,
      3,
    );
  });
});
