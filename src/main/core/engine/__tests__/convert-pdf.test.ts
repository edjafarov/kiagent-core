/** @jest-environment node */
import { multiPagePdf, PROSE_LINES, shifted } from './pdf-fixture';
import { createConverter, parseDetailed } from '../convert';

const conv = (bytes: Uint8Array) =>
  createConverter({ log: jest.fn() })({
    externalId: 'x.pdf',
    type: 'file',
    title: 'x.pdf',
    markdown: null,
    binary: { bytes, mime: 'application/pdf', filename: 'x.pdf' },
    metadata: { mime: 'application/pdf' },
  } as never);

it('a clean 3-page PDF has no marker', async () => {
  const out = await conv(
    multiPagePdf([
      { text: PROSE_LINES },
      { text: PROSE_LINES },
      { text: PROSE_LINES },
    ]),
  );
  expect(out.markdown).toContain('tenant shall pay');
  expect((out.metadata as any).conversion).toBeUndefined();
});
it('a blank last page → needs-ocr [3], text intact', async () => {
  const out = await conv(
    multiPagePdf([
      { text: PROSE_LINES },
      { text: PROSE_LINES },
      { blank: true },
    ]),
  );
  expect((out.metadata as any).conversion).toEqual({
    status: 'needs-ocr',
    pages: [3],
    quality: 1,
  });
  expect(out.markdown).toContain('tenant shall pay');
});
it('a 4-page mixed PDF with pages 2–3 scanned → needs-ocr [2,3]', async () => {
  const out = await conv(
    multiPagePdf([
      { text: PROSE_LINES },
      { scan: true },
      { scan: true },
      { text: PROSE_LINES },
    ]),
  );
  expect((out.metadata as any).conversion).toEqual({
    status: 'needs-ocr',
    pages: [2, 3],
    quality: 1,
  });
});
it('a text cover + scanned exhibit → needs-ocr [2]', async () => {
  const out = await conv(multiPagePdf([{ text: PROSE_LINES }, { scan: true }]));
  expect((out.metadata as any).conversion.pages).toEqual([2]);
});
it('a shifted-glyph text layer → needs-ocr on every page, suspect text KEPT', async () => {
  const out = await conv(
    multiPagePdf([
      { text: shifted(PROSE_LINES) },
      { text: shifted(PROSE_LINES) },
    ]),
  );
  expect((out.metadata as any).conversion.pages).toEqual([1, 2]);
  expect(out.markdown).toContain(shifted(PROSE_LINES)[0].slice(0, 20));
});
it('a page of numbers stays good', async () => {
  const nums = Array.from(
    { length: 20 },
    (_, i) =>
      `2026-03-${String(i + 1).padStart(2, '0')}  1.234,56 EUR  -${i},00`,
  );
  const out = await conv(multiPagePdf([{ text: nums }, { text: PROSE_LINES }]));
  expect((out.metadata as any).conversion).toBeUndefined();
});
it('a whole document under 16 chars stays text-poor (null), as today', async () => {
  const r = await parseDetailed(
    multiPagePdf([{ text: ['Page 1 of 3'] }, { scan: true }]),
    'application/pdf',
    'x.pdf',
  );
  expect(r.markdown).toBeNull();
  expect(r.ocrPages).toBeUndefined();
});
it('the marker is deterministic: converting the same bytes twice gives identical metadata', async () => {
  const b = multiPagePdf([{ text: PROSE_LINES }, { scan: true }]);
  expect(JSON.stringify((await conv(b)).metadata)).toBe(
    JSON.stringify((await conv(b)).metadata),
  );
});
