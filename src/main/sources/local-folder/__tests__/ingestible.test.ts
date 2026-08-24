import { VISUAL_EXTS } from '@main/workers/vision/classify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isIngestible, INGESTIBLE_DENY_RE } from '../ingestible';
import { classifyPath, resolvePathMime } from '../mime';
import { buildItem } from '../scanner';

describe('isIngestible', () => {
  it('accepts every format a pipeline can actually read', () => {
    const accepted = [
      // decoded inline by the source
      'a.txt',
      'a.md',
      'a.markdown',
      'a.json',
      'a.yaml',
      'a.yml',
      'a.toml',
      'a.ini',
      'a.cfg',
      'a.conf',
      'a.xml',
      'a.sql',
      'a.log',
      'a.tsv',
      'a.rst',
      'a.org',
      'a.tex',
      'a.srt',
      'a.vtt',
      'a.ics',
      'a.vcf',
      'a.sh',
      'a.py',
      'a.js',
      'a.ts',
      'a.rb',
      'a.go',
      'a.rs',
      'a.swift',
      // parsed by the engine converter
      'a.pdf',
      'a.docx',
      'a.xlsx',
      'a.xls',
      'a.csv',
      'a.html',
      'a.htm',
      'a.eml',
      'a.emlx',
      'a.mbox',
      // vision
      'a.png',
      'a.jpg',
      'a.jpeg',
      'a.gif',
      'a.webp',
      'a.heic',
      'a.tiff',
      'a.bmp',
      // ASR
      'a.mp3',
      'a.m4a',
      'a.wav',
      'a.flac',
      'a.mp4',
      'a.mov',
    ];
    const rejected = accepted.filter((f) => !isIngestible(`/root/${f}`));
    expect(rejected).toEqual([]);
  });

  it('rejects the formats that made 80% of a real corpus unsearchable', () => {
    // Every one of these was measured in a live 8,900-doc local-folder
    // account, all with empty markdown: a game's shader cache (63% of the
    // corpus on its own), DICOM scans, archives, game saves, GIS sidecars.
    const junk = [
      '/d/shadercache/dx12/ps_6_0/0001.scache',
      '/d/shadercache/dx12/ps_6_0/0001.bin',
      '/d/Horos Data/DATABASE.noindex/10000/753.dcm',
      '/d/save games/autosave_2bb6f912.eu5',
      '/d/x.sav',
      '/d/x.tar',
      '/d/x.zip',
      '/d/x.dmg',
      '/d/x.exe',
      '/d/flags/TZA.svgz',
      '/d/x.avi',
      '/d/x.shp',
      '/d/x.dbf',
      '/d/x.prj',
      '/d/x.shx',
      '/d/x.mss',
      '/d/x.vsix',
      '/d/x.certsigningrequest',
    ];
    const accepted = junk.filter((f) => isIngestible(f));
    expect(accepted).toEqual([]);
  });

  it('never ingests credential material, however plain-text it is', () => {
    const secrets = [
      '/d/.env',
      '/d/.env.local',
      '/d/.env.production',
      '/d/id_rsa',
      '/d/id_ed25519',
      '/d/server.pem',
      '/d/private.key',
      '/d/cert.p12',
      '/d/.npmrc',
      '/d/.netrc',
      '/d/.git-credentials',
    ];
    const leaked = secrets.filter((f) => isIngestible(f));
    expect(leaked).toEqual([]);
    // and the deny rule is what did it, not an accidental extension miss
    expect(INGESTIBLE_DENY_RE.test('.env.local')).toBe(true);
  });

  it('honours the macOS .noindex directory marker anywhere in the path', () => {
    // Spotlight's own convention. The measured corpus had 752 DICOM files
    // under `Horos Data/DATABASE.noindex/`, a directory macOS itself is told
    // to skip. Applies even to formats that would otherwise be ingestible.
    expect(isIngestible('/d/Horos Data/DATABASE.noindex/scan.jpg')).toBe(false);
    expect(isIngestible('/d/notes.noindex/a.md')).toBe(false);
    expect(isIngestible('/d/Horos Data/DATABASE/scan.jpg')).toBe(true);
  });

  it('derives its image set from the vision worker rather than restating it', () => {
    // A format added to VISUAL_EXTS must become ingestible with no edit here;
    // a hand-copied list would silently drift.
    for (const ext of VISUAL_EXTS) {
      expect(isIngestible(`/d/photo.${ext}`)).toBe(true);
    }
  });

  it('is case-insensitive about extensions', () => {
    expect(isIngestible('/d/IMG_1494.JPG')).toBe(true);
    expect(isIngestible('/d/REPORT.PDF')).toBe(true);
    expect(isIngestible('/d/CACHE.SCACHE')).toBe(false);
  });

  it('rejects an extensionless file rather than guessing', () => {
    expect(isIngestible('/d/Makefile')).toBe(false);
    expect(isIngestible('/d/LICENSE')).toBe(false);
  });
});

describe('classifyPath', () => {
  it('routes text-ish data files to the text bucket despite their mime', () => {
    // `mime` maps .json to application/json and — the classic trap — .ts to
    // video/mp2t. Extension wins for the formats we know are text.
    expect(classifyPath('/d/a.json')).toBe('text');
    expect(classifyPath('/d/a.ts')).toBe('text');
    expect(classifyPath('/d/a.yaml')).toBe('text');
  });

  it('routes email to the binary bucket so the converter parses it', () => {
    // .eml must NOT be decoded raw: the body is quoted-printable/base64 and
    // a raw decode indexes attachment blobs instead of the message.
    expect(classifyPath('/d/msg.eml')).toBe('binary');
    expect(classifyPath('/d/msg.emlx')).toBe('binary');
  });

  it('leaves genuinely unreadable formats unsupported', () => {
    expect(classifyPath('/d/x.scache')).toBe('unsupported');
    expect(classifyPath('/d/x.dcm')).toBe('unsupported');
  });
});

describe('text-extension files that are secretly binary', () => {
  function write(name: string, bytes: Buffer): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf-textsniff-'));
    const p = path.join(dir, name);
    fs.writeFileSync(p, bytes);
    return p;
  }

  it('reports text/plain for a TEXT_EXTS file, never the lookup mime', async () => {
    // `mime` calls .ts video/mp2t. Storing that verbatim is not cosmetic: the
    // audio worker's candidate gate allows any `video/*` and does NOT check
    // whether the doc already has content, so every TypeScript file in a
    // watched folder would queue for speech transcription.
    expect(resolvePathMime('/d/a.ts')).toBe('text/plain');
    expect(resolvePathMime('/d/a.json')).toBe('text/plain');
    // formats with a real parser keep their true mime
    expect(resolvePathMime('/d/a.pdf')).toBe('application/pdf');
    expect(resolvePathMime('/d/a.jpg')).toBe('image/jpeg');

    const p = write('mod.ts', Buffer.from('export const x = 1;\n', 'utf8'));
    const item = await buildItem(p, fs.statSync(p));
    expect(item.mime).toBe('text/plain');
    expect(item.markdownText).toContain('export const x = 1;');
  });

  it('does not decode a real MPEG-TS video as if it were TypeScript', async () => {
    // A genuine .ts transport stream: NUL bytes throughout. Decoding it as
    // UTF-8 would push megabytes of mojibake into markdown and the search
    // index. It stays a metadata-only document instead.
    const ts = Buffer.alloc(4096);
    ts.writeUInt8(0x47, 0); // MPEG-TS sync byte
    const p = write('stream.ts', ts);
    const item = await buildItem(p, fs.statSync(p));
    expect(item.markdownText).toBeNull();
    expect(item.binary).toBeNull();
  });

  it('still decodes text that merely looks unusual', async () => {
    const p = write(
      'notes.md',
      Buffer.from('héllo — em dash, no NULs', 'utf8'),
    );
    const item = await buildItem(p, fs.statSync(p));
    expect(item.markdownText).toContain('héllo');
  });
});
