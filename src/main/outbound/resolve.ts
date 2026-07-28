/**
 * Grounded reply resolution (spec §1, §4): recipients and threading come
 * ONLY from stored document metadata — the model supplies no address, and a
 * gap is an explicit error or warning, never a guess.
 *
 * Metadata carries { from, to, messageId, cc, replyTo, references }; absent
 * lists are treated as empty.
 * The Sent mailbox is synced too, so `from` may be the user — self-sent
 * docs reply to their stored recipients, never back to the user.
 */
import type { Document } from '@shared/contracts';

export interface ResolvedReply {
  to: string[];
  /** Always `[]` in this phase — reply_all folds the original Cc recipients
   *  into `to` rather than populating this field. Do not assume otherwise. */
  cc: string[];
  subject: string | null;
  recipientDisplay: string;
  threading: Record<string, unknown>;
  warnings: string[];
}

/** "Alice <alice@x>" → "alice@x"; bare addresses pass through. */
function addrOf(display: string): string {
  const m = /<([^>]+)>/.exec(display);
  return (m ? m[1] : display).trim().toLowerCase();
}

interface ImapReplyMeta {
  from?: string | null;
  to?: string[];
  cc?: string[];
  replyTo?: string | null;
  messageId?: string | null;
  references?: string[];
}

export function resolveImapReply(
  doc: Document,
  selfAddresses: string[],
  replyAll: boolean,
): ResolvedReply {
  if (doc.type !== 'email.message') {
    throw new Error(
      `draft_reply: document type '${doc.type}' is not replyable in this ` +
        `build — only 'email.message' (IMAP) documents are supported so far.`,
    );
  }
  const meta = doc.metadata as ImapReplyMeta;
  const self = new Set(selfAddresses.map((a) => addrOf(a)));
  const warnings: string[] = [];
  const from = meta.from ?? null;
  const selfSent = from !== null && self.has(addrOf(from));

  const to: string[] = [];
  const seen = new Set(self);
  const push = (display: string): void => {
    const a = addrOf(display);
    if (!seen.has(a)) {
      seen.add(a);
      to.push(display);
    }
  };

  let recipientDisplay: string;
  if (selfSent) {
    for (const t of meta.to ?? []) push(t);
    if (replyAll) for (const c of meta.cc ?? []) push(c);
    if (to.length === 0) {
      throw new Error(
        'draft_reply: this message was sent by you and its stored ' +
          'recipients are only you — cannot resolve a reply target.',
      );
    }
    recipientDisplay = to.join(', ');
    warnings.push(
      'Replying to a message you sent — addressing its original recipients.',
    );
  } else {
    const primary = meta.replyTo ?? from;
    if (!primary) {
      throw new Error(
        'draft_reply: the stored document has no sender metadata — cannot ' +
          'resolve a reply recipient.',
      );
    }
    push(primary);
    if (replyAll) {
      for (const t of meta.to ?? []) push(t);
      if (meta.cc === undefined) {
        warnings.push(
          'Cc recipients of the original message are not stored for this ' +
            'document; the reply goes to its From/To recipients only.',
        );
      } else {
        for (const c of meta.cc) push(c);
      }
    }
    if (to.length === 0) {
      // `primary` was a self address (e.g. a Reply-To pointing back at the
      // user) and `seen` is seeded with self, so the push above was a no-op —
      // never silently draft a reply to nobody.
      throw new Error(
        'draft_reply: the stored reply target resolves to your own address ' +
          '— there is nothing to send to.',
      );
    }
    recipientDisplay = to.join(', ');
  }

  const threading: Record<string, unknown> = {};
  if (meta.messageId) {
    // Stored angle-stripped (imap/parse.ts stripAngle) — re-bracket for RFC
    // 5322 headers; the references chain (when stored) precedes the message.
    const bracketed = `<${meta.messageId}>`;
    threading.inReplyTo = bracketed;
    threading.references = [
      ...(meta.references ?? []).map((r) => `<${r}>`),
      bracketed,
    ];
  } else {
    warnings.push(
      'No Message-ID is stored for the original — the reply may not thread ' +
        'on the recipient side.',
    );
  }

  const title = doc.title ?? null;
  const subject =
    title === null ? null : /^re:/i.test(title) ? title : `Re: ${title}`;

  return { to, cc: [], subject, recipientDisplay, threading, warnings };
}
