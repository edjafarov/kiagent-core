import { createHash } from 'node:crypto';
import fs from 'fs';
import path from 'path';

import { SyncReadOnly } from '../../sync/role';
import { closeDevices, device, withRoots } from './helpers/device';

afterEach(closeDevices);

const addAccount = (d: Awaited<ReturnType<typeof device>>) =>
  d.db.run(
    `INSERT INTO accounts(id, source, identifier, config, status, created_at)
     VALUES('acct-shared', 'shared-folder', 'shared', '{}', 'connecting', 'now')`,
  );

it('resolve maps a path under Incoming to its document identity', async () => {
  const d = await device();
  await addAccount(d);
  const { incoming } = await withRoots(d);
  expect(await d.svc.resolve(path.join(incoming, 'a', 'scan.pdf'))).toEqual({
    accountId: 'acct-shared',
    externalId: 'incoming/a/scan.pdf',
    root: 'incoming',
    relPath: 'a/scan.pdf',
  });
});

it('resolve is null outside both roots, in .kia-sync, and before the account exists', async () => {
  const d = await device();
  const { incoming } = await withRoots(d);
  expect(await d.svc.resolve(path.join(incoming, 'x.pdf'))).toBeNull();
  await addAccount(d);
  expect(await d.svc.resolve(path.join(d.dir, 'elsewhere', 'x.pdf'))).toBeNull();
  expect(await d.svc.resolve(path.join(incoming, '.kia-sync', 'tmp'))).toBeNull();
});

const sha = (t: string) => createHash('sha256').update(t).digest('hex');
const put = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const doc = (externalId: string) => ({ accountId: 'acct-shared', externalId });

it('pathOf is the inverse of resolve, and null when the root is unset', async () => {
  const d = await device();
  await addAccount(d);
  const { sorted } = await withRoots(d);
  const abs = path.join(sorted, 'tax', '2025.pdf');
  put(abs, 'tax');
  d.svc.kick();
  await d.svc.settled();
  const ref = (await d.svc.resolve(abs))!;
  expect(await d.svc.pathOf(ref)).toBe(abs);
  await d.svc.setRoots({ incoming: null, sorted: null });
  expect(await d.svc.pathOf(ref)).toBeNull();
});

describe('pathOf is given only for the right bytes', () => {
  const live = async (mode: 'leader' | 'copy' = 'leader') => {
    const d = await device(mode);
    await addAccount(d);
    const roots = await withRoots(d);
    return { d, ...roots };
  };
  const row = (d: Awaited<ReturnType<typeof device>>, rel: string, text: string, missing = 0, deleted = 0) =>
    d.db.run(
      `INSERT INTO shared_files(root, rel_path, sha256, bytes, mtime, missing_here, deleted, parked, rev)
       VALUES('sorted', ?, ?, ?, 't', ?, ?, 0, 3)`,
      [rel, sha(text), text.length, missing, deleted],
    );

  it('a file on disk with no row has no path', async () => {
    const { d, sorted } = await live('copy');
    put(path.join(sorted, 'a.pdf'), 'x');
    expect(await d.svc.pathOf(doc('sorted/a.pdf'))).toBeNull();
  });

  it('a tombstone has no path', async () => {
    const { d, sorted } = await live('copy');
    put(path.join(sorted, 'a.pdf'), 'x');
    await row(d, 'a.pdf', 'x', 0, 1);
    expect(await d.svc.pathOf(doc('sorted/a.pdf'))).toBeNull();
  });

  it('after a promotion that left the older version on disk, the path is not given', async () => {
    const { d, sorted } = await live('copy');
    put(path.join(sorted, 'a.pdf'), 'old');
    await d.db.run(`INSERT INTO shared_mirror(root, rel_path, sha256, bytes, mtime_ms) VALUES('sorted','a.pdf',?,3,0)`, [sha('old')]);
    await row(d, 'a.pdf', 'new');
    d.sync.set('leader');
    await d.svc.settled();
    const [r] = await d.db.all(`SELECT missing_here FROM shared_files WHERE rel_path = 'a.pdf'`);
    expect(r.missing_here).toBe(1);
    expect(await d.svc.pathOf(doc('sorted/a.pdf'))).toBeNull();
  });

  it('a copy that holds the right bytes of a missing_here row gets its path', async () => {
    const { d, sorted } = await live('copy');
    put(path.join(sorted, 'a.pdf'), 'new');
    await row(d, 'a.pdf', 'new', 1);
    expect(await d.svc.pathOf(doc('sorted/a.pdf'))).toBe(path.join(sorted, 'a.pdf'));
  });

  it('a file edited here since the mirror entry has no path until the manifest agrees', async () => {
    const { d, sorted } = await live();
    const abs = path.join(sorted, 'a.pdf');
    put(abs, 'one');
    d.svc.kick();
    await d.svc.settled();
    expect(await d.svc.pathOf(doc('sorted/a.pdf'))).toBe(abs);
    await d.db.run(`UPDATE shared_files SET sha256 = ? WHERE rel_path = 'a.pdf'`, [sha('two')]);
    expect(await d.svc.pathOf(doc('sorted/a.pdf'))).toBeNull();
  });

  it('a root that is not usable gives no path', async () => {
    const { d, sorted } = await live();
    const abs = path.join(sorted, 'a.pdf');
    put(abs, 'one');
    d.svc.kick();
    await d.svc.settled();
    await d.db.run(`INSERT INTO meta(key, value) VALUES('shared-folders:paused', '["sorted"]')`);
    const again = await d.restart();
    expect(again.usable('sorted')).toBe(false);
    expect(await again.pathOf(doc('sorted/a.pdf'))).toBeNull();
  });
});

it('pathOf refuses another account and hostile ids', async () => {
  const d = await device();
  await addAccount(d);
  await withRoots(d);
  expect(await d.svc.pathOf({ accountId: 'other', externalId: 'sorted/a.pdf' })).toBeNull();
  expect(await d.svc.pathOf({ accountId: 'acct-shared', externalId: 'sorted/../a.pdf' })).toBeNull();
  expect(await d.svc.pathOf({ accountId: 'acct-shared', externalId: 'elsewhere/a.pdf' })).toBeNull();
});

it('registerCapture on a copy throws SyncReadOnly', async () => {
  const d = await device('copy');
  await expect(d.svc.registerCapture('c1', 'h')).rejects.toBeInstanceOf(SyncReadOnly);
});

it('roots survive a restart', async () => {
  const d = await device();
  const roots = await withRoots(d);
  expect(d.svc.roots()).toEqual(roots);
  const again = await d.restart();
  expect(again.roots()).toEqual(roots);
});

it('mode follows the sync role', async () => {
  const d = await device('leader');
  expect(d.svc.mode()).toBe('leader');
  d.sync.set('copy');
  expect(d.svc.mode()).toBe('copy');
  d.sync.set('fenced');
  expect(d.svc.mode()).toBe('idle');
});
