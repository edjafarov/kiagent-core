/**
 * Grounded gmail reply resolution (spec §1, §4): recipients and threading
 * come ONLY from the thread document's stored metadata — the model supplies
 * no address, and a gap is an explicit error or warning, never a guess.
 *
 * Handles both metadata generations written by sources/gmail/to-document.ts:
 * the current shape has only `{ from, id, date, snippet }` per message —
 * per-message `to`/`cc` are added by a later re-sync (phase 7). This
 * resolver treats the enriched shape as an upgrade it detects per-call
 * (`Array.isArray(last.to)`), never assumes it.
 */
import type { Document } from '@shared/contracts';

export interface GmailReplyResolution {
  to: string[];
  cc: string[];
  recipientDisplay: string;
  threading: {
    gmailThreadId: string;
    inReplyTo?: string;
    references?: string[];
  };
  warnings: string[];
}

interface GmailThreadMessage {
  id?: string | null;
  from?: string | null;
  to?: string[];
  cc?: string[];
  date?: string;
  snippet?: string;
}

interface GmailThreadMeta {
  gmailThreadId?: string;
  messages?: GmailThreadMessage[];
}

/** "Alice <alice@x.com>" → "alice@x.com"; bare addresses pass through. */
function addrOf(display: string): string {
  const m = /<([^>]+)>/.exec(display);
  return (m ? m[1] : display).trim().toLowerCase();
}

/** gmail stores the raw Message-ID header, usually already bracketed — add
 *  `<>` only when it's missing them. */
function bracket(id: string): string {
  return id.startsWith('<') && id.endsWith('>') ? id : `<${id}>`;
}

/** Filters a display-string list down to non-self entries, preserving the
 *  original display form (never the bare address) and de-duping by address. */
function minusSelf(displays: string[], self: Set<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const d of displays) {
    const a = addrOf(d);
    if (self.has(a) || seen.has(a)) continue;
    seen.add(a);
    out.push(d);
  }
  return out;
}

export function resolveGmailReply(
  doc: Document,
  selfAddresses: string[],
  replyAll: boolean,
): GmailReplyResolution {
  const meta = doc.metadata as GmailThreadMeta;
  if (
    !meta.gmailThreadId ||
    !Array.isArray(meta.messages) ||
    meta.messages.length === 0
  ) {
    throw new Error(
      'this Gmail document is missing thread metadata — re-sync the ' +
        'account and try again',
    );
  }

  const self = new Set(selfAddresses.map((a) => addrOf(a)));
  const { messages } = meta;
  const last = messages[messages.length - 1];
  const warnings: string[] = [];

  let to: string[] = [];
  let cc: string[] = [];

  const lastIsSelf =
    typeof last.from === 'string' && self.has(addrOf(last.from));
  const lastEnriched = Array.isArray(last.to);

  if (replyAll && lastEnriched) {
    const candidates = [
      ...(typeof last.from === 'string' ? [last.from] : []),
      ...(last.to ?? []),
    ];
    to = minusSelf(candidates, self);
    cc = minusSelf(last.cc ?? [], self);
  } else {
    // Plain reply, or reply_all falling back on an un-enriched doc: target
    // the last message whose sender is not self.
    let targetFrom: string | null = null;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const { from } = messages[i];
      if (typeof from === 'string' && !self.has(addrOf(from))) {
        targetFrom = from;
        break;
      }
    }
    if (targetFrom !== null) {
      to = [targetFrom];
    } else if (lastIsSelf && lastEnriched) {
      to = minusSelf(last.to ?? [], self);
      if (to.length > 0) {
        warnings.push(
          'Replying to a thread where you sent the last message — ' +
            'targeting its original recipients',
        );
      }
    }
    if (replyAll && !lastEnriched) {
      warnings.push(
        'reply_all fell back to reply-to-sender: this thread was synced ' +
          'before per-message recipients were stored; it will carry them ' +
          'after its next re-sync',
      );
    }
  }

  if (to.length === 0) {
    throw new Error(
      'this thread only contains messages from you — use draft_message to ' +
        'start a new email instead',
    );
  }

  const threading: GmailReplyResolution['threading'] = {
    gmailThreadId: meta.gmailThreadId,
  };
  const ids = messages
    .map((m) => m.id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
    .map(bracket);
  if (typeof last.id === 'string' && last.id.length > 0) {
    threading.inReplyTo = bracket(last.id);
  }
  if (ids.length > 0) {
    threading.references = ids;
  }

  return {
    to,
    cc,
    recipientDisplay: to.join(', '),
    threading,
    warnings,
  };
}
