/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';
import JSZip from 'jszip';

import crypto from 'crypto';
import zlib from 'zlib';
import { DEFAULT_EXPAND_BUDGET } from '../containers/types';

import {
  MAX_ZIP_CHILDREN,
  ZIP_LIMITS,
  expandZip,
  extractMember,
  scratchName,
  type ExtractOutcome,
  type ZipResume,
} from '../containers/zip';
import type { ChildItem, ExpandBudget } from '../containers/types';

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

/** Pages a zip to the end, playing the source's part for nested members:
 *  'skip' marks them name-only; 'extract' copies them into `scratch`. */
async function drain(
  p: string,
  mode: 'skip' | 'extract',
  budget: ExpandBudget = DEFAULT_EXPAND_BUDGET,
  outcomes: ExtractOutcome[] = [],
): Promise<{
  items: ChildItem[];
  summary?: string;
  resume: null;
  pages: number;
}> {
  const scratch = path.join(dir, 'scratch');
  fs.mkdirSync(scratch, { recursive: true });
  const items: ChildItem[] = [];
  let resume: ZipResume | null = null;
  for (let pages = 1; pages < 1000; pages++) {
    const n = resume?.nested;
    if (n && !n.skip) {
      if (mode === 'skip') n.skip = true;
      else {
        const dest = path.join(scratch, scratchName(p, n));
        if (!fs.existsSync(dest)) {
          // eslint-disable-next-line no-await-in-loop
          const out = await extractMember(p, n, dest);
          outcomes.push(out);
          if (out !== 'ok') n.skip = true;
        }
        if (!n.skip) n.file = dest;
      }
    }
    // eslint-disable-next-line no-await-in-loop
    const r = await expandZip(p, resume, budget);
    items.push(...r.items);
    if (r.resume === null)
      return { items, summary: r.summary, resume: null, pages };
    resume = r.resume as ZipResume;
  }
  throw new Error('zip never finished');
}

/** Wraps every write-mode FileHandle's `write`; `onWrite` may throw. */
function spyOnWrites(onWrite: (chunk: Buffer) => void): void {
  const realOpen = fs.promises.open;
  jest.spyOn(fs.promises, 'open').mockImplementation((async (
    ...args: Parameters<typeof fs.promises.open>
  ) => {
    const fh = await realOpen(...args);
    if (args[1] !== 'w') return fh;
    const write = fh.write.bind(fh) as (...a: unknown[]) => Promise<unknown>;
    (fh as { write: unknown }).write = async (
      chunk: Buffer,
      ...rest: unknown[]
    ) => {
      onWrite(chunk.subarray(0, (rest[1] as number) ?? chunk.length));
      return write(chunk, ...rest);
    };
    return fh;
  }) as typeof fs.promises.open);
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
    // Without extraction (the source skips), the mailbox is name-only.
    const r = await drain(p, 'skip');
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

describe('central-directory resume', () => {
  it('a resumed page reads only its own entries, same keys as one pass', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 300; i++)
      files[`f${String(i).padStart(3, '0')}.txt`] = `n${i}`;
    const p = await writeZip('many.zip', files);
    const one = await expandZip(p, null, {
      ...DEFAULT_EXPAND_BUDGET,
      items: 1000,
    });
    expect(one.items).toHaveLength(300);

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const yauzl = require('yauzl') as {
      ZipFile: { prototype: { readEntry(): void } };
    };
    const spy = jest.spyOn(yauzl.ZipFile.prototype, 'readEntry');
    const keys: string[] = [];
    let resume: ZipResume | null = null;
    let pages = 0;
    try {
      do {
        spy.mockClear();
        // eslint-disable-next-line no-await-in-loop
        const page = await expandZip(p, resume, {
          ...DEFAULT_EXPAND_BUDGET,
          items: 50,
        });
        keys.push(...page.items.map((c) => c.key));
        // 50 entries plus the one read that finds the end (last page).
        expect(spy.mock.calls.length).toBeLessThanOrEqual(51);
        resume = page.resume as ZipResume | null;
        pages += 1;
      } while (resume);
    } finally {
      spy.mockRestore();
    }
    expect(pages).toBe(7); // six full pages, then the one that finds the end
    expect(keys).toEqual(one.items.map((c) => c.key));
  });

  it('pins the yauzl walk fields the resume relies on', async () => {
    const p = await writeZip('pin.zip', { 'a.txt': 'a' });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const yauzl = require('yauzl') as typeof import('yauzl');
    const zf = await new Promise<import('yauzl').ZipFile>((res, rej) =>
      yauzl.open(p, { lazyEntries: true }, (e, z) =>
        e || !z ? rej(e) : res(z),
      ),
    );
    const w = zf as unknown as {
      readEntryCursor: unknown;
      entriesRead: unknown;
    };
    expect(typeof w.readEntryCursor).toBe('number');
    expect(typeof w.entriesRead).toBe('number');
    zf.close();
  });

  it('falls back to the skip scan for a resume without an offset', async () => {
    const p = await writeZip('old.zip', {
      'a.txt': 'a',
      'b.txt': 'b',
      'c.txt': 'c',
    });
    const r = await expandZip(
      p,
      { index: 2, count: 2, head: ['a.txt', 'b.txt'] },
      DEFAULT_EXPAND_BUDGET,
    );
    expect(r.items.map((c) => c.title)).toEqual(['c.txt']);
  });
});

/** A hand-built zip (JSZip overwrites duplicate names and computes honest
 *  sizes): each entry may lie about its sizes. */
function rawZip(
  name: string,
  entries: Array<{
    name: string;
    data: Buffer;
    deflate?: boolean;
    declaredSize?: number;
    declaredCompressed?: number;
    crc?: number;
  }>,
): string {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const body = e.deflate ? zlib.deflateRawSync(e.data) : e.data;
    const crc = e.crc ?? zlib.crc32(e.data);
    const usize = e.declaredSize ?? e.data.length;
    const csize = e.declaredCompressed ?? body.length;
    const fname = Buffer.from(e.name);
    const method = e.deflate ? 8 : 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc >>> 0, 14);
    lh.writeUInt32LE(csize, 18);
    lh.writeUInt32LE(usize, 22);
    lh.writeUInt16LE(fname.length, 26);
    const local = Buffer.concat([lh, fname, body]);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(0x21, 14); // 1980-01-01
    ch.writeUInt32LE(crc >>> 0, 16);
    ch.writeUInt32LE(csize, 20);
    ch.writeUInt32LE(usize, 24);
    ch.writeUInt16LE(fname.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([ch, fname]));
    locals.push(local);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.concat([...locals, cd, eocd]));
  return p;
}

const mboxOf = (...subjects: string[]) =>
  subjects
    .map(
      (s, i) =>
        `From - Mon, ${i + 1} Jan 2024 10:00:00 +0000\nFrom: a@x.de\nSubject: ${s}\n` +
        `Date: Mon, ${i + 1} Jan 2024 10:00:00 +0000\nMessage-ID: <${s}@x.de>\n\nbody ${s}\n\n`,
    )
    .join('');

describe('nested containers inside a zip', () => {
  afterEach(() => {
    ZIP_LIMITS.children = MAX_ZIP_CHILDREN;
    jest.restoreAllMocks();
  });

  it('expands a Takeout mailbox member into flat message children', async () => {
    const p = await writeZip('takeout.zip', {
      'Takeout/a.txt': 'hello',
      'Takeout/Mail/All mail.mbox': mboxOf('One', 'Two', 'Three'),
    });
    const outcomes: ExtractOutcome[] = [];
    const r = await drain(p, 'extract', DEFAULT_EXPAND_BUDGET, outcomes);
    expect(outcomes).toEqual(['ok']);
    const msgs = r.items.filter((c) => c.type === 'email.message');
    expect(msgs.map((c) => c.title)).toEqual(['One', 'Two', 'Three']);
    for (const c of msgs)
      expect(c.key).toMatch(/^zip:Takeout\/Mail\/All mail\.mbox#msg:/);
    expect(r.items.find((c) => c.key === 'zip:Takeout/a.txt')).toBeDefined();
    expect(r.summary).toContain('# takeout.zip — 2 files');
    expect(r.summary).toContain('- Takeout/Mail/All mail.mbox — 3 messages');
  });

  it('pages inside the member with the same keys as one pass', async () => {
    const p = await writeZip('paged.zip', {
      'a.txt': 'a',
      'm.mbox': mboxOf('A', 'B', 'C', 'D', 'E'),
      'z.txt': 'z',
    });
    const one = await drain(p, 'extract', {
      ...DEFAULT_EXPAND_BUDGET,
      items: 1000,
    });
    const paged = await drain(p, 'extract', {
      ...DEFAULT_EXPAND_BUDGET,
      items: 2,
    });
    expect(paged.items.map((c) => c.key)).toEqual(one.items.map((c) => c.key));
    expect(paged.items).toHaveLength(7);
  });

  it('never exceeds the page budget across the nested → ordinary transition', async () => {
    const p = await writeZip('edge.zip', {
      'm.mbox': mboxOf('A', 'B'),
      'z.txt': 'z',
    });
    const scratch = path.join(dir, 'scratch');
    fs.mkdirSync(scratch, { recursive: true });
    const first = await expandZip(p, null, {
      ...DEFAULT_EXPAND_BUDGET,
      items: 2,
    });
    const n = (first.resume as ZipResume).nested!;
    const dest = path.join(scratch, scratchName(p, n));
    expect(await extractMember(p, n, dest)).toBe('ok');
    n.file = dest;
    const second = await expandZip(p, first.resume as ZipResume, {
      ...DEFAULT_EXPAND_BUDGET,
      items: 2,
    });
    expect(second.items.map((c) => c.title)).toEqual(['A', 'B']);
    expect(second.resume).not.toBeNull(); // z.txt waits for the next page
  });

  it('waits (same resume, no items) while the scratch copy is missing', async () => {
    const p = await writeZip('wait.zip', { 'm.mbox': mboxOf('A') });
    const first = await expandZip(p, null, DEFAULT_EXPAND_BUDGET);
    const resume = first.resume as ZipResume;
    resume.nested!.file = path.join(dir, 'missing.mbox');
    const again = await expandZip(p, resume, DEFAULT_EXPAND_BUDGET);
    expect(again.items).toEqual([]);
    expect((again.resume as ZipResume).nested).toMatchObject({
      member: 'm.mbox',
      inner: null,
    });
    expect((again.resume as ZipResume).nested!.file).toBeUndefined();
  });

  it('expands vCard and ENEX members; a nested zip stays name-only', async () => {
    const p = await writeZip('mixed.zip', {
      'c.vcf': 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Ada Lovelace\r\nEND:VCARD\r\n',
      'n.enex':
        '<en-export><note><title>Trip</title><content><![CDATA[<en-note>go</en-note>]]></content></note></en-export>',
      'inner.zip': `PK\u0005\u0006${'\u0000'.repeat(18)}`,
    });
    const r = await drain(p, 'extract');
    expect(r.items.find((c) => c.type === 'contact.card')?.title).toBe(
      'Ada Lovelace',
    );
    expect(r.items.find((c) => c.type === 'note')?.title).toBe('Trip');
    expect(r.items.find((c) => c.key === 'zip:inner.zip')?.markdown).toBeNull();
    expect(r.summary).toContain('- c.vcf — 1 card');
    expect(r.summary).toContain('- n.enex — 1 note');
  });

  it('two members with the same name get distinct scratch copies', async () => {
    const p = rawZip('dup.zip', [
      { name: 'mail.mbox', data: Buffer.from(mboxOf('First')) },
      { name: 'mail.mbox', data: Buffer.from(mboxOf('Second')) },
    ]);
    const r = await drain(p, 'extract');
    expect(r.items.map((c) => c.title)).toEqual(['First', 'Second']);
  });

  it('a forged smaller size (stored, CRC of the full payload) is corrupt, not truncated', async () => {
    const data = Buffer.from(mboxOf('A', 'B'));
    const p = rawZip('forged.zip', [
      {
        name: 'm.mbox',
        data,
        declaredSize: 40,
        declaredCompressed: 40,
      },
    ]);
    const outcomes: ExtractOutcome[] = [];
    const r = await drain(p, 'extract', DEFAULT_EXPAND_BUDGET, outcomes);
    expect(outcomes).toEqual(['corrupt']);
    expect(r.items.map((c) => c.key)).toEqual(['zip:m.mbox']); // name-only
    expect(fs.readdirSync(path.join(dir, 'scratch'))).toEqual([]);
  });

  it('a member that inflates past its declared size is corrupt, and the copy stops at the cap', async () => {
    const data = Buffer.from(mboxOf('A', 'B', 'C'))
      .toString()
      .repeat(2000);
    const p = rawZip('over.zip', [
      {
        name: 'm.mbox',
        data: Buffer.from(data),
        deflate: true,
        declaredSize: 50,
      },
    ]);
    let written = 0;
    spyOnWrites((chunk) => {
      written += chunk.length;
    });
    const outcomes: ExtractOutcome[] = [];
    await drain(p, 'extract', DEFAULT_EXPAND_BUDGET, outcomes);
    expect(outcomes).toEqual(['corrupt']);
    expect(written).toBeLessThanOrEqual(50);
    expect(fs.readdirSync(path.join(dir, 'scratch'))).toEqual([]);
  });

  it('a different zip at the same path is a mismatch', async () => {
    const p = await writeZip('swap.zip', { 'm.mbox': mboxOf('A') });
    const n = (
      (await expandZip(p, null, DEFAULT_EXPAND_BUDGET)).resume as ZipResume
    ).nested!;
    await writeZip('swap.zip', { 'm.mbox': mboxOf('Other') });
    expect(await extractMember(p, n, path.join(dir, 'x.mbox'))).toBe(
      'mismatch',
    );
  });

  it('a disk that fills mid-copy is nospace and leaves no .part', async () => {
    const data = Buffer.concat([
      Buffer.from(mboxOf('A')),
      crypto.randomBytes(4 * 1024 * 1024),
    ]);
    const p = rawZip('full.zip', [{ name: 'm.mbox', data, deflate: true }]);
    const n = (
      (await expandZip(p, null, DEFAULT_EXPAND_BUDGET)).resume as ZipResume
    ).nested!;
    let writes = 0;
    spyOnWrites(() => {
      writes += 1;
      if (writes === 2)
        throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
    });
    const dest = path.join(dir, 'full.mbox');
    expect(await extractMember(p, n, dest)).toBe('nospace');
    expect(fs.existsSync(`${dest}.part`)).toBe(false);
    expect(fs.existsSync(dest)).toBe(false);
  });

  it('too little free disk is nospace', async () => {
    const p = await writeZip('big.zip', { 'm.mbox': mboxOf('A') });
    const n = (
      (await expandZip(p, null, DEFAULT_EXPAND_BUDGET)).resume as ZipResume
    ).nested!;
    jest
      .spyOn(fs.promises, 'statfs')
      .mockResolvedValue({ bavail: 1, bsize: 1 } as never);
    expect(await extractMember(p, n, path.join(dir, 'x.mbox'))).toBe('nospace');
  });

  it('an abort mid-copy settles promptly and leaves no .part', async () => {
    // Incompressible: a compressible payload would trip the ratio guard.
    const data = Buffer.concat([
      Buffer.from(mboxOf('A')),
      crypto.randomBytes(40 * 1024 * 1024),
    ]);
    const p = rawZip('abort.zip', [{ name: 'm.mbox', data, deflate: true }]);
    const n = (
      (await expandZip(p, null, DEFAULT_EXPAND_BUDGET)).resume as ZipResume
    ).nested!;
    const dest = path.join(dir, 'abort.mbox');
    const ac = new AbortController();
    const run = extractMember(p, n, dest, { signal: ac.signal });
    setTimeout(() => ac.abort(), 5);
    const t0 = Date.now();
    await expect(run).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(fs.existsSync(`${dest}.part`)).toBe(false);
    expect(fs.existsSync(dest)).toBe(false);
  }, 20_000);

  it('the children cap counts nested items', async () => {
    ZIP_LIMITS.children = 2;
    const p = await writeZip('cap.zip', { 'm.mbox': mboxOf('A', 'B', 'C') });
    const r = await drain(p, 'extract');
    expect(r.items).toHaveLength(2);
    expect(r.summary).toMatch(/^# cap\.zip — first /);
  });
});
