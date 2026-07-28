/**
 * Grounded gmail reply resolution (spec §1, §4): recipients and threading
 * come ONLY from the thread document's stored metadata — the model supplies
 * no address, and a gap is an explicit error or warning, never a guess.
 * Per-message `to`/`cc` and the raw `replyTo` header come from
 * sources/gmail/to-document.ts; absent lists are treated as empty.
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
  /** RAW `Reply-To` header as stored by to-document.ts. */
  replyTo?: string | null;
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

/**
 * The address a reply to `m` is aimed at: `Reply-To` when the sender set one,
 * otherwise `From` — matching resolve.ts (imap) and RFC 5322 §3.6.2.
 *
 * Deliberately `||`, not `??`: gmail's projection is
 * `m.headers['reply-to'] ?? null`, so a bare `Reply-To:` header survives as an
 * EMPTY STRING rather than null (imap's parser normalizes it away, gmail's
 * does not). An empty or whitespace-only header means "no Reply-To" — treating
 * it as present would address the reply to nobody. The returned address is
 * trimmed: it goes on the wire as a `To:` header, not just through addrOf().
 */
function replyTarget(m: GmailThreadMessage): string | null {
  if (typeof m.replyTo === 'string' && m.replyTo.trim() !== '') {
    return m.replyTo.trim();
  }
  return typeof m.from === 'string' ? m.from : null;
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
  // Gmail accounts also own `attachment` child docs (to-document.ts) parented
  // to the thread — those never carry thread metadata, so the missing-
  // metadata error below would send a user re-syncing in an endless loop.
  // Gate on type first, precisely, mirroring resolve.ts's own type gate.
  if (doc.type !== 'email.thread') {
    throw new Error(
      `draft_reply: document type '${doc.type}' is not replyable in this ` +
        `build — only 'email.thread' (Gmail) documents are supported so far.`,
    );
  }
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

  if (replyAll) {
    const primary = replyTarget(last);
    const candidates = [
      ...(primary !== null ? [primary] : []),
      ...(last.to ?? []),
    ];
    to = minusSelf(candidates, self);
    cc = minusSelf(last.cc ?? [], self);
  } else {
    // Plain reply: target the last message whose sender is not self.
    // Self-detection stays on `From` (a Reply-To never makes a message
    // yours), but the address the reply is ADDRESSED to comes from that
    // same target message — which is not necessarily `last`, e.g. when you
    // sent the newest message.
    let target: GmailThreadMessage | null = null;
    let targetFrom: string | null = null;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const { from } = messages[i];
      if (typeof from === 'string' && !self.has(addrOf(from))) {
        target = messages[i];
        targetFrom = from;
        break;
      }
    }
    if (target !== null && targetFrom !== null) {
      // Reply-To wins over From — EXCEPT when it points back at the user.
      // A plain reply must never be addressed to the user themselves (before
      // Reply-To was honored, the loop above made that impossible), so fall
      // back to From, which the loop already proved is not self.
      const primary = replyTarget(target) ?? targetFrom;
      to = self.has(addrOf(primary)) ? [targetFrom] : [primary];
    } else if (lastIsSelf) {
      to = minusSelf(last.to ?? [], self);
      if (to.length > 0) {
        warnings.push(
          'Replying to a thread where you sent the last message — ' +
            'targeting its original recipients',
        );
      }
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
