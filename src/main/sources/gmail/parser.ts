import EmailReplyParser from 'email-reply-parser';

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
}

export function stripQuotedReplies(text: string): string {
  const parsed = new EmailReplyParser().read(text);
  return parsed.getVisibleText().trim();
}

export function parseGmailMessage(msg: GmailApiMessage): ParsedEmail {
  if (!msg.payload) throw new Error('no payload');
  const headers = collectHeaders(msg.payload);
  const htmlBody = findBody(msg.payload, 'text/html');
  let plain = findBody(msg.payload, 'text/plain');
  if (!plain && htmlBody) plain = ''; // HTML→md left to the engine's converter
  const body = plain ? stripQuotedReplies(plain) : '';
  return {
    messageId: headers['message-id'] ?? '',
    threadId: msg.threadId ?? '',
    from: headers.from ?? '',
    to: split(headers.to),
    cc: split(headers.cc),
    date: parseMessageDate(msg.internalDate, headers.date),
    subject: headers.subject ?? '',
    body,
    htmlBody,
    headers,
    labelIds: msg.labelIds ?? [],
    attachments: collectAttachments(msg.payload, msg.id ?? ''),
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

function findBody(p: GmailPart, mt: string): string | null {
  if (p.mimeType === mt && p.body?.data) {
    return Buffer.from(p.body.data, 'base64url').toString('utf-8');
  }
  for (const c of p.parts ?? []) {
    const r = findBody(c, mt);
    if (r) return r;
  }
  return null;
}

function split(s: string | undefined): string[] {
  return s
    ? s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
    : [];
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
