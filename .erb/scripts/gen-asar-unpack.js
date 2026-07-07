/**
 * Regenerate build.asarUnpack from the @chainsafe/libp2p-yamux dependency tree.
 *
 * Why: the remote-mcp tunnel loads yamux (and its ESM-only transitive deps:
 * uint8arrays, @libp2p/*, @multiformats/*, it-*, …) via a runtime dynamic
 * `import()` (see src/main/remote-mcp/tunnel/yamux-factory.ts). Node's ESM
 * resolver cannot honour those packages' package.json `imports`/`exports`
 * subpath maps from inside an `app.asar` archive, so they MUST be unpacked.
 * This walks the closure and writes one recursive unpack glob per package.
 *
 * Run after any dependency bump that could change yamux's tree:
 *   node .erb/scripts/gen-asar-unpack.js          # print + diff against package.json
 *   node .erb/scripts/gen-asar-unpack.js --write  # update package.json in place
 *
 * `--write` exits non-zero if it changed anything, so CI can gate on a stale list.
 */
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');
// Prefer the packaged app's node_modules (what electron-builder ships), fall
// back to the repo root so this works before `release/app` is installed.
const roots = [
  path.join(repoRoot, 'release', 'app', 'node_modules'),
  path.join(repoRoot, 'node_modules'),
].filter((d) => fs.existsSync(d));

const ENTRY = '@chainsafe/libp2p-yamux';
const NATIVE_GLOB = '**/*.{node,dll}';

function readPkg(name) {
  for (const root of roots) {
    const p = path.join(root, name, 'package.json');
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  }
  return null;
}

const seen = new Set();
(function walk(name) {
  if (seen.has(name)) return;
  const pkg = readPkg(name);
  if (!pkg) return; // optional/peer dep not installed — skip
  seen.add(name);
  for (const dep of Object.keys(pkg.dependencies || {})) walk(dep);
})(ENTRY);

if (!seen.size) {
  console.error(
    `Could not resolve ${ENTRY}; run \`npm i\` (and in release/app) first.`,
  );
  process.exit(2);
}

const globs = [NATIVE_GLOB, ...[...seen].sort().map((n) => `**/${n}/**`)];

const pkgJsonPath = path.join(repoRoot, 'package.json');
const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
const current = pkgJson.build.asarUnpack;
const same = JSON.stringify(current) === JSON.stringify(globs);

if (process.argv.includes('--write')) {
  if (same) {
    console.log('asarUnpack already up to date.');
    process.exit(0);
  }
  pkgJson.build.asarUnpack = globs;
  fs.writeFileSync(pkgJsonPath, `${JSON.stringify(pkgJson, null, 2)}\n`);
  console.log(`Updated build.asarUnpack (${globs.length} globs).`);
  process.exit(1); // signal "changed" for CI
} else {
  console.log(JSON.stringify(globs, null, 2));
  if (!same) {
    console.error(
      '\npackage.json build.asarUnpack is STALE — run with --write.',
    );
    process.exit(1);
  }
  console.log('\npackage.json build.asarUnpack is up to date.');
}
