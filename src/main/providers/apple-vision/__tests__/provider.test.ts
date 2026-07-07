/**
 * @jest-environment node
 */
import type { InferenceProvider } from '@shared/contracts';

import { createAppleVisionProvider } from '../provider';

const noop = () => {};
const fakeHelper = {
  ocrImage: jest.fn(async () => 'ocr result'),
  rasterizePdf: jest.fn(async () => []),
};

describe('apple-vision provider', () => {
  it('is ready on darwin when the binary exists', () => {
    const p: InferenceProvider = createAppleVisionProvider({
      binaryPath: __filename, // any existing file
      helper: fakeHelper,
      platform: 'darwin',
      log: noop,
    });
    expect(p.id).toBe('apple-vision');
    expect(p.supports).toEqual(['read']);
    expect(p.status()).toBe('ready');
  });

  it('is unsupported off darwin, error when binary missing', () => {
    expect(
      createAppleVisionProvider({
        binaryPath: __filename,
        helper: fakeHelper,
        platform: 'linux',
        log: noop,
      }).status(),
    ).toBe('unsupported');
    const missing = createAppleVisionProvider({
      binaryPath: '/no/such/kia-vision',
      helper: fakeHelper,
      platform: 'darwin',
      log: noop,
    });
    expect(missing.status()).toMatchObject({
      error: expect.stringContaining('vendor:inference'),
    });
  });

  it('handles read and rejects other kinds', async () => {
    const p = createAppleVisionProvider({
      binaryPath: __filename,
      helper: fakeHelper,
      platform: 'darwin',
      log: noop,
    });
    await expect(
      p.handle({
        kind: 'read',
        payload: { image: new Uint8Array([1]), mime: 'image/png' },
        lane: 'background',
      }),
    ).resolves.toBe('ocr result');
    await expect(
      p.handle({ kind: 'see', payload: {}, lane: 'background' }),
    ).rejects.toThrow(/read/);
  });
});
