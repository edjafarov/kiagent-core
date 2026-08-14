// src/__tests__/whisper-slug-contract.test.ts
/**
 * Pins the whisper vendor layout to accel-less `${platform}-${arch}` slugs.
 * The llama resolver bug (providers/index.ts resolveLlamaBinary vs
 * accel-suffixed vendor dirs) must be impossible to repeat here: the provider
 * resolves assets/whisper/`${platform}-${arch}` directly, so every slug the
 * vendor scripts can produce must have exactly that shape.
 */
import {
  WHISPER_ASSETS,
  WHISPER_DARWIN_SLUGS,
  WHISPER_TAG,
  whisperAssetUrl,
  whisperDir,
  whisperSlugsForHost,
} from '../../scripts/whisper-assets.mjs';

describe('whisper vendor slug contract', () => {
  it('prebuilt slugs are exactly linux-x64 and win32-x64', () => {
    expect(Object.keys(WHISPER_ASSETS).sort()).toEqual([
      'linux-x64',
      'win32-x64',
    ]);
  });

  // build-whisper.mjs derives its build TARGETS from WHISPER_DARWIN_SLUGS
  // (not an inline literal), so this pins the one other producer of whisper
  // vendor slugs — the darwin source build — to the same module that claims
  // to be the single source of truth. Someone introducing e.g.
  // `darwin-arm64-metal` there without updating this list fails here first.
  it('darwin source-build slugs are exactly darwin-arm64 and darwin-x64', () => {
    expect([...WHISPER_DARWIN_SLUGS].sort()).toEqual([
      'darwin-arm64',
      'darwin-x64',
    ]);
  });

  it('every slug is accel-less platform-arch', () => {
    const all = [
      ...Object.keys(WHISPER_ASSETS),
      ...WHISPER_DARWIN_SLUGS,
      ...whisperSlugsForHost('darwin', 'arm64'),
      ...whisperSlugsForHost('linux', 'x64'),
      ...whisperSlugsForHost('win32', 'x64'),
    ];
    for (const slug of all) {
      expect(slug).toMatch(/^(darwin|linux|win32)-(arm64|x64)$/);
    }
  });

  it('whisperDir resolves every producer (fetched or built) under the same assets/whisper root', () => {
    for (const slug of [
      ...Object.keys(WHISPER_ASSETS),
      ...WHISPER_DARWIN_SLUGS,
    ]) {
      expect(whisperDir(slug)).toBe(`assets/whisper/${slug}`);
    }
  });

  it('darwin builds from source (empty fetch set); win32-arm64 ships nothing', () => {
    expect(whisperSlugsForHost('darwin', 'arm64')).toEqual([]);
    expect(whisperSlugsForHost('darwin', 'x64')).toEqual([]);
    // win32 fetch set is x64-only: no upstream arm64 build exists (spec §1).
    expect(whisperSlugsForHost('win32', 'arm64')).toEqual(['win32-x64']);
  });

  it('asset URLs pin the tag', () => {
    expect(whisperAssetUrl('whisper-bin-x64.zip')).toBe(
      `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_TAG}/whisper-bin-x64.zip`,
    );
  });
});
