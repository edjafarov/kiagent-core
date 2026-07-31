/**
 * Partial indexes backing extractionStats() (store.ts): docs_extracted and
 * docs_pending_visual exist with WHERE clauses textually identical to the
 * stats queries (so SQLite's planner can prove the index applies), and the
 * self-heal in ensureStatsIndexes() rebuilds a stale/decoy index rather than
 * silently regressing to a full table scan.
 */
import Database from 'better-sqlite3';

import {
  EXTRACTED_DOCS_WHERE,
  ensureStatsIndexes,
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
     VALUES('acc-1','test','me@example.com','idle','2026-01-01T00:00:00Z')`,
  );
  const insert = db.prepare(
    `INSERT INTO documents
       (id, account_id, external_id, type, title, markdown, metadata,
        content_hash, seq, archived_at, ingested_at, updated_at)
     VALUES (@id, 'acc-1', @external_id, @type, @title, @markdown, @metadata,
             @content_hash, @seq, @archived_at, @ingested_at, @updated_at)`,
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
    let type = 'note';
    let markdown: string | null = `Body text for document ${i}`;
    let metadata: Record<string, unknown> = {};
    let archivedAt: string | null = null;
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
      external_id: `ext-${i}`,
      type,
      title: `Title ${i}`,
      markdown,
      metadata: JSON.stringify(metadata),
      content_hash: `hash-${i}`,
      seq: i,
      archived_at: archivedAt,
      ingested_at: ts,
      updated_at: ts,
    });
  }
  insertMany(rows);
  db.exec('ANALYZE');
}

describe('schema: extraction-stats partial indexes', () => {
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

  it('ensureStatsIndexes self-heals a decoy docs_pending_visual back to the desired definition', () => {
    db.exec(`DROP INDEX docs_pending_visual`);
    db.exec(
      `CREATE INDEX docs_pending_visual ON documents(id) WHERE archived_at IS NULL`,
    );
    expect(indexSql(db, 'docs_pending_visual')).toBe(
      `CREATE INDEX docs_pending_visual ON documents(id) WHERE archived_at IS NULL`,
    );

    ensureStatsIndexes(db);

    expect(indexSql(db, 'docs_pending_visual')).toBe(
      `CREATE INDEX docs_pending_visual ON documents(id) WHERE ${PENDING_VISUAL_WHERE}`,
    );
  });

  it('ensureStatsIndexes degrades instead of throwing when a build fails, then heals once the failure clears', () => {
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
      expect(() => ensureStatsIndexes(db)).not.toThrow();
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

    // With the injected failure gone, the very next ensureStatsIndexes call
    // (e.g. the next app restart) heals it.
    ensureStatsIndexes(db);
    expect(indexSql(db, 'docs_pending_visual')).toBe(
      `CREATE INDEX docs_pending_visual ON documents(id) WHERE ${PENDING_VISUAL_WHERE}`,
    );
  });
});
