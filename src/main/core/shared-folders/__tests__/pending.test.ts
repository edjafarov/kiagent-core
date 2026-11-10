import fs from 'fs';
import path from 'path';

import { mirrorPass } from '../mirror';
import { closeDevices, device, withRoots, type Device } from './helpers/device';
import { serveTransport, sha, stubServe, tmpDir } from './helpers/fake-transport';

afterEach(closeDevices);

const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const scan = async (d: Device) => {
  d.svc.kick();
  await d.svc.settled();
};
const pending = async (d: Device) =>
  (await d.db.all(`SELECT kind, root, rel_path, capture_id FROM shared_pending ORDER BY id`)) as unknown as {
    kind: string; root: string; rel_path: string; capture_id: string | null;
  }[];
const live = async (d: Device, root: string) =>
  (await d.db.all(`SELECT rel_path, deleted FROM shared_files WHERE root = ? ORDER BY rel_path`, [root])) as unknown as {
    rel_path: string; deleted: number;
  }[];
const captureOf = async (d: Device, root: string, rel: string) => {
  const row = (await d.db.all(`SELECT capture_id FROM shared_mirror WHERE root = ? AND rel_path = ?`, [root, rel]))[0];
  return row ? row.capture_id : 'NO ENTRY';
};
async function leader() {
  const d = await device('leader');
  const roots = await withRoots(d);
  await d.svc.settled();
  return { d, ...roots };
}

describe('moves and removals are remembered until the scan that commits them', () => {
  it('sorting the last Incoming file, a restart before the scan: the Incoming row is tombstoned', async () => {
    const { d, incoming, sorted } = await leader();
    write(path.join(incoming, 'in.pdf'), 'scan');
    await scan(d);
    d.sync.set('copy'); // nothing scans while the Mac is not the leader
    fs.mkdirSync(path.join(sorted, 'tax'));
    fs.renameSync(path.join(incoming, 'in.pdf'), path.join(sorted, 'tax', 'in.pdf'));
    await d.svc.moved(path.join(incoming, 'in.pdf'), path.join(sorted, 'tax', 'in.pdf'));
    expect(await pending(d)).toMatchObject([{ kind: 'moved', root: 'incoming', rel_path: 'in.pdf' }]);
    const again = await d.restart();
    d.sync.set('leader');
    await again.settled();
    expect(await live(d, 'incoming')).toEqual([{ rel_path: 'in.pdf', deleted: 1 }]);
    expect(await live(d, 'sorted')).toEqual([{ rel_path: 'tax/in.pdf', deleted: 0 }]);
    expect(await again.listForSorting()).toEqual([]);
    expect(await pending(d)).toEqual([]); // consumed with the tombstone
  });

  it('a scan that saw the gap before moved() was called does not forget the move', async () => {
    const { d, incoming, sorted } = await leader();
    write(path.join(incoming, 'in.pdf'), 'scan');
    await scan(d);
    fs.renameSync(path.join(incoming, 'in.pdf'), path.join(sorted, 'in.pdf'));
    await scan(d); // sees Incoming empty: paused, row kept
    expect(await live(d, 'incoming')).toEqual([{ rel_path: 'in.pdf', deleted: 0 }]);
    await d.svc.moved(path.join(incoming, 'in.pdf'), path.join(sorted, 'in.pdf'));
    await d.svc.settled();
    expect(await live(d, 'incoming')).toEqual([{ rel_path: 'in.pdf', deleted: 1 }]);
    expect(await d.svc.listForSorting()).toEqual([]);
    expect(await pending(d)).toEqual([]);
  });

  it('a mirrored removal served to another Mac is remembered the same way', async () => {
    const { d, sorted } = await leader();
    write(path.join(sorted, 'a.txt'), 'one');
    await scan(d);
    d.sync.set('copy');
    d.sync.set('leader'); // a role flap: the queue and the pass restart
    expect(await d.svc.serve.remove({ root: 'sorted', relPath: 'a.txt', sha256: sha('one') })).toBe(true);
    await d.svc.settled();
    expect(await live(d, 'sorted')).toEqual([{ rel_path: 'a.txt', deleted: 1 }]);
    expect(await pending(d)).toEqual([]);
  });
});

describe('capture notes outlive the scan', () => {
  it('a note for a file the scan has not listed yet is stored and attached when it is', async () => {
    const { d, incoming } = await leader();
    const abs = path.join(incoming, 'scan.pdf');
    write(abs, 'bytes');
    expect(await d.svc.noteCapture('c1', abs, sha('bytes'))).toBe(true);
    expect(await pending(d)).toMatchObject([{ kind: 'note', root: 'incoming', rel_path: 'scan.pdf', capture_id: 'c1' }]);
    d.sync.set('copy'); // the Mac quits before it lists the scan
    const again = await d.restart();
    d.sync.set('leader');
    await again.settled();
    expect(await captureOf(d, 'incoming', 'scan.pdf')).toBe('c1');
    expect(await pending(d)).toEqual([]);
  });

  it('a note is bound to its path: the same bytes elsewhere are an ordinary file', async () => {
    const { d, incoming } = await leader();
    write(path.join(incoming, 'scan.pdf'), 'bytes');
    write(path.join(incoming, 'user-copy.pdf'), 'bytes');
    await d.svc.noteCapture('c1', path.join(incoming, 'scan.pdf'), sha('bytes'));
    await scan(d);
    expect(await captureOf(d, 'incoming', 'scan.pdf')).toBe('c1');
    expect(await captureOf(d, 'incoming', 'user-copy.pdf')).toBeNull();
  });

  it('noteCapture refuses a path outside the roots', async () => {
    const { d, incoming } = await leader();
    expect(await d.svc.noteCapture('c1', path.join(d.dir, 'elsewhere.pdf'), sha('x'))).toBe(false);
    expect(await d.svc.noteCapture('c1', path.join(incoming, '.kia-sync', 'x'), sha('x'))).toBe(false);
    expect(await pending(d)).toEqual([]);
  });

  it('a copy offers a scan it filed itself with the capture id, and the leader answers have-it', async () => {
    const lead = await leader();
    write(path.join(lead.sorted, 'filed', 'scan.pdf'), 'bytes');
    await scan(lead.d);
    await lead.d.svc.registerCapture('c1', sha('bytes'));
    const copy = await device('copy');
    const mine = await withRoots(copy);
    const abs = path.join(mine.incoming, 'scan.pdf');
    write(abs, 'bytes');
    expect(await copy.svc.noteCapture('c1', abs, sha('bytes'))).toBe(true); // no mirror entry yet
    const t = serveTransport(lead.d.svc.serve);
    await mirrorPass({ ...copy.deps, roots: copy.svc.roots() }, t);
    expect(fs.existsSync(abs)).toBe(false); // answered have-it: moved to the Trash
    expect(copy.trashed).toEqual([abs]);
    expect(await pending(copy)).toEqual([]);
    expect(await live(lead.d, 'incoming')).toEqual([]); // and it did not become a second file on the leader
  });

  it('the capture id travels with an offer that the leader writes', async () => {
    const copy = await device('copy');
    const mine = await withRoots(copy);
    const abs = path.join(mine.incoming, 'scan.pdf');
    write(abs, 'bytes');
    await copy.svc.noteCapture('c1', abs, sha('bytes'));
    const lead = { incoming: path.join(tmpDir(), 'i'), sorted: path.join(tmpDir(), 's') };
    const serve = stubServe(lead, () => 'written');
    await mirrorPass({ ...copy.deps, roots: copy.svc.roots() }, serveTransport(serve));
    expect(serve.offers).toMatchObject([{ relPath: 'scan.pdf', captureId: 'c1' }]);
    expect(await captureOf(copy, 'incoming', 'scan.pdf')).toBe('c1');
    expect(await pending(copy)).toEqual([]);
  });
});

describe('the table', () => {
  it('is local, and a factory reset clears it', async () => {
    const { COPIED_CORE_TABLES, LOCAL_CORE_TABLES } = await import('../../sync/tables');
    expect(LOCAL_CORE_TABLES).toContain('shared_pending');
    expect(COPIED_CORE_TABLES).not.toContain('shared_pending');
  });
});
