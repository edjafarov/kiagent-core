// scripts/build-whisper.mjs
// Builds whisper-cli from source for darwin-arm64 AND darwin-x64 (cross), the
// same both-arches pattern as build-vision-helper.mjs. whisper.cpp publishes
// no runnable macOS binary (the release carries an XCFramework — a library,
// not a CLI), so macOS is a cmake build on the runner that already compiles
// two other native helpers. Requires cmake + Xcode CLT (present on
// macos-latest runners and any dev Mac with CLT).
import { existsSync, mkdirSync, rmSync, copyFileSync, chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WHISPER_TAG, WHISPER_COMMIT, WHISPER_DARWIN_SLUGS, whisperDir } from './whisper-assets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TAG_STAMP = '.whisper-tag';

if (process.platform !== 'darwin') {
  console.error(`build-whisper only runs on darwin (got ${process.platform})`);
  process.exit(1);
}

function hint(cmd) {
  if (cmd === 'cmake') return 'cmake is required to build whisper-cli from source. Install it (e.g. `brew install cmake` on macOS) and re-run.';
  if (cmd === 'git') return 'git is required to build whisper-cli from source. Install it (e.g. via Xcode Command Line Tools: `xcode-select --install`) and re-run.';
  return null;
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.error) {
    console.error(`${cmd} failed to launch: ${r.error.message}`);
    if (r.error.code === 'ENOENT') {
      const h = hint(cmd);
      if (h) console.error(h);
    }
    process.exit(1);
  }
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// osxArch (the -DCMAKE_OSX_ARCHITECTURES value) per arch — derived alongside
// WHISPER_DARWIN_SLUGS rather than hardcoded here, so the accel-less-slug
// contract test covering WHISPER_DARWIN_SLUGS also covers what this script
// actually builds: adding a slug there without a matching entry here fails
// fast instead of quietly building nothing for it.
const OSX_ARCH = { arm64: 'arm64', x64: 'x86_64' };
const TARGETS = WHISPER_DARWIN_SLUGS.map((slug) => {
  const arch = slug.replace(/^darwin-/, '');
  const osxArch = OSX_ARCH[arch];
  if (!osxArch) throw new Error(`build-whisper.mjs has no -DCMAKE_OSX_ARCHITECTURES mapping for slug "${slug}"`);
  return { arch, osxArch, destDir: path.join(ROOT, whisperDir(slug)) };
});

// Idempotency is keyed on a `.whisper-tag` stamp (tag + verified commit), not
// just binary existence: a WHISPER_TAG bump must trigger a rebuild rather
// than silently keep serving a stale vendored binary from a previous tag.
function isCurrent(destDir) {
  const binary = path.join(destDir, 'whisper-cli');
  const stampPath = path.join(destDir, TAG_STAMP);
  if (!existsSync(binary) || !existsSync(stampPath)) return false;
  const [tag, commit] = readFileSync(stampPath, 'utf8').trim().split('\n');
  return tag === WHISPER_TAG && commit === WHISPER_COMMIT;
}

const todo = TARGETS.filter(({ destDir }) => !isCurrent(destDir));
if (todo.length === 0) {
  console.log(`whisper-cli already built for both darwin arches (${WHISPER_TAG})`);
  process.exit(0);
}
for (const { arch, destDir } of todo) {
  if (existsSync(destDir)) {
    console.log(`Vendored whisper-cli (${arch}) at ${destDir} is stale or unstamped — rebuilding for ${WHISPER_TAG}`);
    rmSync(destDir, { recursive: true, force: true });
  }
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
if (head.error) {
  console.error(`git failed to launch: ${head.error.message}`);
  if (head.error.code === 'ENOENT') console.error(hint('git'));
  process.exit(1);
}
if (head.stdout?.trim() !== WHISPER_COMMIT) {
  console.error(`whisper checkout is ${head.stdout?.trim()}, expected ${WHISPER_COMMIT}`);
  process.exit(1);
}

for (const { arch, osxArch, destDir } of todo) {
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

  // Architecture gate (vendor-ships-inert guard, UNCONDITIONAL — runs for
  // both arches regardless of which one this host is): verifies the produced
  // Mach-O actually matches what we asked cmake to cross-compile, rather than
  // silently matching the build host. This is exactly the failure class that
  // broke this task once already (the x64 cross-build picking up the ARM
  // build host's native CPU) — a bad cross-build must fail here even when
  // the wrong-arch binary happens to still run.
  const archCheck = spawnSync('lipo', ['-archs', binary], { encoding: 'utf8' });
  const reportedArch = archCheck.stdout?.trim();
  if (archCheck.status !== 0 || reportedArch !== osxArch) {
    console.error(`whisper-cli (${arch}) architecture check failed: expected '${osxArch}', lipo reported '${reportedArch || archCheck.stderr?.trim() || archCheck.error?.message}'`);
    process.exit(1);
  }

  // Smoke gate (vendor-ships-inert guard): the binary must actually run
  // wherever it CAN run. A launch that starts and exits non-zero is fatal on
  // BOTH arches — coverage must not depend on whether Rosetta happens to be
  // installed on the build machine. The only tolerated outcome for the
  // non-host arch is a spawn error meaning this host cannot execute that
  // architecture at all (e.g. ENOEXEC without Rosetta); the architecture
  // gate above already proved the binary is the right shape in that case.
  const smoke = spawnSync(binary, ['-h'], { stdio: 'ignore' });
  const hostNative = arch === process.arch;
  if (smoke.error) {
    if (hostNative) {
      console.error(`whisper-cli (${arch}) smoke run failed to launch: ${smoke.error.message}`);
      process.exit(1);
    }
    console.log(`whisper-cli (${arch}) did not launch on this host (${smoke.error.code ?? smoke.error.message}) — expected without Rosetta for a non-native arch; architecture verified above.`);
  } else if (smoke.status !== 0) {
    console.error(`whisper-cli (${arch}) smoke run failed (exit ${smoke.status})`);
    process.exit(1);
  } else {
    console.log(`whisper-cli (${arch}) smoke run OK`);
  }

  // Version stamp (written last, only once every gate above has passed): the
  // idempotency check above keys off this file, not binary existence, so a
  // WHISPER_TAG bump rebuilds instead of silently keeping a stale binary.
  writeFileSync(path.join(destDir, TAG_STAMP), `${WHISPER_TAG}\n${WHISPER_COMMIT}\n`);
}
