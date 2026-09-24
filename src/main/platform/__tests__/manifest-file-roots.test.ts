// src/main/platform/__tests__/manifest-file-roots.test.ts
/** @jest-environment node */
import {
  parseManifest,
  isHomeRelativePath,
  consentedFileRoots,
  fileRootsCovered,
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
    expect(m.fileRoots).toEqual([ROOT]);
  });

  it('defaults to an empty list (always an array, spec §3.1)', () => {
    expect(parseManifest(BASE).fileRoots).toEqual([]);
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

  it.each(['~/Library', '~/Library/Caches', '~/library/caches'])(
    'rejects-library-top %p (macOS paths are case-insensitive)',
    (p) => {
      expect(() =>
        parseManifest({ ...BASE, fileRoots: [{ ...ROOT, path: p }] }),
      ).toThrow(/invalid manifest: fileRoots/);
    },
  );

  it('accepts a folder two levels under ~/Library', () => {
    const path = '~/Library/Application Support/Claude';
    expect(
      parseManifest({ ...BASE, fileRoots: [{ ...ROOT, path }] }).fileRoots[0]
        .path,
    ).toBe(path);
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

describe('consented file roots', () => {
  it('canonicalises to the id-sorted {id,path} list, dropping purpose', () => {
    expect(consentedFileRoots(undefined)).toEqual([]);
    expect(
      consentedFileRoots([
        { id: 'codex', path: '~/.codex', purpose: 'x' },
        { id: 'claude', path: '~/.claude', purpose: 'y' },
      ]),
    ).toEqual([
      { id: 'claude', path: '~/.claude' },
      { id: 'codex', path: '~/.codex' },
    ]);
  });

  it('covers when every declared root was consented (subset, like caps)', () => {
    const consented = [
      { id: 'claude', path: '~/.claude' },
      { id: 'codex', path: '~/.codex' },
    ];
    const claude = { id: 'claude', path: '~/.claude', purpose: 'changed copy' };
    expect(fileRootsCovered(undefined, [])).toBe(true);
    expect(fileRootsCovered([claude], consented)).toBe(true); // narrowed
    expect(fileRootsCovered([claude], [])).toBe(false); // legacy row
    expect(
      fileRootsCovered([{ ...claude, path: '~/.claude2' }], consented),
    ).toBe(false); // same id, new path
    expect(fileRootsCovered([{ ...claude, id: 'other' }], consented)).toBe(
      false,
    ); // same path, new id
  });
});
