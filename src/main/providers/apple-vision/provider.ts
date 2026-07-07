import fs from 'fs';

import type { InferenceProvider, LogLevel } from '@shared/contracts';

import type { VisionHelper } from './vision-helper';

export function createAppleVisionProvider(deps: {
  binaryPath: string;
  helper: VisionHelper;
  platform?: string;
  log: (level: LogLevel, msg: string) => void;
}): InferenceProvider {
  const platform = deps.platform ?? process.platform;
  return {
    id: 'apple-vision',
    supports: ['read'],
    status() {
      if (platform !== 'darwin') return 'unsupported';
      if (!fs.existsSync(deps.binaryPath)) {
        return {
          error: 'kia-vision helper missing — run: npm run vendor:inference',
        };
      }
      return 'ready';
    },
    async handle(req) {
      if (req.kind !== 'read') {
        throw new Error(
          `apple-vision only supports 'read' (got '${req.kind}')`,
        );
      }
      const { image, mime } = req.payload as {
        image: Uint8Array;
        mime?: string;
      };
      return deps.helper.ocrImage(image, mime);
    },
  };
}
