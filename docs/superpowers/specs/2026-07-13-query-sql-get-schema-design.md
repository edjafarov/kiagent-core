# `query_sql` / `get_schema` MCP tools — design

**Status:** approved, ready for implementation plan
**Date:** 2026-07-13
**Leftover:** closes item 12 in `docs/rebuild/LEFTOVERS.md`

## Problem

The greenfield MCP surface ships five bounded tools (`search`, `get`, `count`,
`get_related`, `digital_memory_info`), all built on the `Query` interface. The
legacy app had two more — `query_sql` (a read-only raw-SQL escape hatch) and
`get_schema` (an annotated schema doc so the model can write that SQL) — held
back "until the 'powerful' tool consent tier exists" (`count.ts` and
`server.ts` reference their absence; `count(group_by)` errors for every value
but `source` because the aggregation it needs is only expressible in raw SQL).

We are shipping them now. The gate they waited on is unnecessary here: MCP
access is already user-confirmed (the user installs the desktop app and
connects a client), the live transports are loopback-bound or a
locally-spawned stdio sibling, and both tools are strictly read-only.

## What ships

Two tools, registered alongside the existing five:

- **`query_sql`** — runs one read-only `SELECT`/`WITH` statement against the
  corpus. Capped at 500 rows with a `truncated` flag. Rejects anything that
  isn't `SELECT`/`WITH` at the tool layer, and opens a read-only driver handle
  so a write can't slip through even if the textual check is bypassed.
- **`get_schema`** — returns a hand-maintained markdown description of the
  corpus schema (tables, columns, enums, relations, prep notes) so the model
  knows what to query before calling `query_sql`. Pure; no DB access.

Both are tagged `tier: 'powerful'`.

## Design decisions

### 1. The schema doc is written fresh, not ported

The legacy `SCHEMA_DOC` describes a schema that no longer exists — bigint
integer ids, `inference_jobs`, `oidc_payload`, `tracked_roots`,
`drive_folder_index`, `imap_message_index`, `connector_cadence`, a
single-column `documents_tri`, and a `source`/`source_id` column pair on
`documents`. Porting it verbatim would hand the model a map of a building that
was demolished.

The greenfield schema (`src/main/core/store/schema.ts`) is:

- **`documents`** — `id` (TEXT, UUIDv7 PK), `account_id`, `external_id`, `type`,
  `title`, `markdown`, `url`, `metadata` (JSON), `created_at`, `parent_id`,
  `content_hash`, `seq`, `archived_at`, `languages` (JSON array), `ingested_at`,
  `updated_at`. **There is no `source` column** — a document's source is
  `accounts.source`, reached by joining `documents.account_id = accounts.id`.
  This join is the single most important thing the doc must teach, because
  every "by source" query needs it.
- **`accounts`** — `id` (TEXT PK), `source`, `identifier`, `config` (JSON),
  `status`, `cursor`, `progress` (JSON), `last_sync_at`, `last_error`,
  `cadence`, `created_at`.
- **`documents_fts`** — FTS5: `doc_id` (UNINDEXED), `title`, `markdown`,
  `title_stem`, `markdown_stem`. `rowid = documents.rowid`; join on `doc_id`.
- **`documents_tri`** — FTS5 trigram: `doc_id` (UNINDEXED), `body`. Substring
  fallback index.
- **`changes`** — the ordered feed (`seq`, `kind`, `ref_id`, `at`). Documented
  read-only because it can answer "what changed and when" questions.

The doc documents the agent-facing, queryable tables: `documents`, `accounts`,
`documents_fts`, `documents_tri`, `changes`. Internal bookkeeping tables —
`meta`, `consumers`, `work_ledger`, `vault`, `consents`, `schedule` — are
allowlisted out (see the drift test); `vault` in particular holds encrypted
credential blobs and is deliberately not advertised.

Schema-doc shape (`overview`, `tables[]`, `enums[]`) and the markdown renderer
port cleanly from the legacy `schema-doc.ts` / `get-schema.ts`; only the
*content* is rewritten.

**Enums:**
- `source` — CI-enforced against the registered source ids (see drift test).
  Today: `gmail`, `imap`, `local-folder`.
- `type` — hand-maintained (document type strings are scattered literals in
  per-source builders, so they can't be machine-derived). Documents the dotted
  greenfield types (`email.thread`, `email.message`, `attachment`, `file`,
  ...), pulled from the source builders at authoring time with a header note to
  keep it current.

### 2. A separate `tools/raw-sql.ts` module; `buildBuiltinTools` stays Query-only

`query_sql` needs a raw SQLite handle, which the `Query`-only `buildBuiltinTools`
signature does not carry. Rather than thread a handle through every existing
tool, add:

```ts
// src/main/core/mcp/tools/raw-sql.ts
export function createRawSqlTools(dbPath: string): {
  tools: McpTool[];       // [query_sql, get_schema]
  dispose: () => Promise<void>;
}
```

It owns the read-only handle and returns both tools plus a `dispose` that closes
it. `get_schema` needs no handle but ships in the same pair (you only expose the
schema doc where you expose the SQL). `buildBuiltinTools(query)` is unchanged —
its Query-only test callers stay green.

Both entry points already know the db path and wire the pair in identically:

- **`core/mcp/server.ts`** (`startMcp`): `dbPath` is already computed
  (`path.join(deps.dataDir, 'kiagent.db')`, line ~222). Build
  `const raw = createRawSqlTools(dbPath)`, seed the registry with
  `[...buildBuiltinTools(deps.query), ...raw.tools]`, and `await raw.dispose()`
  in `stop()`.
- **`mcp/stdio-entry.ts`**: `dbPath` comes from `--db`. Same concat; call
  `raw.dispose()` inside `shutdown()` alongside `store.close()`.

The registry is read at request time and shared across sessions, so both
transports see the two new tools with no further change. `createMcpHandler()`
(the product remote-transport hook) shares that same registry — see §5.

### 3. No bigint coercion

Legacy set `defaultSafeIntegers(true)` and coerced every `bigint` back to
`Number` (its ids were 64-bit integers). Greenfield ids are TEXT and the store
is number-native (`app-db.ts`: "Integer columns come back as plain `number`…
no seq/rowid approaches 2^53"). A plain `new Database(dbPath, { readonly: true })`
returns integer columns as JS numbers directly — no coercion, and no
`JSON.stringify(bigint)` throw hazard. The row-shaping loop from legacy is
dropped; rows are returned as SQLite hands them over.

### 4. Read-only enforcement, ported verbatim

Two independent layers, both retained:

1. **Textual gate:** strip leading whitespace and leading `--` comment lines,
   then require the statement to start with `select` or `with`
   (case-insensitive). Reject otherwise with a clear message.
2. **Driver gate:** the handle is opened `readonly: true`, so
   `INSERT`/`UPDATE`/`DELETE`/`CREATE`/`DROP`/`PRAGMA`-that-writes fail at
   better-sqlite3 regardless of the textual check.

Row cap: wrap the query as `SELECT * FROM (<sql>) LIMIT 501`, return the first
500, set `truncated = rows.length > 500`.

### 5. Transport exposure (flagged, accepted)

Core's registry is shared by loopback HTTP, the stdio sibling, and
`createMcpHandler()` — the hook alpha-cent's remote HTTPS overlay mounts. In
core, both live transports are local, so shipping here exposes `query_sql` to
loopback + stdio only. Downstream, alpha-cent's remote server would expose it to
authenticated claude.ai remote clients.

This is accepted, not a new data boundary: the existing bounded tools already
let any connected client read the entire corpus; `vault` blobs stay encrypted;
the 500-row cap bounds per-call exfiltration. `tier: 'powerful'` is exactly the
signal a future consent gate or a per-transport filter would use to keep these
off the remote path. **Decision for alpha-cent, not core:** whether to filter
`powerful` tools off its remote transport. Core ships them; the tier tag makes
that filtering a one-line predicate later.

## WAL-safety (must be proven, not assumed)

`openCorpusReadConnection` (`app-db.ts:169-196`) deliberately opens the corpus
**read-write** and documents why: "a strict readonly open fails on WAL
recovery" when the GUI app is closed and the `-wal` is dirty. Our raw handle is
`readonly: true` — the exact case that comment warns about.

In practice a read-write connection always opens first (the db worker in the
HTTP path; the stdio sibling's own `store` at `stdio-entry.ts:92`, before the
tools build at :113), so the `-shm`/`-wal` is already mapped and the readonly
reader just attaches — which is why the author wrote "query_sql keeps its own
readonly handle." But this ordering must be verified, not trusted.

**Approach:** a test opens a raw `readonly: true` handle against a corpus with a
dirty `-wal` and **no other live connection**.

- If it succeeds → ship `readonly: true` (strongest posture: driver-level write
  protection).
- If it throws `SQLITE_CANTOPEN` → `createRawSqlTools` falls back to opening the
  handle the way `openCorpusReadConnection` does (read-write file open, treated
  as read-only by convention: the textual gate still blocks non-`SELECT`), and
  the spec/comment records that the driver gate is convention-enforced in that
  path.

The plan must carry this as an explicit line item — unit tests that always run
with a writer present will not surface it.

## Files

- `src/main/core/mcp/tools/schema-doc.ts` — new; greenfield `SCHEMA_DOC` + types.
- `src/main/core/mcp/tools/get-schema.ts` — new; markdown renderer (ported) +
  `get_schema` tool wiring.
- `src/main/core/mcp/tools/query-sql.ts` — new; the read-only SQL runner.
- `src/main/core/mcp/tools/raw-sql.ts` — new; `createRawSqlTools(dbPath)` bundling
  both tools + `dispose`, owning the handle (incl. the WAL fallback if needed).
- `src/main/core/mcp/server.ts` — wire `createRawSqlTools` into the registry;
  dispose in `stop()`.
- `src/main/mcp/stdio-entry.ts` — same wiring; dispose in `shutdown()`.
- `src/main/core/mcp/tools/index.ts` — export the new types.
- `src/main/core/mcp/activity.ts` (`summarizeCall`) — a sane summary for the two
  new tool names so the activity feed / tray don't render garbage.
- `docs/rebuild/LEFTOVERS.md` — item 12 moves from omitted to shipped.
- `docs/architecture/mcp.md` — drop the "no `query_sql`/`get_schema`" line.

## Tests

- **`query-sql.test.ts`** — `SELECT` returns rows; `WITH … SELECT` works;
  `INSERT`/`UPDATE`/`DELETE`/`DROP`/`CREATE` and a write `PRAGMA` are rejected
  (textual gate); a write attempt that evades the textual gate still fails at the
  driver; 500-row cap sets `truncated`; ≤500 does not; leading `--` comments are
  stripped before the `SELECT` check.
- **`get-schema.test.ts`** — returns markdown; contains the `documents` and
  `accounts` tables and the `source` enum values.
- **`mcp-schema-doc-drift.test.ts`** — ported: (1) every live column of every
  documented table is documented; (2) every live table is documented or
  allowlisted (FTS5 shadow tables + the internal bookkeeping set) and every
  documented table exists live; (3) the `source` enum matches the ids from
  `registerBundledSources`. No `tracked_roots.kind` check (table gone); `type`
  enum not enforced (header note).
- **WAL-recovery open test** — the §"WAL-safety" line item: a `readonly: true`
  open against a dirty-`-wal` corpus with no other connection.
- **Registration test** — both tools appear in the registry built by `server.ts`
  and `stdio-entry.ts` and are callable end-to-end (extend the existing
  `tools.test.ts` / server test rather than a new file).

## Out of scope

- No consent/permission gate (`tier: 'powerful'` is metadata only).
- No change to `count`'s `group_by` limitations — its error messages already
  point at `query_sql`; a follow-up could route the unsupported group_bys
  through raw SQL, but that is not this task.
- No per-transport filtering in core (an alpha-cent decision, §5).
