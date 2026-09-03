import { spawn, type SpawnOptions } from 'node:child_process';

/** Deterministic input rejection: whisper-cli could not decode THIS file.
 *  Carries status=400 so the audio worker's existing 4xx branch maps it to a
 *  terminal skip (deferring would loop the same undecodable file forever). */
export class AsrInputRejectedError extends Error {
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = 'AsrInputRejectedError';
  }
}

/** The ONLY signal that classifies as input rejection — the explicit stderr
 *  diagnostic, never exit code or missing output. Version-pinned to the
 *  vendored v1.9.2: cli.cpp logs it via a direct fprintf(stderr,…) (so it
 *  survives --no-prints, which only nulls the whisper-log callback) and then
 *  `continue`s, exiting 0; model-init failure returns 3 with no diagnostic.
 *  ⚠️ Re-verify against examples/cli/cli.cpp on every WHISPER_TAG bump (the
 *  reminder also lives in scripts/whisper-assets.mjs). */
export const INPUT_REJECTED_DIAGNOSTIC = 'failed to read audio file';

/** whisper.cpp v1.9.2 `g_lang` table (whisper.cpp:whisper_lang_id). 99
 *  Whisper languages plus `yue`. `-l` with any other code prints
 *  `error: unknown language '<code>'` and exits 0 with an EMPTY transcript
 *  (measured 2026-09-03), so callers must allowlist against this set BEFORE
 *  spawning. ⚠️ Re-verify on every WHISPER_TAG bump. */
export const WHISPER_LANGUAGES: ReadonlySet<string> = new Set([
  'en',
  'zh',
  'de',
  'es',
  'ru',
  'ko',
  'fr',
  'ja',
  'pt',
  'tr',
  'pl',
  'ca',
  'nl',
  'ar',
  'sv',
  'it',
  'id',
  'hi',
  'fi',
  'vi',
  'he',
  'uk',
  'el',
  'ms',
  'cs',
  'ro',
  'da',
  'hu',
  'ta',
  'no',
  'th',
  'ur',
  'hr',
  'bg',
  'lt',
  'la',
  'mi',
  'ml',
  'cy',
  'sk',
  'te',
  'fa',
  'lv',
  'bn',
  'sr',
  'az',
  'sl',
  'kn',
  'et',
  'mk',
  'br',
  'eu',
  'is',
  'hy',
  'ne',
  'mn',
  'bs',
  'kk',
  'sq',
  'sw',
  'gl',
  'mr',
  'pa',
  'si',
  'km',
  'sn',
  'yo',
  'so',
  'af',
  'oc',
  'ka',
  'be',
  'tg',
  'sd',
  'gu',
  'am',
  'yi',
  'lo',
  'uz',
  'fo',
  'ht',
  'ps',
  'tk',
  'nn',
  'mt',
  'sa',
  'lb',
  'my',
  'bo',
  'tl',
  'mg',
  'as',
  'tt',
  'haw',
  'ln',
  'ha',
  'ba',
  'jw',
  'su',
  'yue',
]);

/** `-dl` prints exactly one line on stderr through the whisper log callback
 *  (so it is LOST under --no-prints — detect runs must not pass it):
 *  `whisper_full_with_state: auto-detected language: uk (p = 0.463610)`.
 *  With VAD on and no speech, no line is printed and the exit is still 0.
 *  ⚠️ Re-verify on every WHISPER_TAG bump. */
export const DETECTED_LANGUAGE_DIAGNOSTIC = 'auto-detected language:';
const DETECTED_LANGUAGE_RE =
  /auto-detected language: ([a-z]+) \(p = ([0-9.]+)\)/;

/** `-l <unknown>`: `error: unknown language '<code>'` on stderr, exit 0, no
 *  transcript. Defensive second line behind WHISPER_LANGUAGES. Includes the
 *  trailing quote so the match can't fire on an input path that happens to
 *  contain the words "unknown language" (whisper echoes input paths in
 *  other diagnostics). ⚠️ Re-verify on every WHISPER_TAG bump. */
export const UNKNOWN_LANGUAGE_DIAGNOSTIC = "error: unknown language '";

/** Explicit VAD parameters (whisper.cpp v1.9.2 flags). Pinned so a whisper
 *  bump cannot silently change meeting segmentation. Bump `version` whenever
 *  a value changes. */
export const WHISPER_VAD_PARAMS = {
  version: 1,
  threshold: 0.5, // -vt   (whisper default 0.50)
  minSpeechMs: 150, // -vspd (whisper default 250) — keep short backchannels ("mhm")
  minSilenceMs: 100, // -vsd  (whisper default 100)
  speechPadMs: 120, // -vp   (whisper default 30) — protect quiet word onsets/offsets
  samplesOverlapS: 0.1, // -vo   (whisper default 0.10)
} as const;

const STDERR_CAP_BYTES = 8 * 1024;

/** The minimal child-process shape this wrapper actually touches. Narrow on
 *  purpose: `typeof spawn` is a heavily overloaded signature that no
 *  hand-rolled test fake can satisfy without an `as unknown as` cast that
 *  disables checking of the fake entirely. Node's real `ChildProcess`
 *  satisfies this structurally for free (Readable extends EventEmitter),
 *  so the real `spawn` needs no cast to flow through `SpawnFn` below. */
export interface WhisperChildProcess {
  readonly stdout: NodeJS.EventEmitter | null;
  readonly stderr: NodeJS.EventEmitter | null;
  on(event: 'error', listener: (err: Error) => void): this;
  on(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => WhisperChildProcess;

/**
 * One whisper-cli run: audio file path in → transcript text out.
 *
 * The transcript is the child's STREAMED stdout (spawn, not execFile — the
 * 1 MiB default maxBuffer kills multi-hour transcripts), with no -otxt/-of
 * output file: an output file cannot distinguish "input undecodable" from
 * "output write failed" (ENOSPC — cli continues on output-open failure and
 * still exits 0) and a mid-stream write failure would silently truncate.
 * stdout has neither problem. No timeout on purpose: CPU-tier transcription
 * of hours-long audio is legitimately slow; dispose() aborts via `signal`.
 *
 * Classification (spec §2, in order): spawn error / exit-by-signal → plain
 * Error (transient, worker defers); stderr carries the diagnostic →
 * AsrInputRejectedError regardless of exit code; exit 0 → resolve stdout
 * (empty string feeds the worker's own empty-transcript throw); non-zero →
 * plain Error carrying the bounded stderr (host fault, worker defers).
 * Detect runs resolve the parsed stderr line as JSON; an `unknown language`
 * diagnostic rejects as a plain Error.
 */
export function runWhisperCli(args: {
  binaryPath: string;
  modelPath: string;
  inputPath: string;
  /** Keep whisper's `[HH:MM:SS.mmm --> HH:MM:SS.mmm]` line prefixes. */
  timestamps?: boolean;
  /** Silero VAD model path. Present → whisper skips non-speech regions
   *  instead of decoding them, which is the only effective cure for
   *  silence hallucination (see the VAD comment on the argv below). */
  vadModelPath?: string;
  /** Pre-validated whisper language code (WHISPER_LANGUAGES). Absent → `-l auto`. */
  language?: string;
  /** `-dl`: detect and exit. Resolves to JSON `{language, probability}` or
   *  `{language: null}`; stdout is empty by construction. */
  detectLanguage?: boolean;
  signal?: AbortSignal;
  spawnFn?: SpawnFn;
}): Promise<string> {
  const spawnFn = args.spawnFn ?? spawn;
  return new Promise<string>((resolve, reject) => {
    // A signal handed to us already aborted (e.g. the caller's dispose() ran
    // before this job was scheduled) must never launch the child — otherwise
    // a cancelled job silently runs a full CPU-tier transcription (hours) to
    // completion as if nothing were wrong, because nothing is left to fire
    // the 'abort' event.
    if (args.signal?.aborted) {
      reject(new Error('whisper-cli aborted before start'));
      return;
    }

    const child = spawnFn(
      args.binaryPath,
      [
        '-m',
        args.modelPath,
        '-f',
        args.inputPath,
        '-l',
        // A detect run must never pass a pinned language: the contract is
        // that `language` is ignored on a detect run, and if whisper ever
        // echoed the pin back as a "detection" the app would lock it in.
        args.detectLanguage === true ? 'auto' : (args.language ?? 'auto'),
        ...(args.timestamps === true ? [] : ['--no-timestamps']),
        ...(args.detectLanguage === true ? ['-dl'] : ['--no-prints']),
        // Whisper hallucinates on silence: given a mostly-silent track it
        // emits the last real utterance again once per 30s window, with
        // timestamps stretched across the gap. Per-speaker meeting channels
        // are mostly silence by construction (each side is quiet while the
        // other talks), so a 6-minute call came back with 25 phantom repeats
        // and smeared timings that mis-interleaved the two speakers.
        // Decoder-side knobs do NOT fix it (-mc 0, -sns, -nth all measured:
        // no effect); skipping non-speech audio outright does.
        ...(args.vadModelPath !== undefined
          ? [
              '--vad',
              '-vm',
              args.vadModelPath,
              '-vt',
              String(WHISPER_VAD_PARAMS.threshold),
              '-vspd',
              String(WHISPER_VAD_PARAMS.minSpeechMs),
              '-vsd',
              String(WHISPER_VAD_PARAMS.minSilenceMs),
              '-vp',
              String(WHISPER_VAD_PARAMS.speechPadMs),
              '-vo',
              String(WHISPER_VAD_PARAMS.samplesOverlapS),
            ]
          : []),
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    const out: Buffer[] = [];
    let err = Buffer.alloc(0);
    // Sticky: once the diagnostic is seen, remember it independent of the
    // trimmed retention window below — the tail-cap must never be able to
    // un-see a diagnostic it already scanned (see cap comment).
    let sawDiagnostic = false;
    let sawUnknownLanguage = false;
    let detected: { language: string; probability: number } | null = null;
    child.stdout?.on('data', (c: Buffer) => out.push(c));
    // An EPIPE/ECONNRESET on a stdio stream emits 'error' on the Readable,
    // not on the ChildProcess — unhandled, that's an uncaught exception and
    // takes down the whole Electron main process. Swallow here; the child's
    // own 'error'/'close' handlers already carry the outcome.
    child.stdout?.on('error', () => {});
    child.stderr?.on('data', (c: Buffer) => {
      err = Buffer.concat([err, c]);
      const text = err.toString('utf8');
      if (text.includes(INPUT_REJECTED_DIAGNOSTIC)) sawDiagnostic = true;
      if (text.includes(UNKNOWN_LANGUAGE_DIAGNOSTIC)) sawUnknownLanguage = true;
      if (detected === null && text.includes(DETECTED_LANGUAGE_DIAGNOSTIC)) {
        const m = DETECTED_LANGUAGE_RE.exec(text);
        if (m) {
          const probability = Number(m[2]);
          detected = Number.isFinite(probability)
            ? { language: m[1], probability }
            : null;
        }
      }
      if (err.length > STDERR_CAP_BYTES) err = err.subarray(-STDERR_CAP_BYTES);
    });
    child.stderr?.on('error', () => {});

    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
      (killTimer as unknown as { unref?: () => void }).unref?.();
    };
    args.signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = (): void => {
      args.signal?.removeEventListener('abort', onAbort);
      if (killTimer !== undefined) clearTimeout(killTimer);
    };

    child.on('error', (e: Error) => {
      cleanup();
      reject(
        new Error(`whisper-cli failed to launch: ${e.message}`, { cause: e }),
      );
    });
    child.on('close', (code: number | null, sig: string | null) => {
      cleanup();
      const stderr = err.toString('utf8');
      // Diagnostic FIRST: a failed audio read exits 0 (see const doc above),
      // so an exit-code check first would misread it as an empty success.
      if (sawDiagnostic) {
        reject(
          new AsrInputRejectedError(
            `whisper-cli could not decode the input: ${stderr.trim()}`,
          ),
        );
        return;
      }
      if (sawUnknownLanguage) {
        reject(
          new Error(`whisper-cli rejected the language: ${stderr.trim()}`),
        );
        return;
      }
      if (sig) {
        reject(new Error(`whisper-cli killed by ${sig}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`whisper-cli exited ${code}: ${stderr.trim()}`));
        return;
      }
      if (args.detectLanguage === true) {
        resolve(
          JSON.stringify(detected === null ? { language: null } : detected),
        );
        return;
      }
      resolve(Buffer.concat(out).toString('utf8'));
    });
  });
}
