import type {
  AddressedMail,
  AddressedQuery,
  SendIntent,
  SendResult,
  Source,
} from '../contracts';

test('email-channel contract fields exist', () => {
  const q: AddressedQuery = {
    toAddress: 'a+kia@x.com',
    since: 1,
    auditSince: 2,
  };
  const m: AddressedMail = {
    providerId: 'p',
    messageId: '<m@x>',
    references: [],
    sent: true,
    from: 'a@x.com',
    subject: 's',
    date: 0,
    to: ['a+kia@x.com'],
    cc: [],
    text: '',
    ownChannel: false,
    automated: false,
  };
  const i: SendIntent = {
    accountId: 'a',
    kind: 'new',
    bodyMarkdown: 'b',
    replyTo: 'a+kia@x.com',
    messageId: '<1@x>',
    ownerChannel: true,
  };
  const r: SendResult = { providerThreadId: 't' };
  const hook: Source<unknown, unknown>['listAddressedTo'] = async () => [m];
  expect([q, m, i, r, hook].length).toBe(5);
});
