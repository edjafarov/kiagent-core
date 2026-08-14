import fs from 'node:fs';

export interface AsrCapabilityResult {
  ok: boolean;
  reason?: 'no_binary';
}

/** ASR capability = the vendored whisper-cli exists for this platform-arch.
 *  win32-arm64 has no upstream build, so no assets/whisper/win32-arm64/ dir
 *  is ever vendored — the missing binary IS the platform gate (spec §1). */
export function checkAsrCapability(
  binaryPath: string,
  exists: (p: string) => boolean = fs.existsSync,
): AsrCapabilityResult {
  return exists(binaryPath) ? { ok: true } : { ok: false, reason: 'no_binary' };
}
