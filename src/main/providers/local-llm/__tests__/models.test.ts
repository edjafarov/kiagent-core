import {
  selectCuratedModel,
  resolveModelOverride,
  checkCapability,
} from '../index';
import type { BackendInfo } from '../backend';

const G = 1024 ** 3;

describe('selectCuratedModel', () => {
  it.each([
    [
      'metal 64GB → 12B',
      { accel: 'metal', capacityBytes: 64 * G },
      'gemma-4-12b-it-Q4_K_M',
    ],
    [
      'metal 32GB → E4B',
      { accel: 'metal', capacityBytes: 32 * G },
      'gemma-4-E4B-it-Q4_K_M',
    ],
    [
      'metal 16GB → E2B',
      { accel: 'metal', capacityBytes: 16 * G },
      'gemma-4-E2B-it-Q4_K_M',
    ],
    [
      'vulkan 8GB VRAM → E2B',
      { accel: 'vulkan', capacityBytes: 8 * G },
      'gemma-4-E2B-it-Q4_K_M',
    ],
    [
      'cpu 128GB still E2B',
      { accel: 'cpu', capacityBytes: 128 * G },
      'gemma-4-E2B-it-Q4_K_M',
    ],
  ])('%s', (_n, backend, want) => {
    expect(selectCuratedModel(backend as BackendInfo).id).toBe(want);
  });
});

describe('checkCapability', () => {
  it('cpu-only under 8GB fails, gpu always passes', () => {
    expect(
      checkCapability({ platform: 'linux', arch: 'x64', totalMemBytes: 4 * G })
        .ok,
    ).toBe(false);
    expect(
      checkCapability({
        platform: 'darwin',
        arch: 'arm64',
        totalMemBytes: 16 * G,
      }).ok,
    ).toBe(true);
  });
});

describe('resolveModelOverride', () => {
  it('override resolves catalog ids, auto/unknown → null', () => {
    expect(resolveModelOverride('gemma-4-E4B-it-Q4_K_M')?.id).toBe(
      'gemma-4-E4B-it-Q4_K_M',
    );
    expect(resolveModelOverride('auto')).toBeNull();
    expect(resolveModelOverride('bogus')).toBeNull();
  });
});
