import type { Account } from '@shared/contracts';

import { selfAddressesFor, senderAddressFor } from '../identity';

function account(config: Record<string, unknown>): Account {
  return {
    id: 'a1',
    source: 'imap',
    identifier: 'me@example.com@imap.example.com',
    config,
    status: 'live',
    cursor: null,
    createdAt: '2026-07-01T00:00:00Z',
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
