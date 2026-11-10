import fs from 'fs';
import path from 'path';

import { sha } from './helpers/fake-transport';
import { closeDevices, device, withRoots, type Device } from './helpers/device';
import { serveTransport } from './helpers/fake-transport';
import { mirrorPass } from '../mirror';

afterEach(closeDevices);

const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const rows = async (d: Device, root = 'sorted') =>
  (await d.db.all(`SELECT rel_path, deleted, missing_here FROM shared_files WHERE root = ? ORDER BY rel_path`, [
    root,
  ])) as unknown as { rel_path: string; deleted: number; missing_here: number }[];
const scan = async (d: Device) => {
  d.svc.kick();
  await d.svc.settled();
};
const pausedKey = async (d: Device) =>
  (await d.db.all(`SELECT value FROM meta WHERE key = 'shared-folders:paused'`)).map((r) => r.value);

/** A leader whose Sorted folder holds a.txt and b.txt, scanned. */
async function populated() {
  const d = await device('leader');
  const { sorted, incoming } = await withRoots(d);
  write(path.join(sorted, 'a.txt'), 'one');
  write(path.join(sorted, 'b.txt'), 'two');
  await scan(d);
  return { d, sorted, incoming };
}
const unmount = (sorted: string) => {
  for (const f of fs.readdirSync(sorted)) fs.rmSync(path.join(sorted, f), { recursive: true });
};

describe('a paused root accepts nothing and stays paused', () => {
  it('an offer into an emptied root is refused, installs nothing and leaves no staging directory', async () => {
    const { d, sorted } = await populated();
    unmount(sorted);
    const tmp = path.join(sorted, '.kia-sync', 'in-staged-before'); // staged before the volume went
    write(tmp, 'new bytes');
    await expect(
      d.svc.serve.offer({ root: 'sorted', relPath: 'x.txt', sha256: sha('new bytes'), base: null, captureId: null }, tmp, 'Air'),
    ).rejects.toMatchObject({ code: 'SHARED_ROOT_PAUSED' });
    expect(fs.readdirSync(sorted)).toEqual(['.kia-sync']);
    expect(fs.readdirSync(path.join(sorted, '.kia-sync'))).toEqual([]); // the refused upload is dropped
    await scan(d);
    expect((await rows(d)).map((r) => r.deleted)).toEqual([0, 0]);
  });

  it('stagingFile does not create a staging directory in a root that has just emptied', async () => {
    const { d, sorted } = await populated();
    unmount(sorted);
    await expect(d.svc.serve.stagingFile('sorted')).rejects.toMatchObject({ code: 'SHARED_ROOT_PAUSED' });
    expect(fs.readdirSync(sorted)).toEqual([]);
  });

  it('a root emptied by this Mac\'s own move is not paused for a request', async () => {
    const { d, incoming } = await populated();
    write(path.join(incoming, 'in.pdf'), 'scan');
    await scan(d);
    fs.rmSync(path.join(incoming, 'in.pdf'));
    await d.db.run(`INSERT INTO shared_pending(kind, root, rel_path) VALUES('moved', 'incoming', 'in.pdf')`);
    await expect(d.svc.serve.stagingFile('incoming')).resolves.toContain('.kia-sync');
  });

  it('a root holding only files the index does not admit is as good as empty', async () => {
    const { d, sorted } = await populated();
    unmount(sorted);
    write(path.join(sorted, '.DS_Store'), 'finder'); // what a mount point can hold
    await expect(d.svc.serve.stagingFile('sorted')).rejects.toMatchObject({ code: 'SHARED_ROOT_PAUSED' });
  });

  it('open and remove are refused too', async () => {
    const { d, sorted } = await populated();
    unmount(sorted);
    await expect(d.svc.serve.open({ root: 'sorted', relPath: 'a.txt', sha256: sha('one') })).rejects.toMatchObject({
      code: 'SHARED_ROOT_PAUSED',
    });
    await expect(d.svc.serve.remove({ root: 'sorted', relPath: 'a.txt', sha256: sha('one') })).rejects.toMatchObject({
      code: 'SHARED_ROOT_PAUSED',
    });
  });

  it('a file that is not one of the manifest rows does not release the pause; one that is does', async () => {
    const { d, sorted } = await populated();
    unmount(sorted);
    await scan(d);
    expect(await pausedKey(d)).toHaveLength(1);
    write(path.join(sorted, 'stray.txt'), 'something else'); // e.g. what a mount point holds
    await scan(d);
    expect((await rows(d)).map((r) => [r.rel_path, r.deleted])).toEqual([['a.txt', 0], ['b.txt', 0]]);
    expect(d.svc.usable('sorted')).toBe(false);
    write(path.join(sorted, 'a.txt'), 'one'); // a row's file is back: the volume is
    await scan(d);
    expect(d.svc.usable('sorted')).toBe(true);
    expect(await pausedKey(d)).toEqual([]);
    expect((await rows(d)).map((r) => [r.rel_path, r.deleted])).toEqual([['a.txt', 0], ['b.txt', 1], ['stray.txt', 0]]);
  });

  it('a pause survives a restart', async () => {
    const { d, sorted } = await populated();
    unmount(sorted);
    await scan(d);
    const again = await d.restart();
    expect(again.usable('sorted')).toBe(false);
    write(path.join(sorted, 'stray.txt'), 'x');
    again.kick();
    await again.settled();
    expect((await rows(d)).map((r) => r.deleted)).toEqual([0, 0]);
  });

  it('a missing root is paused as well, and a returning empty directory stays paused', async () => {
    const { d, sorted } = await populated();
    fs.rmSync(sorted, { recursive: true });
    await scan(d);
    fs.mkdirSync(sorted);
    await scan(d);
    expect((await rows(d)).map((r) => r.deleted)).toEqual([0, 0]);
    expect(d.svc.usable('sorted')).toBe(false);
  });

  it('a copy: an emptied root with a stray file sends no deletion and removes nothing', async () => {
    const c = await device('copy');
    const { sorted } = await withRoots(c);
    write(path.join(sorted, 'a.txt'), 'one');
    write(path.join(sorted, 'b.txt'), 'two');
    for (const [rel, t] of [['a.txt', 'one'], ['b.txt', 'two']] as const) {
      await c.db.run(
        `INSERT INTO shared_files(root, rel_path, sha256, bytes, mtime, rev) VALUES('sorted', ?, ?, ?, 't', 3)`,
        [rel, sha(t), t.length],
      );
      await c.db.run(`INSERT INTO shared_mirror(root, rel_path, sha256, bytes, mtime_ms) VALUES('sorted', ?, ?, ?, 0)`, [
        rel,
        sha(t),
        t.length,
      ]);
    }
    const t = serveTransport({ open: async () => null, stagingFile: async () => '', offer: async () => 'written', remove: async () => true });
    const run = () => mirrorPass({ ...c.deps, roots: c.svc.roots() }, t);
    unmount(sorted);
    await run();
    write(path.join(sorted, 'stray.txt'), 'x');
    await run();
    expect(t.calls.filter((x) => x.startsWith('remove'))).toEqual([]);
    expect((await c.db.all(`SELECT 1 FROM shared_mirror`)).length).toBe(2);
  });

  it('the sorter emptying Incoming after a scan saw the gap: paused, then released once moved() explains it', async () => {
    const { d, incoming, sorted } = await populated();
    write(path.join(incoming, 'in.pdf'), 'scan');
    await scan(d);
    fs.mkdirSync(path.join(sorted, 'tax'), { recursive: true });
    fs.renameSync(path.join(incoming, 'in.pdf'), path.join(sorted, 'tax', 'in.pdf'));
    await scan(d); // the scan saw the file gone before documents reported the move
    expect((await rows(d, 'incoming')).map((r) => r.deleted)).toEqual([0]);
    await d.svc.moved(path.join(incoming, 'in.pdf'), path.join(sorted, 'tax', 'in.pdf'));
    await d.svc.settled();
    expect((await rows(d, 'incoming')).map((r) => r.deleted)).toEqual([1]);
    expect(d.svc.usable('incoming')).toBe(true);
  });
});
