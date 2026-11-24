/** Archives earlier versions kept for a set-aside device are removed at boot,
 *  and are never taken for a join archive (no-recovery-archives spec). */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { archiveFiles, sweepPassedOverArchives } from '../status';

let dir: string;
let db: string;
const names = () => fs.readdirSync(dir).sort();
const write = (name: string) => fs.writeFileSync(path.join(dir, name), 'x');

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-sweep-'));
  db = path.join(dir, 'kiagent.db');
  write('kiagent.db');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const TAGGED = 'kiagent.db.archive-20261108140541';
const PLAIN = 'kiagent.db.archive-20261101090000';
const leaveTagged = () => {
  for (const ext of ['', '-wal', '-shm', '.passed-over.json'])
    write(`${TAGGED}${ext}`);
};
const leavePlain = () => {
  for (const ext of ['', '-wal', '-shm']) write(`${PLAIN}${ext}`);
};

describe('sweepPassedOverArchives', () => {
  it('deletes a tagged archive, its wal and shm, and its tag', () => {
    leaveTagged();
    expect(sweepPassedOverArchives(db)).toBe(1);
    expect(names()).toEqual(['kiagent.db']);
  });

  it('keeps a join archive', () => {
    leavePlain();
    leaveTagged();
    expect(sweepPassedOverArchives(db)).toBe(1);
    expect(names()).toEqual([
      'kiagent.db',
      PLAIN,
      `${PLAIN}-shm`,
      `${PLAIN}-wal`,
    ]);
    expect(sweepPassedOverArchives(db)).toBe(0);
  });

  it('deletes the archive before its tag', () => {
    leaveTagged();
    const order: string[] = [];
    sweepPassedOverArchives(db, (f) => {
      order.push(path.basename(f));
      fs.rmSync(f, { force: true });
    });
    expect(order).toEqual([
      TAGGED,
      `${TAGGED}-wal`,
      `${TAGGED}-shm`,
      `${TAGGED}.passed-over.json`,
    ]);
  });

  it('a failed archive delete keeps the tag, and the next sweep finishes', () => {
    leaveTagged();
    expect(
      sweepPassedOverArchives(db, (f) => {
        if (f.endsWith(TAGGED)) throw new Error('busy');
        fs.rmSync(f, { force: true });
      }),
    ).toBe(0);
    expect(names()).toContain(`${TAGGED}.passed-over.json`);
    expect(names()).toContain(TAGGED);
    // Still tagged: not old data, and not something Delete would remove.
    expect(archiveFiles(db)).toEqual([]);
    expect(sweepPassedOverArchives(db)).toBe(1);
    expect(names()).toEqual(['kiagent.db']);
  });

  it('removes a stray tag that was never finished', () => {
    write(`${TAGGED}.passed-over.json.tmp`);
    expect(sweepPassedOverArchives(db)).toBe(0);
    expect(names()).toEqual(['kiagent.db']);
  });

  it('a missing directory is nothing to sweep', () => {
    expect(sweepPassedOverArchives(path.join(dir, 'gone', 'kiagent.db'))).toBe(
      0,
    );
  });
});

describe('archiveFiles', () => {
  it('lists a join archive with its wal and shm, and no tagged archive or tag', () => {
    leavePlain();
    leaveTagged();
    write(`${TAGGED}.passed-over.json.tmp`);
    expect(
      archiveFiles(db)
        .map((f) => path.basename(f))
        .sort(),
    ).toEqual([PLAIN, `${PLAIN}-shm`, `${PLAIN}-wal`]);
  });
});
