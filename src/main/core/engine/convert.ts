import type { DocumentInput } from '@shared/contracts';

import type { LogSink } from './engine';

/**
 * Commit-path stage 1: deterministic binary → markdown. Parsers only — no
 * inference. Text-poor results (scans, images) keep `markdown: null` so a
 * vision worker picks them up later via the 'defer' two-pass pattern.
 *
 * Runs in-process for now; the crash-isolated worker pool rides the
 * converter/worker.ts entry when it lands (see LEFTOVERS).
 */
export function createConverter(
  logs: LogSink,
): (input: DocumentInput) => Promise<DocumentInput> {
  return async (input) => {
    if (!input.binary || input.markdown !== null) return stripBinary(input);
    const { bytes, mime, filename } = input.binary;
    try {
      const markdown = await parse(bytes, mime, filename);
      if (markdown !== null) {
        return { ...stripBinary(input), markdown };
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

async function parse(
  bytes: Uint8Array,
  mime: string,
  filename?: string,
): Promise<string | null> {
  const buf = Buffer.from(bytes);
  const ext = (filename ?? '').toLowerCase().split('.').pop() ?? '';

  if (mime === 'application/pdf' || ext === 'pdf') {
    const pdfParse = (await import('pdf-parse')).default;
    const out = await pdfParse(buf);
    const text = out.text?.trim() ?? '';
    // Text-poor PDF (a scan): leave it for the vision worker.
    return text.length >= 32 ? text : null;
  }

  if (
    mime ===
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    ext === 'docx'
  ) {
    const mammoth = await import('mammoth');
    const out = await mammoth.convertToMarkdown({ buffer: buf });
    return out.value;
  }

  if (mime === 'text/html' || ext === 'html' || ext === 'htm') {
    return htmlToMarkdown(buf.toString('utf8'));
  }

  if (mime === 'text/csv' || ext === 'csv') {
    return csvToMarkdown(buf.toString('utf8'));
  }

  if (
    mime ===
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    ext === 'xlsx' ||
    ext === 'xls'
  ) {
    const XLSX = await import('xlsx');
    const wb = XLSX.read(buf, { type: 'buffer' });
    const parts: string[] = [];
    for (const name of wb.SheetNames.slice(0, 10)) {
      const csv = XLSX.utils.sheet_to_csv(wb.Sheets[name]);
      parts.push(`## ${name}\n\n${csvToMarkdown(csv)}`);
    }
    return parts.join('\n\n');
  }

  if (
    mime === 'message/rfc822' ||
    mime === 'application/mbox' ||
    ['eml', 'emlx', 'mbox'].includes(ext)
  ) {
    return emailToMarkdown(buf, ext);
  }

  if (mime.startsWith('text/') || ['md', 'txt', 'json', 'log'].includes(ext)) {
    return buf.toString('utf8');
  }

  // Images and unknown binaries: vision territory.
  return null;
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

/**
 * Locally-saved email → markdown, via the same `mailparser` the IMAP source
 * uses (src/main/sources/imap/parse.ts) rather than a second implementation.
 *
 * Raw decoding is NOT an option even though these files look like text: a
 * body is quoted-printable or base64, and an attachment is a base64 blob that
 * would otherwise land in the search index as thousands of meaningless
 * "words". Attachments are reduced to their filenames, which is the part a
 * person actually searches for.
 */
async function emailToMarkdown(buf: Buffer, ext: string): Promise<string> {
  const { simpleParser } = await import('mailparser');

  const render = async (raw: Buffer): Promise<string> => {
    const mail = await simpleParser(raw);
    const head: string[] = [];
    const addr = (v: unknown): string =>
      v && typeof v === 'object' && 'text' in (v as Record<string, unknown>)
        ? String((v as { text?: string }).text ?? '')
        : '';
    if (mail.subject) head.push(`# ${mail.subject}`);
    if (mail.from) head.push(`**From:** ${addr(mail.from)}`);
    const to = Array.isArray(mail.to)
      ? mail.to.map(addr).join(', ')
      : addr(mail.to);
    if (to) head.push(`**To:** ${to}`);
    if (mail.date) head.push(`**Date:** ${mail.date.toISOString()}`);
    const names = (mail.attachments ?? [])
      .map((a) => a.filename)
      .filter((n): n is string => Boolean(n));
    if (names.length > 0) head.push(`**Attachments:** ${names.join(', ')}`);
    // `text` is the decoded text/plain part; fall back to the HTML part.
    const body =
      mail.text ?? (mail.html ? await htmlToMarkdown(mail.html) : '');
    return [head.join('\n\n'), body.trim()].filter(Boolean).join('\n\n');
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
