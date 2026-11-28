// scripts/app-lock-version.mjs
// release-it's bumper writes the new version into release/app/package.json
// but not into its lockfile, so every `npm install` (electron-builder
// install-app-deps) rewrote the lockfile's version and left the tree dirty.
// sync-app-lock-version.mjs runs this as release-it's after:bump hook: it
// copies the version into the lockfile's two version fields and touches
// nothing else — no npm, no network, no dependency resolution.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Returns true when the lockfile changed. */
export function syncAppLockVersion(appDir) {
  const pkg = JSON.parse(
    readFileSync(path.join(appDir, 'package.json'), 'utf8'),
  );
  const lockPath = path.join(appDir, 'package-lock.json');
  const before = readFileSync(lockPath, 'utf8');
  const lock = JSON.parse(before);
  lock.version = pkg.version;
  if (lock.packages && lock.packages['']) {
    lock.packages[''].version = pkg.version;
  }
  const after = `${JSON.stringify(lock, null, 2)}\n`;
  if (after === before) return false;
  writeFileSync(lockPath, after);
  return true;
}
