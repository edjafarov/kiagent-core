/** @jest-environment node */
import JSZip from 'jszip';

import type { Change, Document, WorkerSession } from '@shared/contracts';
import { convertibleKind, MAX_MARKDOWN_CHARS } from '@main/core/engine/convert';
import { FetchDeferredError } from '@main/core/engine/fetch-deferred';
import {
  ConverterCrashedError,
  ConverterTimeoutError,
  ConverterUnavailableError,
} from '@main/core/converter/converter';
import { abortError } from '@main/core/abort';

import {
  MAX_CLOUD_BINARY_BYTES,
  MAX_FETCH_BYTES,
} from '@shared/file-indexability';

import {
  multiPagePdf,
  PROSE_LINES,
  shifted,
} from '@main/core/engine/__tests__/pdf-fixture';
import {
  convertCapFor,
  createConvertWorker,
  isConvertCandidate,
} from '../convert-worker';

import { pdfReadyForOcr } from '../outcome';

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
  over: Partial<WorkerSession> = {},
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
    bump: async () => 1,
    mayBecomeReady: () => false,
    emit: () => {},
    enrich: (e) => enriched.push(e),
    log: () => {},
    ...over,
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
    const big = doc({ metadata: { sizeBytes: convertCapFor('docx') + 1 } });
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

it('an octet-stream .msg attachment and an extensionless Outlook-MIME one are convert candidates', () => {
  expect(
    isConvertCandidate(
      doc({
        type: 'attachment',
        title: 'fwd.msg',
        markdown: null,
        metadata: {
          mime: 'application/octet-stream',
          filename: 'fwd.msg',
          sizeBytes: 20480,
        },
      }),
    ),
  ).toBe(true);
  expect(
    isConvertCandidate(
      doc({
        type: 'attachment',
        title: 'attachment',
        markdown: null,
        metadata: {
          mime: 'application/vnd.ms-outlook',
          filename: 'attachment',
          sizeBytes: 20480,
        },
      }),
    ),
  ).toBe(true);
});

describe('large files (fetch cap, re-admission, crash fence, output cap)', () => {
  const MiB = 1024 * 1024;
  const pdfDoc = (sizeBytes: number, over: Record<string, unknown> = {}) =>
    doc({
      title: 'big.pdf',
      metadata: {
        mime: 'application/pdf',
        filename: 'big.pdf',
        sizeBytes,
        ...over,
      },
    });

  it('a mixed PDF records needs-ocr with pages, quality and NO timestamp, keeping all text', async () => {
    const s = fakeSession(async () =>
      multiPagePdf([{ text: PROSE_LINES }, { scan: true }]),
    );
    await createConvertWorker().work(change(pdfDoc(5000)), s);
    expect(s.enriched[0].metadata.conversion).toEqual({
      status: 'needs-ocr',
      pages: [2],
      quality: 1,
    });
    expect(s.enriched[0].markdown).toContain('tenant shall pay');
  });
  it('a clean PDF records ok with quality 1', async () => {
    const s = fakeSession(async () => multiPagePdf([{ text: PROSE_LINES }]));
    await createConvertWorker().work(change(pdfDoc(5000)), s);
    expect(s.enriched[0].metadata.conversion).toMatchObject({
      status: 'ok',
      quality: 1,
    });
  });
  it('a 40 MiB PDF is fetched and parsed (fetch cap, not eager cap)', async () => {
    const s = fakeSession(async () => tinyPdf('large pdf body text here'));
    expect(await createConvertWorker().work(change(pdfDoc(40 * MiB)), s)).toBe(
      'done',
    );
    expect(s.enriched[0].metadata.conversion.status).toBe('ok');
  });
  it('a docx over the cloud eager cap is too-large and never fetched', async () => {
    const fetchBytes = jest.fn();
    const s = fakeSession(fetchBytes);
    await createConvertWorker().work(
      change(doc({ metadata: { sizeBytes: MAX_CLOUD_BINARY_BYTES + 1 } })),
      s,
    );
    expect(fetchBytes).not.toHaveBeenCalled();
    expect(s.enriched[0].metadata.conversion.status).toBe('too-large');
  });
  it('a 22 MiB cloud docx (between the local and cloud eager caps) is parsed', async () => {
    const s = fakeSession(async () => tinyDocx('docx body text here'));
    await createConvertWorker().work(
      change(doc({ metadata: { sizeBytes: 22 * MiB } })),
      s,
    );
    expect(s.enriched[0].metadata.conversion.status).toBe('ok');
  });
  it('re-admits a too-large row only when the current cap admits it', () => {
    const tl = { conversion: { status: 'too-large', at: 'x' } };
    expect(isConvertCandidate(pdfDoc(40 * MiB, tl))).toBe(true);
    expect(isConvertCandidate(pdfDoc(MAX_FETCH_BYTES + 1, tl))).toBe(false);
    expect(
      isConvertCandidate(doc({ metadata: { sizeBytes: 30 * MiB, ...tl } })),
    ).toBe(false);
    // any other outcome stays final
    expect(
      isConvertCandidate(
        pdfDoc(40 * MiB, { conversion: { status: 'failed', at: 'x' } }),
      ),
    ).toBe(false);
  });
  it('a body over the cap (declared size understated) records too-large that stays final', async () => {
    // Mail parsers fall back to sizeBytes 0; re-admitting on the declared
    // size alone would re-download the body every cycle forever.
    const s = fakeSession(
      async () => new Uint8Array(MAX_CLOUD_BINARY_BYTES + 1),
    );
    const d = doc({ metadata: { sizeBytes: 0 } });
    await createConvertWorker().work(change(d), s);
    const { conversion } = s.enriched[0].metadata;
    expect(conversion.status).toBe('too-large');
    expect(
      isConvertCandidate({ ...d, metadata: { ...d.metadata, conversion } }),
    ).toBe(false);
  });
  it('no crash fence any more: a large PDF parses on every attempt', async () => {
    const parse = jest.fn(async () => ({
      markdown: 'parsed text from the large pdf',
    }));
    const s = fakeSession(async () => tinyPdf('x'), { bump: async () => 9 });
    await createConvertWorker({ parse }).work(change(pdfDoc(40 * MiB)), s);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(s.enriched[0].metadata.conversion.status).toBe('ok');
  });
  it.each([
    [new ConverterCrashedError('x'), 'converter crashed'],
    [new ConverterTimeoutError('x'), 'converter timed out'],
  ])(
    'a converter %p records failed with a fixed reason',
    async (err, reason) => {
      const s = fakeSession(async () => tinyPdf('x'));
      const out = await createConvertWorker({
        parse: async () => {
          throw err;
        },
      }).work(change(pdfDoc(1024)), s);
      expect(out).toBe('done');
      expect(s.enriched[0].metadata.conversion).toMatchObject({
        status: 'failed',
        error: reason,
      });
    },
  );
  it.each([[new ConverterUnavailableError('x')], [abortError()]])(
    '%p defers and writes nothing',
    async (err) => {
      const s = fakeSession(async () => tinyPdf('x'));
      const out = await createConvertWorker({
        parse: async () => {
          throw err;
        },
      }).work(change(pdfDoc(1024)), s);
      expect(out).toBe('defer');
      expect(s.enriched).toHaveLength(0);
    },
  );
  it('admits only once the bytes are in hand, releases after the parse, and passes the signal', async () => {
    const events: string[] = [];
    let fetched!: (b: Uint8Array) => void;
    const ac = new AbortController();
    const s = fakeSession(
      () => {
        events.push('fetch');
        return new Promise<Uint8Array>((r) => {
          fetched = r;
        });
      },
      {
        signal: ac.signal,
        admit: async () => {
          events.push('admit');
          return () => events.push('release');
        },
      },
    );
    let seen: AbortSignal | undefined;
    const run = createConvertWorker({
      parse: async (_b, _m, _n, signal) => {
        seen = signal;
        events.push('parse');
        return { markdown: 'text' };
      },
    }).work(change(pdfDoc(1024)), s);
    await new Promise((r) => setTimeout(r, 50)); // a slow fetch holds no slot
    expect(events).toEqual(['fetch']);
    fetched(tinyPdf('x'));
    await run;
    expect(events).toEqual(['fetch', 'admit', 'parse', 'release']);
    expect(seen).toBe(ac.signal);
  });
  it('releases the slot when the parse throws', async () => {
    const release = jest.fn();
    const s = fakeSession(async () => tinyPdf('x'), {
      admit: async () => release,
    });
    await createConvertWorker({
      parse: async () => {
        throw new ConverterCrashedError('x');
      },
    }).work(change(pdfDoc(1024)), s);
    expect(release).toHaveBeenCalledTimes(1);
  });
  it('uses deps.converter when no parse seam is given', async () => {
    const parseDetailed = jest.fn(async () => ({ markdown: 'from the child' }));
    const s = fakeSession(async () => tinyPdf('x'));
    await createConvertWorker({ converter: { parseDetailed } }).work(
      change(pdfDoc(1024)),
      s,
    );
    expect(parseDetailed).toHaveBeenCalledTimes(1);
    expect(s.enriched[0].markdown).toBe('from the child');
  });
  it('a large parse logs the memory probe line; an eager-size one does not', async () => {
    const parse = jest.fn(async () => ({
      markdown: 'parsed text from the large pdf',
    }));
    const big: string[] = [];
    await createConvertWorker({ parse }).work(
      change(pdfDoc(40 * MiB)),
      fakeSession(async () => tinyPdf('x'), {
        log: (_l: string, m: string) => big.push(m),
      }),
    );
    expect(big.filter((m) => m.startsWith('mem: big.pdf '))).toHaveLength(1);
    const small: string[] = [];
    await createConvertWorker({ parse }).work(
      change(pdfDoc(1024)),
      fakeSession(async () => tinyPdf('x'), {
        log: (_l: string, m: string) => small.push(m),
      }),
    );
    expect(small.filter((m) => m.startsWith('mem:'))).toEqual([]);
  });
  it('fence is not consulted for eager-size docs', async () => {
    const bump = jest.fn(async () => 99);
    const s = fakeSession(async () => tinyPdf('small pdf body text'), { bump });
    await createConvertWorker().work(change(pdfDoc(1000)), s);
    expect(bump).not.toHaveBeenCalled();
  });
  it('a deferred fetch never bumps', async () => {
    const bump = jest.fn(async () => 1);
    const s = fakeSession(
      async () => {
        throw new FetchDeferredError('offline');
      },
      { bump },
    );
    await expect(
      createConvertWorker().work(change(pdfDoc(40 * MiB)), s),
    ).rejects.toBeInstanceOf(FetchDeferredError);
    expect(bump).not.toHaveBeenCalled();
  });
  it('output over 2 MiB chars is truncated and marked', async () => {
    const big = 'word '.repeat(600_000); // 3,000,000 chars
    const s = fakeSession(async () => new TextEncoder().encode(big));
    await createConvertWorker().work(
      change(
        doc({
          title: 'a.txt',
          metadata: {
            mime: 'text/plain',
            filename: 'a.txt',
            sizeBytes: big.length,
          },
        }),
      ),
      s,
    );
    const e = s.enriched[0];
    expect(e.markdown.length).toBeLessThanOrEqual(MAX_MARKDOWN_CHARS + 20);
    expect(e.markdown.endsWith('[truncated]')).toBe(true);
    expect(e.metadata.conversion.truncated).toBe(true);
  });
  it('worker version is 2 (one shared replay for this release)', () => {
    expect(createConvertWorker().version).toBe(2);
  });
  it('too-large no longer hands a PDF to OCR', () => {
    expect(pdfReadyForOcr({ status: 'too-large' })).toBe(false);
    expect(pdfReadyForOcr({ status: 'text-poor' })).toBe(true);
  });
});

describe('re-assessing old garbled PDF rows (garbled-PDF §5)', () => {
  const garbledText = shifted([...PROSE_LINES, ...PROSE_LINES]).join('\n');
  const oldPdf = (markdown: string, conversion?: object) =>
    doc({
      title: 'old.pdf',
      markdown,
      metadata: {
        mime: 'application/pdf',
        filename: 'old.pdf',
        sizeBytes: 5000,
        ...(conversion ? { conversion } : {}),
      },
    });

  it('admits an old garbled PDF row (no marker, or ok without quality)', () => {
    expect(isConvertCandidate(oldPdf(garbledText))).toBe(true);
    expect(
      isConvertCandidate(oldPdf(garbledText, { status: 'ok', at: 'x' })),
    ).toBe(true);
  });
  it('admits any unassessed old PDF row without reading its text (matches stays O(1) in the markdown)', () => {
    // The garble check is O(n) in the markdown; run in matches() it blocked
    // the main loop for every clean row on every replay (review: 500 clean
    // 100 KB rows → 1.8 s). work() assesses once and persists the verdict.
    expect(isConvertCandidate(oldPdf(PROSE_LINES.join('\n')))).toBe(true);
  });
  it('work() marks a clean old row ok + quality WITHOUT fetching; it then no longer matches', async () => {
    const s = fakeSession(async () => {
      throw new Error('must not fetch a clean row');
    });
    const old = oldPdf(PROSE_LINES.join('\n'));
    expect(await createConvertWorker().work(change(old), s)).toBe('done');
    expect(s.enriched).toHaveLength(1);
    expect(s.enriched[0].markdown).toBeUndefined();
    const { conversion } = s.enriched[0].metadata;
    expect(conversion).toMatchObject({ status: 'ok', quality: 1 });
    expect(
      isConvertCandidate({
        ...old,
        metadata: { ...old.metadata, conversion },
      }),
    ).toBe(false);
  });
  it('does not admit anything carrying quality', () => {
    expect(
      isConvertCandidate(
        oldPdf(garbledText, { status: 'ok', at: 'x', quality: 1 }),
      ),
    ).toBe(false);
    expect(
      isConvertCandidate(
        oldPdf(garbledText, { status: 'needs-ocr', pages: [1], quality: 1 }),
      ),
    ).toBe(false);
  });
  it('re-assessment records needs-ocr with quality and leaves the markdown as is', async () => {
    const s = fakeSession(async () =>
      multiPagePdf([{ text: shifted(PROSE_LINES) }, { text: PROSE_LINES }]),
    );
    await createConvertWorker().work(change(oldPdf(garbledText)), s);
    expect(s.enriched[0]).toEqual({
      documentId: 'd',
      metadata: {
        conversion: { status: 'needs-ocr', pages: [1], quality: 1 },
      },
    });
  });
  it('re-assessment of a clean re-parse records ok + quality, markdown untouched', async () => {
    const s = fakeSession(async () => multiPagePdf([{ text: PROSE_LINES }]));
    await createConvertWorker().work(change(oldPdf(garbledText)), s);
    expect(s.enriched[0].markdown).toBeUndefined();
    expect(s.enriched[0].metadata.conversion).toMatchObject({
      status: 'ok',
      quality: 1,
    });
  });
});
