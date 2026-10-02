/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';
import JSZip from 'jszip';

import type {
  Document,
  DocumentInput,
  Source,
  Worker,
} from '@shared/contracts';

import { openDb } from '../../../db/app-db';
import { createConverter } from '../../../core/engine/convert';
import { createEngine } from '../../../core/engine/engine';
import {
  multiPagePdf,
  PROSE_LINES,
  shifted,
} from '../../../core/engine/__tests__/pdf-fixture';
import { createVisionWorker } from '../../vision/vision-worker';
import { openStore } from '../../../core/store/store';
import type { CoreStore } from '../../../core/store/store';
import { classifyDocument } from '../../vision/classify';
import { createConvertWorker } from '../convert-worker';

const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

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

/** A Gmail-shaped attachment: committed bytes-less, markdown null. */
const attachment = (externalId: string, extra = {}): DocumentInput => ({
  externalId,
  type: 'attachment',
  title: 'offer.docx',
  markdown: null,
  metadata: {
    mime: DOCX_MIME,
    filename: 'offer.docx',
    sizeBytes: 33_630,
    ...extra,
  },
  createdAt: null,
});

/** Serves bytes the way gmail's fetchBytes does — nothing pushed at ingest. */
function bytesOnlySource(bytes: Uint8Array): Source {
  return {
    descriptor: {
      id: 'mail',
      name: 'Mail',
      documentTypes: ['attachment'],
      auth: 'none',
    },
    async connect() {
      return { identifier: 'me@test' };
    },
    // eslint-disable-next-line require-yield
    async *pull() {},
    toDocument: (item) => item as DocumentInput,
    fetchBytes: async () => bytes,
  };
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

async function waitFor(cond: () => Promise<boolean>, ms = 5000) {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout');
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('convert pipeline (real store + engine)', () => {
  let dir: string;
  let store: CoreStore;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-convert-'));
    store = await openStore(await openDb(path.join(dir, 'test.db')), {
      encrypt: (s: string) => Buffer.from(s, 'utf8'),
      decrypt: (b: Buffer) => b.toString('utf8'),
      detectLanguages: () => [],
    });
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function engineWith(sources: Map<string, Source>) {
    return createEngine({
      store,
      sources: { get: (id) => sources.get(id) },
      inference: {
        complete: async () => '',
        see: async () => '',
        read: async () => '',
        hear: async () => '',
      },
      convert: async (d) => d,
      logs: { log: () => {} },
    });
  }

  const read = async (accountId: string, externalId: string) =>
    (await store.read.byExternalId(
      accountId,
      externalId,
      'attachment',
    )) as Document;

  it('a bytes-less docx attachment gets its text, searchable, with an ok outcome', async () => {
    const bytes = await tinyDocx('Liability is capped at the fee.');
    const sources = new Map([['mail', bytesOnlySource(bytes)]]);
    const engine = engineWith(sources);
    const account = await store.createAccount({
      source: 'mail',
      identifier: 'x',
    });
    const handle = engine.attach(createConvertWorker());

    await store.commit({
      account: account.id,
      documents: [attachment('m1/2')],
      cursor: 1,
    });

    await waitFor(
      async () => (await read(account.id, 'm1/2'))?.markdown != null,
    );
    const d = await read(account.id, 'm1/2');
    expect(d.markdown).toContain('Liability is capped at the fee');
    expect((d.metadata as any).conversion.status).toBe('ok');
    expect((d.metadata as any).filename).toBe('offer.docx'); // merged, not replaced
    const hits = await store.read.search({ text: 'liability capped' } as never);
    expect(JSON.stringify(hits)).toContain(d.id);
    await handle.stop();
  });

  it('a doc seen before its source registers is deferred, then converted by the re-drive', async () => {
    const bytes = await tinyDocx('Kickoff is the first Monday after payment.');
    const sources = new Map<string, Source>(); // gmail not registered yet (boot order)
    const engine = engineWith(sources);
    const account = await store.createAccount({
      source: 'mail',
      identifier: 'x',
    });
    const worker = createConvertWorker();
    const handle = engine.attach(worker);

    await store.commit({
      account: account.id,
      documents: [attachment('m1/3')],
      cursor: 1,
    });
    await waitFor(
      async () => (await store.ledgerHasDeferred('worker:convert:v2')) === true,
    );
    // Not marked unavailable — nothing was written back.
    expect((await read(account.id, 'm1/3')).metadata).not.toHaveProperty(
      'conversion',
    );

    sources.set('mail', bytesOnlySource(bytes)); // the source finishes registering
    await engine.rerunDeferred(worker);

    const d = await read(account.id, 'm1/3');
    expect(d.markdown).toContain('first Monday after payment');
    expect((d.metadata as any).conversion.status).toBe('ok');
    await handle.stop();
  });

  it('an offline/auth fetch failure is deferred (not failed) and converted once the source recovers', async () => {
    const bytes = await tinyDocx('Travel expenses need prior approval.');
    let online = false;
    const source: Source = {
      ...bytesOnlySource(bytes),
      fetchBytes: async () => {
        if (!online)
          throw new Error('getaddrinfo ENOTFOUND gmail.googleapis.com');
        return bytes;
      },
    };
    const engine = engineWith(new Map([['mail', source]]));
    const account = await store.createAccount({
      source: 'mail',
      identifier: 'x',
    });
    const worker = createConvertWorker();
    const handle = engine.attach(worker);

    await store.commit({
      account: account.id,
      documents: [attachment('m1/6')],
      cursor: 1,
    });
    await waitFor(
      async () => (await store.ledgerHasDeferred('worker:convert:v2')) === true,
    );
    expect((await store.ledgerCounts('worker:convert:v2')).failed).toBe(0);

    online = true;
    await engine.rerunDeferred(worker);
    const d = await read(account.id, 'm1/6');
    expect(d.markdown).toContain('Travel expenses need prior approval');
    await handle.stop();
  });

  it('never calls the source for bytes while the account needs re-auth — defers instead', async () => {
    const bytes = await tinyDocx('unused');
    const fetchBytes = jest.fn(async () => bytes);
    const source: Source = { ...bytesOnlySource(bytes), fetchBytes };
    const engine = engineWith(new Map([['mail', source]]));
    const account = await store.createAccount({
      source: 'mail',
      identifier: 'x',
    });
    await store.commit({
      account: account.id,
      documents: [],
      cursor: null,
      status: 'needsReauth',
    });
    const handle = engine.attach(createConvertWorker());

    await store.commit({
      account: account.id,
      documents: [attachment('m1/7')],
      cursor: 1,
    });
    await waitFor(
      async () => (await store.ledgerHasDeferred('worker:convert:v2')) === true,
    );
    expect(fetchBytes).not.toHaveBeenCalled();
    await handle.stop();
  });

  it('a metadata-only enrich records the outcome without touching existing markdown', async () => {
    const account = await store.createAccount({
      source: 'mail',
      identifier: 'x',
    });
    await store.commit({
      account: account.id,
      documents: [
        { ...attachment('m1/4'), markdown: 'text vision already wrote' },
      ],
      cursor: 1,
    });
    const before = await read(account.id, 'm1/4');
    await store.commit({
      consumer: 'worker:test:v1',
      cursor: 0,
      enrich: [
        {
          documentId: before.id,
          metadata: { conversion: { status: 'text-poor' } },
        },
      ],
    } as never);
    const after = await read(account.id, 'm1/4');
    expect(after.markdown).toBe('text vision already wrote');
    expect((after.metadata as any).conversion.status).toBe('text-poor');
    expect((after.metadata as any).filename).toBe('offer.docx');
    expect(after.seq).toBeGreaterThan(before.seq); // re-emitted on the feed
  });

  it('a text-poor PDF outcome is what hands the doc to vision', async () => {
    const pdf = {
      ...(await (async () => {
        const account = await store.createAccount({
          source: 'mail',
          identifier: 'x',
        });
        await store.commit({
          account: account.id,
          documents: [
            {
              ...attachment('m1/5'),
              title: 'scan.pdf',
              metadata: {
                mime: 'application/pdf',
                filename: 'scan.pdf',
                sizeBytes: 90_000,
              },
            },
          ],
          cursor: 1,
        });
        return read(account.id, 'm1/5');
      })()),
    };
    expect(classifyDocument(pdf)).toBe('skip'); // parser first
    expect(
      classifyDocument({
        ...pdf,
        metadata: { ...pdf.metadata, conversion: { status: 'text-poor' } },
      }),
    ).toBe('candidate');
  });

  it('upgrade: the v2 replay re-parses an old too-large PDF, even with several historical changes', async () => {
    const engine = engineWith(
      new Map([['mail', bytesOnlySource(tinyPdf('large pdf body text here'))]]),
    );
    const account = await store.createAccount({
      source: 'mail',
      identifier: 'u',
    });
    const pdf = (rev: number): DocumentInput => ({
      externalId: 'm1/att',
      type: 'attachment',
      title: 'big.pdf',
      markdown: null,
      metadata: {
        mime: 'application/pdf',
        filename: 'big.pdf',
        sizeBytes: 40 * 1024 * 1024,
        rev,
      },
      createdAt: null,
    });
    // three historical changes for the same doc → one v2 replay batch
    // eslint-disable-next-line no-await-in-loop
    for (const rev of [1, 2, 3])
      await store.commit({
        account: account.id,
        documents: [pdf(rev)],
        cursor: rev,
      });

    // 1. the OLD worker's verdict: too-large (faked; the v1 code is gone)
    const v1: Worker = {
      ...createConvertWorker(),
      version: 1,
      matches: (ch) =>
        ch.kind === 'document' &&
        ch.document.type === 'attachment' &&
        (ch.document.metadata as { conversion?: unknown }).conversion == null,
      work: async (ch, s) => {
        if (ch.kind !== 'document') return 'skip';
        s.enrich({
          documentId: ch.document.id,
          metadata: { conversion: { status: 'too-large', at: 'x' } },
        });
        return 'done';
      },
    };
    const h1 = engine.attach(v1);
    await waitFor(
      async () =>
        ((await read(account.id, 'm1/att')).metadata as any).conversion
          ?.status === 'too-large',
    );
    await h1.stop();

    // 2. the real v2 worker replays the feed from 0
    const h2 = engine.attach(createConvertWorker());
    await waitFor(
      async () =>
        ((await read(account.id, 'm1/att')).metadata as any).conversion
          ?.status !== 'too-large',
    );
    await h2.stop();
    const d = await read(account.id, 'm1/att');
    expect((d.metadata as any).conversion.status).toBe('ok');
    expect(d.markdown).toContain('large pdf body');
  });

  it('needs-ocr end to end: the commit path marks page 2, vision OCRs only it and keeps the prose', async () => {
    const bytes = multiPagePdf([{ text: PROSE_LINES }, { scan: true }]);
    const source: Source = {
      descriptor: {
        id: 'pdfsrc',
        name: 'PDF',
        documentTypes: ['file'],
        auth: 'none',
      },
      async connect() {
        return { identifier: 'pdf@test' };
      },
      async *pull(_session, cursor) {
        if (cursor) return;
        yield {
          phase: 'backfill',
          cursor: 1,
          items: [
            {
              externalId: 'mixed.pdf',
              type: 'file',
              title: 'mixed.pdf',
              markdown: null,
              binary: { bytes, mime: 'application/pdf', filename: 'mixed.pdf' },
              metadata: { mime: 'application/pdf', sizeBytes: bytes.length },
              createdAt: null,
            } as DocumentInput,
          ],
        };
      },
      toDocument: (item) => item as DocumentInput,
      fetchBytes: async () => bytes,
    } as Source;
    const ocrCalls: number[][] = [];
    const engine = createEngine({
      store,
      sources: { get: (id) => (id === 'pdfsrc' ? source : undefined) },
      inference: {
        complete: async () => '',
        see: async () => '',
        read: async () => 'scanned exhibit page two',
        hear: async () => '',
      },
      convert: createConverter({ log: () => {} }),
      logs: { log: () => {} },
    });
    const vision = engine.attach(
      createVisionWorker({
        rasterizer: {
          pdfToPngs: async (_b, { pages }) => {
            ocrCalls.push(pages);
            return {
              pageCount: 2,
              pages: pages.map((n) => ({ page: n, png: new Uint8Array([n]) })),
            };
          },
        },
        laneOpen: () => true,
      }),
    );
    const account = await engine.connect(source, {
      oauth: async () => ({}),
      showQr: () => {},
      prompt: async () => ({}),
      status: () => {},
      pickFolders: async () => [],
    });
    const run = engine.run(account);
    const get = async () =>
      store.read.byExternalId(account.id, 'mixed.pdf', 'file');
    await waitFor(
      async () =>
        ((await get())?.metadata as { extraction?: { engine?: string } })
          ?.extraction?.engine === 'local-ocr',
    );
    await run.stop();
    await vision.stop();
    const d = (await get())!;
    expect(ocrCalls).toEqual([[2]]);
    expect(d.markdown).toContain('tenant shall pay');
    expect(d.markdown).toContain('scanned exhibit page two');
    expect((d.metadata as { conversion?: unknown }).conversion).toEqual({
      status: 'needs-ocr',
      pages: [2],
      quality: 1,
    });
  }, 15000);

  it('v2 replay re-assesses an old garbled PDF row once and never fetches a clean one', async () => {
    const garbledText = shifted([...PROSE_LINES, ...PROSE_LINES]).join('\n');
    const fetched: string[] = [];
    const src: Source = {
      ...bytesOnlySource(multiPagePdf([{ text: shifted(PROSE_LINES) }])),
      fetchBytes: async (_s: unknown, d: Document) => {
        fetched.push(d.externalId);
        return multiPagePdf([{ text: shifted(PROSE_LINES) }]);
      },
    } as Source;
    const engine = engineWith(new Map([[src.descriptor.id, src]]));
    const account = await store.createAccount({
      source: src.descriptor.id,
      identifier: 'r',
    });
    const pdfRow = (externalId: string, markdown: string) =>
      ({
        externalId,
        type: 'attachment',
        title: `${externalId}.pdf`,
        markdown,
        metadata: {
          mime: 'application/pdf',
          filename: `${externalId}.pdf`,
          sizeBytes: 5000,
          conversion: { status: 'ok', at: 'x' },
        },
        createdAt: null,
      }) as DocumentInput;
    await store.commit({
      account: account.id,
      documents: [
        pdfRow('garbled', garbledText),
        pdfRow('clean', PROSE_LINES.join('\n')),
      ],
      cursor: 1,
    });
    const handle = engine.attach(createConvertWorker());
    const conv = async (id: string) =>
      ((await read(account.id, id)).metadata as { conversion?: unknown })
        .conversion;
    await waitFor(async () =>
      JSON.stringify(await conv('garbled')).includes('needs-ocr'),
    );
    await handle.stop();
    expect(await conv('garbled')).toEqual({
      status: 'needs-ocr',
      pages: [1],
      quality: 1,
    });
    expect((await read(account.id, 'garbled')).markdown).toBe(garbledText);
    expect(fetched).toEqual(['garbled']);
  });
});
