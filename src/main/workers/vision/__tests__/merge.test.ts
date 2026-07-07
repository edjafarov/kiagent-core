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
