/**
 * @jest-environment node
 *
 * nodemailer's MimeNode.build() relies on Node's setImmediate (see
 * gmail.test.ts).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import MailComposer from 'nodemailer/lib/mail-composer';
import { simpleParser } from 'mailparser';

import type { AccountId } from '@shared/contracts';

import { openDb } from '../../../db/app-db';
import { openStore, type CoreStore } from '../../../core/store/store';
import { createGmailSender } from '../gmail';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const COMPOSE =
  'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose';

function res(status: number, body: unknown) {
  return {
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    headers: { get: () => null },
  };
}

const b64 = (s: string) => Buffer.from(s).toString('base64url');

/** A draft as it might sit in Gmail after the user touched it. */
async function storedRaw(): Promise<Buffer> {
  const node = new MailComposer({
    from: 'me@gmail.com',
    to: 'bob@example.com',
    bcc: 'boss@example.com',
    subject: 'Re: Numbers',
    text: 'Old text',
    html: '<p>Old text <img src="cid:logo@x"></p>',
    inReplyTo: '<orig@x>',
    references: ['<orig@x>'],
    attachments: [
      {
        filename: 'logo.png',
        contentType: 'image/png',
        content: Buffer.from('PNGDATA'),
        cid: 'logo@x',
      },
      {
        filename: 'a.pdf',
        contentType: 'application/pdf',
        content: Buffer.from('%PDF-a'),
      },
      {
        filename: 'b.txt',
        contentType: 'text/plain',
        content: Buffer.from('bee'),
      },
    ],
  }).compile();
  node.keepBcc = true;
  return node.build();
}

describe('gmail draft mirror', () => {
  let dir: string;
  let store: CoreStore;
  let accountId: AccountId;
  let fetchMock: jest.Mock;

  const intent = () => ({
    accountId,
    kind: 'reply' as const,
    to: ['bob@example.com'],
    subject: 'Re: Numbers',
    bodyMarkdown: 'Thanks!',
    threading: {
      gmailThreadId: 't123',
      inReplyTo: '<orig@x>',
      references: ['<orig@x>'],
    },
  });
  const ref = () => ({ accountId, id: 'd1', threadId: 't123' });
  const drafts = () => createGmailSender({ store }).drafts!;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-gmail-drafts-'));
    store = openStore(await openDb(path.join(dir, 'test.db')), deps);
    const account = await store.createAccount({
      source: 'gmail',
      identifier: 'me@gmail.com',
      config: {},
    });
    accountId = account.id;
    await store.vault.save(accountId, {
      accessToken: 'tok-1',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      scope: COMPOSE,
    });
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  const use = (
    fn: (url: string, init: { method?: string; body?: string }) => unknown,
  ) => {
    fetchMock = jest.fn(
      async (url: string, init: { method?: string; body?: string }) =>
        fn(url, init),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
  };
  const sentRaw = (call: number) =>
    Buffer.from(
      JSON.parse(String(fetchMock.mock.calls[call][1].body)).message.raw,
      'base64url',
    );

  it('create posts drafts.create in the thread with the reply headers', async () => {
    use(() => res(200, { id: 'd1', message: { id: 'm1', threadId: 't123' } }));
    const r = await drafts().create(intent());
    expect(r).toEqual({ accountId, id: 'd1', threadId: 't123' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/drafts`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body).message.threadId).toBe('t123');
    const raw = sentRaw(0).toString('utf8');
    expect(raw).toContain('In-Reply-To: <orig@x>');
    expect(raw).toContain('References: <orig@x>');
    expect(raw).toContain('Thanks!');
  });

  it('create carries attachments and Bcc', async () => {
    use(() => res(200, { id: 'd1', message: { id: 'm1', threadId: 't1' } }));
    await drafts().create({
      ...intent(),
      bcc: ['boss@example.com'],
      attachments: [
        { filename: 'x.pdf', mime: 'application/pdf', contentBase64: 'AQI=' },
      ],
    });
    const parsed = await simpleParser(sentRaw(0));
    expect(parsed.attachments.map((a) => a.filename)).toEqual(['x.pdf']);
    expect((parsed.bcc as { text: string }).text).toBe('boss@example.com');
  });

  it('a grant without gmail.compose asks to reconnect and never calls Gmail', async () => {
    await store.vault.save(accountId, {
      accessToken: 'tok-1',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      scope:
        'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send',
    });
    use(() => res(200, {}));
    await expect(drafts().create(intent())).rejects.toThrow(
      'Reconnect this account in Settings to sync drafts',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('an API scope refusal also asks to reconnect', async () => {
    use(() =>
      res(403, {
        error: { details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] },
      }),
    );
    await expect(drafts().create(intent())).rejects.toThrow(
      'Reconnect this account in Settings to sync drafts',
    );
  });

  it('read maps format=full to the draft content', async () => {
    use(() =>
      res(200, {
        id: 'd1',
        message: {
          id: 'm2',
          threadId: 't123',
          payload: {
            mimeType: 'multipart/mixed',
            headers: [
              {
                name: 'To',
                value: '"Doe, Jane" <jane@x.com>, bob@example.com',
              },
              { name: 'Cc', value: 'carol@example.com' },
              { name: 'Bcc', value: 'boss@example.com' },
              { name: 'Subject', value: 'Re: Numbers' },
            ],
            parts: [
              {
                mimeType: 'text/plain',
                body: { data: b64('Edited in Gmail') },
              },
              {
                mimeType: 'application/pdf',
                filename: 'a.pdf',
                headers: [
                  {
                    name: 'Content-Disposition',
                    value: 'attachment; filename="a.pdf"',
                  },
                ],
                body: { attachmentId: 'att1', size: 6 },
              },
            ],
          },
        },
      }),
    );
    const r = await drafts().read(ref());
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/drafts/d1?format=full`);
    expect(r).toEqual({
      state: 'draft',
      ref: { accountId, id: 'd1', threadId: 't123' },
      content: {
        to: ['"Doe, Jane" <jane@x.com>', 'bob@example.com'],
        cc: ['carol@example.com'],
        bcc: ['boss@example.com'],
        subject: 'Re: Numbers',
        bodyText: 'Edited in Gmail',
        attachments: [{ filename: 'a.pdf', mime: 'application/pdf', size: 6 }],
      },
    });
  });

  it('read of an HTML-only draft gives its text', async () => {
    use(() =>
      res(200, {
        id: 'd1',
        message: {
          threadId: 't123',
          payload: {
            mimeType: 'text/html',
            headers: [{ name: 'To', value: 'bob@example.com' }],
            body: { data: b64('<p>Hello <b>Bob</b></p>') },
          },
        },
      }),
    );
    const r = await drafts().read(ref());
    expect(r.state === 'draft' && r.content.bodyText).toMatch(
      /Hello \*\*Bob\*\*/,
    );
  });

  it('read of a draft that no longer exists is gone', async () => {
    use(() =>
      res(404, {
        error: { code: 404, message: 'Requested entity was not found.' },
      }),
    );
    expect(await drafts().read(ref())).toEqual({ state: 'gone' });
  });

  describe('update', () => {
    let stored: Buffer;
    beforeEach(async () => {
      stored = await storedRaw();
    });
    const withStored = () =>
      use((url, init) =>
        init.method === 'PUT'
          ? res(200, { id: 'd1', message: { id: 'm3', threadId: 't123' } })
          : res(200, {
              id: 'd1',
              message: {
                id: 'm2',
                threadId: 't123',
                raw: stored.toString('base64url'),
              },
            }),
      );

    it('a body change keeps Bcc, the inline image and the files, and drops the HTML', async () => {
      withStored();
      const r = await drafts().update(ref(), { bodyMarkdown: 'New text' });
      expect(r).toEqual({ accountId, id: 'd1', threadId: 't123' });
      expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/drafts/d1?format=raw`);
      const [url, init] = fetchMock.mock.calls[1];
      expect(url).toBe(`${BASE}/drafts/d1`);
      expect(JSON.parse(init.body)).toMatchObject({
        id: 'd1',
        message: { threadId: 't123' },
      });
      const raw = sentRaw(1);
      expect(raw.toString('utf8')).toMatch(/^Bcc: boss@example\.com/m);
      const m = await simpleParser(raw);
      expect(m.text?.trim()).toBe('New text');
      expect(m.html).toBe(false);
      expect(m.inReplyTo).toBe('<orig@x>');
      const logo = m.attachments.find((a) => a.filename === 'logo.png');
      expect(logo?.cid).toBe('logo@x');
      expect(m.attachments.map((a) => a.filename).sort()).toEqual([
        'a.pdf',
        'b.txt',
        'logo.png',
      ]);
    });

    it('a subject change keeps the HTML', async () => {
      withStored();
      await drafts().update(ref(), { subject: 'Re: Numbers (v2)' });
      const m = await simpleParser(sentRaw(1));
      expect(m.subject).toBe('Re: Numbers (v2)');
      expect(m.html).toContain('Old text');
    });

    it('removeAttachments drops only that file; added files join', async () => {
      withStored();
      await drafts().update(ref(), {
        removeAttachments: ['a.pdf'],
        attachments: [
          { filename: 'c.csv', mime: 'text/csv', contentBase64: b64('1,2') },
        ],
      });
      const m = await simpleParser(sentRaw(1));
      expect(m.attachments.map((a) => a.filename).sort()).toEqual([
        'b.txt',
        'c.csv',
        'logo.png',
      ]);
    });
  });

  it('send goes through drafts.send', async () => {
    use(() => res(200, { id: 'm9', threadId: 't123' }));
    const r = await drafts().send(ref());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${BASE}/drafts/send`);
    expect(JSON.parse(init.body)).toEqual({ id: 'd1' });
    expect(r).toEqual({ externalMessageId: 'm9', providerThreadId: 't123' });
  });

  it('remove deletes the draft; an already-missing one is fine', async () => {
    use(() => res(404, 'not found'));
    await expect(drafts().remove(ref())).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');
  });

  it('a compose-only grant can still send a plain message', async () => {
    use(() => res(200, { id: 'm1', threadId: 't1' }));
    await createGmailSender({ store }).send(intent());
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/messages/send`);
  });
});
