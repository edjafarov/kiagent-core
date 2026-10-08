# MCP reads stay fast during sync — dedicated read worker

**Status:** DRAFT rev 1 (2026-10-08) · **Issue:** #146 · **Base:** core v0.104.0 (c369815d) · **Related:** #145 (helpers yield, released v0.104.0), #147 (converter off main + background admission)

## 1. Problem

During initial sync, MCP calls (search / get / count / get_related / query_sql) from ChatGPT or Claude become very slow, and `query_sql` can freeze the app.

Two causes, both independent of CPU priority (which #145 fixed):

1. **One FIFO queue for reads and writes.** The corpus connection lives in ONE worker thread (`db/worker-entry.ts`), and every operation goes through one FIFO coordinator (`db/coordinator.ts:333/437`, no priority). Ingest `commit` writes documents plus two FTS indexes (`documents_fts`, `documents_tri` trigram over up to ~2 MB bodies) in one transaction. Reconcile stages 10,000 refs per call. A MCP `search` (`deps.query = p.store.read`, `main.ts:1005`) is a plain `db.all` RPC that waits behind all of that.
2. **`query_sql` runs on the main thread.** `createRawSqlTools(dbPath)` (`core/mcp/server.ts:285`) opens a readonly better-sqlite3 handle in the main process with no `busy_timeout` and no time bound. The 500-row cap bounds output, not work: one heavy query blocks the main event loop, which also runs pull loops, converters, feed workers and IPC.

## 2. Goals / non-goals

**Goals**
- G1. Foreground reads (MCP tools and resources, renderer search and document views, extension `query` slice) never wait behind ingest writes.
- G2. `query_sql` never runs on the main thread and is stopped after a fixed time limit.
- G3. A read sees every write whose commit promise has resolved before the read started (same guarantee callers have today).
- G4. Failure of the read path degrades to today's behaviour (reads on the writer), never to failed reads.
- G5. Metrics to verify the acceptance targets: foreground read latency and fallbacks, query_sql duration and timeouts.

**Non-goals**
- Pausing or pacing ingest (that is #147).
- Smaller commit transactions or trigram size caps (#147 / follow-up, after measurement).
- The stdio MCP sibling (`mcp/stdio-entry.ts`): separate OS process with its own connection; unchanged.
- Background / consistency-sensitive reads (engine, outbound send, message evidence, feed, ledger, factory reset): stay on the writer.

## 3. Design

### 3.1 One worker entry, two roles

The existing worker entry gains a role. `openDbInWorker(dbPath, workerFile, { role: 'read' })` passes `workerData.role`; `worker-entry.ts` branches before `openDb`:

- `role: 'write'` (default): unchanged.
- `role: 'read'`: opens the corpus with `openReadConnection(dbPath, { cacheKiB })` (new, `db/app-db.ts`, next to `openCorpusReadConnection`):
  - `new Database(path, { fileMustExist: true })` — read-write open so WAL recovery works (same reason as `openCorpusReadConnection`), but
  - `PRAGMA query_only = ON` (writes refused at the SQLite level), `busy_timeout = 5000`, `cache_size = -cacheKiB`, `mmap_size = 0`.
  - No migrations, no write procedures, no plugin registry, no coordinator (bridge `admit` serves directly — one statement at a time on the worker's own thread is the queue).
  - Procedures: `querySql` only (§3.4).

No new webpack entry, no new file resolver in `main.ts`: the same `dbWorker` bundle serves both roles. Tests spawn it the same way (`execArgv` seam).

`cacheKiB`: 8192 normally, 2048 (SQLite's default) when `hostBudget(host, null).weak` (#145). The writer's pragmas are untouched.

### 3.2 One read surface, two connections

`store.read` (the `Query` object, 8 methods, `store.ts:704-1013`) is built inside `openStore`. Extract it into `createCorpusQuery(db: AppDb): { query: Query; invalidate(): void }` (new `core/store/corpus-query.ts`), used by:

- `openStore` (writer connection) — `store.read` is exactly what it is today;
- `bootCore` for the reader — `CorePlatform.reads: Query`, the **foreground read path**.

The only in-process read state is `corpusLangsCache` (languages for query-side stemming, `store.ts:604`). It moves into `createCorpusQuery` and is dropped by `invalidate()`. Because the reader's `Query` object lives in the MAIN process (only its SQL runs in the read worker), the writer store can invalidate it directly: `openStore` gains `onCorpusChange(cb)` fired wherever it clears its own cache today (commit `:1107`, resetAll `:1342`, archive/purge `:1538/:1553`), and `bootCore` wires `store.onCorpusChange(() => reads.invalidate())`. No TTL, no `data_version` polling.

G3 holds by WAL semantics: once the writer's `COMMIT` returns, any statement that starts later on another connection sees it. Every store write path resolves its promise after its transaction commits; a read issued after that promise resolves runs after the commit.

### 3.3 Routing

`CorePlatform.reads` replaces `store.read` for foreground callers:

| Caller | Today | After |
|---|---|---|
| MCP built-in tools + resources (`buildBuiltinTools(deps.query)`, `attachResourceHandlers`) | `p.store.read` | `p.reads` |
| Renderer IPC `search:query`, `docs:get`, `docs:children` | `store.read` | `reads` |
| Extension `query` slice (`withAccountTypes(deps.store.read, …)`, `extension-platform.ts:961`) | `store.read` | `reads` |
| Engine, message evidence, outbound send, boot/diagnostics `accounts()`/`count()`, factory reset | `store.read` | unchanged (writer) |

The extension slice moves too: extension pages are user-facing (calendar, people), and an extension that commits and then queries only does so after its commit promise resolves (G3).

### 3.4 query_sql in its own lazily-started read worker

`query_sql` must be stoppable, and better-sqlite3 cannot interrupt a running statement. A synchronous statement can only be stopped by terminating its thread. So query_sql gets its OWN read-role worker, so that killing it never disturbs search/get:

- `createSqlReader({ open, timeoutMs: 10_000, idleMs: 300_000 })` (new, `core/mcp/sql-reader.ts`): opens a read-role worker on first `query_sql`, runs `runQuerySql` there as the `querySql` procedure (same textual gate + `LIMIT 501` wrapper, `tools/query-sql.ts`), closes the worker after `idleMs` without calls.
- Timeout: after `timeoutMs` the main side calls `terminate()` on that AppDb (new method on the worker-backed AppDb: hard `worker.terminate()`, no respawn, pending requests rejected with code `DB_WORKER_TERMINATED`) and returns to the caller: `query_sql stopped after 10 s. Narrow it: filter by account or created_at, avoid LIKE over markdown, or use search.` The next call opens a fresh worker.
- Calls are serialized (one statement at a time; a second caller waits its turn, bounded by the same timeout).
- `createRawSqlTools(dbPath)` becomes `createRawSqlTools(sqlReader)`; the main-thread handle is gone. Server `stop()` disposes the reader.

Memory: the sql worker exists only while query_sql is in use (idle close), so weak machines pay for one extra isolate + cache only during active SQL sessions.

### 3.5 Lifecycle and failure

- **Open order:** `bootCore` opens the reader AFTER `openDbInWorker` (writer) resolves — the writer migrates; readers never do (`fileMustExist`). Corpus recovery (file move on refusal) happens before boot, so no reader holds the file then.
- **Open failure:** the reader failing to open logs `[db] read worker unavailable: <message> — reads use the writer` and `reads` is wired to `store.read`. Boot never fails because of the reader.
- **Crash:** the reader uses the existing supervisor (respawn up to 3 per 60 s, parked requests). `reads` is wrapped by `withWriterFallback(readerQuery, store.read)`: a call rejected with `DB_WORKER_CRASHED` is retried once on the writer; `DB_WORKER_DEAD` switches every later call to the writer (sticky, logged once). SQL errors propagate unchanged.
- **Shutdown:** `platform.shutdown` closes the sql reader and the read worker before `store.close()`.
- **Factory reset / compact:** in-place on the writer; readers keep working (WAL snapshots). `onCorpusChange` from resetAll drops the reader's language cache.
- **Checkpoints:** reader statements are short; query_sql is capped at 10 s, so a reader can delay checkpoint progress at most that long.

### 3.6 Metrics

`withWriterFallback` records per-call duration and outcome; the sql reader records duration and timeouts. Both expose `stats(): { count, p50Ms, p95Ms, maxMs, fallbacks | timeouts }` over the last 256 calls. `main.ts` diagnostics (`:696`, next to `dbDiagnostics`) adds `readDiagnostics: { reads, sql }`. Client-side timing measures exactly what the caller waits (fixing the coordinator metrics' blind spot for read traffic).

## 4. Rails for later

- `CorePlatform.reads` is THE foreground read path: future user-facing reads (home widgets, calendar page, people) route there by default.
- #147's background admission can read `reads` stats (p95) as a pressure signal instead of a per-call MCP pause.
- `createCorpusQuery` is reusable by the stdio sibling (`mcp/stdio-entry.ts`) when it next changes, replacing its private `openStore` read use.
- Trigram body cap: decide after measuring with §3.6 stats during a real backfill.

## 5. Testing

- `createCorpusQuery` extraction: existing store/search suites pass unchanged (behaviour-preserving move).
- Read role (real worker under ts-node): opens without migrating; `query_only` refuses an INSERT; `cache_size` set; no write procedures registered.
- **Reads don't queue behind writes (the core claim):** with a real writer + reader on one file, hold the writer busy (`withExclusive` on the writer client, or a long fixture procedure) and assert `reads.search`/`document` resolve while it is held, and that the same call on `store.read` does not.
- Read-after-commit: commit through the writer, then `reads.document`/`search` see the new row; `onCorpusChange` drops the reader's language cache (a commit adding a new language changes the stem set).
- Fallback: reader open failure → `reads === store.read` path; `DB_WORKER_CRASHED` → one writer retry; `DB_WORKER_DEAD` → sticky writer, logged once.
- query_sql: runs off main (main-thread handle gone; `raw-sql-wiring` updated); a statement exceeding `timeoutMs` (fixture: recursive CTE) is stopped, the caller gets the message, the next call succeeds on a fresh worker, and `reads` calls during the timeout are unaffected; idle close after `idleMs` (fake timers).
- Routing: MCP deps, renderer IPC handlers and extension query slice use `p.reads`; engine/outbound/factory-reset still use `store.read` (grep gate + unit).

## 6. Acceptance (live, before release)

- During a Gmail + Drive initial sync on a weak-profile run (`KIA_HOST_WEAK=1`) and on the Windows VM: MCP search/get p95 (from `readDiagnostics.reads`) within ~2× the idle-state p95.
- A deliberately heavy `query_sql` is stopped at 10 s with the message; the app UI stays responsive meanwhile (no main-thread stall in the event-loop lag probe).
- `fallbacks` stays 0 during the run.
