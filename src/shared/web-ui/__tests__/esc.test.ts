import { esc } from '../esc';

describe('esc()', () => {
  it('escapes ampersand', () => {
    expect(esc('a&b')).toBe('a&amp;b');
  });
  it('escapes angle brackets', () => {
    expect(esc('<script>')).toBe('&lt;script&gt;');
  });
  it('escapes double quote', () => {
    expect(esc('a"b')).toBe('a&quot;b');
  });
  it('escapes single quote', () => {
    expect(esc("a'b")).toBe('a&#39;b');
  });
  it('handles empty string', () => {
    expect(esc('')).toBe('');
  });
  it('handles a realistic mix', () => {
    expect(esc(`<a href="x?a&b='c'">X</a>`)).toBe(
      '&lt;a href=&quot;x?a&amp;b=&#39;c&#39;&quot;&gt;X&lt;/a&gt;',
    );
  });
});
