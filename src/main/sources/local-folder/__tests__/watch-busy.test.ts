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

  it('heldByAnotherProgram: a closed file is free', () => {
    const file = path.join(dir, 'free.txt');
    fs.writeFileSync(file, 'x');
    expect(heldByAnotherProgram(file)).toBe(false);
    expect(heldByAnotherProgram(path.join(dir, 'missing.txt'))).toBe(false);
  });
});
