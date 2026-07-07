// Usage: node scripts/build-vision-helper.mjs
// Compiles native/vision-helper/main.swift into assets/vision/darwin-<arch>/
// kia-vision for BOTH mac arches (the mac CI runner packages arm64 + x64).
// Cross-arch builds use swiftc -target. macOS-only; requires Xcode CLT.
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (process.platform !== 'darwin') {
  console.error(`kia-vision only builds on darwin (got ${process.platform})`);
  process.exit(1);
}

const source = path.join(ROOT, 'native', 'vision-helper', 'main.swift');
// Minimum deployment target for the Vision API used by the helper.
// arm64: no -target (matches current behavior; defaults to host SDK minimum).
// x64: explicit -target for cross-compilation on arm64 runner.
const TARGETS = [
  { arch: 'arm64', triple: null },
  { arch: 'x64', triple: 'x86_64-apple-macosx11.0' },
];

for (const { arch, triple } of TARGETS) {
  const destDir = path.join(ROOT, 'assets', 'vision', `darwin-${arch}`);
  const binary = path.join(destDir, 'kia-vision');
  if (existsSync(binary) && statSync(binary).mtimeMs >= statSync(source).mtimeMs) {
    console.log(`kia-vision (${arch}) already built at ${binary}`);
    continue;
  }
  mkdirSync(destDir, { recursive: true });
  console.log(`Compiling ${source} → ${binary}${triple ? ` (target ${triple})` : ''}`);
  const swiftcArgs = ['-O'];
  if (triple) swiftcArgs.push('-target', triple);
  swiftcArgs.push('-o', binary, source);
  const r = spawnSync('swiftc', swiftcArgs, {
    stdio: 'inherit',
  });
  if (r.error) {
    console.error(`swiftc not available: ${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) process.exit(r.status ?? 1);
}
