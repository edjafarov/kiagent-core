/**
 * @jest-environment node
 *
 * nodemailer's MimeNode.build() relies on Node's setImmediate, which the
 * default jsdom test environment does not provide (same reason
 * src/main/sources/imap/__tests__/parse.test.ts opts into node for
 * mailparser).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { AccountId } from '@shared/contracts';

import { openDb } from '../../../db/app-db';
import { openStore, type CoreStore } from '../../../core/store/store';
import { createSmtpSender, deriveSmtpConfig } from '../smtp';
import { buildBundledSenders } from '../index';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};

describe('deriveSmtpConfig', () => {
  const imap = {
    host: 'imap.fastmail.com',
    port: 993,
    secure: true,
    user: 'u',
  };
  it('maps the imap. prefix to smtp. with submission defaults', () => {
    expect(deriveSmtpConfig(imap)).toEqual({
      host: 'smtp.fastmail.com',
      port: 465,
      secure: true,
    });
  });
  it('passes non-imap-prefixed hosts through', () => {
    expect(deriveSmtpConfig({ ...imap, host: 'mail.example.org' }).host).toBe(
      'mail.example.org',
    );
  });
  it('overrides win field-by-field', () => {
    expect(
      deriveSmtpConfig(imap, {
        host: 'send.fastmail.com',
        port: 587,
        secure: false,
      }),
    ).toEqual({ host: 'send.fastmail.com', port: 587, secure: false });
  });
});

describe('smtp sender', () => {
  let dir: string;
  let store: CoreStore;
  let accountId: AccountId;
  let sendMail: jest.Mock;
  let createTransport: jest.Mock;
  let appended: Array<{ path: string; content: Buffer }>;

  const fakeImapClient = () => ({
    listFolders: async () => [
      { path: 'INBOX', flags: [] },
      { path: 'Sent', specialUse: '\\Sent', flags: [] },
    ],
    status: async () => ({ uidValidity: 1, uidNext: 1, exists: 0 }),
    listUids: async () => [],
    fetchMany: async () => [],
    append: async (p: string, c: Buffer) => {
      appended.push({ path: p, content: c });
    },
    close: async () => {},
  });

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-smtp-'));
    store = openStore(await openDb(path.join(dir, 'test.db')), deps);
    const account = await store.createAccount({
      source: 'imap',
      // Realistic identifier shape: `${user}@${host}` — NOT an address; the
      // sender must derive From/envelope from config.user instead.
      identifier: 'me@example.com@imap.example.com',
      config: {
        host: 'imap.example.com',
        port: 993,
        secure: true,
        user: 'me@example.com',
      },
    });
    accountId = account.id;
    await store.vault.save(accountId, { password: 'hunter2' });
    sendMail = jest.fn(async () => ({}));
    createTransport = jest.fn((_opts: unknown) => ({ sendMail }));
    appended = [];
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const sender = () =>
    createSmtpSender({
      store,
      createTransport,
      connectImap: (async () => fakeImapClient()) as never,
    });

  // A function, not a plain object: `accountId` isn't assigned until
  // `beforeEach` runs, so a describe-scope object literal here would
  // capture `undefined` forever (and TS's TS2454 correctly flags reading
  // `accountId` before it's assigned in this scope).
  const intent = () => ({
    accountId,
    kind: 'reply' as const,
    to: ['Alice <alice@example.com>'],
    cc: [],
    subject: 'Re: Numbers',
    bodyMarkdown: 'Thanks!',
    threading: { inReplyTo: '<orig@x>', references: ['<orig@x>'] },
  });

  it('sends a composed RFC822 message with threading headers', async () => {
    const result = await sender().send(intent());
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(createTransport).toHaveBeenCalledTimes(1);
    const transportOpts = createTransport.mock.calls[0][0];
    expect(transportOpts).toEqual(
      expect.objectContaining({
        host: 'smtp.example.com',
        port: 465,
        secure: true,
        auth: expect.objectContaining({ user: 'me@example.com' }),
      }),
    );
    // The identifier (`${user}@${host}`) must never silently take over SMTP
    // AUTH in place of config.user.
    expect(transportOpts.auth.user).not.toBe('me@example.com@imap.example.com');
    const { envelope, raw } = sendMail.mock.calls[0][0];
    expect(envelope).toEqual({
      from: 'me@example.com',
      to: ['alice@example.com'],
    });
    const rfc822 = raw.toString('utf8');
    expect(rfc822).toContain('From: me@example.com'); // config.user, NOT the identifier
    expect(rfc822).not.toContain('me@example.com@imap.example.com');
    expect(rfc822).toContain('In-Reply-To: <orig@x>');
    expect(rfc822).toContain('References: <orig@x>');
    expect(rfc822).toContain('Subject: Re: Numbers');
    expect(rfc822).toContain('Thanks!');
    expect(result.externalMessageId).toMatch(/^<.+>$/);
  });

  it('appends the same raw bytes to the Sent mailbox', async () => {
    await sender().send(intent());
    expect(appended).toHaveLength(1);
    expect(appended[0].path).toBe('Sent');
    expect(appended[0].content.equals(sendMail.mock.calls[0][0].raw)).toBe(
      true,
    );
  });

  it('a Sent-append failure does not fail the send', async () => {
    const broken = createSmtpSender({
      store,
      createTransport: jest.fn((_opts: unknown) => ({ sendMail })),
      connectImap: (async () => {
        throw new Error('imap down');
      }) as never,
    });
    await expect(broken.send(intent())).resolves.toBeTruthy();
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it('throws without a stored password', async () => {
    await store.vault.delete(accountId);
    await expect(sender().send(intent())).rejects.toThrow(/password/i);
  });
});

describe('bundled senders', () => {
  it('ships exactly the imap sender in phase 1', async () => {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-snd-'));
    const store2 = openStore(await openDb(path.join(dir2, 't.db')), deps);
    const senders = buildBundledSenders({ store: store2 });
    expect([...senders.keys()]).toEqual(['imap']);
    await store2.close();
    fs.rmSync(dir2, { recursive: true, force: true });
  });
});
