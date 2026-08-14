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
  WHISPER_TAG,
  whisperAssetUrl,
  whisperSlugsForHost,
} from '../../scripts/whisper-assets.mjs';

describe('whisper vendor slug contract', () => {
  it('prebuilt slugs are exactly linux-x64 and win32-x64', () => {
    expect(Object.keys(WHISPER_ASSETS).sort()).toEqual([
      'linux-x64',
      'win32-x64',
    ]);
  });

  it('every slug is accel-less platform-arch', () => {
    const all = [
      ...Object.keys(WHISPER_ASSETS),
      ...whisperSlugsForHost('darwin', 'arm64'),
      ...whisperSlugsForHost('linux', 'x64'),
      ...whisperSlugsForHost('win32', 'x64'),
    ];
    for (const slug of all) {
      expect(slug).toMatch(/^(darwin|linux|win32)-(arm64|x64)$/);
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
