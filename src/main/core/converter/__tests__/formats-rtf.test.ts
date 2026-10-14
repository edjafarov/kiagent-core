/** @jest-environment node */
import { rtfToText } from '../formats/rtf';
import { msgBody, parse } from '../parsers';

/** MS-OXRTFCP container. `compressed` writes LZFu with literal runs only
 *  (control byte 0 + 8 literals), which the decompressor reads like any
 *  other LZFu stream; otherwise the uncompressed "MELA" form. */
function compressedRtf(rtf: string, compressed: boolean): Uint8Array {
  const raw = Buffer.from(rtf, 'latin1');
  let body: Buffer = raw;
  if (compressed) {
    const runs: Buffer[] = [];
    for (let o = 0; o < raw.length; o += 8)
      runs.push(Buffer.from([0]), raw.subarray(o, o + 8));
    body = Buffer.concat(runs);
  }
  const head = Buffer.alloc(16);
  head.writeUInt32LE(body.length + 12, 0); // COMPSIZE: bytes after this field
  head.writeUInt32LE(raw.length, 4); // RAWSIZE
  head.write(compressed ? 'LZFu' : 'MELA', 8, 'latin1');
  return new Uint8Array(Buffer.concat([head, body]));
}

describe('rtfToText', () => {
  it('drops tables of fonts/colors/info and keeps paragraphs', () => {
    const rtf =
      '{\\rtf1\\ansi\\ansicpg1252{\\fonttbl\\f0\\fswiss Helvetica;}{\\colortbl;\\red255\\green0\\blue0;}{\\info{\\author X}}\\f0\\fs24 Hello\\par World\\par}';
    expect(rtfToText(rtf)).toBe('Hello\nWorld');
  });

  it("decodes \\'hh in the declared codepage (cp1251) and \\uN with fallback skip", () => {
    const rtf =
      "{\\rtf1\\ansi\\ansicpg1251 \\'cf\\'f0\\'e8\\'e2\\'e5\\'f2 \\uc1\\u1052?\\u1080?\\u1088?}";
    expect(rtfToText(rtf)).toBe('Привет Мир');
  });

  it('literal non-ASCII bytes decode in the declared codepage', () => {
    // "Привет" as raw cp1251 bytes, read as latin1 like the converter does.
    const raw = Buffer.concat([
      Buffer.from('{\\rtf1\\ansi\\ansicpg1251 ', 'latin1'),
      Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]),
      Buffer.from('}', 'latin1'),
    ]).toString('latin1');
    expect(rtfToText(raw)).toBe('Привет');
  });

  it("an \\'hh fallback after \\uN is skipped, and \\uc2 skips two", () => {
    expect(rtfToText("{\\rtf1 a\\u252\\'fcb\\uc2\\u223??c}")).toBe('aübßc');
  });

  it('skips \\* destinations and field instructions, keeps field results', () => {
    const rtf =
      '{\\rtf1{\\*\\generator Cocoa;}{\\field{\\*\\fldinst HYPERLINK "http://x"}{\\fldrslt Click here}}\\line done\\tab ok}';
    expect(rtfToText(rtf)).toBe('Click here\ndone\tok');
  });

  it('escaped braces and backslashes are text', () => {
    expect(rtfToText('{\\rtf1 a\\{b\\}c\\\\d}')).toBe('a{b}c\\d');
  });

  it('\\bin skips raw bytes; a negative or oversized \\bin never loops', () => {
    expect(rtfToText('{\\rtf1 a\\bin3 }{}b}')).toBe('ab');
    expect(rtfToText('{\\rtf1 a\\bin-7 b}')).toBe('ab');
    expect(rtfToText('{\\rtf1 a\\bin999999 b}')).toBe('a');
  });

  it('unbalanced and truncated input still terminates', () => {
    expect(rtfToText('}}}{\\rtf1 x\\')).toBe('x');
  });
});

describe('.rtf files', () => {
  it('parse() returns the text', async () => {
    const md = await parse(
      new TextEncoder().encode('{\\rtf1\\ansi Gr\\u252?\\u223?e\\par}'),
      'application/rtf',
      'a.rtf',
    );
    expect(md).toBe('Grüße');
  });
});

describe('msgBody', () => {
  const rtf =
    "{\\rtf1\\ansi\\ansicpg1252 Termin am Montag in M\\'fcnchen\\par}";

  it.each([true, false])(
    'an RTF-only .msg body is decompressed and stripped (LZFu: %s)',
    async (compressed) => {
      expect(
        await msgBody({ compressedRtf: compressedRtf(rtf, compressed) }),
      ).toBe('Termin am Montag in München');
    },
  );

  it('a plain body wins over RTF', async () => {
    expect(
      await msgBody({ body: 'plain', compressedRtf: compressedRtf(rtf, true) }),
    ).toBe('plain');
  });

  it('a compressed-RTF header claiming more bytes than present yields no body', async () => {
    const bad = compressedRtf(rtf, true);
    Buffer.from(bad.buffer).writeUInt32LE(0x7fffffff, 0);
    expect(await msgBody({ compressedRtf: bad })).toBe('');
  });
});
