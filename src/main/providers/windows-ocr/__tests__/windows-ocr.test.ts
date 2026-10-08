/** @jest-environment node */
import os from 'os';
import path from 'path';

import { createWindowsOcrProvider, NO_OCR_LANGUAGE } from '../provider';
import { makeWindowsOcrHelper } from '../windows-ocr-helper';

const FAKE = path.join(__dirname, 'fixtures', 'fake-windows-ocr.cjs');
const log = jest.fn();
const withEnv = async <T>(
  env: Record<string, string>,
  f: () => Promise<T>,
): Promise<T> => {
  Object.assign(process.env, env);
  try {
    return await f();
  } finally {
    for (const k of Object.keys(env)) delete process.env[k];
  }
};

describe('windows-ocr helper', () => {
  it('returns the recognized text', async () => {
    await withEnv({ FAKE_WOCR_TEXT: 'Rechnung Nr. 42' }, async () =>
      expect(
        await makeWindowsOcrHelper(FAKE, log).ocrImage(
          new Uint8Array([1, 2]),
          'image/png',
        ),
      ).toBe('Rechnung Nr. 42'),
    );
  });
  it('a background OCR run is demoted to PRIORITY_LOW', async () => {
    const setPriority = jest.fn();
    await makeWindowsOcrHelper(FAKE, log, { setPriority }).ocrImage(
      new Uint8Array([1]),
      'image/png',
      'background',
    );
    expect(setPriority).toHaveBeenCalledWith(
      expect.any(Number),
      os.constants.priority.PRIORITY_LOW,
    );
  });
  it('a non-zero exit rejects with stderr', async () => {
    await withEnv({ FAKE_WOCR_FAIL: '1' }, async () =>
      expect(
        makeWindowsOcrHelper(FAKE, log).ocrImage(new Uint8Array([1])),
      ).rejects.toThrow('boom'),
    );
  });
  it('a hung helper times out', async () => {
    await withEnv({ FAKE_WOCR_HANG: '1' }, async () =>
      expect(
        makeWindowsOcrHelper(FAKE, log, { timeoutMs: 300 }).ocrImage(
          new Uint8Array([1]),
        ),
      ).rejects.toThrow(/timed out/),
    );
  });
  it('selftest: exit 1 with {ok:false} is ok:false, not a throw', async () => {
    await withEnv({ FAKE_WOCR_NOLANG: '1' }, async () =>
      expect(await makeWindowsOcrHelper(FAKE, log).selftest()).toEqual({
        ok: false,
      }),
    );
    expect(await makeWindowsOcrHelper(FAKE, log).selftest()).toEqual({
      ok: true,
    });
  });
});

it('selftest: a crashed probe (no {ok:false} on stdout) reports why, not "no language"', async () => {
  await withEnv({ FAKE_WOCR_SELFTEST_CRASH: '1' }, async () =>
    expect(await makeWindowsOcrHelper(FAKE, log).selftest()).toEqual({
      ok: false,
      error: 'Failure extracting contents of the application bundle',
    }),
  );
});

describe('windows-ocr provider status', () => {
  const helper = (ok: boolean) => ({
    ocrImage: jest.fn(),
    selftest: jest.fn(async () => ({ ok })),
  });
  it('unsupported off win32', () => {
    expect(
      createWindowsOcrProvider({
        binaryPath: FAKE,
        helper: helper(true),
        platform: 'darwin',
        log,
      }).status(),
    ).toBe('unsupported');
  });
  it('missing exe → error', () => {
    expect(
      createWindowsOcrProvider({
        binaryPath: '/nope.exe',
        helper: helper(true),
        platform: 'win32',
        log,
      }).status(),
    ).toEqual({ error: 'windows-ocr helper missing' });
  });
  it('standby until selftest resolves, then ready / no-language error', async () => {
    const p = createWindowsOcrProvider({
      binaryPath: FAKE,
      helper: helper(true),
      platform: 'win32',
      log,
    });
    expect(p.status()).toBe('standby');
    await new Promise((r) => {
      setImmediate(r);
    });
    expect(p.status()).toBe('ready');
    const q = createWindowsOcrProvider({
      binaryPath: FAKE,
      helper: helper(false),
      platform: 'win32',
      log,
    });
    await new Promise((r) => {
      setImmediate(r);
    });
    expect(q.status()).toEqual({ error: NO_OCR_LANGUAGE });
  });
  it('a helper that cannot run shows its own error, not the language guidance', async () => {
    const p = createWindowsOcrProvider({
      binaryPath: FAKE,
      helper: {
        ocrImage: jest.fn(),
        selftest: jest.fn(async () => ({ ok: false, error: 'blocked' })),
      },
      platform: 'win32',
      log,
    });
    await new Promise((r) => {
      setImmediate(r);
    });
    expect(p.status()).toEqual({ error: 'windows-ocr helper failed: blocked' });
  });
  it('handle routes read to ocrImage', async () => {
    const h = helper(true);
    h.ocrImage.mockResolvedValue('text');
    const p = createWindowsOcrProvider({
      binaryPath: FAKE,
      helper: h,
      platform: 'win32',
      log,
    });
    expect(
      await p.handle({
        kind: 'read',
        payload: { image: new Uint8Array([1]), mime: 'image/png' },
      } as never),
    ).toBe('text');
  });
});

it('mayBecomeReady while the boot selftest is pending, not after it resolves', async () => {
  let resolve!: (r: { ok: boolean }) => void;
  const pending = new Promise<{ ok: boolean }>((r) => {
    resolve = r;
  });
  const p = createWindowsOcrProvider({
    binaryPath: FAKE,
    helper: { ocrImage: jest.fn(), selftest: () => pending },
    platform: 'win32',
    log,
  });
  expect(p.mayBecomeReady?.()).toBe(true);
  resolve({ ok: false });
  await new Promise((r) => {
    setImmediate(r);
  });
  expect(p.mayBecomeReady?.()).toBe(false);
});
