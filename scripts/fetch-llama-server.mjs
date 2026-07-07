// Usage:
//   node scripts/fetch-llama-server.mjs                 # all slugs for this host
//   node scripts/fetch-llama-server.mjs <slug> [<slug>] # specific slug(s)
//   node scripts/fetch-llama-server.mjs --print-sha      # download host slugs, print sha256
// Downloads pinned llama.cpp release binaries into assets/llama/<slug>/.
// Idempotent per slug. Fail-closed: unknown slug or sha mismatch aborts.
import { mkdirSync, existsSync, createWriteStream, readFileSync } from 'node:fs';
import { rm, readdir, rename, copyFile, unlink, chmod, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import AdmZip from 'adm-zip';
import { LLAMA_TAG, LLAMA_ASSETS, slugsForHost, assetUrl } from './llama-assets.mjs';

const args = process.argv.slice(2);
const printSha = args.includes('--print-sha');
const slugArgs = args.filter((a) => !a.startsWith('--'));
const slugs = slugArgs.length ? slugArgs : slugsForHost(process.platform, process.arch);

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
    } else if (e.name === 'llama-server' || e.name === 'llama-server.exe') {
      return path.dirname(p);
    }
  }
  return null;
}

async function fetchSlug(slug) {
  const entry = LLAMA_ASSETS[slug];
  if (!entry) {
    console.error(`No pinned llama asset for slug "${slug}". Known: ${Object.keys(LLAMA_ASSETS).join(', ')}`);
    process.exit(1);
  }
  const { asset, sha256 } = entry;
  const destDir = path.join('assets', 'llama', slug);
  const binName = slug.startsWith('win32') ? 'llama-server.exe' : 'llama-server';
  const binary = path.join(destDir, binName);
  if (existsSync(binary) && !printSha) {
    console.log(`llama-server already vendored at ${binary}`);
    return;
  }
  mkdirSync(destDir, { recursive: true });

  const url = assetUrl(asset);
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
  const unpackDir = path.join(os.tmpdir(), `llama-${LLAMA_TAG}-${slug}`);
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
    console.error(`llama-server not found in ${asset}.`);
    process.exit(1);
  }
  for (const e of await readdir(binDir)) {
    await move(path.join(binDir, e), path.join(destDir, e));
  }
  // adm-zip drops the unix mode; ensure the binary is executable on posix.
  if (!slug.startsWith('win32')) {
    await chmod(binary, 0o755).catch(() => {});
  }
  await rm(tmp, { force: true }).catch(() => {});
  console.log(`Vendored llama-server + libs into ${destDir}`);
}

for (const slug of slugs) {
  // eslint-disable-next-line no-await-in-loop
  await fetchSlug(slug);
}
