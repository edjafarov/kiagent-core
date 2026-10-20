/**
 * Bundled Gmail transport: users.messages.send with the stored thread id.
 * Token refresh mirrors the engine's session semantics (60s margin, vault
 * write-back) because sends run outside any pull session. The sent message
 * re-enters the corpus through the normal history.list delta — no append.
 * Auto-retried ONLY on proven request-rejections (429/quota-403 — see
 * isSendSafeRetry); ambiguous failures (timeout/5xx/network) are never
 * retried: a duplicate email is worse than a failed row.
 */
import MailComposer from 'nodemailer/lib/mail-composer';

import type {
  Credentials,
  SendIntent,
  Sender,
  SendResult,
} from '@shared/contracts';

import type { CoreStore } from '../../core/store/store';
import { googleRefresher } from '../../sources/gmail/oauth';
import { sendGmailMessage } from '../../sources/gmail/gmail-api';
import { senderAddressFor } from '../identity';
import { createGmailDrafts } from './gmail-drafts';

const REFRESH_MARGIN_MS = 60_000;

/** Stamped on owner-channel mail only (core ownerMail). */
export const OWNER_CHANNEL_HEADERS = {
  'X-Kia-Channel': 'owner',
} as const;

/** Gmail refuses messages over 25 MB (the whole encoded message). */
const GMAIL_MESSAGE_MAX = 25 * 1024 * 1024;

function composeRaw(opts: {
  from: string | { name: string; address: string };
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  text: string;
  inReplyTo?: string;
  references?: string[];
  replyTo?: string;
  messageId?: string;
  ownerChannel?: boolean;
  attachments?: SendIntent['attachments'];
}): Promise<Buffer> {
  const mail = new MailComposer({
    from: opts.from,
    to: opts.to,
    cc: opts.cc?.length ? opts.cc : undefined,
    bcc: opts.bcc?.length ? opts.bcc : undefined,
    subject: opts.subject,
    text: opts.text,
    inReplyTo: opts.inReplyTo,
    references: opts.references?.length ? opts.references : undefined,
    replyTo: opts.replyTo,
    messageId: opts.messageId,
    headers: opts.ownerChannel ? { ...OWNER_CHANNEL_HEADERS } : undefined,
    attachments: opts.attachments?.length
      ? opts.attachments.map((a) => ({
          filename: a.filename,
          contentType: a.mime,
          content: Buffer.from(a.contentBase64, 'base64'),
        }))
      : undefined,
  });
  return new Promise((resolve, reject) => {
    const node = mail.compile();
    // Gmail reads the recipients from the headers (and strips Bcc on
    // delivery), so the Bcc header has to stay in the raw.
    node.keepBcc = true;
    node.build((err, message) => {
      if (err) reject(err);
      else resolve(message);
    });
  });
}

/** The account address, or (owner channel only) its send-as alias and
 *  display name. ownerMail has already validated both. */
function fromFor(
  intent: SendIntent,
  account: string,
): string | { name: string; address: string } {
  if (!intent.ownerChannel) return account;
  const address = intent.fromAddress ?? account;
  return intent.fromName ? { name: intent.fromName, address } : address;
}

export function createGmailSender(deps: {
  store: CoreStore;
  refresher?: typeof googleRefresher;
}): Sender {
  const refresh = deps.refresher ?? googleRefresher;

  async function freshCredentials(
    accountId: string,
  ): Promise<Credentials | null> {
    const creds = await deps.store.vault.load(accountId);
    if (!creds) return null;
    const expiringSoon =
      creds.expiresAt !== undefined &&
      Date.parse(creds.expiresAt) < Date.now() + REFRESH_MARGIN_MS;
    if (!expiringSoon) return creds;
    const fresh = await refresh(creds);
    if (!fresh) return creds;
    await deps.store.vault.save(accountId, fresh);
    return fresh;
  }

  async function compose(intent: SendIntent): Promise<Buffer> {
    const account = await deps.store.account(intent.accountId);
    if (!account) throw new Error('the sending account no longer exists');
    const threading = (intent.threading ?? {}) as {
      inReplyTo?: string;
      references?: string[];
    };
    const raw = await composeRaw({
      from: fromFor(intent, senderAddressFor(account)),
      to: intent.to ?? [],
      cc: intent.cc,
      bcc: intent.bcc,
      subject: intent.subject,
      text: intent.bodyMarkdown,
      inReplyTo: threading.inReplyTo,
      references: threading.references,
      replyTo: intent.replyTo,
      messageId: intent.messageId,
      ownerChannel: intent.ownerChannel,
      attachments: intent.attachments,
    });
    if (raw.length > GMAIL_MESSAGE_MAX)
      throw new Error('gmail: message too large');
    return raw;
  }

  return {
    drafts: createGmailDrafts({ credentials: freshCredentials, compose }),
    async send(intent: SendIntent): Promise<SendResult> {
      const account = await deps.store.account(intent.accountId);
      if (!account) throw new Error('the sending account no longer exists');
      const reconnectMsg = `this Gmail account was connected before sending existed — reconnect ${account.identifier} in Settings to grant send permission`;
      const creds = await freshCredentials(intent.accountId);
      if (!creds?.accessToken)
        throw new Error(
          `no Gmail credentials — reconnect ${account.identifier}`,
        );
      // Fail fast when we KNOW the grant can't send (gmail.compose also
      // allows sending); unknown (pre-scope-tracking blob) falls through
      // to the API's verdict.
      if (
        creds.scope &&
        !creds.scope.includes('gmail.send') &&
        !creds.scope.includes('gmail.compose')
      )
        throw new Error(reconnectMsg);

      const threading = (intent.threading ?? {}) as { gmailThreadId?: string };
      const raw = await compose(intent);
      try {
        const r = await sendGmailMessage(
          { credentials: () => freshCredentials(intent.accountId) },
          raw,
          threading.gmailThreadId,
        );
        return { externalMessageId: r.id, providerThreadId: r.threadId };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (
          /ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficientPermissions/i.test(msg)
        )
          throw new Error(reconnectMsg);
        throw e;
      }
    },
  };
}
