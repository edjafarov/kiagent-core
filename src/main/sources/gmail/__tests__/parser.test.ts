import { parseGmailMessage, type GmailApiMessage } from '../parser';

/** Minimal header-only message fixture — no body parts, so the parser's
 *  body path stays out of these address-list assertions. */
function messageWithHeaders(
  headers: { name: string; value: string }[],
): GmailApiMessage {
  return {
    id: 'm1',
    threadId: 'thread1',
    labelIds: ['INBOX'],
    internalDate: '1704106800000',
    payload: {
      mimeType: 'multipart/alternative',
      headers: [
        { name: 'From', value: 'Alice <alice@example.com>' },
        { name: 'Subject', value: 'Address list parsing' },
        { name: 'Message-ID', value: '<m1@example.com>' },
        ...headers,
      ],
    },
  };
}

describe('parseGmailMessage address lists', () => {
  it('splits address lists on top-level commas only', () => {
    const parsed = parseGmailMessage(
      messageWithHeaders([
        { name: 'To', value: '"Doe, Jane" <jane@x.com>, Bob <bob@x.com>' },
        { name: 'Cc', value: '"Roe, Rita" <rita@x.com>, Carol <carol@x.com>' },
      ]),
    );
    expect(parsed.to).toEqual(['"Doe, Jane" <jane@x.com>', 'Bob <bob@x.com>']);
    expect(parsed.cc).toEqual([
      '"Roe, Rita" <rita@x.com>',
      'Carol <carol@x.com>',
    ]);
  });

  // A malformed header with an odd number of quotes must NOT merge the
  // remaining recipients into one entry: the reply path resolves an address
  // by taking the first <...> in an entry, so a merged entry whose first
  // bracketed address is the user's own gets self-filtered and silently
  // drops the co-recipient. Falling back to the naive split keeps one
  // recipient per entry, exactly as before the quote-aware change.
  it('falls back to a plain comma split when quotes are unbalanced', () => {
    const parsed = parseGmailMessage(
      messageWithHeaders([
        { name: 'To', value: 'Bob "smith <bob@x.com>, Carol <c@x.com>' },
      ]),
    );
    expect(parsed.to).toEqual(['Bob "smith <bob@x.com>', 'Carol <c@x.com>']);
  });

  it('leaves comma-free display names unchanged', () => {
    const parsed = parseGmailMessage(
      messageWithHeaders([
        {
          name: 'To',
          value: 'Bob <bob@example.com>, Carol <carol@example.com>',
        },
        { name: 'Cc', value: 'dave@example.com' },
      ]),
    );
    expect(parsed.to).toEqual([
      'Bob <bob@example.com>',
      'Carol <carol@example.com>',
    ]);
    expect(parsed.cc).toEqual(['dave@example.com']);
  });

  it('returns empty arrays when To/Cc are absent', () => {
    const parsed = parseGmailMessage(messageWithHeaders([]));
    expect(parsed.to).toEqual([]);
    expect(parsed.cc).toEqual([]);
  });
});
