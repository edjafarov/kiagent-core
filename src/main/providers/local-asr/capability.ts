import fs from 'node:fs';

export interface AsrCapabilityResult {
  ok: boolean;
  reason?: 'no_binary';
}

/** ASR capability = the vendored whisper-cli exists for this platform-arch.
 *  A platform-arch with no vendored assets/whisper/<slug>/ dir (e.g. linux
 *  arm64) is unsupported — the missing binary IS the platform gate. */
export function checkAsrCapability(
  binaryPath: string,
  exists: (p: string) => boolean = fs.existsSync,
): AsrCapabilityResult {
  return exists(binaryPath) ? { ok: true } : { ok: false, reason: 'no_binary' };
}
