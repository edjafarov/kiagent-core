/** Multi-page PDF builder for converter/vision tests (a helper, not a test). */
export type FixturePage =
  | { text?: string[] }
  | { scan: true }
  | { blank: true };
export function multiPagePdf(pages: FixturePage[]): Uint8Array {
  const objs: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const kids: string[] = [];
  for (const p of pages) {
    const stream =
      'text' in p && p.text
        ? `BT /F1 11 Tf 72 740 Td 14 TL ${p.text.map((l) => `(${l.replace(/[()\\]/g, '\\$&')}) '`).join(' ')} ET`
        : 'scan' in p
          ? 'q 400 0 0 500 100 150 cm BI /W 2 /H 2 /CS /G /BPC 8 ID \x80\x40\x40\x80 EI Q'
          : '';
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    const contents = objs.length;
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contents} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`,
    );
    kids.push(`${objs.length} 0 R`);
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`;
  let out = '%PDF-1.4\n';
  const offsets = objs.map((body, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const at of offsets) out += `${String(at).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}
export const PROSE_LINES = [
  'The tenant shall pay the rent on the first day of each month and the',
  'landlord shall maintain the property in good repair at all times.',
];
export const shifted = (lines: string[], k = 7) =>
  lines.map((l) =>
    l.replace(/[a-z]/g, (c) =>
      String.fromCharCode(((c.charCodeAt(0) - 97 + k) % 26) + 97),
    ),
  );
