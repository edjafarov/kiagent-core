import { coveringRoots, isUnder } from '../folder-paths';

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
