import type { Document, DocumentInput } from '@shared/contracts';
import {
  toDocument,
  type GmailThreadItem,
} from '@main/sources/gmail/to-document';

import { resolveGmailReply } from '../resolve-gmail';

const SELF = ['me@gmail.com'];
const doc = (over: Partial<Record<string, unknown>> = {}): Document =>
  ({
    id: 'd1',
    accountId: 'a1',
    type: 'email.thread',
    title: 'T',
    markdown: '',
    metadata: {
      gmailThreadId: 't123',
      messages: [
        { id: '<m1@x>', from: 'Alice <alice@x.com>', date: 'D', snippet: 's' },
        { id: '<m2@x>', from: 'me@gmail.com', date: 'D', snippet: 's' },
        { id: '<m3@x>', from: 'Bob <bob@x.com>', date: 'D', snippet: 's' },
      ],
      ...over,
    },
  }) as unknown as Document;

describe('resolveGmailReply', () => {
  it('reply targets the last non-self sender with full threading', () => {
    const r = resolveGmailReply(doc(), SELF, false);
    expect(r.to).toEqual(['Bob <bob@x.com>']);
    expect(r.threading).toEqual({
      gmailThreadId: 't123',
      inReplyTo: '<m3@x>',
      references: ['<m1@x>', '<m2@x>', '<m3@x>'],
    });
    expect(r.warnings).toEqual([]);
  });

  it('reply_all on an un-enriched doc falls back with a warning', () => {
    const r = resolveGmailReply(doc(), SELF, true);
    expect(r.to).toEqual(['Bob <bob@x.com>']);
    expect(r.cc).toEqual([]);
    expect(r.warnings[0]).toMatch(/fell back to reply-to-sender/);
  });

  it('reply_all uses enriched per-message recipients minus self', () => {
    const r = resolveGmailReply(
      doc({
        messages: [
          {
            id: '<m9@x>',
            from: 'Alice <alice@x.com>',
            date: 'D',
            snippet: 's',
            to: ['me@gmail.com', 'Carol <carol@x.com>'],
            cc: ['dave@x.com'],
          },
        ],
      }),
      SELF,
      true,
    );
    expect(r.to).toEqual(['Alice <alice@x.com>', 'Carol <carol@x.com>']);
    expect(r.cc).toEqual(['dave@x.com']);
    expect(r.warnings).toEqual([]);
  });

  it('rejects a non-thread gmail document (e.g. an attachment child doc) with a precise error, not the re-sync message', () => {
    const attachmentDoc = {
      id: 'd2',
      accountId: 'a1',
      type: 'attachment',
      title: 'file.pdf',
      markdown: null,
      metadata: {
        mime: 'application/pdf',
        filename: 'file.pdf',
        sizeBytes: 1234,
        messageId: '<m1@x>',
        partId: '0.1',
        attachmentId: 'abc',
      },
    } as unknown as Document;
    let caught: Error | undefined;
    try {
      resolveGmailReply(attachmentDoc, SELF, false);
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toMatch(/not replyable/);
    expect(caught?.message).not.toMatch(/missing thread metadata/);
    expect(caught?.message).not.toMatch(/re-sync/);
  });

  it('reply honors Reply-To over From', () => {
    const r = resolveGmailReply(
      doc({
        messages: [
          {
            id: '<m1@x>',
            from: 'Alice <alice@x.com>',
            date: 'D',
            snippet: 's',
            to: ['me@gmail.com'],
            cc: [],
            replyTo: 'list@x.com',
          },
        ],
      }),
      SELF,
      false,
    );
    expect(r.to).toEqual(['list@x.com']);
  });

  it('reply substitutes the TARGET message Reply-To, not the newest message', () => {
    // Newest message is the user's own, so the reply target is the earlier
    // message — its Reply-To must be the one that wins.
    const r = resolveGmailReply(
      doc({
        messages: [
          {
            id: '<m1@x>',
            from: 'Alice <alice@x.com>',
            date: 'D',
            snippet: 's',
            replyTo: 'list@x.com',
          },
          { id: '<m2@x>', from: 'me@gmail.com', date: 'D', snippet: 's' },
        ],
      }),
      SELF,
      false,
    );
    expect(r.to).toEqual(['list@x.com']);
  });

  it('reply_all puts Reply-To ahead of the other recipients, minus self', () => {
    const r = resolveGmailReply(
      doc({
        messages: [
          {
            id: '<m9@x>',
            from: 'Alice <alice@x.com>',
            date: 'D',
            snippet: 's',
            to: ['me@gmail.com', 'Carol <carol@x.com>'],
            cc: ['dave@x.com'],
            replyTo: 'list@x.com',
          },
        ],
      }),
      SELF,
      true,
    );
    expect(r.to).toEqual(['list@x.com', 'Carol <carol@x.com>']);
    expect(r.to).not.toContain('Alice <alice@x.com>');
    expect(r.cc).toEqual(['dave@x.com']);
    expect(r.warnings).toEqual([]);
  });

  it('treats an EMPTY Reply-To header as absent (falls back to From)', () => {
    // gmail's projection is `m.headers['reply-to'] ?? null`, so a bare
    // `Reply-To:` header reaches metadata as '' — never address a reply to it.
    // Whitespace-only is the same thing with a different spelling. Full
    // matrix: both spellings x both reply modes.
    const withReplyTo = (replyTo: string) =>
      doc({
        messages: [
          {
            id: '<m9@x>',
            from: 'Alice <alice@x.com>',
            date: 'D',
            snippet: 's',
            to: ['me@gmail.com', 'Carol <carol@x.com>'],
            cc: ['dave@x.com'],
            replyTo,
          },
        ],
      });

    for (const blank of ['', '   ']) {
      expect(resolveGmailReply(withReplyTo(blank), SELF, false).to).toEqual([
        'Alice <alice@x.com>',
      ]);
      const all = resolveGmailReply(withReplyTo(blank), SELF, true);
      expect(all.to).toEqual(['Alice <alice@x.com>', 'Carol <carol@x.com>']);
      expect(all.cc).toEqual(['dave@x.com']);
    }

    // A padded-but-real header is honored, trimmed — it goes on the wire.
    expect(
      resolveGmailReply(withReplyTo('  list@x.com  '), SELF, false).to,
    ).toEqual(['list@x.com']);
    expect(
      resolveGmailReply(withReplyTo('  list@x.com  '), SELF, true).to,
    ).toEqual(['list@x.com', 'Carol <carol@x.com>']);
  });

  it('never addresses a plain reply to the user, even when Reply-To points back at them', () => {
    const r = resolveGmailReply(
      doc({
        messages: [
          {
            id: '<m1@x>',
            from: 'Alice <alice@x.com>',
            date: 'D',
            snippet: 's',
            replyTo: 'me@gmail.com',
          },
        ],
      }),
      SELF,
      false,
    );
    // Falls back to From, which the target loop already proved is not self.
    expect(r.to).toEqual(['Alice <alice@x.com>']);
    expect(r.to).not.toContain('me@gmail.com');
    expect(r.warnings).toEqual([]);
  });

  it('glue: toDocument output feeds reply_all end to end', () => {
    // The one test where the real producer meets the real consumer: a raw
    // two-message thread goes through parseGmailMessage -> toDocument, and
    // the resulting metadata is handed straight to the resolver.
    const item: GmailThreadItem = {
      id: 'thread-reply-all',
      accountEmail: 'me@gmail.com',
      messages: [
        {
          id: 'rm1',
          threadId: 'thread-reply-all',
          labelIds: ['INBOX'],
          internalDate: '1704106800000',
          payload: {
            mimeType: 'text/plain',
            headers: [
              { name: 'From', value: 'Alice <alice@x.com>' },
              { name: 'To', value: 'me@gmail.com' },
              { name: 'Subject', value: 'Kickoff' },
              { name: 'Message-ID', value: '<rm1@x.com>' },
            ],
            body: { data: 'S2lja29mZiBhZ2VuZGEgYXR0YWNoZWQu', size: 24 },
          },
        },
        {
          id: 'rm2',
          threadId: 'thread-reply-all',
          labelIds: ['INBOX'],
          internalDate: '1704110400000',
          payload: {
            mimeType: 'text/plain',
            headers: [
              { name: 'From', value: 'Bob <bob@x.com>' },
              { name: 'To', value: 'me@gmail.com, Carol <carol@x.com>' },
              { name: 'Cc', value: 'dave@x.com' },
              { name: 'Reply-To', value: 'list@x.com' },
              { name: 'Subject', value: 'Re: Kickoff' },
              { name: 'Message-ID', value: '<rm2@x.com>' },
            ],
            body: { data: 'QWRkaW5nIENhcm9sIGFuZCBEYXZlIGhlcmUu', size: 27 },
          },
        },
      ],
    };

    const out = toDocument(item);
    const produced = (Array.isArray(out) ? out : [out]) as DocumentInput[];
    const thread = produced.find((d) => d.type === 'email.thread');
    expect(thread).toBeDefined();
    const asDocument = {
      id: 'd',
      accountId: 'a',
      ...thread,
    } as unknown as Document;

    const r = resolveGmailReply(asDocument, ['me@gmail.com'], true);
    expect(r.warnings).toEqual([]); // enriched — no fallback
    // Reply-To survives parse -> projection -> resolution and outranks From.
    expect(r.to).toEqual(['list@x.com', 'Carol <carol@x.com>']);
    expect(r.to).not.toContain('Bob <bob@x.com>');
    expect(r.to).not.toContain('me@gmail.com');
    expect(r.cc).toEqual(['dave@x.com']);
    expect(r.threading).toEqual({
      gmailThreadId: 'thread-reply-all',
      inReplyTo: '<rm2@x.com>',
      references: ['<rm1@x.com>', '<rm2@x.com>'],
    });
  });

  it('errors loudly on missing metadata and self-only threads', () => {
    expect(() =>
      resolveGmailReply(doc({ gmailThreadId: undefined }), SELF, false),
    ).toThrow(/missing thread metadata/);
    expect(() =>
      resolveGmailReply(
        doc({
          messages: [
            { id: '<m1@x>', from: 'me@gmail.com', date: 'D', snippet: 's' },
          ],
        }),
        SELF,
        false,
      ),
    ).toThrow(/only contains messages from you/);
  });
});
