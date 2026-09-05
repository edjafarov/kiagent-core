/**
 * Schema v3: stamp `documents.scope_root_id` for every live row on the three
 * folder-scoped sources, rewrite `accounts.config` to canonical
 * `folderRoots` (plus the A-2 legacy mirror core alone owns), and — for
 * `local-folder` ONLY — archive rows that are provably out of scope.
 *
 * **C-27: for a CLOUD document (google-docs, onedrive) this migration is
 * ATTRIBUTION-ONLY and archives NOTHING.** `metadata.root_folder_id` is
 * frozen at last emission by the connectors' `hashSkip`, so a mismatch is
 * stale data, not evidence of being out of scope: a document stamped with
 * child folder `B` is still in scope after the user selects parent folder
 * `A`, and a migration has no way to learn that `B ⊂ A` — no ancestor chain
 * is stored anywhere, and boot must not make network calls. So a cloud row
 * that matches no configured root and has no catch-all is left LIVE with
 * `scope_root_id` NULL. `local-folder` is different on purpose: its roots are
 * absolute paths, so `isUnder` decides containment exactly and locally, which
 * is why it alone keeps an archive pass and the mass-archive breaker.
 *
 * The matrix below is seeded from facts measured on the user's two REAL
 * corpora on 2026-09-04 (re-verified read-only 2026-09-05), not invented:
 *  - production google-docs account 019fd782 has `config.roots =
 *    [{rootFolderId:'root', rootName:'My Drive'}]` and 316 live rows, of
 *    which only 2 carry `metadata.root_folder_id = 'root'`. The other 314 are
 *    spread over 24 distinct stale ids — hashSkip froze them at whatever root
 *    was configured at last emission (spec-reality-diff A0/A0b). Without the
 *    catch-all rule the migration archives 314 of 316 on a `needsReauth`
 *    account that cannot re-walk. `catchall-stale-*` below is that row shape,
 *    using two of the account's real stale ids (the largest bucket,
 *    116 rows, and the second, 49 rows).
 *  - dev google-docs account 019fb967 has 5 explicit roots and 271/271
 *    attributable; dev local-folder 01a033e5 has 1815/1815 attributable by
 *    `metadata.absPath` (0 rows missing the key, 0 failing `isUnder`).
 *    `explicit-*` and `local-*` are those shapes.
 *  - NEITHER corpus has a cloud account that both lacks a catch-all AND
 *    carries a stale root id, so the real-corpus dry run in
 *    `folder-scope-corpus-dryrun.test.ts` CANNOT discriminate C-27.
 *    `explicit-unmatched` below is the only test in the train that can — it
 *    is the `B ⊂ A` row on an account with explicit roots and no catch-all,
 *    and it must come out LIVE with a NULL scope. Do not delete it, and do
 *    not "fix" it by archiving.
 *  - `accounts.source` literals are bare and unprefixed; `gmail` genuinely
 *    coexists and must never be touched.
 *
 * Fixture idiom, and why it differs from v2's: v2's tests rewind by writing
 * `meta.schemaVersion='1'` and calling `migrate()` again. v3 cannot do that —
 * its body starts with `ALTER TABLE documents ADD COLUMN scope_root_id`,
 * which raises `duplicate column name` on a second run. `rewindToV2()` below
 * drops the index and then the column (order matters: SQLite refuses to drop
 * a column an index references) and sets the marker to 2, which reproduces a
 * genuine pre-v3 corpus exactly. Requires SQLite >= 3.35; the bundled
 * better-sqlite3 is 3.53.2.
 */
import Database from 'better-sqlite3';

import { migrate } from '../schema';

type Row = Record<string, string | number | null>;

function seedAccount(
  db: Database.Database,
  id: string,
  source: string,
  config: Record<string, unknown> | string,
  cursor: string | null = null,
): void {
  db.prepare(
    `INSERT INTO accounts(id, source, identifier, config, status, cursor, created_at)
     VALUES (?, ?, ?, ?, 'idle', ?, '2026-01-01T00:00:00Z')`,
  ).run(
    id,
    source,
    `${id}@example.com`,
    typeof config === 'string' ? config : JSON.stringify(config),
    cursor,
  );
}

function seedDoc(db: Database.Database, row: Row): void {
  db.prepare(
    `INSERT INTO documents
       (id, account_id, external_id, type, title, markdown, metadata,
        content_hash, seq, archived_at, created_at, ingested_at, updated_at)
     VALUES (@id, @account_id, @external_id, @type, @title, @markdown, @metadata,
             @content_hash, @seq, @archived_at, @created_at, @ingested_at, @updated_at)`,
  ).run(row);
}

/** One `documents` row. `metadata` is taken VERBATIM so the hostile shapes
 *  (`'null'`, `'[1,2]'`) that JSON.stringify would never produce can be
 *  seeded — the same trick v2's `candidateRawMetadata` uses. `languages`,
 *  `url` and `parent_id` are omitted: the v1 DDL (`schema.ts:173-191`) gives
 *  `languages` a NOT NULL DEFAULT '[]' and leaves the other two nullable. */
function doc(
  id: string,
  accountId: string,
  type: string,
  rawMetadata: string,
  opts: { externalId?: string; archivedAt?: string | null } = {},
): Row {
  return {
    id,
    account_id: accountId,
    external_id: opts.externalId ?? id,
    type,
    title: null,
    markdown: null,
    metadata: rawMetadata,
    content_hash: `hash-${id}`,
    seq: 0,
    archived_at: opts.archivedAt ?? null,
    created_at: '2026-01-01T00:00:00Z',
    ingested_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

const meta = (o: Record<string, unknown>): string => JSON.stringify(o);

/** Undo v3's DDL and rewind the version marker, reproducing a real pre-v3
 *  corpus: tables and rows already exist, `scope_root_id` does not. v2's
 *  `UPDATE meta SET value='1'` idiom cannot be reused because re-running v3's
 *  `ALTER TABLE … ADD COLUMN` raises `duplicate column name`. The index must
 *  go first — SQLite refuses `DROP COLUMN` on a column an index references. */
function rewindToV2(db: Database.Database): void {
  db.exec(`DROP INDEX IF EXISTS idx_documents_account_scope_root`);
  db.exec(`ALTER TABLE documents DROP COLUMN scope_root_id`);
  db.prepare(`UPDATE meta SET value='2' WHERE key='schemaVersion'`).run();
}

function scopeOf(db: Database.Database, id: string): string | null {
  const row = db
    .prepare(`SELECT scope_root_id FROM documents WHERE id = ?`)
    .get(id) as { scope_root_id: string | null } | undefined;
  if (!row) throw new Error(`no document seeded with id '${id}'`);
  return row.scope_root_id;
}

function live(db: Database.Database, id: string): boolean {
  const row = db
    .prepare(`SELECT archived_at FROM documents WHERE id = ?`)
    .get(id) as { archived_at: string | null } | undefined;
  if (!row) throw new Error(`no document seeded with id '${id}'`);
  return row.archived_at === null;
}

function configOf(db: Database.Database, id: string): Record<string, unknown> {
  const row = db.prepare(`SELECT config FROM accounts WHERE id = ?`).get(id) as
    | { config: string }
    | undefined;
  if (!row) throw new Error(`no account seeded with id '${id}'`);
  return JSON.parse(row.config) as Record<string, unknown>;
}

function cursorOf(db: Database.Database, id: string): string | null {
  return (
    db.prepare(`SELECT cursor FROM accounts WHERE id = ?`).get(id) as {
      cursor: string | null;
    }
  ).cursor;
}

function schemaVersion(db: Database.Database): number {
  const row = db
    .prepare(`SELECT value FROM meta WHERE key='schemaVersion'`)
    .get() as { value: string } | undefined;
  return row ? Number(row.value) : 0;
}

function changesFor(
  db: Database.Database,
  id: string,
): Array<{ seq: number; kind: string }> {
  return db
    .prepare(`SELECT seq, kind FROM changes WHERE ref_id = ? ORDER BY seq`)
    .all(id) as Array<{ seq: number; kind: string }>;
}

function changeCount(db: Database.Database): number {
  return (
    db.prepare(`SELECT COUNT(*) AS n FROM changes`).get() as { n: number }
  ).n;
}

function docChangeCount(db: Database.Database): number {
  return (
    db
      .prepare(`SELECT COUNT(*) AS n FROM changes WHERE kind='document'`)
      .get() as { n: number }
  ).n;
}

/**
 * Every account shape the migration must handle, and one (`gmail`) it must
 * not touch.
 */
function seedMatrix(db: Database.Database): void {
  // A. Drive WITH the 'root' catch-all — the production 019fd782 shape.
  seedAccount(db, 'acc-catchall', 'google-docs', {
    roots: [{ rootFolderId: 'root', rootName: 'My Drive' }],
  });
  seedDoc(
    db,
    doc(
      'catchall-hit',
      'acc-catchall',
      'file',
      meta({ root_folder_id: 'root' }),
    ),
  );
  // The 314-row shape: a REAL stale Drive folder id from that account (its
  // largest bucket, 116 rows) that is no longer configured. R6 attributes it
  // to the catch-all; the pre-R6 spec archived it.
  seedDoc(
    db,
    doc(
      'catchall-stale-a',
      'acc-catchall',
      'file',
      meta({ root_folder_id: '0B246AxIx6hdAeTBrQ0xLbVhuRTQ' }),
    ),
  );
  // Native Google Doc: type 'gdocs.doc', NOT 'file'. v3 deliberately has no
  // type filter (unlike v2) because gdocs emits root_folder_id on every type;
  // 17 of the 316 rows on the real account are `gdocs.doc`.
  seedDoc(
    db,
    doc(
      'catchall-stale-native',
      'acc-catchall',
      'gdocs.doc',
      meta({ root_folder_id: '0B246AxIx6hdALVUxemdKS1Bkd3c' }),
    ),
  );
  // No root_folder_id at all → NULL, never archived (brief + A1.1 + A-3).
  seedDoc(
    db,
    doc(
      'catchall-nokey',
      'acc-catchall',
      'file',
      meta({ mime: 'application/pdf' }),
    ),
  );
  // Already archived → never stamped, never re-archived.
  seedDoc(
    db,
    doc(
      'catchall-archived',
      'acc-catchall',
      'file',
      meta({ root_folder_id: 'root' }),
      {
        archivedAt: '2026-01-02T00:00:00Z',
      },
    ),
  );

  // B. Drive WITHOUT a catch-all — the dev 019fb967 / production 01a00157
  //    shape. Under C-27 NO cloud account may archive, so this account is
  //    the discriminator for that rule, not an archiving account.
  //    Its cursor is seeded NON-NULL on purpose: A3 option (i) is only pinned
  //    if the "cursor unchanged" assertion can actually fail.
  seedAccount(
    db,
    'acc-explicit',
    'google-docs',
    {
      roots: [
        { rootFolderId: 'R1', rootName: 'Google Meet' },
        { rootFolderId: 'R2', rootName: 'Meet Recordings' },
      ],
    },
    '{"page_token":"tok-1","backfill_done":true}',
  );
  seedDoc(
    db,
    doc('explicit-r1', 'acc-explicit', 'file', meta({ root_folder_id: 'R1' })),
  );
  seedDoc(
    db,
    doc('explicit-r2', 'acc-explicit', 'file', meta({ root_folder_id: 'R2' })),
  );
  // ★ THE C-27 ROW. 'R9' names no configured root and this account has no
  //   catch-all — the pre-C-27 rule archived it. But 'R9' is a stamp FROZEN
  //   by hashSkip at last emission: it may well be a child folder of R1 or
  //   R2, in which case the document is still in scope and archiving it is
  //   silent data loss on a path with no in-app recovery. A migration cannot
  //   tell; a connector can. So: LIVE, scope_root_id NULL, never archived.
  //   This is the ONLY place in the plan where that rule is testable — no
  //   real corpus has this shape (see the header comment).
  seedDoc(
    db,
    doc(
      'explicit-unmatched',
      'acc-explicit',
      'file',
      meta({ root_folder_id: 'R9' }),
    ),
  );
  // No key → NULL, NOT archived either (A-3).
  seedDoc(db, doc('explicit-nokey', 'acc-explicit', 'file', meta({})));

  // C. Legacy Drive with NO roots key → [{id:'root',name:'My Drive'}],
  //    mirroring gdocs source.ts:362-365's own default.
  seedAccount(db, 'acc-legacy-drive', 'google-docs', {});
  seedDoc(
    db,
    doc(
      'legacy-drive-any',
      'acc-legacy-drive',
      'file',
      meta({ root_folder_id: 'ANY' }),
    ),
  );

  // D. Legacy OneDrive with no roots → [{id:'root',name:'OneDrive'}]. Its
  //    catch-all is the literal 'root' too: onedrive source.ts:211 seeds
  //    {rootFolderId:'root', rootName:'OneDrive'}, its picker seeds
  //    {id:'root', name:'OneDrive'} (:829) and its delta URL is
  //    /me/drive/items/root/delta (:618, :658).
  seedAccount(db, 'acc-legacy-onedrive', 'onedrive', {});
  seedDoc(
    db,
    doc(
      'legacy-od-any',
      'acc-legacy-onedrive',
      'file',
      meta({ root_folder_id: 'SHARED-X' }),
    ),
  );

  // E. local-folder, OVERLAPPING roots. coveringRoots collapses to '/A'
  //    BEFORE attribution (D7), so both rows attribute to '/A' and nothing
  //    is ambiguous; the legacy `paths` mirror carries the collapsed set.
  seedAccount(db, 'acc-local', 'local-folder', {
    paths: ['/A', '/A/B'],
    watch: false,
  });
  seedDoc(
    db,
    doc('local-in-a', 'acc-local', 'file', meta({ absPath: '/A/x.txt' })),
  );
  seedDoc(
    db,
    doc('local-in-b', 'acc-local', 'file', meta({ absPath: '/A/B/y.txt' })),
  );
  // Separator-aware: '/AA' must NOT match root '/A'. This is the ONLY row in
  // the whole matrix that v3 archives: containment is decidable exactly from
  // the absolute path, so `out-of-scope` here is a proof, not a guess (C-27).
  seedDoc(
    db,
    doc('local-sibling', 'acc-local', 'file', meta({ absPath: '/AA/z.txt' })),
  );
  // No absPath → NULL, never archived (A-3).
  seedDoc(
    db,
    doc('local-nokey', 'acc-local', 'file', meta({ filename: 'q.txt' })),
  );

  // F. local-folder on WINDOWS. `externalId` is posix-ized
  //    (scanner.ts:166-168 toAbsPosix: absPath.split(path.sep).join('/'))
  //    while `absPath` (to-document.ts:57) and `config.paths` are OS-native.
  //    Matching on externalId mis-attributes here; matching on absPath is
  //    correct.
  seedAccount(db, 'acc-win', 'local-folder', { paths: ['C:\\Users\\x\\Docs'] });
  seedDoc(
    db,
    doc(
      'win-file',
      'acc-win',
      'file',
      meta({ absPath: 'C:\\Users\\x\\Docs\\f.txt' }),
      {
        externalId: 'C:/Users/x/Docs/f.txt',
      },
    ),
  );

  // G. gmail — entirely outside the migration's scope. Carries a
  //    root_folder_id that WOULD match nothing, to prove the source filter.
  seedAccount(db, 'acc-gmail', 'gmail', {});
  seedDoc(
    db,
    doc(
      'gmail-thread',
      'acc-gmail',
      'email.thread',
      meta({ root_folder_id: 'ZZ' }),
    ),
  );
}

describe('schema v3: scope_root_id attribution, the catch-all rule and C-27', () => {
  let db: Database.Database;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    // Describe-scoped, matching the house pattern set by this branch's head
    // commit ("scope the unreadable-metadata warn spy to the whole describe
    // block"): pass 1b now warns once per account that C-27 leaves
    // unattributed, and the C-27 test below asserts on it.
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    db = new Database(':memory:');
    migrate(db); // full ladder incl. v3 (no rows yet — a no-op).
    seedMatrix(db);
    rewindToV2(db);
  });

  afterEach(() => {
    db.close();
    warnSpy.mockRestore();
  });

  it('adds the column and the partial index, and reaches schemaVersion 3', () => {
    migrate(db);

    const cols = (
      db.prepare(`PRAGMA table_info(documents)`).all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    expect(cols).toContain('scope_root_id');
    // The exact DDL text, not just the index name: the partial predicate and
    // the SECOND column are both load-bearing for Task 3's IN-list seek.
    expect(
      (
        db
          .prepare(
            `SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_documents_account_scope_root'`,
          )
          .get() as { sql: string }
      ).sql,
    ).toBe(
      `CREATE INDEX idx_documents_account_scope_root ON documents(account_id, scope_root_id) WHERE archived_at IS NULL`,
    );
    expect(schemaVersion(db)).toBe(3);
  });

  it('attributes every unmatched live row on a catch-all account to the catch-all and archives nothing (R6 — the 314-of-316 case; unchanged under C-27)', () => {
    migrate(db);

    expect(scopeOf(db, 'catchall-hit')).toBe('root');
    expect(scopeOf(db, 'catchall-stale-a')).toBe('root');
    expect(scopeOf(db, 'catchall-stale-native')).toBe('root'); // no type filter
    expect(scopeOf(db, 'catchall-nokey')).toBeNull();
    expect(live(db, 'catchall-hit')).toBe(true);
    expect(live(db, 'catchall-stale-a')).toBe(true);
    expect(live(db, 'catchall-stale-native')).toBe(true);
    expect(live(db, 'catchall-nokey')).toBe(true);
    expect(changesFor(db, 'catchall-stale-a')).toHaveLength(0);
    expect(changesFor(db, 'catchall-nokey')).toHaveLength(0);

    // Legacy (no `roots` key) Drive and OneDrive both gain the 'root'
    // catch-all, so their stale rows are attributed, never archived.
    expect(scopeOf(db, 'legacy-drive-any')).toBe('root');
    expect(live(db, 'legacy-drive-any')).toBe(true);
    expect(scopeOf(db, 'legacy-od-any')).toBe('root');
    expect(live(db, 'legacy-od-any')).toBe(true);
  });

  /**
   * ★ C-27, and the only test in the train that can fail if C-27 is lost.
   *
   * `explicit-unmatched` carries `root_folder_id: 'R9'` on an account whose
   * configured roots are ['R1','R2'] and which has NO catch-all. The pre-C-27
   * rule archived it. C-27 does not, because 'R9' is a stamp frozen by
   * hashSkip at last emission: it may be a child folder of R1 or R2 and the
   * document may be perfectly in scope. Neither this migration nor anything
   * else in core can tell — no folder parentage is stored for a cloud
   * provider — so the honest answer is NULL-and-live, and the archive
   * decision belongs to the connector, which has walked the real tree.
   *
   * Neither real corpus has this shape (every cloud mismatch on both sits on
   * a catch-all account), so the corpus dry run is silent about C-27 and this
   * test is the whole gate.
   */
  it('★ C-27 — a cloud account with NO catch-all still archives NOTHING: an unmatched row is left LIVE with a NULL scope, and the account is named in one warning', () => {
    migrate(db);

    expect(scopeOf(db, 'explicit-r1')).toBe('R1');
    expect(scopeOf(db, 'explicit-r2')).toBe('R2');

    // The C-27 row: unmatched, no catch-all — LIVE, NULL, no changes row.
    expect(live(db, 'explicit-unmatched')).toBe(true);
    expect(scopeOf(db, 'explicit-unmatched')).toBeNull();
    expect(changesFor(db, 'explicit-unmatched')).toHaveLength(0);

    // Key absent → NULL and LIVE too (A-3).
    expect(live(db, 'explicit-nokey')).toBe(true);
    expect(scopeOf(db, 'explicit-nokey')).toBeNull();
    expect(changesFor(db, 'explicit-nokey')).toHaveLength(0);

    // NOT ONE document archived on ANY cloud account in the whole matrix.
    // Stated as a query rather than row by row so a future cloud fixture is
    // covered automatically.
    expect(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM documents d JOIN accounts a ON a.id = d.account_id
              WHERE a.source IN ('google-docs','onedrive') AND d.archived_at IS NOT NULL
                AND d.id <> 'catchall-archived'`,
          )
          .get() as { n: number }
      ).n,
    ).toBe(0);

    // The hazard population is COUNTED and reported, once per account, so
    // Tasks 3 and 7 can size it on a real machine before anyone points
    // `archiveNullScoped` at it. One warn naming the account and the counts.
    const warnedForExplicit = warnSpy.mock.calls.filter((args: unknown[]) =>
      args.some(
        (a) =>
          typeof a === 'string' &&
          a.includes('acc-explicit') &&
          a.includes('unattributed'),
      ),
    );
    expect(warnedForExplicit).toHaveLength(1);
    // 1 unmatched of 4 live rows on that account.
    expect(String(warnedForExplicit[0][0])).toContain('1 of 4');
    // …and NOT for an account that attributed everything.
    expect(
      warnSpy.mock.calls.some((args: unknown[]) =>
        args.some(
          (a) =>
            typeof a === 'string' &&
            a.includes('acc-catchall') &&
            a.includes('unattributed'),
        ),
      ),
    ).toBe(false);
  });

  it('archives out-of-scope rows ONLY for local-folder, where containment is provable from the absolute path, and never a row whose metadata lacks the attribution key', () => {
    migrate(db);

    expect(live(db, 'local-sibling')).toBe(false); // '/AA' is not under '/A'
    expect(scopeOf(db, 'local-sibling')).toBeNull();
    expect(live(db, 'local-nokey')).toBe(true);
    expect(scopeOf(db, 'local-nokey')).toBeNull();
    expect(changesFor(db, 'local-nokey')).toHaveLength(0);

    // The archive set for the WHOLE matrix is exactly one row, and it is a
    // local-folder row. C-27 in one assertion.
    expect(
      (
        db
          .prepare(
            `SELECT id FROM documents WHERE archived_at IS NOT NULL ORDER BY id`,
          )
          .all() as Array<{ id: string }>
      ).map((r) => r.id),
    ).toEqual(['catchall-archived', 'local-sibling']); // the first was seeded archived
  });

  it('attributes local-folder by metadata.absPath (OS-native), never by the posix-ized externalId, and collapses overlapping roots first', () => {
    migrate(db);

    expect(scopeOf(db, 'local-in-a')).toBe('/A');
    expect(scopeOf(db, 'local-in-b')).toBe('/A'); // '/A/B' collapsed away
    expect(scopeOf(db, 'win-file')).toBe('C:\\Users\\x\\Docs');
  });

  it('leaves gmail and already-archived rows completely untouched', () => {
    migrate(db);

    expect(scopeOf(db, 'gmail-thread')).toBeNull();
    expect(live(db, 'gmail-thread')).toBe(true);
    expect(changesFor(db, 'gmail-thread')).toHaveLength(0);

    expect(scopeOf(db, 'catchall-archived')).toBeNull();
    expect(live(db, 'catchall-archived')).toBe(false);
    expect(changesFor(db, 'catchall-archived')).toHaveLength(0);
  });

  /**
   * A-3, stated as a CLOSED SET. Every other test here checks NULL-and-live
   * row by row; this one asserts the complete population, so an edit that
   * introduces a new NULL-scoped live row anywhere in the matrix — or archives
   * one that exists today — fails here even if it slips past the row-by-row
   * assertions.
   *
   * Why the migration must never archive a NULL-scoped row: NULL means
   * "not attributed", not "out of scope". Three different populations land
   * NULL — `v3Attribute`'s `unknown` (no usable key), its `unmatched` (C-27:
   * a CLOUD key that names no configured root, on an account with no
   * catch-all), and a row on an account whose config could not be read — and
   * NONE of them is an archive candidate. The one and only archive verdict is
   * `out-of-scope`, which by construction only the local-folder branch can
   * ever produce.
   *
   * Hand-off, and nothing more: per A-3 the ONLY thing that may archive a
   * NULL-scoped row is Task 3's `applyFolderScope` with `archiveNullScoped:
   * true` — and per DECISIONS **C-34 that flag is NOT on the store's input
   * type in this train at all**, so in this train nothing archives a
   * NULL-scoped row anywhere. Read the ⚠️ HAND-OFF section at the top of this
   * task before re-arming it: `explicit-unmatched` below is exactly the kind
   * of row it would destroy, and a re-walk cannot re-stamp a LIVE row (both
   * cloud connectors' `hashSkip` and core's `upsertDocument` skip an
   * unchanged live row outright), so archiving it is a one-way door.
   */
  it('never archives a NULL-scoped live row — the complete NULL population survives (A-3, C-27)', () => {
    migrate(db);

    const nullAndLive = (
      db
        .prepare(
          `SELECT id FROM documents
            WHERE scope_root_id IS NULL AND archived_at IS NULL
            ORDER BY id`,
        )
        .all() as Array<{ id: string }>
    ).map((r) => r.id);

    // catchall-nokey     — metadata has no root_folder_id (catch-all account)
    // explicit-nokey     — metadata is {} on a no-catch-all cloud account
    // explicit-unmatched — C-27: a frozen root id that matches nothing, on an
    //                      account with no catch-all. THE row this rule saves.
    // gmail-thread       — not a folder-scoped source at all
    // local-nokey        — metadata has no absPath on the ONE archiving account
    expect(nullAndLive).toEqual([
      'catchall-nokey',
      'explicit-nokey',
      'explicit-unmatched',
      'gmail-thread',
      'local-nokey',
    ]);
    for (const id of nullAndLive) {
      expect(changesFor(db, id)).toHaveLength(0);
    }

    // …and this is policy, not an inert archive path: the one account that
    // owns a spared NULL row AND is allowed to archive DID archive, in the
    // same pass. Exactly one document change in the whole migration.
    expect(changesFor(db, 'local-sibling')).toHaveLength(1);
    expect(docChangeCount(db)).toBe(1);
  });

  it('writes canonical folderRoots AND the A-2 legacy mirror, keeps other config keys, and never touches the cursor', () => {
    const cursorBefore = cursorOf(db, 'acc-explicit');
    expect(cursorBefore).toBe('{"page_token":"tok-1","backfill_done":true}');
    migrate(db);

    expect(configOf(db, 'acc-explicit')).toEqual({
      roots: [
        { rootFolderId: 'R1', rootName: 'Google Meet' },
        { rootFolderId: 'R2', rootName: 'Meet Recordings' },
      ],
      folderRoots: [
        { id: 'R1', name: 'Google Meet' },
        { id: 'R2', name: 'Meet Recordings' },
      ],
    });
    expect(configOf(db, 'acc-legacy-drive')).toEqual({
      roots: [{ rootFolderId: 'root', rootName: 'My Drive' }],
      folderRoots: [{ id: 'root', name: 'My Drive' }],
    });
    expect(configOf(db, 'acc-legacy-onedrive')).toEqual({
      roots: [{ rootFolderId: 'root', rootName: 'OneDrive' }],
      folderRoots: [{ id: 'root', name: 'OneDrive' }],
    });
    // local-folder: `paths` mirror carries the COLLAPSED set; `watch` survives.
    expect(configOf(db, 'acc-local')).toEqual({
      paths: ['/A'],
      watch: false,
      folderRoots: [{ id: '/A', name: 'A' }],
    });
    expect(configOf(db, 'acc-gmail')).toEqual({});

    // A-2's "one owner, one derivation": the mirror is exactly derivable from
    // `folderRoots`, which is what makes this migration and Task 3's
    // applyFolderScope agree byte-for-byte.
    for (const id of [
      'acc-catchall',
      'acc-explicit',
      'acc-legacy-drive',
      'acc-legacy-onedrive',
    ]) {
      const c = configOf(db, id) as {
        folderRoots: Array<{ id: string; name: string }>;
        roots: Array<{ rootFolderId: string; rootName: string }>;
      };
      expect(c.roots).toEqual(
        c.folderRoots.map((r) => ({ rootFolderId: r.id, rootName: r.name })),
      );
    }
    for (const id of ['acc-local', 'acc-win']) {
      const c = configOf(db, id) as {
        folderRoots: Array<{ id: string; name: string }>;
        paths: string[];
      };
      expect(c.paths).toEqual(c.folderRoots.map((r) => r.id));
    }

    // A3 option (i): the cursor is opaque to core and stays byte-identical.
    // Seeded non-null above so this assertion can actually fail.
    expect(cursorOf(db, 'acc-explicit')).toBe(
      '{"page_token":"tok-1","backfill_done":true}',
    );
    expect(cursorOf(db, 'acc-explicit')).toBe(cursorBefore);
  });

  it('makes every archive feed-visible with documents.seq === changes.seq, appends one account change per rewritten account, and re-running the body archives nothing new', () => {
    migrate(db);

    // One archived row in the whole matrix under C-27 — the local-folder one.
    for (const id of ['local-sibling']) {
      const ch = changesFor(db, id);
      expect(ch).toHaveLength(1);
      expect(ch[0].kind).toBe('document');
      const d = db
        .prepare(
          `SELECT seq, archived_at, updated_at FROM documents WHERE id = ?`,
        )
        .get(id) as {
        seq: number;
        archived_at: string | null;
        updated_at: string;
      };
      expect(d.archived_at).not.toBeNull();
      expect(d.updated_at).toBe(d.archived_at);
      expect(d.seq).toBe(ch[0].seq);
    }
    for (const id of [
      'acc-catchall',
      'acc-explicit',
      'acc-legacy-drive',
      'acc-legacy-onedrive',
      'acc-local',
      'acc-win',
    ]) {
      const ch = changesFor(db, id);
      expect(ch).toHaveLength(1);
      expect(ch[0].kind).toBe('account');
    }
    expect(changesFor(db, 'acc-gmail')).toHaveLength(0);

    // migrate() at the latest version is a no-op by construction — that says
    // nothing about the BODY's own `d.archived_at IS NULL` guard. Force v3 to
    // run AGAIN against a corpus that already has rows archived by the first
    // run: without the guard, each would get a SECOND changes row.
    rewindToV2(db);
    const docChangesBefore = docChangeCount(db);
    migrate(db);
    expect(docChangeCount(db)).toBe(docChangesBefore);
    expect(changesFor(db, 'local-sibling')).toHaveLength(1);
    expect(schemaVersion(db)).toBe(3);
  });
});

describe('schema v3: the mass-archive breaker (local-folder — the only source that archives)', () => {
  let db: Database.Database;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    db = new Database(':memory:');
    migrate(db);
    // LOCAL-FOLDER on purpose. Under C-27 a cloud account never archives at
    // all, so a cloud fixture here would pass for the wrong reason and stop
    // pinning the breaker. local-folder is the only source with an archive
    // pass, so it is the only place the breaker can be exercised.
    //
    // 150 of 151 live rows are out of scope — above BOTH thresholds the
    // engine's own reconcile breaker uses (engine.ts:133-134,
    // MASS_ARCHIVE_MIN_DOCS = 100 and MASS_ARCHIVE_RATIO = 0.5, compared at
    // engine.ts:307-310 with `>` on both). The breaker is an engine concept
    // and does not run during migration, so v3 re-implements it.
    seedAccount(db, 'acc-mass', 'local-folder', { paths: ['/KEEP'] });
    seedDoc(
      db,
      doc('mass-keep', 'acc-mass', 'file', meta({ absPath: '/KEEP/a.txt' })),
    );
    for (let i = 0; i < 150; i += 1) {
      seedDoc(
        db,
        doc(
          `mass-gone-${i}`,
          'acc-mass',
          'file',
          meta({ absPath: `/GONE/${i}.txt` }),
        ),
      );
    }
    rewindToV2(db);
  });

  afterEach(() => {
    db.close();
    warnSpy.mockRestore();
  });

  it('refuses the archival, leaves every row live with scope_root_id NULL, and names the account in a warning', () => {
    migrate(db);

    expect(live(db, 'mass-keep')).toBe(true);
    expect(scopeOf(db, 'mass-keep')).toBe('/KEEP');
    expect(live(db, 'mass-gone-0')).toBe(true);
    expect(live(db, 'mass-gone-149')).toBe(true);
    // NULL, not a fabricated root id. NULL is the honest "unattributed"
    // marker, and A-3 gives it exactly one deliberate, opt-in repair path
    // (applyFolderScope with archiveNullScoped:true, paired with a forced
    // re-establish). A fabricated root id would instead be a WRONG answer
    // that nothing can ever correct: contentHash excludes scope
    // (write-tx.ts hashes title/markdown/url/metadata/createdAt only) and
    // both cloud connectors hashSkip an unchanged live row, so a stale stamp
    // would survive every future re-walk and would also hide the row from the
    // one repair path that exists.
    expect(scopeOf(db, 'mass-gone-0')).toBeNull();
    expect(docChangeCount(db)).toBe(0);
    expect(
      warnSpy.mock.calls.some((args: unknown[]) =>
        args.some((a) => typeof a === 'string' && a.includes('acc-mass')),
      ),
    ).toBe(true);
    expect(schemaVersion(db)).toBe(3);
  });
});

/**
 * Fail open, never throw — a throw here rolls back the version step and every
 * subsequent boot repeats it (map §2's boot-death path: native error box,
 * exit(1), no window, no auto-update recovery). `JSON.parse('null')` SUCCEEDS
 * and yields null, and `typeof [] === 'object'`, so the guard must check the
 * parsed VALUE's shape — for `documents.metadata` AND for `accounts.config`,
 * which v2 never had to read.
 */
describe('schema v3: unreadable metadata and unreadable config are skipped, not archived', () => {
  let db: Database.Database;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    db = new Database(':memory:');
    migrate(db);

    seedAccount(db, 'acc-ok', 'google-docs', {
      roots: [{ rootFolderId: 'K', rootName: 'K' }],
    });
    seedDoc(db, doc('md-null', 'acc-ok', 'file', 'null'));
    seedDoc(db, doc('md-array', 'acc-ok', 'file', '[1,2]'));
    // NOTE: there is deliberately NO genuinely malformed-JSON fixture here
    // (e.g. '{oops'). Once v1's `json_extract(metadata, …)` partial indexes
    // exist SQLite evaluates the index expression at INSERT time and rejects
    // the row outright — measured on the bundled 3.53.2: '{oops' ERRORs while
    // 'null', '[1,2]', '"oops"', '123' and '{"a":1}' all insert. v2's own
    // test records the same fact verbatim
    // (file-indexability-migration.test.ts:441). `readJsonObject`'s `catch` is
    // kept regardless: it is correct defensive code for a corpus written
    // before those indexes existed, and its unreachability from an INSERT is a
    // fact about the corpus, not dead code.
    // Controls seeded AFTER the hostile rows so they page after them: a
    // `continue` must not truncate the scan.
    seedDoc(
      db,
      doc('ctl-hit', 'acc-ok', 'file', meta({ root_folder_id: 'K' })),
    );
    seedDoc(
      db,
      doc('ctl-gone', 'acc-ok', 'file', meta({ root_folder_id: 'X' })),
    );

    seedAccount(db, 'acc-cfg-null', 'google-docs', 'null');
    seedDoc(
      db,
      doc(
        'cfg-null-doc',
        'acc-cfg-null',
        'file',
        meta({ root_folder_id: 'X' }),
      ),
    );
    seedAccount(db, 'acc-cfg-array', 'onedrive', '[]');
    seedDoc(
      db,
      doc(
        'cfg-array-doc',
        'acc-cfg-array',
        'file',
        meta({ root_folder_id: 'X' }),
      ),
    );
    // local-folder whose `paths` is unusable — getRootPaths
    // (local-folder-source.ts:52-64) would throw SourcePermanentError at
    // runtime; the migration must skip the account, not the boot.
    seedAccount(db, 'acc-cfg-nopaths', 'local-folder', { watch: true });
    seedDoc(
      db,
      doc(
        'cfg-nopaths-doc',
        'acc-cfg-nopaths',
        'file',
        meta({ absPath: '/Z/a.txt' }),
      ),
    );
    // C-31. MIXED validity: one good path, one that is not a non-empty
    // string. The runtime validator is `.every(...)`
    // (local-folder-source.ts:57), so THIS ACCOUNT DOES NOT RUN AT ALL today
    // — every pull throws SourcePermanentError. A migration that instead
    // FILTERED the bad entry would silently redefine the account's scope to
    // the surviving subset, rewrite its config to match, and then archive
    // every row outside that subset — deciding on the user's behalf which of
    // their folders was the "real" one. `cfg-mixed-out` is a row that a
    // filtering implementation archives and an `.every` implementation
    // leaves alone. Match the runtime: any invalid entry ⇒ skip the account.
    seedAccount(db, 'acc-cfg-mixedpaths', 'local-folder', {
      paths: ['/M', 42],
      watch: false,
    });
    seedDoc(
      db,
      doc(
        'cfg-mixed-in',
        'acc-cfg-mixedpaths',
        'file',
        meta({ absPath: '/M/a.txt' }),
      ),
    );
    seedDoc(
      db,
      doc(
        'cfg-mixed-out',
        'acc-cfg-mixedpaths',
        'file',
        meta({ absPath: '/N/b.txt' }),
      ),
    );
    // Empty array — same rule, same outcome (`paths.length > 0` in the
    // runtime validator).
    seedAccount(db, 'acc-cfg-emptypaths', 'local-folder', { paths: [] });
    seedDoc(
      db,
      doc(
        'cfg-empty-doc',
        'acc-cfg-emptypaths',
        'file',
        meta({ absPath: '/Q/a.txt' }),
      ),
    );

    rewindToV2(db);
  });

  afterEach(() => {
    db.close();
    warnSpy.mockRestore();
  });

  it('leaves unreadable-metadata rows live with NULL scope while the controls around them are attributed normally', () => {
    migrate(db);

    for (const id of ['md-null', 'md-array']) {
      expect(live(db, id)).toBe(true);
      expect(scopeOf(db, id)).toBeNull();
      expect(changesFor(db, id)).toHaveLength(0);
    }
    expect(scopeOf(db, 'ctl-hit')).toBe('K');
    // `ctl-gone` sits outside the account's single root, but `acc-ok` is a
    // CLOUD (`google-docs`) account and under C-27 a cloud v3 archives
    // NOTHING — attribution only. So it stays live with a NULL scope; do not
    // "restore" a `live(...) === false` assertion here, and do not move the
    // fixture to local-folder: `ctl-hit` already proves the scan skips the
    // unreadable rows SELECTIVELY rather than bailing on the whole account.
    // What keeps `ctl-gone` a discriminator rather than a duplicate of
    // `md-null` is the last clause: an unattributed-but-readable row emits NO
    // per-document unreadable-metadata warning, while `md-null`/`md-array` do
    // (pinned below).
    expect(live(db, 'ctl-gone')).toBe(true);
    expect(scopeOf(db, 'ctl-gone')).toBeNull();
    expect(
      warnSpy.mock.calls.some((args: unknown[]) =>
        args.some((a) => typeof a === 'string' && a.includes('ctl-gone')),
      ),
    ).toBe(false);
    expect(schemaVersion(db)).toBe(3);
  });

  it('leaves an account with unreadable or unusable config completely untouched — config, documents and scope (C-31: `paths` validity matches the runtime `.every`)', () => {
    migrate(db);

    for (const [acc, docId] of [
      ['acc-cfg-null', 'cfg-null-doc'],
      ['acc-cfg-array', 'cfg-array-doc'],
      ['acc-cfg-nopaths', 'cfg-nopaths-doc'],
      // C-31: a MIXED-validity `paths` is unusable, exactly as the runtime
      // validator says. Both rows survive — including the one outside the
      // single valid path, which a filtering implementation would archive.
      ['acc-cfg-mixedpaths', 'cfg-mixed-in'],
      ['acc-cfg-mixedpaths', 'cfg-mixed-out'],
      ['acc-cfg-emptypaths', 'cfg-empty-doc'],
    ] as const) {
      expect(live(db, docId)).toBe(true);
      expect(scopeOf(db, docId)).toBeNull();
      expect(changesFor(db, acc)).toHaveLength(0);
    }
    expect(
      (
        db
          .prepare(`SELECT config FROM accounts WHERE id='acc-cfg-null'`)
          .get() as {
          config: string;
        }
      ).config,
    ).toBe('null');
    // The mixed config is left BYTE-IDENTICAL: no `folderRoots`, no rewritten
    // `paths`. Rewriting it would both invent a scope the user never chose
    // and silently repair an account the runtime deliberately refuses to run.
    expect(
      JSON.parse(
        (
          db
            .prepare(
              `SELECT config FROM accounts WHERE id='acc-cfg-mixedpaths'`,
            )
            .get() as {
            config: string;
          }
        ).config,
      ),
    ).toEqual({ paths: ['/M', 42], watch: false });
    expect(schemaVersion(db)).toBe(3);
  });

  it('logs the offending document id and the offending account id', () => {
    migrate(db);
    const warnedFor = (needle: string) =>
      warnSpy.mock.calls.some((args: unknown[]) =>
        args.some((a) => typeof a === 'string' && a.includes(needle)),
      );

    expect(warnedFor('md-null')).toBe(true);
    expect(warnedFor('md-array')).toBe(true);
    expect(warnedFor('acc-cfg-null')).toBe(true);
    expect(warnedFor('acc-cfg-nopaths')).toBe(true);
    expect(warnedFor('acc-cfg-mixedpaths')).toBe(true); // C-31
    expect(warnedFor('acc-cfg-emptypaths')).toBe(true); // C-31
  });
});

describe('schema v3: atomicity on failure', () => {
  it('rolls back the WHOLE version step — the column, the index, the config rewrite, the archive and the version marker', () => {
    const db = new Database(':memory:');
    migrate(db);
    // LOCAL-FOLDER: this test needs pass 2 to actually reach an archive, and
    // under C-27 only local-folder ever does. A cloud fixture here would make
    // the trigger unreachable and the whole test pass vacuously.
    seedAccount(db, 'acc-x', 'local-folder', { paths: ['/K'] });
    seedDoc(
      db,
      doc('doomed', 'acc-x', 'file', meta({ absPath: '/GONE/a.txt' })),
    );
    rewindToV2(db);

    // `UPDATE OF archived_at` fires on the column being MENTIONED in SET, so
    // this trips pass 2's archive but NOT pass 1b's `SET scope_root_id = ?`
    // (verified against SQLite 3.53.2).
    db.exec(`
      CREATE TRIGGER forced_abort
      BEFORE UPDATE OF archived_at ON documents
      BEGIN
        SELECT RAISE(ABORT, 'forced');
      END;
    `);
    const before = changeCount(db);

    // Match on the message, never on the constructor: a native SqliteError
    // crosses realms in an in-band jest run and `toThrow(SqliteError)` flakes
    // (known issue in this repo).
    expect(() => migrate(db)).toThrow(/forced/);

    expect(schemaVersion(db)).toBe(2);
    expect(live(db, 'doomed')).toBe(true);
    expect(changeCount(db)).toBe(before);
    expect(
      JSON.parse(
        (
          db.prepare(`SELECT config FROM accounts WHERE id='acc-x'`).get() as {
            config: string;
          }
        ).config,
      ),
    ).toEqual({ paths: ['/K'] });
    // SQLite DDL is transactional: the ALTER and the CREATE INDEX are undone
    // too, so the next boot re-runs a clean v3 rather than tripping on
    // `duplicate column name`. Verified empirically on 3.53.2.
    expect(
      (
        db.prepare(`PRAGMA table_info(documents)`).all() as Array<{
          name: string;
        }>
      ).map((c) => c.name),
    ).not.toContain('scope_root_id');
    expect(
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_documents_account_scope_root'`,
        )
        .get(),
    ).toBeUndefined();

    db.close();
  });
});

/**
 * The index exists for exactly one consumer: Task 3's `applyFolderScope`.
 * Under R8/A-1 that predicate is an explicit `IN`-list, NEVER a `NOT IN`:
 *
 *   account_id = ? AND archived_at IS NULL
 *     AND scope_root_id IN (…archiveScopeRootIds)
 *
 * with an EMPTY `archiveScopeRootIds` as the safe default (it archives
 * nothing, and is Drive-with-a-catch-all's and OneDrive's happy path).
 *
 * DECISIONS **C-34**: `archiveNullScoped` is NOT on `applyFolderScope`'s store
 * input type in this train, so the `IN_JSON_WITH_NULL_FLAG` shape below is NOT
 * a form Task 3 may ship — it is kept here only as the measured evidence that
 * adding such a disjunct later still plans onto this index (it narrows the
 * seek to `account_id`, and never degrades to a table scan). The two shapes
 * Task 3 may ship are the plain `IN`-list and the `remaining` count.
 *
 * If Task 3's SQL is not one of them, this test must be re-run against the
 * shape it does use — the assertion is on the PLAN, so it is cheap to
 * re-derive and it is the one place the two tasks' SQL is checked against the
 * same index.
 *
 * Plans measured 2026-09-04 on the bundled better-sqlite3 (SQLite 3.53.2).
 * Only the `USING INDEX … (cols)` fragment is pinned: `LIST SUBQUERY`,
 * `SCAN json_each VIRTUAL TABLE INDEX` and `CREATE BLOOM FILTER` are
 * planner decorations that move between SQLite releases.
 */
describe('schema v3: the index serves the consumer it exists for', () => {
  const SEEK_BOTH =
    'USING INDEX idx_documents_account_scope_root (account_id=? AND scope_root_id=?)';
  /** Measured on SQLite 3.53.2 with v1's partial indexes AND the new v3 index
   *  present: when only `account_id` is seekable the planner picks the
   *  equally-eligible pre-existing partial index `docs_account_recency`, not
   *  `idx_documents_account_scope_root`. The substantive claim is unchanged —
   *  the seek is on an INDEX and never degrades to `SCAN documents` — so this
   *  is deliberately a regex over the index NAME while `SEEK_BOTH` stays an
   *  exact string (Step 8 mutation #18 relies on that exactness). */
  const SEEK_ACCOUNT = /USING INDEX \S+ \(account_id=\?\)/;

  const IN_LITERAL = `SELECT id FROM documents
     WHERE account_id = ? AND archived_at IS NULL
       AND scope_root_id IN ('a','b')`;
  const IN_JSON = `SELECT id FROM documents
     WHERE account_id = ? AND archived_at IS NULL
       AND scope_root_id IN (SELECT value FROM json_each(?))`;
  /** C-34: `archiveNullScoped` was REMOVED from the shipped predicate — the
   *  refusal lives in the type, so this shape is NOT one Task 3 may ship. It
   *  is kept here only to record what the disjunct costs: the seek narrows
   *  from both index columns to `account_id` alone, and still never scans. */
  const IN_JSON_WITH_NULL_FLAG = `SELECT id FROM documents
     WHERE account_id = ? AND archived_at IS NULL
       AND (scope_root_id IN (SELECT value FROM json_each(?))
            OR (? AND scope_root_id IS NULL))`;
  const REMAINING = `SELECT COUNT(*) AS n FROM documents
     WHERE account_id = ? AND archived_at IS NULL`;

  const planOf = (
    db: Database.Database,
    sql: string,
    ...params: unknown[]
  ): string =>
    (
      db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as [])) as Array<{
        detail: string;
      }>
    )
      .map((r) => r.detail)
      .join(' | ');

  it("plans Task 3's R8 IN-list archive predicate onto idx_documents_account_scope_root, never a table scan", () => {
    const db = new Database(':memory:');
    migrate(db);

    // The IN-list forms seek BOTH index columns — strictly better than the
    // rejected NOT-IN predicate, which could only seek account_id.
    expect(planOf(db, IN_LITERAL, 'acc')).toContain(SEEK_BOTH);
    expect(planOf(db, IN_JSON, 'acc', '["a","b"]')).toContain(SEEK_BOTH);
    // With the archiveNullScoped disjunct the seek narrows to account_id,
    // which is still the index and still not a scan.
    expect(planOf(db, IN_JSON_WITH_NULL_FLAG, 'acc', '["a"]', 0)).toMatch(
      SEEK_ACCOUNT,
    );
    // …and the `remaining` count applyFolderScope returns.
    expect(planOf(db, REMAINING, 'acc')).toMatch(SEEK_ACCOUNT);

    for (const [sql, params] of [
      [IN_LITERAL, ['acc']],
      [IN_JSON, ['acc', '["a","b"]']],
      [IN_JSON_WITH_NULL_FLAG, ['acc', '["a"]', 0]],
      [REMAINING, ['acc']],
    ] as Array<[string, unknown[]]>) {
      expect(planOf(db, sql, ...params)).not.toMatch(/\bSCAN documents\b/);
    }
    db.close();
  });

  it('the `not a scan` assertion is a live discriminator, not a tautology', () => {
    // Same predicates against the same table WITHOUT the index: every one of
    // them degrades to `SCAN documents`. Without this control the assertions
    // above could pass on a corpus where the index was never created.
    const db = new Database(':memory:');
    db.exec(
      `CREATE TABLE documents(
         id TEXT PRIMARY KEY, account_id TEXT NOT NULL,
         archived_at TEXT, scope_root_id TEXT)`,
    );
    expect(planOf(db, IN_LITERAL, 'acc')).toMatch(/\bSCAN documents\b/);
    expect(planOf(db, IN_JSON, 'acc', '["a","b"]')).toMatch(
      /\bSCAN documents\b/,
    );
    expect(planOf(db, IN_JSON_WITH_NULL_FLAG, 'acc', '["a"]', 0)).toMatch(
      /\bSCAN documents\b/,
    );
    expect(planOf(db, REMAINING, 'acc')).toMatch(/\bSCAN documents\b/);
    db.close();
  });
});
