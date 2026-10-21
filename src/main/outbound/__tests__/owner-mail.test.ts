/** @jest-environment node */
import { renderEmailBody } from '../email-body';
import { createOwnerMail, encodedSizeBound } from '../owner-mail';

const account = {
  id: 'a1',
  source: 'gmail',
  identifier: 'Me@Gmail.com',
  config: {},
  status: 'idle',
} as never;

function setup(
  over: {
    listAddressedTo?: unknown;
    fetchAddressedAttachment?: unknown;
    now?: () => number;
  } = {},
) {
  const sent: unknown[] = [];
  const sender = {
    send: jest.fn(async (i: unknown) => {
      sent.push(i);
      return { externalMessageId: 'x', providerThreadId: 't' };
    }),
  };
  const om = createOwnerMail({
    account: async (id) => (id === 'a1' ? account : null),
    sources: {
      get: () =>
        ({
          listAddressedTo: over.listAddressedTo ?? (async () => []),
          fetchAddressedAttachment: over.fetchAddressedAttachment,
        }) as never,
    },
    senders: { get: () => sender, ids: () => ['gmail'] },
    session: () => ({}) as never,
    now: over.now,
  });
  return { om, sent, sender };
}

test('describe resolves owner and support', async () => {
  expect(await setup().om.describe('a1')).toEqual({
    ownerAddress: 'me@gmail.com',
    supported: true,
  });
  expect(await setup().om.describe('nope')).toBeNull();
});

test('sendToOwner pins recipient to owner and stamps channel fields', async () => {
  const { om, sent } = setup();
  const r = await om.sendToOwner('a1', {
    replyTo: 'me+kia@gmail.com',
    subject: 'Re: x',
    bodyText: 'hi',
    messageId: '<1@kia.local>',
    inReplyTo: '<q@x>',
    references: ['<q@x>'],
    providerThreadId: 't1',
  });
  expect(r).toEqual({ externalMessageId: 'x', providerThreadId: 't' });
  expect(sent[0]).toEqual({
    accountId: 'a1',
    kind: 'new',
    to: ['me@gmail.com'],
    subject: 'Re: x',
    bodyMarkdown: 'hi',
    bodyHtml: renderEmailBody('hi').html,
    replyTo: 'me+kia@gmail.com',
    messageId: '<1@kia.local>',
    ownerChannel: true,
    threading: {
      inReplyTo: '<q@x>',
      references: ['<q@x>'],
      gmailThreadId: 't1',
    },
  });
});

test('a display name rides along; the address stays the owner', async () => {
  const { om, sent } = setup();
  await om.sendToOwner('a1', {
    replyTo: 'me+kia@gmail.com',
    subject: 's',
    bodyText: 'b',
    fromName: 'Kia',
  });
  expect(sent[0]).toMatchObject({ fromName: 'Kia', to: ['me@gmail.com'] });
});

test.each([
  ['Kia <other@x.com>'],
  ['other@x.com'],
  ['Kia"'],
  ['Kia\r\nBcc: x@y'],
  [''],
  ['x'.repeat(41)],
])('rejects fromName %p', async (fromName) => {
  const { om, sender } = setup();
  await expect(
    om.sendToOwner('a1', {
      replyTo: 'me+kia@gmail.com',
      subject: 's',
      bodyText: 'b',
      fromName,
    }),
  ).rejects.toThrow(/fromName/);
  expect(sender.send).not.toHaveBeenCalled();
});

test('Kia may send as a plus-variant of the owner', async () => {
  const { om, sent } = setup();
  await om.sendToOwner('a1', {
    replyTo: 'me+kia@gmail.com',
    subject: 's',
    bodyText: 'b',
    fromAddress: 'Me+Kia@gmail.com',
  });
  expect(sent[0]).toMatchObject({
    fromAddress: 'me+kia@gmail.com',
    to: ['me@gmail.com'],
  });
});

test.each([
  ['other@gmail.com'],
  ['me@gmail.com'],
  ['me+kia@evil.com'],
  ['me+kia@gmail.com\r\nBcc: x@y'],
])('rejects fromAddress %p', async (fromAddress) => {
  const { om, sender } = setup();
  await expect(
    om.sendToOwner('a1', {
      replyTo: 'me+kia@gmail.com',
      subject: 's',
      bodyText: 'b',
      fromAddress,
    }),
  ).rejects.toThrow(/fromAddress/);
  expect(sender.send).not.toHaveBeenCalled();
});

test('native reply uses kind reply + outboundRef', async () => {
  const { om, sent } = setup();
  await om.sendToOwner('a1', {
    replyTo: 'me+kia@gmail.com',
    subject: 's',
    bodyText: 'b',
    replyToProviderId: 'AAMk',
  });
  expect(sent[0]).toMatchObject({
    kind: 'reply',
    outboundRef: { messageId: 'AAMk' },
    to: ['me@gmail.com'],
  });
});

test.each([
  ['other@gmail.com'],
  ['me+kia@evil.com'],
  ['me+kia@gmail.com\r\nBcc: x@y'],
  ['me+@gmail.com'],
  ['me@gmail.com'],
])('rejects replyTo %p', async (replyTo) => {
  await expect(
    setup().om.sendToOwner('a1', { replyTo, subject: 's', bodyText: 'b' }),
  ).rejects.toThrow(/replyTo/);
});

test('rejects CRLF subject and malformed ids', async () => {
  const { om, sender } = setup();
  await expect(
    om.sendToOwner('a1', {
      replyTo: 'me+kia@gmail.com',
      subject: 'a\nb',
      bodyText: '',
    }),
  ).rejects.toThrow(/subject/);
  await expect(
    om.sendToOwner('a1', {
      replyTo: 'me+kia@gmail.com',
      subject: 's',
      bodyText: '',
      inReplyTo: 'nope',
    }),
  ).rejects.toThrow(/id/);
  expect(sender.send).not.toHaveBeenCalled();
});

test('caps 60 sends per hour per account', async () => {
  let t = 0;
  const { om } = setup({ now: () => t });
  const m = { replyTo: 'me+kia@gmail.com', subject: 's', bodyText: 'b' };
  for (let i = 0; i < 60; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await om.sendToOwner('a1', m);
  }
  await expect(om.sendToOwner('a1', m)).rejects.toThrow(/rate/);
  t = 3_600_001;
  await expect(om.sendToOwner('a1', m)).resolves.toBeDefined();
});

test('listAddressedTo delegates to the source with a session', async () => {
  const list = jest.fn(async () => [{ providerId: 'p' }]);
  const { om } = setup({ listAddressedTo: list });
  expect(
    await om.listAddressedTo('a1', { toAddress: 'me+kia@gmail.com', since: 0 }),
  ).toEqual([{ providerId: 'p' }]);
  expect(list).toHaveBeenCalled();
});

describe('fetchAttachment', () => {
  test('returns bytes of a sent message part, passing the cap to the source', async () => {
    const fetchAddressedAttachment = jest.fn(
      async () => new Uint8Array([1, 2, 3]),
    );
    const { om } = setup({ fetchAddressedAttachment });
    expect(await om.fetchAttachment('a1', 'm1', '2')).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    expect(fetchAddressedAttachment).toHaveBeenCalledWith(
      expect.anything(),
      'm1',
      '2',
      {
        maxBytes: 25 * 1024 * 1024,
      },
    );
  });

  test('refuses a message not in Sent', async () => {
    const { om } = setup({
      fetchAddressedAttachment: async () => {
        throw new Error('gmail: not a sent message');
      },
    });
    await expect(om.fetchAttachment('a1', 'm1', '2')).rejects.toThrow(
      'ownerMail: not an owner message',
    );
  });

  test('caps at 25 MB', async () => {
    const big = { length: 25 * 1024 * 1024 + 1 } as unknown as Uint8Array;
    const { om } = setup({ fetchAddressedAttachment: async () => big });
    await expect(om.fetchAttachment('a1', 'm1', '2')).rejects.toThrow(
      'ownerMail: attachment too large',
    );
  });

  test('maps a missing part to a stable error', async () => {
    const { om } = setup({
      fetchAddressedAttachment: async () => {
        throw new Error('gmail: no such attachment');
      },
    });
    await expect(om.fetchAttachment('a1', 'm1', 'x')).rejects.toThrow(
      'ownerMail: no such attachment',
    );
  });

  test('throws when the source cannot fetch attachments', async () => {
    const { om } = setup();
    await expect(om.fetchAttachment('a1', 'm1', '2')).rejects.toThrow(
      'ownerMail: source cannot fetch attachments',
    );
  });
});

describe('sendToOwner attachments', () => {
  const base = { replyTo: 'me+kia@gmail.com', subject: 's', bodyText: 'b' };
  const file = (
    filename: string,
    mime = 'application/pdf',
    bytes = new Uint8Array([1, 2]),
  ) => ({
    filename,
    mime,
    bytes,
  });

  test('rides along base64-encoded with sanitised names and mimes', async () => {
    const { om, sent } = setup();
    await om.sendToOwner('a1', {
      ...base,
      attachments: [
        file('../../etc/Vertrag\r\n.pdf'),
        file('a.bin', 'not a mime'),
        file('b.x', 'application/x-unknown'),
      ],
    });
    expect((sent[0] as { attachments: unknown }).attachments).toEqual([
      {
        filename: 'Vertrag.pdf',
        mime: 'application/pdf',
        contentBase64: 'AQI=',
      },
      {
        filename: 'a.bin',
        mime: 'application/octet-stream',
        contentBase64: 'AQI=',
      },
      {
        filename: 'b.x',
        mime: 'application/octet-stream',
        contentBase64: 'AQI=',
      },
    ]);
  });

  test('rejects more than 10 attachments', async () => {
    const { om, sender } = setup();
    await expect(
      om.sendToOwner('a1', {
        ...base,
        attachments: Array.from({ length: 11 }, (_, i) => file(`${i}.pdf`)),
      }),
    ).rejects.toThrow('ownerMail: at most 10 attachments');
    expect(sender.send).not.toHaveBeenCalled();
  });

  test('rejects an encoded total over 24 MiB', async () => {
    const { om, sender } = setup();
    const big = new Uint8Array(19 * 1024 * 1024); // 19 MiB → ~25.3 MiB base64
    await expect(
      om.sendToOwner('a1', {
        ...base,
        attachments: [file('big.pdf', 'application/pdf', big)],
      }),
    ).rejects.toThrow('ownerMail: message too large');
    expect(sender.send).not.toHaveBeenCalled();
  });

  test('bounds the whole MIME message, not just the base64', async () => {
    // 18 MiB composes to ~25.8 MB with MIME line breaks: over the cap.
    expect(encodedSizeBound(100, [18 * 1024 * 1024])).toBeGreaterThan(
      24 * 1024 * 1024,
    );
    const { om, sender } = setup();
    await expect(
      om.sendToOwner('a1', {
        ...base,
        attachments: [
          file('b.pdf', 'application/pdf', new Uint8Array(18 * 1024 * 1024)),
        ],
      }),
    ).rejects.toThrow('ownerMail: message too large');
    expect(sender.send).not.toHaveBeenCalled();
  });

  test('no attachments key without files', async () => {
    const { om, sent } = setup();
    await om.sendToOwner('a1', base);
    expect(sent[0]).not.toHaveProperty('attachments');
  });
});
