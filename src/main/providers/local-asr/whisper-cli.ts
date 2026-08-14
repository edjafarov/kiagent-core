import { spawn } from 'node:child_process';

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

const STDERR_CAP_BYTES = 8 * 1024;

export type SpawnFn = typeof spawn;

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
 */
export function runWhisperCli(args: {
  binaryPath: string;
  modelPath: string;
  inputPath: string;
  signal?: AbortSignal;
  spawnFn?: SpawnFn;
}): Promise<string> {
  const spawnFn = args.spawnFn ?? spawn;
  return new Promise<string>((resolve, reject) => {
    const child = spawnFn(
      args.binaryPath,
      [
        '-m',
        args.modelPath,
        '-f',
        args.inputPath,
        '-l',
        'auto',
        '--no-timestamps',
        '--no-prints',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    const out: Buffer[] = [];
    let err = Buffer.alloc(0);
    child.stdout?.on('data', (c: Buffer) => out.push(c));
    child.stderr?.on('data', (c: Buffer) => {
      err = Buffer.concat([err, c]);
      if (err.length > STDERR_CAP_BYTES) err = err.subarray(-STDERR_CAP_BYTES);
    });

    const onAbort = (): void => {
      child.kill('SIGTERM');
      const t = setTimeout(() => child.kill('SIGKILL'), 2000);
      (t as unknown as { unref?: () => void }).unref?.();
    };
    args.signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = (): void =>
      args.signal?.removeEventListener('abort', onAbort);

    child.on('error', (e: Error) => {
      cleanup();
      reject(new Error(`whisper-cli failed to launch: ${e.message}`));
    });
    child.on('close', (code: number | null, sig: string | null) => {
      cleanup();
      const stderr = err.toString('utf8');
      // Diagnostic FIRST: a failed audio read exits 0 (see const doc above),
      // so an exit-code check first would misread it as an empty success.
      if (stderr.includes(INPUT_REJECTED_DIAGNOSTIC)) {
        reject(
          new AsrInputRejectedError(
            `whisper-cli could not decode the input: ${stderr.trim()}`,
          ),
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
      resolve(Buffer.concat(out).toString('utf8'));
    });
  });
}
