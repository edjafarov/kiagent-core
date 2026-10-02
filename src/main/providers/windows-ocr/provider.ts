import fs from 'fs';

import type {
  InferenceProvider,
  LogLevel,
  ProviderStatus,
} from '@shared/contracts';

import type { WindowsOcrHelper } from './windows-ocr-helper';

/** The selftest runs only at boot, so the guidance must say restart. */
export const NO_OCR_LANGUAGE =
  'No text-recognition language is installed. Add a language in Windows Settings → Time & language → Language & region (one with Optical character recognition), then restart KIAgent.';

export function createWindowsOcrProvider(deps: {
  binaryPath: string;
  helper: Pick<WindowsOcrHelper, 'ocrImage' | 'selftest'>;
  platform?: string;
  log: (level: LogLevel, msg: string) => void;
}): InferenceProvider {
  const platform = deps.platform ?? process.platform;
  // Languages are probed once, at boot. Until the probe resolves: standby.
  let probed: boolean | null = null;
  if (platform === 'win32' && fs.existsSync(deps.binaryPath)) {
    void deps.helper.selftest().then((r) => {
      probed = r.ok;
    });
  }
  return {
    id: 'windows-ocr',
    supports: ['read'],
    status(): ProviderStatus {
      if (platform !== 'win32') return 'unsupported';
      if (!fs.existsSync(deps.binaryPath))
        return { error: 'windows-ocr helper missing' };
      if (probed === null) return 'standby';
      return probed ? 'ready' : { error: NO_OCR_LANGUAGE };
    },
    async handle(req) {
      if (req.kind !== 'read')
        throw new Error(`windows-ocr only supports 'read' (got '${req.kind}')`);
      const { image, mime } = req.payload as {
        image: Uint8Array;
        mime?: string;
      };
      return deps.helper.ocrImage(image, mime);
    },
  };
}
