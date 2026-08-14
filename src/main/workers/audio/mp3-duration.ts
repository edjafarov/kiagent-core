/**
 * Best-effort mp3 duration probe, for bounding DECODED size before handing a
 * passthrough mp3 to whisper (spec §6): mp3 stays compressed on disk and no
 * fixed compression-ratio guess is safe — valid 8 kbps MP3 exists and decodes
 * to 32× its size as PCM16. Parses the first frame header plus the Xing/Info
 * (VBR) frame count when present; falls back to fileSize/byterate for CBR
 * (validated by checking the second frame lands where CBR predicts); returns
 * null when it cannot decide (no sync word, unsupported layer, inconsistent
 * frames) — the caller then transcodes (darwin) or applies the /32 floor.
 *
 * The contract is deliberately asymmetric: `null` ("I cannot tell") is always
 * safe because the caller degrades conservatively, while a confidently WRONG
 * number is not. Every ambiguous case below therefore resolves to null.
 */

// index tables: [MPEG-2/2.5, MPEG-1] × Layer III
const BITRATES_KBPS = {
  mpeg1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  mpeg2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const SAMPLE_RATES = {
  mpeg1: [44100, 48000, 32000],
  mpeg2: [22050, 24000, 16000],
  mpeg25: [11025, 12000, 8000],
};

/** Don't scan an entire multi-hundred-MB file looking for a sync word. */
const MAX_SYNC_SCAN_BYTES = 64 * 1024;

interface FrameInfo {
  version: 'mpeg1' | 'mpeg2' | 'mpeg25';
  bitrateBps: number;
  sampleRate: number;
  samplesPerFrame: number; // Layer III: 1152 (MPEG-1) / 576 (MPEG-2/2.5)
  frameBytes: number;
  channels: 1 | 2;
}

function parseFrameHeader(b: Uint8Array, off: number): FrameInfo | null {
  if (off < 0 || off + 4 > b.length) return null;
  const b0 = b[off];
  const b1 = b[off + 1];
  const b2 = b[off + 2];
  const b3 = b[off + 3];
  // 11 sync bits.
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return null;

  // Version: 00 = MPEG-2.5, 01 = reserved, 10 = MPEG-2, 11 = MPEG-1.
  let version: FrameInfo['version'];
  switch ((b1 >> 3) & 0x03) {
    case 0:
      version = 'mpeg25';
      break;
    case 2:
      version = 'mpeg2';
      break;
    case 3:
      version = 'mpeg1';
      break;
    default:
      return null; // reserved
  }

  // Layer: 01 = Layer III. Anything else (I, II, reserved) is out of scope.
  if (((b1 >> 1) & 0x03) !== 1) return null;

  // Bitrate index: 0 = "free format" (bitrate not in the header — unusable
  // here), 15 = reserved. Both reject rather than index past the table.
  const bitrateIndex = (b2 >> 4) & 0x0f;
  if (bitrateIndex === 0 || bitrateIndex === 0x0f) return null;
  const bitrateTable =
    version === 'mpeg1' ? BITRATES_KBPS.mpeg1 : BITRATES_KBPS.mpeg2;
  const bitrateBps = bitrateTable[bitrateIndex] * 1000;

  // Sample rate index: 11 is reserved.
  const rateIndex = (b2 >> 2) & 0x03;
  if (rateIndex === 0x03) return null;
  const sampleRate = SAMPLE_RATES[version][rateIndex];

  const padding = (b2 >> 1) & 0x01;
  // Channel mode 11 = single channel (mono); 00/01/10 all carry two channels.
  const channels: 1 | 2 = ((b3 >> 6) & 0x03) === 3 ? 1 : 2;

  const samplesPerFrame = version === 'mpeg1' ? 1152 : 576;
  const frameBytes =
    Math.floor(((samplesPerFrame / 8) * bitrateBps) / sampleRate) + padding;
  if (frameBytes <= 4) return null;

  return {
    version,
    bitrateBps,
    sampleRate,
    samplesPerFrame,
    frameBytes,
    channels,
  };
}

/** Size of an ID3v2 tag at the head of the file, or 0 if there isn't one. */
function id3v2Size(b: Uint8Array): number {
  if (b.length < 10) return 0;
  if (b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return 0; // 'ID3'
  // 28-bit syncsafe size: 7 bits per byte, high bit always clear.
  for (let i = 6; i <= 9; i += 1) if ((b[i] & 0x80) !== 0) return 0;
  const size = (b[6] << 21) | (b[7] << 14) | (b[8] << 7) | b[9];
  // Deliberately NOT adding the optional 10-byte footer: under-skipping is
  // recoverable (the forward scan walks past the leftovers, and '3DI' cannot
  // false-sync) whereas over-skipping could land inside the first frame.
  return 10 + size;
}

function findFirstFrame(
  b: Uint8Array,
): { off: number; info: FrameInfo } | null {
  const start = Math.min(id3v2Size(b), b.length);
  const limit = Math.min(b.length - 4, start + MAX_SYNC_SCAN_BYTES);
  for (let i = start; i <= limit; i += 1) {
    if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) continue;
    const info = parseFrameHeader(b, i);
    if (info) return { off: i, info };
  }
  return null;
}

function readU32BE(b: Uint8Array, off: number): number {
  return (
    b[off] * 0x1000000 + ((b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3])
  );
}

function xingFrameCount(
  b: Uint8Array,
  off: number,
  info: FrameInfo,
): number | null {
  // The VBR tag lives in the first frame, right after the header + side info.
  // Side-info size depends on BOTH version and channel mode.
  const sideInfo =
    info.version === 'mpeg1'
      ? info.channels === 1
        ? 17
        : 32
      : info.channels === 1
        ? 9
        : 17;
  const tagOff = off + 4 + sideInfo;
  if (tagOff + 8 > b.length) return null;
  const fourcc = String.fromCharCode(
    b[tagOff],
    b[tagOff + 1],
    b[tagOff + 2],
    b[tagOff + 3],
  );
  if (fourcc !== 'Xing' && fourcc !== 'Info') return null;
  const flags = readU32BE(b, tagOff + 4);
  if ((flags & 0x01) === 0) return null; // frame count not present
  if (tagOff + 12 > b.length) return null;
  const frames = readU32BE(b, tagOff + 8);
  return frames > 0 ? frames : null;
}

export function mp3DurationSeconds(bytes: Uint8Array): number | null {
  const first = findFirstFrame(bytes);
  if (!first) return null;
  const { off, info } = first;

  const frames = xingFrameCount(bytes, off, info);
  if (frames !== null) {
    const seconds = (frames * info.samplesPerFrame) / info.sampleRate;
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  }

  // CBR fallback: only trustworthy if the stream really is constant-bitrate,
  // so demand that the next frame header sits exactly where this frame's size
  // predicts AND declares the same version/rate/bitrate. A VBR stream whose
  // Xing tag lacks a frame count fails this check and returns null rather than
  // reporting a duration derived from one frame's bitrate.
  const nextOff = off + info.frameBytes;
  if (nextOff + 4 <= bytes.length) {
    const second = parseFrameHeader(bytes, nextOff);
    if (
      !second ||
      second.version !== info.version ||
      second.sampleRate !== info.sampleRate ||
      second.bitrateBps !== info.bitrateBps
    ) {
      return null;
    }
  }

  const seconds = ((bytes.length - off) * 8) / info.bitrateBps;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}
