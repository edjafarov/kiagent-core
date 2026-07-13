# `query_sql` / `get_schema` MCP tools — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the two held-back MCP tools — a read-only raw-SQL runner (`query_sql`) and an annotated schema doc (`get_schema`) — on both the loopback HTTP and stdio transports, closing LEFTOVERS item 12.

**Architecture:** A new `tools/query-sql.ts` holds the pure SELECT/WITH runner (given a handle); `tools/schema-doc.ts` + `tools/get-schema.ts` hold a freshly-written greenfield schema doc and its markdown renderer; `tools/raw-sql.ts` owns a read-only SQLite handle and bundles both as `McpTool`s via `createRawSqlTools(dbPath) → { tools, dispose }`. The two MCP entry points (`core/mcp/server.ts`, `mcp/stdio-entry.ts`) concat `...raw.tools` into the shared registry and `dispose()` on teardown. `buildBuiltinTools(query)` is left untouched.

**Tech Stack:** TypeScript, `better-sqlite3`, Jest, `@modelcontextprotocol/sdk`. Spec: `docs/superpowers/specs/2026-07-13-query-sql-get-schema-design.md`.

## Global Constraints

- **Read-only only.** `query_sql` runs one `SELECT`/`WITH`; two write guards — a textual gate (statement must start with `select`/`with` after stripping leading whitespace and `--` comment lines) AND a read-only driver handle. 500-row cap with a `truncated` flag.
- **No bigint coercion.** Greenfield ids are TEXT and the store is number-native (`app-db.ts`). Open a plain handle; do **not** call `defaultSafeIntegers`. Integer columns come back as JS numbers.
- **`tier: 'powerful'`** on both tools — metadata only, no consent gate wired in this work.
- **Schema doc is written fresh** against `src/main/core/store/schema.ts`. Never port the legacy `SCHEMA_DOC` (it describes a demolished schema).
- **JSON Schema, not zod,** for `inputSchema` — match the existing greenfield tools (`search.ts` etc.).
- New tests live in `src/main/core/mcp/__tests__/` (same dir as `tools.test.ts`), so tool imports are `../tools/<name>` and db is `../../../db/app-db`.
- **Jest's default env is `jsdom`.** Every new test file below starts with `/** @jest-environment node */` (first line) — required for the `fetch`/HTTP wiring test, and used on the DB tests for parity with `server.test.ts`.
- Standard test `deps`: `{ encrypt: (s) => Buffer.from(s,'utf8'), decrypt: (b) => b.toString('utf8'), detectLanguages: () => ['eng'] }`.
- Commit after every green task. Branch `feat/query-sql-get-schema` (already checked out; spec already committed there).

---

### Task 1: `query_sql` — the read-only SQL runner

**Files:**
- Create: `src/main/core/mcp/tools/query-sql.ts`
- Test: `src/main/core/mcp/__tests__/query-sql.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `querySqlDescription: string`
  - `querySqlInputSchema` (readonly JSON Schema object with required `sql: string`)
  - `interface QuerySqlResult { rows: Record<string, unknown>[]; truncated: boolean }`
  - `runQuerySql(conn: BetterSqlite3.Database, sql: string): QuerySqlResult`

- [ ] **Step 1: Write the failing test**

Create `src/main/core/mcp/__tests__/query-sql.test.ts`:

```ts
/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';

import { openDb } from '../../../db/app-db';
import { openStore } from '../../store/store';
import { runQuerySql } from '../tools/query-sql';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};

describe('runQuerySql', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-qsql-'));
    dbPath = path.join(dir, 'test.db');
    const store = openStore(await openDb(dbPath), deps);
    const acc = await store.createAccount({
      source: 'gmail',
      identifier: 'me@example.com',
    });
    await store.commit({
      account: acc.id,
      documents: Array.from({ length: 3 }, (_, i) => ({
        externalId: `d${i}`,
        type: 'email.message',
        title: `Doc ${i}`,
        markdown: 'body',
        metadata: {},
        createdAt: '2026-01-01T00:00:00Z',
      })),
    });
    await store.close();
  });

  const ro = () =>
    new Database(dbPath, { readonly: true, fileMustExist: true });

  it('runs a SELECT and returns rows', () => {
    const conn = ro();
    try {
      const { rows, truncated } = runQuerySql(
        conn,
        'SELECT type, title FROM documents ORDER BY title',
      );
      expect(rows).toHaveLength(3);
      expect(rows[0]).toMatchObject({ type: 'email.message', title: 'Doc 0' });
      expect(truncated).toBe(false);
    } finally {
      conn.close();
    }
  });

  it('runs a WITH (CTE) SELECT', () => {
    const conn = ro();
    try {
      const { rows } = runQuerySql(
        conn,
        'WITH t AS (SELECT title FROM documents) SELECT count(*) AS n FROM t',
      );
      expect(rows[0]).toEqual({ n: 3 });
    } finally {
      conn.close();
    }
  });

  it('rejects non-SELECT statements at the textual gate', () => {
    const conn = ro();
    try {
      for (const sql of [
        'INSERT INTO documents DEFAULT VALUES',
        'UPDATE documents SET title=1',
        'DELETE FROM documents',
        'DROP TABLE documents',
        'CREATE TABLE x(y)',
        'PRAGMA journal_mode=DELETE',
      ]) {
        expect(() => runQuerySql(conn, sql)).toThrow(/only SELECT \/ WITH/);
      }
    } finally {
      conn.close();
    }
  });

  it('strips leading -- comments before the gate', () => {
    const conn = ro();
    try {
      const { rows } = runQuerySql(
        conn,
        '-- a note\n-- another\nSELECT count(*) AS n FROM documents',
      );
      expect(rows[0]).toEqual({ n: 3 });
    } finally {
      conn.close();
    }
  });

  it('a WITH … INSERT that passes the textual gate still cannot write', () => {
    const conn = ro();
    try {
      // Starts with `with`, so the textual gate admits it; it then fails —
      // the subquery wrapping makes it invalid SQL, and a readonly driver
      // would reject the write regardless. Either way it throws and the
      // corpus is unchanged.
      expect(() =>
        runQuerySql(conn, 'WITH t AS (SELECT 1) INSERT INTO documents DEFAULT VALUES'),
      ).toThrow();
      const n = (
        conn.prepare('SELECT count(*) AS n FROM documents').get() as { n: number }
      ).n;
      expect(n).toBe(3);
    } finally {
      conn.close();
    }
  });

  it('caps at 500 rows and flags truncation', () => {
    const conn = ro();
    try {
      const { rows, truncated } = runQuerySql(
        conn,
        'WITH RECURSIVE seq(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM seq WHERE x < 600) SELECT x FROM seq',
      );
      expect(rows).toHaveLength(500);
      expect(truncated).toBe(true);
    } finally {
      conn.close();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/main/core/mcp/__tests__/query-sql.test.ts`
Expected: FAIL — `Cannot find module '../tools/query-sql'`.

- [ ] **Step 3: Write the implementation**

Create `src/main/core/mcp/tools/query-sql.ts`:

```ts
/**
 * `query_sql` — the read-only raw-SQL escape hatch. A straight port of
 * kiagent-ref's tools/query-sql.ts, minus the bigint dance (greenfield ids are
 * TEXT and the store is number-native, so integer columns come back as JS
 * numbers). Two independent write guards, both retained:
 *   1. textual — the statement must start with SELECT/WITH after leading
 *      whitespace and `--` comment lines are stripped;
 *   2. driver — raw-sql.ts opens the handle readonly, so a write fails at
 *      better-sqlite3 even if the textual check is bypassed.
 * The query is wrapped as `SELECT * FROM (<sql>) LIMIT 501` so the cap applies
 * uniformly and anything that is not a valid SELECT subquery (e.g. a
 * `WITH … INSERT`) fails to parse rather than executing.
 */
import type BetterSqlite3 from 'better-sqlite3';

export const querySqlDescription = `Run a read-only SELECT or WITH query against the digital-memory database. Capped at 500 rows — add your own LIMIT/ORDER BY when order matters. Use when search/count/get_related aren't expressive enough: joins, custom aggregations, time bucketing, grouping. Call \`get_schema\` FIRST for table/column names and how the tables relate — notably a document's source lives on \`accounts.source\`, reached by joining \`documents.account_id = accounts.id\` (there is no source column on documents). The connection is read-only; writes fail at the driver.`;

export const querySqlInputSchema = {
  type: 'object',
  properties: {
    sql: {
      type: 'string',
      description: 'A single read-only SELECT or WITH statement.',
    },
  },
  required: ['sql'],
} as const;

export interface QuerySqlResult {
  rows: Record<string, unknown>[];
  truncated: boolean;
}

const MAX_ROWS = 500;

export function runQuerySql(
  conn: BetterSqlite3.Database,
  sql: string,
): QuerySqlResult {
  const stripped = sql
    .replace(/^\s+/, '')
    .replace(/^(--[^\n]*\n)+/, '') // drop ALL leading -- comment lines
    .trimStart();
  if (!/^(select|with)\b/i.test(stripped)) {
    throw new Error('query_sql: only SELECT / WITH statements are allowed');
  }
  const rows = conn
    .prepare(`SELECT * FROM (${stripped}) LIMIT ${MAX_ROWS + 1}`)
    .all() as Record<string, unknown>[];
  return { rows: rows.slice(0, MAX_ROWS), truncated: rows.length > MAX_ROWS };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/main/core/mcp/__tests__/query-sql.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/core/mcp/tools/query-sql.ts src/main/core/mcp/__tests__/query-sql.test.ts
git commit -m "feat(mcp): read-only query_sql runner"
```

---

### Task 2: `get_schema` — greenfield schema doc + markdown renderer + drift test

**Files:**
- Create: `src/main/core/mcp/tools/schema-doc.ts`
- Create: `src/main/core/mcp/tools/get-schema.ts`
- Test: `src/main/core/mcp/__tests__/get-schema.test.ts`
- Test: `src/main/core/mcp/__tests__/schema-doc-drift.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `interface ColumnDoc { name: string; type: string; notes: string }`
  - `interface TableDoc { name: string; description: string; columns: ColumnDoc[]; relations?: string[]; prep_notes?: string }`
  - `interface SchemaDoc { overview: string; tables: TableDoc[]; enums: Array<{ name: string; values: string[]; notes?: string }> }`
  - `SCHEMA_DOC: SchemaDoc`
  - `getSchemaDescription: string`
  - `renderSchema(): string`

- [ ] **Step 1: Write the failing tests**

Create `src/main/core/mcp/__tests__/get-schema.test.ts`:

```ts
/** @jest-environment node */
import { renderSchema } from '../tools/get-schema';

describe('renderSchema', () => {
  it('renders markdown covering the queryable tables and the source enum', () => {
    const md = renderSchema();
    expect(md).toContain('## documents');
    expect(md).toContain('## accounts');
    // The join every by-source query needs must be spelled out.
    expect(md).toContain('accounts.source');
    // The source enum values are present.
    expect(md).toMatch(/`gmail`/);
    expect(md).toMatch(/`local-folder`/);
    expect(md).toMatch(/`imap`/);
  });
});
```

Create `src/main/core/mcp/__tests__/schema-doc-drift.test.ts`:

```ts
/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { Source } from '@shared/contracts';

import type { ConnectBroker } from '../../../auth/connect-broker';
import { openDb } from '../../../db/app-db';
import { registerBundledSources } from '../../../sources';
import { SCHEMA_DOC } from '../tools/schema-doc';

/**
 * Bidirectional drift detection between SCHEMA_DOC (what get_schema tells MCP
 * agents) and the live greenfield schema:
 *   1. every live column of a documented table has a doc entry;
 *   2. every live table is documented OR allowlisted (SQLite/FTS5 internals +
 *      the internal bookkeeping tables), and every documented table exists;
 *   3. the `source` enum exactly matches the registered source ids.
 * NOT enforced: the `type` enum (scattered per-source literals; hand-kept).
 */
describe('schema-doc drift detector', () => {
  let dir: string;
  let db: Awaited<ReturnType<typeof openDb>>;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-drift-'));
    db = await openDb(path.join(dir, 'test.db'));
  });

  afterAll(async () => {
    await db.close();
  });

  it('every live column in every documented table is documented', async () => {
    const missing: string[] = [];
    for (const table of SCHEMA_DOC.tables) {
      const liveCols = (await db.all(
        `PRAGMA table_info(${table.name})`,
      )) as Array<{ name: string }>;
      if (liveCols.length === 0) continue; // some virtual tables report 0 cols
      const documented = new Set(table.columns.map((c) => c.name));
      for (const col of liveCols) {
        if (!documented.has(col.name)) missing.push(`${table.name}.${col.name}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every live table is documented or allowlisted, and vice versa', async () => {
    const liveRows = (await db.all(
      `SELECT name FROM sqlite_master WHERE type='table'`,
    )) as Array<{ name: string }>;
    const liveNames = liveRows.map((r) => r.name);
    const documented = new Set(SCHEMA_DOC.tables.map((t) => t.name));

    // Internal bookkeeping tables (not agent-facing) + SQLite internals + the
    // FTS5 shadow tables of documented virtual tables.
    const INTERNAL = new Set([
      'meta',
      'consumers',
      'work_ledger',
      'vault',
      'consents',
      'schedule',
    ]);
    const isInternal = (name: string): boolean => {
      if (name.startsWith('sqlite_')) return true;
      if (INTERNAL.has(name)) return true;
      for (const doc of documented) {
        if (
          name.startsWith(`${doc}_`) &&
          /_(data|idx|content|docsize|config)$/.test(name)
        ) {
          return true;
        }
      }
      return false;
    };

    const undocumented = liveNames.filter(
      (n) => !isInternal(n) && !documented.has(n),
    );
    expect(undocumented).toEqual([]);

    const liveSet = new Set(liveNames);
    const phantom = [...documented].filter((n) => !liveSet.has(n));
    expect(phantom).toEqual([]);
  });

  it('the source enum exactly matches the registered source ids', () => {
    const ids: string[] = [];
    const brokerStub = {
      registerOAuthProfile: () => {},
    } as unknown as ConnectBroker;
    registerBundledSources((s: Source) => ids.push(s.descriptor.id), brokerStub);

    const sourceEnum = SCHEMA_DOC.enums.find((e) => e.name === 'source');
    expect(sourceEnum).toBeDefined();
    expect([...sourceEnum!.values].sort()).toEqual([...ids].sort());
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx jest src/main/core/mcp/__tests__/get-schema.test.ts src/main/core/mcp/__tests__/schema-doc-drift.test.ts`
Expected: FAIL — `Cannot find module '../tools/get-schema'` / `../tools/schema-doc`.

- [ ] **Step 3a: Write the schema doc**

Create `src/main/core/mcp/tools/schema-doc.ts`. Column lists MUST be complete — the drift test fails if a live column is missing. Source columns come from `src/main/core/store/schema.ts` (v1 + v3 migrations).

```ts
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
 * are scattered literals in per-source builders (sources/*/); keep it
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
        { name: 'url', type: 'TEXT', notes: 'Canonical source URL; may be NULL.' },
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
          notes: "Sync status, e.g. 'backfilling', 'live', 'error', 'needsReauth'.",
        },
        { name: 'cursor', type: 'TEXT', notes: 'Per-source resume cursor; may be NULL.' },
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
        { name: 'last_error', type: 'TEXT', notes: 'Last sync error; NULL on success.' },
        { name: 'cadence', type: 'TEXT', notes: 'Poll cadence override; may be NULL.' },
        { name: 'created_at', type: 'TEXT (ISO-8601)', notes: 'When connected.' },
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
        { name: 'at', type: 'TEXT (ISO-8601)', notes: 'When the change was recorded.' },
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
        { name: 'markdown_stem', type: 'TEXT', notes: 'Snowball-stemmed body.' },
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
        { name: 'body', type: 'TEXT', notes: 'Trigram-indexed "title\\nmarkdown".' },
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
```

- [ ] **Step 3b: Write the renderer**

Create `src/main/core/mcp/tools/get-schema.ts` (renderer ported from kiagent-ref, `getSchema` → `renderSchema`):

```ts
/**
 * `get_schema` — render SCHEMA_DOC as one markdown document. Pure; no DB
 * access (the drift test guarantees SCHEMA_DOC matches live SQLite). Markdown
 * rather than JSON keeps it scan-friendly for the model and lets prose like
 * prep_notes read naturally. Ported from kiagent-ref's get-schema.ts.
 */
import { SCHEMA_DOC } from './schema-doc';

export const getSchemaDescription = `Annotated schema of the digital-memory database — tables, columns, enum values, relations, and prep notes. Call this before \`query_sql\` when search/count/get_related aren't expressive enough and you need custom SQL. Key relation: a document's source is \`accounts.source\`, joined via \`documents.account_id = accounts.id\`. For live counts/sync state use \`digital_memory_info\` instead — this tool is layout, not contents. Returns markdown.`;

export function renderSchema(): string {
  const lines: string[] = [];
  lines.push('# Kia digital memory schema', '');
  lines.push(SCHEMA_DOC.overview, '');

  for (const t of SCHEMA_DOC.tables) {
    lines.push(`## ${t.name}`, '');
    lines.push(t.description, '');
    lines.push('| Column | Type | Notes |');
    lines.push('|---|---|---|');
    for (const c of t.columns) {
      const notes = c.notes.replace(/\|/g, '\\|');
      lines.push(`| \`${c.name}\` | ${c.type} | ${notes} |`);
    }
    if (t.relations && t.relations.length) {
      lines.push('', '**Relations:**');
      for (const r of t.relations) lines.push(`- ${r}`);
    }
    if (t.prep_notes) lines.push('', `**Prep notes:** ${t.prep_notes}`);
    lines.push('');
  }

  lines.push('### Enums', '');
  for (const e of SCHEMA_DOC.enums) {
    const vals = e.values.map((v) => `\`${v}\``).join(', ');
    const tail = e.notes ? ` — ${e.notes}` : '';
    lines.push(`- **${e.name}**: ${vals}${tail}`);
  }

  return lines.join('\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx jest src/main/core/mcp/__tests__/get-schema.test.ts src/main/core/mcp/__tests__/schema-doc-drift.test.ts`
Expected: PASS. If the drift test's column check fails, a live column is missing from `schema-doc.ts` — add it (do not loosen the test). If the source-enum check fails, reconcile the `source` enum with the registered ids.

- [ ] **Step 5: Commit**

```bash
git add src/main/core/mcp/tools/schema-doc.ts src/main/core/mcp/tools/get-schema.ts \
  src/main/core/mcp/__tests__/get-schema.test.ts src/main/core/mcp/__tests__/schema-doc-drift.test.ts
git commit -m "feat(mcp): greenfield schema doc + get_schema renderer with drift test"
```

---

### Task 3: `createRawSqlTools` — the handle-owning tool pair (with WAL-safe open)

**Files:**
- Create: `src/main/core/mcp/tools/raw-sql.ts`
- Test: `src/main/core/mcp/__tests__/raw-sql.test.ts`

**Interfaces:**
- Consumes: `runQuerySql`, `querySqlDescription`, `querySqlInputSchema` (Task 1); `renderSchema`, `getSchemaDescription` (Task 2); `McpTool` from `@shared/contracts`.
- Produces: `createRawSqlTools(dbPath: string): { tools: McpTool[]; dispose: () => Promise<void> }` — `tools` is `[query_sql, get_schema]`, both `tier: 'powerful'`.

- [ ] **Step 1: Write the failing test**

Create `src/main/core/mcp/__tests__/raw-sql.test.ts`. The **dirty-`-wal` open test is the load-bearing one** the advisor called out — it copies the corpus files while a writer still holds a populated `-wal`, then opens the copy with no writer present.

```ts
/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { openDb } from '../../../db/app-db';
import { openStore } from '../../store/store';
import { createRawSqlTools } from '../tools/raw-sql';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};

async function seedCorpus(dbPath: string): Promise<void> {
  const store = openStore(await openDb(dbPath), deps);
  const acc = await store.createAccount({
    source: 'gmail',
    identifier: 'me@example.com',
  });
  await store.commit({
    account: acc.id,
    documents: [
      {
        externalId: 'd0',
        type: 'email.message',
        title: 'Hello',
        markdown: 'body',
        metadata: {},
        createdAt: '2026-01-01T00:00:00Z',
      },
    ],
  });
  await store.close();
}

describe('createRawSqlTools', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-rawsql-'));
  });

  it('exposes query_sql and get_schema, both tier powerful', async () => {
    const dbPath = path.join(dir, 'test.db');
    await seedCorpus(dbPath);
    const raw = createRawSqlTools(dbPath);
    try {
      const names = raw.tools.map((t) => t.name).sort();
      expect(names).toEqual(['get_schema', 'query_sql']);
      expect(raw.tools.every((t) => t.tier === 'powerful')).toBe(true);
    } finally {
      await raw.dispose();
    }
  });

  it('query_sql reads the corpus; get_schema returns markdown', async () => {
    const dbPath = path.join(dir, 'test.db');
    await seedCorpus(dbPath);
    const raw = createRawSqlTools(dbPath);
    try {
      const q = raw.tools.find((t) => t.name === 'query_sql')!;
      const result = (await q.call({
        sql: 'SELECT title FROM documents',
      })) as { rows: Array<{ title: string }>; truncated: boolean };
      expect(result.rows).toEqual([{ title: 'Hello' }]);

      const s = raw.tools.find((t) => t.name === 'get_schema')!;
      const md = (await s.call({})) as string;
      expect(md).toContain('## documents');
    } finally {
      await raw.dispose();
    }
  });

  it('opens a corpus with a dirty -wal and no live writer', async () => {
    // Seed a corpus and, while a writer still holds an un-checkpointed -wal,
    // copy all three files to a fresh path. The copy has a populated -wal with
    // NO associated connection — exactly the WAL-recovery case a strict
    // readonly open can trip over.
    const src = path.join(dir, 'live.db');
    const store = openStore(await openDb(src), deps);
    const acc = await store.createAccount({
      source: 'gmail',
      identifier: 'me@example.com',
    });
    await store.commit({
      account: acc.id,
      documents: [
        {
          externalId: 'd0',
          type: 'email.message',
          title: 'DirtyWal',
          markdown: 'body',
          metadata: {},
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
    });

    const copyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-copy-'));
    const dst = path.join(copyDir, 'copy.db');
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(src + suffix)) fs.copyFileSync(src + suffix, dst + suffix);
    }
    await store.close(); // writer for the ORIGINAL goes away; the copy has none

    const raw = createRawSqlTools(dst);
    try {
      const q = raw.tools.find((t) => t.name === 'query_sql')!;
      const result = (await q.call({
        sql: 'SELECT title FROM documents',
      })) as { rows: Array<{ title: string }> };
      // The row lived only in the -wal, so reading it back proves the handle
      // recovered the dirty -wal rather than silently reading a stale main db.
      expect(result.rows).toEqual([{ title: 'DirtyWal' }]);
    } finally {
      await raw.dispose();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/main/core/mcp/__tests__/raw-sql.test.ts`
Expected: FAIL — `Cannot find module '../tools/raw-sql'`.

- [ ] **Step 3: Write the implementation**

Create `src/main/core/mcp/tools/raw-sql.ts`:

```ts
/**
 * The "powerful" raw-SQL tool pair — query_sql + get_schema — bundled together
 * because they are only useful as a pair (the schema doc exists to help write
 * the SQL) and because query_sql needs a raw SQLite handle that the Query-only
 * buildBuiltinTools does not carry. Both MCP entry points (core/mcp/server.ts,
 * mcp/stdio-entry.ts) concat `...tools` into the shared registry and call
 * `dispose()` on teardown.
 *
 * The handle is opened readonly for a driver-level write guard. A strict
 * readonly open can fail WAL recovery (SQLITE_CANTOPEN) when the -wal is dirty
 * and no writer is present, because a readonly connection cannot create the
 * -shm; in that case we fall back to the same read-write-but-treated-readonly
 * open openCorpusReadConnection uses (app-db.ts). On that fallback the textual
 * SELECT/WITH gate in runQuerySql remains the write guard. In practice a writer
 * (db worker / stdio store) always opens first, so the readonly path is taken.
 */
import Database from 'better-sqlite3';

import type { McpTool } from '@shared/contracts';

import {
  getSchemaDescription,
  renderSchema,
} from './get-schema';
import {
  querySqlDescription,
  querySqlInputSchema,
  runQuerySql,
} from './query-sql';

function openReadHandle(dbPath: string): Database.Database {
  try {
    return new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    const code = (err as { code?: string })?.code ?? '';
    if (code === 'SQLITE_CANTOPEN') {
      // Readonly WAL recovery failed — reopen read-write (treated read-only by
      // convention; the textual gate still blocks non-SELECT).
      return new Database(dbPath, { fileMustExist: true });
    }
    throw err;
  }
}

export function createRawSqlTools(dbPath: string): {
  tools: McpTool[];
  dispose: () => Promise<void>;
} {
  const conn = openReadHandle(dbPath);

  const tools: McpTool[] = [
    {
      name: 'query_sql',
      description: querySqlDescription,
      inputSchema: querySqlInputSchema,
      tier: 'powerful',
      call: async (args: Record<string, unknown>) =>
        runQuerySql(conn, String((args as { sql?: unknown }).sql ?? '')),
    },
    {
      name: 'get_schema',
      description: getSchemaDescription,
      inputSchema: { type: 'object', properties: {} },
      tier: 'powerful',
      call: async () => renderSchema(),
    },
  ];

  return {
    tools,
    dispose: async () => {
      conn.close();
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest src/main/core/mcp/__tests__/raw-sql.test.ts`
Expected: PASS (3 tests). **If the dirty-`-wal` test fails with `SQLITE_CANTOPEN`**, the readonly fallback is doing its job — confirm the fallback branch is reached; the test should still pass because the fallback opens read-write. If it fails some other way, stop and report — do not weaken the test.

- [ ] **Step 5: Commit**

```bash
git add src/main/core/mcp/tools/raw-sql.ts src/main/core/mcp/__tests__/raw-sql.test.ts
git commit -m "feat(mcp): createRawSqlTools bundling query_sql + get_schema (WAL-safe open)"
```

---

### Task 4: Wire both transports + activity summaries

**Files:**
- Modify: `src/main/core/mcp/server.ts` (`startMcp` — build + registry seed ~line 221; `stop()` ~line 519)
- Modify: `src/main/mcp/stdio-entry.ts` (`main()` — registry build ~line 113; `shutdown()` ~line 122)
- Modify: `src/main/core/mcp/activity.ts` (`summarizeCall` switch ~line 243)
- Test: `src/main/core/mcp/__tests__/raw-sql-wiring.test.ts`
- Test (extend): `src/main/core/mcp/__tests__/activity.test.ts`

**Interfaces:**
- Consumes: `createRawSqlTools` (Task 3).
- Produces: no new exports; `query_sql`/`get_schema` now present in both transports' registries.

- [ ] **Step 1: Write the failing wiring test**

Create `src/main/core/mcp/__tests__/raw-sql-wiring.test.ts`. It boots the real HTTP server and asserts `tools/list` includes the two tools and `query_sql` runs end-to-end over JSON-RPC.

```ts
/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { openDb } from '../../../db/app-db';
import { openStore } from '../../store/store';
import { startMcp } from '../server';
import type { McpServerHandle } from '../server';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};

const logSink = { log: () => {} };

async function rpc(
  port: number,
  body: unknown,
  sessionId?: string,
): Promise<{ status: number; sessionId: string | null; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  // enableJsonResponse is on, so the body is a single JSON object.
  return {
    status: res.status,
    sessionId: res.headers.get('mcp-session-id'),
    json: text ? JSON.parse(text) : null,
  };
}

describe('raw-sql tools over the HTTP transport', () => {
  let dir: string;
  let handle: McpServerHandle;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-wiring-'));
    const dbPath = path.join(dir, 'kiagent.db');
    const store = openStore(await openDb(dbPath), deps);
    const acc = await store.createAccount({
      source: 'gmail',
      identifier: 'me@example.com',
    });
    await store.commit({
      account: acc.id,
      documents: [
        {
          externalId: 'd0',
          type: 'email.message',
          title: 'Wired',
          markdown: 'body',
          metadata: {},
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    await store.close();

    handle = await startMcp({ query: store.read, logSink, dataDir: dir });
  });

  afterAll(async () => {
    await handle.stop();
  });

  it('lists query_sql and get_schema and runs query_sql', async () => {
    const port = handle.port!;
    const init = await rpc(port, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test', version: '0' },
      },
    });
    const sid = init.sessionId!;
    expect(sid).toBeTruthy();

    const list = await rpc(
      port,
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      sid,
    );
    const toolNames = list.json.result.tools.map((t: { name: string }) => t.name);
    expect(toolNames).toEqual(expect.arrayContaining(['query_sql', 'get_schema']));

    const call = await rpc(
      port,
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'query_sql', arguments: { sql: 'SELECT title FROM documents' } },
      },
      sid,
    );
    const payload = JSON.parse(call.json.result.content[0].text);
    expect(payload.rows).toEqual([{ title: 'Wired' }]);
  });
});
```

> Note: `store.read` is captured before `store.close()`; `startMcp` opens its own read handle to the same `kiagent.db` via `createRawSqlTools`, so `query_sql` reads the corpus independently of the closed write store. The bounded tools use `deps.query` (= `store.read`), which reads the same file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest src/main/core/mcp/__tests__/raw-sql-wiring.test.ts`
Expected: FAIL — `tools/list` lacks `query_sql`/`get_schema` (server not yet wired).

- [ ] **Step 3a: Wire `server.ts`**

Add the import near the other `./tools` import:

```ts
import { createRawSqlTools } from './tools/raw-sql';
```

Replace the registry seed at the top of `startMcp` (currently `const registry = createToolRegistry(buildBuiltinTools(deps.query));` then `const dbPath = ...`):

```ts
  const dbPath = path.join(deps.dataDir, 'kiagent.db');
  const rawSql = createRawSqlTools(dbPath);
  const registry = createToolRegistry([
    ...buildBuiltinTools(deps.query),
    ...rawSql.tools,
  ]);
```

In `stop()`, close the handle alongside the dispatchers (before/after `httpServer.close` — order does not matter):

```ts
    async stop() {
      loopback.dispose();
      productDispatcher?.dispose();
      await rawSql.dispose();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
        httpServer.closeAllConnections?.();
      });
    },
```

- [ ] **Step 3b: Wire `stdio-entry.ts`**

Add the import:

```ts
import { createRawSqlTools } from '../core/mcp/tools/raw-sql';
```

Replace the registry build (`const registry = createToolRegistry(buildBuiltinTools(store.read));`) with:

```ts
  const rawSql = createRawSqlTools(dbPath);
  const registry = createToolRegistry([
    ...buildBuiltinTools(store.read),
    ...rawSql.tools,
  ]);
```

In `shutdown()`, dispose before closing the store:

```ts
    try {
      await server.close();
    } catch {
      /* ignore */
    }
    try {
      await rawSql.dispose();
    } catch {
      /* ignore */
    }
    try {
      await store.close();
    } finally {
      process.exit(code);
    }
```

- [ ] **Step 3c: Add activity summaries**

In `src/main/core/mcp/activity.ts`, add two cases to the `summarizeCall` switch (before `default:`):

```ts
    case 'query_sql': {
      const rows = Array.isArray((result as { rows?: unknown }).rows)
        ? (result as { rows: unknown[] }).rows
        : [];
      const truncated = Boolean((result as { truncated?: unknown }).truncated);
      return {
        summary: `ran SQL → ${rows.length}${truncated ? '+' : ''} row(s)`,
      };
    }
    case 'get_schema':
      return { summary: 'read schema' };
```

- [ ] **Step 4a: Add an activity summary test**

Append to `src/main/core/mcp/__tests__/activity.test.ts` (inside the `summarizeCall` describe block; match the file's existing import of `summarizeCall`):

```ts
  it('summarizes query_sql by row count', () => {
    const out = summarizeCall(
      'query_sql',
      { sql: 'SELECT 1' },
      { rows: [{ x: 1 }, { x: 2 }], truncated: false },
    );
    expect(out.summary).toBe('ran SQL → 2 row(s)');
    expect(out.detail).toBeUndefined();
  });

  it('marks truncated query_sql results', () => {
    const out = summarizeCall('query_sql', { sql: 'SELECT 1' }, {
      rows: new Array(500).fill({ x: 1 }),
      truncated: true,
    });
    expect(out.summary).toBe('ran SQL → 500+ row(s)');
  });

  it('summarizes get_schema', () => {
    const out = summarizeCall('get_schema', {}, 'markdown');
    expect(out.summary).toBe('read schema');
  });
```

- [ ] **Step 4b: Run the tests to verify they pass**

Run: `npx jest src/main/core/mcp/__tests__/raw-sql-wiring.test.ts src/main/core/mcp/__tests__/activity.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/core/mcp/server.ts src/main/mcp/stdio-entry.ts src/main/core/mcp/activity.ts \
  src/main/core/mcp/__tests__/raw-sql-wiring.test.ts src/main/core/mcp/__tests__/activity.test.ts
git commit -m "feat(mcp): expose query_sql + get_schema on http and stdio transports"
```

---

### Task 5: Docs + full verification

**Files:**
- Modify: `docs/rebuild/LEFTOVERS.md` (item 12)
- Modify: `docs/architecture/mcp.md` (the "no query_sql/get_schema" line, ~line 52)
- Modify: `src/main/core/mcp/tools/count.ts` (stale "which this build does not expose" wording — optional but keeps docs honest)
- Modify: `src/main/core/mcp/tools/index.ts` (export the new types if any downstream needs them — see step)

- [ ] **Step 1: Update `LEFTOVERS.md`**

Replace item 12:

```markdown
12. **`query_sql` / `get_schema` MCP tools** — DONE (2026-07-13, spec
    `docs/superpowers/specs/2026-07-13-query-sql-get-schema-design.md`): both
    ship on the HTTP and stdio transports (`tools/raw-sql.ts`), `tier:
    'powerful'` with no consent gate. `query_sql` is read-only (SELECT/WITH
    textual gate + readonly driver, 500-row cap); `get_schema` returns a
    freshly-written greenfield schema doc kept honest by a drift test. The
    'powerful' tier tag is the hook a future per-transport/consent filter
    would key off.
```

- [ ] **Step 2: Update `docs/architecture/mcp.md`**

Read the file around line 52. Replace the line that says the surface is "Deliberately narrower than the legacy app: no `query_sql` / `get_schema` raw-SQL escape hatch." with a statement that both now ship as `tier: 'powerful'` read-only tools (query_sql: SELECT/WITH only, 500-row cap; get_schema: markdown schema doc), gate deferred. Keep the surrounding prose intact; adjust the tool count if the doc states one.

- [ ] **Step 3: Refresh the stale `count.ts` comments (optional, do if quick)**

The `count.ts` file and error message say raw SQL "is intentionally NOT ported" / "this MCP build does not expose". Now it IS exposed. Update the two references (the header comment ~line 8 and the thrown error ~line 76) to point callers at `query_sql`/`get_schema` as available tools for the unsupported `group_by` values, e.g.:

```ts
      `count: group_by '${a.group_by}' isn't supported directly — use query_sql (see get_schema) for grouped aggregations. Supported here: 'source'.`,
```

If you change the error text, grep for a test asserting the old message (`grep -rn "does not expose" src`) and update it too.

- [ ] **Step 4: Typecheck + lint**

Run: `npm run typecheck` (`tsc -p tsconfig.typecheck.json` — this is what CI runs).
Expected: no errors.

Run: `npm run lint`
Expected: no new errors in the touched files. (Watch for unused imports and the `as unknown as ConnectBroker` cast — both are intentional.)

- [ ] **Step 5: Full MCP suite + whole-repo jest**

Run: `npx jest src/main/core/mcp src/main/mcp`
Expected: PASS.

Then the whole suite:

Run: `npx jest`
Expected: green except the known pre-existing flaky `src/main/platform/__tests__/extension-e2e.test.ts` (a forked-child timing test that passes in isolation — re-run it alone to confirm: `npx jest src/main/platform/__tests__/extension-e2e.test.ts`). Any OTHER failure is yours to fix.

- [ ] **Step 6: Commit**

```bash
git add docs/rebuild/LEFTOVERS.md docs/architecture/mcp.md src/main/core/mcp/tools/count.ts
git commit -m "docs(mcp): mark query_sql/get_schema shipped; refresh stale references"
```

---

## Self-Review

**Spec coverage:**
- Two tools shipped, `tier:'powerful'`, no gate → Tasks 1, 3, 4. ✓
- Fresh `SCHEMA_DOC` against greenfield schema, `accounts.source` join taught → Task 2 (schema-doc.ts overview + documents.prep_notes). ✓
- Separate `raw-sql.ts`; `buildBuiltinTools(query)` untouched → Task 3 (and Task 4 concats without changing `buildBuiltinTools`). ✓
- No bigint coercion → Task 1 (no `defaultSafeIntegers`), Global Constraints. ✓
- Read-only enforcement (textual + driver), 500-cap + truncated → Task 1 tests + impl. ✓
- WAL-safety proven, fallback on `SQLITE_CANTOPEN` → Task 3 (dirty-`-wal` test + `openReadHandle` fallback). ✓
- Drift test (columns, tables allowlist, source enum; no tracked_roots.kind; type hand-maintained) → Task 2. ✓
- Both transports wired + dispose on teardown → Task 4. ✓
- `summarizeCall` sane summaries → Task 4. ✓
- Docs (LEFTOVERS, mcp.md) + stale `count.ts` → Task 5. ✓
- Transport-exposure decision recorded (alpha-cent's call) → spec §5; nothing to build in core. ✓

**Placeholder scan:** No TBD/TODO; every code step carries complete code. The only conditional is Task 3's fallback branch, which is implemented (not deferred) and driven by an actual error code.

**Type consistency:** `runQuerySql(conn, sql)` / `QuerySqlResult` (Task 1) are the exact names Task 3 imports. `renderSchema` (Task 2) matches Task 3's import (renamed from legacy `getSchema` — no `getSchema` reference survives). `createRawSqlTools(dbPath) → { tools, dispose }` (Task 3) matches the wiring in Task 4. `Source.descriptor.id` (Task 2 drift test) matches the contract. `ConnectBroker` stub only needs `registerOAuthProfile`, matching `sources/index.ts`'s usage.
