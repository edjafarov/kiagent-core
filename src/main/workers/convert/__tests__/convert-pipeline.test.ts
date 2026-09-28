/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';
import JSZip from 'jszip';

import type { Document, DocumentInput, Source } from '@shared/contracts';

import { openDb } from '../../../db/app-db';
import { createEngine } from '../../../core/engine/engine';
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
      async () => (await store.ledgerHasDeferred('worker:convert:v1')) === true,
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
      async () => (await store.ledgerHasDeferred('worker:convert:v1')) === true,
    );
    expect((await store.ledgerCounts('worker:convert:v1')).failed).toBe(0);

    online = true;
    await engine.rerunDeferred(worker);
    const d = await read(account.id, 'm1/6');
    expect(d.markdown).toContain('Travel expenses need prior approval');
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
});
