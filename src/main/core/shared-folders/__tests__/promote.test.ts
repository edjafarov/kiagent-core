import { createHash } from 'node:crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { reconcileAtPromotion } from '../promote';
import { closeDevices, device, withRoots, type Device } from './helpers/device';

afterEach(closeDevices);

const sha = (t: string) => createHash('sha256').update(t).digest('hex');
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
type Row = { rel_path: string; sha256: string; missing_here: number; deleted: number; parked: number; rev: number };
const rows = async (d: Device, root = 'incoming') =>
  (await d.db.all(
    `SELECT rel_path, sha256, missing_here, deleted, parked, rev FROM shared_files WHERE root = ? ORDER BY rel_path`,
    [root],
  )) as unknown as Row[];
const mirror = async (d: Device, root = 'incoming') =>
  (await d.db.all(`SELECT rel_path, sha256 FROM shared_mirror WHERE root = ? ORDER BY rel_path`, [root])) as {
    rel_path: string; sha256: string;
  }[];
const putRow = (d: Device, rel: string, text: string, o: Partial<{ deleted: number; missing: number; parked: number; rev: number; root: string }> = {}) =>
  d.db.run(
    `INSERT INTO shared_files(root, rel_path, sha256, bytes, mtime, missing_here, deleted, parked, rev)
     VALUES(?, ?, ?, ?, 't', ?, ?, ?, ?)`,
    [o.root ?? 'incoming', rel, sha(text), text.length, o.missing ?? 0, o.deleted ?? 0, o.parked ?? 0, o.rev ?? 3],
  );
const putMirror = (d: Device, rel: string, text: string, root = 'incoming') =>
  d.db.run(`INSERT INTO shared_mirror(root, rel_path, sha256, bytes, mtime_ms) VALUES(?, ?, ?, ?, 0)`, [
    root, rel, sha(text), text.length,
  ]);
const run = (d: Device) => reconcileAtPromotion({ ...d.deps, roots: d.svc.roots() });
const setup = async () => {
  const d = await device('copy');
  const r = await withRoots(d);
  return { d, ...r };
};

it('a row whose file is here with that hash is kept, and the mirror agrees', async () => {
  const { d, incoming } = await setup();
  write(path.join(incoming, 'a.pdf'), 'same');
  await putRow(d, 'a.pdf', 'same');
  await run(d);
  expect(await rows(d)).toMatchObject([{ rel_path: 'a.pdf', missing_here: 0, deleted: 0, rev: 3 }]);
  expect(await mirror(d)).toEqual([{ rel_path: 'a.pdf', sha256: sha('same') }]);
});

it('a row whose file was never fetched becomes missing_here', async () => {
  const { d } = await setup();
  await putRow(d, 'gone.pdf', 'bytes');
  await run(d);
  const [r] = await rows(d);
  expect(r).toMatchObject({ missing_here: 1, deleted: 0, sha256: sha('bytes') });
  expect(r.rev).toBeGreaterThan(3);
});

it('an older version is neither published nor sorted, and its file stays (Review Focus 1)', async () => {
  const { d, incoming } = await setup();
  const f = path.join(incoming, 'a.pdf');
  write(f, 'old');
  await putMirror(d, 'a.pdf', 'old');
  await putRow(d, 'a.pdf', 'new');
  await run(d);
  expect(fs.readFileSync(f, 'utf8')).toBe('old');
  expect(await rows(d)).toMatchObject([{ sha256: sha('new'), missing_here: 1 }]);
  expect(await mirror(d)).toEqual([{ rel_path: 'a.pdf', sha256: sha('old') }]);
  d.sync.set('leader');
  expect(await d.svc.listForSorting()).toEqual([]);
  await d.svc.settled();
  expect(await rows(d)).toMatchObject([{ sha256: sha('new'), missing_here: 1 }]);
});

it('a tombstone whose file is unchanged sends the file to the Trash', async () => {
  const { d, incoming } = await setup();
  const f = path.join(incoming, 'a.pdf');
  write(f, 'bye');
  await putMirror(d, 'a.pdf', 'bye');
  await putRow(d, 'a.pdf', 'bye', { deleted: 1 });
  await run(d);
  expect(d.trashed).toEqual([f]);
  expect(await mirror(d)).toEqual([]);
  expect(await rows(d)).toMatchObject([{ deleted: 1 }]);
});

it('a tombstone for a version this Mac missed still removes the unchanged file', async () => {
  const { d, incoming } = await setup();
  write(path.join(incoming, 'a.pdf'), 'v1');
  await putMirror(d, 'a.pdf', 'v1');
  await putRow(d, 'a.pdf', 'v2', { deleted: 1 });
  await run(d);
  expect(d.trashed).toHaveLength(1);
});

it('a file changed here and never offered becomes the leader file', async () => {
  const { d, incoming } = await setup();
  write(path.join(incoming, 'a.pdf'), 'mine');
  await putMirror(d, 'a.pdf', 'theirs');
  await putRow(d, 'a.pdf', 'theirs', { rev: 3 });
  await run(d);
  const [r] = await rows(d);
  expect(r).toMatchObject({ sha256: sha('mine'), missing_here: 0, deleted: 0 });
  expect(r.rev).toBeGreaterThan(3);
  expect(await mirror(d)).toEqual([{ rel_path: 'a.pdf', sha256: sha('mine') }]);
});

it('a file with no row and no mirror entry is written into the manifest, not parked', async () => {
  const { d, incoming } = await setup();
  write(path.join(incoming, 'new', 'b.pdf'), 'fresh');
  await run(d);
  expect(await rows(d)).toMatchObject([{ rel_path: 'new/b.pdf', sha256: sha('fresh'), parked: 0, missing_here: 0 }]);
  expect(await mirror(d)).toEqual([{ rel_path: 'new/b.pdf', sha256: sha('fresh') }]);
});

it('a file changed here under a tombstone is not removed: it comes back', async () => {
  const { d, incoming } = await setup();
  const f = path.join(incoming, 'a.pdf');
  write(f, 'edited');
  await putMirror(d, 'a.pdf', 'orig');
  await putRow(d, 'a.pdf', 'orig', { deleted: 1 });
  await run(d);
  expect(d.trashed).toEqual([]);
  expect(await rows(d)).toMatchObject([{ deleted: 0, sha256: sha('edited') }]);
});

it('an empty mirror facing a tombstone and a file keeps the file (Review Focus 4)', async () => {
  const { d, incoming } = await setup();
  write(path.join(incoming, 'a.pdf'), 'same');
  await putRow(d, 'a.pdf', 'same', { deleted: 1 });
  await run(d);
  expect(d.trashed).toEqual([]);
  expect(await rows(d)).toMatchObject([{ deleted: 0 }]);
});

it('a parked row stays parked', async () => {
  const { d, incoming } = await setup();
  write(path.join(incoming, 'a.pdf'), 'same');
  await putRow(d, 'a.pdf', 'same', { parked: 1 });
  await run(d);
  expect(await rows(d)).toMatchObject([{ parked: 1 }]);
  d.sync.set('leader');
  expect(await d.svc.listForSorting()).toEqual([]);
  expect(await d.svc.parked(path.join(incoming, 'a.pdf'))).toBe(true);
});

it('a row whose file is here, marked missing, is filled', async () => {
  const { d, incoming } = await setup();
  write(path.join(incoming, 'a.pdf'), 'bytes');
  await putRow(d, 'a.pdf', 'bytes', { missing: 1 });
  await run(d);
  const [r] = await rows(d);
  expect(r.missing_here).toBe(0);
  expect(r.rev).toBeGreaterThan(3);
});

it('a revived tombstone keeps the parked flag of its row', async () => {
  const { d, incoming } = await setup();
  write(path.join(incoming, 'a.pdf'), 'mine');
  await putRow(d, 'a.pdf', 'theirs', { deleted: 1, parked: 1 });
  await run(d);
  expect(await rows(d)).toMatchObject([{ deleted: 0, parked: 1, sha256: sha('mine') }]);
});

it('a folder that cannot be listed does not turn its rows into missing_here', async () => {
  const { d, incoming } = await setup();
  const locked = path.join(incoming, 'locked');
  write(path.join(locked, 'a.pdf'), 'x');
  await putRow(d, 'locked/a.pdf', 'x');
  await putMirror(d, 'locked/a.pdf', 'x');
  fs.chmodSync(locked, 0o000);
  try {
    await run(d);
  } finally {
    fs.chmodSync(locked, 0o755);
  }
  expect(await rows(d)).toMatchObject([{ missing_here: 0, rev: 3 }]);
  expect(await mirror(d)).toHaveLength(1);
});

it('a root that cannot be read is left alone', async () => {
  const { d, incoming } = await setup();
  await putRow(d, 'a.pdf', 'bytes');
  await putMirror(d, 'a.pdf', 'bytes');
  fs.rmSync(incoming, { recursive: true });
  await run(d);
  expect(await rows(d)).toMatchObject([{ missing_here: 0, deleted: 0, rev: 3 }]);
  expect(await mirror(d)).toHaveLength(1);
  expect(d.trashed).toEqual([]);
});

it('listForSorting lists only live, present, unparked Incoming rows', async () => {
  const { d, incoming } = await setup();
  for (const [rel, o] of [
    ['ok.pdf', {}], ['parked.pdf', { parked: 1 }], ['dead.pdf', { deleted: 1 }], ['away.pdf', { missing: 1 }],
  ] as const) {
    if (rel !== 'away.pdf') write(path.join(incoming, rel), rel);
    await putRow(d, rel, rel, o);
    if (rel !== 'away.pdf') await putMirror(d, rel, rel);
  }
  await putRow(d, 'filed.pdf', 'x', { root: 'sorted' });
  d.sync.set('leader');
  expect(await d.svc.listForSorting()).toEqual([path.join(incoming, 'ok.pdf')]);
});

it('a copy and a fenced device list nothing for sorting', async () => {
  const { d, incoming } = await setup();
  write(path.join(incoming, 'ok.pdf'), 'x');
  await putRow(d, 'ok.pdf', 'x');
  expect(await d.svc.listForSorting()).toEqual([]);
  d.sync.set('fenced');
  expect(await d.svc.listForSorting()).toEqual([]);
});

it('a tombstone not yet applied is applied before listForSorting answers', async () => {
  const { d, incoming } = await setup();
  const f = path.join(incoming, 'dead.pdf');
  write(f, 'bye');
  await putMirror(d, 'dead.pdf', 'bye');
  await putRow(d, 'dead.pdf', 'bye', { deleted: 1 });
  write(path.join(incoming, 'ok.pdf'), 'ok');
  await putMirror(d, 'ok.pdf', 'ok');
  await putRow(d, 'ok.pdf', 'ok');
  d.sync.set('leader');
  expect(await d.svc.listForSorting()).toEqual([path.join(incoming, 'ok.pdf')]);
  expect(d.trashed).toEqual([f]);
});

it('no scan publishes before the reconcile: the first leader scan sees the settled manifest', async () => {
  const { d, incoming } = await setup();
  write(path.join(incoming, 'a.pdf'), 'old');
  await putMirror(d, 'a.pdf', 'old');
  await putRow(d, 'a.pdf', 'new');
  d.sync.set('leader');
  await d.svc.settled();
  expect(await rows(d)).toMatchObject([{ sha256: sha('new'), missing_here: 1 }]);
});

it('a restart as leader after having been a copy still reconciles', async () => {
  const { d, incoming } = await setup();
  write(path.join(incoming, 'a.pdf'), 'old');
  await putMirror(d, 'a.pdf', 'old');
  await putRow(d, 'a.pdf', 'new');
  await d.svc.close(); // the app quits as a copy ...
  d.sync.set('leader'); // ... and starts again as the leader
  const again = await d.restart();
  expect(await again.listForSorting()).toEqual([]);
  await again.settled();
  expect(await rows(d)).toMatchObject([{ sha256: sha('new'), missing_here: 1 }]);
});

it('a Mac that never was a copy has nothing to reconcile', async () => {
  const d = await device('leader');
  const { incoming } = await withRoots(d);
  await d.svc.settled();
  write(path.join(incoming, 'a.pdf'), 'x');
  d.svc.kick();
  await d.svc.settled();
  expect(await d.db.all(`SELECT 1 FROM meta WHERE key = 'shared-folders:reconcile-pending'`)).toEqual([]);
  expect(await d.svc.listForSorting()).toEqual([path.join(incoming, 'a.pdf')]);
});

describe('a root that is not there is still owed its reconcile', () => {
  const owed = async (d: Device) =>
    (await d.db.all(`SELECT value FROM meta WHERE key = 'shared-folders:reconcile-pending'`)).map((r) => r.value);

  it('an unmounted root stays owed; when it returns the rows are reconciled, not tombstoned', async () => {
    const { d, incoming } = await setup();
    await putRow(d, 'never-fetched.pdf', 'bytes');
    await putRow(d, 'kept.pdf', 'kept');
    await putRow(d, 'dead.pdf', 'bye', { deleted: 1 });
    fs.rmSync(incoming, { recursive: true });
    d.sync.set('leader');
    await d.svc.settled();
    expect(await rows(d)).toMatchObject([
      { rel_path: 'dead.pdf', deleted: 1, rev: 3 },
      { rel_path: 'kept.pdf', deleted: 0, missing_here: 0, rev: 3 },
      { rel_path: 'never-fetched.pdf', deleted: 0, missing_here: 0, rev: 3 },
    ]);
    expect(await owed(d)).toHaveLength(1);
    expect(await d.svc.listForSorting()).toEqual([]);
    // the volume comes back with a file of its own and the old tombstone's file
    write(path.join(incoming, 'dead.pdf'), 'bye');
    write(path.join(incoming, 'own.pdf'), 'own');
    write(path.join(incoming, 'kept.pdf'), 'kept');
    await putMirror(d, 'dead.pdf', 'bye');
    d.svc.kick();
    await d.svc.settled();
    expect(await rows(d)).toMatchObject([
      { rel_path: 'dead.pdf', deleted: 1 },
      { rel_path: 'kept.pdf', deleted: 0, missing_here: 0 },
      { rel_path: 'never-fetched.pdf', deleted: 0, missing_here: 1 },
      { rel_path: 'own.pdf', deleted: 0, missing_here: 0 },
    ]);
    expect(d.trashed).toEqual([path.join(incoming, 'dead.pdf')]);
    expect(await owed(d)).toEqual([]);
  });

  it('a root that reappears between the reconcile and the scan is not scanned before its reconcile', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owed-'));
    const incoming = path.join(dir, 'incoming');
    const d = await device('copy', {
      log: (_l, m) => {
        if (m.includes('reconcile is still owed')) write(path.join(incoming, 'own.pdf'), 'own');
      },
    });
    await d.svc.setRoots({ incoming, sorted: null });
    await putRow(d, 'never-fetched.pdf', 'bytes');
    d.sync.set('leader');
    await d.svc.settled();
    expect(await rows(d)).toMatchObject([{ rel_path: 'never-fetched.pdf', deleted: 0, rev: 3 }]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('an empty mount point leaves rows and mirror entries alone and stays owed', async () => {
    const { d } = await setup();
    await putRow(d, 'a.pdf', 'a');
    await putRow(d, 'b.pdf', 'b');
    await putMirror(d, 'a.pdf', 'a');
    await putMirror(d, 'b.pdf', 'b');
    d.sync.set('leader');
    await d.svc.settled();
    expect(await rows(d)).toMatchObject([
      { rel_path: 'a.pdf', missing_here: 0, deleted: 0, rev: 3 },
      { rel_path: 'b.pdf', missing_here: 0, deleted: 0, rev: 3 },
    ]);
    expect(await mirror(d)).toHaveLength(2);
    expect(await owed(d)).toHaveLength(1);
  });

  it('an unset root is owed too, and an owed root refuses serve and sorting', async () => {
    const d = await device('copy');
    const incoming = path.join(d.dir, 'incoming');
    fs.mkdirSync(incoming);
    await d.svc.setRoots({ incoming, sorted: null });
    await putRow(d, 'x.pdf', 'x', { root: 'sorted' });
    d.sync.set('leader');
    await d.svc.settled();
    expect(await owed(d)).toHaveLength(1);
    await expect(
      d.svc.serve.open({ root: 'sorted', relPath: 'x.pdf', sha256: sha('x') }),
    ).rejects.toMatchObject({ code: 'SHARED_ROOT_PAUSED', root: 'sorted', reason: 'owed' });
    await d.svc.setRoots({ incoming, sorted: path.join(d.dir, 'sorted') });
    fs.mkdirSync(path.join(d.dir, 'sorted'));
    write(path.join(d.dir, 'sorted', 'x.pdf'), 'x'); // the row's file is back
    d.svc.kick();
    await d.svc.settled();
    expect(await owed(d)).toEqual([]);
  });

  it('only a root that is owed is reconciled: the other one is scanned like any root of a leader', async () => {
    const d = await device('copy');
    const incoming = path.join(d.dir, 'incoming');
    fs.mkdirSync(incoming);
    await d.svc.setRoots({ incoming, sorted: null }); // Sorted stays unset, so it stays owed
    write(path.join(incoming, 'a.pdf'), 'a');
    write(path.join(incoming, 'b.pdf'), 'b');
    await putRow(d, 'a.pdf', 'a');
    await putRow(d, 'b.pdf', 'b');
    await putMirror(d, 'a.pdf', 'a');
    await putMirror(d, 'b.pdf', 'b');
    d.sync.set('leader');
    await d.svc.settled();
    expect(await owed(d)).toHaveLength(1); // still Sorted
    fs.rmSync(path.join(incoming, 'a.pdf')); // the user deletes a file on the leader
    d.svc.kick();
    await d.svc.settled();
    expect(await rows(d)).toMatchObject([
      { rel_path: 'a.pdf', deleted: 1, missing_here: 0 },
      { rel_path: 'b.pdf', deleted: 0 },
    ]);
  });
});

describe('a reconcile that could not finish is still owed', () => {
  const owed = async (d: Device) =>
    (await d.db.all(`SELECT value FROM meta WHERE key = 'shared-folders:reconcile-pending'`)).map((r) => r.value);

  it('a folder that cannot be listed keeps the root owed; the older file is not published when it opens', async () => {
    const { d, incoming } = await setup();
    const locked = path.join(incoming, 'locked');
    write(path.join(locked, 'a.pdf'), 'old');
    await putMirror(d, 'locked/a.pdf', 'old');
    await putRow(d, 'locked/a.pdf', 'new');
    fs.chmodSync(locked, 0o000);
    try {
      d.sync.set('leader');
      await d.svc.settled();
      expect(await owed(d)).toHaveLength(1);
      expect(d.svc.usable('incoming')).toBe(false);
      expect(await d.svc.listForSorting()).toEqual([]);
    } finally {
      fs.chmodSync(locked, 0o755);
    }
    d.svc.kick();
    await d.svc.settled();
    expect(await rows(d)).toMatchObject([{ rel_path: 'locked/a.pdf', sha256: sha('new'), missing_here: 1 }]);
    expect(fs.readFileSync(path.join(locked, 'a.pdf'), 'utf8')).toBe('old');
    expect(await owed(d)).toEqual([]);
  });

  it('a Trash that fails keeps the root owed; the tombstone is not revived and is applied on the next try', async () => {
    let failing = true;
    const d = await device('copy', {
      trash: async (p) => {
        if (failing) throw new Error('busy');
        d.trashed.push(p);
        fs.rmSync(p, { force: true });
      },
    });
    const { incoming } = await withRoots(d);
    const f = path.join(incoming, 'a.pdf');
    write(f, 'bye');
    await putMirror(d, 'a.pdf', 'bye');
    await putRow(d, 'a.pdf', 'bye', { deleted: 1 });
    d.sync.set('leader');
    await d.svc.settled();
    expect(fs.existsSync(f)).toBe(true);
    expect(await rows(d)).toMatchObject([{ rel_path: 'a.pdf', deleted: 1, rev: 3 }]);
    expect(await owed(d)).toHaveLength(1);
    expect(d.svc.usable('incoming')).toBe(false);
    failing = false;
    d.svc.kick();
    await d.svc.settled();
    expect(d.trashed).toEqual([f]);
    expect(await rows(d)).toMatchObject([{ deleted: 1 }]);
    expect(await owed(d)).toEqual([]);
  });
});
