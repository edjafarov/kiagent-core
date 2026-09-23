// src/main/platform/__tests__/manifest-file-roots.test.ts
/** @jest-environment node */
import {
  parseManifest,
  declaredFileRoots,
  isHomeRelativePath,
} from '../manifest';

const BASE = {
  id: 'kia.files',
  name: 'Files',
  version: '1.0.0',
  engine: '^2.3.0',
  entry: 'index.js',
  caps: ['files'],
  contributes: { sources: [], senders: [] },
};
const ROOT = { id: 'claude', path: '~/.claude', purpose: 'Claude history' };

describe('manifest.fileRoots', () => {
  it('accepts-valid', () => {
    const m = parseManifest({ ...BASE, fileRoots: [ROOT] });
    expect(declaredFileRoots(m)).toEqual([ROOT]);
  });

  it('defaults to an empty list', () => {
    expect(declaredFileRoots(parseManifest(BASE))).toEqual([]);
  });

  it('requires-files-cap', () => {
    expect(() =>
      parseManifest({ ...BASE, caps: [], fileRoots: [ROOT] }),
    ).toThrow(/PLUGIN_FILES_CAP_REQUIRED/);
  });

  it('rejects-bundled-tier', () => {
    expect(() =>
      parseManifest({ ...BASE, fileRoots: [ROOT] }, { tier: 'bundled' }),
    ).toThrow(/PLUGIN_FILE_ROOTS_TIER_DENIED/);
  });

  it.each([
    '~/..',
    '/abs',
    '~',
    '~/',
    '~/a/../b',
    '~/a/./b',
    '~//a',
    '~/a/',
    'x/~/a',
    '~/a\0b',
  ])('rejects-lexical-escape %p', (p) => {
    expect(isHomeRelativePath(p)).toBe(false);
    expect(() =>
      parseManifest({ ...BASE, fileRoots: [{ ...ROOT, path: p }] }),
    ).toThrow(/invalid manifest: fileRoots/);
  });

  it('rejects-duplicate-id', () => {
    expect(() =>
      parseManifest({
        ...BASE,
        fileRoots: [ROOT, { ...ROOT, path: '~/.other' }],
      }),
    ).toThrow(/duplicate fileRoots id 'claude'/);
  });

  it('rejects bad id, empty/long purpose, more than 8 roots', () => {
    expect(() =>
      parseManifest({ ...BASE, fileRoots: [{ ...ROOT, id: 'Bad' }] }),
    ).toThrow();
    expect(() =>
      parseManifest({ ...BASE, fileRoots: [{ ...ROOT, purpose: '' }] }),
    ).toThrow();
    expect(() =>
      parseManifest({
        ...BASE,
        fileRoots: [{ ...ROOT, purpose: 'x'.repeat(201) }],
      }),
    ).toThrow();
    const nine = Array.from({ length: 9 }, (_, i) => ({
      ...ROOT,
      id: `r${i}`,
      path: `~/r${i}`,
    }));
    expect(() => parseManifest({ ...BASE, fileRoots: nine })).toThrow();
  });
});
