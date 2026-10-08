import { buildLineWindow, extractWindowTerms } from '../line-window';

describe('buildLineWindow', () => {
  const md = 'line1\nline2\nline3\nline4';

  it('with no terms returns the head window and a trailing ellipsis', () => {
    expect(buildLineWindow(md, [], 1)).toBe('line1\nline2\nline3\n…');
  });

  it('anchors on the first matching line and marks hits with **', () => {
    expect(buildLineWindow(md, ['line3'], 0)).toBe('…\n**line3**\n…');
  });

  it('headTruncated forces a trailing ellipsis even when every kept line fits', () => {
    expect(buildLineWindow('a\nb', [], 5, true)).toBe('a\nb\n…');
    expect(buildLineWindow('a\nb', [], 5, false)).toBe('a\nb');
  });
});

describe('extractWindowTerms', () => {
  it('keeps phrases whole and strips query syntax', () => {
    expect(extractWindowTerms('"term sheet" -spam invest*')).toEqual([
      'term sheet',
      'spam',
      'invest',
    ]);
  });
});
