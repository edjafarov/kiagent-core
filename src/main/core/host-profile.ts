import os from 'node:os';

/** Acceleration backend of the local model server. */
export type LlmAccel = 'metal' | 'vulkan' | 'cpu';

/** Immutable hardware facts, read once at boot. The ONLY place core reads
 *  `os` for hardware; providers and workers receive these via deps. */
export interface HostFacts {
  platform: NodeJS.Platform;
  arch: string;
  /** LOGICAL cores (os.availableParallelism). */
  cores: number;
  totalMemBytes: number;
}

/** Derived, pure. #146 sizes its read connection and #147 its admission
 *  limit from here — not from their own `os` reads. */
export interface HostBudget {
  weak: boolean;
  backgroundThreads: number;
}

export const WEAK_MAX_CORES = 4;
/** 8 GiB and below: a resident local model plus first-sync parsing swaps. */
export const WEAK_MAX_MEM_BYTES = 8 * 1024 ** 3;

export function readHostFacts(probes: Partial<HostFacts> = {}): HostFacts {
  const cores =
    probes.cores ??
    (typeof os.availableParallelism === 'function'
      ? os.availableParallelism()
      : os.cpus().length);
  return {
    platform: probes.platform ?? process.platform,
    arch: probes.arch ?? process.arch,
    cores,
    totalMemBytes: probes.totalMemBytes ?? os.totalmem(),
  };
}

/** `accel` null = not detected yet: Metal on darwin, CPU elsewhere (there is
 *  no production Vulkan probe yet, so every non-Mac is weak until one ships).
 *  `KIA_HOST_WEAK=1|0` overrides `weak` for testing. */
export function hostBudget(
  f: HostFacts,
  accel: LlmAccel | null,
  env: NodeJS.ProcessEnv = process.env,
): HostBudget {
  const onCpu = accel === 'cpu' || (accel === null && f.platform !== 'darwin');
  let weak =
    f.cores <= WEAK_MAX_CORES || f.totalMemBytes <= WEAK_MAX_MEM_BYTES || onCpu;
  if (env.KIA_HOST_WEAK === '1') weak = true;
  else if (env.KIA_HOST_WEAK === '0') weak = false;
  return { weak, backgroundThreads: Math.max(1, Math.floor(f.cores / 2)) };
}

/** One boot log line. At boot `accel` is unknown (detected lazily). */
export function describeHost(
  f: HostFacts,
  accel: LlmAccel | null,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const gb = (f.totalMemBytes / 1024 ** 3).toFixed(1);
  const b = hostBudget(f, accel, env);
  return `cores=${f.cores} mem=${gb}GB platform=${f.platform}-${f.arch} accel=${accel ?? 'unknown'} weak=${b.weak} backgroundThreads=${b.backgroundThreads}`;
}
