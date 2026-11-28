/** @jest-environment node */
import os from 'os';
import path from 'path';

import type { CorePlatform } from '../../core/boot';
import { registerBundledProviders } from '../index';

const realPlatform = process.platform;
const setPlatform = (value: string) =>
  Object.defineProperty(process, 'platform', { value, configurable: true });

afterEach(() => setPlatform(realPlatform));

const register = (platformName: string) => {
  setPlatform(platformName);
  const registerFn = jest.fn();
  const fake = {
    inference: { register: registerFn },
    logSink: { log: jest.fn() },
    prefs: {
      get: () => ({ models: { autoInstall: false } }),
      onChange: () => () => {},
    },
  } as unknown as CorePlatform;
  const dir = path.join(os.tmpdir(), 'kia-no-such-dir');
  const out = registerBundledProviders(fake, { assetsDir: dir, dataDir: dir });
  return {
    ids: registerFn.mock.calls.map(([p]) => (p as { id: string }).id),
    missingBinaries: out.missingBinaries,
  };
};
const registeredIds = (platformName: string): string[] =>
  register(platformName).ids;

it('registers windows-ocr on win32', () => {
  expect(registeredIds('win32')).toContain('windows-ocr');
});
it('does not register windows-ocr on darwin', () => {
  expect(registeredIds('darwin')).not.toContain('windows-ocr');
});

it('names every provider whose bundled program is missing (an assets dir with nothing vendored)', () => {
  expect(register('linux').missingBinaries).toEqual([
    'local-llm',
    'local-embed',
    'local-asr',
  ]);
  expect(register('win32').missingBinaries).toEqual([
    'local-llm',
    'local-embed',
    'local-asr',
    'windows-ocr',
  ]);
});
