// Usage:
//   node scripts/fetch-whisper-vad.mjs              # vendor the VAD model
//   node scripts/fetch-whisper-vad.mjs --print-sha  # download, print sha256
// Downloads the pinned Silero VAD model into assets/whisper/.
//
// Runs on EVERY platform, unlike fetch-whisper-cli.mjs: the model is
// platform-independent, and macOS fetches no whisper slugs at all (it builds
// the CLI from source), so anything gated on whisperSlugsForHost() would skip
// the model exactly where the meetings feature needs it.
//
// Idempotent: an existing file whose sha256 matches the pin is kept. A
// mismatch re-downloads rather than trusting whatever is on disk.
// Fail-closed: a sha mismatch on the fresh download aborts without touching
// the vendored copy (download to .tmp, verify, then rename).
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  WHISPER_VAD_MODEL,
  whisperVadModelPath,
  whisperVadModelUrl,
} from './whisper-assets.mjs';

const printSha = process.argv.slice(2).includes('--print-sha');
const dest = whisperVadModelPath();
const staging = `${dest}.tmp`;

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

if (existsSync(dest) && !printSha) {
  const have = sha256File(dest);
  if (have === WHISPER_VAD_MODEL.sha256) {
    console.log(`VAD model already vendored at ${dest}`);
    process.exit(0);
  }
  console.log(`Vendored VAD model at ${dest} does not match the pin — re-fetching (the existing file is left in place until the replacement verifies)`);
}

mkdirSync(path.dirname(dest), { recursive: true });

const url = whisperVadModelUrl();
console.log(`Downloading ${url}`);
const res = await fetch(url);
if (!res.ok) {
  console.error(`Download failed for ${WHISPER_VAD_MODEL.name}: HTTP ${res.status}`);
  process.exit(1);
}
await writeFile(staging, Buffer.from(await res.arrayBuffer()));

const got = sha256File(staging);
if (printSha) {
  console.log(`  ${WHISPER_VAD_MODEL.name}: sha256 ${got}`);
  await rm(staging, { force: true });
  process.exit(0);
}
if (got !== WHISPER_VAD_MODEL.sha256) {
  console.error(`sha256 mismatch for ${WHISPER_VAD_MODEL.name}\n  expected ${WHISPER_VAD_MODEL.sha256}\n  got      ${got}`);
  await rm(staging, { force: true });
  process.exit(1);
}

// Swap only after the sha gate passes — the vendored copy is never left
// missing or half-written.
renameSync(staging, dest);
console.log(`Vendored VAD model into ${dest}`);
