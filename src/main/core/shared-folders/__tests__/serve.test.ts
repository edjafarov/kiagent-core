import fs from 'fs';
import path from 'path';

import { SyncReadOnly } from '../../sync/role';
import type { OfferMeta } from '../service';
import { closeDevices, device, withRoots, type Device } from './helpers/device';
import { sha } from './helpers/fake-transport';

afterEach(closeDevices);

const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const read = (file: string) => fs.readFileSync(file, 'utf8');
const scan = async (d: Device) => {
  d.svc.kick();
  await d.svc.settled();
};
const rows = async (d: Device) =>
  (await d.db.all(
    `SELECT root, rel_path, sha256, missing_here, deleted FROM shared_files ORDER BY root, rel_path`,
  )) as unknown as { root: string; rel_path: string; sha256: string; missing_here: number; deleted: number }[];

/** A leader whose manifest already lists what is in its folders. */
async function leader() {
  const d = await device('leader');
  const roots = await withRoots(d);
  await d.svc.settled();
  return { d, ...roots };
}
const offer = async (
  d: Device,
  text: string,
  over: Partial<OfferMeta> = {},
  name = 'Air',
) => {
  const root = over.root ?? 'sorted';
  const tmp = await d.svc.serve.stagingFile(root);
  fs.writeFileSync(tmp, text);
  const meta: OfferMeta = { root, relPath: 'a.txt', sha256: sha(text), base: null, captureId: null, ...over };
  return { tmp, answer: await d.svc.serve.offer(meta, tmp, name) };
};
const missingRow = (d: Device, root: string, rel: string, text: string) =>
  d.db.run(
    `INSERT INTO shared_files(root, rel_path, sha256, bytes, mtime, missing_here, deleted, parked, rev)
     VALUES(?, ?, ?, ?, '2026-01-01T00:00:00.000Z', 1, 0, 0, 50)`,
    [root, rel, sha(text), Buffer.byteLength(text)],
  );

describe('serve.open and the manifest', () => {
  it('serves only the version the live row names: not older bytes, not a missing_here or deleted row', async () => {
    const { d, sorted } = await leader();
    write(path.join(sorted, 'a.txt'), 'old');
    write(path.join(sorted, 'b.txt'), 'bee');
    write(path.join(sorted, 'c.txt'), 'sea');
    await scan(d);
    // a new leader that never fetched the newer a.txt: the row names the new bytes, the disk holds the old
    await d.db.run(`UPDATE shared_files SET sha256 = ? WHERE rel_path = 'a.txt'`, [sha('new')]);
    await d.db.run(`UPDATE shared_files SET missing_here = 1 WHERE rel_path = 'b.txt'`);
    await d.db.run(`UPDATE shared_files SET deleted = 1 WHERE rel_path = 'c.txt'`);
    const q = (relPath: string, text: string) => ({ root: 'sorted' as const, relPath, sha256: sha(text) });
    expect(await d.svc.serve.open(q('a.txt', 'old'))).toBeNull(); // old bytes, the file's own hash
    expect(await d.svc.serve.open(q('a.txt', 'new'))).toBeNull(); // the row's hash, which the disk does not have
    expect(await d.svc.serve.open(q('b.txt', 'bee'))).toBeNull();
    expect(await d.svc.serve.open(q('c.txt', 'sea'))).toBeNull();
    await d.db.run(`UPDATE shared_files SET sha256 = ? WHERE rel_path = 'a.txt'`, [sha('old')]);
    expect(await d.svc.serve.open(q('a.txt', 'old'))).toMatchObject({ bytes: 3 });
  });
});

describe('serve.open', () => {
  it('gives the path and size of a file that still has that hash; null otherwise', async () => {
    const { d, sorted } = await leader();
    write(path.join(sorted, 'tax', 'a.txt'), 'hello');
    await scan(d);
    const q = { root: 'sorted' as const, relPath: 'tax/a.txt', sha256: sha('hello') };
    expect(await d.svc.serve.open(q)).toEqual({ path: path.join(sorted, 'tax', 'a.txt'), bytes: 5 });
    expect(await d.svc.serve.open({ ...q, sha256: sha('other') })).toBeNull();
    expect(await d.svc.serve.open({ ...q, relPath: 'tax/none.txt' })).toBeNull();
  });

  it('does not hash again when size and mtime equal the mirror entry', async () => {
    const { d, sorted } = await leader();
    write(path.join(sorted, 'a.txt'), 'hello');
    await scan(d);
    d.hashed.length = 0;
    await d.svc.serve.open({ root: 'sorted', relPath: 'a.txt', sha256: sha('hello') });
    expect(d.hashed).toEqual([]);
  });

  it('a file edited since the last scan is hashed and refused', async () => {
    const { d, sorted } = await leader();
    write(path.join(sorted, 'a.txt'), 'hello');
    await scan(d);
    write(path.join(sorted, 'a.txt'), 'hello, edited');
    expect(await d.svc.serve.open({ root: 'sorted', relPath: 'a.txt', sha256: sha('hello') })).toBeNull();
  });

  it.each([['../x'], ['/etc/passwd'], ['a//b'], ['.kia-sync/x'], ['.kia-sync'], ['a/../../x'], ['']])(
    'refuses the path %j',
    async (relPath) => {
      const { d } = await leader();
      await expect(d.svc.serve.open({ root: 'sorted', relPath, sha256: 'x' })).rejects.toThrow();
    },
  );

  it('refuses an unknown root, and a root that is not set', async () => {
    const { d } = await leader();
    await expect(d.svc.serve.open({ root: 'etc' as never, relPath: 'a', sha256: 'x' })).rejects.toThrow();
    await d.svc.setRoots({ incoming: null, sorted: null });
    await expect(d.svc.serve.open({ root: 'sorted', relPath: 'a', sha256: 'x' })).rejects.toThrow();
  });

  it('a copy does not serve', async () => {
    const d = await device('copy');
    await withRoots(d);
    await expect(d.svc.serve.open({ root: 'sorted', relPath: 'a', sha256: 'x' })).rejects.toBeInstanceOf(SyncReadOnly);
    await expect(d.svc.serve.stagingFile('sorted')).rejects.toBeInstanceOf(SyncReadOnly);
    const tmp = path.join(d.dir, 'sorted', '.kia-sync', 'in-x');
    write(tmp, 'x');
    await expect(
      d.svc.serve.offer({ root: 'sorted', relPath: 'a.txt', sha256: sha('x'), base: null, captureId: null }, tmp, 'Air'),
    ).rejects.toBeInstanceOf(SyncReadOnly);
    await expect(d.svc.serve.remove({ root: 'sorted', relPath: 'a', sha256: 'x' })).rejects.toBeInstanceOf(SyncReadOnly);
  });

  it('waits for a promotion reconcile that is owed (a tombstone is applied before anything is served)', async () => {
    const d = await device('copy');
    const { sorted } = await withRoots(d);
    const f = path.join(sorted, 'a.txt');
    write(f, 'old');
    const st = fs.statSync(f);
    await d.db.run(
      `INSERT INTO shared_mirror(root, rel_path, sha256, bytes, mtime_ms) VALUES('sorted','a.txt',?,?,?)`,
      [sha('old'), st.size, Math.floor(st.mtimeMs)],
    );
    await d.db.run(
      `INSERT INTO shared_files(root, rel_path, sha256, bytes, mtime, missing_here, deleted, parked, rev)
       VALUES('sorted','a.txt',?,3,'t',0,1,0,1)`,
      [sha('old')],
    );
    d.sync.set('leader');
    expect(await d.svc.serve.open({ root: 'sorted', relPath: 'a.txt', sha256: sha('old') })).toBeNull();
    expect(d.trashed).toEqual([f]);
  });
});

describe('serve.stagingFile', () => {
  it('is a fresh path in that root\'s .kia-sync', async () => {
    const { d, incoming } = await leader();
    const a = await d.svc.serve.stagingFile('incoming');
    const b = await d.svc.serve.stagingFile('incoming');
    expect(path.dirname(a)).toBe(path.join(incoming, '.kia-sync'));
    expect(a).not.toBe(b);
    await expect(d.svc.serve.stagingFile('x' as never)).rejects.toThrow();
  });
});

describe('serve.offer, in order', () => {
  it('1. have-it: a registered capture whose bytes are in a live row here', async () => {
    const { d, incoming } = await leader();
    write(path.join(incoming, 'scan.pdf'), 'pdf bytes');
    await scan(d);
    await d.svc.registerCapture('cap-1', sha('pdf bytes'));
    const { tmp, answer } = await offer(d, 'pdf bytes', { root: 'incoming', relPath: 'other.pdf', captureId: 'cap-1' });
    expect(answer).toBe('have-it');
    expect(fs.existsSync(tmp)).toBe(false);
    await scan(d);
    expect((await rows(d)).map((r) => r.rel_path)).toEqual(['scan.pdf']);
  });

  it('1. a capture whose file sorting moved is still recognised', async () => {
    const { d, sorted } = await leader();
    write(path.join(sorted, 'Tax', 'scan.pdf'), 'pdf bytes');
    await scan(d);
    await d.svc.registerCapture('cap-1', sha('pdf bytes'));
    expect((await offer(d, 'pdf bytes', { root: 'incoming', relPath: 'again.pdf', captureId: 'cap-1' })).answer).toBe('have-it');
  });

  it('1. a capture id registered with other bytes is an ordinary file', async () => {
    const { d, incoming } = await leader();
    write(path.join(incoming, 'scan.pdf'), 'pdf bytes');
    await scan(d);
    await d.svc.registerCapture('cap-1', sha('something else'));
    const { answer } = await offer(d, 'pdf bytes', { root: 'incoming', relPath: 'copy.pdf', captureId: 'cap-1' });
    expect(answer).toBe('written');
  });

  it('1. an unregistered capture id is an ordinary file', async () => {
    const { d, incoming } = await leader();
    write(path.join(incoming, 'scan.pdf'), 'pdf bytes');
    await scan(d);
    const { answer } = await offer(d, 'pdf bytes', { root: 'incoming', relPath: 'copy.pdf', captureId: 'nope' });
    expect(answer).toBe('written');
  });

  it('1. an offer without a capture id is never answered have-it, though the bytes equal a registered capture (Review Focus 3)', async () => {
    const { d, incoming } = await leader();
    write(path.join(incoming, 'scan.pdf'), 'pdf bytes');
    await scan(d);
    await d.svc.registerCapture('cap-1', sha('pdf bytes'));
    const { answer } = await offer(d, 'pdf bytes', { root: 'incoming', relPath: 'users-copy.pdf' });
    expect(answer).toBe('written');
    expect(read(path.join(incoming, 'users-copy.pdf'))).toBe('pdf bytes');
  });

  it('2. a capture id, but the row\'s bytes are missing here: filled, not have-it (Review Focus 3)', async () => {
    const { d, incoming } = await leader();
    await missingRow(d, 'incoming', 'scan.pdf', 'pdf bytes');
    await d.svc.registerCapture('cap-1', sha('pdf bytes'));
    const { answer } = await offer(d, 'pdf bytes', { root: 'incoming', relPath: 'whatever.pdf', captureId: 'cap-1' });
    expect(answer).toBe('filled');
    expect(read(path.join(incoming, 'scan.pdf'))).toBe('pdf bytes'); // at the row's path, not the offered one
    expect(fs.existsSync(path.join(incoming, 'whatever.pdf'))).toBe(false);
    const [row] = await rows(d);
    expect(row).toMatchObject({ rel_path: 'scan.pdf', missing_here: 0, deleted: 0 });
  });

  it('2. a missing_here row is filled by its bytes at any path, with or without a capture id', async () => {
    const { d, sorted } = await leader();
    await missingRow(d, 'sorted', 'old/name.txt', 'the bytes');
    const { answer } = await offer(d, 'the bytes', { relPath: 'new-name.txt' });
    expect(answer).toBe('filled');
    expect(read(path.join(sorted, 'old', 'name.txt'))).toBe('the bytes');
  });

  it('2. an older version left at the row\'s path is replaced by the filling bytes', async () => {
    const { d, sorted } = await leader();
    write(path.join(sorted, 'a.txt'), 'older');
    await scan(d);
    await d.db.run(
      `UPDATE shared_files SET sha256 = ?, missing_here = 1, rev = 99 WHERE rel_path = 'a.txt'`,
      [sha('newer')],
    );
    expect((await offer(d, 'newer', { relPath: 'a.txt' })).answer).toBe('filled');
    expect(read(path.join(sorted, 'a.txt'))).toBe('newer');
  });

  it('2. somebody else\'s file at the row\'s path is not overwritten to fill it', async () => {
    const { d, sorted } = await leader();
    await missingRow(d, 'sorted', 'a.txt', 'the bytes');
    write(path.join(sorted, 'a.txt'), "the leader's own new file");
    const { answer } = await offer(d, 'the bytes', { relPath: 'a.txt' });
    expect(answer).toBe('kept-both');
    expect(read(path.join(sorted, 'a.txt'))).toBe("the leader's own new file");
    expect(read(path.join(sorted, 'a (from Air).txt'))).toBe('the bytes');
  });

  it('3. the file at that path has this hash: same, nothing written', async () => {
    const { d, sorted } = await leader();
    write(path.join(sorted, 'a.txt'), 'same bytes');
    await scan(d);
    const { tmp, answer } = await offer(d, 'same bytes');
    expect(answer).toBe('same');
    expect(fs.existsSync(tmp)).toBe(false);
    expect(fs.readdirSync(sorted).filter((n) => n !== '.kia-sync')).toEqual(['a.txt']);
  });

  it('4. a free path: written, and the manifest follows', async () => {
    const { d, sorted } = await leader();
    const { answer } = await offer(d, 'fresh', { relPath: 'x/y/new.txt' });
    expect(answer).toBe('written');
    expect(read(path.join(sorted, 'x', 'y', 'new.txt'))).toBe('fresh');
    await d.svc.settled();
    expect(await rows(d)).toMatchObject([{ rel_path: 'x/y/new.txt', sha256: sha('fresh'), deleted: 0 }]);
  });

  it('4. a plain edit (the leader\'s file still equals base): written over it', async () => {
    const { d, sorted } = await leader();
    write(path.join(sorted, 'a.txt'), 'v1');
    await scan(d);
    const { answer } = await offer(d, 'v2 edited on the copy', { base: sha('v1') });
    expect(answer).toBe('written');
    expect(read(path.join(sorted, 'a.txt'))).toBe('v2 edited on the copy');
    await d.svc.settled();
    expect((await rows(d))[0].sha256).toBe(sha('v2 edited on the copy'));
  });

  it('5. a conflict keeps both: the offered file gets the device name', async () => {
    const { d, sorted } = await leader();
    write(path.join(sorted, 'a.txt'), 'leader edit');
    await scan(d);
    const one = await offer(d, 'copy edit', { base: sha('v1') });
    expect(one.answer).toBe('kept-both');
    expect(read(path.join(sorted, 'a.txt'))).toBe('leader edit');
    expect(read(path.join(sorted, 'a (from Air).txt'))).toBe('copy edit');
    const two = await offer(d, 'another edit', { base: sha('v1') });
    expect(two.answer).toBe('kept-both');
    expect(read(path.join(sorted, 'a (from Air) 2.txt'))).toBe('another edit');
    await d.svc.settled();
    expect((await rows(d)).map((r) => r.rel_path)).toEqual(['a (from Air) 2.txt', 'a (from Air).txt', 'a.txt']);
  });

  it('5. no base at all and a different file there is a conflict too; a name without extension works', async () => {
    const { d, sorted } = await leader();
    write(path.join(sorted, 'notes', 'README'), 'mine');
    await scan(d);
    expect((await offer(d, 'theirs', { relPath: 'notes/README' }, 'Pro')).answer).toBe('kept-both');
    expect(read(path.join(sorted, 'notes', 'README (from Pro)'))).toBe('theirs');
  });

  it('5. a device name cannot steer the file out of the folder', async () => {
    const { d, sorted } = await leader();
    write(path.join(sorted, 'a.txt'), 'leader');
    await scan(d);
    await offer(d, 'x', {}, '../../evil/name');
    const names = fs.readdirSync(sorted).filter((n) => n !== '.kia-sync');
    expect(names).toHaveLength(2);
    expect(names.find((n) => n !== 'a.txt')).not.toMatch(/[\\/]/);
    expect(fs.existsSync(path.join(sorted, '..', '..', 'evil'))).toBe(false);
  });
});

describe('serve.offer, what it refuses', () => {
  it('bytes that do not match their hash: refused, nothing written, temp file removed', async () => {
    const { d, sorted } = await leader();
    const tmp = await d.svc.serve.stagingFile('sorted');
    fs.writeFileSync(tmp, 'actual');
    await expect(
      d.svc.serve.offer({ root: 'sorted', relPath: 'a.txt', sha256: sha('claimed'), base: null, captureId: null }, tmp, 'Air'),
    ).rejects.toThrow(/hash/);
    expect(fs.existsSync(tmp)).toBe(false);
    expect(fs.existsSync(path.join(sorted, 'a.txt'))).toBe(false);
  });

  it.each([['../x.txt'], ['/x.txt'], ['a//b.txt'], ['.kia-sync/x'], ['a/../../x']])('the path %j', async (relPath) => {
    const { d, sorted } = await leader();
    const tmp = await d.svc.serve.stagingFile('sorted');
    fs.writeFileSync(tmp, 'x');
    await expect(
      d.svc.serve.offer({ root: 'sorted', relPath, sha256: sha('x'), base: null, captureId: null }, tmp, 'Air'),
    ).rejects.toThrow();
    expect(fs.existsSync(path.join(sorted, '..', 'x.txt'))).toBe(false);
  });

  it('an unknown root', async () => {
    const { d } = await leader();
    const tmp = await d.svc.serve.stagingFile('sorted');
    fs.writeFileSync(tmp, 'x');
    await expect(
      d.svc.serve.offer({ root: 'nope' as never, relPath: 'a', sha256: sha('x'), base: null, captureId: null }, tmp, 'Air'),
    ).rejects.toThrow();
  });

  it('a temp file that is not in a .kia-sync is neither used nor deleted', async () => {
    const { d, sorted } = await leader();
    const elsewhere = path.join(d.dir, 'elsewhere.txt');
    fs.writeFileSync(elsewhere, 'x');
    await expect(
      d.svc.serve.offer({ root: 'sorted', relPath: 'a.txt', sha256: sha('x'), base: null, captureId: null }, elsewhere, 'Air'),
    ).rejects.toThrow(/\.kia-sync/);
    expect(fs.existsSync(elsewhere)).toBe(true);
    expect(fs.existsSync(path.join(sorted, 'a.txt'))).toBe(false);
  });
});

describe('serve.remove', () => {
  it('moves the file to the Trash when it still has that hash, and the manifest follows', async () => {
    const { d, sorted } = await leader();
    write(path.join(sorted, 'a.txt'), 'one');
    write(path.join(sorted, 'keep.txt'), 'k');
    await scan(d);
    expect(await d.svc.serve.remove({ root: 'sorted', relPath: 'a.txt', sha256: sha('one') })).toBe(true);
    expect(d.trashed).toEqual([path.join(sorted, 'a.txt')]);
    await d.svc.settled();
    expect((await rows(d)).find((r) => r.rel_path === 'a.txt')).toMatchObject({ deleted: 1 });
  });

  it('the last file of a folder can be removed: the folder is empty because of this device', async () => {
    const { d, sorted } = await leader();
    write(path.join(sorted, 'a.txt'), 'one');
    await scan(d);
    await d.svc.serve.remove({ root: 'sorted', relPath: 'a.txt', sha256: sha('one') });
    await d.svc.settled();
    expect(await rows(d)).toMatchObject([{ rel_path: 'a.txt', deleted: 1 }]);
  });

  it('does nothing for a stale hash', async () => {
    const { d, sorted } = await leader();
    write(path.join(sorted, 'a.txt'), 'one');
    await scan(d);
    expect(await d.svc.serve.remove({ root: 'sorted', relPath: 'a.txt', sha256: sha('older') })).toBe(false);
    expect(d.trashed).toEqual([]);
    expect(await d.svc.serve.remove({ root: 'sorted', relPath: 'none.txt', sha256: sha('one') })).toBe(false);
  });

  it.each([['../x'], ['.kia-sync/x'], ['/x']])('refuses the path %j', async (relPath) => {
    const { d } = await leader();
    await expect(d.svc.serve.remove({ root: 'sorted', relPath, sha256: 'x' })).rejects.toThrow();
  });
});
