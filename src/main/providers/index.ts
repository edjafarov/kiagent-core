import path from 'path';

import type { CorePlatform } from '../core/boot';

import { createAppleVisionProvider } from './apple-vision/provider';
import { makeVisionHelper } from './apple-vision/vision-helper';
import type { VisionHelper } from './apple-vision/vision-helper';
import { createLocalLlmProvider } from './local-llm/provider';
import type { LocalLlmProvider } from './local-llm/provider';

/** darwin is Metal-implicit (no accel in the slug); other platforms would
 *  carry the accel (see ref catalog.ts llamaSlug), but accel is only known
 *  after detectHostBackend() runs — which for non-darwin needs the binary
 *  itself (--list-devices). Until that's wired, resolve platform-arch only;
 *  darwin (today's only shipped target) needs nothing more. */
function resolveLlamaBinary(llamaDir: string): string {
  const slug = `${process.platform}-${process.arch}`;
  const binName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  return path.join(llamaDir, slug, binName);
}

/** Mirrors registerBundledSources: main.ts calls this once after bootCore. */
export function registerBundledProviders(
  platform: CorePlatform,
  opts: { assetsDir: string; dataDir: string },
): { localLlm: LocalLlmProvider; visionHelper: VisionHelper | null } {
  const log = (scope: string) => (level: 'info' | 'warn' | 'error', msg: string) =>
    platform.logSink.log(scope, level, msg);

  const visionBinary = path.join(
    opts.assetsDir, 'vision', `${process.platform}-${process.arch}`, 'kia-vision',
  );
  const visionHelper =
    process.platform === 'darwin' ? makeVisionHelper(visionBinary, log('inference')) : null;
  if (visionHelper) {
    platform.inference.register(
      createAppleVisionProvider({ binaryPath: visionBinary, helper: visionHelper, log: log('inference') }),
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
  return { localLlm, visionHelper };
}
