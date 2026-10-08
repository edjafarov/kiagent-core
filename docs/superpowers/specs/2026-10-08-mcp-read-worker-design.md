# MCP reads stay fast during sync — dedicated read worker

**Status:** DRAFT rev 2 (2026-10-08) — rev 1 reviewed by fable + codex astra (both NOT SATISFIED; all findings folded in, see §8) · **Issue:** #146 · **Base:** core v0.104.0 (c369815d) · **Related:** #145 (helpers yield, released v0.104.0), #147 (converter off main + background admission)

## 1. Problem

During initial sync, MCP calls (search / get / count / get_related / query_sql) from ChatGPT or Claude become very slow, and `query_sql` can freeze the app.

Causes, independent of CPU priority (which #145 handled):

1. **One FIFO queue for reads and writes.** The corpus connection lives in ONE worker thread (`db/worker-entry.ts`); every operation goes through one FIFO coordinator (`db/coordinator.ts:333/437`, no priority). Ingest `commit` writes documents plus two FTS indexes (`documents_fts`, `documents_tri` trigram over up to ~2 MB bodies) in one transaction; reconcile stages 10,000 refs per call. MCP `search` (`deps.query = p.store.read`, `main.ts:1005`) issues plain `db.all` RPCs that wait behind all of it.
2. **Search post-processing runs on the main thread.** The `Query` object runs in main and only its SQL crosses to the worker: language stemming, RRF fusion, fuzzy-pass folding of candidate bodies (`store.ts:~878`, runs even with no negated terms) and snippet building all happen in main. Folding 50 × 2 MiB bodies measured ~0.9 s synchronous.
3. **`query_sql` runs on the main thread.** `createRawSqlTools(dbPath)` (`core/mcp/server.ts:285`) opens a readonly better-sqlite3 handle in main with no `busy_timeout` and no time bound. `LIMIT 501` bounds row count, not work and not bytes (`SELECT markdown FROM documents` returns up to 500 large bodies, then serialized synchronously in main by the MCP registry).

## 2. Goals / non-goals

**Goals**
- G1. MCP and renderer foreground reads never wait behind ingest writes, and their SQL and post-processing run off the main thread.
- G2. `query_sql` runs outside the main process, is really stopped (process killed, file handles and WAL snapshot released) after 10 s, and its result is bounded in bytes before it reaches main.
- G3. A read sees every write whose commit promise resolved before the read started (today's guarantee).
- G4. Any failure of the read worker degrades ordinary reads to today's behaviour (writer), including calls already in flight. `query_sql` never falls back to main.
- G5. Acceptance is measured end-to-end from an external MCP client, separately for search and get; internal timings exist for diagnosis.

**Non-goals**
- Pausing or pacing ingest; converters off main (#147). If main-thread converter stalls prevent G5 acceptance, that is reported as the #147 dependency, not hidden (§6).
- Extension `query` slice: it is one surface shared by extension pages and connector background pulls (`extension-host-entry.ts:384`, `extension-platform.ts:961`); it stays on the writer until #147 adds work-kind context at the host boundary (§4).
- Background / consistency-sensitive reads (engine, outbound send, message evidence, feed, ledger, factory reset, boot/diagnostics): stay on the writer.

## 3. Design

### 3.1 Read role of the existing DB worker

`openDbInWorker(dbPath, workerFile, { role: 'read' })` passes `workerData.role`; `worker-entry.ts` branches before `openDb`:

- `role: 'write'` (default): unchanged.
- `role: 'read'`: opens the corpus with `openCorpusReadConnection(dbPath, { cacheKiB, queryOnly: true })` — the existing helper (`db/app-db.ts:257`, read-write open so WAL recovery works) extended with options: `PRAGMA query_only = ON`, `busy_timeout = 5000` (already), `cache_size = -cacheKiB`, `mmap_size = 0`. No migrations, no write procedures, no plugin registry, no coordinator (one statement at a time on the worker's thread).
  - It builds `createCorpusQuery(conn)` (§3.2) and registers ONE procedure, `read`, `{ method, args } → query[method](...args)`.

Same `dbWorker` bundle, no new webpack entry, no new file resolver; tests spawn it through the existing `execArgv` seam. `cacheKiB`: 8192 normally, 2048 (SQLite's default) when `hostBudget(host, null).weak` (#145). Writer pragmas untouched.

### 3.2 The query runs where its SQL runs

Extract the read surface (`store.read`, 8 methods, `store.ts:704-1013`) into `createCorpusQuery(db: AppDb): Query` (new `core/store/corpus-query.ts`), unchanged in behaviour except two bounded-work fixes below. Used by:

- `openStore` on the writer connection — `store.read` stays exactly what it is today, including its own cache invalidation on commit/reset/archive.
- the read worker (§3.1), over its own connection — all SQL, stemming, fusion, folding and snippet building run in the worker. Main holds a thin proxy, `createReadProxy(readDb): Query`, whose methods call `readDb.proc('read', { method, args })`.
- the stdio MCP sibling (`mcp/stdio-entry.ts:94`), replacing its `openStore`-with-fake-codec read use (deletion, same behaviour).

**Language cache (G3).** `corpusLangsCache` moves into `createCorpusQuery`. On a connection that does not see its own writes (the reader, the stdio sibling) the cache is keyed by `PRAGMA data_version`: before using the cache, read `data_version` (same connection, same thread, one cheap pragma); if it changed since the cache was filled, recompute. Fill and check happen on the one connection in order, so no stale publication race exists and no cross-component invalidation subscription is needed. The writer keeps its explicit invalidation (its own commits do not change its `data_version`).

**Bounded-work fixes** (benefit both connections):
- Fuzzy (trigram) pass: candidates are capped before ranking — `SELECT rowid FROM documents_tri WHERE documents_tri MATCH ? LIMIT 200` (unordered, stops early), then rank those. Today it ranks all trigram matches before limiting.
- Negation folding of candidate bodies runs only when the query has negated terms.

G3 for document data: once the writer's COMMIT returns, any statement starting later on another connection sees it (WAL). Store write promises resolve after COMMIT.

### 3.3 Routing

`CorePlatform.reads: Query` is the foreground read path:

| Caller | Today | After |
|---|---|---|
| MCP built-in tools + resources (`buildBuiltinTools(deps.query)`, `attachResourceHandlers`) | `p.store.read` | `p.reads` |
| Renderer IPC `search:query`, `docs:get`, `docs:children` | `store.read` | `reads` |
| Extension `query` slice | `store.read` | unchanged (§2 non-goal, §4 rail) |
| Engine, message evidence, outbound send, boot/diagnostics, factory reset | `store.read` | unchanged |

### 3.4 query_sql in a killable process

A running SQLite statement cannot be interrupted from JS (better-sqlite3 12.11 has no `sqlite3_interrupt`; `worker.terminate()` waits for the native call — measured: terminate requested at 101 ms resolved at 2,221 ms when the query finished). Only a process kill stops it.

- **SQL runner process** (new entry `core/mcp/sql-runner-entry.ts`, webpack entry `sqlRunner` in prod + dev configs): spawned the same way extension hosts are (`platform/transport.ts`: Electron `utilityProcess` in the app, `node` fork under ts-node in tests). Opens `openCorpusReadConnection(dbPath, { cacheKiB: 2048, queryOnly: true })`, answers `{ id, sql }` with the bounded result.
- **Executor interface:** `type QuerySqlExecutor = (sql: string) => Promise<QuerySqlResult>`. `createRawSqlTools(exec)` takes it. The app passes `createSqlRunner({ spawn, timeoutMs: 10_000, idleMs: 300_000 })`; the stdio sibling passes an in-process executor over its own connection (its own process; unchanged behaviour).
- **Runner lifecycle:** spawned lazily on the first call; calls serialized (one statement at a time, a waiting caller's 10 s starts when its statement starts); idle kill after `idleMs`. On timeout: mark the runner dead, `SIGKILL`, await its `exit` (bounded 2 s, logged if exceeded), reject with `query_sql stopped after 10 s. Narrow it: filter by account or created_at, avoid LIKE over markdown, or use search.` Next call spawns a fresh runner. At most one runner exists at a time. The MCP server owns it: `stop()` kills it.
- **Bounded result, inside the runner before transfer** (also applies to the stdio executor, same `runQuerySql`): rows materialized incrementally with `.iterate()`; each string value cut at 64 KiB with `…[truncated]`; stop at 500 rows or 1 MiB of serialized row data, whichever first; `truncated: true` + hint when cut. Main receives ≤ ~1 MiB.
- **No fallback** for query_sql: if the runner cannot start, the tool returns `query_sql is unavailable right now.`

### 3.5 Lifecycle and failure of the read worker

- **Open order:** `bootCore` opens the reader AFTER the writer's `openDbInWorker` resolves (writer migrates; readers never do). Corpus recovery happens before boot.
- **One wrapper for every failure mode:** `reads = withWriterFallback(proxy | null, store.read, log)`:
  - reader failed to open → wrapper starts in writer mode (logged once: `[db] read worker unavailable: <message> — reads use the writer`);
  - a call rejected with `DB_WORKER_CRASHED` or `DB_WORKER_DEAD` (including callers parked during a failed respawn) is retried once on the writer; `DB_WORKER_DEAD` also switches all later calls to the writer (sticky, logged once);
  - SQL errors propagate unchanged.
  - Stats stay active in every mode.
- **Crash:** existing supervisor (respawn up to 3 per 60 s, parked requests).
- **Shutdown:** `platform.shutdown` closes the read worker before `store.close()`; the MCP server kills the SQL runner in `stop()`.
- **Factory reset / compact:** in place on the writer; the reader sees the result through WAL and recomputes languages via `data_version`.
- **Checkpoints:** a reader's snapshot lives for one statement; reader work is bounded by the fuzzy candidate cap; the SQL runner's snapshot is released when it is killed. Overlapping reads can still delay checkpoint progress; `readDiagnostics` reports `-wal` size so this is visible (§3.6).

### 3.6 Diagnostics (internal, for diagnosis — not acceptance)

- The read worker returns `{ value, execMs }` from the `read` procedure; the proxy records `{ caller, method, execMs, totalMs, at }` (caller: `mcp` | `renderer`; set by the wiring site).
- The SQL runner records `{ execMs, totalMs, rows, bytes, truncated, timedOut, at }`.
- `withWriterFallback` counts fallbacks by reason.
- `readDiagnostics()`: per caller × method count/p50/p95/max over the last 256 calls with sample age, fallbacks, SQL runner timeouts, and `-wal` file size. Surfaced next to `dbDiagnostics` (`main.ts:696`).

## 4. Rails for later

- `CorePlatform.reads` is THE foreground read path; future user-facing reads route there.
- Extension pages: when #147 adds work-kind context at the extension host boundary (user request vs source pull), the host's `query` calls made while serving a user request route to `reads`; pulls stay on the writer.
- #147's background admission should key on writer pressure (coordinator `queueWaitMs`) and main event-loop lag, not on read latency (which this issue decouples from ingest by design).
- `createCorpusQuery` + `data_version` cache is the one read implementation for every connection (writer, reader, stdio sibling).
- Trigram body cap: decide after measuring with §3.6 during a real backfill.

## 5. Testing

- `createCorpusQuery` extraction: existing store/search suites pass unchanged; new tests for the fuzzy candidate cap (more than 200 trigram matches → bounded work, best exact matches kept) and no folding without negated terms.
- Language cache: reader-side query sees a new language after a writer commit (data_version changed); interleaving test: cache fill started before a commit, search after the commit recomputes.
- Read role (real worker under ts-node): no migration; `query_only` refuses an INSERT; `cache_size` set; only the `read` procedure registered.
- **Reads don't queue behind writes:** real writer + reader on one file; run a real large ingest `commit` (FTS + trigram over multi-MB bodies) and a reconcile stage on the writer while issuing `reads.search` + `reads.document` + `reads.countBy`; assert reader calls complete while the writer is mid-transaction and `store.read` calls queue behind it.
- Fallback: open failure → writer mode with stats; in-flight `DB_WORKER_CRASHED` → writer retry; parked callers during a failed respawn (`DB_WORKER_DEAD`) → writer retry, then sticky.
- query_sql: main-thread handle gone (`raw-sql-wiring` updated); an expensive non-row-yielding statement (aggregate over a large recursive CTE) is killed at the timeout — assert the runner process EXITED and a new call succeeds on a fresh runner, while `reads` calls during it are unaffected; byte bound (500 rows × 2 MB markdown → ≤ 1 MiB, `truncated: true`); idle kill (fake timers); stdio executor gets the same bounds.
- Routing: MCP deps and renderer IPC use `p.reads`; extension slice, engine, outbound, factory reset still use `store.read` (grep gate + unit).

## 6. Acceptance (live, before release)

- **Probe:** `scripts/mcp-latency-probe.mjs` — an external MCP client against the local server (7421) running a fixed workload (10 search queries incl. one fuzzy-only term, 10 `get` ids) every 5 s; reports p50/p95 for search and get separately, plus main event-loop lag sampled from `readDiagnostics`.
- **Run:** idle baseline, then during a Gmail + Drive initial sync — on the Mac with `KIA_HOST_WEAK=1`, and on the Windows VM. Same corpus/cache state for before (v0.104.0) and after.
- **Pass:** search and get p95 during sync ≤ ~2× idle p95; a heavy `query_sql` is stopped at 10 s and the runner process is gone; fallbacks = 0. If the probe shows main event-loop lag (converters, #147) dominating the remaining latency, record it and hand the number to #147 instead of tuning around it.

## 7. Out of scope, recorded

- Pool of more than one reader: not needed while reader statements are bounded; revisit if `readDiagnostics` shows queueing on the reader.
- Smaller commit transactions / trigram cap: #147 / follow-up.

## 8. Review log

- rev 1 → rev 2: thread terminate cannot stop SQLite → killable SQL runner process (fable F1, astra 1); query runs in the reader, not split across threads (astra 2); `data_version` cache instead of cross-component invalidation (astra 3); byte bounds in the runner (astra 4); extension slice stays on the writer (astra 5); fuzzy candidate cap + no fold without negations, no false checkpoint bound (astra 6); external MCP probe for acceptance, internal stats keyed by caller × method with execMs + wal size (astra 7, fable F3); fallback covers in-flight and parked callers and open failure (astra 8); `openCorpusReadConnection` extended instead of a sibling, stdio uses `createCorpusQuery` (fable F4); SQL runner owned by the MCP server only (fable F5); reads p95 is not a #147 pressure signal (fable F2).
