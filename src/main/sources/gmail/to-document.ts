import type { DocumentInput } from '@shared/contracts';

import { parseGmailMessage, type GmailApiMessage } from './parser';

/** Gmail's own document type id for this port — dotted per contracts.ts's
 *  documentTypes convention (`'email.thread' | 'file' | 'chat.message'`).
 *  Legacy stored one row per whole thread (type `email_thread`) plus a
 *  separate `attachment` row per attachment; this port emits the
 *  thread-level document plus one child document per attachment, so there
 *  is no `email.message` type — a thread's individual messages are folded
 *  into ONE document's markdown, exactly like legacy did. */
export const GMAIL_THREAD_DOCUMENT_TYPE = 'email.thread';

/** Inline images under this size are signature/pixel noise — never stored. */
const TINY_ATTACHMENT_IMAGE_BYTES = 8 * 1024;

/**
 * What `pull()` fetches per thread and hands to `toDocument`. This is the
 * `Item` half of `Source<Cursor, Item>` — a plain, already-fetched, fully
 * self-describing object so `toDocument` can stay PURE (no session, no
 * network). `accountEmail` is stamped on by `pull()` from
 * `session.account.identifier` so the deep link can be authuser-scoped like
 * legacy's `buildSourceUrl`, without `toDocument` needing account context.
 */
export interface GmailThreadItem {
  /** Gmail thread id — the externalId scheme (unchanged from legacy). */
  id: string;
  /** Raw `thread.messages[]` from `threads.get?format=full`. */
  messages: GmailApiMessage[];
  /** Connected account's email address (for the authuser deep link). */
  accountEmail: string;
}

/** PURE thread → DocumentInput mapping. Returns null for a thread with zero
 *  messages (mirrors legacy's `emptyThreadReason` skip). Returns an array
 *  with the thread doc followed by attachment child docs if attachments exist,
 *  otherwise returns just the thread doc. */
export function toDocument(
  item: GmailThreadItem,
): DocumentInput | DocumentInput[] | null {
  if (item.messages.length === 0) return null;

  const parsed = item.messages.map(parseGmailMessage);
  const first = parsed[0];
  const last = parsed[parsed.length - 1];

  const subject = (first.subject?.trim() || '(no subject)') as string;
  const url = buildThreadUrl(item.accountEmail, item.id);

  const sections: string[] = [];
  sections.push(`# ${subject}\n`);
  sections.push(
    `> Thread: ${parsed.length} messages · ${fmt(first.date)} → ${fmt(last.date)}`,
  );
  sections.push(`> Open in Gmail: ${url}\n\n---`);

  let idx = 1;
  for (const m of parsed) {
    sections.push(`## ${idx} — ${m.from} · ${fmt(m.date)}\n\n${m.body}`);
    for (const att of m.attachments) {
      sections.push(`[Attachment: ${att.filename || att.attachmentId}]`);
    }
    idx += 1;
  }

  const labels = [...new Set(parsed.flatMap((m) => m.labelIds))];
  const participants = [
    ...new Set(parsed.flatMap((m) => [m.from, ...m.to, ...m.cc])),
  ];

  const threadDoc: DocumentInput = {
    externalId: item.id,
    type: GMAIL_THREAD_DOCUMENT_TYPE,
    title: subject,
    markdown: sections.join('\n'),
    url,
    metadata: {
      gmailThreadId: item.id,
      from: first.from,
      to: first.to,
      cc: first.cc,
      labels,
      messageCount: parsed.length,
      participants,
      firstMessageAt: first.date.toISOString(),
      lastMessageAt: last.date.toISOString(),
      messages: parsed.map((m) => ({
        id: m.messageId,
        from: m.from,
        date: m.date.toISOString(),
        snippet: m.body.slice(0, 200),
      })),
    },
    // Last message date, per the task brief's design — a deliberate
    // deviation from legacy, which stamped created_at from the FIRST
    // message. See report for rationale.
    createdAt: last.date.toISOString(),
  };

  const attachments: DocumentInput[] = [];
  for (const m of parsed) {
    for (const att of m.attachments) {
      if (
        att.mimeType.startsWith('image/') &&
        att.sizeBytes < TINY_ATTACHMENT_IMAGE_BYTES
      )
        continue;
      attachments.push({
        externalId: `${att.messageId}/${att.partId}`,
        type: 'attachment',
        title: att.filename || null,
        markdown: null, // text-poor by construction — the vision worker's pool
        url: threadDoc.url,
        metadata: {
          mime: att.mimeType,
          filename: att.filename,
          sizeBytes: att.sizeBytes,
          messageId: att.messageId,
          partId: att.partId,
          attachmentId: att.attachmentId, // rotates — fetchBytes re-resolves via partId
        },
        createdAt: m.date.toISOString(),
        parent: { externalId: item.id, type: GMAIL_THREAD_DOCUMENT_TYPE },
      });
    }
  }
  return attachments.length ? [threadDoc, ...attachments] : threadDoc;
}

function fmt(d: Date): string {
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

export function buildThreadUrl(accountEmail: string, threadId: string): string {
  const authuser = encodeURIComponent(accountEmail);
  return `https://mail.google.com/mail/?authuser=${authuser}#all/${threadId}`;
}
