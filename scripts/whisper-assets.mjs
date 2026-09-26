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
// b5130 is upstream's CI build tag for v1.9.4 (same commit, 927cfce3): the
// v1.9.4 GitHub release carries no binaries, b5130 carries them all —
// including the first win-cpu-arm64 archive.
export const WHISPER_TAG = 'b5130';
// The commit the tag points at — build-whisper.mjs verifies its checkout
// against this so the macOS from-source build is as pinned as the archives.
export const WHISPER_COMMIT = '927cfce34f31707e17f2bff35c349632fb9e2c3a';

/** slug → { asset (release archive filename), sha256 }. Prebuilt platforms
 *  only; darwin builds from source (no runnable macOS binary upstream — the
 *  release carries an XCFramework, a library, not a CLI). */
export const WHISPER_ASSETS = {
  'linux-x64': {
    asset: 'whisper-bin-ubuntu-x64.tar.gz',
    sha256: '53e7fd8b5764edad916b8848dd0af6abb1ff1d3b86c899e79c78652412536c32',
  },
  'win32-x64': {
    asset: 'whisper-bin-x64.zip',
    sha256: 'f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c',
  },
  'win32-arm64': {
    asset: 'whisper-bin-win-cpu-arm64.zip',
    sha256: '799543b926ab5b6c2d60cab269a2092e0ae8d27820e9e15429e59de3699546fc',
  },
};

/** Silero VAD model, used by the `hear` route to skip non-speech audio
 *  (whisper hallucinates repeated text on silence — see whisper-cli.ts).
 *  Platform-INDEPENDENT: one file for every slug, so it is fetched outside
 *  the per-slug loop — hanging it off whisperSlugsForHost() would skip macOS
 *  entirely (that returns [] there) and ship the feature inert on the only
 *  platform meetings runs on. Pinned to an immutable HF revision, not
 *  `resolve/main`, so the bytes cannot drift under the sha. */
export const WHISPER_VAD_MODEL = {
  name: 'ggml-silero-v5.1.2.bin',
  revision: '9ffd54a1e1ee413ddf265af9913beaf518d1639b',
  sha256: '29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf',
};

export function whisperVadModelUrl() {
  const { name, revision } = WHISPER_VAD_MODEL;
  return `https://huggingface.co/ggml-org/whisper-vad/resolve/${revision}/${name}`;
}

/** Where the VAD model is vendored — one copy shared by every slug, resolved
 *  by the provider as <assetsDir>/whisper/<name>. */
export function whisperVadModelPath() {
  return `assets/whisper/${WHISPER_VAD_MODEL.name}`;
}

/** Which slugs a given CI runner must FETCH (build-whisper.mjs covers darwin).
 *  win32 fetches both arches: one NSIS installer carries both payloads and
 *  the runtime picks assets/whisper/win32-<arch> for its own arch. */
export function whisperSlugsForHost(platform, arch) {
  if (platform === 'darwin') return []; // built from source, both arches
  if (platform === 'win32') return ['win32-x64', 'win32-arm64'];
  if (platform === 'linux') return ['linux-x64'];
  throw new Error(`no whisper vendor set for platform ${platform}`);
}

/** Slugs build-whisper.mjs produces from source (darwin has no prebuilt
 *  upstream binary — see WHISPER_ASSETS above). Kept here, not inline in the
 *  build script, so the accel-less-slug contract test in
 *  whisper-slug-contract.test.ts covers the source-build producer too, not
 *  just the fetched ones — this module claims to be the single source of
 *  truth for every whisper vendor slug, fetched or built. */
export const WHISPER_DARWIN_SLUGS = ['darwin-arm64', 'darwin-x64'];

export function whisperAssetUrl(asset) {
  return `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_TAG}/${asset}`;
}

/** Vendor directory for any whisper slug, fetched or built from source.
 *  Relative to the repo root — callers join it with their own base (ROOT for
 *  build-whisper.mjs, cwd for fetch-whisper-cli.mjs, both of which already
 *  run with cwd == repo root). */
export function whisperDir(slug) {
  return `assets/whisper/${slug}`;
}
