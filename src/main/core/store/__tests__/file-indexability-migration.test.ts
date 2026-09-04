/**
 * Schema v2: archives `documents` rows @shared/file-indexability's
 * `decideFileIndexing` would reject, left over from before that policy
 * existed. Only `type = 'file'` rows from the three sources the migration
 * knows how to classify — `local-folder` (profile 'local-folder') and
 * `google-docs` / `onedrive` (profile 'cloud-drive') — are candidates.
 * Every other source (e.g. `gmail`) and every other type (Google's own
 * native docs export as `type = 'gdocs.doc'`, never `'file'`) must be left
 * completely untouched.
 *
 * The matrix below is seeded from facts read out of a REAL 11 GB dev
 * corpus, not invented: bare (unprefixed) `accounts.source` literals, a
 * `type = 'file'` split where the same corpus held 298 untouched
 * `gdocs.doc` rows against only 40 `file` rows, both metadata key spellings
 * genuinely coexisting (`mime`/`mime_type`, `sizeBytes`/`size_bytes`/
 * `size`), and real terminal `unsupported` noise
 * (`vnd.google-apps.presentation` among it). Getting the source literal or
 * the type filter wrong — or reading only one metadata spelling — turns
 * this migration into a silent no-op that a looser fixture would never
 * catch, which is exactly what these assertions are built to catch.
 */
import Database from 'better-sqlite3';

import { migrate } from '../schema';

type Row = Record<string, string | number | null>;

function seedAccount(db: Database.Database, id: string, source: string): void {
  db.prepare(
    `INSERT INTO accounts(id, source, identifier, status, created_at)
     VALUES (?, ?, ?, 'idle', '2026-01-01T00:00:00Z')`,
  ).run(id, source, `${id}@example.com`);
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

/** One candidate `documents` row. `title` defaults to null (metadata carries
 *  the filename); pass one explicitly to exercise the title fallback. */
function candidate(
  id: string,
  accountId: string,
  type: string,
  metadata: Record<string, unknown>,
  title: string | null = null,
): Row {
  return candidateRawMetadata(
    id,
    accountId,
    type,
    JSON.stringify(metadata),
    title,
  );
}

/** Same as `candidate`, but takes the `metadata` column verbatim — for
 *  seeding shapes `JSON.stringify` would never produce (a literal JSON
 *  `null`, malformed JSON), which is exactly what F1 needs to reproduce. */
function candidateRawMetadata(
  id: string,
  accountId: string,
  type: string,
  rawMetadata: string,
  title: string | null = null,
): Row {
  return {
    id,
    account_id: accountId,
    external_id: id,
    type,
    title,
    markdown: null,
    metadata: rawMetadata,
    content_hash: `hash-${id}`,
    seq: 0,
    archived_at: null,
    created_at: '2026-01-01T00:00:00Z',
    ingested_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };
}

/**
 * Seeds accounts for all four sources (three the migration classifies, plus
 * `gmail` — a source outside its scope, confirmed present in the real
 * corpus's `accounts` table) and the full candidate matrix.
 */
function seedMatrix(db: Database.Database): void {
  seedAccount(db, 'acc-local', 'local-folder');
  seedAccount(db, 'acc-google', 'google-docs');
  seedAccount(db, 'acc-onedrive', 'onedrive');
  seedAccount(db, 'acc-gmail', 'gmail');

  // local-folder: mime, filename, ext, absPath, size, sizeBytes.
  seedDoc(
    db,
    candidate('local-pdf', 'acc-local', 'file', {
      mime: 'application/pdf',
      filename: 'report.pdf',
      ext: 'pdf',
      absPath: '/Users/x/Documents/report.pdf',
      sizeBytes: 12_345,
      size: 12_345,
    }),
  );
  seedDoc(
    db,
    candidate('local-mp3', 'acc-local', 'file', {
      mime: 'audio/mpeg',
      filename: 'memo.mp3',
      ext: 'mp3',
      absPath: '/Users/x/Music/memo.mp3',
      size: 500_000, // 'size' only — exercises the 3rd-tier size fallback.
    }),
  );
  seedDoc(
    db,
    candidate('local-zip', 'acc-local', 'file', {
      mime: 'application/zip',
      filename: 'archive.zip',
      ext: 'zip',
      absPath: '/Users/x/Downloads/archive.zip',
      sizeBytes: 999,
    }),
  );
  // 'size' only, no sizeBytes/size_bytes — and unlike local-mp3 (whose
  // decision doesn't depend on size at all), THIS decision flips on whether
  // the tier is actually read: over the 50 MiB local-PDF vision cap when
  // read correctly (archived); an unread size is never treated as over any
  // cap, which would instead index it. Discriminates the 3rd size tier.
  seedDoc(
    db,
    candidate('local-huge-pdf-size-tier', 'acc-local', 'file', {
      mime: 'application/pdf',
      filename: 'huge3.pdf',
      absPath: '/Users/x/Documents/huge3.pdf',
      size: 60 * 1024 * 1024,
    }),
  );
  // google-docs `file` rows: mime AND mime_type, size_bytes AND sizeBytes.
  seedDoc(
    db,
    candidate(
      'google-pdf',
      'acc-google',
      'file',
      { mime_type: 'application/pdf', sizeBytes: 100_000 }, // no 'mime', no filename.
      'Uploaded scan', // exercises the title fallback for filename.
    ),
  );
  seedDoc(
    db,
    candidate('google-mp3', 'acc-google', 'file', {
      mime: 'audio/mpeg',
      mime_type: 'audio/mpeg',
      filename: 'clip.mp3',
      size_bytes: 4_000_000, // 'size_bytes' only — 2nd-tier size fallback.
    }),
  );
  seedDoc(
    db,
    candidate('google-mp4', 'acc-google', 'file', {
      mime_type: 'video/mp4', // 'mime_type' only — 2nd-tier mime fallback.
      filename: 'video.mp4',
      sizeBytes: 5_000_000,
    }),
  );
  seedDoc(
    db,
    candidate('google-zip', 'acc-google', 'file', {
      mime: 'application/zip',
      filename: 'bundle.zip',
      size: 1_000, // 'size' only.
    }),
  );
  seedDoc(
    db,
    candidate('google-sheet', 'acc-google', 'file', {
      mime: 'application/vnd.google-apps.spreadsheet',
      filename: 'Q3 Numbers',
    }),
  );
  // Real corpus noise (per the migration brief): a non-document google-apps
  // MIME on a `file` row must fall through to 'unsupported' with no special
  // casing, same as google-sheet above.
  seedDoc(
    db,
    candidate('google-presentation', 'acc-google', 'file', {
      mime: 'application/vnd.google-apps.presentation',
      filename: 'Deck',
    }),
  );
  // A `file`-typed row that nonetheless carries the NATIVE document MIME —
  // decideFileIndexing has no concept of "native doc" and would otherwise
  // send this to 'unsupported' (archived). The migration must special-case
  // exactly this one MIME to preserve it.
  seedDoc(
    db,
    candidate('google-doc-mistyped-file', 'acc-google', 'file', {
      mime: 'application/vnd.google-apps.document',
      filename: 'Mistyped native doc',
    }),
  );
  // The REAL shape a native Google Doc takes: type 'gdocs.doc', never
  // 'file'. The SQL type filter alone must keep this untouched — though in
  // production so does the document-MIME override above, since a real
  // native doc always carries that MIME too.
  seedDoc(
    db,
    candidate('google-native-doc', 'acc-google', 'gdocs.doc', {
      mime: 'application/vnd.google-apps.document',
      filename: 'Native doc',
    }),
  );
  // A second non-'file' type, but WITHOUT the document MIME, so this one
  // stays live ONLY via the `d.type = 'file'` filter — the override above
  // can't rescue it. Without this row, dropping the type filter entirely
  // would slip past every other assertion here (google-native-doc's own
  // document MIME would keep it live regardless), silently proving nothing.
  seedDoc(
    db,
    candidate('google-other-type-zip', 'acc-google', 'gdocs.folder', {
      mime: 'application/zip',
      filename: 'bundle.zip',
      size: 1_000,
    }),
  );

  // onedrive `file` rows.
  seedDoc(
    db,
    candidate('onedrive-pdf', 'acc-onedrive', 'file', {
      mime: 'application/pdf',
      filename: 'notes.pdf',
      sizeBytes: 200_000,
    }),
  );
  seedDoc(
    db,
    candidate('onedrive-mp3', 'acc-onedrive', 'file', {
      mime_type: 'application/octet-stream', // no usable mime — ext decides.
      filename: 'voice.mp3',
      size_bytes: 3_000_000,
    }),
  );
  seedDoc(
    db,
    candidate('onedrive-big-pdf', 'acc-onedrive', 'file', {
      mime: 'application/pdf',
      filename: 'huge.pdf',
      sizeBytes: 30 * 1024 * 1024, // over the 25 MiB cloud cap — pins tier 1.
    }),
  );
  // 'size_bytes' only, no sizeBytes/size — same over-cap PDF as
  // onedrive-big-pdf above, but read through the 2nd size tier instead of
  // the 1st. Discriminates that tier specifically: an unread size_bytes
  // falls through to the absent 'size' tier, size becomes unknown, and an
  // unknown size is never treated as over any cap — it would index instead.
  seedDoc(
    db,
    candidate('onedrive-big-pdf-size-bytes-tier', 'acc-onedrive', 'file', {
      mime: 'application/pdf',
      filename: 'huge2.pdf',
      size_bytes: 30 * 1024 * 1024,
    }),
  );

  // gmail: a source entirely outside the migration's scope. Must never be
  // touched even though this row would fail the policy if it were.
  seedDoc(
    db,
    candidate('gmail-mp3', 'acc-gmail', 'file', {
      mime: 'audio/mpeg',
      filename: 'voicemail.mp3',
      sizeBytes: 100,
    }),
  );
}

function live(db: Database.Database, id: string): boolean {
  const row = db
    .prepare(`SELECT archived_at FROM documents WHERE id = ?`)
    .get(id) as { archived_at: string | null } | undefined;
  if (!row) throw new Error(`no document seeded with id '${id}'`);
  return row.archived_at === null;
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
): Array<{ seq: number; kind: string; ref_id: string }> {
  return db
    .prepare(
      `SELECT seq, kind, ref_id FROM changes WHERE ref_id = ? ORDER BY seq`,
    )
    .all(id) as Array<{ seq: number; kind: string; ref_id: string }>;
}

function changeCount(db: Database.Database): number {
  return (
    db.prepare(`SELECT COUNT(*) AS n FROM changes`).get() as { n: number }
  ).n;
}

describe('schema v2: archive file-indexability rejects', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db); // builds the full schema, including v2 (no rows yet — no-op).
    seedMatrix(db);
    // Simulate a real pre-v2 corpus: tables and data already exist, but the
    // version marker says v1, as it would before this migration existed.
    db.prepare(`UPDATE meta SET value='1' WHERE key='schemaVersion'`).run();
  });

  afterEach(() => {
    db.close();
  });

  it('archives everything the policy rejects and leaves everything else live', () => {
    migrate(db);

    expect(live(db, 'local-pdf')).toBe(true);
    expect(live(db, 'local-mp3')).toBe(true);
    expect(live(db, 'local-zip')).toBe(false);
    expect(live(db, 'local-huge-pdf-size-tier')).toBe(false); // size-tier-3 discriminator
    expect(live(db, 'google-pdf')).toBe(true);
    expect(live(db, 'google-mp3')).toBe(false);
    expect(live(db, 'google-mp4')).toBe(false);
    expect(live(db, 'google-zip')).toBe(false);
    expect(live(db, 'google-sheet')).toBe(false);
    expect(live(db, 'google-presentation')).toBe(false);
    expect(live(db, 'google-doc-mistyped-file')).toBe(true);
    expect(live(db, 'google-native-doc')).toBe(true); // type 'gdocs.doc' — never classified
    expect(live(db, 'google-other-type-zip')).toBe(true); // type 'gdocs.folder' — never classified
    expect(live(db, 'onedrive-pdf')).toBe(true);
    expect(live(db, 'onedrive-mp3')).toBe(false);
    expect(live(db, 'onedrive-big-pdf')).toBe(false);
    expect(live(db, 'onedrive-big-pdf-size-bytes-tier')).toBe(false); // size-tier-2 discriminator
    expect(live(db, 'gmail-mp3')).toBe(true); // source outside scope

    expect(schemaVersion(db)).toBe(2);
  });

  it('gives every archived row a changes row with documents.seq === changes.seq, and re-migrating is a no-op', () => {
    migrate(db);

    const archivedIds = [
      'local-zip',
      'local-huge-pdf-size-tier',
      'google-mp3',
      'google-mp4',
      'google-zip',
      'google-sheet',
      'google-presentation',
      'onedrive-mp3',
      'onedrive-big-pdf',
      'onedrive-big-pdf-size-bytes-tier',
    ];
    const liveIds = [
      'local-pdf',
      'local-mp3',
      'google-pdf',
      'google-doc-mistyped-file',
      'google-native-doc',
      'google-other-type-zip',
      'onedrive-pdf',
      'gmail-mp3',
    ];

    for (const id of archivedIds) {
      const changes = changesFor(db, id);
      expect(changes).toHaveLength(1);
      expect(changes[0].kind).toBe('document');
      const doc = db
        .prepare(`SELECT seq, archived_at FROM documents WHERE id = ?`)
        .get(id) as { seq: number; archived_at: string | null };
      expect(doc.archived_at).not.toBeNull();
      expect(doc.seq).toBe(changes[0].seq);
    }
    for (const id of liveIds) {
      expect(changesFor(db, id)).toHaveLength(0);
    }

    // migrate() at the latest version is a no-op by construction (the ladder
    // loop skips entirely) — that says nothing about the migration BODY's
    // own `d.archived_at IS NULL` guard. Force the v2 entry to run AGAIN,
    // this time against a corpus that already has archived rows from the
    // run above: if the guard were dropped, every already-archived id would
    // get a SECOND `changes` row here.
    db.prepare(`UPDATE meta SET value='1' WHERE key='schemaVersion'`).run();
    const before = changeCount(db);
    migrate(db);
    expect(changeCount(db)).toBe(before);
    for (const id of archivedIds) {
      expect(changesFor(db, id)).toHaveLength(1); // still exactly one, not two
    }
    expect(schemaVersion(db)).toBe(2);
  });
});

/**
 * F1/N1: metadata the migration cannot read as a genuine object must be
 * SKIPPED (left live, warned) — never archived, never thrown on. Kept in
 * its own describe with its own tiny fixture set, deliberately separate
 * from `seedMatrix` above: these two rows exist purely to make
 * `console.warn` fire, and folding them into the shared matrix meant every
 * run of the two tests above printed an unrelated warning + stack trace
 * (N2). `console.warn` itself is only mocked here, at the test boundary —
 * the production call in schema.ts is untouched, so it stays exactly as
 * load-bearing for diagnosing a skipped row in a real corpus as before;
 * mocking it in Jest just keeps this suite's own output clean. Both tests
 * in this block share the one spy; the second reads its recorded calls to
 * assert the offending document ids were actually logged.
 */
describe('schema v2: unreadable metadata is skipped, not archived', () => {
  let db: Database.Database;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    db = new Database(':memory:');
    migrate(db);
    seedAccount(db, 'acc-local', 'local-folder');
    // Parses to JS `null`. `json_extract` accepts the literal string 'null'
    // on INSERT (unlike genuinely malformed JSON, which the partial indexes
    // reject at insert time), so this shape reaches the table for real.
    seedDoc(
      db,
      candidateRawMetadata('local-null-metadata', 'acc-local', 'file', 'null'),
    );
    // Parses to a JS array. `typeof [] === 'object' && [] !== null`, so a
    // shape check that only excludes `null` lets an array straight through
    // — every field then resolves to undefined and decideFileIndexing
    // archives it as 'no-extension', which is exactly backwards for
    // metadata this migration cannot actually read.
    seedDoc(
      db,
      candidateRawMetadata(
        'local-array-metadata',
        'acc-local',
        'file',
        '[1,2]',
      ),
    );
    // Controls seeded AFTER the two hostile rows (by insertion order, so
    // they page after them too): prove a `continue` on the hostile rows
    // does not truncate or otherwise disturb the rest of the scan.
    seedDoc(
      db,
      candidate('ctl-live-pdf', 'acc-local', 'file', {
        mime: 'application/pdf',
        filename: 'keep.pdf',
        sizeBytes: 1_000,
      }),
    );
    seedDoc(
      db,
      candidate('ctl-archived-zip', 'acc-local', 'file', {
        mime: 'application/zip',
        filename: 'drop.zip',
        sizeBytes: 1_000,
      }),
    );
    db.prepare(`UPDATE meta SET value='1' WHERE key='schemaVersion'`).run();
  });

  afterEach(() => {
    db.close();
    warnSpy.mockRestore();
  });

  it('leaves both null- and array-metadata rows live, archives the control row around them, and still reaches schemaVersion 2', () => {
    migrate(db);

    expect(live(db, 'local-null-metadata')).toBe(true);
    expect(changesFor(db, 'local-null-metadata')).toHaveLength(0);
    expect(live(db, 'local-array-metadata')).toBe(true);
    expect(changesFor(db, 'local-array-metadata')).toHaveLength(0);
    expect(live(db, 'ctl-live-pdf')).toBe(true);
    expect(live(db, 'ctl-archived-zip')).toBe(false);
    expect(changesFor(db, 'ctl-archived-zip')).toHaveLength(1);

    expect(schemaVersion(db)).toBe(2);
  });

  it('logs the offending document id for both null- and array-metadata rows', () => {
    migrate(db);
    // Read `.mock.calls` off the shared spy while it is still live —
    // `afterEach` calls `mockRestore()`, which also clears recorded calls,
    // so this must happen before that runs, not after.
    const warnedFor = (id: string) =>
      warnSpy.mock.calls.some((args: unknown[]) =>
        args.some((a: unknown) => typeof a === 'string' && a.includes(id)),
      );

    expect(warnedFor('local-null-metadata')).toBe(true);
    expect(warnedFor('local-array-metadata')).toBe(true);
  });
});

describe('schema v2: atomicity on failure', () => {
  it('rolls back the whole version step when archiving throws — version, row, and changes all stay as they were', () => {
    const db = new Database(':memory:');
    migrate(db);
    seedAccount(db, 'acc-local', 'local-folder');
    seedDoc(
      db,
      candidate('doomed-zip', 'acc-local', 'file', {
        mime: 'application/zip',
        filename: 'archive.zip',
        sizeBytes: 10,
      }),
    );
    db.prepare(`UPDATE meta SET value='1' WHERE key='schemaVersion'`).run();

    db.exec(`
      CREATE TRIGGER forced_abort
      BEFORE UPDATE OF archived_at ON documents
      BEGIN
        SELECT RAISE(ABORT, 'forced');
      END;
    `);

    const before = changeCount(db);

    expect(() => migrate(db)).toThrow(/forced/);

    expect(schemaVersion(db)).toBe(1);
    expect(live(db, 'doomed-zip')).toBe(true);
    expect(changeCount(db)).toBe(before);

    db.close();
  });
});
