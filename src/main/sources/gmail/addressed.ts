/**
 * Owner-channel listing: every message addressed To one address, mailbox-wide
 * (Spam/Trash included, drafts excluded), each flagged `sent` when it carries
 * Gmail's SENT label. Only sent rows are fetched in full — foreign mail is
 * metadata only, so its body never leaves Gmail.
 */
import type {
  AddressedAttachment,
  AddressedMail,
  AddressedQuery,
  Session,
} from '@shared/contracts';

import { isAutomatedMessage } from '../imap/filter';
import {
  getAttachment,
  getMessage,
  getMessageMetadata,
  listMessagesPage,
} from './gmail-api';
import { plainTextOf, type GmailApiMessage, type GmailPart } from './parser';

const HEADERS = [
  'From',
  'Sender',
  'To',
  'Cc',
  'Subject',
  'Message-ID',
  'In-Reply-To',
  'References',
  'X-Kia-Channel',
  'Auto-Submitted',
  'Precedence',
  'X-Auto-Response-Suppress',
  'X-Autoreply',
  'X-Autorespond',
  'List-Id',
  'List-Unsubscribe',
  'Return-Path',
] as const;
const TEXT_CAP = 32 * 1024;

const headersOf = (m: GmailApiMessage): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const h of m.payload?.headers ?? []) {
    const k = h.name.toLowerCase();
    if (!(k in out)) out[k] = h.value;
  }
  return out;
};
const addr = (v = '') => (/<([^>]+)>/.exec(v)?.[1] ?? v).trim().toLowerCase();
const addrs = (v = '') =>
  v
    .split(',')
    .map((x) => addr(x))
    .filter(Boolean);
const ids = (v = '') => v.match(/<[^<>\s]+>/g) ?? [];
const INLINE_IMAGE_MIN = 8 * 1024;

/** `filename` / RFC 2231 `filename*` of a Content-Disposition value, decoded;
 *  only a fallback, Gmail's parsed `part.filename` wins. */
export function filenameParam(cd: string): string {
  const ext = /filename\*=([^;]+)/i.exec(cd)?.[1]?.trim();
  if (ext) {
    const m = /^([^']*)'[^']*'(.*)$/.exec(ext.replace(/^"|"$/g, ''));
    try {
      if (m) return decodeURIComponent(m[2]);
    } catch {
      /* fall through to the plain parameter */
    }
  }
  return /filename="?([^";]+)"?/i.exec(cd)?.[1]?.trim() ?? '';
}

/** Every named file part of a message, attachment or inline. */
export function attachmentsOfMessage(
  msg: GmailApiMessage,
): AddressedAttachment[] {
  const out: AddressedAttachment[] = [];
  const walk = (part: GmailPart): void => {
    const cd =
      part.headers?.find((h) => h.name.toLowerCase() === 'content-disposition')
        ?.value ?? '';
    const filename = part.filename || filenameParam(cd);
    const mime = part.mimeType || 'application/octet-stream';
    const size = part.body?.size ?? 0;
    // Gmail serves larger parts by attachmentId and small ones inline in
    // body.data; both are files when they carry a name.
    const hasBytes = !!part.body?.attachmentId || part.body?.data != null;
    if (hasBytes && filename && part.partId) {
      const inline = !cd.trimStart().toLowerCase().startsWith('attachment');
      if (!(inline && mime.startsWith('image/') && size < INLINE_IMAGE_MIN))
        out.push({ id: part.partId, filename, mime, size, inline });
    }
    for (const c of part.parts ?? []) walk(c);
  };
  if (msg.payload) walk(msg.payload);
  return out;
}

export async function listAddressedTo(
  session: Session,
  q: AddressedQuery,
): Promise<AddressedMail[]> {
  const auditSince = q.auditSince ?? q.since;
  const after = Math.floor(Math.min(q.since, auditSince) / 1000);
  const query = `to:${q.toAddress} after:${after}`;
  const found: string[] = [];
  let token: string | undefined;
  do {
    // eslint-disable-next-line no-await-in-loop
    const page = await listMessagesPage(session, query, token);
    for (const m of page.messages ?? []) found.push(m.id);
    token = page.nextPageToken;
  } while (token);

  const out: AddressedMail[] = [];
  for (const id of found) {
    // eslint-disable-next-line no-await-in-loop
    const meta = await getMessageMetadata(session, id, HEADERS);
    const labels = meta.labelIds ?? [];
    if (labels.includes('DRAFT')) continue;
    const h = headersOf(meta);
    const sent = labels.includes('SENT');
    const date = Number(meta.internalDate ?? 0);
    if (date < (sent ? q.since : auditSince)) continue;
    // eslint-disable-next-line no-await-in-loop
    const full = sent ? await getMessage(session, id) : null;
    const text = full ? plainTextOf(full).slice(0, TEXT_CAP) : '';
    const inReplyTo = ids(h['in-reply-to'])[0];
    out.push({
      providerId: id,
      messageId: ids(h['message-id'])[0] ?? '',
      ...(inReplyTo ? { inReplyTo } : {}),
      references: ids(h.references),
      ...(meta.threadId ? { providerThreadId: meta.threadId } : {}),
      sent,
      from: addr(h.from),
      ...(h.sender ? { sender: addr(h.sender) } : {}),
      subject: h.subject ?? '',
      date,
      to: addrs(h.to),
      cc: addrs(h.cc),
      text,
      ownChannel: 'x-kia-channel' in h,
      automated: isAutomatedMessage(h, h.from ?? '').matched,
      attachments: full ? attachmentsOfMessage(full) : [],
    });
  }
  return out;
}

/** One attachment of an owner message, by MIME part id. Re-checks SENT on
 *  the full message and refuses parts over `maxBytes` before downloading. */
export async function fetchAddressedAttachment(
  session: Session,
  providerId: string,
  attachmentId: string,
  opts: { maxBytes: number },
): Promise<Uint8Array> {
  const msg = await getMessage(session, providerId);
  if (!(msg.labelIds ?? []).includes('SENT'))
    throw new Error('gmail: not a sent message');
  let found: GmailPart | undefined;
  const walk = (part: GmailPart): void => {
    if (part.partId === attachmentId) found = part;
    for (const c of part.parts ?? []) walk(c);
  };
  if (msg.payload) walk(msg.payload);
  const body = found?.body;
  if (!body || (!body.attachmentId && body.data == null))
    throw new Error('gmail: no such attachment');
  if ((body.size ?? 0) > opts.maxBytes)
    throw new Error('gmail: attachment too large');
  const data = body.attachmentId
    ? (await getAttachment(session, providerId, body.attachmentId)).data
    : body.data;
  const bytes = new Uint8Array(Buffer.from(data ?? '', 'base64url'));
  if (bytes.length > opts.maxBytes)
    throw new Error('gmail: attachment too large');
  return bytes;
}
