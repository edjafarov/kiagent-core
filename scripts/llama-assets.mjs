// scripts/llama-assets.mjs
// Single source of truth for the vendored llama.cpp binaries. The slug keys
// MUST match catalog.ts's llamaSlug() output — pinned by
// src/__tests__/llama-slug-contract.test.ts. Bump LLAMA_TAG deliberately and
// re-run `node scripts/fetch-llama-server.mjs --print-sha` to refresh shas.
export const LLAMA_TAG = 'b9585';

/** slug → { asset (release archive filename), sha256 (null until pinned) }.
 *  win32-arm64 ships CPU-only: b9585 has no win-arm64 Vulkan archive, and the
 *  runtime degrades arm64 Windows to cpu, so win32-arm64-vulkan is never asked
 *  for. */
export const LLAMA_ASSETS = {
  'darwin-arm64': { asset: `llama-${LLAMA_TAG}-bin-macos-arm64.tar.gz`, sha256: 'e88f05f82c8c0c0f5a861ff7822f096ad6641128e6f64c666eee743f46730db6' },
  'darwin-x64': { asset: `llama-${LLAMA_TAG}-bin-macos-x64.tar.gz`, sha256: '31151226ac563764df3456b615c261d10a92f09e99be48a64d39985f15e7a15b' },
  'win32-x64-vulkan': { asset: `llama-${LLAMA_TAG}-bin-win-vulkan-x64.zip`, sha256: 'af6b1b94377b9f78dbb2285b878fb696d36766391499d65e055ecd622b69018a' },
  'win32-x64-cpu': { asset: `llama-${LLAMA_TAG}-bin-win-cpu-x64.zip`, sha256: '23c0e329e2228f7cbcc83884f42c7787f1a3133e5548ea99e89d60202e1fd89c' },
  'win32-arm64-cpu': { asset: `llama-${LLAMA_TAG}-bin-win-cpu-arm64.zip`, sha256: '9dd7cde8fdc2a5c932f63e4392c1c10ce6f65d39a70a781d9a3978e68ca9c215' },
  'linux-x64-vulkan': { asset: `llama-${LLAMA_TAG}-bin-ubuntu-vulkan-x64.tar.gz`, sha256: '5f5467e5d9827b27eda17ee39b35fd2b7c8aa298f144e8836491ccec76160fdf' },
  'linux-x64-cpu': { asset: `llama-${LLAMA_TAG}-bin-ubuntu-x64.tar.gz`, sha256: 'be111dd28e6228fc4cb6a6ec41f03a67947ab61f315a3d22d0e68ac7372a58ab' },
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
