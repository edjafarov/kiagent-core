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

it('pathOf is the inverse of resolve, and null when the root is unset', async () => {
  const d = await device();
  await addAccount(d);
  const { sorted } = await withRoots(d);
  const abs = path.join(sorted, 'tax', '2025.pdf');
  const ref = (await d.svc.resolve(abs))!;
  expect(await d.svc.pathOf(ref)).toBe(abs);
  await d.svc.setRoots({ incoming: null, sorted: null });
  expect(await d.svc.pathOf(ref)).toBeNull();
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
