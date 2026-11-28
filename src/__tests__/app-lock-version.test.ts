/**
 * The release hook keeps release/app/package-lock.json's version equal to
 * release/app/package.json's, so an install after a release leaves the tree
 * clean. Only the two version fields may change.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { syncAppLockVersion } from '../../scripts/app-lock-version.mjs';

function appDir(pkgVersion: string, lock: object): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kia-lock-'));
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'kiagent', version: pkgVersion }),
  );
  fs.writeFileSync(
    path.join(dir, 'package-lock.json'),
    `${JSON.stringify(lock, null, 2)}\n`,
  );
  return dir;
}

const readLock = (dir: string) =>
  JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'));

describe('syncAppLockVersion', () => {
  it('writes the package version into both lockfile version fields and nothing else', () => {
    const dir = appDir('0.138.0', {
      name: 'kiagent',
      version: '0.110.2',
      lockfileVersion: 2,
      packages: {
        '': {
          name: 'kiagent',
          version: '0.110.2',
          dependencies: { a: '^1.0.0' },
        },
        'node_modules/a': { version: '1.2.3' },
      },
      dependencies: { a: { version: '1.2.3' } },
    });

    expect(syncAppLockVersion(dir)).toBe(true);
    expect(readLock(dir)).toEqual({
      name: 'kiagent',
      version: '0.138.0',
      lockfileVersion: 2,
      packages: {
        '': {
          name: 'kiagent',
          version: '0.138.0',
          dependencies: { a: '^1.0.0' },
        },
        'node_modules/a': { version: '1.2.3' },
      },
      dependencies: { a: { version: '1.2.3' } },
    });
  });

  it('leaves an in-sync lockfile byte-identical', () => {
    const dir = appDir('1.0.0', {
      name: 'kiagent',
      version: '1.0.0',
      lockfileVersion: 2,
      packages: { '': { name: 'kiagent', version: '1.0.0' } },
    });
    const before = fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8');

    expect(syncAppLockVersion(dir)).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8')).toBe(
      before,
    );
  });
});
