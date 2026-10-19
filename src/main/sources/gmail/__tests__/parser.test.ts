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
  it('captures author evidence before signature cleaning', () => {
    const parsed = parseGmailMessage({
      id: 'evidence-id',
      threadId: 'thread1',
      internalDate: '1704106800000',
      payload: {
        mimeType: 'text/plain',
        headers: [
          { name: 'From', value: 'Alex Example <alex@example.com>' },
          { name: 'Message-ID', value: '<evidence@example.com>' },
        ],
        body: {
          data: Buffer.from('Ready.\n\n--\nAlex Example\nProcurement').toString(
            'base64url',
          ),
        },
      },
    });
    expect(parsed.body).toBe('Ready.');
    expect(parsed.evidence.author).toBe('alex@example.com');
    expect(parsed.evidence.signature).toContain('Procurement');
  });

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

describe('parseGmailMessage HTML-only body', () => {
  function htmlOnly(html: string): GmailApiMessage {
    return {
      id: 'html-only',
      threadId: 'thread-html',
      internalDate: '1704106800000',
      payload: {
        mimeType: 'text/html',
        headers: [
          { name: 'From', value: 'Shop <noreply@shop.example>' },
          { name: 'Message-ID', value: '<html-only@shop.example>' },
        ],
        body: { data: Buffer.from(html).toString('base64url') },
      },
    };
  }

  it('turns a message with only an HTML part into body text', () => {
    const parsed = parseGmailMessage(
      htmlOnly(
        '<html><head><style>.x{color:red}</style></head><body>' +
          '<h1>Your parcel is on its way</h1><p>Order <b>DE5Y46</b> ships today.</p>' +
          '</body></html>',
      ),
    );
    expect(parsed.body).toContain('Your parcel is on its way');
    expect(parsed.body).toContain('DE5Y46');
    expect(parsed.body).not.toContain('color:red');
  });

  it('keeps image alt text but drops tracking pixels and image URLs', () => {
    const parsed = parseGmailMessage(
      htmlOnly(
        '<p><img src="https://cdn.shop.example/logo.png" alt="Shop logo">' +
          'Thanks for your order.</p>' +
          '<img src="https://track.shop.example/open.gif" width="1" height="1">',
      ),
    );
    expect(parsed.body).toContain('Thanks for your order.');
    expect(parsed.body).toContain('Shop logo');
    expect(parsed.body).not.toContain('track.shop.example');
    expect(parsed.body).not.toContain('cdn.shop.example');
  });
});
