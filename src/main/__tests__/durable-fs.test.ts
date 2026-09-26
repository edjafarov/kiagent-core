/** @jest-environment node */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncDirectory } from '../durable-fs';

describe('syncDirectory', () => {
  const missing = path.join(os.tmpdir(), `kia-no-such-dir-${process.pid}`);

  it('opens and flushes the directory on POSIX', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kia-durable-fs-'));
    try {
      expect(() => syncDirectory(dir, 'darwin')).not.toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    // Proof it really opens the directory there.
    expect(() => syncDirectory(missing, 'linux')).toThrow(/ENOENT/);
  });

  it('never opens the directory on Windows, which cannot flush one', () => {
    expect(() => syncDirectory(missing, 'win32')).not.toThrow();
  });
});
