/** @jest-environment node */
/**
 * Containers end to end (spec B): the real engine and store, the
 * local-folder source with the in-process converter, the convert and
 * vision workers attached.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';

import type { Document, Source } from '@shared/contracts';

import { openDb } from '../../../db/app-db';
import { createConverter } from '../../../core/engine/convert';
import { createEngine } from '../../../core/engine/engine';
import { openStore, type CoreStore } from '../../../core/store/store';
import { createConvertWorker } from '../../../workers/convert/convert-worker';
import { createVisionWorker } from '../../../workers/vision/vision-worker';
import { localFolderSource } from '../local-folder-source';

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

const msg = (subject: string, body: string, day: number) =>
  `From - Mon, ${day} Jan 2024 10:00:00 +0000\n` +
  `From: Anna Weber <anna@example.de>\n` +
  `To: Bob <bob@example.com>\n` +
  `Subject: ${subject}\n` +
  `Date: Mon, ${day} Jan 2024 10:00:00 +0000\n` +
  `Message-ID: <${subject.toLowerCase()}@example.de>\n\n${body}\n\n`;

async function waitFor(cond: () => Promise<boolean>, ms = 15_000) {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout');
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('local-folder containers end to end', () => {
  let tmp: string;
  let root: string;
  let store: CoreStore;

  beforeEach(async () => {
    tmp = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'lf-containers-e2e-')),
    );
    root = path.join(tmp, 'root');
    fs.mkdirSync(root);
    store = await openStore(await openDb(path.join(tmp, 'test.db')), {
      encrypt: (s: string) => Buffer.from(s, 'utf8'),
      decrypt: (b: Buffer) => b.toString('utf8'),
      detectLanguages: () => [],
    });
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('expands, searches, skips the workers, and reconciles a deleted mailbox', async () => {
    fs.writeFileSync(
      path.join(root, 'inbox.mbox'),
      msg('Kickoff', 'Meet at the zebrafinch pavilion.', 15) +
        msg('Budget', 'The budget is final.', 16),
    );
    const zip = new JSZip();
    zip.file('notes.txt', 'remember the quartzlantern');
    zip.file('offer.docx', await tinyDocx('obsidianferry clause'));
    fs.writeFileSync(
      path.join(root, 'x.zip'),
      await zip.generateAsync({ type: 'uint8array' }),
    );
    fs.writeFileSync(
      path.join(root, 'c.vcf'),
      'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Wilhelmina Quaxley\r\nEMAIL:wq@example.de\r\nEND:VCARD\r\n',
    );
    fs.writeFileSync(
      path.join(root, 'n.enex'),
      '<?xml version="1.0" encoding="UTF-8"?>\n<en-export>\n<note>\n<title>Trip</title>\n' +
        '<content><![CDATA[<en-note><div>marmaladecomet itinerary</div></en-note>]]></content>\n' +
        '<created>20240115T100000Z</created>\n</note>\n</en-export>\n',
    );

    const fetched: string[] = [];
    const source: Source = {
      ...(localFolderSource as unknown as Source),
      fetchBytes: async (session, doc: Document) => {
        fetched.push(doc.externalId);
        return localFolderSource.fetchBytes!(session, doc);
      },
    };
    const engine = createEngine({
      store,
      sources: { get: (id) => (id === 'local-folder' ? source : undefined) },
      inference: {
        complete: async () => '',
        see: async () => '',
        read: async () => '',
        hear: async () => '',
      },
      convert: createConverter({ log: () => {} }),
      logs: { log: () => {} },
    });
    const convert = engine.attach(createConvertWorker());
    const vision = engine.attach(
      createVisionWorker({
        rasterizer: {
          pdfToPngs: async () => ({ pageCount: 0, pages: [] }),
        },
        laneOpen: () => true,
      }),
    );
    const account = await store.createAccount({
      source: 'local-folder',
      identifier: 'this-machine',
      config: { folderRoots: [{ id: root, name: 'root' }], watch: false },
    });

    const hits = async (text: string) =>
      JSON.stringify(await store.read.search({ text } as never));
    const terms = [
      'zebrafinch',
      'quartzlantern',
      'obsidianferry',
      'Quaxley',
      'marmaladecomet',
    ];
    // The probe can fail: an unknown term has no hit.
    expect(await hits('nonexistentqqq')).not.toContain('"id"');
    let run = engine.run(account);
    await waitFor(async () => {
      // eslint-disable-next-line no-await-in-loop
      for (const t of terms)
        if (!(await hits(t)).includes('"id"')) return false;
      return true;
    });
    await run.stop();
    // Give the workers a moment over the committed feed.
    await new Promise((r) => setTimeout(r, 300));

    const mboxId = path.join(root, 'inbox.mbox').split(path.sep).join('/');
    const kickoff = JSON.parse(await hits('zebrafinch')) as unknown;
    expect(JSON.stringify(kickoff)).toContain(`${mboxId}#`);
    // Containers and their children are never fetched by a worker, and
    // every conversion marker stays 'ok'.
    expect(fetched).toEqual([]);
    for (const name of ['inbox.mbox', 'x.zip', 'c.vcf', 'n.enex']) {
      const extId = path.join(root, name).split(path.sep).join('/');
      // eslint-disable-next-line no-await-in-loop
      const row = await store.read.byExternalId(account.id, extId, 'file');
      expect(row).not.toBeNull();
      expect((row!.metadata as { conversion?: unknown }).conversion).toEqual({
        status: 'ok',
      });
    }

    // Delete the mailbox while "closed"; the next run's reconcile and rescan
    // archive it and its children without a mass-archive refusal.
    fs.rmSync(path.join(root, 'inbox.mbox'));
    run = engine.run((await store.account(account.id))!);
    await waitFor(async () => !(await hits('zebrafinch')).includes('"id"'));
    await run.stop();
    expect((await store.account(account.id))?.lastError ?? null).toBeNull();
    expect(await hits('quartzlantern')).toContain('"id"');

    await convert.stop();
    await vision.stop();
  }, 30_000);
});
