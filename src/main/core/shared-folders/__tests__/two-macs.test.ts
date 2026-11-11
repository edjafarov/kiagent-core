/** Two Macs, two pairs of folders, one transport each way: what the user sees. */
import fs from 'fs';
import path from 'path';

import { closeDevices, device, withRoots, type Device } from './helpers/device';
import { copyRows, serveTransport } from './helpers/fake-transport';

afterEach(closeDevices);

interface Mac {
  d: Device;
  incoming: string;
  sorted: string;
}

async function pair(): Promise<{ a: Mac; b: Mac; sync(from: Mac, to: Mac): Promise<void>; lead(x: Mac, y: Mac): Promise<void> }> {
  const mk = async (mode: 'leader' | 'copy'): Promise<Mac> => {
    const d = await device(mode);
    return { d, ...(await withRoots(d)) };
  };
  const a = await mk('leader');
  const b = await mk('copy');
  a.d.svc.setTransport(serveTransport(b.d.svc.serve, 'Mac A'));
  b.d.svc.setTransport(serveTransport(a.d.svc.serve, 'Mac B'));
  await a.d.svc.settled();
  await b.d.svc.settled();
  return {
    a,
    b,
    // The sync service's job: the leader's rows arrive on the copy.
    sync: async (from, to) => {
      await copyRows(from.d.db, to.d.db);
      to.d.sync.applied(['shared_files']);
      await to.d.svc.settled();
    },
    lead: async (x, y) => {
      y.d.sync.set('copy');
      x.d.sync.set('leader');
      await y.d.svc.settled();
      await x.d.svc.settled();
    },
  };
}

const put = (dir: string, rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const read = (dir: string, rel: string): string | null => {
  try {
    return fs.readFileSync(path.join(dir, rel), 'utf8');
  } catch {
    return null;
  }
};
const scan = async (m: Mac): Promise<void> => {
  m.d.svc.kick();
  await m.d.svc.settled();
};
const row = async (m: Mac, rel: string) =>
  (await m.d.db.all(`SELECT * FROM shared_files WHERE rel_path = ?`, [rel]))[0];

it("the leader's files appear on the copy", async () => {
  const { a, b, sync } = await pair();
  put(a.sorted, 'Taxes/2026/bill.txt', 'the bill');
  put(a.incoming, 'scan1.jpg', 'a photo');
  await scan(a);
  await sync(a, b);
  expect(read(b.sorted, 'Taxes/2026/bill.txt')).toBe('the bill');
  expect(read(b.incoming, 'scan1.jpg')).toBe('a photo');
});

it('a file dropped on the copy reaches the leader', async () => {
  const { a, b, sync } = await pair();
  put(b.incoming, 'from-b.txt', 'dropped on B');
  await scan(b);
  expect(read(a.incoming, 'from-b.txt')).toBe('dropped on B');
  await scan(a);
  await sync(a, b);
  expect(read(b.incoming, 'from-b.txt')).toBe('dropped on B');
  expect((await row(a, 'from-b.txt'))?.deleted).toBe(0);
});

it('a deletion on the copy reaches the leader', async () => {
  const { a, b, sync } = await pair();
  put(a.sorted, 'old.txt', 'old');
  put(a.sorted, 'keep.txt', 'keep'); // an emptied folder is not believed
  await scan(a);
  await sync(a, b);
  expect(read(b.sorted, 'old.txt')).toBe('old');
  fs.rmSync(path.join(b.sorted, 'old.txt'));
  await scan(b);
  expect(read(a.sorted, 'old.txt')).toBeNull();
  expect(a.d.trashed.some((p) => p.endsWith('old.txt'))).toBe(true);
  await scan(a);
  expect((await row(a, 'old.txt'))?.deleted).toBe(1);
});

it('missing_here rows survive a lead change and are filled by the returning Mac', async () => {
  const { a, b, sync, lead } = await pair();
  put(a.sorted, 'only-on-a.txt', 'bytes only A has');
  await scan(a);
  // The rows reach B but its pass does not run: B never got the bytes.
  await copyRows(a.d.db, b.d.db);
  await lead(b, a);
  await scan(b);
  const r = await row(b, 'only-on-a.txt');
  expect(r?.missing_here).toBe(1);
  expect(r?.deleted).toBe(0);
  expect(read(b.sorted, 'only-on-a.txt')).toBeNull();
  await scan(b);
  expect((await row(b, 'only-on-a.txt'))?.missing_here).toBe(1);
  // A, a copy now, receives the rows and supplies the bytes.
  await sync(b, a);
  expect(read(b.sorted, 'only-on-a.txt')).toBe('bytes only A has');
  await scan(b);
  const filled = await row(b, 'only-on-a.txt');
  expect(filled?.missing_here).toBe(0);
  expect(filled?.deleted).toBe(0);
});

it('a file the new leader deleted is not offered back by the returning leader', async () => {
  const { a, b, sync, lead } = await pair();
  put(a.sorted, 'gone.txt', 'will be deleted');
  put(a.sorted, 'stays.txt', 'stays');
  await scan(a);
  await sync(a, b);
  await lead(b, a);
  fs.rmSync(path.join(b.sorted, 'gone.txt'));
  await scan(b);
  expect((await row(b, 'gone.txt'))?.deleted).toBe(1);
  await sync(b, a); // A, a copy, drops its copy of the file
  expect(read(a.sorted, 'gone.txt')).toBeNull();
  await lead(a, b);
  await scan(a);
  await sync(a, b);
  expect(read(a.sorted, 'gone.txt')).toBeNull();
  expect(read(b.sorted, 'gone.txt')).toBeNull();
  expect((await row(a, 'gone.txt'))?.deleted).toBe(1);
  expect(read(a.sorted, 'stays.txt')).toBe('stays');
  expect(read(b.sorted, 'stays.txt')).toBe('stays');
});

it('a same-path conflict keeps both', async () => {
  const { a, b, sync } = await pair();
  put(a.incoming, 'c.txt', 'from A');
  await scan(a);
  put(b.incoming, 'c.txt', 'from B, longer');
  await scan(b); // offered before B has seen the leader's rows
  expect(read(a.incoming, 'c.txt')).toBe('from A');
  const kept = fs.readdirSync(a.incoming).filter((n) => /^c \(from .*\)\.txt$/.test(n));
  expect(kept).toHaveLength(1);
  expect(read(a.incoming, kept[0])).toBe('from B, longer');
  await scan(a);
  await sync(a, b);
  expect(read(b.incoming, 'c.txt')).toBe('from A');
  expect(read(b.incoming, kept[0])).toBe('from B, longer');
});

it('two files with the same content at two paths both survive', async () => {
  const { a, b, sync } = await pair();
  put(a.sorted, 'one/copy.pdf', 'same bytes');
  put(a.sorted, 'two/copy.pdf', 'same bytes');
  await scan(a);
  await sync(a, b);
  expect(read(b.sorted, 'one/copy.pdf')).toBe('same bytes');
  expect(read(b.sorted, 'two/copy.pdf')).toBe('same bytes');
  put(b.incoming, 'x.png', 'twin');
  put(b.incoming, 'y.png', 'twin');
  await scan(b);
  expect(read(a.incoming, 'x.png')).toBe('twin');
  expect(read(a.incoming, 'y.png')).toBe('twin');
  await scan(a);
  expect((await row(a, 'x.png'))?.deleted).toBe(0);
  expect((await row(a, 'y.png'))?.deleted).toBe(0);
});
