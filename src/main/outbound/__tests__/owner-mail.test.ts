/** @jest-environment node */
import { createOwnerMail } from '../owner-mail';

const account = {
  id: 'a1',
  source: 'gmail',
  identifier: 'Me@Gmail.com',
  config: {},
  status: 'idle',
} as never;

function setup(over: { listAddressedTo?: unknown; now?: () => number } = {}) {
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
