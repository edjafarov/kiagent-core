/**
 * @jest-environment node
 *
 * Runs the REAL migration against copies of the user's two real corpora, in
 * two cases, and reports per account what happened. Skipped unless
 * KIA_CORPUS_DRYRUN=1, because it depends on a machine that has those
 * corpora; nothing in CI does.
 *
 *   KIA_CORPUS_DRYRUN=1 npx jest src/main/core/store/__tests__/folder-scope-corpus-dryrun.test.ts
 *
 * CASE A — v3 IN ISOLATION. This is the headline: it measures v3 and only v3,
 * on the corpus exactly as it exists today. The clone's `meta.schemaVersion`
 * is stamped to '2' before `migrate()` runs, so the ladder executes
 * MIGRATIONS[2] alone. That is legal because v2 is a PURE ARCHIVE PASS with no
 * DDL whatsoever (schema.ts:319-395 — one paged SELECT, one INSERT INTO
 * changes, one UPDATE documents), so skipping it leaves no schema object
 * missing and no column v3 needs unwritten. v2 shipped in the
 * strict-file-indexability train and is not under test here.
 *
 * CASE B — THE REAL UPGRADE PATH. Both corpora are at schemaVersion 1, so a
 * plain `migrate()` runs v2 AND v3 back to back — what an upgrading user gets.
 * v3 is the only migration that writes `changes(kind='account')` (v2's insert
 * is hard-coded `VALUES('document', ?, ?)`, schema.ts:328-330) and it writes
 * them in pass 1a, before any document archive, so the seq of the FIRST
 * account change above the pre-migrate high-water mark is an unambiguous
 * boundary: document changes below it are v2's, above it are v3's.
 *
 * SAFETY. The source databases are opened for READING ONLY, and only by the
 * kernel: `fs.copyFileSync` copies the MAIN database file — never `-wal` or
 * `-shm` — into a temp dir, and every SQLite connection below is opened on
 * that copy. A running dev app is never written to. (`?immutable=1` is not
 * reachable here: better-sqlite3 does not enable SQLITE_OPEN_URI, so a
 * `file:…?immutable=1` filename fails with "unable to open database file";
 * the copy gives the same read-only guarantee by construction.) Each clone
 * lives in its own directory and that whole directory — clone, `-wal` and
 * `-shm` that `migrate()`'s `journal_mode = WAL` creates — is removed as soon
 * as its case finishes, so PEAK DISK IS ONE CLONE, not four.
 *
 * COPYFILE_FICLONE is requested but is only a hint — it silently falls back
 * to a byte copy, which is what actually happened on both corpora on
 * 2026-09-04 (4.9 s and real disk consumed).
 *
 * C-31 — WHY `quick_check` ALONE IS NOT A SNAPSHOT GUARANTEE. Copying only
 * the main DB file is not a reliable snapshot of a WAL-mode database. When
 * the `-wal` is NON-EMPTY, the main file is a *consistent but stale*
 * pre-WAL image: `PRAGMA quick_check` happily returns 'ok' on it, and the
 * run silently measures a corpus older than the one on disk. `quick_check`
 * catches a TORN copy; it cannot catch a STALE one. So the precondition is
 * asserted, not assumed: `requireQuiescentWal()` below fails the run if a
 * `-wal` exists with a non-zero size. Measured 2026-09-05 —
 * `kiagent/data/kiagent.db-wal` and `kiagent-dev/data/kiagent.db-wal` are
 * BOTH 0 bytes with both apps quit (SQLite truncates the WAL when the last
 * connection closes), so the prescribed run is safe today. If the assertion
 * fires: quit the packaged app AND the dev app, confirm the `-wal` is 0
 * bytes, and rerun. Do not work around it by copying the `-wal` too — a
 * three-file copy taken while a writer is live is exactly the torn state
 * this is avoiding. The principled alternative, if the app can never be
 * quit, is SQLite's online backup API (`db.backup(dest)` in better-sqlite3),
 * which takes a real snapshot of a live database.
 *
 * The `quick_check` immediately after opening is still run, as the guard
 * against a torn copy. If it does not return 'ok', quit both apps and rerun
 * — do not try to interpret the numbers from a torn copy.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

import { migrate } from '../schema';

jest.setTimeout(30 * 60 * 1000);

const FOLDER_SOURCES = `('local-folder','google-docs','onedrive')`;

const CORPORA = [
  {
    label: 'production',
    src: path.join(
      os.homedir(),
      'Library/Application Support/kiagent/data/kiagent.db',
    ),
  },
  {
    label: 'dev',
    src: path.join(
      os.homedir(),
      'Library/Application Support/kiagent-dev/data/kiagent.db',
    ),
  },
];

/**
 * The production Google Drive account from spec-reality-diff A0 / DECISIONS
 * R6. Every number here was measured on 2026-09-04 against the live corpus.
 * The account is `needsReauth` and therefore cannot sync and cannot grow; if
 * it is ever reconnected, re-measure and update these rather than relaxing
 * them.
 */
const A0_ACCOUNT = '019fd782-1685-7c30-b1ae-979621574e08';
const A0_LIVE_AT_V1 = 316;
/** Live rows whose frozen `root_folder_id` is NOT the configured `'root'`. */
const A0_STALE_ROWS = 314;
/** Distinct stale ids those 314 rows are spread across (25 incl. `'root'`). */
const A0_DISTINCT_STALE_IDS = 24;
const A0_ARCHIVED_BY_V2 = 42;
const A0_LIVE_AFTER_FULL_LADDER = A0_LIVE_AT_V1 - A0_ARCHIVED_BY_V2; // 274

interface Api {
  db: Database.Database;
  one: <T>(sql: string, ...p: unknown[]) => T;
  all: <T>(sql: string, ...p: unknown[]) => T[];
}

const run = process.env.KIA_CORPUS_DRYRUN === '1' ? describe : describe.skip;

run('schema v3 against the real corpora', () => {
  let tmp: string;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-v3-dryrun-'));
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /**
   * C-31 — the STALENESS precondition, asserted rather than assumed.
   *
   * Copying only the main DB file is a correct snapshot ONLY while the WAL is
   * empty. With a non-empty `-wal` the main file is a consistent but STALE
   * pre-WAL image that `PRAGMA quick_check` accepts without complaint, and
   * the whole run would then measure a corpus that is not the one on disk —
   * silently, with green assertions. Measured 2026-09-05 with both apps
   * quit: both `-wal` files are 0 bytes. A missing `-wal` is equally fine
   * (SQLite deletes it on a clean last close).
   */
  function requireQuiescentWal(label: string, src: string): void {
    const wal = `${src}-wal`;
    const size = fs.existsSync(wal) ? fs.statSync(wal).size : 0;
    if (size !== 0) {
      throw new Error(
        `dry run: ${label} corpus has a NON-EMPTY WAL (${wal}, ${size} bytes). ` +
          `Copying the main DB file alone would snapshot a consistent but STALE ` +
          `pre-WAL image that quick_check accepts, so the numbers below would be ` +
          `meaningless. Quit the packaged app AND the dev app, confirm the -wal is ` +
          `0 bytes, and rerun. Do NOT copy the -wal alongside it.`,
      );
    }
  }

  /** Copy → open → quick_check → body → close → delete the whole clone dir.
   *
   *  C-31 — A MISSING CORPUS IS A HARD FAILURE, NOT A SKIP. The earlier draft
   *  returned `false` here and every caller ignored the return value, so on a
   *  machine without the corpora this whole file reported PASS having asserted
   *  nothing at all — the most valuable step in the task, silently green. The
   *  env gate (`KIA_CORPUS_DRYRUN=1`) is the opt-in; once you have opted in,
   *  the corpora must be there. The per-test `expect.hasAssertions()` at each
   *  call site is the other half: it fails a body that runs but asserts
   *  nothing. */
  function withClone(
    caseName: string,
    label: string,
    src: string,
    body: (api: Api) => void,
  ): void {
    if (!fs.existsSync(src)) {
      throw new Error(
        `dry run: ${label} corpus not present at ${src}. KIA_CORPUS_DRYRUN=1 was set, ` +
          `so this is a hard failure, not a skip — this test exists to run against the ` +
          `REAL corpora and proves nothing without them. Unset KIA_CORPUS_DRYRUN to skip ` +
          `the suite deliberately, or run it on the machine that has them.`,
      );
    }
    requireQuiescentWal(label, src);
    const dir = path.join(tmp, `${caseName}-${label}`);
    fs.mkdirSync(dir, { recursive: true });
    const clone = path.join(dir, 'kiagent.db');
    fs.copyFileSync(src, clone, fs.constants.COPYFILE_FICLONE);
    const db = new Database(clone);
    try {
      // THE consistency guard. FICLONE is a hint and usually degrades to a
      // byte copy, so a copy taken while an app holds the DB open can be torn.
      // That must fail loudly here, not as a confusing migration error twenty
      // seconds later. Not 'ok' => quit the app and rerun. (It does NOT catch
      // a stale pre-WAL image — `requireQuiescentWal` above owns that.)
      expect(db.pragma('quick_check', { simple: true })).toBe('ok');
      body({
        db,
        one: <T>(sql: string, ...p: unknown[]) =>
          db.prepare(sql).get(...(p as [])) as T,
        all: <T>(sql: string, ...p: unknown[]) =>
          db.prepare(sql).all(...(p as [])) as T[],
      });
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  interface LiveRow {
    account_id: string;
    n: number;
    nulls: number;
  }

  const liveByAccount = (api: Api) =>
    api.all<{ account_id: string; n: number }>(
      `SELECT d.account_id, COUNT(*) n FROM documents d
         JOIN accounts a ON a.id = d.account_id
        WHERE d.archived_at IS NULL AND a.source IN ${FOLDER_SOURCES}
        GROUP BY 1`,
    );

  const liveWithScope = (api: Api) =>
    api.all<LiveRow>(
      `SELECT d.account_id, COUNT(*) n,
              SUM(CASE WHEN d.scope_root_id IS NULL THEN 1 ELSE 0 END) nulls
         FROM documents d JOIN accounts a ON a.id = d.account_id
        WHERE d.archived_at IS NULL AND a.source IN ${FOLDER_SOURCES}
        GROUP BY 1`,
    );

  const docChangesAbove = (api: Api, seq: number) =>
    api.all<{ account_id: string; n: number }>(
      `SELECT d.account_id, COUNT(*) n FROM documents d
         JOIN changes c ON c.ref_id = d.id AND c.kind='document'
        WHERE c.seq > ? GROUP BY 1`,
      seq,
    );

  // ────────────────────────────────────────────────────────────────────────
  describe('case A — v3 in isolation (v2 skipped on the CLONE)', () => {
    it.each(CORPORA)('$label', ({ label, src }) => {
      // C-31: a body that asserts nothing must never report PASS. `withClone`
      // makes a MISSING corpus fail; this makes an EMPTY body fail.
      expect.hasAssertions();
      withClone('caseA', label, src, (api) => {
        const { one, all, db } = api;

        expect(
          one<{ value: string }>(
            `SELECT value FROM meta WHERE key='schemaVersion'`,
          ).value,
        ).toBe('1');

        const before = new Map(
          liveByAccount(api).map((r) => [r.account_id, r.n] as const),
        );

        // ── INPUT SIDE, asserted independently of the migration, so
        //    "316 live in" is falsifiable on its own.
        const a0Present = before.has(A0_ACCOUNT);
        if (a0Present) {
          const cfg = JSON.parse(
            one<{ config: string }>(
              `SELECT config FROM accounts WHERE id = ?`,
              A0_ACCOUNT,
            ).config,
          ) as { roots: Array<{ rootFolderId: string }> };
          expect(cfg.roots.map((r) => r.rootFolderId)).toContain('root');
          expect(before.get(A0_ACCOUNT)).toBe(A0_LIVE_AT_V1);
          expect(
            one<{ n: number }>(
              `SELECT COUNT(*) n FROM documents
                WHERE account_id = ? AND archived_at IS NULL
                  AND json_extract(metadata,'$.root_folder_id') IS NOT 'root'`,
              A0_ACCOUNT,
            ).n,
          ).toBe(A0_STALE_ROWS);
          expect(
            one<{ n: number }>(
              `SELECT COUNT(DISTINCT json_extract(metadata,'$.root_folder_id')) n
                 FROM documents
                WHERE account_id = ? AND archived_at IS NULL
                  AND json_extract(metadata,'$.root_folder_id') IS NOT 'root'`,
              A0_ACCOUNT,
            ).n,
          ).toBe(A0_DISTINCT_STALE_IDS);
          expect(
            one<{ n: number }>(
              `SELECT COUNT(*) n FROM documents
                WHERE account_id = ? AND archived_at IS NULL
                  AND json_extract(metadata,'$.root_folder_id') IS NULL`,
              A0_ACCOUNT,
            ).n,
          ).toBe(0);
        }

        const s0 = one<{ n: number }>(
          `SELECT COALESCE(MAX(seq),0) n FROM changes`,
        ).n;

        // Isolate v3: v2 is a pure archive pass with no DDL, so skipping it
        // leaves the schema complete.
        db.prepare(`UPDATE meta SET value='2' WHERE key='schemaVersion'`).run();
        const started = Date.now();
        migrate(db);
        const elapsed = Date.now() - started;

        expect(
          one<{ value: string }>(
            `SELECT value FROM meta WHERE key='schemaVersion'`,
          ).value,
        ).toBe('3');

        const archivedByV3 = docChangesAbove(api, s0);
        const after = liveWithScope(api);

        console.log(`\n=== ${label} · CASE A · v3 alone in ${elapsed} ms ===`);
        for (const row of after) {
          console.log(
            `  ${row.account_id}: liveIn=${before.get(row.account_id) ?? 0}` +
              ` liveOut=${row.n}` +
              ` v3Archived=${archivedByV3.find((a) => a.account_id === row.account_id)?.n ?? 0}` +
              ` scopeNull=${row.nulls}`,
          );
        }
        console.log(
          '  configs:',
          JSON.stringify(
            all(
              `SELECT id, config FROM accounts WHERE source IN ${FOLDER_SOURCES}`,
            ),
            null,
            2,
          ),
        );

        // ── PASS CRITERIA ──────────────────────────────────────────────
        // 1. v3 archives NOTHING, on EVERY account.
        //    NOTE (C-27): for the four CLOUD accounts this is now true by
        //    construction — the migration has no cloud archive pass at all —
        //    so this assertion no longer discriminates the cloud rule. It is
        //    still a live gate for the local-folder account (01a033e5), which
        //    DOES have an archive pass, and it is still worth keeping as a
        //    regression net. The cloud rule's real test is
        //    `explicit-unmatched` in folder-scope-migration.test.ts.
        expect(archivedByV3).toEqual([]);
        // 2. Every live folder-scoped row is attributed. THIS is the
        //    assertion that carries weight for C-27 on the real corpora: an
        //    implementation that left mismatches NULL where it should have
        //    matched them (e.g. a broken catch-all branch) shows up here as a
        //    non-zero `nulls`, on an account where 314 of 316 rows depend on
        //    the catch-all rule.
        for (const row of after) expect(row.nulls).toBe(0);
        // 3. Live in === live out, per account. Nothing left, nothing added.
        for (const row of after) {
          expect(row.n).toBe(before.get(row.account_id) ?? 0);
        }
        expect(after.length).toBe(before.size);

        // 4. THE HEADLINE (DECISIONS R6, spec-reality-diff A0). On the
        //    production Drive account: 316 live in, 316 live out, 0 archived,
        //    0 unattributed — and every one of the 316 attributed to the
        //    'root' catch-all, including all 314 whose frozen root_folder_id
        //    names a folder that is no longer configured. Under the pre-R6
        //    spec this account lost 314 of 316 rows on a `needsReauth`
        //    account that cannot re-walk, with no way to get them back.
        if (a0Present) {
          const a0 = after.find((r) => r.account_id === A0_ACCOUNT);
          expect(a0).toBeDefined();
          expect(a0!.n).toBe(A0_LIVE_AT_V1);
          expect(a0!.nulls).toBe(0);
          expect(
            archivedByV3.find((r) => r.account_id === A0_ACCOUNT),
          ).toBeUndefined();
          expect(
            one<{ n: number }>(
              `SELECT COUNT(*) n FROM documents
                WHERE account_id = ? AND archived_at IS NULL
                  AND scope_root_id = 'root'`,
              A0_ACCOUNT,
            ).n,
          ).toBe(A0_LIVE_AT_V1);
        }
      });
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  describe('case B — the real upgrade path, full ladder v1 → v3', () => {
    it.each(CORPORA)('$label', ({ label, src }) => {
      expect.hasAssertions(); // C-31, as in case A
      withClone('caseB', label, src, (api) => {
        const { one, all, db } = api;

        expect(
          one<{ value: string }>(
            `SELECT value FROM meta WHERE key='schemaVersion'`,
          ).value,
        ).toBe('1');

        const before = new Map(
          liveByAccount(api).map((r) => [r.account_id, r.n] as const),
        );
        const s0 = one<{ n: number }>(
          `SELECT COALESCE(MAX(seq),0) n FROM changes`,
        ).n;

        const started = Date.now();
        migrate(db);
        const elapsed = Date.now() - started;

        expect(
          one<{ value: string }>(
            `SELECT value FROM meta WHERE key='schemaVersion'`,
          ).value,
        ).toBe('3');

        // v3's first write is its account-change row; v2 writes only
        // kind='document'. So this boundary is unambiguous — and it must
        // exist, because both corpora have folder-scoped accounts.
        const boundary = one<{ n: number | null }>(
          `SELECT MIN(seq) n FROM changes WHERE kind='account' AND seq > ?`,
          s0,
        ).n;
        expect(boundary).not.toBeNull();

        const v2Archived = new Map(
          all<{ account_id: string; n: number }>(
            `SELECT d.account_id, COUNT(*) n FROM documents d
               JOIN changes c ON c.ref_id = d.id AND c.kind='document'
              WHERE c.seq > ? AND c.seq < ? GROUP BY 1`,
            s0,
            boundary!,
          ).map((r) => [r.account_id, r.n] as const),
        );
        const archivedByV3 = docChangesAbove(api, boundary!);
        const after = liveWithScope(api);

        console.log(`\n=== ${label} · CASE B · v1→v3 in ${elapsed} ms ===`);
        for (const row of after) {
          console.log(
            `  ${row.account_id}: live@v1=${before.get(row.account_id) ?? 0}` +
              ` v2Archived=${v2Archived.get(row.account_id) ?? 0}` +
              ` v3Archived=${archivedByV3.find((a) => a.account_id === row.account_id)?.n ?? 0}` +
              ` liveAfter=${row.n} scopeNull=${row.nulls}`,
          );
        }
        console.log(
          '  configs:',
          JSON.stringify(
            all(
              `SELECT id, config FROM accounts WHERE source IN ${FOLDER_SOURCES}`,
            ),
            null,
            2,
          ),
        );

        // ── PASS CRITERIA ──────────────────────────────────────────────
        // 1. v3 archives NOTHING on either real corpus, on any account. As in
        //    case A: guaranteed by construction for cloud (C-27), a live gate
        //    for the local-folder account.
        expect(archivedByV3).toEqual([]);
        // 2. Every live folder-scoped row v3 was handed is attributed.
        for (const row of after) expect(row.nulls).toBe(0);
        // 3. Every account's live count is exactly what v2 left behind — the
        //    whole delta is v2's file-indexability policy, none of it v3's.
        for (const row of after) {
          expect(row.n).toBe(
            (before.get(row.account_id) ?? 0) -
              (v2Archived.get(row.account_id) ?? 0),
          );
        }
        // 4. The A0 account through the real ladder: 316 at v1, 42 removed by
        //    v2's indexability policy, 274 handed to v3, 274 out, 0 archived
        //    by v3, all 274 attributed to the catch-all.
        if (before.has(A0_ACCOUNT)) {
          const a0 = after.find((r) => r.account_id === A0_ACCOUNT);
          expect(a0).toBeDefined();
          expect(before.get(A0_ACCOUNT)).toBe(A0_LIVE_AT_V1);
          expect(v2Archived.get(A0_ACCOUNT)).toBe(A0_ARCHIVED_BY_V2);
          expect(a0!.n).toBe(A0_LIVE_AFTER_FULL_LADDER);
          expect(a0!.nulls).toBe(0);
          expect(
            one<{ n: number }>(
              `SELECT COUNT(*) n FROM documents
                WHERE account_id = ? AND archived_at IS NULL
                  AND scope_root_id = 'root'`,
              A0_ACCOUNT,
            ).n,
          ).toBe(A0_LIVE_AFTER_FULL_LADDER);
        }
      });
    });
  });
});
