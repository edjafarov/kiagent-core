/**
 * The Gmail side of an Outbox draft: a real Gmail draft kept in step with the
 * Kia row (spec §5.5). Create composes exactly what a send would; update
 * rebuilds the stored draft from its own raw so what the user added in Gmail
 * (Bcc, HTML, inline images, files) survives a Kia edit — except that a body
 * change replaces both parts with Kia's (the Markdown as text, its rendering
 * as HTML), which would otherwise say the old thing. Read maps `format=full` to DraftContent; a draft that no
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
  headersOf,
  htmlBodyOf,
  isFilePart,
  plainTextOf,
  splitAddressList,
  type GmailPart,
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
      // Sent from Gmail, the draft id can still answer — with the sent
      // message, which no longer carries DRAFT.
      const labels = d.message.labelIds;
      if (labels && !labels.includes('DRAFT'))
        return labels.includes('SENT')
          ? { state: 'sent', externalMessageId: d.message.id }
          : { state: 'gone' };
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

/** True when Gmail left the text out of a `format=full` answer (a body part
 *  stored by reference): adopting that would read as an emptied draft. */
function bodyByReference(p: GmailPart | undefined): boolean {
  if (!p || isFilePart(p)) return false;
  if (/^text\/(plain|html)$/i.test(p.mimeType ?? '') && !p.body?.data)
    return Boolean(p.body?.attachmentId);
  return (p.parts ?? []).some(bodyByReference);
}

function contentOf(msg: Parameters<typeof plainTextOf>[0]): DraftContent {
  const bodyText = plainTextOf(msg);
  if (!bodyText && bodyByReference(msg.payload))
    throw new Error('the Gmail draft text is too large to read');
  const h = headersOf(msg);
  const bodyHtml = htmlBodyOf(msg);
  return {
    to: splitAddressList(h.to),
    cc: splitAddressList(h.cc),
    bcc: splitAddressList(h.bcc),
    subject: h.subject ?? null,
    bodyText,
    ...(bodyHtml !== undefined ? { bodyHtml } : {}),
    attachments: filesOf(msg.payload),
  };
}

/** Every part the message carries as a file — whatever its type, so a
 *  .txt or .html added in Gmail is reviewed like any other. Inline parts
 *  the body refers to (a Content-ID) stay part of the body; an inline part
 *  without one (Apple Mail's inline PDF) is a file that will be sent. */
function filesOf(p: GmailPart | undefined): DraftContent['attachments'] {
  if (!p) return [];
  const out: DraftContent['attachments'] = [];
  const walk = (part: GmailPart) => {
    const header = (name: string) =>
      part.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? '';
    const cd = header('content-disposition');
    // Gmail's own (decoded) name first; the header only as a fallback.
    const named = part.filename || /filename="?([^";]+)"?/i.exec(cd)?.[1];
    const inBody = /^\s*inline/i.test(cd) && header('content-id') !== '';
    if (named && !inBody)
      out.push({
        filename: named,
        mime: part.mimeType || 'application/octet-stream',
        size: part.body?.size ?? 0,
      });
    for (const c of part.parts ?? []) walk(c);
  };
  walk(p);
  return out;
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
        (a.contentDisposition === 'inline' && Boolean(a.cid)) ||
        !removed.has(a.filename ?? ''),
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
    html: bodyChanged ? patch.bodyHtml : m.html || undefined,
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
