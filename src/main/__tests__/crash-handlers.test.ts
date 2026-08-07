/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  CRASH_LOG_FILE,
  describeError,
  installCrashHandlers,
  recordCrash,
  reportBootFailure,
  type CrashDeps,
} from '../crash-handlers';

function makeDeps(overrides: Partial<CrashDeps> = {}) {
  const logDir = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'kia-crash-')),
    'logs',
  );
  const sinkCalls: Array<[string, string, string]> = [];
  const boxes: Array<[string, string]> = [];
  const exits: number[] = [];
  const appEvents = new Map<string, (...args: unknown[]) => void>();
  const deps: CrashDeps = {
    logDir,
    sink: () => ({
      log: (scope, level, msg) => {
        sinkCalls.push([scope, level, msg]);
      },
    }),
    showErrorBox: (t, c) => boxes.push([t, c]),
    exit: (c) => exits.push(c),
    onAppEvent: (event, handler) => appEvents.set(event, handler),
    ...overrides,
  };
  const readLines = () =>
    fs
      .readFileSync(path.join(logDir, CRASH_LOG_FILE), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
  return { deps, logDir, sinkCalls, boxes, exits, appEvents, readLines };
}

describe('describeError', () => {
  it('keeps name, message and stack from an Error', () => {
    const out = describeError(new TypeError('bad thing'));
    expect(out.name).toBe('TypeError');
    expect(out.message).toBe('bad thing');
    expect(String(out.stack)).toContain('bad thing');
  });

  it('handles a thrown non-Error', () => {
    expect(describeError('just a string')).toEqual({
      message: 'just a string',
    });
    expect(describeError(undefined)).toEqual({ message: 'undefined' });
  });
});

describe('recordCrash', () => {
  it('creates the log dir and appends a durable JSONL record', () => {
    const { deps, readLines } = makeDeps();
    recordCrash(deps, 'main.crash', 'uncaught exception', new Error('boom'));
    const [rec] = readLines();
    expect(rec.level).toBe('error');
    expect(rec.scope).toBe('main.crash');
    expect(rec.msg).toBe('uncaught exception');
    expect(rec.fields.message).toBe('boom');
    expect(rec.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('writes synchronously, so the record survives an immediate exit', () => {
    const { deps, logDir } = makeDeps();
    recordCrash(deps, 'main.crash', 'x', new Error('boom'));
    // No tick awaited: if this were fs.appendFile the file would not exist.
    expect(fs.existsSync(path.join(logDir, CRASH_LOG_FILE))).toBe(true);
  });

  it('also notifies the sink, for the live viewer and the ring', () => {
    const { deps, sinkCalls } = makeDeps();
    recordCrash(deps, 'main.crash', 'uncaught exception', new Error('boom'));
    expect(sinkCalls).toEqual([['main.crash', 'error', 'uncaught exception']]);
  });

  it('still lands on disk when there is no sink yet — the boot-failure case', () => {
    const { deps, readLines } = makeDeps({ sink: () => null });
    recordCrash(deps, 'main.boot', 'boot failed', new Error('no db'));
    expect(readLines()[0].fields.message).toBe('no db');
  });

  it('does not throw when the sink throws — the disk record already landed', () => {
    const { deps, readLines } = makeDeps({
      sink: () => ({
        log: () => {
          throw new Error('sink is broken too');
        },
      }),
    });
    expect(() => recordCrash(deps, 's', 'm', new Error('boom'))).not.toThrow();
    expect(readLines()).toHaveLength(1);
  });

  it('does not throw when the log directory cannot be written', () => {
    const { deps } = makeDeps({ logDir: '/proc/definitely/not/writable' });
    expect(() => recordCrash(deps, 's', 'm', new Error('boom'))).not.toThrow();
  });
});

describe('reportBootFailure', () => {
  it('records, shows a dialog naming the log file, and exits non-zero', () => {
    const { deps, boxes, exits, readLines, logDir } = makeDeps();
    reportBootFailure(deps, new Error('worker handshake timed out'));

    expect(readLines()[0]).toMatchObject({
      scope: 'main.boot',
      msg: 'boot failed',
    });
    expect(boxes[0][0]).toBe('kiagent could not start');
    expect(boxes[0][1]).toContain('worker handshake timed out');
    expect(boxes[0][1]).toContain(path.join(logDir, CRASH_LOG_FILE));
    expect(exits).toEqual([1]);
  });
});

describe('installCrashHandlers', () => {
  it('records, reports and exits on an uncaught exception, then uninstalls cleanly', () => {
    const { deps, boxes, exits, readLines } = makeDeps();
    const before = process.listenerCount('uncaughtException');
    const uninstall = installCrashHandlers(deps);
    expect(process.listenerCount('uncaughtException')).toBe(before + 1);

    process.emit('uncaughtException', new Error('kaboom'));

    expect(readLines()[0]).toMatchObject({
      scope: 'main.crash',
      msg: 'uncaught exception',
    });
    expect(boxes[0][0]).toBe('kiagent has stopped');
    expect(exits).toEqual([1]);

    uninstall();
    expect(process.listenerCount('uncaughtException')).toBe(before);
  });

  /* Verified against this Electron build: an unhandled rejection warns and the
   * app carries on, unlike an uncaught exception. Recording it must not turn a
   * stray rejection into a fatal modal. */
  it('records an unhandled rejection without a dialog and without exiting', () => {
    const { deps, boxes, exits, readLines } = makeDeps();
    const uninstall = installCrashHandlers(deps);

    process.emit(
      'unhandledRejection',
      new Error('nobody caught me'),
      Promise.resolve(),
    );

    expect(readLines()[0]).toMatchObject({
      scope: 'main.crash',
      msg: 'unhandled rejection',
    });
    expect(readLines()[0].fields.message).toBe('nobody caught me');
    expect(boxes).toEqual([]);
    expect(exits).toEqual([]);
    uninstall();
  });

  it('records a gone render process without exiting — its supervisor decides', () => {
    const { deps, appEvents, exits, readLines } = makeDeps();
    const uninstall = installCrashHandlers(deps);

    appEvents.get('render-process-gone')?.(
      {},
      {},
      {
        reason: 'crashed',
        exitCode: 133,
      },
    );

    expect(readLines()[0]).toMatchObject({
      scope: 'main.crash',
      msg: 'render process gone',
    });
    expect(exits).toEqual([]);
    uninstall();
  });

  it('records a gone child process without exiting', () => {
    const { deps, appEvents, exits, readLines } = makeDeps();
    const uninstall = installCrashHandlers(deps);

    appEvents.get('child-process-gone')?.(
      {},
      {
        type: 'Utility',
        reason: 'crashed',
      },
    );

    expect(readLines()[0].msg).toBe('child process gone');
    expect(exits).toEqual([]);
    uninstall();
  });
});
