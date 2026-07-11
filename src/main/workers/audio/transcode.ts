import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Bytes ready for llama.cpp's `input_audio` part, which accepts wav or mp3. */
export interface PreparedAudio {
  data: Uint8Array;
  format: 'wav' | 'mp3';
}

/** Thrown when the audio can't be turned into wav/mp3 on THIS host — e.g. an
 *  opus voice note on a non-macOS build, where no transcoder is bundled. A
 *  permanent condition for this platform, so the worker skips rather than
 *  re-deferring forever. */
export class AudioUnsupportedFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AudioUnsupportedFormatError';
  }
}

const WAV_MIMES = new Set([
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/vnd.wave',
]);
const MP3_MIMES = new Set(['audio/mpeg', 'audio/mp3', 'audio/x-mp3']);

/** mime → source extension, for hinting the CoreAudio decoder when a file has
 *  a mime but no filename extension (e.g. some attachments). */
const MIME_EXT: Record<string, string> = {
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/amr': 'amr',
  'audio/webm': 'weba',
  'audio/3gpp': '3gp',
};

function isWav(mime: string | undefined, ext: string): boolean {
  return (mime !== undefined && WAV_MIMES.has(mime)) || ext === 'wav';
}

function isMp3(mime: string | undefined, ext: string): boolean {
  return (mime !== undefined && MP3_MIMES.has(mime)) || ext === 'mp3';
}

export interface TranscodeDeps {
  /** Override the transcoder (tests / non-darwin strategies). Returns 16 kHz
   *  mono PCM wav bytes. `null` means "no transcoder on this platform". */
  transcode?: ((input: Uint8Array, ext: string) => Promise<Uint8Array>) | null;
  platform?: NodeJS.Platform;
}

/**
 * Turn arbitrary audio bytes into something llama.cpp's `input_audio` accepts.
 * wav/mp3 pass through untouched; every other container (m4a, ogg/opus, aac,
 * flac…) is transcoded to 16 kHz mono PCM wav. On macOS the transcode uses the
 * built-in `afconvert` (CoreAudio) — no bundled dependency, and verified to
 * decode m4a/aac/mp3/opus/ogg. On other platforms only wav/mp3 pass; anything
 * else raises AudioUnsupportedFormatError (a cross-platform ffmpeg/wasm decoder
 * is a follow-up).
 */
export async function prepareAudio(
  bytes: Uint8Array,
  meta: { mime?: string; ext?: string },
  deps: TranscodeDeps = {},
): Promise<PreparedAudio> {
  const ext = (meta.ext ?? '').toLowerCase().replace(/^\./, '');
  if (isWav(meta.mime, ext)) return { data: bytes, format: 'wav' };
  if (isMp3(meta.mime, ext)) return { data: bytes, format: 'mp3' };

  const platform = deps.platform ?? process.platform;
  const transcode =
    deps.transcode !== undefined
      ? deps.transcode
      : platform === 'darwin'
        ? afconvertToWav
        : null;
  if (!transcode) {
    throw new AudioUnsupportedFormatError(
      `cannot transcode audio (mime=${meta.mime ?? '?'} ext=${ext || '?'}) on ` +
        `${platform}: only wav/mp3 are supported without a bundled transcoder`,
    );
  }
  const hintExt = ext || MIME_EXT[meta.mime ?? ''] || 'audio';
  return { data: await transcode(bytes, hintExt), format: 'wav' };
}

let counter = 0;

/** macOS `afconvert`: any CoreAudio-decodable input → 16 kHz mono 16-bit PCM
 *  WAVE. Uses temp files (afconvert is file-in/file-out, not a pipe). */
async function afconvertToWav(
  input: Uint8Array,
  ext: string,
): Promise<Uint8Array> {
  const dir = os.tmpdir();
  counter += 1;
  const stamp = `${process.pid}-${Date.now()}-${counter}`;
  const inPath = path.join(dir, `kiagent-asr-${stamp}.${ext}`);
  const outPath = path.join(dir, `kiagent-asr-${stamp}.wav`);
  try {
    await fs.writeFile(inPath, input);
    await runAfconvert(inPath, outPath);
    return new Uint8Array(await fs.readFile(outPath));
  } finally {
    await fs.rm(inPath, { force: true }).catch(() => {});
    await fs.rm(outPath, { force: true }).catch(() => {});
  }
}

function runAfconvert(inPath: string, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'afconvert',
      ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', inPath, outPath],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    proc.stderr?.on('data', (c) => {
      stderr += String(c);
    });
    proc.on('error', (e) =>
      reject(
        new AudioUnsupportedFormatError(
          `afconvert failed to launch: ${e.message}`,
        ),
      ),
    );
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else
        reject(
          new AudioUnsupportedFormatError(
            `afconvert exited ${code}: ${stderr.trim()}`,
          ),
        );
    });
  });
}
