# Sync Yields to the User (#147, #136) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Initial sync stops competing with the user: parsers and the WASM rasteriser run in a crash-isolated converter child, one kind-aware admission owner gates background units and yields to foreground reads, and every writer RPC carries one bounded chunk.

**Architecture:** A supervised `kia-converter` utility process (modelled on the #146 SQL runner) runs `parseDetailed` / `parsePdfPages` / `rasterizePdf`. A pure `core/admission.ts` owns slots (`ingestSlots` from `hostBudget`), foreground-first with grace, kind priority with aging, slow mode, and the enrichment lane (`backgroundLaneState` becomes its projection). The engine acquires a slot per sub-commit (pull loop), per consumer flush (`attach`/`rerunDeferred`) and per reconcile archive chunk; the convert worker acquires one around its parse through a new optional `session.admit()`.

**Tech Stack:** TypeScript, Electron `utilityProcess` (prod) / `child_process.fork` with `serialization: 'advanced'` (jest), better-sqlite3 behind the DB worker, jest (ts-jest), `perf_hooks.monitorEventLoopDelay`, `@hyzyla/pdfium` (WASM), `pngjs`.

**Spec:** `docs/superpowers/specs/2026-10-09-sync-yields-design.md` (APPROVED rev 5, binding). Read it before every task.

Repo/worktree: kiagent-core at `~/work/kcore-sync`, branch `opt/sync`, base `v0.106.0`. All source paths below are relative to `~/work/kcore-sync`. The spec's `core/…` paths map to `src/main/core/…`; its `converter/worker.ts` is `src/main/converter/worker.ts`; its `createMcpServer` is `startMcp` in `src/main/core/mcp/server.ts`.

Shorthands used in commands:

```bash
SCRATCH=/private/tmp/claude-501/-Users-edjafarov-work-alpha-cent/4c50a2e2-79f9-4098-aef4-8a2c75761c3a/scratchpad/opt
HEAVY=$SCRATCH/heavy.sh
```

## Global Constraints

- Tests/builds run SEQUENTIALLY only; full jest suites, webpack builds and packaging go through `/private/tmp/claude-501/-Users-edjafarov-work-alpha-cent/4c50a2e2-79f9-4098-aef4-8a2c75761c3a/scratchpad/opt/heavy.sh <cmd>`. Targeted single jest files may run directly.
- Worktrees symlink node_modules/release/app deps to ~/work/kiagent-core; NEVER run `npm run build` or `npm ci` in a worktree (shared dist). The converter worker entry already exists as a webpack entry stub; verify its bundling via a scratchpad --output-path webpack run under heavy.sh if needed.
- DB/better-sqlite3 suites may hit a pre-existing jest-worker SIGSEGV at teardown; compare against the base before calling a failure.
- Never git stash/amend/rebase/reset. Commit with `git commit -F <msgfile> -- <paths>`; no Co-Authored-By lines.
- `npm run lint` (or eslint on touched files) and `npx tsc --noEmit -p .` are gates.

Spec values every task must use verbatim:

- `MAX_QUEUED_BYTES = 128 MiB`; converter timeout 120 s wall clock per job, doubled on 1-slot hosts; SIGTERM then SIGKILL after 2 s; idle exit after 300 s; child demoted to BELOW_NORMAL (`demoteHost`), never LOW; service name `kia-converter`.
- `ingestSlots`: 1 when `cores <= 4` or memory ≤ 8 GiB, otherwise 2; ignores the `onCpu` term; `KIA_HOST_WEAK=1|0` overrides.
- `FOREGROUND_GRACE_MS = 300`, `MAX_FOREGROUND_WAIT_MS = 10_000`, `KIND_AGING_MS = 5_000`; priority ingest > convert > reconcile > redrive, then FIFO; slow mode `factor = 1.0` when `ingestSlots === 1`, `0.25` otherwise, hold capped at 2 s, only while `scheduler.env.userActive`.
- `SUB_COMMIT_BYTES = 8 MiB` of markdown/text, or 50 documents.
- Event-loop monitor: 20 ms resolution, 60 s windows, warn when p99 > 250 ms.
- Kill switch `KIA_CONVERTER_INLINE=1` runs everything in-process.
- Running a single jest file: `cd ~/work/kcore-sync && npx jest <path> --runInBand`. Suites that fork children or use `setImmediate` start with `/** @jest-environment node */` (the default environment is jsdom).
- `no-await-in-loop` is enforced: every intentional sequential await in a loop carries `// eslint-disable-next-line no-await-in-loop`, as the existing code does.

## Cross-workstream note (DB workstream, `~/work/kcore-db`)

A parallel DB workstream also edits `src/main/core/store/write-tx.ts` `commitTx` and the engine's `attach` (seeding a worker with a non-advancing consumer cursor). This plan makes the consumer `cursor` optional on commits, and that change lives **only in Task 2** with this contract:

> **Consumer-cursor contract.** On a `{ consumer, … }` commit, `cursor` is optional. `cursor !== undefined` ⇒ today's upsert (`INSERT … ON CONFLICT(name) DO UPDATE SET cursor = excluded.cursor`). `cursor === undefined` ⇒ `commitTx` executes **no statement** against `consumers` (no insert, no update); everything else in the consumer branch (clearAttempts, documents, enrich) is unchanged. Only `attach` ever writes a consumer cursor.

Task 2 touches only the consumer variant of `CommitBatch` in `src/shared/contracts.ts`, the single `if` around the consumers upsert in `commitTx`, and one new test file. `attach`'s `dropBatch` keeps passing `cursor: batchStart`. Task 10 (engine `attach`/`rerunDeferred`) uses the contract but does not touch `commitTx`. When the DB branch merges, its attach seeding lands on top of Task 10's flush code; the only overlapping hunk in `write-tx.ts` is the one guarded upsert.

## Review Focus

1. **Packaged app cannot load `worker.js`** (asar path, missing bundle, AV block on Windows): every parse rejects `ConverterUnavailableError`. Expected: no permanent markers are written, documents still commit (markdown-null), the convert worker defers and retries, and the runner does not respawn-loop a child per document. Pinned by Task 4's spawn-backoff test and Task 5's unavailable test; Task 15 smokes the bundle.
2. **Pause/stop/remove while a loop waits for a slot or for the converter.** Expected: the stop resolves within a second, nothing commits after it, no failure marker is written. Pinned by Task 4 (abort queued/waiting/active) and Task 9 (pause while waiting).
3. **A polling MCP agent that never lets foreground go idle.** Expected: ingest still progresses (one starvation escape at a time every 10 s) and background inference proceeds after at most 10 s. Pinned by Task 6 (starvation escape, capped idle wait) and Task 7 (gate waits then proceeds).
4. **One huge item** (a mail with dozens of attachments, or one item whose outputs exceed 8 MiB): it must never split across sub-commits. Expected: one sub-commit carries the whole item even past the bound. Pinned by Task 9's single-item test.
5. **Live tail advancing while re-drive flushes.** Expected: the consumer cursor never rewinds. Pinned by Task 10's concurrency regression.

---

## File map

Create:

- `src/main/core/abort.ts`: `abortError()`, `isAbortError()`; shared by admission and the converter.
- `src/main/core/converter/parsers.ts`: the pure parsers moved verbatim out of `core/engine/convert.ts`, plus `rasterizePdf` (pdfium + BGRA swap + PNG encode) and `rasterScale`. No electron/store/log imports.
- `src/main/core/converter/protocol.ts`: the parent↔child message types.
- `src/main/core/converter/converter.ts`: the `Converter` interface, stats, the three error classes, and `createInlineConverter()`.
- `src/main/core/converter/runner.ts`: `createConverterRunner()`, the child supervisor.
- `src/main/core/admission.ts`: `createAdmission()`, `NOOP_ADMISSION`, `inForeground()`.
- `src/main/core/event-loop-monitor.ts`: `startEventLoopMonitor()`.
- Tests: `src/main/core/converter/__tests__/{parsers,runner,runner-process,vision-through-child}.test.ts`, `src/main/core/converter/__tests__/fixtures/spinning-converter.cjs`, `src/main/core/__tests__/{admission,event-loop-monitor}.test.ts`, `src/main/core/store/__tests__/{consumer-cursor,sync-yields-store,reconcile-chunk-worker}.test.ts`, `src/main/core/engine/__tests__/sync-yields-engine.test.ts`, `src/main/core/mcp/__tests__/foreground.test.ts`.

Modify:

- `src/main/converter/worker.ts`: the stub becomes the child entry.
- `src/main/core/host-profile.ts`: `ingestSlots`.
- `src/shared/contracts.ts`: optional consumer `cursor`, account `relink`, `WorkerSession.hasProvider?`/`admit?`.
- `src/main/core/store/{write-tx,store}.ts`, `src/main/db/worker-entry.ts`: cursor guard, `relink`, `reconcileArchiveChunk`.
- `src/main/core/engine/convert.ts`: re-exports the parsers; `createConverter(logs, converter)` maps converter failures.
- `src/main/core/engine/engine.ts`: admission, sub-commits, bounded flushes, chunked archival, session `admit`/`hasProvider`.
- `src/main/core/inference.ts`: async `gate()` with the foreground wait; `hasProvider()`.
- `src/main/core/boot.ts`: builds converter + admission + monitor; `backgroundLaneState` becomes a projection.
- `src/main/core/mcp/{sql-runner-spawn,registry,resources,server}.ts`, `src/main/core/child-priority.ts`.
- `src/main/workers/{index.ts,convert/convert-worker.ts,convert/outcome.ts,vision/vision-worker.ts,vision/rasterize.ts,audio/audio-worker.ts}`.
- `src/main/core/read-diagnostics.ts`, `src/main/main.ts`.

Task order: store-only prerequisites (1, 2), converter (§1: 3, 4, 5), admission (§2: 6, 7), store write units (8), engine integration (§3/§4: 9, 10, 11), workers (12), foreground sources (13), diagnostics (14), measurement (15).

---

### Task 1: `hostBudget.ingestSlots`

**Files:**
- Modify: `src/main/core/host-profile.ts:17-21` (HostBudget), `:44-55` (hostBudget), `:58-66` (describeHost)
- Test: `src/main/core/__tests__/host-profile.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `HostBudget.ingestSlots: 1 | 2` (Task 5 doubles the converter timeout on 1; Task 7 sizes admission with it).

- [ ] **Step 1: Write the failing tests**

Append to `src/main/core/__tests__/host-profile.test.ts`, and update the existing `toEqual` at line 20 to include `ingestSlots: 2` and the `describeHost` expected string at line 80 to end in ` backgroundThreads=4 ingestSlots=2`:

```ts
describe('ingestSlots', () => {
  it.each([
    ['strong Mac', mac(), 2],
    ['4 logical cores', mac({ cores: 4 }), 1],
    ['exactly 8 GiB', mac({ totalMemBytes: WEAK_MAX_MEM_BYTES }), 1],
    [
      '16-core Windows desktop (CPU accel would make it weak for enrichment)',
      mac({ platform: 'win32', arch: 'x64', cores: 16, totalMemBytes: 32 * GiB }),
      2,
    ],
  ])('%s → %d', (_name, facts, slots) => {
    expect(hostBudget(facts, 'cpu', {}).ingestSlots).toBe(slots);
  });

  it('ignores the onCpu term that makes every non-Mac weak for enrichment', () => {
    const win = mac({ platform: 'win32', cores: 16, totalMemBytes: 32 * GiB });
    const b = hostBudget(win, null, {});
    expect(b.weak).toBe(true);
    expect(b.ingestSlots).toBe(2);
  });

  it('KIA_HOST_WEAK overrides it both ways', () => {
    expect(hostBudget(mac(), 'metal', { KIA_HOST_WEAK: '1' }).ingestSlots).toBe(1);
    expect(
      hostBudget(mac({ cores: 2 }), 'metal', { KIA_HOST_WEAK: '0' }).ingestSlots,
    ).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/main/core/__tests__/host-profile.test.ts --runInBand`
Expected: FAIL (`ingestSlots` is undefined; the `toEqual` and describe-string assertions fail).

- [ ] **Step 3: Implement**

In `src/main/core/host-profile.ts` replace the `HostBudget` interface and `hostBudget`/`describeHost` bodies:

```ts
export interface HostBudget {
  weak: boolean;
  backgroundThreads: number;
  /** #147 admission cap: background units (ingest/convert/reconcile/redrive)
   *  that may run at once. Sized by cores and memory ONLY — the `onCpu` term
   *  that makes every non-Mac "weak" for enrichment must not cut a 16-core
   *  Windows desktop's sync throughput in half. */
  ingestSlots: 1 | 2;
}
```

```ts
export function hostBudget(
  f: HostFacts,
  accel: LlmAccel | null,
  env: NodeJS.ProcessEnv = process.env,
): HostBudget {
  const onCpu = accel === 'cpu' || (accel === null && f.platform !== 'darwin');
  const small =
    f.cores <= WEAK_MAX_CORES || f.totalMemBytes <= WEAK_MAX_MEM_BYTES;
  let weak = small || onCpu;
  let ingestSlots: 1 | 2 = small ? 1 : 2;
  if (env.KIA_HOST_WEAK === '1') {
    weak = true;
    ingestSlots = 1;
  } else if (env.KIA_HOST_WEAK === '0') {
    weak = false;
    ingestSlots = 2;
  }
  return {
    weak,
    backgroundThreads: Math.max(1, Math.floor(f.cores / 2)),
    ingestSlots,
  };
}
```

In `describeHost`, append ` ingestSlots=${b.ingestSlots}` to the returned string after `backgroundThreads=${b.backgroundThreads}`.

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/main/core/__tests__/host-profile.test.ts --runInBand`
Expected: PASS.

- [ ] **Step 5: Gates and commit**

```bash
cd ~/work/kcore-sync
npx eslint src/main/core/host-profile.ts src/main/core/__tests__/host-profile.test.ts
npx tsc --noEmit -p .
printf 'feat(host): ingestSlots for background admission (#147)\n\n1 slot on <=4 cores or <=8 GiB, else 2; ignores the onCpu term;\nKIA_HOST_WEAK overrides.\n' > $SCRATCH/msg-t1.txt
git add src/main/core/host-profile.ts src/main/core/__tests__/host-profile.test.ts
git commit -F $SCRATCH/msg-t1.txt -- src/main/core/host-profile.ts src/main/core/__tests__/host-profile.test.ts
```

---

### Task 2: Optional consumer cursor on commits (isolated contract)

This task is the whole cross-workstream surface. Keep it to exactly these hunks (see "Cross-workstream note" above).

**Files:**
- Modify: `src/shared/contracts.ts:250-258` (consumer variant of `CommitBatch`)
- Modify: `src/main/core/store/write-tx.ts:478-486` (the consumers upsert in `commitTx`)
- Test: `src/main/core/store/__tests__/consumer-cursor.test.ts` (new)

**Interfaces:**
- Consumes: nothing.
- Produces: `CommitBatch` consumer variant `{ consumer: string; cursor?: Seq; documents?; enrich?; clearAttempts? }` with the contract quoted in the cross-workstream note. Task 10 relies on it.

- [ ] **Step 1: Write the failing test**

Create `src/main/core/store/__tests__/consumer-cursor.test.ts`:

```ts
/**
 * Consumer-cursor contract (#147 §4): a consumer commit WITHOUT `cursor`
 * runs no statement against `consumers`; with it, today's upsert.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { openDb, type AppDb } from '../../../db/app-db';
import { openStore, type CoreStore } from '../store';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};

describe('consumer commit without a cursor', () => {
  let dir: string;
  let db: AppDb;
  let store: CoreStore;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-ccursor-'));
    db = await openDb(path.join(dir, 'kiagent.db'));
    store = openStore(db, deps);
  });
  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const consumerRows = (name: string): number =>
    Number(
      (
        db
          ._conn!.prepare(`SELECT COUNT(*) AS n FROM consumers WHERE name = ?`)
          .get(name) as { n: number }
      ).n,
    );

  it('leaves a stored cursor untouched', async () => {
    await store.commit({ consumer: 'worker:t:v1', cursor: 100 });
    const acc = await store.createAccount({ source: 'test', identifier: 'a' });
    await store.commit({
      account: acc.id,
      cursor: 1,
      documents: [
        {
          externalId: 'x',
          type: 'note',
          title: 'x',
          markdown: 'old',
          metadata: {},
          createdAt: null,
        },
      ],
    });
    const doc = await store.read.byExternalId(acc.id, 'x', 'note');
    await store.commit({
      consumer: 'worker:t:v1',
      enrich: [{ documentId: doc!.id, markdown: 'new body' }],
    });
    expect(await store.consumerCursor('worker:t:v1')).toBe(100);
    expect((await store.read.document(doc!.id))?.markdown).toBe('new body');
  });

  it('creates no consumers row for a consumer that never wrote a cursor', async () => {
    await store.commit({ consumer: 'worker:fresh:v1', clearAttempts: ['d1'] });
    expect(consumerRows('worker:fresh:v1')).toBe(0);
    expect(await store.consumerCursor('worker:fresh:v1')).toBe(0);
  });

  it('with a cursor still upserts it (today)', async () => {
    await store.commit({ consumer: 'worker:t:v1', cursor: 5 });
    await store.commit({ consumer: 'worker:t:v1', cursor: 7 });
    expect(await store.consumerCursor('worker:t:v1')).toBe(7);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/main/core/store/__tests__/consumer-cursor.test.ts --runInBand`
Expected: FAIL to compile (`cursor` is required on the consumer variant), or at runtime the second test sees a consumers row with `cursor` NULL.

- [ ] **Step 3: Implement**

`src/shared/contracts.ts`, consumer variant of `CommitBatch`:

```ts
  | {
      consumer: string;
      /** Omitted = leave `consumers.cursor` exactly as stored: the commit
       *  runs no statement against `consumers` at all. Only a worker's live
       *  tail (`engine.attach`) advances its own cursor; bounded mid-batch
       *  flushes and the deferred re-drive omit it (#147 §4). */
      cursor?: Seq;
      documents?: DocumentInput[];
      enrich?: EnrichInput[];
      /** Doc ids whose work_attempts rows (this consumer) are deleted in this
       *  same transaction — the commit that persists their `done` outcome. */
      clearAttempts?: string[];
    }
```

`src/main/core/store/write-tx.ts`, top of the `if ('consumer' in batch)` branch:

```ts
    if ('consumer' in batch) {
      // Consumer-cursor contract (#147 §4): no cursor ⇒ no statement against
      // `consumers`. A bounded mid-batch flush or a re-drive must never
      // rewrite (and so possibly rewind) a cursor the live tail advanced.
      if (batch.cursor !== undefined)
        conn
          .prepare(
            `INSERT INTO consumers(name, cursor) VALUES(?, ?)
         ON CONFLICT(name) DO UPDATE SET cursor = excluded.cursor`,
          )
          .run(batch.consumer, batch.cursor);
```

(The rest of the branch is unchanged.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/main/core/store/__tests__/consumer-cursor.test.ts --runInBand`
Expected: PASS. Then `npx tsc --noEmit -p .`. Expected: no errors (every existing caller still passes a cursor).

- [ ] **Step 5: Commit**

```bash
cd ~/work/kcore-sync
npx eslint src/shared/contracts.ts src/main/core/store/write-tx.ts src/main/core/store/__tests__/consumer-cursor.test.ts
printf 'feat(store): consumer cursor optional on commits (#147)\n\nNo cursor => commitTx runs no statement against consumers. Isolated\ncontract for the DB workstream merge; only attach advances a cursor.\n' > $SCRATCH/msg-t2.txt
git add src/main/core/store/__tests__/consumer-cursor.test.ts
git commit -F $SCRATCH/msg-t2.txt -- src/shared/contracts.ts src/main/core/store/write-tx.ts src/main/core/store/__tests__/consumer-cursor.test.ts
```

---

### Task 3: Extract the pure parsers and the rasteriser into `core/converter/parsers.ts`

Pure move, no behaviour change, plus `maxEdge` support in the rasteriser (unused until Task 12).

**Files:**
- Create: `src/main/core/converter/parsers.ts`
- Modify: `src/main/core/engine/convert.ts` (keeps `createConverter`, `stripBinary`; re-exports the moved names)
- Modify: `src/main/workers/vision/rasterize.ts` (types re-exported; `wasmRasterizer` delegates; `Rasterizer` gains `maxEdge?`/`signal?`)
- Test: `src/main/core/converter/__tests__/parsers.test.ts` (new); existing `convert-pdf`, `convert-email`, `rasterize`, `convert-worker`, `vision-worker` suites must stay green unchanged.

**Interfaces:**
- Consumes: nothing.
- Produces (from `src/main/core/converter/parsers.ts`):
  - `MAX_MARKDOWN_CHARS`, `capMarkdown(md)`, `type ConvertibleKind`, `convertibleKind(mime, filename?)`, `needsOcrMarker(pages)`, `parsePdfPages(bytes): Promise<string[]>`, `parseDetailed(bytes, mime, filename?): Promise<{ markdown: string | null; ocrPages?: number[] }>`, `parse(bytes, mime, filename?)`.
  - `interface RasterPage { page: number; png: Uint8Array }`, `interface RasterResult { pageCount: number; pages: RasterPage[] }`, `DEFAULT_SCALE = 2`, `rasterScale(size, maxEdge?): number`, `rasterizePdf(bytes, pages, maxEdge?): Promise<RasterResult>`.
  - `Rasterizer.pdfToPngs(bytes, opts: { pages: number[]; maxEdge?: number; signal?: AbortSignal })`.

- [ ] **Step 1: Write the failing test**

Create `src/main/core/converter/__tests__/parsers.test.ts`:

```ts
/** @jest-environment node */
import fs from 'fs';
import path from 'path';

import { DEFAULT_SCALE, rasterScale } from '../parsers';

it('parsers.ts imports nothing from electron, the store, the engine or the log sink', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'parsers.ts'), 'utf8');
  const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  for (const spec of imports)
    expect(spec).not.toMatch(/electron|\/store\/|\/logs|engine\/engine/);
});

describe('rasterScale', () => {
  const letter = { originalWidth: 612, originalHeight: 792 };
  it('without maxEdge renders at today’s 2× (OCR reads full-size pages)', () => {
    expect(rasterScale(letter)).toBe(DEFAULT_SCALE);
  });
  it('with maxEdge picks the scale whose longest edge is maxEdge', () => {
    expect(rasterScale(letter, 896)).toBeCloseTo(896 / 792, 6);
  });
  it('never upscales past 2× (the old path only ever shrank)', () => {
    expect(rasterScale({ originalWidth: 100, originalHeight: 120 }, 896)).toBe(
      DEFAULT_SCALE,
    );
  });
  it('a degenerate page size falls back to 2×', () => {
    expect(rasterScale({ originalWidth: 0, originalHeight: 0 }, 896)).toBe(
      DEFAULT_SCALE,
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/main/core/converter/__tests__/parsers.test.ts --runInBand`
Expected: FAIL (`Cannot find module '../parsers'`).

- [ ] **Step 3: Create `src/main/core/converter/parsers.ts`**

Header and imports:

```ts
/**
 * The converter's pure half (#136): bytes in, markdown / page text / PNG
 * pages out. Runs inside the `kia-converter` child (converter/worker.ts) and,
 * under KIA_CONVERTER_INLINE=1 or in tests, in-process. MUST stay free of
 * electron, store, engine and log-sink imports — the child bundles only this.
 */
import { PNG } from 'pngjs';

import { HAS_TEXT_CHARS } from '@main/workers/convert/outcome';

import { guardCfbReader } from '../engine/msg-guard';
import { assessPage, QUALITY_VERSION } from '../engine/text-quality';
```

Then move **verbatim** from `src/main/core/engine/convert.ts` (cut, do not copy): `MAX_MARKDOWN_CHARS` (with its doc comment), `capMarkdown`, `ConvertibleKind`, `convertibleKind`, `parsePdfPages`, `needsOcrMarker`, `parseDetailed`, `parse`, `parseOther`, `htmlToMarkdown`, `csvToMarkdown`, `MBOX_MAX_MESSAGES`, `MailParts`, `renderMail`, `msgToMarkdown`, `emailToMarkdown`. Keep the `QUALITY_VERSION` import only if `needsOcrMarker` uses it (it does).

Then move from `src/main/workers/vision/rasterize.ts` (cut): `RasterPage`, `RasterResult` (export both), `DEFAULT_SCALE` (export it), `bgraToRgba`, `encodePng`. Add:

```ts
/** Render scale for one page. Without `maxEdge`: today's DEFAULT_SCALE — OCR
 *  deliberately reads full-size pages. With it (a raster that feeds only the
 *  VLM): the scale whose longest edge is `maxEdge`, never above DEFAULT_SCALE,
 *  because the old path rendered at 2× and then only ever shrank. */
export function rasterScale(
  size: { originalWidth: number; originalHeight: number },
  maxEdge?: number,
): number {
  if (maxEdge === undefined) return DEFAULT_SCALE;
  const longest = Math.max(size.originalWidth, size.originalHeight);
  if (!(longest > 0)) return DEFAULT_SCALE;
  return Math.min(DEFAULT_SCALE, maxEdge / longest);
}

/** pdfium (WASM) → PNG pages. The body of the old `wasmRasterizer`, moved
 *  verbatim; `maxEdge` only changes the scale passed to `render`. Requested
 *  1-based pages are deduped, sorted, and those outside 1..pageCount
 *  silently skipped; `pageCount` is the document's TOTAL, which windowed OCR
 *  needs to continue past its first window. */
export async function rasterizePdf(
  bytes: Uint8Array,
  pages: number[],
  maxEdge?: number,
): Promise<RasterResult> {
  // @hyzyla/pdfium is ESM-only; this module compiles to CommonJS, so it must
  // be pulled in via dynamic import rather than a static (require-producing) one.
  const { PDFiumLibrary } = await import('@hyzyla/pdfium');
  const library = await PDFiumLibrary.init();
  try {
    const doc = await library.loadDocument(bytes);
    try {
      const pageCount = doc.getPageCount();
      const wanted = [...new Set(pages)]
        .filter((n) => n >= 1 && n <= pageCount)
        .sort((a, b) => a - b);
      const out: RasterPage[] = [];

      for (const n of wanted) {
        const page = doc.getPage(n - 1);
        // eslint-disable-next-line no-await-in-loop
        const img = await page.render({
          scale:
            maxEdge === undefined
              ? DEFAULT_SCALE
              : rasterScale(page.getOriginalSize(), maxEdge),
          render: 'bitmap',
        });
        const buf = encodePng(img.data, img.width, img.height);
        out.push({ page: n, png: new Uint8Array(buf) });
      }

      return { pageCount, pages: out };
    } finally {
      doc.destroy();
    }
  } finally {
    library.destroy();
  }
}
```

(`getOriginalSize()` is only called when `maxEdge` is set, so `rasterize.test.ts`'s pdfium mock, which has no `getOriginalSize`, keeps working.)

- [ ] **Step 4: Rewrite `src/main/core/engine/convert.ts` around the move**

The file keeps only the commit-path stage and re-exports, so every existing import (`@main/core/engine/convert`) still resolves:

```ts
import type { DocumentInput } from '@shared/contracts';

import {
  capMarkdown,
  convertibleKind,
  needsOcrMarker,
  parseDetailed,
} from '../converter/parsers';

import type { LogSink } from './engine';
import { QUALITY_VERSION } from './text-quality';

export {
  MAX_MARKDOWN_CHARS,
  capMarkdown,
  convertibleKind,
  needsOcrMarker,
  parse,
  parseDetailed,
  parsePdfPages,
  type ConvertibleKind,
} from '../converter/parsers';
```

followed by the existing `createConverter` and `stripBinary` bodies, unchanged (the doc comment above `createConverter` stays).

- [ ] **Step 5: Rewrite the moved parts of `src/main/workers/vision/rasterize.ts`**

Remove `import { PNG } from 'pngjs';`, `RasterPage`, `RasterResult`, `DEFAULT_SCALE`, `bgraToRgba`, `encodePng`. Add at the top:

```ts
import {
  rasterizePdf,
  type RasterPage,
  type RasterResult,
} from '@main/core/converter/parsers';

export type { RasterPage, RasterResult };
```

Change the `Rasterizer` interface and `wasmRasterizer`:

```ts
/** Renders the requested 1-based pages (deduped, ascending); page numbers
 *  outside 1..pageCount are silently skipped. `maxEdge` (a VLM-only raster)
 *  renders straight at that longest edge; omitted = full-size 2× pages. */
export interface Rasterizer {
  pdfToPngs(
    bytes: Uint8Array,
    opts: { pages: number[]; maxEdge?: number; signal?: AbortSignal },
  ): Promise<RasterResult>;
}

export function wasmRasterizer(): Rasterizer {
  return {
    pdfToPngs: (bytes, { pages, maxEdge }) =>
      rasterizePdf(bytes, pages, maxEdge),
  };
}
```

`VisionHelper`, `HelperTimeoutError` and `pickRasterizer` stay as they are in this task.

- [ ] **Step 6: Run the new and the existing suites**

```bash
cd ~/work/kcore-sync
for f in src/main/core/converter/__tests__/parsers.test.ts \
  src/main/core/engine/__tests__/convert-pdf.test.ts \
  src/main/core/engine/__tests__/convert-email.test.ts \
  src/main/workers/vision/__tests__/rasterize.test.ts \
  src/main/workers/convert/__tests__/convert-worker.test.ts \
  src/main/workers/vision/__tests__/vision-worker.test.ts; do
  npx jest "$f" --runInBand || break
done
```

Expected: all PASS with no edits to the existing suites.

- [ ] **Step 7: Gates and commit**

```bash
npx eslint src/main/core/converter src/main/core/engine/convert.ts src/main/workers/vision/rasterize.ts
npx tsc --noEmit -p .
printf 'refactor(converter): move pure parsers + rasteriser to core/converter/parsers (#136)\n\nVerbatim move; convert.ts re-exports. rasterizePdf gains optional maxEdge\n(rasterScale, never above 2x).\n' > $SCRATCH/msg-t3.txt
git add src/main/core/converter
git commit -F $SCRATCH/msg-t3.txt -- src/main/core/converter src/main/core/engine/convert.ts src/main/workers/vision/rasterize.ts
```

---

### Task 4: Converter child entry, supervisor and inline facade

**Files:**
- Create: `src/main/core/abort.ts`, `src/main/core/converter/protocol.ts`, `src/main/core/converter/converter.ts`, `src/main/core/converter/runner.ts`
- Modify: `src/main/converter/worker.ts` (stub → entry)
- Modify: `src/main/core/mcp/sql-runner-spawn.ts` (`forkRunnerChild` gains `serialization`; `utilityRunnerChild` gains `{ serviceName, onSpawn }`)
- Modify: `src/main/core/child-priority.ts:107-118` (`demoteHost` gains a `name` param)
- Create tests: `src/main/core/converter/__tests__/runner.test.ts`, `src/main/core/converter/__tests__/runner-process.test.ts`, `src/main/core/converter/__tests__/fixtures/spinning-converter.cjs`

**Interfaces:**
- Consumes: Task 3's `parsers.ts` exports; `RunnerChild` from `src/main/core/mcp/sql-runner.ts`.
- Produces:
  - `abortError(): Error` (name `'AbortError'`), `isAbortError(e: unknown): boolean` in `src/main/core/abort.ts`.
  - `src/main/core/converter/converter.ts`:
    ```ts
    export interface ParseResult { markdown: string | null; ocrPages?: number[] }
    export interface ConverterStats {
      mode: 'child' | 'inline'; state: string; pid: number | null;
      jobs: number; crashes: number; timeouts: number; cancels: number;
      unavailable: number; queued: number; queuedBytes: number; p95Ms: number | null;
    }
    export interface Converter {
      parseDetailed(bytes: Uint8Array, mime: string, filename?: string, signal?: AbortSignal): Promise<ParseResult>;
      parsePdfPages(bytes: Uint8Array, signal?: AbortSignal): Promise<string[]>;
      rasterizePdf(bytes: Uint8Array, pages: number[], opts?: { maxEdge?: number; signal?: AbortSignal }): Promise<RasterResult>;
      stats(): ConverterStats;
      stop(): Promise<void>;
    }
    export class ConverterCrashedError extends Error {}
    export class ConverterTimeoutError extends Error {}
    export class ConverterUnavailableError extends Error {}
    export function createInlineConverter(): Converter;
    ```
  - `src/main/core/converter/runner.ts`: `CONVERTER_TIMEOUT_MS = 120_000`, `CONVERTER_IDLE_MS = 300_000`, `MAX_QUEUED_BYTES = 128 * 1024 * 1024`, `SPAWN_BACKOFF_MS = 30_000`, `createConverterRunner(opts: ConverterRunnerOptions): Converter`.
  - `forkRunnerChild(modulePath, { env?, execArgv?, cwd?, serialization?: 'json' | 'advanced' })`.
  - `utilityRunnerChild(modulePath, env, onOutput?, opts?: { serviceName?: string; onSpawn?: (pid: number | undefined) => void })`.
  - `demoteHost(pid, deps = {}, name = 'extension-host')`.

Failure attribution (spec §1, deliberately unlike the SQL runner's `failAll`):

| Event | Active job | Queued jobs |
|---|---|---|
| child exits while a job is active | `ConverterCrashedError` | stay queued; next job respawns |
| job passes `timeoutMs` | `ConverterTimeoutError`; SIGTERM, SIGKILL after `termGraceMs` | stay queued; respawn after exit |
| spawn throws / child exits before `ready` / start timeout | (none active) | all rejected `ConverterUnavailableError`; spawning paused `SPAWN_BACKOFF_MS` (submits reject at once) |
| caller aborts a queued job / a space wait | `AbortError` | others untouched |
| caller aborts the active job | `AbortError`; child killed | stay queued; respawn |
| child replies `ok:false` (the parser threw) | `Error` with the child's `name` + `message` | untouched |

- [ ] **Step 1: Shared pieces (no test of their own)**

`src/main/core/abort.ts`:

```ts
/** The ONE AbortError shape admission and the converter reject with. Checked
 *  by name, never instanceof (it crosses no boundary today, but DOMException
 *  and Error both satisfy the name check). */
export function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

export function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}
```

`src/main/core/converter/protocol.ts`:

```ts
/** Parent ↔ `kia-converter` child messages (#136). Bytes travel as a
 *  structured-clone copy (utilityProcess postMessage; child_process.fork
 *  with serialization 'advanced' in tests) — never JSON. */
export type ConverterJob =
  | { op: 'parseDetailed'; bytes: Uint8Array; mime: string; filename?: string }
  | { op: 'parsePdfPages'; bytes: Uint8Array }
  | { op: 'rasterizePdf'; bytes: Uint8Array; pages: number[]; maxEdge?: number };

export type ConverterRequest = ConverterJob & { id: number };

export type ConverterReply =
  | { t: 'ready' }
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; name: string; message: string };
```

`src/main/core/child-priority.ts`, `demoteHost`:

```ts
/** Extension hosts and the converter are Electron utility processes we don't
 *  spawn through `launch`: demote on their 'spawn' event, to BELOW_NORMAL
 *  (never LOW — Windows IDLE-class children starve under load). */
export function demoteHost(
  pid: number | undefined,
  deps: PriorityDeps = {},
  name = 'extension-host',
): void {
  if (pid === undefined) return;
  demoteAndNote(
    name,
    'below-normal',
    pid,
    os.constants.priority.PRIORITY_BELOW_NORMAL,
    deps,
  );
}
```

`src/main/core/mcp/sql-runner-spawn.ts`: add `serialization?: 'json' | 'advanced';` to `forkRunnerChild`'s opts type and pass `serialization: opts.serialization ?? 'json'` to `fork(...)`. Change `utilityRunnerChild`:

```ts
export function utilityRunnerChild(
  modulePath: string,
  env: Record<string, string>,
  onOutput?: (line: string) => void,
  opts: {
    serviceName?: string;
    /** utilityProcess `pid` is only valid after 'spawn' (transport.ts:129). */
    onSpawn?: (pid: number | undefined) => void;
  } = {},
): RunnerChild {
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  const { utilityProcess } = require('electron') as typeof import('electron');
  const child = utilityProcess.fork(modulePath, [], {
    serviceName: opts.serviceName ?? 'kia-sql-runner',
    stdio: 'pipe',
    env: { ...process.env, ...env } as Record<string, string>,
  });
  if (opts.onSpawn) child.once('spawn', () => opts.onSpawn!(child.pid));
```

(the rest of the function is unchanged).

- [ ] **Step 2: Write the failing supervisor unit tests**

Create `src/main/core/converter/__tests__/runner.test.ts`:

```ts
/** @jest-environment node */
import type { RunnerChild } from '../../mcp/sql-runner';
import {
  ConverterCrashedError,
  ConverterTimeoutError,
  ConverterUnavailableError,
} from '../converter';
import { createConverterRunner } from '../runner';

class FakeChild implements RunnerChild {
  readonly pid = 4242;
  sent: Array<{ id: number; op: string; bytes: Uint8Array }> = [];
  killed: string[] = [];
  private msg?: (m: unknown) => void;
  private exit?: (code: number | null) => void;
  /** Signals this fake dies on. [] = ignores every signal. */
  dieOn: string[] = ['SIGTERM', 'SIGKILL'];
  send(m: unknown) {
    this.sent.push(m as never);
  }
  onMessage(cb: (m: unknown) => void) {
    this.msg = cb;
  }
  onExit(cb: (code: number | null) => void) {
    this.exit = cb;
  }
  kill(sig: 'SIGTERM' | 'SIGKILL') {
    this.killed.push(sig);
    if (this.dieOn.includes(sig)) queueMicrotask(() => this.exit?.(null));
  }
  ready() {
    this.msg?.({ t: 'ready' });
  }
  reply(id: number, result: unknown) {
    this.msg?.({ id, ok: true, result });
  }
  fail(id: number, name: string, message: string) {
    this.msg?.({ id, ok: false, name, message });
  }
  crash(code = 1) {
    this.exit?.(code);
  }
}

const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 5));
  }
};
const settle = <T>(p: Promise<T>) =>
  p.then(
    (v) => ({ ok: true as const, v }),
    (e: Error) => ({ ok: false as const, e }),
  );
const B = (n: number) => new Uint8Array(n);

function setup(over: Partial<Parameters<typeof createConverterRunner>[0]> = {}) {
  const children: FakeChild[] = [];
  const runner = createConverterRunner({
    spawn: () => {
      const c = new FakeChild();
      children.push(c);
      queueMicrotask(() => c.ready());
      return c;
    },
    timeoutMs: 200,
    idleMs: 60_000,
    termGraceMs: 20,
    killGraceMs: 50,
    ...over,
  });
  return { runner, children };
}

afterEach(() => jest.restoreAllMocks());

it('runs one job at a time and resolves each result', async () => {
  const { runner, children } = setup();
  const a = runner.parsePdfPages(B(1));
  const b = runner.parsePdfPages(B(1));
  await until(() => children[0]?.sent.length === 1);
  expect(children[0].sent).toHaveLength(1); // b waits for a
  children[0].reply(children[0].sent[0].id, ['p1']);
  await expect(a).resolves.toEqual(['p1']);
  await until(() => children[0].sent.length === 2);
  children[0].reply(children[0].sent[1].id, ['p2']);
  await expect(b).resolves.toEqual(['p2']);
  expect(runner.stats().jobs).toBe(2);
  await runner.stop();
});

it('a crash fails only the active job; a queued job succeeds on the respawned child', async () => {
  const { runner, children } = setup();
  const active = settle(runner.parsePdfPages(B(1)));
  const queued = runner.parsePdfPages(B(1));
  await until(() => children[0]?.sent.length === 1);
  children[0].crash(139);
  const r = await active;
  expect(r.ok).toBe(false);
  expect((r as { e: Error }).e).toBeInstanceOf(ConverterCrashedError);
  await until(() => children[1]?.sent.length === 1);
  children[1].reply(children[1].sent[0].id, ['ok']);
  await expect(queued).resolves.toEqual(['ok']);
  expect(runner.stats().crashes).toBe(1);
  await runner.stop();
});

it('a timeout rejects ConverterTimeoutError, escalates SIGTERM → SIGKILL, respawns for the next job', async () => {
  const { runner, children } = setup();
  const slow = settle(runner.parsePdfPages(B(1)));
  const next = runner.parsePdfPages(B(1));
  await until(() => children[0]?.sent.length === 1);
  children[0].dieOn = ['SIGKILL']; // ignores SIGTERM like a busy parser
  const r = await slow;
  expect((r as { e: Error }).e).toBeInstanceOf(ConverterTimeoutError);
  await until(() => children[0].killed.join() === 'SIGTERM,SIGKILL');
  await until(() => children[1]?.sent.length === 1);
  children[1].reply(children[1].sent[0].id, ['fine']);
  await expect(next).resolves.toEqual(['fine']);
  expect(runner.stats().timeouts).toBe(1);
  await runner.stop();
});

it('a spawn failure is transient: queued jobs reject ConverterUnavailableError and spawning backs off', async () => {
  let spawns = 0;
  const runner = createConverterRunner({
    spawn: () => {
      spawns += 1;
      throw new Error('ENOENT worker.js');
    },
    timeoutMs: 200,
    spawnBackoffMs: 60_000,
  });
  await expect(runner.parsePdfPages(B(1))).rejects.toBeInstanceOf(
    ConverterUnavailableError,
  );
  // Inside the backoff: rejected at once, no respawn per document.
  await expect(runner.parsePdfPages(B(1))).rejects.toBeInstanceOf(
    ConverterUnavailableError,
  );
  expect(spawns).toBe(1);
  await runner.stop();
});

it('a child that exits before ready is unavailable, not a crash', async () => {
  const runner = createConverterRunner({
    spawn: () => {
      const c = new FakeChild();
      queueMicrotask(() => c.crash(1));
      return c;
    },
    timeoutMs: 200,
  });
  await expect(runner.parsePdfPages(B(1))).rejects.toBeInstanceOf(
    ConverterUnavailableError,
  );
  expect(runner.stats().crashes).toBe(0);
  await runner.stop();
});

it('abort: a queued job is removed, an active one kills the child; both reject AbortError, neither is a crash', async () => {
  const { runner, children } = setup();
  const acA = new AbortController();
  const acB = new AbortController();
  const a = settle(runner.parsePdfPages(B(1), acA.signal));
  const b = settle(runner.parsePdfPages(B(1), acB.signal));
  await until(() => children[0]?.sent.length === 1);
  acB.abort(); // queued
  expect(((await b) as { e: Error }).e.name).toBe('AbortError');
  acA.abort(); // active
  expect(((await a) as { e: Error }).e.name).toBe('AbortError');
  await until(() => children[0].killed.includes('SIGTERM'));
  expect(runner.stats()).toMatchObject({ cancels: 2, crashes: 0 });
  await runner.stop();
});

it('the queue blocks at the byte bound; an oversize job is admitted into an empty queue', async () => {
  const { runner, children } = setup({ maxQueuedBytes: 10 });
  const big = runner.parsePdfPages(B(25)); // > bound, queue empty → admitted
  const first = runner.parsePdfPages(B(4));
  let secondStarted = false;
  const second = runner.parsePdfPages(B(4)).then((v) => {
    secondStarted = true;
    return v;
  });
  await until(() => children[0]?.sent.length === 1);
  expect(runner.stats().queuedBytes).toBe(25); // first/second wait for space
  children[0].reply(children[0].sent[0].id, ['big']);
  await big;
  await until(() => children[0].sent.length === 2);
  children[0].reply(children[0].sent[1].id, ['1']);
  await first;
  await until(() => children[0].sent.length === 3);
  children[0].reply(children[0].sent[2].id, ['2']);
  await second;
  expect(secondStarted).toBe(true);
  await runner.stop();
});

it('capacity is reserved atomically: simultaneous submits and several waiters never overshoot the bound', async () => {
  const { runner, children } = setup({ maxQueuedBytes: 10 });
  // Three 4-byte jobs in ONE tick: only two fit (8 ≤ 10), the third waits.
  const a = runner.parsePdfPages(B(4));
  const b = runner.parsePdfPages(B(4));
  const c = runner.parsePdfPages(B(4));
  const d = runner.parsePdfPages(B(4));
  await until(() => children[0]?.sent.length === 1);
  expect(runner.stats().queuedBytes).toBe(8);
  // a finishes: exactly ONE waiter (c) is granted, d keeps waiting.
  children[0].reply(children[0].sent[0].id, []);
  await a;
  await until(() => children[0].sent.length === 2);
  expect(runner.stats().queuedBytes).toBe(8);
  expect(runner.stats().queued).toBe(1); // c queued, b active, d waiting
  for (let i = 1; i < 4; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await until(() => children[0].sent.length === i + 1);
    children[0].reply(children[0].sent[i].id, []);
    expect(runner.stats().queuedBytes).toBeLessThanOrEqual(10);
  }
  await Promise.all([b, c, d]);
  expect(runner.stats().queuedBytes).toBe(0);
  await runner.stop();
});

it('an abort between the capacity grant and the enqueue returns the reservation', async () => {
  const { runner, children } = setup({ maxQueuedBytes: 10 });
  const hold = runner.parsePdfPages(B(8));
  const ac = new AbortController();
  const waiting = settle(runner.parsePdfPages(B(8), ac.signal));
  await until(() => children[0]?.sent.length === 1);
  // The reply settles `hold` and grants the waiter synchronously; the abort
  // lands before submit()'s continuation runs.
  children[0].reply(children[0].sent[0].id, []);
  ac.abort();
  expect(((await waiting) as { e: Error }).e.name).toBe('AbortError');
  await hold;
  expect(runner.stats().queuedBytes).toBe(0);
  expect(children[0].sent).toHaveLength(1);
  await runner.stop();
});

it('a stop between the capacity grant and the enqueue rejects unavailable and leaves nothing queued', async () => {
  const { runner, children } = setup({ maxQueuedBytes: 10 });
  const hold = settle(runner.parsePdfPages(B(8)));
  const waiting = settle(runner.parsePdfPages(B(8)));
  await until(() => children[0]?.sent.length === 1);
  children[0].reply(children[0].sent[0].id, []);
  const stopped = runner.stop(); // same tick as the grant
  expect(((await waiting) as { e: Error }).e).toBeInstanceOf(ConverterUnavailableError);
  await hold;
  await stopped;
  expect(runner.stats()).toMatchObject({ queuedBytes: 0, queued: 0 });
  expect(children[0].sent).toHaveLength(1);
});

it('abort while waiting for queue space rejects AbortError', async () => {
  const { runner, children } = setup({ maxQueuedBytes: 10 });
  const hold = runner.parsePdfPages(B(8));
  const ac = new AbortController();
  const waiting = settle(runner.parsePdfPages(B(8), ac.signal));
  await until(() => children[0]?.sent.length === 1);
  ac.abort();
  expect(((await waiting) as { e: Error }).e.name).toBe('AbortError');
  children[0].reply(children[0].sent[0].id, []);
  await hold;
  await runner.stop();
});

it('exits after idleMs with nothing to do', async () => {
  const { runner, children } = setup({ idleMs: 30 });
  const p = runner.parsePdfPages(B(1));
  await until(() => children[0]?.sent.length === 1);
  children[0].reply(children[0].sent[0].id, []);
  await p;
  await until(() => children[0].killed.includes('SIGTERM'), 1000);
  expect(runner.stats().state).toBe('none');
  await runner.stop();
});

it('a parser error rejects with the child’s name and message; the child stays up', async () => {
  const { runner, children } = setup();
  const p = runner.parseDetailed(B(1), 'application/pdf', 'x.pdf');
  await until(() => children[0]?.sent.length === 1);
  children[0].fail(children[0].sent[0].id, 'TypeError', 'bad XRef entry');
  await expect(p).rejects.toThrow('bad XRef entry');
  await expect(p).rejects.toHaveProperty('name', 'TypeError');
  expect(children[0].killed).toEqual([]);
  await runner.stop();
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx jest src/main/core/converter/__tests__/runner.test.ts --runInBand`
Expected: FAIL (`Cannot find module '../converter'` / `'../runner'`).

- [ ] **Step 4: Implement `src/main/core/converter/converter.ts`**

```ts
/**
 * The converter boundary (#136): what the commit path, the convert worker
 * and the vision worker call. `createConverterRunner` (runner.ts) runs it in
 * the crash-isolated `kia-converter` child; `createInlineConverter` runs the
 * same parsers in-process (KIA_CONVERTER_INLINE=1, tests).
 */
import { abortError } from '../abort';
import {
  capMarkdown,
  parseDetailed,
  parsePdfPages,
  rasterizePdf,
  type RasterResult,
} from './parsers';

export interface ParseResult {
  markdown: string | null;
  ocrPages?: number[];
}

export interface ConverterStats {
  mode: 'child' | 'inline';
  state: string;
  pid: number | null;
  jobs: number;
  crashes: number;
  timeouts: number;
  cancels: number;
  unavailable: number;
  queued: number;
  queuedBytes: number;
  p95Ms: number | null;
}

export interface Converter {
  /** Markdown is capped at MAX_MARKDOWN_CHARS before it is returned. */
  parseDetailed(
    bytes: Uint8Array,
    mime: string,
    filename?: string,
    signal?: AbortSignal,
  ): Promise<ParseResult>;
  parsePdfPages(bytes: Uint8Array, signal?: AbortSignal): Promise<string[]>;
  rasterizePdf(
    bytes: Uint8Array,
    pages: number[],
    opts?: { maxEdge?: number; signal?: AbortSignal },
  ): Promise<RasterResult>;
  stats(): ConverterStats;
  stop(): Promise<void>;
}

/** The child died while THIS job was running. Attributed to the active job only. */
export class ConverterCrashedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConverterCrashedError';
  }
}

/** THIS job ran past the wall-clock limit; the child was killed. */
export class ConverterTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConverterTimeoutError';
  }
}

/** Infrastructure, not the document: the child could not start (or the
 *  converter is stopped). Transient — callers try later, never record a
 *  permanent failure. */
export class ConverterUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConverterUnavailableError';
  }
}

const RECENT = 64;

/** Nearest-rank p95 over the last RECENT job durations. */
export function p95(durations: number[]): number | null {
  if (durations.length === 0) return null;
  const s = [...durations].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)];
}

export function pushRecent(durations: number[], ms: number): void {
  durations.push(ms);
  if (durations.length > RECENT) durations.shift();
}

export function createInlineConverter(): Converter {
  let jobs = 0;
  let cancels = 0;
  const recent: number[] = [];
  const run = async <T>(
    signal: AbortSignal | undefined,
    fn: () => Promise<T>,
  ): Promise<T> => {
    if (signal?.aborted) {
      cancels += 1;
      throw abortError();
    }
    const t0 = Date.now();
    try {
      return await fn();
    } finally {
      jobs += 1;
      pushRecent(recent, Date.now() - t0);
    }
  };
  return {
    parseDetailed: (bytes, mime, filename, signal) =>
      run(signal, async () => {
        const r = await parseDetailed(bytes, mime, filename);
        return r.markdown === null
          ? r
          : { ...r, markdown: capMarkdown(r.markdown).markdown };
      }),
    parsePdfPages: (bytes, signal) => run(signal, () => parsePdfPages(bytes)),
    rasterizePdf: (bytes, pages, opts) =>
      run(opts?.signal, () => rasterizePdf(bytes, pages, opts?.maxEdge)),
    stats: () => ({
      mode: 'inline',
      state: 'inline',
      pid: null,
      jobs,
      crashes: 0,
      timeouts: 0,
      cancels,
      unavailable: 0,
      queued: 0,
      queuedBytes: 0,
      p95Ms: p95(recent),
    }),
    stop: async () => {},
  };
}
```

- [ ] **Step 5: Implement `src/main/core/converter/runner.ts`**

```ts
/**
 * Supervisor of the ONE `kia-converter` child (#136, spec §1), modelled on
 * the #146 SQL runner (mcp/sql-runner.ts) but with per-job attribution: a
 * crash or timeout fails only the ACTIVE job; queued jobs wait for the
 * replacement child. One job runs at a time; the queue is bounded by input
 * bytes. Spawn/infrastructure failures are transient
 * (ConverterUnavailableError) and pause spawning for SPAWN_BACKOFF_MS so a
 * missing or blocked bundle never respawns a process per document.
 */
import { abortError } from '../abort';
import type { RunnerChild } from '../mcp/sql-runner';
import {
  ConverterCrashedError,
  ConverterTimeoutError,
  ConverterUnavailableError,
  p95,
  pushRecent,
  type Converter,
  type ParseResult,
} from './converter';
import type { RasterResult } from './parsers';
import type { ConverterJob, ConverterReply } from './protocol';

export const CONVERTER_TIMEOUT_MS = 120_000;
export const CONVERTER_IDLE_MS = 300_000;
export const MAX_QUEUED_BYTES = 128 * 1024 * 1024;
export const SPAWN_BACKOFF_MS = 30_000;

export interface ConverterRunnerOptions {
  spawn(): RunnerChild;
  /** Wall clock per job (bootCore doubles it on 1-slot hosts). */
  timeoutMs?: number;
  idleMs?: number;
  maxQueuedBytes?: number;
  /** Child must say ready within this (default 20 s). */
  startTimeoutMs?: number;
  /** SIGTERM → SIGKILL grace (default 2 s). */
  termGraceMs?: number;
  /** No exit this long after SIGKILL → drop the child and move on (default 5 s). */
  killGraceMs?: number;
  spawnBackoffMs?: number;
  log?(level: 'info' | 'warn' | 'error', msg: string): void;
  now?(): number;
}

type State = 'none' | 'starting' | 'ready' | 'stopping';

interface Job {
  job: ConverterJob;
  bytes: number;
  resolve(v: unknown): void;
  reject(e: Error): void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface SpaceWaiter {
  bytes: number;
  resolve(): void;
  reject(e: Error): void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export function createConverterRunner(opts: ConverterRunnerOptions): Converter {
  const timeoutMs = opts.timeoutMs ?? CONVERTER_TIMEOUT_MS;
  const idleMs = opts.idleMs ?? CONVERTER_IDLE_MS;
  const maxQueuedBytes = opts.maxQueuedBytes ?? MAX_QUEUED_BYTES;
  const startTimeoutMs = opts.startTimeoutMs ?? 20_000;
  const termGraceMs = opts.termGraceMs ?? 2_000;
  const killGraceMs = opts.killGraceMs ?? 5_000;
  const spawnBackoffMs = opts.spawnBackoffMs ?? SPAWN_BACKOFF_MS;
  const log = opts.log ?? (() => {});
  const now = opts.now ?? Date.now;

  let state: State = 'none';
  let child: RunnerChild | null = null;
  let closed = false;
  let nextId = 1;
  let unavailableUntil = 0;
  const queue: Job[] = [];
  const spaceWaiters: SpaceWaiter[] = [];
  let queuedBytes = 0; // queued + active
  let active: {
    id: number;
    job: Job;
    startedAt: number;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let startTimer: ReturnType<typeof setTimeout> | undefined;
  let termTimer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let exitWaiters: Array<() => void> = [];
  const stats = { jobs: 0, crashes: 0, timeouts: 0, cancels: 0, unavailable: 0 };
  const recent: number[] = [];

  const clearIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
  };
  const clearStop = () => {
    for (const t of [startTimer, termTimer, killTimer]) if (t) clearTimeout(t);
    startTimer = undefined;
    termTimer = undefined;
    killTimer = undefined;
  };
  const flushExitWaiters = () => {
    const w = exitWaiters;
    exitWaiters = [];
    for (const f of w) f();
  };

  const fits = (bytes: number) =>
    queuedBytes === 0 || queuedBytes + bytes <= maxQueuedBytes;

  /** Grants capacity to waiters in FIFO order. The bytes are reserved HERE,
   *  synchronously with the grant, so a later grant in the same loop (or a
   *  concurrent submit) never sees space a woken waiter is about to use. */
  function wakeSpaceWaiters(): void {
    while (spaceWaiters.length > 0 && fits(spaceWaiters[0].bytes)) {
      const w = spaceWaiters.shift()!;
      if (w.onAbort) w.signal?.removeEventListener('abort', w.onAbort);
      queuedBytes += w.bytes;
      w.resolve();
    }
  }

  /** Give back a reservation that never became a queued job. */
  function unreserve(bytes: number): void {
    queuedBytes -= bytes;
    wakeSpaceWaiters();
  }

  /** A job leaves the books (finished, failed, cancelled). */
  function settle(j: Job): void {
    if (j.onAbort) j.signal?.removeEventListener('abort', j.onAbort);
    queuedBytes -= j.bytes;
    wakeSpaceWaiters();
  }

  function failQueued(err: Error): void {
    for (const j of queue.splice(0)) {
      settle(j);
      j.reject(err);
    }
  }

  function armIdle(): void {
    clearIdle();
    idleTimer = setTimeout(() => {
      if (state === 'ready' && !active && queue.length === 0) beginStop();
    }, idleMs);
    idleTimer.unref?.();
  }

  function beginStop(): void {
    if (!child || state === 'stopping') return;
    state = 'stopping';
    clearIdle();
    if (startTimer) clearTimeout(startTimer);
    startTimer = undefined;
    const c = child;
    c.kill('SIGTERM');
    termTimer = setTimeout(() => {
      c.kill('SIGKILL');
      killTimer = setTimeout(() => {
        if (child !== c) return;
        log('error', `[converter] child pid=${c.pid} did not exit after SIGKILL — abandoning it`);
        child = null;
        state = 'none';
        flushExitWaiters();
        pump();
      }, killGraceMs);
    }, termGraceMs);
  }

  function unavailable(reason: string): void {
    stats.unavailable += 1;
    unavailableUntil = now() + spawnBackoffMs;
    log('error', `[converter] unavailable: ${reason}`);
    failQueued(new ConverterUnavailableError(`converter unavailable: ${reason}`));
  }

  function onChildExit(c: RunnerChild, code: number | null): void {
    if (c !== child) return;
    clearStop();
    const was = state;
    child = null;
    state = 'none';
    if (active) {
      const { job, timer } = active;
      clearTimeout(timer);
      active = null;
      stats.crashes += 1;
      settle(job);
      log('warn', `[converter] child exited (code ${code}) mid-job — failing that job only`);
      job.reject(new ConverterCrashedError(`converter exited (code ${code}) while converting`));
    } else if (was === 'starting') {
      unavailable(`child exited (code ${code}) before it was ready`);
    } else if (was !== 'stopping') {
      log('warn', `[converter] child exited unexpectedly (code ${code})`);
    }
    flushExitWaiters();
    pump();
  }

  function startNext(): void {
    clearIdle();
    const job = queue.shift()!;
    const id = nextId;
    nextId += 1;
    const timer = setTimeout(() => onTimeout(id), timeoutMs);
    active = { id, job, startedAt: now(), timer };
    child!.send({ id, ...job.job });
  }

  function onTimeout(id: number): void {
    if (!active || active.id !== id) return;
    const { job } = active;
    active = null;
    stats.timeouts += 1;
    settle(job);
    job.reject(new ConverterTimeoutError(`converter timed out after ${timeoutMs / 1000} s`));
    beginStop();
  }

  function onMessage(c: RunnerChild, raw: unknown): void {
    if (c !== child) return;
    const m = raw as ConverterReply;
    if ('t' in m && m.t === 'ready' && state === 'starting') {
      if (startTimer) clearTimeout(startTimer);
      startTimer = undefined;
      state = 'ready';
      pump();
      return;
    }
    if (!('id' in m) || !active || active.id !== m.id) return;
    const { job, timer, startedAt } = active;
    clearTimeout(timer);
    active = null;
    stats.jobs += 1;
    pushRecent(recent, now() - startedAt);
    settle(job);
    if (m.ok) job.resolve(m.result);
    else {
      const e = new Error(m.message);
      e.name = m.name;
      job.reject(e);
    }
    if (queue.length > 0) startNext();
    else armIdle();
  }

  function spawnChild(): void {
    let c: RunnerChild;
    try {
      c = opts.spawn();
    } catch (e) {
      unavailable(`spawn failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    child = c;
    state = 'starting';
    c.onMessage((m) => onMessage(c, m));
    c.onExit((code) => onChildExit(c, code));
    startTimer = setTimeout(() => {
      unavailable(`child not ready within ${startTimeoutMs} ms`);
      beginStop();
    }, startTimeoutMs);
  }

  function pump(): void {
    if (closed || queue.length === 0) return;
    if (state === 'none') {
      if (now() < unavailableUntil) {
        failQueued(new ConverterUnavailableError('converter unavailable (backing off)'));
        return;
      }
      spawnChild();
    } else if (state === 'ready' && !active) startNext();
  }

  function cancel(j: Job): void {
    const i = queue.indexOf(j);
    if (i >= 0) {
      queue.splice(i, 1);
      stats.cancels += 1;
      settle(j);
      j.reject(abortError());
      return;
    }
    if (active?.job === j) {
      clearTimeout(active.timer);
      active = null;
      stats.cancels += 1;
      settle(j);
      j.reject(abortError());
      beginStop(); // abandon the work; the next job respawns
    }
  }

  /** Resolves once `bytes` of capacity are RESERVED for the caller (counted
   *  in queuedBytes). The immediate path reserves synchronously too, so N
   *  submits in one tick can never all see the same free space. A rejected
   *  wait holds no reservation. */
  function reserveSpace(bytes: number, signal?: AbortSignal): Promise<void> {
    if (fits(bytes) && spaceWaiters.length === 0) {
      queuedBytes += bytes;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const w: SpaceWaiter = { bytes, resolve, reject, signal };
      if (signal) {
        w.onAbort = () => {
          const i = spaceWaiters.indexOf(w);
          if (i >= 0) spaceWaiters.splice(i, 1);
          stats.cancels += 1;
          reject(abortError());
        };
        signal.addEventListener('abort', w.onAbort, { once: true });
      }
      spaceWaiters.push(w);
    });
  }

  async function submit(job: ConverterJob, signal?: AbortSignal): Promise<unknown> {
    if (closed) throw new ConverterUnavailableError('converter stopped');
    if (signal?.aborted) {
      stats.cancels += 1;
      throw abortError();
    }
    if (state === 'none' && now() < unavailableUntil)
      throw new ConverterUnavailableError('converter unavailable (backing off)');
    const bytes = job.bytes.byteLength;
    await reserveSpace(bytes, signal);
    // The grant resolved before this continuation ran, and the waiter's abort
    // listener is already gone: a stop() or an abort in between is seen only
    // here. Give the reservation back instead of queueing into a closed or
    // cancelled runner.
    if (closed) {
      unreserve(bytes);
      throw new ConverterUnavailableError('converter stopped');
    }
    if (signal?.aborted) {
      unreserve(bytes);
      stats.cancels += 1;
      throw abortError();
    }
    return new Promise((resolve, reject) => {
      const j: Job = { job, bytes, resolve, reject, signal };
      if (signal) {
        j.onAbort = () => cancel(j);
        signal.addEventListener('abort', j.onAbort, { once: true });
      }
      queue.push(j); // its bytes were reserved by reserveSpace
      pump();
    });
  }

  return {
    parseDetailed: (bytes, mime, filename, signal) =>
      submit({ op: 'parseDetailed', bytes, mime, filename }, signal) as Promise<ParseResult>,
    parsePdfPages: (bytes, signal) =>
      submit({ op: 'parsePdfPages', bytes }, signal) as Promise<string[]>,
    rasterizePdf: (bytes, pages, o) =>
      submit({ op: 'rasterizePdf', bytes, pages, maxEdge: o?.maxEdge }, o?.signal) as Promise<RasterResult>,
    stats: () => ({
      mode: 'child',
      state,
      pid: child?.pid ?? null,
      ...stats,
      queued: queue.length,
      queuedBytes,
      p95Ms: p95(recent),
    }),
    async stop() {
      closed = true;
      const err = new ConverterUnavailableError('converter stopped');
      // Waiters first: failQueued's settle() would otherwise grant them
      // reservations only to have submit() give them back.
      for (const w of spaceWaiters.splice(0)) {
        if (w.onAbort) w.signal?.removeEventListener('abort', w.onAbort);
        w.reject(err);
      }
      failQueued(err);
      if (active) {
        const { job, timer } = active;
        clearTimeout(timer);
        active = null;
        settle(job);
        job.reject(err);
      }
      clearIdle();
      if (!child) return;
      const done = new Promise<void>((resolve) => exitWaiters.push(resolve));
      beginStop();
      await done;
    },
  };
}
```

- [ ] **Step 6: Run the unit tests**

Run: `npx jest src/main/core/converter/__tests__/runner.test.ts --runInBand`
Expected: PASS.

- [ ] **Step 7: Implement the child entry `src/main/converter/worker.ts`**

Replace the stub entirely:

```ts
/**
 * `kia-converter` child entry (#136, spec §1): the parsers and the WASM
 * rasteriser, off the main process. Answers one `{ id, op, … }` request at a
 * time (the supervisor in core/converter/runner.ts sends one at a time).
 * Installs NO signal handlers: SIGTERM must kill it even mid-parse.
 */
import {
  capMarkdown,
  parseDetailed,
  parsePdfPages,
  rasterizePdf,
} from '../core/converter/parsers';
import type {
  ConverterReply,
  ConverterRequest,
} from '../core/converter/protocol';

type ParentPort = {
  postMessage(m: unknown): void;
  on(ev: 'message', cb: (m: unknown) => void): void;
};
// Electron utilityProcess has `process.parentPort`; child_process.fork has
// `process.send` / `process.on('message')` (jest, serialization 'advanced').
const { parentPort } = process as unknown as { parentPort?: ParentPort };

const send = (m: ConverterReply): void => {
  if (parentPort) parentPort.postMessage(m);
  else process.send?.(m);
};
const onMessage = (cb: (m: unknown) => void): void => {
  if (parentPort) {
    parentPort.on('message', (ev: unknown) =>
      cb(
        ev && typeof ev === 'object' && 'data' in ev
          ? (ev as { data: unknown }).data
          : ev,
      ),
    );
  } else {
    process.on('message', cb);
  }
};

// Not a signal handler: a forked (non-Electron) child leaves with its parent.
process.on('disconnect', () => process.exit(0));

async function run(req: ConverterRequest): Promise<unknown> {
  // A fresh copy: bytes arriving over IPC may be a view into a larger
  // ArrayBuffer (Node's pool slice), and pdf.js reads the whole buffer —
  // the convert.ts "bad XRef entry" workaround, kept on this side.
  const bytes = new Uint8Array(req.bytes);
  switch (req.op) {
    case 'parseDetailed': {
      const r = await parseDetailed(bytes, req.mime, req.filename);
      return r.markdown === null
        ? r
        : { ...r, markdown: capMarkdown(r.markdown).markdown };
    }
    case 'parsePdfPages':
      return parsePdfPages(bytes);
    case 'rasterizePdf':
      return rasterizePdf(bytes, req.pages, req.maxEdge);
    default:
      throw new Error(`unknown converter op ${(req as { op: string }).op}`);
  }
}

onMessage((m) => {
  const req = m as ConverterRequest;
  run(req).then(
    (result) => send({ id: req.id, ok: true, result }),
    (e: unknown) =>
      send({
        id: req.id,
        ok: false,
        name: e instanceof Error ? e.name : 'Error',
        message: e instanceof Error ? e.message : String(e),
      }),
  );
});
send({ t: 'ready' });
```

- [ ] **Step 8: Write the real-child tests**

`src/main/core/converter/__tests__/fixtures/spinning-converter.cjs`:

```js
// A converter child stuck in a synchronous loop (a parser that never
// returns): answers ready, then spins forever on its first request. Proves
// the main event loop keeps turning and the wall-clock timeout kills it.
process.on('disconnect', () => process.exit(0));
process.on('message', () => {
  for (;;) {
    /* spin */
  }
});
process.send({ t: 'ready' });
```

`src/main/core/converter/__tests__/runner-process.test.ts`:

```ts
/**
 * @jest-environment node
 */
import fs from 'node:fs';
import path from 'node:path';

import { PNG } from 'pngjs';

import {
  createWorkerEnv,
  REPO_ROOT,
} from '../../../db/__tests__/worker-test-env';
import { multiPagePdf, PROSE_LINES } from '../../engine/__tests__/pdf-fixture';
import { forkRunnerChild } from '../../mcp/sql-runner-spawn';
import { createInlineConverter, type Converter } from '../converter';
import { createConverterRunner } from '../runner';

jest.setTimeout(180_000);

const ENTRY = path.join(REPO_ROOT, 'src', 'main', 'converter', 'worker.ts');
const SPIN = path.join(__dirname, 'fixtures', 'spinning-converter.cjs');
const FIXTURES = path.join(REPO_ROOT, 'src', 'main', 'core', 'engine', '__tests__', 'fixtures');

const MIME: Record<string, string> = {
  msg: 'application/vnd.ms-outlook',
  pdf: 'application/pdf',
  eml: 'message/rfc822',
  html: 'text/html',
  csv: 'text/csv',
  txt: 'text/plain',
};
const mimeOf = (name: string) => MIME[name.split('.').pop() ?? ''] ?? 'application/octet-stream';

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
  );
}

const settle = <T>(p: Promise<T>) =>
  p.then(
    (v) => ({ ok: true as const, v }),
    (e: Error) => ({ ok: false as const, name: e.name, message: e.message }),
  );

describe('converter over a real child process', () => {
  const env = createWorkerEnv('converter');
  const spawnReal = () =>
    forkRunnerChild(ENTRY, {
      execArgv: env.execArgv,
      cwd: REPO_ROOT,
      serialization: 'advanced',
    });
  let child: Converter;
  const inline = createInlineConverter();

  beforeAll(() => {
    child = createConverterRunner({ spawn: spawnReal, startTimeoutMs: 90_000 });
  });
  afterAll(async () => {
    await child.stop();
    env.cleanup();
  });

  it('every fixture parses identically inline and through the child', async () => {
    const generated: Array<[string, Uint8Array]> = [
      ['prose.pdf', multiPagePdf([{ text: PROSE_LINES }, { scan: true }, { blank: true }])],
      ['scan.pdf', multiPagePdf([{ scan: true }])],
      ['note.eml', Buffer.from('Subject: Hi\r\nFrom: a@b.c\r\n\r\nHello there body\r\n')],
      ['page.html', Buffer.from('<h1>Title</h1><p>para <b>bold</b></p>')],
      ['t.csv', Buffer.from('a,b\n1,2\n')],
    ];
    const onDisk = walk(FIXTURES).map(
      (f): [string, Uint8Array] => [path.basename(f), new Uint8Array(fs.readFileSync(f))],
    );
    for (const [name, bytes] of [...onDisk, ...generated]) {
      // eslint-disable-next-line no-await-in-loop
      const a = await settle(inline.parseDetailed(bytes, mimeOf(name), name));
      // eslint-disable-next-line no-await-in-loop
      const b = await settle(child.parseDetailed(bytes, mimeOf(name), name));
      expect({ name, ...b }).toEqual({ name, ...a });
    }
  });

  it('rasterizePdf without maxEdge is byte-identical to the in-process 2× render', async () => {
    const pdf = multiPagePdf([{ text: PROSE_LINES }, { scan: true }]);
    const a = await inline.rasterizePdf(pdf, [1, 2]);
    const b = await child.rasterizePdf(pdf, [1, 2]);
    expect(b.pageCount).toBe(a.pageCount);
    expect(b.pages.map((p) => p.page)).toEqual(a.pages.map((p) => p.page));
    for (let i = 0; i < a.pages.length; i += 1)
      expect(Buffer.compare(Buffer.from(a.pages[i].png), Buffer.from(b.pages[i].png))).toBe(0);
  });

  it('a windowed request reports the document’s total pageCount, and 25 pages complete in windows', async () => {
    const pdf = multiPagePdf(Array.from({ length: 25 }, () => ({ scan: true as const })));
    const seen = new Set<number>();
    for (let start = 1; start <= 25; start += 10) {
      const want = Array.from({ length: Math.min(10, 26 - start) }, (_, i) => start + i);
      // eslint-disable-next-line no-await-in-loop
      const r = await child.rasterizePdf(pdf, want);
      expect(r.pageCount).toBe(25);
      for (const p of r.pages) seen.add(p.page);
    }
    expect(seen.size).toBe(25);
  });

  it('with maxEdge it renders at the target edge and matches the 2× render after downscale', async () => {
    const pdf = multiPagePdf([{ text: PROSE_LINES }]);
    const small = PNG.sync.read(Buffer.from((await child.rasterizePdf(pdf, [1], { maxEdge: 896 })).pages[0].png));
    expect(Math.max(small.width, small.height)).toBeGreaterThanOrEqual(894);
    expect(Math.max(small.width, small.height)).toBeLessThanOrEqual(896);
    const big = PNG.sync.read(Buffer.from((await child.rasterizePdf(pdf, [1])).pages[0].png));
    // Nearest-neighbour downscale of the old 2× page to the new size, then
    // the mean absolute RGB difference: equal content, different sampling.
    let diff = 0;
    for (let y = 0; y < small.height; y += 1)
      for (let x = 0; x < small.width; x += 1) {
        const sx = Math.min(big.width - 1, Math.floor((x * big.width) / small.width));
        const sy = Math.min(big.height - 1, Math.floor((y * big.height) / small.height));
        const s = (y * small.width + x) * 4;
        const b = (sy * big.width + sx) * 4;
        for (let c = 0; c < 3; c += 1) diff += Math.abs(small.data[s + c] - big.data[b + c]);
      }
    expect(diff / (small.width * small.height * 3)).toBeLessThan(12);
  });

  it('a spinning child: main keeps ticking, the timeout kills it, the respawned child serves the next job', async () => {
    let spawns = 0;
    const runner = createConverterRunner({
      spawn: () => {
        spawns += 1;
        return spawns === 1
          ? forkRunnerChild(SPIN, { serialization: 'advanced' })
          : spawnReal();
      },
      timeoutMs: 1_500,
      termGraceMs: 500,
      startTimeoutMs: 90_000,
    });
    let ticks = 0;
    const iv = setInterval(() => {
      ticks += 1;
    }, 50);
    const stuck = settle(runner.parsePdfPages(new Uint8Array([1])));
    const r = await stuck;
    clearInterval(iv);
    expect(r).toMatchObject({ ok: false, name: 'ConverterTimeoutError' });
    expect(ticks).toBeGreaterThanOrEqual(15); // ~1.5 s of 50 ms ticks, main never blocked
    const ok = await runner.parseDetailed(Buffer.from('plain text body'), 'text/plain', 'a.txt');
    expect(ok).toEqual({ markdown: 'plain text body' });
    expect(spawns).toBe(2);
    expect(runner.stats().timeouts).toBe(1);
    await runner.stop();
  });
});
```

- [ ] **Step 9: Run the process tests**

Run: `npx jest src/main/core/converter/__tests__/runner-process.test.ts --runInBand`
Expected: PASS. If the fixture `.msg` files make both sides reject, that is still parity (the test compares settled outcomes). If the child cannot start, check the `serialization: 'advanced'` plumbing in `forkRunnerChild` first: with JSON serialization a `Uint8Array` arrives as a plain object.

- [ ] **Step 10: Gates and commit**

```bash
npx eslint src/main/core/abort.ts src/main/core/converter src/main/converter/worker.ts src/main/core/mcp/sql-runner-spawn.ts src/main/core/child-priority.ts
npx tsc --noEmit -p .
npx jest src/main/core/mcp/__tests__/sql-runner-spawn.test.ts src/main/core/__tests__/child-priority.test.ts --runInBand
printf 'feat(converter): kia-converter child + supervisor (#136)\n\nOne job at a time, 128 MiB input-byte queue, 120 s timeout\n(SIGTERM then SIGKILL), idle exit 300 s. Crash/timeout fail only the\nactive job; spawn failures are transient and back off. Inline facade\nfor KIA_CONVERTER_INLINE and tests.\n' > $SCRATCH/msg-t4.txt
git add src/main/core/abort.ts src/main/core/converter
git commit -F $SCRATCH/msg-t4.txt -- src/main/core/abort.ts src/main/core/converter src/main/converter/worker.ts src/main/core/mcp/sql-runner-spawn.ts src/main/core/child-priority.ts
```

---

### Task 5: Wire the converter into boot and the commit path

**Files:**
- Modify: `src/main/core/engine/convert.ts` (`createConverter(logs, converter)` + failure mapping)
- Modify: `src/main/workers/convert/outcome.ts` (`ConversionOutcome.reason?: 'crash'`)
- Modify: `src/main/core/engine/engine.ts:68-70` (`EngineDeps.convert` takes an optional signal)
- Modify: `src/main/core/boot.ts` (`BootDeps.converterSpawn?`, build runner or inline, `CorePlatform.converter`, shutdown)
- Modify: `src/main/main.ts:918-928` (resolve `worker.js`, pass `converterSpawn`)
- Test: `src/main/core/engine/__tests__/convert-failures.test.ts` (new)

**Interfaces:**
- Consumes: Task 4 (`Converter`, error classes, `createConverterRunner`, `createInlineConverter`, `CONVERTER_TIMEOUT_MS`, `utilityRunnerChild` opts, `demoteHost` name); Task 1 (`ingestSlots`).
- Produces:
  - `createConverter(logs: LogSink, converter?: Pick<Converter, 'parseDetailed'>): (input: DocumentInput, signal?: AbortSignal) => Promise<DocumentInput>`.
  - `EngineDeps.convert(input: DocumentInput, signal?: AbortSignal): Promise<DocumentInput>`; `CorePlatform.convert` same signature.
  - `CorePlatform.converter: Converter`.
  - `BootDeps.converterSpawn?: () => RunnerChild`.

Commit-path mapping (spec §1 table): crash → `stripBinary` + `metadata.conversion = { status: 'failed', reason: 'crash' }` (deterministic, no `at`); timeout → `stripBinary`, no marker; unavailable → `stripBinary`, no marker; abort → rethrow (the pull loop is stopping); an ordinary parser throw → today's warn + `stripBinary`.

- [ ] **Step 1: Write the failing tests**

Create `src/main/core/engine/__tests__/convert-failures.test.ts`:

```ts
/** @jest-environment node */
import type { Document, DocumentInput } from '@shared/contracts';

import {
  ConverterCrashedError,
  ConverterTimeoutError,
  ConverterUnavailableError,
} from '../../converter/converter';
import { abortError } from '../../abort';
import { isConvertCandidate } from '../../../workers/convert/convert-worker';
import { pdfReadyForOcr } from '../../../workers/convert/outcome';
import { createConverter } from '../convert';

const input: DocumentInput = {
  externalId: 'f',
  type: 'file',
  title: 'a.pdf',
  markdown: null,
  metadata: { mime: 'application/pdf', filename: 'a.pdf' },
  createdAt: null,
  binary: { bytes: new Uint8Array([1, 2, 3]), mime: 'application/pdf', filename: 'a.pdf' },
};
const throwing = (err: Error) => ({
  parseDetailed: async () => {
    throw err;
  },
});

it('a converter crash commits a deterministic failed/crash marker and no bytes', async () => {
  const convert = createConverter({ log: () => {} }, throwing(new ConverterCrashedError('x')));
  const a = await convert(input);
  const b = await convert(input);
  expect(a).toEqual(b); // deterministic: contentHash covers metadata
  expect('binary' in a).toBe(false);
  expect(a.markdown).toBeNull();
  expect(a.metadata).toEqual({
    mime: 'application/pdf',
    filename: 'a.pdf',
    conversion: { status: 'failed', reason: 'crash' },
  });
  // The convert worker never re-admits it; a PDF still goes to OCR.
  const asDoc = { ...a, id: 'd', accountId: 'acc', archivedAt: null } as unknown as Document;
  expect(isConvertCandidate(asDoc)).toBe(false);
  expect(pdfReadyForOcr(a.metadata.conversion)).toBe(true);
});

it.each([
  ['timeout', new ConverterTimeoutError('x')],
  ['unavailable', new ConverterUnavailableError('x')],
])('a converter %s commits no marker (the convert worker retries later)', async (_n, err) => {
  const out = await createConverter({ log: () => {} }, throwing(err))(input);
  expect('binary' in out).toBe(false);
  expect((out.metadata as { conversion?: unknown }).conversion).toBeUndefined();
});

it('an abort propagates (the pull loop is stopping; nothing commits)', async () => {
  await expect(
    createConverter({ log: () => {} }, throwing(abortError()))(input),
  ).rejects.toHaveProperty('name', 'AbortError');
});

it('passes the caller’s signal to the converter', async () => {
  const seen: Array<AbortSignal | undefined> = [];
  const ac = new AbortController();
  await createConverter(
    { log: () => {} },
    {
      parseDetailed: async (_b, _m, _f, signal) => {
        seen.push(signal);
        return { markdown: 'text body long enough' };
      },
    },
  )(input, ac.signal);
  expect(seen).toEqual([ac.signal]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/main/core/engine/__tests__/convert-failures.test.ts --runInBand`
Expected: FAIL (`createConverter` ignores its second argument; the crash case returns no marker).

- [ ] **Step 3: Implement the commit-path mapping**

`src/main/workers/convert/outcome.ts`, in `ConversionOutcome` after `quality?: 1;`:

```ts
  /** failed only: the converter child died on this document (#136). Written
   *  by the commit path, deterministically (no `at`). */
  reason?: 'crash';
```

`src/main/core/engine/convert.ts`: add imports

```ts
import { isAbortError } from '../abort';
import {
  ConverterCrashedError,
  createInlineConverter,
  type Converter,
} from '../converter/converter';
```

and replace `createConverter` with:

```ts
export function createConverter(
  logs: LogSink,
  converter: Pick<Converter, 'parseDetailed'> = createInlineConverter(),
): (input: DocumentInput, signal?: AbortSignal) => Promise<DocumentInput> {
  return async (input, signal) => {
    if (!input.binary || input.markdown !== null) return stripBinary(input);
    const { bytes, mime, filename } = input.binary;
    try {
      const { markdown: md, ocrPages } = await converter.parseDetailed(
        bytes,
        mime,
        filename,
        signal,
      );
      if (md !== null) {
        const base = {
          ...stripBinary(input),
          markdown: capMarkdown(md).markdown,
        };
        // Deterministic, no timestamp: contentHash covers metadata (garbled
        // spec §3), so the same bytes always commit the same row. A clean
        // PDF is stamped assessed too, so the convert worker never re-reads
        // its text to decide whether it is garbled.
        if (ocrPages)
          return {
            ...base,
            metadata: {
              ...input.metadata,
              conversion: needsOcrMarker(ocrPages),
            },
          };
        if (convertibleKind(mime, filename) === 'pdf')
          return {
            ...base,
            metadata: {
              ...input.metadata,
              conversion: { status: 'ok', quality: QUALITY_VERSION },
            },
          };
        return base;
      }
    } catch (err) {
      // The pull loop is stopping: nothing of this batch may commit.
      if (isAbortError(err)) throw err;
      if (err instanceof ConverterCrashedError) {
        logs.log('converter', 'warn', `converter crashed on ${filename ?? mime}`);
        // Deterministic marker (no `at`): the convert worker never re-admits
        // a doc carrying `conversion`, and a PDF still goes to OCR
        // (pdfReadyForOcr: 'failed').
        return {
          ...stripBinary(input),
          metadata: {
            ...input.metadata,
            conversion: { status: 'failed', reason: 'crash' },
          },
        };
      }
      // Timeout / unavailable / an ordinary parser throw: no marker — the
      // convert worker re-tries it later through the source's fetchBytes.
      logs.log(
        'converter',
        'warn',
        `parse failed for ${filename ?? mime}: ${String(err)}`,
      );
    }
    // Unparseable or text-poor: stays markdown-null for the vision pass.
    return stripBinary(input);
  };
}
```

`src/main/core/engine/engine.ts`, `EngineDeps`:

```ts
  /** The commit-path conversion stage: binary in, markdown out. Deterministic
   *  parsers only — text-poor results are left for a vision worker ('defer').
   *  `signal` cancels a queued or running converter job (pause/stop). */
  convert(input: DocumentInput, signal?: AbortSignal): Promise<DocumentInput>;
```

- [ ] **Step 4: Build the converter in `bootCore`**

`src/main/core/boot.ts`: imports

```ts
import type { Converter } from './converter/converter';
import { createInlineConverter } from './converter/converter';
import { CONVERTER_TIMEOUT_MS, createConverterRunner } from './converter/runner';
import type { RunnerChild } from './mcp/sql-runner';
```

`BootDeps` gains:

```ts
  /** Spawns the bundled `kia-converter` child (webpack `worker` entry).
   *  Absent (tests, stdio) or KIA_CONVERTER_INLINE=1 ⇒ parsers run inline. */
  converterSpawn?: () => RunnerChild;
```

`CorePlatform` gains (next to `convert`):

```ts
  /** The crash-isolated converter (#136): parsers + WASM rasteriser. */
  converter: Converter;
  convert(input: DocumentInput, signal?: AbortSignal): Promise<DocumentInput>;
```

(replace the old `convert(input: DocumentInput): Promise<DocumentInput>;` line). In `bootCore`, replace `const convert = createConverter(sink);` with:

```ts
  const budget = hostBudget(host, null);
  const converter: Converter =
    deps.converterSpawn && process.env.KIA_CONVERTER_INLINE !== '1'
      ? createConverterRunner({
          spawn: deps.converterSpawn,
          // Doubled on 1-slot hosts: a demoted child on a weak machine is
          // slow, not stuck (spec §1).
          timeoutMs: CONVERTER_TIMEOUT_MS * (budget.ingestSlots === 1 ? 2 : 1),
          log: (level, msg) => sink.log('converter', level, msg),
        })
      : createInlineConverter();
  const convert = createConverter(sink, converter);
```

Reuse `budget` for the existing `openReads({ … weak: hostBudget(host, null).weak … })` line (`weak: budget.weak`) — move the `budget` declaration above `openReads`. Add `converter,` to the `platform` object literal, and in `shutdown` after `await engine.stopAll();` add `await converter.stop();`.

- [ ] **Step 5: Spawn it from `main.ts`**

`src/main/main.ts`: add `import { demoteHost } from './core/child-priority';`. Before `platform = await bootCore({`, add:

```ts
    // Bundled converter child (webpack `worker` entry, #136): prod
    // `worker.js`, dev `worker.bundle.dev.js`. Demoted to BELOW_NORMAL on
    // spawn — never LOW: Windows IDLE-class children starve under load.
    const converterFile =
      [
        path.join(__dirname, 'worker.js'),
        path.join(__dirname, 'worker.bundle.dev.js'),
      ].find((f) => fs.existsSync(f)) ?? path.join(__dirname, 'worker.js');
```

and pass to `bootCore`:

```ts
      converterSpawn: () =>
        utilityRunnerChild(
          converterFile,
          {},
          (line) => platform?.logSink.log('converter', 'warn', line),
          {
            serviceName: 'kia-converter',
            onSpawn: (pid) => demoteHost(pid, {}, 'kia-converter'),
          },
        ),
```

- [ ] **Step 6: Run the tests**

```bash
cd ~/work/kcore-sync
for f in src/main/core/engine/__tests__/convert-failures.test.ts \
  src/main/core/engine/__tests__/convert-pdf.test.ts \
  src/main/core/engine/__tests__/convert-email.test.ts \
  src/main/workers/convert/__tests__/convert-pipeline.test.ts; do
  npx jest "$f" --runInBand || break
done
```

Expected: PASS.

- [ ] **Step 7: Gates and commit**

```bash
npx eslint src/main/core/engine/convert.ts src/main/workers/convert/outcome.ts src/main/core/engine/engine.ts src/main/core/boot.ts src/main/main.ts src/main/core/engine/__tests__/convert-failures.test.ts
npx tsc --noEmit -p .
printf 'feat(converter): commit path converts in the kia-converter child (#136)\n\nbootCore builds the runner (timeout doubled on 1-slot hosts) or the\ninline facade (KIA_CONVERTER_INLINE=1). Crash => deterministic\nfailed/crash marker; timeout/unavailable => no marker; abort rethrows.\n' > $SCRATCH/msg-t5.txt
git add src/main/core/engine/__tests__/convert-failures.test.ts
git commit -F $SCRATCH/msg-t5.txt -- src/main/core/engine/convert.ts src/main/workers/convert/outcome.ts src/main/core/engine/engine.ts src/main/core/boot.ts src/main/main.ts src/main/core/engine/__tests__/convert-failures.test.ts
```

---
### Task 6: The admission owner `core/admission.ts` (pure)

**Files:**
- Create: `src/main/core/admission.ts`
- Test: `src/main/core/__tests__/admission.test.ts`

**Interfaces:**
- Consumes: `abortError` (Task 4), `LaneState`, `SchedulerEnv`, `AppPrefs` from `@shared/contracts`.
- Produces:
  ```ts
  export type UnitKind = 'ingest' | 'convert' | 'reconcile' | 'redrive';
  export const FOREGROUND_GRACE_MS = 300;
  export const MAX_FOREGROUND_WAIT_MS = 10_000;
  export const KIND_AGING_MS = 5_000;
  export const SLOW_MODE_MAX_HOLD_MS = 2_000;
  export interface EnrichmentInputs {
    processing(): AppPrefs['processing'];
    env(): Pick<SchedulerEnv, 'onBattery' | 'userActive'>;
    weak(): boolean;
    syncing(): boolean;
  }
  export interface Admission {
    acquire(kind: UnitKind, signal: AbortSignal): Promise<() => void>;
    foreground(): () => void;
    foregroundBusy(): boolean;
    foregroundIdle(signal?: AbortSignal): Promise<void>;
    enrichmentLane(now?: Date): LaneState;
    snapshot(): AdmissionSnapshot;
  }
  export function createAdmission(deps: AdmissionDeps): Admission;
  export const NOOP_ADMISSION: Admission;
  export function inForeground<T>(a: Pick<Admission, 'foreground'> | undefined, fn: () => Promise<T>): Promise<T>;
  ```
  `AdmissionDeps = { slots: number; userActive(): boolean; enrichment: EnrichmentInputs; now?(): number; setTimer?(fn: () => void, ms: number): unknown; clearTimer?(t: unknown): void }`.

Rules implemented (spec §2, in order): (1) foreground first, with a 300 ms grace after the last leave; while busy, a waiter that has waited 10 s is admitted anyway, one escaped unit at a time; (2) at most `slots` units, ordered ingest > convert > reconcile > redrive then FIFO, except that a waiter that has waited 5 s goes ahead of every younger waiter; (3) slow mode holds a released slot for `factor × duration` (cap 2 s) while the user is active; (4) lane states never stop units (`enrichmentLane` is only the enrichment projection); (5) `acquire` rejects `AbortError` when its signal fires; `release` and `leave` are idempotent.

- [ ] **Step 1: Write the failing tests**

Create `src/main/core/__tests__/admission.test.ts`:

```ts
/** @jest-environment node */
import {
  createAdmission,
  FOREGROUND_GRACE_MS,
  inForeground,
  KIND_AGING_MS,
  MAX_FOREGROUND_WAIT_MS,
  type AdmissionDeps,
  type UnitKind,
} from '../admission';

/** A virtual clock: timers fire only when the test advances time. */
function virtualClock() {
  let t = 0;
  let seq = 0;
  const timers: Array<{ at: number; id: number; fn: () => void }> = [];
  const flush = () => new Promise<void>((r) => setImmediate(r));
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number) => {
      const h = { at: t + Math.max(0, ms), id: (seq += 1), fn };
      timers.push(h);
      return h;
    },
    clearTimer: (h: unknown) => {
      const i = timers.indexOf(h as never);
      if (i >= 0) timers.splice(i, 1);
    },
    async advance(ms: number) {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at || a.id - b.id);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        t = next.at;
        next.fn();
        // eslint-disable-next-line no-await-in-loop
        await flush();
      }
      t = end;
      await flush();
    },
    flush,
  };
}

const idle = {
  processing: () => ({ enabled: true, window: 'always' as const }),
  env: () => ({ onBattery: false, userActive: false }),
  weak: () => false,
  syncing: () => false,
};

function setup(over: Partial<AdmissionDeps> = {}) {
  const clock = virtualClock();
  const a = createAdmission({
    slots: 1,
    userActive: () => false,
    enrichment: idle,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...over,
  });
  return { a, clock };
}

/** Acquire and record when it resolves. */
function track(a: ReturnType<typeof createAdmission>, kind: UnitKind, signal = new AbortController().signal) {
  const s: { release?: () => void; error?: Error } = {};
  a.acquire(kind, signal).then(
    (r) => {
      s.release = r;
    },
    (e: Error) => {
      s.error = e;
    },
  );
  return s;
}

it('orders waiters ingest > convert > reconcile > redrive, then FIFO', async () => {
  const { a, clock } = setup();
  const first = track(a, 'ingest');
  await clock.flush();
  const order: string[] = [];
  const kinds: Array<[UnitKind, string]> = [
    ['redrive', 'R'],
    ['convert', 'C1'],
    ['ingest', 'I2'],
    ['reconcile', 'X'],
    ['convert', 'C2'],
  ];
  const waiters = kinds.map(([k, name]) => ({ name, s: track(a, k) }));
  await clock.flush();
  first.release!();
  for (let i = 0; i < kinds.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await clock.flush();
    const got = waiters.find((w) => w.s.release && !order.includes(w.name))!;
    order.push(got.name);
    got.s.release!();
  }
  expect(order).toEqual(['I2', 'C1', 'C2', 'X', 'R']);
});

it('caps running units at slots', async () => {
  const { a, clock } = setup({ slots: 2 });
  const s = [track(a, 'ingest'), track(a, 'ingest'), track(a, 'ingest')];
  await clock.flush();
  expect(s.map((x) => Boolean(x.release))).toEqual([true, true, false]);
  expect(a.snapshot().running).toBe(2);
});

it('foreground blocks new units, running ones finish; admission resumes after the grace', async () => {
  const { a, clock } = setup({ slots: 2 });
  const running = track(a, 'ingest');
  await clock.flush();
  const leave = a.foreground();
  const blocked = track(a, 'ingest');
  await clock.flush();
  expect(blocked.release).toBeUndefined();
  running.release!(); // a running unit is never preempted, it just finishes
  await clock.advance(100);
  leave();
  leave(); // idempotent
  await clock.advance(FOREGROUND_GRACE_MS - 1);
  expect(blocked.release).toBeUndefined();
  expect(a.foregroundBusy()).toBe(true);
  await clock.advance(1);
  expect(blocked.release).toBeDefined();
  expect(a.foregroundBusy()).toBe(false);
});

it('starvation escape: a 10 s waiter is admitted anyway, one at a time', async () => {
  const { a, clock } = setup({ slots: 2 });
  a.foreground(); // never leaves: a polling agent
  const one = track(a, 'ingest');
  const two = track(a, 'convert');
  await clock.advance(MAX_FOREGROUND_WAIT_MS - 1);
  expect(one.release).toBeUndefined();
  await clock.advance(1);
  expect(one.release).toBeDefined();
  expect(two.release).toBeUndefined(); // one escaped unit at a time
  one.release!();
  await clock.flush();
  expect(two.release).toBeDefined();
  expect(a.snapshot().starvationEscapes).toBe(2);
});

it('kind aging: at cap 1 under continuous ingest, a convert waiter gets in within KIND_AGING_MS', async () => {
  const { a, clock } = setup();
  let ingest = track(a, 'ingest');
  await clock.flush();
  const convert = track(a, 'convert');
  let admittedAt = -1;
  for (let t = 0; t < 2 * KIND_AGING_MS && admittedAt < 0; t += 100) {
    const nextIngest = track(a, 'ingest'); // always a younger ingest waiter
    // eslint-disable-next-line no-await-in-loop
    await clock.advance(100);
    ingest.release!();
    // eslint-disable-next-line no-await-in-loop
    await clock.flush();
    if (convert.release) {
      admittedAt = clock.now();
      convert.release();
      // eslint-disable-next-line no-await-in-loop
      await clock.flush();
    }
    ingest = nextIngest;
  }
  expect(admittedAt).toBeGreaterThanOrEqual(KIND_AGING_MS);
  expect(admittedAt).toBeLessThanOrEqual(KIND_AGING_MS + 100);
});

it('slow mode: while the user is active a released slot stays held for factor × duration, capped at 2 s', async () => {
  let active = true;
  const { a, clock } = setup({ userActive: () => active });
  const first = track(a, 'ingest');
  await clock.flush();
  const second = track(a, 'ingest');
  await clock.advance(400);
  first.release!(); // ran 400 ms; factor 1.0 at 1 slot → held 400 ms
  await clock.advance(399);
  expect(second.release).toBeUndefined();
  await clock.advance(1);
  expect(second.release).toBeDefined();
  const third = track(a, 'ingest');
  await clock.advance(5_000);
  second.release!(); // ran 5 s → hold capped at 2 s
  await clock.advance(1_999);
  expect(third.release).toBeUndefined();
  await clock.advance(1);
  expect(third.release).toBeDefined();
  active = false;
  const fourth = track(a, 'ingest');
  third.release!(); // user away: no hold
  await clock.flush();
  expect(fourth.release).toBeDefined();
  expect(a.snapshot().slowModeHoldMs).toBe(2_400);
});

it('slow mode factor is 0.25 with 2 slots', async () => {
  const { a, clock } = setup({ slots: 2, userActive: () => true });
  const [x, y] = [track(a, 'ingest'), track(a, 'ingest')];
  await clock.flush();
  const z = track(a, 'ingest');
  await clock.advance(800);
  x.release!(); // held 200 ms
  await clock.advance(199);
  expect(z.release).toBeUndefined();
  await clock.advance(1);
  expect(z.release).toBeDefined();
  expect(y.release).toBeDefined();
});

it('lane states never stop units', async () => {
  const { a, clock } = setup({
    enrichment: {
      processing: () => ({ enabled: false, window: 'night' as const }),
      env: () => ({ onBattery: true, userActive: true }),
      weak: () => true,
      syncing: () => true,
    },
  });
  expect(a.enrichmentLane()).toBe('disabled');
  const s = track(a, 'ingest');
  await clock.flush();
  expect(s.release).toBeDefined();
});

it('abort rejects a waiting acquire with AbortError and it never takes a slot', async () => {
  const { a, clock } = setup();
  const holder = track(a, 'ingest');
  await clock.flush();
  const ac = new AbortController();
  const aborted = track(a, 'convert', ac.signal);
  const after = track(a, 'redrive');
  ac.abort();
  await clock.flush();
  expect(aborted.error?.name).toBe('AbortError');
  holder.release!();
  await clock.flush();
  expect(after.release).toBeDefined();
  await expect(a.acquire('ingest', ac.signal)).rejects.toHaveProperty('name', 'AbortError');
});

it('release is idempotent', async () => {
  const { a, clock } = setup();
  const one = track(a, 'ingest');
  await clock.flush();
  const two = track(a, 'ingest');
  const three = track(a, 'ingest');
  one.release!();
  one.release!();
  await clock.flush();
  expect(two.release).toBeDefined();
  expect(three.release).toBeUndefined();
  expect(a.snapshot().running).toBe(1);
});

describe('foregroundIdle (enrichment waits, never throws)', () => {
  it('resolves at once when idle', async () => {
    const { a } = setup();
    await expect(a.foregroundIdle()).resolves.toBeUndefined();
  });
  it('waits while foreground is busy and resolves after the grace', async () => {
    const { a, clock } = setup();
    const leave = a.foreground();
    let done = false;
    void a.foregroundIdle().then(() => {
      done = true;
    });
    await clock.advance(1_000);
    expect(done).toBe(false);
    leave();
    await clock.advance(FOREGROUND_GRACE_MS);
    expect(done).toBe(true);
  });
  it('is capped at MAX_FOREGROUND_WAIT_MS', async () => {
    const { a, clock } = setup();
    a.foreground();
    let done = false;
    void a.foregroundIdle().then(() => {
      done = true;
    });
    await clock.advance(MAX_FOREGROUND_WAIT_MS - 1);
    expect(done).toBe(false);
    await clock.advance(1);
    expect(done).toBe(true);
  });
  it('rejects AbortError on abort', async () => {
    const { a, clock } = setup();
    a.foreground();
    const ac = new AbortController();
    // Assertion attached BEFORE the abort: a rejection left unhandled across
    // an event-loop turn is recorded by jest-circus as a test error.
    const rejected = expect(a.foregroundIdle(ac.signal)).rejects.toHaveProperty(
      'name',
      'AbortError',
    );
    ac.abort();
    await clock.flush();
    await rejected;
  });
});

it('inForeground enters and leaves, including on throw', async () => {
  const { a } = setup();
  await expect(
    inForeground(a, async () => {
      expect(a.snapshot().foregroundInFlight).toBe(1);
      throw new Error('boom');
    }),
  ).rejects.toThrow('boom');
  expect(a.snapshot().foregroundInFlight).toBe(0);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/main/core/__tests__/admission.test.ts --runInBand`
Expected: FAIL (`Cannot find module '../admission'`).

- [ ] **Step 3: Implement `src/main/core/admission.ts`**

```ts
/**
 * The ONE owner of background admission (#147 spec §2, §5). It admits
 * background UNITS — `ingest | convert | reconcile | redrive`, each "work in
 * hand plus one bounded write" — and owns the enrichment lane, which
 * `backgroundLaneState` (boot.ts) projects, the inference gate waits on
 * (`foregroundIdle`), and the worker pre-flights read. No other module
 * decides whether background work may run.
 *
 * Vision and audio are NOT units here: they are enrichment, lane-gated, and
 * their heavy work runs in demoted helper processes.
 */
import type {
  AppPrefs,
  LaneState,
  SchedulerEnv,
} from '@shared/contracts';

import { abortError } from './abort';

export type UnitKind = 'ingest' | 'convert' | 'reconcile' | 'redrive';

export const FOREGROUND_GRACE_MS = 300;
export const MAX_FOREGROUND_WAIT_MS = 10_000;
export const KIND_AGING_MS = 5_000;
export const SLOW_MODE_MAX_HOLD_MS = 2_000;

const RANK: Record<UnitKind, number> = {
  ingest: 0,
  convert: 1,
  reconcile: 2,
  redrive: 3,
};

/** What the enrichment lane is computed from — read live on every call. */
export interface EnrichmentInputs {
  processing(): AppPrefs['processing'];
  env(): Pick<SchedulerEnv, 'onBattery' | 'userActive'>;
  weak(): boolean;
  syncing(): boolean;
}

export interface AdmissionSnapshot {
  slots: number;
  /** Units in flight, slow-mode holds included. */
  running: number;
  held: number;
  foregroundInFlight: number;
  foregroundBusy: boolean;
  waiting: Record<UnitKind, number>;
  admitted: Record<UnitKind, number>;
  /** Cumulative ms waited, by kind. */
  waitMs: Record<UnitKind, number>;
  starvationEscapes: number;
  slowModeHoldMs: number;
  enrichmentWaits: number;
  enrichmentWaitMs: number;
}

export interface Admission {
  /** Resolves, once a slot is free, to `release()` (idempotent). Rejects
   *  `AbortError` when `signal` fires first. Never call it while holding an
   *  account-flow lock or inside a transaction. */
  acquire(kind: UnitKind, signal: AbortSignal): Promise<() => void>;
  /** Enter a foreground call; returns its (idempotent) leave. */
  foreground(): () => void;
  /** A foreground call is in flight, or left less than the grace ago. */
  foregroundBusy(): boolean;
  /** Resolves when not busy, or after MAX_FOREGROUND_WAIT_MS; rejects on abort. */
  foregroundIdle(signal?: AbortSignal): Promise<void>;
  /** The enrichment lane (was boot.ts backgroundLaneState's body). */
  enrichmentLane(now?: Date): LaneState;
  snapshot(): AdmissionSnapshot;
}

export interface AdmissionDeps {
  /** hostBudget().ingestSlots. */
  slots: number;
  /** scheduler.env.userActive — slow mode. */
  userActive(): boolean;
  enrichment: EnrichmentInputs;
  now?(): number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(t: unknown): void;
}

interface Waiter {
  kind: UnitKind;
  enq: number;
  resolve(release: () => void): void;
  reject(e: Error): void;
  signal: AbortSignal;
  onAbort(): void;
}

interface IdleWaiter {
  finish(err?: Error): void;
}

const byKind = (): Record<UnitKind, number> => ({
  ingest: 0,
  convert: 0,
  reconcile: 0,
  redrive: 0,
});

export function createAdmission(deps: AdmissionDeps): Admission {
  const now = deps.now ?? Date.now;
  const setTimer =
    deps.setTimer ??
    ((fn: () => void, ms: number) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return t;
    });
  const clearTimer =
    deps.clearTimer ??
    ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));

  const waiters: Waiter[] = [];
  const idleWaiters = new Set<IdleWaiter>();
  let running = 0;
  let held = 0;
  let escapedRunning = 0;
  let fgInFlight = 0;
  let fgLastLeave = Number.NEGATIVE_INFINITY;
  let wake: unknown = null;
  const admitted = byKind();
  const waitMs = byKind();
  let starvationEscapes = 0;
  let slowModeHoldMs = 0;
  let enrichmentWaits = 0;
  let enrichmentWaitMs = 0;

  const foregroundBusy = (): boolean =>
    fgInFlight > 0 || now() - fgLastLeave < FOREGROUND_GRACE_MS;

  /** Which waiter (if any) may start now. */
  function pickNext(): { index: number; escaped: boolean } | null {
    const t = now();
    let best = -1;
    if (foregroundBusy()) {
      // Rule 1 anti-starvation: one escaped unit at a time.
      if (escapedRunning > 0) return null;
      waiters.forEach((w, i) => {
        if (t - w.enq >= MAX_FOREGROUND_WAIT_MS && (best < 0 || w.enq < waiters[best].enq))
          best = i;
      });
      return best < 0 ? null : { index: best, escaped: true };
    }
    // Rule 2 aging: a waiter past KIND_AGING_MS goes ahead of every younger one.
    waiters.forEach((w, i) => {
      if (t - w.enq >= KIND_AGING_MS && (best < 0 || w.enq < waiters[best].enq))
        best = i;
    });
    if (best >= 0) return { index: best, escaped: false };
    waiters.forEach((w, i) => {
      if (
        best < 0 ||
        RANK[w.kind] < RANK[waiters[best].kind] ||
        (RANK[w.kind] === RANK[waiters[best].kind] && w.enq < waiters[best].enq)
      )
        best = i;
    });
    return best < 0 ? null : { index: best, escaped: false };
  }

  function admit(w: Waiter, escaped: boolean): void {
    w.signal.removeEventListener('abort', w.onAbort);
    running += 1;
    if (escaped) {
      escapedRunning += 1;
      starvationEscapes += 1;
    }
    const t0 = now();
    waitMs[w.kind] += t0 - w.enq;
    admitted[w.kind] += 1;
    let released = false;
    w.resolve(() => {
      if (released) return;
      released = true;
      if (escaped) escapedRunning -= 1;
      // Rule 3 slow mode: sync slows for an active user but never stops.
      const factor = deps.slots === 1 ? 1 : 0.25;
      const hold = deps.userActive()
        ? Math.min(SLOW_MODE_MAX_HOLD_MS, factor * (now() - t0))
        : 0;
      if (hold > 0) {
        held += 1;
        slowModeHoldMs += hold;
        setTimer(() => {
          held -= 1;
          running -= 1;
          pump();
        }, hold);
      } else {
        running -= 1;
        pump();
      }
    });
  }

  function pump(): void {
    while (running < deps.slots && waiters.length > 0) {
      const pick = pickNext();
      if (!pick) break;
      const [w] = waiters.splice(pick.index, 1);
      admit(w, pick.escaped);
    }
    armWake();
  }

  /** One timer at the next moment something may change: the grace ending
   *  (idle waiters resolve, units may start) or a waiter's starvation
   *  deadline. Aging needs no timer — it only reorders at a release. */
  function armWake(): void {
    if (wake !== null) {
      clearTimer(wake);
      wake = null;
    }
    if (waiters.length === 0 && idleWaiters.size === 0) return;
    if (!foregroundBusy()) return;
    let at = Number.POSITIVE_INFINITY;
    if (fgInFlight === 0) at = fgLastLeave + FOREGROUND_GRACE_MS;
    if (escapedRunning === 0 && running < deps.slots)
      for (const w of waiters)
        at = Math.min(at, w.enq + MAX_FOREGROUND_WAIT_MS);
    if (!Number.isFinite(at)) return;
    wake = setTimer(() => {
      wake = null;
      if (!foregroundBusy()) for (const iw of [...idleWaiters]) iw.finish();
      pump();
    }, Math.max(0, at - now()));
  }

  function enrichmentLane(at = new Date()): LaneState {
    const p = deps.enrichment.processing();
    if (!p.enabled) return 'disabled';
    const env = deps.enrichment.env();
    if (env.onBattery) return 'battery';
    if (deps.enrichment.weak() && deps.enrichment.syncing())
      return 'until-synced';
    switch (p.window) {
      case 'always':
        return 'open';
      case 'night': {
        const h = at.getHours();
        return h >= 22 || h < 7 ? 'open' : 'until-night';
      }
      case 'idle':
      default:
        return env.userActive ? 'until-idle' : 'open';
    }
  }

  return {
    acquire(kind, signal) {
      if (signal.aborted) return Promise.reject(abortError());
      return new Promise<() => void>((resolve, reject) => {
        const w: Waiter = {
          kind,
          enq: now(),
          resolve,
          reject,
          signal,
          onAbort: () => {
            const i = waiters.indexOf(w);
            if (i < 0) return;
            waiters.splice(i, 1);
            reject(abortError());
            armWake();
          },
        };
        signal.addEventListener('abort', w.onAbort, { once: true });
        waiters.push(w);
        pump();
      });
    },

    foreground() {
      fgInFlight += 1;
      armWake();
      let left = false;
      return () => {
        if (left) return;
        left = true;
        fgInFlight -= 1;
        if (fgInFlight === 0) fgLastLeave = now();
        armWake();
      };
    },

    foregroundBusy,

    foregroundIdle(signal) {
      if (signal?.aborted) return Promise.reject(abortError());
      if (!foregroundBusy()) return Promise.resolve();
      enrichmentWaits += 1;
      const t0 = now();
      return new Promise<void>((resolve, reject) => {
        let cap: unknown = null;
        const onAbort = () => entry.finish(abortError());
        const entry: IdleWaiter = {
          finish(err) {
            if (!idleWaiters.delete(entry)) return;
            if (cap !== null) clearTimer(cap);
            signal?.removeEventListener('abort', onAbort);
            enrichmentWaitMs += now() - t0;
            if (err) reject(err);
            else resolve();
          },
        };
        idleWaiters.add(entry);
        cap = setTimer(() => entry.finish(), MAX_FOREGROUND_WAIT_MS);
        signal?.addEventListener('abort', onAbort, { once: true });
        armWake();
      });
    },

    enrichmentLane,

    snapshot() {
      const waiting = byKind();
      for (const w of waiters) waiting[w.kind] += 1;
      return {
        slots: deps.slots,
        running,
        held,
        foregroundInFlight: fgInFlight,
        foregroundBusy: foregroundBusy(),
        waiting,
        admitted: { ...admitted },
        waitMs: { ...waitMs },
        starvationEscapes,
        slowModeHoldMs,
        enrichmentWaits,
        enrichmentWaitMs,
      };
    },
  };
}

const EMPTY_SNAPSHOT: AdmissionSnapshot = {
  slots: 0,
  running: 0,
  held: 0,
  foregroundInFlight: 0,
  foregroundBusy: false,
  waiting: byKind(),
  admitted: byKind(),
  waitMs: byKind(),
  starvationEscapes: 0,
  slowModeHoldMs: 0,
  enrichmentWaits: 0,
  enrichmentWaitMs: 0,
};

/** The default for every optional `admission` dep: admits at once. */
export const NOOP_ADMISSION: Admission = {
  acquire: (_kind, signal) =>
    signal.aborted ? Promise.reject(abortError()) : Promise.resolve(() => {}),
  foreground: () => () => {},
  foregroundBusy: () => false,
  foregroundIdle: (signal) =>
    signal?.aborted ? Promise.reject(abortError()) : Promise.resolve(),
  enrichmentLane: () => 'open',
  snapshot: () => EMPTY_SNAPSHOT,
};

/** Run `fn` as one foreground call (MCP tools/call, resources/read, the
 *  renderer's search/get/children). Leaves on throw too. */
export async function inForeground<T>(
  admission: Pick<Admission, 'foreground'> | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const leave = admission?.foreground();
  try {
    return await fn();
  } finally {
    leave?.();
  }
}

```

- [ ] **Step 4: Run to verify it passes**

Run: `npx jest src/main/core/__tests__/admission.test.ts --runInBand`
Expected: PASS. If the aging test lands one tick late, check that `pickNext` compares `enq` (arrival) and not admission order.

- [ ] **Step 5: Gates and commit**

```bash
npx eslint src/main/core/admission.ts src/main/core/__tests__/admission.test.ts
npx tsc --noEmit -p .
printf 'feat(admission): one background-work owner (#147)\n\nSlots, foreground-first with 300 ms grace and a 10 s starvation escape,\nkind priority with 5 s aging, slow mode, abortable acquire, and the\nenrichment lane. Pure; injected clock.\n' > $SCRATCH/msg-t6.txt
git add src/main/core/admission.ts src/main/core/__tests__/admission.test.ts
git commit -F $SCRATCH/msg-t6.txt -- src/main/core/admission.ts src/main/core/__tests__/admission.test.ts
```

---

### Task 7: Admission in boot — lane projection, inference wait, worker pre-flight wait

**Files:**
- Modify: `src/main/core/boot.ts` (build admission; `CorePlatform.admission`; `enrichmentInputsFor`; `backgroundLaneState` becomes a projection; `createEngine({ admission })`; `inference.setForegroundIdle`)
- Modify: `src/main/core/inference.ts:38-97` (option types gain `signal?`), `:130-134` (interface), `:250` (state), `:309-311` (`gate`), `withLocalFallback` (`:380-405`, gains `signal`), every `gate(lane)` call site (`:397`, `:412`, `:482`, `:541`, `:554`), `:620-622` (setter)
- Modify: `src/shared/contracts.ts:847-895` (`Inference` method options gain `signal?`)
- Modify: `src/main/core/engine/engine.ts:54-75` (`EngineDeps.admission?`), `:686-712` (session inference wrappers forward the work signal)
- Modify: `src/main/workers/index.ts`, `src/main/workers/vision/vision-worker.ts:68-74,197`, `src/main/workers/audio/audio-worker.ts:57,106`
- Tests: `src/main/core/__tests__/boot-lane.test.ts`, `src/main/core/__tests__/inference.test.ts`, `src/main/workers/__tests__/attach-bundled-workers.test.ts`, `src/main/workers/__tests__/redrive.test.ts`, `src/main/workers/vision/__tests__/vision-worker.test.ts`

**Interfaces:**
- Consumes: Task 6 (`createAdmission`, `Admission`, `EnrichmentInputs`, `NOOP_ADMISSION`, `MAX_FOREGROUND_WAIT_MS`); Task 1 (`ingestSlots`).
- Produces:
  - `CorePlatform.admission: Admission`.
  - `enrichmentInputsFor(get: () => Pick<CorePlatform, 'prefs' | 'scheduler' | 'host' | 'llmAccel' | 'engine'>): EnrichmentInputs` (exported from boot.ts; test fixtures use it).
  - `backgroundLaneState(platform, now?) = platform.admission.enrichmentLane(now)` (same result and `LaneState` values as today).
  - `InferencePlane.setForegroundIdle(fn: (signal?: AbortSignal) => Promise<void>): void`.
  - `signal?: AbortSignal` on the options of `Inference.complete/see/read/hear` and `InferencePlane.completeWithMeta/seeWithMeta`: cancels a background call while it waits at the gate (never forwarded to providers).
  - `EngineDeps.admission?: Pick<Admission, 'acquire'>` (used from Task 9 on).
  - Vision/audio deps `foregroundIdle?(signal: AbortSignal): Promise<void>`.

Spec §5 single owner: `refreshLane` (`src/main/platform/extension-platform.ts`) reaches admission only through `backgroundLaneState(p)` at `src/main/main.ts:1083`, which this task turns into `admission.enrichmentLane()`. That transitive path is the whole wiring; do not add a second one.

- [ ] **Step 1: Write the failing tests**

`src/main/core/__tests__/inference.test.ts`, add `import { abortError } from '../abort';` and append inside `describe('inference plane', …)`:

```ts
  it('a background call waits for the foreground wait, then proceeds (no LaneClosedError)', async () => {
    const plane = createInference(noopLogs);
    plane.register(provider('ocr', ['read'], 'ocr'));
    plane.setLanePolicy(() => true);
    let release!: () => void;
    plane.setForegroundIdle(
      () => new Promise<void>((r) => {
        release = r;
      }),
    );
    let done = false;
    const p = plane.read(new Uint8Array([1]), { lane: 'background' }).then((v) => {
      done = true;
      return v;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    release();
    await expect(p).resolves.toBe('ocr:read');
  });

  it('cancelling a background call during the foreground wait rejects AbortError and never invokes the provider', async () => {
    const plane = createInference(noopLogs);
    const handle = jest.fn(async () => 'never');
    plane.register({ id: 'ocr', supports: ['read'], status: () => 'ready', handle });
    plane.setLanePolicy(() => true);
    plane.setForegroundIdle(
      (signal) =>
        new Promise<void>((_, reject) => {
          signal?.addEventListener('abort', () => reject(abortError()), { once: true });
        }),
    );
    const ac = new AbortController();
    const p = plane.read(new Uint8Array([1]), { lane: 'background', signal: ac.signal });
    await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    await expect(p).rejects.toHaveProperty('name', 'AbortError');
    expect(handle).not.toHaveBeenCalled();
  });

  it('an abort that lands as the wait resolves still never invokes the provider', async () => {
    const plane = createInference(noopLogs);
    const handle = jest.fn(async () => 'never');
    plane.register({ id: 'ocr', supports: ['complete'], status: () => 'ready', handle });
    plane.setLanePolicy(() => true);
    const ac = new AbortController();
    plane.setForegroundIdle(async () => {
      ac.abort(); // the wait ends normally, but the caller is gone
    });
    await expect(
      plane.complete('hi', { lane: 'background', signal: ac.signal }),
    ).rejects.toHaveProperty('name', 'AbortError');
    expect(handle).not.toHaveBeenCalled();
  });

  it('interactive calls never wait for the foreground', async () => {
    const plane = createInference(noopLogs);
    plane.register(provider('ocr', ['read'], 'ocr'));
    plane.setForegroundIdle(() => new Promise<void>(() => {}));
    await expect(plane.read(new Uint8Array([1]))).resolves.toBe('ocr:read');
  });

  it('a closed lane still fails fast, before any wait', async () => {
    const plane = createInference(noopLogs);
    plane.register(provider('ocr', ['read'], 'ocr'));
    plane.setLanePolicy(() => false);
    const wait = jest.fn(() => new Promise<void>(() => {}));
    plane.setForegroundIdle(wait);
    await expect(
      plane.read(new Uint8Array([1]), { lane: 'background' }),
    ).rejects.toThrow(LaneClosedError);
    expect(wait).not.toHaveBeenCalled();
  });
```

`src/main/core/__tests__/boot-lane.test.ts`: change the imports and the fixture so the platform carries an admission built from the same inputs (all existing `it.each` rows stay as they are):

```ts
import { createAdmission } from '../admission';
import {
  backgroundLaneOpen,
  backgroundLaneState,
  enrichmentInputsFor,
  takeLaneWake,
} from '../boot';
```

and at the end of `function platform(over)`, replace `return { … } as unknown as CorePlatform;` with:

```ts
  const p = {
    /* …the existing object literal, unchanged… */
  } as unknown as CorePlatform;
  (p as { admission: CorePlatform['admission'] }).admission = createAdmission({
    slots: 1,
    userActive: () => p.scheduler.env.userActive,
    enrichment: enrichmentInputsFor(() => p),
  });
  return p;
```

Append one test proving the single owner:

```ts
it('backgroundLaneState is the admission owner’s enrichment projection', () => {
  const p = platform({ window: 'idle', userActive: true });
  const spy = jest.spyOn(p.admission, 'enrichmentLane');
  expect(backgroundLaneState(p, NOON)).toBe('until-idle');
  expect(spy).toHaveBeenCalledWith(NOON);
});
```

`src/main/workers/__tests__/attach-bundled-workers.test.ts` (both fake platforms, lines ~45 and ~223) and `src/main/workers/__tests__/redrive.test.ts` (fake at ~13): after each `const platform = { … };` literal add

```ts
  (platform as Record<string, unknown>).admission = createAdmission({
    slots: 1,
    userActive: () => false,
    enrichment: enrichmentInputsFor(() => platform as never),
  });
```

with imports `import { createAdmission } from '../../core/admission';` and `import { enrichmentInputsFor } from '../../core/boot';`. (The second attach-bundled fake has `processing.enabled: false`, so `weak()`/`syncing()` are never evaluated — `enrichmentLane` returns `'disabled'` first.)

`src/main/workers/vision/__tests__/vision-worker.test.ts`, append:

```ts
it('pre-flight: waits for the foreground before the lane check and any fetch', async () => {
  let release!: () => void;
  const fetchBytes = jest.fn(async () => new Uint8Array(100_000));
  const worker = createVisionWorker({
    rasterizer: { pdfToPngs: jest.fn(async () => raster(new Uint8Array([1]))) },
    laneOpen: () => true,
    foregroundIdle: () => new Promise<void>((r) => {
      release = r;
    }),
  });
  const p = worker.work(change({}), fakeSession({ fetchBytes }));
  await new Promise((r) => setTimeout(r, 20));
  expect(fetchBytes).not.toHaveBeenCalled();
  release();
  await expect(p).resolves.toBe('done');
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
for f in src/main/core/__tests__/inference.test.ts src/main/core/__tests__/boot-lane.test.ts src/main/workers/vision/__tests__/vision-worker.test.ts; do npx jest "$f" --runInBand; done
```

Expected: FAIL (`setForegroundIdle` / `enrichmentInputsFor` / `foregroundIdle` do not exist).

- [ ] **Step 3: Inference gate**

`src/main/core/inference.ts` — interface, after `setLanePolicy`:

```ts
  /** Bind the foreground wait (#147 §2 rule 1): every background request
   *  awaits it after the lane check — a bounded WAIT (admission caps it at
   *  MAX_FOREGROUND_WAIT_MS), never a throw, so a foreground burst never
   *  discards an already-done fetch/raster/OCR. The caller's `signal` ends
   *  the wait (AbortError). Unbound = no wait. */
  setForegroundIdle(fn: (signal?: AbortSignal) => Promise<void>): void;
```

Options: add to `complete`'s, `completeWithMeta`'s and `seeWithMeta`'s option objects in `InferencePlane`, and to all four option objects of `Inference` in `src/shared/contracts.ts` (`complete`, `see`, `read`, `hear`):

```ts
      /** Background lane only: cancels the call while it waits at the gate
       *  (rejects AbortError; the provider is never invoked). Not forwarded
       *  to providers. */
      signal?: AbortSignal;
```

State next to `let lanePolicy…`:

```ts
  let foregroundIdle: (signal?: AbortSignal) => Promise<void> = () =>
    Promise.resolve();
```

`gate` (add `import { abortError } from './abort';`):

```ts
  /** Interactive: returns synchronously — no suspension, so an interactive
   *  call registers in `activeCalls` in the same tick as before (the
   *  inference-active-calls suite pins that). Background: lane check, the
   *  bounded and cancellable foreground wait, then the lane and the signal
   *  re-checked, since either may have changed during the (≤ 10 s) wait. */
  const gate = (lane: Lane, signal?: AbortSignal): Promise<void> | undefined => {
    if (lane === 'interactive') return undefined;
    // Lane first: a closed lane fails fast (LaneClosedError's memory
    // rationale above) and never waits.
    if (!lanePolicy()) throw new LaneClosedError();
    if (signal?.aborted) throw abortError();
    return (async () => {
      await foregroundIdle(signal);
      if (signal?.aborted) throw abortError();
      if (!lanePolicy()) throw new LaneClosedError();
    })();
  };
```

Every `gate(lane);` call site becomes the two-line form below, so only a background call ever awaits:

```ts
    const waited = gate(lane, opts?.signal);
    if (waited) await waited;
```

(`completeWithMeta`, `seeWithMeta`, `read`, `hear`.) `withLocalFallback` gains a last parameter `signal?: AbortSignal`, its catch uses the same two-line form with that `signal`, and `completeWithMeta` / `seeWithMeta` pass `opts?.signal` as that argument. Because the fallback's own `gate` may now throw `AbortError`, add `name === 'AbortError'` to the rethrow list in its catch (next to `'LaneClosedError'`), so an aborted remote attempt never falls back locally. Add to the returned object next to `setLanePolicy(fn) { … }`:

```ts
    setForegroundIdle(fn) {
      foregroundIdle = fn;
    },
```

`src/main/core/inference-active-calls.test.ts` stays unchanged: every call in it is interactive, and interactive dispatch stays synchronous.

Engine session (`src/main/core/engine/engine.ts:686-712`, inside `workOne`): every inference wrapper forwards the work's `signal`, so stopping a worker during the gate wait cancels the call instead of waiting up to 10 s and dispatching afterwards:

```ts
        inference(prompt, opts) {
          return deps.inference.complete(prompt, {
            ...opts,
            lane: 'background',
            signal,
          });
        },
        see(image, prompt, opts) {
          return deps.inference.see(image, prompt, {
            ...opts,
            lane: 'background',
            signal,
          });
        },
```

and likewise `signal` in `seeWithMeta`, `read` and `hear`. `EngineDeps.inference` is `Inference & { seeWithMeta?(…, opts?: { mime?; lane?; task? }) … }`: add `signal?: AbortSignal` to that `seeWithMeta` option type too (`engine.ts:60-64`); the other four take the `Inference` contract's options.

- [ ] **Step 4: Boot**

`src/main/core/boot.ts` imports:

```ts
import {
  createAdmission,
  type Admission,
  type EnrichmentInputs,
} from './admission';
```

`CorePlatform` gains:

```ts
  /** The ONE background-work owner (#147): unit admission, foreground
   *  first, and the enrichment lane `backgroundLaneState` projects. */
  admission: Admission;
```

Add the exported helper above `bootCore`:

```ts
/** The enrichment lane's live inputs, read through `get()` on every call so
 *  `llmAccel` (bound by main.ts later) and `engine.syncing()` are never
 *  stale and never read before they exist. */
export function enrichmentInputsFor(
  get: () => Pick<
    CorePlatform,
    'prefs' | 'scheduler' | 'host' | 'llmAccel' | 'engine'
  >,
): EnrichmentInputs {
  return {
    processing: () => get().prefs.get().processing,
    env: () => get().scheduler.env,
    weak: () => hostBudget(get().host, get().llmAccel()).weak,
    syncing: () => get().engine.syncing(),
  };
}
```

In `bootCore`: declare `let platform!: CorePlatform;` right after `const sink …` lines, and after `const scheduler = createScheduler(…)`:

```ts
  // Lazy reads through `platform`: nothing evaluates the lane before
  // `platform` is assigned below.
  const admission = createAdmission({
    slots: budget.ingestSlots,
    userActive: () => scheduler.env.userActive,
    enrichment: enrichmentInputsFor(() => platform),
  });
  inference.setForegroundIdle((signal) => admission.foregroundIdle(signal));
```

Pass `admission` to `createEngine({ …, admission })`, change `const platform: CorePlatform = {` to `platform = {`, and add `admission,` to the literal.

Replace `backgroundLaneState`'s body and comment:

```ts
/** The enrichment lane, projected from the admission owner (#147 §5): same
 *  result and LaneState values as before. Inference admission, the worker
 *  pre-flights, the extension `lane()` resolver and the 5 s publisher all
 *  read it. Ingest/convert/reconcile/redrive units are admitted by
 *  `platform.admission.acquire` and are never closed by a lane state. */
export function backgroundLaneState(
  platform: CorePlatform,
  now = new Date(),
): LaneState {
  return platform.admission.enrichmentLane(now);
}
```

`src/main/core/engine/engine.ts`, `EngineDeps` gains `import type { Admission } from '../admission';` and:

```ts
  /** #147 background admission. Optional: absent = admit at once. */
  admission?: Pick<Admission, 'acquire'>;
```

- [ ] **Step 5: Worker pre-flights**

`src/main/workers/vision/vision-worker.ts` deps type gains:

```ts
  /** #147: wait (bounded) while the user's foreground calls are in flight. */
  foregroundIdle?(signal: AbortSignal): Promise<void>;
```

and in `workOne`, right before `if (!deps.laneOpen()) return 'defer';`:

```ts
    await deps.foregroundIdle?.(session.signal);
```

Same two edits in `src/main/workers/audio/audio-worker.ts` (dep type next to `laneOpen(): boolean;`; the await right before its `if (!deps.laneOpen()) return 'defer';`).

`src/main/workers/index.ts`: add `foregroundIdle: (signal) => platform.admission.foregroundIdle(signal),` to both `createVisionWorker({…})` and `createAudioWorker({…})`.

- [ ] **Step 6: Run the tests**

```bash
for f in src/main/core/__tests__/inference.test.ts src/main/core/__tests__/boot-lane.test.ts \
  src/main/workers/__tests__/attach-bundled-workers.test.ts src/main/workers/__tests__/redrive.test.ts \
  src/main/workers/vision/__tests__/vision-worker.test.ts src/main/core/__tests__/inference-active-calls.test.ts \
  src/main/core/__tests__/processing-status.test.ts; do npx jest "$f" --runInBand || break; done
```

Expected: PASS. Any test asserting a synchronous `toThrow` on a background inference call must already use `rejects` (the gate was inside async functions before); fix any that does not to `await expect(…).rejects.toThrow(…)`.

- [ ] **Step 7: Gates and commit**

```bash
npx eslint src/shared/contracts.ts src/main/core/inference.ts src/main/core/boot.ts src/main/core/engine/engine.ts src/main/workers src/main/core/__tests__/boot-lane.test.ts src/main/core/__tests__/inference.test.ts
npx tsc --noEmit -p .
printf 'feat(admission): boot owns admission; lane is its projection (#147)\n\nbackgroundLaneState = admission.enrichmentLane; background inference\nawaits foregroundIdle (bounded wait, never a throw); vision/audio\npre-flights wait too.\n' > $SCRATCH/msg-t7.txt
git commit -F $SCRATCH/msg-t7.txt -- src/shared/contracts.ts src/main/core/inference.ts src/main/core/boot.ts src/main/core/engine/engine.ts src/main/workers/index.ts src/main/workers/vision/vision-worker.ts src/main/workers/audio/audio-worker.ts src/main/core/__tests__/boot-lane.test.ts src/main/core/__tests__/inference.test.ts src/main/workers/__tests__/attach-bundled-workers.test.ts src/main/workers/__tests__/redrive.test.ts src/main/workers/vision/__tests__/vision-worker.test.ts
```

---

### Task 8: Store — `relink` pairs and chunked reconcile archival

**Files:**
- Modify: `src/shared/contracts.ts` (account variant of `CommitBatch` gains `relink?`)
- Modify: `src/main/core/store/write-tx.ts:400-433` (`reconcileParents` → `relinkPairs`), account branch of `commitTx` (~`:637`), `:196-221` (`WriteTx`), `:796-819` (`archiveBatchTx` takes a limit), `:1046-1058` (`reconcileArchive` → `reconcileArchiveChunk`)
- Modify: `src/main/db/worker-entry.ts:158-161` (register `reconcileArchiveChunk`, drop `reconcileArchive`)
- Modify: `src/main/core/store/store.ts:249-252,982-994` (`reconcileArchiveChunk`; `reconcileArchive` becomes a main-side loop of chunk RPCs)
- Tests: `src/main/core/store/__tests__/sync-yields-store.test.ts` (new), `src/main/core/store/__tests__/reconcile-chunk-worker.test.ts` (new), `src/main/db/__tests__/db-worker.test.ts:249-251` (migrated: it calls the removed `reconcileArchive` procedure directly)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `CommitBatch` account variant: `relink?: Array<{ child: ExternalRef; parent: ExternalRef }>`.
  - `CoreStore.reconcileArchiveChunk(accountId: AccountId, startSeq: Seq, limit?: number): Promise<{ archived: number; done: boolean }>`: exactly one `archiveBatchTx` per call; `done` ⇔ `archived < limit`; on `done` the pass is ended (staging dropped).
  - `CoreStore.reconcileArchive` keeps its signature (tests/maintenance) and loops `reconcileArchiveChunk`; the engine stops calling it in Task 11.

- [ ] **Step 1: Write the failing tests**

`src/main/core/store/__tests__/sync-yields-store.test.ts`:

```ts
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { AccountId, DocumentInput } from '@shared/contracts';

import { openDb } from '../../../db/app-db';
import { openStore, type CoreStore } from '../store';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};
const doc = (externalId: string, extra: Partial<DocumentInput> = {}): DocumentInput => ({
  externalId,
  type: 'note',
  title: externalId,
  markdown: `body ${externalId}`,
  metadata: {},
  createdAt: null,
  ...extra,
});

describe('sub-commit store support', () => {
  let dir: string;
  let store: CoreStore;
  let account: AccountId;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-syncstore-'));
    store = openStore(await openDb(path.join(dir, 'kiagent.db')), deps);
    account = (await store.createAccount({ source: 'test', identifier: 'me' })).id;
  });
  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('relink links a child committed by an earlier sub-commit once its parent lands', async () => {
    const parent = { externalId: 'msg', type: 'note' };
    await store.commit({ account, cursor: null, documents: [doc('att', { parent })] });
    expect((await store.read.byExternalId(account, 'att', 'note'))?.parentId).toBeNull();
    await store.commit({
      account,
      cursor: 'c1',
      documents: [doc('msg')],
      relink: [{ child: { externalId: 'att', type: 'note' }, parent }],
    });
    const msg = await store.read.byExternalId(account, 'msg', 'note');
    expect((await store.read.byExternalId(account, 'att', 'note'))?.parentId).toBe(msg!.id);
  });

  it('reconcileArchiveChunk runs one bounded transaction per call and ends the pass when done', async () => {
    await store.commit({ account, cursor: 1, documents: ['a', 'b', 'c', 'd', 'e'].map((x) => doc(x)) });
    const head = await store.headSeq();
    await store.reconcileBegin(account);
    await store.reconcileStage(account, [{ externalId: 'a', type: 'note' }]);
    expect(await store.reconcileArchiveChunk(account, head, 2)).toEqual({ archived: 2, done: false });
    expect(await store.reconcileArchiveChunk(account, head, 2)).toEqual({ archived: 2, done: false });
    expect(await store.reconcileArchiveChunk(account, head, 2)).toEqual({ archived: 0, done: true });
    await expect(store.reconcileArchiveChunk(account, head, 2)).rejects.toThrow(/reconcile staging lost/);
    expect(await store.read.count({ account })).toBe(1);
  });

  it('a doc committed between chunks (newer than startSeq) is never archived', async () => {
    await store.commit({ account, cursor: 1, documents: ['a', 'b', 'c'].map((x) => doc(x)) });
    const head = await store.headSeq();
    await store.reconcileBegin(account);
    await store.reconcileStage(account, [{ externalId: 'a', type: 'note' }]);
    expect((await store.reconcileArchiveChunk(account, head, 1)).archived).toBe(1);
    await store.commit({ account, cursor: 2, documents: [doc('late')] });
    while (!(await store.reconcileArchiveChunk(account, head, 1)).done) {
      /* drain */
    }
    expect((await store.read.byExternalId(account, 'late', 'note'))?.archivedAt).toBeNull();
  });
});
```

`src/main/core/store/__tests__/reconcile-chunk-worker.test.ts`:

```ts
/**
 * @jest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { DocumentInput } from '@shared/contracts';

import { createWorkerEnv, WORKER_ENTRY } from '../../../db/__tests__/worker-test-env';
import { openDbInWorker } from '../../../db/worker-client';
import { openStore } from '../store';

jest.setTimeout(120_000);

it('a writer call issued between archive chunks completes before the next chunk (real DB worker)', async () => {
  const env = createWorkerEnv('reconcile-chunk');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-rchunk-'));
  const db = await openDbInWorker(path.join(dir, 'kiagent.db'), WORKER_ENTRY, { execArgv: env.execArgv });
  const store = openStore(db, {
    encrypt: (s: string) => Buffer.from(s, 'utf8'),
    decrypt: (b: Buffer) => b.toString('utf8'),
    detectLanguages: () => ['eng'],
  });
  try {
    const account = (await store.createAccount({ source: 'test', identifier: 'me' })).id;
    const docs = Array.from({ length: 40 }, (_, i): DocumentInput => ({
      externalId: `d${i}`, type: 'note', title: `d${i}`, markdown: `body ${i}`, metadata: {}, createdAt: null,
    }));
    await store.commit({ account, cursor: 1, documents: docs });
    const head = await store.headSeq();
    await store.reconcileBegin(account);
    await store.reconcileStage(account, [{ externalId: 'd0', type: 'note' }]);
    const order: string[] = [];
    const c1 = store.reconcileArchiveChunk(account, head, 10).then(() => order.push('chunk1'));
    const w = store.setAccountStatus(account, { error: null }).then(() => order.push('writer'));
    const c2 = store.reconcileArchiveChunk(account, head, 10).then(() => order.push('chunk2'));
    await Promise.all([c1, w, c2]);
    expect(order).toEqual(['chunk1', 'writer', 'chunk2']);
  } finally {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    env.cleanup();
  }
});
```


- [ ] **Step 2: Run to verify they fail**

```bash
npx jest src/main/core/store/__tests__/sync-yields-store.test.ts --runInBand
npx jest src/main/core/store/__tests__/reconcile-chunk-worker.test.ts --runInBand
```

Expected: FAIL to compile (`relink`, `reconcileArchiveChunk` unknown).

- [ ] **Step 3: Implement**

`src/shared/contracts.ts`, account variant of `CommitBatch`, after `errorScope?`:

```ts
      /** Parent links to (re)resolve in this transaction (#147 §4): every
       *  `{child, parent}` of the SOURCE batch, carried by its last
       *  sub-commit, so a child an earlier sub-commit landed before its
       *  parent still gets linked. Any order inside a batch stays fine. */
      relink?: Array<{ child: ExternalRef; parent: ExternalRef }>;
```

`src/main/core/store/write-tx.ts`, replace `reconcileParents` with:

```ts
  /** Re-resolve each child's parent_id from refs, appending a change only
   *  when it moves (content_hash excludes parent). Shared by the batch's own
   *  DocumentInput.parent refs and by an account commit's `relink` pairs. */
  const relinkPairs = (
    accountId: string,
    pairs: Array<{ child: ExternalRef; parent: ExternalRef }>,
  ): Seq | null => {
    let last: Seq | null = null;
    for (const { child: c, parent: p } of pairs) {
      const child = findDocRow(accountId, c.externalId, c.type);
      if (!child) continue; // upserted above; absence means a prior step rejected it
      const parent = findDocRow(accountId, p.externalId, p.type);
      const parentId = parent?.id ?? null;
      if (child.parent_id !== parentId) {
        const seq = appendChange('document', child.id);
        conn
          .prepare(
            `UPDATE documents SET parent_id=?, seq=?, updated_at=? WHERE id=?`,
          )
          .run(parentId, seq, deps.now(), child.id);
        last = seq;
      }
    }
    return last;
  };

  const reconcileParents = (
    accountId: string,
    documents: DocumentInput[],
  ): Seq | null =>
    relinkPairs(
      accountId,
      documents.flatMap((d) =>
        d.parent
          ? [{ child: { externalId: d.externalId, type: d.type }, parent: d.parent }]
          : [],
      ),
    );
```

(keep the existing doc comment above `reconcileParents`). In the account branch, right after `const reconciled = reconcileParents(acc.id, batch.documents); if (reconciled !== null) last = reconciled;`:

```ts
    if (batch.relink?.length) {
      const relinked = relinkPairs(acc.id, batch.relink);
      if (relinked !== null) last = relinked;
    }
```

`archiveBatchTx` takes the limit: signature `(accountId: string, startSeq: Seq, limit: number): number` and `.all(accountId, startSeq, limit)`.

`WriteTx` interface: replace `reconcileArchive(...)` with

```ts
  /** ONE bounded archive transaction (#147 §4). `done` when it archived
   *  fewer than `limit` — the pass is then ended. A DB-worker respawn
   *  mid-pass surfaces as ReconcileStagingLost, never a partial archive. */
  reconcileArchiveChunk(
    accountId: string,
    startSeq: Seq,
    limit?: number,
  ): { archived: number; done: boolean };
```

and the implementation (replacing `reconcileArchive`):

```ts
    reconcileArchiveChunk: (accountId, startSeq, limit = RECONCILE_ARCHIVE_BATCH) => {
      requirePass(accountId);
      const archived = archiveBatchTx(accountId, startSeq, limit);
      const done = archived < limit;
      if (done) endPass(accountId);
      return { archived, done };
    },
```

`src/main/db/worker-entry.ts`: replace the `reconcileArchive` procedure with

```ts
        reconcileArchiveChunk: (args) => {
          const a = args as { accountId: string; startSeq: Seq; limit?: number };
          return writeTx.reconcileArchiveChunk(a.accountId, a.startSeq, a.limit);
        },
```

`src/main/core/store/store.ts`: interface — keep `reconcileArchive` and add

```ts
  /** One bounded archive chunk per call (one worker RPC, one transaction).
   *  The engine loops it, admitting each chunk (#147 §4). */
  reconcileArchiveChunk(
    accountId: AccountId,
    startSeq: Seq,
    limit?: number,
  ): Promise<{ archived: number; done: boolean }>;
```

Implementation: before the returned object, define

```ts
  const reconcileArchiveChunk = async (
    accountId: AccountId,
    startSeq: Seq,
    limit?: number,
  ): Promise<{ archived: number; done: boolean }> => {
    const r = writeTx
      ? writeTx.reconcileArchiveChunk(accountId, startSeq, limit)
      : ((await db.proc!('reconcileArchiveChunk', {
          accountId,
          startSeq,
          limit,
        })) as { archived: number; done: boolean });
    if (r.archived > 0) {
      corpus.invalidateLanguages();
      nudge.emit('commit');
    }
    return r;
  };
```

and replace the old `async reconcileArchive(…)` with

```ts
    reconcileArchiveChunk,

    /** Main-side loop of bounded chunk RPCs (tests, maintenance). The engine
     *  loops reconcileArchiveChunk itself so it can admit every chunk. */
    async reconcileArchive(accountId, startSeq) {
      let archived = 0;
      for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const r = await reconcileArchiveChunk(accountId, startSeq);
        archived += r.archived;
        if (r.done) return archived;
      }
    },
```

(If `writeTx`, `db`, `corpus`, `nudge` are declared after the point where you put the helper, move it below their declarations, just above `return {`.)

`src/main/db/__tests__/db-worker.test.ts` calls the worker procedure directly (not through the store wrapper), so it must move to the new procedure and its result shape. Replace

```ts
    expect(
      await client!.proc!('reconcileArchive', { accountId, startSeq }),
    ).toBe(1);
```

with

```ts
    // One chunk archives the single deletion and, being short of the limit,
    // reports done and ends the pass (the refusal below still holds).
    expect(
      await client!.proc!('reconcileArchiveChunk', { accountId, startSeq }),
    ).toEqual({ archived: 1, done: true });
```

- [ ] **Step 4: Run the tests**

```bash
for f in src/main/core/store/__tests__/sync-yields-store.test.ts src/main/core/store/__tests__/reconcile-chunk-worker.test.ts \
  src/main/core/store/__tests__/write-tx.test.ts src/main/core/store/__tests__/store.test.ts \
  src/main/core/store/__tests__/parent-child-lifetime.test.ts src/main/db/__tests__/db-worker.test.ts; do
  npx jest "$f" --runInBand || break; done
```

Expected: PASS (store-level `reconcileArchive` tests pass through the store-side loop; `db-worker.test.ts` passes on the migrated chunk call). A jest-worker SIGSEGV at teardown on a DB suite is pre-existing: if one appears, run the same file at the base commit (a scratch checkout of `v0.106.0` with the usual symlinked deps) and compare before calling it a failure.

- [ ] **Step 5: Gates and commit**

```bash
npx eslint src/shared/contracts.ts src/main/core/store src/main/db/worker-entry.ts
npx tsc --noEmit -p .
printf 'feat(store): relink pairs + one-transaction reconcile archive chunks (#147)\n\nAccount commits carry relink pairs (reconcileParents logic);\nreconcileArchiveChunk does one archiveBatchTx per RPC and ends the pass\nwhen done.\n' > $SCRATCH/msg-t8.txt
git add src/main/core/store/__tests__/sync-yields-store.test.ts src/main/core/store/__tests__/reconcile-chunk-worker.test.ts
git commit -F $SCRATCH/msg-t8.txt -- src/shared/contracts.ts src/main/core/store/write-tx.ts src/main/core/store/store.ts src/main/db/worker-entry.ts src/main/db/__tests__/db-worker.test.ts src/main/core/store/__tests__/sync-yields-store.test.ts src/main/core/store/__tests__/reconcile-chunk-worker.test.ts
```

---
### Task 9: Engine pull loop — admitted, bounded sub-commits

**Files:**
- Modify: `src/main/core/engine/engine.ts` (module constants near `REDRIVE_PAGE` ~`:194`; `createEngine` top ~`:450`; the restart seed `:1034-1040`; the `for await (const batch …)` body `:1080-1132`)
- Modify: `src/shared/contracts.ts:168-171` (`AccountProgress.base?`)
- Test: `src/main/core/engine/__tests__/sync-yields-engine.test.ts` (new; later tasks append to it); `src/main/core/engine/__tests__/engine.test.ts:184-247` (the legacy stale-counter test, run unchanged as a gate)

**Interfaces:**
- Consumes: `EngineDeps.admission` (Task 7), `NOOP_ADMISSION` (Task 6), `EngineDeps.convert(input, signal)` (Task 5), `CommitBatch.relink` (Task 8).
- Produces: `export const SUB_COMMIT_BYTES = 8 * 1024 * 1024; export const SUB_COMMIT_DOCS = 50;` from `engine.ts` (Task 10 uses `SUB_COMMIT_BYTES`), and module-level `textBytes(d: { markdown?: string | null }): number`.

Sub-commit rules (spec §3/§4): for each received batch, repeat { `acquire('ingest')` → `toDocument` + convert items one at a time, closing the group at an item boundary once it holds ≥ 50 documents or ≥ 8 MiB of markdown → one sub-commit → release } until the batch's items are used up (at least once, so an empty batch still commits its cursor/deletions). Intermediate sub-commits carry `cursor` = the last committed cursor (`fresh.cursor`, then the previous batch's `batch.cursor`), `status`, `progress` (spec §4: visible progress), `error: null`, `errorScope`. The last sub-commit carries `batch.cursor`, `batch.deletions`, `relink` (every `{child, parent}` from the batch), and `progress` for the whole batch.

Progress stays replay-safe through a `base` field:
- An intermediate sub-commit writes `progress = { done: base + n, totalEstimate, base }`, where `base` is `progressDone` at the start of the batch — the `done` value at the last cursor advance — and `n` the items consumed so far.
- The last sub-commit (the cursor advance) writes `{ done, totalEstimate }` with **no** `base`: its `done` is aligned with the cursor it writes.
- Restart seed: when the stored progress has a `base`, the last commit was intermediate, the batch will replay from the old cursor, so `progressDone = progress.base`. When it has none, today's legacy seed runs unchanged (`max(progress.done, document count)`), so accounts from builds that never accumulated the counter still recover (`engine.test.ts`' stale-counter case still ends at 7).

`AccountProgress` (`src/shared/contracts.ts`) gains:

```ts
  /** Set only by an intermediate sub-commit (#147 §4): `done` at the last
   *  cursor advance. A resume replays the half-committed batch from that
   *  cursor and counts up from `base`, never from `done`. Absent = `done`
   *  is aligned with the stored cursor. UI ignores it. */
  base?: number;
``` Abort is checked between documents and before each commit; an aborted group commits nothing.

- [ ] **Step 1: Write the failing tests**

Create `src/main/core/engine/__tests__/sync-yields-engine.test.ts`:

```ts
/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type {
  Account,
  Batch,
  CommitBatch,
  DocumentInput,
  Source,
} from '@shared/contracts';

import { openDb } from '../../../db/app-db';
import { createAdmission, type Admission } from '../../admission';
import { openStore, type CoreStore } from '../../store/store';
import { createEngine, type EngineDeps } from '../engine';

jest.setTimeout(60_000);

const noopLogs = { log: () => {} };
const idleLane = {
  processing: () => ({ enabled: true, window: 'always' as const }),
  env: () => ({ onBattery: false, userActive: false }),
  weak: () => false,
  syncing: () => false,
};
const cap1 = (): Admission =>
  createAdmission({ slots: 1, userActive: () => false, enrichment: idleLane });

const doc = (externalId: string, extra: Partial<DocumentInput> = {}): DocumentInput => ({
  externalId,
  type: 'note',
  title: externalId,
  markdown: `body ${externalId}`,
  metadata: {},
  createdAt: null,
  ...extra,
});
const items = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => doc(`${prefix}${i}`));

async function waitFor(cond: () => Promise<boolean> | boolean, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  // eslint-disable-next-line no-await-in-loop
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error('waitFor timeout');
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Yields `batches` from the one after `cursor`; optionally parks like a
 *  live watcher (holding no slot) until stopped. */
function batchSource<I = DocumentInput>(
  id: string,
  batches: Array<Batch<string, I>>,
  opts: { park?: boolean; toDocument?: (item: I) => DocumentInput | DocumentInput[] | null } = {},
): Source<string, I> {
  return {
    descriptor: { id, name: id, documentTypes: ['note'], auth: 'none' },
    async connect() {
      return { identifier: `${id}@test` };
    },
    async *pull(session, cursor) {
      const start = cursor === null ? 0 : batches.findIndex((b) => b.cursor === cursor) + 1;
      for (const b of batches.slice(start)) yield b;
      if (opts.park)
        await new Promise<void>((resolve) =>
          session.signal.addEventListener('abort', () => resolve(), { once: true }),
        );
    },
    toDocument: opts.toDocument ?? ((item) => item as unknown as DocumentInput),
  };
}

describe('pull loop sub-commits (#147 §3/§4)', () => {
  let dir: string;
  let store: CoreStore;
  let accountCommits: Array<Extract<CommitBatch, { account: string }>>;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-syncy-'));
    store = openStore(await openDb(path.join(dir, 'test.db')), {
      encrypt: (s: string) => Buffer.from(s, 'utf8'),
      decrypt: (b: Buffer) => b.toString('utf8'),
      detectLanguages: () => [],
    });
    accountCommits = [];
    const real = store.commit.bind(store);
    jest.spyOn(store, 'commit').mockImplementation(async (batch) => {
      if ('account' in batch) accountCommits.push(batch);
      return real(batch);
    });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeEngine(sources: Source<string, never>[], extra: Partial<EngineDeps> = {}) {
    return createEngine({
      store,
      sources: { get: (id) => sources.find((s) => s.descriptor.id === id) as Source | undefined },
      inference: {
        complete: async () => '',
        see: async () => '',
        read: async () => '',
        hear: async () => '',
      },
      convert: async (input) => input,
      logs: noopLogs,
      ...extra,
    });
  }
  const connect = (engine: ReturnType<typeof makeEngine>, source: Source<string, never>): Promise<Account> =>
    engine.connect(source as Source, {
      oauth: async () => ({}),
      showQr: () => {},
      prompt: async () => ({}),
      status: () => {},
      pickFolders: async () => [],
    });
  const live = (id: string) => async () => (await store.account(id))?.status === 'live';

  it('intermediate sub-commits keep the last committed cursor; only the last carries the new one', async () => {
    const source = batchSource('s', [
      { phase: 'backfill', items: items('a', 60), cursor: 'c1', estimateTotal: 120 },
      { phase: 'backfill', items: items('b', 60), cursor: 'c2', estimateTotal: 120 },
    ]);
    const engine = makeEngine([source as never]);
    const account = await connect(engine, source as never);
    const h = engine.run(account);
    await waitFor(live(account.id));
    await h.stop();
    expect(
      accountCommits.slice(0, 4).map((c) => ({ cursor: c.cursor, n: c.documents.length, done: c.progress?.done })),
    ).toEqual([
      { cursor: null, n: 50, done: 50 }, // intermediate progress is visible
      { cursor: 'c1', n: 10, done: 60 },
      { cursor: 'c1', n: 50, done: 110 },
      { cursor: 'c2', n: 10, done: 120 },
    ]);
    expect(accountCommits.slice(0, 4).map((c) => c.progress?.base)).toEqual([0, undefined, 60, undefined]);
    expect(await store.read.count({ account: account.id })).toBe(120);
  });

  it('progress is replay-safe: a crash inside the second batch re-counts only that batch', async () => {
    const source = batchSource('s', [
      { phase: 'backfill', items: items('a', 60), cursor: 'c1', estimateTotal: 120 },
      { phase: 'backfill', items: items('b', 60), cursor: 'c2', estimateTotal: 120 },
    ]);
    const engine = makeEngine([source as never]);
    const account = await connect(engine, source as never);
    const real = (store.commit as jest.Mock).getMockImplementation()!;
    let failed = false;
    (store.commit as jest.Mock).mockImplementation(async (batch: CommitBatch) => {
      // The second batch's FINAL sub-commit dies after its first 50 items
      // landed under cursor 'c1'.
      if ('account' in batch && batch.cursor === 'c2' && !failed) {
        failed = true;
        throw new Error('db worker died mid-batch');
      }
      return real(batch);
    });
    const h = engine.run(account);
    await waitFor(async () => (await store.account(account.id))?.cursor === 'c2', 15_000);
    await h.stop();
    expect(failed).toBe(true);
    // The crash left { done: 110, base: 60 } under cursor 'c1'; the resume
    // seeds 60 (not max(110, 110 docs)) and replays 60 items.
    const acc = await store.account(account.id);
    expect(acc?.progress).toEqual({ done: 120, totalEstimate: 120 });
    expect(await store.read.count({ account: account.id })).toBe(120);
  });

  it('a child committed before its parent across a sub-commit boundary is linked by relink', async () => {
    const parent = { externalId: 'msg', type: 'note' };
    const children = Array.from({ length: 50 }, (_, i) => doc(`att${i}`, { parent }));
    const source = batchSource('s', [{ phase: 'backfill', items: [...children, doc('msg')], cursor: 'c1' }]);
    const engine = makeEngine([source as never]);
    const account = await connect(engine, source as never);
    const h = engine.run(account);
    await waitFor(live(account.id));
    await h.stop();
    expect(accountCommits[0].documents).toHaveLength(50); // children first
    const msg = await store.read.byExternalId(account.id, 'msg', 'note');
    for (const i of [0, 49])
      // eslint-disable-next-line no-await-in-loop
      expect((await store.read.byExternalId(account.id, `att${i}`, 'note'))?.parentId).toBe(msg!.id);
  });

  it('the 8 MiB bound counts UTF-8 bytes: CJK markdown closes a sub-commit by bytes, not code units', async () => {
    // 'あ' is 1 UTF-16 code unit but 3 UTF-8 bytes: 1 Mi chars = 3 MiB.
    const cjk = 'あ'.repeat(1024 * 1024);
    const source = batchSource('s', [
      { phase: 'backfill', items: [1, 2, 3, 4].map((n) => doc(`j${n}`, { markdown: cjk })), cursor: 'c1' },
    ]);
    const engine = makeEngine([source as never]);
    const account = await connect(engine, source as never);
    const h = engine.run(account);
    await waitFor(live(account.id));
    await h.stop();
    // 3 docs = 9 MiB ≥ 8 MiB closes the first group (by .length it would be
    // 3 Mi units and all 4 would go together).
    expect(accountCommits.slice(0, 2).map((c) => c.documents.length)).toEqual([3, 1]);
  });

  it('ASCII just under the bound stays in one sub-commit', async () => {
    const MiB = 1024 * 1024;
    const body = 'x'.repeat(2 * MiB - 1); // 4 docs = 8 MiB − 4 bytes
    const source = batchSource('s', [
      { phase: 'backfill', items: [1, 2, 3, 4].map((n) => doc(`k${n}`, { markdown: body })), cursor: 'c1' },
    ]);
    const engine = makeEngine([source as never]);
    const account = await connect(engine, source as never);
    const h = engine.run(account);
    await waitFor(live(account.id));
    await h.stop();
    expect(accountCommits[0].documents).toHaveLength(4);
  });

  it('one item’s outputs never split, even past the bound', async () => {
    const source = batchSource<{ n: number }>(
      's',
      [{ phase: 'backfill', items: [{ n: 60 }], cursor: 'c1' }],
      { toDocument: (it) => Array.from({ length: it.n }, (_, i) => doc(`part${i}`)) },
    );
    const engine = makeEngine([source as never]);
    const account = await connect(engine, source as never);
    const h = engine.run(account);
    await waitFor(live(account.id));
    await h.stop();
    expect(accountCommits[0].documents).toHaveLength(60);
    expect(accountCommits[0].cursor).toBe('c1');
  });

  it('a crash between sub-commits re-pulls the batch from the old cursor, idempotently', async () => {
    const source = batchSource('s', [{ phase: 'backfill', items: items('a', 60), cursor: 'c1' }]);
    const engine = makeEngine([source as never]);
    const account = await connect(engine, source as never);
    const real = (store.commit as jest.Mock).getMockImplementation()!;
    let failed = false;
    (store.commit as jest.Mock).mockImplementation(async (batch: CommitBatch) => {
      if ('account' in batch && batch.cursor === 'c1' && !failed) {
        failed = true;
        throw new Error('db worker died mid-batch');
      }
      return real(batch);
    });
    const h = engine.run(account);
    await waitFor(async () => (await store.account(account.id))?.cursor === 'c1', 15_000);
    await h.stop();
    expect(failed).toBe(true);
    expect(await store.read.count({ account: account.id })).toBe(60);
  });

  it('a parked live source holds no slot: another account’s unit is admitted meanwhile', async () => {
    const admission = cap1();
    const a = batchSource('a', [{ phase: 'live', items: [doc('a1')], cursor: 'a1' }], { park: true });
    const b = batchSource('b', [{ phase: 'live', items: [doc('b1')], cursor: 'b1' }], { park: true });
    const engine = makeEngine([a as never, b as never], { admission });
    const accA = await connect(engine, a as never);
    const accB = await connect(engine, b as never);
    const hA = engine.run(accA);
    await waitFor(async () => (await store.read.count({ account: accA.id })) === 1);
    const hB = engine.run(accB);
    await waitFor(async () => (await store.read.count({ account: accB.id })) === 1);
    expect(admission.snapshot().running).toBe(0);
    await hA.stop();
    await hB.stop();
  });

  it('two accounts interleave at cap 1', async () => {
    const admission = cap1();
    const three = (p: string): Array<Batch<string, DocumentInput>> =>
      [1, 2, 3].map((n) => ({ phase: 'backfill', items: [doc(`${p}${n}`)], cursor: `${p}${n}` }));
    const a = batchSource('a', three('a'));
    const b = batchSource('b', three('b'));
    const engine = makeEngine([a as never, b as never], { admission });
    const accA = await connect(engine, a as never);
    const accB = await connect(engine, b as never);
    const hA = engine.run(accA);
    const hB = engine.run(accB);
    await waitFor(async () => (await live(accA.id)()) && (await live(accB.id)()));
    await hA.stop();
    await hB.stop();
    const order = accountCommits.filter((c) => c.documents.length > 0).map((c) => c.account);
    expect(new Set(order.slice(0, 3)).size).toBe(2);
  });

  it('pause while waiting for a slot resolves promptly and commits nothing', async () => {
    const admission = cap1();
    admission.foreground(); // a foreground call that never ends
    const source = batchSource('s', [{ phase: 'backfill', items: [doc('x')], cursor: 'c1' }]);
    const engine = makeEngine([source as never], { admission });
    const account = await connect(engine, source as never);
    engine.run(account);
    await waitFor(() => admission.snapshot().waiting.ingest === 1);
    const t0 = Date.now();
    await engine.pause(account.id);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(await store.read.count({ account: account.id })).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/main/core/engine/__tests__/sync-yields-engine.test.ts --runInBand`
Expected: FAIL (one commit per batch: the first test sees `{ cursor: 'c1', n: 60 }`; the pause test never sees a waiting ingest unit).

- [ ] **Step 3: Implement**

`src/main/core/engine/engine.ts` — imports: add `import { NOOP_ADMISSION } from '../admission';` (keep the `type Admission` import from Task 7). Module level, after `REDRIVE_PAGE`:

```ts
/** #147 §4 bounded writer units: a sub-commit (or a consumer flush) closes
 *  once it holds this much markdown/text … */
export const SUB_COMMIT_BYTES = 8 * 1024 * 1024;
/** … or this many documents — whichever comes first, and only ever at a
 *  source-item boundary. */
export const SUB_COMMIT_DOCS = 50;

/** UTF-8 bytes of the markdown a document carries into a writer unit — a
 *  real byte count: `.length` counts UTF-16 code units, which lets CJK text
 *  reach ~3× the bound before a flush. */
const textBytes = (d: { markdown?: string | null }): number =>
  Buffer.byteLength(d.markdown ?? '', 'utf8');
```

In `createEngine`, after `const { store, logs } = deps;`:

```ts
  const admission = deps.admission ?? NOOP_ADMISSION;
```

Replace the restart seed of `progressDone` (`engine.ts:1034-1040`) with:

```ts
              let progressDone = 0;
              if (fresh.cursor !== null) {
                // An intermediate sub-commit (#147) left `base` = the count at
                // the stored cursor: the half-committed batch replays from
                // that cursor, so count up from base — `done` and the
                // document count both include items about to be replayed.
                // No base: today's legacy seed, unchanged.
                progressDone =
                  fresh.progress?.base ??
                  Math.max(
                    fresh.progress?.done ?? 0,
                    await store.read.count({ account: account.id }),
                  );
              }
```

Replace the whole `for await (const batch of abortable(src.pull(…), abort.signal)) { … }` loop (from `for await` through its closing brace, i.e. through `retries = 0; }`) with:

```ts
              // The last cursor this account durably committed: what an
              // intermediate sub-commit writes back, so a crash between
              // sub-commits re-pulls the batch from where it began
              // (unchanged content_hash makes the replay a no-op).
              let committedCursor: unknown = fresh.cursor ?? null;
              for await (const batch of abortable(
                src.pull(session, fresh.cursor ?? null),
                abort.signal,
              )) {
                if (abort.signal.aborted) {
                  await reconciling;
                  return;
                }
                status = batch.phase === 'backfill' ? 'backfilling' : 'live';
                const { items } = batch;
                // `base` only on intermediate progress (see AccountProgress).
                const progressAt = (consumed: number, intermediate: boolean) =>
                  batch.estimateTotal !== undefined
                    ? {
                        done: progressDone + consumed,
                        totalEstimate: batch.estimateTotal,
                        ...(intermediate ? { base: progressDone } : {}),
                      }
                    : undefined;
                const relink: Array<{ child: ExternalRef; parent: ExternalRef }> = [];
                let next = 0;
                // One admitted unit per sub-commit (#147 §3): the batch is in
                // hand, so the slot covers toDocument + convert + ONE bounded
                // write and nothing else — never the wait for the next batch.
                do {
                  // eslint-disable-next-line no-await-in-loop
                  const release = await admission.acquire('ingest', abort.signal);
                  try {
                    const documents: DocumentInput[] = [];
                    let bytes = 0;
                    while (
                      next < items.length &&
                      documents.length < SUB_COMMIT_DOCS &&
                      bytes < SUB_COMMIT_BYTES
                    ) {
                      if (abort.signal.aborted) break;
                      const out = src.toDocument(items[next]);
                      next += 1;
                      for (const input of out ? (Array.isArray(out) ? out : [out]) : []) {
                        // eslint-disable-next-line no-await-in-loop
                        const converted = await deps.convert(input, abort.signal);
                        documents.push(converted);
                        bytes += textBytes(converted);
                        if (converted.parent)
                          relink.push({
                            child: { externalId: converted.externalId, type: converted.type },
                            parent: converted.parent,
                          });
                      }
                      // Real event-loop turn between items: toDocument is CPU
                      // work on this thread, and awaits on settled promises
                      // never leave the microtask queue. (timers/promises:
                      // jsdom-based tests have no setImmediate global.)
                      // eslint-disable-next-line no-await-in-loop
                      await nextEventLoopTurn();
                    }
                    if (abort.signal.aborted) break;
                    const last = next >= items.length;
                    // Boundaries fall only between items, so one item's
                    // parent and attachments never split. Only the LAST
                    // sub-commit moves the cursor and applies deletions; it
                    // also re-links children earlier sub-commits landed.
                    // eslint-disable-next-line no-await-in-loop
                    await store.commit(
                      last
                        ? {
                            account: account.id,
                            documents,
                            deletions: batch.deletions,
                            cursor: batch.cursor,
                            status,
                            progress: progressAt(items.length, false),
                            error: null,
                            errorScope,
                            relink: relink.length ? relink : undefined,
                          }
                        : {
                            account: account.id,
                            documents,
                            cursor: committedCursor,
                            status,
                            progress: progressAt(next, true),
                            error: null,
                            errorScope,
                          },
                    );
                  } finally {
                    release();
                  }
                } while (next < items.length);
                if (abort.signal.aborted) {
                  await reconciling;
                  return;
                }
                committedCursor = batch.cursor;
                if (batch.estimateTotal !== undefined) progressDone += items.length;
                backfillCommitted = batch.phase === 'backfill';
                retries = 0;
              }
```

Notes for the implementer: `break` inside the `try` exits the `do … while` and still runs `finally` (the slot is released). An `AbortError` from `acquire` or the converter lands in the existing `catch (err)` below, whose first lines (`await reconciling; if (abort.signal.aborted) return;`) already handle it.

- [ ] **Step 4: Run the new and the existing engine suites**

```bash
for f in src/main/core/engine/__tests__/sync-yields-engine.test.ts src/main/core/engine/__tests__/engine.test.ts \
  src/main/core/engine/__tests__/account-flows.test.ts src/main/core/engine/__tests__/needs-reauth.test.ts \
  src/main/core/engine/__tests__/abortable-leak.test.ts src/main/core/engine/__tests__/gmail-scope-store.test.ts; do
  npx jest "$f" --runInBand || break; done
```

Expected: PASS with no change to existing assertions — in particular `engine.test.ts`' "resumed backfill seeds progress from the stored doc count when the persisted counter is stale" still ends at `{ done: 7, totalEstimate: 7 }` (no `base` stored → legacy seed). Also: none of these suites pulls a batch of more than 50 items (their large fixtures — `REDRIVE_PAGE + 7` scans, 150-doc reconcile sets — are seeded with direct `store.commit` calls, not through `pull`).

- [ ] **Step 5: Gates and commit**

```bash
npx eslint src/shared/contracts.ts src/main/core/engine/engine.ts src/main/core/engine/__tests__/sync-yields-engine.test.ts
npx tsc --noEmit -p .
printf 'feat(engine): pull loop commits in admitted, bounded sub-commits (#147)\n\nOne ingest slot per sub-commit (<=50 docs or 8 MiB, item boundaries\nonly); intermediate sub-commits rewrite the last committed cursor; the\nlast carries the new cursor, deletions and relink pairs.\n' > $SCRATCH/msg-t9.txt
git add src/main/core/engine/__tests__/sync-yields-engine.test.ts
git commit -F $SCRATCH/msg-t9.txt -- src/shared/contracts.ts src/main/core/engine/engine.ts src/main/core/engine/__tests__/sync-yields-engine.test.ts
```

---

### Task 10: Engine `attach` / `rerunDeferred` — bounded, admitted flushes; session `admit` and `hasProvider`

**Files:**
- Modify: `src/shared/contracts.ts:1122-1165` (`WorkerSession.hasProvider?`, `admit?`)
- Modify: `src/main/core/inference.ts` (`InferencePlane.hasProvider`)
- Modify: `src/main/core/engine/engine.ts` (`EngineDeps.inference.hasProvider?`; `workOne(…, admitKind)` session; `attach` body `:1735-1800`; `rerunDeferred` body `:1899-1997` (registered re-drives); `stopAll` `:2078-2083`)
- Test: append to `src/main/core/engine/__tests__/sync-yields-engine.test.ts`; `src/main/core/__tests__/inference.test.ts`

**Interfaces:**
- Consumes: Task 2 consumer-cursor contract; Task 9 `SUB_COMMIT_BYTES`, `textBytes`, `admission`.
- Produces:
  - `WorkerSession.hasProvider?(kind: 'see' | 'read'): boolean` — a ready provider exists right now (Task 12's vision worker).
  - `WorkerSession.admit?(): Promise<() => void>` — bound by the engine to `admission.acquire('convert', signal)` in `attach` and `admission.acquire('redrive', signal)` in `rerunDeferred` (Task 12's convert worker).
  - `InferencePlane.hasProvider(kind: 'complete' | 'see' | 'read' | 'hear'): boolean`.

Flush rules (spec §4): emitted docs + enrich + their `clearAttempts` are flushed whenever staged markdown reaches `SUB_COMMIT_BYTES`, and once at the end. Each flush that carries output is one admitted unit — `acquire` right before `store.commit`, `release` right after — `'convert'` in `attach`, `'redrive'` in `rerunDeferred`. `attach`'s intermediate flushes omit `cursor`; its final commit writes the batch's cursor. `rerunDeferred` never writes a cursor. A final `attach` commit with nothing staged (cursor only) is a flush too and is admitted like any other (spec §4: every consumer flush, including the final cursor write). The one unadmitted consumer write is `dropBatch`, the stop-time cleanup that rewrites the unchanged cursor after an abort: it runs only when the signal has fired, when `acquire` would reject anyway. No permit is held across `fetchBytes`, a network wait or a retry backoff.

- [ ] **Step 1: Write the failing tests**

`src/main/core/__tests__/inference.test.ts`, inside `describe('inference plane', …)`:

```ts
  it('hasProvider answers from ready local providers', () => {
    const plane = createInference(noopLogs);
    expect(plane.hasProvider('read')).toBe(false);
    plane.register(provider('ocr', ['read'], 'ocr'));
    expect(plane.hasProvider('read')).toBe(true);
    expect(plane.hasProvider('see')).toBe(false);
  });
```

Append to `src/main/core/engine/__tests__/sync-yields-engine.test.ts` (same file, new describe; reuse its helpers — add `import type { Change, Worker } from '@shared/contracts';` and `import { workerConsumerName } from '../engine';`):

```ts
describe('consumer flushes (#147 §4)', () => {
  let dir: string;
  let store: CoreStore;
  let consumerCommits: Array<Extract<CommitBatch, { consumer: string }>>;
  const MiB = 1024 * 1024;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-flush-'));
    store = openStore(await openDb(path.join(dir, 'test.db')), {
      encrypt: (s: string) => Buffer.from(s, 'utf8'),
      decrypt: (b: Buffer) => b.toString('utf8'),
      detectLanguages: () => [],
    });
    consumerCommits = [];
    const real = store.commit.bind(store);
    jest.spyOn(store, 'commit').mockImplementation(async (batch) => {
      if ('consumer' in batch) consumerCommits.push(batch);
      return real(batch);
    });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const engineWith = (admission: Pick<Admission, 'acquire'>) =>
    createEngine({
      store,
      sources: { get: () => undefined },
      inference: { complete: async () => '', see: async () => '', read: async () => '', hear: async () => '' },
      convert: async (i) => i,
      logs: noopLogs,
      admission,
    });

  async function seed(ids: string[], metadata: Record<string, unknown> = { todo: true }) {
    const acc = await store.createAccount({ source: 'seed', identifier: 'seed' });
    await store.commit({ account: acc.id, cursor: 1, documents: ids.map((x) => doc(x, { metadata })) });
    return acc;
  }
  const todo = (c: Change) =>
    c.kind === 'document' && (c.document.metadata as { todo?: boolean }).todo === true;
  const enrichWorker = (body: string, over: Partial<Worker> = {}): Worker => ({
    name: 'bulk',
    version: 1,
    matches: todo,
    async work(change, session) {
      if (change.kind !== 'document') return 'skip';
      session.enrich({ documentId: change.document.id, markdown: body, metadata: { todo: false } });
      return 'done';
    },
    ...over,
  });

  it('attach: flushes are bounded and admitted; an intermediate flush leaves the cursor unchanged', async () => {
    await seed(['d1', 'd2', 'd3', 'd4']);
    const acquire = jest.fn<ReturnType<Admission['acquire']>, Parameters<Admission['acquire']>>(
      async () => () => {},
    );
    const engine = engineWith({ acquire });
    const worker = enrichWorker('x'.repeat(3 * MiB));
    const consumer = workerConsumerName(worker);
    const convertAcquires = () => acquire.mock.calls.filter(([k]) => k === 'convert').length;
    const h = engine.attach(worker);
    // The enrich commits create new document changes; the feed consumes them
    // next, they no longer match, and their batch ends in a cursor-only flush.
    // Wait for that follow-up flush AND for the books to balance (no flush
    // in flight between its acquire and its commit).
    await waitFor(
      () =>
        consumerCommits.some(
          (c) => c.cursor !== undefined && !c.enrich && !c.documents && !c.clearAttempts,
        ) && convertAcquires() === consumerCommits.length,
    );
    const flushes = [...consumerCommits];
    const acquired = convertAcquires();
    await h.stop();
    // Exactly two flushes carry output…
    const withOutput = flushes.filter((c) => (c.enrich?.length ?? 0) > 0);
    expect(withOutput.map((c) => [c.enrich!.length, 'cursor' in c])).toEqual([
      [3, false], // 9 MiB staged ≥ 8 MiB → intermediate flush, no cursor
      [1, true], // final flush writes the cursor
    ]);
    // …and EVERY observed flush, the cursor-only follow-up included, was admitted.
    expect(flushes.length).toBeGreaterThanOrEqual(3);
    expect(acquired).toBe(flushes.length);
    expect(await store.consumerCursor(consumer)).toBeGreaterThan(0);
  });

  it('attach: the flush bound counts UTF-8 bytes of non-ASCII enrich markdown', async () => {
    await seed(['d1', 'd2', 'd3', 'd4']);
    const acquire = jest.fn<ReturnType<Admission['acquire']>, Parameters<Admission['acquire']>>(
      async () => () => {},
    );
    // 1 Mi 'あ' = 1 Mi code units but 3 MiB of UTF-8.
    const worker = enrichWorker('あ'.repeat(MiB));
    const h = engineWith({ acquire }).attach(worker);
    await waitFor(() => consumerCommits.some((c) => c.cursor !== undefined && (c.enrich?.length ?? 0) > 0));
    await h.stop();
    expect(consumerCommits.filter((c) => (c.enrich?.length ?? 0) > 0).map((c) => c.enrich!.length)).toEqual([3, 1]);
  });

  it('attach: a batch with no output still admits its final cursor commit', async () => {
    await seed(['d1', 'd2']);
    const acquire = jest.fn<ReturnType<Admission['acquire']>, Parameters<Admission['acquire']>>(
      async () => () => {},
    );
    const worker: Worker = { name: 'nothing', version: 1, matches: () => false, work: async () => 'skip' };
    const consumer = workerConsumerName(worker);
    const convertAcquires = () => acquire.mock.calls.filter(([k]) => k === 'convert').length;
    const h = engineWith({ acquire }).attach(worker);
    await waitFor(
      async () =>
        (await store.consumerCursor(consumer)) > 0 && convertAcquires() === consumerCommits.length,
    );
    await h.stop();
    const cursorCommits = consumerCommits.filter((c) => c.cursor !== undefined);
    expect(cursorCommits.length).toBeGreaterThan(0);
    for (const c of cursorCommits) expect(c.documents ?? c.enrich ?? c.clearAttempts).toBeUndefined();
    expect(acquire.mock.calls.filter(([k]) => k === 'convert')).toHaveLength(cursorCommits.length);
  });

  it('attach: the final cursor commit waits while foreground is busy', async () => {
    await seed(['d1']);
    const admission = cap1();
    const leave = admission.foreground();
    const worker: Worker = { name: 'nothing2', version: 1, matches: () => false, work: async () => 'skip' };
    const consumer = workerConsumerName(worker);
    const h = engineWith(admission).attach(worker);
    await new Promise((r) => setTimeout(r, 500));
    expect(await store.consumerCursor(consumer)).toBe(0);
    leave();
    await waitFor(async () => (await store.consumerCursor(consumer)) > 0);
    await h.stop();
  });

  it('stopAll aborts and drains a re-drive blocked on admission; nothing commits after it', async () => {
    const acc = await seed(['d1']);
    const worker = enrichWorker('late');
    const consumer = workerConsumerName(worker);
    const d = await store.read.byExternalId(acc.id, 'd1', 'note');
    await store.ledgerRecord(consumer, d!.seq, 1, 'deferred');
    const admission = cap1();
    admission.foreground(); // never leaves: the flush waits for a slot
    const engine = engineWith(admission);
    const redrive = engine.rerunDeferred(worker);
    await waitFor(() => admission.snapshot().waiting.redrive === 1);
    const t0 = Date.now();
    await engine.stopAll();
    expect(Date.now() - t0).toBeLessThan(1_000);
    await expect(redrive).resolves.toBeUndefined();
    expect(admission.snapshot().waiting.redrive).toBe(0);
    expect((await store.read.byExternalId(acc.id, 'd1', 'note'))?.markdown).toBe('body d1');
    expect((await store.ledgerCounts(consumer)).deferred).toBe(1);
  });

  it('a re-drive requested after stopAll began never starts', async () => {
    const acc = await seed(['d1']);
    const worker = enrichWorker('late');
    const consumer = workerConsumerName(worker);
    const d = await store.read.byExternalId(acc.id, 'd1', 'note');
    await store.ledgerRecord(consumer, d!.seq, 1, 'deferred');
    const engine = engineWith(cap1());
    const probe = jest.spyOn(store, 'ledgerDeferred');
    const stopping = engine.stopAll(); // the scheduler's probe finishes after this
    await engine.rerunDeferred(worker);
    await stopping;
    expect(probe).not.toHaveBeenCalled();
    expect((await store.ledgerCounts(consumer)).deferred).toBe(1);
  });

  it('stopAll cancels a re-drive over a no-output backlog before it writes the ledger', async () => {
    const acc = await seed(['n1', 'n2', 'n3']);
    // Matches nothing: every entry resolves as 'skip' without any admission.
    const worker: Worker = { name: 'none', version: 1, matches: () => false, work: async () => 'skip' };
    const consumer = workerConsumerName(worker);
    for (const id of ['n1', 'n2', 'n3']) {
      // eslint-disable-next-line no-await-in-loop
      const d = await store.read.byExternalId(acc.id, id, 'note');
      // eslint-disable-next-line no-await-in-loop
      await store.ledgerRecord(consumer, d!.seq, 1, 'deferred');
    }
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const real = store.changesAt.bind(store);
    const changesAt = jest.spyOn(store, 'changesAt').mockImplementation(async (seqs) => {
      await gate; // the page is in flight when shutdown starts
      return real(seqs);
    });
    const writes = jest.spyOn(store, 'ledgerRecordMany');
    const engine = engineWith(cap1());
    const redrive = engine.rerunDeferred(worker);
    await waitFor(() => changesAt.mock.calls.length === 1);
    const stopped = engine.stopAll();
    release();
    await stopped;
    await expect(redrive).resolves.toBeUndefined();
    expect(writes).not.toHaveBeenCalled();
    expect((await store.ledgerCounts(consumer)).deferred).toBe(3);
  });

  it('rerunDeferred never writes the cursor: a live tail advancing 100 → 200 mid-flush ends at 200', async () => {
    await seed(['d1', 'd2']);
    const worker = enrichWorker('redriven');
    const consumer = workerConsumerName(worker);
    await store.commit({ consumer, cursor: 100 });
    for (const id of ['d1', 'd2']) {
      // eslint-disable-next-line no-await-in-loop
      const d = (await store.read.search({ text: id }))[0];
      // eslint-disable-next-line no-await-in-loop
      await store.ledgerRecord(consumer, d.seq, 1, 'deferred');
    }
    const engine = engineWith({
      acquire: async (kind) => {
        // The live tail commits its cursor while the re-drive waits for its flush.
        if (kind === 'redrive') await store.commit({ consumer, cursor: 200 });
        return () => {};
      },
    });
    await engine.rerunDeferred(worker);
    expect(await store.consumerCursor(consumer)).toBe(200);
    const redrive = consumerCommits.filter((c) => (c.enrich?.length ?? 0) > 0);
    expect(redrive.length).toBeGreaterThan(0);
    for (const c of redrive) expect('cursor' in c).toBe(false);
  });

  it('a flush waits for admission while foreground is busy', async () => {
    const acc = await seed(['d1']);
    const admission = cap1();
    const leave = admission.foreground();
    const h = engineWith(admission).attach(enrichWorker('converted body'));
    const d1 = () => store.read.byExternalId(acc.id, 'd1', 'note');
    await new Promise((r) => setTimeout(r, 500));
    expect((await d1())?.markdown).toBe('body d1');
    leave();
    await waitFor(async () => (await d1())?.markdown === 'converted body');
    await h.stop();
  });

  it('re-drive at cap 1 does not deadlock (the worker’s own admit and the flush are sequential units)', async () => {
    await seed(['d1', 'd2', 'd3']);
    const admission = cap1();
    const worker = enrichWorker('ok', {
      async work(change, session) {
        if (change.kind !== 'document') return 'skip';
        const release = await session.admit!();
        try {
          session.enrich({ documentId: change.document.id, markdown: 'ok', metadata: { todo: false } });
        } finally {
          release();
        }
        return 'done';
      },
    });
    const consumer = workerConsumerName(worker);
    for (const id of ['d1', 'd2', 'd3']) {
      // eslint-disable-next-line no-await-in-loop
      const d = (await store.read.search({ text: id }))[0];
      // eslint-disable-next-line no-await-in-loop
      await store.ledgerRecord(consumer, d.seq, 1, 'deferred');
    }
    await Promise.race([
      engineWith(admission).rerunDeferred(worker),
      new Promise((_, reject) => setTimeout(() => reject(new Error('deadlock')), 5_000)),
    ]);
    expect(admission.snapshot().running).toBe(0);
  });

  it('convert makes progress while two accounts backfill at cap 1', async () => {
    const acc = await seed(['c1'], { convertMe: true });
    const admission = cap1();
    const endless = (id: string): Source<string, DocumentInput> => ({
      descriptor: { id, name: id, documentTypes: ['note'], auth: 'none' },
      async connect() {
        return { identifier: `${id}@test` };
      },
      async *pull(session) {
        for (let i = 0; !session.signal.aborted; i += 1) {
          yield { phase: 'backfill', items: [doc(`${id}${i}`)], cursor: `${id}${i}` };
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 10));
        }
      },
      toDocument: (item) => item,
    });
    const a = endless('a');
    const b = endless('b');
    const engine = createEngine({
      store,
      sources: { get: (id) => (id === 'a' ? a : id === 'b' ? b : undefined) as Source | undefined },
      inference: { complete: async () => '', see: async () => '', read: async () => '', hear: async () => '' },
      convert: async (i) => i,
      logs: noopLogs,
      admission,
    });
    const conn = (s: Source) =>
      engine.connect(s, { oauth: async () => ({}), showQr: () => {}, prompt: async () => ({}), status: () => {}, pickFolders: async () => [] });
    const hA = engine.run(await conn(a as Source));
    const hB = engine.run(await conn(b as Source));
    const hW = engine.attach({
      name: 'conv',
      version: 1,
      matches: (c) => c.kind === 'document' && (c.document.metadata as { convertMe?: boolean }).convertMe === true,
      async work(change, session) {
        if (change.kind !== 'document') return 'skip';
        const release = await session.admit!();
        try {
          session.enrich({ documentId: change.document.id, markdown: 'converted', metadata: { convertMe: false } });
        } finally {
          release();
        }
        return 'done';
      },
    });
    await waitFor(async () => (await store.read.byExternalId(acc.id, 'c1', 'note'))?.markdown === 'converted', 25_000);
    await Promise.all([hA.stop(), hB.stop(), hW.stop()]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
npx jest src/main/core/__tests__/inference.test.ts --runInBand
npx jest src/main/core/engine/__tests__/sync-yields-engine.test.ts --runInBand
```

Expected: FAIL (`hasProvider` missing; one unbounded consumer commit with a cursor; `session.admit` undefined).

- [ ] **Step 3: Contracts and inference**

`src/shared/contracts.ts`, `WorkerSession`, after `mayBecomeReady`:

```ts
  /** Is a provider of `kind` ready right now? Cheap and synchronous. The
   *  vision worker renders VLM-only rasters at the VLM's edge when no `read`
   *  provider exists (#136-C). Absent = unknown: callers assume one exists. */
  hasProvider?(kind: 'see' | 'read'): boolean;
  /** Bundled workers only (#147 §2): wait for a background admission slot
   *  for ONE CPU-heavy step and resolve to its `release()`. Call it after
   *  the step's input is in hand — never across `fetchBytes`, a network
   *  wait or a retry backoff — and release in a `finally`. Absent = none. */
  admit?(): Promise<() => void>;
```

`src/main/core/inference.ts`: interface, next to `mayBecomeReady`:

```ts
  /** A ready LOCAL provider of `kind` exists (what `pick(kind)` without a
   *  task would find). Never throws. */
  hasProvider(kind: 'complete' | 'see' | 'read' | 'hear'): boolean;
```

implementation, next to `mayBecomeReady(kind) { … }`:

```ts
    hasProvider(kind) {
      return providers.some(
        (p) => !p.remote && p.supports.includes(kind) && p.status() === 'ready',
      );
    },
```

- [ ] **Step 4: Engine session**

`EngineDeps.inference` gains `hasProvider?(kind: 'see' | 'read'): boolean;` (next to `mayBecomeReady?`). `workOne`'s signature becomes

```ts
  const workOne = async (
    worker: Worker,
    change: Change,
    signal: AbortSignal,
    /** The unit kind a worker's `session.admit()` acquires here. */
    admitKind: 'convert' | 'redrive',
  ): Promise<{ … unchanged … }> => {
```

and the session literal gains, after `mayBecomeReady`:

```ts
        hasProvider: (kind) => deps.inference.hasProvider?.(kind) ?? true,
        admit: () => admission.acquire(admitKind, signal),
```

Call sites: `workOne(worker, change, abort.signal, 'convert')` in `attach`, `workOne(worker, change, abort.signal, 'redrive')` in `rerunDeferred`.

- [ ] **Step 5: `attach` flushes**

In `attach`'s per-batch body, replace `let emitted…; let enrich…; const clear: string[] = [];` with:

```ts
              let emitted: DocumentInput[] = [];
              let enrich: EnrichInput[] = [];
              let clear: string[] = [];
              let staged = 0;
```

and add, after `dropBatch`'s definition:

```ts
              /** One bounded consumer write (#147 §4), always an admitted
               *  `convert` unit — acquired right before the commit, released
               *  right after it — including the batch's final commit when it
               *  carries only the cursor (spec §4: every flush is admitted).
               *  `cursorAfter` only on that final commit: an intermediate
               *  flush leaves consumers.cursor untouched (CommitBatch
               *  contract). */
              const flush = async (cursorAfter?: Seq): Promise<void> => {
                const hasOutput =
                  emitted.length > 0 || enrich.length > 0 || clear.length > 0;
                if (!hasOutput && cursorAfter === undefined) return;
                let release: () => void;
                try {
                  release = await admission.acquire('convert', abort.signal);
                } catch (err) {
                  if (abort.signal.aborted) await dropBatch();
                  throw err;
                }
                try {
                  await store.commit({
                    consumer,
                    ...(cursorAfter !== undefined ? { cursor: cursorAfter } : {}),
                    documents: emitted.length ? emitted : undefined,
                    enrich: enrich.length ? enrich : undefined,
                    clearAttempts: clear.length ? clear : undefined,
                  });
                } finally {
                  release();
                }
                emitted = [];
                enrich = [];
                clear = [];
                staged = 0;
              };
```

Inside the `if (matched) { … }` block, after the existing `if (r.outcome === 'done' && change.kind === 'document') clear.push(change.document.id);` line, add:

```ts
                  staged +=
                    r.docs.reduce((n, d) => n + textBytes(d), 0) +
                    r.enrich.reduce((n, e) => n + textBytes(e), 0);
                  if (staged >= SUB_COMMIT_BYTES) await flush();
```

Replace the batch's closing `await store.commit({ consumer, cursor, documents…, enrich…, clearAttempts… });` with:

```ts
              await flush(cursor);
```

- [ ] **Step 6: `rerunDeferred` flushes**

Inside the per-page loop, replace `const emitted: DocumentInput[] = []; const enrich: EnrichInput[] = [];` and `const clear: string[] = [];` with `let` versions plus `let staged = 0;`, and add after them:

```ts
        /** Re-drive output, one admitted `redrive` unit per flush. NEVER a
         *  cursor: re-drive has none of its own, and writing the consumer's
         *  could rewind a live tail that advanced meanwhile (#147 §4). */
        const flush = async (): Promise<void> => {
          if (!emitted.length && !enrich.length && !clear.length) return;
          const release = await admission.acquire('redrive', abort.signal);
          try {
            await store.commit({
              consumer,
              documents: emitted.length ? emitted : undefined,
              enrich: enrich.length ? enrich : undefined,
              clearAttempts: clear.length ? clear : undefined,
            });
          } finally {
            release();
          }
          emitted = [];
          enrich = [];
          clear = [];
          staged = 0;
        };
```

In the per-change loop, after the `ledger.push({ seq: change.seq, attempts: r.attempts, outcome: r.outcome });`, add:

```ts
          staged +=
            r.docs.reduce((n, d) => n + textBytes(d), 0) +
            r.enrich.reduce((n, e) => n + textBytes(e), 0);
          // eslint-disable-next-line no-await-in-loop
          if (staged >= SUB_COMMIT_BYTES) await flush();
```

Replace the page's `if (emitted.length || enrich.length || clear.length) { await store.commit({ consumer, cursor: await store.consumerCursor(consumer), … }); }` block with:

```ts
        // eslint-disable-next-line no-await-in-loop
        await flush();
```

The `ledgerRecordMany` that follows stays where it is (after the page's last flush), so a ledger row still never says `done` before its output is durable.

Shutdown owns the re-drives (the scheduler's stop only clears its timer; a re-drive parked in `acquire` would otherwise resume after the store closed). In `createEngine`, next to `const running = new Map…`:

```ts
  /** Re-drives in flight: `stopAll` aborts and drains them (#147 §4). */
  const activeRedrives = new Set<{ abort: AbortController; done: Promise<void> }>();
  /** Set by `stopAll` before anything else: a scheduler callback that
   *  finished its deferred-work probe after shutdown began must not launch
   *  an untracked re-drive. Never cleared — `stopAll` is shutdown. */
  let stopping = false;
```

`rerunDeferred` registers itself around its existing body (the keyset loop is unchanged apart from the flush edits above):

```ts
    async rerunDeferred(worker: Worker): Promise<void> {
      if (stopping) return;
      const consumer = workerConsumerName(worker);
      const abort = new AbortController();
      let finished!: () => void;
      const entry = {
        abort,
        done: new Promise<void>((r) => {
          finished = r;
        }),
      };
      activeRedrives.add(entry);
      try {
        // …the existing `let after: Seq = 0; for (;;) { … }` loop, with the
        // flush edits above and the three abort checks below…
      } catch (err) {
        // Stopped mid-page: nothing of this page was recorded in the ledger,
        // so its entries stay 'deferred' for the next run.
        if (abort.signal.aborted) return;
        throw err;
      } finally {
        activeRedrives.delete(entry);
        finished();
      }
    },
```

Abort checks inside the keyset loop, so a backlog of non-matching or skipped entries (which never reaches `acquire`) still stops at once instead of scanning and writing ledger rows while shutdown waits:

```ts
      for (;;) {
        if (abort.signal.aborted) return; // between pages
        // eslint-disable-next-line no-await-in-loop
        const seqs = await store.ledgerDeferred(consumer, after, REDRIVE_PAGE);
        …
        for (const change of changes) {
          if (abort.signal.aborted) return; // between changes: no more work
          …
        }
        // eslint-disable-next-line no-await-in-loop
        await flush();
        if (abort.signal.aborted) return; // before the ledger write
        if (ledger.length) {
          // eslint-disable-next-line no-await-in-loop
          await store.ledgerRecordMany(consumer, ledger);
        }
      }
```

(A `return` inside the `try` still runs the `finally`, so the entry is removed and `done` settles.)

`stopAll`:

```ts
    async stopAll(): Promise<void> {
      stopping = true; // first: no re-drive may register from here on
      abortEvidenceReads();
      const redrives = [...activeRedrives];
      for (const r of redrives) r.abort.abort();
      await Promise.all([
        ...[...running.values()].map((h) => h.stop().catch(() => {})),
        ...redrives.map((r) => r.done),
      ]);
    },
```

- [ ] **Step 7: Run the tests**

```bash
for f in src/main/core/engine/__tests__/sync-yields-engine.test.ts src/main/core/__tests__/inference.test.ts \
  src/main/core/engine/__tests__/engine.test.ts src/main/core/engine/__tests__/feed-retry.test.ts \
  src/main/workers/convert/__tests__/convert-pipeline.test.ts; do npx jest "$f" --runInBand || break; done
```

Expected: PASS.

- [ ] **Step 8: Gates and commit**

```bash
npx eslint src/shared/contracts.ts src/main/core/inference.ts src/main/core/engine/engine.ts src/main/core/engine/__tests__/sync-yields-engine.test.ts src/main/core/__tests__/inference.test.ts
npx tsc --noEmit -p .
printf 'feat(engine): bounded, admitted consumer flushes (#147)\n\nattach flushes at 8 MiB (convert unit), intermediate flushes omit the\ncursor; rerunDeferred never writes a cursor (redrive unit). Sessions\ngain admit() and hasProvider().\n' > $SCRATCH/msg-t10.txt
git commit -F $SCRATCH/msg-t10.txt -- src/shared/contracts.ts src/main/core/inference.ts src/main/core/engine/engine.ts src/main/core/engine/__tests__/sync-yields-engine.test.ts src/main/core/__tests__/inference.test.ts
```

---

### Task 11: Engine reconcile — one admitted chunk per archive RPC

**Files:**
- Modify: `src/main/core/engine/engine.ts:265-374` (`reconcilePass` gains `admission`; the archive call becomes a chunk loop) and its call site `:1060-1080`
- Modify: `src/main/core/engine/__tests__/engine.test.ts:2365,2406,2432` (spies move to `reconcileArchiveChunk`)
- Test: append to `src/main/core/engine/__tests__/sync-yields-engine.test.ts`

**Interfaces:**
- Consumes: `CoreStore.reconcileArchiveChunk` (Task 8), `admission` (Task 9).
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Append to `sync-yields-engine.test.ts`, inside `describe('pull loop sub-commits (#147 §3/§4)', …)` (it reuses that describe's `store`, `makeEngine`, `live`):

```ts
  it('reconcile archives one admitted chunk per RPC and stops when done', async () => {
    const source: Source<string, DocumentInput> = {
      descriptor: { id: 'rec', name: 'rec', documentTypes: ['note'], auth: 'none' },
      async connect() {
        return { identifier: 'rec@test' };
      },
      async *pull() {
        /* nothing new upstream */
      },
      async *reconcile() {
        yield [{ externalId: 'a', type: 'note' }];
      },
      toDocument: (item) => item,
    };
    const acc = await store.createAccount({ source: 'rec', identifier: 'rec@test' });
    await store.commit({ account: acc.id, cursor: null, documents: ['a', 'b', 'c'].map((x) => doc(x)) });
    const kinds: string[] = [];
    const real = store.reconcileArchiveChunk.bind(store);
    let fake = 2;
    const chunk = jest.spyOn(store, 'reconcileArchiveChunk').mockImplementation(async (id, seq, limit) => {
      if (fake > 0) {
        fake -= 1;
        return { archived: 0, done: false };
      }
      return real(id, seq, limit);
    });
    const engine = makeEngine([source as never], {
      admission: {
        acquire: async (kind) => {
          kinds.push(kind);
          return () => {};
        },
      },
    });
    // Every run cycle of a source with reconcile() starts a pass (engine.ts
    // ~:1061); 2 of 3 missing is under MASS_ARCHIVE_MIN_DOCS, so no refusal.
    const h = engine.run((await store.account(acc.id))!);
    await waitFor(
      async () => (await store.read.byExternalId(acc.id, 'b', 'note'))?.archivedAt != null,
    );
    await h.stop();
    expect(chunk).toHaveBeenCalledTimes(3);
    expect(kinds.filter((k) => k === 'reconcile')).toHaveLength(3);
    expect((await store.read.byExternalId(acc.id, 'b', 'note'))?.archivedAt).not.toBeNull();
    expect((await store.read.byExternalId(acc.id, 'a', 'note'))?.archivedAt).toBeNull();
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/main/core/engine/__tests__/sync-yields-engine.test.ts -t 'reconcile archives' --runInBand`
Expected: FAIL (`reconcileArchiveChunk` never called; the engine still calls `reconcileArchive`).

- [ ] **Step 3: Implement**

`reconcilePass` gains a last parameter `admission: Pick<Admission, 'acquire'>`, and `await store.reconcileArchive(account.id, startSeq);` becomes:

```ts
    // One bounded archive transaction per RPC, each an admitted `reconcile`
    // unit (#147 §4): the DB worker serves requests in order, so a single
    // multi-chunk RPC would block every other writer until the whole cleanup
    // ended. The store ends the pass on the chunk that reports `done`; a DB
    // worker respawn mid-pass surfaces as "reconcile staging lost" (caught
    // below), never as a partial archive of a re-created staging table.
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const release = await admission.acquire('reconcile', signal);
      let done: boolean;
      try {
        // eslint-disable-next-line no-await-in-loop
        ({ done } = await store.reconcileArchiveChunk(account.id, startSeq));
      } finally {
        release();
      }
      if (done) break;
    }
```

(An abort rejects `acquire` with `AbortError`; the existing `catch` ends the pass and returns because `signal.aborted`.) At the call site in `run()`, pass `admission` as the new last argument after `allowance`.

In `src/main/core/engine/__tests__/engine.test.ts`, change the three `jest.spyOn(store, 'reconcileArchive')` to `jest.spyOn(store, 'reconcileArchiveChunk')` so their `not.toHaveBeenCalled()` assertions keep meaning "nothing archived".

- [ ] **Step 4: Run the tests**

```bash
npx jest src/main/core/engine/__tests__/sync-yields-engine.test.ts --runInBand
npx jest src/main/core/engine/__tests__/engine.test.ts --runInBand
```

Expected: PASS.

- [ ] **Step 5: Gates and commit**

```bash
npx eslint src/main/core/engine/engine.ts src/main/core/engine/__tests__/engine.test.ts src/main/core/engine/__tests__/sync-yields-engine.test.ts
npx tsc --noEmit -p .
printf 'feat(engine): reconcile archives in admitted one-transaction chunks (#147)\n' > $SCRATCH/msg-t11.txt
git commit -F $SCRATCH/msg-t11.txt -- src/main/core/engine/engine.ts src/main/core/engine/__tests__/engine.test.ts src/main/core/engine/__tests__/sync-yields-engine.test.ts
```

---
### Task 12: Workers parse and rasterise through the converter

**Files:**
- Modify: `src/main/workers/convert/convert-worker.ts:118-263` (deps `converter?`; signal-aware `parse` seam; fence removed; admit after fetch; failure mapping)
- Modify: `src/main/workers/vision/vision-worker.ts` (deps `parsePdfPages?`; `rasterFailure`; `vlmOnly` maxEdge; signals)
- Modify: `src/main/workers/vision/rasterize.ts:99-109` (`pickRasterizer(helper, platform, converter?)`)
- Modify: `src/main/workers/index.ts:35-41` (wire `platform.converter`)
- Test: `src/main/workers/convert/__tests__/convert-worker.test.ts` (replace the three `fence:` tests at `:397-438`; add new ones), `src/main/workers/vision/__tests__/vision-worker.test.ts` (append), `src/main/workers/vision/__tests__/rasterize.test.ts` (append), `src/main/core/engine/__tests__/sync-yields-engine.test.ts` (append), `src/main/core/converter/__tests__/vision-through-child.test.ts` (new)

**Interfaces:**
- Consumes: `Converter`, `ConverterCrashedError`, `ConverterTimeoutError`, `ConverterUnavailableError`, `ParseResult` (Task 4); `isAbortError` (Task 4); `WorkerSession.admit?` / `hasProvider?` (Task 10); `CorePlatform.converter` (Task 5); `VLM_MAX_EDGE` (`vision/downscale.ts`); `Rasterizer.pdfToPngs(bytes, { pages, maxEdge?, signal? })` (Task 3).
- Produces:
  - `createConvertWorker(deps?: { now?; converter?: Pick<Converter, 'parseDetailed'>; parse?: (bytes: Uint8Array, mime: string, filename?: string, signal?: AbortSignal) => Promise<ParseResult> })` — `parse` stays a test seam and wins over `converter`.
  - `createVisionWorker(deps: { …; parsePdfPages?: (bytes: Uint8Array, signal?: AbortSignal) => Promise<string[]> })`.
  - `pickRasterizer(helper: VisionHelper | null, platform = process.platform, converter?: Pick<Converter, 'rasterizePdf'>): Rasterizer`.

Spec test "a 10 s `fetchBytes` holds no slot" maps to the convert-worker test "admits only once the bytes are in hand" below (a pending fetch, then admit/parse/release in order).

Mapping (spec §1 table): convert worker — crash → `record('failed', { error: 'converter crashed' })`, timeout → `record('failed', { error: 'converter timed out' })`, unavailable / abort → `'defer'`, any other throw (the parser itself threw) → today's `record('failed', { error })`. Vision — crash or timeout in the window raster, the text-layer parse or the VLM image raster: `bump('raster')`; on the first, `'defer'`; once `> 1`, a metadata-only enrich `{ ocrProgress: undefined, extraction: { raster: 'failed', at } }` (no `markdown`) and `'done'`. Unavailable / abort → `'defer'`. `HelperTimeoutError` (macOS helper) keeps today's `'defer'`.

- [ ] **Step 1: Write the failing convert-worker tests**

In `src/main/workers/convert/__tests__/convert-worker.test.ts` add to the imports:

```ts
import {
  ConverterCrashedError,
  ConverterTimeoutError,
  ConverterUnavailableError,
} from '@main/core/converter/converter';
import { abortError } from '@main/core/abort';
```

Delete the three tests whose names start with `fence:` (`:397-438`) and put these in their place (same `describe`, so `MiB`, `tinyPdf` and `pdfDoc` are in scope):

```ts
  it('no crash fence any more: a large PDF parses on every attempt', async () => {
    const parse = jest.fn(async () => ({ markdown: 'parsed text from the large pdf' }));
    const s = fakeSession(async () => tinyPdf('x'), { bump: async () => 9 });
    await createConvertWorker({ parse }).work(change(pdfDoc(40 * MiB)), s);
    expect(parse).toHaveBeenCalledTimes(1);
    expect(s.enriched[0].metadata.conversion.status).toBe('ok');
  });
  it.each([
    [new ConverterCrashedError('x'), 'converter crashed'],
    [new ConverterTimeoutError('x'), 'converter timed out'],
  ])('a converter %p records failed with a fixed reason', async (err, reason) => {
    const s = fakeSession(async () => tinyPdf('x'));
    const out = await createConvertWorker({
      parse: async () => {
        throw err;
      },
    }).work(change(pdfDoc(1024)), s);
    expect(out).toBe('done');
    expect(s.enriched[0].metadata.conversion).toMatchObject({ status: 'failed', error: reason });
  });
  it.each([[new ConverterUnavailableError('x')], [abortError()]])(
    '%p defers and writes nothing',
    async (err) => {
      const s = fakeSession(async () => tinyPdf('x'));
      const out = await createConvertWorker({
        parse: async () => {
          throw err;
        },
      }).work(change(pdfDoc(1024)), s);
      expect(out).toBe('defer');
      expect(s.enriched).toHaveLength(0);
    },
  );
  it('admits only once the bytes are in hand, releases after the parse, and passes the signal', async () => {
    const events: string[] = [];
    let fetched!: (b: Uint8Array) => void;
    const ac = new AbortController();
    const s = fakeSession(
      () => {
        events.push('fetch');
        return new Promise<Uint8Array>((r) => {
          fetched = r;
        });
      },
      {
        signal: ac.signal,
        admit: async () => {
          events.push('admit');
          return () => events.push('release');
        },
      },
    );
    let seen: AbortSignal | undefined;
    const run = createConvertWorker({
      parse: async (_b, _m, _n, signal) => {
        seen = signal;
        events.push('parse');
        return { markdown: 'text' };
      },
    }).work(change(pdfDoc(1024)), s);
    await new Promise((r) => setTimeout(r, 50)); // a slow fetch holds no slot
    expect(events).toEqual(['fetch']);
    fetched(tinyPdf('x'));
    await run;
    expect(events).toEqual(['fetch', 'admit', 'parse', 'release']);
    expect(seen).toBe(ac.signal);
  });
  it('releases the slot when the parse throws', async () => {
    const release = jest.fn();
    const s = fakeSession(async () => tinyPdf('x'), { admit: async () => release });
    await createConvertWorker({
      parse: async () => {
        throw new ConverterCrashedError('x');
      },
    }).work(change(pdfDoc(1024)), s);
    expect(release).toHaveBeenCalledTimes(1);
  });
  it('uses deps.converter when no parse seam is given', async () => {
    const parseDetailed = jest.fn(async () => ({ markdown: 'from the child' }));
    const s = fakeSession(async () => tinyPdf('x'));
    await createConvertWorker({ converter: { parseDetailed } }).work(change(pdfDoc(1024)), s);
    expect(parseDetailed).toHaveBeenCalledTimes(1);
    expect(s.enriched[0].markdown).toBe('from the child');
  });
```

(`pdfDoc(size)` is that `describe`'s helper: `big.pdf`, `application/pdf`, the given declared size.)

- [ ] **Step 2: Run to verify they fail**

Run: `npx jest src/main/workers/convert/__tests__/convert-worker.test.ts --runInBand`
Expected: FAIL (the fence still records `failed` at `bump > 2`; converter errors become `failed` with `String(err)`; `admit` is never called).

- [ ] **Step 3: Implement the convert worker**

`src/main/workers/convert/convert-worker.ts` imports, replacing `parseDetailed as realParse,` in the `@main/core/engine/convert` import with nothing (keep the other names) and adding:

```ts
import { isAbortError } from '@main/core/abort';
import {
  ConverterCrashedError,
  ConverterTimeoutError,
  ConverterUnavailableError,
  createInlineConverter,
  type Converter,
  type ParseResult,
} from '@main/core/converter/converter';
```

Deps and parse selection:

```ts
export function createConvertWorker(
  deps: {
    now?: () => Date;
    /** The crash-isolated converter (CorePlatform.converter). Absent =
     *  in-process parsers (tests, KIA_CONVERTER_INLINE hosts that pass none). */
    converter?: Pick<Converter, 'parseDetailed'>;
    /** Test seam only; wins over `converter`. */
    parse?: (
      bytes: Uint8Array,
      mime: string,
      filename?: string,
      signal?: AbortSignal,
    ) => Promise<ParseResult>;
  } = {},
): Worker {
  const now = deps.now ?? (() => new Date());
  const converter = deps.converter ?? createInlineConverter();
  const parse =
    deps.parse ??
    ((bytes: Uint8Array, mime: string, filename?: string, signal?: AbortSignal) =>
      converter.parseDetailed(bytes, mime, filename, signal));
```

Replace everything from the comment `// Crash fence AFTER the bytes arrive…` through the end of the `catch` of the parse (`return record('failed', { error: String(err) }); }`) with:

```ts
      const large =
        Math.max(declared ?? 0, bytes.length) > MAX_LOCAL_BINARY_BYTES;
      // No crash fence: the parse runs in the kia-converter child (#136), so
      // a hostile file can no longer take main down. The slot is taken only
      // now — the bytes are in hand — and covers the parse alone.
      let res: ParseResult;
      const release = (await session.admit?.()) ?? (() => {});
      try {
        res = await parse(bytes, str(meta.mime) ?? '', name, session.signal);
      } catch (err) {
        // Transient: the child could not start, or this run was cancelled.
        if (err instanceof ConverterUnavailableError || isAbortError(err))
          return 'defer';
        if (err instanceof ConverterCrashedError)
          return record('failed', { error: 'converter crashed' });
        if (err instanceof ConverterTimeoutError)
          return record('failed', { error: 'converter timed out' });
        session.log(
          'warn',
          `parse failed for ${name ?? doc.id}: ${String(err)}`,
        );
        return record('failed', { error: String(err) });
      } finally {
        release();
      }
```

`res` is used unchanged below. The file no longer calls `session.bump`; leave `version: 2` (no replay is wanted: documents the fence recorded `failed` stay failed, as spec §1 deletes only the fence).

- [ ] **Step 4: Run the convert-worker suites**

```bash
for f in src/main/workers/convert/__tests__/convert-worker.test.ts src/main/workers/convert/__tests__/convert-pipeline.test.ts; do npx jest "$f" --runInBand || break; done
```

Expected: PASS.

- [ ] **Step 5: Write the failing vision tests**

`src/main/workers/vision/__tests__/vision-worker.test.ts`, imports:

```ts
import {
  ConverterCrashedError,
  ConverterTimeoutError,
  ConverterUnavailableError,
} from '@main/core/converter/converter';
import { VLM_MAX_EDGE } from '../downscale';
```

Append:

```ts
describe('converter failures (#136 §1)', () => {
  const needsOcrDoc = () =>
    change({
      markdown: 'layer text that must survive',
      metadata: {
        ...baseDoc.metadata,
        conversion: { status: 'needs-ocr', pages: [2], quality: 1 },
        ocrProgress: { pageCount: 3, pages: { '1': 'partial' } },
      },
    });
  const failing = (err: Error): Rasterizer => ({
    pdfToPngs: jest.fn(async () => {
      throw err;
    }),
  });

  it.each([[new ConverterCrashedError('x')], [new ConverterTimeoutError('x')]])(
    'raster %p: first attempt defers, the second writes a metadata-only marker',
    async (err) => {
      let n = 0;
      const worker = createVisionWorker({ rasterizer: failing(err), laneOpen: () => true });
      const s1 = fakeSession({ bump: async () => (n += 1) });
      expect(await worker.work(needsOcrDoc(), s1)).toBe('defer');
      expect(s1.enriched).toHaveLength(0);
      const s2 = fakeSession({ bump: async () => (n += 1) });
      expect(await worker.work(needsOcrDoc(), s2)).toBe('done');
      expect(s2.enriched).toHaveLength(1);
      const e = s2.enriched[0];
      expect('markdown' in e).toBe(false);
      expect(e.metadata.extraction.raster).toBe('failed');
      expect('ocrProgress' in e.metadata && e.metadata.ocrProgress === undefined).toBe(true);
    },
  );
  it('a text-layer parse crash takes the same path', async () => {
    const rasterizer: Rasterizer = {
      pdfToPngs: async (_b, { pages }) => ({
        pageCount: 3,
        pages: pages.map((p) => ({ page: p, png: new Uint8Array([p]) })),
      }),
    };
    const worker = createVisionWorker({
      rasterizer,
      laneOpen: () => true,
      parsePdfPages: async () => {
        throw new ConverterCrashedError('x');
      },
    });
    const s = fakeSession({ bump: async () => 2 });
    expect(await worker.work(needsOcrDoc(), s)).toBe('done');
    expect(s.enriched[0].metadata.extraction.raster).toBe('failed');
    expect('markdown' in s.enriched[0]).toBe(false);
  });
  it('converter unavailable defers without counting', async () => {
    const bump = jest.fn(async () => 5);
    const worker = createVisionWorker({
      rasterizer: failing(new ConverterUnavailableError('x')),
      laneOpen: () => true,
    });
    const s = fakeSession({ bump });
    expect(await worker.work(needsOcrDoc(), s)).toBe('defer');
    expect(bump).not.toHaveBeenCalled();
    expect(s.enriched).toHaveLength(0);
  });
  it('no read provider: rasters render at the VLM edge (window and VLM images)', async () => {
    const calls: Array<{ pages: number[]; maxEdge?: number }> = [];
    const rasterizer: Rasterizer = {
      pdfToPngs: async (_b, { pages, maxEdge }) => {
        calls.push({ pages, maxEdge });
        return { pageCount: 2, pages: pages.map((p) => ({ page: p, png: new Uint8Array([p]) })) };
      },
    };
    const s = fakeSession({
      hasProvider: (kind) => kind !== 'read',
      read: async () => {
        throw new NoProviderError('read');
      },
    });
    await createVisionWorker({ rasterizer, laneOpen: () => true }).work(change({}), s);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const c of calls) expect(c.maxEdge).toBe(VLM_MAX_EDGE);
  });
  it('with a read provider the OCR window renders full size (no maxEdge)', async () => {
    const calls: Array<number | undefined> = [];
    const rasterizer: Rasterizer = {
      pdfToPngs: async (_b, { pages, maxEdge }) => {
        calls.push(maxEdge);
        return { pageCount: 1, pages: pages.map((p) => ({ page: p, png: new Uint8Array([p]) })) };
      },
    };
    const s = fakeSession({ hasProvider: () => true });
    await createVisionWorker({ rasterizer, laneOpen: () => true }).work(change({}), s);
    expect(calls[0]).toBeUndefined();
  });
});
```

`src/main/workers/vision/__tests__/rasterize.test.ts`, inside `describe('pickRasterizer', …)`:

```ts
    it('off darwin, a converter rasterises (with maxEdge and signal)', async () => {
      const result = { pageCount: 1, pages: [] };
      const converter = { rasterizePdf: jest.fn(async () => result) };
      const signal = new AbortController().signal;
      const r = await pickRasterizer(null, 'win32', converter).pdfToPngs(new Uint8Array([1]), {
        pages: [1],
        maxEdge: 896,
        signal,
      });
      expect(r).toBe(result);
      expect(converter.rasterizePdf).toHaveBeenCalledWith(new Uint8Array([1]), [1], { maxEdge: 896, signal });
    });
    it('darwin with the native helper ignores the converter', async () => {
      const helper: VisionHelper = { rasterizePdf: jest.fn(async () => ({ pageCount: 1, pages: [] })) };
      const converter = { rasterizePdf: jest.fn() };
      await pickRasterizer(helper, 'darwin', converter).pdfToPngs(new Uint8Array([1]), { pages: [1] });
      expect(converter.rasterizePdf).not.toHaveBeenCalled();
    });
```

Append to `src/main/core/engine/__tests__/sync-yields-engine.test.ts`, inside `describe('pull loop sub-commits (#147 §3/§4)', …)` (add `import { ConverterCrashedError } from '../../converter/converter';`, `import { createVisionWorker } from '../../../workers/vision/vision-worker';` and `import { multiPagePdf, PROSE_LINES } from './pdf-fixture';`):

```ts
  it('a needs-ocr PDF whose raster keeps crashing stays searchable by its text layer', async () => {
    const pdfBytes = multiPagePdf([{ text: PROSE_LINES }, { scan: true }]);
    const source: Source<string, DocumentInput> = {
      descriptor: { id: 'files', name: 'files', documentTypes: ['attachment'], auth: 'none' },
      async connect() {
        return { identifier: 'files@test' };
      },
      async *pull() {},
      toDocument: (i) => i,
      fetchBytes: async () => pdfBytes,
    };
    const engine = makeEngine([source as never]);
    const acc = await store.createAccount({ source: 'files', identifier: 'files@test' });
    await store.commit({
      account: acc.id,
      cursor: null,
      documents: [
        {
          externalId: 'scan.pdf',
          type: 'attachment',
          title: 'scan.pdf',
          markdown: 'zebracorn layer text',
          metadata: {
            mime: 'application/pdf',
            filename: 'scan.pdf',
            sizeBytes: pdfBytes.length,
            conversion: { status: 'needs-ocr', pages: [2], quality: 1 },
          },
          createdAt: null,
        },
      ],
    });
    const worker = createVisionWorker({
      rasterizer: {
        pdfToPngs: async () => {
          throw new ConverterCrashedError('pdfium died');
        },
      },
      laneOpen: () => true,
    });
    const h = engine.attach(worker);
    await waitFor(async () => (await store.ledgerCounts(workerConsumerName(worker))).deferred === 1);
    await h.stop();
    await engine.rerunDeferred(worker);
    const d = await store.read.byExternalId(acc.id, 'scan.pdf', 'attachment');
    expect(d?.markdown).toBe('zebracorn layer text');
    expect((d?.metadata as { extraction?: { raster?: string } }).extraction?.raster).toBe('failed');
    expect('ocrProgress' in (d?.metadata ?? {})).toBe(false);
    expect((await store.read.search({ text: 'zebracorn' })).map((x) => x.id)).toEqual([d!.id]);
  });
```

(`workerConsumerName` is already imported from Task 10; `store.ledgerCounts(consumer)` returns `{ done, skip, failed, deferred }`.)

Create `src/main/core/converter/__tests__/vision-through-child.test.ts`:

```ts
/**
 * @jest-environment node
 */
import path from 'node:path';

import type { Change, Document, WorkerSession } from '@shared/contracts';

import { createWorkerEnv, REPO_ROOT } from '../../../db/__tests__/worker-test-env';
import { multiPagePdf } from '../../engine/__tests__/pdf-fixture';
import { forkRunnerChild } from '../../mcp/sql-runner-spawn';
import { pickRasterizer } from '../../../workers/vision/rasterize';
import { createVisionWorker } from '../../../workers/vision/vision-worker';
import { createConverterRunner } from '../runner';

jest.setTimeout(240_000);

const ENTRY = path.join(REPO_ROOT, 'src', 'main', 'converter', 'worker.ts');

it('windowed OCR of a 25-page scanned PDF completes every window through the child', async () => {
  const env = createWorkerEnv('vision-child');
  const converter = createConverterRunner({
    spawn: () => forkRunnerChild(ENTRY, { execArgv: env.execArgv, cwd: REPO_ROOT, serialization: 'advanced' }),
    startTimeoutMs: 90_000,
  });
  try {
    const bytes = multiPagePdf(Array.from({ length: 25 }, () => ({ scan: true })));
    const worker = createVisionWorker({
      rasterizer: pickRasterizer(null, 'linux', converter),
      laneOpen: () => true,
      parsePdfPages: (b, s) => converter.parsePdfPages(b, s),
    });
    let doc = {
      id: 'd', accountId: 'a', externalId: 'x', type: 'attachment', title: 'scan.pdf', markdown: null,
      metadata: { mime: 'application/pdf', sizeBytes: bytes.length, conversion: { status: 'text-poor' } },
      createdAt: null, parentId: null, contentHash: 'h', seq: 1, ingestSeq: 1, archivedAt: null,
      languages: [], ingestedAt: '2026-01-01', updatedAt: '2026-01-01', scopeRootId: null,
    } as Document;
    const reads: number[] = [];
    for (let run = 0; run < 5; run += 1) {
      const enriched: Array<{ markdown?: string; metadata?: Record<string, unknown> }> = [];
      const session = {
        signal: new AbortController().signal,
        read: async (png: Uint8Array) => {
          reads.push(png.length);
          return 'recognised words on this page '.repeat(3);
        },
        fetchBytes: async () => bytes,
        bump: async () => 1,
        mayBecomeReady: () => false,
        hasProvider: () => true,
        enrich: (e: { markdown?: string; metadata?: Record<string, unknown> }) => enriched.push(e),
        log: () => {},
      } as unknown as WorkerSession;
      // eslint-disable-next-line no-await-in-loop
      expect(await worker.work({ seq: run + 1, kind: 'document', document: doc } as Change, session)).toBe('done');
      const e = enriched[0];
      doc = { ...doc, markdown: e.markdown ?? doc.markdown, metadata: JSON.parse(JSON.stringify({ ...doc.metadata, ...e.metadata })) };
      if ((doc.metadata as { extraction?: unknown }).extraction) break;
    }
    expect(reads).toHaveLength(25);
    expect((doc.metadata as { extraction?: { engine?: string } }).extraction?.engine).toBe('local-ocr');
    expect(converter.stats().crashes).toBe(0);
  } finally {
    await converter.stop();
    env.cleanup();
  }
});
```

- [ ] **Step 6: Run to verify they fail**

```bash
for f in src/main/workers/vision/__tests__/vision-worker.test.ts src/main/workers/vision/__tests__/rasterize.test.ts \
  src/main/core/engine/__tests__/sync-yields-engine.test.ts src/main/core/converter/__tests__/vision-through-child.test.ts; do
  npx jest "$f" --runInBand; done
```

Expected: FAIL (crash errors are rethrown; no `parsePdfPages` dep; `pickRasterizer` ignores a third argument).

- [ ] **Step 7: Implement `pickRasterizer`**

`src/main/workers/vision/rasterize.ts`:

```ts
import type { Converter } from '@main/core/converter/converter';

/** macOS with the native helper: the helper (unchanged). Everywhere else:
 *  the kia-converter child when one is given (#136-C), so the pdfium render,
 *  BGRA swap and PNG encode run off main; the in-process WASM path only for
 *  tests and hosts that pass none. */
export function pickRasterizer(
  helper: VisionHelper | null,
  platform = process.platform,
  converter?: Pick<Converter, 'rasterizePdf'>,
): Rasterizer {
  if (platform === 'darwin' && helper) {
    return {
      pdfToPngs: (bytes, { pages }) => helper.rasterizePdf(bytes, pages),
    };
  }
  if (converter)
    return {
      pdfToPngs: (bytes, { pages, maxEdge, signal }) =>
        converter.rasterizePdf(bytes, pages, { maxEdge, signal }),
    };
  return wasmRasterizer();
}
```

- [ ] **Step 8: Implement the vision worker**

`src/main/workers/vision/vision-worker.ts` imports: change `import { capMarkdown, parsePdfPages } from '@main/core/engine/convert';` to `import { capMarkdown, parsePdfPages as inlinePdfPages } from '@main/core/engine/convert';` and add:

```ts
import { isAbortError } from '@main/core/abort';
import {
  ConverterCrashedError,
  ConverterTimeoutError,
  ConverterUnavailableError,
} from '@main/core/converter/converter';
import { passthroughDownscaler, VLM_MAX_EDGE, type ImageDownscaler } from './downscale';
```

(replacing the existing `./downscale` import line).

Deps gain (next to `downscale?`):

```ts
  /** The text-layer parse of a needs-ocr PDF. Production passes the
   *  converter child's; default = in-process (tests). */
  parsePdfPages?: (bytes: Uint8Array, signal?: AbortSignal) => Promise<string[]>;
```

At the top of `createVisionWorker`'s body:

```ts
  const parsePdfPages = deps.parsePdfPages ?? ((b: Uint8Array) => inlinePdfPages(b));

  /** The converter failed on this doc's PDF (#136 §1). Transient failures
   *  (child unavailable, cancelled) defer and never count. A crash or a
   *  timeout counts; from the second one the doc gets a metadata-only
   *  marker: its existing markdown (a needs-ocr text layer) and its index
   *  survive, partial OCR is dropped, and the run is `done` — never a throw,
   *  so the engine does not re-run fetch + raster three more times.
   *  `null` = not a converter failure; the caller keeps its own handling. */
  async function rasterFailure(
    session: WorkerSession,
    documentId: string,
    err: unknown,
  ): Promise<WorkOutcome | null> {
    if (err instanceof ConverterUnavailableError || isAbortError(err))
      return 'defer';
    if (
      !(err instanceof ConverterCrashedError) &&
      !(err instanceof ConverterTimeoutError)
    )
      return null;
    if ((await session.bump('raster')) <= 1) return 'defer';
    cache = null;
    session.enrich({
      documentId,
      metadata: {
        ocrProgress: undefined,
        extraction: { raster: 'failed', at: new Date().toISOString() },
      },
    });
    return 'done';
  }
```

`vlmPass` gains a first-position-after-session parameter `documentId: string`, and its images catch becomes:

```ts
    try {
      pageImages = await images();
    } catch (err) {
      return (await rasterFailure(session, documentId, err)) ?? 'defer';
    }
```

Update both `vlmPass(session, …)` calls in `workOne` to `vlmPass(session, doc.id, …)`.

In `workOne`, after `const listed = …;` add:

```ts
    // #136-C: when no OCR provider exists the rasters feed the VLM alone, so
    // pdfium renders straight at the VLM's edge (no 2× render + downscale).
    // OCR keeps full-size pages. Absent probe = assume OCR exists.
    const vlmOnly = !listed && session.hasProvider?.('read') === false;
    const maxEdge = vlmOnly ? VLM_MAX_EDGE : undefined;
```

The window raster becomes:

```ts
      try {
        raster = await deps.rasterizer.pdfToPngs(bytes, {
          pages: next,
          maxEdge,
          signal: session.signal,
        });
      } catch (err) {
        const failed = await rasterFailure(session, doc.id, err);
        if (failed) return failed;
        // A demoted raster helper past its deadline is load, not a bad PDF:
        // defer (re-driven when idle) instead of exhausting engine retries.
        if (err instanceof HelperTimeoutError) return 'defer';
        throw err;
      }
```

The text layer becomes:

```ts
      try {
        layer = cache?.layer ?? (await parsePdfPages(bytes, session.signal));
      } catch (err) {
        return (await rasterFailure(session, doc.id, err)) ?? 'defer';
      }
```

And the VLM `images` raster:

```ts
    const images = async (): Promise<VlmImage[]> =>
      (
        await deps.rasterizer.pdfToPngs(pdfBytes, {
          pages: first,
          maxEdge,
          signal: session.signal,
        })
      ).pages.map((p) => ({ page: p.page, bytes: p.png, mime: 'image/png' }));
```

`vlmPass` still runs `downscale` on every image; on a `maxEdge` render it is a no-op-sized resize (the page is already ≤ 896).

- [ ] **Step 9: Wire `workers/index.ts`**

```ts
  attachWorker(platform, createConvertWorker({ converter: platform.converter }));

  const worker = createVisionWorker({
    rasterizer: pickRasterizer(deps.visionHelper, process.platform, platform.converter),
    laneOpen: () => backgroundLaneOpen(platform),
    downscale: deps.downscale,
    parsePdfPages: (bytes, signal) => platform.converter.parsePdfPages(bytes, signal),
    foregroundIdle: (signal) => platform.admission.foregroundIdle(signal),
  });
```

(`foregroundIdle` is Task 7's line, kept.) The fake platforms in `attach-bundled-workers.test.ts` / `redrive.test.ts` are cast `as never` and have no `converter`: that is fine — `platform.converter` is read lazily (`parsePdfPages`) or passed as `undefined` (in-process fallback in `pickRasterizer` and `createConvertWorker`), so those fixtures need no change.

- [ ] **Step 10: Run the tests**

```bash
for f in src/main/workers/vision/__tests__/vision-worker.test.ts src/main/workers/vision/__tests__/rasterize.test.ts \
  src/main/workers/convert/__tests__/convert-worker.test.ts src/main/workers/__tests__/attach-bundled-workers.test.ts \
  src/main/workers/__tests__/redrive.test.ts src/main/core/engine/__tests__/sync-yields-engine.test.ts \
  src/main/core/converter/__tests__/vision-through-child.test.ts; do npx jest "$f" --runInBand || break; done
```

Expected: PASS.

- [ ] **Step 11: Gates and commit**

```bash
npx eslint src/main/workers src/main/core/engine/__tests__/sync-yields-engine.test.ts src/main/core/converter/__tests__/vision-through-child.test.ts
npx tsc --noEmit -p .
printf 'feat(workers): convert + vision go through the converter child (#136)\n\nConvert worker: no crash fence; admit after fetch; crash/timeout\nrecord failed, unavailable/abort defer. Vision: raster and text layer\nin the child; second crash/timeout writes a metadata-only marker; VLM-only\nrasters render at the VLM edge.\n' > $SCRATCH/msg-t12.txt
git add src/main/core/converter/__tests__/vision-through-child.test.ts
git commit -F $SCRATCH/msg-t12.txt -- src/main/workers src/main/core/engine/__tests__/sync-yields-engine.test.ts src/main/core/converter/__tests__/vision-through-child.test.ts
```

---
### Task 13: Foreground sources — MCP tool calls, `callTool`, `resources/read`, renderer reads

**Files:**
- Modify: `src/main/core/mcp/registry.ts:118-149` (`attachToolHandlers` 6th param `foreground?`)
- Modify: `src/main/core/mcp/resources.ts:23-53` (`attachResourceHandlers` 3rd param `foreground?`)
- Modify: `src/main/core/mcp/server.ts:50` (`McpDeps.admission?`), `:328-339` (pass it), `:585-600` (`callTool` wrapped)
- Modify: `src/main/main.ts:613-615` (renderer reads), `:1015` (`startMcp({ …, admission: p.admission })`)
- Test: `src/main/core/mcp/__tests__/foreground.test.ts` (new)

**Interfaces:**
- Consumes: `inForeground(admission, fn)` and `Admission.foreground()` / `snapshot()` (Task 6); `CorePlatform.admission` (Task 7).
- Produces:
  - `type Foreground = <T>(fn: () => Promise<T>) => Promise<T>` exported from `registry.ts`.
  - `attachToolHandlers(mcp, registry, logSink, onActivity?, allow?, foreground?: Foreground)`.
  - `attachResourceHandlers(mcp, query, foreground?: Foreground)`.
  - `McpDeps.admission?: Pick<Admission, 'foreground'>`.

The stdio sibling (`src/main/mcp/stdio-entry.ts`) is a separate process with no admission; it passes nothing and is unchanged. `tools/list` and `resources/templates/list` are not foreground (they read no corpus).

- [ ] **Step 1: Write the failing test**

Create `src/main/core/mcp/__tests__/foreground.test.ts`:

```ts
/** @jest-environment node */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { McpTool, Query } from '@shared/contracts';

import { openDb } from '../../../db/app-db';
import { createAdmission } from '../../admission';
import { attachToolHandlers, createToolRegistry } from '../registry';
import { attachResourceHandlers } from '../resources';
import { startMcp } from '../server';
import { createTestSqlExecutor } from './helpers/sql-executor';

const idleLane = {
  processing: () => ({ enabled: true, window: 'always' as const }),
  env: () => ({ onBattery: false, userActive: false }),
  weak: () => false,
  syncing: () => false,
};
const admission = () => createAdmission({ slots: 1, userActive: () => false, enrichment: idleLane });

function capture() {
  const handlers: Array<(req: unknown) => Promise<unknown>> = [];
  const mcp = {
    server: {
      setRequestHandler: (_s: unknown, fn: (req: unknown) => Promise<unknown>) => handlers.push(fn),
      getClientVersion: () => ({ name: 'test', version: '1' }),
    },
  } as never;
  return { mcp, handlers };
}

function fakeQuery(over: Partial<Query> = {}): Query {
  return {
    async document() {
      return null;
    },
    async children() {
      return [];
    },
    async byExternalId() {
      return null;
    },
    async search() {
      return [];
    },
    async count() {
      return 0;
    },
    async countBy() {
      return [];
    },
    async accounts() {
      return [];
    },
    ...over,
  };
}

const probeTool = (a: ReturnType<typeof admission>, seen: number[], fail = false): McpTool => ({
  name: 'probe',
  description: '',
  inputSchema: {},
  call: async () => {
    seen.push(a.snapshot().foregroundInFlight);
    if (fail) throw new Error('boom');
    return 'ok';
  },
});

describe('foreground entry/exit (#147 §2)', () => {
  it.each([false, true])('tools/call is foreground for its whole run (throws: %p)', async (fail) => {
    const a = admission();
    const seen: number[] = [];
    const { mcp, handlers } = capture();
    attachToolHandlers(
      mcp,
      createToolRegistry([probeTool(a, seen, fail)]),
      { log: () => {} } as never,
      undefined,
      undefined,
      (fn) => (async () => {
        const leave = a.foreground();
        try {
          return await fn();
        } finally {
          leave();
        }
      })(),
    );
    await handlers[1]({ params: { name: 'probe', arguments: {} } });
    expect(seen).toEqual([1]);
    expect(a.snapshot().foregroundInFlight).toBe(0);
  });

  it.each([false, true])('resources/read is foreground (throws: %p)', async (fail) => {
    const a = admission();
    const seen: number[] = [];
    const { mcp, handlers } = capture();
    attachResourceHandlers(
      mcp,
      fakeQuery({
        document: async () => {
          seen.push(a.snapshot().foregroundInFlight);
          if (fail) throw new Error('boom');
          return null;
        },
      }),
      (fn) => (async () => {
        const leave = a.foreground();
        try {
          return await fn();
        } finally {
          leave();
        }
      })(),
    );
    await handlers[2]({ params: { uri: 'doc://x' } }).catch(() => {});
    expect(seen).toEqual([1]);
    expect(a.snapshot().foregroundInFlight).toBe(0);
  });

  it('startMcp wires admission: callTool runs in foreground and leaves on throw', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-fg-'));
    const seed = await openDb(path.join(dir, 'kiagent.db'));
    await seed.close();
    const a = admission();
    const handle = await startMcp({
      query: fakeQuery(),
      sqlExecutor: createTestSqlExecutor(path.join(dir, 'kiagent.db')),
      logSink: { log: () => {} },
      dataDir: dir,
      portCandidates: [0],
      admission: a,
    });
    try {
      const seen: number[] = [];
      handle.registerTool(probeTool(a, seen, true));
      const out = await handle.callTool('probe', {}, { transport: 'agent', allowTools: ['probe'], client: 't' });
      expect(out.ok).toBe(false);
      expect(seen[0]).toBeGreaterThanOrEqual(1);
      expect(a.snapshot().foregroundInFlight).toBe(0);
    } finally {
      await handle.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

(`handlers[2]` is `resources/read`: `attachResourceHandlers` registers list, templates, read in that order.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/main/core/mcp/__tests__/foreground.test.ts --runInBand`
Expected: FAIL (`seen` is `[0]`: the extra parameters are ignored; `admission` is not an `McpDeps` key → tsc error under ts-jest).

- [ ] **Step 3: Implement**

`src/main/core/mcp/registry.ts`:

```ts
/** Runs `fn` as foreground work (#147 §2): background units wait while any
 *  is in flight. Bound to the app's admission by startMcp; absent in the
 *  stdio sibling, which has none. */
export type Foreground = <T>(fn: () => Promise<T>) => Promise<T>;
```

`attachToolHandlers` gains, after `allow?: ReadonlySet<string>,`:

```ts
  foreground?: Foreground,
```

and its call handler body becomes:

```ts
  mcp.server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const call = () =>
      invokeTool(
        registry,
        logSink,
        req.params.name,
        (req.params.arguments ?? {}) as Record<string, unknown>,
        mcp.server.getClientVersion()?.name ?? null,
        onActivity,
        allow,
      );
    const out = await (foreground ? foreground(call) : call());
    // isError (not a thrown protocol error) so the calling LLM sees the
    // real message instead of a generic JSON-RPC failure.
    return out.ok
      ? { content: [{ type: 'text', text: JSON.stringify(out.result) }] }
      : { isError: true, content: [{ type: 'text', text: out.error }] };
  });
```

`src/main/core/mcp/resources.ts`: `import type { Foreground } from './registry';`, signature `export function attachResourceHandlers(mcp: McpServer, query: Query, foreground?: Foreground): void {`, and the read handler:

```ts
  mcp.server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const { uri } = req.params;
    const m = /^doc:\/\/(.+)$/.exec(uri);
    if (!m) throw new Error(`bad resource uri: ${uri}`);
    const read = () => query.document(m[1] as DocumentId);
    const doc = await (foreground ? foreground(read) : read());
    if (!doc) throw new Error(`not found: ${uri}`);
    return {
      contents: [{ uri, mimeType: 'text/markdown', text: doc.markdown ?? '' }],
    };
  });
```

`src/main/core/mcp/server.ts`: imports `import { inForeground, type Admission } from '../admission';` and `type Foreground` from `./registry`. `McpDeps` gains:

```ts
  /** The app's admission owner (#147 §2): every tools/call, resources/read
   *  and in-process callTool runs as foreground work. Absent in tests and
   *  hosts without one. */
  admission?: Pick<Admission, 'foreground'>;
```

Inside `startMcp`, before the session factory:

```ts
  const foreground: Foreground = (fn) => inForeground(deps.admission, fn);
```

Pass it: `attachToolHandlers(server, registry, deps.logSink, (rec) => …, allow, foreground);` and `attachResourceHandlers(server, deps.query, foreground);` (the one session-server call site at `:328-339`). `callTool` becomes:

```ts
    callTool(name, args, opts) {
      return runWithTransport(opts.transport, () =>
        foreground(() =>
          invokeTool(
            registry,
            deps.logSink,
            name,
            args,
            opts.client,
            (rec) =>
              deps.onActivity?.({
                ...rec,
                transport: activityTransport(currentTransport()),
              }),
            new Set(opts.allowTools),
          ),
        ),
      );
    },
```

`src/main/main.ts` — add `import { inForeground } from './core/admission';` and change the renderer reads:

```ts
    // Renderer reads are foreground (#147 §2): sync units wait meanwhile.
    'search:query': (req) =>
      inForeground(p.admission, () => p.readsFor('renderer').search(req ?? {})),
    'docs:get': ({ id }) =>
      inForeground(p.admission, () => p.readsFor('renderer').document(id)),
    'docs:children': ({ id }) =>
      inForeground(p.admission, () => p.readsFor('renderer').children(id)),
```

and add `admission: p.admission,` to the `startMcp({ … })` call at `:1015`.

- [ ] **Step 4: Run the tests**

```bash
for f in src/main/core/mcp/__tests__/foreground.test.ts src/main/core/mcp/__tests__/registry.test.ts \
  src/main/core/mcp/__tests__/mcp-session-factory.test.ts src/main/core/mcp/__tests__/latency-probe.test.ts; do
  npx jest "$f" --runInBand || break; done
```

Expected: PASS. Also run the reads gate: `npx jest $(git ls-files 'src/**/reads-no-queue*.test.ts') --runInBand`.

- [ ] **Step 5: Gates and commit**

```bash
npx eslint src/main/core/mcp src/main/main.ts
npx tsc --noEmit -p .
printf 'feat(mcp): tool calls, resource reads and renderer reads are foreground (#147)\n' > $SCRATCH/msg-t13.txt
git add src/main/core/mcp/__tests__/foreground.test.ts
git commit -F $SCRATCH/msg-t13.txt -- src/main/core/mcp/registry.ts src/main/core/mcp/resources.ts src/main/core/mcp/server.ts src/main/main.ts src/main/core/mcp/__tests__/foreground.test.ts
```

---

### Task 14: Diagnostics — event-loop delay, admission snapshot, converter stats

**Files:**
- Create: `src/main/core/event-loop-monitor.ts`
- Modify: `src/main/core/read-diagnostics.ts` (`ReadDiagnostics` gains `eventLoop`, `admission`, `converter`; `buildReadDiagnostics` deps gain them)
- Modify: `src/main/core/boot.ts:316-321` (`readDiagnostics` wiring), `shutdown` (stop the monitor), the monitor start after the logs sink exists
- Test: `src/main/core/__tests__/event-loop-monitor.test.ts` (new), `src/main/core/__tests__/read-diagnostics.test.ts` (append)

**Interfaces:**
- Consumes: `AdmissionSnapshot` (Task 6), `ConverterStats` (Task 4).
- Produces:
  ```ts
  export interface EventLoopWindow { p50Ms: number; p99Ms: number; maxMs: number; samples: number; at: number }
  export interface EventLoopMonitor { last(): EventLoopWindow | null; stop(): void }
  export function startEventLoopMonitor(deps: {
    log(level: 'warn', msg: string): void;
    windowMs?: number;          // default 60_000
    warnP99Ms?: number;         // default 250
    histogram?: HistogramLike;  // default monitorEventLoopDelay({ resolution: 20 })
    setInterval?(fn: () => void, ms: number): unknown;
    clearInterval?(t: unknown): void;
    now?(): number;
  }): EventLoopMonitor;
  ```
  `ReadDiagnostics.eventLoop: EventLoopWindow | null`, `.admission: AdmissionSnapshot | null`, `.converter: ConverterStats | null`.

- [ ] **Step 1: Write the failing tests**

Create `src/main/core/__tests__/event-loop-monitor.test.ts`:

```ts
/** @jest-environment node */
import { startEventLoopMonitor, type HistogramLike } from '../event-loop-monitor';

function fakeHistogram(values: { p50: number; p99: number; max: number; count: number }) {
  const h: HistogramLike & { resets: number; enabled: boolean } = {
    resets: 0,
    enabled: false,
    enable() {
      h.enabled = true;
    },
    disable() {
      h.enabled = false;
    },
    reset() {
      h.resets += 1;
    },
    percentile: (p: number) => (p === 50 ? values.p50 : values.p99),
    get max() {
      return values.max;
    },
    get count() {
      return values.count;
    },
  };
  return h;
}

it('reports each window in ms, resets the histogram, and warns above the p99 threshold', () => {
  const ms = 1e6;
  const h = fakeHistogram({ p50: 3 * ms, p99: 300 * ms, max: 900 * ms, count: 40 });
  let tick!: () => void;
  const warns: string[] = [];
  const m = startEventLoopMonitor({
    log: (_l, msg) => warns.push(msg),
    histogram: h,
    setInterval: (fn) => {
      tick = fn;
      return 1;
    },
    clearInterval: () => {},
    now: () => 5_000,
  });
  expect(h.enabled).toBe(true);
  expect(m.last()).toBeNull();
  tick();
  expect(m.last()).toEqual({ p50Ms: 3, p99Ms: 300, maxMs: 900, samples: 40, at: 5_000 });
  expect(h.resets).toBe(1);
  expect(warns).toHaveLength(1);
  expect(warns[0]).toMatch(/p99 300 ms/);
  m.stop();
  expect(h.enabled).toBe(false);
});

it('an empty window reports zeros and never warns', () => {
  const h = fakeHistogram({ p50: Number.NaN, p99: Number.NaN, max: 0, count: 0 });
  let tick!: () => void;
  const warns: string[] = [];
  const m = startEventLoopMonitor({
    log: (_l, msg) => warns.push(msg),
    histogram: h,
    setInterval: (fn) => {
      tick = fn;
      return 1;
    },
    clearInterval: () => {},
    now: () => 1,
  });
  tick();
  expect(m.last()).toEqual({ p50Ms: 0, p99Ms: 0, maxMs: 0, samples: 0, at: 1 });
  expect(warns).toHaveLength(0);
  m.stop();
});

it('the real histogram measures a blocked loop', async () => {
  let tick!: () => void;
  const m = startEventLoopMonitor({
    log: () => {},
    setInterval: (fn) => {
      tick = fn;
      return 1;
    },
    clearInterval: () => {},
  });
  await new Promise((r) => setTimeout(r, 50));
  const until = Date.now() + 120;
  while (Date.now() < until) {
    /* block the loop */
  }
  await new Promise((r) => setTimeout(r, 50));
  tick();
  expect(m.last()!.maxMs).toBeGreaterThanOrEqual(80);
  m.stop();
});
```

`src/main/core/__tests__/read-diagnostics.test.ts`, inside `describe('buildReadDiagnostics', …)`:

```ts
  it('carries the event-loop window, the admission snapshot and converter stats (null when absent)', async () => {
    const eventLoop = { p50Ms: 1, p99Ms: 2, maxMs: 3, samples: 4, at: 5 };
    const admission = { slots: 1, running: 0 } as never;
    const converter = { mode: 'child', jobs: 3 } as never;
    const d = await buildReadDiagnostics({
      stats: stats(),
      walPath: '/x',
      statFile: async () => ({ size: 0 }),
      eventLoop: () => eventLoop,
      admission: () => admission,
      converter: () => converter,
    });
    expect(d.eventLoop).toBe(eventLoop);
    expect(d.admission).toBe(admission);
    expect(d.converter).toBe(converter);
    const bare = await buildReadDiagnostics({ stats: stats(), walPath: '/x', statFile: async () => ({ size: 0 }) });
    expect([bare.eventLoop, bare.admission, bare.converter]).toEqual([null, null, null]);
  });
```

- [ ] **Step 2: Run to verify they fail**

```bash
npx jest src/main/core/__tests__/event-loop-monitor.test.ts --runInBand
npx jest src/main/core/__tests__/read-diagnostics.test.ts --runInBand
```

Expected: FAIL (module not found; unknown properties).

- [ ] **Step 3: Implement `src/main/core/event-loop-monitor.ts`**

```ts
/**
 * Main-thread event-loop delay, in 60 s windows (#147 §6): the number the
 * sync-yields work exists to move. p50/p99/max of the last window go into
 * readDiagnostics() and the KIA_READ_DIAG_FILE dump; a window whose p99
 * exceeds 250 ms logs one warning.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';

/** The slice of perf_hooks' IntervalHistogram this module reads (ns). */
export interface HistogramLike {
  enable(): void;
  disable(): void;
  reset(): void;
  percentile(p: number): number;
  readonly max: number;
  readonly count: number;
}

export interface EventLoopWindow {
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
  samples: number;
  /** ms epoch the window closed. */
  at: number;
}

export interface EventLoopMonitor {
  last(): EventLoopWindow | null;
  stop(): void;
}

const NS_PER_MS = 1e6;
const toMs = (ns: number) =>
  Number.isFinite(ns) ? Math.round((ns / NS_PER_MS) * 10) / 10 : 0;

export function startEventLoopMonitor(deps: {
  log(level: 'warn', msg: string): void;
  windowMs?: number;
  warnP99Ms?: number;
  histogram?: HistogramLike;
  setInterval?(fn: () => void, ms: number): unknown;
  clearInterval?(t: unknown): void;
  now?(): number;
}): EventLoopMonitor {
  const h = deps.histogram ?? monitorEventLoopDelay({ resolution: 20 });
  const windowMs = deps.windowMs ?? 60_000;
  const warnP99Ms = deps.warnP99Ms ?? 250;
  const now = deps.now ?? Date.now;
  const every =
    deps.setInterval ??
    ((fn: () => void, ms: number) => {
      const t = setInterval(fn, ms);
      t.unref?.();
      return t;
    });
  const cancel =
    deps.clearInterval ??
    ((t: unknown) => clearInterval(t as ReturnType<typeof setInterval>));
  let last: EventLoopWindow | null = null;
  h.enable();
  const timer = every(() => {
    const samples = h.count;
    last =
      samples > 0
        ? {
            p50Ms: toMs(h.percentile(50)),
            p99Ms: toMs(h.percentile(99)),
            maxMs: toMs(h.max),
            samples,
            at: now(),
          }
        : { p50Ms: 0, p99Ms: 0, maxMs: 0, samples: 0, at: now() };
    h.reset();
    if (last.p99Ms > warnP99Ms)
      deps.log(
        'warn',
        `event loop p99 ${last.p99Ms} ms (max ${last.maxMs} ms) over the last ${windowMs / 1000} s`,
      );
  }, windowMs);
  return {
    last: () => last,
    stop() {
      cancel(timer);
      h.disable();
    },
  };
}
```

- [ ] **Step 4: Extend `read-diagnostics.ts`**

```ts
import type { AdmissionSnapshot } from './admission';
import type { ConverterStats } from './converter/converter';
import type { EventLoopWindow } from './event-loop-monitor';

export interface ReadDiagnostics {
  /** Includes `reads.fuzzyRuns`: the reader's cumulative fuzzy-pass executions. */
  reads: ReadStatsSnapshot;
  sql: SqlRunnerDiagnostics | null;
  walBytes: number | null;
  /** Last closed 60 s window of main-thread event-loop delay (#147 §6). */
  eventLoop: EventLoopWindow | null;
  /** Foreground in flight, waiting/running units, waits, escapes, holds. */
  admission: AdmissionSnapshot | null;
  /** kia-converter jobs, crashes, timeouts, cancels, p95. */
  converter: ConverterStats | null;
}
```

`buildReadDiagnostics` deps gain `eventLoop?: () => EventLoopWindow | null; admission?: () => AdmissionSnapshot; converter?: () => ConverterStats;` and the return adds:

```ts
    eventLoop: deps.eventLoop?.() ?? null,
    admission: deps.admission?.() ?? null,
    converter: deps.converter?.() ?? null,
```

- [ ] **Step 5: Wire boot**

`src/main/core/boot.ts`: `import { startEventLoopMonitor } from './event-loop-monitor';`. Right after `setChildPriorityLog(…)` (`:247`):

```ts
  const eventLoop = startEventLoopMonitor({
    log: (level, msg) => sink.log('event-loop', level, msg),
  });
```

`readDiagnostics` becomes:

```ts
    readDiagnostics: (sql) =>
      buildReadDiagnostics({
        stats: readPlane.stats,
        walPath: `${dbPath}-wal`,
        sql,
        eventLoop: () => eventLoop.last(),
        admission: () => admission.snapshot(),
        converter: () => converter.stats(),
      }),
```

and `shutdown` starts with `eventLoop.stop();`. `bootCore` has no failure cleanup to extend; the interval is `unref`'d, so a boot that throws after the monitor starts never holds the process open.

- [ ] **Step 6: Run the tests**

```bash
for f in src/main/core/__tests__/event-loop-monitor.test.ts src/main/core/__tests__/read-diagnostics.test.ts \
  src/main/core/__tests__/boot-lane.test.ts src/main/core/mcp/__tests__/latency-probe.test.ts; do npx jest "$f" --runInBand || break; done
```

Expected: PASS. (The latency-probe suite reads the dump file; the new keys are additive.)

- [ ] **Step 7: Gates and commit**

```bash
npx eslint src/main/core/event-loop-monitor.ts src/main/core/read-diagnostics.ts src/main/core/boot.ts src/main/core/__tests__/event-loop-monitor.test.ts src/main/core/__tests__/read-diagnostics.test.ts
npx tsc --noEmit -p .
printf 'feat(diagnostics): event-loop delay, admission and converter in readDiagnostics (#147)\n' > $SCRATCH/msg-t14.txt
git add src/main/core/event-loop-monitor.ts src/main/core/__tests__/event-loop-monitor.test.ts
git commit -F $SCRATCH/msg-t14.txt -- src/main/core/event-loop-monitor.ts src/main/core/read-diagnostics.ts src/main/core/boot.ts src/main/core/__tests__/event-loop-monitor.test.ts src/main/core/__tests__/read-diagnostics.test.ts
```

---

### Task 15: Measurement — full gates, bundle smoke, before/after acceptance runs

**Files:**
- No source changes expected. If a gate fails, fix it in the task that owns the code and commit that fix with its own message.

Steps 1–4 are for the implementer. Steps 5–8 are **manual steps for the controller** (founder Mac and Windows VM); the implementer stops after Step 4 and reports.

- [ ] **Step 1: Full jest, compared against the base**

```bash
HEAVY=/private/tmp/claude-501/-Users-edjafarov-work-alpha-cent/4c50a2e2-79f9-4098-aef4-8a2c75761c3a/scratchpad/opt/heavy.sh
$HEAVY npx jest --runInBand --silent 2>&1 | tee $SCRATCH/jest-after.txt | tail -40
```

Expected: every suite passes. A suite that fails only with a jest-worker SIGSEGV at teardown is the known better-sqlite3 issue: check it out at the base (`git worktree add $SCRATCH/base v0.106.0`, symlink `node_modules` as the worktree recipe says, run that one file there) and treat it as pre-existing only if it fails the same way at the base. Remove that worktree afterwards (unlink `node_modules` first). The #146 suites (`src/main/core/mcp/__tests__/sql-runner*.test.ts`) and `reads-no-queue` must be green.

- [ ] **Step 2: Lint and types**

```bash
npm run lint
npx tsc --noEmit -p .
```

Expected: both clean.

- [ ] **Step 3: Bundle check for `worker.js` (never into the shared dist)**

The prod webpack config deletes `*.js.map` in the shared dist when it loads, so the check uses the **dev** config with its entry narrowed to `worker` and its output redirected to the scratchpad:

```bash
mkdir -p $SCRATCH/webpack-worker
cat > $SCRATCH/webpack-worker/config.ts <<'EOF'
import path from 'path';
import base from '/Users/edjafarov/work/kcore-sync/.erb/configs/webpack.config.main.dev';

const entry = (base.entry as Record<string, unknown>).worker;
if (!entry) throw new Error('dev config has no `worker` entry');
export default {
  ...base,
  entry: { worker: entry },
  output: { ...base.output, path: path.join(process.env.SCRATCH!, 'webpack-worker', 'out') },
  plugins: (base.plugins ?? []).filter((p) => p?.constructor?.name !== 'BundleAnalyzerPlugin'),
};
EOF
cd ~/work/kcore-sync && SCRATCH=$SCRATCH TS_NODE_PROJECT=$HOME/work/kcore-sync/tsconfig.json $HEAVY npx cross-env NODE_ENV=development TS_NODE_TRANSPILE_ONLY=true NODE_OPTIONS="-r ts-node/register --no-warnings" webpack --config $SCRATCH/webpack-worker/config.ts
ls -la $SCRATCH/webpack-worker/out
```

(The dev config's other plugins are harmless here: `copySharedCssPlugin` writes relative to the overridden output path, and the analyzer is filtered out. Never use the prod config: it deletes `*.js.map` in the shared dist at load.)

Expected: `worker.bundle.dev.js` exists in `$SCRATCH/webpack-worker/out`, and `git status` in `~/work/kiagent-core` shows no change to its `dist` / `release/app/dist`.

- [ ] **Step 4: Smoke the bundle as a child**

```bash
cat > $SCRATCH/webpack-worker/smoke.cjs <<'EOF'
const { fork } = require('child_process');
const path = require('path');
const bundle = path.join(process.env.SCRATCH, 'webpack-worker', 'out', 'worker.bundle.dev.js');
const child = fork(bundle, [], { serialization: 'advanced', stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
const t = setTimeout(() => { console.error('TIMEOUT'); child.kill('SIGKILL'); process.exit(1); }, 60000);
child.on('message', (m) => {
  if (m && m.t === 'ready') {
    child.send({ id: 1, op: 'parseDetailed', bytes: new Uint8Array(Buffer.from('<h1>Hello</h1><p>bundle smoke</p>')), mime: 'text/html', filename: 'a.html' });
  } else if (m && m.id === 1) {
    console.log(JSON.stringify(m));
    clearTimeout(t);
    child.kill();
    process.exit(m.ok && /bundle smoke/.test(m.result.markdown) ? 0 : 1);
  }
});
EOF
NODE_PATH=$HOME/work/kiagent-core/node_modules:$HOME/work/kiagent-core/release/app/node_modules node $SCRATCH/webpack-worker/smoke.cjs
```

Expected: one JSON line with `"ok":true` and markdown containing `bundle smoke`; exit 0. Report Steps 1–4 to the controller and stop.

- [ ] **Step 5 (MANUAL — controller): stage the change into a test build**

Release/tag core from `opt/sync`, pin it in alpha-cent on a branch, and build per the release runbook (one heavy step at a time: docker → mac → smoke mac → smoke win). The release smoke **must** load `worker.js` (the converter): add a stage or check its log for a `kia-converter` spawn and one successful parse. Builds and smokes run sequentially, never in parallel.

- [ ] **Step 6 (MANUAL — controller): founder Mac, before and after**

For the current release (before) and the test build (after), each on the same profile and corpus:

```bash
# after build: launch with the dump on, then validate the workload once
KIA_READ_DIAG_FILE=/tmp/kia-read-diag.json <launch the app>
node scripts/mcp-latency-probe.mjs --url http://127.0.0.1:7421/mcp --diag /tmp/kia-read-diag.json --ids ids.json --validate-only
# idle baseline, then the same during each scenario
node scripts/mcp-latency-probe.mjs --url http://127.0.0.1:7421/mcp --cycles 24 --interval 5000 --label idle --out idle.json --diag /tmp/kia-read-diag.json --ids ids.json
node scripts/mcp-latency-probe.mjs --url http://127.0.0.1:7421/mcp --cycles 24 --interval 5000 --label during-sync --out during-sync.json --diag /tmp/kia-read-diag.json --baseline idle.json --ids ids.json
```

The before build (v0.106.0 pin) has no `eventLoop`/`admission`/`converter` diagnostics: run its probe with `--ids ids.json` and NO `--diag`, as the probe's header documents.

Scenarios, each recorded with the probe output plus `/tmp/kia-diag.json` (`eventLoop`, `admission`, `converter`):
1. Local folder in watch mode (edit/add files) while Gmail backfills.
2. Convert progress during a multi-account backfill at cap 1 (`KIA_HOST_WEAK=1`): the convert worker's ledger `done` count must rise during the backfill.
3. A remote MCP burst during a vision backlog.

- [ ] **Step 7 (MANUAL — controller): Windows VM (`ssh win`), before and after**

The same three scenarios, plus "16-core Windows desktop throughput" (`ingestSlots` must be 2: check the host line in the log), comparing idle throughput (documents/min during a Drive backfill) before vs after.

- [ ] **Step 8 (MANUAL — controller): acceptance**

Pass when all hold, after vs before:
- `eventLoop.p99Ms` during sync < 100 ms on the Mac and < 250 ms on Windows.
- MCP p95 during sync ≤ 1.5 × the idle p95 on each machine.
- Ingest throughput on an idle machine within 10 % of before.
- `converter.crashes` / `timeouts` explained by named documents, and no permanent markers from `ConverterUnavailableError`.

Record the numbers in the PR description; a miss sends the controller back to the owning task, not to tuning constants blindly.
