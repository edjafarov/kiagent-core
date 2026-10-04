/**
 * Owner-only mail route. A trusted extension (the assistant's email channel)
 * may read mail addressed to a plus-variant of an account's own address and
 * send mail TO THE OWNER ONLY: the recipient is pinned here, never taken
 * from the caller, so this route can never mail a third party. No Outbox, no
 * confirmation page — the only person it can reach is the user themselves.
 */
import type {
  Account,
  AddressedMail,
  AddressedQuery,
  Session,
  Source,
} from '@shared/contracts';

import { EMAIL_RX, senderAddressFor } from './identity';
import type { SenderLookup } from './senders';

const HOUR = 3_600_000;
const CAP = 60;
const ID_RX = /^<[^\s<>@]+@[^\s<>@]+>$/;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface OwnerMessage {
  /** Must be `<owner local>+<tag>@<owner domain>`. */
  replyTo: string;
  subject: string;
  bodyText: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  /** Provider-native reply target (Graph /reply), when the source has one. */
  replyToProviderId?: string;
  providerThreadId?: string;
}

export interface OwnerMailApi {
  describe(
    accountId: string,
  ): Promise<{ ownerAddress: string; supported: boolean } | null>;
  listAddressedTo(
    accountId: string,
    q: AddressedQuery,
  ): Promise<AddressedMail[]>;
  sendToOwner(
    accountId: string,
    m: OwnerMessage,
  ): Promise<{ externalMessageId?: string; providerThreadId?: string }>;
}

export function createOwnerMail(deps: {
  account(id: string): Promise<Account | null>;
  sources: { get(id: string): Source<unknown, unknown> | undefined };
  senders: SenderLookup;
  session(account: Account, signal: AbortSignal): Session;
  now?: () => number;
}): OwnerMailApi {
  const now = deps.now ?? Date.now;
  const sends = new Map<string, number[]>();

  const ownerOf = (a: Account): string | null => {
    let addr: string;
    try {
      addr = (
        a.source === 'gmail' || a.source === 'imap'
          ? senderAddressFor(a)
          : a.identifier
      )
        .trim()
        .toLowerCase();
    } catch {
      return null;
    }
    return EMAIL_RX.test(addr) ? addr : null;
  };

  async function load(id: string) {
    const a = await deps.account(id);
    if (!a) throw new Error('ownerMail: unknown account');
    const owner = ownerOf(a);
    if (!owner) throw new Error('ownerMail: account has no owner address');
    return { a, owner };
  }

  return {
    async describe(id) {
      const a = await deps.account(id);
      if (!a) return null;
      const owner = ownerOf(a);
      const src = deps.sources.get(a.source);
      return {
        ownerAddress: owner ?? '',
        supported: !!owner && typeof src?.listAddressedTo === 'function',
      };
    },

    async listAddressedTo(id, q) {
      const { a } = await load(id);
      const src = deps.sources.get(a.source);
      if (!src?.listAddressedTo)
        throw new Error('ownerMail: source cannot list addressed mail');
      return src.listAddressedTo(
        deps.session(a, new AbortController().signal),
        q,
      );
    },

    async sendToOwner(id, m) {
      const { a, owner } = await load(id);
      const [local, domain] = owner.split('@');
      const rx = new RegExp(
        `^${esc(local)}\\+[a-z0-9.]{1,40}@${esc(domain)}$`,
        'i',
      );
      if (!rx.test(m.replyTo))
        throw new Error(
          'ownerMail: replyTo must be a plus-variant of the owner address',
        );
      if (/[\r\n]/.test(m.subject))
        throw new Error('ownerMail: subject must be one line');
      for (const x of [m.messageId, m.inReplyTo, ...(m.references ?? [])])
        if (x !== undefined && !ID_RX.test(x))
          throw new Error('ownerMail: malformed message id');
      const t = now();
      const recent = (sends.get(id) ?? []).filter((s) => t - s < HOUR);
      if (recent.length >= CAP)
        throw new Error('ownerMail: rate limit (60/hour) reached');
      const sender = deps.senders.get(a.source);
      if (!sender) throw new Error('ownerMail: no sender for this account');
      const threading: Record<string, unknown> = {};
      if (m.inReplyTo) threading.inReplyTo = m.inReplyTo;
      if (m.references?.length) threading.references = m.references;
      if (m.providerThreadId) threading.gmailThreadId = m.providerThreadId;
      recent.push(t);
      sends.set(id, recent);
      const r = await sender.send({
        accountId: a.id,
        kind: m.replyToProviderId ? 'reply' : 'new',
        ...(m.replyToProviderId
          ? { outboundRef: { messageId: m.replyToProviderId } }
          : {}),
        to: [owner],
        subject: m.subject,
        bodyMarkdown: m.bodyText,
        replyTo: m.replyTo.toLowerCase(),
        ...(m.messageId ? { messageId: m.messageId } : {}),
        ownerChannel: true,
        ...(Object.keys(threading).length ? { threading } : {}),
      });
      return {
        ...(r.externalMessageId
          ? { externalMessageId: r.externalMessageId }
          : {}),
        ...(r.providerThreadId ? { providerThreadId: r.providerThreadId } : {}),
      };
    },
  };
}
