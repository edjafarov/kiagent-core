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
          notes:
            "Deep link back to the original, meant to be handed to the user. gmail: a https://mail.google.com/... thread deep link (attachment docs inherit their thread's). local-folder: file:// + the absolute file path (also in metadata.absPath). Extension-provided sources: that app's web permalink (slack archive link, notion / google-docs / onedrive / ms365 / hubspot page URL). NULL for imap mail, and empty on some extension-provided file/attachment docs.",
        },
        {
          name: 'metadata',
          type: 'TEXT (JSON)',
          notes:
            'Polymorphic per source/type. Default "{}". gmail email.thread: {from, to, cc, labels, participants, messageCount, firstMessageAt, lastMessageAt, messages[]}. local-folder file: {absPath (absolute filesystem path), filename, ext, mime, sizeBytes, mtime}. attachment / file docs generally: {filename, mime, sizeBytes}.',
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
        'To filter/group by source, join accounts: `SELECT a.source, count(*) FROM documents d JOIN accounts a ON a.id = d.account_id GROUP BY a.source`. Exclude soft-deleted rows with `archived_at IS NULL`. Always include `d.url` in projections whose rows will be shown to the user — it is the citation link (see the url column).',
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
      name: 'outbox',
      description:
        'Frozen outbound drafts + their audit trail (replies/new messages awaiting user confirmation, and the sent/failed/discarded/expired history). NOT a document type: drafts are mutable workflow state, and the sent copy re-enters the corpus through normal ingestion.',
      columns: [
        { name: 'id', type: 'TEXT PK', notes: 'UUIDv7.' },
        {
          name: 'account_id',
          type: 'TEXT',
          notes:
            'FK → accounts.id (ON DELETE CASCADE). Owning (sending) account.',
        },
        {
          name: 'kind',
          type: 'TEXT',
          notes: "Enum — 'reply' or 'new'.",
        },
        {
          name: 'reply_to_document_id',
          type: 'TEXT',
          notes: "FK → documents.id when kind='reply'; NULL for a new message.",
        },
        {
          name: 'outbound_ref',
          type: 'TEXT (JSON)',
          notes:
            "Opaque per-source reply target, round-tripped verbatim to the same source's Sender. NULL unless the source's toDocument wrote metadata.outbound.",
        },
        {
          name: 'recipient_display',
          type: 'TEXT',
          notes: 'Human-readable recipient summary shown on confirm surfaces.',
        },
        {
          name: 'to_json',
          type: 'TEXT (JSON array)',
          notes: 'Recipient addresses. Default "[]".',
        },
        {
          name: 'cc_json',
          type: 'TEXT (JSON array)',
          notes: 'CC addresses. Default "[]".',
        },
        {
          name: 'subject',
          type: 'TEXT',
          notes: 'May be NULL (e.g. threaded replies that inherit a subject).',
        },
        {
          name: 'body_markdown',
          type: 'TEXT',
          notes: 'The frozen draft body.',
        },
        {
          name: 'threading_json',
          type: 'TEXT (JSON)',
          notes:
            'Opaque per-source threading headers/ids; may be NULL for a new (non-reply) message.',
        },
        {
          name: 'confirm_mode',
          type: 'TEXT',
          notes:
            "Enum — 'review' (full app-served review page), 'link' (in-chat review + short-TTL signed link), or 'chat' (in-chat review, confirmed by the user in conversation and sent via send_draft; no link is issued up front). Frozen at creation.",
        },
        {
          name: 'status',
          type: 'TEXT',
          notes:
            "Enum — 'draft', 'sending', 'sent', 'failed', 'discarded', 'expired', 'delivery_unknown'. 'delivery_unknown' means the process died mid-send; never auto-retried.",
        },
        {
          name: 'error',
          type: 'TEXT',
          notes: "Send failure detail; NULL unless status='failed'.",
        },
        {
          name: 'external_message_id',
          type: 'TEXT',
          notes: 'Transport-assigned id once sent; NULL until then.',
        },
        {
          name: 'created_via',
          type: 'TEXT',
          notes:
            "'mcp-local' or 'mcp-remote' — which MCP plane created it — or " +
            "'panel' when the user re-drafted it from the in-app Outbox screen.",
        },
        {
          name: 'created_at',
          type: 'TEXT (ISO-8601)',
          notes: 'When the draft was frozen.',
        },
        {
          name: 'sent_at',
          type: 'TEXT (ISO-8601)',
          notes:
            'When the send transport accepted the message; NULL until sent.',
        },
        {
          name: 'expires_at',
          type: 'TEXT (ISO-8601)',
          notes: 'Confirmation deadline; past this a pending draft expires.',
        },
      ],
      relations: [
        'outbox.account_id → accounts.id',
        "outbox.reply_to_document_id → documents.id (kind='reply')",
      ],
      prep_notes:
        'Sent/failed/discarded/expired rows are retained — this table IS the audit log, not just a queue.',
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
        'email.thread + attachment (gmail); email.message (imap); file (local-folder).',
    },
  ],
};
