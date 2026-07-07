import type { DocumentInput } from '@shared/contracts';
import fixtureThread from './fixtures/thread.json';
import {
  toDocument,
  buildThreadUrl,
  GMAIL_THREAD_DOCUMENT_TYPE,
  type GmailThreadItem,
} from '../to-document';
import type { GmailApiMessage } from '../parser';

const ACCOUNT_EMAIL = 'owner@example.com';

function itemFromFixture(): GmailThreadItem {
  return {
    id: fixtureThread.id,
    messages: fixtureThread.messages as unknown as GmailApiMessage[],
    accountEmail: ACCOUNT_EMAIL,
  };
}

describe('toDocument (gmail thread -> DocumentInput)', () => {
  it('maps a fixture thread to a DocumentInput matching legacy conventions', () => {
    const out = toDocument(itemFromFixture());
    expect(out).not.toBeNull();
    const out_array = Array.isArray(out) ? out : [out];
    const d = out_array[0] as DocumentInput;

    expect(d.externalId).toBe('18abc0000000001');
    expect(d.type).toBe(GMAIL_THREAD_DOCUMENT_TYPE);
    expect(d.type).toBe('email.thread');
    expect(d.title).toBe('Sync time tomorrow?');

    const expectedUrl = buildThreadUrl(ACCOUNT_EMAIL, '18abc0000000001');
    expect(d.url).toBe(expectedUrl);
    expect(d.url).toContain('authuser=owner%40example.com');
    expect(d.url).toContain('#all/18abc0000000001');

    // createdAt is the LAST message's date (task-specified; deviates from
    // legacy, which used the first message's date — see report).
    expect(d.createdAt).toBe(new Date(1704110400000).toISOString());
  });

  it('renders sender/date headers and reply-parsed bodies in the markdown', () => {
    const out = toDocument(itemFromFixture());
    const out_array = Array.isArray(out) ? out : [out];
    const d = out_array[0] as DocumentInput;
    expect(d.markdown).toContain('# Sync time tomorrow?');
    expect(d.markdown).toContain('> Thread: 2 messages ·');
    expect(d.markdown).toContain(
      `> Open in Gmail: ${buildThreadUrl(ACCOUNT_EMAIL, '18abc0000000001')}`,
    );

    expect(d.markdown).toContain('## 1 — Alice <alice@example.com> ·');
    expect(d.markdown).toContain('Hi team,');
    expect(d.markdown).toContain('Can we move the sync to 3pm tomorrow?');

    expect(d.markdown).toContain('## 2 — Bob <bob@example.com> ·');
    expect(d.markdown).toContain('Works for me.');
    // Quoted reply text must be stripped from message 2's body.
    const secondMessageSection = d.markdown!.split('## 2')[1];
    expect(secondMessageSection).not.toContain(
      'Can we move the sync to 3pm tomorrow?',
    );

    // Attachment filename surfaced inline (no byte fetch / child doc in this port).
    expect(d.markdown).toContain('[Attachment: agenda.pdf]');
  });

  it('builds metadata matching legacy fields (from/to/labels/messageCount/...)', () => {
    const out = toDocument(itemFromFixture());
    const out_array = Array.isArray(out) ? out : [out];
    const d = out_array[0] as DocumentInput;
    expect(d.metadata.gmailThreadId).toBe('18abc0000000001');
    expect(d.metadata.from).toBe('Alice <alice@example.com>');
    expect(d.metadata.to).toEqual([
      'Bob <bob@example.com>',
      'Carol <carol@example.com>',
    ]);
    expect(d.metadata.cc).toEqual([]);
    expect(d.metadata.labels).toEqual([
      'INBOX',
      'IMPORTANT',
      'CATEGORY_PERSONAL',
    ]);
    expect(d.metadata.messageCount).toBe(2);
    expect(d.metadata.participants).toEqual([
      'Alice <alice@example.com>',
      'Bob <bob@example.com>',
      'Carol <carol@example.com>',
    ]);
    expect(d.metadata.firstMessageAt).toBe(
      new Date(1704106800000).toISOString(),
    );
    expect(d.metadata.lastMessageAt).toBe(
      new Date(1704110400000).toISOString(),
    );
    const messages = d.metadata.messages as Array<{
      id: string;
      from: string;
      date: string;
      snippet: string;
    }>;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      id: '<msg1@example.com>',
      from: 'Alice <alice@example.com>',
    });
    expect(messages[1]).toMatchObject({
      id: '<msg2@example.com>',
      from: 'Bob <bob@example.com>',
    });
    expect(messages[1].snippet).toContain('Works for me.');
  });

  it('returns null for an empty thread (no messages)', () => {
    const doc = toDocument({
      id: 'empty-thread',
      messages: [],
      accountEmail: ACCOUNT_EMAIL,
    });
    expect(doc).toBeNull();
  });

  it('emits attachment child documents keyed by messageId/partId', () => {
    const item: GmailThreadItem = {
      id: 'thread-with-atts',
      accountEmail: ACCOUNT_EMAIL,
      messages: [
        {
          id: 'm1',
          threadId: 'thread-with-atts',
          labelIds: ['INBOX'],
          internalDate: '1704106800000',
          payload: {
            mimeType: 'multipart/mixed',
            headers: [
              { name: 'From', value: 'sender@example.com' },
              { name: 'To', value: 'recipient@example.com' },
              { name: 'Subject', value: 'Email with attachments' },
              { name: 'Date', value: 'Mon, 1 Jan 2024 10:00:00 -0800' },
              { name: 'Message-ID', value: '<m1@example.com>' },
            ],
            parts: [
              {
                partId: '0',
                mimeType: 'text/plain',
                body: { data: 'SGVsbG8gd29ybGQ=', size: 12 },
              },
              {
                partId: '2',
                mimeType: 'application/pdf',
                filename: 'scan.pdf',
                headers: [
                  {
                    name: 'Content-Disposition',
                    value: 'attachment; filename="scan.pdf"',
                  },
                ],
                body: { attachmentId: 'AAA', size: 50_000 },
              },
              {
                partId: '3',
                mimeType: 'image/png',
                filename: 'sig.png',
                headers: [
                  {
                    name: 'Content-Disposition',
                    value: 'attachment; filename="sig.png"',
                  },
                ],
                body: { attachmentId: 'BBB', size: 900 },
              },
            ],
          },
        },
      ],
    };
    const out = toDocument(item);
    expect(Array.isArray(out)).toBe(true);
    const docs = out as unknown as DocumentInput[];
    const atts = docs.filter((d) => d.type === 'attachment');
    expect(atts).toHaveLength(1); // tiny image skipped as decorative
    expect(atts[0].externalId).toBe('m1/2');
    expect(atts[0].markdown).toBeNull();
    expect(atts[0].parent).toEqual({
      externalId: item.id,
      type: 'email.thread',
    });
    expect(atts[0].metadata).toMatchObject({
      mime: 'application/pdf',
      filename: 'scan.pdf',
      sizeBytes: 50_000,
      messageId: 'm1',
      partId: '2',
      attachmentId: 'AAA',
    });
  });
});
