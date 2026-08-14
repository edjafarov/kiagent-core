// Usage:
//   node scripts/fetch-whisper-cli.mjs                 # all slugs for this host
//   node scripts/fetch-whisper-cli.mjs <slug> [<slug>] # specific slug(s)
//   node scripts/fetch-whisper-cli.mjs --print-sha      # download host slugs, print sha256
// Downloads pinned whisper.cpp release binaries into assets/whisper/<slug>/.
// Idempotent per slug, keyed on a `.whisper-tag` stamp file (not just binary
// existence) — a WHISPER_TAG bump must re-vendor rather than silently keep
// serving a stale binary that happens to already be on disk.
// Fail-closed: unknown slug or sha mismatch aborts.
// A clean no-op on darwin (whisperSlugsForHost returns [] there — see
// build-whisper.mjs, which builds macOS from source instead).
//
// Mirrors fetch-llama-server.mjs's download/sha/extract/move helpers
// (duplicated rather than shared, so the two scripts stay independently
// runnable), with these differences:
//   - dest dir assets/whisper/<slug>/, binary whisper-cli[.exe]
//   - the release archive also ships whisper-server* (a resident HTTP
//     server) and other example binaries (main, bench, quantize, stream,
//     …); only whisper-cli* plus shared libs are kept — spec §2 deliberately
//     does not ship the resident server.
//   - smoke gate: run the fetched binary with `-h` when the slug matches the
//     host, since a cross-fetched foreign-arch binary can't run here.
import { mkdirSync, existsSync, createWriteStream, readFileSync, writeFileSync } from 'node:fs';
import { rm, readdir, rename, copyFile, unlink, chmod } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import AdmZip from 'adm-zip';
import { WHISPER_TAG, WHISPER_ASSETS, whisperSlugsForHost, whisperAssetUrl, whisperDir } from './whisper-assets.mjs';

const TAG_STAMP = '.whisper-tag';

const args = process.argv.slice(2);
const printSha = args.includes('--print-sha');
const slugArgs = args.filter((a) => !a.startsWith('--'));
const slugs = slugArgs.length ? slugArgs : whisperSlugsForHost(process.platform, process.arch);

if (slugs.length === 0) {
  console.log('No whisper-cli slugs to fetch for this host (darwin builds from source — see build-whisper.mjs).');
  process.exit(0);
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

async function move(from, to) {
  try {
    await rename(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    await copyFile(from, to);
    await unlink(from);
  }
}

async function findBin(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const hit = await findBin(p);
      if (hit) return hit;
    } else if (e.name === 'whisper-cli' || e.name === 'whisper-cli.exe') {
      return path.dirname(p);
    }
  }
  return null;
}

// Keep whisper-cli* plus shared libraries; drop whisper-server* (the resident
// server — deliberately not shipped, spec §2) and the other example binaries
// (main, bench, quantize, stream, …).
function shouldVendor(name) {
  if (name.startsWith('whisper-server')) return false;
  if (name.startsWith('whisper-cli')) return true;
  if (/\.(so|dll|dylib)(\.|$)/.test(name)) return true;
  return false;
}

async function fetchSlug(slug) {
  const entry = WHISPER_ASSETS[slug];
  if (!entry) {
    console.error(`No pinned whisper asset for slug "${slug}". Known: ${Object.keys(WHISPER_ASSETS).join(', ')}`);
    process.exit(1);
  }
  const { asset, sha256 } = entry;
  const destDir = whisperDir(slug);
  const binName = slug.startsWith('win32') ? 'whisper-cli.exe' : 'whisper-cli';
  const binary = path.join(destDir, binName);
  const stampPath = path.join(destDir, TAG_STAMP);
  const stampCurrent = existsSync(stampPath) && readFileSync(stampPath, 'utf8').trim() === WHISPER_TAG;
  if (existsSync(binary) && stampCurrent && !printSha) {
    console.log(`whisper-cli already vendored at ${binary} (${WHISPER_TAG})`);
    return;
  }
  if (existsSync(destDir) && !stampCurrent) {
    console.log(`Vendored whisper-cli at ${destDir} is stale or unstamped — re-vendoring for ${WHISPER_TAG}`);
    await rm(destDir, { recursive: true, force: true });
  }
  mkdirSync(destDir, { recursive: true });

  const url = whisperAssetUrl(asset);
  const tmp = path.join(os.tmpdir(), asset);
  console.log(`Downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`Download failed for ${asset}: HTTP ${res.status}`);
    process.exit(1);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));

  const got = sha256File(tmp);
  if (printSha) {
    console.log(`  '${slug}': sha256 ${got}`);
  } else if (sha256 && got !== sha256) {
    console.error(`sha256 mismatch for ${asset}\n  expected ${sha256}\n  got      ${got}`);
    process.exit(1);
  }

  console.log('Extracting…');
  const unpackDir = path.join(os.tmpdir(), `whisper-${WHISPER_TAG}-${slug}`);
  await rm(unpackDir, { recursive: true, force: true });
  mkdirSync(unpackDir, { recursive: true });
  if (asset.endsWith('.zip')) {
    new AdmZip(tmp).extractAllTo(unpackDir, /* overwrite */ true);
  } else {
    const r = spawnSync('tar', ['-xzf', tmp, '-C', unpackDir], { stdio: 'inherit' });
    if (r.status !== 0) process.exit(r.status ?? 1);
  }

  const binDir = await findBin(unpackDir);
  if (!binDir) {
    console.error(`whisper-cli not found in ${asset}.`);
    process.exit(1);
  }
  for (const e of await readdir(binDir)) {
    if (!shouldVendor(e)) continue;
    await move(path.join(binDir, e), path.join(destDir, e));
  }
  // Post-move existence gate (vendor-ships-inert guard): if upstream renamed
  // the CLI, or shouldVendor() over-filters against a future archive layout,
  // fail loudly here rather than logging "Vendored" over an empty directory
  // — on a non-native slug the smoke gate below never runs, so this is the
  // only check standing between a layout change and a silent exit 0.
  if (!existsSync(binary)) {
    console.error(`whisper-cli not vendored — expected ${binary} after moving ${asset}'s contents. shouldVendor()/findBin() likely need updating for this archive's layout.`);
    process.exit(1);
  }
  // adm-zip drops the unix mode; ensure the binary is executable on posix.
  if (!slug.startsWith('win32')) {
    await chmod(binary, 0o755).catch(() => {});
  }
  await rm(tmp, { force: true }).catch(() => {});
  console.log(`Vendored whisper-cli + libs into ${destDir}`);

  // Smoke gate (vendor-ships-inert guard): only runnable when the fetched
  // slug is native to this host — a cross-fetched foreign-arch binary can't
  // execute here, so we skip the run rather than fail on it.
  if (slug === `${process.platform}-${process.arch}`) {
    const smoke = spawnSync(binary, ['-h'], { stdio: 'ignore' });
    if (smoke.error || smoke.status !== 0) {
      console.error(`whisper-cli (${slug}) smoke run failed`);
      process.exit(1);
    }
    console.log(`whisper-cli (${slug}) smoke run OK`);
  } else {
    console.log(`whisper-cli (${slug}) is not native to this host (${process.platform}-${process.arch}) — skipping smoke run`);
  }

  // Version stamp (written last, only once every gate above has passed):
  // the idempotency check at the top of this function keys off this file,
  // not binary existence, so a WHISPER_TAG bump re-vendors instead of
  // silently keeping a stale binary that happens to already be on disk.
  writeFileSync(stampPath, `${WHISPER_TAG}\n`);
}

for (const slug of slugs) {
  // eslint-disable-next-line no-await-in-loop
  await fetchSlug(slug);
}
