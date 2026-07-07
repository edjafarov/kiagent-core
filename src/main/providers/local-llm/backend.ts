import os from 'node:os';

/** GPU/CPU acceleration backend the bundled llama-server build targets.
 *  No CUDA (Vulkan covers NVIDIA/AMD/Intel — see the design spec). */
export type Accel = 'metal' | 'vulkan' | 'cpu';

/** One GPU as reported by `llama-server --list-devices`. */
export interface VulkanDevice {
  name: string;
  /** Total device memory, or null when the probe can't read it. */
  vramBytes: number | null;
}

export interface BackendInfo {
  accel: Accel;
  /** The byte budget the tier selector should use: VRAM for a discrete GPU,
   *  system RAM for Metal/CPU/iGPU. */
  capacityBytes: number;
}

/** Pure backend decision. darwin is always Metal (capacity = unified RAM).
 *  Elsewhere a usable Vulkan device → vulkan (capacity = its VRAM when known),
 *  else cpu (capacity = system RAM). Never throws. */
export function detectBackend(platform: string, vulkanDevices: VulkanDevice[], totalMemBytes: number): BackendInfo {
  if (platform === 'darwin') {
    return { accel: 'metal', capacityBytes: totalMemBytes };
  }
  const gpu = vulkanDevices[0];
  if (gpu) {
    return {
      accel: 'vulkan',
      capacityBytes: gpu.vramBytes ?? totalMemBytes,
    };
  }
  return { accel: 'cpu', capacityBytes: totalMemBytes };
}

/** Parse `llama-server --list-devices` stdout into Vulkan devices.
 *  Lines look like `  Vulkan0: <name> (NNNN MiB, ...)`. VRAM is the first
 *  `MiB` figure on the line; absent → null. */
export function parseVulkanDevices(stdout: string): VulkanDevice[] {
  const devices: VulkanDevice[] = [];
  for (const line of stdout.split('\n')) {
    // Greedy name capture so a vendor name with its own parens (e.g.
    // "Intel(R) Arc A770") doesn't steal the trailing "(NNNN MiB)" group.
    const m = /Vulkan\d+:\s*(.+)\s*\(([^)]*)\)/.exec(line);
    if (!m) continue;
    const name = m[1].trim();
    const mib = /^[^:]*?(\d+)\s*MiB/.exec(m[2]);
    devices.push({
      name,
      vramBytes: mib ? Number(mib[1]) * 1024 ** 2 : null,
    });
  }
  return devices;
}

/** Live, best-effort, cache-at-call-site backend detection. darwin → metal
 *  immediately; otherwise try to probe for Vulkan devices via optional listDevices.
 *  Degrades to cpu on any failure.
 *
 *  Note: listDevices defaults to returning '' (no Vulkan probe). The bundled
 *  `llama-server --list-devices` spawn wiring is phase C. */
export async function detectHostBackend(
  opts?: {
    platform?: string;
    listDevices?(): Promise<string>;
  },
): Promise<BackendInfo> {
  const platform = opts?.platform ?? os.platform();
  const totalMemBytes = os.totalmem();

  if (platform === 'darwin') {
    return detectBackend(platform, [], totalMemBytes);
  }

  let vulkanOutput = '';
  if (opts?.listDevices) {
    try {
      vulkanOutput = await opts.listDevices();
    } catch {
      vulkanOutput = '';
    }
  }

  const vulkanDevices = parseVulkanDevices(vulkanOutput);
  return detectBackend(platform, vulkanDevices, totalMemBytes);
}
