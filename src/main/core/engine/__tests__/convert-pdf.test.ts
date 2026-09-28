/** @jest-environment node */
import { createConverter } from '../convert';

/** A minimal one-page PDF whose only text is `text`, with a correct xref. */
function tinyPdf(text: string): Uint8Array {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = objects.map((body, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) out += `${String(at).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

describe('converter: pdf', () => {
  it('extracts a PDF small enough to land in a slice of the shared Buffer pool', async () => {
    const bytes = tinyPdf(
      'The marker word for pdf documents is kiasmokepdf. '.repeat(5),
    );
    expect(bytes.length).toBeLessThan(4096);
    const logs = { log: jest.fn() };
    const out = await createConverter(logs)({
      externalId: 'report.pdf',
      type: 'file',
      title: 'report.pdf',
      markdown: null,
      binary: { bytes, mime: 'application/pdf', filename: 'report.pdf' },
      metadata: {},
    } as never);
    expect(logs.log).not.toHaveBeenCalled();
    expect(out.markdown).toContain('kiasmokepdf');
  });

  it('keeps the text of a short real PDF (a receipt, a one-liner)', async () => {
    const out = await createConverter({ log: jest.fn() })({
      externalId: 'receipt.pdf',
      type: 'file',
      title: 'receipt.pdf',
      markdown: null,
      binary: {
        // 42 non-space chars, like the release smoke fixture: under OCR's
        // 200-char bar, but a real text layer that OCR may never reach.
        bytes: tinyPdf('The marker word for pdf documents is kiasmokepdf.'),
        mime: 'application/pdf',
        filename: 'receipt.pdf',
      },
      metadata: {},
    } as never);
    expect(out.markdown).toContain('kiasmokepdf');
  });

  it('leaves a PDF with no real text layer markdown-null for OCR', async () => {
    const out = await createConverter({ log: jest.fn() })({
      externalId: 'scan.pdf',
      type: 'file',
      title: 'scan.pdf',
      markdown: null,
      binary: {
        bytes: tinyPdf('Page 1 of 3'),
        mime: 'application/pdf',
        filename: 'scan.pdf',
      },
      metadata: {},
    } as never);
    expect(out.markdown).toBeNull();
    expect(out).not.toHaveProperty('binary');
  });
});
