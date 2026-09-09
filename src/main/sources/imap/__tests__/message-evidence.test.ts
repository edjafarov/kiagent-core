/** @jest-environment node */
import type { Account, AccountId, Document, Session } from '@shared/contracts';

import { createImapSource } from '../source';
import type { ImapClient } from '../types';

function session(): Session {
  const account: Account = {
    id: 'imap-account' as AccountId,
    source: 'imap',
    identifier: 'owner@example.com',
    config: {
      host: 'imap.example.com',
      port: 993,
      secure: true,
      user: 'owner@example.com',
    },
    status: 'live',
    cursor: null,
    createdAt: new Date(0).toISOString(),
  };
  return {
    account,
    signal: new AbortController().signal,
    async credentials() {
      return { password: 'fixture-password' };
    },
    log: () => {},
  };
}

function document(externalId = 'INBOX:7:42'): Document {
  return {
    id: 'doc-1' as never,
    accountId: 'imap-account' as AccountId,
    externalId,
    type: 'email.message',
    title: 'Fixture',
    markdown: null,
    metadata: { mailbox: 'INBOX', uid: 42 },
    createdAt: null,
    contentHash: 'hash-1',
    seq: 1,
    archivedAt: null,
    languages: [],
    ingestedAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    parentId: null,
    scopeRootId: null,
  };
}

function raw(uid: number, from: string, body: string): Buffer {
  return Buffer.from(
    [
      `From: ${from}`,
      'To: owner@example.com',
      'Subject: Fixture',
      `Message-ID: <message-${uid}@example.com>`,
      'Date: Wed, 01 Jan 2025 12:00:00 +0000',
      '',
      body,
    ].join('\r\n'),
  );
}

function fakeClient(
  uidValidity: number,
  source: Buffer,
): { client: ImapClient; state: { fetches: number; closed: number } } {
  const state = { fetches: 0, closed: 0 };
  const client: ImapClient = {
    async listFolders() {
      return [{ path: 'INBOX', flags: [] }];
    },
    async status() {
      return { uidValidity, uidNext: 43, exists: 1 };
    },
    async listUids() {
      return [42];
    },
    async fetchMany(_path, uids) {
      state.fetches += 1;
      return uids.includes(42) ? [{ uid: 42, source }] : [];
    },
    async append() {},
    async close() {
      state.closed += 1;
    },
  };
  return { client, state };
}

describe('imap readMessageEvidence', () => {
  it('reads only the document UID, filters the normalized author, and does not use the sync cursor', async () => {
    const fake = fakeClient(
      7,
      raw(
        42,
        'Alex Example <Alex@Example.com>',
        'Hello\n--\nAlex\nProcurement',
      ),
    );
    const source = createImapSource({ connect: async () => fake.client });
    const rows = await source.readMessageEvidence!(session(), document(), {
      authors: [' alex@example.com '],
      limit: 3,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      author: 'alex@example.com',
      messageKey: 'message-42@example.com',
    });
    expect(fake.state.fetches).toBe(1);
    expect(fake.state.closed).toBe(1);
    expect(session().account.cursor).toBeNull();
  });

  it('returns no rows when the stored UIDVALIDITY no longer matches', async () => {
    const fake = fakeClient(8, raw(42, 'alex@example.com', 'stale'));
    const source = createImapSource({ connect: async () => fake.client });
    await expect(
      source.readMessageEvidence!(session(), document('INBOX:7:42'), {
        authors: ['alex@example.com'],
        limit: 3,
      }),
    ).resolves.toEqual([]);
    expect(fake.state.fetches).toBe(0);
    expect(fake.state.closed).toBe(1);
  });
});
