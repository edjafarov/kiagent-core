/** @jest-environment node */
import JSZip from 'jszip';

import type { Change, Document, WorkerSession } from '@shared/contracts';
import { convertibleKind } from '@main/core/engine/convert';
import { FetchDeferredError } from '@main/core/engine/fetch-deferred';

import {
  createConvertWorker,
  isConvertCandidate,
  MAX_CONVERT_BYTES,
} from '../convert-worker';

const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** A minimal but real .docx whose one paragraph is `text`. */
async function tinyDocx(text: string): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
  );
  return zip.generateAsync({ type: 'uint8array' });
}

/** A minimal one-page PDF whose only text is `text` (see convert-pdf.test). */
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

const baseDoc = {
  id: 'd',
  accountId: 'a',
  externalId: 'm1/2',
  type: 'attachment',
  title: 'offer.docx',
  markdown: null,
  metadata: { mime: DOCX_MIME, filename: 'offer.docx', sizeBytes: 33_630 },
  createdAt: null,
  parentId: null,
  contentHash: 'h',
  seq: 1,
  ingestSeq: 1,
  archivedAt: null,
  languages: [],
  ingestedAt: '2026-01-01',
  updatedAt: '2026-01-01',
  scopeRootId: null,
} as Document;

const doc = (over: Partial<Document> = {}): Document => ({
  ...baseDoc,
  ...over,
  metadata: { ...baseDoc.metadata, ...(over.metadata ?? {}) },
});
const change = (d: Document) =>
  ({ seq: 1, kind: 'document', document: d }) as Change;

function fakeSession(
  fetchBytes: WorkerSession['fetchBytes'],
): WorkerSession & { enriched: any[] } {
  const enriched: any[] = [];
  return {
    enriched,
    signal: new AbortController().signal,
    inference: async () => 'x',
    see: async () => 'x',
    seeWithMeta: async () => ({ text: 'x', providerId: 'p', modelId: 'm' }),
    read: async () => 'x',
    hear: async () => 'x',
    fetchBytes,
    emit: () => {},
    enrich: (e) => enriched.push(e),
    log: () => {},
  };
}

const worker = createConvertWorker({
  now: () => new Date('2026-09-28T12:00:00Z'),
});

describe('convertibleKind', () => {
  it.each([
    [DOCX_MIME, 'x.docx', 'docx'],
    ['application/octet-stream', 'Offer.DOCX', 'docx'],
    ['application/pdf', 'a.pdf', 'pdf'],
    [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'a.xlsx',
      'spreadsheet',
    ],
    ['message/rfc822', 'fwd.eml', 'email'],
    ['text/csv', 'a.csv', 'csv'],
    ['text/calendar', 'invite.ics', 'text'],
    ['image/png', 'a.png', null],
    ['application/msword', 'old.doc', null],
    ['application/zip', 'a.zip', null],
  ])('%s %s → %s', (mime, name, kind) => {
    expect(convertibleKind(mime, name)).toBe(kind);
  });
});

describe('isConvertCandidate', () => {
  it('takes a bytes-less docx attachment', () => {
    expect(isConvertCandidate(doc())).toBe(true);
  });
  it.each([
    [
      'already has an outcome (re-entrancy)',
      doc({ metadata: { conversion: { status: 'text-poor' } } }),
    ],
    [
      'already extracted by vision',
      doc({ metadata: { extraction: { engine: 'local-ocr' } } }),
    ],
    ['has text', doc({ markdown: 'plenty of real text in the body' })],
    ['archived', doc({ archivedAt: '2026-09-01' })],
    [
      'an image',
      doc({
        title: 'a.png',
        metadata: { mime: 'image/png', filename: 'a.png' },
      }),
    ],
    [
      'audio',
      doc({
        title: 'a.mp3',
        metadata: { mime: 'audio/mpeg', filename: 'a.mp3' },
      }),
    ],
    ['a thread', doc({ type: 'email.thread' })],
  ])('skips a doc that is %s', (_, d) => {
    expect(isConvertCandidate(d)).toBe(false);
  });
  it('treats non-string connector metadata as absent instead of throwing', () => {
    const d = doc({
      title: null,
      metadata: { mime: 42, filename: {} } as never,
    });
    expect(isConvertCandidate(d)).toBe(false);
  });
});

describe('convert worker', () => {
  it('parses a real docx and writes markdown + ok', async () => {
    const bytes = await tinyDocx(
      'Phase 0 offer: at most 8 interview sessions.',
    );
    const s = fakeSession(async () => bytes);
    expect(await worker.work(change(doc()), s)).toBe('done');
    expect(s.enriched).toHaveLength(1);
    expect(s.enriched[0].markdown).toContain('at most 8 interview sessions');
    expect(s.enriched[0].metadata.conversion).toEqual({
      status: 'ok',
      at: '2026-09-28T12:00:00.000Z',
    });
  });

  it('records failed (no markdown key) when the parser throws', async () => {
    const s = fakeSession(async () => new Uint8Array([1, 2, 3]));
    expect(await worker.work(change(doc()), s)).toBe('done');
    expect(s.enriched[0]).not.toHaveProperty('markdown');
    expect(s.enriched[0].metadata.conversion.status).toBe('failed');
    expect(typeof s.enriched[0].metadata.conversion.error).toBe('string');
  });

  it('records text-poor for a real PDF with a thin text layer, leaving markdown alone', async () => {
    const pdf = doc({
      title: 'scan.pdf',
      metadata: { mime: 'application/pdf', filename: 'scan.pdf' },
    });
    const s = fakeSession(async () => tinyPdf('Page 1 of 3'));
    expect(await worker.work(change(pdf), s)).toBe('done');
    expect(s.enriched[0]).not.toHaveProperty('markdown');
    expect(s.enriched[0].metadata.conversion.status).toBe('text-poor');
  });

  it('parses a short real PDF to ok, keeping its text', async () => {
    const pdf = doc({
      title: 'receipt.pdf',
      metadata: { mime: 'application/pdf', filename: 'receipt.pdf' },
    });
    const s = fakeSession(async () =>
      tinyPdf('Total due: EUR 40.00, paid by card'),
    );
    expect(await worker.work(change(pdf), s)).toBe('done');
    expect(s.enriched[0].markdown).toContain('EUR 40.00');
    expect(s.enriched[0].metadata.conversion.status).toBe('ok');
  });

  it('parses a real PDF with a real text layer to ok', async () => {
    const pdf = doc({
      title: 'offer.pdf',
      metadata: { mime: 'application/pdf', filename: 'offer.pdf' },
    });
    const line = 'The fee is owed even if WWH does not proceed. ';
    const s = fakeSession(async () => tinyPdf(line.repeat(6)));
    expect(await worker.work(change(pdf), s)).toBe('done');
    expect(s.enriched[0].markdown).toContain('The fee is owed');
    expect(s.enriched[0].metadata.conversion.status).toBe('ok');
  });

  it('records too-large without fetching when the declared size is over the cap', async () => {
    const fetchBytes = jest.fn(async () => new Uint8Array(1));
    const s = fakeSession(fetchBytes);
    const big = doc({ metadata: { sizeBytes: MAX_CONVERT_BYTES + 1 } });
    expect(await worker.work(change(big), s)).toBe('done');
    expect(fetchBytes).not.toHaveBeenCalled();
    expect(s.enriched[0].metadata.conversion.status).toBe('too-large');
  });

  it('records unavailable when the source has no bytes', async () => {
    const s = fakeSession(async () => null);
    expect(await worker.work(change(doc()), s)).toBe('done');
    expect(s.enriched[0].metadata.conversion.status).toBe('unavailable');
  });

  it('records nothing when the fetch fails right now — the engine defers it', async () => {
    const s = fakeSession(async () => {
      throw new FetchDeferredError('gmail fetchBytes failed: 401');
    });
    await expect(worker.work(change(doc()), s)).rejects.toBeInstanceOf(
      FetchDeferredError,
    );
    expect(s.enriched).toHaveLength(0);
  });

  it('its own write-back does not re-match (no loop)', async () => {
    const s = fakeSession(async () => null);
    await worker.work(change(doc()), s);
    const after = doc({ metadata: s.enriched[0].metadata });
    expect(worker.matches(change(after))).toBe(false);
  });
});
