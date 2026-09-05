import {
  coveringRoots,
  isUnder,
  normalizePathSeparators,
} from '../folder-paths';

describe('isUnder', () => {
  it('is true for an exact-equal path', () => {
    expect(isUnder('/Users/ed', '/Users/ed')).toBe(true);
  });

  it('is true for a direct child', () => {
    expect(isUnder('/Users/ed/docs', '/Users/ed')).toBe(true);
  });

  it('is true for a deep descendant', () => {
    expect(isUnder('/Users/ed/docs/2024/reports', '/Users/ed')).toBe(true);
  });

  it('does not fall for the sibling-prefix trap', () => {
    expect(isUnder('/Users/edjafarov', '/Users/ed')).toBe(false);
  });

  it('treats "/" as covering everything under it', () => {
    expect(isUnder('/Users/x', '/')).toBe(true);
  });

  it('treats a drive root like "C:\\" as covering its children', () => {
    expect(isUnder('C:\\Users', 'C:\\')).toBe(true);
  });

  it('does not let one drive cover another', () => {
    expect(isUnder('D:\\Users', 'C:\\Users')).toBe(false);
  });
});

describe('coveringRoots', () => {
  it('collapses mixed nested input down to the top-most paths', () => {
    const result = coveringRoots(['/a/b/c', '/a', '/d/e', '/a/b']);
    expect(result.sort()).toEqual(['/a', '/d/e'].sort());
  });

  it('leaves already-minimal input unchanged', () => {
    const input = ['/a', '/b', '/c'];
    expect(coveringRoots(input).sort()).toEqual(input.sort());
  });
});

/**
 * C-46/D1. Written AFTER the migration fix as a regression pin on the helper
 * itself; the RED that drove the fix is in
 * `store/__tests__/folder-scope-migration.test.ts` ("retains and attributes a
 * Windows SCAN row whose absPath fast-glob unixified").
 */
describe('normalizePathSeparators', () => {
  it('rewrites every backslash to a forward slash', () => {
    expect(normalizePathSeparators('C:\\Users\\x\\Docs')).toBe(
      'C:/Users/x/Docs',
    );
  });

  it('leaves an already-posix path byte-identical', () => {
    expect(normalizePathSeparators('/Users/ed/docs')).toBe('/Users/ed/docs');
  });

  it('makes the mixed-provenance pair that isUnder alone cannot match', () => {
    // The exact shape a Windows corpus produces: fast-glob unixified the
    // document path, `path.resolve` backslashed the config root.
    const absPath = 'C:/Users/x/Docs/f.txt';
    const root = 'C:\\Users\\x\\Docs';
    expect(isUnder(absPath, root)).toBe(false);
    expect(
      isUnder(normalizePathSeparators(absPath), normalizePathSeparators(root)),
    ).toBe(true);
  });

  it('does not defeat the sibling-prefix trap once normalized', () => {
    expect(
      isUnder(
        normalizePathSeparators('C:/Users/x/DocsBackup/f.txt'),
        normalizePathSeparators('C:\\Users\\x\\Docs'),
      ),
    ).toBe(false);
  });
});
