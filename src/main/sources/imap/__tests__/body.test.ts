import { cleanBody } from '../body';

describe('cleanBody', () => {
  it('strips a quoted "On ... wrote:" reply chain', () => {
    const text =
      'Hi Bob,\n\nThis is the reply body.\n\n' +
      'On Tue, Dec 31, 2024 at 10:00 AM Bob <bob@example.com> wrote:\n' +
      '> original message text\n> more quoted text';
    const out = cleanBody(text);
    expect(out).toContain('This is the reply body.');
    expect(out).not.toContain('original message text');
  });

  it('returns an empty string for empty/whitespace-only input', () => {
    expect(cleanBody('')).toBe('');
    expect(cleanBody('   \n  ')).toBe('');
  });

  it('falls back to the trimmed original when nothing is left visible', () => {
    // A message that is ENTIRELY a quote block with no leading text — the
    // parser may consider all of it "quoted"; we must not return ''.
    const text = '> only quoted content\n> nothing else';
    const out = cleanBody(text);
    expect(out.length).toBeGreaterThan(0);
  });

  it('passes plain unquoted text through unchanged (trimmed)', () => {
    expect(cleanBody('  just a plain message  ')).toBe('just a plain message');
  });
});
