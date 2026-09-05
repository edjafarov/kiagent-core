/**
 * `applyFolderScope` — the ONE transaction a folder-scope edit gets, plus the
 * `scope_root_id` write path it reads.
 *
 * Everything here runs against a real migrated corpus on the in-process
 * (`db._conn`) path, which is the same `createWriteTx` handle the DB worker
 * registers (see db/worker-entry.ts). The worker RPC round-trip is pinned
 * separately in db/__tests__/db-worker.test.ts.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

import type { AccountId, DocumentInput } from '@shared/contracts';

import { openDb, type AppDb } from '../../../db/app-db';
import { migrate } from '../schema';
import { openStore } from '../store';
import type { CoreStore } from '../store';
import { withLegacyMirror } from '../write-tx';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};

/** `scopeRootId` omitted entirely models the R5 case: the source could not
 *  resolve a root, so the engine emits the document anyway and the store
 *  warns once — it never throws. What the column ends up holding depends on
 *  the branch (C-13): a NEW row lands NULL, an EXISTING row keeps whatever
 *  stamp it already had, because the UPDATE binds
 *  `scope_root_id = COALESCE(?, scope_root_id)`. */
const doc = (externalId: string, scopeRootId?: string): DocumentInput => ({
  externalId,
  type: 'file',
  title: externalId,
  markdown: `body of ${externalId}`,
  metadata: {},
  createdAt: '2026-01-01T00:00:00Z',
  ...(scopeRootId === undefined ? {} : { scopeRootId }),
});

const CONFIG_V1 = {
  folderRoots: [
    { id: 'root', name: 'My Drive' },
    { id: 'X', name: 'Reports' },
  ],
};
const CURSOR_V1 = {
  page_token: 'p1',
  backfill_done: true,
  scope_roots: ['root', 'X'],
};

describe('folder scope write path', () => {
  let dir: string;
  let db: AppDb;
  let store: CoreStore;
  let accountId: AccountId;
  let warnSpy: jest.SpyInstance;

  const liveCount = async (): Promise<number> =>
    Number(
      (
        (await db.all(
          `SELECT COUNT(*) AS n FROM documents
            WHERE account_id = ? AND archived_at IS NULL`,
          [accountId],
        )) as Array<{ n: number }>
      )[0].n,
    );

  const changesCount = async (): Promise<number> =>
    Number(
      (
        (await db.all(`SELECT COUNT(*) AS n FROM changes`)) as Array<{
          n: number;
        }>
      )[0].n,
    );

  const configJson = async (id: AccountId): Promise<string> =>
    JSON.stringify((await store.account(id))!.config);

  beforeEach(async () => {
    // Installed BEFORE the seed commit: once Step 3 lands, seeding doc('d')
    // on a folder-scoped account emits exactly one R5 warn per beforeEach.
    // Same idiom as file-indexability-migration.test.ts:436.
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-folder-scope-'));
    db = await openDb(path.join(dir, 'test.db'));
    store = openStore(db, deps);
    accountId = (
      await store.createAccount({
        source: 'google-docs',
        identifier: 'me@example.com',
        config: CONFIG_V1,
      })
    ).id;
    await store.commit({
      account: accountId,
      documents: [doc('a', 'root'), doc('b', 'X'), doc('c', 'X'), doc('d')],
      cursor: CURSOR_V1,
    });
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    warnSpy.mockRestore();
  });

  it('persists DocumentInput.scopeRootId, and NULL when the source could not resolve one', async () => {
    const a = await store.read.byExternalId(accountId, 'a', 'file');
    const b = await store.read.byExternalId(accountId, 'b', 'file');
    const d = await store.read.byExternalId(accountId, 'd', 'file');
    expect(a?.scopeRootId).toBe('root');
    expect(b?.scopeRootId).toBe('X');
    expect(d?.scopeRootId).toBeNull();
  });

  it('re-stamps scope_root_id when the document CONTENT also changed', async () => {
    await store.commit({
      account: accountId,
      // same externalId, changed body -> contentHash differs -> UPDATE branch
      documents: [{ ...doc('b', 'root'), markdown: 'body of b, edited' }],
      cursor: CURSOR_V1,
    });
    const b = await store.read.byExternalId(accountId, 'b', 'file');
    expect(b?.scopeRootId).toBe('root');
  });

  it('a train-1 upsert that says nothing about scope leaves the existing stamp intact (C-13)', async () => {
    // DECISIONS C-13, and the reason the UPDATE binds
    // `scope_root_id = COALESCE(?, scope_root_id)` rather than
    // `input.scopeRootId ?? null`. A TRAIN-1 connector — the installed
    // gdocs 2.1.6 / onedrive 2.0.5, which know nothing about `scopeRootId` —
    // re-pulls CHANGED content and emits no scope at all. Under `?? null`
    // that blanks the v3 migration's stamp — and a blank stamp is invisible
    // to every `IN`-list a future Save can compute, so the document can never
    // leave scope again, and no walk ever re-attributes it (a LIVE row with
    // unchanged content and extraction status is never re-stamped: both
    // connectors' hashSkip is `if (!existing || existing.archivedAt) return
    // false;`, and upsertDocument early-returns on `content_hash === hash &&
    // archived_at === null`). It becomes an outright LOSS again the day
    // train 2 ships C-34's archive-AFTER-proof branch. NULL from a connector
    // therefore means "no opinion", never "clear the stamp". This test is
    // now the WHOLE pin: C-34 deleted the Step 5 repair test that used to be
    // its other half, together with the branch that test exercised.
    // 'b' was stamped by the seed commit's INSERT, and that stands in for a
    // v3-migrated row deliberately: it is the only way to get a stamped row
    // in this suite, and it is the STRICTER fixture. A hand-written
    // `UPDATE documents SET scope_root_id='X'` stamp would leave this test
    // GREEN at Step 2 — the pre-Step-3 UPDATE never touches the column at
    // all — so the RED below only exists because the seed's INSERT is what
    // put the stamp there.
    await store.commit({
      account: accountId,
      documents: [
        { ...doc('b'), markdown: 'body of b, edited by a train-1 connector' },
      ],
      cursor: CURSOR_V1,
    });
    const b = await store.read.byExternalId(accountId, 'b', 'file');
    expect(b?.scopeRootId).toBe('X');
    // the CONTENT did land — this is the UPDATE branch, not a short-circuit
    expect(b?.markdown).toBe('body of b, edited by a train-1 connector');
  });

  it('does NOT re-stamp when only the scope changed — contentHash excludes scope', async () => {
    // This is the invariant the whole task exists for. `contentHash`
    // (write-tx.ts:25-37) hashes title/markdown/url/metadata/createdAt and
    // nothing else, so `upsertDocument` returns null for an unchanged live
    // row and never touches it. A re-pull therefore cannot repair a stale or
    // NULL `scope_root_id` — `applyFolderScope` is the only path that can.
    await store.commit({
      account: accountId,
      documents: [doc('b', 'root')], // identical content, different root
      cursor: CURSOR_V1,
    });
    const b = await store.read.byExternalId(accountId, 'b', 'file');
    expect(b?.scopeRootId).toBe('X');
  });

  it('warns once for an unattributable document and NEVER throws (R5)', async () => {
    // DECISIONS R5: a folder-scoped document with no resolvable root leaves
    // a NEW row's scope_root_id NULL — and an EXISTING row's stamp UNTOUCHED,
    // because C-13's UPDATE binds `COALESCE(?, scope_root_id)` — and logs ONE
    // warn {accountId, source, externalId}. "Omitted means NULL" is only true
    // of the INSERT branch; on the UPDATE branch it means "no opinion". A
    // throw here
    // lands in engine.ts's per-batch loop, fails the whole pull attempt,
    // burns the 5-retry ladder and parks the account in status:'error' — one
    // unattributable file would poison an entire account, and core's own
    // local-folder/watch.ts:168 yields items whose rootOf() is undefined ON
    // PURPOSE. The commit must therefore RESOLVE.
    warnSpy.mockClear(); // the seed commit already warned once, for 'd'
    const seq = await store.commit({
      account: accountId,
      documents: [doc('e'), doc('f', 'X')],
      cursor: CURSOR_V1,
    });
    expect(typeof seq).toBe('number');

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      'commit: no resolvable folder root — scope_root_id not stamped by this commit',
      { accountId, source: 'google-docs', externalId: 'e' },
    );

    expect(
      (await store.read.byExternalId(accountId, 'e', 'file'))?.scopeRootId,
    ).toBeNull();
    expect(
      (await store.read.byExternalId(accountId, 'f', 'file'))?.scopeRootId,
    ).toBe('X');
  });

  it('does NOT warn for an account that is not folder-scoped', async () => {
    // Without the gate every imap / gmail / whatsapp document — and every
    // worker enrichment under the synthetic 'worker' account, whose config is
    // the literal '{}' — would warn on every commit, because those sources
    // never set `scopeRootId` at all. The gate reads the CANONICAL marker
    // `config.folderRoots` (contracts' FolderScopedConfig), not a hard-coded
    // source list, so a fourth folder-scoped source is covered the day it
    // ships.
    const imapId = (
      await store.createAccount({
        source: 'imap',
        identifier: 'me@example.com',
        config: { host: 'imap.example.com' },
      })
    ).id;
    warnSpy.mockClear();
    await store.commit({
      account: imapId,
      documents: [doc('m1')],
      cursor: null,
    });
    expect(warnSpy).not.toHaveBeenCalled();
    expect(
      (await store.read.byExternalId(imapId, 'm1', 'file'))?.scopeRootId,
    ).toBeNull();
  });

  it('archives NOTHING when the source hands back an empty set — the common happy path', async () => {
    const config = { folderRoots: [{ id: 'root', name: 'My Drive' }] };
    const cursor = {
      page_token: 'p1',
      backfill_done: true,
      scope_roots: ['root'],
    };

    const result = await store.applyFolderScope({
      accountId,
      config,
      cursor,
      // 'X' was DESELECTED but is still covered by the retained catch-all
      // 'root', so nothing leaves scope. DECISIONS R8/A-1: the SOURCE alone
      // knows containment and says so with an EMPTY array; core must never
      // re-derive an archive set by set-difference over `folderRoots`, which
      // would archive b and c here — and, on the real production account, all
      // 314 rows whose historical stamp `hashSkip` froze.
      archiveScopeRootIds: [],
      reattributeScopeRoots: [],
      expectedConfigJson: await configJson(accountId),
    });

    expect(result).toEqual({
      archived: 0,
      reattributed: 0,
      remaining: 4,
      stale: false,
    });

    const after = await store.account(accountId);
    expect(after!.config.folderRoots).toEqual(config.folderRoots);
    expect(after!.cursor).toEqual(cursor);
    expect(await liveCount()).toBe(4);
  });

  it('archives exactly the scope_root_id values the source listed, feed-visibly', async () => {
    const result = await store.applyFolderScope({
      accountId,
      config: { folderRoots: [{ id: 'root', name: 'My Drive' }] },
      cursor: { page_token: 'p1', backfill_done: false, scope_roots: ['root'] },
      // b and c. 'a' keeps 'root'; 'd' is NULL-scoped and stays LIVE — that
      // is the other half of C-34's pin that nothing in this train archives an
      // unattributable row, and Step 16's mutation 2 is where it bites.
      archiveScopeRootIds: ['X'],
      reattributeScopeRoots: [],
      expectedConfigJson: await configJson(accountId),
    });
    expect(result).toEqual({
      archived: 2,
      reattributed: 0,
      remaining: 2,
      stale: false,
    });

    // Archiving is feed-visible, never a raw delete: one `changes` row per
    // archived document, with documents.seq set to that same change's seq.
    const rows = (await db.all(
      `SELECT d.external_id AS e, c.kind AS kind
         FROM documents d JOIN changes c ON c.ref_id = d.id AND c.seq = d.seq
        WHERE d.account_id = ? AND d.archived_at IS NOT NULL
        ORDER BY d.external_id`,
      [accountId],
    )) as Array<{ e: string; kind: string }>;
    expect(rows).toEqual([
      { e: 'b', kind: 'document' },
      { e: 'c', kind: 'document' },
    ]);
  });

  // ── C-46/D5: re-attribution, the third verb ────────────────────────────
  //
  // The only two things a source could say about a removed root were
  // "archive it" and nothing. Both are wrong when a RETAINED root still
  // covers it: archiving forces a re-download of the whole subtree and opens
  // a window in which the user's documents are not searchable, while silence
  // freezes the stale stamp forever — `hashSkip` never refreshes a live row,
  // so a later save that removes the COVERING root cannot match those rows
  // either (C-46/D3). Re-attribution is one UPDATE inside the same
  // transaction, no network, no gap.

  it('C-46/D5: re-stamps live rows from → to, archives nothing, and counts them', async () => {
    const result = await store.applyFolderScope({
      accountId,
      config: { folderRoots: [{ id: 'root', name: 'My Drive' }] },
      cursor: { page_token: 'p1', backfill_done: true, scope_roots: ['root'] },
      // 'X' was removed but the retained catch-all really does cover it, so
      // its documents stay in scope under 'root'.
      archiveScopeRootIds: [],
      reattributeScopeRoots: [{ from: 'X', to: 'root' }],
      expectedConfigJson: await configJson(accountId),
    });

    expect(result).toEqual({
      archived: 0,
      reattributed: 2, // b and c
      remaining: 4,
      stale: false,
    });
    expect(
      (await store.read.byExternalId(accountId, 'b', 'file'))?.scopeRootId,
    ).toBe('root');
    expect(
      (await store.read.byExternalId(accountId, 'c', 'file'))?.scopeRootId,
    ).toBe('root');
    // 'a' was already 'root' and 'd' is NULL — neither is touched, and NULL
    // is never swept up by a re-attribution (A-3 still holds).
    expect(
      (await store.read.byExternalId(accountId, 'a', 'file'))?.scopeRootId,
    ).toBe('root');
    expect(
      (await store.read.byExternalId(accountId, 'd', 'file'))?.scopeRootId,
    ).toBeNull();
    expect(await liveCount()).toBe(4);
  });

  it('C-46/D5: writes NO document `changes` row — scope attribution must not churn the feed', async () => {
    const docChangeCount = async (): Promise<number> =>
      Number(
        (
          (await db.all(
            `SELECT COUNT(*) AS n FROM changes WHERE kind = 'document'`,
          )) as Array<{ n: number }>
        )[0].n,
      );
    const before = await changesCount();
    const docsBefore = await docChangeCount(); // the seed commit's four

    const seqBefore = (await db.all(
      `SELECT external_id AS e, seq FROM documents
        WHERE account_id = ? AND external_id IN ('b','c') ORDER BY external_id`,
      [accountId],
    )) as Array<{ e: string; seq: number }>;

    await store.applyFolderScope({
      accountId,
      config: { folderRoots: [{ id: 'root', name: 'My Drive' }] },
      cursor: CURSOR_V1,
      archiveScopeRootIds: [],
      reattributeScopeRoots: [{ from: 'X', to: 'root' }],
      expectedConfigJson: await configJson(accountId),
    });

    // `scope_root_id` is not user-visible content: a re-attribution must not
    // resurface two documents in the user's feed. The ONE new row is the
    // account change every Save writes.
    // The re-attribution DID happen — without this the two counts below are
    // trivially satisfied by an implementation that does nothing at all.
    expect(
      (await store.read.byExternalId(accountId, 'b', 'file'))?.scopeRootId,
    ).toBe('root');

    expect(await changesCount()).toBe(before + 1);
    expect(await docChangeCount()).toBe(docsBefore);
    // …and `seq` is left alone too, so nothing shows up as recently updated.
    const seqAfter = (await db.all(
      `SELECT external_id AS e, seq FROM documents
        WHERE account_id = ? AND external_id IN ('b','c') ORDER BY external_id`,
      [accountId],
    )) as Array<{ e: string; seq: number }>;
    expect(seqAfter).toEqual(seqBefore);
  });

  it('C-46/D5: THROWS when a root is named in both arrays, and writes nothing at all', async () => {
    const configBefore = await configJson(accountId);

    // A source that says one root both leaves scope and does not has a bug.
    // Core refuses to pick an order between two opposite outcomes.
    await expect(
      store.applyFolderScope({
        accountId,
        config: { folderRoots: [{ id: 'root', name: 'My Drive' }] },
        cursor: CURSOR_V1,
        archiveScopeRootIds: ['X'],
        reattributeScopeRoots: [{ from: 'X', to: 'root' }],
        expectedConfigJson: configBefore,
      }),
    ).rejects.toThrow(/both archived and re-attributed/i);

    // The whole transaction rolled back: config, cursor and every row.
    expect(await configJson(accountId)).toBe(configBefore);
    expect(await liveCount()).toBe(4);
    expect(
      (await store.read.byExternalId(accountId, 'b', 'file'))?.scopeRootId,
    ).toBe('X');
  });

  it('C-46/D5: applies BEFORE the archive step, so a re-attributed row can then be archived under its new root', async () => {
    // The only observable consequence of the ordering. `from` 'X' is not in
    // the archive list, so the guard does not fire; 'root' is, and b/c have
    // just become 'root'.
    const result = await store.applyFolderScope({
      accountId,
      config: { folderRoots: [{ id: 'Y', name: 'Other' }] },
      cursor: CURSOR_V1,
      archiveScopeRootIds: ['root'],
      reattributeScopeRoots: [{ from: 'X', to: 'root' }],
      expectedConfigJson: await configJson(accountId),
    });

    expect(result.reattributed).toBe(2);
    expect(result.archived).toBe(3); // a, plus the re-stamped b and c
    expect(await liveCount()).toBe(1); // only NULL-scoped 'd'
  });

  it('C-46/D5: is idempotent, ignores ARCHIVED rows, and an empty array is a no-op', async () => {
    // Step 1 — archive 'X'. b and c are now archived and still stamped 'X'.
    await store.applyFolderScope({
      accountId,
      config: { folderRoots: [{ id: 'root', name: 'My Drive' }] },
      cursor: CURSOR_V1,
      archiveScopeRootIds: ['X'],
      reattributeScopeRoots: [],
      expectedConfigJson: await configJson(accountId),
    });
    // Step 2 — a fresh LIVE row under 'X', so the assertion below has
    // something that CAN move and is not green by construction.
    await store.commit({
      account: accountId,
      documents: [doc('e', 'X')],
      cursor: CURSOR_V1,
    });

    const first = await store.applyFolderScope({
      accountId,
      config: { folderRoots: [{ id: 'root', name: 'My Drive' }] },
      cursor: CURSOR_V1,
      archiveScopeRootIds: [],
      reattributeScopeRoots: [{ from: 'X', to: 'root' }],
      expectedConfigJson: await configJson(accountId),
    });
    expect(first.reattributed).toBe(1); // 'e' only
    expect(
      (await store.read.byExternalId(accountId, 'e', 'file'))?.scopeRootId,
    ).toBe('root');

    // The archived rows keep their stamp AND stay archived. `archived_at IS
    // NULL` is in the predicate for the same reason it is in the archive
    // predicate: an archived row is out of the working set entirely, and
    // silently re-stamping one would make the record of WHY it was archived
    // unrecoverable.
    for (const e of ['b', 'c']) {
      const row = await store.read.byExternalId(accountId, e, 'file');
      expect(row?.scopeRootId).toBe('X');
      expect(row?.archivedAt).not.toBeNull();
    }

    // Idempotent: nothing is stamped 'X' and live any more.
    const second = await store.applyFolderScope({
      accountId,
      config: { folderRoots: [{ id: 'root', name: 'My Drive' }] },
      cursor: CURSOR_V1,
      archiveScopeRootIds: [],
      reattributeScopeRoots: [{ from: 'X', to: 'root' }],
      expectedConfigJson: await configJson(accountId),
    });
    expect(second.reattributed).toBe(0);

    // And the empty array does nothing at all.
    const none = await store.applyFolderScope({
      accountId,
      config: { folderRoots: [{ id: 'root', name: 'My Drive' }] },
      cursor: CURSOR_V1,
      archiveScopeRootIds: [],
      reattributeScopeRoots: [],
      expectedConfigJson: await configJson(accountId),
    });
    expect(none.reattributed).toBe(0);
    expect(none.archived).toBe(0);
  });

  it('C-46/D5: never crosses an account boundary', async () => {
    const otherId = (
      await store.createAccount({
        source: 'google-docs',
        identifier: 'other@example.com',
        config: CONFIG_V1,
      })
    ).id;
    await store.commit({
      account: otherId,
      documents: [doc('o1', 'X')],
      cursor: CURSOR_V1,
    });

    const result = await store.applyFolderScope({
      accountId,
      config: { folderRoots: [{ id: 'root', name: 'My Drive' }] },
      cursor: CURSOR_V1,
      archiveScopeRootIds: [],
      reattributeScopeRoots: [{ from: 'X', to: 'root' }],
      expectedConfigJson: await configJson(accountId),
    });

    expect(result.reattributed).toBe(2);
    expect(
      (await store.read.byExternalId(otherId, 'o1', 'file'))?.scopeRootId,
    ).toBe('X');
  });

  // ── NO test for archiving NULL-scoped rows, and no branch to test (C-34) ──
  //
  // Two tests stood here: "leaves NULL-scoped rows live unless
  // archiveNullScoped is explicitly set" and "the repair pass does not archive
  // a train-1 row whose stamp COALESCE preserved". DECISIONS C-34 deleted both
  // together with the branch they exercised: `FolderScopeInput` no longer
  // carries `archiveNullScoped`, `FOLDER_SCOPE_OUT` has no NULL disjunct and
  // no flag bind, and NOTHING in this train archives a row the v3 migration
  // could not attribute. The guarantee is the TYPE, not a literal and not a
  // test — re-adding the property at the engine call site is a TS2353
  // (excess-property check on the inline object literal).
  //
  // That NULL rows go untouched is still pinned, by the two tests above: the
  // empty-set Save leaves all four live (`remaining: 4`), and the ['X'] Save
  // archives exactly 'b' and 'c' — the seed's unattributable 'd' is neither
  // counted nor present in the joined `changes` rows. Step 16's mutation 2 is
  // where that gets its teeth: it restores the deleted disjunct and the ['X']
  // test fails on `archived: 3` (the empty-set test above would fail too, but
  // the mutation's -t filter runs only the one).
  //
  // WHAT MUST EXIST BEFORE THIS BRANCH CAN RETURN — both of these, not either:
  //
  //  1. An ARCHIVE-AFTER-PROOF predicate, shaped like `reconcile`'s. Its two
  //     halves are, verbatim from write-tx.ts:512-517:
  //
  //       const ELIGIBLE = `account_id = ? AND archived_at IS NULL AND seq <= ?`;
  //       const UNLISTED = `NOT EXISTS (
  //           SELECT 1 FROM reconcile_listing l
  //            WHERE l.account_id = documents.account_id
  //              AND l.external_id = documents.external_id
  //              AND l.type = documents.type)`;
  //
  //     — archive only what a COMPLETED, durable listing proved absent, and
  //     only up to the caller's seq snapshot, so a pull landing mid-pass is
  //     never mistaken for a deletion. Archiving FIRST and relying on a
  //     compensating re-walk is not a substitute: whether that walk ran,
  //     completed and reached the row is unobservable from the transaction
  //     that archived, every later incremental pass is blind to an unchanged
  //     file, and a LIVE NULL-scoped row is never re-stamped by any walk —
  //     both connectors' hashSkip is `if (!existing || existing.archivedAt)
  //     return false;` (gdocs source.ts:476, onedrive source.ts:296) and
  //     upsertDocument early-returns on `content_hash === hash &&
  //     archived_at === null` (write-tx.ts:170-176).
  //
  //  2. A LISTING PASS FOR ONEDRIVE, which has no `reconcile()` at all
  //     (onedrive-kia-connector/src/source.ts:62) — so it has nothing to stage
  //     a listing from, and no periodic pass that would ever repair a wrong
  //     archive.

  it('returns counts only — never rows', async () => {
    const result = await store.applyFolderScope({
      accountId,
      config: CONFIG_V1,
      cursor: CURSOR_V1,
      archiveScopeRootIds: [],
      reattributeScopeRoots: [],
      expectedConfigJson: await configJson(accountId),
    });
    // A per-account row array crossing the DB-worker boundary is what OOM'd
    // the main process on a 3.7M-document account. Pin the whole surface.
    expect(Object.keys(result).sort()).toEqual([
      'archived',
      'reattributed',
      'remaining',
      'stale',
    ]);
    for (const v of Object.values(result)) {
      expect(['number', 'boolean']).toContain(typeof v);
    }
  });

  it('derives the R1 legacy roots mirror for a cloud source, overwriting a stale one', async () => {
    // A-2: `manageFolders` returns CANONICAL-ONLY config. Core is the single
    // owner of the mirror, in exactly two places — the v3 migration and here.
    // The installed Marketplace connectors (gdocs 2.1.6, onedrive 2.0.5) do
    // not auto-update and read `config.roots`; gdocs reading no `roots` falls
    // through to "all of My Drive" and reconcile()-archives everything else.
    //
    // The `roots` planted in the INPUT is the pre-edit mirror a source that
    // simply spread its old config would carry along. It must be REPLACED,
    // not preserved — a preserved stale mirror is R1's bug with extra steps.
    await store.applyFolderScope({
      accountId,
      config: {
        folderRoots: [{ id: 'X', name: 'Reports' }],
        roots: [{ rootFolderId: 'root', rootName: 'My Drive' }],
        someUnrelatedSourceKey: 7,
      },
      cursor: { page_token: 'p1', backfill_done: false, scope_roots: ['X'] },
      archiveScopeRootIds: [],
      reattributeScopeRoots: [],
      expectedConfigJson: await configJson(accountId),
    });

    expect((await store.account(accountId))!.config).toEqual({
      folderRoots: [{ id: 'X', name: 'Reports' }],
      roots: [{ rootFolderId: 'X', rootName: 'Reports' }],
      someUnrelatedSourceKey: 7,
    });
  });

  it('derives the R1 legacy paths mirror for local-folder', async () => {
    const localId = (
      await store.createAccount({
        source: 'local-folder',
        identifier: 'this-machine',
        config: { folderRoots: [{ id: '/A', name: 'A' }], watch: true },
      })
    ).id;

    await store.applyFolderScope({
      accountId: localId,
      config: {
        folderRoots: [
          { id: '/A', name: 'A' },
          { id: '/B/C', name: 'C' },
        ],
        watch: true,
      },
      cursor: null,
      archiveScopeRootIds: [],
      reattributeScopeRoots: [],
      expectedConfigJson: await configJson(localId),
    });

    expect((await store.account(localId))!.config).toEqual({
      folderRoots: [
        { id: '/A', name: 'A' },
        { id: '/B/C', name: 'C' },
      ],
      paths: ['/A', '/B/C'],
      watch: true,
    });
  });

  it('writes no legacy mirror for a source that is not folder-scoped', async () => {
    const imapId = (
      await store.createAccount({
        source: 'imap',
        identifier: 'imap-mirror@example.com',
        config: { folderRoots: [{ id: 'INBOX', name: 'Inbox' }] },
      })
    ).id;

    await store.applyFolderScope({
      accountId: imapId,
      config: { folderRoots: [{ id: 'INBOX', name: 'Inbox' }] },
      cursor: null,
      archiveScopeRootIds: [],
      reattributeScopeRoots: [],
      expectedConfigJson: await configJson(imapId),
    });

    expect((await store.account(imapId))!.config).toEqual({
      folderRoots: [{ id: 'INBOX', name: 'Inbox' }],
    });
  });

  it('refuses to write when the stored config moved since the flow read it', async () => {
    const expectedConfigJson = await configJson(accountId);

    // a second Save on the same account lands first
    const winner = { folderRoots: [{ id: 'X', name: 'Reports' }] };
    await store.setAccountConfig(accountId, winner);

    const result = await store.applyFolderScope({
      accountId,
      config: { folderRoots: [{ id: 'root', name: 'My Drive' }] },
      cursor: { page_token: 'p9', backfill_done: false, scope_roots: ['root'] },
      archiveScopeRootIds: ['X'],
      reattributeScopeRoots: [],
      expectedConfigJson,
    });

    expect(result).toEqual({
      archived: 0,
      reattributed: 0,
      remaining: 0,
      stale: true,
    });
    const after = await store.account(accountId);
    expect(after!.config).toEqual(winner); // no mirror derived — nothing ran
    expect(after!.cursor).toEqual(CURSOR_V1); // untouched
    expect(await liveCount()).toBe(4);
  });

  it('rolls the config and cursor writes back when the archive fails mid-flight', async () => {
    const beforeConfigJson = await configJson(accountId);
    const beforeChanges = await changesCount();

    // Fail the SECOND archive, after the config/cursor UPDATE and one
    // successful archive have already run. `UPDATE OF archived_at` fires only
    // on the archive loop's statement, and a BEFORE trigger sees the earlier
    // UPDATEs of the same transaction — so "one row already archived" is a
    // deterministic mid-loop trip point. Keying on a specific external_id
    // would not be: the page SELECT has no ORDER BY, so which row comes first
    // is planner-dependent, and if the trigger fired on the first row the test
    // would silently degrade into "failure BEFORE any archive rolls back".
    // archiveScopeRootIds: ['X'] selects exactly b and c — two rows, so the
    // loop always reaches a second UPDATE.
    db._conn!.exec(
      `CREATE TRIGGER folder_scope_boom
         BEFORE UPDATE OF archived_at ON documents
         WHEN (SELECT COUNT(*) FROM documents
                WHERE account_id = NEW.account_id
                  AND archived_at IS NOT NULL) >= 1
         BEGIN SELECT RAISE(ABORT, 'forced-archive-failure'); END`,
    );

    // Captured by hand rather than with `.rejects.toThrow()`: this rejects
    // with a native better-sqlite3 SqliteError, and matcher-side instanceof
    // checks on those have flaked in-band in this repo. Assert on the message.
    const failed = await store
      .applyFolderScope({
        accountId,
        config: { folderRoots: [{ id: 'root', name: 'My Drive' }] },
        cursor: {
          page_token: 'p2',
          backfill_done: false,
          scope_roots: ['root'],
        },
        archiveScopeRootIds: ['X'],
        reattributeScopeRoots: [],
        expectedConfigJson: beforeConfigJson,
      })
      .then(
        () => null,
        (e: unknown) => e as { message?: string },
      );
    expect(failed?.message).toMatch(/forced-archive-failure/);

    const after = await store.account(accountId);
    expect(JSON.stringify(after!.config)).toBe(beforeConfigJson);
    expect(after!.cursor).toEqual(CURSOR_V1);
    // C-29's NEGATIVE branch — the recovery read a caller makes after a
    // rejection. `folderRoots` is still the PRE-edit set, so durable state
    // says "nothing committed": the caller must restart the account's
    // ORIGINAL loop, not the one the failed edit was aiming for. The
    // POSITIVE branch (rejection, but the write DID land) is the next test.
    expect(after!.config.folderRoots).toEqual(CONFIG_V1.folderRoots);
    expect(await liveCount()).toBe(4); // one row WAS archived before the abort — and rolled back with it
    expect(await changesCount()).toBe(beforeChanges); // no orphan feed rows

    db._conn!.exec(`DROP TRIGGER folder_scope_boom`);
  });

  it('a lost reply is not proof nothing ran — durable state is the discriminator, and an applyFolderScope retry is stale (C-29)', async () => {
    // In production this call crosses the DB-worker bridge, which COMMITS the
    // transaction and only THEN posts its reply (db/bridge.ts:100-127:
    // `value = await proc(req.args);` … `port.postMessage({id, ok: true,
    // value})`). A worker death in that window rejects the in-flight promise
    // (worker-client.ts:168-183 `_markDead`, tagged DB_WORKER_CRASHED) even
    // though the archive is durable — so `applyScope` can exit, having
    // archived, WITHOUT ever restarting the compensating backfill. Model the
    // lost reply by simply discarding the result, and pin the three
    // properties the recovery rule depends on. The real worker round trip is
    // driven end to end in db/__tests__/db-worker.test.ts.
    const expectedConfigJson = await configJson(accountId);
    const intended = { folderRoots: [{ id: 'root', name: 'My Drive' }] };
    const cursor = {
      page_token: 'p1',
      backfill_done: false,
      scope_roots: ['root'],
    };
    await store.applyFolderScope({
      accountId,
      config: intended,
      cursor,
      archiveScopeRootIds: ['X'],
      reattributeScopeRoots: [],
      expectedConfigJson,
    }); // result deliberately discarded — this is the lost reply

    // 1. the archive is DURABLE: b and c are gone, a and d remain
    expect(await liveCount()).toBe(2);

    // 2. the discriminator: the PARSED folderRoots match what the flow meant
    //    to write, so durable state says "it committed" and the caller must
    //    restart the loop with the NEW cursor.
    const after = await store.account(accountId);
    expect(after!.config.folderRoots).toEqual(intended.folderRoots);
    expect(after!.cursor).toEqual(cursor);
    //    …and the JSON TEXT does NOT match, because this procedure appends
    //    R1's legacy mirror inside the transaction. A caller comparing
    //    JSON.stringify(update.config) against the stored text would conclude
    //    "nothing committed" on every folder-scoped cloud account and leave
    //    the archive uncompensated. This assertion is that trap, nailed down.
    expect(JSON.stringify(after!.config)).not.toBe(JSON.stringify(intended));

    // 3. a naive retry is NOT the compensating action: the stale-write guard
    //    sees the stored config has already moved and writes nothing.
    const retry = await store.applyFolderScope({
      accountId,
      config: intended,
      cursor,
      archiveScopeRootIds: ['X'],
      reattributeScopeRoots: [],
      expectedConfigJson,
    });
    expect(retry).toEqual({
      archived: 0,
      reattributed: 0,
      remaining: 0,
      stale: true,
    });
    expect(await liveCount()).toBe(2);
  });

  it('an archived row comes BACK when the re-walk re-emits it, un-archived and re-stamped (C-27)', async () => {
    // The store half of the recovery loop EVERY archive path in this train
    // depends on — it is what makes a removed root a scope edit rather than a
    // delete. Note the re-emitted document is BYTE-IDENTICAL in content to the
    // seed: `contentHash` is unchanged, and this still works, because
    // `upsertDocument`'s early return requires `existing.archived_at === null`
    // (write-tx.ts:170-176). An ARCHIVED row therefore always takes the UPDATE
    // branch, which sets archived_at=NULL and stamps
    // `scope_root_id = COALESCE(?, scope_root_id)`. Upstream, both cloud
    // connectors' hashSkip exempts an archived row for exactly this reason
    // (gdocs source.ts:463-487, onedrive source.ts:293-300), and
    // local-folder's full backfill yields every entry
    // (local-folder-source.ts:233-264). Mutation 9 in Step 16 is how this pin
    // gets its teeth.
    //
    // The archive here is an ordinary `archiveScopeRootIds` one — 'X', i.e. b
    // and c. It is deliberately NOT a NULL-scoped archive: C-34 took that
    // branch out of this train (see Step 5's replacement comment), and this
    // loop is what a future archive-AFTER-proof branch would rely on, never a
    // licence to archive on a guess and hope the walk repairs it.
    const removed = await store.applyFolderScope({
      accountId,
      config: { folderRoots: [{ id: 'root', name: 'My Drive' }] },
      cursor: {
        page_token: 'p1',
        backfill_done: false,
        scope_roots: ['root'],
      },
      archiveScopeRootIds: ['X'],
      reattributeScopeRoots: [],
      expectedConfigJson: await configJson(accountId),
    });
    expect(removed.archived).toBe(2); // 'b' and 'c'
    expect(await liveCount()).toBe(2);

    // the user re-selects that folder, and the re-establish walk reaches 'b'
    // again — same body, now resolvable under the retained catch-all root
    await store.commit({
      account: accountId,
      documents: [doc('b', 'root')], // identical content to the seed
      cursor: CURSOR_V1,
    });

    const b = await store.read.byExternalId(accountId, 'b', 'file');
    expect(b?.archivedAt).toBeNull();
    expect(b?.scopeRootId).toBe('root');
    expect(await liveCount()).toBe(3);
  });
});

/**
 * DECISIONS R1 / C-15 — core's TWO legacy-mirror writers must agree.
 *
 * `rewindToV2` reproduces a genuine pre-v3 corpus: the tables and the seeded
 * accounts already exist, `scope_root_id` does not. It is the only way to run
 * the v3 pass over accounts this test seeded, because `migrate` on a fresh
 * in-memory db creates the tables and runs v3 in the same call, before there
 * is anything to insert into. v2's `UPDATE meta SET value='1'` idiom cannot
 * be reused: re-running v3's `ALTER TABLE … ADD COLUMN` would raise
 * `duplicate column name`. The index must be dropped FIRST — SQLite refuses
 * `DROP COLUMN` on a column an index references. Requires SQLite >= 3.35; the
 * bundled better-sqlite3 is 3.53.2 (read off this worktree 2026-09-05, where
 * the add-index/drop-index/drop-column round trip was also exercised on a
 * stand-in table — NOT on migrate()'s real output). The real safety net is
 * ordering: under A-9 Task 2's own suite runs this exact helper against the
 * real v3 schema before this task starts, so a helper that could not work
 * would have failed there first.
 */
function rewindToV2(db: Database.Database): void {
  db.exec(`DROP INDEX IF EXISTS idx_documents_account_scope_root`);
  db.exec(`ALTER TABLE documents DROP COLUMN scope_root_id`);
  db.prepare(`UPDATE meta SET value='2' WHERE key='schemaVersion'`).run();
}

function seedMirrorAccount(
  db: Database.Database,
  id: string,
  source: string,
  config: Record<string, unknown>,
): void {
  db.prepare(
    `INSERT INTO accounts(id, source, identifier, config, status, cursor, created_at)
     VALUES (?, ?, ?, ?, 'idle', NULL, '2026-01-01T00:00:00Z')`,
  ).run(id, source, `${id}@example.com`, JSON.stringify(config));
}

function mirrorConfigOf(
  db: Database.Database,
  id: string,
): Record<string, unknown> {
  const row = db.prepare(`SELECT config FROM accounts WHERE id = ?`).get(id) as
    | { config: string }
    | undefined;
  if (!row) throw new Error(`no account seeded with id '${id}'`);
  return JSON.parse(row.config) as Record<string, unknown>;
}

/** One account per source the mirror covers, each seeded in its PRE-v3
 *  (legacy) shape, plus one source neither writer may mirror. `rootName` is
 *  deliberately different from `rootFolderId` everywhere, so a derivation
 *  that swapped the two would not accidentally pass. */
const MIRROR_FIXTURES: Array<{
  id: string;
  source: string;
  legacy: Record<string, unknown>;
}> = [
  {
    id: 'xpin-drive',
    source: 'google-docs',
    legacy: {
      roots: [
        { rootFolderId: 'root', rootName: 'My Drive' },
        { rootFolderId: 'R1', rootName: 'Reports' },
      ],
    },
  },
  {
    id: 'xpin-onedrive',
    source: 'onedrive',
    legacy: { roots: [{ rootFolderId: 'R2', rootName: 'Documents' }] },
  },
  {
    id: 'xpin-local',
    source: 'local-folder',
    legacy: { paths: ['/A', '/B/C'], watch: true },
  },
  {
    // Not one of the three sources with a legacy reader. The migration's
    // account query filters it out and `withLegacyMirror` returns its config
    // untouched — so this row pins that the two writers agree on WHICH
    // sources get a mirror, not just on its shape.
    id: 'xpin-gmail',
    source: 'gmail',
    legacy: { folderRoots: [{ id: 'INBOX', name: 'Inbox' }] },
  },
];

describe('core derives the legacy mirror twice, and the two agree (R1 / C-15)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db); // full ladder incl. v3 — no rows yet, so v3 is a no-op
    for (const f of MIRROR_FIXTURES) {
      seedMirrorAccount(db, f.id, f.source, f.legacy);
    }
    rewindToV2(db);
  });

  afterEach(() => {
    db.close();
  });

  it('the v3 migration and withLegacyMirror produce the same mirror keys and values', () => {
    migrate(db); // runs v3 ONLY — rewindToV2 put the marker back to '2'

    for (const f of MIRROR_FIXTURES) {
      const migrated = mirrorConfigOf(db, f.id);
      // Feed the migration's OWN canonical output back through the runtime
      // derivation. Identical input, so any difference in the result is a
      // difference between the two derivations — which is exactly the drift
      // this pins. Never assert against hand-written expected literals here:
      // literals agreeing is what the seam already had, and it is what
      // C-15 says is not enough.
      const pinned = withLegacyMirror(f.source, {
        ...f.legacy,
        folderRoots: migrated.folderRoots,
      });
      // the mirror COLUMN SET first, so a missing or extra legacy key names
      // itself before any value diff drowns it
      expect({ id: f.id, keys: Object.keys(migrated).sort() }).toEqual({
        id: f.id,
        keys: Object.keys(pinned).sort(),
      });
      // then every value, `id`-labelled so the failing fixture is named
      expect({ id: f.id, config: migrated }).toEqual({
        id: f.id,
        config: pinned,
      });
    }
  });
});
