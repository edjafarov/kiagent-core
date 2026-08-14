// scripts/build-whisper.mjs
// Builds whisper-cli from source for darwin-arm64 AND darwin-x64 (cross), the
// same both-arches pattern as build-vision-helper.mjs. whisper.cpp publishes
// no runnable macOS binary (the release carries an XCFramework — a library,
// not a CLI), so macOS is a cmake build on the runner that already compiles
// two other native helpers. Requires cmake + Xcode CLT (present on
// macos-latest runners and any dev Mac with CLT).
import { existsSync, mkdirSync, rmSync, copyFileSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WHISPER_TAG, WHISPER_COMMIT } from './whisper-assets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (process.platform !== 'darwin') {
  console.error(`build-whisper only runs on darwin (got ${process.platform})`);
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.error) {
    console.error(`${cmd} failed to launch: ${r.error.message}`);
    if (r.error.code === 'ENOENT' && cmd === 'cmake') {
      console.error('cmake is required to build whisper-cli from source. Install it (e.g. `brew install cmake` on macOS) and re-run.');
    }
    process.exit(1);
  }
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const TARGETS = [
  { arch: 'arm64', osxArch: 'arm64' },
  { arch: 'x64', osxArch: 'x86_64' },
];

const todo = TARGETS.filter(({ arch }) =>
  !existsSync(path.join(ROOT, 'assets', 'whisper', `darwin-${arch}`, 'whisper-cli')));
if (todo.length === 0) {
  console.log('whisper-cli already built for both darwin arches');
  process.exit(0);
}

// Shallow-clone the pinned tag and verify the commit — the source build must
// be as pinned as the sha256'd archives.
const src = path.join(os.tmpdir(), `whisper-cpp-${WHISPER_TAG}`);
if (!existsSync(path.join(src, 'CMakeLists.txt'))) {
  rmSync(src, { recursive: true, force: true });
  run('git', ['clone', '--depth', '1', '--branch', WHISPER_TAG,
    'https://github.com/ggml-org/whisper.cpp.git', src]);
}
const head = spawnSync('git', ['-C', src, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
if (head.stdout?.trim() !== WHISPER_COMMIT) {
  console.error(`whisper checkout is ${head.stdout?.trim()}, expected ${WHISPER_COMMIT}`);
  process.exit(1);
}

for (const { arch, osxArch } of todo) {
  const destDir = path.join(ROOT, 'assets', 'whisper', `darwin-${arch}`);
  const binary = path.join(destDir, 'whisper-cli');
  const buildDir = path.join(src, `build-${arch}`);
  console.log(`Building whisper-cli (${arch})`);
  run('cmake', ['-B', buildDir, '-S', src,
    '-DCMAKE_BUILD_TYPE=Release',
    '-DBUILD_SHARED_LIBS=OFF',            // one self-contained binary — nothing to vendor beside it
    '-DWHISPER_METAL_EMBED_LIBRARY=ON',   // Metal shader baked in: no .metallib to ship (spec §1)
    '-DWHISPER_BUILD_TESTS=OFF',
    `-DCMAKE_OSX_ARCHITECTURES=${osxArch}`,
    // GGML_NATIVE=OFF on BOTH arches, deliberately, not just the x64 cross
    // build: these binaries are vendored into an installer and run on
    // strangers' Macs, never on the machine that built them. Left ON,
    // ggml resolves -march=native from the BUILD host. On x64 (cross from
    // an arm64 host — the dev machine and every macos-latest CI runner)
    // that bakes in an Apple Silicon CPU name clang rejects outright
    // ("unknown target CPU 'apple-m3'"). On arm64 it doesn't error — it
    // silently succeeds and bakes in whatever the builder's chip supports
    // (e.g. SME on an M3/M4 runner), which can fault as an illegal
    // instruction on an end user's older M1/M2. That failure mode only
    // reproduces on hardware neither the builder nor CI is testing on, so
    // it must be prevented at the flag, not caught after the fact. Metal
    // (WHISPER_METAL_EMBED_LIBRARY above) carries the compute on macOS
    // regardless, and ARMv8 baseline still gives NEON — portability wins
    // here. Do not "optimise" this back to GGML_NATIVE=ON.
    '-DGGML_NATIVE=OFF',
  ]);
  run('cmake', ['--build', buildDir, '--config', 'Release', '--target', 'whisper-cli', '-j']);
  mkdirSync(destDir, { recursive: true });
  copyFileSync(path.join(buildDir, 'bin', 'whisper-cli'), binary);
  chmodSync(binary, 0o755);
  // Smoke gate (vendor-ships-inert guard): the host-native binary must run.
  // The cross-built x64 binary is smoke-run only when Rosetta can execute it;
  // a launch failure there is fatal too — better a red build than an inert one.
  const smoke = spawnSync(binary, ['-h'], { stdio: 'ignore' });
  if (arch === (process.arch === 'arm64' ? 'arm64' : 'x64')) {
    if (smoke.error || smoke.status !== 0) {
      console.error(`whisper-cli (${arch}) smoke run failed`);
      process.exit(1);
    }
  }
}
