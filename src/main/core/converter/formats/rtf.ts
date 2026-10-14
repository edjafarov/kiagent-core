/** Minimal RTF → plain text: groups, control words, \'hh in the document's
 *  codepage, \uN with \ucN fallback skipping, \bin, escaped symbols. Skips
 *  non-text destinations (fonts, colors, styles, info, pictures, `\*`
 *  destinations, field instructions — field results are kept). Linear in the
 *  input: every step advances. Pure. */

const SKIP_DEST = new Set([
  'fonttbl',
  'colortbl',
  'stylesheet',
  'info',
  'pict',
  'object',
  'themedata',
  'colorschememapping',
  'datastore',
  'latentstyles',
  'listtable',
  'listoverridetable',
  'rsidtbl',
  'generator',
  'xmlnstbl',
  'fldinst',
  'header',
  'footer',
  'headerl',
  'headerr',
  'headerf',
  'footerl',
  'footerr',
  'footerf',
  'filetbl',
  'revtbl',
  'pgdsctbl',
  'expandedcolortbl',
  'mmathPr',
]);

/** Codepages whose WHATWG label is not `windows-<n>`. */
const CODEPAGE_LABEL: Record<number, string> = {
  932: 'shift_jis',
  936: 'gbk',
  949: 'euc-kr',
  950: 'big5',
  10000: 'macintosh',
  20866: 'koi8-r',
  28591: 'iso-8859-1',
  65001: 'utf-8',
};

const decoderFor = (cp: number): TextDecoder => {
  try {
    return new TextDecoder(CODEPAGE_LABEL[cp] ?? `windows-${cp}`);
  } catch {
    return new TextDecoder('windows-1252');
  }
};

interface Group {
  skip: boolean;
  uc: number;
}

/** `src` is the RTF read as latin1 (one char per byte). */
export function rtfToText(src: string): string {
  let out = '';
  // Document bytes (literal and \'hh) awaiting decode as one run in the
  // active codepage: a cp1251 file may carry Cyrillic as raw bytes.
  let pending: number[] = [];
  let decoder = decoderFor(1252);
  const stack: Group[] = [];
  let g: Group = { skip: false, uc: 1 };
  let skipChars = 0; // \uN fallback characters still to drop
  let i = 0;

  const flush = () => {
    if (pending.length) {
      out += decoder.decode(new Uint8Array(pending));
      pending = [];
    }
  };
  const byte = (b: number) => {
    if (skipChars > 0) {
      skipChars--;
      return;
    }
    if (!g.skip) pending.push(b);
  };
  const emit = (s: string) => {
    if (skipChars > 0) {
      skipChars--;
      return;
    }
    if (g.skip) return;
    flush();
    out += s;
  };

  while (i < src.length) {
    const ch = src[i];
    if (ch === '{') {
      flush();
      stack.push(g);
      g = { ...g };
      skipChars = 0;
      i++;
      // `{\*\dest …}` — an ignorable destination.
      if (src.startsWith('\\*', i)) g.skip = true;
      continue;
    }
    if (ch === '}') {
      flush();
      g = stack.pop() ?? { skip: false, uc: 1 };
      skipChars = 0;
      i++;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      i++;
      continue;
    }
    if (ch !== '\\') {
      byte(src.charCodeAt(i) & 0xff);
      i++;
      continue;
    }
    const next = src[i + 1];
    if (next === undefined) break;
    if (next === '\\' || next === '{' || next === '}') {
      byte(next.charCodeAt(0));
      i += 2;
      continue;
    }
    if (next === "'") {
      const hex = parseInt(src.slice(i + 2, i + 4), 16);
      i += 4;
      if (Number.isFinite(hex)) byte(hex);
      else if (skipChars > 0) skipChars--;
      continue;
    }
    if (next === '\r' || next === '\n') {
      emit('\n'); // `\` + newline is a paragraph break
      i += 2;
      continue;
    }
    if (next === '~') {
      emit('\u00a0');
      i += 2;
      continue;
    }
    if (next === '_') {
      emit('-');
      i += 2;
      continue;
    }
    const m = /^([a-zA-Z]{1,32})(-?\d{1,10})? ?/.exec(src.slice(i + 1, i + 46));
    if (!m) {
      i += 2; // other control symbols (\-, \*, \|, \:) carry no text
      continue;
    }
    i += 1 + m[0].length;
    const word = m[1];
    const arg = m[2] === undefined ? null : Number(m[2]);
    if (SKIP_DEST.has(word)) {
      g.skip = true;
      continue;
    }
    switch (word) {
      case 'par':
      case 'line':
      case 'sect':
      case 'page':
      case 'row':
        emit('\n');
        break;
      case 'tab':
      case 'cell':
        emit('\t');
        break;
      case 'ansicpg':
        if (arg != null && arg > 0) {
          flush();
          decoder = decoderFor(arg);
        }
        break;
      case 'uc':
        g.uc = arg != null && arg >= 0 ? arg : 1;
        break;
      case 'u': {
        if (arg == null) break;
        const code = arg < 0 ? arg + 65536 : arg;
        skipChars = 0;
        emit(String.fromCharCode(code));
        skipChars = g.uc;
        break;
      }
      case 'bin':
        // Raw binary data follows: skip it. A negative or oversized length
        // is corrupt — ignore it rather than move backwards.
        if (arg != null && arg > 0) i = Math.min(src.length, i + arg);
        break;
      default:
        break;
    }
  }
  flush();
  return out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function rtfBytesToMarkdown(bytes: Uint8Array): string {
  return rtfToText(Buffer.from(bytes).toString('latin1'));
}
