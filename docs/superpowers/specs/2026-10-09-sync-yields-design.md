# Sync yields to the user (#147, #136)

Status: APPROVED rev 5 (2026-10-09). Astra r4 and fable r3 SATISFIED.

Issues: kiagent-core #147 and #136 (the converter worker, folded in).
Tracking: #138. Base: core v0.106.0, which already includes #145 (helpers
yield) and #146 (MCP read worker).

## Problem

Initial sync still competes with the user for the main process and for the
single writer.

1. **Conversion runs on the main thread.** The parsers for PDF, DOCX, XLSX,
   HTML, MSG/EML and MBOX (`core/engine/convert.ts`) run on main in three
   places:
   - the commit path (`engine.ts:1097`, local-folder binaries);
   - the convert feed worker (`workers/convert/convert-worker.ts`);
   - the vision worker's PDF text layer (`vision-worker.ts:367`).

   On hosts without the Apple helper (every Windows host), the vision
   rasteriser also runs on main. It is WASM pdfium at scale 2, followed by a
   per-pixel BGRA→RGBA JavaScript loop and a synchronous PNG encode
   (`workers/vision/rasterize.ts`, #136-C).

   One large file blocks IPC, MCP HTTP and the UI for seconds. A hostile file
   can loop or OOM the main process.
2. **Nothing admits background work.**
   - Each account runs its own pull loop, with no global limit.
   - The convert worker, its re-drive and reconcile archival are not gated.
   - The only yield is one `setImmediate` per item.
3. **Nothing pauses for the user.** MCP calls and renderer reads arrive while
   ingest is converting and committing at full speed.
4. **Writer units are unbounded.**
   - An account commit carries a whole source batch.
   - A feed-worker or re-drive commit carries up to 500 documents' outputs
     (`FEED_BATCH`, `REDRIVE_PAGE`).
   - `reconcileArchive` loops 5,000-row transactions *inside one DB-worker
     RPC*. The worker serves requests strictly in order, so this blocks every
     other writer call until the whole cleanup ends.

## Goals

- **Event loop.** Main-thread event-loop delay p99 under 100 ms on the
  founder Mac and under 250 ms on the Windows VM, during a Gmail + Drive +
  local-folder initial sync. Measured with the monitor in §6.
- **MCP latency.** MCP search/get p95 stays within 1.5× the idle baseline
  during that sync, measured with `scripts/mcp-latency-probe.mjs` (the #146
  protocol), while ingest keeps progressing.
- **Converter isolation.** A crash, hang or OOM in the converter or
  rasteriser never takes down main. Converter output is byte-identical to
  today's.
- **Bounded writes.** No writer RPC carries more than one bounded chunk.
- **Throughput.** On an idle machine (no MCP, user away), ingest throughput is
  within 10% of today's, on **both** Mac and Windows.

## Non-goals

- Changing what is ingested.
- Changing the lane states that extensions see.
- The stdio MCP sibling. It is a separate process that never blocks main or
  the writer.
- FTS/trigram tuning (#147 item 5).

## Design

### 1. Converter process (#136 A and C)

Implement the reserved stub `converter/worker.ts`. It already has the webpack
entry `worker` in core's dev and prod configs and in alpha-cent's prod config,
so no new entry is needed.

The supervisor is `core/converter/runner.ts`, modelled on the #146 SQL runner:

- **Spawn.** It uses the same `utilityRunnerChild` / `forkRunnerChild`
  adapters, with service name `kia-converter`, resolving `worker.js` /
  `worker.bundle.dev.js` next to the main bundle.
- **Priority.** After spawn the child is demoted to BELOW_NORMAL
  (`demoteHost`), not LOW: Windows IDLE-class children starve under load,
  and starvation would turn into spurious timeouts.
- **Ops.** The pure code moves verbatim into
  `core/converter/parsers.ts`, which has no electron/store/log imports.
  - `parseDetailed(bytes, mime, filename) → {markdown, ocrPages?}`. The
    child caps markdown at `MAX_MARKDOWN_CHARS` before replying.
  - `parsePdfPages(bytes) → string[]`.
  - `rasterizePdf(bytes, pages, maxEdge?) → RasterResult` (#136-C). The reply
    keeps the existing `RasterResult` contract, `{pageCount, pages:
    [{page, png}]}`, because windowed OCR needs the document's total
    `pageCount` to continue past its first window.
    - **`maxEdge` is the caller's choice.** The vision worker passes
      `maxEdge = VLM_MAX_EDGE` **only** when it already knows that no read
      provider exists, so the raster feeds the VLM alone. It knows this
      from a new session `hasProvider('read')` probe, checked before the
      first window. pdfium then renders at the scale that gives that edge
      directly. There is no 2× render and no full-size pixel loop.
    - **Otherwise** (OCR will read the pages) `maxEdge` is omitted, pages
      render at today's `DEFAULT_SCALE = 2`, and `vlmPass` keeps its own
      `downscale`, as now. OCR deliberately uses full-size pages, so once
      Windows OCR ships it does not silently run on 896-edge renders.
    - In both paths, the BGRA swap and the PNG encode run in the child, off
      main.
    - On macOS with the native helper, `helper.rasterizePdf` is unchanged.
- **Queue.** One job runs at a time. The queue is bounded by input bytes,
  `MAX_QUEUED_BYTES = 128 MiB`, and `submit()` waits for space.
- **Timeout.** 120 s wall clock per job, doubled on 1-slot hosts (§2). On
  timeout: SIGTERM, then SIGKILL after 2 s. Idle exit after 300 s.
- **Cancellation.** Every op takes an `AbortSignal`.
  - A queued job is removed and rejects with `AbortError`.
  - Waiting for queue space rejects.
  - An **active** job is abandoned and the child is killed, then respawned on
    the next job.

  Cancellation never writes a failure marker.
- **Failure attribution.** This deliberately differs from the SQL runner's
  `failAll`:
  - A crash or timeout is attributed **only to the active job**. Queued,
    unstarted jobs stay queued for the replacement child.
  - Spawn and infrastructure failures (the child can't start) reject with a
    *transient* `ConverterUnavailableError`, which callers treat as "try
    later". They never record a permanent failure.
- **Mapping per caller:**

  | Caller | Crash | Timeout | Unavailable / abort |
  |---|---|---|---|
  | Commit path | `stripBinary` + deterministic marker `{status:'failed', reason:'crash'}` | today's path: `stripBinary`, no marker; the convert worker retries once later | today's path: no marker |
  | Convert feed worker | `record('failed', {error:'converter crashed'})` | `record('failed', {error:'converter timed out'})` | `defer` |
  | Vision worker (text layer and raster) | after `session.bump('raster') > 1`: a **metadata-only** enrichment that sets `extraction: { raster: 'failed' }` and clears `ocrProgress`. It **omits `markdown`**, so the existing body (for example a `needs-ocr` PDF's text layer) and its index survive. Partial OCR is not merged in. The outcome is `done`, never a throw, so there is no 3-attempt re-run of fetch + raster. This is not the `complete()` helper, which always replaces markdown | same as crash | `defer` |

  The convert worker's old crash fence (`bump('parse') > 2`) is deleted,
  because a parse can no longer kill main. The `failed`/`defer` outcomes are
  exactly the existing `record()`/`'defer'` paths.
- **Byte identity.** A parity test runs every fixture under
  `core/engine/__tests__/fixtures` both inline and through the child, and
  expects deep-equal results. The bytes-copy workaround for the pool-slice
  bug is kept on the child side.
- **Kill switch.** `KIA_CONVERTER_INLINE=1` runs everything in-process, as
  today.

### 2. One background-work owner: `core/admission.ts`

This is the kind-aware owner that #145's rail asked for. `backgroundLaneState`
(`boot.ts`) becomes a **projection** of it for the enrichment kind. Its result
and the `LaneState` values extensions see are unchanged, and the boot.ts
comment is updated.

```ts
interface Admission {
  // background-unit kinds; enrichment keeps using the lane (below)
  acquire(kind: 'ingest' | 'convert' | 'reconcile' | 'redrive',
          signal: AbortSignal): Promise<() => void>;  // resolves to release()
  foreground(): () => void;          // enter → leave (idempotent)
  foregroundBusy(): boolean;         // in flight or within grace
  // resolves when not busy, or after MAX_FOREGROUND_WAIT_MS; rejects on abort
  foregroundIdle(signal: AbortSignal): Promise<void>;
  enrichmentLane(now?): LaneState;   // = today's backgroundLaneState logic
  snapshot(): AdmissionSnapshot;
}
```

The admission object is built in `bootCore` and injected into:

- `createEngine`;
- the workers;
- `createMcpServer`;
- the renderer read handlers in `main.ts`.

Each injection is an optional dep with a no-op default.

**Slots.** `hostBudget` gains `ingestSlots`. It is 1 when `cores <= 4` or
memory is ≤ 8 GiB, otherwise 2. It deliberately ignores the `onCpu` term,
which makes every non-Mac host "weak" for enrichment. `KIA_HOST_WEAK=1|0`
still overrides.

**What a unit is: work in hand only, never waits.** A slot is acquired
**after** the input exists and released after its bounded write.

| Kind | Acquired after | Released after |
|---|---|---|
| `ingest` | the source batch has been received from `pull()` (`next()` resolved). A local-folder watcher event or a live source's `src-next` reply is the same thing: waiting for it holds no slot. | `toDocument` + convert + **one sub-commit** (§4). The loop requests the next batch only after the batch's last sub-commit, so backpressure is unchanged: one batch in flight per account. |
| `convert` | the convert worker's `session.fetchBytes` returned (the extension round trip holds no slot) | parse + that document's staged output; the output is flushed by the bounded consumer commit (§4) |
| `redrive` | per **attempt**, not per page; no permit encloses `workOne` | that attempt, and always before any retry backoff sleep |
| `reconcile` | — | one archive chunk (§4) |

Vision and audio units are **not** admitted here. They are enrichment: their
heavy work runs in demoted helper processes, they are lane-gated by #145, and
a multi-minute transcription must never hold an ingest slot. Their main-thread
cost (the raster) now lives in the converter child (§1).

**Rules**, in order:

1. **Foreground first.** While `foreground` calls are in flight, and for
   `FOREGROUND_GRACE_MS = 300` after the last one leaves, no new unit is
   admitted. Running units finish; nothing is preempted.
   - *Anti-starvation:* an acquire that has waited `MAX_FOREGROUND_WAIT_MS =
     10_000` is admitted anyway, one unit at a time.
   - **Enrichment** sees the same signal as a bounded **wait**, not a throw.
     Background inference (`gate()` for the background lane, and the worker
     pre-flight) awaits `admission.foregroundIdle(signal)`, capped at
     `MAX_FOREGROUND_WAIT_MS`, then proceeds. So a foreground burst never
     discards a fetch, raster or OCR that has already been done, and never
     schedules a full deferred-backlog walk. `LaneClosedError` stays
     reserved for real lane closure. The lane state reported to extensions
     does not change.
2. **Cap.** At most `ingestSlots` units run at a time. Waiters are ordered
   ingest > convert > reconcile > redrive, then FIFO, **with aging**:
   - a waiter that has waited `KIND_AGING_MS = 5_000` is admitted ahead of
     every younger waiter of a higher kind;
   - so at cap 1, under continuous backfill, convert, reconcile and redrive
     each still get roughly one unit per 5 s.

   Pull loops round-robin between accounts naturally.
3. **Slow mode.** While `scheduler.env.userActive`, a released slot stays
   held for `factor × unit duration`:
   - `factor = 1.0` when `ingestSlots === 1`;
   - `factor = 0.25` otherwise;
   - the hold is capped at 2 s.

   Sync slows for an active user but never stops.
4. **Lane states never stop units.** `until-synced`, `until-idle`,
   `until-night`, `battery` and `processing.enabled = false` all govern
   enrichment only. The scheduler's existing on-battery tick parking is
   unchanged.
5. **Abortable.** A pending `acquire` rejects with `AbortError` when its
   signal fires (pause, stop, removal). A slot is never acquired while
   holding an account-flow lock or inside a transaction. `release` is
   idempotent.

**Foreground sources** (each counts while in flight):

- `invokeTool` via `createMcpServer`, covering HTTP sessions and in-process
  `callTool`;
- MCP `resources/read` (`attachResourceHandlers`);
- the renderer handlers `search:query`, `docs:get` and `docs:children`.

Periodic reads, ticks and counters do not count. There is no "background
origin" exemption, because no background caller of `callTool` exists today.

**Never gated:** outbox, `draft_message`, `send_draft`, status writes and
settings.

### 3. Engine and worker integration

- **Pull loop.** For each received batch, the loop splits the batch's
  items into sub-commit groups (§4). For each group it:
  1. calls `acquire('ingest')`;
  2. runs `toDocument` + convert for the group's items;
  3. sub-commits;
  4. releases.

  It checks `abort.signal` between documents and before each commit. The
  converter is called with the loop's signal.
- **Feed worker (`attach`).** Each matched change takes
  `fetchBytes` (no slot) → `acquire('convert')` → `parse` → stage output →
  release. Only the convert worker parses. Other feed workers (vision, audio,
  any extension worker) keep their current unadmitted path.
- **Re-drive.** Each attempt is admitted individually, as above.

### 4. Bounded writer units

- **Account sub-commits.** Sub-commit boundaries fall **only between source
  items**, so a single item's outputs (for example a parent and its
  attachments) never split. A group closes when either limit is reached:
  `SUB_COMMIT_BYTES = 8 MiB` of markdown/text, or 50 documents.
  - Intermediate sub-commits pass the **last committed cursor** explicitly in
    `cursor`: `fresh.cursor` at loop entry, then the previous batch's
    `batch.cursor`. They also pass `status` and `progress`. No new store flag
    is needed.
  - Only the last sub-commit carries the new `batch.cursor` and `deletions`.
  - It also carries `relink: Array<{child: ExternalRef, parent: ExternalRef}>`,
    collected from every item in the batch that has a `parent`. The stored row
    keeps only a resolved `parent_id`, so the parent reference itself has to
    travel. `commitTx` runs the existing `reconcileParents` logic over these
    pairs, so a child committed in an earlier sub-commit gets linked once its
    parent lands. This keeps today's batch-level guarantee: any order inside a
    batch is fine.
  - A crash between sub-commits re-pulls the batch from the old cursor. This
    is idempotent, because unchanged `content_hash` is skipped.
- **Consumer sub-commits** (`attach` and `rerunDeferred`). Emitted documents
  and enrich are flushed whenever the staged bytes reach `SUB_COMMIT_BYTES`,
  and once at the end.
  - **Every flush is an admitted unit, for every consumer**, whichever
    worker it serves: convert, vision, audio or an extension. The flush is acquired right before
    `store.commit` and released right after it, as `convert` for `attach` and
    `redrive` for `rerunDeferred`. No permit is held across `fetchBytes`, a
    network wait or a retry backoff.
  - **Cursor contract.** The consumer `cursor` field on a commit becomes
    optional. When it is omitted, `commitTx` leaves `consumers.cursor`
    untouched. Today it is upserted unconditionally.
    - `attach`: intermediate flushes omit `cursor`. The final flush writes
      the new cursor. Only `attach` ever advances its feed cursor.
    - `rerunDeferred`: every flush omits `cursor`. Re-drive has no cursor of
      its own, and progress lives in the ledger (`clearAttempts` plus
      attempts), which is written with each flush, as today.

    This replaces the rev 2 `cursor: batchStart` idea, which could rewind a
    live tail that advanced while re-drive was running.
  - Replaying worked documents after a crash is already tolerated (`seen` +
    `clearAttempts`).
- **Chunked archival.** `store.reconcileArchiveChunk(accountId, startSeq) →
  {archived, done}` runs exactly one `archiveBatchTx` per RPC.
  - The engine loops, calling `acquire('reconcile')` per chunk, and calls
    `endPass` only when done.
  - If the DB worker respawns mid-pass, `requirePass` fails safely.

### 5. Single owner, stated

`admission` owns `ingest|convert|reconcile|redrive` admission and the
enrichment lane (`enrichmentLane`, plus the foreground check in `gate()`).
The following all read it:

- `backgroundLaneState`;
- the inference gate;
- the worker pre-flights;
- `refreshLane`.

No other module decides whether background work may run.

### 6. Measurement built in

- **Event-loop delay.** `perf_hooks.monitorEventLoopDelay` (20 ms
  resolution) runs on main. The p50/p99/max of each 60 s window goes into
  `readDiagnostics().eventLoop` and the `KIA_READ_DIAG_FILE` dump. A warning
  is logged when p99 > 250 ms.
- **Admission snapshot.** Foreground in-flight, waiting by kind, running,
  cumulative wait ms, starvation escapes and slow-mode hold ms.
- **Converter stats.** Jobs, crashes, timeouts, cancels and p95 ms.
- **Acceptance run.** On the founder Mac and the Windows VM, before and
  after, record the latency probe plus the diagnostics dump during a Gmail +
  Drive + local-folder initial sync. The scenarios include "local-folder in
  watch mode while Gmail backfills", "16-core Windows desktop throughput",
  "convert progress during a multi-account backfill at cap 1" and "a remote
  MCP burst during a vision backlog".

## Testing

- **Converter**
  - Fixture parity.
  - A crash affects only the active job; a healthy queued job succeeds on the
    respawned child.
  - Timeout, kill and respawn.
  - Spawn failure is transient (no marker).
  - Abort of a queued, waiting or active job, with no marker.
  - The queue blocks at the byte bound.
  - Idle exit.
  - `rasterizePdf` returns `RasterResult` with the total `pageCount` for a
    windowed request.
  - With `maxEdge`, it renders at the target edge and matches the old path
    after downscale (pixel tolerance).
  - Without `maxEdge`, its output is byte-identical to today's 2× render (the
    OCR path).
  - Windowed OCR of a 25-page PDF through the child completes all windows.
  - Main stays responsive during a looping hostile `.msg` (event-loop ticks
    observed).
- **Admission** (pure, with a fake clock)
  - `ingestSlots` comes from cores/memory, and Windows with 16 cores gets 2.
  - Priority and FIFO ordering.
  - Foreground blocks new units, with grace.
  - Starvation escape.
  - Slow-mode hold and its cap.
  - Lane states never block units.
  - Abort rejects a waiting acquire.
  - `release` is idempotent.
  - background inference **waits** while foreground is busy and proceeds
    after (no `LaneClosedError`, no `defer`, no pending-wake);
  - that wait is capped at `MAX_FOREGROUND_WAIT_MS`;
  - kind aging: at cap 1 with a permanent ingest waiter, a convert waiter is
    admitted within `KIND_AGING_MS`.
- **Engine**
  - A source parked in `watch`/`src-next` holds no slot, and another
    account's unit is admitted meanwhile.
  - A 10 s `fetchBytes` holds no slot.
  - Re-drive at cap 1 does not deadlock.
  - Sub-commits:
    - intermediate sub-commits keep the cursor;
    - a child-before-parent order across a sub-commit boundary gets linked by
      `relink`;
    - a crash between sub-commits re-pulls idempotently.
  - Consumer flushes are bounded, each is admitted, and an intermediate
    `attach` flush leaves the cursor unchanged.
  - **Concurrency regression:** with the live tail advancing the cursor from
    100 to 200 while `rerunDeferred` flushes, the cursor ends at 200.
  - A flush waits for admission while foreground is busy.
  - Pause while waiting resolves promptly.
  - Two accounts interleave at cap 1.
  - Convert makes progress while two accounts backfill at cap 1.
  - **Vision raster failure:** repeated raster failures, and repeated
    text-layer failures, on a PDF with existing markdown leave the markdown
    and its search hits intact, set the marker, clear `ocrProgress`, and
    return `done` without throwing.
- **Store**
  - `relink` pairs link a child committed earlier;
  - a commit without a consumer `cursor` preserves the stored cursor.
  - `reconcileArchiveChunk` does one transaction per call, and a writer call
    issued between chunks completes before the next chunk.
- **MCP / renderer**
  - `invokeTool`, `callTool` and `resources/read` enter and leave
    foreground, including on throw.
- **Gates.** The #146 suites and `reads-no-queue` stay green.

## Risks

- **Idle throughput.** Slots of 2 on capable hosts, slow mode only while the
  user is active, and units that hold no slot while waiting keep throughput
  close to today's. Only measurement proves the 10% target.
- **Packaging.** No new webpack entry. The release smoke on Mac and Windows
  must load `worker.js`.
- **Extension connectors.** They keep their upstream sessions while a batch
  waits for a slot. The wait is seconds, not hours.
- **Memory.** Input bytes are copied once into the child, bounded by the
  queue. Raster output is PNG at target size.
