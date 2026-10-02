/** @jest-environment node */
import os from 'os';
import path from 'path';

import type { CorePlatform } from '../../core/boot';
import { registerBundledProviders } from '../index';

const realPlatform = process.platform;
const setPlatform = (value: string) =>
  Object.defineProperty(process, 'platform', { value, configurable: true });

afterEach(() => setPlatform(realPlatform));

const registeredIds = (platformName: string): string[] => {
  setPlatform(platformName);
  const register = jest.fn();
  const fake = {
    inference: { register },
    logSink: { log: jest.fn() },
    prefs: {
      get: () => ({ models: { autoInstall: false } }),
      onChange: () => () => {},
    },
  } as unknown as CorePlatform;
  const dir = path.join(os.tmpdir(), 'kia-no-such-dir');
  registerBundledProviders(fake, { assetsDir: dir, dataDir: dir });
  return register.mock.calls.map(([p]) => (p as { id: string }).id);
};

it('registers windows-ocr on win32', () => {
  expect(registeredIds('win32')).toContain('windows-ocr');
});
it('does not register windows-ocr on darwin', () => {
  expect(registeredIds('darwin')).not.toContain('windows-ocr');
});
