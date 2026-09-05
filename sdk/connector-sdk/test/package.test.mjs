import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sdkRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => JSON.parse(readFileSync(join(sdkRoot, f), 'utf8'));
const pkg = read('package.json');
const lock = read('package-lock.json');

// Nothing is ever installed in this package — it has no node_modules and
// borrows core's toolchain off the ancestor `node_modules/.bin` on PATH — so
// npm never rewrites the lockfile and never syncs its version fields. SDK
// 1.1.0 was cut with a lockfile still claiming 1.0.0 for exactly that reason.
// Both fields are hand-maintained; pin them to package.json here.
test('package-lock.json version matches package.json', () => {
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
});

// Release notes interpolate this field (`scripts/release.sh`). Nothing
// validates that a core release by that name exists — this only pins the
// shape, so a stray "0.84" or "next" cannot reach a published release note.
test('kiagentCore names a concrete x.y.z core version', () => {
  assert.match(pkg.kiagentCore, /^\d+\.\d+\.\d+$/);
});
