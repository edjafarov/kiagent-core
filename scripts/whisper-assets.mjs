// scripts/whisper-assets.mjs
// Single source of truth for the vendored whisper.cpp runtime, mirroring
// llama-assets.mjs. Slugs are deliberately ACCEL-LESS (`platform-arch` only):
// the provider resolves assets/whisper/`${platform}-${arch}` directly, so the
// llama accel-suffix resolver mismatch cannot be repeated here.
//
// ⚠️ On every WHISPER_TAG bump: re-verify the `failed to read audio file`
// stderr diagnostic in src/main/providers/local-asr/whisper-cli.ts against the
// new tag's examples/cli/cli.cpp — input rejection is keyed on that exact
// string (v1.9.2: a failed audio read logs it and exits 0; model-init failure
// returns 3). The archives are sha-pinned, so the message cannot drift under
// us between bumps.
export const WHISPER_TAG = 'v1.9.2';
// The commit the tag points at — build-whisper.mjs verifies its checkout
// against this so the macOS from-source build is as pinned as the archives.
export const WHISPER_COMMIT = '306c88f4d1286aec1bf96e544632897886af5501';

/** slug → { asset (release archive filename), sha256 }. Prebuilt platforms
 *  only; darwin builds from source (no runnable macOS binary upstream — the
 *  release carries an XCFramework, a library, not a CLI). */
export const WHISPER_ASSETS = {
  'linux-x64': {
    asset: 'whisper-bin-ubuntu-x64.tar.gz',
    sha256: '46811a3ecf584307480a220b9ef5ff81b7b22dc41577cbc274ce3afc61f753b1',
  },
  'win32-x64': {
    asset: 'whisper-bin-x64.zip',
    sha256: '49dcc16de826f20bd53d44f947a1ae49dfa81f86cad67a64d80820cb192d674a',
  },
};

/** Which slugs a given CI runner must FETCH (build-whisper.mjs covers darwin).
 *  win32 is x64-only: upstream publishes no win-arm64 build, so arm64 Windows
 *  ships no ASR (the provider reports `unsupported` there — spec §1). */
export function whisperSlugsForHost(platform, arch) {
  if (platform === 'darwin') return []; // built from source, both arches
  if (platform === 'win32') return ['win32-x64'];
  if (platform === 'linux') return ['linux-x64'];
  throw new Error(`no whisper vendor set for platform ${platform}`);
}

export function whisperAssetUrl(asset) {
  return `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_TAG}/${asset}`;
}
