import { createHash } from 'node:crypto';
import fs from 'fs';
import path from 'path';

import { SyncReadOnly } from '../../sync/role';
import type { SharedTransport } from '../service';
import { closeDevices, device, withRoots } from './helpers/device';
import { sha } from './helpers/fake-transport';

afterEach(closeDevices);

const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hashOf = (p: string) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/** A hashFile that stops on files whose name matches until `release()`. */
function gated(match: (p: string) => boolean) {
  const reached = deferred();
  const gate = deferred();
  return {
    reached: reached.promise,
    release: gate.resolve,
    hashFile: async (p: string) => {
      if (match(p)) {
        reached.resolve();
        await gate.promise;
      }
      return hashOf(p);
    },
  };
}
const revs = async (d: { db: { all: (s: string) => Promise<Record<string, unknown>[]> } }) =>
  (await d.db.all(`SELECT rel_path, rev FROM shared_files ORDER BY rev`)) as unknown as { rel_path: string; rev: number }[];

describe('one queue, and the role is checked at every write', () => {
  it('a filled offer that commits while a scan hashes gets its own revision', async () => {
    const g = gated((p) => p.endsWith('new.txt'));
    const d = await device('leader', { hashFile: g.hashFile });
    const { incoming, sorted } = await withRoots(d);
    await d.svc.settled();
    await d.db.run(
      `INSERT INTO shared_files(root, rel_path, sha256, bytes, mtime, missing_here, deleted, parked, rev)
       VALUES('sorted','m.txt',?,2,'t',1,0,0,5)`,
      [sha('mm')],
    );
    write(path.join(incoming, 'new.txt'), 'new');
    d.svc.kick();
    await g.reached;
    const tmp = await d.svc.serve.stagingFile('sorted');
    fs.writeFileSync(tmp, 'mm');
    const offered = d.svc.serve.offer(
      { root: 'sorted', relPath: 'm.txt', sha256: sha('mm'), base: null, captureId: null },
      tmp,
      'Air',
    );
    await nap(30);
    g.release();
    expect(await offered).toBe('filled');
    await d.svc.settled();
    const all = await revs(d);
    expect(all.map((r) => r.rel_path).sort()).toEqual(['m.txt', 'new.txt']);
    expect(new Set(all.map((r) => r.rev)).size).toBe(2);
    expect(all.every((r) => r.rev > 5)).toBe(true);
    void sorted;
  });

  it('a scan that is hashing when the Mac is demoted writes nothing', async () => {
    const g = gated((p) => p.endsWith('new.txt'));
    const d = await device('leader', { hashFile: g.hashFile });
    const { incoming } = await withRoots(d);
    await d.svc.settled();
    write(path.join(incoming, 'new.txt'), 'new');
    d.svc.kick();
    await g.reached;
    d.sync.set('copy');
    g.release();
    await d.svc.settled();
    expect(await revs(d)).toEqual([]);
    expect(await d.db.all(`SELECT 1 FROM shared_mirror`)).toEqual([]);
  });

  it('an offer that is still being hashed when the Mac is demoted places nothing', async () => {
    const g = gated((p) => path.basename(p).startsWith('in-'));
    const d = await device('leader', { hashFile: g.hashFile });
    const { sorted } = await withRoots(d);
    await d.svc.settled();
    const tmp = await d.svc.serve.stagingFile('sorted');
    fs.writeFileSync(tmp, 'bytes');
    const offered = d.svc.serve.offer(
      { root: 'sorted', relPath: 'x.txt', sha256: sha('bytes'), base: null, captureId: null },
      tmp,
      'Air',
    );
    const outcome = offered.then(
      () => 'answered',
      (e: unknown) => (e instanceof SyncReadOnly ? 'read-only' : String(e)),
    );
    await g.reached;
    d.sync.set('copy');
    g.release();
    expect(await outcome).toBe('read-only');
    expect(fs.existsSync(path.join(sorted, 'x.txt'))).toBe(false);
  });

  it('a copy pass that is fetching when the Mac takes the lead installs nothing', async () => {
    const d = await device('copy');
    const { sorted } = await withRoots(d);
    await d.db.run(
      `INSERT INTO shared_files(root, rel_path, sha256, bytes, mtime, missing_here, deleted, parked, rev)
       VALUES('sorted','a.txt',?,4,'2026-01-01T00:00:00.000Z',0,0,0,3)`,
      [sha('data')],
    );
    const reached = deferred();
    const gate = deferred();
    const t: SharedTransport = {
      fetch: async (_q, dest) => {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, 'data');
        reached.resolve();
        await gate.promise;
        return 'ok';
      },
      offer: async () => 'written',
      remove: async () => {},
    };
    d.svc.setTransport(t);
    await reached.promise;
    d.sync.set('leader');
    gate.resolve();
    await d.svc.settled();
    expect(fs.existsSync(path.join(sorted, 'a.txt'))).toBe(false);
    expect(await d.db.all(`SELECT 1 FROM shared_mirror WHERE rel_path = 'a.txt'`)).toEqual([]);
  });

  it('serve answers only after the pass that is running has finished', async () => {
    const g = gated((p) => p.endsWith('new.txt'));
    const d = await device('leader', { hashFile: g.hashFile });
    const { incoming, sorted } = await withRoots(d);
    await d.svc.settled();
    write(path.join(sorted, 'a.txt'), 'one');
    write(path.join(incoming, 'new.txt'), 'new');
    d.svc.kick();
    await g.reached;
    let answered = false;
    const opened = d.svc.serve.open({ root: 'sorted', relPath: 'a.txt', sha256: sha('one') }).then((r) => {
      answered = true;
      return r;
    });
    await nap(40);
    expect(answered).toBe(false);
    g.release();
    expect(await opened).toMatchObject({ bytes: 3 });
  });
});
