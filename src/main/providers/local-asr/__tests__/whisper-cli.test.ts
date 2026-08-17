import { EventEmitter } from 'node:events';

import {
  AsrInputRejectedError,
  INPUT_REJECTED_DIAGNOSTIC,
  runWhisperCli,
} from '../whisper-cli';
import type { SpawnFn } from '../whisper-cli';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();

  stderr = new EventEmitter();

  killed: string[] = [];

  kill(sig?: NodeJS.Signals | number) {
    this.killed.push(String(sig ?? 'SIGTERM'));
    return true;
  }
}

// `SpawnFn` is now a narrow structural type (see whisper-cli.ts), so this
// fake satisfies it directly — no `as unknown as` cast, meaning a drift
// between the fake's shape and what runWhisperCli actually calls (wrong
// arg types, missing `on`/`kill` overloads) is a real compile error here.
function fakeSpawn(): { spawnFn: SpawnFn; child: FakeChild; argv: string[][] } {
  const child = new FakeChild();
  const argv: string[][] = [];
  const spawnFn: SpawnFn = (cmd, args) => {
    argv.push([cmd, ...args]);
    return child;
  };
  return { spawnFn, child, argv };
}

const ARGS = {
  binaryPath: '/assets/whisper/darwin-arm64/whisper-cli',
  modelPath: '/models/asr/whisper-small-q5_1/ggml-small-q5_1.bin',
  inputPath: '/tmp/in.wav',
};

describe('runWhisperCli', () => {
  it('builds the exact argv and resolves streamed stdout on exit 0', async () => {
    const { spawnFn, child, argv } = fakeSpawn();
    const p = runWhisperCli({ ...ARGS, spawnFn });
    child.stdout.emit('data', Buffer.from('hello '));
    child.stdout.emit('data', Buffer.from('world'));
    child.emit('close', 0, null);
    await expect(p).resolves.toBe('hello world');
    expect(argv[0]).toEqual([
      ARGS.binaryPath,
      '-m',
      ARGS.modelPath,
      '-f',
      ARGS.inputPath,
      '-l',
      'auto',
      '--no-timestamps',
      '--no-prints',
    ]);
  });

  it('survives a multi-MB transcript (the execFile maxBuffer regression)', async () => {
    const { spawnFn, child } = fakeSpawn();
    const p = runWhisperCli({ ...ARGS, spawnFn });
    const chunk = Buffer.alloc(1024 * 1024, 0x61); // 1 MiB of 'a'
    for (let i = 0; i < 5; i += 1) child.stdout.emit('data', chunk);
    child.emit('close', 0, null);
    await expect(p).resolves.toHaveLength(5 * 1024 * 1024);
  });

  it('the stderr diagnostic rejects as AsrInputRejectedError EVEN at exit 0', async () => {
    // v1.9.2 cli.cpp: a failed audio read logs the diagnostic, `continue`s,
    // and exits 0 with no transcript (cli.cpp:1169-1170).
    const { spawnFn, child } = fakeSpawn();
    const p = runWhisperCli({ ...ARGS, spawnFn });
    child.stderr.emit(
      'data',
      Buffer.from(`error: ${INPUT_REJECTED_DIAGNOSTIC} '/tmp/in.wav'\n`),
    );
    child.emit('close', 0, null);
    await expect(p).rejects.toBeInstanceOf(AsrInputRejectedError);
    await expect(p).rejects.toMatchObject({ status: 400 });
  });

  it('non-zero exit WITHOUT the diagnostic is a plain (transient) error carrying stderr', async () => {
    // Model-init failure returns 3 — a host/install fault, not bad input.
    const { spawnFn, child } = fakeSpawn();
    const p = runWhisperCli({ ...ARGS, spawnFn });
    child.stderr.emit('data', Buffer.from('whisper_init_from_file: failed\n'));
    child.emit('close', 3, null);
    await expect(p).rejects.toThrow(/whisper_init_from_file/);
    await expect(p).rejects.not.toBeInstanceOf(AsrInputRejectedError);
  });

  it('exit-by-signal is a plain error, never input rejection', async () => {
    const { spawnFn, child } = fakeSpawn();
    const p = runWhisperCli({ ...ARGS, spawnFn });
    child.emit('close', null, 'SIGKILL');
    await expect(p).rejects.toThrow(/SIGKILL/);
    await expect(p).rejects.not.toBeInstanceOf(AsrInputRejectedError);
  });

  it('spawn failure (ENOENT) is a plain error', async () => {
    const { spawnFn, child } = fakeSpawn();
    const p = runWhisperCli({ ...ARGS, spawnFn });
    child.emit(
      'error',
      Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }),
    );
    await expect(p).rejects.toThrow(/ENOENT/);
  });

  it('empty stdout at exit 0 without the diagnostic resolves to empty string', async () => {
    // The WORKER owns the empty-transcript throw (bounded retry) — the
    // wrapper must not invent a classification for it.
    const { spawnFn, child } = fakeSpawn();
    const p = runWhisperCli({ ...ARGS, spawnFn });
    child.emit('close', 0, null);
    await expect(p).resolves.toBe('');
  });

  it('abort kills the child with SIGTERM', async () => {
    const { spawnFn, child } = fakeSpawn();
    const ctl = new AbortController();
    const p = runWhisperCli({ ...ARGS, signal: ctl.signal, spawnFn });
    ctl.abort();
    expect(child.killed).toContain('SIGTERM');
    child.emit('close', null, 'SIGTERM');
    await expect(p).rejects.toThrow(/SIGTERM/);
  });

  it('a pre-aborted signal rejects without ever spawning the child', async () => {
    const { spawnFn, argv } = fakeSpawn();
    const ctl = new AbortController();
    ctl.abort();
    const p = runWhisperCli({ ...ARGS, signal: ctl.signal, spawnFn });
    await expect(p).rejects.toThrow(/aborted before start/);
    expect(argv).toHaveLength(0);
  });

  it('caps retained stderr (bounded capture)', async () => {
    const { spawnFn, child } = fakeSpawn();
    const p = runWhisperCli({ ...ARGS, spawnFn });
    for (let i = 0; i < 100; i += 1)
      child.stderr.emit('data', Buffer.alloc(1024, 0x62));
    child.emit('close', 5, null);
    await expect(p).rejects.toThrow();
    let err: Error | undefined;
    try {
      await p;
    } catch (e) {
      err = e as Error;
    }
    // Cap is 8 KiB plus a short "whisper-cli exited N: " prefix — bounded
    // tightly enough that a regression to a materially larger cap (the
    // previous, looser 16 KiB bound would have missed e.g. a 15 KiB cap) trips.
    expect(err?.message.length).toBeLessThan(8.5 * 1024);
  });

  it('default run passes --no-timestamps', async () => {
    const { spawnFn, child, argv } = fakeSpawn();
    const p = runWhisperCli({ ...ARGS, spawnFn });
    child.emit('close', 0, null);
    await p;
    expect(argv[0]).toContain('--no-timestamps');
  });

  it('timestamps: true drops --no-timestamps and changes nothing else', async () => {
    const { spawnFn, child, argv } = fakeSpawn();
    const p = runWhisperCli({ ...ARGS, timestamps: true, spawnFn });
    child.emit('close', 0, null);
    await p;
    expect(argv[0]).not.toContain('--no-timestamps');
    expect(argv[0]).toContain('--no-prints');
    expect(argv[0]).toContain('-l');
  });

  it('a diagnostic seen before the stderr cap trims it out still rejects as AsrInputRejectedError', async () => {
    // The diagnostic must be caught the instant it streams by, before a
    // later flood of noise can push it out of the retained tail window —
    // otherwise an undecodable file gets misclassified as transient and
    // loops forever instead of being skipped once.
    const { spawnFn, child } = fakeSpawn();
    const p = runWhisperCli({ ...ARGS, spawnFn });
    child.stderr.emit(
      'data',
      Buffer.from(`error: ${INPUT_REJECTED_DIAGNOSTIC} '/tmp/in.wav'\n`),
    );
    for (let i = 0; i < 16; i += 1)
      child.stderr.emit('data', Buffer.alloc(1024, 0x63));
    child.emit('close', 0, null);
    await expect(p).rejects.toBeInstanceOf(AsrInputRejectedError);
    await expect(p).rejects.toMatchObject({ status: 400 });
  });
});

// Whisper decodes silence into hallucinated text — a channel that is mostly
// one person listening comes back as the last real utterance repeated once
// per window, with timestamps smeared across the silence (2026-08-17: a real
// 6-minute call produced 25× "yes" on one side). Silero VAD skips non-speech
// outright, which removes the hallucinations AND tightens the timestamps.
describe('runWhisperCli VAD', () => {
  it('enables VAD with the model path when one is given', async () => {
    const { spawnFn, child, argv } = fakeSpawn();
    const p = runWhisperCli({
      ...ARGS,
      vadModelPath: '/assets/whisper/ggml-silero-v5.1.2.bin',
      spawnFn,
    });
    child.emit('close', 0, null);
    await p;
    expect(argv[0]).toContain('--vad');
    expect(argv[0].slice(argv[0].indexOf('--vad'))).toEqual([
      '--vad',
      '-vm',
      '/assets/whisper/ggml-silero-v5.1.2.bin',
    ]);
  });

  it('omits every VAD flag when no model path is given', async () => {
    const { spawnFn, child, argv } = fakeSpawn();
    const p = runWhisperCli({ ...ARGS, spawnFn });
    child.emit('close', 0, null);
    await p;
    expect(argv[0]).not.toContain('--vad');
    expect(argv[0]).not.toContain('-vm');
  });
});
