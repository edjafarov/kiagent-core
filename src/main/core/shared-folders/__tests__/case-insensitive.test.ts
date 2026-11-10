import fs from 'fs';
import path from 'path';

import { mirrorPass } from '../mirror';
import { reconcileAtPromotion } from '../promote';
import { closeDevices, device, withRoots, type Device } from './helpers/device';
import { serveTransport, sha, stubServe, tmpDir } from './helpers/fake-transport';
import type { OfferAnswer, OfferMeta } from '../service';

afterEach(closeDevices);

const put = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const MT = '2026-01-02T03:04:05.000Z';
const row = (c: Device, rel: string, text: string, o: { deleted?: number; missing?: number; root?: string } = {}) =>
  c.db.run(
    `INSERT INTO shared_files(root, rel_path, sha256, bytes, mtime, missing_here, deleted, parked, rev)
     VALUES(?, ?, ?, ?, ?, ?, ?, 0, 1)`,
    [o.root ?? 'sorted', rel, sha(text), Buffer.byteLength(text), MT, o.missing ?? 0, o.deleted ?? 0],
  );
const mir = async (c: Device, rel: string, text: string, abs?: string) => {
  const st = abs ? fs.statSync(abs) : null;
  await c.db.run(`INSERT INTO shared_mirror(root, rel_path, sha256, bytes, mtime_ms) VALUES('sorted', ?, ?, ?, ?)`, [
    rel,
    sha(text),
    Buffer.byteLength(text),
    st ? Math.floor(st.mtimeMs) : 0,
  ]);
};
const rows = async (c: Device) =>
  (await c.db.all(`SELECT rel_path, deleted, missing_here FROM shared_files ORDER BY rel_path`)) as unknown as {
    rel_path: string; deleted: number; missing_here: number;
  }[];
const entries = async (c: Device) =>
  (await c.db.all(`SELECT rel_path FROM shared_mirror ORDER BY rel_path`)).map((r) => String(r.rel_path));

/** A file that is there and agreed on, so that the root is not an empty mount point. */
async function anchor(c: Device, sorted: string) {
  put(path.join(sorted, 'anchor.txt'), 'anchor');
  await row(c, 'anchor.txt', 'anchor');
  await mir(c, 'anchor.txt', 'anchor', path.join(sorted, 'anchor.txt'));
}
const names = (dir: string) => fs.readdirSync(dir).filter((n) => n !== '.kia-sync' && n !== 'anchor.txt');

async function copyOn(platform: NodeJS.Platform, answer?: (m: OfferMeta) => OfferAnswer) {
  const c = await device('copy', { platform });
  const { sorted } = await withRoots(c);
  const lead = { incoming: path.join(tmpDir(), 'i'), sorted: path.join(tmpDir(), 's') };
  fs.mkdirSync(lead.incoming, { recursive: true });
  fs.mkdirSync(lead.sorted, { recursive: true });
  const serve = stubServe(lead, answer);
  const t = serveTransport(serve);
  const run = () => mirrorPass({ ...c.deps, roots: c.svc.roots() }, t);
  return { c, sorted, lead, serve, t, run };
}

describe('the copy (macOS and Windows match names without regard to case)', () => {
  it('the same content under another spelling is one file: adopted, nothing transferred, every pass', async () => {
    const { c, sorted, t, run } = await copyOn('darwin');
    put(path.join(sorted, 'taxes', 'a.pdf'), 'same');
    await row(c, 'Taxes/a.pdf', 'same');
    await run();
    await run();
    expect(t.calls).toEqual([]);
    expect(fs.readdirSync(sorted)).toEqual(['taxes']);
    expect(await entries(c)).toEqual(['taxes/a.pdf']);
  });

  it('other content under another spelling is offered once, as the leader\'s spelling, and nothing else is fetched', async () => {
    const { c, sorted, t, run } = await copyOn('darwin');
    put(path.join(sorted, 'taxes', 'a.pdf'), 'mine');
    await row(c, 'Taxes/a.pdf', 'theirs');
    await run();
    expect(t.calls).toEqual(['offer sorted/Taxes/a.pdf']);
    expect(fs.readdirSync(sorted)).toEqual(['taxes']);
  });

  it('a newer version is fetched over the file that is there, in its own spelling', async () => {
    const { c, sorted, lead, run } = await copyOn('darwin');
    put(path.join(sorted, 'taxes', 'a.pdf'), 'old');
    await mir(c, 'taxes/a.pdf', 'old', path.join(sorted, 'taxes', 'a.pdf'));
    await row(c, 'Taxes/a.pdf', 'newer');
    put(path.join(lead.sorted, 'Taxes', 'a.pdf'), 'newer');
    const rename = jest.spyOn(fs.promises, 'rename');
    try {
      await run();
      expect(rename.mock.calls.map((c) => c[1])).toEqual([path.join(sorted, 'taxes', 'a.pdf')]); // its own spelling
    } finally {
      rename.mockRestore();
    }
    expect(names(sorted)).toEqual(['taxes']);
    expect(fs.readFileSync(path.join(sorted, 'taxes', 'a.pdf'), 'utf8')).toBe('newer');
    expect(await entries(c)).toEqual(['taxes/a.pdf']);
  });

  it('a file that is not there yet is created with the manifest\'s spelling', async () => {
    const { c, sorted, lead, run } = await copyOn('darwin');
    put(path.join(lead.sorted, 'Taxes', 'A.pdf'), 'fresh');
    await row(c, 'Taxes/A.pdf', 'fresh');
    await run();
    expect(names(sorted)).toEqual(['Taxes']);
    expect(fs.readdirSync(path.join(sorted, 'Taxes'))).toEqual(['A.pdf']);
  });

  it('a file deleted here is a deletion sent for the leader\'s spelling, not a fetch of it', async () => {
    const { c, sorted, t, run } = await copyOn('darwin');
    await anchor(c, sorted);
    await mir(c, 'taxes/a.pdf', 'gone');
    await row(c, 'Taxes/a.pdf', 'gone');
    await run();
    expect(t.calls).toEqual(['remove sorted/Taxes/a.pdf']);
  });

  it('on Linux the two spellings are two files', async () => {
    const { c, sorted, t, lead, run } = await copyOn('linux');
    await anchor(c, sorted);
    put(path.join(lead.sorted, 'Taxes', 'a.pdf'), 'gone');
    await mir(c, 'taxes/a.pdf', 'gone');
    await row(c, 'Taxes/a.pdf', 'gone');
    await run();
    expect(t.calls).toEqual(['fetch sorted/Taxes/a.pdf@0']);
  });
});

describe('a new leader', () => {
  it('has one live row for a file whose spelling differs from the manifest\'s', async () => {
    const c = await device('copy', { platform: 'darwin' });
    const { sorted } = await withRoots(c);
    put(path.join(sorted, 'taxes', 'a.pdf'), 'same');
    await mir(c, 'taxes/a.pdf', 'same', path.join(sorted, 'taxes', 'a.pdf'));
    await row(c, 'Taxes/a.pdf', 'same');
    await reconcileAtPromotion({ ...c.deps, roots: c.svc.roots() });
    expect(await rows(c)).toEqual([{ rel_path: 'Taxes/a.pdf', deleted: 0, missing_here: 0 }]);
    expect(await entries(c)).toEqual(['taxes/a.pdf']);
  });

  it('on Linux the same two spellings are two rows', async () => {
    const c = await device('copy', { platform: 'linux' });
    const { sorted } = await withRoots(c);
    put(path.join(sorted, 'taxes', 'a.pdf'), 'same');
    await mir(c, 'taxes/a.pdf', 'same', path.join(sorted, 'taxes', 'a.pdf'));
    await row(c, 'Taxes/a.pdf', 'same');
    await reconcileAtPromotion({ ...c.deps, roots: c.svc.roots() });
    expect((await rows(c)).map((r) => [r.rel_path, r.missing_here])).toEqual([['Taxes/a.pdf', 1], ['taxes/a.pdf', 0]]);
  });
});

describe('the leader\'s scan', () => {
  async function leader(platform: NodeJS.Platform) {
    const d = await device('leader', { platform });
    const roots = await withRoots(d);
    await d.svc.settled();
    return { d, ...roots };
  }
  const scan = async (d: Device) => {
    d.svc.kick();
    await d.svc.settled();
  };

  it('never makes a second live row for a name that differs only in case, and does not hash it again', async () => {
    const { d, sorted } = await leader('darwin');
    put(path.join(sorted, 'Taxes', 'A.pdf'), 'same');
    await row(d, 'taxes/a.pdf', 'same');
    await mir(d, 'taxes/a.pdf', 'same', path.join(sorted, 'Taxes', 'A.pdf'));
    await scan(d);
    await scan(d);
    await scan(d);
    expect(await rows(d)).toEqual([{ rel_path: 'taxes/a.pdf', deleted: 0, missing_here: 0 }]);
    expect(d.hashed).toEqual([]); // the stat cache found the entry under the other spelling
    expect(await entries(d)).toEqual(['taxes/a.pdf']);
  });

  it('an edit under the other spelling updates the one row', async () => {
    const { d, sorted } = await leader('darwin');
    put(path.join(sorted, 'taxes', 'a.pdf'), 'edited');
    await row(d, 'Taxes/a.pdf', 'original');
    await scan(d);
    expect(await d.db.all(`SELECT rel_path, sha256, deleted FROM shared_files`)).toEqual([
      { rel_path: 'Taxes/a.pdf', sha256: sha('edited'), deleted: 0 },
    ]);
  });

  it('on Linux the other spelling is a new file and the old one is gone', async () => {
    const { d, sorted } = await leader('linux');
    put(path.join(sorted, 'taxes', 'a.pdf'), 'same');
    await row(d, 'Taxes/a.pdf', 'same');
    await scan(d);
    expect((await rows(d)).map((r) => [r.rel_path, r.deleted])).toEqual([['Taxes/a.pdf', 1], ['taxes/a.pdf', 0]]);
  });
});

describe('serve, kept-both names', () => {
  it('skips a name that a live row already has in another case', async () => {
    const d = await device('leader', { platform: 'darwin' });
    const { sorted } = await withRoots(d);
    await d.svc.settled();
    put(path.join(sorted, 'doc.txt'), 'leader version');
    d.svc.kick();
    await d.svc.settled();
    await row(d, 'Doc (from Air).txt', 'someone else', { missing: 1 });
    const tmp = await d.svc.serve.stagingFile('sorted');
    fs.writeFileSync(tmp, 'offered version');
    const answer = await d.svc.serve.offer(
      { root: 'sorted', relPath: 'doc.txt', sha256: sha('offered version'), base: null, captureId: null },
      tmp,
      'Air',
    );
    expect(answer).toBe('kept-both');
    expect(fs.existsSync(path.join(sorted, 'doc (from Air) 2.txt'))).toBe(true);
  });
});

describe('a path on this Mac and the manifest row of the same file', () => {
  it('resolve gives the row\'s identity and parked finds the row, whatever the spelling on disk', async () => {
    const d = await device('leader', { platform: 'darwin' });
    const { sorted, incoming } = await withRoots(d);
    await d.svc.settled();
    await d.db.run(
      `INSERT INTO accounts(id, source, identifier, config, status, created_at)
       VALUES('acct-shared', 'shared-folder', 'shared', '{}', 'connecting', 'now')`,
    );
    await row(d, 'Taxes/a.pdf', 'x');
    await d.db.run(
      `INSERT INTO shared_files(root, rel_path, sha256, bytes, mtime, parked, rev) VALUES('incoming','Scans/X.pdf',?,1,'t',1,2)`,
      [sha('x')],
    );
    expect(await d.svc.resolve(path.join(sorted, 'taxes', 'a.pdf'))).toMatchObject({
      externalId: 'sorted/Taxes/a.pdf',
      relPath: 'Taxes/a.pdf',
    });
    expect(await d.svc.resolve(path.join(sorted, 'new', 'b.pdf'))).toMatchObject({ externalId: 'sorted/new/b.pdf' });
    expect(await d.svc.parked(path.join(incoming, 'scans', 'x.pdf'))).toBe(true);
  });
});
