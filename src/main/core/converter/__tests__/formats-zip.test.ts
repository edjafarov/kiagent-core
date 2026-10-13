/** @jest-environment node */
import JSZip from 'jszip';

import { MAX_ZIP_PART_BYTES, openZipParts } from '../formats/zip-parts';
import { byLocalName, parseXml, textContent } from '../formats/xml';
import { convertibleKind } from '../parsers';

describe('openZipParts', () => {
  it('reads a named part and reports missing ones as null', async () => {
    const zip = new JSZip();
    zip.file('a/b.xml', '<x>hi</x>');
    const parts = await openZipParts(
      await zip.generateAsync({ type: 'uint8array' }),
    );
    expect(parts.has('a/b.xml')).toBe(true);
    expect(await parts.text('a/b.xml')).toBe('<x>hi</x>');
    expect(await parts.text('nope.xml')).toBeNull();
  });

  it('refuses a part whose uncompressed size is over the cap', async () => {
    const zip = new JSZip();
    zip.file('big.xml', 'a'.repeat(MAX_ZIP_PART_BYTES + 1));
    const parts = await openZipParts(
      await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }),
    );
    await expect(parts.text('big.xml')).rejects.toThrow('zip part too large');
  });

  it('stops once the parts read add up past the total budget', async () => {
    const zip = new JSZip();
    const chunk = 'a'.repeat(MAX_ZIP_PART_BYTES - 1);
    for (const n of ['1', '2', '3']) zip.file(`${n}.xml`, chunk);
    const parts = await openZipParts(
      await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }),
    );
    await parts.text('1.xml');
    await parts.text('2.xml');
    await expect(parts.text('3.xml')).rejects.toThrow(
      'zip inflate budget exceeded',
    );
  });

  it('throws on bytes that are not a zip', async () => {
    await expect(
      openZipParts(new TextEncoder().encode('not a zip at all')),
    ).rejects.toThrow();
  });
});

describe('xml helpers', () => {
  it('finds elements by local name across prefixes and renders ODF spacing', () => {
    const doc = parseXml(
      '<r xmlns:t="urn:t"><t:p>a<t:s t:c="2"/>b<t:tab/>c<t:line-break/>d</t:p></r>',
    );
    const [p] = byLocalName(doc, 'p');
    expect(textContent(p)).toBe('a  b\tc\nd');
  });
});

describe('convertibleKind — new kinds', () => {
  it.each([
    [
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'a.pptx',
      'presentation',
    ],
    ['', 'a.pptx', 'presentation'],
    ['application/vnd.oasis.opendocument.text', 'a.odt', 'odf-text'],
    ['application/vnd.oasis.opendocument.spreadsheet', 'a.ods', 'spreadsheet'],
    ['application/epub+zip', 'a.epub', 'epub'],
    ['application/msword', 'a.doc', 'word97'],
    ['application/rtf', 'a.rtf', 'rtf'],
    ['text/rtf', 'a.rtf', 'rtf'],
    ['application/x-subrip', 'a.srt', 'subtitles'],
    ['text/vtt', 'a.vtt', 'subtitles'],
    ['text/plain', 'a.txt', 'text'],
  ])('%s %s → %s', (mime, name, kind) => {
    expect(convertibleKind(mime, name)).toBe(kind);
  });
});
