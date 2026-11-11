import fs from 'fs';
import path from 'path';

import { mirrorPass } from '../mirror';
import { scanRoot } from '../leader-scan';
import { closeDevices, device, withRoots, type Device } from './helpers/device';
import {
  serveTransport,
  sha,
  stubServe,
  tmpDir,
} from './helpers/fake-transport';

afterEach(closeDevices);

const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const rows = async (d: Device, root = 'sorted') =>
  (await d.db.all(
    `SELECT rel_path, deleted, missing_here FROM shared_files WHERE root = ? ORDER BY rel_path`,
    [root],
  )) as unknown as {
    rel_path: string;
    deleted: number;
    missing_here: number;
  }[];
const state = async (d: Device, root = 'sorted') =>
  (await rows(d, root)).map((r) => [r.rel_path, r.deleted, r.missing_here]);
const mirrorOf = async (d: Device, root = 'sorted') =>
  (
    await d.db.all(
      `SELECT rel_path FROM shared_mirror WHERE root = ? ORDER BY rel_path`,
      [root],
    )
  ).map((r) => String(r.rel_path));
const scan = async (d: Device) => {
  d.svc.kick();
  await d.svc.settled();
};
const markerOf = (root: string) => path.join(root, '.kia-sync', 'root');

/** What an unmounted volume leaves behind: the mount point, empty. */
const unmount = (root: string) => {
  for (const f of fs.readdirSync(root))
    fs.rmSync(path.join(root, f), { recursive: true });
};
/** The volume is mounted again: its files, marker included, are back. */
const remount = (
  root: string,
  marker: string,
  files: Record<string, string> = {},
) => {
  write(markerOf(root), marker);
  for (const [rel, text] of Object.entries(files))
    write(path.join(root, rel), text);
};

/** A leader whose Sorted folder holds a.txt and b.txt, scanned. */
async function populated() {
  const d = await device('leader');
  const { sorted, incoming } = await withRoots(d);
  write(path.join(sorted, 'a.txt'), 'one');
  write(path.join(sorted, 'b.txt'), 'two');
  await scan(d);
  return {
    d,
    sorted,
    incoming,
    marker: fs.readFileSync(markerOf(sorted), 'utf8'),
  };
}

/** A copy that agrees with a leader on a.txt and b.txt in Sorted. */
async function agreed() {
  const c = await device('copy');
  const { sorted, incoming } = await withRoots(c);
  for (const [rel, t] of [
    ['a.txt', 'one'],
    ['b.txt', 'two'],
  ] as const) {
    write(path.join(sorted, rel), t);
    await c.db.run(
      `INSERT INTO shared_files(root, rel_path, sha256, bytes, mtime, rev) VALUES('sorted', ?, ?, ?, 't', 3)`,
      [rel, sha(t), t.length],
    );
    const st = fs.statSync(path.join(sorted, rel));
    await c.db.run(
      `INSERT INTO shared_mirror(root, rel_path, sha256, bytes, mtime_ms) VALUES('sorted', ?, ?, ?, ?)`,
      [rel, sha(t), t.length, Math.floor(st.mtimeMs)],
    );
  }
  const lead = {
    incoming: path.join(tmpDir(), 'incoming'),
    sorted: path.join(tmpDir(), 'sorted'),
  };
  fs.mkdirSync(lead.incoming, { recursive: true });
  fs.mkdirSync(lead.sorted, { recursive: true });
  const serve = stubServe(lead);
  const t = serveTransport(serve);
  const run = () => mirrorPass({ ...c.deps, roots: c.svc.roots() }, t);
  return {
    c,
    sorted,
    incoming,
    lead,
    serve,
    t,
    run,
    marker: fs.readFileSync(markerOf(sorted), 'utf8'),
  };
}

describe('the marker', () => {
  it('is written into each root once, when setRoots first names it; the id is kept in the database', async () => {
    const d = await device('leader');
    const { sorted } = await withRoots(d);
    const id = fs.readFileSync(markerOf(sorted), 'utf8');
    expect(id.trim()).not.toBe('');
    expect(d.svc.rootStatus('sorted')).toBe('ok');
    expect(
      JSON.stringify(
        await d.db.all(
          `SELECT value FROM meta WHERE key = 'shared-folders:initialised'`,
        ),
      ),
    ).toContain(id.trim());
    await d.svc.setRoots(d.svc.roots()); // again: the same marker
    await scan(d);
    expect(fs.readFileSync(markerOf(sorted), 'utf8')).toBe(id);
  });

  it('is not written for a folder that is not there: it stays uninitialised and paused, and is written once the folder exists', async () => {
    const d = await device('leader');
    const sorted = path.join(d.dir, 'later');
    await d.svc.setRoots({ incoming: null, sorted });
    expect(fs.existsSync(sorted)).toBe(false);
    expect(d.svc.rootStatus('sorted')).toBe('paused-missing');
    fs.mkdirSync(sorted);
    await scan(d); // the next kick tries again
    expect(fs.existsSync(markerOf(sorted))).toBe(true);
    expect(d.svc.rootStatus('sorted')).toBe('ok');
  });

  it('is never recreated by a scan, a mirror pass or a request served', async () => {
    const { d, sorted } = await populated();
    unmount(sorted);
    await scan(d);
    await scan(d);
    await expect(d.svc.serve.stagingFile('sorted')).rejects.toMatchObject({
      code: 'SHARED_ROOT_PAUSED',
    });
    expect(fs.readdirSync(sorted)).toEqual([]);
    const { c, sorted: cs, run } = await agreed();
    unmount(cs);
    await run();
    await run();
    expect(fs.readdirSync(cs)).toEqual([]);
  });
});

describe('a folder the user empties by hand', () => {
  it('deleting the last file in Incoming tombstones it, and Incoming keeps working', async () => {
    const d = await device('leader');
    const { incoming } = await withRoots(d);
    write(path.join(incoming, 'only.pdf'), 'scan');
    await scan(d);
    fs.rmSync(path.join(incoming, 'only.pdf'));
    await scan(d);
    expect(await state(d, 'incoming')).toEqual([['only.pdf', 1, 0]]);
    expect(d.svc.usable('incoming')).toBe(true);
    // an offer from another Mac is accepted into it
    const tmp = await d.svc.serve.stagingFile('incoming');
    write(tmp, 'phone');
    expect(
      await d.svc.serve.offer(
        {
          root: 'incoming',
          relPath: 'p.pdf',
          sha256: sha('phone'),
          base: null,
          captureId: null,
        },
        tmp,
        'Air',
      ),
    ).toBe('written');
    // and a new file is listed
    write(path.join(incoming, 'new.pdf'), 'fresh');
    await scan(d);
    expect((await state(d, 'incoming')).map((r) => r[0])).toEqual([
      'new.pdf',
      'only.pdf',
      'p.pdf',
    ]);
    expect(await d.svc.listForSorting()).toEqual([
      path.join(incoming, 'new.pdf'),
      path.join(incoming, 'p.pdf'),
    ]);
  });

  it('on a copy the deletions are sent', async () => {
    const { c, sorted, serve, run } = await agreed();
    fs.rmSync(path.join(sorted, 'a.txt'));
    fs.rmSync(path.join(sorted, 'b.txt'));
    await run();
    expect(serve.removed.map((q) => q.relPath).sort()).toEqual([
      'a.txt',
      'b.txt',
    ]);
    expect(await mirrorOf(c)).toEqual([]);
    expect(c.svc.usable('sorted')).toBe(false); // a copy is owed its reconcile, as always: not a pause
    expect(c.svc.rootStatus('sorted')).toBe('owed');
  });
});

describe('a root that is not really here is paused', () => {
  it('an empty mount point on the leader: no tombstones; the pause shows and holds with every row deleted', async () => {
    const { d, sorted } = await populated();
    unmount(sorted);
    await scan(d);
    expect(await state(d)).toEqual([
      ['a.txt', 0, 0],
      ['b.txt', 0, 0],
    ]);
    expect(d.svc.rootStatus('sorted')).toBe('paused-marker');
    expect(d.svc.usable('sorted')).toBe(false);
    expect(await mirrorOf(d)).toEqual(['a.txt', 'b.txt']);
  });

  it('a paused root with zero live rows stays paused', async () => {
    const { d, sorted } = await populated();
    fs.rmSync(path.join(sorted, 'a.txt'));
    fs.rmSync(path.join(sorted, 'b.txt'));
    await scan(d);
    expect(await state(d)).toEqual([
      ['a.txt', 1, 0],
      ['b.txt', 1, 0],
    ]);
    unmount(sorted);
    await scan(d);
    expect(d.svc.rootStatus('sorted')).toBe('paused-marker');
    write(path.join(sorted, 'x.txt'), 'x'); // a stray file does not release it
    await scan(d);
    expect(d.svc.rootStatus('sorted')).toBe('paused-marker');
    expect(await state(d)).toEqual([
      ['a.txt', 1, 0],
      ['b.txt', 1, 0],
    ]);
  });

  it('a marker with another id pauses the root', async () => {
    const { d, sorted } = await populated();
    write(markerOf(sorted), 'somebody-elses-folder');
    fs.rmSync(path.join(sorted, 'a.txt'));
    await scan(d);
    expect(d.svc.rootStatus('sorted')).toBe('paused-marker');
    expect(await state(d)).toEqual([
      ['a.txt', 0, 0],
      ['b.txt', 0, 0],
    ]);
  });

  it('a directory holding only a .DS_Store is paused', async () => {
    const { d, sorted } = await populated();
    unmount(sorted);
    write(path.join(sorted, '.DS_Store'), 'finder');
    await scan(d);
    expect(d.svc.rootStatus('sorted')).toBe('paused-marker');
    expect(await state(d)).toEqual([
      ['a.txt', 0, 0],
      ['b.txt', 0, 0],
    ]);
  });

  it('a missing directory is paused-missing, and a returning empty directory stays paused', async () => {
    const { d, sorted } = await populated();
    fs.rmSync(sorted, { recursive: true });
    await scan(d);
    expect(d.svc.rootStatus('sorted')).toBe('paused-missing');
    fs.mkdirSync(sorted);
    await scan(d);
    expect(d.svc.rootStatus('sorted')).toBe('paused-marker');
    expect(await state(d)).toEqual([
      ['a.txt', 0, 0],
      ['b.txt', 0, 0],
    ]);
  });

  it('the marker coming back releases it, and nothing was lost', async () => {
    const { d, sorted, marker } = await populated();
    unmount(sorted);
    await scan(d);
    expect(d.svc.usable('sorted')).toBe(false);
    remount(sorted, marker, { 'a.txt': 'one', 'b.txt': 'two' });
    await scan(d);
    expect(d.svc.rootStatus('sorted')).toBe('ok');
    expect(await state(d)).toEqual([
      ['a.txt', 0, 0],
      ['b.txt', 0, 0],
    ]);
    expect(d.trashed).toEqual([]);
  });

  it('a pause survives a restart', async () => {
    const { d, sorted } = await populated();
    unmount(sorted);
    await scan(d);
    const again = await d.restart();
    expect(again.rootStatus('sorted')).toBe('paused-marker');
    write(path.join(sorted, 'stray.txt'), 'x');
    again.kick();
    await again.settled();
    expect((await rows(d)).map((r) => r.deleted)).toEqual([0, 0]);
  });

  it('a request is refused, installs nothing and creates no staging directory', async () => {
    const { d, sorted } = await populated();
    unmount(sorted);
    const rel = {
      root: 'sorted' as const,
      relPath: 'a.txt',
      sha256: sha('one'),
    };
    await expect(d.svc.serve.stagingFile('sorted')).rejects.toMatchObject({
      code: 'SHARED_ROOT_PAUSED',
    });
    await expect(d.svc.serve.open(rel)).rejects.toMatchObject({
      code: 'SHARED_ROOT_PAUSED',
    });
    await expect(d.svc.serve.remove(rel)).rejects.toMatchObject({
      code: 'SHARED_ROOT_PAUSED',
    });
    const tmp = path.join(sorted, '.kia-sync', 'in-staged-before'); // staged before the volume went
    write(tmp, 'new bytes');
    await expect(
      d.svc.serve.offer(
        {
          root: 'sorted',
          relPath: 'x.txt',
          sha256: sha('new bytes'),
          base: null,
          captureId: null,
        },
        tmp,
        'Air',
      ),
    ).rejects.toMatchObject({ code: 'SHARED_ROOT_PAUSED' });
    expect(fs.readdirSync(path.join(sorted, '.kia-sync'))).toEqual([]); // the refused upload is dropped
    expect(fs.readdirSync(sorted)).toEqual(['.kia-sync']);
  });

  it('a copy: an empty mount point sends no deletion, fetches nothing into it and creates no .kia-sync', async () => {
    const { c, sorted, lead, serve, t, run } = await agreed();
    write(path.join(lead.sorted, 'c.txt'), 'three'); // the leader has a file this Mac lacks
    await c.db.run(
      `INSERT INTO shared_files(root, rel_path, sha256, bytes, mtime, rev) VALUES('sorted', 'c.txt', ?, 5, 't', 4)`,
      [sha('three')],
    );
    unmount(sorted);
    await run();
    await run();
    expect(serve.removed).toEqual([]);
    expect(t.calls).toEqual([]);
    expect(fs.readdirSync(sorted)).toEqual([]);
    expect(await mirrorOf(c)).toEqual(['a.txt', 'b.txt']);
    expect(c.trashed).toEqual([]);
    expect(c.svc.rootStatus('sorted')).toBe('paused-marker');
  });

  it('at promotion an empty mount point stays owed and touches nothing', async () => {
    const { d, sorted } = await populated();
    d.sync.set('copy');
    unmount(sorted);
    d.sync.set('leader');
    await d.svc.settled();
    expect(await state(d)).toEqual([
      ['a.txt', 0, 0],
      ['b.txt', 0, 0],
    ]);
    expect(d.svc.rootStatus('sorted')).toBe('paused-marker');
    expect(await mirrorOf(d)).toEqual(['a.txt', 'b.txt']);
  });

  it('the scan itself writes nothing when the marker is gone, even if called directly', async () => {
    const { d, sorted } = await populated();
    unmount(sorted);
    const before = await d.db.all(
      `SELECT rev FROM shared_files WHERE root = 'sorted'`,
    );
    await scanRoot({ ...d.deps }, 'sorted', sorted);
    expect(
      await d.db.all(`SELECT rev FROM shared_files WHERE root = 'sorted'`),
    ).toEqual(before);
  });
});

describe('reattach', () => {
  it('on a copy: local-only files are offered, equal ones adopted, missing ones fetched, nothing trashed', async () => {
    const { c, sorted, lead, serve, run, marker } = await agreed();
    // the manifest: a.txt and b.txt as they were, plus c.txt that only the leader has
    write(path.join(lead.sorted, 'a.txt'), 'one');
    write(path.join(lead.sorted, 'c.txt'), 'three');
    write(path.join(lead.sorted, 'b.txt'), 'two'); // b.txt the new folder lacks: fetched, not read as a deletion
    await c.db.run(
      `INSERT INTO shared_files(root, rel_path, sha256, bytes, mtime, rev) VALUES('sorted', 'c.txt', ?, 5, 't', 4)`,
      [sha('three')],
    );
    // the user points the folder at another one: it holds a.txt (equal), mine.txt (local only)
    unmount(sorted);
    write(path.join(sorted, 'a.txt'), 'one');
    write(path.join(sorted, 'mine.txt'), 'mine');
    await run();
    expect(c.svc.rootStatus('sorted')).toBe('paused-marker'); // nothing happened without the user's say
    await c.svc.reattach('sorted');
    await c.svc.settled();
    expect(fs.readFileSync(markerOf(sorted), 'utf8')).not.toBe(marker);
    await run();
    expect(serve.offers.map((o) => o.relPath)).toEqual(['mine.txt']);
    expect(fs.readFileSync(path.join(sorted, 'c.txt'), 'utf8')).toBe('three'); // fetched
    expect(fs.readFileSync(path.join(sorted, 'b.txt'), 'utf8')).toBe('two');
    expect(await mirrorOf(c)).toEqual(['a.txt', 'b.txt', 'c.txt', 'mine.txt']); // a.txt adopted
    expect(c.trashed).toEqual([]);
    expect(serve.removed).toEqual([]);
    expect(fs.existsSync(path.join(sorted, 'a.txt'))).toBe(true);
  });

  it('on a leader: nothing is marked deleted, files are compared afresh, and a reconcile is owed', async () => {
    const { d, sorted, incoming } = await populated();
    unmount(sorted);
    write(path.join(sorted, 'a.txt'), 'one'); // the replacement folder holds a, not b, and an own file
    write(path.join(sorted, 'own.txt'), 'own');
    await scan(d);
    expect(d.svc.rootStatus('sorted')).toBe('paused-marker');
    await d.svc.reattach('sorted');
    expect(await mirrorOf(d)).toEqual([]);
    await d.svc.settled();
    expect(d.svc.rootStatus('sorted')).toBe('ok');
    expect(await state(d)).toEqual([
      ['a.txt', 0, 0],
      ['b.txt', 0, 1],
      ['own.txt', 0, 0],
    ]);
    expect(d.trashed).toEqual([]);
    expect(await mirrorOf(d)).toEqual(['a.txt', 'own.txt']);
    expect(d.svc.rootStatus('incoming')).toBe('ok');
    expect(incoming).toBeTruthy();
  });

  it('refuses a folder that is not there, and a root that is not set', async () => {
    const { d, sorted } = await populated();
    fs.rmSync(sorted, { recursive: true });
    await expect(d.svc.reattach('sorted')).rejects.toThrow(/not there/);
    await d.svc.setRoots({ incoming: null, sorted: null });
    await expect(d.svc.reattach('sorted')).rejects.toThrow(/not set/);
  });
});

describe('rootStatus', () => {
  it('names why a root is not in use', async () => {
    const d = await device('leader');
    expect(d.svc.rootStatus('incoming')).toBe('unset');
    const { incoming } = await withRoots(d);
    await d.svc.settled();
    expect(d.svc.rootStatus('incoming')).toBe('ok');
    expect(d.svc.usable('incoming')).toBe(true);
    unmount(incoming);
    await scan(d);
    expect(d.svc.rootStatus('incoming')).toBe('paused-marker');
    fs.rmSync(incoming, { recursive: true });
    await scan(d);
    expect(d.svc.rootStatus('incoming')).toBe('paused-missing');
  });
});
