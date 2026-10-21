import EmailReplyParser from 'email-reply-parser';
import { type MessageEvidenceV1 } from '@shared/message-evidence';
import { extractMessageEvidence, htmlToText } from '../email-evidence';

/**
 * Gmail message payload shapes and parsing, ported from legacy
 * kiagent-ref src/main/connectors/gmail/parser.ts. Pure — no network, no I/O.
 */

export interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: GmailPart[];
}

export interface GmailApiMessage {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  /** Gmail's authoritative receive timestamp (epoch ms, as a string). */
  internalDate?: string;
  payload?: GmailPart;
}

export interface ParsedAttachment {
  messageId: string;
  partId: string;
  attachmentId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export interface ParsedEmail {
  messageId: string;
  threadId: string;
  from: string;
  to: string[];
  cc: string[];
  date: Date;
  subject: string;
  body: string;
  htmlBody: string | null;
  headers: Record<string, string>;
  labelIds: string[];
  attachments: ParsedAttachment[];
  evidence: MessageEvidenceV1;
}

export function stripQuotedReplies(text: string): string {
  const parsed = new EmailReplyParser().read(text);
  return parsed.getVisibleText().trim();
}

/** The message's full text as written — text/plain, else HTML converted to
 *  text — WITHOUT quote stripping (callers that strip do it themselves). */
export function plainTextOf(msg: GmailApiMessage): string {
  if (!msg.payload) return '';
  const plain = findBody(msg.payload, 'text/plain');
  if (plain) return plain;
  const html = findBody(msg.payload, 'text/html');
  return html ? htmlToText(html) : '';
}

/** The message's HTML body, when it has one. */
export function htmlBodyOf(msg: GmailApiMessage): string | undefined {
  return (msg.payload && findBody(msg.payload, 'text/html')) || undefined;
}

/** A message's first header of each name, lower-cased keys. */
export function headersOf(msg: GmailApiMessage): Record<string, string> {
  return msg.payload ? collectHeaders(msg.payload) : {};
}

/** An address-list header split into one entry per recipient. */
export function splitAddressList(s: string | undefined): string[] {
  return split(s);
}

export function parseGmailMessage(msg: GmailApiMessage): ParsedEmail {
  if (!msg.payload) throw new Error('no payload');
  const headers = collectHeaders(msg.payload);
  const htmlBody = findBody(msg.payload, 'text/html');
  const plain = findBody(msg.payload, 'text/plain');
  // A message with only an HTML part (receipts, newsletters) is read from it.
  const text = plain || (htmlBody ? htmlToText(htmlBody) : '');
  const body = text ? stripQuotedReplies(text) : '';
  const date = parseMessageDate(msg.internalDate, headers.date);
  return {
    messageId: headers['message-id'] ?? '',
    threadId: msg.threadId ?? '',
    from: headers.from ?? '',
    to: split(headers.to),
    cc: split(headers.cc),
    date,
    subject: headers.subject ?? '',
    body,
    htmlBody,
    headers,
    labelIds: msg.labelIds ?? [],
    attachments: collectAttachments(msg.payload, msg.id ?? ''),
    evidence: extractMessageEvidence({
      messageKey: headers['message-id'] ?? msg.id ?? msg.threadId ?? 'message',
      author: headers.from ?? '',
      at: date.toISOString(),
      plain: plain ?? '',
      html: htmlBody,
    }),
  };
}

// Prefer Gmail's internalDate (epoch ms, stamped by Gmail's MTA on arrival —
// always present and parseable). Old emails often arrive with no Date:
// header or a non-RFC-2822 string; falling back to the header only when
// internalDate is absent avoids Invalid Date / "Invalid time value" crashes
// (legacy hit this and dropped whole threads from indexing over it).
function parseMessageDate(
  internalDate: string | undefined,
  headerDate: string | undefined,
): Date {
  if (internalDate) {
    const ms = Number(internalDate);
    if (Number.isFinite(ms)) return new Date(ms);
  }
  if (headerDate) {
    const d = new Date(headerDate);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date(0);
}

function collectHeaders(p: GmailPart): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of p.headers ?? []) {
    const k = h.name.toLowerCase();
    if (!(k in out)) out[k] = h.value;
  }
  return out;
}

/** A part that is a file, not the message's text: it has a name, or says
 *  it is an attachment. A .txt attached to an HTML-only mail is not its body. */
export function isFilePart(p: GmailPart): boolean {
  if (p.filename) return true;
  const cd =
    p.headers?.find((h) => h.name.toLowerCase() === 'content-disposition')
      ?.value ?? '';
  return /^\s*attachment/i.test(cd);
}

function findBody(p: GmailPart, mt: string): string | null {
  if (isFilePart(p)) return null;
  if (p.mimeType === mt && p.body?.data) {
    return Buffer.from(p.body.data, 'base64url').toString('utf-8');
  }
  for (const c of p.parts ?? []) {
    const r = findBody(c, mt);
    if (r) return r;
  }
  return null;
}

/** Split an address-list header on top-level commas — a comma inside a
 *  double-quoted display name ("Doe, Jane" <j@x.com>) is part of the name,
 *  not a separator. These strings feed outbound To: headers, so a corrupted
 *  entry would become a bogus recipient. */
function split(s: string | undefined): string[] {
  if (!s) return [];
  const trimAll = (parts: string[]): string[] =>
    parts.map((p) => p.trim()).filter(Boolean);
  // An odd quote count means the header is malformed. The scanner below would
  // stay "inside" a quote to the end of the string and merge every remaining
  // recipient into one entry — and the reply path resolves an entry by its
  // first <...>, so a merged entry starting with the user's own address is
  // self-filtered and the co-recipient vanishes silently. Prefer the old naive
  // split there: still one recipient per entry, just with a stray quote.
  if ((s.match(/"/g)?.length ?? 0) % 2 !== 0) return trimAll(s.split(','));
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (const ch of s) {
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return trimAll(out);
}

function collectAttachments(
  p: GmailPart,
  gmailMessageId: string,
): ParsedAttachment[] {
  const out: ParsedAttachment[] = [];
  const seen = new Set<string>();
  function walk(part: GmailPart): void {
    const att = part.body?.attachmentId;
    const mt = part.mimeType ?? '';
    if (att && !seen.has(att) && mt !== 'text/plain' && mt !== 'text/html') {
      const headers = collectHeaders(part);
      const cd = headers['content-disposition'] ?? '';
      if (cd.trimStart().toLowerCase().startsWith('attachment')) {
        seen.add(att);
        out.push({
          messageId: gmailMessageId,
          partId: part.partId ?? '',
          attachmentId: att,
          filename: extractFilenameParam(cd) ?? part.filename ?? '',
          mimeType: mt || 'application/octet-stream',
          sizeBytes: part.body?.size ?? 0,
        });
      }
    }
    for (const c of part.parts ?? []) walk(c);
  }
  walk(p);
  return out;
}

function extractFilenameParam(cd: string): string | null {
  const m = /filename="?([^";]+)"?/i.exec(cd);
  return m ? m[1] : null;
}

/** Export attachments from a raw GmailApiMessage — used by fetchBytes to
 *  re-resolve rotated attachment ids. */
export function attachmentsOf(msg: GmailApiMessage): ParsedAttachment[] {
  if (!msg.payload || !msg.id) return [];
  return collectAttachments(msg.payload, msg.id);
}
