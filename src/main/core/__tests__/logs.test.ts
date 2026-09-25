import fs from 'fs';
import os from 'os';
import path from 'path';

import { createLogs } from '../logs';

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-logs-'));
}

function readLines(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0);
}

describe('createLogs rotation', () => {
  it('rotates to .1 once the file crosses maxBytes, keeping every record in order', () => {
    const dir = mkTmpDir();
    // Each record serializes to ~78 bytes; 200 puts the cap between the 3rd
    // and 4th append, so exactly one rotation happens across all 5 records.
    const { sink } = createLogs(dir, { maxBytes: 200 });
    const file = path.join(dir, 'kiagent.log.jsonl');
    const rotated = `${file}.1`;

    for (let i = 0; i < 5; i++) {
      sink.log('test', 'info', `msg-${i}`);
    }

    expect(fs.existsSync(rotated)).toBe(true);

    const before = readLines(rotated).map(
      (l) => (JSON.parse(l) as { msg: string }).msg,
    );
    const after = readLines(file).map(
      (l) => (JSON.parse(l) as { msg: string }).msg,
    );
    const all = [...before, ...after];

    expect(all).toEqual(['msg-0', 'msg-1', 'msg-2', 'msg-3', 'msg-4']);
  });

  it('never lets the current file exceed maxBytes plus one record under many rotations', () => {
    const dir = mkTmpDir();
    // Large enough that several records accumulate between rotations (each
    // record is ~90 bytes), so the ceiling below is actually exercised
    // instead of passing trivially on an always-empty file.
    const maxBytes = 300;
    const { sink } = createLogs(dir, { maxBytes });
    const file = path.join(dir, 'kiagent.log.jsonl');

    let maxRecordBytes = 0;
    for (let i = 0; i < 200; i++) {
      const msg = `message-number-${i}`;
      const line = `${JSON.stringify({
        ts: new Date().toISOString(),
        level: 'info',
        scope: 'test',
        msg,
      })}\n`;
      maxRecordBytes = Math.max(maxRecordBytes, Buffer.byteLength(line));
      sink.log('test', 'info', msg);

      const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
      expect(size).toBeLessThanOrEqual(maxBytes + maxRecordBytes);
    }
  });

  it('rotates a pre-existing oversized file immediately on createLogs', () => {
    const dir = mkTmpDir();
    const file = path.join(dir, 'kiagent.log.jsonl');
    fs.writeFileSync(file, 'x'.repeat(200));

    createLogs(dir, { maxBytes: 100 });

    const rotated = `${file}.1`;
    expect(fs.existsSync(rotated)).toBe(true);
    expect(fs.readFileSync(rotated, 'utf8')).toBe('x'.repeat(200));
    expect(fs.existsSync(file)).toBe(false);
  });

  it('export() still returns the current file path', async () => {
    const dir = mkTmpDir();
    const { store, sink } = createLogs(dir, { maxBytes: 100 });
    sink.log('test', 'info', 'hello');

    const exported = await store.export();
    expect(exported).toBe(path.join(dir, 'kiagent.log.jsonl'));
  });
});
