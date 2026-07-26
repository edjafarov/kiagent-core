/**
 * @jest-environment node
 *
 * nodemailer's MimeNode.build() relies on Node's setImmediate, which the
 * default jsdom test environment does not provide (see smtp.test.ts).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { AccountId, Credentials } from '@shared/contracts';

import { openDb } from '../../../db/app-db';
import { openStore, type CoreStore } from '../../../core/store/store';
import { createGmailSender } from '../gmail';
import { buildBundledSenders } from '../index';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};

function okJson(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: () => null },
  };
}

function errJson(status: number, body: unknown) {
  return {
    ok: false,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: () => null },
  };
}

describe('gmail sender', () => {
  let dir: string;
  let store: CoreStore;
  let accountId: AccountId;
  let fetchMock: jest.Mock;

  const futureIso = () => new Date(Date.now() + 3600_000).toISOString();
  const pastIso = () => new Date(Date.now() - 3600_000).toISOString();

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-gmail-snd-'));
    store = openStore(await openDb(path.join(dir, 'test.db')), deps);
    const account = await store.createAccount({
      source: 'gmail',
      identifier: 'me@gmail.com',
      config: {},
    });
    accountId = account.id;
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  const intent = () => ({
    accountId,
    kind: 'reply' as const,
    to: ['bob@example.com'],
    cc: ['carol@example.com'],
    subject: 'Re: Numbers',
    bodyMarkdown: 'Thanks!',
    threading: {
      gmailThreadId: 't123',
      inReplyTo: '<orig@x>',
      references: ['<orig@x>'],
    },
  });

  it('1. happy path: sends via users.messages.send with the stored thread id', async () => {
    await store.vault.save(accountId, {
      accessToken: 'tok-1',
      expiresAt: futureIso(),
      scope:
        'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send',
    });
    fetchMock = jest.fn(async () => okJson({ id: 'm9', threadId: 't123' }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const sender = createGmailSender({ store });
    const result = await sender.send(intent());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
    );
    expect(init.headers.Authorization).toBe('Bearer tok-1');
    const body = JSON.parse(init.body);
    expect(body.threadId).toBe('t123');
    const rfc822 = Buffer.from(body.raw, 'base64url').toString('utf8');
    expect(rfc822).toContain('bob@example.com');
    expect(rfc822).toContain('In-Reply-To: <orig@x>');
    expect(result.externalMessageId).toBe('m9');
  });

  it('2. expired creds trigger the injected refresher once, and the fresh token is both saved to the vault and used for the send', async () => {
    await store.vault.save(accountId, {
      accessToken: 'stale-tok',
      refreshToken: 'refresh-1',
      expiresAt: pastIso(),
      scope: 'https://www.googleapis.com/auth/gmail.send',
    });
    const fresh: Credentials = {
      accessToken: 'fresh-tok',
      refreshToken: 'refresh-1',
      expiresAt: futureIso(),
      scope: 'https://www.googleapis.com/auth/gmail.send',
    };
    const refresher = jest.fn(async () => fresh);
    fetchMock = jest.fn(async () => okJson({ id: 'm9', threadId: 't123' }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const sender = createGmailSender({ store, refresher });
    await sender.send(intent());

    expect(refresher).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer fresh-tok');
    const saved = await store.vault.load(accountId);
    expect(saved?.accessToken).toBe('fresh-tok');
  });

  it('3. scope present WITHOUT gmail.send rejects with a reconnect message and never calls fetch', async () => {
    await store.vault.save(accountId, {
      accessToken: 'tok-1',
      expiresAt: futureIso(),
      scope: 'https://www.googleapis.com/auth/gmail.readonly',
    });
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const sender = createGmailSender({ store });
    await expect(sender.send(intent())).rejects.toThrow(/reconnect/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('4. an API 403 ACCESS_TOKEN_SCOPE_INSUFFICIENT response rejects with a reconnect message', async () => {
    await store.vault.save(accountId, {
      accessToken: 'tok-1',
      expiresAt: futureIso(),
      scope: 'https://www.googleapis.com/auth/gmail.send',
    });
    fetchMock = jest.fn(async () =>
      errJson(403, {
        error: {
          status: 'PERMISSION_DENIED',
          message: 'Request had insufficient authentication scopes.',
          details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }],
        },
      }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const sender = createGmailSender({ store });
    await expect(sender.send(intent())).rejects.toThrow(/reconnect/);
  });
});

describe('bundled senders (phase 5: gmail joins imap)', () => {
  it('5. buildBundledSenders keys include both imap and gmail', async () => {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-snd2-'));
    const store2 = openStore(await openDb(path.join(dir2, 't.db')), deps);
    try {
      const senders = buildBundledSenders({
        store: store2,
        logSink: { log: () => {} },
      });
      expect([...senders.keys()]).toEqual(['imap', 'gmail']);
    } finally {
      await store2.close();
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });
});
