/**
 * @jest-environment node
 *
 * Folder-scope behaviour of the IMAP source: connect defaults, manageFolders,
 * scoped pull / live re-LIST, scope stamps, scoped reconcile.
 */
import type {
  Account,
  AccountId,
  AuthChannel,
  Batch,
  DocumentInput,
  FolderNode,
  FolderPickerSpec,
  FolderSelectionChannel,
  Session,
} from '@shared/contracts';
import { SourceAuthError } from '@shared/source-errors';

import { createImapSource } from '../source';
import type {
  ImapClient,
  ImapCursor,
  ImapFolderInfo,
  ImapMessageItem,
} from '../types';

// ── Fixtures ────────────────────────────────────────────────────────────────

function rfc822(uid: number, opts: { attachment?: boolean } = {}): string {
  const head = [
    'From: Alice <alice@example.com>',
    'To: bob@example.com',
    `Subject: Subject ${uid}`,
    `Message-ID: <uid-${uid}@test>`,
    'Date: Wed, 01 Jan 2025 12:00:00 +0000',
  ];
  if (!opts.attachment)
    return [...head, '', `Body of message ${uid}`].join('\r\n');
  return [
    ...head,
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="b1"',
    '',
    '--b1',
    'Content-Type: text/plain',
    '',
    `Body of message ${uid}`,
    '--b1',
    'Content-Type: application/pdf; name="a.pdf"',
    'Content-Disposition: attachment; filename="a.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('%PDF-1.4 hello').toString('base64'),
    '--b1--',
    '',
  ].join('\r\n');
}

interface Box {
  path: string;
  specialUse?: string;
  delimiter?: string;
  parentPath?: string;
  flags?: string[];
  uidValidity: number;
  messages: Map<number, string>;
}

const msgs = (n: number, opts: { attachment?: boolean } = {}) =>
  new Map<number, string>(
    Array.from({ length: n }, (_, i) => [i + 1, rfc822(i + 1, opts)]),
  );

/** A fake server whose folder list can change while a session is live. */
function makeServer(boxes: Box[]) {
  const log: string[] = [];
  const find = (path: string): Box => {
    const m = boxes.find((x) => x.path === path);
    if (!m) throw new Error(`no such mailbox ${path}`);
    return m;
  };
  const client: ImapClient = {
    async listFolders(): Promise<ImapFolderInfo[]> {
      log.push('list');
      return boxes.map((m) => ({
        path: m.path,
        specialUse: m.specialUse,
        delimiter: m.delimiter ?? '/',
        parentPath: m.parentPath,
        flags: m.flags ?? [],
      }));
    },
    async status(path) {
      log.push(`status:${path}`);
      const m = find(path);
      return {
        uidValidity: m.uidValidity,
        uidNext: Math.max(0, ...m.messages.keys()) + 1,
        exists: m.messages.size,
      };
    },
    async listUids(path) {
      log.push(`uids:${path}`);
      return [...find(path).messages.keys()].sort((a, b) => a - b);
    },
    async fetchMany(path, uids) {
      log.push(`fetch:${path}`);
      const m = find(path);
      return uids
        .filter((u) => m.messages.has(u))
        .map((u) => ({ uid: u, source: Buffer.from(m.messages.get(u)!) }));
    },
    async append() {},
    async close() {
      log.push('close');
    },
  };
  return { client, boxes, log };
}

const BASE = { host: 'imap.example.com', port: 993, secure: true, user: 'a@b' };
const roots = (...ids: string[]) => ids.map((id) => ({ id, name: id }));

function makeSession(
  config: Record<string, unknown>,
  opts: {
    cursor?: ImapCursor | null;
    password?: string | null;
    signal?: AbortSignal;
    logs?: Array<[string, string]>;
  } = {},
): Session {
  const account: Account = {
    id: 'acc1' as AccountId,
    source: 'imap',
    identifier: 'a@b',
    config,
    status: 'connecting',
    cursor: opts.cursor ?? null,
    createdAt: new Date().toISOString(),
  };
  return {
    account,
    signal: opts.signal ?? new AbortController().signal,
    async credentials() {
      return opts.password === null ? null : { password: 'pw' };
    },
    log: (level: string, msg: string) => opts.logs?.push([level, msg]),
  } as Session;
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

function fakeChannel(
  picked: (spec: FolderPickerSpec) => FolderNode[],
  log: string[] = [],
) {
  const specs: FolderPickerSpec[] = [];
  const channel: FolderSelectionChannel = {
    status: () => {},
    async pickFolders(spec) {
      specs.push(spec);
      log.push('pick');
      return picked(spec);
    },
  };
  return { channel, specs };
}
const node = (id: string): FolderNode => ({ id, name: id, hasChildren: false });

/** Folder server: INBOX, Sent, Receipts, Projects/{Acme}, Trash. */
function folderServer() {
  return makeServer([
    { path: 'INBOX', uidValidity: 1, messages: msgs(2) },
    { path: 'Sent', specialUse: '\\Sent', uidValidity: 2, messages: msgs(1) },
    { path: 'Receipts', uidValidity: 3, messages: msgs(3) },
    { path: 'Trash', specialUse: '\\Trash', uidValidity: 4, messages: msgs(1) },
    {
      path: 'Projects',
      uidValidity: 5,
      flags: ['\\noselect'],
      messages: new Map(),
    },
    {
      path: 'Projects/Acme',
      parentPath: 'Projects',
      uidValidity: 6,
      messages: msgs(2, { attachment: true }),
    },
  ]);
}

const allMailServer = () =>
  makeServer([
    { path: 'INBOX', uidValidity: 1, messages: msgs(1) },
    {
      path: '[Gmail]/All Mail',
      specialUse: '\\All',
      parentPath: '[Gmail]',
      uidValidity: 2,
      messages: msgs(1),
    },
    {
      path: '[Gmail]/Sent Mail',
      specialUse: '\\Sent',
      parentPath: '[Gmail]',
      uidValidity: 3,
      messages: msgs(1),
    },
  ]);

// ── connect ─────────────────────────────────────────────────────────────────

describe('imap folder scope — connect', () => {
  const auth = (pick?: jest.Mock): AuthChannel => ({
    oauth: async () => ({}),
    showQr: () => {},
    prompt: async () => ({ host: 'h', user: 'u', password: 'p' }),
    status: () => {},
    pickFolders: pick ?? (async () => []),
  });

  it('descriptor declares folderScope and implements manageFolders', () => {
    const s = createImapSource();
    expect(s.descriptor.folderScope).toBe(true);
    expect(typeof s.manageFolders).toBe('function');
  });

  it('never opens a picker and writes folderRoots = defaults (folder server)', async () => {
    const { client } = folderServer();
    const pick = jest.fn(async () => []);
    const src = createImapSource({ connect: async () => client });
    const res = await src.connect(auth(pick));
    expect(pick).not.toHaveBeenCalled();
    expect(res.config?.folderRoots).toEqual(roots('INBOX', 'Sent'));
  });

  it('All-Mail server: default root is All Mail only', async () => {
    const { client } = allMailServer();
    const src = createImapSource({ connect: async () => client });
    const res = await src.connect(auth());
    expect(res.config?.folderRoots).toEqual(roots('[Gmail]/All Mail'));
  });
});

// ── manageFolders ───────────────────────────────────────────────────────────

describe('imap folder scope — manageFolders', () => {
  const declared = () => ({
    ...BASE,
    folderRoots: roots('INBOX', 'Sent', 'Receipts'),
  });
  const cursor = (): ImapCursor => ({
    mailboxes: {
      INBOX: { uidValidity: '1', lastUid: 2, attachments: 1 },
      Sent: { uidValidity: '2', lastUid: 1, attachments: 1 },
      Receipts: { uidValidity: '3', lastUid: 3, attachments: 1 },
    },
  });

  it('narrowing: archiveRefs = removed generations, cursor drops them, no network after the picker', async () => {
    const { client, log } = folderServer();
    const { channel } = fakeChannel(() => [node('INBOX'), node('Sent')], log);
    const src = createImapSource({ connect: async () => client });
    const res = await src.manageFolders!(
      makeSession(declared(), { cursor: cursor() }),
      channel,
    );
    expect(res.archiveRefs).toEqual([
      { externalId: 'Receipts:3:1', type: 'email.message' },
      { externalId: 'Receipts:3:2', type: 'email.message' },
      { externalId: 'Receipts:3:3', type: 'email.message' },
    ]);
    expect(res.archiveScopeRootIds).toEqual([]);
    expect(Object.keys((res.cursor as ImapCursor).mailboxes).sort()).toEqual([
      'INBOX',
      'Sent',
    ]);
    expect(res.config.folderRoots).toEqual(roots('INBOX', 'Sent'));
    expect(res.config.host).toBe('imap.example.com');
    // Order: list -> close -> pick, and nothing after the pick.
    expect(log).toEqual(['list', 'close', 'pick']);
  });

  it('widening: no archiveRefs; the new mailbox backfills with the summed estimate', async () => {
    const { client } = folderServer();
    const cfg = { ...BASE, folderRoots: roots('INBOX', 'Sent') };
    const cur: ImapCursor = {
      mailboxes: {
        INBOX: { uidValidity: '1', lastUid: 2, attachments: 1 },
        Sent: { uidValidity: '2', lastUid: 1, attachments: 1 },
      },
    };
    const { channel } = fakeChannel(() => [
      node('INBOX'),
      node('Sent'),
      node('Receipts'),
    ]);
    const src = createImapSource({
      connect: async () => client,
      sleep: async () => {},
    });
    const res = await src.manageFolders!(
      makeSession(cfg, { cursor: cur }),
      channel,
    );
    expect(res.archiveRefs).toEqual([]);
    expect(res.cursor).toEqual(cur);

    const ctl = new AbortController();
    const session = makeSession(res.config, {
      cursor: res.cursor as ImapCursor,
      signal: ctl.signal,
    });
    const batches: Batch<ImapCursor, ImapMessageItem>[] = [];
    for await (const b of src.pull(session, res.cursor as ImapCursor)) {
      batches.push(b);
      if (b.items.length > 0) ctl.abort();
    }
    const first = batches[0];
    expect(first.phase).toBe('backfill');
    expect(first.items.map((i) => i.mailbox)).toEqual([
      'Receipts',
      'Receipts',
      'Receipts',
    ]);
    expect(first.estimateTotal).toBe(2 + 1 + 3);
  });

  it('legacy account: picker preselects the defaults, offers expand + note', async () => {
    const { client } = folderServer();
    const { channel, specs } = fakeChannel(() => [node('INBOX'), node('Sent')]);
    const src = createImapSource({ connect: async () => client });
    const res = await src.manageFolders!(makeSession({ ...BASE }), channel);
    expect(specs[0].selected?.map((n) => n.id)).toEqual(['INBOX', 'Sent']);
    expect(specs[0].note).toMatch(/removed from kia/);
    expect(specs[0].purpose).toBe('manage');
    expect(specs[0].multiSelect).toBe(true);
    expect(res.cursor).toBeNull();
    expect(res.archiveRefs).toEqual([]);
  });

  it('All-Mail server legacy account: preselected is All Mail only', async () => {
    const { client } = allMailServer();
    const { channel, specs } = fakeChannel(() => [node('[Gmail]/All Mail')]);
    const src = createImapSource({ connect: async () => client });
    await src.manageFolders!(makeSession({ ...BASE }), channel);
    expect(specs[0].selected?.map((n) => n.id)).toEqual(['[Gmail]/All Mail']);
  });

  it('expands ancestors of a nested selection and serves roots/children', async () => {
    const { client } = folderServer();
    const cfg = { ...BASE, folderRoots: roots('Projects/Acme') };
    const { channel, specs } = fakeChannel(() => [node('Projects/Acme')]);
    const src = createImapSource({ connect: async () => client });
    await src.manageFolders!(makeSession(cfg), channel);
    expect(specs[0].expand).toEqual(['Projects']);
    const top = await specs[0].roots('mail');
    expect(top.map((n) => n.id)).toContain('Projects');
    expect((await specs[0].children('Projects')).map((n) => n.id)).toEqual([
      'Projects/Acme',
    ]);
  });

  it('does not preselect a root whose folder vanished', async () => {
    const { client } = folderServer();
    const cfg = { ...BASE, folderRoots: roots('INBOX', 'Gone') };
    const { channel, specs } = fakeChannel(() => [node('INBOX')]);
    const src = createImapSource({ connect: async () => client });
    await src.manageFolders!(makeSession(cfg), channel);
    expect(specs[0].selected?.map((n) => n.id)).toEqual(['INBOX']);
  });

  it('drops a picked id the model does not offer', async () => {
    const { client } = folderServer();
    const { channel } = fakeChannel(() => [node('INBOX'), node('Nope')]);
    const src = createImapSource({ connect: async () => client });
    const res = await src.manageFolders!(makeSession(declared()), channel);
    expect(res.config.folderRoots).toEqual(roots('INBOX'));
  });

  it('rejects a selection with only Trash/Junk (or nothing) and writes nothing', async () => {
    const { client } = folderServer();
    const src = createImapSource({ connect: async () => client });
    await expect(
      src.manageFolders!(
        makeSession(declared()),
        fakeChannel(() => [node('Trash')]).channel,
      ),
    ).rejects.toThrow(/at least one/i);
    await expect(
      src.manageFolders!(
        makeSession(declared()),
        fakeChannel(() => []).channel,
      ),
    ).rejects.toThrow(/at least one/i);
  });

  it('missing password is a SourceAuthError', async () => {
    const src = createImapSource({ connect: jest.fn() });
    await expect(
      src.manageFolders!(
        makeSession(declared(), { password: null }),
        fakeChannel(() => []).channel,
      ),
    ).rejects.toBeInstanceOf(SourceAuthError);
  });
});

// ── pull ────────────────────────────────────────────────────────────────────

describe('imap folder scope — pull', () => {
  it('syncs only the covered mailboxes and stamps every document with its root', async () => {
    const { client } = folderServer();
    const src = createImapSource({ connect: async () => client });
    const ctl = new AbortController();
    const session = makeSession(
      { ...BASE, folderRoots: roots('Projects', 'INBOX') },
      { signal: ctl.signal },
    );
    const items: ImapMessageItem[] = [];
    for await (const b of src.pull(session, null)) {
      items.push(...b.items);
      if (b.phase === 'live') ctl.abort();
    }
    expect(new Set(items.map((i) => i.mailbox))).toEqual(
      new Set(['INBOX', 'Projects/Acme']),
    );
    const docs = items.flatMap((i) => {
      const d = src.toDocument(i);
      return d === null ? [] : Array.isArray(d) ? d : [d];
    });
    expect(docs.some((d) => d.type === 'attachment')).toBe(true);
    for (const d of docs) {
      const { mailbox } = d.metadata as { mailbox: string };
      expect(d.scopeRootId).toBe(mailbox === 'INBOX' ? 'INBOX' : 'Projects');
    }
  });

  it('toDocument stamps message and attachments; leaves the key off without a root', () => {
    const src = createImapSource();
    const base: ImapMessageItem = {
      mailbox: 'X',
      uid: 1,
      uidValidity: '9',
      messageId: null,
      subject: 's',
      from: 'a@b.c',
      to: [],
      cc: [],
      replyTo: null,
      references: [],
      date: null,
      bodyText: 'b',
      headers: {},
      attachments: [{ index: 0, filename: 'f', mime: 'x/y', sizeBytes: 1 }],
    };
    const stamped = src.toDocument({
      ...base,
      scopeRootId: 'R',
    }) as DocumentInput[];
    expect(stamped.map((d) => d.scopeRootId)).toEqual(['R', 'R']);
    const bare = src.toDocument(base) as DocumentInput[];
    expect(
      bare.every((d) => !('scopeRootId' in d) || d.scopeRootId === undefined),
    ).toBe(true);
  });

  it('live loop re-LISTs: a subfolder created under a ticked root is synced as a backfill', async () => {
    const { client, boxes, log } = folderServer();
    const ctl = new AbortController();
    let sleeps = 0;
    const src = createImapSource({
      connect: async () => client,
      relistEveryPolls: 2,
      sleep: async () => {
        sleeps += 1;
        if (sleeps === 1) {
          boxes.push({
            path: 'Projects/New',
            parentPath: 'Projects',
            uidValidity: 7,
            messages: msgs(2),
          });
        }
        if (sleeps === 3) ctl.abort();
      },
    });
    const cfg = { ...BASE, folderRoots: roots('Projects') };
    const cur: ImapCursor = {
      mailboxes: {
        'Projects/Acme': { uidValidity: '6', lastUid: 2, attachments: 1 },
      },
    };
    const batches = await collect(
      src.pull(makeSession(cfg, { signal: ctl.signal, cursor: cur }), cur),
    );
    const fresh = batches.filter((b) =>
      b.items.some((i) => i.mailbox === 'Projects/New'),
    );
    expect(fresh).toHaveLength(1);
    expect(fresh[0].phase).toBe('backfill');
    expect(fresh[0].items[0].scopeRootId).toBe('Projects');
    // Σ exists of resolved mailboxes: Acme 2 + New 2.
    expect(fresh[0].estimateTotal).toBe(4);
    expect(log.filter((l) => l === 'list')).toHaveLength(2);
  });

  it('a mailbox that vanishes stops being polled and emits no deletions', async () => {
    const { client, boxes, log } = folderServer();
    const ctl = new AbortController();
    let sleeps = 0;
    const src = createImapSource({
      connect: async () => client,
      relistEveryPolls: 1,
      sleep: async () => {
        sleeps += 1;
        if (sleeps === 1)
          boxes.splice(
            boxes.findIndex((b) => b.path === 'Receipts'),
            1,
          );
        if (sleeps === 3) ctl.abort();
      },
    });
    const cfg = { ...BASE, folderRoots: roots('INBOX', 'Receipts') };
    const cur: ImapCursor = {
      mailboxes: {
        INBOX: { uidValidity: '1', lastUid: 2, attachments: 1 },
        Receipts: { uidValidity: '3', lastUid: 3, attachments: 1 },
      },
    };
    const batches = await collect(
      src.pull(makeSession(cfg, { signal: ctl.signal, cursor: cur }), cur),
    );
    expect(batches.flatMap((b) => b.deletions ?? [])).toEqual([]);
    const idx = log.indexOf('list', 1);
    expect(log.slice(idx).some((l) => l.endsWith('Receipts'))).toBe(false);
  });

  it('a re-LIST that resolves to nothing keeps the previous set and warns', async () => {
    const { client, log } = folderServer();
    const realList = client.listFolders.bind(client);
    let hide = false;
    client.listFolders = async () => (hide ? [] : realList());
    const ctl = new AbortController();
    const logs: Array<[string, string]> = [];
    let sleeps = 0;
    const src = createImapSource({
      connect: async () => client,
      relistEveryPolls: 1,
      sleep: async () => {
        sleeps += 1;
        hide = true;
        if (sleeps === 3) ctl.abort();
      },
    });
    const cfg = { ...BASE, folderRoots: roots('INBOX') };
    const cur: ImapCursor = {
      mailboxes: { INBOX: { uidValidity: '1', lastUid: 2, attachments: 1 } },
    };
    await collect(
      src.pull(
        makeSession(cfg, { signal: ctl.signal, cursor: cur, logs }),
        cur,
      ),
    );
    expect(logs.some(([l, m]) => l === 'warn' && /re-list/.test(m))).toBe(true);
    // INBOX kept being polled after the empty re-LIST (initial + 3 polls).
    expect(log.filter((l) => l === 'uids:INBOX').length).toBeGreaterThanOrEqual(
      3,
    );
  });

  it('still throws when declared roots resolve to nothing at start', async () => {
    const { client } = folderServer();
    const src = createImapSource({ connect: async () => client });
    await expect(
      collect(
        src.pull(makeSession({ ...BASE, folderRoots: roots('Gone') }), null),
      ),
    ).rejects.toThrow(/no syncable mailboxes/);
  });
});

// ── reconcile ───────────────────────────────────────────────────────────────

describe('imap folder scope — reconcile', () => {
  it('lists only resolved mailboxes', async () => {
    const { client, log } = folderServer();
    const src = createImapSource({ connect: async () => client });
    const pages = await collect(
      src.reconcile!(makeSession({ ...BASE, folderRoots: roots('Projects') })),
    );
    expect(pages.flat().map((r) => r.externalId)).toEqual([
      'Projects/Acme:6:1',
      'Projects/Acme:6:2',
    ]);
    expect(log.some((l) => l.endsWith('INBOX') || l.endsWith('Receipts'))).toBe(
      false,
    );
  });

  it('throws when every declared root vanished', async () => {
    const { client } = folderServer();
    const src = createImapSource({ connect: async () => client });
    await expect(
      collect(
        src.reconcile!(makeSession({ ...BASE, folderRoots: roots('Gone') })),
      ),
    ).rejects.toThrow(/no syncable mailboxes/);
  });
});
