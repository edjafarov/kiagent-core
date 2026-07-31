/**
 * Partial indexes backing performance-critical query paths in store.ts:
 * docs_extracted and docs_pending_visual back extractionStats(), and
 * docs_account_recency backs the per-account startup projection (count() +
 * the textless search() branch). All three exist with WHERE/ORDER BY
 * expressions textually identical to their queries (so SQLite's planner can
 * prove the index applies), and the self-heal in ensureQueryIndexes()
 * rebuilds a stale/decoy index rather than silently regressing to a full
 * table scan or a temp B-tree sort.
 */
import Database from 'better-sqlite3';

import {
  EXTRACTED_DOCS_WHERE,
  ensureQueryIndexes,
  migrate,
  PENDING_VISUAL_WHERE,
} from '../schema';

/** Join EXPLAIN QUERY PLAN's `detail` rows into one string for substring checks. */
function planDetail(db: Database.Database, sql: string): string {
  return (
    db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>
  )
    .map((r) => r.detail)
    .join(' | ');
}

function indexSql(db: Database.Database, name: string): string | undefined {
  return (
    db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND name=?`)
      .get(name) as { sql: string } | undefined
  )?.sql;
}

/**
 * Seed a non-trivial, mixed-selectivity `documents` table and run ANALYZE so
 * the EQP assertions below reflect a planner with real cardinality stats
 * (sqlite_stat1) rather than the trivial "empty table" case, where SQLite's
 * default heuristics can favor an index for reasons unrelated to whether it
 * actually helps at corpus scale.
 */
function seedMixedDocuments(db: Database.Database): void {
  db.exec(
    `INSERT INTO accounts(id, source, identifier, status, created_at)
     VALUES('acc-1','test','me@example.com','idle','2026-01-01T00:00:00Z'),
            ('acc-2','test','someone-else@example.com','idle','2026-01-01T00:00:00Z')`,
  );
  const insert = db.prepare(
    `INSERT INTO documents
       (id, account_id, external_id, type, title, markdown, metadata,
        content_hash, seq, archived_at, created_at, ingested_at, updated_at)
     VALUES (@id, @account_id, @external_id, @type, @title, @markdown, @metadata,
             @content_hash, @seq, @archived_at, @created_at, @ingested_at, @updated_at)`,
  );
  const insertMany = db.transaction(
    (rows: Array<Record<string, string | number | null>>) => {
      for (const row of rows) insert.run(row);
    },
  );
  const rows: Array<Record<string, string | number | null>> = [];
  const total = 2000;
  for (let i = 0; i < total; i += 1) {
    const ts = `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}Z`;
    // Two accounts, split so 'acc-1' is a small minority — meaningfully
    // selective for the EQP assertions below (a 50/50 or single-account seed
    // doesn't generalize to the real multi-account corpus this index
    // targets, where any one account is a small slice of the whole table).
    const accountId = i % 7 === 0 ? 'acc-1' : 'acc-2';
    let type = 'note';
    let markdown: string | null = `Body text for document ${i}`;
    let metadata: Record<string, unknown> = {};
    let archivedAt: string | null = null;
    // Origin date present on some rows, absent (falls back to ingested_at)
    // on others — exercises both sides of the COALESCE the index expresses.
    const createdAt =
      i % 4 === 0
        ? `2025-12-01T00:00:${String(i % 60).padStart(2, '0')}Z`
        : null;
    if (i % 10 === 0) {
      // pending-visual candidate: mime-carrying attachment, no text yet.
      type = 'attachment';
      markdown = null;
      metadata = { mime: 'image/png' };
    } else if (i % 10 === 1) {
      // pending-visual candidate: ext-carrying local file, no text yet.
      type = 'file';
      markdown = null;
      metadata = { ext: 'pdf' };
    } else if (i % 10 === 2) {
      // processed doc.
      metadata = { extraction: { engine: 'local-ocr' } };
    } else if (i % 10 === 3) {
      // processed but archived — must NOT count as an index hit either way.
      metadata = { extraction: { engine: 'local-ocr' } };
      archivedAt = ts;
    }
    rows.push({
      id: `doc-${i}`,
      account_id: accountId,
      external_id: `ext-${i}`,
      type,
      title: `Title ${i}`,
      markdown,
      metadata: JSON.stringify(metadata),
      content_hash: `hash-${i}`,
      seq: i,
      archived_at: archivedAt,
      created_at: createdAt,
      ingested_at: ts,
      updated_at: ts,
    });
  }
  insertMany(rows);
  db.exec('ANALYZE');
}

describe('schema: query-performance partial indexes', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    migrate(db);
  });

  afterEach(() => {
    db.close();
  });

  it('migrate() leaves docs_extracted and docs_pending_visual in sqlite_master with the exact desired SQL', () => {
    expect(indexSql(db, 'docs_extracted')).toBe(
      `CREATE INDEX docs_extracted ON documents(updated_at DESC, seq DESC) WHERE ${EXTRACTED_DOCS_WHERE}`,
    );
    expect(indexSql(db, 'docs_pending_visual')).toBe(
      `CREATE INDEX docs_pending_visual ON documents(id) WHERE ${PENDING_VISUAL_WHERE}`,
    );
  });

  it('planner uses docs_pending_visual for the pendingOcr query', () => {
    seedMixedDocuments(db);
    const sql = `SELECT COUNT(*) AS c FROM documents WHERE ${PENDING_VISUAL_WHERE}`;
    expect(planDetail(db, sql)).toContain('USING INDEX docs_pending_visual');
  });

  it('planner uses docs_extracted for the processed-count query', () => {
    seedMixedDocuments(db);
    const sql = `SELECT COUNT(*) AS c FROM documents WHERE ${EXTRACTED_DOCS_WHERE}`;
    expect(planDetail(db, sql)).toContain('USING INDEX docs_extracted');
  });

  it('planner uses docs_extracted for the recent-list query', () => {
    seedMixedDocuments(db);
    const sql = `SELECT id, title, json_extract(metadata,'$.filename') AS filename, type,
                  json_extract(metadata,'$.extraction.engine') AS engine, updated_at
           FROM documents
           WHERE ${EXTRACTED_DOCS_WHERE}
           ORDER BY updated_at DESC, seq DESC LIMIT 10`;
    expect(planDetail(db, sql)).toContain('USING INDEX docs_extracted');
  });

  it('ensureQueryIndexes self-heals a decoy docs_pending_visual back to the desired definition', () => {
    db.exec(`DROP INDEX docs_pending_visual`);
    db.exec(
      `CREATE INDEX docs_pending_visual ON documents(id) WHERE archived_at IS NULL`,
    );
    expect(indexSql(db, 'docs_pending_visual')).toBe(
      `CREATE INDEX docs_pending_visual ON documents(id) WHERE archived_at IS NULL`,
    );

    ensureQueryIndexes(db);

    expect(indexSql(db, 'docs_pending_visual')).toBe(
      `CREATE INDEX docs_pending_visual ON documents(id) WHERE ${PENDING_VISUAL_WHERE}`,
    );
  });

  it('ensureQueryIndexes degrades instead of throwing when a build fails, then heals once the failure clears', () => {
    // Force docs_pending_visual to need a rebuild.
    db.exec(`DROP INDEX docs_pending_visual`);
    db.exec(
      `CREATE INDEX docs_pending_visual ON documents(id) WHERE archived_at IS NULL`,
    );

    const realExec = db.exec.bind(db);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    // Own-property shadow over the prototype method (this instance only):
    // simulate a build failure (e.g. SQLITE_BUSY / disk pressure) on the
    // CREATE INDEX statement specifically, leaving DROP/other exec calls
    // (including migrate()'s own, which already ran in beforeEach) working.
    db.exec = ((sql: string) => {
      if (/^CREATE INDEX/.test(sql)) {
        throw new Error('simulated disk pressure');
      }
      return realExec(sql);
    }) as typeof db.exec;

    try {
      expect(() => ensureQueryIndexes(db)).not.toThrow();
    } finally {
      db.exec = realExec;
    }

    expect(warnSpy).toHaveBeenCalled();
    expect(
      warnSpy.mock.calls.some((args) =>
        args.some(
          (a) => typeof a === 'string' && a.includes('docs_pending_visual'),
        ),
      ),
    ).toBe(true);
    warnSpy.mockRestore();

    // The failed build must not have left a partial/corrupt state — the
    // decoy is still there, untouched (the transaction rolled back).
    expect(indexSql(db, 'docs_pending_visual')).toBe(
      `CREATE INDEX docs_pending_visual ON documents(id) WHERE archived_at IS NULL`,
    );

    // With the injected failure gone, the very next ensureQueryIndexes call
    // (e.g. the next app restart) heals it.
    ensureQueryIndexes(db);
    expect(indexSql(db, 'docs_pending_visual')).toBe(
      `CREATE INDEX docs_pending_visual ON documents(id) WHERE ${PENDING_VISUAL_WHERE}`,
    );
  });

  it('migrate() leaves docs_account_recency in sqlite_master with the exact desired SQL', () => {
    expect(indexSql(db, 'docs_account_recency')).toBe(
      `CREATE INDEX docs_account_recency ON documents(account_id, COALESCE(created_at, ingested_at) DESC) WHERE archived_at IS NULL`,
    );
  });

  it('planner uses docs_account_recency for the per-account count query, with no filter step', () => {
    seedMixedDocuments(db);
    const sql = `SELECT COUNT(*) FROM documents WHERE archived_at IS NULL AND account_id='acc-1'`;
    expect(planDetail(db, sql)).toContain('USING INDEX docs_account_recency');
  });

  it('planner uses docs_account_recency for the per-account recent-list query, with the order coming from the index (no temp B-tree sort)', () => {
    seedMixedDocuments(db);
    const sql = `SELECT d.* FROM documents d WHERE 1=1 AND d.archived_at IS NULL AND d.account_id='acc-1'
           ORDER BY COALESCE(d.created_at, d.ingested_at) DESC
           LIMIT 5 OFFSET 0`;
    const plan = planDetail(db, sql);
    expect(plan).toContain('USING INDEX docs_account_recency');
    expect(plan).not.toContain('USE TEMP B-TREE FOR ORDER BY');
  });

  it('ensureQueryIndexes self-heals a decoy docs_account_recency back to the desired definition', () => {
    db.exec(`DROP INDEX docs_account_recency`);
    db.exec(
      `CREATE INDEX docs_account_recency ON documents(account_id) WHERE archived_at IS NULL`,
    );
    expect(indexSql(db, 'docs_account_recency')).toBe(
      `CREATE INDEX docs_account_recency ON documents(account_id) WHERE archived_at IS NULL`,
    );

    ensureQueryIndexes(db);

    expect(indexSql(db, 'docs_account_recency')).toBe(
      `CREATE INDEX docs_account_recency ON documents(account_id, COALESCE(created_at, ingested_at) DESC) WHERE archived_at IS NULL`,
    );
  });

  it('ensureQueryIndexes degrades instead of throwing when the docs_account_recency build fails, then heals once the failure clears', () => {
    // Force docs_account_recency to need a rebuild.
    db.exec(`DROP INDEX docs_account_recency`);
    db.exec(
      `CREATE INDEX docs_account_recency ON documents(account_id) WHERE archived_at IS NULL`,
    );

    const realExec = db.exec.bind(db);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    db.exec = ((sql: string) => {
      if (/^CREATE INDEX/.test(sql)) {
        throw new Error('simulated disk pressure');
      }
      return realExec(sql);
    }) as typeof db.exec;

    try {
      expect(() => ensureQueryIndexes(db)).not.toThrow();
    } finally {
      db.exec = realExec;
    }

    expect(warnSpy).toHaveBeenCalled();
    expect(
      warnSpy.mock.calls.some((args) =>
        args.some(
          (a) => typeof a === 'string' && a.includes('docs_account_recency'),
        ),
      ),
    ).toBe(true);
    warnSpy.mockRestore();

    // The failed build must not have left a partial/corrupt state — the
    // decoy is still there, untouched (the transaction rolled back).
    expect(indexSql(db, 'docs_account_recency')).toBe(
      `CREATE INDEX docs_account_recency ON documents(account_id) WHERE archived_at IS NULL`,
    );

    // With the injected failure gone, the very next ensureQueryIndexes call
    // (e.g. the next app restart) heals it.
    ensureQueryIndexes(db);
    expect(indexSql(db, 'docs_account_recency')).toBe(
      `CREATE INDEX docs_account_recency ON documents(account_id, COALESCE(created_at, ingested_at) DESC) WHERE archived_at IS NULL`,
    );
  });
});
