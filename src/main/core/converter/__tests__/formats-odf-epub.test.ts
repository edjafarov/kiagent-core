/** @jest-environment node */
import { parse } from '../parsers';
import { epubBytes, odsBytes, odtBytes } from './office-fixtures';

describe('odt', () => {
  it('headings, paragraphs, lists and tables, with the meta title first', async () => {
    const body =
      '<text:h text:outline-level="1">Contract</text:h>' +
      '<text:p>The term is <text:span>two</text:span> years.</text:p>' +
      '<text:list><text:list-item><text:p>Clause A</text:p></text:list-item><text:list-item><text:p>Clause B</text:p></text:list-item></text:list>' +
      '<table:table><table:table-row><table:table-cell><text:p>Fee</text:p></table:table-cell><table:table-cell><text:p>100 EUR</text:p></table:table-cell></table:table-row></table:table>';
    const md = await parse(
      await odtBytes(body, 'Mietvertrag'),
      'application/vnd.oasis.opendocument.text',
      'a.odt',
    );
    expect(md).toBe(
      [
        '# Mietvertrag',
        '# Contract',
        'The term is two years.',
        '- Clause A\n- Clause B',
        'Fee | 100 EUR',
      ].join('\n\n'),
    );
  });
});

describe('ods', () => {
  it('goes through the spreadsheet path', async () => {
    const md = await parse(
      await odsBytes([
        ['Item', 'Cost'],
        ['Rent', '900'],
      ]),
      'application/vnd.oasis.opendocument.spreadsheet',
      'budget.ods',
    );
    expect(md).toContain('## Budget');
    expect(md).toContain('| Rent | 900 |');
  });
});

describe('epub', () => {
  it('reads metadata and chapters in spine order from an OPF in a subdirectory', async () => {
    const md = await parse(
      await epubBytes({
        opfDir: 'OEBPS',
        title: 'Der Prozess',
        author: 'Franz Kafka',
        chapters: [
          {
            href: 'text/ch%201.xhtml',
            html: '<html><body><h1>Verhaftung</h1><p>Jemand musste Josef K. verleumdet haben.</p></body></html>',
          },
          {
            href: 'text/ch2.xhtml',
            html: '<html><body><h1>Gespräch</h1><p>K. war telefonisch verständigt.</p></body></html>',
          },
        ],
      }),
      'application/epub+zip',
      'kafka.epub',
    );
    expect(md!.startsWith('# Der Prozess\n\n**Author:** Franz Kafka')).toBe(
      true,
    );
    expect(md!.indexOf('Verhaftung')).toBeLessThan(md!.indexOf('Gespräch'));
    expect(md).toContain('Jemand musste Josef K. verleumdet haben.');
  });

  it('chapter <head>, <title> and <style> text never reaches the markdown', async () => {
    const md = await parse(
      await epubBytes({
        opfDir: '',
        chapters: [
          {
            href: 'c.xhtml',
            html: '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>HeadTitle</title><style>p{color:red}</style></head><body><p>Body</p></body></html>',
          },
        ],
      }),
      'application/epub+zip',
      'x.epub',
    );
    expect(md).toBe('Body');
  });

  it('an epub without container.xml throws', async () => {
    const JSZip = (await import('jszip')).default;
    const z = new JSZip();
    z.file('mimetype', 'application/epub+zip');
    await expect(
      parse(
        await z.generateAsync({ type: 'uint8array' }),
        'application/epub+zip',
        'x.epub',
      ),
    ).rejects.toThrow('epub');
  });
});
