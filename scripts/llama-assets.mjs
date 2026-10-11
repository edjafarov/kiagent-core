// scripts/llama-assets.mjs
// Single source of truth for the vendored llama.cpp binaries. The slug keys
// MUST match catalog.ts's llamaSlug() output — pinned by
// src/__tests__/llama-slug-contract.test.ts. Bump LLAMA_TAG deliberately and
// re-run `node scripts/fetch-llama-server.mjs --print-sha` to refresh shas.
export const LLAMA_TAG = 'b11555';

/** slug → { asset (release archive filename), sha256 (null until pinned) }.
 *  win32-arm64 ships CPU-only: the runtime degrades arm64 Windows to cpu
 *  (b11555 does publish a win-arm64 Vulkan archive; we don't vendor it), so win32-arm64-vulkan is never asked
 *  for. */
export const LLAMA_ASSETS = {
  'darwin-arm64': { asset: `llama-${LLAMA_TAG}-bin-macos-arm64.tar.gz`, sha256: '8ae54aa7abc4e08e3c8d8e6bb0b42f5829dc65f260f2c81d88622d40c3cb135e' },
  'darwin-x64': { asset: `llama-${LLAMA_TAG}-bin-macos-x64.tar.gz`, sha256: 'be8b7b97547df38e76a9037770f7092cf78ddfb2f38122215fc3cfa9e7362f3e' },
  'win32-x64-vulkan': { asset: `llama-${LLAMA_TAG}-bin-win-vulkan-x64.zip`, sha256: '195a4646e15c3c1d8ecfe76bd5b69c48f92c4d0c1c8e6a7862fa6f81fb444e3b' },
  'win32-x64-cpu': { asset: `llama-${LLAMA_TAG}-bin-win-cpu-x64.zip`, sha256: 'a3ccec67b19ed8c9bf1fcb95e5e111ee1a275021e3b37cf4758f5934fd7c44ba' },
  'win32-arm64-cpu': { asset: `llama-${LLAMA_TAG}-bin-win-cpu-arm64.zip`, sha256: 'c631128c577c2ed4930502e1b360b16ff8f444771b0a45ad0681b8470f9d0466' },
  'linux-x64-vulkan': { asset: `llama-${LLAMA_TAG}-bin-ubuntu-vulkan-x64.tar.gz`, sha256: '8ce0c8724bec75417adca5b5ef74241b858c1d8baba75336d9b8e787738d9527' },
  'linux-x64-cpu': { asset: `llama-${LLAMA_TAG}-bin-ubuntu-x64.tar.gz`, sha256: '99ff3b3e8b406056130857b09505aba3906aba181cd6dca482230242586523df' },
};

/** Which slugs a given CI runner must vendor, matching electron-builder's
 *  per-platform targets (mac: arm64+x64; win: x64 + arm64 nsis; linux: x64). */
export function slugsForHost(platform, arch) {
  if (platform === 'darwin') return ['darwin-arm64', 'darwin-x64'];
  if (platform === 'win32') return ['win32-x64-vulkan', 'win32-x64-cpu', 'win32-arm64-cpu'];
  if (platform === 'linux') return ['linux-x64-vulkan', 'linux-x64-cpu'];
  throw new Error(`no llama vendor set for platform ${platform}`);
}

export function assetUrl(asset) {
  return `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_TAG}/${asset}`;
}
