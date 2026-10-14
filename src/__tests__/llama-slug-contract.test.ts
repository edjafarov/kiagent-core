// src/__tests__/llama-slug-contract.test.ts
/**
 * Every llama.cpp build the vendor scripts ship must be one the runtime
 * resolver finds (core#127: the resolver once asked for `win32-x64/` while
 * vendoring wrote `win32-x64-vulkan/` + `win32-x64-cpu/`, so local AI never
 * started on Windows or Linux).
 */
import path from 'path';

import { LLAMA_ASSETS, slugsForHost } from '../../scripts/llama-assets.mjs';
import { resolveLlamaBinaries } from '../main/providers/local-llm/binaries';

const HOSTS: [NodeJS.Platform, string][] = [
  ['darwin', 'arm64'],
  ['darwin', 'x64'],
  ['win32', 'x64'],
  ['win32', 'arm64'],
  ['linux', 'x64'],
];
const ROOT = '/assets/llama';
const bin = (platform: string) =>
  platform === 'win32' ? 'llama-server.exe' : 'llama-server';

describe('llama vendor slug contract', () => {
  it.each(HOSTS)(
    '%s-%s resolves a build when exactly the vendored slugs exist',
    (platform, arch) => {
      const vendored = slugsForHost(platform, arch).map((slug: string) =>
        path.join(ROOT, slug, bin(platform)),
      );
      const r = resolveLlamaBinaries(ROOT, platform, arch, (p) =>
        vendored.includes(p),
      );
      const found = [r.gpu, r.cpu].filter(Boolean);
      expect(found.length).toBeGreaterThan(0);
      for (const p of found) expect(vendored).toContain(p);
    },
  );

  it('every vendored non-darwin slug is reachable by its own host', () => {
    for (const slug of Object.keys(LLAMA_ASSETS)) {
      const [platform, arch] = slug.split('-') as [NodeJS.Platform, string];
      const p = path.join(ROOT, slug, bin(platform));
      const r = resolveLlamaBinaries(ROOT, platform, arch, (q) => q === p);
      expect([r.gpu, r.cpu]).toContain(p);
    }
  });

  it('win32-arm64 ships cpu only and resolves it', () => {
    const cpu = path.join(ROOT, 'win32-arm64-cpu', 'llama-server.exe');
    expect(
      resolveLlamaBinaries(ROOT, 'win32', 'arm64', (p) => p === cpu),
    ).toEqual({ gpu: null, cpu });
  });

  it('nothing vendored → no build', () => {
    expect(resolveLlamaBinaries(ROOT, 'win32', 'x64', () => false)).toEqual({
      gpu: null,
      cpu: null,
    });
  });
});
