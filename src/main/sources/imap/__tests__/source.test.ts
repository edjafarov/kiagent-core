/**
 * @jest-environment node
 *
 * pull() parses fixture messages via mailparser, which relies on Node's
 * setImmediate — not provided by the default jsdom test environment.
 */
import type { Account, AccountId, AuthChannel, Batch, DocumentInput, Session } from '@shared/contracts';
import { createImapSource } from '../source';
import type { ConnectFn } from '../source';
import type { ImapClient, ImapCursor, ImapMessageItem } from '../types';

// ── Fixtures ────────────────────────────────────────────────────────────────

function rfc822(uid: number, subject: string, opts: { headers?: string[] } = {}): string {
  const lines = [
    'From: Alice <alice@example.com>',
    'To: bob@example.com',
    `Subject: ${subject}`,
    `Message-ID: <uid-${uid}@test>`,
    'Date: Wed, 01 Jan 2025 12:00:00 +0000',
    ...(opts.headers ?? []),
    '',
    `Body of message ${uid}`,
  ];
  return lines.join('\r\n');
}

interface FakeMailbox {
  path: string;
  specialUse?: string;
  uidValidity: number;
  messages: Map<number, string>;
}

function makeFakeClient(mailboxes: FakeMailbox[]) {
  const state = { closed: false, statusCalls: 0, fetchCalls: 0 };
  const find = (path: string): FakeMailbox => {
    const m = mailboxes.find((x) => x.path === path);
    if (!m) throw new Error(`fake client: no such mailbox ${path}`);
    return m;
  };
  const client: ImapClient = {
    async listFolders() {
      return mailboxes.map((m) => ({ path: m.path, specialUse: m.specialUse, flags: [] }));
    },
    async status(path: string) {
      state.statusCalls += 1;
      const m = find(path);
      return { uidValidity: m.uidValidity, uidNext: Math.max(0, ...m.messages.keys()) + 1, exists: m.messages.size };
    },
    async listUids(path: string) {
      return [...find(path).messages.keys()].sort((a, b) => a - b);
    },
    async fetchMany(path: string, uids: number[]) {
      state.fetchCalls += 1;
      const m = find(path);
      return uids
        .filter((u) => m.messages.has(u))
        .map((u) => ({ uid: u, source: Buffer.from(m.messages.get(u)!, 'utf8') }));
    },
    async close() {
      state.closed = true;
    },
  };
  return { client, mailboxes, state };
}

function makeSession(
  config: Record<string, unknown>,
  opts: { password?: string | null; signal?: AbortSignal } = {},
): Session {
  const account: Account = {
    id: 'acc1' as AccountId,
    source: 'imap',
    identifier: 'alice@example.com',
    config,
    status: 'connecting',
    cursor: null,
    createdAt: new Date().toISOString(),
  };
  return {
    account,
    signal: opts.signal ?? new AbortController().signal,
    async credentials() {
      if (opts.password === null) return null;
      return { password: opts.password ?? 'hunter2' };
    },
    log: () => {},
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of iterable) out.push(x);
  return out;
}

const CONFIG = { host: 'imap.example.com', port: 993, secure: true, user: 'alice@example.com' };

// ── descriptor ──────────────────────────────────────────────────────────────

describe('createImapSource — descriptor', () => {
  it('declares password auth, multiAccount, and a 15m cadence', () => {
    const source = createImapSource();
    expect(source.descriptor).toMatchObject({
      id: 'imap',
      name: 'Email (IMAP)',
      documentTypes: ['email.message'],
      auth: 'password',
      multiAccount: true,
      cadence: { every: '15m' },
    });
  });
});

// ── connect ─────────────────────────────────────────────────────────────────

describe('createImapSource — connect', () => {
  function fakeAuth(answers: Record<string, unknown>): AuthChannel {
    return {
      oauth: async () => ({}),
      showQr: () => {},
      prompt: async (schema) => {
        // The platform's vault only captures the literal 'password' key —
        // assert the prompt schema actually asks for one.
        const props = (schema as { properties?: Record<string, unknown> }).properties ?? {};
        expect(props).toHaveProperty('password');
        return answers;
      },
      status: () => {},
      pickFolders: async () => [],
    };
  }

  it('verifies connectivity and returns identifier/config on success', async () => {
    const { client } = makeFakeClient([{ path: 'INBOX', uidValidity: 1, messages: new Map() }]);
    const connectFn: ConnectFn = jest.fn(async () => client);
    const source = createImapSource({ connect: connectFn });

    const result = await source.connect(
      fakeAuth({ host: 'imap.example.com', port: 993, secure: true, user: 'alice@example.com', password: 'hunter2' }),
    );

    expect(result.identifier).toBe('alice@example.com@imap.example.com');
    expect(result.config).toEqual(CONFIG);
    expect(connectFn).toHaveBeenCalledWith(CONFIG, 'hunter2');
  });

  it('rejects when required fields are missing', async () => {
    const source = createImapSource({ connect: jest.fn() as unknown as ConnectFn });
    await expect(
      source.connect(fakeAuth({ host: '', user: 'alice', password: '' })),
    ).rejects.toThrow(/required/i);
  });

  it('surfaces an auth-failed message from the connect attempt', async () => {
    const connectFn: ConnectFn = jest.fn(async () => {
      throw { authenticationFailed: true, responseText: 'bad creds' };
    });
    const source = createImapSource({ connect: connectFn });
    await expect(
      source.connect(fakeAuth({ host: 'h', user: 'u', password: 'p' })),
    ).rejects.toThrow(/Authentication failed/);
  });

  it('rejects when the account has no syncable mailboxes', async () => {
    const { client } = makeFakeClient([{ path: 'Junk', uidValidity: 1, messages: new Map() }]);
    const source = createImapSource({ connect: jest.fn(async () => client) });
    await expect(
      source.connect(fakeAuth({ host: 'h', user: 'u', password: 'p' })),
    ).rejects.toThrow(/no mail folders/);
  });

  it('defaults port from `secure` when omitted (993 tls / 143 starttls)', async () => {
    const { client } = makeFakeClient([{ path: 'INBOX', uidValidity: 1, messages: new Map() }]);
    const connectFn: ConnectFn = jest.fn(async () => client);
    const source = createImapSource({ connect: connectFn });
    await source.connect(fakeAuth({ host: 'h', user: 'u', password: 'p', secure: false }));
    expect(connectFn).toHaveBeenCalledWith(expect.objectContaining({ port: 143, secure: false }), 'p');
  });
});

// ── toDocument ──────────────────────────────────────────────────────────────

describe('createImapSource — toDocument', () => {
  const source = createImapSource();

  function item(overrides: Partial<ImapMessageItem> = {}): ImapMessageItem {
    return {
      mailbox: 'INBOX',
      uid: 7,
      uidValidity: '999',
      messageId: 'abc@test',
      subject: 'Hello',
      from: 'Alice <alice@example.com>',
      to: ['bob@example.com'],
      date: '2025-01-01T12:00:00.000Z',
      bodyText: 'Hi there',
      headers: {},
      ...overrides,
    };
  }

  it('maps a normal message to a DocumentInput with the expected externalId/type/url', () => {
    const doc = source.toDocument(item());
    expect(doc).toEqual({
      externalId: 'INBOX:999:7',
      type: 'email.message',
      title: 'Hello',
      markdown: 'Hi there',
      metadata: {
        from: 'Alice <alice@example.com>',
        to: ['bob@example.com'],
        date: '2025-01-01T12:00:00.000Z',
        mailbox: 'INBOX',
        uid: 7,
        messageId: 'abc@test',
      },
      createdAt: '2025-01-01T12:00:00.000Z',
      url: undefined,
    });
  });

  it('falls back to "(no subject)" for blank/missing subjects', () => {
    expect((source.toDocument(item({ subject: null })) as DocumentInput | null)?.title).toBe('(no subject)');
    expect((source.toDocument(item({ subject: '   ' })) as DocumentInput | null)?.title).toBe('(no subject)');
  });

  it('returns null (skips) an automated/bulk sender', () => {
    const doc = source.toDocument(item({ from: 'no-reply@example.com', headers: {} }));
    expect(doc).toBeNull();
  });

  it('returns null for a message carrying List-Unsubscribe', () => {
    const doc = source.toDocument(item({ headers: { 'list-unsubscribe': '<mailto:x>' } }));
    expect(doc).toBeNull();
  });
});

// ── pull ────────────────────────────────────────────────────────────────────

describe('createImapSource — pull', () => {
  it('backfills a fresh account in batches of 50, oldest UID first, advancing the cursor each chunk', async () => {
    const messages = new Map<number, string>();
    for (let uid = 1; uid <= 120; uid += 1) messages.set(uid, rfc822(uid, `Subject ${uid}`));
    const { client, state } = makeFakeClient([{ path: 'INBOX', uidValidity: 555, messages }]);
    const source = createImapSource({
      connect: async () => client,
      sleep: async () => {},
    });
    const controller = new AbortController();
    const session = makeSession(CONFIG, { signal: controller.signal });

    const batches: Batch<ImapCursor, ImapMessageItem>[] = [];
    for await (const batch of source.pull(session, null)) {
      batches.push(batch);
      if (batch.phase === 'backfill' && batches.length === 3) {
        // Stop right after backfill completes, before entering the live loop.
        controller.abort();
      }
    }

    expect(batches).toHaveLength(3);
    expect(batches.map((b) => b.items.length)).toEqual([50, 50, 20]);
    expect(batches.every((b) => b.phase === 'backfill')).toBe(true);
    expect(batches.every((b) => b.estimateTotal === 120)).toBe(true);
    expect(batches[0].items[0].uid).toBe(1); // oldest first
    expect(batches[2].cursor.mailboxes.INBOX).toEqual({ uidValidity: '555', lastUid: 120 });
    expect(state.closed).toBe(true);
  });

  it('a returning account with nothing new produces no batches during the first pass', async () => {
    const messages = new Map<number, string>([[1, rfc822(1, 'one')], [2, rfc822(2, 'two')]]);
    const { client } = makeFakeClient([{ path: 'INBOX', uidValidity: 1, messages }]);
    let pollCount = 0;
    const controller = new AbortController();
    const source = createImapSource({
      connect: async () => client,
      sleep: async () => {
        pollCount += 1;
        controller.abort(); // stop after exactly one live-loop iteration
      },
    });
    const cursor: ImapCursor = { mailboxes: { INBOX: { uidValidity: '1', lastUid: 2 } } };
    const session = makeSession(CONFIG, { signal: controller.signal });

    const batches = await collect(source.pull(session, cursor));
    expect(batches).toEqual([]);
    expect(pollCount).toBe(1);
  });

  it('picks up new mail that appears between live-phase polls', async () => {
    const messages = new Map<number, string>([[1, rfc822(1, 'one')], [2, rfc822(2, 'two')]]);
    const { client } = makeFakeClient([{ path: 'INBOX', uidValidity: 1, messages }]);
    const controller = new AbortController();
    let sleepCalls = 0;
    const source = createImapSource({
      connect: async () => client,
      sleep: async () => {
        sleepCalls += 1;
        if (sleepCalls === 1) {
          // Simulate new mail arriving while parked between polls.
          messages.set(3, rfc822(3, 'three'));
        } else {
          controller.abort();
        }
      },
    });
    const cursor: ImapCursor = { mailboxes: { INBOX: { uidValidity: '1', lastUid: 2 } } };
    const session = makeSession(CONFIG, { signal: controller.signal });

    const batches = await collect(source.pull(session, cursor));
    expect(batches).toHaveLength(1);
    expect(batches[0].phase).toBe('live');
    expect(batches[0].items.map((i) => i.uid)).toEqual([3]);
    expect(batches[0].cursor.mailboxes.INBOX).toEqual({ uidValidity: '1', lastUid: 3 });
    expect(sleepCalls).toBe(2);
  });

  it('treats a UIDVALIDITY change as a from-scratch resync, forcing phase=backfill', async () => {
    const messages = new Map<number, string>([[1, rfc822(1, 'one')], [2, rfc822(2, 'two')]]);
    const { client } = makeFakeClient([{ path: 'INBOX', uidValidity: 999, messages }]); // server-side UIDVALIDITY rolled over
    const controller = new AbortController();
    const source = createImapSource({
      connect: async () => client,
      sleep: async () => controller.abort(),
    });
    // Stale cursor from before the rollover.
    const cursor: ImapCursor = { mailboxes: { INBOX: { uidValidity: '1', lastUid: 50 } } };
    const session = makeSession(CONFIG, { signal: controller.signal });

    const batches = await collect(source.pull(session, cursor));
    expect(batches).toHaveLength(1);
    expect(batches[0].phase).toBe('backfill');
    expect(batches[0].items.map((i) => i.uid)).toEqual([1, 2]); // refetched from 0, not from stale lastUid=50
    expect(batches[0].cursor.mailboxes.INBOX).toEqual({ uidValidity: '999', lastUid: 2 });
  });

  it('throws when the account has no stored password credential', async () => {
    const { client } = makeFakeClient([{ path: 'INBOX', uidValidity: 1, messages: new Map() }]);
    const source = createImapSource({ connect: async () => client });
    const session = makeSession(CONFIG, { password: null });
    await expect(collect(source.pull(session, null))).rejects.toThrow(/password/i);
  });

  it('closes the client and yields nothing when the signal is already aborted', async () => {
    const { client, state } = makeFakeClient([{ path: 'INBOX', uidValidity: 1, messages: new Map([[1, rfc822(1, 'x')]]) }]);
    const controller = new AbortController();
    controller.abort();
    const source = createImapSource({ connect: async () => client });
    const cursor: ImapCursor = { mailboxes: { INBOX: { uidValidity: '1', lastUid: 1 } } };
    const session = makeSession(CONFIG, { signal: controller.signal });

    const batches = await collect(source.pull(session, cursor));
    expect(batches).toEqual([]);
    expect(state.closed).toBe(true);
  });
});

// ── reconcile ───────────────────────────────────────────────────────────────

describe('createImapSource — reconcile', () => {
  it('yields ExternalRefs for every UID currently present in each synced mailbox', async () => {
    const { client } = makeFakeClient([
      { path: 'INBOX', uidValidity: 10, messages: new Map([[1, ''], [2, '']]) },
      { path: 'Sent', uidValidity: 20, specialUse: '\\Sent', messages: new Map([[5, '']]) },
    ]);
    const source = createImapSource({ connect: async () => client });
    const session = makeSession(CONFIG);

    const pages = await collect(source.reconcile!(session));
    const refs = pages.flat();
    expect(refs).toEqual(
      expect.arrayContaining([
        { externalId: 'INBOX:10:1', type: 'email.message' },
        { externalId: 'INBOX:10:2', type: 'email.message' },
        { externalId: 'Sent:20:5', type: 'email.message' },
      ]),
    );
    expect(refs).toHaveLength(3);
  });

  it('pages large mailboxes into chunks of 500', async () => {
    const messages = new Map<number, string>();
    for (let uid = 1; uid <= 501; uid += 1) messages.set(uid, '');
    const { client } = makeFakeClient([{ path: 'INBOX', uidValidity: 1, messages }]);
    const source = createImapSource({ connect: async () => client });
    const session = makeSession(CONFIG);

    const pages = await collect(source.reconcile!(session));
    expect(pages).toHaveLength(2);
    expect(pages[0]).toHaveLength(500);
    expect(pages[1]).toHaveLength(1);
  });

  it('stops without yielding once the signal is aborted', async () => {
    const { client } = makeFakeClient([{ path: 'INBOX', uidValidity: 1, messages: new Map([[1, '']]) }]);
    const controller = new AbortController();
    controller.abort();
    const source = createImapSource({ connect: async () => client });
    const session = makeSession(CONFIG, { signal: controller.signal });

    const pages = await collect(source.reconcile!(session));
    expect(pages).toEqual([]);
  });
});
