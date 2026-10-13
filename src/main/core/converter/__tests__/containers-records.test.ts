/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { readRecords, type RecordRules } from '../containers/records';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kia-records-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const write = (name: string, content: string | Buffer) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
};
const all = async (p: string, offset: number, rules: RecordRules) => {
  const out = [];
  for await (const r of readRecords(p, offset, rules)) out.push(r);
  return out;
};
const mboxRules = (max = 1024 * 1024): RecordRules => ({
  isStart: (line, prevBlank) =>
    prevBlank && line.subarray(0, 5).toString('latin1') === 'From ',
  maxRecordBytes: max,
});

describe('readRecords', () => {
  const MBOX =
    'From a@x Mon Jan 01 00:00:00 2024\nSubject: Grüße\n\nbody one\n\n' +
    'From b@x Mon Jan 01 00:00:00 2024\nSubject: two\n\nhello\nFrom inside body is not a start\n\n' +
    'From c@x Mon Jan 01 00:00:00 2024\nSubject: three\n\nlast\n';

  it('splits at start lines with exact byte offsets (multibyte content)', async () => {
    const p = write('a.mbox', MBOX);
    const recs = await all(p, 0, mboxRules());
    expect(recs).toHaveLength(3);
    const bytes = fs.readFileSync(p);
    for (const r of recs)
      expect(bytes.subarray(r.start, r.end).equals(r.raw)).toBe(true);
    expect(recs[0].start).toBe(0);
    expect(recs[1].start).toBe(recs[0].end);
    expect(recs[2].end).toBe(bytes.length);
    expect(recs[1].raw.toString()).toContain('From inside body');
  });

  it('CRLF files split the same way', async () => {
    const p = write('crlf.mbox', MBOX.replace(/\n/g, '\r\n'));
    expect(await all(p, 0, mboxRules())).toHaveLength(3);
  });

  it('reading from a record start resumes there', async () => {
    const p = write('a.mbox', MBOX);
    const [, second] = await all(p, 0, mboxRules());
    const rest = await all(p, second.start, mboxRules());
    expect(rest.map((r) => r.start)).toEqual([
      second.start,
      (await all(p, 0, mboxRules()))[2].start,
    ]);
  });

  it('a record over the cap keeps its head, is marked truncated, and the next is intact', async () => {
    const big = `From a@x 2024\nSubject: big\n\n${'x'.repeat(100)}\n`.repeat(1);
    const p = write(
      'b.mbox',
      `${big}${'y'.repeat(5000)}\n\nFrom b@x 2024\nSubject: small\n\nok\n`,
    );
    const recs = await all(p, 0, mboxRules(200));
    expect(recs).toHaveLength(2);
    expect(recs[0].truncated).toBe(true);
    expect(recs[0].raw.length).toBeLessThanOrEqual(200);
    expect(recs[0].raw.toString()).toContain('Subject: big');
    expect(recs[1].truncated).toBe(false);
    expect(recs[1].raw.toString()).toContain('Subject: small');
  });

  it('a single line longer than a chunk is read in fragments without blowing up', async () => {
    const p = write(
      'long.mbox',
      `From a@x 2024\nSubject: long\n\n${'z'.repeat(3 * 1024 * 1024)}\n\nFrom b@x 2024\n\nok\n`,
    );
    const recs = await all(p, 0, mboxRules(1024));
    expect(recs).toHaveLength(2);
    expect(recs[0].truncated).toBe(true);
    expect(recs[1].raw.toString()).toContain('ok');
  });

  it('end-marker mode ignores text between records', async () => {
    const p = write(
      'c.vcf',
      'junk\r\nBEGIN:VCARD\r\nFN:A\r\nEND:VCARD\r\nnoise\r\nBEGIN:VCARD\r\nFN:B\r\nEND:VCARD\r\n',
    );
    const recs = await all(p, 0, {
      isStart: (l) =>
        l.toString('latin1').trim().toUpperCase() === 'BEGIN:VCARD',
      isEnd: (l) => l.toString('latin1').trim().toUpperCase() === 'END:VCARD',
      maxRecordBytes: 1024,
    });
    expect(recs.map((r) => r.raw.toString())).toEqual([
      'BEGIN:VCARD\r\nFN:A\r\nEND:VCARD\r\n',
      'BEGIN:VCARD\r\nFN:B\r\nEND:VCARD\r\n',
    ]);
  });
});
