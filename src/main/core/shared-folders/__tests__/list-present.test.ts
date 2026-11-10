import fs from 'fs';
import path from 'path';

import { closeDevices, device, withRoots, type Device } from './helpers/device';
import { sha } from './helpers/fake-transport';

afterEach(closeDevices);

const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const row = (d: Device, rel: string, text: string, o: { missing?: number; deleted?: number; parked?: number } = {}) =>
  d.db.run(
    `INSERT INTO shared_files(root, rel_path, sha256, bytes, mtime, missing_here, deleted, parked, rev)
     VALUES('incoming', ?, ?, ?, 't', ?, ?, ?, 3)`,
    [rel, sha(text), text.length, o.missing ?? 0, o.deleted ?? 0, o.parked ?? 0],
  );

async function leader() {
  const d = await device('leader');
  const roots = await withRoots(d);
  await d.svc.settled();
  return { d, ...roots };
}

it('a parked present row is listed as present, and not offered to the sorter', async () => {
  const { d, incoming } = await leader();
  write(path.join(incoming, 'free.pdf'), 'free');
  write(path.join(incoming, 'parked.pdf'), 'parked');
  await row(d, 'free.pdf', 'free');
  await row(d, 'parked.pdf', 'parked', { parked: 1 });
  expect(await d.svc.listForSorting()).toEqual([path.join(incoming, 'free.pdf')]);
  expect(await d.svc.listPresent()).toEqual([path.join(incoming, 'free.pdf'), path.join(incoming, 'parked.pdf')]);
});

it('an older version here (missing_here) and a deleted row are in neither list', async () => {
  const { d, incoming } = await leader();
  write(path.join(incoming, 'old.pdf'), 'old');
  write(path.join(incoming, 'gone.pdf'), 'gone');
  await row(d, 'old.pdf', 'new', { missing: 1, parked: 1 });
  await row(d, 'gone.pdf', 'gone', { deleted: 1, parked: 1 });
  expect(await d.svc.listForSorting()).toEqual([]);
  expect(await d.svc.listPresent()).toEqual([]);
});

it('only Incoming rows are listed', async () => {
  const { d, sorted } = await leader();
  write(path.join(sorted, 'a.pdf'), 'a');
  await d.db.run(
    `INSERT INTO shared_files(root, rel_path, sha256, bytes, mtime, missing_here, deleted, parked, rev)
     VALUES('sorted','a.pdf',?,1,'t',0,0,0,3)`,
    [sha('a')],
  );
  expect(await d.svc.listPresent()).toEqual([]);
});

it('a root that is paused gives nothing', async () => {
  const { d, incoming } = await leader();
  write(path.join(incoming, 'a.pdf'), 'a');
  await row(d, 'a.pdf', 'a', { parked: 1 });
  expect(await d.svc.listPresent()).toHaveLength(1);
  fs.rmSync(path.join(incoming, '.kia-sync'), { recursive: true });
  expect(await d.svc.listPresent()).toEqual([]);
  expect(d.svc.rootStatus('incoming')).toBe('paused-marker');
});

it('a root that is owed its reconcile gives nothing', async () => {
  const d = await device('copy');
  const { incoming } = await withRoots(d);
  write(path.join(incoming, 'a.pdf'), 'a');
  await row(d, 'a.pdf', 'a', { parked: 1 });
  const locked = path.join(incoming, 'locked');
  fs.mkdirSync(locked);
  fs.chmodSync(locked, 0o000); // the listing cannot be completed, so the reconcile stays owed
  try {
    d.sync.set('leader');
    await d.svc.settled();
    expect(d.svc.rootStatus('incoming')).toBe('owed');
    expect(await d.svc.listPresent()).toEqual([]);
  } finally {
    fs.chmodSync(locked, 0o755);
  }
});

it('a device that is not the leader lists nothing', async () => {
  const { d, incoming } = await leader();
  write(path.join(incoming, 'a.pdf'), 'a');
  await row(d, 'a.pdf', 'a');
  expect(await d.svc.listPresent()).toHaveLength(1);
  d.sync.set('fenced');
  await d.svc.settled();
  expect(await d.svc.listPresent()).toEqual([]);
});

it('a device that does not share folders yet lists nothing', async () => {
  const d = await device('leader', {}, { alone: true });
  const { incoming } = await withRoots(d);
  write(path.join(incoming, 'a.pdf'), 'a');
  await row(d, 'a.pdf', 'a');
  expect(await d.svc.listPresent()).toEqual([]);
});
