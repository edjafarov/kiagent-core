/**
 * @jest-environment node
 *
 * mailparser's simple-parser relies on Node's setImmediate, which the
 * default jsdom test environment does not provide.
 */
import { parseImapMessage } from '../parse';
import type { ImapRawMessage } from '../types';

function rawMessage(uid: number, source: string): ImapRawMessage {
  return { uid, source: Buffer.from(source, 'utf8') };
}

const REPLY_MESSAGE = [
  'From: Alice <alice@example.com>',
  'To: Bob <bob@example.com>, carol@example.com',
  'Subject: Re: Hello there',
  'Message-ID: <abc123@mail.example.com>',
  'Date: Wed, 01 Jan 2025 12:00:00 +0000',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Hi Bob,',
  '',
  'This is the reply body.',
  '',
  'On Tue, Dec 31, 2024 at 10:00 AM Bob <bob@example.com> wrote:',
  '> original message text',
  '> more quoted text',
  '',
].join('\r\n');

describe('parseImapMessage', () => {
  it('extracts envelope fields, strips angle brackets from Message-ID, and cleans the body', async () => {
    const item = await parseImapMessage(
      rawMessage(42, REPLY_MESSAGE),
      'INBOX',
      111222,
    );

    expect(item.mailbox).toBe('INBOX');
    expect(item.uid).toBe(42);
    expect(item.uidValidity).toBe('111222');
    expect(item.messageId).toBe('abc123@mail.example.com');
    expect(item.subject).toBe('Re: Hello there');
    expect(item.from).toBe('Alice <alice@example.com>');
    expect(item.to).toEqual(['Bob <bob@example.com>', 'carol@example.com']);
    expect(item.date).toBe(new Date('2025-01-01T12:00:00.000Z').toISOString());
    expect(item.bodyText).toContain('This is the reply body.');
    expect(item.bodyText).not.toContain('original message text');
    expect(item.headers['content-type']).toContain('text/plain');
  });

  it('falls back to a synthetic null messageId-less item when the header is absent', async () => {
    const noMsgId = REPLY_MESSAGE.replace(/^Message-ID:.*\r\n/m, '');
    const item = await parseImapMessage(rawMessage(1, noMsgId), 'INBOX', 1);
    expect(item.messageId).toBeNull();
  });

  it('defaults subject/from/date fields sanely on a minimal message', async () => {
    const minimal = [
      'From: a@example.com',
      'To: b@example.com',
      '',
      'just a body',
    ].join('\r\n');
    const item = await parseImapMessage(rawMessage(1, minimal), 'INBOX', 1);
    expect(item.subject).toBeNull();
    expect(item.date).toBeNull();
    expect(item.bodyText).toBe('just a body');
  });
});
