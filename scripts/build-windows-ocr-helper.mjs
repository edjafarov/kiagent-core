// Usage: node scripts/build-windows-ocr-helper.mjs
// Publishes native/windows-ocr into assets/ocr/win32-<arch>/windows-ocr.exe
// (self-contained single-file .NET 8) for both win-x64 and win-arm64.
// Windows-only; requires the .NET 8 SDK (preinstalled on GitHub's
// windows-latest, or via actions/setup-dotnet). arm64 cross-compiles from an
// x64 host, so a single x64 runner produces both binaries; the runtime picks
// assets/ocr/win32-${process.arch}/ at startup and falls back to GLM-OCR when
// the arch's exe is absent.
import { existsSync, mkdirSync, statSync, readdirSync, copyFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (process.platform !== 'win32') {
  console.error(`windows-ocr only builds on win32 (got ${process.platform})`);
  process.exit(1);
}

const proj = path.join(ROOT, 'native', 'windows-ocr', 'windows-ocr.csproj');
const program = path.join(ROOT, 'native', 'windows-ocr', 'Program.cs');

// One entry per shipped arch. `arch` matches process.arch (the runtime path
// key); `rid` is the .NET runtime identifier passed to `dotnet publish`.
const TARGETS = [
  { arch: 'x64', rid: 'win-x64' },
  { arch: 'arm64', rid: 'win-arm64' },
];

// Idempotent: skip a target if its published exe is newer than both sources.
const newestSrc = Math.max(statSync(proj).mtimeMs, statSync(program).mtimeMs);

for (const { arch, rid } of TARGETS) {
  const destDir = path.join(ROOT, 'assets', 'ocr', `win32-${arch}`);
  const binary = path.join(destDir, 'windows-ocr.exe');

  if (existsSync(binary) && statSync(binary).mtimeMs >= newestSrc) {
    console.log(`windows-ocr (${arch}) already built at ${binary}`);
    continue;
  }

  const publishDir = path.join(os.tmpdir(), `windows-ocr-publish-${arch}`);
  rmSync(publishDir, { recursive: true, force: true });
  console.log(`Publishing ${proj} (${rid}) → ${publishDir}`);
  const r = spawnSync(
    'dotnet',
    [
      'publish', proj,
      '-c', 'Release',
      '-r', rid,
      '--self-contained', 'true',
      '-p:PublishSingleFile=true',
      '-o', publishDir,
    ],
    { stdio: 'inherit' },
  );
  if (r.error) {
    console.error(`dotnet not available: ${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) process.exit(r.status ?? 1);

  if (!existsSync(path.join(publishDir, 'windows-ocr.exe'))) {
    console.error(`publish (${rid}) did not produce windows-ocr.exe in ${publishDir}`);
    process.exit(1);
  }
  mkdirSync(destDir, { recursive: true });
  for (const e of readdirSync(publishDir)) {
    copyFileSync(path.join(publishDir, e), path.join(destDir, e));
  }
  console.log(`Vendored windows-ocr.exe (${arch}) into ${destDir}`);
}
