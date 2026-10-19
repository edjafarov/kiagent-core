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
/** Inbound attachment cap: Gmail's own 25 MB message limit. */
export const OWNER_ATTACHMENT_MAX = 25 * 1024 * 1024;
const CAP = 60;
const ID_RX = /^<[^\s<>@]+@[^\s<>@]+>$/;
/** A plain display name: no address, quotes, brackets or line breaks. */
const NAME_RX = /^[\p{L}\p{N} .'-]{1,40}$/u;
const MAX_ATTACHMENTS = 10;
/** Encoded (base64) total; leaves headroom under Gmail's 25 MB message cap. */
const MAX_ENCODED = 24 * 1024 * 1024;
const MIME_RX = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;

/** One line, no path, no control characters; never empty. */
export function safeAttachmentName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex -- control chars are what we strip
  const controls = /[\u0000-\u001f\u007f]/g;
  const clean = base.replace(controls, '').trim().slice(0, 200);
  return clean && clean !== '.' && clean !== '..' ? clean : 'attachment';
}

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
  /** Display name on From (e.g. "Kia"); the address is always the owner. */
  fromName?: string;
  /** Send-as address; must be a plus-variant of the owner, like replyTo. */
  fromAddress?: string;
  /** Files to attach: at most 10, 24 MiB encoded in total. */
  attachments?: { filename: string; mime: string; bytes: Uint8Array }[];
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
  /** One attachment of an owner message (`AddressedAttachment.id`); the
   *  source re-checks the message is in Sent. Capped at 25 MB. */
  fetchAttachment(
    accountId: string,
    providerId: string,
    attachmentId: string,
  ): Promise<Uint8Array>;
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

    async fetchAttachment(id, providerId, attachmentId) {
      const { a } = await load(id);
      const src = deps.sources.get(a.source);
      if (!src?.fetchAddressedAttachment)
        throw new Error('ownerMail: source cannot fetch attachments');
      let bytes: Uint8Array;
      try {
        bytes = await src.fetchAddressedAttachment(
          deps.session(a, new AbortController().signal),
          providerId,
          attachmentId,
          { maxBytes: OWNER_ATTACHMENT_MAX },
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/not a sent message/i.test(msg))
          throw new Error('ownerMail: not an owner message');
        if (/too large/i.test(msg))
          throw new Error('ownerMail: attachment too large');
        throw e;
      }
      if (bytes.length > OWNER_ATTACHMENT_MAX)
        throw new Error('ownerMail: attachment too large');
      return bytes;
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
      if (m.fromAddress !== undefined && !rx.test(m.fromAddress))
        throw new Error(
          'ownerMail: fromAddress must be a plus-variant of the owner address',
        );
      if (m.fromName !== undefined && !NAME_RX.test(m.fromName))
        throw new Error('ownerMail: fromName must be a plain display name');
      for (const x of [m.messageId, m.inReplyTo, ...(m.references ?? [])])
        if (x !== undefined && !ID_RX.test(x))
          throw new Error('ownerMail: malformed message id');
      const files = m.attachments ?? [];
      if (files.length > MAX_ATTACHMENTS)
        throw new Error('ownerMail: at most 10 attachments');
      const attachments = files.map((f) => ({
        filename: safeAttachmentName(f.filename),
        mime: MIME_RX.test(f.mime)
          ? f.mime.toLowerCase()
          : 'application/octet-stream',
        contentBase64: Buffer.from(f.bytes).toString('base64'),
      }));
      if (
        attachments.reduce((n, f) => n + f.contentBase64.length, 0) >
        MAX_ENCODED
      )
        throw new Error('ownerMail: message too large');
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
        ...(m.fromName ? { fromName: m.fromName } : {}),
        ...(m.fromAddress ? { fromAddress: m.fromAddress.toLowerCase() } : {}),
        ownerChannel: true,
        ...(attachments.length ? { attachments } : {}),
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
