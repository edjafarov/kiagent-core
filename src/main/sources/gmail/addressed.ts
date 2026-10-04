/**
 * Owner-channel listing: every message addressed To one address, mailbox-wide
 * (Spam/Trash included, drafts excluded), each flagged `sent` when it carries
 * Gmail's SENT label. Only sent rows are fetched in full — foreign mail is
 * metadata only, so its body never leaves Gmail.
 */
import type { AddressedMail, AddressedQuery, Session } from '@shared/contracts';

import { isAutomatedMessage } from '../imap/filter';
import { getMessage, getMessageMetadata, listMessagesPage } from './gmail-api';
import { plainTextOf, type GmailApiMessage } from './parser';

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
    const text = sent
      ? // eslint-disable-next-line no-await-in-loop
        plainTextOf(await getMessage(session, id)).slice(0, TEXT_CAP)
      : '';
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
    });
  }
  return out;
}
