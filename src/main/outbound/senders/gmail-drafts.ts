/**
 * The Gmail side of an Outbox draft: a real Gmail draft kept in step with the
 * Kia row (spec §5.5). Create composes exactly what a send would; update
 * rebuilds the stored draft from its own raw so what the user added in Gmail
 * (Bcc, HTML, inline images, files) survives a Kia edit — except that a body
 * change replaces the text and drops the HTML, which would otherwise say
 * the old thing. Read maps `format=full` to DraftContent; a draft that no
 * longer exists is `gone` (Gmail cannot tell sent from deleted).
 */
import MailComposer from 'nodemailer/lib/mail-composer';
import { simpleParser, type AddressObject } from 'mailparser';
import type Mail from 'nodemailer/lib/mailer';

import type {
  Credentials,
  DraftContent,
  DraftMirror,
  DraftPatch,
  DraftReadResult,
  DraftRef,
  SendIntent,
  SendResult,
} from '@shared/contracts';

import {
  createGmailDraft,
  deleteGmailDraft,
  getGmailDraft,
  sendGmailDraft,
  updateGmailDraft,
} from '../../sources/gmail/gmail-api';
import {
  attachmentsOf,
  headersOf,
  plainTextOf,
  splitAddressList,
} from '../../sources/gmail/parser';

/** Matches error-copy's `reconnect .* in Settings` auth contract, so a
 *  refused send reads as provably not sent. */
export const DRAFT_RECONNECT =
  'Reconnect this account in Settings to sync drafts';

const SCOPE_ERROR_RE =
  /ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficientPermissions/i;

export function createGmailDrafts(deps: {
  credentials(accountId: string): Promise<Credentials | null>;
  /** The RFC822 message a send of this intent would carry. */
  compose(intent: SendIntent): Promise<Buffer>;
}): DraftMirror {
  const auth = (accountId: string) => ({
    credentials: () => deps.credentials(accountId),
  });

  /** Writes need gmail.compose; an old grant (send only) fails fast. */
  async function requireCompose(accountId: string): Promise<void> {
    const creds = await deps.credentials(accountId);
    if (!creds?.accessToken) throw new Error(DRAFT_RECONNECT);
    if (creds.scope && !creds.scope.includes('gmail.compose'))
      throw new Error(DRAFT_RECONNECT);
  }

  async function scoped<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof Error && SCOPE_ERROR_RE.test(e.message))
        throw new Error(DRAFT_RECONNECT);
      throw e;
    }
  }

  return {
    async create(intent: SendIntent): Promise<DraftRef> {
      await requireCompose(intent.accountId);
      const threadId = (intent.threading as { gmailThreadId?: string })
        ?.gmailThreadId;
      const raw = await deps.compose(intent);
      const d = await scoped(() =>
        createGmailDraft(auth(intent.accountId), raw, threadId),
      );
      return {
        accountId: intent.accountId,
        id: d.id,
        threadId: d.message?.threadId ?? threadId,
      };
    },

    async update(ref: DraftRef, patch: DraftPatch): Promise<DraftRef> {
      await requireCompose(ref.accountId);
      const current = await scoped(() =>
        getGmailDraft(auth(ref.accountId), ref.id, 'raw'),
      );
      if (!current?.message?.raw)
        throw new Error('the Gmail draft no longer exists');
      const raw = await rebuild(
        Buffer.from(current.message.raw, 'base64url'),
        patch,
      );
      const threadId = current.message.threadId ?? ref.threadId;
      const d = await scoped(() =>
        updateGmailDraft(auth(ref.accountId), ref.id, raw, threadId),
      );
      return {
        accountId: ref.accountId,
        id: d.id ?? ref.id,
        threadId: d.message?.threadId ?? threadId,
      };
    },

    async read(ref: DraftRef): Promise<DraftReadResult> {
      const d = await scoped(() =>
        getGmailDraft(auth(ref.accountId), ref.id, 'full'),
      );
      if (!d?.message) return { state: 'gone' };
      return {
        state: 'draft',
        ref: {
          accountId: ref.accountId,
          id: d.id ?? ref.id,
          threadId: d.message.threadId ?? ref.threadId,
        },
        content: contentOf(d.message),
      };
    },

    async remove(ref: DraftRef): Promise<void> {
      await scoped(() => deleteGmailDraft(auth(ref.accountId), ref.id));
    },

    async send(ref: DraftRef): Promise<SendResult> {
      await requireCompose(ref.accountId);
      const r = await scoped(() => sendGmailDraft(auth(ref.accountId), ref.id));
      return { externalMessageId: r.id, providerThreadId: r.threadId };
    },
  };
}

function contentOf(msg: Parameters<typeof plainTextOf>[0]): DraftContent {
  const h = headersOf(msg);
  return {
    to: splitAddressList(h.to),
    cc: splitAddressList(h.cc),
    bcc: splitAddressList(h.bcc),
    subject: h.subject ?? null,
    bodyText: plainTextOf(msg),
    attachments: attachmentsOf(msg).map((a) => ({
      filename: a.filename,
      mime: a.mimeType,
      size: a.sizeBytes,
    })),
  };
}

function addresses(a: AddressObject | AddressObject[] | undefined): string[] {
  const list = Array.isArray(a) ? a : a ? [a] : [];
  return list.flatMap((o) =>
    o.value
      .filter((v) => v.address)
      .map((v) =>
        v.name ? `"${v.name.replace(/"/g, '')}" <${v.address}>` : v.address!,
      ),
  );
}

/** The stored draft with `patch` applied; everything the patch does not
 *  name is carried over as Gmail holds it. */
async function rebuild(raw: Buffer, patch: DraftPatch): Promise<Buffer> {
  const m = await simpleParser(raw, { skipImageLinks: true });
  const bodyChanged = patch.bodyMarkdown !== undefined;
  const removed = new Set(patch.removeAttachments ?? []);
  const kept: Mail.Attachment[] = m.attachments
    .filter(
      (a) =>
        a.contentDisposition === 'inline' || !removed.has(a.filename ?? ''),
    )
    .map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      content: a.content,
      cid: a.cid,
      contentDisposition:
        a.contentDisposition === 'inline' ? 'inline' : 'attachment',
    }));
  const added: Mail.Attachment[] = (patch.attachments ?? []).map((a) => ({
    filename: a.filename,
    contentType: a.mime,
    content: Buffer.from(a.contentBase64, 'base64'),
  }));
  const refs = m.references;
  const node = new MailComposer({
    from: m.from?.text,
    to: patch.to ?? addresses(m.to),
    cc: patch.cc ?? addresses(m.cc),
    bcc: addresses(m.bcc),
    subject: patch.subject ?? m.subject,
    text: bodyChanged ? patch.bodyMarkdown : (m.text ?? ''),
    html: bodyChanged || !m.html ? undefined : m.html,
    inReplyTo: m.inReplyTo,
    references: refs ? (Array.isArray(refs) ? refs : [refs]) : undefined,
    messageId: m.messageId,
    attachments: [...kept, ...added],
  }).compile();
  node.keepBcc = true;
  return new Promise((resolve, reject) => {
    node.build((err, message) => (err ? reject(err) : resolve(message)));
  });
}
