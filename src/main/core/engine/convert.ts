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
