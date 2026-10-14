import path from 'path';

import type { CorePlatform } from '../core/boot';

import { createAppleVisionProvider } from './apple-vision/provider';
import { makeVisionHelper } from './apple-vision/vision-helper';
import type { VisionHelper } from './apple-vision/vision-helper';
import { createLocalAsrProvider } from './local-asr';
import type { LocalAsrProvider } from './local-asr';
import { listLlamaDevices, resolveLlamaBinaries } from './local-llm/binaries';
import { createLocalLlmProvider } from './local-llm/provider';
import type { LocalLlmProvider } from './local-llm/provider';
import { createWindowsOcrProvider } from './windows-ocr/provider';
import { makeWindowsOcrHelper } from './windows-ocr/windows-ocr-helper';

/** Whisper slugs are accel-less BY DESIGN (scripts/whisper-assets.mjs), so
 *  platform-arch resolution is exact on every platform (llama's are
 *  accel-suffixed off darwin; see local-llm/binaries.ts). A missing dir (a
 *  platform-arch with no vendored build) simply fails the capability check →
 *  provider reports unsupported. */
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

  if (process.platform === 'win32') {
    const wocr = path.join(
      opts.assetsDir,
      'ocr',
      `win32-${process.arch}`,
      'windows-ocr.exe',
    );
    platform.inference.register(
      createWindowsOcrProvider({
        binaryPath: wocr,
        helper: makeWindowsOcrHelper(wocr, log('inference')),
        log: log('inference'),
      }),
    );
  }

  const llama = resolveLlamaBinaries(path.join(opts.assetsDir, 'llama'));
  const vulkanBinary = process.platform === 'darwin' ? null : llama.gpu;
  const localLlm = createLocalLlmProvider({
    llamaBinaryPath: llama.gpu ?? llama.cpu,
    cpuBinaryPath: llama.cpu,
    ...(vulkanBinary
      ? { listDevices: () => listLlamaDevices(vulkanBinary) }
      : {}),
    modelsDir: path.join(opts.dataDir, 'models'),
    prefs: platform.prefs,
    host: platform.host,
    log: log('inference'),
  });
  platform.inference.register(localLlm);
  // Right after local-llm, before any caller can describe(): every later
  // registration bumps the plane's generation.
  platform.inference.register(localLlm.embedProvider);
  // With the chat model installed nothing else asks for the embedding
  // model; this no-ops when Local AI may not install models.
  localLlm.ensureEmbedInstalled();

  const localAsr = createLocalAsrProvider({
    host: platform.host,
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
    activeCalls: platform.inference.activeCalls,
  });
  platform.inference.register(localAsr);

  return { localLlm, localAsr, visionHelper };
}
