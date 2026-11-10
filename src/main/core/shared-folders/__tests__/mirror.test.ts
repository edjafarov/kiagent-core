import fs from 'fs';
import path from 'path';

import { mirrorPass } from '../mirror';
import { closeDevices, device, withRoots, type Device } from './helpers/device';
import { serveTransport, sha, stubServe, tmpDir } from './helpers/fake-transport';
import type { OfferAnswer, OfferMeta } from '../service';

afterEach(closeDevices);

type Mac = Device & { incoming: string; sorted: string; lead: { incoming: string; sorted: string } };

/** A copy with its two folders, and a leader that is two folders of files. */
async function setup(answer?: (m: OfferMeta) => OfferAnswer) {
  const c = (await device('copy')) as Mac;
  const roots = await withRoots(c);
  c.incoming = roots.incoming;
  c.sorted = roots.sorted;
  const lead = { incoming: path.join(tmpDir(), 'incoming'), sorted: path.join(tmpDir(), 'sorted') };
  fs.mkdirSync(lead.incoming, { recursive: true });
  fs.mkdirSync(lead.sorted, { recursive: true });
  const serve = stubServe(lead, answer);
  const t = serveTransport(serve);
  return { c, lead, serve, t };
}

const put = (file: string, text: string, mtime?: Date) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  if (mtime) fs.utimesSync(file, mtime, mtime);
};
const MT = '2026-01-02T03:04:05.000Z';
const row = (c: Device, root: string, rel: string, text: string, flags: { deleted?: number; missing_here?: number } = {}) =>
  c.db.run(
    `INSERT OR REPLACE INTO shared_files(root, rel_path, sha256, bytes, mtime, missing_here, deleted, parked, rev)
     VALUES(?, ?, ?, ?, ?, ?, ?, 0, 1)`,
    [root, rel, sha(text), Buffer.byteLength(text), MT, flags.missing_here ?? 0, flags.deleted ?? 0],
  );
/** The mirror entry for a file that is on disk with exactly `text`. */
const mir = async (c: Device, root: string, abs: string, rel: string, text: string, capture: string | null = null) => {
  const st = fs.statSync(abs);
  await c.db.run(`INSERT OR REPLACE INTO shared_mirror(root, rel_path, sha256, bytes, mtime_ms, capture_id) VALUES(?,?,?,?,?,?)`, [
    root, rel, sha(text), st.size, Math.floor(st.mtimeMs), capture,
  ]);
};
const entries = async (c: Device) =>
  (await c.db.all(`SELECT root, rel_path, sha256, capture_id FROM shared_mirror ORDER BY root, rel_path`)) as unknown as {
    root: string; rel_path: string; sha256: string; capture_id: string | null;
  }[];
const run = (c: Device, t: ReturnType<typeof serveTransport>) =>
  mirrorPass({ ...c.deps, roots: c.svc.roots() }, t);
const read = (f: string) => fs.readFileSync(f, 'utf8');

describe('the table, row by row', () => {
  it('D = M, the leader has the same content: nothing happens', async () => {
    const { c, t } = await setup();
    const f = path.join(c.sorted, 'a.txt');
    put(f, 'one');
    await mir(c, 'sorted', f, 'a.txt', 'one');
    await row(c, 'sorted', 'a.txt', 'one');
    await run(c, t);
    expect(t.calls).toEqual([]);
    expect(c.trashed).toEqual([]);
  });

  it('D = M, the leader has other content: fetched, kept with the row mtime, mirror updated', async () => {
    const { c, lead, t } = await setup();
    const f = path.join(c.sorted, 'a.txt');
    put(f, 'one');
    await mir(c, 'sorted', f, 'a.txt', 'one');
    put(path.join(lead.sorted, 'a.txt'), 'two!');
    await row(c, 'sorted', 'a.txt', 'two!');
    await run(c, t);
    expect(t.calls).toEqual(['fetch sorted/a.txt@0']);
    expect(read(f)).toBe('two!');
    expect(fs.statSync(f).mtime.toISOString()).toBe(MT);
    expect((await entries(c))[0].sha256).toBe(sha('two!'));
    expect(fs.readdirSync(path.join(c.sorted, '.kia-sync'))).toEqual([]);
    await run(c, t); // and now it is in agreement
    expect(t.calls).toHaveLength(1);
  });

  it('D = M and a deleted row: the file goes to the Trash, also when this copy missed an edit', async () => {
    const { c, t } = await setup();
    const f = path.join(c.sorted, 'a.txt');
    put(f, 'old');
    await mir(c, 'sorted', f, 'a.txt', 'old');
    await row(c, 'sorted', 'a.txt', 'newer edit the copy never saw', { deleted: 1 });
    await run(c, t);
    expect(c.trashed).toEqual([f]);
    expect(await entries(c)).toEqual([]);
    expect(t.calls).toEqual([]);
  });

  it('the file is gone, M exists, the leader still has M: the deletion is sent, then the entry dropped', async () => {
    const { c, t } = await setup();
    const f = path.join(c.sorted, 'a.txt');
    put(f, 'one');
    const keep = path.join(c.sorted, 'keep.txt'); // so the root is not empty
    put(keep, 'k');
    await mir(c, 'sorted', keep, 'keep.txt', 'k');
    await row(c, 'sorted', 'keep.txt', 'k');
    await mir(c, 'sorted', f, 'a.txt', 'one');
    await row(c, 'sorted', 'a.txt', 'one');
    fs.rmSync(f);
    await run(c, t);
    expect(t.calls).toEqual(['remove sorted/a.txt']);
    expect((await entries(c)).map((e) => e.rel_path)).not.toContain('a.txt');
  });

  it('no file, no M, a live row: fetched', async () => {
    const { c, lead, t } = await setup();
    put(path.join(lead.incoming, 'sub', 'b.txt'), 'bee');
    await row(c, 'incoming', 'sub/b.txt', 'bee');
    await run(c, t);
    expect(read(path.join(c.incoming, 'sub', 'b.txt'))).toBe('bee');
    expect((await entries(c))[0]).toMatchObject({ root: 'incoming', rel_path: 'sub/b.txt', sha256: sha('bee') });
  });

  it('a file the leader has never seen is offered with no base, never removed', async () => {
    const { c, serve, t } = await setup();
    const f = path.join(c.sorted, 'new.txt');
    put(f, 'mine');
    await run(c, t);
    expect(serve.offers).toEqual([
      { root: 'sorted', relPath: 'new.txt', sha256: sha('mine'), base: null, captureId: null },
    ]);
    expect(read(f)).toBe('mine');
    expect((await entries(c))[0].sha256).toBe(sha('mine'));
  });

  it('an empty mirror table facing a deleted row and a file: the file is offered, not removed (Review Focus 4)', async () => {
    const { c, serve, t } = await setup();
    const f = path.join(c.sorted, 'a.txt');
    put(f, 'still wanted');
    await row(c, 'sorted', 'a.txt', 'still wanted', { deleted: 1 });
    await run(c, t);
    expect(c.trashed).toEqual([]);
    expect(fs.existsSync(f)).toBe(true);
    expect(serve.offers.map((o) => o.relPath)).toEqual(['a.txt']);
  });

  it('D differs from M: offered first with the mirror as base, and nothing else for that path', async () => {
    const { c, lead, serve, t } = await setup();
    const f = path.join(c.sorted, 'a.txt');
    put(f, 'one');
    await mir(c, 'sorted', f, 'a.txt', 'one', 'cap-1');
    put(f, 'one, edited here');
    put(path.join(lead.sorted, 'a.txt'), 'one, edited there');
    await row(c, 'sorted', 'a.txt', 'one, edited there');
    await run(c, t);
    expect(t.calls).toEqual(['offer sorted/a.txt']); // no fetch before the leader has this edit
    expect(serve.offers[0]).toMatchObject({ base: sha('one'), captureId: 'cap-1', sha256: sha('one, edited here') });
    expect(read(f)).toBe('one, edited here');
  });

  it('D = M but the leader has no row at all: offered, never removed', async () => {
    const { c, serve, t } = await setup();
    const f = path.join(c.sorted, 'a.txt');
    put(f, 'one');
    await mir(c, 'sorted', f, 'a.txt', 'one');
    await run(c, t);
    expect(c.trashed).toEqual([]);
    expect(serve.offers.map((o) => o.relPath)).toEqual(['a.txt']);
  });

  it('the same file at the same path on both Macs before sharing is adopted, not offered', async () => {
    const { c, t } = await setup();
    put(path.join(c.sorted, 'a.txt'), 'same');
    await row(c, 'sorted', 'a.txt', 'same');
    await run(c, t);
    expect(t.calls).toEqual([]);
    expect((await entries(c))[0].sha256).toBe(sha('same'));
  });

  it('a file with no M and other content than the row is offered', async () => {
    const { c, serve, t } = await setup();
    put(path.join(c.sorted, 'a.txt'), 'mine');
    await row(c, 'sorted', 'a.txt', 'theirs');
    await run(c, t);
    expect(serve.offers.map((o) => o.sha256)).toEqual([sha('mine')]);
  });
});

describe('missing_here rows', () => {
  it('are never fetched', async () => {
    const { c, t } = await setup();
    await row(c, 'sorted', 'a.txt', 'one', { missing_here: 1 });
    await run(c, t);
    expect(t.calls).toEqual([]);
  });

  it('are filled by a copy that holds the bytes: offered although D = M = the row', async () => {
    const { c, serve, t } = await setup();
    const f = path.join(c.sorted, 'a.txt');
    put(f, 'one');
    await mir(c, 'sorted', f, 'a.txt', 'one');
    await row(c, 'sorted', 'a.txt', 'one', { missing_here: 1 });
    await run(c, t);
    expect(serve.offers.map((o) => `${o.relPath}:${o.sha256 === sha('one')}`)).toEqual(['a.txt:true']);
  });

  it('are not filled with an older version of the file', async () => {
    const { c, t } = await setup();
    const f = path.join(c.sorted, 'a.txt');
    put(f, 'older');
    await mir(c, 'sorted', f, 'a.txt', 'older');
    await row(c, 'sorted', 'a.txt', 'newer', { missing_here: 1 });
    await run(c, t);
    expect(t.calls).toEqual([]);
    expect(read(f)).toBe('older');
  });
});

describe('what the leader answers', () => {
  it('kept-both: the mirror takes this version, so the next pass fetches the leader\'s over it and both end with both', async () => {
    const { c, lead, serve, t } = await setup(() => 'kept-both');
    const f = path.join(c.sorted, 'a.txt');
    put(f, 'base');
    await mir(c, 'sorted', f, 'a.txt', 'base');
    put(f, 'mine, edited');
    put(path.join(lead.sorted, 'a.txt'), 'theirs');
    await row(c, 'sorted', 'a.txt', 'theirs');
    await run(c, t);
    expect((await entries(c))[0].sha256).toBe(sha('mine, edited'));
    // the leader's scan would now list "a (from Air).txt" with the offered bytes
    expect(serve.offered.get('sorted/a.txt')).toBe('mine, edited');
    put(path.join(lead.sorted, 'a (from Air).txt'), 'mine, edited');
    await row(c, 'sorted', 'a (from Air).txt', 'mine, edited');
    await run(c, t);
    expect(read(f)).toBe('theirs');
    expect(read(path.join(c.sorted, 'a (from Air).txt'))).toBe('mine, edited');
  });

  it('have-it: the file goes to the Trash and the entry is dropped, when it still has the offered hash', async () => {
    const { c, t } = await setup(() => 'have-it');
    const f = path.join(c.sorted, 'scan.pdf');
    put(f, 'scan');
    await run(c, t);
    expect(c.trashed).toEqual([f]);
    expect(await entries(c)).toEqual([]);
  });

  it('have-it: a file the user edited meanwhile is kept', async () => {
    const { c, t } = await setup(() => 'have-it');
    const f = path.join(c.sorted, 'scan.pdf');
    put(f, 'scan');
    t.duringOffer = () => put(f, 'scan, annotated');
    await run(c, t);
    expect(c.trashed).toEqual([]);
    expect(read(f)).toBe('scan, annotated');
  });

  it.each(['same', 'written', 'filled'] as const)('%s: the mirror takes the offered hash', async (answer) => {
    const { c, t } = await setup(() => answer);
    put(path.join(c.sorted, 'a.txt'), 'x');
    await run(c, t);
    expect((await entries(c))[0].sha256).toBe(sha('x'));
  });
});

describe('the destination is checked again', () => {
  it('an edit made while the newer version downloads: the download is dropped and the edit offered (Review Focus 2)', async () => {
    const { c, lead, serve, t } = await setup();
    const f = path.join(c.sorted, 'a.txt');
    put(f, 'one');
    await mir(c, 'sorted', f, 'a.txt', 'one');
    put(path.join(lead.sorted, 'a.txt'), 'two!');
    await row(c, 'sorted', 'a.txt', 'two!');
    t.duringFetch = () => put(f, 'one, but mine');
    await run(c, t);
    expect(read(f)).toBe('one, but mine');
    expect(fs.readdirSync(path.join(c.sorted, '.kia-sync'))).toEqual([]);
    expect((await entries(c))[0].sha256).toBe(sha('one'));
    t.duringFetch = undefined;
    await run(c, t); // now D differs from M: offered first
    expect(serve.offers.map((o) => o.sha256)).toEqual([sha('one, but mine')]);
  });

  it('a file that appeared where there was none while it downloaded is kept and offered', async () => {
    const { c, lead, serve, t } = await setup();
    put(path.join(lead.sorted, 'a.txt'), 'theirs');
    await row(c, 'sorted', 'a.txt', 'theirs');
    const f = path.join(c.sorted, 'a.txt');
    t.duringFetch = () => put(f, 'a new file of mine');
    await run(c, t);
    expect(read(f)).toBe('a new file of mine');
    t.duringFetch = undefined;
    await run(c, t);
    expect(serve.offers.map((o) => o.relPath)).toEqual(['a.txt']);
  });

  it('a file edited between the listing and a mirrored removal is not trashed', async () => {
    const { c, t } = await setup();
    const a = path.join(c.sorted, 'a.txt');
    put(a, 'old');
    await mir(c, 'sorted', a, 'a.txt', 'old');
    await row(c, 'sorted', 'a.txt', 'old', { deleted: 1 });
    put(path.join(c.sorted, 'b.txt'), 'new file'); // its offer happens first
    t.duringOffer = () => put(a, 'old, edited just now');
    await run(c, t);
    expect(c.trashed).toEqual([]);
    expect(read(a)).toBe('old, edited just now');
  });

  it('a file recreated before the deletion is sent is not reported deleted', async () => {
    const { c, serve, t } = await setup();
    const a = path.join(c.sorted, 'a.txt');
    put(a, 'one');
    await mir(c, 'sorted', a, 'a.txt', 'one');
    await row(c, 'sorted', 'a.txt', 'one');
    fs.rmSync(a);
    put(path.join(c.sorted, 'b.txt'), 'new');
    t.duringOffer = () => put(a, 'one again');
    await run(c, t);
    expect(serve.removed).toEqual([]);
    expect(read(a)).toBe('one again');
  });
});

describe('transfers', () => {
  it('an interrupted fetch resumes from its offset', async () => {
    const { c, lead, t } = await setup();
    put(path.join(lead.sorted, 'big.txt'), '0123456789');
    await row(c, 'sorted', 'big.txt', '0123456789');
    t.breakAfter = 4;
    await expect(run(c, t)).resolves.toBeUndefined(); // ends quietly
    expect(fs.existsSync(path.join(c.sorted, 'big.txt'))).toBe(false);
    expect(fs.statSync(path.join(c.sorted, '.kia-sync', `${sha('0123456789')}.part`)).size).toBe(4);
    await run(c, t);
    expect(t.calls).toEqual(['fetch sorted/big.txt@0', 'fetch sorted/big.txt@4']);
    expect(read(path.join(c.sorted, 'big.txt'))).toBe('0123456789');
  });

  it('a hash mismatch leaves the old file and no temp file', async () => {
    const { c, lead, t } = await setup();
    const f = path.join(c.sorted, 'a.txt');
    put(f, 'one');
    await mir(c, 'sorted', f, 'a.txt', 'one');
    put(path.join(lead.sorted, 'a.txt'), 'two!');
    await row(c, 'sorted', 'a.txt', 'two!');
    t.corrupt = true;
    await run(c, t);
    expect(read(f)).toBe('one');
    expect(fs.readdirSync(path.join(c.sorted, '.kia-sync'))).toEqual([]);
    expect((await entries(c))[0].sha256).toBe(sha('one'));
  });

  it('gone: nothing changes and the next pass tries again', async () => {
    const { c, t } = await setup();
    await row(c, 'sorted', 'a.txt', 'not on the leader');
    await run(c, t);
    expect(fs.existsSync(path.join(c.sorted, 'a.txt'))).toBe(false);
    expect(await entries(c)).toEqual([]);
  });

  it('a failing transport ends the pass quietly at the first failure and changes nothing', async () => {
    const { c, t } = await setup();
    put(path.join(c.sorted, 'a.txt'), 'mine');
    put(path.join(c.sorted, 'b.txt'), 'mine too');
    t.fail = true;
    await expect(run(c, t)).resolves.toBeUndefined();
    expect(t.calls).toHaveLength(1);
    expect(await entries(c)).toEqual([]);
  });

  it('one path that cannot be written does not stop the others', async () => {
    const { c, lead, t } = await setup();
    put(path.join(c.sorted, 'dir'), 'a file where a folder is needed');
    put(path.join(lead.sorted, 'dir', 'x.txt'), 'x');
    put(path.join(lead.sorted, 'z.txt'), 'z');
    await row(c, 'sorted', 'dir/x.txt', 'x');
    await row(c, 'sorted', 'z.txt', 'z');
    await run(c, t);
    expect(read(path.join(c.sorted, 'z.txt'))).toBe('z');
  });
});

describe('a root that is not there, or looks empty', () => {
  it('a missing root does nothing and says so once (Review Focus 5)', async () => {
    const { c, t } = await setup();
    const f = path.join(c.sorted, 'a.txt');
    put(f, 'one');
    await mir(c, 'sorted', f, 'a.txt', 'one');
    await row(c, 'sorted', 'a.txt', 'one', { deleted: 1 });
    fs.rmSync(c.sorted, { recursive: true });
    await run(c, t);
    await run(c, t);
    expect(t.calls).toEqual([]);
    expect(c.trashed).toEqual([]);
    expect(fs.existsSync(c.sorted)).toBe(false); // not even re-created by a fetch
    expect((await entries(c)).map((e) => e.rel_path)).toEqual(['a.txt']);
    expect(c.logs.filter((l) => l.includes('not mirrored'))).toHaveLength(1);
  });

  it('a root that lists no file at all sends no deletion and removes nothing', async () => {
    const { c, serve, t } = await setup();
    const a = path.join(c.sorted, 'a.txt');
    const b = path.join(c.sorted, 'b.txt');
    put(a, 'one');
    put(b, 'two');
    await mir(c, 'sorted', a, 'a.txt', 'one');
    await mir(c, 'sorted', b, 'b.txt', 'two');
    await row(c, 'sorted', 'a.txt', 'one');
    await row(c, 'sorted', 'b.txt', 'two', { deleted: 1 });
    fs.rmSync(a);
    fs.rmSync(b);
    await run(c, t);
    await run(c, t);
    expect(serve.removed).toEqual([]);
    expect(t.calls).toEqual([]);
    expect(await entries(c)).toHaveLength(2);
    expect(c.logs.filter((l) => l.includes('lists no file at all'))).toHaveLength(1);
  });

  it('a folder that could not be read is no proof that its files are gone', async () => {
    const { c, serve, t } = await setup();
    const keep = path.join(c.sorted, 'keep.txt');
    const f = path.join(c.sorted, 'locked', 'a.txt');
    put(keep, 'k');
    put(f, 'one');
    await mir(c, 'sorted', keep, 'keep.txt', 'k');
    await row(c, 'sorted', 'keep.txt', 'k');
    await mir(c, 'sorted', f, 'locked/a.txt', 'one');
    await row(c, 'sorted', 'locked/a.txt', 'one');
    fs.chmodSync(path.dirname(f), 0o000);
    try {
      await run(c, t);
    } finally {
      fs.chmodSync(path.dirname(f), 0o755);
    }
    expect(serve.removed).toEqual([]);
    expect(t.calls).toEqual([]);
  });

  it('an empty root with an empty mirror still fetches: that is a first mirror', async () => {
    const { c, lead, t } = await setup();
    put(path.join(lead.sorted, 'a.txt'), 'one');
    await row(c, 'sorted', 'a.txt', 'one');
    await run(c, t);
    expect(read(path.join(c.sorted, 'a.txt'))).toBe('one');
  });
});

describe('.kia-sync and paths from outside', () => {
  it('nothing in .kia-sync is offered or adopted', async () => {
    const { c, serve, t } = await setup();
    put(path.join(c.sorted, '.kia-sync', 'x.part'), 'half');
    await run(c, t);
    expect(serve.offers).toEqual([]);
    expect(await entries(c)).toEqual([]);
  });

  it('a row with a path that leaves the root is not fetched', async () => {
    const { c, lead, t } = await setup();
    put(path.join(lead.sorted, '..', 'evil.txt'), 'evil');
    await row(c, 'sorted', '../evil.txt', 'evil');
    await row(c, 'sorted', '/abs.txt', 'evil');
    await row(c, 'sorted', 'a//b.txt', 'evil');
    await run(c, t);
    expect(t.calls).toEqual([]);
    expect(fs.existsSync(path.join(c.sorted, '..', 'evil.txt'))).toBe(false);
  });
});
