import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { heldByAnotherProgram, startWatcher } from '../watch';

// A stand-in for chokidar's FSWatcher: the test drives its events and sees
// the re-watch (unwatch + add).
type Fake = EventEmitter & {
  close(): Promise<void>;
  unwatch: jest.Mock;
  add: jest.Mock;
};
const fake = new EventEmitter() as Fake;
jest.mock('chokidar', () => ({
  __esModule: true,
  default: { watch: () => fake },
}));

const busyError = (p: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`EBUSY: resource busy or locked, watch '${p}'`), {
    code: 'EBUSY',
    syscall: 'watch',
    path: p,
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const drain = (w: { take(): unknown }) => {
  const out = [];
  for (let e = w.take(); e; e = w.take()) out.push(e);
  return out;
};

describe('startWatcher — a file Windows reports busy (EBUSY)', () => {
  let dir: string;
  let ac: AbortController;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-busy-'));
    ac = new AbortController();
    fake.removeAllListeners();
    fake.close = async () => {};
    fake.unwatch = jest.fn();
    fake.add = jest.fn();
  });
  afterEach(() => {
    ac.abort();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("listens for 'error', so chokidar's emit no longer throws", () => {
    const w = startWatcher([dir], ac.signal, { ms: 5, max: 5 });
    expect(() =>
      fake.emit('error', busyError(path.join(dir, 'a.txt'))),
    ).not.toThrow();
    return w.close();
  });

  it('waits for the writer to let go, then re-watches and queues one change', async () => {
    const file = path.join(dir, 'note.txt');
    fs.writeFileSync(file, 'partial');
    let held = true;
    const w = startWatcher([dir], ac.signal, {
      ms: 10,
      max: 50,
      locked: () => held,
    });
    fake.emit('error', busyError(file));
    await sleep(60);
    fs.appendFileSync(file, ' and the rest');
    await sleep(40);
    expect(drain(w)).toEqual([]); // size equal now, but still held
    expect(fake.add).not.toHaveBeenCalled();
    held = false;
    await sleep(40);
    expect(drain(w)).toEqual([{ kind: 'change', absPath: file }]);
    expect(fake.unwatch).toHaveBeenCalledWith(file);
    expect(fake.add).toHaveBeenCalledWith(file);
    await w.close();
  });

  it('repeated errors for one path run one recovery', async () => {
    const file = path.join(dir, 'note.txt');
    fs.writeFileSync(file, 'x');
    const w = startWatcher([dir], ac.signal, {
      ms: 10,
      max: 5,
      locked: () => false,
    });
    for (let i = 0; i < 100; i += 1) fake.emit('error', busyError(file));
    await sleep(60);
    expect(drain(w)).toEqual([{ kind: 'change', absPath: file }]);
    expect(fake.add).toHaveBeenCalledTimes(1);
    await w.close();
  });

  it('a file held forever (Outlook .pst) is re-watched once at the probe limit', async () => {
    const file = path.join(dir, 'note.txt');
    fs.writeFileSync(file, 'x');
    const w = startWatcher([dir], ac.signal, {
      ms: 5,
      max: 4,
      locked: () => true,
    });
    fake.emit('error', busyError(file));
    await sleep(80);
    expect(drain(w)).toEqual([{ kind: 'change', absPath: file }]);
    expect(fake.add).toHaveBeenCalledTimes(1);
    await w.close();
  });

  it('a file deleted while busy queues nothing and is not re-watched', async () => {
    const file = path.join(dir, 'gone.txt');
    fs.writeFileSync(file, 'x');
    const w = startWatcher([dir], ac.signal, {
      ms: 10,
      max: 5,
      locked: () => false,
    });
    fake.emit('error', busyError(file));
    fs.rmSync(file);
    await sleep(60);
    expect(drain(w)).toEqual([]);
    expect(fake.add).not.toHaveBeenCalled();
    await w.close();
  });

  it('ignores busy paths that are not ingestible, and other error codes', async () => {
    const w = startWatcher([dir], ac.signal, {
      ms: 5,
      max: 5,
      locked: () => false,
    });
    const dll = path.join(dir, 'lib.dll');
    fs.writeFileSync(dll, 'x');
    fake.emit('error', busyError(dll));
    fake.emit(
      'error',
      Object.assign(new Error('ENOSPC'), {
        code: 'ENOSPC',
        path: path.join(dir, 'a.txt'),
      }),
    );
    await sleep(40);
    expect(drain(w)).toEqual([]);
    await w.close();
  });

  it('close() and abort cancel pending recoveries', async () => {
    const file = path.join(dir, 'late.txt');
    fs.writeFileSync(file, 'x');
    const w = startWatcher([dir], ac.signal, {
      ms: 10,
      max: 5,
      locked: () => false,
    });
    fake.emit('error', busyError(file));
    await w.close();
    await sleep(50);
    expect(drain(w)).toEqual([]);

    const ac2 = new AbortController();
    const w2 = startWatcher([dir], ac2.signal, {
      ms: 10,
      max: 5,
      locked: () => false,
    });
    fake.emit('error', busyError(file));
    ac2.abort();
    await sleep(50);
    expect(drain(w2)).toEqual([]);
    await w2.close();
  });

  it('a re-watch that fails busy again cannot restart recovery past the budget', async () => {
    const file = path.join(dir, 'held.txt');
    fs.writeFileSync(file, 'x');
    const w = startWatcher([dir], ac.signal, {
      ms: 5,
      max: 3,
      locked: () => false,
    });
    // Every re-watch fails the way chokidar reports it: an 'error' event.
    fake.add.mockImplementation((p: string) =>
      fake.emit('error', busyError(p)),
    );
    fake.emit('error', busyError(file));
    await sleep(150);
    // 3 probes in all: settle at probe 2 (two stats agree), its re-watch
    // fails, the new chain gets the 1 probe left and settles at the limit;
    // that re-watch's error is then ignored.
    expect(fake.add).toHaveBeenCalledTimes(2);
    expect(drain(w)).toEqual([
      { kind: 'change', absPath: file },
      { kind: 'change', absPath: file },
    ]);
    await w.close();
  });

  it('failed stats are unknown, never stable: settles only at the limit', async () => {
    const file = path.join(dir, 'denied.txt');
    fs.writeFileSync(file, 'x');
    const stat = jest.fn(() => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    });
    const locked = jest.fn(() => false);
    const w = startWatcher([dir], ac.signal, { ms: 5, max: 12, locked, stat });
    fake.emit('error', busyError(file));
    await sleep(25);
    expect(fake.add).not.toHaveBeenCalled();
    await sleep(150);
    expect(stat).toHaveBeenCalledTimes(12);
    expect(locked).not.toHaveBeenCalled(); // never reached "stable"
    expect(drain(w)).toEqual([{ kind: 'change', absPath: file }]);
    expect(fake.add).toHaveBeenCalledTimes(1);
    await w.close();
  });

  it('a size that keeps changing is not stable', async () => {
    const file = path.join(dir, 'growing.txt');
    fs.writeFileSync(file, 'x');
    let n = 0;
    const w = startWatcher([dir], ac.signal, {
      ms: 5,
      max: 50,
      locked: () => false,
      stat: () => ({ size: n++ }),
    });
    fake.emit('error', busyError(file));
    await sleep(60);
    expect(fake.add).not.toHaveBeenCalled();
    await w.close();
  });

  it('heldByAnotherProgram: a closed file is free, and the probe closes its fd', () => {
    const file = path.join(dir, 'free.txt');
    fs.writeFileSync(file, 'x');
    const close = jest.spyOn(fs, 'closeSync');
    try {
      expect(heldByAnotherProgram(file)).toBe(false);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore();
    }
  });

  it('heldByAnotherProgram: any open failure is "not known to be free"', () => {
    expect(heldByAnotherProgram(path.join(dir, 'missing.txt'))).toBe(true);
    for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
      const open = jest.spyOn(fs, 'openSync').mockImplementation(() => {
        throw Object.assign(new Error(code), { code });
      });
      try {
        expect(heldByAnotherProgram(path.join(dir, 'x.txt'))).toBe(true);
      } finally {
        open.mockRestore();
      }
    }
  });

  it('a read-only file is never "free", so it settles only at the limit', async () => {
    const file = path.join(dir, 'readonly.txt');
    fs.writeFileSync(file, 'x');
    fs.chmodSync(file, 0o444);
    const w = startWatcher([dir], ac.signal, { ms: 5, max: 12 });
    fake.emit('error', busyError(file));
    await sleep(25);
    expect(fake.add).not.toHaveBeenCalled();
    await sleep(150);
    expect(drain(w)).toEqual([{ kind: 'change', absPath: file }]);
    await w.close();
  });
});
