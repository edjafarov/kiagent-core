/**
 * The bundled SMTP Sender — composes one RFC822 buffer with nodemailer's
 * MailComposer, sends it over SMTP, then best-effort appends the same raw
 * bytes to the account's Sent mailbox over IMAP so the message shows up in
 * the user's own client. Reachable ONLY from the send pipeline (post-
 * confirmation) — never from the MCP plane.
 */
import MailComposer from 'nodemailer/lib/mail-composer';
import { createTransport as realCreateTransport } from 'nodemailer';

import type { SendIntent, SendResult, Sender } from '@shared/contracts';

import type { CoreStore } from '../../core/store/store';
import { connectImapClient } from '../../sources/imap/client';
import { resolveMailboxes } from '../../sources/imap/folders';
import type { ImapAccountConfig } from '../../sources/imap/types';
import { senderAddressFor } from '../identity';

export interface SMTPTransportOptions {
  host: string;
  port: number;
  secure: boolean;
  auth: { user: string; pass: string };
}

interface SmtpOverride {
  host?: string;
  port?: number;
  secure?: boolean;
}

/**
 * Derive SMTP connection settings from the account's IMAP config: an
 * explicit per-field override always wins; otherwise an `imap.` host prefix
 * is swapped for `smtp.` (any other shape passes through unchanged), on
 * port 465 with implicit TLS — the common submission default.
 */
export function deriveSmtpConfig(
  imap: ImapAccountConfig,
  override?: SmtpOverride,
): { host: string; port: number; secure: boolean } {
  const host =
    override?.host ??
    (imap.host.startsWith('imap.')
      ? `smtp.${imap.host.slice('imap.'.length)}`
      : imap.host);
  const port = override?.port ?? 465;
  const secure = override?.secure ?? true;
  return { host, port, secure };
}

/** Strip a `"Display Name" <addr@x.y>` wrapper down to the bare address. */
function bareAddress(addr: string): string {
  const m = addr.match(/<([^>]+)>/);
  return (m ? m[1] : addr).trim();
}

export function createSmtpSender(deps: {
  store: CoreStore;
  /** Test seams — default to the real nodemailer/imapflow paths. */
  createTransport?: (opts: SMTPTransportOptions) => {
    sendMail(mail: {
      envelope: { from: string; to: string[] };
      raw: Buffer;
    }): Promise<unknown>;
  };
  connectImap?: typeof connectImapClient;
  log?: (msg: string) => void;
}): Sender {
  const createTransport = deps.createTransport ?? realCreateTransport;
  const connectImap = deps.connectImap ?? connectImapClient;
  const log = deps.log ?? (() => {});

  return {
    async send(intent: SendIntent): Promise<SendResult> {
      const account = await deps.store.account(intent.accountId);
      if (!account) {
        throw new Error(`smtp: no account found for id ${intent.accountId}`);
      }
      const creds = await deps.store.vault.load(intent.accountId);
      const pass = creds?.password;
      if (!pass) {
        throw new Error(
          `smtp: no password stored for account ${intent.accountId}`,
        );
      }
      const fromAddress = senderAddressFor(account);

      const imapCfg = account.config as unknown as ImapAccountConfig;
      const smtpOverride = (
        account.config as { outbound?: { smtp?: SmtpOverride } }
      ).outbound?.smtp;
      const { host, port, secure } = deriveSmtpConfig(imapCfg, smtpOverride);

      const to = intent.to ?? [];
      const cc = intent.cc?.length ? intent.cc : undefined;
      const mail = new MailComposer({
        from: fromAddress,
        to,
        cc,
        subject: intent.subject,
        text: intent.bodyMarkdown,
        inReplyTo: intent.threading?.inReplyTo as string | undefined,
        references: intent.threading?.references as string[] | undefined,
      });
      const node = mail.compile();
      const messageId = node.messageId();
      const raw = await node.build();

      const transport = createTransport({
        host,
        port,
        secure,
        auth: { user: imapCfg.user, pass },
      });
      await transport.sendMail({
        envelope: {
          from: fromAddress,
          to: [...to, ...(cc ?? [])].map(bareAddress),
        },
        raw,
      });

      // Sent-append is best-effort: the message already left over SMTP, so a
      // failure here must never fail the send.
      try {
        const client = await connectImap(imapCfg, pass);
        try {
          const folders = await client.listFolders();
          const sent = resolveMailboxes(folders).find((m) => m.role === 'sent');
          if (sent) {
            await client.append(sent.path, raw);
          }
        } finally {
          await client.close();
        }
      } catch (err) {
        log(
          `smtp: Sent-append failed for account ${intent.accountId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      return { externalMessageId: messageId };
    },
  };
}
