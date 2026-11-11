import fs from 'fs';
import path from 'path';

import { closeDevices, device, withRoots } from './helpers/device';

afterEach(closeDevices);

const rels = async (d: Awaited<ReturnType<typeof device>>) =>
  (await d.db.all(`SELECT rel_path FROM shared_files ORDER BY rel_path`)).map((r) => String(r.rel_path));

it('the leader scans once at start and on kick', async () => {
  const fake = { events: [] as (() => void)[] };
  const d = await device('leader', {
    watch: (_root, onEvent) => {
      fake.events.push(onEvent);
      return { close: async () => {} };
    },
    debounceMs: 0,
  });
  const { sorted } = await withRoots(d);
  await d.svc.settled();
  expect(await rels(d)).toEqual([]);
  fs.writeFileSync(path.join(sorted, 'a.txt'), 'x');
  d.svc.kick();
  await d.svc.settled();
  expect(await rels(d)).toEqual(['a.txt']);
});

it('a watcher event for either root runs a scan', async () => {
  const handlers = new Map<string, () => void>();
  const d = await device('leader', {
    watch: (root, onEvent) => {
      handlers.set(root, onEvent);
      return { close: async () => {} };
    },
    debounceMs: 0,
  });
  const { incoming } = await withRoots(d);
  await d.svc.settled();
  expect([...handlers.keys()].sort()).toEqual([incoming, path.join(d.dir, 'sorted')].sort());
  fs.writeFileSync(path.join(incoming, 'b.txt'), 'x');
  handlers.get(incoming)!();
  await d.svc.settled();
  expect(await rels(d)).toEqual(['b.txt']);
});

it('a copy does not write the manifest', async () => {
  const d = await device('copy', { watch: () => ({ close: async () => {} }), debounceMs: 0 });
  const { sorted } = await withRoots(d);
  fs.writeFileSync(path.join(sorted, 'a.txt'), 'x');
  d.svc.kick();
  await d.svc.settled();
  expect(await rels(d)).toEqual([]);
});

it('a kick during a scan is not lost: a file added meanwhile is listed', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let started!: () => void;
  const running = new Promise<void>((r) => (started = r));
  const d = await device('leader', {
    watch: () => ({ close: async () => {} }),
    debounceMs: 0,
    hashFile: async (p) => {
      started();
      await gate;
      return path.basename(p);
    },
  });
  const { sorted } = await withRoots(d);
  fs.writeFileSync(path.join(sorted, 'a.txt'), 'x');
  d.svc.kick();
  await running;
  fs.writeFileSync(path.join(sorted, 'b.txt'), 'y');
  d.svc.kick();
  d.svc.kick();
  release();
  await d.svc.settled();
  expect(await rels(d)).toEqual(['a.txt', 'b.txt']);
});

it('a leader that starts with roots already set scans once at start', async () => {
  const d = await device('leader');
  const { sorted } = await withRoots(d);
  fs.writeFileSync(path.join(sorted, 'a.txt'), 'x');
  await d.svc.settled();
  await d.db.run(`DELETE FROM shared_files`);
  await d.db.run(`DELETE FROM shared_mirror`);
  const again = await d.restart();
  await again.settled();
  expect(await rels(d)).toEqual(['a.txt']);
});

it('a copy that becomes the leader scans', async () => {
  const d = await device('copy');
  const { sorted } = await withRoots(d);
  fs.writeFileSync(path.join(sorted, 'a.txt'), 'x');
  d.sync.set('leader');
  await new Promise((r) => setTimeout(r, 20));
  await d.svc.settled();
  expect(await rels(d)).toEqual(['a.txt']);
});
