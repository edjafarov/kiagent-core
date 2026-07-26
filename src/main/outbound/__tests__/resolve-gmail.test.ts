import type { Document } from '@shared/contracts';

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
