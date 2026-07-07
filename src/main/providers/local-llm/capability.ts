import os from 'node:os';

/** CPU-only floor: below ~8 GB a 0.9B GLM-OCR + any VLM thrashes. Single
 *  tunable, like the old MIN_RAM_BYTES but scoped to CPU hosts. */
export const CPU_MIN_RAM_BYTES = 8 * 1024 ** 3;

export interface HostProbes {
  platform: string;
  arch: string;
  totalMemBytes: number;
}

export interface CapabilityResult {
  ok: boolean;
  slow?: boolean;
  reason?: string;
}

/** Read the live host probes for platform/arch/RAM. Backend (accel) is
 *  detected separately and asynchronously via detectHostBackend. */
export function readHostProbes(): HostProbes {
  return {
    platform: os.platform(),
    arch: os.arch(),
    totalMemBytes: os.totalmem(),
  };
}

/** Pure capability decision. darwin (Metal GPU) always passes. Non-darwin hosts
 *  are assumed CPU-only for conservative capability check: must meet 8 GB floor.
 *  CPU hosts pass but are flagged `slow`. */
export function checkCapability(probes?: HostProbes): CapabilityResult {
  const p = probes ?? readHostProbes();

  // darwin has Metal GPU, always capable
  if (p.platform === 'darwin') {
    return { ok: true };
  }

  // Non-darwin (assume CPU-only): need 8 GB minimum
  if (p.totalMemBytes < CPU_MIN_RAM_BYTES) {
    return {
      ok: false,
      slow: true,
      reason: 'insufficient_ram',
    };
  }

  // CPU host meets minimum RAM threshold, but mark as slow
  return {
    ok: true,
    slow: true,
  };
}
