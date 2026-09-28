/** @jest-environment node */
import type {
  Account,
  AccountId,
  Document,
  DocumentInput,
  Session,
} from '@shared/contracts';

import { planMailboxSync } from '../cursor';
import { attachmentMeta, parseImapMessage } from '../parse';
import { createImapSource } from '../source';
import type { ImapClient } from '../types';

const DOCX =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** A multipart/mixed message with: a docx, a tiny inline logo (dropped), and
 *  a real-size PNG screenshot. */
function rawWithAttachments(uid: number): Buffer {
  const b64 = (buf: Buffer) => buf.toString('base64');
  const docx = Buffer.from('fake-docx-bytes-for-the-offer');
  const logo = Buffer.alloc(500, 1); // < 8 KB
  const shot = Buffer.alloc(20_000, 2);
  const part = (mime: string, name: string, buf: Buffer, disp: string) =>
    [
      '--B',
      `Content-Type: ${mime}; name="${name}"`,
      `Content-Disposition: ${disp}; filename="${name}"`,
      'Content-Transfer-Encoding: base64',
      '',
      b64(buf),
    ].join('\r\n');
  return Buffer.from(
    [
      'From: Cesar <cesar@wwh.example>',
      'To: owner@example.com',
      'Subject: Offer',
      `Message-ID: <m-${uid}@example.com>`,
      'Date: Wed, 26 Aug 2026 13:52:08 +0000',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="B"',
      '',
      '--B',
      'Content-Type: text/plain',
      '',
      'Please find the offer attached.',
      part(DOCX, 'offer.docx', docx, 'attachment'),
      part('image/png', 'logo.png', logo, 'inline'),
      part('image/png', 'screenshot.png', shot, 'attachment'),
      '--B--',
      '',
    ].join('\r\n'),
  );
}

function session(): Session {
  const account: Account = {
    id: 'imap-account' as AccountId,
    source: 'imap',
    identifier: 'owner@example.com',
    config: { host: 'h', port: 993, secure: true, user: 'owner@example.com' },
    status: 'live',
    cursor: null,
    createdAt: new Date(0).toISOString(),
  };
  return {
    account,
    signal: new AbortController().signal,
    credentials: async () => ({ password: 'pw' }),
    log: () => {},
  };
}

function fakeClient(uidValidity: number, messages: Record<number, Buffer>) {
  const state = { closed: 0 };
  const client: ImapClient = {
    listFolders: async () => [{ path: 'INBOX', flags: [] }],
    status: async () => ({ uidValidity, uidNext: 100, exists: 1 }),
    listUids: async () => Object.keys(messages).map(Number),
    fetchMany: async (_p, uids) =>
      uids
        .filter((u) => messages[u])
        .map((uid) => ({ uid, source: messages[uid] })),
    append: async () => {},
    close: async () => {
      state.closed += 1;
    },
  };
  return { client, state };
}

const asDoc = (d: DocumentInput): Document =>
  ({
    ...d,
    id: 'att-1',
    accountId: 'imap-account',
    contentHash: 'h',
    seq: 1,
    ingestSeq: 1,
    archivedAt: null,
    languages: [],
    ingestedAt: '',
    updatedAt: '',
    parentId: null,
    scopeRootId: null,
    url: null,
  }) as unknown as Document;

describe('imap attachments', () => {
  it('keeps attachment metadata (not bytes), drops tiny images, keeps index slots', async () => {
    const item = await parseImapMessage(
      { uid: 42, source: rawWithAttachments(42) },
      'INBOX',
      7,
    );
    expect(item.attachments).toEqual([
      { index: 0, filename: 'offer.docx', mime: DOCX, sizeBytes: 29 },
      {
        index: 2,
        filename: 'screenshot.png',
        mime: 'image/png',
        sizeBytes: 20_000,
      },
    ]);
    expect(JSON.stringify(item)).not.toContain('fake-docx-bytes');
  });

  it('attachmentMeta tolerates missing fields', () => {
    expect(attachmentMeta([{}])).toEqual([
      {
        index: 0,
        filename: null,
        mime: 'application/octet-stream',
        sizeBytes: 0,
      },
    ]);
  });

  it('toDocument emits the message plus bytes-less attachment children', async () => {
    const source = createImapSource();
    const item = await parseImapMessage(
      { uid: 42, source: rawWithAttachments(42) },
      'INBOX',
      7,
    );
    const out = source.toDocument(item) as DocumentInput[];
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({
      externalId: 'INBOX:7:42',
      type: 'email.message',
    });
    expect(out[1]).toMatchObject({
      externalId: 'INBOX:7:42#0',
      type: 'attachment',
      title: 'offer.docx',
      markdown: null,
      parent: { externalId: 'INBOX:7:42', type: 'email.message' },
      metadata: {
        mime: DOCX,
        mailbox: 'INBOX',
        uid: 42,
        uidValidity: '7',
        attachmentIndex: 0,
      },
    });
    expect(out[1]).not.toHaveProperty('binary');
    expect(out[2]).toMatchObject({ externalId: 'INBOX:7:42#2' });
  });

  it('fetchBytes re-fetches the one UID and returns that attachment', async () => {
    const fake = fakeClient(7, { 42: rawWithAttachments(42) });
    const source = createImapSource({ connect: async () => fake.client });
    const item = await parseImapMessage(
      { uid: 42, source: rawWithAttachments(42) },
      'INBOX',
      7,
    );
    const att = (source.toDocument(item) as DocumentInput[])[1];
    const bytes = await source.fetchBytes!(session(), asDoc(att));
    expect(Buffer.from(bytes!).toString()).toBe(
      'fake-docx-bytes-for-the-offer',
    );
    expect(fake.state.closed).toBe(1);
  });

  it('fetchBytes downloads an N-attachment mail once', async () => {
    const fake = fakeClient(7, { 42: rawWithAttachments(42) });
    let fetches = 0;
    const counting: ImapClient = {
      ...fake.client,
      fetchMany: async (p, u) => {
        fetches += 1;
        return fake.client.fetchMany(p, u);
      },
    };
    const source = createImapSource({ connect: async () => counting });
    const item = await parseImapMessage(
      { uid: 42, source: rawWithAttachments(42) },
      'INBOX',
      7,
    );
    const [, docx, png] = source.toDocument(item) as DocumentInput[];
    await source.fetchBytes!(session(), asDoc(docx));
    const shot = await source.fetchBytes!(session(), asDoc(png));
    expect(shot).toHaveLength(20_000);
    expect(fetches).toBe(1);
  });

  it('fetchBytes answers null (terminal) when UIDVALIDITY rolled over or the mail is gone', async () => {
    const item = await parseImapMessage(
      { uid: 42, source: rawWithAttachments(42) },
      'INBOX',
      7,
    );
    const att = asDoc(
      (createImapSource().toDocument(item) as DocumentInput[])[1],
    );
    const rolled = fakeClient(8, { 42: rawWithAttachments(42) });
    await expect(
      createImapSource({ connect: async () => rolled.client }).fetchBytes!(
        session(),
        att,
      ),
    ).resolves.toBeNull();
    const gone = fakeClient(7, {});
    await expect(
      createImapSource({ connect: async () => gone.client }).fetchBytes!(
        session(),
        att,
      ),
    ).resolves.toBeNull();
    expect(gone.state.closed).toBe(1);
  });

  it('a mailbox synced before attachments existed is re-fetched once, without a reset', () => {
    const legacy = { uidValidity: '7', lastUid: 3 };
    expect(planMailboxSync(legacy, 7, [1, 2, 3])).toEqual({
      reset: false,
      uidsToFetch: [1, 2, 3],
    });
    expect(
      planMailboxSync({ ...legacy, attachments: 1 }, 7, [1, 2, 3, 4]),
    ).toEqual({ reset: false, uidsToFetch: [4] });
  });
});
