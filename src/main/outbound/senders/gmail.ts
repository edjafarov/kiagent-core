/**
 * Bundled Gmail transport: users.messages.send with the stored thread id.
 * Token refresh mirrors the engine's session semantics (60s margin, vault
 * write-back) because sends run outside any pull session. The sent message
 * re-enters the corpus through the normal history.list delta — no append.
 * Never auto-retried: a duplicate email is worse than a failed row.
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

const REFRESH_MARGIN_MS = 60_000;

function composeRaw(opts: {
  from: string;
  to: string[];
  cc?: string[];
  subject?: string;
  text: string;
  inReplyTo?: string;
  references?: string[];
}): Promise<Buffer> {
  const mail = new MailComposer({
    from: opts.from,
    to: opts.to,
    cc: opts.cc?.length ? opts.cc : undefined,
    subject: opts.subject,
    text: opts.text,
    inReplyTo: opts.inReplyTo,
    references: opts.references?.length ? opts.references : undefined,
  });
  return new Promise((resolve, reject) => {
    mail.compile().build((err, message) => {
      if (err) reject(err);
      else resolve(message);
    });
  });
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

  return {
    async send(intent: SendIntent): Promise<SendResult> {
      const account = await deps.store.account(intent.accountId);
      if (!account) throw new Error('the sending account no longer exists');
      const reconnectMsg = `this Gmail account was connected before sending existed — reconnect ${account.identifier} in Settings to grant send permission`;
      const creds = await freshCredentials(intent.accountId);
      if (!creds?.accessToken)
        throw new Error(
          `no Gmail credentials — reconnect ${account.identifier}`,
        );
      // Fail fast when we KNOW the grant predates gmail.send; unknown
      // (pre-scope-tracking blob) falls through to the API's verdict.
      if (creds.scope && !creds.scope.includes('gmail.send'))
        throw new Error(reconnectMsg);

      const threading = (intent.threading ?? {}) as {
        gmailThreadId?: string;
        inReplyTo?: string;
        references?: string[];
      };
      const raw = await composeRaw({
        from: senderAddressFor(account),
        to: intent.to ?? [],
        cc: intent.cc,
        subject: intent.subject,
        text: intent.bodyMarkdown,
        inReplyTo: threading.inReplyTo,
        references: threading.references,
      });
      try {
        const r = await sendGmailMessage(
          { credentials: () => freshCredentials(intent.accountId) },
          raw,
          threading.gmailThreadId,
        );
        return { externalMessageId: r.id };
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
