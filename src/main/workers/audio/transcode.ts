import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  // mp3 only reaches the transcoder under `forceWav` (otherwise it passes
  // through), but when it does, afconvert wants the real extension.
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/x-mp3': 'mp3',
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

/** Bytes ready for llama.cpp's `input_audio`, but as a FILE on disk. Nothing
 *  here ever materialises decoded PCM in the JS heap (spec §6). */
export interface PreparedAudioFile {
  /** The prepared file, always INSIDE `dir`. */
  path: string;
  /** The 0700 temp DIRECTORY holding `path` (and nothing else that outlives
   *  this call). Owned by the CALLER — remove it recursively in a finally;
   *  removing `path` alone leaks a directory per document. */
  dir: string;
  format: 'wav' | 'mp3';
  /** On-disk size. For wav this bounds decoded PCM exactly; for a
   *  passthrough mp3 it does NOT (compressed) — the worker probes duration
   *  instead (spec §6). */
  sizeBytes: number;
}

export interface TranscodeFileDeps {
  /** Override the transcoder. Takes source bytes + ext hint + the caller's
   *  0700 temp DIRECTORY to work in, and returns the PATH of a 16 kHz mono
   *  PCM wav file inside that directory (the caller removes the whole
   *  directory). `null` means "no transcoder on this platform". */
  transcode?:
    | ((input: Uint8Array, ext: string, dir: string) => Promise<string>)
    | null;
  platform?: NodeJS.Platform;
}

/**
 * Turn arbitrary audio bytes into a file whisper.cpp accepts, as a PATH the
 * caller owns and deletes — the transcoded WAV is never read back into the
 * heap, which is the whole point (a 2 h voice note is ~230 MB of PCM16).
 * wav/mp3 pass through to a temp file untouched; every other container (m4a,
 * ogg/opus, aac, flac…) is transcoded to 16 kHz mono PCM wav. On macOS that
 * uses the built-in `afconvert` (CoreAudio) — no bundled dependency. On other
 * platforms only wav/mp3 pass; anything else raises
 * AudioUnsupportedFormatError (a cross-platform decoder is a follow-up).
 * `forceWav` routes an mp3 through the transcoder too, for callers that need
 * real PCM rather than a compressed container whose size says nothing about
 * its decoded size.
 */
export async function prepareAudioFile(
  bytes: Uint8Array,
  meta: { mime?: string; ext?: string },
  deps: TranscodeFileDeps = {},
  opts: { forceWav?: boolean } = {},
): Promise<PreparedAudioFile> {
  const ext = (meta.ext ?? '').toLowerCase().replace(/^\./, '');
  // wav is already PCM: passthrough regardless of forceWav.
  if (isWav(meta.mime, ext)) return writePassthrough(bytes, 'wav');
  if (!opts.forceWav && isMp3(meta.mime, ext)) {
    return writePassthrough(bytes, 'mp3');
  }

  const platform = deps.platform ?? process.platform;
  const transcode =
    deps.transcode !== undefined
      ? deps.transcode
      : platform === 'darwin'
        ? afconvertToWavFile
        : null;
  if (!transcode) {
    throw new AudioUnsupportedFormatError(
      `cannot transcode audio (mime=${meta.mime ?? '?'} ext=${ext || '?'}) on ` +
        `${platform}: only wav/mp3 are supported without a bundled transcoder`,
    );
  }
  const hintExt = ext || MIME_EXT[meta.mime ?? ''] || 'audio';
  return withTempDir(async (dir) => {
    const outPath = await transcode(bytes, hintExt, dir);
    // No local catch for the stat: withTempDir removes the whole directory —
    // including the transcoder's output, whose path never reaches the caller.
    const { size } = await fs.stat(outPath);
    return { path: outPath, dir, format: 'wav', sizeBytes: size };
  });
}

/**
 * Run `fn` against a FRESH 0700 temp directory, removing it if `fn` throws.
 * mkdtemp is what makes the temp path unguessable: the old
 * `kiagent-asr-<pid>-<Date.now()>-<counter>` scheme was predictable, so on a
 * shared /tmp another user could pre-plant a symlink at the name (a
 * write-through primitive) or simply read the private audio out of a
 * default-0644 file. Same shape as local-asr's `handle('hear')`.
 * On SUCCESS the directory is the caller's to remove — recursively.
 */
async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kiagent-asr-'));
  try {
    return await fn(dir);
  } catch (e) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

/** Spill already-container-native bytes to a temp file so every downstream
 *  consumer takes a path, never a buffer. */
async function writePassthrough(
  bytes: Uint8Array,
  format: 'wav' | 'mp3',
): Promise<PreparedAudioFile> {
  return withTempDir(async (dir) => {
    const outPath = path.join(dir, `audio.${format}`);
    // 0600 keeps private audio unreadable to other users on a shared /tmp;
    // `wx` refuses to follow anything already at the name.
    await fs.writeFile(outPath, bytes, { mode: 0o600, flag: 'wx' });
    const { size } = await fs.stat(outPath);
    return { path: outPath, dir, format, sizeBytes: size };
  });
}

/** macOS `afconvert`: any CoreAudio-decodable input → 16 kHz mono 16-bit PCM
 *  WAVE, left ON DISK. Uses temp files (afconvert is file-in/file-out, not a
 *  pipe). Both files live in the CALLER's 0700 `dir`; the caller owns the
 *  directory (and with it `outPath`) and must remove it recursively.
 *
 *  `run` is a seam so the failure-cleanup path can be tested without spawning
 *  a real (platform-dependent) afconvert; production always uses the default. */
export async function afconvertToWavFile(
  input: Uint8Array,
  ext: string,
  dir: string,
  run: (inPath: string, outPath: string) => Promise<void> = runAfconvert,
): Promise<string> {
  const inPath = path.join(dir, `source.${ext}`);
  const outPath = path.join(dir, 'audio.wav');
  try {
    await fs.writeFile(inPath, input, { mode: 0o600, flag: 'wx' });
    await run(inPath, outPath);
    return outPath;
  } catch (e) {
    // Only on failure — on success the WAV is the caller's to delete.
    await fs.rm(outPath, { force: true }).catch(() => {});
    throw e;
  } finally {
    await fs.rm(inPath, { force: true }).catch(() => {});
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
