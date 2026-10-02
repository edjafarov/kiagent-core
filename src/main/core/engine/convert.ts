import type { DocumentInput } from '@shared/contracts';

import { HAS_TEXT_CHARS } from '@main/workers/convert/outcome';

import type { LogSink } from './engine';
import { guardCfbReader } from './msg-guard';
import { assessPage, QUALITY_VERSION } from './text-quality';

/**
 * Commit-path stage 1: deterministic binary → markdown. Parsers only — no
 * inference. Text-poor results (scans, images) keep `markdown: null` so a
 * vision worker picks them up later via the 'defer' two-pass pattern.
 *
 * Runs in-process for now; the crash-isolated worker pool rides the
 * converter/worker.ts entry when it lands (see LEFTOVERS).
 */
/** Upper bound on one document's markdown, whichever path parsed it. */
export const MAX_MARKDOWN_CHARS = 2 * 1024 * 1024;
export function capMarkdown(md: string): {
  markdown: string;
  truncated: boolean;
} {
  return md.length > MAX_MARKDOWN_CHARS
    ? {
        markdown: `${md.slice(0, MAX_MARKDOWN_CHARS)}\n\n[truncated]`,
        truncated: true,
      }
    : { markdown: md, truncated: false };
}

export function createConverter(
  logs: LogSink,
): (input: DocumentInput) => Promise<DocumentInput> {
  return async (input) => {
    if (!input.binary || input.markdown !== null) return stripBinary(input);
    const { bytes, mime, filename } = input.binary;
    try {
      const { markdown: md, ocrPages } = await parseDetailed(
        bytes,
        mime,
        filename,
      );
      if (md !== null) {
        const base = {
          ...stripBinary(input),
          markdown: capMarkdown(md).markdown,
        };
        // Deterministic, no timestamp: contentHash covers metadata (garbled
        // spec §3), so the same bytes always commit the same row. A clean
        // PDF is stamped assessed too, so the convert worker never re-reads
        // its text to decide whether it is garbled.
        if (ocrPages)
          return {
            ...base,
            metadata: {
              ...input.metadata,
              conversion: needsOcrMarker(ocrPages),
            },
          };
        if (convertibleKind(mime, filename) === 'pdf')
          return {
            ...base,
            metadata: {
              ...input.metadata,
              conversion: { status: 'ok', quality: QUALITY_VERSION },
            },
          };
        return base;
      }
    } catch (err) {
      logs.log(
        'converter',
        'warn',
        `parse failed for ${filename ?? mime}: ${String(err)}`,
      );
    }
    // Unparseable or text-poor: stays markdown-null for the vision pass.
    return stripBinary(input);
  };
}

function stripBinary(input: DocumentInput): DocumentInput {
  const { binary: _binary, ...rest } = input;
  return rest;
}

/** What the converter can parse. `parse()` dispatches on this and the
 *  convert worker (workers/convert) matches on it, so "which documents get
 *  parsed" has exactly one answer whichever path the bytes arrive by. */
export type ConvertibleKind =
  | 'pdf'
  | 'docx'
  | 'html'
  | 'csv'
  | 'spreadsheet'
  | 'email'
  | 'text';

export function convertibleKind(
  mime: string | null | undefined,
  filename?: string | null,
): ConvertibleKind | null {
  const m = typeof mime === 'string' ? mime.toLowerCase() : '';
  const ext =
    typeof filename === 'string' && filename.includes('.')
      ? (filename.toLowerCase().split('.').pop() ?? '')
      : '';
  if (m === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (
    m ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    ext === 'docx'
  )
    return 'docx';
  if (m === 'text/html' || ext === 'html' || ext === 'htm') return 'html';
  if (m === 'text/csv' || ext === 'csv') return 'csv';
  if (
    m === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    ext === 'xlsx' ||
    ext === 'xls'
  )
    return 'spreadsheet';
  if (
    m === 'message/rfc822' ||
    m === 'application/mbox' ||
    m === 'application/vnd.ms-outlook' ||
    ['eml', 'emlx', 'mbox', 'msg'].includes(ext)
  )
    return 'email';
  if (m.startsWith('text/') || ['md', 'txt', 'json', 'log'].includes(ext))
    return 'text';
  return null;
}

/** pdf-parse's default page renderer, kept verbatim (line joining by y),
 *  but recording each page's text by its index. A page pdf.js fails on is
 *  caught inside pdf-parse and never reaches the hook → stays ''. */
export async function parsePdfPages(bytes: Uint8Array): Promise<string[]> {
  const pdfParse = (await import('pdf-parse')).default;
  const pages: string[] = [];
  // A fresh copy: Buffer.from() places inputs under 4 KB in a slice of
  // Node's shared pool, and pdf-parse's pdf.js reads the whole underlying
  // ArrayBuffer — every small PDF failed "bad XRef entry".
  const out = await pdfParse(new Uint8Array(bytes) as Buffer, {
    pagerender: async (pageData: {
      pageIndex: number;
      getTextContent: (o: object) => Promise<{
        items: Array<{ str: string; transform: number[] }>;
      }>;
    }) => {
      const tc = await pageData.getTextContent({
        normalizeWhitespace: false,
        disableCombineTextItems: false,
      });
      let lastY: number | undefined;
      let text = '';
      for (const item of tc.items) {
        const y = item.transform[5];
        text += lastY === y || lastY === undefined ? item.str : `\n${item.str}`;
        lastY = y;
      }
      pages[pageData.pageIndex] = text;
      return text;
    },
  });
  return Array.from({ length: out.numpages }, (_, i) => pages[i] ?? '');
}

/** The deterministic `conversion` marker for a PDF whose listed pages
 *  (1-based, ascending) have a missing or garbled text layer. No `at`. */
export function needsOcrMarker(pages: number[]) {
  return { status: 'needs-ocr' as const, pages, quality: QUALITY_VERSION };
}

/** Bytes → markdown, plus — for a PDF — the pages whose text layer needs
 *  OCR. `markdown: null` means text-poor (a scan, or nothing to parse); a
 *  throw means the file could not be parsed. */
export async function parseDetailed(
  bytes: Uint8Array,
  mime: string,
  filename?: string,
): Promise<{ markdown: string | null; ocrPages?: number[] }> {
  if (convertibleKind(mime, filename) !== 'pdf')
    return { markdown: await parseOther(bytes, mime, filename) };
  const pages = await parsePdfPages(bytes);
  const text = pages.join('\n\n').trim();
  // Whole doc under the chain's "has real text" bar (HAS_TEXT_CHARS, not
  // OCR's 200-char sufficiency bar): today's text-poor path (whole-doc OCR +
  // VLM). Above it the text is KEPT — a short real PDF (a receipt) must keep
  // its text, since OCR is off by default and absent on Windows — and only
  // the pages that are not `good` are listed for OCR.
  if (text.replace(/\s+/g, '').length < HAS_TEXT_CHARS)
    return { markdown: null };
  const ocrPages = pages.flatMap((t, i) =>
    assessPage(t) === 'good' ? [] : [i + 1],
  );
  return { markdown: text, ...(ocrPages.length ? { ocrPages } : {}) };
}

/** Bytes → markdown (see parseDetailed). */
export async function parse(
  bytes: Uint8Array,
  mime: string,
  filename?: string,
): Promise<string | null> {
  return (await parseDetailed(bytes, mime, filename)).markdown;
}

async function parseOther(
  bytes: Uint8Array,
  mime: string,
  filename?: string,
): Promise<string | null> {
  const buf = Buffer.from(bytes);
  const ext = (filename ?? '').toLowerCase().split('.').pop() ?? '';

  switch (convertibleKind(mime, filename)) {
    case 'docx': {
      const mammoth = await import('mammoth');
      const out = await mammoth.convertToMarkdown({ buffer: buf });
      return out.value;
    }
    case 'html':
      return htmlToMarkdown(buf.toString('utf8'));
    case 'csv':
      return csvToMarkdown(buf.toString('utf8'));
    case 'spreadsheet': {
      const XLSX = await import('xlsx');
      const wb = XLSX.read(buf, { type: 'buffer' });
      const parts: string[] = [];
      for (const name of wb.SheetNames.slice(0, 10)) {
        const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]);
        parts.push(`## ${name}\n\n${csvToMarkdown(csv)}`);
      }
      return parts.join('\n\n');
    }
    case 'email':
      return emailToMarkdown(buf, ext, (mime ?? '').toLowerCase());
    case 'text':
      return buf.toString('utf8');
    default:
      // Images and unknown binaries: vision territory.
      return null;
  }
}

async function htmlToMarkdown(html: string): Promise<string> {
  const { default: TurndownService } = await import('turndown');
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
  });
  return td.turndown(html);
}

function csvToMarkdown(csv: string): string {
  const lines = csv
    .split('\n')
    .filter((l) => l.trim())
    .slice(0, 200);
  if (lines.length === 0) return '';
  const rows = lines.map((l) => l.split(','));
  const header = `| ${rows[0].join(' | ')} |`;
  const sep = `| ${rows[0].map(() => '---').join(' | ')} |`;
  const body = rows.slice(1).map((r) => `| ${r.join(' | ')} |`);
  return [header, sep, ...body].join('\n');
}

/** Messages rendered from one mbox. An archive can hold tens of thousands;
 *  this file becomes ONE document, so the cap bounds both the parse time and
 *  the markdown a single row carries. */
const MBOX_MAX_MESSAGES = 500;

interface MailParts {
  subject?: string;
  from?: string;
  to?: string;
  cc?: string;
  date?: Date;
  attachments: string[];
  body: string;
}

/** The ONE email layout, for .eml/.emlx/.mbox (mailparser) and .msg
 *  (msgreader) alike, so search sees the same shape whatever the format. */
function renderMail(m: MailParts): string {
  const head: string[] = [];
  if (m.subject) head.push(`# ${m.subject}`);
  if (m.from) head.push(`**From:** ${m.from}`);
  if (m.to) head.push(`**To:** ${m.to}`);
  if (m.cc) head.push(`**Cc:** ${m.cc}`);
  if (m.date && !Number.isNaN(m.date.getTime()))
    head.push(`**Date:** ${m.date.toISOString()}`);
  if (m.attachments.length > 0)
    head.push(`**Attachments:** ${m.attachments.join(', ')}`);
  return [head.join('\n\n'), m.body.trim()].filter(Boolean).join('\n\n');
}

/** Outlook .msg → the same markdown as .eml. Body: plain text, else the HTML
 *  body (string or, from "new Outlook", raw UTF-8 bytes). RTF-only messages
 *  index headers + attachment names (deliberate spec deviation, see the
 *  outlook-msg plan). */
async function msgToMarkdown(buf: Buffer): Promise<string> {
  // A typed lazy require, NOT `await import()`: under module node16 a dynamic
  // import of this CJS package yields the class at `.default.default` (TS2351
  // "not constructable"). Same pattern as local-folder/mime.ts.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { default: MsgReader } =
    require('@kenjiuno/msgreader') as typeof import('@kenjiuno/msgreader');
  // DataView: no copy, and correct for small Buffers living in Node's shared pool.
  const reader = new MsgReader(
    new DataView(buf.buffer, buf.byteOffset, buf.byteLength),
  );
  // Before getFileData() (which parses): a corrupt pointer in the file would
  // otherwise loop until the main process runs out of heap.
  guardCfbReader((reader as unknown as { reader: unknown }).reader);
  const d = reader.getFileData();
  if (d.error) throw new Error(`msg: ${d.error}`);
  // An Exchange sender carries an X.500 DN ("/O=…"), not an address: show the name.
  const who = (name?: string, email?: string): string => {
    const addr = email && !email.startsWith('/') ? email : undefined;
    if (name && addr && name !== addr) return `${name} <${addr}>`;
    return name ?? addr ?? '';
  };
  const rcpt = (type: 'to' | 'cc') =>
    (d.recipients ?? [])
      .filter((r) => r.recipType === type)
      .map((r) => who(r.name, r.smtpAddress ?? r.email))
      .filter(Boolean)
      .join(', ');
  // `html` bytes are decoded as UTF-8 (new Outlook writes UTF-8). Classic
  // Outlook messages with codepage HTML always carry a plain `body`, so they
  // never reach this branch.
  const html =
    d.bodyHtml ?? (d.html ? new TextDecoder().decode(d.html) : undefined);
  const body = d.body?.trim() ? d.body : html ? await htmlToMarkdown(html) : '';
  const when = d.messageDeliveryTime ?? d.clientSubmitTime;
  return renderMail({
    subject: d.subject,
    from: who(d.senderName, d.senderSmtpAddress ?? d.senderEmail),
    to: rcpt('to'),
    cc: rcpt('cc'),
    date: when ? new Date(when) : undefined,
    attachments: (d.attachments ?? [])
      .map((a) => a.fileName ?? a.name)
      .filter((n): n is string => Boolean(n)),
    body,
  });
}

/**
 * Locally-saved email → markdown, via the same `mailparser` the IMAP source
 * uses (src/main/sources/imap/parse.ts) rather than a second implementation;
 * `.msg` goes through msgreader.
 *
 * Raw decoding is NOT an option even though these files look like text: a
 * body is quoted-printable or base64, and an attachment is a base64 blob that
 * would otherwise land in the search index as thousands of meaningless
 * "words". Attachments are reduced to their filenames, which is the part a
 * person actually searches for.
 */
async function emailToMarkdown(
  buf: Buffer,
  ext: string,
  mime: string,
): Promise<string> {
  // Outlook's binary CFB format: by extension OR by MIME (an extensionless
  // attachment carries only the MIME; mailparser would read nothing from it).
  if (ext === 'msg' || mime === 'application/vnd.ms-outlook')
    return msgToMarkdown(buf);

  const { simpleParser } = await import('mailparser');

  const render = async (raw: Buffer): Promise<string> => {
    const mail = await simpleParser(raw);
    const addr = (v: unknown): string =>
      v && typeof v === 'object' && 'text' in (v as Record<string, unknown>)
        ? String((v as { text?: string }).text ?? '')
        : '';
    const list = (v: unknown) =>
      Array.isArray(v) ? v.map(addr).join(', ') : addr(v);
    return renderMail({
      subject: mail.subject,
      from: addr(mail.from),
      to: list(mail.to),
      cc: list(mail.cc),
      date: mail.date,
      attachments: (mail.attachments ?? [])
        .map((a) => a.filename)
        .filter((n): n is string => Boolean(n)),
      // `text` is the decoded text/plain part; fall back to the HTML part.
      body: mail.text ?? (mail.html ? await htmlToMarkdown(mail.html) : ''),
    });
  };

  if (ext === 'emlx') {
    // Apple Mail: a byte count on line 1, the RFC 5322 message, then a plist
    // trailer. Slice by the declared length rather than hunting for the plist.
    const nl = buf.indexOf(0x0a);
    const declared = Number.parseInt(buf.subarray(0, nl).toString('ascii'), 10);
    const body =
      Number.isFinite(declared) && declared > 0
        ? buf.subarray(nl + 1, nl + 1 + declared)
        : buf.subarray(nl + 1);
    return render(body);
  }

  if (ext === 'mbox') {
    // mbox separates messages with a line beginning "From " (no colon).
    const parts = buf
      .toString('utf8')
      .split(/^From .*$/m)
      .map((p) => p.trim())
      .filter(Boolean)
      .slice(0, MBOX_MAX_MESSAGES);
    const out: string[] = [];
    for (const part of parts) {
      // eslint-disable-next-line no-await-in-loop -- sequential by design:
      // parsing 500 messages concurrently would defeat the memory bound.
      out.push(await render(Buffer.from(part, 'utf8')));
    }
    return out.join('\n\n---\n\n');
  }

  return render(buf);
}
