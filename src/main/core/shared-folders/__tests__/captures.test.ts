import fs from 'fs';
import path from 'path';

import { closeDevices, device, withRoots, type Device } from './helpers/device';
import { sha } from './helpers/fake-transport';

afterEach(closeDevices);

const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const scan = async (d: Device) => {
  d.svc.kick();
  await d.svc.settled();
};
const captureOf = async (d: Device, root: string, rel: string) => {
  const row = (await d.db.all(`SELECT capture_id FROM shared_mirror WHERE root = ? AND rel_path = ?`, [root, rel]))[0];
  return row ? row.capture_id : 'NO ENTRY';
};
async function leader() {
  const d = await device('leader');
  const roots = await withRoots(d);
  await d.svc.settled();
  await d.db.run(
    `INSERT INTO accounts(id, source, identifier, config, status, created_at)
     VALUES('acct-shared', 'shared-folder', 'shared', '{}', 'connecting', 'now')`,
  );
  return { d, ...roots };
}

describe('registerCapture and noteCapture', () => {
  it('a re-filed capture may carry new bytes', async () => {
    const { d } = await leader();
    await d.svc.registerCapture('c', 'h1');
    await d.svc.registerCapture('c', 'h2');
    expect(await d.db.all(`SELECT capture_id, sha256 FROM shared_capture_files`)).toEqual([{ capture_id: 'c', sha256: 'h2' }]);
  });

  it('noteCapture sets the note when the entry has that hash; false otherwise', async () => {
    const { d, incoming } = await leader();
    write(path.join(incoming, 'scan.pdf'), 'bytes');
    await scan(d);
    const abs = path.join(incoming, 'scan.pdf');
    expect(await d.svc.noteCapture('c1', abs, sha('other'))).toBe(false);
    expect(await captureOf(d, 'incoming', 'scan.pdf')).toBeNull();
    expect(await d.svc.noteCapture('c1', abs, sha('bytes'))).toBe(true);
    expect(await captureOf(d, 'incoming', 'scan.pdf')).toBe('c1');
    expect(await d.svc.noteCapture('c1', path.join(incoming, 'none.pdf'), sha('bytes'))).toBe(false);
    expect(await d.svc.noteCapture('c1', path.join(d.dir, 'elsewhere.pdf'), sha('bytes'))).toBe(false);
    expect(await d.svc.noteCapture('c1', path.join(incoming, '.kia-sync', 'x'), sha('bytes'))).toBe(false);
  });
});

describe('moved', () => {
  it('carries the note across roots (sorting moves a scan from Incoming to Sorted)', async () => {
    const { d, incoming, sorted } = await leader();
    write(path.join(incoming, 'scan.pdf'), 'bytes');
    await scan(d);
    await d.svc.noteCapture('c1', path.join(incoming, 'scan.pdf'), sha('bytes'));
    fs.mkdirSync(path.join(sorted, 'Tax'), { recursive: true });
    fs.renameSync(path.join(incoming, 'scan.pdf'), path.join(sorted, 'Tax', 'scan.pdf'));
    await d.svc.moved(path.join(incoming, 'scan.pdf'), path.join(sorted, 'Tax', 'scan.pdf'));
    await d.svc.settled();
    expect(await captureOf(d, 'sorted', 'Tax/scan.pdf')).toBe('c1');
    expect(await captureOf(d, 'incoming', 'scan.pdf')).toBe('NO ENTRY');
  });

  it('kicks a scan: the manifest follows without another kick', async () => {
    const { d, incoming, sorted } = await leader();
    write(path.join(incoming, 'a.pdf'), 'bytes');
    await scan(d);
    fs.renameSync(path.join(incoming, 'a.pdf'), path.join(sorted, 'a.pdf'));
    await d.svc.moved(path.join(incoming, 'a.pdf'), path.join(sorted, 'a.pdf'));
    await d.svc.settled();
    expect(await d.db.all(`SELECT root, deleted FROM shared_files ORDER BY root`)).toEqual([
      { root: 'incoming', deleted: 1 },
      { root: 'sorted', deleted: 0 },
    ]);
  });

  it('the note reaches an entry the scan had already written', async () => {
    const { d, incoming, sorted } = await leader();
    write(path.join(incoming, 'a.pdf'), 'bytes');
    await scan(d);
    await d.svc.noteCapture('c1', path.join(incoming, 'a.pdf'), sha('bytes'));
    fs.renameSync(path.join(incoming, 'a.pdf'), path.join(sorted, 'a.pdf'));
    // the sorted scan runs first and lists the file; the move is reported after
    await d.svc.setRoots({ incoming: null, sorted });
    await d.svc.settled();
    await d.svc.setRoots({ incoming, sorted });
    await d.svc.settled();
    await d.svc.moved(path.join(incoming, 'a.pdf'), path.join(sorted, 'a.pdf'));
    await d.svc.settled();
    expect(await captureOf(d, 'sorted', 'a.pdf')).toBe('c1');
  });

  it('a file without a note moves without one', async () => {
    const { d, incoming, sorted } = await leader();
    write(path.join(incoming, 'a.pdf'), 'bytes');
    await scan(d);
    fs.renameSync(path.join(incoming, 'a.pdf'), path.join(sorted, 'a.pdf'));
    await d.svc.moved(path.join(incoming, 'a.pdf'), path.join(sorted, 'a.pdf'));
    await d.svc.settled();
    expect(await captureOf(d, 'sorted', 'a.pdf')).toBeNull();
  });

  it('a note does not jump to a different file with other bytes', async () => {
    const { d, incoming, sorted } = await leader();
    write(path.join(incoming, 'a.pdf'), 'bytes');
    await scan(d);
    await d.svc.noteCapture('c1', path.join(incoming, 'a.pdf'), sha('bytes'));
    fs.rmSync(path.join(incoming, 'a.pdf'));
    write(path.join(sorted, 'b.pdf'), 'different bytes');
    await d.svc.moved(path.join(incoming, 'a.pdf'), path.join(sorted, 'b.pdf'));
    await d.svc.settled();
    expect(await captureOf(d, 'sorted', 'b.pdf')).toBeNull();
  });
});

describe('fileOfCapture', () => {
  it('finds the file of a registered capture, in Incoming or where sorting put it', async () => {
    const { d, incoming, sorted } = await leader();
    write(path.join(incoming, 'a.pdf'), 'bytes');
    await scan(d);
    await d.svc.registerCapture('c1', sha('bytes'));
    expect(await d.svc.fileOfCapture('c1')).toEqual({
      ref: { accountId: 'acct-shared', externalId: 'incoming/a.pdf', root: 'incoming', relPath: 'a.pdf' },
      absPath: path.join(incoming, 'a.pdf'),
      missingHere: false,
    });
    fs.mkdirSync(path.join(sorted, 'Tax'));
    fs.renameSync(path.join(incoming, 'a.pdf'), path.join(sorted, 'Tax', 'a.pdf'));
    await scan(d);
    expect(await d.svc.fileOfCapture('c1')).toMatchObject({
      ref: { externalId: 'sorted/Tax/a.pdf' },
      absPath: path.join(sorted, 'Tax', 'a.pdf'),
    });
  });

  it('is null for an unregistered capture, and for one with no live row', async () => {
    const { d, incoming } = await leader();
    write(path.join(incoming, 'a.pdf'), 'bytes');
    write(path.join(incoming, 'keep.pdf'), 'k');
    await scan(d);
    expect(await d.svc.fileOfCapture('nope')).toBeNull();
    await d.svc.registerCapture('c1', sha('bytes'));
    fs.rmSync(path.join(incoming, 'a.pdf'));
    await scan(d);
    expect(await d.svc.fileOfCapture('c1')).toBeNull();
  });

  it('prefers a row whose bytes are here; a missing_here row has no path', async () => {
    const { d, incoming, sorted } = await leader();
    await d.svc.registerCapture('c1', sha('bytes'));
    await d.db.run(
      `INSERT INTO shared_files(root, rel_path, sha256, bytes, mtime, missing_here, deleted, parked, rev)
       VALUES('incoming','gone.pdf',?,5,'t',1,0,0,99999)`,
      [sha('bytes')],
    );
    expect(await d.svc.fileOfCapture('c1')).toMatchObject({
      ref: { externalId: 'incoming/gone.pdf' },
      absPath: null,
      missingHere: true,
    });
    await d.db.run(
      `INSERT INTO shared_files(root, rel_path, sha256, bytes, mtime, missing_here, deleted, parked, rev)
       VALUES('sorted','here.pdf',?,5,'t',0,0,0,1)`,
      [sha('bytes')],
    ); // older than the missing_here row, but its bytes are here
    expect(await d.svc.fileOfCapture('c1')).toMatchObject({
      ref: { externalId: 'sorted/here.pdf' },
      absPath: path.join(sorted, 'here.pdf'),
      missingHere: false,
    });
    void incoming;
  });

  it('a root that is not set gives no path', async () => {
    const { d, sorted } = await leader();
    write(path.join(sorted, 'here.pdf'), 'bytes');
    await scan(d);
    await d.svc.registerCapture('c1', sha('bytes'));
    await d.svc.setRoots({ incoming: null, sorted: null });
    expect(await d.svc.fileOfCapture('c1')).toMatchObject({ absPath: null, missingHere: false });
  });
});

describe('onChange', () => {
  it('fires after a pass that changed the manifest, not after one that did not', async () => {
    const { d, sorted } = await leader();
    let n = 0;
    d.svc.onChange(() => void (n += 1));
    await scan(d);
    expect(n).toBe(0);
    write(path.join(sorted, 'a.pdf'), 'x');
    await scan(d);
    expect(n).toBe(1);
    await scan(d);
    expect(n).toBe(1);
  });

  it('fires when a promotion reconcile finishes, and stops after unsubscribe', async () => {
    const d = await device('copy');
    await withRoots(d);
    let n = 0;
    const off = d.svc.onChange(() => void (n += 1));
    d.sync.set('leader');
    await new Promise((r) => setTimeout(r, 20));
    await d.svc.settled();
    expect(n).toBe(1);
    off();
    d.sync.set('copy');
    d.sync.set('leader');
    await new Promise((r) => setTimeout(r, 20));
    await d.svc.settled();
    expect(n).toBe(1);
  });

  it('a listener that throws does not stop the others or the pass', async () => {
    const { d, sorted } = await leader();
    let ok = 0;
    d.svc.onChange(() => {
      throw new Error('boom');
    });
    d.svc.onChange(() => void (ok += 1));
    write(path.join(sorted, 'a.pdf'), 'x');
    await scan(d);
    expect(ok).toBe(1);
  });
});
