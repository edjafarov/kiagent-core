import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** The vendored llama-server builds for this host (scripts/llama-assets.mjs
 *  `slugsForHost`). darwin ships one Metal build under the bare
 *  `${platform}-${arch}` slug; win32/linux ship accel-suffixed builds
 *  (`-vulkan`, `-cpu`; win32-arm64 is cpu only). A slot is null when that
 *  build isn't on disk. */
export interface LlamaBinaries {
  /** The GPU build: Metal on darwin, Vulkan elsewhere. */
  gpu: string | null;
  /** The CPU-only build (win32/linux). */
  cpu: string | null;
}

export function resolveLlamaBinaries(
  llamaDir: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  exists: (p: string) => boolean = fs.existsSync,
): LlamaBinaries {
  const bin = platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  const at = (slug: string): string | null => {
    const p = path.join(llamaDir, slug, bin);
    return exists(p) ? p : null;
  };
  if (platform === 'darwin')
    return { gpu: at(`${platform}-${arch}`), cpu: null };
  return {
    gpu: at(`${platform}-${arch}-vulkan`),
    cpu: at(`${platform}-${arch}-cpu`),
  };
}

/** `llama-server --list-devices` output for Vulkan detection (backend.ts
 *  parses it). Rejects on a spawn failure or timeout; the caller degrades to
 *  cpu. */
export function listLlamaDevices(
  binaryPath: string,
  timeoutMs = 15_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      binaryPath,
      ['--list-devices'],
      { timeout: timeoutMs, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) reject(err);
        else resolve(`${stdout}\n${stderr}`);
      },
    );
  });
}
