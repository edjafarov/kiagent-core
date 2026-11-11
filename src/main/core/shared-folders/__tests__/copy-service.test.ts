import fs from 'fs';
import path from 'path';

import { closeDevices, device, withRoots } from './helpers/device';
import { sha, stubServe, serveTransport, tmpDir } from './helpers/fake-transport';

afterEach(closeDevices);

const leaderFolder = () => {
  const lead = { incoming: path.join(tmpDir(), 'i'), sorted: path.join(tmpDir(), 's') };
  fs.mkdirSync(lead.incoming, { recursive: true });
  fs.mkdirSync(lead.sorted, { recursive: true });
  return lead;
};
const rowFor = (d: Awaited<ReturnType<typeof device>>, rel: string, text: string) =>
  d.db.run(
    `INSERT OR REPLACE INTO shared_files(root, rel_path, sha256, bytes, mtime, missing_here, deleted, parked, rev)
     VALUES('sorted', ?, ?, ?, '2026-01-02T03:04:05.000Z', 0, 0, 0, 1)`,
    [rel, sha(text), Buffer.byteLength(text)],
  );

it('a copy with a transport mirrors on kick; without one it does nothing', async () => {
  const d = await device('copy');
  const { sorted } = await withRoots(d);
  const lead = leaderFolder();
  fs.writeFileSync(path.join(lead.sorted, 'a.txt'), 'one');
  await rowFor(d, 'a.txt', 'one');
  d.svc.kick();
  await d.svc.settled();
  expect(fs.existsSync(path.join(sorted, 'a.txt'))).toBe(false);
  d.svc.setTransport(serveTransport(stubServe(lead)));
  await d.svc.settled();
  expect(fs.readFileSync(path.join(sorted, 'a.txt'), 'utf8')).toBe('one');
});

it('rows applied from the leader start a pass; other tables do not', async () => {
  const d = await device('copy');
  const { sorted } = await withRoots(d);
  const lead = leaderFolder();
  const t = serveTransport(stubServe(lead));
  d.svc.setTransport(t);
  await d.svc.settled();
  fs.writeFileSync(path.join(lead.sorted, 'a.txt'), 'one');
  await rowFor(d, 'a.txt', 'one');
  d.sync.applied(['documents']);
  await d.svc.settled();
  expect(t.calls).toEqual([]);
  d.sync.applied(['documents', 'shared_files']);
  await d.svc.settled();
  expect(fs.readFileSync(path.join(sorted, 'a.txt'), 'utf8')).toBe('one');
});

it('a device that is still joining is skipped until the join completes', async () => {
  const d = await device('copy', { retryMs: 20 });
  const { sorted } = await withRoots(d);
  const lead = leaderFolder();
  fs.writeFileSync(path.join(lead.sorted, 'a.txt'), 'one');
  await rowFor(d, 'a.txt', 'one');
  await d.db.run(`UPDATE sync_state SET joining = 1`);
  const t = serveTransport(stubServe(lead));
  d.svc.setTransport(t);
  d.svc.kick();
  await d.svc.settled();
  expect(t.calls).toEqual([]);
  await d.db.run(`UPDATE sync_state SET joining = 0`);
  await new Promise((r) => setTimeout(r, 120)); // the retry timer finds out
  await d.svc.settled();
  expect(fs.readFileSync(path.join(sorted, 'a.txt'), 'utf8')).toBe('one');
});

it('a failed transport is retried by the timer', async () => {
  const d = await device('copy', { retryMs: 20 });
  const { sorted } = await withRoots(d);
  const lead = leaderFolder();
  fs.writeFileSync(path.join(lead.sorted, 'a.txt'), 'one');
  await rowFor(d, 'a.txt', 'one');
  const t = serveTransport(stubServe(lead));
  t.fail = true;
  d.svc.setTransport(t);
  await d.svc.settled();
  expect(fs.existsSync(path.join(sorted, 'a.txt'))).toBe(false);
  t.fail = false;
  await new Promise((r) => setTimeout(r, 120));
  await d.svc.settled();
  expect(fs.readFileSync(path.join(sorted, 'a.txt'), 'utf8')).toBe('one');
});

it('a kick during a pass queues exactly one more pass', async () => {
  const d = await device('copy');
  await withRoots(d);
  const lead = leaderFolder();
  await rowFor(d, 'a.txt', 'never on the leader'); // every pass asks once and is told 'gone'
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let asked = 0;
  d.svc.setTransport({
    fetch: async () => {
      asked += 1;
      if (asked === 1) await gate;
      return 'gone';
    },
    offer: async () => 'written',
    remove: async () => {},
  });
  await new Promise((r) => setTimeout(r, 30));
  expect(asked).toBe(1);
  d.svc.kick();
  d.svc.kick();
  d.svc.kick();
  release();
  await d.svc.settled();
  expect(asked).toBe(2);
  void lead;
});

it('a leader does not mirror', async () => {
  const d = await device('leader');
  await withRoots(d);
  const lead = leaderFolder();
  await rowFor(d, 'a.txt', 'one');
  fs.writeFileSync(path.join(lead.sorted, 'a.txt'), 'one');
  const t = serveTransport(stubServe(lead));
  d.svc.setTransport(t);
  d.svc.kick();
  await d.svc.settled();
  expect(t.calls).toEqual([]);
});
