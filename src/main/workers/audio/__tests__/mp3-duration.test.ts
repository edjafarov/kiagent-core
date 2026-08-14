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

type Version = 'mpeg1' | 'mpeg2' | 'mpeg25';

const VERSION_BITS: Record<Version, number> = { mpeg25: 0, mpeg2: 2, mpeg1: 3 };
const V_BITRATES: Record<Version, number[]> = {
  mpeg1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  mpeg2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  mpeg25: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const V_RATES: Record<Version, number[]> = {
  mpeg1: [44100, 48000, 32000],
  mpeg2: [22050, 24000, 16000],
  mpeg25: [11025, 12000, 8000],
};

/** Generic Layer III frame header for any version / channel mode. */
function l3Header(
  version: Version,
  bitrateKbps: number,
  sampleRate: number,
  mono: boolean,
): Buffer {
  const b = V_BITRATES[version].indexOf(bitrateKbps);
  const r = V_RATES[version].indexOf(sampleRate);
  if (b < 1 || r < 0)
    throw new Error(`bad ${version} ${bitrateKbps}/${sampleRate}`);
  return Buffer.from([
    0xff,
    0xe0 | (VERSION_BITS[version] << 3) | 0x03, // layer III, no CRC
    (b << 4) | (r << 2),
    mono ? 0xc0 : 0x00, // mode 3 = mono, mode 0 = stereo
  ]);
}

function sideInfoBytes(version: Version, mono: boolean): number {
  if (version === 'mpeg1') return mono ? 17 : 32;
  return mono ? 9 : 17;
}

/**
 * A single-frame file whose Xing tag carries `frames`. Parameterised over
 * version + channel mode so every side-info branch (32 / 17 / 9) and every
 * sample-rate table gets a fixture.
 */
function xingFrame(
  version: Version,
  bitrateKbps: number,
  sampleRate: number,
  mono: boolean,
  frames: number,
): Uint8Array {
  const samples = version === 'mpeg1' ? 1152 : 576;
  const size = Math.floor(((samples / 8) * bitrateKbps * 1000) / sampleRate);
  const buf = Buffer.alloc(Math.max(size, 64));
  l3Header(version, bitrateKbps, sampleRate, mono).copy(buf, 0);
  const tagOff = 4 + sideInfoBytes(version, mono);
  buf.write('Xing', tagOff, 'ascii');
  buf.writeUInt32BE(0x0001, tagOff + 4);
  buf.writeUInt32BE(frames, tagOff + 8);
  return new Uint8Array(buf);
}

/**
 * A stream whose first frame carries a VBR/CBR tag with NO frame count,
 * followed by identical-bitrate frames — so the CBR consistency check would
 * happily pass and produce a size/byterate number.
 */
function taggedCbrStream(fourcc: 'Xing' | 'Info', frames = 4): Uint8Array {
  const rate = 44100;
  const frameSize = Math.floor((144 * 128 * 1000) / rate);
  const buf = Buffer.alloc(frameSize * frames);
  for (let i = 0; i < frames; i += 1)
    frameHeader(128, rate).copy(buf, i * frameSize);
  buf.write(fourcc, 36, 'ascii');
  buf.writeUInt32BE(0x0000, 40); // flags: no frame count
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

  it('accepts an Info (CBR) header and falls back to CBR when no frame count flag', () => {
    // `Info` is LAME's CONSTANT-bitrate marker, so size/byterate is valid.
    const bytes = taggedCbrStream('Info');
    expect(mp3DurationSeconds(bytes)).toBeCloseTo(
      (bytes.length * 8) / 128000,
      3,
    );
  });

  it('returns null for a Xing tag with no usable frame count, even when the CBR check would pass', () => {
    // `Xing` declares VARIABLE bitrate: the first frame's 128 kbps is not the
    // file average, so size/byterate would be confidently wrong — and it
    // UNDER-estimates for low-bitrate VBR speech, slipping past the decoded-
    // size cap. The following frames here are deliberately identical, so the
    // CBR consistency gate passes; only the Xing/Info distinction saves us.
    expect(mp3DurationSeconds(taggedCbrStream('Xing'))).toBeNull();
    // …and the Info twin of the exact same bytes still resolves, proving the
    // fourcc is what decides it.
    expect(mp3DurationSeconds(taggedCbrStream('Info'))).not.toBeNull();
  });

  it('returns null for a Xing tag whose frame count is 0 or truncated away', () => {
    const zero = Buffer.from(xingFrame('mpeg1', 128, 44100, false, 0));
    expect(mp3DurationSeconds(new Uint8Array(zero))).toBeNull();
    // Truncated so the count field (offset 44..47) is missing entirely.
    const truncated = Buffer.from(xingFrame('mpeg1', 128, 44100, false, 500));
    expect(
      mp3DurationSeconds(new Uint8Array(truncated.subarray(0, 46))),
    ).toBeNull();
  });

  // Every side-info branch (MPEG-1 32/17, MPEG-2 & 2.5 17/9) and every
  // sample-rate table, each reached through the Xing path so a wrong offset or
  // a wrong samples-per-frame shows up as a wrong duration rather than silence.
  it.each([
    ['mpeg1 stereo (side info 32)', 'mpeg1', 128, 44100, false, 1152],
    ['mpeg1 mono   (side info 17)', 'mpeg1', 128, 32000, true, 1152],
    ['mpeg2 stereo (side info 17)', 'mpeg2', 64, 24000, false, 576],
    ['mpeg2 mono   (side info 9)', 'mpeg2', 64, 22050, true, 576],
    ['mpeg2.5 mono (side info 9)', 'mpeg25', 16, 8000, true, 576],
    ['mpeg2.5 stereo (side info 17)', 'mpeg25', 32, 11025, false, 576],
  ] as const)(
    'reads a Xing frame count from %s',
    (_label, version, kbps, rate, mono, samples) => {
      const bytes = xingFrame(version, kbps, rate, mono, 5000);
      expect(mp3DurationSeconds(bytes)).toBeCloseTo((5000 * samples) / rate, 3);
    },
  );
});
