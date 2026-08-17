import path from 'path';

import type { CorePlatform } from '../core/boot';

import { createAppleVisionProvider } from './apple-vision/provider';
import { makeVisionHelper } from './apple-vision/vision-helper';
import type { VisionHelper } from './apple-vision/vision-helper';
import { createLocalAsrProvider } from './local-asr';
import type { LocalAsrProvider } from './local-asr';
import { createLocalLlmProvider } from './local-llm/provider';
import type { LocalLlmProvider } from './local-llm/provider';

/** darwin is Metal-implicit (no accel in the slug); other platforms would
 *  carry the accel (see ref catalog.ts llamaSlug), but accel is only known
 *  after detectHostBackend() runs — which for non-darwin needs the binary
 *  itself (--list-devices). Until that's wired, resolve platform-arch only;
 *  darwin (today's only shipped target) needs nothing more. */
function resolveLlamaBinary(llamaDir: string): string {
  const slug = `${process.platform}-${process.arch}`;
  const binName =
    process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  return path.join(llamaDir, slug, binName);
}

/** Whisper slugs are accel-less BY DESIGN (scripts/whisper-assets.mjs), so
 *  platform-arch resolution is exact on every platform — the llama accel
 *  mismatch above cannot recur here. A missing dir (win32-arm64: no upstream
 *  build) simply fails the capability check → provider reports unsupported. */
function resolveWhisperBinary(whisperDir: string): string {
  const slug = `${process.platform}-${process.arch}`;
  const binName =
    process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
  return path.join(whisperDir, slug, binName);
}

/** Mirrors registerBundledSources: main.ts calls this once after bootCore. */
export function registerBundledProviders(
  platform: CorePlatform,
  opts: { assetsDir: string; dataDir: string },
): {
  localLlm: LocalLlmProvider;
  localAsr: LocalAsrProvider;
  visionHelper: VisionHelper | null;
} {
  const log =
    (scope: string) => (level: 'info' | 'warn' | 'error', msg: string) =>
      platform.logSink.log(scope, level, msg);

  const visionBinary = path.join(
    opts.assetsDir,
    'vision',
    `${process.platform}-${process.arch}`,
    'kia-vision',
  );
  const visionHelper =
    process.platform === 'darwin'
      ? makeVisionHelper(visionBinary, log('inference'))
      : null;
  if (visionHelper) {
    platform.inference.register(
      createAppleVisionProvider({
        binaryPath: visionBinary,
        helper: visionHelper,
        log: log('inference'),
      }),
    );
  }

  const llamaSlugDir = path.join(opts.assetsDir, 'llama'); // per-platform slug resolved inside
  const localLlm = createLocalLlmProvider({
    llamaBinaryPath: resolveLlamaBinary(llamaSlugDir), // port `llamaSlug` from ref catalog.ts:35
    modelsDir: path.join(opts.dataDir, 'models'),
    prefs: platform.prefs,
    log: log('inference'),
  });
  platform.inference.register(localLlm);

  const localAsr = createLocalAsrProvider({
    binaryPath: resolveWhisperBinary(path.join(opts.assetsDir, 'whisper')),
    // One copy for every slug (scripts/whisper-assets.mjs: the model is
    // platform-independent), so it sits beside the slug dirs, not inside one.
    vadModelPath: path.join(
      opts.assetsDir,
      'whisper',
      'ggml-silero-v5.1.2.bin',
    ),
    asrModelsDir: path.join(opts.dataDir, 'models', 'asr'),
    prefs: platform.prefs,
    log: log('inference'),
  });
  platform.inference.register(localAsr);

  return { localLlm, localAsr, visionHelper };
}
