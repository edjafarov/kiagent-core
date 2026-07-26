import type { Document } from '@shared/contracts';

import { resolveImapReply } from '../resolve';

function imapDoc(metadata: Record<string, unknown>): Document {
  return {
    id: 'doc-1',
    accountId: 'acc-1',
    externalId: 'INBOX:1:100',
    type: 'email.message',
    title: 'Quarterly numbers',
    markdown: 'body',
    metadata,
    createdAt: '2026-07-01T00:00:00Z',
    parentId: null,
    contentHash: 'h',
    seq: 1,
    archivedAt: null,
    languages: ['eng'],
    ingestedAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-01T00:00:00Z',
  } as unknown as Document;
}

const SELF = ['me@example.com'];

// Old-shape metadata (pre-enrichment): no cc/replyTo/references keys.
const OLD_META = {
  from: 'Alice Smith <alice@example.com>',
  to: ['me@example.com', 'Bob <bob@example.com>'],
  date: '2026-07-01T00:00:00Z',
  mailbox: 'INBOX',
  uid: 100,
  messageId: 'orig-123@mail.example.com',
};

// New-shape metadata (post-enrichment).
const NEW_META = {
  ...OLD_META,
  cc: ['Carol <carol@example.com>', 'me@example.com'],
  replyTo: 'Alice List <list@example.com>',
  references: ['root-1@mail.example.com'],
};

describe('resolveImapReply — inbound', () => {
  it('targets Reply-To when stored, with the full references chain', () => {
    const r = resolveImapReply(imapDoc(NEW_META), SELF, false);
    expect(r.to).toEqual(['Alice List <list@example.com>']);
    expect(r.cc).toEqual([]);
    expect(r.subject).toBe('Re: Quarterly numbers');
    expect(r.recipientDisplay).toBe('Alice List <list@example.com>');
    expect(r.threading).toEqual({
      inReplyTo: '<orig-123@mail.example.com>',
      references: ['<root-1@mail.example.com>', '<orig-123@mail.example.com>'],
    });
    expect(r.warnings).toEqual([]);
  });

  it('falls back to From when no Reply-To is stored', () => {
    const r = resolveImapReply(imapDoc(OLD_META), SELF, false);
    expect(r.to).toEqual(['Alice Smith <alice@example.com>']);
    expect(r.threading).toEqual({
      inReplyTo: '<orig-123@mail.example.com>',
      references: ['<orig-123@mail.example.com>'],
    });
  });

  it('reply_all with enriched metadata includes to+cc minus self, no cc warning', () => {
    const r = resolveImapReply(imapDoc(NEW_META), SELF, true);
    expect(r.to).toEqual([
      'Alice List <list@example.com>',
      'Bob <bob@example.com>',
      'Carol <carol@example.com>',
    ]);
    expect(r.warnings).toEqual([]);
  });

  it('reply_all on a pre-enrichment doc warns about unknown cc', () => {
    const r = resolveImapReply(imapDoc(OLD_META), SELF, true);
    expect(r.to).toEqual([
      'Alice Smith <alice@example.com>',
      'Bob <bob@example.com>',
    ]);
    expect(r.warnings.join(' ')).toMatch(/cc/i);
  });

  it('throws when both From and Reply-To are missing', () => {
    expect(() =>
      resolveImapReply(imapDoc({ ...OLD_META, from: null }), SELF, false),
    ).toThrow(/sender/i);
  });
});

describe('resolveImapReply — self-sent (Sent-folder docs)', () => {
  const SENT_META = {
    ...NEW_META,
    from: 'Me <me@example.com>',
    to: ['Alice Smith <alice@example.com>', 'Bob <bob@example.com>'],
    cc: ['Carol <carol@example.com>'],
    replyTo: null,
  };

  it('targets the original recipients, never the user', () => {
    const r = resolveImapReply(imapDoc(SENT_META), SELF, false);
    expect(r.to).toEqual([
      'Alice Smith <alice@example.com>',
      'Bob <bob@example.com>',
    ]);
    expect(r.recipientDisplay).toBe(
      'Alice Smith <alice@example.com>, Bob <bob@example.com>',
    );
    expect(r.warnings.join(' ')).toMatch(/you sent/i);
  });

  it('reply_all adds cc minus self', () => {
    const r = resolveImapReply(imapDoc(SENT_META), SELF, true);
    expect(r.to).toEqual([
      'Alice Smith <alice@example.com>',
      'Bob <bob@example.com>',
      'Carol <carol@example.com>',
    ]);
  });

  it('throws when the stored recipients are only the user', () => {
    expect(() =>
      resolveImapReply(
        imapDoc({ ...SENT_META, to: ['me@example.com'], cc: [] }),
        SELF,
        false,
      ),
    ).toThrow(/only you/i);
  });
});

describe('resolveImapReply — shared behavior', () => {
  it('does not double-prefix an existing Re:', () => {
    const doc = imapDoc(OLD_META);
    (doc as { title: string }).title = 'RE: Quarterly numbers';
    const r = resolveImapReply(doc, SELF, false);
    expect(r.subject).toBe('RE: Quarterly numbers');
  });

  it('warns when no Message-ID is stored', () => {
    const r = resolveImapReply(
      imapDoc({ ...OLD_META, messageId: null }),
      SELF,
      false,
    );
    expect(r.threading).toEqual({});
    expect(r.warnings.join(' ')).toMatch(/thread/i);
  });

  it('rejects non-email documents', () => {
    const doc = imapDoc(OLD_META);
    (doc as { type: string }).type = 'note';
    expect(() => resolveImapReply(doc, SELF, false)).toThrow(/email\.message/);
  });
});
