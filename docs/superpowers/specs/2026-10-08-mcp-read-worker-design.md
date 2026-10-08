# MCP reads stay fast during sync — dedicated read worker

**Status:** DRAFT rev 4 (2026-10-08) — rev 1–3 reviewed by fable + codex astra (NOT SATISFIED; all findings folded in, see §8) · **Issue:** #146 · **Base:** core v0.104.0 (c369815d) · **Related:** #145 (helpers yield, released v0.104.0), #147 (converter off main + background admission)

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

**Fuzzy pass without corpus-wide ranking.** Today the trigram fallback runs `ORDER BY bm25(documents_tri) LIMIT ?`; bm25 gathers corpus-wide phrase statistics, so its cost grows with the match count (measured ~1.2 s at 100k matches) whatever the LIMIT. Replace with ONE statement that keeps every eligibility filter, drops bm25, takes the NEWEST matches (trigram rowid = `documents.rowid` = insert order; FTS5 consumes `ORDER BY rowid DESC` without sorting) and reads no bodies:

```sql
SELECT d.id, d.title, d.created_at, d.ingested_at /* + d.markdown only when the query has negated terms */
  FROM documents_tri t JOIN documents d ON d.id = t.doc_id
 WHERE documents_tri MATCH ? ${where}          -- same filters as today (account, type, dates, people, labels, ext, archived)
 ORDER BY t.rowid DESC LIMIT ?                 -- FUZZY_CANDIDATES = 100
```

Candidates are ranked locally (folded title contains a positive term first, then newest); negation folding of candidate bodies runs only when the query has negated terms. **Merge without RRF:** the exact (FTS5, bm25) list is kept as is; fuzzy candidates already in it are dropped; the rest are appended up to the free slots; full rows are then fetched only for those appended winners (≤ free slots). The existing final date sort for `order:newest` stays.

**Search projection.** `SearchQuery` gains `withBody?: boolean` (default `true`, today's behaviour) and `contextLines?: number`. With `withBody: false` the query returns hits whose `markdown` is empty and whose `snippet` is ALWAYS set where the query runs. Snippet formats do not change: text searches keep FTS5 `snippet()`, fuzzy-filled rows keep the `fuzzy.ts` window, and recency/filter-only searches use the MCP tool's line-window builder (`contextLines`, `**` marks), which moves from `tools/search.ts:244` into the query module (the tool keeps importing it). Callers passing `withBody: false`: the MCP `search` tool, `digital_memory_info` (`query.search({ limit: 500 })`, reads only type/languages/dates), and renderer `search:query` if no renderer consumer reads `markdown` from it (the plan verifies; otherwise it keeps full bodies). Full documents still come from `get` / `document`.

**The `data_version` sample is taken BEFORE the language lookup** that fills the cache, and stored with it; a later sample that differs recomputes.

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

- **SQL runner process:** new entry `core/mcp/sql-runner-entry.ts` (webpack entry `sqlRunner` in prod + dev configs, file resolved next to the main bundle like `dbWorker`). It installs NO signal handlers (so SIGTERM terminates it even inside `sqlite3_step`), opens `openCorpusReadConnection(dbPath, { cacheKiB: 2048, queryOnly: true })`, and answers `{ id, sql }` with the bounded result.
- **Own spawn adapter, not the extension transport:** `createSqlRunner` takes `spawn(): RunnerChild` where `RunnerChild = { pid, send, onMessage, onExit, kill(signal) }`. The app adapter wraps Electron `utilityProcess.fork` (exposes `pid`; `kill()` = SIGTERM / TerminateProcess) plus `process.kill(pid, 'SIGKILL')` as the force step; the test adapter wraps `child_process.fork` under ts-node. No `demoteHost`: query_sql is interactive work (#145: class follows the request).
- **Executor interface:** `type QuerySqlExecutor = (sql: string) => Promise<QuerySqlResult>`. `createRawSqlTools(exec)` takes it. The app passes `createSqlRunner({ spawn, timeoutMs: 10_000, idleMs: 300_000 })`; the stdio sibling passes an in-process executor over its own connection (its own process, unchanged behaviour).
- **Runner states:** `none → starting → ready → stopping → none` (plus `stuck`). At most ONE child exists, owned until its exit is confirmed.
  - First call spawns (`starting`); calls are serialized; a waiting caller's 10 s starts when its statement starts; idle kill after `idleMs`.
  - Timeout: state `stopping`; `kill('SIGTERM')`; if no exit within 2 s, `kill('SIGKILL')`; on `exit` → `none`. The timed-out caller gets `query_sql stopped after 10 s. Narrow it: filter by account or created_at, avoid LIKE over markdown, or use search.` Calls arriving while `stopping` get `query_sql is still stopping the previous query. Try again in a few seconds.`
  - No exit 5 s after SIGKILL → `stuck`: every call gets `query_sql is unavailable right now.` and an error is logged; never a second child.
  - Spawn failure (e.g. the native module fails to load in the utility process) → `query_sql is unavailable right now.` + logged; the next call may retry the spawn.
  - Unexpected `exit` while `starting`/`ready` (crash, OOM): the in-flight caller gets `query_sql is unavailable right now.`, state → `none`, logged; the next call spawns.
  - A late `exit` while `stuck` → `none` (recovered).
  - `readDiagnostics().sql` exposes `{ state, pid }` so the packaged smoke can assert the process is gone.
- **Bounded result, inside the runner before transfer** (the stdio executor uses the same `runQuerySql`): rows materialized incrementally with `.iterate()`; each string value cut at 64 KiB with `…[truncated]`; stop at 500 rows or 1 MiB of serialized row data, whichever first; `truncated: true` + hint when cut.
- **No fallback** to main or the writer for query_sql. The MCP server owns the runner: `stop()` kills it.

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
- **Checkpoints:** a reader's snapshot lives for one statement and the SQL runner's is released when it is killed. Reader statements are NOT all bounded: `count`/`countBy` aggregate over the filtered set and a broad exact search can be slow; one slow statement delays the next reader call and checkpoint progress. #146 does not bound these; `readDiagnostics` (per-method p95, `-wal` size) and the §6 probe (which runs `countBy` concurrently) show whether a second reader is needed (§7).

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

- `createCorpusQuery` extraction: existing store/search suites pass unchanged. Fuzzy: no `bm25(documents_tri)` and no `markdown` column in the fuzzy statement (unless negated terms); account-restricted fuzzy search where another account's matches occupy the newest rowids still returns the restricted account's hits; archived-heavy corpus returns non-archived hits; candidates are the newest matches; local order (title hit, then newest); exact-hit order preserved when fuzzy candidates overlap it (exact `[A,B,C]` + fuzzy `[C,B,A,F]` → `[A,B,C,F]`); no folding without negated terms. Projection: `withBody: false` returns empty markdown and a snippet for text, recency and filter-only searches, each in its existing format; the MCP search tool and `digital_memory_info` outputs are unchanged for the same corpus; grep gate: MCP tools never call `search` without `withBody: false`.
- Language cache: reader-side query sees a new language after a writer commit (data_version changed); interleaving test: cache fill started before a commit, search after the commit recomputes.
- Read role (real worker under ts-node): no migration; `query_only` refuses an INSERT; `cache_size` set; only the `read` procedure registered.
- **Reads don't queue behind writes:** real writer + reader on one file; run a real large ingest `commit` (FTS + trigram over multi-MB bodies) and a reconcile stage on the writer while issuing `reads.search` + `reads.document` + `reads.countBy`; assert reader calls complete while the writer is mid-transaction and `store.read` calls queue behind it.
- Fallback: open failure → writer mode with stats; in-flight `DB_WORKER_CRASHED` → writer retry; parked callers during a failed respawn (`DB_WORKER_DEAD`) → writer retry, then sticky.
- query_sql (child_process adapter): main-thread handle gone (`raw-sql-wiring` updated); an expensive non-row-yielding statement (aggregate over a large recursive CTE) is stopped at the timeout — the child process EXITED (pid gone), a call during `stopping` gets the retry message, the next call succeeds on a fresh child, `reads` calls meanwhile are unaffected; SIGTERM ignored → SIGKILL escalation (fixture child that blocks SIGTERM); no exit → `stuck`, never a second child; byte bound (500 rows × 2 MB markdown → ≤ 1 MiB, `truncated: true`); idle kill (fake timers); stdio executor gets the same bounds.
- Packaged boundary (Electron utility process + packaged better-sqlite3) is verified by the release smoke on macOS and Windows (§6), not by jest.
- Routing: MCP deps and renderer IPC use `p.reads`; extension slice, engine, outbound, factory reset still use `store.read` (grep gate + unit).

## 6. Acceptance (live, before release)

- **Probe:** `scripts/mcp-latency-probe.mjs` — an external MCP client against the local server (7421) running a fixed workload every 5 s: 10 text searches (one fuzzy-only term, one account-restricted), 2 recency/filter-only searches, one `digital_memory_info`, 10 `get` ids, and `count` with `group_by: 'label'` and `group_by: 'from'` over a large matching set (these reach `Query.countBy`) issued concurrently with the gets — `readDiagnostics` must show the `countBy` executions; reports p50/p95 for search and get separately, plus main event-loop lag.
- **Packaged smoke (macOS + Windows, release smoke stage):** `query_sql` `SELECT 1` succeeds in the packaged app (utility process loads better-sqlite3); a non-yielding heavy statement is stopped at 10 s, the runner process is gone, and the next call succeeds.
- **Run:** idle baseline, then during a Gmail + Drive initial sync — on the Mac with `KIA_HOST_WEAK=1`, and on the Windows VM. Same corpus/cache state for before (v0.104.0) and after.
- **Pass:** search and get p95 during sync ≤ ~2× idle p95; a heavy `query_sql` is stopped at 10 s and the runner process is gone; fallbacks = 0. If the probe shows main event-loop lag (converters, #147) dominating the remaining latency, record it and hand the number to #147 instead of tuning around it.

## 7. Out of scope, recorded

- Pool of more than one reader: not in #146. Add a second reader thread (same role, round-robin) only if the §6 probe shows get p95 failing because of slow `count`/search statements on the single reader.
- Smaller commit transactions / trigram cap: #147 / follow-up.

## 8. Review log

- rev 3 → rev 4: fuzzy candidates are the newest matches, statement reads no bodies, full rows only for appended winners (fable N1); merge keeps exact order and appends fuzzy (no RRF) (astra 2); `digital_memory_info` and renderer search use `withBody: false` (fable N2); snippet formats preserved, tool's line-window builder moves into the query module (fable N3); runner crash and stuck-recovery transitions, `{state,pid}` in diagnostics (fable N4); probe exercises `countBy` via `group_by` label/from plus `digital_memory_info` (astra 1).
- rev 2 → rev 3: fuzzy statement keeps all filters and drops bm25 (local ranking: title hit, then newest; 100 candidates) (fable N1, astra 1–2); search projection `withBody: false` with snippets built in the reader for all modes, MCP search stops pulling full bodies (astra 3); own spawn adapter with pid, SIGTERM→SIGKILL escalation, runner states with one child owned until exit confirmed, no signal handlers in the runner, no demotion (astra 4, fable N2–N3); packaged smoke for the utility-process native module on macOS + Windows (fable N4, astra 4); no claim that reader statements are bounded — count/countBy measured concurrently, second reader only if needed (astra 1/6); data_version sampled before fill (astra).
- rev 1 → rev 2: thread terminate cannot stop SQLite → killable SQL runner process (fable F1, astra 1); query runs in the reader, not split across threads (astra 2); `data_version` cache instead of cross-component invalidation (astra 3); byte bounds in the runner (astra 4); extension slice stays on the writer (astra 5); fuzzy candidate cap + no fold without negations, no false checkpoint bound (astra 6); external MCP probe for acceptance, internal stats keyed by caller × method with execMs + wal size (astra 7, fable F3); fallback covers in-flight and parked callers and open failure (astra 8); `openCorpusReadConnection` extended instead of a sibling, stdio uses `createCorpusQuery` (fable F4); SQL runner owned by the MCP server only (fable F5); reads p95 is not a #147 pressure signal (fable F2).
