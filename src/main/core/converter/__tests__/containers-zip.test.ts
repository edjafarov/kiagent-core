/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';
import JSZip from 'jszip';

import { DEFAULT_EXPAND_BUDGET } from '../containers/types';
import { expandZip, type ZipResume } from '../containers/zip';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kia-zip-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

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

async function writeZip(
  name: string,
  files: Record<string, string | Uint8Array>,
): Promise<string> {
  const zip = new JSZip();
  for (const [k, v] of Object.entries(files)) {
    if (k.endsWith('/')) zip.folder(k);
    else zip.file(k, v);
  }
  const p = path.join(dir, name);
  fs.writeFileSync(
    p,
    await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }),
  );
  return p;
}

describe('expandZip', () => {
  it('routes each member by the local file policy', async () => {
    const p = await writeZip('export.zip', {
      'Takeout/notes/a.txt': 'plain notes',
      'Takeout/b.csv': 'name,amount\nrent,900\n',
      'Takeout/c.html':
        '<html><head><title>T</title></head><body><h1>Hello</h1></body></html>',
      'Takeout/d.docx': await tinyDocx('Contract signed'),
      'Takeout/e.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      'Takeout/Mail/f.mbox': 'From - x\n\nbody\n',
      'Takeout/.env': 'SECRET=1',
      'Takeout/dir/': '',
    });
    const r = await expandZip(p, null, DEFAULT_EXPAND_BUDGET);
    const by = Object.fromEntries(r.items.map((i) => [i.key, i]));
    expect(Object.keys(by).sort()).toEqual(
      [
        'zip:Takeout/Mail/f.mbox',
        'zip:Takeout/b.csv',
        'zip:Takeout/c.html',
        'zip:Takeout/d.docx',
        'zip:Takeout/e.png',
        'zip:Takeout/notes/a.txt',
      ].sort(),
    );
    expect(by['zip:Takeout/notes/a.txt'].markdown).toBe('plain notes');
    expect(by['zip:Takeout/b.csv'].markdown).toContain('| rent | 900 |');
    expect(by['zip:Takeout/c.html'].markdown).toContain('# Hello');
    expect(by['zip:Takeout/d.docx'].markdown).toContain('Contract signed');
    expect(by['zip:Takeout/e.png'].markdown).toBeNull();
    expect(by['zip:Takeout/Mail/f.mbox'].markdown).toBeNull();
    expect(by['zip:Takeout/notes/a.txt']).toMatchObject({
      type: 'file',
      title: 'a.txt',
      metadata: {
        member: 'Takeout/notes/a.txt',
        filename: 'a.txt',
        mime: 'text/plain',
        ext: 'txt',
        sizeBytes: 11,
      },
    });
    expect(r.resume).toBeNull();
    expect(r.summary!.startsWith('# export.zip — 6 files\n\n- Takeout/')).toBe(
      true,
    );
  });

  it('a member whose zip headers lie about its size is name-only and the page continues', async () => {
    const p = await writeZip('bomb.zip', {
      'bomb.txt': 'a'.repeat(25 * 1024 * 1024),
      'after.txt': 'still here',
    });
    const bytes = fs.readFileSync(p);
    // Forge "10 bytes" (and a 1:1 ratio) for the first member in both headers.
    let patched = 0;
    for (let i = 0; i + 4 <= bytes.length && patched < 2; i++) {
      const sig = bytes.readUInt32LE(i);
      if (sig === 0x04034b50 && patched === 0) {
        bytes.writeUInt32LE(10, i + 22);
        patched += 1;
      } else if (sig === 0x02014b50 && patched === 1) {
        bytes.writeUInt32LE(bytes.readUInt32LE(i + 20), i + 24);
        patched += 1;
      }
    }
    fs.writeFileSync(p, bytes);
    const r = await expandZip(p, null, DEFAULT_EXPAND_BUDGET);
    const by = Object.fromEntries(r.items.map((i) => [i.key, i]));
    expect(by['zip:bomb.txt'].markdown).toBeNull();
    expect(by['zip:after.txt'].markdown).toBe('still here');
  });

  it('a text member with NUL bytes is name-only', async () => {
    const p = await writeZip('bin.zip', { 'x.txt': 'a\u0000b' });
    const r = await expandZip(p, null, DEFAULT_EXPAND_BUDGET);
    expect(r.items[0].markdown).toBeNull();
  });

  it('pages by entry index with the same keys as one pass', async () => {
    const files = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [`f${i}.txt`, `file ${i}`]),
    );
    const p = await writeZip('many.zip', files);
    const one = await expandZip(p, null, DEFAULT_EXPAND_BUDGET);
    const keys: string[] = [];
    let resume: ZipResume | null = null;
    let last;
    do {
      // eslint-disable-next-line no-await-in-loop
      last = await expandZip(p, resume, { ...DEFAULT_EXPAND_BUDGET, items: 2 });
      keys.push(...last.items.map((i) => i.key));
      resume = last.resume as ZipResume | null;
    } while (resume);
    expect(keys).toEqual(one.items.map((i) => i.key));
    expect(last.summary).toBe(one.summary);
  });

  it('bytes that are not a zip throw', async () => {
    const p = path.join(dir, 'bad.zip');
    fs.writeFileSync(p, 'not a zip');
    await expect(expandZip(p, null, DEFAULT_EXPAND_BUDGET)).rejects.toThrow();
  });
});
