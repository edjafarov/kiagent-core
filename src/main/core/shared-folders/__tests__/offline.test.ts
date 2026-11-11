import fs from 'fs';
import path from 'path';

import { mirrorPass } from '../mirror';
import { closeDevices, device, withRoots, type Device } from './helpers/device';
import { serveTransport, sha, stubServe, tmpDir } from './helpers/fake-transport';

afterEach(closeDevices);

const put = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const row = (c: Device, rel: string, text: string) =>
  c.db.run(
    `INSERT INTO shared_files(root, rel_path, sha256, bytes, mtime, missing_here, deleted, parked, rev)
     VALUES('sorted', ?, ?, ?, '2026-01-02T03:04:05.000Z', 0, 0, 0, 1)`,
    [rel, sha(text), Buffer.byteLength(text)],
  );
const entries = async (c: Device) =>
  (await c.db.all(`SELECT rel_path FROM shared_mirror ORDER BY rel_path`)).map((r) => String(r.rel_path));

async function setup() {
  const c = await device('copy');
  const { sorted } = await withRoots(c);
  const lead = { incoming: path.join(tmpDir(), 'i'), sorted: path.join(tmpDir(), 's') };
  fs.mkdirSync(lead.incoming, { recursive: true });
  fs.mkdirSync(lead.sorted, { recursive: true });
  const t = serveTransport(stubServe(lead));
  const run = () => mirrorPass({ ...c.deps, roots: c.svc.roots() }, t);
  return { c, sorted, t, run };
}

describe('a copy that cannot reach the leader', () => {
  it('keeps what it learned: files that equal the manifest are adopted before the first transport call', async () => {
    const { c, sorted, t, run } = await setup();
    for (const n of ['a', 'b', 'c']) {
      put(path.join(sorted, `${n}.txt`), n);
      await row(c, `${n}.txt`, n);
    }
    put(path.join(sorted, 'new.txt'), 'only here'); // the leader has never seen it: offered
    t.fail = true;
    await run();
    expect(await entries(c)).toEqual(['a.txt', 'b.txt', 'c.txt']);
    c.hashed.length = 0;
    await run();
    await run();
    // the adopted files are not hashed again; the one waiting for the leader is looked at
    expect(c.hashed.filter((p) => !p.endsWith('new.txt'))).toEqual([]);
  });

  it('does not hash a file that waits for the leader again while it has not changed', async () => {
    const { c, sorted, t, run } = await setup();
    put(path.join(sorted, 'new.txt'), 'only here');
    put(path.join(sorted, 'other.txt'), 'other');
    t.fail = true;
    await run();
    await run();
    await run();
    expect(c.hashed.filter((p) => p.endsWith('new.txt'))).toHaveLength(1);
    expect(c.hashed.filter((p) => p.endsWith('other.txt'))).toHaveLength(1);
    // a change is seen
    put(path.join(sorted, 'new.txt'), 'ONLY HERE'); // same size, other time
    fs.utimesSync(path.join(sorted, 'new.txt'), new Date('2030-01-01'), new Date('2030-01-01'));
    await run();
    expect(c.hashed.filter((p) => p.endsWith('new.txt'))).toHaveLength(2);
    t.fail = false;
    await run();
    expect(await entries(c)).toEqual(['new.txt', 'other.txt']);
  });
});
