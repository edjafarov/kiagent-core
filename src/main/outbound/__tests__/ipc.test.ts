import fs from 'fs';
import os from 'os';
import path from 'path';

import type {
  AccountId,
  DocumentInput,
  Prefs,
  Sender,
} from '@shared/contracts';
import type { Invokes } from '@shared/ipc';

import { openDb, type AppDb } from '../../db/app-db';
import { openStore, type CoreStore } from '../../core/store/store';
import { outboundInvokeHandlers } from '../ipc';
import { createOutboundService, type OutboundService } from '../service';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};

const logSink = { log: () => {} };

function fakePrefs(): Prefs {
  const p = {} as unknown as ReturnType<Prefs['get']>;
  return { get: () => p, patch: async () => {}, onChange: () => () => {} };
}

const emailDoc = (): DocumentInput => ({
  externalId: 'INBOX:1:100',
  type: 'email.message',
  title: 'Numbers',
  markdown: 'body',
  metadata: {
    from: 'Alice <alice@example.com>',
    to: ['me@example.com'],
    date: '2026-07-01T00:00:00Z',
    mailbox: 'INBOX',
    uid: 100,
    messageId: 'orig@x',
  },
  createdAt: '2026-07-01T00:00:00Z',
});

const IMAP_CFG = {
  host: 'imap.example.com',
  port: 993,
  secure: true,
  user: 'me@example.com',
};

type Handler = (req: unknown) => Promise<unknown> | unknown;

describe('outbound ipc delegate', () => {
  let dir: string;
  let db: AppDb;
  let store: CoreStore;
  let service: OutboundService;
  let docId: string;
  let sendMock: jest.Mock;
  let handlers: Map<string, Handler>;
  let opened: string[];

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-outipc-'));
    db = await openDb(path.join(dir, 'test.db'));
    store = openStore(db, deps);
    const account = await store.createAccount({
      source: 'imap',
      identifier: 'me@example.com@imap.example.com',
      config: IMAP_CFG,
    });
    await store.commit({
      account: account.id,
      documents: [emailDoc()],
      cursor: null,
    });
    const hits = await store.read.search({ limit: 10 });
    docId = hits[0].id as string;

    sendMock = jest.fn(async () => ({ externalMessageId: '<sent@x>' }));
    service = createOutboundService({
      store,
      prefs: fakePrefs(),
      senders: new Map<string, Sender>([['imap', { send: sendMock }]]),
      logSink,
    });
    service.setBaseUrl('http://127.0.0.1:7421');

    opened = [];
    handlers = new Map(
      Object.entries(
        outboundInvokeHandlers({
          service,
          store,
          openExternal: async (url) => {
            opened.push(url);
          },
        }),
      ) as Array<[string, Handler]>,
    );
  });

  afterEach(async () => {
    // The brief's harness omits this; service.test.ts:100-104 (its stated
    // source) has it. `openDb` is the worker-thread AppDb — leaking one
    // worker per test is a jest "failed to exit gracefully" warning.
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const invoke = <C extends keyof Invokes>(c: C, req: Invokes[C]['req']) =>
    handlers.get(c)!(req) as Promise<Invokes[C]['res']>;

  const tokenOf = (r: { confirm_url?: string }) =>
    r.confirm_url!.split('/outbox/confirm/')[1];

  it('registers the five outbox channels', () => {
    expect([...handlers.keys()].sort()).toEqual([
      'outbox:discard',
      'outbox:list',
      'outbox:open-confirm',
      'outbox:pending-count',
      'outbox:redraft',
    ]);
  });

  it('outbox:list maps rows to the panel shape', async () => {
    await service.draftReply({
      documentId: docId,
      body: 'A long body \n with newlines '.repeat(30),
    });
    const rows = await invoke('outbox:list', {});
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('draft');
    expect(rows[0].kind).toBe('reply');
    expect(rows[0].accountLabel).toBe('me@example.com@imap.example.com');
    expect(rows[0].bodyPreview.length).toBeLessThanOrEqual(140);
    expect(rows[0].bodyPreview).not.toMatch(/\n/);
    // A pending row carries no error projection at all.
    expect(rows[0].error).toBeNull();
    expect(rows[0].errorDetail).toBeNull();
    expect(rows[0].canRetry).toBe(false);
    expect(rows[0].deliveryUncertain).toBe(false);
  });

  it('outbox:list clamps the limit (a negative LIMIT is UNBOUNDED in SQLite)', async () => {
    await service.draftReply({ documentId: docId, body: 'a' });
    await service.draftReply({ documentId: docId, body: 'b' });
    expect(await invoke('outbox:list', { limit: -1 })).toHaveLength(1);
    expect(await invoke('outbox:list', { limit: 9999 })).toHaveLength(2);
  });

  it('outbox:list survives a payload-less invoke and a NaN limit', async () => {
    // `{ limit?: number }` is the only all-optional req in `Invokes`, and the
    // contextBridge erases types — `window.kiagent.invoke('outbox:list')`
    // reaches the handler as `undefined`. Destructuring in the parameter list
    // would TypeError on the panel's primary read.
    await service.draftReply({ documentId: docId, body: 'a' });
    expect(await handlers.get('outbox:list')!(undefined)).toHaveLength(1);
    // Number.isFinite guard: NaN/Infinity fall back to 50, they do not
    // poison Math.floor/min/max into a NaN LIMIT.
    expect(await invoke('outbox:list', { limit: NaN })).toHaveLength(1);
    expect(await invoke('outbox:list', { limit: Infinity })).toHaveLength(1);
  });

  it('outbox:list sweeps overdue drafts before reading (no stale "draft" row)', async () => {
    // Without `expireOverdue()` first, the panel shows a 'draft' row whose
    // "Review & send" then dies with a status error. `create()` runs its own
    // sweep BEFORE its insert, so a past expiresAt survives creation — which
    // is exactly what makes this row a faithful stale-draft fixture.
    const account = (await store.read.accounts())[0];
    await store.outbox.create({
      accountId: account.id,
      kind: 'new',
      recipientDisplay: 'bob@example.com',
      to: ['bob@example.com'],
      cc: [],
      subject: 'stale',
      bodyMarkdown: 'body',
      confirmMode: 'review',
      createdVia: 'mcp-local',
      expiresAt: '2020-01-01T00:00:00Z',
    });

    const [row] = await invoke('outbox:list', {});
    expect(row.status).toBe('expired'); // 'draft' if the sweep is dropped
  });

  it('outbox:list shapes failed rows and marks ambiguity', async () => {
    sendMock.mockRejectedValueOnce(new Error('socket hang up'));
    const r = await service.draftReply({ documentId: docId, body: 'x' });
    await service.confirmByToken(tokenOf(r));

    const [row] = await invoke('outbox:list', {});
    expect(row.status).toBe('failed');
    expect(row.canRetry).toBe(false);
    expect(row.deliveryUncertain).toBe(true);
    // Human sentence up front, technical one-liner behind <details>.
    expect(row.error).toMatch(/could not confirm delivery/i);
    expect(row.errorDetail).toContain('socket hang up');
    expect(row.error).not.toBe(row.errorDetail);
  });

  it('outbox:list marks a provably-not-sent failure retryable', async () => {
    sendMock.mockRejectedValueOnce(
      new Error('smtp transient 421: mailbox busy'),
    );
    const r = await service.draftReply({ documentId: docId, body: 'x' });
    await service.confirmByToken(tokenOf(r));

    const [row] = await invoke('outbox:list', {});
    expect(row.canRetry).toBe(true);
    expect(row.deliveryUncertain).toBe(false);
  });

  it('outbox:list does not mark an unsupported-class failure uncertain', async () => {
    // THE posture gate. Both other failure fixtures agree under either rule,
    // so `deliveryUncertain = shaped.kind === 'unknown'` and the tempting
    // `!shaped.canRetry` are indistinguishable without this case: an
    // unsupported-source failure is canRetry:false but PROVABLY not sent, so
    // it keeps its one-click "Draft again". `!canRetry` would hide it.
    sendMock.mockRejectedValueOnce(
      new Error(
        `sending from 'x' accounts is not supported yet — supported: imap`,
      ),
    );
    const r = await service.draftReply({ documentId: docId, body: 'x' });
    await service.confirmByToken(tokenOf(r));

    const [row] = await invoke('outbox:list', {});
    expect(row.status).toBe('failed');
    expect(row.canRetry).toBe(false);
    expect(row.deliveryUncertain).toBe(false);
  });

  it('outbox:list passes a delivery_unknown sentence through verbatim', async () => {
    const r = await service.draftReply({ documentId: docId, body: 'x' });
    const sentence =
      'the app closed while sending — the message may have been sent; ' +
      'check the Sent folder before re-drafting';
    await store.outbox.transition(r.draft_id, ['draft'], 'delivery_unknown', {
      error: sentence,
    });

    const [row] = await invoke('outbox:list', {});
    expect(row.status).toBe('delivery_unknown');
    // Re-shaping would wrap this perfectly good sentence in `send failed: `.
    expect(row.error).toBe(sentence);
    expect(row.errorDetail).toBeNull();
    expect(row.canRetry).toBe(false);
    expect(row.deliveryUncertain).toBe(true);
  });

  it('outbox:list never shows a stale error on a retried row', async () => {
    // The regression this gate exists for: `transition` only ever SETs patch
    // fields (outbox.ts:42-48), so a failed→sent row keeps its old error
    // string in the DB by design. Reading it ungated paints red text on a
    // green row.
    sendMock.mockRejectedValueOnce(
      new Error('smtp transient 421: mailbox busy'),
    );
    const r = await service.draftReply({ documentId: docId, body: 'x' });
    await service.confirmByToken(tokenOf(r));
    expect((await invoke('outbox:list', {}))[0].canRetry).toBe(true);

    // Try again: re-confirm the SAME row via a freshly minted panel URL.
    const retryUrl = await service.confirmUrlFor(r.draft_id);
    const outcome = await service.confirmByToken(
      retryUrl!.split('/outbox/confirm/')[1],
    );
    expect(outcome.kind).toBe('sent');

    const [row] = await invoke('outbox:list', {});
    expect(row.status).toBe('sent');
    expect(row.error).toBeNull();
    expect(row.errorDetail).toBeNull();
    expect(row.canRetry).toBe(false);
    expect(row.deliveryUncertain).toBe(false);
    expect((await store.outbox.get(r.draft_id))?.error).not.toBeNull(); // audit trail intact
  });

  // ── Task 9: status filter, keyset cursor, pending-count, to/cc ──────────

  /** Same ordering `list`/`listRecent` use: `created_at DESC, id DESC`. UUIDv7
   *  ids and ISO timestamps are both plain ASCII, so JS's default string
   *  comparison agrees with SQLite's BINARY collation — sorting the seeded
   *  rows in JS independently pins the SAME order the SQL query produces,
   *  rather than re-deriving it from another call to the code under test. */
  function newestFirst<T extends { createdAt: string; id: string }>(
    rows: T[],
  ): T[] {
    return [...rows].sort((a, b) => {
      if (a.createdAt !== b.createdAt) {
        return a.createdAt < b.createdAt ? 1 : -1;
      }
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    });
  }

  /** Directly seeds one outbox row (bypassing the outbound service, which
   *  only ever makes 'reply' rows against `docId`) so tests can build a
   *  large, mixed-status, mixed-account fixture cheaply. Mirrors the
   *  'sweeps overdue' test's own direct `store.outbox.create` call above. */
  async function seedRow(over: {
    accountId: AccountId;
    to?: string[];
    cc?: string[];
    status?: 'draft' | 'sent' | 'discarded';
    /** Stamped directly onto the row after insert (mirrors task 8's
     *  `seedDraft` in outbox.test.ts) — `OutboxDraftInput` has no such field,
     *  since `create()` always stamps `deps.now()`. Lets a test force a
     *  `created_at` TIE between rows to exercise the `id DESC` tie-break. */
    createdAt?: string;
  }) {
    const row = await store.outbox.create({
      accountId: over.accountId,
      kind: 'new',
      recipientDisplay: (over.to ?? ['bob@example.com'])[0],
      to: over.to ?? ['bob@example.com'],
      cc: over.cc ?? [],
      subject: 'seed',
      bodyMarkdown: 'body',
      confirmMode: 'review',
      createdVia: 'mcp-local',
      expiresAt: '2099-01-01T00:00:00Z',
    });
    if (over.createdAt !== undefined) {
      await db.run(`UPDATE outbox SET created_at = ? WHERE id = ?`, [
        over.createdAt,
        row.id,
      ]);
    }
    if (over.status && over.status !== 'draft') {
      await store.outbox.transition(row.id, ['draft'], over.status);
      const fresh = await store.outbox.get(row.id);
      if (!fresh) throw new Error('seedRow: readback failed');
      return fresh;
    }
    if (over.createdAt !== undefined) {
      const fresh = await store.outbox.get(row.id);
      if (!fresh) throw new Error('seedRow: readback failed');
      return fresh;
    }
    return row;
  }

  it('keeps every field and the listing semantics it has today', async () => {
    const account = (await store.read.accounts())[0];
    // 15 drafts (well under OUTBOX_PENDING_CAP=20) + 45 sent rows: > the
    // default limit of 50, mixed statuses, one account — exactly what
    // today's status-blind `outbox:list` would have to cope with.
    const seeded = [];
    for (let i = 0; i < 15; i++) {
      seeded.push(await seedRow({ accountId: account.id, status: 'draft' }));
    }
    for (let i = 0; i < 45; i++) {
      seeded.push(await seedRow({ accountId: account.id, status: 'sent' }));
    }

    const rowsArr = (await handlers.get('outbox:list')!(
      undefined,
    )) as Invokes['outbox:list']['res'];
    expect(rowsArr).toHaveLength(50); // default limit unchanged
    expect(rowsArr).toEqual(await invoke('outbox:list', { limit: 50 }));
    // Pin the SHAPE against a literal, not against another call to the same
    // implementation.
    expect(Object.keys(rowsArr[0]).sort()).toEqual([
      'accountLabel',
      'bodyPreview',
      'canRetry',
      'cc',
      'createdAt',
      'deliveryUncertain',
      'draftId',
      'error',
      'errorDetail',
      'kind',
      'recipientDisplay',
      'sentAt',
      'status',
      'subject',
      'to',
    ]);
    expect(rowsArr.map((r) => r.draftId)).toEqual(
      newestFirst(seeded)
        .slice(0, 50)
        .map((r) => r.id),
    );
  });

  it('filters by status', async () => {
    const account = (await store.read.accounts())[0];
    for (let i = 0; i < 5; i++) {
      await seedRow({ accountId: account.id, status: 'draft' });
    }
    for (let i = 0; i < 5; i++) {
      await seedRow({ accountId: account.id, status: 'sent' });
    }
    const rows = await invoke('outbox:list', { status: ['draft'] });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.status === 'draft')).toBe(true);
  });

  it('an empty status array matches nothing (not "no filter")', async () => {
    // `status` omitted/absent means every row (today's default, pinned
    // above); `status: []` — present but deliberately empty — must mean the
    // opposite: match nothing. A UI status-picker with nothing checked asks
    // for zero rows, and silently falling back to "everything" is the worst
    // possible failure direction for an outbox view.
    const account = (await store.read.accounts())[0];
    await seedRow({ accountId: account.id, status: 'draft' });
    await seedRow({ accountId: account.id, status: 'sent' });
    expect(await invoke('outbox:list', { status: [] })).toEqual([]);
    // Sanity: the table is non-empty and the default call proves it, so the
    // empty result above is a real filter-to-nothing, not an empty fixture.
    expect((await invoke('outbox:list', {})).length).toBeGreaterThan(0);
  });

  it('pages with the before cursor, jointly covering every row with no gap', async () => {
    // Two accounts so 30 drafts clears the per-account cap of 20.
    const accountA = (await store.read.accounts())[0];
    const accountB = await store.createAccount({
      source: 'imap',
      identifier: 'second@example.com@imap.example.com',
      config: IMAP_CFG,
    });
    const seeded = [];
    for (let i = 0; i < 15; i++) {
      seeded.push(await seedRow({ accountId: accountA.id, status: 'draft' }));
    }
    for (let i = 0; i < 15; i++) {
      seeded.push(await seedRow({ accountId: accountB.id, status: 'draft' }));
    }

    const first = await invoke('outbox:list', {
      status: ['draft'],
      limit: 20,
    });
    expect(first).toHaveLength(20);
    const tail = first[first.length - 1];
    const second = await invoke('outbox:list', {
      status: ['draft'],
      limit: 20,
      before: { createdAt: tail.createdAt, draftId: tail.draftId },
    });
    expect(second).toHaveLength(10); // 30 seeded - the first page's 20
    const firstIds = new Set(first.map((r) => r.draftId));
    // No duplicate: nothing from the first page reappears on the second.
    expect(second.some((r) => firstIds.has(r.draftId))).toBe(false);
    expect(second.map((r) => r.draftId)).not.toContain(tail.draftId);
    // No gap: the two pages TOGETHER are exactly the 30 seeded rows — the
    // mapping between the IPC wire cursor (`before.draftId`) and the store's
    // keyset cursor (`before.id`) is exactly where a page could silently
    // drop or duplicate a row, and the store layer (task 8's suite) cannot
    // catch a bug that only exists in this handler's mapping.
    const joint = [...first, ...second].map((r) => r.draftId);
    expect(new Set(joint).size).toBe(30);
    expect(new Set(joint)).toEqual(new Set(seeded.map((r) => r.id)));
  });

  it('holds the id-DESC tie-break across a page boundary when created_at ties', async () => {
    // Every row shares the exact same created_at: the ONLY thing that can
    // keep paging correct is the secondary `id DESC` sort, and the ONLY thing
    // that can keep it correct across a page boundary is passing both
    // `createdAt` AND `draftId` through the `before` cursor — either one
    // dropped at the IPC↔store mapping would reshuffle or duplicate rows.
    const account = (await store.read.accounts())[0];
    const tiedAt = '2026-01-01T00:00:00.000Z';
    const seeded = [];
    for (let i = 0; i < 10; i++) {
      seeded.push(
        await seedRow({
          accountId: account.id,
          status: 'draft',
          createdAt: tiedAt,
        }),
      );
    }
    const byIdDesc = [...seeded].sort((a, b) => (a.id < b.id ? 1 : -1));

    const first = await invoke('outbox:list', { status: ['draft'], limit: 4 });
    expect(first.map((r) => r.draftId)).toEqual(
      byIdDesc.slice(0, 4).map((r) => r.id),
    );
    const tail = first[first.length - 1];
    const second = await invoke('outbox:list', {
      status: ['draft'],
      limit: 4,
      before: { createdAt: tail.createdAt, draftId: tail.draftId },
    });
    expect(second.map((r) => r.draftId)).toEqual(
      byIdDesc.slice(4, 8).map((r) => r.id),
    );
    const joint = [...first, ...second].map((r) => r.draftId);
    expect(new Set(joint).size).toBe(8); // no duplicate across the tie
  });

  it('outbox:pending-count sweeps overdue drafts before counting', async () => {
    const account = (await store.read.accounts())[0];
    await store.outbox.create({
      accountId: account.id,
      kind: 'new',
      recipientDisplay: 'bob@example.com',
      to: ['bob@example.com'],
      cc: [],
      subject: 'stale',
      bodyMarkdown: 'body',
      confirmMode: 'review',
      createdVia: 'mcp-local',
      expiresAt: '2020-01-01T00:00:00Z',
    });
    const result = await invoke('outbox:pending-count', undefined);
    // Without the sweep this expired-on-arrival draft would still count.
    expect(result).toEqual({ pending: await store.outbox.countPending() });
    expect(result.pending).toBe(0);
  });

  it('carries recipient addresses verbatim across the three cc shapes issue #113 names', async () => {
    const account = (await store.read.accounts())[0];
    // Shape 1: 'neither' — to only, no cc at all (today's already-covered
    // shape: a plain draft with nobody cc'd).
    await seedRow({
      accountId: account.id,
      to: ['a@example.com'],
      cc: [],
      status: 'draft',
    });
    // Shape 2: 'one' — a single cc address alongside to.
    await seedRow({
      accountId: account.id,
      to: ['b@example.com'],
      cc: ['cc1@example.com'],
      status: 'draft',
    });
    // Shape 3: 'both' — multiple to AND multiple cc addresses.
    await seedRow({
      accountId: account.id,
      to: ['c1@example.com', 'c2@example.com'],
      cc: ['cc2@example.com', 'cc3@example.com'],
      status: 'draft',
    });

    const rows = await invoke('outbox:list', { status: ['draft'], limit: 10 });
    const byFirstTo = new Map(rows.map((r) => [r.to[0], r]));

    expect(byFirstTo.get('a@example.com')?.to).toEqual(['a@example.com']);
    expect(byFirstTo.get('a@example.com')?.cc).toEqual([]);

    expect(byFirstTo.get('b@example.com')?.to).toEqual(['b@example.com']);
    expect(byFirstTo.get('b@example.com')?.cc).toEqual(['cc1@example.com']);

    expect(byFirstTo.get('c1@example.com')?.to).toEqual([
      'c1@example.com',
      'c2@example.com',
    ]);
    expect(byFirstTo.get('c1@example.com')?.cc).toEqual([
      'cc2@example.com',
      'cc3@example.com',
    ]);
  });

  it('outbox:discard discards pending drafts and tolerates races', async () => {
    const r = await service.draftReply({ documentId: docId, body: 'x' });
    await invoke('outbox:discard', { draftId: r.draft_id });
    expect((await store.outbox.get(r.draft_id))?.status).toBe('discarded');
    await invoke('outbox:discard', { draftId: r.draft_id }); // second: no throw
  });

  it('outbox:open-confirm opens actionable rows and names the status otherwise', async () => {
    const r = await service.draftReply({ documentId: docId, body: 'x' });
    await invoke('outbox:open-confirm', { draftId: r.draft_id });
    expect(opened[0]).toContain('/outbox/confirm/');

    await invoke('outbox:discard', { draftId: r.draft_id });
    await expect(
      invoke('outbox:open-confirm', { draftId: r.draft_id }),
    ).rejects.toThrow(/status is 'discarded'/);
  });

  it('outbox:redraft creates a fresh draft and opens its page', async () => {
    sendMock.mockRejectedValueOnce(new Error('socket hang up'));
    const r = await service.draftReply({ documentId: docId, body: 'orig' });
    await service.confirmByToken(tokenOf(r));

    const { draftId } = await invoke('outbox:redraft', { draftId: r.draft_id });
    expect(draftId).not.toBe(r.draft_id);
    expect((await store.outbox.get(draftId))?.status).toBe('draft');
    expect((await store.outbox.get(draftId))?.createdVia).toBe('panel');
    expect(opened.some((u) => u.includes('/outbox/confirm/'))).toBe(true);
  });

  it('reports a cold local server in human words', async () => {
    const cold = createOutboundService({
      store,
      prefs: fakePrefs(),
      senders: new Map<string, Sender>([['imap', { send: sendMock }]]),
      logSink,
    }); // never setBaseUrl'd
    const coldHandlers = new Map(
      Object.entries(
        outboundInvokeHandlers({
          service: cold,
          store,
          openExternal: async () => {},
        }),
      ) as Array<[string, Handler]>,
    );
    const r = await service.draftReply({ documentId: docId, body: 'x' });
    await expect(
      coldHandlers.get('outbox:open-confirm')!({ draftId: r.draft_id }),
    ).rejects.toThrow(/local server is not running/);
  });
});
