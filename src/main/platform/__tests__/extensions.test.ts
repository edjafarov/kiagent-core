/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  discoverExtensions,
  readEnabledState,
  readInstalled,
  writeEnabledState,
  writeInstalled,
} from '../extensions';

const GOOD = {
  id: 'test.basic',
  name: 'Basic',
  version: '1.0.0',
  engine: '^1.0.0',
  entry: 'index.js',
  caps: ['net'],
  contributes: { sources: ['basicsrc'] },
};

function writeExt(extDir: string, dirName: string, manifest: unknown): void {
  const dir = path.join(extDir, dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = {};');
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
}

describe('extension disk state', () => {
  let extDir: string;
  beforeEach(() => {
    extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kia-extdir-'));
  });
  afterEach(() => fs.rmSync(extDir, { recursive: true, force: true }));

  it('installed.json round-trips and defaults to []', () => {
    expect(readInstalled(extDir)).toEqual([]);
    const rec = {
      id: 'test.basic',
      version: '1.0.0',
      ref: 'file:/tmp/x',
      integrity: null,
      installedAt: '2026-07-03T00:00:00.000Z',
      origin: 'dev' as const,
    };
    writeInstalled(extDir, [rec]);
    expect(readInstalled(extDir)).toEqual([rec]);
  });

  it('state.json round-trips, defaults to {}, and is mode 0600', () => {
    expect(readEnabledState(extDir)).toEqual({});
    writeEnabledState(extDir, { 'test.basic': { enabled: false } });
    expect(readEnabledState(extDir)).toEqual({
      'test.basic': { enabled: false },
    });
    const mode = fs.statSync(path.join(extDir, 'state.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('discovers valid extensions and reports invalid ones as errors', () => {
    writeExt(extDir, 'test.basic', GOOD);
    writeExt(extDir, 'bad.one', { ...GOOD, id: 'bad.one', caps: ['teleport'] });
    fs.writeFileSync(path.join(extDir, 'installed.json'), '[]'); // files are skipped
    const found = discoverExtensions(extDir);
    expect(found).toHaveLength(2);
    const ok = found.find((f) => f.dirName === 'test.basic')!;
    expect(ok.manifest?.id).toBe('test.basic');
    expect(ok.entryAbsPath).toBe(path.join(extDir, 'test.basic', 'index.js'));
    const bad = found.find((f) => f.dirName === 'bad.one')!;
    expect(bad.manifest).toBeUndefined();
    expect(bad.error).toMatch(/invalid manifest/);
  });

  it('returns [] when the extensions dir does not exist yet', () => {
    expect(discoverExtensions(path.join(extDir, 'missing'))).toEqual([]);
  });
});
