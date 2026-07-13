/**
 * Single source of truth for the greenfield digital-memory schema as seen by
 * MCP agents via `get_schema`. Written by hand against
 * src/main/core/store/schema.ts (NOT ported from kiagent-ref, whose schema is
 * gone). The `schema-doc-drift` test fails CI when a documented table/column
 * diverges from the live DB or the `source` enum diverges from the registered
 * sources — so update this file whenever schema.ts or the bundled source set
 * changes.
 *
 * EXCEPTION: the `type` enum is NOT machine-enforced — document type strings
 * are scattered literals in per-source builders (sources/*); keep it
 * hand-maintained when a source adds a new document type.
 */
export interface ColumnDoc {
  name: string;
  type: string;
  notes: string;
}

export interface TableDoc {
  name: string;
  description: string;
  columns: ColumnDoc[];
  relations?: string[];
  prep_notes?: string;
}

export interface SchemaDoc {
  overview: string;
  tables: TableDoc[];
  enums: Array<{ name: string; values: string[]; notes?: string }>;
}

export const SCHEMA_DOC: SchemaDoc = {
  overview: `The digital memory is an SQLite database. Every ingested item (email
thread, email message, attachment, file, …) is one row in \`documents\`, owned by
an \`accounts\` row. A document's SOURCE (gmail, imap, local-folder) is NOT on
\`documents\` — it is \`accounts.source\`, reached by joining
\`documents.account_id = accounts.id\`. Full-text indexes live in
\`documents_fts\` (stemmed) and \`documents_tri\` (trigram substring fallback),
both joined by \`doc_id = documents.id\`. \`changes\` is an ordered feed of
everything that changed. All ids are TEXT (UUIDv7); timestamps are ISO-8601
TEXT.`,

  tables: [
    {
      name: 'documents',
      description:
        'One row per ingested item. The central table; FTS and language data join back via documents.id.',
      columns: [
        { name: 'id', type: 'TEXT PK', notes: 'UUIDv7.' },
        {
          name: 'account_id',
          type: 'TEXT',
          notes: 'FK → accounts.id (ON DELETE CASCADE). Owning account.',
        },
        {
          name: 'external_id',
          type: 'TEXT',
          notes:
            'Per-source stable key (gmail thread id, abs file path, …). UNIQUE with (account_id, type).',
        },
        { name: 'type', type: 'TEXT', notes: 'Enum — see `type` in enums.' },
        { name: 'title', type: 'TEXT', notes: 'Display title; may be NULL.' },
        {
          name: 'markdown',
          type: 'TEXT',
          notes: 'Extracted body text; NULL until enriched. Indexed by FTS.',
        },
        {
          name: 'url',
          type: 'TEXT',
          notes: 'Canonical source URL; may be NULL.',
        },
        {
          name: 'metadata',
          type: 'TEXT (JSON)',
          notes: 'Polymorphic per source/type. Default "{}".',
        },
        {
          name: 'created_at',
          type: 'TEXT (ISO-8601)',
          notes: 'When created at the source — NOT when ingested. May be NULL.',
        },
        {
          name: 'parent_id',
          type: 'TEXT',
          notes:
            'For child docs (e.g. attachments): the parent document id. NULL for top-level.',
        },
        {
          name: 'content_hash',
          type: 'TEXT',
          notes: 'SHA-256 of body bytes; used for change detection.',
        },
        {
          name: 'seq',
          type: 'INTEGER',
          notes: 'The changes.seq that last materialized this row.',
        },
        {
          name: 'archived_at',
          type: 'TEXT (ISO-8601)',
          notes: 'Soft-delete marker; NULL for live docs.',
        },
        {
          name: 'languages',
          type: 'TEXT (JSON array)',
          notes: 'Detected ISO-639 codes, e.g. ["eng","deu"]. Default "[]".',
        },
        {
          name: 'ingested_at',
          type: 'TEXT (ISO-8601)',
          notes: 'When first ingested.',
        },
        {
          name: 'updated_at',
          type: 'TEXT (ISO-8601)',
          notes: 'When this row was last refreshed.',
        },
      ],
      relations: [
        'documents.account_id → accounts.id',
        'documents.parent_id → documents.id (children under a parent)',
        'documents_fts.doc_id = documents.id',
        'documents_tri.doc_id = documents.id',
      ],
      prep_notes:
        'To filter/group by source, join accounts: `SELECT a.source, count(*) FROM documents d JOIN accounts a ON a.id = d.account_id GROUP BY a.source`. Exclude soft-deleted rows with `archived_at IS NULL`.',
    },
    {
      name: 'accounts',
      description: 'One row per connected account/source endpoint.',
      columns: [
        { name: 'id', type: 'TEXT PK', notes: 'UUIDv7.' },
        {
          name: 'source',
          type: 'TEXT',
          notes: 'Enum — see `source` in enums. UNIQUE with (identifier).',
        },
        {
          name: 'identifier',
          type: 'TEXT',
          notes: 'Email address / account label / per-source stable key.',
        },
        {
          name: 'config',
          type: 'TEXT (JSON)',
          notes: 'Per-source connector config. Default "{}".',
        },
        {
          name: 'status',
          type: 'TEXT',
          notes:
            "Sync status, e.g. 'backfilling', 'live', 'error', 'needsReauth'.",
        },
        {
          name: 'cursor',
          type: 'TEXT',
          notes: 'Per-source resume cursor; may be NULL.',
        },
        {
          name: 'progress',
          type: 'TEXT (JSON)',
          notes: 'Backfill progress {done, total}; may be NULL.',
        },
        {
          name: 'last_sync_at',
          type: 'TEXT (ISO-8601)',
          notes: 'Last successful sync; may be NULL.',
        },
        {
          name: 'last_error',
          type: 'TEXT',
          notes: 'Last sync error; NULL on success.',
        },
        {
          name: 'cadence',
          type: 'TEXT',
          notes: 'Poll cadence override; may be NULL.',
        },
        {
          name: 'created_at',
          type: 'TEXT (ISO-8601)',
          notes: 'When connected.',
        },
      ],
    },
    {
      name: 'changes',
      description:
        'Ordered append-only feed of everything that changed. Useful for "what changed and when" questions.',
      columns: [
        { name: 'seq', type: 'INTEGER PK', notes: 'Monotonic autoincrement.' },
        {
          name: 'kind',
          type: 'TEXT',
          notes: "One of 'document', 'purge', 'account', 'accountRemoved'.",
        },
        {
          name: 'ref_id',
          type: 'TEXT',
          notes: 'The documents.id / accounts.id the change refers to.',
        },
        {
          name: 'at',
          type: 'TEXT (ISO-8601)',
          notes: 'When the change was recorded.',
        },
      ],
      relations: [
        "changes.ref_id → documents.id (when kind='document'/'purge')",
        "changes.ref_id → accounts.id (when kind='account'/'accountRemoved')",
      ],
    },
    {
      name: 'documents_fts',
      description:
        'FTS5 stemmed full-text index over title/markdown (+ per-language stem columns). Query with MATCH; join back by doc_id.',
      columns: [
        { name: 'doc_id', type: 'TEXT (UNINDEXED)', notes: '= documents.id.' },
        { name: 'title', type: 'TEXT', notes: 'Indexed title.' },
        { name: 'markdown', type: 'TEXT', notes: 'Indexed body.' },
        { name: 'title_stem', type: 'TEXT', notes: 'Snowball-stemmed title.' },
        {
          name: 'markdown_stem',
          type: 'TEXT',
          notes: 'Snowball-stemmed body.',
        },
      ],
      prep_notes:
        'Tokenizer: unicode61, diacritics removed. rowid is pinned to documents.rowid; join on doc_id for stable results.',
    },
    {
      name: 'documents_tri',
      description:
        'FTS5 trigram index for substring/fuzzy fallback recall. Join back by doc_id.',
      columns: [
        { name: 'doc_id', type: 'TEXT (UNINDEXED)', notes: '= documents.id.' },
        {
          name: 'body',
          type: 'TEXT',
          notes: 'Trigram-indexed "title\\nmarkdown".',
        },
      ],
    },
  ],

  enums: [
    {
      name: 'source',
      // CI-enforced against registerBundledSources — see schema-doc-drift.test.ts.
      values: ['gmail', 'imap', 'local-folder'],
      notes: 'Which source ingested the document (on accounts.source).',
    },
    {
      name: 'type',
      // Hand-maintained (NOT CI-enforced — see file header).
      values: ['email.thread', 'email.message', 'attachment', 'file'],
      notes:
        'email.thread + email.message + attachment (gmail, imap); file (local-folder).',
    },
  ],
};
