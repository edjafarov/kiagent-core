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

  kill(sig?: string) {
    this.killed.push(sig ?? 'SIGTERM');
    return true;
  }
}

function fakeSpawn(): { spawnFn: SpawnFn; child: FakeChild; argv: string[][] } {
  const child = new FakeChild();
  const argv: string[][] = [];
  const spawnFn = ((cmd: string, args: string[]) => {
    argv.push([cmd, ...args]);
    return child;
  }) as unknown as SpawnFn;
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

  it('caps retained stderr (bounded capture)', async () => {
    const { spawnFn, child } = fakeSpawn();
    const p = runWhisperCli({ ...ARGS, spawnFn });
    for (let i = 0; i < 100; i += 1)
      child.stderr.emit('data', Buffer.alloc(1024, 0x62));
    child.emit('close', 5, null);
    await p.catch((e: Error) => {
      expect(e.message.length).toBeLessThan(16 * 1024);
    });
  });
});
