import fs from 'fs';
import path from 'path';

import { scanRoot } from '../leader-scan';
import { closeDevices, device, withRoots, type Device } from './helpers/device';

afterEach(closeDevices);

type Row = {
  root: string; rel_path: string; sha256: string; bytes: number; missing_here: number;
  deleted: number; parked: number; rev: number;
};
const rows = async (d: Device, root?: string): Promise<Row[]> =>
  (await d.db.all(
    `SELECT root, rel_path, sha256, bytes, missing_here, deleted, parked, rev FROM shared_files
      ${root ? `WHERE root = '${root}'` : ''} ORDER BY root, rel_path`,
  )) as unknown as Row[];
const mirror = async (d: Device) =>
  (await d.db.all(`SELECT root, rel_path, sha256, bytes, capture_id FROM shared_mirror ORDER BY root, rel_path`)) as {
    root: string; rel_path: string; sha256: string; bytes: number; capture_id: string | null;
  }[];
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const setup = async () => {
  // A copy runs no background scan, so the tests below are the only scanner
  // (scanRoot does not look at the mode).
  const d = await device('copy');
  const r = await withRoots(d);
  return { d, ...r };
};

it('a new file gets a row and a mirror entry', async () => {
  const { d, sorted } = await setup();
  write(path.join(sorted, 'tax', 'a.txt'), 'hello');
  await scanRoot(d.deps, 'sorted', sorted);
  const [row] = await rows(d);
  expect(row).toMatchObject({ root: 'sorted', rel_path: 'tax/a.txt', bytes: 5, deleted: 0, missing_here: 0, parked: 0 });
  expect(await mirror(d)).toEqual([
    { root: 'sorted', rel_path: 'tax/a.txt', sha256: row.sha256, bytes: 5, capture_id: null },
  ]);
});

it('an edit changes the hash and bumps rev', async () => {
  const { d, sorted } = await setup();
  const f = path.join(sorted, 'a.txt');
  write(f, 'one');
  await scanRoot(d.deps, 'sorted', sorted);
  const [before] = await rows(d);
  write(f, 'two!');
  await scanRoot(d.deps, 'sorted', sorted);
  const [after] = await rows(d);
  expect(after.sha256).not.toBe(before.sha256);
  expect(after.rev).toBeGreaterThan(before.rev);
  expect((await mirror(d))[0].sha256).toBe(after.sha256);
});

it('a removed file becomes a deleted row with its last hash, and loses its mirror entry', async () => {
  const { d, sorted } = await setup();
  const f = path.join(sorted, 'a.txt');
  write(f, 'one');
  write(path.join(sorted, 'keep.txt'), 'stays'); // a root that lists nothing is not believed
  await scanRoot(d.deps, 'sorted', sorted);
  const [before] = await rows(d);
  fs.rmSync(f);
  await scanRoot(d.deps, 'sorted', sorted);
  const [after] = await rows(d);
  expect(after).toMatchObject({ deleted: 1, sha256: before.sha256 });
  expect(after.rev).toBeGreaterThan(before.rev);
  expect((await mirror(d)).map((m) => m.rel_path)).toEqual(['keep.txt']);
  const rev = after.rev;
  await scanRoot(d.deps, 'sorted', sorted);
  expect((await rows(d))[0].rev).toBe(rev);
});

it('a deleted row comes back when the file does', async () => {
  const { d, sorted } = await setup();
  const f = path.join(sorted, 'a.txt');
  write(f, 'one');
  await scanRoot(d.deps, 'sorted', sorted);
  fs.rmSync(f);
  await scanRoot(d.deps, 'sorted', sorted);
  write(f, 'one');
  await scanRoot(d.deps, 'sorted', sorted);
  expect((await rows(d))[0]).toMatchObject({ deleted: 0, missing_here: 0 });
});

it('a missing_here row survives a scan that does not find its file', async () => {
  const { d, sorted } = await setup();
  await d.db.run(
    `INSERT INTO shared_files(root, rel_path, sha256, bytes, mtime, missing_here, rev) VALUES('sorted','x.pdf','h',9,'t',1,5)`,
  );
  await scanRoot(d.deps, 'sorted', sorted);
  expect((await rows(d))[0]).toMatchObject({ rel_path: 'x.pdf', missing_here: 1, deleted: 0, rev: 5 });
});

it('a missing_here row keeps its manifest hash when the disk holds an older version', async () => {
  const { d, sorted } = await setup();
  write(path.join(sorted, 'x.txt'), 'old');
  await scanRoot(d.deps, 'sorted', sorted);
  await d.db.run(`UPDATE shared_files SET sha256 = 'newer', missing_here = 1, rev = 9`);
  await scanRoot(d.deps, 'sorted', sorted);
  expect((await rows(d))[0]).toMatchObject({ sha256: 'newer', missing_here: 1, rev: 9 });
});

it('a missing_here row is filled when the file with its hash is here', async () => {
  const { d, sorted } = await setup();
  write(path.join(sorted, 'x.txt'), 'bytes');
  await scanRoot(d.deps, 'sorted', sorted);
  await d.db.run(`UPDATE shared_files SET missing_here = 1, rev = 9`);
  await d.db.run(`DELETE FROM shared_mirror`);
  await scanRoot(d.deps, 'sorted', sorted);
  expect((await rows(d))[0]).toMatchObject({ missing_here: 0 });
  expect((await rows(d))[0].rev).toBeGreaterThan(9);
});

it('the first Incoming scan parks what it finds; later files and Sorted files are not parked', async () => {
  const { d, incoming, sorted } = await setup();
  write(path.join(incoming, 'old.pdf'), 'old');
  write(path.join(sorted, 'kept.pdf'), 'kept');
  await scanRoot(d.deps, 'incoming', incoming);
  await scanRoot(d.deps, 'sorted', sorted);
  write(path.join(incoming, 'new.pdf'), 'new');
  await scanRoot(d.deps, 'incoming', incoming);
  expect((await rows(d)).map((r) => [r.root, r.rel_path, r.parked])).toEqual([
    ['incoming', 'new.pdf', 0],
    ['incoming', 'old.pdf', 1],
    ['sorted', 'kept.pdf', 0],
  ]);
});

it('an Incoming that was empty at the first scan does not park its first file', async () => {
  const { d, incoming } = await setup();
  await scanRoot(d.deps, 'incoming', incoming);
  write(path.join(incoming, 'scan.pdf'), 'first');
  await scanRoot(d.deps, 'incoming', incoming);
  expect((await rows(d))[0]).toMatchObject({ rel_path: 'scan.pdf', parked: 0 });
});

it('a leader that already has Incoming rows parks nothing it finds', async () => {
  const { d, incoming } = await setup();
  await d.db.run(
    `INSERT INTO shared_files(root, rel_path, sha256, bytes, mtime, rev) VALUES('incoming','seen.pdf','h',1,'t',1)`,
  );
  write(path.join(incoming, 'fresh.pdf'), 'fresh');
  await scanRoot(d.deps, 'incoming', incoming);
  expect((await rows(d, 'incoming')).find((r) => r.rel_path === 'fresh.pdf')!.parked).toBe(0);
});

it('a root that is gone changes nothing and logs once (Review Focus 5)', async () => {
  const { d, sorted } = await setup();
  write(path.join(sorted, 'a.txt'), 'one');
  await scanRoot(d.deps, 'sorted', sorted);
  const before = await rows(d);
  fs.rmSync(sorted, { recursive: true });
  await scanRoot(d.deps, 'sorted', sorted);
  await scanRoot(d.deps, 'sorted', sorted);
  expect(await rows(d)).toEqual(before);
  expect(await mirror(d)).toHaveLength(1);
  expect(d.logs.filter((l) => l.includes('sorted'))).toHaveLength(1);
});

it('a root that is a file, not a folder, changes nothing', async () => {
  const { d, sorted } = await setup();
  write(path.join(sorted, 'a.txt'), 'one');
  await scanRoot(d.deps, 'sorted', sorted);
  const before = await rows(d);
  fs.rmSync(sorted, { recursive: true });
  fs.writeFileSync(sorted, 'not a folder');
  await scanRoot(d.deps, 'sorted', sorted);
  expect(await rows(d)).toEqual(before);
});

it('a folder that cannot be read hides its files but tombstones none of them', async () => {
  const { d, sorted } = await setup();
  const locked = path.join(sorted, 'locked');
  write(path.join(locked, 'a.txt'), 'one');
  write(path.join(sorted, 'b.txt'), 'two');
  await scanRoot(d.deps, 'sorted', sorted);
  fs.chmodSync(locked, 0o000);
  try {
    await scanRoot(d.deps, 'sorted', sorted);
    expect((await rows(d)).map((r) => [r.rel_path, r.deleted])).toEqual([['b.txt', 0], ['locked/a.txt', 0]]);
  } finally {
    fs.chmodSync(locked, 0o755);
  }
});

it('.kia-sync content is never listed, hashed or mirrored', async () => {
  const { d, sorted } = await setup();
  write(path.join(sorted, '.kia-sync', 'partial.pdf'), 'in transit');
  write(path.join(sorted, 'real.pdf'), 'real');
  await scanRoot(d.deps, 'sorted', sorted);
  expect((await rows(d)).map((r) => r.rel_path)).toEqual(['real.pdf']);
  expect(d.hashed.some((h) => h.includes('.kia-sync'))).toBe(false);
});

it('an unchanged file is not hashed twice', async () => {
  const { d, sorted } = await setup();
  write(path.join(sorted, 'a.txt'), 'one');
  await scanRoot(d.deps, 'sorted', sorted);
  await scanRoot(d.deps, 'sorted', sorted);
  expect(d.hashed).toHaveLength(1);
});

it('a rename carries the capture id to the new mirror entry', async () => {
  const { d, incoming } = await setup();
  const a = path.join(incoming, 'scan.pdf');
  write(a, 'pixels');
  await scanRoot(d.deps, 'incoming', incoming);
  await d.db.run(`UPDATE shared_mirror SET capture_id = 'cap-1'`);
  fs.renameSync(a, path.join(incoming, 'renamed.pdf'));
  await scanRoot(d.deps, 'incoming', incoming);
  expect(await mirror(d)).toMatchObject([{ rel_path: 'renamed.pdf', capture_id: 'cap-1' }]);
  expect((await rows(d)).map((r) => [r.rel_path, r.deleted])).toEqual([['renamed.pdf', 0], ['scan.pdf', 1]]);
});

it('an edit keeps the capture id on the mirror entry', async () => {
  const { d, incoming } = await setup();
  const a = path.join(incoming, 'scan.pdf');
  write(a, 'pixels');
  await scanRoot(d.deps, 'incoming', incoming);
  await d.db.run(`UPDATE shared_mirror SET capture_id = 'cap-1'`);
  write(a, 'more pixels');
  await scanRoot(d.deps, 'incoming', incoming);
  expect((await mirror(d))[0].capture_id).toBe('cap-1');
});

it('a root that lists no file at all is not believed: nothing is tombstoned, logged once', async () => {
  const { d, sorted } = await setup();
  write(path.join(sorted, 'a.txt'), 'one');
  write(path.join(sorted, 'b.txt'), 'two');
  await scanRoot(d.deps, 'sorted', sorted);
  const before = await rows(d);
  const mirrorBefore = await mirror(d);
  fs.rmSync(path.join(sorted, 'a.txt'));
  fs.rmSync(path.join(sorted, 'b.txt'));
  await scanRoot(d.deps, 'sorted', sorted);
  await scanRoot(d.deps, 'sorted', sorted);
  expect(await rows(d)).toEqual(before);
  expect(await mirror(d)).toEqual(mirrorBefore);
  expect(d.logs.filter((l) => l.includes('lists no file at all'))).toHaveLength(1);
  // the files come back: the root is believed again
  write(path.join(sorted, 'a.txt'), 'one');
  await scanRoot(d.deps, 'sorted', sorted);
  expect((await rows(d)).map((r) => [r.rel_path, r.deleted])).toEqual([['a.txt', 0], ['b.txt', 1]]);
});

it('an empty first Incoming is still a fresh root: no rows, nothing to protect', async () => {
  const { d, incoming } = await setup();
  await scanRoot(d.deps, 'incoming', incoming);
  expect(await rows(d)).toEqual([]);
  expect(d.logs.filter((l) => l.includes('lists no file at all'))).toHaveLength(0);
});

it('a folder emptied by this device\'s own hands (sorting, a mirrored removal) is believed', async () => {
  const { d, sorted } = await setup();
  write(path.join(sorted, 'a.txt'), 'one');
  write(path.join(sorted, 'b.txt'), 'two');
  await scanRoot(d.deps, 'sorted', sorted);
  fs.rmSync(path.join(sorted, 'a.txt'));
  fs.rmSync(path.join(sorted, 'b.txt'));
  await scanRoot({ ...d.deps, explained: new Set(['sorted/a.txt']) }, 'sorted', sorted); // b.txt is unexplained
  expect((await rows(d)).map((r) => r.deleted)).toEqual([0, 0]);
  await scanRoot({ ...d.deps, explained: new Set(['sorted/a.txt', 'sorted/b.txt']) }, 'sorted', sorted);
  expect((await rows(d)).map((r) => r.deleted)).toEqual([1, 1]);
});
