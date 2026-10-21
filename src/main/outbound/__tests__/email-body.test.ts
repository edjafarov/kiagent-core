import { bodyHash, collapse, renderEmailBody, wordsOf } from '../email-body';

const html = (md: string) => renderEmailBody(md).html;

describe('renderEmailBody', () => {
  it('renders headings, bold, lists and a table as HTML', () => {
    const out = html(
      '## Decisions\n\n- **Release** go-ahead\n- Send-As\n\n| a | b |\n|---|---|\n| 1 | 2 |',
    );
    expect(out).toMatch(/<h2 style="[^"]+">Decisions<\/h2>/);
    expect(out).toContain('<strong>Release</strong>');
    expect(out).toMatch(/<ul>\s*<li>/);
    expect(out).toContain('<table>');
    expect(out).not.toContain('##');
    expect(out).not.toContain('**');
  });

  it('keeps a single newline as a line break', () => {
    expect(html('Hi Anna,\nthanks')).toContain('Hi Anna,<br>thanks');
  });

  it('escapes raw HTML instead of passing it through', () => {
    for (const raw of [
      'before <!-- hide\n\nafter',
      '<style>p{display:none}</style>\n\nafter',
      '<script>alert(1)</script>',
      'x <img src=x onerror=alert(1)> y',
      '<div onclick="x()">hi</div>',
    ]) {
      const out = html(raw);
      expect(out).not.toMatch(/<(script|style|img|div onclick)/i);
      expect(out).not.toContain('<!--');
    }
    expect(html('before <!-- hide\n\nafter')).toContain('after');
  });

  it('keeps only http(s) and mailto links', () => {
    expect(html('[site](https://example.com)')).toContain(
      '<a href="https://example.com">site</a>',
    );
    expect(html('[mail](mailto:a@b.c)')).toContain('href="mailto:a@b.c"');
    const bad = html('[x](javascript:alert(1)) [y](data:text/html,hi)');
    expect(bad).not.toContain('href=');
    expect(bad).toContain('x');
  });

  it('turns images into links, never loads them', () => {
    const out = html('![chart](https://example.com/c.png)');
    expect(out).not.toContain('<img');
    expect(out).toContain('<a href="https://example.com/c.png">chart</a>');
  });

  it('is deterministic and keeps the Markdown as the text part', () => {
    const md = '# T\n\n*a* and `b`\n\n1. one\n2. two';
    expect(renderEmailBody(md)).toEqual(renderEmailBody(md));
    expect(renderEmailBody(md).text).toBe(md);
  });

  it('never throws on odd input', () => {
    for (const md of ['', '```', '[', '<', '\u0000', 'x'.repeat(100_000)])
      expect(() => renderEmailBody(md)).not.toThrow();
  });
});

describe('wordsOf', () => {
  it('ignores tags, styles and whitespace', () => {
    expect(wordsOf('<p>Hello <b>Sam</b></p>\n<p>bye</p>')).toBe(
      wordsOf('<div style="x">Hello   Sam</div><div>bye</div>'),
    );
    expect(wordsOf('a&nbsp;&amp;&#8212;b')).toBe('a &—b');
  });

  it('a changed word differs', () => {
    expect(wordsOf('<p>Pay €100</p>')).not.toBe(wordsOf('<p>Pay €1,000</p>'));
  });

  it('link targets and images count', () => {
    expect(wordsOf('<a href="https://a.com">here</a>')).not.toBe(
      wordsOf('<a href="https://b.com">here</a>'),
    );
    expect(wordsOf('<p>Approved</p>')).not.toBe(
      wordsOf('<p>Approved<img src="cid:x"></p>'),
    );
  });

  it('drops head, style and comments', () => {
    expect(
      wordsOf('<html><head><style>p{}</style></head><body>hi<!-- x --></body>'),
    ).toBe('hi');
  });

  it('Kia’s rendering re-serialized by a provider has the same words', () => {
    const md =
      '## Plan\n\n- **one**\n- two [doc](https://x.io/d)\n\nThanks,\nEd';
    const ours = html(md);
    const theirs = `<html><head><meta charset="utf-8"></head><body><div dir="ltr">${ours
      .replace(/<strong>/g, '<b>')
      .replace(/<\/strong>/g, '</b>')
      .replace(/\n/g, '\r\n')}</div></body></html>`;
    expect(wordsOf(theirs)).toBe(wordsOf(ours));
  });
});

describe('bodyHash / collapse', () => {
  it('hashes the html and the text part', () => {
    expect(bodyHash({ bodyText: 'a' })).not.toBe(
      bodyHash({ bodyText: 'a', bodyHtml: '<p>a</p>' }),
    );
    expect(bodyHash({ bodyText: 'a', bodyHtml: 'x' })).toBe(
      bodyHash({ bodyText: 'a', bodyHtml: 'x' }),
    );
  });
  it('collapses all whitespace', () => {
    expect(collapse(' a \n b\t')).toBe('a b');
  });
});
