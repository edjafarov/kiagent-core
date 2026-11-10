import fs from 'fs';
import os from 'os';
import path from 'path';

import { mirrorPass } from '../mirror';
import { safeAbs } from '../paths';
import { listSortable } from '../promote';
import { closeDevices, device, withRoots } from './helpers/device';
import { serveTransport, sha, stubServe, tmpDir } from './helpers/fake-transport';

afterEach(closeDevices);

const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const outsideDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));

describe('safeAbs', () => {
  it('accepts plain paths, also under a root that is itself a symlink, and paths not made yet', async () => {
    const real = tmpDir();
    const link = path.join(tmpDir(), 'link');
    fs.symlinkSync(real, link);
    write(path.join(real, 'a', 'b.txt'), 'x');
    expect(await safeAbs(link, 'a/b.txt')).toBe(path.join(link, 'a', 'b.txt'));
    expect(await safeAbs(link, 'new/dir/c.txt')).toBe(path.join(link, 'new', 'dir', 'c.txt'));
  });

  it('rejects a symlinked directory below the root, even one that points back inside', async () => {
    const root = tmpDir();
    const out = outsideDir();
    fs.symlinkSync(out, path.join(root, 'Tax'));
    fs.mkdirSync(path.join(root, 'real'));
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'alias'));
    await expect(safeAbs(root, 'Tax/report.pdf')).rejects.toThrow(/symlink/);
    await expect(safeAbs(root, 'Tax/deeper/new/report.pdf')).rejects.toThrow(/symlink/);
    await expect(safeAbs(root, 'alias/x.pdf')).rejects.toThrow(/symlink/);
  });

  it('checks the real path too: a directory swapped for a link after the lstat is still caught', async () => {
    const root = tmpDir();
    const out = outsideDir();
    fs.symlinkSync(out, path.join(root, 'Tax'));
    const lstat = fs.promises.lstat.bind(fs.promises);
    const spy = jest
      .spyOn(fs.promises, 'lstat')
      .mockImplementation(((p: fs.PathLike, o?: object) => lstat(String(p).endsWith('Tax') ? root : p, o as never)) as never);
    try {
      await expect(safeAbs(root, 'Tax/report.pdf')).rejects.toThrow(/leaves the folder/);
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects a file that is itself a symlink', async () => {
    const root = tmpDir();
    const out = outsideDir();
    write(path.join(out, 'secret.txt'), 's');
    fs.symlinkSync(path.join(out, 'secret.txt'), path.join(root, 'a.txt'));
    await expect(safeAbs(root, 'a.txt')).rejects.toThrow(/symlink/);
  });
});

describe('a path from another device through a symlinked directory', () => {
  async function leaderWithLink() {
    const d = await device('leader');
    const { sorted } = await withRoots(d);
    await d.svc.settled();
    const out = outsideDir();
    write(path.join(out, 'report.pdf'), 'outside');
    fs.symlinkSync(out, path.join(sorted, 'Tax'));
    return { d, sorted, out };
  }

  it('an offer writes nothing outside the root', async () => {
    const { d, out } = await leaderWithLink();
    const tmp = await d.svc.serve.stagingFile('sorted');
    fs.writeFileSync(tmp, 'new');
    await expect(
      d.svc.serve.offer({ root: 'sorted', relPath: 'Tax/fresh.pdf', sha256: sha('new'), base: null, captureId: null }, tmp, 'Air'),
    ).rejects.toThrow(/symlink/);
    const tmp2 = await d.svc.serve.stagingFile('sorted');
    fs.writeFileSync(tmp2, 'new');
    await expect(
      d.svc.serve.offer({ root: 'sorted', relPath: 'Tax/report.pdf', sha256: sha('new'), base: sha('outside'), captureId: null }, tmp2, 'Air'),
    ).rejects.toThrow(/symlink/);
    expect(fs.readdirSync(out)).toEqual(['report.pdf']);
    expect(fs.readFileSync(path.join(out, 'report.pdf'), 'utf8')).toBe('outside');
    expect(fs.existsSync(tmp2)).toBe(false); // the refused upload is dropped
  });

  it('open and remove do not follow it', async () => {
    const { d, out } = await leaderWithLink();
    await expect(d.svc.serve.open({ root: 'sorted', relPath: 'Tax/report.pdf', sha256: sha('outside') })).rejects.toThrow(
      /symlink/,
    );
    await expect(d.svc.serve.remove({ root: 'sorted', relPath: 'Tax/report.pdf', sha256: sha('outside') })).rejects.toThrow(
      /symlink/,
    );
    expect(d.trashed).toEqual([]);
    expect(fs.existsSync(path.join(out, 'report.pdf'))).toBe(true);
  });

  it('a copy does not fetch into it', async () => {
    const c = await device('copy');
    const { sorted } = await withRoots(c);
    const out = outsideDir();
    fs.symlinkSync(out, path.join(sorted, 'Tax'));
    await c.db.run(
      `INSERT INTO shared_files(root, rel_path, sha256, bytes, mtime, rev) VALUES('sorted','Tax/report.pdf',?,5,'2026-01-01T00:00:00.000Z',3)`,
      [sha('hello')],
    );
    const lead = { incoming: path.join(tmpDir(), 'i'), sorted: path.join(tmpDir(), 's') };
    write(path.join(lead.sorted, 'Tax', 'report.pdf'), 'hello');
    const t = serveTransport(stubServe(lead));
    await mirrorPass({ ...c.deps, roots: c.svc.roots() }, t);
    expect(t.calls).toEqual([]); // not even downloaded
    expect(fs.readdirSync(out)).toEqual([]);
    expect(await c.db.all(`SELECT 1 FROM shared_mirror`)).toEqual([]);
  });

  it('what the sorter is told to sort never goes through it', async () => {
    const d = await device('leader');
    const { incoming } = await withRoots(d);
    await d.svc.settled();
    const out = outsideDir();
    write(path.join(out, 'x.pdf'), 'x');
    fs.symlinkSync(out, path.join(incoming, 'Link'));
    write(path.join(incoming, 'ok.pdf'), 'ok');
    for (const rel of ['Link/x.pdf', 'ok.pdf'])
      await d.db.run(
        `INSERT INTO shared_files(root, rel_path, sha256, bytes, mtime, rev) VALUES('incoming',?,?,1,'t',90)`,
        [rel, sha('x')],
      );
    expect(await listSortable(d.deps, incoming)).toEqual([path.join(incoming, 'ok.pdf')]);
  });
});
