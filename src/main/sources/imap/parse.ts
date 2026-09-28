import { simpleParser, type AddressObject } from 'mailparser';
import { extractMessageEvidence } from '../email-evidence';
import type {
  ImapAttachmentMeta,
  ImapMessageItem,
  ImapRawMessage,
} from './types';
import { cleanBody } from './body';
import { stripAngle } from './ids';

/**
 * Parse one raw RFC822 message into the shape toDocument() needs. Async
 * (mailparser is async) but deterministic given fixed input bytes — a fixture
 * Buffer in is a fixture ImapMessageItem out, so this is unit-tested with
 * fixtures rather than a live server.
 *
 * Mirrors kiagent-ref/src/main/connectors/imap/message-parser.ts. The
 * threading fields (cc/replyTo/references) are preserved for reply
 * resolution (see src/main/outbound/resolve.ts); attachments are kept as
 * METADATA only (see `attachmentMeta`) and become child documents.
 */
export async function parseImapMessage(
  raw: ImapRawMessage,
  mailbox: string,
  uidValidity: number,
): Promise<ImapMessageItem> {
  const mail = await simpleParser(raw.source);

  const messageId = mail.messageId ? stripAngle(mail.messageId) : null;

  const headers: Record<string, string> = {};
  for (const [k, v] of mail.headers) {
    headers[k.toLowerCase()] =
      typeof v === 'string' ? v : headerValueToString(v);
  }

  const from = addrText(mail.from);
  const to = addrList(mail.to);
  const cc = addrList(mail.cc);
  const replyTo = addrText(mail.replyTo) || null;
  const references = (
    Array.isArray(mail.references)
      ? mail.references
      : mail.references
        ? [mail.references]
        : []
  ).map(stripAngle);

  const rawText =
    mail.text ?? (typeof mail.html === 'string' ? stripHtml(mail.html) : '');
  const bodyText = cleanBody(rawText);

  return {
    mailbox,
    uid: raw.uid,
    uidValidity: String(uidValidity),
    messageId,
    subject: mail.subject ?? null,
    from: from || null,
    to,
    cc,
    replyTo,
    references,
    date: mail.date ? mail.date.toISOString() : null,
    bodyText,
    headers,
    attachments: attachmentMeta(mail.attachments ?? []),
    evidence: extractMessageEvidence({
      messageKey: messageId ?? `imap:${uidValidity}:${raw.uid}`,
      author: from,
      at: mail.date ? mail.date.toISOString() : null,
      plain: mail.text ?? '',
      html: typeof mail.html === 'string' ? mail.html : null,
    }),
  };
}

/** The bytes of attachment `index` (mailparser order) of one raw message,
 *  or null when the message no longer has that attachment. */
export async function attachmentContent(
  source: Buffer,
  index: number,
): Promise<Buffer | null> {
  const mail = await simpleParser(source);
  return mail.attachments?.[index]?.content ?? null;
}

/** Inline images under this size are signatures/logos/tracking pixels —
 *  the same bar the Gmail source uses. */
export const TINY_INLINE_IMAGE_BYTES = 8 * 1024;

/** Every real attachment's metadata, indexed by its position in mailparser's
 *  array (the key `fetchBytes` re-resolves by). Tiny images are dropped but
 *  keep their index slot, so indexes stay aligned with a re-parse. */
export function attachmentMeta(
  attachments: ReadonlyArray<{
    filename?: string;
    contentType?: string;
    size?: number;
    content?: Buffer;
  }>,
): ImapAttachmentMeta[] {
  const out: ImapAttachmentMeta[] = [];
  attachments.forEach((a, index) => {
    const mime = (a.contentType ?? 'application/octet-stream').toLowerCase();
    const sizeBytes = a.size ?? a.content?.length ?? 0;
    if (mime.startsWith('image/') && sizeBytes < TINY_INLINE_IMAGE_BYTES)
      return;
    out.push({ index, filename: a.filename ?? null, mime, sizeBytes });
  });
  return out;
}

function addrText(a: AddressObject | AddressObject[] | undefined): string {
  return addrList(a)[0] ?? '';
}

function addrList(a: AddressObject | AddressObject[] | undefined): string[] {
  if (!a) return [];
  const list = Array.isArray(a) ? a : [a];
  return list
    .flatMap((obj) =>
      obj.value.map((v) =>
        v.name ? `${v.name} <${v.address}>` : (v.address ?? ''),
      ),
    )
    .filter((s) => s.length > 0);
}

function headerValueToString(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(headerValueToString).join(', ');
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    // Address-like headers (from/to/cc): { text, html, value }.
    if (typeof obj.text === 'string') return obj.text;
    // Structured headers (content-type/content-disposition): { value, params }.
    if (typeof obj.value === 'string') return obj.value;
  }
  return String(v);
}

/**
 * Minimal HTML->text fallback for the rare message with an html part but no
 * text/plain part and no mailparser-derived text. Not a full renderer — just
 * enough to avoid storing raw markup as the document body.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
