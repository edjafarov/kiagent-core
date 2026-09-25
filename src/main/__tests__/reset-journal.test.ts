import fs from 'fs';
import os from 'os';
import path from 'path';

import { RESET_JOURNAL_FILE, createResetJournal } from '../reset-journal';

describe('reset journal (alpha-cent#192)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kia-reset-journal-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('is pending from begin() until end(), on disk, for the next process to see', () => {
    const journal = createResetJournal(dir);
    expect(journal.pending()).toBe(false);

    journal.begin();
    expect(createResetJournal(dir).pending()).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([RESET_JOURNAL_FILE]); // no temp file
    expect(
      JSON.parse(fs.readFileSync(path.join(dir, RESET_JOURNAL_FILE), 'utf8')),
    ).toEqual({ startedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) });

    journal.end();
    expect(createResetJournal(dir).pending()).toBe(false);
  });

  it('begins in a data directory that does not exist yet, and ends when nothing is pending', () => {
    const journal = createResetJournal(path.join(dir, 'data'));
    expect(() => journal.end()).not.toThrow();
    journal.begin();
    expect(journal.pending()).toBe(true);
  });

  it('flushes the record before it is in place', () => {
    const fsync = jest.spyOn(fs, 'fsyncSync');
    const rename = jest.spyOn(fs, 'renameSync');
    createResetJournal(dir).begin();
    expect(fsync.mock.invocationCallOrder[0]).toBeLessThan(
      rename.mock.invocationCallOrder[0],
    );
    fsync.mockRestore();
    rename.mockRestore();
  });
});
