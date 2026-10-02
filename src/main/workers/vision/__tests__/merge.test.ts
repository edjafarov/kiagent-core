import { mergeExtraction } from '../merge';

it('single page: sections without page markers', () => {
  expect(mergeExtraction([{ ocrText: 'hello world' }])).toBe(
    '**Text content (OCR):**\n\nhello world',
  );
});

it('multi page: --- page N --- headers, description + ocr', () => {
  const out = mergeExtraction([
    { ocrText: 'p1 text', description: 'a chart' },
    { description: 'a photo' },
  ]);
  expect(out).toContain('--- page 1 ---');
  expect(out).toContain('**Description:** a chart');
  expect(out).toContain('**Text content (OCR):**\n\np1 text');
  expect(out).toContain('--- page 2 ---');
});

it('caps at 1MB', () => {
  const out = mergeExtraction([{ ocrText: 'x'.repeat(2_000_000) }]);
  expect(out.length).toBeLessThanOrEqual(1_000_000);
});

it('empty pages produce empty string', () => {
  expect(mergeExtraction([{}, { ocrText: '   ' }])).toBe('');
});

it('labels by real page number', () => {
  const md = mergeExtraction([
    { page: 3, ocrText: 'three' },
    { page: 17, ocrText: 'seventeen' },
  ]);
  expect(md).toContain('--- page 3 ---');
  expect(md).toContain('--- page 17 ---');
  expect(md.indexOf('three')).toBeLessThan(md.indexOf('seventeen'));
});

it('a single page numbered > 1 is still labelled', () => {
  expect(mergeExtraction([{ page: 5, ocrText: 'five' }])).toContain(
    '--- page 5 ---',
  );
});
