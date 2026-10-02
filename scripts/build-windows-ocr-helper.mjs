// Usage: node scripts/build-windows-ocr-helper.mjs
// Publishes native/windows-ocr into assets/ocr/win32-<arch>/windows-ocr.exe
// (self-contained single-file .NET 10) for both win-x64 and win-arm64.
// Requires the .NET 10 SDK; runs on win32 and on the linux docker leg
// (cross-publish: EnableWindowsTargeting pulls the WinRT projection as a
// NuGet reference package). One host produces both arches; the runtime picks
// assets/ocr/win32-${process.arch}/ at startup.
import { existsSync, mkdirSync, statSync, readdirSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
      '-p:EnableWindowsTargeting=true',
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
  // A wrong-arch or non-PE output must fail here, not at the installer gate.
  const pe = readFileSync(path.join(publishDir, 'windows-ocr.exe'));
  const off = pe.readUInt32LE(0x3c);
  const machine = pe.readUInt16LE(off + 4);
  const want = { x64: 0x8664, arm64: 0xaa64 }[arch];
  if (pe.toString('latin1', off, off + 4) !== 'PE\0\0' || machine !== want) {
    console.error(`windows-ocr (${arch}) is not a PE ${arch} binary`);
    process.exit(1);
  }
  mkdirSync(destDir, { recursive: true });
  for (const e of readdirSync(publishDir)) {
    copyFileSync(path.join(publishDir, e), path.join(destDir, e));
  }
  console.log(`Vendored windows-ocr.exe (${arch}) into ${destDir}`);
}
