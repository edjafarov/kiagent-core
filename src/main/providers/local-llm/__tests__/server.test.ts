import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { LlamaServer } from '../server';

/**
 * In-process stand-in for a spawned child, ported from the reference app's
 * runtime-server.test.ts (kiagent-ref). Records the signals it receives and
 * only "exits" for the configured signals (default: any), so tests can
 * simulate a wedged process that ignores SIGTERM.
 *
 * Emits 'exit' SYNCHRONOUSLY (unlike a real ChildProcess, which is always
 * async) — deliberately, not a real-Node port: under jsdom's VM-context test
 * environment neither `process.nextTick` nor `setImmediate` reliably flushes
 * relative to fake-timer-advanced Promises, so async emission here is
 * flaky/undefined. server.ts's own listener wiring (killTimer assigned right
 * after `kill()` is called, not before) is unaffected by the ordering change.
 */
class FakeChild extends EventEmitter {
  killed = false;

  exitCode: number | null = null;

  signalCode: NodeJS.Signals | null = null;

  readonly signals: NodeJS.Signals[] = [];

  // Present only for ChildProcess shape parity (injected-spawnFn path is used).
  stdout = null;

  stderr = null;

  constructor(
    private readonly behavior: {
      exitOnSignals?: NodeJS.Signals[] | 'any';
    } = {},
  ) {
    super();
  }

  kill(signal?: NodeJS.Signals): boolean {
    const sig = signal ?? 'SIGTERM';
    this.killed = true;
    this.signals.push(sig);
    const exitOn = this.behavior.exitOnSignals ?? 'any';
    if (exitOn === 'any' || exitOn.includes(sig)) {
      this.signalCode = sig;
      this.emit('exit', null, sig);
    }
    return true;
  }

  crash(code = 1): void {
    this.exitCode = code;
    this.emit('exit', code, null);
  }
}

const noopLog = (): void => {};

describe('LlamaServer supervisor (fake timers, no real processes/network)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('respawns after an unexpected exit with growing backoff, and does not respawn after deliberate stop()', async () => {
    const children: FakeChild[] = [];
    const spawnFn = jest.fn(() => {
      const c = new FakeChild();
      children.push(c);
      return c as unknown as ChildProcess;
    });
    // Child #0 (initial start) and #2 (second respawn) report healthy; child
    // #1 (first respawn) never does — `jest.advanceTimersByTimeAsync` runs
    // any Promise chain a fired timer kicks off to completion before
    // returning, so if EVERY child reported healthy the in-flight
    // `waitHealthy()` for child #1 would resolve (resetting the backoff to 0)
    // before this test gets a chance to crash it — masking the growth this
    // test exists to verify.
    const healthyByChildIndex = [true, false, true];
    const isHealthyAt = jest.fn(
      async () => healthyByChildIndex[children.length - 1] ?? true,
    );

    const s = new LlamaServer({
      binaryPath: 'unused',
      modelPath: 'm',
      mmprojPath: 'mm',
      gpuLayers: 999,
      log: noopLog,
      port: 34567,
      spawnFn: spawnFn as any,
      isHealthyAt,
      startupTimeoutMs: 5000,
      healthPollMs: 50,
      respawnBaseMs: 100,
      respawnMaxMs: 10_000,
    });

    await s.start();
    expect(children).toHaveLength(1);
    expect(s.isHealthy()).toBe(true);

    // Unexpected crash #1 → respawn scheduled at backoff = respawnBaseMs (100ms).
    children[0].crash(1);
    expect(s.isHealthy()).toBe(false);

    // Not yet due just before the backoff elapses.
    await jest.advanceTimersByTimeAsync(99);
    expect(children).toHaveLength(1);

    await jest.advanceTimersByTimeAsync(1); // fires at 100ms total
    expect(children).toHaveLength(2);
    expect(s.isHealthy()).toBe(false); // child #2 never reports healthy

    // Crash #2, while child #2 is still unhealthy — the backoff must have
    // DOUBLED (100ms -> 200ms) rather than reset (a reset only happens once
    // a respawned child actually becomes healthy).
    children[1].crash(1);

    await jest.advanceTimersByTimeAsync(100); // half of the new 200ms backoff
    expect(children).toHaveLength(2); // not due yet — backoff grew, didn't reset

    await jest.advanceTimersByTimeAsync(100); // total 200ms since crash #2
    expect(children).toHaveLength(3);
    expect(s.isHealthy()).toBe(true); // child #3 reports healthy via isHealthyAt

    // Deliberate stop(): no further respawn, even if time is advanced a lot.
    const stopPromise = s.stop();
    await jest.advanceTimersByTimeAsync(0);
    await stopPromise;
    expect(children[2].signals).toContain('SIGTERM');

    await jest.advanceTimersByTimeAsync(60_000);
    expect(children).toHaveLength(3); // no 4th spawn after stop()
    expect(s.isHealthy()).toBe(false);
  });

  it('stop() escalates SIGTERM -> SIGKILL after the grace period for a child that ignores SIGTERM', async () => {
    const fake = new FakeChild({ exitOnSignals: ['SIGKILL'] });
    const spawnFn = jest.fn(() => fake as unknown as ChildProcess);

    const s = new LlamaServer({
      binaryPath: 'unused',
      modelPath: 'm',
      mmprojPath: 'mm',
      gpuLayers: 999,
      log: noopLog,
      port: 34568,
      spawnFn: spawnFn as any,
      isHealthyAt: async () => true,
      startupTimeoutMs: 1000,
      healthPollMs: 20,
      stopGraceMs: 200,
    });

    await s.start();
    expect(s.isHealthy()).toBe(true);

    const stopPromise = s.stop();
    await Promise.resolve();
    expect(fake.signals).toEqual(['SIGTERM']);

    // Grace period hasn't elapsed yet — no escalation.
    await jest.advanceTimersByTimeAsync(199);
    expect(fake.signals).toEqual(['SIGTERM']);

    // Grace period elapses — escalate to SIGKILL.
    await jest.advanceTimersByTimeAsync(1);
    expect(fake.signals).toEqual(['SIGTERM', 'SIGKILL']);

    await stopPromise;
    expect(s.isHealthy()).toBe(false);
  });
});

describe('LlamaServer launch args', () => {
  function capture() {
    const calls: { bin: string; args: string[] }[] = [];
    const spawnFn = ((bin: string, args: string[]) => {
      calls.push({ bin, args });
      // Minimal fake child: never exits, no error — launch() only needs
      // `.on`/`.removeListener` to be safely callable.
      const fake = {
        on: () => {},
        removeListener: () => {},
        removeAllListeners: () => {},
        kill: () => {},
        pid: 1,
      };
      return fake as unknown as ChildProcess;
    }) as any;
    return { calls, spawnFn };
  }

  /** Assert that flag and value appear consecutively in args. */
  function nglValue(args: string[]): string | undefined {
    const i = args.indexOf('-ngl');
    return i >= 0 ? args[i + 1] : undefined;
  }

  it('passes -ngl 999 when gpuLayers is 999 (GPU offload)', () => {
    const { calls, spawnFn } = capture();
    const srv = new LlamaServer({
      binaryPath: 'unused',
      modelPath: 'm',
      mmprojPath: 'mm',
      gpuLayers: 999,
      log: noopLog,
      spawnFn,
    });
    (srv as any).launch();
    expect(nglValue(calls[0].args)).toBe('999');
  });

  it('passes -ngl 0 when gpuLayers is 0 (CPU build)', () => {
    const { calls, spawnFn } = capture();
    const srv = new LlamaServer({
      binaryPath: 'unused',
      modelPath: 'm',
      mmprojPath: 'mm',
      gpuLayers: 0,
      log: noopLog,
      spawnFn,
    });
    (srv as any).launch();
    expect(nglValue(calls[0].args)).toBe('0');
  });
});
