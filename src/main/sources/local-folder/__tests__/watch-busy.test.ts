import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startWatcher } from '../watch';

// A stand-in for chokidar's FSWatcher: the test drives its events.
const fake = new EventEmitter() as EventEmitter & { close(): Promise<void> };
fake.close = async () => {};
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

describe('startWatcher — a file Windows reports busy (EBUSY)', () => {
  let dir: string;
  let ac: AbortController;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-busy-'));
    ac = new AbortController();
    fake.removeAllListeners();
  });
  afterEach(() => {
    ac.abort();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("listens for 'error', so chokidar's emit no longer throws", () => {
    const w = startWatcher([dir], ac.signal, { ms: 5, max: 5 });
    const file = path.join(dir, 'note.txt');
    expect(() => fake.emit('error', busyError(file))).not.toThrow();
    return w.close();
  });

  it('queues a change for the busy file once its size stops moving', async () => {
    const file = path.join(dir, 'note.txt');
    fs.writeFileSync(file, 'partial');
    const w = startWatcher([dir], ac.signal, { ms: 10, max: 10 });
    fake.emit('add', file); // chokidar still emits add after the error
    fake.emit('error', busyError(file));
    expect(w.take()).toEqual({ kind: 'add', absPath: file });
    fs.appendFileSync(file, ' and the rest'); // the copy finishes
    await sleep(80);
    expect(w.take()).toEqual({ kind: 'change', absPath: file });
    expect(w.take()).toBeUndefined();
    await w.close();
  });

  it('ignores busy paths that are not ingestible, and other error codes', async () => {
    const w = startWatcher([dir], ac.signal, { ms: 5, max: 5 });
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
    expect(w.take()).toBeUndefined();
    await w.close();
  });

  it('a file deleted before it settles queues nothing', async () => {
    const file = path.join(dir, 'gone.txt');
    fs.writeFileSync(file, 'x');
    const w = startWatcher([dir], ac.signal, { ms: 10, max: 5 });
    fake.emit('error', busyError(file));
    fs.rmSync(file);
    await sleep(60);
    expect(w.take()).toBeUndefined();
    await w.close();
  });

  it('close() cancels pending re-checks', async () => {
    const file = path.join(dir, 'late.txt');
    fs.writeFileSync(file, 'x');
    const w = startWatcher([dir], ac.signal, { ms: 10, max: 5 });
    fake.emit('error', busyError(file));
    await w.close();
    await sleep(50);
    expect(w.take()).toBeUndefined();
  });
});
