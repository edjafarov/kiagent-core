/** @jest-environment node */
import { parse } from '../parsers';
import { pptxBytes } from './office-fixtures';

const MIME =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';

describe('pptx', () => {
  it('renders title, slides in order with titles, bodies and notes', async () => {
    const md = await parse(
      await pptxBytes(
        [
          {
            title: 'Q3 Review',
            body: ['Revenue up 12%', 'Churn flat'],
            notes: ['Mention the EU deal'],
          },
          { title: 'Next steps', body: ['Hire two engineers'] },
        ],
        { title: 'Board deck', author: 'Dana Weber' },
      ),
      MIME,
      'deck.pptx',
    );
    expect(md).toBe(
      [
        '# Board deck',
        '**Author:** Dana Weber',
        '## Slide 1 — Q3 Review',
        'Revenue up 12%\nChurn flat',
        '### Notes',
        'Mention the EU deal',
        '## Slide 2 — Next steps',
        'Hire two engineers',
      ].join('\n\n'),
    );
  });

  it('skips a slide whose part is missing and keeps the rest', async () => {
    const md = await parse(
      await pptxBytes(
        [{ title: 'One' }, { title: 'Two' }, { title: 'Three' }],
        {
          dropSlide: 2,
        },
      ),
      MIME,
      'deck.pptx',
    );
    expect(md).toContain('## Slide 1 — One');
    expect(md).toContain('## Slide 3 — Three');
    expect(md).not.toContain('Two');
  });

  it('a slide without a title placeholder gets a bare heading; slide numbers in notes are not text', async () => {
    const md = await parse(
      await pptxBytes([{ body: ['Just a picture caption'], notes: ['n'] }]),
      MIME,
      'deck.pptx',
    );
    expect(md).toContain('## Slide 1\n\nJust a picture caption');
    expect(md).toContain('### Notes\n\nn');
    expect(md).not.toMatch(/Notes\n\n1\b/);
  });

  it('a zip whose presentation.xml is not XML throws instead of rendering empty', async () => {
    const JSZip = (await import('jszip')).default;
    const zip = new JSZip();
    zip.file('ppt/presentation.xml', 'garbage, not xml');
    await expect(
      parse(await zip.generateAsync({ type: 'uint8array' }), MIME, 'deck.pptx'),
    ).rejects.toThrow('xml');
  });

  it('bytes that are not a zip throw', async () => {
    await expect(
      parse(new TextEncoder().encode('hello'), MIME, 'deck.pptx'),
    ).rejects.toThrow();
  });
});
