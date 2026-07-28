import type { Account } from '@shared/contracts';

import { selfAddressesFor, senderAddressFor } from '../identity';

function account(
  config: Record<string, unknown>,
  over: Partial<Account> = {},
): Account {
  return {
    id: 'a1',
    source: 'imap',
    identifier: 'me@example.com@imap.example.com',
    config,
    status: 'live',
    cursor: null,
    createdAt: '2026-07-01T00:00:00Z',
    ...over,
  } as unknown as Account;
}

describe('senderAddressFor', () => {
  it('uses config.user when it is an email', () => {
    expect(senderAddressFor(account({ user: 'me@example.com' }))).toBe(
      'me@example.com',
    );
  });

  it('prefers an explicit outbound.fromAddress', () => {
    expect(
      senderAddressFor(
        account({
          user: 'me@example.com',
          outbound: { fromAddress: 'eldar@example.com' },
        }),
      ),
    ).toBe('eldar@example.com');
  });

  it('never falls back to the identifier', () => {
    expect(() => senderAddressFor(account({ user: 'plainlogin' }))).toThrow(
      /From address/i,
    );
  });

  it('refuses non-email sources outright — compose is email-only', () => {
    // An extension-sender source (slack) can REPLY (its target comes from
    // the document's metadata.outbound), but it has no From address to
    // compose from — and must say so instead of falling through to the
    // config-shaped "no usable From address" advice, which no amount of
    // account configuration could satisfy.
    expect(() =>
      senderAddressFor(account({}, { source: 'slack', identifier: 'T123:me' })),
    ).toThrow(/email-only/);
  });
});

describe('selfAddressesFor', () => {
  it('returns sender + user without duplicates', () => {
    expect(
      selfAddressesFor(
        account({
          user: 'me@example.com',
          outbound: { fromAddress: 'eldar@example.com' },
        }),
      ),
    ).toEqual(['eldar@example.com', 'me@example.com']);
    expect(selfAddressesFor(account({ user: 'me@example.com' }))).toEqual([
      'me@example.com',
    ]);
  });
});

describe('gmail identity', () => {
  it('gmail accounts send as their identifier', () => {
    const acc = {
      id: 'g1',
      source: 'gmail',
      identifier: 'me@gmail.com',
      config: {},
    } as unknown as Account;
    expect(senderAddressFor(acc)).toBe('me@gmail.com');
    expect(selfAddressesFor(acc)).toEqual(['me@gmail.com']);
  });
});
