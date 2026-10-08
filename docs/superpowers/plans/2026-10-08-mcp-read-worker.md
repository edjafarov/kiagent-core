# MCP Read Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MCP and renderer foreground reads (search / get / count / get_related / digital_memory_info) run on a dedicated read-only DB worker thread and never queue behind ingest writes, and `query_sql` runs in a killable child process with a 10 s time bound and a byte-bounded result (#146).

**Architecture:** The 8-method read surface leaves `store.ts` and becomes `createCorpusQuery(db)` (`core/store/corpus-query.ts`), one implementation used by the writer, a new `role: 'read'` of the existing DB worker, and the stdio sibling. Main holds a thin `createReadProxy` wrapped by `withWriterFallback`; `CorePlatform.reads` / `readsFor(caller)` is the foreground read path. `query_sql` moves to a separate `sqlRunner` process owned by the MCP server, driven by a state machine (`none → starting → ready → stopping → none`, plus `stuck`) over an injectable spawn adapter.

**Tech Stack:** TypeScript, Electron main + `worker_threads` + `utilityProcess`, better-sqlite3 12.11 (SQLite 3.53.2, FTS5), Node `child_process` (tests), jest, webpack (`.erb/configs`).

**Spec:** `docs/superpowers/specs/2026-10-08-mcp-read-worker-design.md` (APPROVED rev 5, binding). Issue #146; related #145 (released v0.104.0), #147.

**Plan rev 1.**

## Global Constraints

- Repo: kiagent-core worktree `~/work/kcore-read`, branch `design/mcp-read-worker` (core v0.104.0 `c369815d` + spec commits). All paths below are relative to it. `node_modules` is already present; do not run `npm ci`.
- Pre-flight (before Task 1): jest's setup file (`.erb/scripts/check-build-exists.ts`) aborts without `release/app/dist/main/main.js` and `release/app/dist/renderer/renderer.js`; both exist in this worktree today. Run `npx jest src/main/core/store/__tests__/fuzzy.test.ts` once — it must pass; if the setup file aborts, run the build it names (`npm run build:main` / `npm run build:renderer`) and retry.
- Run jest as `npx jest <paths>`; typecheck `npx tsc -p tsconfig.typecheck.json`; lint `npx eslint --fix <files>`. One heavy command at a time — never run builds/tests in parallel. Worker/child tests spawn ts-node and take 10-30 s each; set `jest.setTimeout(60_000)` in those files.
- **Every task's last run step ends with `npx tsc -p tsconfig.typecheck.json` clean and `npx eslint --fix` on the touched files before its commit.** Each task must leave the tree typechecking.
- Commits: `git commit -F <msgfile> -- <paths>`; messages are conventional, end with `(#146)`, and carry NO Co-Authored-By line. Never `git stash`, `--amend`, rebase, reset, or `--no-verify`. Never dispatch subagents.
- Test files that need node start with `/** @jest-environment node */`. Worker-thread / child-process tests run the TS SOURCE under ts-node with `execArgv: ['--no-experimental-strip-types','-r',<preload.js>,'-r','ts-node/register/transpile-only','-r','tsconfig-paths/register']` (the preload redirects `better-sqlite3` to the repo-root copy); Task 3 creates the shared helper `src/main/db/__tests__/worker-test-env.ts`.
- Constants (verbatim from the spec): `FUZZY_CANDIDATES = 100`; reader `cacheKiB` 8192 normally and 2048 when `hostBudget(host, null).weak`; `PRAGMA query_only = ON`, `busy_timeout = 5000`, `cache_size = -cacheKiB`, `mmap_size = 0`; recency snippet head `substr(d.markdown, 1, 65536)`; `query_sql` values cut at 64 KiB (UTF-8 bytes) with `…[truncated]`, stop at 500 rows or 1 MiB of serialized rows array (brackets and commas included); runner `createSqlRunner({ spawn, timeoutMs: 10_000, idleMs: 300_000 })`, SIGTERM then SIGKILL after 2 s, `stuck` when no exit 5 s after SIGKILL; stats window = last 256 calls.
- Copy (verbatim): timeout `query_sql stopped after 10 s. Narrow it: filter by account or created_at, avoid LIKE over markdown, or use search.`; during stop `query_sql is still stopping the previous query. Try again in a few seconds.`; otherwise `query_sql is unavailable right now.`; reader open failure log `[db] read worker unavailable: <message> — reads use the writer`.
- Failure semantics: `DB_WORKER_CRASHED` or `DB_WORKER_DEAD` rejections from the reader are retried ONCE on the writer; `DB_WORKER_DEAD` also makes the router sticky-writer. SQL errors propagate unchanged. `query_sql` NEVER falls back to main or the writer.
- Writer pragmas and write procedures are untouched. Extension `query` slice, engine, message evidence, outbound send, factory reset, boot/diagnostics keep `store.read`.

## Review Focus

1. A document whose `commit` promise already resolved (or one in a language the reader has never seen, e.g. the first German mail after an English-only corpus) must be found by the very next MCP `search` through the reader — stale language cache or a snapshot older than the commit would silently lose it. (Tests: Task 1 data_version tests; Task 5 end-to-end read-after-write + new-language test.)
2. Account-restricted or archived-heavy fuzzy (trigram) searches: another account's 150 newest matches, or 110 newest archived matches, must not crowd out the restricted account's / live documents' hits. (Task 2.)
3. Reader failures mid-session: open failure at boot, worker crash during a call, crash-loop exhaustion with callers parked, and an ordinary SQL error (must NOT trigger fallback or be swallowed). (Task 4, plus open failure in Task 5.)
4. `query_sql` runaway or oversized work: a non-yielding aggregate, a child that ignores SIGTERM, 500 rows of multi-MB cells, a child that crashes — the process must really be gone, the caller must get the specified message, the next call must work. (Task 6.)
5. Negated-term fuzzy queries and large-document snippets: `rechnung -spam` must still drop fuzzy hits containing the negated term (substring, folded) while no body is read when there is no negation, and a recency snippet over a 150 KB document must be head-limited, not loaded whole. (Task 2.)

---

## File Structure

| File | Responsibility |
|---|---|
| `src/main/core/store/rows.ts` (new) | `DocRow`, `AccountRow`, `toDocument`, `toAccount` (moved out of `store.ts`; `store.ts` re-exports the types) |
| `src/main/core/store/fts-query.ts` (new) | `ftsQuery` boolean-grammar compiler (moved verbatim) |
| `src/main/core/store/line-window.ts` (new) | line-window snippet builder moved from `mcp/tools/search.ts` (`extractWindowTerms`, `clampLine`, `buildLineWindow`) |
| `src/main/core/store/corpus-query.ts` (new) | `createCorpusQuery(db, opts)`, `QUERY_METHODS`, `accountsFrom`, `CORPUS_LANGUAGES_SQL`, the new fuzzy pass + projections |
| `src/main/core/store/fuzzy.ts` | pure fuzzy helpers; `rrfMerge` deleted; `FUZZY_CANDIDATES`, `fuzzyCandidatesSql`, `rankFuzzyCandidates`, `pickFuzzyWinners` added |
| `src/main/core/store/read-proxy.ts` (new) | `queryFromInvoker`, `createReadStats`, `createReadProxy`, `withWriterFallback` |
| `src/main/core/reads.ts` (new) | `openReads` — opens the reader worker, wires proxy + fallback, owns close |
| `src/main/core/read-diagnostics.ts` (new) | `buildReadDiagnostics`, `startReadDiagnosticsDump` |
| `src/main/db/app-db.ts` | `openCorpusReadConnection(path, { cacheKiB?, queryOnly? })` |
| `src/main/db/worker-client.ts` | `OpenDbInWorkerOptions.role/cacheKiB` → `workerData` |
| `src/main/db/worker-entry.ts` | `role: 'read'` branch registering only the `read` procedure |
| `src/main/core/mcp/tools/query-sql.ts` | byte/row/value-bounded `runQuerySqlBounded`; `QuerySqlExecutor` type |
| `src/main/core/mcp/sql-runner.ts` (new) | `createSqlRunner` state machine, `RunnerChild`, messages, diagnostics |
| `src/main/core/mcp/sql-runner-spawn.ts` (new) | `forkRunnerChild` (child_process) and `utilityRunnerChild` (Electron) adapters |
| `src/main/core/mcp/sql-runner-entry.ts` (new) | the child process entry (webpack entry `sqlRunner`) |
| `src/main/core/mcp/tools/raw-sql.ts` | `createRawSqlTools(exec)`, `createInProcessSqlExecutor` |
| `src/main/core/mcp/server.ts` | `McpDeps.sqlExecutor`, `sqlDiagnostics()`, `stop()` stops the executor |
| `src/main/mcp/stdio-entry.ts` | `createCorpusQuery` + in-process executor |
| `src/main/core/boot.ts`, `src/main/main.ts` | wiring + routing |
| `.erb/configs/webpack.config.main.{prod,dev}.ts` | `sqlRunner` entry |
| `scripts/mcp-latency-probe.mjs` (new) | external MCP latency probe |

Task order: 1 → 2 → 3 (uses 1) → 4 (uses 1) → 5 (uses 3, 4) → 6 → 7 (uses 4, 5, 6) → 8 → 9 → 10 → 11.

---

### Task 1: `createCorpusQuery` extraction + `data_version` language cache

Behaviour-preserving move of the read surface out of `store.ts` (spec §3.2), plus the cache mode readers need.

**Files:**
- Create: `src/main/core/store/rows.ts`, `src/main/core/store/fts-query.ts`, `src/main/core/store/corpus-query.ts`
- Modify: `src/main/core/store/store.ts`
- Test: `src/main/core/store/__tests__/corpus-query.test.ts`

**Interfaces:**
- Produces:
  - `QUERY_METHODS = ['document','documentPage','children','byExternalId','search','count','countBy','accounts'] as const`; `type QueryMethod`.
  - `interface CorpusQueryOptions { languageCache?: 'explicit' | 'data-version' }` (default `'explicit'`).
  - `interface CorpusQuery { query: Query; invalidateLanguages(): void }`.
  - `createCorpusQuery(db: AppDb, opts?: CorpusQueryOptions): CorpusQuery`.
  - `accountsFrom(reader: AppDb): Promise<Account[]>`, `CORPUS_LANGUAGES_SQL` (still re-exported from `store.ts`).
  - `rows.ts`: `DocRow`, `AccountRow`, `toDocument`, `toAccount` (types still importable from `./store`).

- [ ] **Step 1: Write the failing test** — `src/main/core/store/__tests__/corpus-query.test.ts`

```ts
/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { AccountId } from '@shared/contracts';

import {
  openCorpusReadConnection,
  openDb,
  type AppDb,
} from '../../../db/app-db';
import {
  CORPUS_LANGUAGES_SQL,
  createCorpusQuery,
  QUERY_METHODS,
} from '../corpus-query';
import { openStore, type CoreStore } from '../store';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: (text: string) =>
    /[äöüß]|Rechnung/i.test(text) ? ['deu'] : ['eng'],
};

describe('createCorpusQuery', () => {
  let dir: string;
  let dbPath: string;
  let writerDb: AppDb;
  let store: CoreStore;
  let accountId: AccountId;
  let readDb: AppDb | undefined;

  const commitDoc = (externalId: string, markdown: string) =>
    store.commit({
      account: accountId,
      cursor: null,
      documents: [
        {
          externalId,
          type: 'note',
          title: `T ${externalId}`,
          markdown,
          metadata: {},
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
    });

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-corpus-query-'));
    dbPath = path.join(dir, 'test.db');
    writerDb = await openDb(dbPath);
    store = openStore(writerDb, deps);
    accountId = (
      await store.createAccount({ source: 'test', identifier: 'me@example.com' })
    ).id;
  });

  afterEach(async () => {
    if (readDb) await readDb.close();
    readDb = undefined;
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('exposes exactly the QUERY_METHODS surface', () => {
    const { query } = createCorpusQuery(writerDb);
    expect(Object.keys(query).sort()).toEqual([...QUERY_METHODS].sort());
  });

  it('data-version mode: a second connection sees a language added by the writer', async () => {
    await commitDoc('en1', 'we run daily');
    readDb = await openCorpusReadConnection(dbPath);
    const { query } = createCorpusQuery(readDb, {
      languageCache: 'data-version',
    });
    // Fills the cache with { eng } only.
    expect(await query.search({ text: 'Rechnungen' })).toHaveLength(0);
    await commitDoc('de1', 'Die Rechnung ist offen');
    // German is now in the corpus: the inflected query must stem to it.
    expect(await query.search({ text: 'Rechnungen' })).toHaveLength(1);
  });

  it('data-version mode: a fill that started before a commit is recomputed after it', async () => {
    await commitDoc('en1', 'we run daily');
    readDb = await openCorpusReadConnection(dbPath);
    const real = readDb;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let started!: () => void;
    const startedP = new Promise<void>((r) => {
      started = r;
    });
    // Holds the languages lookup open AFTER its rows were read, so the
    // writer's commit lands between "fill started" and "fill stored".
    const slow = {
      ...real,
      all: async (sql: string, params?: never) => {
        const rows = await real.all(sql, params);
        if (sql === CORPUS_LANGUAGES_SQL) {
          started();
          await gate;
        }
        return rows;
      },
    } as AppDb;
    const { query } = createCorpusQuery(slow, { languageCache: 'data-version' });
    const first = query.search({ text: 'Rechnungen' });
    await startedP;
    await commitDoc('de1', 'Die Rechnung ist offen');
    release();
    await first; // may legitimately be stale
    expect(await query.search({ text: 'Rechnungen' })).toHaveLength(1);
  });

  it('explicit mode keeps the cache until invalidateLanguages()', async () => {
    await commitDoc('en1', 'we run daily');
    const calls: string[] = [];
    const spy = {
      ...writerDb,
      all: (sql: string, params?: never) => {
        calls.push(sql);
        return writerDb.all(sql, params);
      },
    } as AppDb;
    const { query, invalidateLanguages } = createCorpusQuery(spy);
    await query.search({ text: 'run' });
    await query.search({ text: 'run' });
    expect(calls.filter((s) => s === CORPUS_LANGUAGES_SQL)).toHaveLength(1);
    invalidateLanguages();
    await query.search({ text: 'run' });
    expect(calls.filter((s) => s === CORPUS_LANGUAGES_SQL)).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/main/core/store/__tests__/corpus-query.test.ts`
Expected: FAIL — `Cannot find module '../corpus-query'`.

- [ ] **Step 3: Move the row types/mappers and `ftsQuery` out of `store.ts`** (mechanical cut/paste — do NOT retype)

```bash
cd ~/work/kcore-read/src/main/core/store

# --- fts-query.ts: from the doc comment above tokenizeFts through the end of ftsQuery
S=$(grep -n '^ \* Compile user search text' store.ts | cut -d: -f1); S=$((S-1))
E=$(grep -n '^export function openStore' store.ts | cut -d: -f1); E=$((E-2))
sed -n "${S}p;${E}p" store.ts        # expect: '/**'  then  '}'
sed -n "${S},${E}p" store.ts | sed 's/^function ftsQuery/export function ftsQuery/' > fts-query.ts
sed -i '' "${S},${E}d" store.ts

# --- rows.ts: DocRow, AccountRow, toDocument, toAccount (contiguous block)
S=$(grep -n '^export interface DocRow {$' store.ts | cut -d: -f1)
F=$(grep -n '^function toAccount' store.ts | cut -d: -f1)
E=$(awk -v s="$F" 'NR>=s && /^}$/ {print NR; exit}' store.ts)
sed -n "${S}p;${E}p" store.ts        # expect: 'export interface DocRow {'  then  '}'
{
  printf "import type {\n  Account,\n  AccountId,\n  Document,\n  DocumentId,\n  SyncStatus,\n} from '@shared/contracts';\n\n"
  sed -n "${S},${E}p" store.ts
} | sed 's/^function toDocument/export function toDocument/; s/^function toAccount/export function toAccount/' > rows.ts
sed -i '' "${S},${E}d" store.ts
```

Then add to the imports of `store.ts` (and let `tsc` tell you any other `@shared/contracts` type `rows.ts` needs — add it there):

```ts
import { toAccount, toDocument, type AccountRow, type DocRow } from './rows';
export type { AccountRow, DocRow } from './rows';
```

(`write-tx.ts` keeps importing `AccountRow, DocRow` from `./store` unchanged.) `ftsQuery` is no longer used in `store.ts` after Step 5; remove its import list entries there as `eslint` reports them.

- [ ] **Step 4: Create `corpus-query.ts` by splicing the existing `query` object** (the `const query: Query = { … };` block and `accountsFrom` leave `store.ts`)

```bash
cd ~/work/kcore-read/src/main/core/store
S=$(grep -n '^  const query: Query = {$' store.ts | cut -d: -f1)
E=$(grep -n '^  // ── public surface' store.ts | cut -d: -f1); E=$((E-2))
sed -n "${S}p;${E}p" store.ts        # expect: '  const query: Query = {'  then  '  };'

cat > /tmp/cq-head.ts <<'EOF'
import type { Account, Query } from '@shared/contracts';

import type { AppDb, AppDbParam } from '../../db/app-db';
import { stemVariants } from '../stemming';
import { ftsQuery } from './fts-query';
import {
  buildSnippet,
  extractTerms,
  foldForNegation,
  rrfMerge,
  toTrigramMatch,
} from './fuzzy';
import { toAccount, toDocument, type AccountRow, type DocRow } from './rows';

/** Walks the docs_languages index (schema.ts), not the documents table. */
export const CORPUS_LANGUAGES_SQL = `SELECT DISTINCT languages FROM documents`;

/** Metadata paths scanned by the `participant:` filter — extend as new
 *  connector metadata shapes appear (slack/whatsapp senders etc.). */
const PARTICIPANT_METADATA_PATHS = [
  '$.from',
  '$.to',
  '$.cc',
  '$.participants',
  '$.sender',
  '$.author',
] as const;

/** The read surface, in one place: the read worker's allow-list, the proxy and
 *  the fallback wrapper all derive from this list. */
export const QUERY_METHODS = [
  'document',
  'documentPage',
  'children',
  'byExternalId',
  'search',
  'count',
  'countBy',
  'accounts',
] as const;
export type QueryMethod = (typeof QUERY_METHODS)[number];

export interface CorpusQueryOptions {
  /** `'explicit'` (default, the writer): the distinct-languages cache is
   *  dropped by `invalidateLanguages()` — the writer's own commits do not
   *  change its `PRAGMA data_version`. `'data-version'` (readers, the stdio
   *  sibling): the cache is keyed by `PRAGMA data_version`, sampled on the same
   *  connection BEFORE the lookup that fills it. */
  languageCache?: 'explicit' | 'data-version';
}

export interface CorpusQuery {
  query: Query;
  /** Drops the languages cache (explicit mode; harmless in data-version mode). */
  invalidateLanguages(): void;
}

export async function accountsFrom(reader: AppDb): Promise<Account[]> {
  const rows = (await reader.all(
    `SELECT * FROM accounts ORDER BY created_at`,
  )) as unknown as AccountRow[];
  return rows.map(toAccount);
}

export function createCorpusQuery(
  db: AppDb,
  opts: CorpusQueryOptions = {},
): CorpusQuery {
  const mode = opts.languageCache ?? 'explicit';
  let cache: { langs: string[]; version: number | null } | null = null;

  const loadLanguages = async (): Promise<string[]> => {
    const rows = (await db.all(CORPUS_LANGUAGES_SQL)) as unknown as Array<{
      languages: string;
    }>;
    const set = new Set<string>(['eng']);
    for (const r of rows)
      for (const l of JSON.parse(r.languages) as string[]) set.add(l);
    return [...set];
  };

  const corpusLanguages = async (): Promise<string[]> => {
    if (mode === 'explicit') {
      if (!cache) cache = { langs: await loadLanguages(), version: null };
      return cache.langs;
    }
    // data-version: sample BEFORE the lookup and store it with the result, so
    // a commit landing mid-fill makes the NEXT call see a different version.
    const rows = (await db.all(`PRAGMA data_version`)) as unknown as Array<{
      data_version: number;
    }>;
    const version = rows[0].data_version;
    if (cache && cache.version === version) return cache.langs;
    const langs = await loadLanguages();
    cache = { langs, version };
    return langs;
  };

  const findDocRow = async (
    accountId: string,
    externalId: string,
    type: string,
  ): Promise<DocRow | undefined> => {
    const rows = await db.all(
      `SELECT * FROM documents WHERE account_id = ? AND external_id = ? AND type = ?`,
      [accountId, externalId, type],
    );
    return rows[0] as unknown as DocRow | undefined;
  };

EOF

cat > /tmp/cq-tail.ts <<'EOF'

  return {
    query,
    invalidateLanguages: () => {
      cache = null;
    },
  };
}
EOF

{ cat /tmp/cq-head.ts; sed -n "${S},${E}p" store.ts; cat /tmp/cq-tail.ts; } > corpus-query.ts
sed -i '' "${S},${E}d" store.ts
```

- [ ] **Step 5: Rewire `store.ts` onto it.** Replace the old language-cache block (the comment `// Distinct languages present in the corpus …` through `corpusLanguages`'s closing `};`) with:

```ts
  // The read surface lives in corpus-query.ts so the read worker and the stdio
  // sibling share the exact implementation. The writer keeps explicit cache
  // invalidation: its own commits never change its PRAGMA data_version.
  const corpus = createCorpusQuery(db);
  const query: Query = corpus.query;
```

Delete the old `const accountsFrom = async (reader: AppDb) => { … };` block. Replace the four `corpusLangsCache = null;` statements (commit, reset, `reconcileArchive`, `applyFolderScope`) with `corpus.invalidateLanguages();` using:

```bash
sed -i '' 's/corpusLangsCache = null;/corpus.invalidateLanguages();/' src/main/core/store/store.ts
```

Remove `const CORPUS_LANGUAGES_SQL = …` and `PARTICIPANT_METADATA_PATHS` from `store.ts`, and add:

```ts
import { accountsFrom, createCorpusQuery } from './corpus-query';
export { CORPUS_LANGUAGES_SQL } from './corpus-query';
```

(`accountsFrom(heldDb)` in the backup path keeps working through the import.) Remove imports that became unused (`stemVariants`, the `./fuzzy` names, `findDocRow`/`getAccountRow` if unreferenced) as `tsc`/`eslint` report them.

- [ ] **Step 6: Run — expect PASS, behaviour unchanged**

Run: `npx jest src/main/core/store src/main/core/mcp` (the existing store, search-parity, fts, count-by and MCP suites are the equivalence proof — none may change).
Then: `npx tsc -p tsconfig.typecheck.json && npx eslint --fix src/main/core/store/store.ts src/main/core/store/corpus-query.ts src/main/core/store/rows.ts src/main/core/store/fts-query.ts src/main/core/store/__tests__/corpus-query.test.ts`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
printf 'refactor(store): createCorpusQuery with data_version-keyed language cache (#146)\n' > /tmp/msg-r1
git add src/main/core/store/rows.ts src/main/core/store/fts-query.ts src/main/core/store/corpus-query.ts src/main/core/store/__tests__/corpus-query.test.ts
git commit -F /tmp/msg-r1 -- src/main/core/store/rows.ts src/main/core/store/fts-query.ts src/main/core/store/corpus-query.ts src/main/core/store/store.ts src/main/core/store/__tests__/corpus-query.test.ts
```

---

### Task 2: Fuzzy pass rewrite + search projections

Spec §3.2: fuzzy pass without corpus-wide ranking, `project: 'full' | 'snippet' | 'metadata'`, `contextLines`, the line-window builder moves into the query module.

**Renderer finding (spec asks the plan to verify):** the only consumers of the renderer `search:query` channel are `src/renderer/screens/Sources/sections/TrackedContent.tsx` (reads `id`, `title`, `type`, `updatedAt` only) and, in alpha-cent, `src/overlay/renderer/screens/Calendar/` (`data.ts` / `detail.tsx` read `markdown` of `meeting.transcript` documents through `summarySection(transcript.markdown)`). Because one overlay consumer reads `markdown`, the IPC handler keeps the default projection (`'full'`) — no `project` is injected for the renderer (Task 5 routes it to the reader unchanged). `SearchRequest` is `Parameters<Query['search']>[0]`, so a renderer caller that needs less (TrackedContent could pass `project: 'metadata'`) can opt in per request later; that opt-in is NOT part of this plan.

**Files:**
- Create: `src/main/core/store/line-window.ts`, `src/main/core/store/__tests__/line-window.test.ts`, `src/main/core/store/__tests__/corpus-query-search.test.ts`, `src/main/core/mcp/__tests__/search-projection-gate.test.ts`
- Modify: `src/main/core/store/fuzzy.ts`, `src/main/core/store/__tests__/fuzzy.test.ts`, `src/main/core/store/corpus-query.ts`, `src/shared/contracts.ts` (Query.search arg), `src/main/core/mcp/tools/search.ts`, `src/main/core/mcp/tools/digital-memory-info.ts`

**Interfaces:**
- Consumes (Task 1): `createCorpusQuery`, `toDocument`, `DocRow`.
- Produces:
  - `Query.search` arg gains `project?: 'full' | 'snippet' | 'metadata'` and `contextLines?: number`.
  - `CorpusQuery` gains `fuzzyRuns(): number` — the cumulative number of times THIS instance actually executed the trigram fallback statement (`fuzzyCandidatesSql`). It is the acceptance probe's proof that its fuzzy workload really runs the fuzzy pass (the pass is skipped when the exact page is full, on later pages, or for terms it cannot fuzz). It reaches the probe as: Task 3 returns it in the `read` procedure result (`fuzzyRuns`, next to `execMs`), Task 4 keeps the reader's latest value in `ReadStats`/`ReadStatsSnapshot.fuzzyRuns`, Task 7 puts it in `readDiagnostics().reads.fuzzyRuns`. (Chosen over a separate `stats` procedure: the value rides on a call that already happens, so no extra round trip and no new worker surface.)
  - `fuzzy.ts`: `FUZZY_CANDIDATES = 100`, `fuzzyCandidatesSql(where: string, withBody: boolean): string`, `interface FuzzyCandidate`, `rankFuzzyCandidates<T extends FuzzyCandidate>(cands: readonly T[], positiveFolded: readonly string[]): T[]`, `pickFuzzyWinners(exactIds: ReadonlySet<string>, ranked: readonly { id: string }[], free: number): string[]`. `rrfMerge` is deleted.
  - `line-window.ts`: `DEFAULT_CONTEXT_LINES = 2`, `extractWindowTerms(q: string): string[]`, `buildLineWindow(markdown: string, terms: string[], contextLines: number, headTruncated?: boolean): string`.

- [ ] **Step 1: Write the failing tests**

`src/main/core/store/__tests__/line-window.test.ts`:

```ts
import { buildLineWindow, extractWindowTerms } from '../line-window';

describe('buildLineWindow', () => {
  const md = 'line1\nline2\nline3\nline4';

  it('with no terms returns the head window and a trailing ellipsis', () => {
    expect(buildLineWindow(md, [], 1)).toBe('line1\nline2\nline3\n…');
  });

  it('anchors on the first matching line and marks hits with **', () => {
    expect(buildLineWindow(md, ['line3'], 0)).toBe('…\n**line3**\n…');
  });

  it('headTruncated forces a trailing ellipsis even when every kept line fits', () => {
    expect(buildLineWindow('a\nb', [], 5, true)).toBe('a\nb\n…');
    expect(buildLineWindow('a\nb', [], 5, false)).toBe('a\nb');
  });
});

describe('extractWindowTerms', () => {
  it('keeps phrases whole and strips query syntax', () => {
    expect(extractWindowTerms('"term sheet" -spam invest*')).toEqual([
      'term sheet',
      'spam',
      'invest',
    ]);
  });
});
```

Edit `src/main/core/store/__tests__/fuzzy.test.ts`: delete the whole `describe('rrfMerge', …)` block and MERGE the names below into its EXISTING `import { … } from '../fuzzy';` statement (drop `rrfMerge` from it, add the four others; do NOT add a second import from `'../fuzzy'`, eslint `import/no-duplicates` fails). The existing statement ends up as:

```ts
import {
  extractTerms, // …keep whatever the file already imports besides rrfMerge…
  FUZZY_CANDIDATES,
  fuzzyCandidatesSql,
  pickFuzzyWinners,
  rankFuzzyCandidates,
} from '../fuzzy';
```

Then append these blocks (no new import line):

```ts
describe('fuzzyCandidatesSql', () => {
  it('is newest-first, ranks nothing by bm25 and reads no body by default', () => {
    const sql = fuzzyCandidatesSql('AND d.account_id = ?', false);
    expect(sql).toMatch(/ORDER BY t\.rowid DESC LIMIT \?/);
    expect(sql).not.toMatch(/bm25/);
    expect(sql).not.toMatch(/markdown/);
    expect(sql).toMatch(/AND d\.account_id = \?/);
  });

  it('selects the body only when negated terms need folding', () => {
    expect(fuzzyCandidatesSql('', true)).toMatch(/d\.markdown/);
  });

  it('caps candidates at 100', () => {
    expect(FUZZY_CANDIDATES).toBe(100);
  });
});

describe('rankFuzzyCandidates / pickFuzzyWinners', () => {
  const c = (id: string, title: string, at: string) => ({
    id,
    title,
    created_at: at,
    ingested_at: at,
  });

  it('ranks a folded title hit first, then newest', () => {
    const ranked = rankFuzzyCandidates(
      [
        c('old', 'misc', '2026-01-01'),
        c('new', 'misc', '2026-03-01'),
        c('title', 'Jahresrechnung 2024', '2026-02-01'),
      ],
      ['rechnung'],
    );
    expect(ranked.map((r) => r.id)).toEqual(['title', 'new', 'old']);
  });

  it('keeps exact-hit order and appends only the new fuzzy hits', () => {
    // exact [A,B,C] + fuzzy [C,B,A,F] with one free slot -> [A,B,C,F]
    const exact = ['A', 'B', 'C'];
    const winners = pickFuzzyWinners(
      new Set(exact),
      ['C', 'B', 'A', 'F'].map((id) => ({ id })),
      1,
    );
    expect([...exact, ...winners]).toEqual(['A', 'B', 'C', 'F']);
  });

  it('never exceeds the free slots', () => {
    expect(
      pickFuzzyWinners(new Set(), ['x', 'y', 'z'].map((id) => ({ id })), 2),
    ).toEqual(['x', 'y']);
  });
});
```

`src/main/core/store/__tests__/corpus-query-search.test.ts`:

```ts
/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { AccountId, DocumentInput } from '@shared/contracts';

import { openDb, type AppDb } from '../../../db/app-db';
import { createCorpusQuery } from '../corpus-query';
import { FUZZY_CANDIDATES, fuzzyCandidatesSql } from '../fuzzy';
import { openStore, type CoreStore } from '../store';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: (text: string) =>
    /[äöüß]|Rechnung/i.test(text) ? ['deu'] : ['eng'],
};

const doc = (
  externalId: string,
  over: Partial<DocumentInput> = {},
): DocumentInput => ({
  externalId,
  type: 'note',
  title: `Title ${externalId}`,
  markdown: `body-${externalId}`,
  metadata: {},
  createdAt: '2026-01-01T00:00:00Z',
  ...over,
});

describe('corpus query: fuzzy pass and projections', () => {
  let dir: string;
  let db: AppDb;
  let store: CoreStore;
  let acc: AccountId;
  let sqls: string[];
  let query: ReturnType<typeof createCorpusQuery>['query'];
  let corpus: ReturnType<typeof createCorpusQuery>;

  const commit = (account: AccountId, documents: DocumentInput[]) =>
    store.commit({ account, cursor: null, documents });

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-cq-search-'));
    db = await openDb(path.join(dir, 'test.db'));
    store = openStore(db, deps);
    acc = (await store.createAccount({ source: 'test', identifier: 'a@x' })).id;
    sqls = [];
    const spy = {
      ...db,
      all: (sql: string, params?: never) => {
        sqls.push(sql);
        return db.all(sql, params);
      },
    } as AppDb;
    corpus = createCorpusQuery(spy);
    query = corpus.query;
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const fuzzySql = () => sqls.find((s) => s.includes('documents_tri')) ?? '';

  it('account-restricted fuzzy search is not crowded out by another account in the newest rowids', async () => {
    const b = (await store.createAccount({ source: 'test', identifier: 'b@x' }))
      .id;
    await commit(acc, [1, 2, 3].map((i) => doc(`a${i}`, { markdown: `Jahresrechnung a${i}` })));
    await commit(
      b,
      Array.from({ length: FUZZY_CANDIDATES + 50 }, (_, i) =>
        doc(`b${i}`, { markdown: `Jahresrechnung b${i}` }),
      ),
    );
    const hits = await query.search({ text: 'rechnung', account: acc, limit: 10 });
    expect(hits.map((h) => h.externalId).sort()).toEqual(['a1', 'a2', 'a3']);
  });

  it('without an account filter the candidate window is the NEWEST 100 matches: the oldest 50 rowids never appear', async () => {
    await commit(
      acc,
      Array.from({ length: FUZZY_CANDIDATES + 50 }, (_, i) =>
        doc(`old${String(i).padStart(3, '0')}`, { markdown: `Jahresrechnung n${i}` }),
      ),
    );
    const rows = (await db.all(fuzzyCandidatesSql('', false), [
      '"rechnung"',
      FUZZY_CANDIDATES,
    ])) as Array<{ id: string }>;
    expect(rows).toHaveLength(FUZZY_CANDIDATES);
    const idToExternal = new Map(
      (
        (await db.all(`SELECT id, external_id FROM documents`)) as Array<{
          id: string;
          external_id: string;
        }>
      ).map((r) => [r.id, r.external_id]),
    );
    const got = new Set(rows.map((r) => idToExternal.get(r.id)));
    for (let i = 0; i < 50; i += 1) {
      expect(got.has(`old${String(i).padStart(3, '0')}`)).toBe(false);
    }
    for (let i = 50; i < FUZZY_CANDIDATES + 50; i += 1) {
      expect(got.has(`old${String(i).padStart(3, '0')}`)).toBe(true);
    }
  });

  it('fuzzyRuns counts only real executions of the trigram fallback statement', async () => {
    await commit(acc, [
      ...Array.from({ length: 12 }, (_, i) => doc(`inv${i}`, { markdown: `the invoice number ${i}` })),
      doc('jr', { markdown: 'Jahresrechnung offen' }),
    ]);
    expect(corpus.fuzzyRuns()).toBe(0);
    // a stemmed term whose exact page is FULL never runs the fuzzy pass
    await query.search({ text: 'invoices', limit: 10 });
    expect(corpus.fuzzyRuns()).toBe(0);
    // a later page never runs it either
    await query.search({ text: 'invoice', limit: 10, offset: 10 });
    expect(corpus.fuzzyRuns()).toBe(0);
    // a real misspelling / fragment leaves the page short: the statement runs once
    const hits = await query.search({ text: 'rechnung', limit: 10 });
    expect(hits.map((h) => h.externalId)).toEqual(['jr']);
    expect(corpus.fuzzyRuns()).toBe(1);
  });

  it('archived-heavy corpus still returns the live fuzzy hits', async () => {
    await commit(acc, [1, 2, 3, 4, 5].map((i) => doc(`live${i}`, { markdown: `Jahresrechnung live${i}` })));
    await commit(
      acc,
      Array.from({ length: 110 }, (_, i) =>
        doc(`arch${i}`, { markdown: `Jahresrechnung arch${i}` }),
      ),
    );
    await db.run(
      `UPDATE documents SET archived_at = '2026-02-01T00:00:00Z' WHERE external_id LIKE 'arch%'`,
    );
    const hits = await query.search({ text: 'rechnung', limit: 10 });
    expect(hits).toHaveLength(5);
    expect(hits.every((h) => h.externalId.startsWith('live'))).toBe(true);
  });

  it('fuzzy order is local: title hit first, then newest', async () => {
    await commit(acc, [
      doc('d1', { markdown: 'Jahresrechnung eins', createdAt: '2026-01-01T00:00:00Z' }),
      doc('d2', { title: 'Jahresrechnung 2024', markdown: 'zwei', createdAt: '2026-02-01T00:00:00Z' }),
      doc('d3', { markdown: 'Jahresrechnung drei', createdAt: '2026-03-01T00:00:00Z' }),
    ]);
    const hits = await query.search({ text: 'rechnung', limit: 10 });
    expect(hits.map((h) => h.externalId)).toEqual(['d2', 'd3', 'd1']);
  });

  it('keeps the exact hit first and appends the fuzzy hit once', async () => {
    await commit(acc, [
      doc('exact', { markdown: 'a rechnung here', createdAt: '2026-01-01T00:00:00Z' }),
      doc('fuzzy', { markdown: 'Jahresrechnung there', createdAt: '2026-02-01T00:00:00Z' }),
    ]);
    const hits = await query.search({ text: 'rechnung', limit: 10 });
    expect(hits.map((h) => h.externalId)).toEqual(['exact', 'fuzzy']);
  });

  it('reads no body in the fuzzy statement unless the query has negated terms, and still honours the negation', async () => {
    await commit(acc, [
      doc('keep', { markdown: 'Jahresrechnung ok' }),
      doc('drop', { markdown: 'Jahresrechnung spamwort' }),
    ]);
    await query.search({ text: 'rechnung', limit: 10 });
    expect(fuzzySql()).not.toMatch(/markdown/);
    expect(fuzzySql()).not.toMatch(/bm25\(documents_tri/);

    sqls.length = 0;
    const hits = await query.search({ text: 'rechnung -spam', limit: 10 });
    expect(fuzzySql()).toMatch(/d\.markdown/);
    expect(hits.map((h) => h.externalId)).toEqual(['keep']);
  });

  it('EXPLAIN QUERY PLAN of the fuzzy statement has no temp b-tree for ORDER BY', async () => {
    await commit(acc, [doc('x1', { markdown: 'Jahresrechnung' })]);
    const plan = (await db.all(
      `EXPLAIN QUERY PLAN ${fuzzyCandidatesSql('AND d.account_id = ?', false)}`,
      ['"rechnung"', acc, FUZZY_CANDIDATES],
    )) as Array<{ detail: string }>;
    expect(plan.map((r) => r.detail).join('\n')).not.toMatch(
      /USE TEMP B-TREE FOR ORDER BY/,
    );
  });

  describe('projections', () => {
    beforeEach(async () => {
      await commit(acc, [
        doc('p1', {
          title: 'Quarterly',
          markdown: 'line1\nThe invoice is due\nline3\nline4',
        }),
      ]);
    });

    it("'snippet' text search: empty markdown, FTS snippet, no body column", async () => {
      const [h] = await query.search({ text: 'invoice', project: 'snippet' });
      expect(h.markdown).toBe('');
      expect(h.snippet).toContain('<b>invoice</b>');
      const exact = sqls.find((s) => s.includes('documents_fts')) ?? '';
      expect(exact).not.toMatch(/d\.markdown|d\.\*/);
    });

    it("'snippet' fuzzy-filled row keeps the fuzzy window and blanks the body", async () => {
      await commit(acc, [doc('f1', { markdown: 'Jahresrechnung steht aus' })]);
      const hits = await query.search({ text: 'rechnung', project: 'snippet' });
      const f = hits.find((h) => h.externalId === 'f1')!;
      expect(f.markdown).toBe('');
      expect(f.snippet).toContain('<b>rechnung</b>');
    });

    it("'snippet' recency / filter-only listings use the line window", async () => {
      const recency = await query.search({ project: 'snippet', contextLines: 1 });
      expect(recency[0].markdown).toBe('');
      expect(recency[0].snippet).toBe('line1\nThe invoice is due\nline3\n…');
      const filtered = await query.search({ account: acc, project: 'snippet' });
      expect(filtered[0].snippet).toContain('line1');
    });

    it("'metadata': no body, no snippet, no snippet work", async () => {
      sqls.length = 0;
      const [h] = await query.search({ text: 'invoice', project: 'metadata' });
      expect(h.markdown).toBe('');
      expect(h.snippet).toBeUndefined();
      expect(sqls.some((s) => /d\.markdown|d\.\*|snippet\(/.test(s))).toBe(false);
      await query.search({ project: 'metadata' });
      expect(sqls.some((s) => /d\.markdown|d\.\*/.test(s))).toBe(false);
    });

    it("'full' (default) keeps today's rows", async () => {
      const [h] = await query.search({ text: 'invoice' });
      expect(h.markdown).toContain('The invoice is due');
    });

    it('recency snippets are head-limited to the first 64 KiB and end with an ellipsis', async () => {
      const lines = Array.from({ length: 100 }, (_, i) =>
        i === 90 ? `TAILMARK ${'x'.repeat(1490)}` : `${i} ${'y'.repeat(1490)}`,
      );
      await commit(acc, [
        doc('big', { markdown: lines.join('\n'), createdAt: '2027-01-01T00:00:00Z' }),
      ]);
      const [h] = await query.search({ project: 'snippet', contextLines: 30, limit: 1 });
      expect(h.externalId).toBe('big');
      expect(h.snippet).not.toContain('TAILMARK');
      expect(h.snippet!.endsWith('…')).toBe(true);
      const [full] = await query.search({ limit: 1 });
      expect(full.markdown!.length).toBeGreaterThan(65536);
    });
  });
});
```

`src/main/core/mcp/__tests__/search-projection-gate.test.ts`:

```ts
import fs from 'fs';
import path from 'path';

const toolsDir = path.join(__dirname, '..', 'tools');

describe('MCP tools never ask Query.search for full bodies', () => {
  const files = fs
    .readdirSync(toolsDir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ f, src: fs.readFileSync(path.join(toolsDir, f), 'utf8') }))
    .filter(({ src }) => /\bquery\.search\(/.test(src));

  it('finds the two search call sites', () => {
    expect(files.map((x) => x.f).sort()).toEqual([
      'digital-memory-info.ts',
      'search.ts',
    ]);
  });

  it.each(files.map((x) => [x.f, x.src]))(
    '%s passes an explicit project other than full',
    (_f, src) => {
      expect(src).toMatch(/project:\s*'(snippet|metadata)'/);
      expect(src).not.toMatch(/project:\s*'full'/);
    },
  );
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx jest src/main/core/store/__tests__/line-window.test.ts src/main/core/store/__tests__/fuzzy.test.ts src/main/core/store/__tests__/corpus-query-search.test.ts src/main/core/mcp/__tests__/search-projection-gate.test.ts`
Expected: FAIL — missing modules / exports.

- [ ] **Step 3: `line-window.ts`** (the builder moves out of `mcp/tools/search.ts:244`; semantics unchanged except the new `headTruncated` flag)

```ts
/**
 * Line-window ("grep -C") snippets for recency / filter-only listings, which
 * have no FTS5 snippet to lean on. Moved out of mcp/tools/search.ts so the
 * query module can build them where the rows are read.
 */

export const DEFAULT_CONTEXT_LINES = 2;
const SNIPPET_MAX_LINE_CHARS = 400;

/** Searchable terms out of a free-text query so a window can anchor near a
 *  real match: "quoted phrases" stay whole; `-`, `*`, parens and boolean
 *  operators are stripped. */
export function extractWindowTerms(q: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m: RegExpExecArray | null;
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(q)) !== null) {
    const raw = (m[1] ?? m[2])
      .replace(/^[-(]+/, '')
      .replace(/[)*]+$/, '')
      .toLowerCase();
    if (raw && raw !== 'and' && raw !== 'or' && raw !== 'not') tokens.push(raw);
  }
  return tokens;
}

export function clampLine(line: string, terms: string[]): string {
  if (line.length <= SNIPPET_MAX_LINE_CHARS) return line;
  const lower = line.toLowerCase();
  let idx = -1;
  for (const t of terms) {
    const i = lower.indexOf(t);
    if (i >= 0 && (idx < 0 || i < idx)) idx = i;
  }
  if (idx < 0) return `${line.slice(0, SNIPPET_MAX_LINE_CHARS)}…`;
  const radius = Math.floor(SNIPPET_MAX_LINE_CHARS / 2);
  const start = Math.max(0, idx - radius);
  const end = Math.min(line.length, idx + radius);
  let w = line.slice(start, end);
  if (start > 0) w = `…${w}`;
  if (end < line.length) w += '…';
  return w;
}

/** `headTruncated`: `markdown` is only the head of a longer body (the recency
 *  projection reads `substr(markdown, 1, 65536)`), so the window always ends
 *  with an ellipsis. */
export function buildLineWindow(
  markdown: string,
  terms: string[],
  contextLines: number,
  headTruncated = false,
): string {
  if (!markdown) return '';
  const lines = markdown.split(/\r?\n/);
  let matchLine = -1;
  for (let i = 0; i < lines.length && matchLine < 0; i += 1) {
    const lower = lines[i].toLowerCase();
    if (terms.some((t) => lower.includes(t))) matchLine = i;
  }
  let start: number;
  let end: number;
  if (matchLine < 0) {
    start = 0;
    end = Math.min(lines.length, contextLines * 2 + 1);
  } else {
    start = Math.max(0, matchLine - contextLines);
    end = Math.min(lines.length, matchLine + contextLines + 1);
  }
  let window = lines
    .slice(start, end)
    .map((l) => clampLine(l, terms))
    .join('\n');
  if (start > 0) window = `…\n${window}`;
  if (end < lines.length || headTruncated) window = `${window}\n…`;
  for (const t of terms) {
    const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    window = window.replace(new RegExp(escaped, 'gi'), '**$&**');
  }
  return window
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
```

- [ ] **Step 4: `fuzzy.ts`** — delete `RRF_K` and `rrfMerge` (the whole block from `const RRF_K = 60;` through the end of `rrfMerge`), and append:

```ts
/** Newest trigram matches considered per fuzzy pass (spec §3.2). */
export const FUZZY_CANDIDATES = 100;

/** The ONE fuzzy statement: keeps every eligibility filter (`where` is
 *  `AND …` or empty), drops bm25 (its cost grows with the match count), takes
 *  the NEWEST matches (trigram rowid = documents.rowid = insert order; FTS5
 *  serves `ORDER BY rowid DESC` without sorting) and reads no body unless
 *  negated terms need folding. */
export function fuzzyCandidatesSql(where: string, withBody: boolean): string {
  return `SELECT d.id, d.title, d.created_at, d.ingested_at${withBody ? ', d.markdown' : ''}
            FROM documents_tri t JOIN documents d ON d.id = t.doc_id
           WHERE documents_tri MATCH ? ${where}
           ORDER BY t.rowid DESC LIMIT ?`;
}

export interface FuzzyCandidate {
  id: string;
  title: string | null;
  created_at: string | null;
  ingested_at: string;
  markdown?: string | null;
}

/** Local ranking: a folded title that contains a positive term first, then
 *  newest by origin date (stable, so ties keep newest-rowid order). */
export function rankFuzzyCandidates<T extends FuzzyCandidate>(
  cands: readonly T[],
  positiveFolded: readonly string[],
): T[] {
  const dateOf = (c: T) => c.created_at ?? c.ingested_at;
  const titleHit = (c: T) => {
    const t = foldForNegation(c.title ?? '');
    return positiveFolded.some((p) => t.includes(p)) ? 1 : 0;
  };
  return [...cands].sort(
    (a, b) =>
      titleHit(b) - titleHit(a) ||
      (dateOf(a) < dateOf(b) ? 1 : dateOf(a) > dateOf(b) ? -1 : 0),
  );
}

/** Fuzzy may only FILL the page's free slots: ids already in the exact list
 *  are skipped, the rest are taken in ranked order up to `free`. */
export function pickFuzzyWinners(
  exactIds: ReadonlySet<string>,
  ranked: readonly { id: string }[],
  free: number,
): string[] {
  const out: string[] = [];
  for (const c of ranked) {
    if (out.length >= free) break;
    if (!exactIds.has(c.id)) out.push(c.id);
  }
  return out;
}
```

- [ ] **Step 5: Contract.** In `src/shared/contracts.ts`, inside the `Query.search` argument type, add after `orderBy?: 'newest' | 'relevance';`:

```ts
    /** What each row carries. `'full'` (default) = today's rows incl. the whole
     *  markdown. `'snippet'` = `markdown` is '' and `snippet` is always set.
     *  `'metadata'` = `markdown` is '' and there is no snippet work at all. */
    project?: 'full' | 'snippet' | 'metadata';
    /** Context lines for recency / filter-only line-window snippets
     *  (`'snippet'` projection; default 2). */
    contextLines?: number;
```

- [ ] **Step 6: `corpus-query.ts` — new `search` below the filters.** Update the imports (add `Document` to the `import type { Account, Query } from '@shared/contracts'` line — Task 1 trimmed it to what Task 1 uses; drop `rrfMerge`, add `FUZZY_CANDIDATES, fuzzyCandidatesSql, pickFuzzyWinners, rankFuzzyCandidates` from `./fuzzy`, and `buildLineWindow, DEFAULT_CONTEXT_LINES` from `./line-window`). Above `createCorpusQuery` add:

```ts
const RECENCY_HEAD_CHARS = 65536;
/** Every documents column except the body — what 'snippet'/'metadata' select. */
const DOC_COLUMNS_NO_BODY =
  'd.id, d.account_id, d.external_id, d.type, d.title, d.url, d.metadata, d.created_at, d.parent_id, d.content_hash, d.seq, d.ingest_seq, d.archived_at, d.languages, d.ingested_at, d.updated_at, d.scope_root_id';
```

Add the counter to `createCorpusQuery`: declare `let fuzzyRunCount = 0;` right below `let cache: …`, extend the interface and the returned object:

```ts
export interface CorpusQuery {
  query: Query;
  /** Drops the languages cache (explicit mode; harmless in data-version mode). */
  invalidateLanguages(): void;
  /** Cumulative executions of the trigram fallback statement on this instance. */
  fuzzyRuns(): number;
}
```

```ts
  return {
    query,
    invalidateLanguages: () => {
      cache = null;
    },
    fuzzyRuns: () => fuzzyRunCount,
  };
```

In `search`, replace everything from the line `const where = filters.length ? \`AND ${filters.join(' AND ')}\` : '';` through the end of the method (the line before `async count(q) {`) with:

```ts
      const where = filters.length ? `AND ${filters.join(' AND ')}` : '';
      const project = q.project ?? 'full';
      const contextLines = q.contextLines ?? DEFAULT_CONTEXT_LINES;
      const cols = project === 'full' ? 'd.*' : DOC_COLUMNS_NO_BODY;
      // A non-full projection never returns a body, whatever the statement read.
      const toHit = (
        r: DocRow,
        snippet?: string,
      ): Document & { snippet?: string } => {
        const d = toDocument(project === 'full' ? r : { ...r, markdown: '' });
        return snippet === undefined ? d : { ...d, snippet };
      };
      const dateOf = (d: Document) => d.createdAt ?? d.ingestedAt;

      if (q.text?.trim()) {
        const langs = await corpusLanguages();
        const orderSql =
          q.orderBy === 'newest'
            ? `ORDER BY COALESCE(d.created_at, d.ingested_at) DESC, d.id DESC`
            : `ORDER BY bm25(documents_fts, 0, 4.0, 1.0, 2.0, 0.5)`;
        const snippetSql =
          project === 'metadata'
            ? 'NULL'
            : `snippet(documents_fts, 2, '<b>', '</b>', '…', 24)`;
        const rows = (await db.all(
          `SELECT ${cols}, ${snippetSql} AS _snippet
             FROM documents_fts f JOIN documents d ON d.id = f.doc_id
             WHERE documents_fts MATCH ? ${where}
             ${orderSql}
             LIMIT ? OFFSET ?`,
          [
            ftsQuery(q.text, (term) => stemVariants(term, langs)),
            ...params,
            limit,
            offset,
          ],
        )) as unknown as Array<DocRow & { _snippet: string | null }>;
        const exact = rows.map((r) =>
          toHit(r, project === 'metadata' ? undefined : (r._snippet ?? '')),
        );

        // Fuzzy fallback (trigram substring recall): only when the exact pass
        // left the FIRST page short — good queries never pay for a second scan.
        if (offset > 0 || rows.length >= limit) return exact;
        const { positive, negated } = extractTerms(q.text);
        // Cannot-represent-it ⇒ don't-fuzz: (a) every positive term must
        // survive into the trigram AND group; (b) grouped negation has no
        // flat-term form; (c) metadata mode selects no body, so it cannot
        // re-apply negated terms to fuzzy hits.
        const triMatch =
          positive.every((t) => t.length >= 3) &&
          !/\bNOT\s*\(/.test(q.text) &&
          !(project === 'metadata' && negated.length > 0)
            ? toTrigramMatch(positive)
            : null;
        if (!triMatch) return exact;

        fuzzyRunCount += 1; // the trigram fallback statement is about to run
        const candidates = (await db.all(
          fuzzyCandidatesSql(where, negated.length > 0),
          [triMatch, ...params, FUZZY_CANDIDATES],
        )) as unknown as Array<{
          id: string;
          title: string | null;
          created_at: string | null;
          ingested_at: string;
          markdown?: string | null;
        }>;
        // A NOT-excluded document must never resurface via fuzzy: drop hits
        // containing any negated term (folded substring, deliberately broader
        // than FTS token semantics). Runs only when the query has negations.
        const negatedFolded = negated.map((n) => foldForNegation(n));
        const safe = negatedFolded.length
          ? candidates.filter((c) => {
              const haystack = foldForNegation(
                `${c.title ?? ''}\n${c.markdown ?? ''}`,
              );
              return !negatedFolded.some((n) => haystack.includes(n));
            })
          : candidates;
        const ranked = rankFuzzyCandidates(
          safe,
          positive.map((t) => foldForNegation(t)),
        );
        const winnerIds = pickFuzzyWinners(
          new Set(rows.map((r) => r.id)),
          ranked,
          limit - rows.length,
        );
        if (winnerIds.length === 0) return exact;

        // Full rows only for the (at most free-slot) appended winners; a
        // snippet needs the body to build the fuzzy window, metadata does not.
        const winnerRows = (await db.all(
          `SELECT ${project === 'metadata' ? DOC_COLUMNS_NO_BODY : 'd.*'}
             FROM documents d WHERE d.id IN (${winnerIds.map(() => '?').join(',')})`,
          winnerIds,
        )) as unknown as DocRow[];
        const byId = new Map(winnerRows.map((r) => [r.id, r]));
        const fuzzyHits = winnerIds
          .map((id) => byId.get(id))
          .filter((r): r is DocRow => r !== undefined)
          .map((r) =>
            toHit(
              r,
              project === 'metadata'
                ? undefined
                : buildSnippet(r.markdown ?? '', positive),
            ),
          );
        // The exact (bm25) order is kept as is; fuzzy hits are appended.
        const hits = [...exact, ...fuzzyHits];
        if (q.orderBy === 'newest') {
          hits.sort((a, b) =>
            dateOf(a) < dateOf(b) ? 1 : dateOf(a) > dateOf(b) ? -1 : 0,
          );
        }
        return hits;
      }

      // Recency / filter-only listing. 'snippet' needs only the head of the
      // body for its line window (and says so with a trailing ellipsis).
      const recencyCols =
        project === 'full'
          ? 'd.*'
          : project === 'snippet'
            ? `${DOC_COLUMNS_NO_BODY}, substr(d.markdown, 1, ${RECENCY_HEAD_CHARS}) AS markdown`
            : DOC_COLUMNS_NO_BODY;
      const recency = (await db.all(
        `SELECT ${recencyCols} FROM documents d WHERE 1=1 ${where}
           ORDER BY COALESCE(d.created_at, d.ingested_at) DESC, d.id DESC
           LIMIT ? OFFSET ?`,
        [...params, limit, offset],
      )) as unknown as DocRow[];
      return recency.map((r) =>
        project === 'snippet'
          ? toHit(
              r,
              buildLineWindow(
                r.markdown ?? '',
                [],
                contextLines,
                (r.markdown?.length ?? 0) >= RECENCY_HEAD_CHARS,
              ),
            )
          : toHit(r),
      );
    },
```

- [ ] **Step 7: MCP tool callers.** In `src/main/core/mcp/tools/search.ts`: delete exactly these from the file: the constant `SNIPPET_MAX_LINE_CHARS` and the functions `extractTerms`, `clampLine` and `buildSnippet`; KEEP `DEFAULT_LIMIT`, `MAX_LIMIT`, `SNIPPET_DEFAULT_CONTEXT_LINES`, `SNIPPET_MAX_CONTEXT_LINES`, `resolveLimit` and `resolveContextLines`, import the builder, and ask for the snippet projection:

```ts
import { buildLineWindow, extractWindowTerms } from '../../store/line-window';
```

```ts
    const base = {
      text: rawText,
      type: effType,
      fromDate: args.from_date,
      toDate: args.to_date,
      limit,
      people,
      label: parsed.label.length ? parsed.label : undefined,
      hasAttachment: parsed.hasAttachment || undefined,
      filename: parsed.filename.length ? parsed.filename : undefined,
      ext: parsed.ext.length ? parsed.ext : undefined,
      orderBy: parsed.order,
      // The store builds the snippet where the rows are read; the tool never
      // needs a body (get(id) fetches it).
      project: 'snippet' as const,
      contextLines,
    };
```

```ts
    const terms = rawText ? extractWindowTerms(rawText) : [];
    return docs.map((d, i) => ({
      // …unchanged fields…
      snippet:
        d.snippet ?? buildLineWindow(d.markdown ?? '', terms, contextLines),
```

In `digital-memory-info.ts` change the sample call to `await query.search({ limit: SAMPLE_SIZE, project: 'metadata' })`.

- [ ] **Step 8: Run — expect PASS**

Run: `npx jest src/main/core/store src/main/core/mcp` — any pre-existing test that pinned the old RRF ordering (look in `search-parity.test.ts`) must be updated to "exact order kept, fuzzy appended" (spec §3.2) and nothing else; every other expectation stays.
Then: `npx tsc -p tsconfig.typecheck.json && npx eslint --fix src/main/core/store/corpus-query.ts src/main/core/store/fuzzy.ts src/main/core/store/line-window.ts src/main/core/mcp/tools/search.ts src/main/core/mcp/tools/digital-memory-info.ts src/shared/contracts.ts src/main/core/store/__tests__/*.ts src/main/core/mcp/__tests__/search-projection-gate.test.ts`

- [ ] **Step 9: Commit**

```bash
printf 'feat(search): bm25-free newest-first fuzzy pass and snippet/metadata projections (#146)\n' > /tmp/msg-r2
git add src/main/core/store/line-window.ts src/main/core/store/__tests__/line-window.test.ts src/main/core/store/__tests__/corpus-query-search.test.ts src/main/core/mcp/__tests__/search-projection-gate.test.ts
git commit -F /tmp/msg-r2 -- src/main/core/store src/shared/contracts.ts src/main/core/mcp/tools/search.ts src/main/core/mcp/tools/digital-memory-info.ts src/main/core/mcp/__tests__/search-projection-gate.test.ts
```


---

### Task 3: Read role of the DB worker

Spec §3.1: `openCorpusReadConnection` gains options; `worker-entry.ts` branches on `workerData.role`; the stdio sibling switches to `createCorpusQuery`.

**Files:**
- Create: `src/main/db/__tests__/worker-test-env.ts`, `src/main/db/__tests__/db-worker-read-role.test.ts`, `src/main/mcp/__tests__/stdio-entry.test.ts`
- Modify: `src/main/db/app-db.ts` (`openCorpusReadConnection`), `src/main/db/worker-client.ts` (`OpenDbInWorkerOptions`, `spawnWorker`), `src/main/db/worker-entry.ts`, `src/main/mcp/stdio-entry.ts`

**Interfaces:**
- Consumes (Task 1): `createCorpusQuery(db, { languageCache: 'data-version' })`, `QUERY_METHODS`.
- Produces:
  - `openCorpusReadConnection(filePath: string, opts?: { cacheKiB?: number; queryOnly?: boolean }): Promise<AppDb>`.
  - `OpenDbInWorkerOptions` gains `role?: 'write' | 'read'` and `cacheKiB?: number`.
  - Worker `read` procedure: `proc('read', { method: QueryMethod, args: unknown[] }) → Promise<{ value: unknown; execMs: number; fuzzyRuns: number }>` (`fuzzyRuns` = the worker's cumulative `CorpusQuery.fuzzyRuns()`).
  - Test helper `createWorkerEnv(label): { execArgv: string[]; preloadPath: string; cleanup(): void }`, `WORKER_ENTRY`, `REPO_ROOT` (used by Tasks 3, 5, 6).

- [ ] **Step 1: Write the shared test helper** — `src/main/db/__tests__/worker-test-env.ts`

```ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Repo root (this file lives in src/main/db/__tests__). */
export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
/** The TS source of the DB worker entry (run under ts-node, never the bundle). */
export const WORKER_ENTRY = path.join(__dirname, '..', 'worker-entry.ts');

/**
 * `execArgv` for spawning TS sources in a Worker / child process, copied from
 * db-worker.test.ts: Node's native type-stripping must be off so ts-node
 * transpiles to CJS, and a tiny preload redirects the bare `better-sqlite3`
 * specifier (which `src/node_modules` would resolve to the Electron-ABI
 * junction) to the repo-root copy built for plain Node.
 */
export function createWorkerEnv(label: string): {
  execArgv: string[];
  preloadPath: string;
  cleanup(): void;
} {
  const unique = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const preloadPath = path.join(os.tmpdir(), `kiagent-${label}-preload-${unique}.js`);
  const target = path
    .join(REPO_ROOT, 'node_modules', 'better-sqlite3')
    .replace(/\\/g, '\\\\');
  fs.writeFileSync(
    preloadPath,
    `const Module = require('module');
const target = ${JSON.stringify(target)};
const orig = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'better-sqlite3') {
    return orig.call(this, target, ...rest);
  }
  return orig.apply(this, [request, ...rest]);
};
`,
  );
  return {
    preloadPath,
    execArgv: [
      '--no-experimental-strip-types',
      '-r',
      preloadPath,
      '-r',
      'ts-node/register/transpile-only',
      '-r',
      'tsconfig-paths/register',
    ],
    cleanup: () => {
      if (fs.existsSync(preloadPath)) fs.rmSync(preloadPath);
    },
  };
}
```

- [ ] **Step 2: Write the failing read-role test** — `src/main/db/__tests__/db-worker-read-role.test.ts`

```ts
/**
 * @jest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { openStore } from '@main/core/store/store';
import { openDb, type AppDb } from '../app-db';
import { openDbInWorker } from '../worker-client';
import { createWorkerEnv, WORKER_ENTRY } from './worker-test-env';

jest.setTimeout(60_000);

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};

describe('DB worker read role (real spawn)', () => {
  let dir: string;
  let dbPath: string;
  const env = createWorkerEnv('read-role');
  let reader: AppDb | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-read-role-'));
    dbPath = path.join(dir, 'kiagent.db');
  });

  afterEach(async () => {
    if (reader?.isOpen()) await reader.close();
    reader = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  afterAll(() => env.cleanup());

  async function seed(): Promise<void> {
    const store = openStore(await openDb(dbPath), deps);
    const acc = await store.createAccount({
      source: 'test',
      identifier: 'me@example.com',
    });
    await store.commit({
      account: acc.id,
      cursor: null,
      documents: [
        {
          externalId: 'd1',
          type: 'note',
          title: 'Hello',
          markdown: 'invoice body',
          metadata: {},
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    await store.close();
  }

  const open = (cacheKiB = 4096) =>
    openDbInWorker(dbPath, WORKER_ENTRY, {
      execArgv: env.execArgv,
      role: 'read',
      cacheKiB,
    });

  it('serves the read procedure with the specified pragmas', async () => {
    await seed();
    reader = await open(4096);
    const res = (await reader.proc!('read', {
      method: 'accounts',
      args: [],
    })) as { value: Array<{ identifier: string }>; execMs: number; fuzzyRuns: number };
    expect(res.value.map((a) => a.identifier)).toEqual(['me@example.com']);
    expect(typeof res.execMs).toBe('number');
    expect(res.fuzzyRuns).toBe(0);
    expect(await reader.all('PRAGMA cache_size')).toEqual([{ cache_size: -4096 }]);
    expect(await reader.all('PRAGMA query_only')).toEqual([{ query_only: 1 }]);
    expect(await reader.all('PRAGMA mmap_size')).toEqual([{ mmap_size: 0 }]);
  });

  it('runs search (stemming, fuzzy, projection) inside the worker', async () => {
    await seed();
    reader = await open();
    const res = (await reader.proc!('read', {
      method: 'search',
      args: [{ text: 'invoice', project: 'snippet' }],
    })) as { value: Array<{ title: string; markdown: string; snippet: string }> };
    expect(res.value).toHaveLength(1);
    expect(res.value[0].markdown).toBe('');
    expect(res.value[0].snippet).toContain('<b>invoice</b>');
  });

  it('returns the worker-side fuzzyRuns counter with every read result', async () => {
    await seed();
    reader = await open();
    const read = async (text: string) =>
      (await reader!.proc!('read', { method: 'search', args: [{ text }] })) as {
        fuzzyRuns: number;
      };
    expect((await read('invoice')).fuzzyRuns).toBe(1); // page short -> fuzzy statement ran
    expect((await read('invoice')).fuzzyRuns).toBe(2); // cumulative across calls
    const acc = (await reader.proc!('read', { method: 'accounts', args: [] })) as {
      fuzzyRuns: number;
    };
    expect(acc.fuzzyRuns).toBe(2); // other methods leave it alone
  });

  it('refuses writes (query_only) and registers no write procedure', async () => {
    await seed();
    reader = await open();
    await expect(reader.run('DELETE FROM documents')).rejects.toThrow(/readonly/i);
    await expect(reader.proc!('commit', {})).rejects.toThrow(/unknown db procedure/);
    await expect(
      reader.proc!('read', { method: 'exec', args: [] }),
    ).rejects.toThrow(/unknown read method/);
  });

  it('does not migrate: a bare file stays bare', async () => {
    const bare = new Database(dbPath);
    bare.exec('CREATE TABLE only_me(x)');
    bare.close();
    reader = await open();
    const names = (await reader.all(
      `SELECT name FROM sqlite_master WHERE type = 'table'`,
    )) as Array<{ name: string }>;
    expect(names.map((n) => n.name)).toEqual(['only_me']);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx jest src/main/db/__tests__/db-worker-read-role.test.ts`
Expected: FAIL (the worker ignores `role` and tries to migrate / `read` is unknown).

- [ ] **Step 4: `openCorpusReadConnection` options** — in `src/main/db/app-db.ts` replace the function (signature and tail) with:

```ts
export interface CorpusReadOptions {
  /** `PRAGMA cache_size = -cacheKiB` and `mmap_size = 0`. Omitted: SQLite defaults. */
  cacheKiB?: number;
  /** `PRAGMA query_only = ON`: writes fail inside SQLite, whatever the caller does. */
  queryOnly?: boolean;
}

export async function openCorpusReadConnection(
  filePath: string,
  opts: CorpusReadOptions = {},
): Promise<AppDb> {
  // Fail fast (and deterministically) if the GUI app never created the corpus.
  // better-sqlite3's `fileMustExist` raises at open, but an explicit check
  // gives a clearer message for the stdio entry's stderr and is not subject to
  // driver-state quirks.
  if (!fs.existsSync(filePath)) {
    throw new Error(`corpus database not found: ${filePath}`);
  }
  const conn = new Database(filePath, { fileMustExist: true });
  conn.pragma('busy_timeout = 5000');
  if (opts.queryOnly) conn.pragma('query_only = ON');
  if (opts.cacheKiB !== undefined) {
    conn.pragma(`cache_size = -${Math.floor(opts.cacheKiB)}`);
    conn.pragma('mmap_size = 0');
  }
  // Integer columns come back as plain `number` — core's store is number-native
  // (matches `openStore`'s bare `new Database`); no seq/rowid approaches 2^53.
  return wrapConn(conn);
}
```

(keep the existing doc comment above it, and add one line: "Optional `cacheKiB`/`queryOnly` are for the read worker and the stdio sibling.")

- [ ] **Step 5: `worker-client.ts`** — extend the options and the spawn:

```ts
export interface OpenDbInWorkerOptions {
  execArgv?: string[];
  pluginSources?: Readonly<Record<string, string>>;
  /** `'read'`: the worker opens a query-only connection and serves only the
   *  `read` procedure (worker-entry.ts); no migrations. Default `'write'`. */
  role?: 'write' | 'read';
  /** Page cache for the read role, in KiB. */
  cacheKiB?: number;
}
```

and in `spawnWorker` change `workerData` to:

```ts
    workerData: {
      dbPath,
      pluginSources: opts.pluginSources,
      role: opts.role,
      cacheKiB: opts.cacheKiB,
    },
```

- [ ] **Step 6: `worker-entry.ts`** — add imports, read the new `workerData` fields, add the role function and the branch.

```ts
import { createCorpusQuery, QUERY_METHODS } from '@main/core/store/corpus-query';
import { openCorpusReadConnection, openDb } from './app-db';
```
(replace the existing `import { openDb } from './app-db';`.) Change the destructuring to:

```ts
const { dbPath, pluginSources, role, cacheKiB } = workerData as {
  dbPath: string;
  pluginSources?: Record<string, string>;
  role?: 'write' | 'read';
  cacheKiB?: number;
};
```

Add above the `(async () => {` IIFE:

```ts
/** Read role: a query-only connection, no migrations, no write procedures, no
 *  plugin registry, no coordinator (one statement at a time on this thread).
 *  The whole read surface runs HERE — SQL, stemming, fusion, folding, snippets
 *  — and main only sees the finished rows. */
async function runReadRole(): Promise<void> {
  const db = await openCorpusReadConnection(dbPath, {
    cacheKiB: cacheKiB ?? 2048,
    queryOnly: true,
  });
  const corpus = createCorpusQuery(db, { languageCache: 'data-version' });
  const { query } = corpus;
  const methods = new Set<string>(QUERY_METHODS);
  const table = query as unknown as Record<
    string,
    (...a: unknown[]) => Promise<unknown>
  >;
  attachDbHost(
    parentPort!,
    db,
    () => process.exit(0),
    {
      read: async (args) => {
        const { method, args: callArgs } = args as {
          method: string;
          args: unknown[];
        };
        if (!methods.has(method)) {
          throw new Error(`unknown read method: ${method}`);
        }
        const started = performance.now();
        const value = await table[method](...callArgs);
        return {
          value,
          execMs: performance.now() - started,
          fuzzyRuns: corpus.fuzzyRuns(),
        };
      },
    },
  );
}
```

and as the first statement inside the IIFE's `try {`:

```ts
    if (role === 'read') {
      await runReadRole();
      parentPort!.postMessage({ t: 'ready' });
      return;
    }
```

- [ ] **Step 7: stdio sibling.** In `src/main/mcp/stdio-entry.ts` update the header comment sentence ("Reads the corpus via `openStore` …") to say it reads through `createCorpusQuery` over a query-only connection, then replace the imports `openStore, type CoreStore` with:

```ts
import { createCorpusQuery } from '../core/store/corpus-query';
import type { AppDb } from '../db/app-db';
import type { Query } from '@shared/contracts';
```

and replace the `let store: CoreStore; try { … } catch …` block with:

```ts
  let readDb: AppDb;
  let query: Query;
  try {
    // Read-only sibling: no migrations, no journal_mode, read-WRITE open so a
    // dirty -wal can be recovered, `query_only` so nothing can write. The
    // language cache is keyed by data_version because the app's commits happen
    // on another connection.
    readDb = await openCorpusReadConnection(dbPath, { queryOnly: true });
    query = createCorpusQuery(readDb, { languageCache: 'data-version' }).query;
  } catch (err) {
    process.stderr.write(
      `[mcp-stdio] failed to open corpus: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
    return;
  }
```

then `buildBuiltinTools(query, createOutboundProxy())`, `attachResourceHandlers(server, query)`, and in `shutdown` replace `await store.close();` with `await readDb.close();`.

- [ ] **Step 8: stdio smoke test** — `src/main/mcp/__tests__/stdio-entry.test.ts` (the sibling must still serve search and query_sql after the swap; Task 6 re-runs it)

```ts
/**
 * @jest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { openStore } from '@main/core/store/store';
import { openDb } from '@main/db/app-db';
import {
  createWorkerEnv,
  REPO_ROOT,
} from '@main/db/__tests__/worker-test-env';

jest.setTimeout(90_000);

const STDIO_ENTRY = path.join(__dirname, '..', 'stdio-entry.ts');

describe('stdio MCP sibling (real process)', () => {
  const env = createWorkerEnv('stdio');
  let dir: string;
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  afterAll(() => env.cleanup());

  it('serves search and query_sql from a query-only connection', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-stdio-'));
    const dbPath = path.join(dir, 'kiagent.db');
    const store = openStore(await openDb(dbPath), {
      encrypt: (s: string) => Buffer.from(s, 'utf8'),
      decrypt: (b: Buffer) => b.toString('utf8'),
      detectLanguages: () => ['eng'],
    });
    const acc = await store.createAccount({ source: 'gmail', identifier: 'me@example.com' });
    await store.commit({
      account: acc.id,
      cursor: null,
      documents: [
        {
          externalId: 'd1',
          type: 'email.message',
          title: 'Quarterly invoice',
          markdown: 'the invoice is due',
          metadata: {},
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    await store.close();

    client = new Client({ name: 'stdio-test', version: '0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [...env.execArgv, STDIO_ENTRY, '--db', dbPath],
        cwd: REPO_ROOT,
        env: {
          ...process.env,
          TS_NODE_PROJECT: path.join(REPO_ROOT, 'tsconfig.json'),
          TS_NODE_TRANSPILE_ONLY: '1',
        } as Record<string, string>,
      }),
    );

    const search = (await client.callTool({
      name: 'search',
      arguments: { query: 'invoice' },
    })) as { content: Array<{ text: string }> };
    const hits = JSON.parse(search.content[0].text) as Array<{ title: string; snippet: string }>;
    expect(hits.map((h) => h.title)).toEqual(['Quarterly invoice']);
    expect(hits[0].snippet).toContain('invoice');

    const sql = (await client.callTool({
      name: 'query_sql',
      arguments: { sql: 'SELECT title FROM documents' },
    })) as { content: Array<{ text: string }> };
    expect(JSON.parse(sql.content[0].text).rows).toEqual([{ title: 'Quarterly invoice' }]);
  });
});

// (Task 6 Step 11 extends this file with the bounded-result call.)
```

- [ ] **Step 9: Run — expect PASS**

Run: `npx jest src/main/db/__tests__/db-worker-read-role.test.ts src/main/mcp/__tests__/stdio-entry.test.ts src/main/db/__tests__/db-worker.test.ts src/main/db/__tests__/db-worker-respawn.test.ts`
Then: `npx tsc -p tsconfig.typecheck.json && npx eslint --fix src/main/db/app-db.ts src/main/db/worker-client.ts src/main/db/worker-entry.ts src/main/mcp/stdio-entry.ts src/main/db/__tests__/worker-test-env.ts src/main/db/__tests__/db-worker-read-role.test.ts src/main/mcp/__tests__/stdio-entry.test.ts`
Expected: all green; the existing writer-role worker suites unchanged.

- [ ] **Step 10: Commit**

```bash
printf 'feat(db): read role of the DB worker; stdio sibling on createCorpusQuery (#146)\n' > /tmp/msg-r3
git add src/main/db/__tests__/worker-test-env.ts src/main/db/__tests__/db-worker-read-role.test.ts src/main/mcp/__tests__/stdio-entry.test.ts
git commit -F /tmp/msg-r3 -- src/main/db/app-db.ts src/main/db/worker-client.ts src/main/db/worker-entry.ts src/main/mcp/stdio-entry.ts src/main/db/__tests__/worker-test-env.ts src/main/db/__tests__/db-worker-read-role.test.ts src/main/mcp/__tests__/stdio-entry.test.ts
```

---

### Task 4: Read proxy, writer fallback, read stats

Spec §3.3 / §3.5 / §3.6. Pure TypeScript over a fake `AppDb`; no worker needed here.

**Files:**
- Create: `src/main/core/store/read-proxy.ts`
- Test: `src/main/core/store/__tests__/read-proxy.test.ts`

**Interfaces:**
- Consumes: `QUERY_METHODS`, `QueryMethod` (Task 1); `DB_WORKER_CRASHED`, `DB_WORKER_DEAD` (`db/worker-client.ts`); the `read` procedure shape from Task 3.
- Produces:
  - `type ReadCaller = 'mcp' | 'renderer' | 'other'`, `type ReadVia = 'reader' | 'writer'`, `type FallbackReason = 'open-failed' | 'crashed' | 'dead'`, `type ReadMode = 'reader' | 'writer'`.
  - `interface ReadRecord { caller; method: QueryMethod; via: ReadVia; execMs: number; totalMs: number; at: number; fuzzyRuns?: number }` (`fuzzyRuns` = the reader's cumulative counter as returned by the `read` procedure; absent on writer-path records).
  - `interface ReadGroupStats { caller; method; via; count; p50Ms; p95Ms; maxMs; execP95Ms; newestAgeMs }`; `interface ReadStatsSnapshot { mode: ReadMode; groups: ReadGroupStats[]; fallbacks: Record<FallbackReason, number>; fuzzyRuns: number }`.
  - `interface ReadStats { record(r): void; fallback(reason): void; setMode(m): void; snapshot(now?: number): ReadStatsSnapshot }`; `createReadStats(window?: number): ReadStats` (default 256).
  - `queryFromInvoker(invoke: (method: QueryMethod, args: unknown[]) => Promise<unknown>): Query`.
  - `createReadProxy(readDb: AppDb, stats: ReadStats, caller: ReadCaller): Query`.
  - `withWriterFallback(deps: { proxy: ((caller: ReadCaller) => Query) | null; writer: Query; stats: ReadStats; log(level: 'warn' | 'error', msg: string): void; openError?: string }): { for(caller: ReadCaller): Query; mode(): ReadMode }`.

- [ ] **Step 1: Write the failing test** — `src/main/core/store/__tests__/read-proxy.test.ts`

```ts
import type { AppDb } from '../../../db/app-db';
import { DB_WORKER_CRASHED, DB_WORKER_DEAD } from '../../../db/worker-client';
import { QUERY_METHODS } from '../corpus-query';
import {
  createReadProxy,
  createReadStats,
  withWriterFallback,
} from '../read-proxy';

const codeErr = (code: string, message = code) =>
  Object.assign(new Error(message), { code });

function writer() {
  const w: Record<string, jest.Mock> = {};
  for (const m of QUERY_METHODS) w[m] = jest.fn(async () => `writer:${m}`);
  return w;
}
const readerDb = (proc: jest.Mock) => ({ proc }) as unknown as AppDb;

describe('createReadProxy', () => {
  it('forwards method + args to the read procedure and records execMs/totalMs', async () => {
    const proc = jest.fn(async () => ({ value: ['hit'], execMs: 3, fuzzyRuns: 5 }));
    const stats = createReadStats();
    const q = createReadProxy(readerDb(proc), stats, 'mcp');
    expect(await q.search({ text: 'x' })).toEqual(['hit']);
    expect(proc).toHaveBeenCalledWith('read', {
      method: 'search',
      args: [{ text: 'x' }],
    });
    const g = stats.snapshot().groups[0];
    expect(g).toMatchObject({
      caller: 'mcp',
      method: 'search',
      via: 'reader',
      count: 1,
      execP95Ms: 3,
    });
    expect(g.p95Ms).toBeGreaterThanOrEqual(0);
    expect(stats.snapshot().fuzzyRuns).toBe(5); // the reader's cumulative counter is surfaced
  });
});

describe('createReadStats', () => {
  it('computes p50/p95/max per caller x method and keeps only the last 256 calls', () => {
    const stats = createReadStats(256);
    for (let i = 1; i <= 300; i += 1) {
      stats.record({
        caller: 'mcp',
        method: 'search',
        via: 'reader',
        execMs: i,
        totalMs: i,
        at: 1000,
      });
    }
    const g = stats.snapshot(2000).groups[0];
    expect(g.count).toBe(256); // 45..300
    expect(g.maxMs).toBe(300);
    expect(g.p50Ms).toBe(172); // nearest rank of 45..300 at 50%
    expect(g.p95Ms).toBe(288);
    expect(g.newestAgeMs).toBe(1000);
  });
});

describe('withWriterFallback', () => {
  const log = jest.fn();
  beforeEach(() => log.mockReset());

  it('starts in writer mode when the reader failed to open (logged once, stats active)', async () => {
    const w = writer();
    const stats = createReadStats();
    const router = withWriterFallback({
      proxy: null,
      writer: w as never,
      stats,
      log,
      openError: 'boom',
    });
    expect(router.mode()).toBe('writer');
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      'warn',
      '[db] read worker unavailable: boom — reads use the writer',
    );
    expect(await router.for('mcp').count({})).toBe('writer:count');
    expect(stats.snapshot().fallbacks['open-failed']).toBe(1);
    expect(stats.snapshot().groups[0]).toMatchObject({ via: 'writer', count: 1 });
  });

  it('retries an in-flight DB_WORKER_CRASHED call once on the writer, without going sticky', async () => {
    const w = writer();
    const proc = jest
      .fn()
      .mockRejectedValueOnce(codeErr(DB_WORKER_CRASHED))
      .mockResolvedValue({ value: 'reader', execMs: 1 });
    const stats = createReadStats();
    const router = withWriterFallback({
      proxy: (c) => createReadProxy(readerDb(proc), stats, c),
      writer: w as never,
      stats,
      log,
    });
    expect(await router.for('mcp').document('d1' as never)).toBe('writer:document');
    expect(await router.for('mcp').document('d1' as never)).toBe('reader');
    expect(router.mode()).toBe('reader');
    expect(stats.snapshot().fallbacks.crashed).toBe(1);
  });

  it('DB_WORKER_DEAD (including parked callers) retries on the writer and then sticks', async () => {
    const w = writer();
    const proc = jest.fn(
      () =>
        new Promise((_, reject) =>
          setTimeout(() => reject(codeErr(DB_WORKER_DEAD)), 10),
        ),
    );
    const stats = createReadStats();
    const router = withWriterFallback({
      proxy: (c) => createReadProxy(readerDb(proc), stats, c),
      writer: w as never,
      stats,
      log,
    });
    const q = router.for('renderer');
    const [a, b] = await Promise.all([q.count({}), q.accounts()]);
    expect([a, b]).toEqual(['writer:count', 'writer:accounts']);
    expect(router.mode()).toBe('writer');
    proc.mockClear();
    expect(await q.count({})).toBe('writer:count');
    expect(proc).not.toHaveBeenCalled(); // sticky: the reader is not asked again
    expect(
      log.mock.calls.filter(([, m]) => /read worker is dead/.test(m as string)),
    ).toHaveLength(1);
    expect(stats.snapshot().fallbacks.dead).toBeGreaterThanOrEqual(1);
  });

  it('propagates SQL errors unchanged: no fallback, writer not called', async () => {
    const w = writer();
    const proc = jest.fn().mockRejectedValue(new Error('search query: unmatched ")"'));
    const stats = createReadStats();
    const router = withWriterFallback({
      proxy: (c) => createReadProxy(readerDb(proc), stats, c),
      writer: w as never,
      stats,
      log,
    });
    await expect(router.for('mcp').search({ text: ')' })).rejects.toThrow(/unmatched/);
    expect(w.search).not.toHaveBeenCalled();
    expect(stats.snapshot().fallbacks).toEqual({ 'open-failed': 0, crashed: 0, dead: 0 });
  });
});
```


- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/main/core/store/__tests__/read-proxy.test.ts`
Expected: FAIL — `Cannot find module '../read-proxy'`.

- [ ] **Step 3: Implement** — `src/main/core/store/read-proxy.ts`

```ts
/**
 * Main-side half of the read worker (spec §3.3 / §3.5 / §3.6): a thin proxy
 * whose methods call the reader's `read` procedure, one wrapper that turns
 * every reader failure mode into "use the writer", and the per
 * caller x method statistics that diagnose it.
 */
import type { Query } from '@shared/contracts';

import type { AppDb } from '../../db/app-db';
import { DB_WORKER_CRASHED, DB_WORKER_DEAD } from '../../db/worker-client';
import { QUERY_METHODS, type QueryMethod } from './corpus-query';

export type ReadCaller = 'mcp' | 'renderer' | 'other';
export type ReadVia = 'reader' | 'writer';
export type FallbackReason = 'open-failed' | 'crashed' | 'dead';
export type ReadMode = 'reader' | 'writer';

export interface ReadRecord {
  caller: ReadCaller;
  method: QueryMethod;
  via: ReadVia;
  /** Time inside the reader's statement(s); equals totalMs on the writer. */
  execMs: number;
  /** Request to answer, as main saw it (includes queueing on either side). */
  totalMs: number;
  at: number;
  /** The reader worker's cumulative fuzzy-pass executions (reader path only). */
  fuzzyRuns?: number;
}

export interface ReadGroupStats {
  caller: ReadCaller;
  method: QueryMethod;
  via: ReadVia;
  count: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  execP95Ms: number;
  newestAgeMs: number;
}

export interface ReadStatsSnapshot {
  mode: ReadMode;
  groups: ReadGroupStats[];
  fallbacks: Record<FallbackReason, number>;
  /** Latest cumulative fuzzy-pass count reported by the reader (0 until a read ran). */
  fuzzyRuns: number;
}

export interface ReadStats {
  record(r: ReadRecord): void;
  fallback(reason: FallbackReason): void;
  setMode(mode: ReadMode): void;
  snapshot(now?: number): ReadStatsSnapshot;
}

const STATS_WINDOW = 256;

const percentile = (sorted: number[], p: number): number =>
  sorted.length === 0
    ? 0
    : sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];

export function createReadStats(window = STATS_WINDOW): ReadStats {
  const ring: ReadRecord[] = [];
  const fallbacks: Record<FallbackReason, number> = {
    'open-failed': 0,
    crashed: 0,
    dead: 0,
  };
  let mode: ReadMode = 'reader';
  let fuzzyRuns = 0;
  return {
    record(r) {
      if (r.fuzzyRuns !== undefined) fuzzyRuns = r.fuzzyRuns;
      ring.push(r);
      if (ring.length > window) ring.shift();
    },
    fallback(reason) {
      fallbacks[reason] += 1;
    },
    setMode(m) {
      mode = m;
    },
    snapshot(now = Date.now()) {
      const byKey = new Map<string, ReadRecord[]>();
      for (const r of ring) {
        const key = `${r.caller}|${r.method}|${r.via}`;
        const list = byKey.get(key);
        if (list) list.push(r);
        else byKey.set(key, [r]);
      }
      const groups: ReadGroupStats[] = [...byKey.values()].map((list) => {
        const total = list.map((r) => r.totalMs).sort((a, b) => a - b);
        const exec = list.map((r) => r.execMs).sort((a, b) => a - b);
        const newest = Math.max(...list.map((r) => r.at));
        return {
          caller: list[0].caller,
          method: list[0].method,
          via: list[0].via,
          count: list.length,
          p50Ms: percentile(total, 0.5),
          p95Ms: percentile(total, 0.95),
          maxMs: total[total.length - 1],
          execP95Ms: percentile(exec, 0.95),
          newestAgeMs: now - newest,
        };
      });
      return { mode, groups, fallbacks: { ...fallbacks }, fuzzyRuns };
    },
  };
}

/** A `Query` whose every method goes through one async invoker. */
export function queryFromInvoker(
  invoke: (method: QueryMethod, args: unknown[]) => Promise<unknown>,
): Query {
  const q: Record<string, unknown> = {};
  for (const m of QUERY_METHODS) {
    q[m] = (...args: unknown[]) => invoke(m, args);
  }
  return q as unknown as Query;
}

export function createReadProxy(
  readDb: AppDb,
  stats: ReadStats,
  caller: ReadCaller,
): Query {
  return queryFromInvoker(async (method, args) => {
    const t0 = performance.now();
    const res = (await readDb.proc!('read', { method, args })) as {
      value: unknown;
      execMs: number;
      fuzzyRuns?: number;
    };
    stats.record({
      caller,
      method,
      via: 'reader',
      execMs: res.execMs,
      totalMs: performance.now() - t0,
      at: Date.now(),
      fuzzyRuns: res.fuzzyRuns,
    });
    return res.value;
  });
}

type Invokable = Record<QueryMethod, (...a: unknown[]) => Promise<unknown>>;

export function withWriterFallback(deps: {
  proxy: ((caller: ReadCaller) => Query) | null;
  writer: Query;
  stats: ReadStats;
  log(level: 'warn' | 'error', msg: string): void;
  /** Why the reader could not be opened (only with `proxy: null`). */
  openError?: string;
}): { for(caller: ReadCaller): Query; mode(): ReadMode } {
  const { proxy, writer, stats, log } = deps;
  let sticky = proxy === null;
  if (proxy === null) {
    stats.fallback('open-failed');
    stats.setMode('writer');
    log(
      'warn',
      `[db] read worker unavailable: ${deps.openError ?? 'unknown error'} — reads use the writer`,
    );
  }
  const goSticky = (): void => {
    if (sticky) return;
    sticky = true;
    stats.setMode('writer');
    log('error', '[db] read worker is dead — reads use the writer');
  };
  const viaWriter = writer as unknown as Invokable;

  return {
    mode: () => (sticky ? 'writer' : 'reader'),
    for(caller) {
      const viaProxy = proxy ? (proxy(caller) as unknown as Invokable) : null;
      return queryFromInvoker(async (method, args) => {
        if (!sticky && viaProxy) {
          try {
            return await viaProxy[method](...args);
          } catch (e) {
            const code = (e as { code?: string } | null)?.code;
            if (code !== DB_WORKER_CRASHED && code !== DB_WORKER_DEAD) throw e;
            stats.fallback(code === DB_WORKER_DEAD ? 'dead' : 'crashed');
            if (code === DB_WORKER_DEAD) goSticky();
            // fall through: the writer answers this call, once
          }
        }
        const t0 = performance.now();
        const value = await viaWriter[method](...args);
        const ms = performance.now() - t0;
        stats.record({
          caller,
          method,
          via: 'writer',
          execMs: ms,
          totalMs: ms,
          at: Date.now(),
        });
        return value;
      });
    },
  };
}
```

Note for the stats test above: with the sorted window `45..300` (256 values), nearest-rank p50 is `sorted[ceil(0.5*256)-1] = sorted[127] = 172` and p95 is `sorted[ceil(0.95*256)-1] = sorted[243] = 288` — matches the asserted numbers.

- [ ] **Step 4: Run — expect PASS**

Run: `npx jest src/main/core/store/__tests__/read-proxy.test.ts`
Then: `npx tsc -p tsconfig.typecheck.json && npx eslint --fix src/main/core/store/read-proxy.ts src/main/core/store/__tests__/read-proxy.test.ts`

- [ ] **Step 5: Commit**

```bash
printf 'feat(reads): read proxy, writer fallback and per-caller read stats (#146)\n' > /tmp/msg-r4
git add src/main/core/store/read-proxy.ts src/main/core/store/__tests__/read-proxy.test.ts
git commit -F /tmp/msg-r4 -- src/main/core/store/read-proxy.ts src/main/core/store/__tests__/read-proxy.test.ts
```

---

### Task 5: `openReads`, boot wiring, routing, "reads don't queue behind writes"

Spec §3.3 (routing), §3.5 (open order, shutdown), §5 (no-queue test, routing gate).

**Files:**
- Create: `src/main/core/reads.ts`, `src/main/core/__tests__/reads.test.ts`, `src/main/core/__tests__/reads-no-queue.test.ts`, `src/main/__tests__/read-routing.test.ts`
- Modify: `src/main/core/boot.ts`, `src/main/main.ts`

**Interfaces:**
- Consumes: `openDbInWorker(..., { role: 'read', cacheKiB, execArgv })` (Task 3); `createReadStats`, `createReadProxy`, `withWriterFallback`, `ReadCaller`, `ReadStats`, `ReadMode` (Task 4); `hostBudget`.
- Produces:
  - `READ_CACHE_KIB = 8192`, `READ_CACHE_KIB_WEAK = 2048`, `readCacheKiB(weak: boolean): number`.
  - `openReads(deps: { dbPath: string; workerFile: string; execArgv?: string[]; writer: Query; weak: boolean; log(level: 'warn' | 'error', msg: string): void }): Promise<Reads>`.
  - `interface Reads { reads: Query; readsFor(caller: ReadCaller): Query; stats: ReadStats; mode(): ReadMode; close(): Promise<void> }`.
  - `CorePlatform.reads: Query`, `CorePlatform.readsFor(caller: ReadCaller): Query`.

- [ ] **Step 1: Write the failing tests**

`src/main/core/__tests__/reads.test.ts`:

```ts
/**
 * @jest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AccountId } from '@shared/contracts';

import { openDb, type AppDb } from '../../db/app-db';
import {
  createWorkerEnv,
  WORKER_ENTRY,
} from '../../db/__tests__/worker-test-env';
import { openReads, readCacheKiB, type Reads } from '../reads';
import { openStore, type CoreStore } from '../store/store';

jest.setTimeout(90_000);

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: (text: string) =>
    /[äöüß]|Rechnung/i.test(text) ? ['deu'] : ['eng'],
};

describe('openReads (real reader worker)', () => {
  const env = createWorkerEnv('reads');
  let dir: string;
  let dbPath: string;
  let writerDb: AppDb;
  let store: CoreStore;
  let accountId: AccountId;
  let plane: Reads | undefined;
  const log = jest.fn();

  const commitDoc = (externalId: string, markdown: string) =>
    store.commit({
      account: accountId,
      cursor: null,
      documents: [
        {
          externalId,
          type: 'note',
          title: `T ${externalId}`,
          markdown,
          metadata: {},
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
    });

  beforeEach(async () => {
    log.mockReset();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-reads-'));
    dbPath = path.join(dir, 'kiagent.db');
    writerDb = await openDb(dbPath);
    store = openStore(writerDb, deps);
    accountId = (await store.createAccount({ source: 'test', identifier: 'me@x' })).id;
  });

  afterEach(async () => {
    await plane?.close();
    plane = undefined;
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  afterAll(() => env.cleanup());

  it('a resolved commit is visible to the next read, including a new language', async () => {
    await commitDoc('en1', 'we run daily');
    plane = await openReads({
      dbPath,
      workerFile: WORKER_ENTRY,
      execArgv: env.execArgv,
      writer: store.read,
      weak: false,
      log,
    });
    expect(plane.mode()).toBe('reader');
    expect(await plane.reads.search({ text: 'Rechnungen' })).toHaveLength(0);
    await commitDoc('de1', 'Die Rechnung ist offen');
    const hits = await plane.reads.search({ text: 'Rechnungen' });
    expect(hits).toHaveLength(1);
    const doc = await plane.readsFor('mcp').document(hits[0].id);
    expect(doc?.externalId).toBe('de1');
    const groups = plane.stats.snapshot().groups;
    expect(groups.find((g) => g.caller === 'other' && g.method === 'search')).toMatchObject({
      via: 'reader',
      count: 2,
    });
    expect(groups.find((g) => g.caller === 'mcp' && g.method === 'document')).toBeDefined();
  });

  it('falls back to the writer when the reader cannot open (logged once, stats kept)', async () => {
    await commitDoc('en1', 'we run daily');
    plane = await openReads({
      dbPath,
      workerFile: path.join(dir, 'no-such-worker.js'),
      writer: store.read,
      weak: false,
      log,
    });
    expect(plane.mode()).toBe('writer');
    expect(log).toHaveBeenCalledTimes(1);
    const [level, msg] = log.mock.calls[0];
    expect(level).toBe('warn');
    expect(msg).toMatch(/^\[db\] read worker unavailable: .* — reads use the writer$/);
    expect(await plane.reads.accounts()).toHaveLength(1);
    expect(plane.stats.snapshot().fallbacks['open-failed']).toBe(1);
  });

  it('weak hosts get SQLite-default page cache', () => {
    expect(readCacheKiB(false)).toBe(8192);
    expect(readCacheKiB(true)).toBe(2048);
  });
});
```

`src/main/core/__tests__/reads-no-queue.test.ts` (the spec §5 headline test; a real writer worker + a real reader worker on one file):

```ts
/**
 * @jest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AccountId, DocumentInput } from '@shared/contracts';

import type { AppDb } from '../../db/app-db';
import {
  createWorkerEnv,
  WORKER_ENTRY,
} from '../../db/__tests__/worker-test-env';
import { openDbInWorker } from '../../db/worker-client';
import { openReads, type Reads } from '../reads';
import { openStore, type CoreStore } from '../store/store';

jest.setTimeout(120_000);

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};

/** Pseudo-random unique tokens, so the FTS + trigram indexes do real work. */
function bigBody(seed: number, words: number): string {
  let x = seed;
  const out: string[] = [];
  for (let i = 0; i < words; i += 1) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out.push(x.toString(36));
  }
  return out.join(' ');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('reads do not queue behind ingest writes (real writer + reader workers)', () => {
  const env = createWorkerEnv('no-queue');
  let dir: string;
  let writerDb: AppDb;
  let store: CoreStore;
  let plane: Reads;
  let account: AccountId;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-noqueue-'));
    const dbPath = path.join(dir, 'kiagent.db');
    writerDb = await openDbInWorker(dbPath, WORKER_ENTRY, {
      execArgv: env.execArgv,
    });
    store = openStore(writerDb, deps);
    account = (await store.createAccount({ source: 'test', identifier: 'me@x' })).id;
    await store.commit({
      account,
      cursor: 1,
      documents: Array.from({ length: 200 }, (_, i): DocumentInput => ({
        externalId: `seed${i}`,
        type: 'note',
        title: `Seed ${i}`,
        markdown: `alpha beta note ${i}`,
        metadata: { labels: ['L1'], from: `person${i % 7}@example.com` },
        createdAt: '2026-01-01T00:00:00Z',
      })),
    });
    plane = await openReads({
      dbPath,
      workerFile: WORKER_ENTRY,
      execArgv: env.execArgv,
      writer: store.read,
      weak: false,
      log: () => {},
    });
  });

  afterAll(async () => {
    await plane.close();
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    env.cleanup();
  });

  it('serves search + document + countBy while the writer is mid-transaction; the writer path queues', async () => {
    const [seedHit] = await plane.reads.search({ text: 'alpha', limit: 1 });
    expect(seedHit).toBeDefined();

    // A real large ingest: DOCS documents x ~2.3 MB, FTS + trigram + stem views
    // in ONE transaction on the writer thread. Default 8 (~18 MB: enough to
    // span the reads on a normal machine without a heavy structured clone). If
    // this machine finishes it before the 300 ms check, raise DOCS until
    // `commitSettled === false` holds; if the suite nears its timeout or the
    // worker runs out of memory, lower it. Never weaken the assertions.
    const DOCS = 8;
    const documents = Array.from({ length: DOCS }, (_, i): DocumentInput => ({
      externalId: `big${i}`,
      type: 'note',
      title: `Big ${i}`,
      markdown: bigBody(i + 1, 330_000),
      metadata: {},
      createdAt: '2026-02-01T00:00:00Z',
    }));
    let commitSettled = false;
    const commitP = store
      .commit({ account, cursor: 2, documents })
      .then(() => {
        commitSettled = true;
      });
    await sleep(300); // the writer thread is now inside the transaction
    expect(commitSettled).toBe(false); // fixture big enough to span the reads

    const t0 = Date.now();
    const [hits, doc, counts] = await Promise.all([
      plane.reads.search({ text: 'alpha', limit: 5 }),
      plane.reads.document(seedHit.id),
      plane.reads.countBy({ field: 'label' }),
    ]);
    const readsMs = Date.now() - t0;
    expect(hits.length).toBeGreaterThan(0);
    expect(doc?.id).toBe(seedHit.id);
    expect(counts[0]).toMatchObject({ key: 'L1' });
    // The reader answered while the writer was still mid-transaction...
    expect(commitSettled).toBe(false);
    expect(readsMs).toBeLessThan(2_000);

    // ...whereas a read issued on the writer connection waits behind it.
    await store.read.document(seedHit.id);
    expect(commitSettled).toBe(true);
    await commitP;

    // Read-after-write: the resolved commit is visible to the very next reader call.
    const after = await plane.reads.search({ text: 'Big', limit: 5 });
    expect(after.length).toBeGreaterThan(0);
  });

  it('serves reads while the writer runs ONE long reconcile-stage transaction; the writer path queues behind it', async () => {
    const [seedHit] = await plane.reads.search({ text: 'alpha', limit: 1 });
    expect(seedHit).toBeDefined();

    // reconcileBegin/Stage are real writer procedures. ONE reconcileStage call
    // with REFS refs is ONE transaction on the writer thread; size it like the
    // ingest case: it must run for >= ~300 ms on this machine. If the first
    // `stageSettled === false` check fails the stage was too fast: raise REFS;
    // if the suite nears its timeout or the worker runs out of memory, lower it.
    // Never weaken the assertions.
    const REFS = 300_000;
    await store.reconcileBegin(account);
    const refs = Array.from({ length: REFS }, (_, i) => ({
      externalId: `stage-${i}`,
      type: 'note',
    }));
    let stageSettled = false;
    const stageP = store.reconcileStage(account, refs).then(() => {
      stageSettled = true;
    });
    await sleep(300); // the writer thread is now inside the stage transaction
    expect(stageSettled).toBe(false); // fixture big enough to span the reads

    const t0 = Date.now();
    const [hits, doc, counts] = await Promise.all([
      plane.reads.search({ text: 'alpha', limit: 5 }),
      plane.reads.document(seedHit.id),
      plane.reads.countBy({ field: 'label' }),
    ]);
    const readsMs = Date.now() - t0;
    expect(hits.length).toBeGreaterThan(0);
    expect(doc?.id).toBe(seedHit.id);
    expect(counts[0]).toMatchObject({ key: 'L1' });
    // The reader calls finished BEFORE the single stage transaction settled...
    expect(stageSettled).toBe(false);
    expect(readsMs).toBeLessThan(2_000);

    // ...whereas a read issued on the writer path waits behind it.
    await store.read.document(seedHit.id);
    expect(stageSettled).toBe(true);
    await stageP;
    await store.reconcileEnd(account);
  });
});
```

`src/main/__tests__/read-routing.test.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';

const read = (rel: string) =>
  fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

describe('read routing (spec §3.3)', () => {
  it('MCP and the renderer foreground IPC use the read plane', () => {
    const main = read('main.ts');
    expect(main).toMatch(/query:\s*p\.readsFor\('mcp'\)/);
    expect(main).toMatch(/'search:query':\s*\(req\)\s*=>\s*p\.readsFor\('renderer'\)\.search\(/);
    expect(main).toMatch(/'docs:get':\s*\(\{ id \}\)\s*=>\s*p\.readsFor\('renderer'\)\.document\(/);
    expect(main).toMatch(/'docs:children':\s*\(\{ id \}\)\s*=>\s*p\.readsFor\('renderer'\)\.children\(/);
    expect(main).not.toMatch(/p\.store\.read\.(search|document|children)\b/);
  });

  it('the extension slice, engine, evidence, outbound and factory reset stay on the writer', () => {
    for (const rel of [
      'platform/extension-platform.ts',
      'core/engine/engine.ts',
      'core/engine/message-evidence.ts',
      'outbound/service.ts',
      'factory-reset.ts',
    ]) {
      expect(read(rel)).not.toMatch(/\breadsFor\b|\.reads\b/);
    }
    expect(read('platform/extension-platform.ts')).toMatch(
      /withAccountTypes\(deps\.store\.read/,
    );
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx jest src/main/core/__tests__/reads.test.ts src/main/__tests__/read-routing.test.ts`
Expected: FAIL — `Cannot find module '../reads'`, routing regexes unmatched. (Do NOT run `reads-no-queue` yet; it needs Step 3.)

- [ ] **Step 3: `src/main/core/reads.ts`**

```ts
/**
 * The foreground read plane: a read-only DB worker (Task 3) behind a thin
 * proxy, with the writer as the answer to every reader failure (spec §3.5).
 * `bootCore` opens it AFTER the writer's `openDbInWorker` resolved — the writer
 * migrates, readers never do.
 */
import type { Query } from '@shared/contracts';

import type { AppDb } from '../db/app-db';
import { openDbInWorker } from '../db/worker-client';
import {
  createReadProxy,
  createReadStats,
  withWriterFallback,
  type ReadCaller,
  type ReadMode,
  type ReadStats,
} from './store/read-proxy';

export const READ_CACHE_KIB = 8192;
/** SQLite's own default (-2000 KiB): weak hosts keep their memory. */
export const READ_CACHE_KIB_WEAK = 2048;

export const readCacheKiB = (weak: boolean): number =>
  weak ? READ_CACHE_KIB_WEAK : READ_CACHE_KIB;

export interface Reads {
  /** The foreground read path, attributed to caller 'other'. */
  reads: Query;
  readsFor(caller: ReadCaller): Query;
  stats: ReadStats;
  mode(): ReadMode;
  close(): Promise<void>;
}

export async function openReads(deps: {
  dbPath: string;
  workerFile: string;
  execArgv?: string[];
  writer: Query;
  weak: boolean;
  log(level: 'warn' | 'error', msg: string): void;
}): Promise<Reads> {
  const stats = createReadStats();
  let readDb: AppDb | null = null;
  let openError: string | undefined;
  try {
    readDb = await openDbInWorker(deps.dbPath, deps.workerFile, {
      role: 'read',
      cacheKiB: readCacheKiB(deps.weak),
      execArgv: deps.execArgv,
    });
  } catch (e) {
    openError = e instanceof Error ? e.message : String(e);
  }
  const opened = readDb;
  const router = withWriterFallback({
    proxy: opened ? (caller) => createReadProxy(opened, stats, caller) : null,
    writer: deps.writer,
    stats,
    log: deps.log,
    openError,
  });
  return {
    reads: router.for('other'),
    readsFor: (caller) => router.for(caller),
    stats,
    mode: router.mode,
    close: async () => {
      if (opened) await opened.close();
    },
  };
}
```

- [ ] **Step 4: `boot.ts` wiring.** Add `Query` to the `@shared/contracts` type imports and:

```ts
import { openReads } from './reads';
import type { ReadCaller } from './store/read-proxy';
```

`BootDeps` is unchanged (no test boots a worker through it; `openReads` already takes `execArgv` for its own tests). Keep the writer open as it is, and open the reader right after the store exists:

```ts
  const dbPath = path.join(deps.dataDir, 'kiagent.db');
  const db = await openDbInWorker(dbPath, deps.dbWorkerFile);
  const store = openStore(db, {
    encrypt: deps.encrypt,
    decrypt: deps.decrypt,
    detectLanguages,
    profileDir: deps.dataDir,
  });
  // Foreground reads (MCP, renderer) run on their own read-only worker so they
  // never queue behind ingest writes. Opened AFTER the writer migrated.
  const readPlane = await openReads({
    dbPath,
    workerFile: deps.dbWorkerFile,
    writer: store.read,
    weak: hostBudget(host, null).weak,
    log: (level, msg) => sink.log('db', level, msg),
  });
```

In `CorePlatform` add:

```ts
  /** Foreground read path (MCP, renderer): the read worker with writer fallback.
   *  Attributed to caller 'other' in read diagnostics. */
  reads: Query;
  /** Same path, attributed to `caller` in read diagnostics. */
  readsFor(caller: ReadCaller): Query;
```

In the `platform` literal add `reads: readPlane.reads, readsFor: readPlane.readsFor,` and change `shutdown` to close the reader first:

```ts
    shutdown: async () => {
      scheduler.stop();
      await engine.stopAll();
      await readPlane.close();
      await store.close();
    },
```

- [ ] **Step 5: `main.ts` routing.**

```ts
    'search:query': (req) => p.readsFor('renderer').search(req ?? {}),
    'docs:get': ({ id }) => p.readsFor('renderer').document(id),
    'docs:children': ({ id }) => p.readsFor('renderer').children(id),
```

and in `startMcp({ … })`: `query: p.readsFor('mcp'),`. Leave `p.store.read.accounts()` (boot, `storage:stats`) and everything else untouched.

- [ ] **Step 6: Run — expect PASS**

Run (one at a time): `npx jest src/main/core/__tests__/reads.test.ts`, then `npx jest src/main/__tests__/read-routing.test.ts`, then `npx jest src/main/core/__tests__/reads-no-queue.test.ts`.
Expected: all PASS. If the no-queue test's first `expect(commitSettled).toBe(false)` fails, the commit was too fast for this machine: raise `DOCS` (default 8); if it times out or the writer worker runs out of memory, lower `DOCS`. If the reconcile test's first `stageSettled === false` check fails, raise `REFS`. Never weaken the assertions.
Then: `npx tsc -p tsconfig.typecheck.json && npx eslint --fix src/main/core/reads.ts src/main/core/boot.ts src/main/main.ts src/main/core/__tests__/reads.test.ts src/main/core/__tests__/reads-no-queue.test.ts src/main/__tests__/read-routing.test.ts`

- [ ] **Step 7: Commit**

```bash
printf 'feat(reads): read worker plane wired into boot; MCP and renderer reads routed to it (#146)\n' > /tmp/msg-r5
git add src/main/core/reads.ts src/main/core/__tests__/reads.test.ts src/main/core/__tests__/reads-no-queue.test.ts src/main/__tests__/read-routing.test.ts
git commit -F /tmp/msg-r5 -- src/main/core/reads.ts src/main/core/boot.ts src/main/main.ts src/main/core/__tests__/reads.test.ts src/main/core/__tests__/reads-no-queue.test.ts src/main/__tests__/read-routing.test.ts
```

---

### Task 6: `query_sql` in a killable process

Spec §3.4. Four deliverables, one task because none is useful alone: bounded result, runner state machine, runner process + spawn adapters, and the MCP server/stdio/main wiring.

**Files:**
- Create: `src/main/core/mcp/sql-runner.ts`, `src/main/core/mcp/sql-runner-spawn.ts`, `src/main/core/mcp/sql-runner-entry.ts`, `src/main/core/mcp/__tests__/query-sql-bounds.test.ts`, `src/main/core/mcp/__tests__/sql-runner.test.ts`, `src/main/core/mcp/__tests__/sql-runner-spawn.test.ts`, `src/main/core/mcp/__tests__/sql-runner-process.test.ts`, `src/main/core/mcp/__tests__/fixtures/sigterm-ignoring-runner.cjs`
- Modify: `src/main/core/mcp/tools/query-sql.ts`, `src/main/core/mcp/tools/raw-sql.ts`, `src/main/core/mcp/server.ts`, `src/main/mcp/stdio-entry.ts`, `src/main/main.ts`, `.erb/configs/webpack.config.main.prod.ts`, `.erb/configs/webpack.config.main.dev.ts`, `src/main/core/mcp/__tests__/raw-sql.test.ts`, `src/main/core/mcp/__tests__/raw-sql-wiring.test.ts`, `src/main/core/mcp/__tests__/server.test.ts`, `src/main/core/mcp/__tests__/mcp-session-factory.test.ts`, `src/main/core/mcp/__tests__/outbound-routes.test.ts`, `src/main/mcp/__tests__/stdio-entry.test.ts`, `src/main/__tests__/read-routing.test.ts`

**Interfaces:**
- Consumes: `openCorpusReadConnection(path, { cacheKiB, queryOnly })` (Task 3); `createWorkerEnv`, `REPO_ROOT` (Task 3).
- Produces:
  - `query-sql.ts`: `type QuerySqlExecutor = (sql: string) => Promise<QuerySqlResult>`; `MAX_ROWS = 500`, `MAX_VALUE_BYTES = 65536` (UTF-8 bytes, never splitting a code point), `MAX_RESULT_BYTES = 1048576`; `runQuerySqlBounded(conn, sql): { result: QuerySqlResult; bytes: number }`; `runQuerySql(conn, sql): QuerySqlResult` (unchanged signature).
  - `sql-runner.ts`: `interface RunnerChild { readonly pid: number | undefined; send(msg: unknown): void; onMessage(cb: (msg: unknown) => void): void; onExit(cb: (code: number | null) => void): void; kill(signal: 'SIGTERM' | 'SIGKILL'): void }`; `type SqlRunnerState = 'none' | 'starting' | 'ready' | 'stopping' | 'stuck'`; `SQL_UNAVAILABLE`, `SQL_STILL_STOPPING`, `sqlStoppedMessage(timeoutMs)`; `interface SqlRunRecord`; `interface SqlRunnerDiagnostics { state; pid: number | null; timeouts: number; recent: SqlRunRecord[] }`; `interface SqlExecutorHandle { exec: QuerySqlExecutor; stop(): Promise<void>; diagnostics?(): SqlRunnerDiagnostics }`; `interface SqlRunner extends SqlExecutorHandle { diagnostics(): SqlRunnerDiagnostics }`; `createSqlRunner(opts: SqlRunnerOptions): SqlRunner`.
  - `sql-runner-spawn.ts`: `forkRunnerChild(modulePath, opts?: { env?, execArgv?, cwd? }): RunnerChild`, `utilityRunnerChild(modulePath, env, onOutput?): RunnerChild`.
  - `raw-sql.ts`: `createRawSqlTools(exec: QuerySqlExecutor): { tools: McpTool[] }`; `createInProcessSqlExecutor(source: string | BetterSqlite3.Database): SqlExecutorHandle`.
  - `McpDeps.sqlExecutor: SqlExecutorHandle` (REQUIRED — the server has no default and opens no handle itself); `McpServerHandle.sqlDiagnostics(): SqlRunnerDiagnostics | null`.

- [ ] **Step 1: Write the failing bounds test** — `src/main/core/mcp/__tests__/query-sql-bounds.test.ts`

```ts
/** @jest-environment node */
import Database from 'better-sqlite3';

import {
  MAX_RESULT_BYTES,
  MAX_ROWS,
  MAX_VALUE_BYTES,
  runQuerySql,
  runQuerySqlBounded,
} from '../tools/query-sql';

const MARK = '…[truncated]';
const series = (n: number, cols: string) =>
  `WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i < ${n}) SELECT ${cols} FROM c`;

describe('runQuerySql bounds', () => {
  let conn: Database.Database;
  beforeEach(() => {
    conn = new Database(':memory:');
  });
  afterEach(() => conn.close());

  it('stops at 500 rows', () => {
    const r = runQuerySql(conn, series(600, 'i'));
    expect(r.rows).toHaveLength(MAX_ROWS);
    expect(r.truncated).toBe(true);
  });

  it('cuts every string value at 64 KiB with a marker and says so', () => {
    const r = runQuerySql(conn, `SELECT hex(randomblob(40000)) AS big`);
    const big = r.rows[0].big as string;
    expect(big.endsWith(MARK)).toBe(true);
    expect(big.length).toBe(65536 + MARK.length); // ASCII: bytes == chars
    expect(r.truncated).toBe(true);
    expect(r.hint).toMatch(/64 KiB/);
  });

  it('cuts non-ASCII values by UTF-8 BYTES, never inside a code point', () => {
    // 'ü' = 2 bytes, '日本' = 3 bytes each, '😀' = 4 bytes (surrogate pair).
    for (const unit of ['ü', '日本', '😀', 'aü日😀']) {
      const text = unit.repeat(Math.ceil(80_000 / Buffer.byteLength(unit)));
      const r = runQuerySql(conn, `SELECT '${text}' AS v`);
      const v = r.rows[0].v as string;
      expect(v.endsWith(MARK)).toBe(true);
      const body = v.slice(0, -MARK.length);
      expect(Buffer.byteLength(body)).toBeLessThanOrEqual(MAX_VALUE_BYTES);
      expect(Buffer.byteLength(body)).toBeGreaterThan(MAX_VALUE_BYTES - 4);
      expect(body).not.toMatch(/\uFFFD/); // no split code point
      expect(text.startsWith(body)).toBe(true);
      expect(r.truncated).toBe(true);
    }
  });

  it('does not cut a value of exactly 64 KiB (boundary), cuts one byte more', () => {
    const exact = runQuerySql(conn, `SELECT '${'a'.repeat(MAX_VALUE_BYTES)}' AS v`);
    expect(exact.rows[0].v).toBe('a'.repeat(MAX_VALUE_BYTES));
    expect(exact.truncated).toBe(false);
    // 2-byte chars landing exactly on the limit are kept whole...
    const twoByte = 'ü'.repeat(MAX_VALUE_BYTES / 2);
    const keep = runQuerySql(conn, `SELECT '${twoByte}' AS v`);
    expect(keep.rows[0].v).toBe(twoByte);
    expect(keep.truncated).toBe(false);
    // ...one more byte cuts.
    const over = runQuerySql(conn, `SELECT '${'a'.repeat(MAX_VALUE_BYTES + 1)}' AS v`);
    expect((over.rows[0].v as string).endsWith(MARK)).toBe(true);
    expect(over.truncated).toBe(true);
  });

  it('stops at 1 MiB of serialized row data (array brackets and commas included), whichever limit comes first', () => {
    const r = runQuerySql(conn, series(600, 'i, hex(randomblob(100000)) AS big'));
    expect(r.truncated).toBe(true);
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows.length).toBeLessThan(MAX_ROWS);
    // The FULL serialized array, exactly as it is transferred.
    expect(Buffer.byteLength(JSON.stringify(r.rows))).toBeLessThanOrEqual(
      MAX_RESULT_BYTES,
    );
    expect(r.hint).toMatch(/1 MiB/);
  });

  it('accounts for the array overhead: many tiny rows still serialize within 1 MiB', () => {
    // Each row serializes to ~14 bytes + a comma; 500 rows is far below 1 MiB,
    // so make the budget bind with wide-but-legal rows (60 KiB each).
    const r = runQuerySqlBounded(conn, series(30, `i, hex(randomblob(30000)) AS big`));
    expect(Buffer.byteLength(JSON.stringify(r.result.rows))).toBeLessThanOrEqual(
      MAX_RESULT_BYTES,
    );
    // `bytes` is the serialized size of the rows array as transferred.
    expect(r.bytes).toBe(Buffer.byteLength(JSON.stringify(r.result.rows)));
    expect(r.result.truncated).toBe(true);
  });

  it('a 500-row cut sets truncated and a hint', () => {
    const r = runQuerySql(conn, series(600, 'i'));
    expect(r.rows).toHaveLength(MAX_ROWS);
    expect(r.truncated).toBe(true);
    expect(r.hint).toMatch(/500 rows/);
  });

  it('returns no rows and says why when ONE row alone exceeds 1 MiB', () => {
    const cols = Array.from({ length: 20 }, (_, i) => `hex(randomblob(40000)) AS c${i}`).join(', ');
    const r = runQuerySql(conn, `SELECT ${cols}`);
    expect(r.rows).toEqual([]);
    expect(r.truncated).toBe(true);
    expect(r.hint).toMatch(/single row exceeds 1 MiB/);
  });

  it('replaces blobs with a placeholder instead of serializing them', () => {
    const r = runQuerySql(conn, `SELECT randomblob(10) AS b`);
    expect(r.rows).toEqual([{ b: '<blob 10 bytes>' }]);
  });

  it('still gates non-SELECT statements', () => {
    expect(() => runQuerySql(conn, 'DELETE FROM x')).toThrow(/only SELECT/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/main/core/mcp/__tests__/query-sql-bounds.test.ts`
Expected: FAIL — `MAX_RESULT_BYTES` not exported / unbounded behaviour.

- [ ] **Step 3: Bounded `runQuerySql`.** In `src/main/core/mcp/tools/query-sql.ts` replace everything from `export interface QuerySqlResult` to the end of the file with:

```ts
export interface QuerySqlResult {
  rows: Record<string, unknown>[];
  truncated: boolean;
  hint?: string;
}

/** What the MCP tool (and the runner process) executes SQL with. */
export type QuerySqlExecutor = (sql: string) => Promise<QuerySqlResult>;

export const MAX_ROWS = 500;
/** One string value is cut at this many UTF-8 BYTES (never inside a code
 *  point), with TRUNCATED_MARK appended. */
export const MAX_VALUE_BYTES = 64 * 1024;
/** The serialized rows array (JSON, brackets and commas included) is cut here,
 *  so a result is bounded in BYTES as it is transferred. */
export const MAX_RESULT_BYTES = 1024 * 1024;
const TRUNCATED_MARK = '…[truncated]';

function cutValue(v: unknown): { value: unknown; cut: boolean } {
  // A UTF-16 unit is at most 3 UTF-8 bytes (a surrogate pair is 4 bytes for 2
  // units), so short strings need no byte count at all.
  if (typeof v === 'string' && v.length * 3 > MAX_VALUE_BYTES) {
    const buf = Buffer.from(v, 'utf8');
    if (buf.length > MAX_VALUE_BYTES) {
      let end = MAX_VALUE_BYTES;
      // Back up to a code-point boundary: byte `end` must not be a continuation byte.
      while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
      return {
        value: `${buf.toString('utf8', 0, end)}${TRUNCATED_MARK}`,
        cut: true,
      };
    }
    return { value: v, cut: false };
  }
  if (Buffer.isBuffer(v)) return { value: `<blob ${v.length} bytes>`, cut: false };
  return { value: v, cut: false };
}

/** Same gates as before (textual SELECT/WITH + the driver's own guard), but the
 *  rows are materialized INCREMENTALLY with `.iterate()` and the result is
 *  bounded by rows, by bytes and per value — in the process that owns the
 *  connection, before anything is transferred. */
export function runQuerySqlBounded(
  conn: BetterSqlite3.Database,
  sql: string,
): { result: QuerySqlResult; bytes: number } {
  const stripped = sql
    .replace(/^\s+/, '')
    .replace(/^(--[^\n]*\n)+/, '') // drop ALL leading -- comment lines
    .trimStart();
  if (!/^(select|with)\b/i.test(stripped)) {
    throw new Error('query_sql: only SELECT / WITH statements are allowed');
  }
  const stmt = conn.prepare(
    `SELECT * FROM (${stripped}) LIMIT ${MAX_ROWS + 1}`,
  );
  const rows: Record<string, unknown>[] = [];
  // Serialized size of the rows array as it will be transferred: '[' + ']'
  // plus a ',' between rows plus each row's own JSON.
  let bytes = 2;
  let rowCut = false;
  let byteCut = false;
  let valueCut = false;
  for (const raw of stmt.iterate() as IterableIterator<Record<string, unknown>>) {
    if (rows.length >= MAX_ROWS) {
      rowCut = true;
      break;
    }
    const row: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw)) {
      const c = cutValue(v);
      row[k] = c.value;
      if (c.cut) valueCut = true;
    }
    const size = Buffer.byteLength(JSON.stringify(row)) + (rows.length > 0 ? 1 : 0);
    if (bytes + size > MAX_RESULT_BYTES) {
      byteCut = true;
      break; // leaving the loop resets the statement
    }
    rows.push(row);
    bytes += size;
  }
  const first = rows[0];
  const hints: string[] = [];
  if (
    first &&
    ('id' in first || 'doc_id' in first) &&
    !('url' in first) &&
    !('source_url' in first)
  ) {
    hints.push(
      'these rows look like documents — include d.url in the SELECT so each one can be cited/linked when presented.',
    );
  }
  if (rowCut) {
    hints.push(`result cut at ${MAX_ROWS} rows — add a LIMIT/OFFSET or narrow the WHERE.`);
  }
  if (byteCut) {
    hints.push(
      rows.length === 0
        ? 'a single row exceeds 1 MiB — select fewer or shorter columns.'
        : 'result cut at 1 MiB of row data — select fewer or shorter columns, or add a LIMIT.',
    );
  }
  if (valueCut) {
    hints.push('long text values were cut at 64 KiB (UTF-8 bytes) — use substr() to read a part.');
  }
  return {
    result: {
      rows,
      truncated: rowCut || byteCut || valueCut,
      hint: hints.length ? hints.join(' ') : undefined,
    },
    bytes,
  };
}

export function runQuerySql(
  conn: BetterSqlite3.Database,
  sql: string,
): QuerySqlResult {
  return runQuerySqlBounded(conn, sql).result;
}
```

Run `npx jest src/main/core/mcp/__tests__/query-sql-bounds.test.ts src/main/core/mcp/__tests__/query-sql.test.ts` — both PASS (the pre-existing query-sql suite pins the gate, the 500 cap and the document hint and must not change).

- [ ] **Step 4: Write the failing runner state-machine test** — `src/main/core/mcp/__tests__/sql-runner.test.ts`

```ts
import {
  createSqlRunner,
  SQL_STILL_STOPPING,
  SQL_UNAVAILABLE,
  sqlStoppedMessage,
  type RunnerChild,
} from '../sql-runner';

function fakeChild(pid: number) {
  const msgCbs: Array<(m: unknown) => void> = [];
  const exitCbs: Array<(c: number | null) => void> = [];
  const sent: Array<{ id: number; sql: string }> = [];
  const kills: string[] = [];
  const child: RunnerChild = {
    pid,
    send: (m) => {
      sent.push(m as never);
    },
    onMessage: (cb) => {
      msgCbs.push(cb);
    },
    onExit: (cb) => {
      exitCbs.push(cb);
    },
    kill: (s) => {
      kills.push(s);
    },
  };
  return {
    child,
    sent,
    kills,
    say: (m: unknown) => msgCbs.forEach((cb) => cb(m)),
    exit: (code: number | null = 0) => exitCbs.forEach((cb) => cb(code)),
  };
}

function harness() {
  const children: Array<ReturnType<typeof fakeChild>> = [];
  const log = jest.fn();
  const spawn = jest.fn(() => {
    const c = fakeChild(1000 + children.length);
    children.push(c);
    return c.child;
  });
  const runner = createSqlRunner({
    spawn,
    timeoutMs: 10_000,
    idleMs: 300_000,
    log,
  });
  return { runner, children, spawn, log };
}

const reply = (id: number, rows: unknown[] = []) => ({
  id,
  ok: true,
  result: { rows, truncated: false },
  bytes: 10,
  execMs: 1,
});

describe('createSqlRunner', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('spawns on the first call, sends only after ready, serializes calls', async () => {
    const { runner, children, spawn } = harness();
    const p1 = runner.exec('SELECT 1');
    const p2 = runner.exec('SELECT 2');
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(runner.diagnostics().state).toBe('starting');
    expect(children[0].sent).toEqual([]);
    children[0].say({ t: 'ready' });
    expect(children[0].sent.map((s) => s.sql)).toEqual(['SELECT 1']);
    children[0].say(reply(1, [{ one: 1 }]));
    await expect(p1).resolves.toEqual({ rows: [{ one: 1 }], truncated: false });
    expect(children[0].sent.map((s) => s.sql)).toEqual(['SELECT 1', 'SELECT 2']);
    children[0].say(reply(2));
    await p2;
    expect(runner.diagnostics().state).toBe('ready');
  });

  it('passes a SQL error message through unchanged', async () => {
    const { runner, children } = harness();
    const p = runner.exec('SELECT * FROM nope');
    children[0].say({ t: 'ready' });
    children[0].say({ id: 1, ok: false, message: 'no such table: nope' });
    await expect(p).rejects.toThrow('no such table: nope');
  });

  it('times out: message, SIGTERM, stopping state, retry message, fresh child afterwards', async () => {
    const { runner, children, spawn } = harness();
    const p1 = runner.exec('slow');
    children[0].say({ t: 'ready' });
    const rejected = expect(p1).rejects.toThrow(sqlStoppedMessage(10_000));
    await jest.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(sqlStoppedMessage(10_000)).toBe(
      'query_sql stopped after 10 s. Narrow it: filter by account or created_at, avoid LIKE over markdown, or use search.',
    );
    expect(runner.diagnostics()).toMatchObject({ state: 'stopping', pid: 1000, timeouts: 1 });
    expect(children[0].kills).toEqual(['SIGTERM']);
    await expect(runner.exec('x')).rejects.toThrow(SQL_STILL_STOPPING);
    expect(SQL_STILL_STOPPING).toBe(
      'query_sql is still stopping the previous query. Try again in a few seconds.',
    );

    children[0].exit(null);
    expect(runner.diagnostics().state).toBe('none');
    const p2 = runner.exec('SELECT 2');
    expect(spawn).toHaveBeenCalledTimes(2);
    children[1].say({ t: 'ready' });
    children[1].say(reply(children[1].sent[0].id, [{ two: 2 }]));
    await expect(p2).resolves.toMatchObject({ rows: [{ two: 2 }] });
  });

  it('escalates to SIGKILL after 2 s of ignored SIGTERM', async () => {
    const { runner, children } = harness();
    const p = runner.exec('slow');
    children[0].say({ t: 'ready' });
    const rejected = expect(p).rejects.toThrow(/stopped after/);
    await jest.advanceTimersByTimeAsync(10_000);
    await rejected;
    await jest.advanceTimersByTimeAsync(1_999);
    expect(children[0].kills).toEqual(['SIGTERM']);
    await jest.advanceTimersByTimeAsync(1);
    expect(children[0].kills).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('goes stuck when nothing exits 5 s after SIGKILL: never a second child; a late exit recovers', async () => {
    const { runner, children, spawn, log } = harness();
    const p = runner.exec('slow');
    children[0].say({ t: 'ready' });
    const rejected = expect(p).rejects.toThrow(/stopped after/);
    await jest.advanceTimersByTimeAsync(10_000 + 2_000 + 5_000);
    await rejected;
    expect(runner.diagnostics().state).toBe('stuck');
    expect(log).toHaveBeenCalledWith('error', expect.stringContaining('did not exit'));
    await expect(runner.exec('x')).rejects.toThrow(SQL_UNAVAILABLE);
    expect(spawn).toHaveBeenCalledTimes(1);
    children[0].exit(null); // the OS finally reaped it
    expect(runner.diagnostics().state).toBe('none');
    const p2 = runner.exec('SELECT 3');
    expect(spawn).toHaveBeenCalledTimes(2);
    children[1].say({ t: 'ready' });
    children[1].say(reply(children[1].sent[0].id));
    await p2;
  });

  it("a waiting caller's 10 s starts when its own statement starts", async () => {
    const { runner, children } = harness();
    const p1 = runner.exec('a');
    const p2 = runner.exec('b');
    children[0].say({ t: 'ready' });
    await jest.advanceTimersByTimeAsync(9_000);
    children[0].say(reply(1));
    await p1;
    expect(children[0].sent.map((s) => s.sql)).toEqual(['a', 'b']);
    await jest.advanceTimersByTimeAsync(9_000); // 18 s since the call, 9 s since b started
    expect(runner.diagnostics().timeouts).toBe(0);
    const rejected = expect(p2).rejects.toThrow(/stopped after/);
    await jest.advanceTimersByTimeAsync(1_000);
    await rejected;
    expect(runner.diagnostics().timeouts).toBe(1);
  });

  it('spawn failure: unavailable message, error logged, the next call retries the spawn', async () => {
    const { runner, children, spawn, log } = harness();
    spawn.mockImplementationOnce(() => {
      throw new Error('native module failed to load');
    });
    await expect(runner.exec('x')).rejects.toThrow(SQL_UNAVAILABLE);
    expect(log).toHaveBeenCalledWith('error', expect.stringContaining('native module failed to load'));
    const p = runner.exec('SELECT 1');
    expect(spawn).toHaveBeenCalledTimes(2);
    children[0].say({ t: 'ready' });
    children[0].say(reply(children[0].sent[0].id));
    await p;
  });

  it('an open-error from the child is unavailable and the child is stopped', async () => {
    const { runner, children } = harness();
    const p = runner.exec('x');
    const rejected = expect(p).rejects.toThrow(SQL_UNAVAILABLE);
    children[0].say({ t: 'open-error', message: 'cannot load better-sqlite3' });
    await rejected;
    expect(children[0].kills).toEqual(['SIGTERM']);
  });

  it('an unexpected exit while a statement runs fails the caller and the next call spawns', async () => {
    const { runner, children, spawn } = harness();
    const p = runner.exec('x');
    children[0].say({ t: 'ready' });
    const rejected = expect(p).rejects.toThrow(SQL_UNAVAILABLE);
    children[0].exit(137); // OOM-killed
    await rejected;
    expect(runner.diagnostics().state).toBe('none');
    void runner.exec('y').catch(() => {});
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('kills an idle child after idleMs', async () => {
    const { runner, children } = harness();
    const p = runner.exec('SELECT 1');
    children[0].say({ t: 'ready' });
    children[0].say(reply(1));
    await p;
    await jest.advanceTimersByTimeAsync(299_999);
    expect(children[0].kills).toEqual([]);
    await jest.advanceTimersByTimeAsync(1);
    expect(children[0].kills).toEqual(['SIGTERM']);
    expect(runner.diagnostics().state).toBe('stopping');
    children[0].exit(0);
    expect(runner.diagnostics().state).toBe('none');
  });

  it('stop() kills the child, resolves once it exited, and refuses later calls', async () => {
    const { runner, children } = harness();
    const p = runner.exec('SELECT 1');
    children[0].say({ t: 'ready' });
    children[0].say(reply(1));
    await p;
    const stopped = runner.stop();
    expect(children[0].kills).toEqual(['SIGTERM']);
    children[0].exit(0);
    await stopped;
    await expect(runner.exec('x')).rejects.toThrow(SQL_UNAVAILABLE);
  });
});
```

- [ ] **Step 5: Run to verify it fails**

Run: `npx jest src/main/core/mcp/__tests__/sql-runner.test.ts`
Expected: FAIL — `Cannot find module '../sql-runner'`.

- [ ] **Step 6: `src/main/core/mcp/sql-runner.ts`**

```ts
/**
 * Owns the ONE killable process `query_sql` runs in (spec §3.4). A running
 * SQLite statement cannot be interrupted from JS (better-sqlite3 has no
 * sqlite3_interrupt; `worker.terminate()` waits for the native call), so the
 * only real stop is a process kill. States:
 *
 *   none → starting → ready → stopping → none      (+ stuck)
 *
 * At most ONE child exists and it is owned until its `exit` is confirmed.
 * The child is injected as a `RunnerChild` so the same machine runs over
 * Electron's utilityProcess in the app and child_process.fork in jest.
 */
import type { QuerySqlExecutor, QuerySqlResult } from './tools/query-sql';

export interface RunnerChild {
  readonly pid: number | undefined;
  send(msg: unknown): void;
  onMessage(cb: (msg: unknown) => void): void;
  onExit(cb: (code: number | null) => void): void;
  kill(signal: 'SIGTERM' | 'SIGKILL'): void;
}

export type SqlRunnerState = 'none' | 'starting' | 'ready' | 'stopping' | 'stuck';

export const SQL_UNAVAILABLE = 'query_sql is unavailable right now.';
export const SQL_STILL_STOPPING =
  'query_sql is still stopping the previous query. Try again in a few seconds.';
export const sqlStoppedMessage = (timeoutMs: number): string =>
  `query_sql stopped after ${timeoutMs / 1000} s. Narrow it: filter by account or created_at, avoid LIKE over markdown, or use search.`;

export interface SqlRunRecord {
  execMs: number;
  totalMs: number;
  rows: number;
  bytes: number;
  truncated: boolean;
  timedOut: boolean;
  at: number;
}

export interface SqlRunnerDiagnostics {
  state: SqlRunnerState;
  pid: number | null;
  timeouts: number;
  recent: SqlRunRecord[];
}

export interface SqlExecutorHandle {
  exec: QuerySqlExecutor;
  stop(): Promise<void>;
  diagnostics?(): SqlRunnerDiagnostics;
}

export interface SqlRunner extends SqlExecutorHandle {
  diagnostics(): SqlRunnerDiagnostics;
}

export interface SqlRunnerOptions {
  spawn(): RunnerChild;
  /** Per statement, counted from when ITS statement starts. */
  timeoutMs: number;
  idleMs: number;
  /** Child must say ready within this (default 20 s). */
  startTimeoutMs?: number;
  /** SIGTERM → SIGKILL grace (default 2 s). */
  termGraceMs?: number;
  /** No exit this long after SIGKILL → `stuck` (default 5 s). */
  killGraceMs?: number;
  log?(level: 'info' | 'warn' | 'error', msg: string): void;
  now?(): number;
}

interface Job {
  sql: string;
  resolve(r: QuerySqlResult): void;
  reject(e: Error): void;
  enqueuedAt: number;
}

interface ChildReply {
  t?: string;
  id?: number;
  ok?: boolean;
  message?: string;
  result?: QuerySqlResult;
  bytes?: number;
  execMs?: number;
}

const RECENT = 64;

export function createSqlRunner(opts: SqlRunnerOptions): SqlRunner {
  const startTimeoutMs = opts.startTimeoutMs ?? 20_000;
  const termGraceMs = opts.termGraceMs ?? 2_000;
  const killGraceMs = opts.killGraceMs ?? 5_000;
  const log = opts.log ?? (() => {});
  const now = opts.now ?? Date.now;

  let state: SqlRunnerState = 'none';
  let child: RunnerChild | null = null;
  let closed = false;
  let nextId = 1;
  let timeouts = 0;
  const recent: SqlRunRecord[] = [];
  const queue: Job[] = [];
  let current: {
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

  const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
  const record = (r: SqlRunRecord) => {
    recent.push(r);
    if (recent.length > RECENT) recent.shift();
  };
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
    const waiters = exitWaiters;
    exitWaiters = [];
    for (const w of waiters) w();
  };

  function failAll(err: Error): void {
    if (current) {
      clearTimeout(current.timer);
      const { job } = current;
      current = null;
      job.reject(err);
    }
    for (const j of queue.splice(0)) j.reject(err);
  }

  function armIdle(): void {
    clearIdle();
    idleTimer = setTimeout(() => {
      if (state === 'ready' && !current && queue.length === 0) beginStop();
    }, opts.idleMs);
  }

  /** SIGTERM now; SIGKILL after the grace; `stuck` if it still does not exit. */
  function beginStop(): void {
    if (!child || state === 'stopping' || state === 'stuck') return;
    state = 'stopping';
    clearIdle();
    if (startTimer) clearTimeout(startTimer);
    startTimer = undefined;
    const c = child;
    c.kill('SIGTERM');
    termTimer = setTimeout(() => {
      c.kill('SIGKILL');
      killTimer = setTimeout(() => {
        state = 'stuck';
        log(
          'error',
          `[sql-runner] child pid=${c.pid} did not exit after SIGKILL — query_sql is unavailable until it does`,
        );
        failAll(new Error(SQL_UNAVAILABLE));
        flushExitWaiters();
      }, killGraceMs);
    }, termGraceMs);
  }

  function onChildExit(c: RunnerChild): void {
    if (c !== child) return;
    clearStop();
    const was = state;
    child = null;
    state = 'none';
    if (was === 'stuck') {
      log('info', '[sql-runner] stuck child finally exited — recovered');
    } else if (was !== 'stopping') {
      log('error', `[sql-runner] child exited unexpectedly (state ${was})`);
      failAll(new Error(SQL_UNAVAILABLE));
    }
    flushExitWaiters();
    pump();
  }

  function startNext(): void {
    clearIdle();
    const job = queue.shift()!;
    const id = nextId;
    nextId += 1;
    const startedAt = now();
    const timer = setTimeout(() => onTimeout(id), opts.timeoutMs);
    current = { id, job, startedAt, timer };
    child!.send({ id, sql: job.sql });
  }

  function onTimeout(id: number): void {
    if (!current || current.id !== id) return;
    const { job, startedAt } = current;
    current = null;
    timeouts += 1;
    record({
      execMs: now() - startedAt,
      totalMs: now() - job.enqueuedAt,
      rows: 0,
      bytes: 0,
      truncated: false,
      timedOut: true,
      at: now(),
    });
    job.reject(new Error(sqlStoppedMessage(opts.timeoutMs)));
    beginStop();
  }

  function finish(m: ChildReply): void {
    const { job, startedAt, timer } = current!;
    clearTimeout(timer);
    current = null;
    if (m.ok && m.result) {
      record({
        execMs: m.execMs ?? now() - startedAt,
        totalMs: now() - job.enqueuedAt,
        rows: m.result.rows.length,
        bytes: m.bytes ?? 0,
        truncated: m.result.truncated,
        timedOut: false,
        at: now(),
      });
      job.resolve(m.result);
    } else {
      job.reject(new Error(m.message ?? SQL_UNAVAILABLE));
    }
    if (queue.length > 0) startNext();
    else armIdle();
  }

  function onMessage(c: RunnerChild, raw: unknown): void {
    if (c !== child) return;
    const m = raw as ChildReply;
    if (m.t === 'ready' && state === 'starting') {
      if (startTimer) clearTimeout(startTimer);
      startTimer = undefined;
      state = 'ready';
      pump();
    } else if (m.t === 'open-error') {
      log('error', `[sql-runner] child could not open the corpus: ${m.message ?? 'unknown'}`);
      failAll(new Error(SQL_UNAVAILABLE));
      beginStop();
    } else if (typeof m.id === 'number' && current && current.id === m.id) {
      finish(m);
    }
  }

  function spawnChild(): void {
    let c: RunnerChild;
    try {
      c = opts.spawn();
    } catch (e) {
      log('error', `[sql-runner] spawn failed: ${msg(e)}`);
      failAll(new Error(SQL_UNAVAILABLE));
      return;
    }
    child = c;
    state = 'starting';
    c.onMessage((m) => onMessage(c, m));
    c.onExit(() => onChildExit(c));
    startTimer = setTimeout(() => {
      log('error', `[sql-runner] child did not become ready within ${startTimeoutMs} ms`);
      failAll(new Error(SQL_UNAVAILABLE));
      beginStop();
    }, startTimeoutMs);
  }

  function pump(): void {
    if (closed || queue.length === 0) return;
    if (state === 'none') spawnChild();
    else if (state === 'ready' && !current) startNext();
  }

  const exec: QuerySqlExecutor = (sql) =>
    new Promise<QuerySqlResult>((resolve, reject) => {
      if (closed || state === 'stuck') {
        reject(new Error(SQL_UNAVAILABLE));
        return;
      }
      if (state === 'stopping') {
        reject(new Error(SQL_STILL_STOPPING));
        return;
      }
      queue.push({ sql, resolve, reject, enqueuedAt: now() });
      pump();
    });

  return {
    exec,
    async stop() {
      closed = true;
      failAll(new Error(SQL_UNAVAILABLE));
      if (!child) return;
      beginStop();
      if (state === 'stuck') return;
      await new Promise<void>((resolve) => {
        exitWaiters.push(resolve);
      });
    },
    diagnostics: () => ({
      state,
      pid: child?.pid ?? null,
      timeouts,
      recent: recent.slice(),
    }),
  };
}
```

- [ ] **Step 7: Run — expect PASS**

Run: `npx jest src/main/core/mcp/__tests__/sql-runner.test.ts`
Expected: PASS (all 10).

- [ ] **Step 8: Spawn adapters + the runner entry**

`src/main/core/mcp/sql-runner-spawn.ts`:

```ts
/**
 * Spawn adapters for the SQL runner (NOT the extension transport: the runner
 * needs `pid` and a SIGKILL force step, and it is not demoted — query_sql is
 * interactive work). The dbPath travels in `env.KIA_SQL_RUNNER_DB`, which both
 * child_process.fork and utilityProcess.fork support.
 */
import { fork } from 'child_process';

import type { RunnerChild } from './sql-runner';

/** child_process adapter — jest, and anything that is not Electron. */
export function forkRunnerChild(
  modulePath: string,
  opts: {
    env?: NodeJS.ProcessEnv;
    execArgv?: string[];
    cwd?: string;
  } = {},
): RunnerChild {
  const cp = fork(modulePath, [], {
    execArgv: opts.execArgv ?? [],
    env: { ...process.env, ...opts.env },
    cwd: opts.cwd,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  cp.on('error', () => {
    /* the exit listener owns recovery */
  });
  return {
    get pid() {
      return cp.pid;
    },
    send: (m) => {
      try {
        cp.send(m as object, () => {});
      } catch {
        /* raced an exit */
      }
    },
    onMessage: (cb) => {
      cp.on('message', cb);
    },
    onExit: (cb) => {
      cp.on('exit', (code) => cb(code));
    },
    kill: (signal) => {
      try {
        cp.kill(signal);
      } catch {
        /* already gone */
      }
    },
  };
}

/** Electron utilityProcess adapter — the packaged app. `kill('SIGTERM')` is
 *  utilityProcess.kill() (SIGTERM / TerminateProcess); SIGKILL is the force step
 *  through the pid. Verified by the release smoke on macOS and Windows. */
export function utilityRunnerChild(
  modulePath: string,
  env: Record<string, string>,
  onOutput?: (line: string) => void,
): RunnerChild {
  // Lazy-required so importing this module under jest (no electron) is safe.
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  const { utilityProcess } = require('electron') as typeof import('electron');
  const child = utilityProcess.fork(modulePath, [], {
    serviceName: 'kia-sql-runner',
    stdio: 'pipe',
    env: { ...process.env, ...env } as Record<string, string>,
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on('data', (b: Buffer | string) => {
      const line = b.toString().trimEnd();
      if (line) onOutput?.(line.slice(0, 4096));
    });
  }
  return {
    get pid() {
      return child.pid;
    },
    send: (m) => child.postMessage(m),
    onMessage: (cb) => {
      child.on('message', cb);
    },
    onExit: (cb) => {
      child.on('exit', (code) => cb(code));
    },
    kill: (signal) => {
      if (signal === 'SIGTERM') {
        child.kill();
      } else if (child.pid !== undefined) {
        try {
          process.kill(child.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    },
  };
}
```

`src/main/core/mcp/sql-runner-entry.ts` (webpack entry `sqlRunner`; installs NO signal handlers, so SIGTERM terminates it even inside `sqlite3_step`):

```ts
/**
 * Child process entry for query_sql (spec §3.4). Opens the corpus query-only
 * and answers `{ id, sql }` with the bounded result. It deliberately installs
 * NO signal handlers: the default SIGTERM action kills the process even while
 * SQLite is inside a long `sqlite3_step`, which is the whole point.
 */
import { openCorpusReadConnection } from '../../db/app-db';
import { runQuerySqlBounded } from './tools/query-sql';

type ParentPort = {
  postMessage(m: unknown): void;
  on(ev: 'message', cb: (m: unknown) => void): void;
};
// Electron utilityProcess has `process.parentPort`; child_process.fork has
// `process.send` / `process.on('message')`.
const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;

/** `done` runs once the message has left this process, so a following
 *  `process.exit` cannot drop it. */
const send = (m: unknown, done?: () => void): void => {
  if (parentPort) {
    parentPort.postMessage(m);
    if (done) setTimeout(done, 100); // utilityProcess has no send callback
  } else if (process.send) {
    process.send(m, undefined, undefined, () => done?.());
  } else {
    done?.();
  }
};
const onMessage = (cb: (m: unknown) => void): void => {
  if (parentPort) {
    parentPort.on('message', (ev: unknown) =>
      cb(ev && typeof ev === 'object' && 'data' in ev ? (ev as { data: unknown }).data : ev),
    );
  } else {
    process.on('message', cb);
  }
};

// Not a signal handler: the forked (non-Electron) child leaves when its parent
// goes away; a utilityProcess dies with the app.
process.on('disconnect', () => process.exit(0));

(async () => {
  try {
    const dbPath = process.env.KIA_SQL_RUNNER_DB;
    if (!dbPath) throw new Error('KIA_SQL_RUNNER_DB is not set');
    const db = await openCorpusReadConnection(dbPath, {
      cacheKiB: 2048,
      queryOnly: true,
    });
    const conn = db._conn!;
    onMessage((m) => {
      const req = m as { id: number; sql: string };
      const started = performance.now();
      try {
        const { result, bytes } = runQuerySqlBounded(conn, req.sql);
        send({ id: req.id, ok: true, result, bytes, execMs: performance.now() - started });
      } catch (e) {
        send({
          id: req.id,
          ok: false,
          message: e instanceof Error ? e.message : String(e),
          execMs: performance.now() - started,
        });
      }
    });
    send({ t: 'ready' });
  } catch (e) {
    // Exit only after the reason has been delivered (never drop it).
    send(
      { t: 'open-error', message: e instanceof Error ? e.message : String(e) },
      () => process.exit(1),
    );
  }
})();
```

- [ ] **Step 9: Write the adapter test and the real-process test**

`src/main/core/mcp/__tests__/sql-runner-spawn.test.ts`:

```ts
/** @jest-environment node */
const mockFork = jest.fn();
jest.mock('electron', () => ({ utilityProcess: { fork: mockFork } }), {
  virtual: true,
});

import { utilityRunnerChild } from '../sql-runner-spawn';

describe('utilityRunnerChild', () => {
  const fakeChild = () => ({
    pid: 4321,
    kill: jest.fn(),
    postMessage: jest.fn(),
    on: jest.fn(),
    stdout: null,
    stderr: null,
  });

  it('forks with the db path in env, forwards messages, SIGTERM -> kill(), SIGKILL -> process.kill', () => {
    const c = fakeChild();
    mockFork.mockReturnValue(c);
    const killSpy = jest.spyOn(process, 'kill').mockImplementation(() => true);
    const runner = utilityRunnerChild('/app/sqlRunner.js', { KIA_SQL_RUNNER_DB: '/data/kiagent.db' });
    expect(mockFork).toHaveBeenCalledWith(
      '/app/sqlRunner.js',
      [],
      expect.objectContaining({
        serviceName: 'kia-sql-runner',
        env: expect.objectContaining({ KIA_SQL_RUNNER_DB: '/data/kiagent.db' }),
      }),
    );
    expect(runner.pid).toBe(4321);
    runner.send({ id: 1 });
    expect(c.postMessage).toHaveBeenCalledWith({ id: 1 });
    runner.kill('SIGTERM');
    expect(c.kill).toHaveBeenCalledTimes(1);
    expect(killSpy).not.toHaveBeenCalled();
    runner.kill('SIGKILL');
    expect(killSpy).toHaveBeenCalledWith(4321, 'SIGKILL');
    killSpy.mockRestore();
  });
});
```

`src/main/core/mcp/__tests__/fixtures/sigterm-ignoring-runner.cjs`:

```js
// Test double for a runner child that cannot be stopped politely: says ready,
// then spins forever on the first request and ignores SIGTERM.
process.on('SIGTERM', () => {});
process.on('disconnect', () => process.exit(0));
process.on('message', () => {
  for (;;) {
    /* busy */
  }
});
process.send({ t: 'ready' });
```

`src/main/core/mcp/__tests__/sql-runner-process.test.ts` (real child processes; the packaged utility-process boundary is the release smoke's job):

```ts
/**
 * @jest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { openDb } from '../../../db/app-db';
import {
  createWorkerEnv,
  REPO_ROOT,
  WORKER_ENTRY,
} from '../../../db/__tests__/worker-test-env';
import { openReads } from '../../reads';
import { openStore } from '../../store/store';
import { createSqlRunner, type SqlRunner } from '../sql-runner';
import { forkRunnerChild } from '../sql-runner-spawn';

jest.setTimeout(120_000);

const ENTRY = path.join(__dirname, '..', 'sql-runner-entry.ts');
const SIGTERM_FIXTURE = path.join(__dirname, 'fixtures', 'sigterm-ignoring-runner.cjs');
// An aggregate over a recursive CTE yields no rows until it is done: only a
// process kill can stop it.
const HEAVY = `SELECT count(*) AS n FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x < 2000000000) SELECT x FROM c)`;

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};
const until = async (cond: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('SQL runner over real child processes', () => {
  const env = createWorkerEnv('sql-runner');
  let dir: string;
  let dbPath: string;
  let runner: SqlRunner | undefined;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-sqlrunner-'));
    dbPath = path.join(dir, 'kiagent.db');
    await (await openDb(dbPath)).close();
  });
  afterEach(async () => {
    await runner?.stop();
    runner = undefined;
  });
  afterAll(() => {
    env.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const real = (timeoutMs: number) =>
    createSqlRunner({
      spawn: () =>
        forkRunnerChild(ENTRY, {
          env: { KIA_SQL_RUNNER_DB: dbPath },
          execArgv: env.execArgv,
          cwd: REPO_ROOT,
        }),
      timeoutMs,
      idleMs: 60_000,
      startTimeoutMs: 90_000,
      termGraceMs: 1_000,
      killGraceMs: 5_000,
    });

  it('runs a statement, stops a runaway one for real, and recovers on a fresh child', async () => {
    runner = real(800);
    const first = await runner.exec('SELECT 1 AS one');
    expect(first.rows).toEqual([{ one: 1 }]);
    const pid1 = runner.diagnostics().pid!;
    expect(pid1).not.toBe(process.pid);

    // The main thread must stay responsive while the child burns CPU.
    let maxLag = 0;
    let last = Date.now();
    const tick = setInterval(() => {
      const n = Date.now();
      maxLag = Math.max(maxLag, n - last - 20);
      last = n;
    }, 20);
    await expect(runner.exec(HEAVY)).rejects.toThrow(/stopped after 0\.8 s/);
    expect(runner.diagnostics().state).toBe('stopping');
    await expect(runner.exec('SELECT 1')).rejects.toThrow(/still stopping/);
    await until(() => runner!.diagnostics().state === 'none');
    clearInterval(tick);
    expect(maxLag).toBeLessThan(300);
    expect(isAlive(pid1)).toBe(false); // the process EXITED, not just the call

    const again = await runner.exec('SELECT 2 AS two');
    expect(again.rows).toEqual([{ two: 2 }]);
    expect(runner.diagnostics().pid).not.toBe(pid1);
    expect(runner.diagnostics().timeouts).toBe(1);
  });

  it('real read worker keeps answering search + document while a runaway statement runs in the runner', async () => {
    const writerDb = await openDb(dbPath);
    const store = openStore(writerDb, {
      encrypt: (x: string) => Buffer.from(x, 'utf8'),
      decrypt: (b: Buffer) => b.toString('utf8'),
      detectLanguages: () => ['eng'],
    });
    const acct = (await store.createAccount({ source: 'test', identifier: 'me@x' })).id;
    await store.commit({
      account: acct,
      cursor: 1,
      documents: [
        {
          externalId: 'live1',
          type: 'note',
          title: 'Live one',
          markdown: 'alpha runaway neighbour',
          metadata: {},
          createdAt: '2026-01-01T00:00:00Z',
        },
      ],
    });
    const plane = await openReads({
      dbPath,
      workerFile: WORKER_ENTRY,
      execArgv: env.execArgv,
      writer: store.read,
      weak: false,
      log: () => {},
    });
    try {
      const [seed] = await plane.reads.search({ text: 'alpha', limit: 1 });
      expect(seed).toBeDefined();
      runner = real(3_000);
      await runner.exec('SELECT 1'); // child ready before measuring
      let ok = 0;
      let stop = false;
      let maxLag = 0;
      let last = Date.now();
      const tick = setInterval(() => {
        const n = Date.now();
        maxLag = Math.max(maxLag, n - last - 20);
        last = n;
      }, 20);
      const reader = (async () => {
        while (!stop) {
          const hits = await plane.reads.search({ text: 'alpha', limit: 5 });
          const doc = await plane.reads.document(seed.id);
          if (hits.length > 0 && doc?.id === seed.id) ok += 1;
          await new Promise((r) => setTimeout(r, 50));
        }
      })();
      // While the runaway SQL burns CPU in the runner process, the read worker
      // keeps resolving successful search + document calls on the same DB file.
      await expect(runner.exec(HEAVY)).rejects.toThrow(/stopped after/);
      stop = true;
      await reader;
      clearInterval(tick);
      expect(ok).toBeGreaterThanOrEqual(5);
      expect(maxLag).toBeLessThan(300);
      await until(() => runner!.diagnostics().state === 'none');
    } finally {
      await plane.close();
      await store.close();
    }
  });

  it('bounds the result in bytes inside the child', async () => {
    runner = real(30_000);
    const r = await runner.exec(
      `WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i < 600) SELECT i, hex(randomblob(100000)) AS big FROM c`,
    );
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(r.rows))).toBeLessThanOrEqual(1024 * 1024);
  });

  it('escalates to SIGKILL when the child ignores SIGTERM', async () => {
    runner = createSqlRunner({
      spawn: () => forkRunnerChild(SIGTERM_FIXTURE),
      timeoutMs: 200,
      idleMs: 60_000,
      termGraceMs: 300,
      killGraceMs: 5_000,
    });
    const t0 = Date.now();
    await expect(runner.exec('SELECT 1')).rejects.toThrow(/stopped after/);
    const pid = runner.diagnostics().pid!;
    await until(() => runner!.diagnostics().state === 'none');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(200 + 300);
    expect(isAlive(pid)).toBe(false);
  });

  it('reports an unavailable runner when the entry cannot open the corpus', async () => {
    runner = createSqlRunner({
      spawn: () =>
        forkRunnerChild(ENTRY, {
          env: { KIA_SQL_RUNNER_DB: path.join(dir, 'missing.db') },
          execArgv: env.execArgv,
          cwd: REPO_ROOT,
        }),
      timeoutMs: 5_000,
      idleMs: 60_000,
      startTimeoutMs: 90_000,
    });
    await expect(runner.exec('SELECT 1')).rejects.toThrow(/unavailable/);
  });
});
```

- [ ] **Step 10: Run — expect PASS**

Run (one at a time): `npx jest src/main/core/mcp/__tests__/sql-runner-spawn.test.ts`, then `npx jest src/main/core/mcp/__tests__/sql-runner-process.test.ts`.
Expected: PASS. If `maxLag` flakes on a loaded machine, widen the bound — never remove the assertion.

- [ ] **Step 11: Rewire the tools, server, stdio, main, webpack**

`src/main/core/mcp/tools/raw-sql.ts` — replace the whole file body below the header comment (keep the header, update its second paragraph to say the handle now lives in the runner process) with:

```ts
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

import type { McpTool } from '@shared/contracts';

import type { SqlExecutorHandle } from '../sql-runner';
import { getSchemaDescription, renderSchema } from './get-schema';
import {
  querySqlDescription,
  querySqlInputSchema,
  runQuerySql,
  type QuerySqlExecutor,
} from './query-sql';

function openReadHandle(dbPath: string): BetterSqlite3.Database {
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

/** In-process executor: the stdio sibling (its own process, over its own
 *  connection) and tests that inject one explicitly. The MCP server never
 *  builds one itself, and the app never uses it — main.ts passes the killable
 *  runner. A string source is opened lazily and owned (closed by stop()); a
 *  connection is borrowed. */
export function createInProcessSqlExecutor(
  source: string | BetterSqlite3.Database,
): SqlExecutorHandle {
  const owned = typeof source === 'string';
  let conn: BetterSqlite3.Database | null = owned ? null : source;
  return {
    exec: async (sql) => {
      if (!conn) conn = openReadHandle(source as string);
      return runQuerySql(conn, sql);
    },
    stop: async () => {
      if (owned && conn) {
        conn.close();
        conn = null;
      }
    },
  };
}

export function createRawSqlTools(exec: QuerySqlExecutor): {
  tools: McpTool[];
} {
  const tools: McpTool[] = [
    {
      name: 'query_sql',
      description: querySqlDescription,
      inputSchema: querySqlInputSchema,
      tier: 'powerful',
      call: async (args: Record<string, unknown>) =>
        exec(String((args as { sql?: unknown }).sql ?? '')),
    },
    {
      name: 'get_schema',
      description: getSchemaDescription,
      inputSchema: { type: 'object', properties: {} },
      tier: 'powerful',
      call: async () => renderSchema(),
    },
  ];
  return { tools };
}
```

`src/main/core/mcp/server.ts`: add `import { createRawSqlTools } from './tools/raw-sql';` and `import type { SqlExecutorHandle, SqlRunnerDiagnostics } from './sql-runner';`; in `McpDeps` add

```ts
  /** The `query_sql` executor — REQUIRED, there is no in-process default (the
   *  server must never open a handle on the main thread). main.ts passes the
   *  killable runner; tests inject `createInProcessSqlExecutor(dbPath)`.
   *  The server OWNS whatever is passed: `stop()` stops it. */
  sqlExecutor: SqlExecutorHandle;
```

in `McpServerHandle` add `sqlDiagnostics(): SqlRunnerDiagnostics | null;`, replace `const rawSql = createRawSqlTools(dbPath);` with

```ts
  const sql = deps.sqlExecutor;
  const rawSql = createRawSqlTools(sql.exec);
```

in the returned handle add `sqlDiagnostics: () => sql.diagnostics?.() ?? null,` and in `stop()` replace the `try { await rawSql.dispose(); } catch { /* ignore */ }` block with `try { await sql.stop(); } catch { /* ignore */ }`.

`src/main/mcp/stdio-entry.ts`: import `createInProcessSqlExecutor` next to `createRawSqlTools`; replace `const rawSql = createRawSqlTools(dbPath);` with

```ts
  // Its own process over its own query-only connection: no runner needed here.
  const rawSql = createRawSqlTools(
    createInProcessSqlExecutor(readDb._conn!).exec,
  );
```

and delete the `try { await rawSql.dispose(); } catch { /* ignore */ }` block in `shutdown` (the connection is closed by `readDb.close()`).

Webpack — in BOTH `.erb/configs/webpack.config.main.prod.ts` and `.dev.ts`, add after the `dbWorker` entry:

```ts
    sqlRunner: path.join(webpackPaths.srcMainPath, 'core/mcp/sql-runner-entry.ts'),
```

`src/main/main.ts` — add imports `import { createSqlRunner } from './core/mcp/sql-runner';` and `import { utilityRunnerChild } from './core/mcp/sql-runner-spawn';`, then immediately before `mcp = await startMcp({` add the resolver (same scheme as `dbWorkerFile`) and pass the runner:

```ts
    // Bundled SQL runner (webpack `sqlRunner` entry): prod `sqlRunner.js`, dev
    // `sqlRunner.bundle.dev.js`.
    const sqlRunnerFile =
      [
        path.join(__dirname, 'sqlRunner.js'),
        path.join(__dirname, 'sqlRunner.bundle.dev.js'),
      ].find((f) => fs.existsSync(f)) ?? path.join(__dirname, 'sqlRunner.js');
    mcp = await startMcp({
      query: p.readsFor('mcp'),
      sqlExecutor: createSqlRunner({
        spawn: () =>
          utilityRunnerChild(
            sqlRunnerFile,
            { KIA_SQL_RUNNER_DB: path.join(dataDir, 'kiagent.db') },
            (line) => p.logSink.log('sql-runner', 'warn', line),
          ),
        timeoutMs: 10_000,
        idleMs: 300_000,
        log: (level, msg) => p.logSink.log('sql-runner', level, msg),
      }),
      logSink: p.logSink,
      // …the rest of the existing arguments unchanged…
```

Every existing test that calls `startMcp` must now inject an executor (the typecheck flags each one): `server.test.ts` (all three `startMcp({` calls), `mcp-session-factory.test.ts`, `outbound-routes.test.ts` (and any other hit of `git grep -n "startMcp(" -- src`). In each, import `createInProcessSqlExecutor` from `../tools/raw-sql` and add to the deps object

```ts
      sqlExecutor: createInProcessSqlExecutor(path.join(<that test's dataDir expression>, 'kiagent.db')),
```

(the executor opens lazily, so a path whose file does not exist yet is fine; the server's `stop()` closes it). Then update `raw-sql.test.ts`, which uses the old `createRawSqlTools(dbPath)`/`dispose()`:

```bash
perl -0pi -e 's/const raw = createRawSqlTools\((\w+)\);/const sqlh = createInProcessSqlExecutor($1);\n    const raw = createRawSqlTools(sqlh.exec);/g; s/await raw\.dispose\(\);/await sqlh.stop();/g; s/import \{ createRawSqlTools \} from/import { createInProcessSqlExecutor, createRawSqlTools } from/' src/main/core/mcp/__tests__/raw-sql.test.ts
```

In `raw-sql-wiring.test.ts` make the wired server use a real runner and assert the main-thread handle is gone: add imports

```ts
import {
  createWorkerEnv,
  REPO_ROOT,
} from '../../../db/__tests__/worker-test-env';
import { createSqlRunner } from '../sql-runner';
import { forkRunnerChild } from '../sql-runner-spawn';
```

declare `const wenv = createWorkerEnv('wiring'); let runner: ReturnType<typeof createSqlRunner>;` and `jest.setTimeout(90_000);`, create the runner in `beforeAll` before `startMcp`:

```ts
    runner = createSqlRunner({
      spawn: () =>
        forkRunnerChild(path.join(__dirname, '..', 'sql-runner-entry.ts'), {
          env: { KIA_SQL_RUNNER_DB: dbPath },
          execArgv: wenv.execArgv,
          cwd: REPO_ROOT,
        }),
      timeoutMs: 10_000,
      idleMs: 60_000,
      startTimeoutMs: 90_000,
    });
```

pass `sqlExecutor: runner,` to `startMcp`, and at the end of the existing `it(...)` add

```ts
    // query_sql ran in a separate process; the server owns it and stops it.
    const pid = runner.diagnostics().pid!;
    expect(pid).not.toBe(process.pid);
    expect(handle.sqlDiagnostics()?.state).toBe('ready');
    await handle.stop();
    expect(runner.diagnostics().state).toBe('none');
    await new Promise((r) => setTimeout(r, 100));
    expect(() => process.kill(pid, 0)).toThrow(); // gone
```

(and make `afterAll` tolerate an already-stopped handle: `await handle.stop().catch(() => {}); wenv.cleanup();`.)

Append to `src/main/__tests__/read-routing.test.ts`:

```ts
describe('query_sql routing', () => {
  it('the app hands the MCP server the killable runner; the server never opens a handle itself', () => {
    expect(read('main.ts')).toMatch(/sqlExecutor:\s*createSqlRunner\(/);
    expect(read('core/mcp/server.ts')).not.toMatch(/new Database\(/);
    expect(read('core/mcp/server.ts')).not.toMatch(/better-sqlite3/);
  });
});
```

Extend `src/main/mcp/__tests__/stdio-entry.test.ts` (spec §5: the stdio executor gets the same bounds) with an `it` that reuses the seeded corpus setup (move the seeding into a `beforeEach`/helper) and drives all three bounds through the stdio client:

```ts
    const live: Client = client; // definite local after connect: no `Client | undefined` deref in the closure
    const callSql = async (sql: string) => {
      const r = (await live.callTool({
        name: 'query_sql',
        arguments: { sql },
      })) as { content: Array<{ text: string }> };
      return JSON.parse(r.content[0].text) as {
        rows: Array<Record<string, unknown>>;
        truncated: boolean;
        hint?: string;
      };
    };
    const series = (n: number, cols: string) =>
      `WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i < ${n}) SELECT ${cols} FROM c`;

    // 1. row cap
    const rowsCut = await callSql(series(600, 'i'));
    expect(rowsCut.rows).toHaveLength(500);
    expect(rowsCut.truncated).toBe(true);

    // 2. oversized text value (> 64 KiB): cut, marked, truncated
    const valueCut = await callSql(`SELECT hex(randomblob(40000)) AS big`);
    const big = valueCut.rows[0].big as string;
    expect(big.endsWith('…[truncated]')).toBe(true);
    expect(Buffer.byteLength(big.slice(0, -'…[truncated]'.length))).toBeLessThanOrEqual(65536);
    expect(valueCut.truncated).toBe(true);

    // 3. 1 MiB aggregate cap (the whole serialized rows array)
    const aggCut = await callSql(series(600, 'i, hex(randomblob(100000)) AS big'));
    expect(aggCut.truncated).toBe(true);
    expect(aggCut.rows.length).toBeGreaterThan(0);
    expect(aggCut.rows.length).toBeLessThan(500);
    expect(Buffer.byteLength(JSON.stringify(aggCut.rows))).toBeLessThanOrEqual(1024 * 1024);
    expect(aggCut.hint).toMatch(/1 MiB/);
```

- [ ] **Step 12: Run — expect PASS, then gate the task**

Run (one at a time): `npx jest src/main/core/mcp`, `npx jest src/main/mcp src/main/__tests__/read-routing.test.ts`.
Then: `npx tsc -p tsconfig.typecheck.json && npx eslint --fix src/main/core/mcp src/main/mcp/stdio-entry.ts src/main/mcp/__tests__/stdio-entry.test.ts src/main/main.ts .erb/configs/webpack.config.main.prod.ts .erb/configs/webpack.config.main.dev.ts src/main/__tests__/read-routing.test.ts`
Expected: green. (`server.test.ts`, `mcp-session-factory.test.ts` and `outbound-routes.test.ts` now inject an in-process executor explicitly; their assertions are otherwise unchanged.)

- [ ] **Step 13: Commit**

```bash
printf 'feat(mcp): query_sql runs in a killable runner process with byte-bounded results (#146)\n' > /tmp/msg-r6
git add src/main/core/mcp/sql-runner.ts src/main/core/mcp/sql-runner-spawn.ts src/main/core/mcp/sql-runner-entry.ts src/main/core/mcp/__tests__/query-sql-bounds.test.ts src/main/core/mcp/__tests__/sql-runner.test.ts src/main/core/mcp/__tests__/sql-runner-spawn.test.ts src/main/core/mcp/__tests__/sql-runner-process.test.ts src/main/core/mcp/__tests__/fixtures/sigterm-ignoring-runner.cjs
git commit -F /tmp/msg-r6 -- src/main/core/mcp src/main/mcp/stdio-entry.ts src/main/mcp/__tests__/stdio-entry.test.ts src/main/main.ts .erb/configs/webpack.config.main.prod.ts .erb/configs/webpack.config.main.dev.ts src/main/__tests__/read-routing.test.ts
```

---

### Task 7: `readDiagnostics`

Spec §3.6: per caller × method count/p50/p95/max over the last 256 calls with sample age, fallbacks, SQL runner `{ state, pid, timeouts }`, and the `-wal` file size — surfaced next to `dbDiagnostics`. An env-gated file dump lets the acceptance probe (Task 8) read it from outside the app.

**Files:**
- Create: `src/main/core/read-diagnostics.ts`, `src/main/core/__tests__/read-diagnostics.test.ts`
- Modify: `src/main/core/boot.ts`, `src/main/main.ts`

**Interfaces:**
- Consumes: `ReadStats`, `ReadStatsSnapshot` (Task 4); `SqlRunnerDiagnostics` (Task 6); `readPlane.stats` (Task 5).
- Produces:
  - `interface ReadDiagnostics { reads: ReadStatsSnapshot; sql: { state: SqlRunnerState; pid: number | null; timeouts: number; recent: SqlRunRecord[] } | null; walBytes: number | null }`.
  - `buildReadDiagnostics(deps: { stats: ReadStats; walPath: string; sql?: SqlRunnerDiagnostics | null; statFile?: (p: string) => Promise<{ size: number }>; now?: number }): Promise<ReadDiagnostics>`.
  - `startReadDiagnosticsDump(file: string, snapshot: () => Promise<unknown>, intervalMs: number): () => void` (returns stop).
  - `CorePlatform.readDiagnostics(sql?: SqlRunnerDiagnostics | null): Promise<ReadDiagnostics>`.

- [ ] **Step 1: Write the failing test** — `src/main/core/__tests__/read-diagnostics.test.ts`

```ts
/** @jest-environment node */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildReadDiagnostics, startReadDiagnosticsDump } from '../read-diagnostics';
import { createReadStats } from '../store/read-proxy';

describe('buildReadDiagnostics', () => {
  const stats = () => {
    const s = createReadStats();
    s.record({ caller: 'mcp', method: 'countBy', via: 'reader', execMs: 40, totalMs: 45, at: 1_000, fuzzyRuns: 7 });
    return s;
  };

  it('combines read stats, the SQL runner state and the -wal size', async () => {
    const d = await buildReadDiagnostics({
      stats: stats(),
      walPath: '/x/kiagent.db-wal',
      statFile: async () => ({ size: 4096 }),
      sql: { state: 'ready', pid: 77, timeouts: 2, recent: [] },
      now: 2_000,
    });
    expect(d.walBytes).toBe(4096);
    expect(d.reads.fuzzyRuns).toBe(7);
    expect(d.sql).toEqual({ state: 'ready', pid: 77, timeouts: 2, recent: [] });
    expect(d.reads.groups[0]).toMatchObject({
      caller: 'mcp',
      method: 'countBy',
      via: 'reader',
      count: 1,
      newestAgeMs: 1_000,
    });
  });

  it('reports null for a missing -wal and for an app without a runner', async () => {
    const d = await buildReadDiagnostics({
      stats: stats(),
      walPath: '/nope',
      statFile: async () => {
        throw new Error('ENOENT');
      },
    });
    expect(d.walBytes).toBeNull();
    expect(d.sql).toBeNull();
  });
});

describe('startReadDiagnosticsDump', () => {
  it('writes the snapshot immediately and again every interval until stopped', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-diag-'));
    const file = path.join(dir, 'diag.json');
    let n = 0;
    const stop = startReadDiagnosticsDump(file, async () => ({ n: (n += 1) }), 20);
    const waitFor = async (cond: () => boolean) => {
      const end = Date.now() + 3_000;
      while (!cond()) {
        if (Date.now() > end) throw new Error('timeout');
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    await waitFor(() => fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).n >= 2);
    expect(typeof JSON.parse(fs.readFileSync(file, 'utf8')).snapshotAt).toBe('number');
    stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/main/core/__tests__/read-diagnostics.test.ts`
Expected: FAIL — `Cannot find module '../read-diagnostics'`.

- [ ] **Step 3: Implement** — `src/main/core/read-diagnostics.ts`

```ts
/**
 * Internal diagnosis for the read plane (spec §3.6) — NOT acceptance: the
 * acceptance numbers come from the external probe (scripts/mcp-latency-probe.mjs).
 * Shows whether a reader statement (count/countBy/broad search) is the slow
 * part, whether the writer fallback fired, what the SQL runner is doing, and
 * whether the WAL is growing because a reader snapshot is blocking checkpoints.
 */
import fs from 'node:fs';

import type { SqlRunnerDiagnostics } from './mcp/sql-runner';
import type { ReadStats, ReadStatsSnapshot } from './store/read-proxy';

export interface ReadDiagnostics {
  /** Includes `reads.fuzzyRuns`: the reader's cumulative fuzzy-pass executions. */
  reads: ReadStatsSnapshot;
  sql: SqlRunnerDiagnostics | null;
  walBytes: number | null;
}

export async function buildReadDiagnostics(deps: {
  stats: ReadStats;
  walPath: string;
  sql?: SqlRunnerDiagnostics | null;
  statFile?: (p: string) => Promise<{ size: number }>;
  now?: number;
}): Promise<ReadDiagnostics> {
  const statFile = deps.statFile ?? ((p: string) => fs.promises.stat(p));
  let walBytes: number | null = null;
  try {
    walBytes = (await statFile(deps.walPath)).size;
  } catch {
    walBytes = null;
  }
  return {
    reads: deps.stats.snapshot(deps.now),
    sql: deps.sql ?? null,
    walBytes,
  };
}

/** Acceptance aid (KIA_READ_DIAG_FILE): rewrite `file` with a fresh snapshot
 *  every `intervalMs`. Each file carries `snapshotAt` (ms epoch, taken BEFORE
 *  the snapshot), so a reader can wait for a snapshot that reflects calls it
 *  made earlier. Failures are swallowed — diagnostics never break the app. */
export function startReadDiagnosticsDump(
  file: string,
  snapshot: () => Promise<unknown>,
  intervalMs: number,
): () => void {
  const write = async () => {
    try {
      const snapshotAt = Date.now();
      const snap = (await snapshot()) as Record<string, unknown>;
      await fs.promises.writeFile(file, JSON.stringify({ ...snap, snapshotAt }, null, 2));
    } catch {
      /* best effort */
    }
  };
  void write();
  const timer = setInterval(() => void write(), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
```

- [ ] **Step 4: Wire it.** `boot.ts`: `import { buildReadDiagnostics, type ReadDiagnostics } from './read-diagnostics';` and `import type { SqlRunnerDiagnostics } from './mcp/sql-runner';`; in `CorePlatform` add

```ts
  /** Read-plane diagnostics (reads stats, SQL runner state, -wal size). The
   *  MCP server owns the runner, so the caller passes its diagnostics in. */
  readDiagnostics(sql?: SqlRunnerDiagnostics | null): Promise<ReadDiagnostics>;
```

and in the `platform` literal:

```ts
    readDiagnostics: (sql) =>
      buildReadDiagnostics({ stats: readPlane.stats, walPath: `${dbPath}-wal`, sql }),
```

`main.ts`: in the handler that returns `dbDiagnostics` (`storage:stats`, `main.ts:680`) add the line right below it. `mcp` is the module-level `let mcp: McpServerHandle | null` (`main.ts:130`), hence the `?.`. `src/shared/ipc.ts` types the response as `StorageStats`, which does not list `dbDiagnostics` either — the extra field already compiles for the existing line, so leave the type alone unless `tsc` objects:

```ts
        readDiagnostics: await p.readDiagnostics(mcp?.sqlDiagnostics() ?? null),
```

and right after `mcp = await startMcp({ … });` add (import `startReadDiagnosticsDump` from `./core/read-diagnostics`):

```ts
    // Acceptance aid (§6): KIA_READ_DIAG_FILE=/path makes the app rewrite its
    // read diagnostics every 5 s so the external MCP probe can read them.
    if (process.env.KIA_READ_DIAG_FILE) {
      startReadDiagnosticsDump(
        process.env.KIA_READ_DIAG_FILE,
        () => p.readDiagnostics(mcp?.sqlDiagnostics() ?? null),
        5_000,
      );
    }
```

- [ ] **Step 5: Run — expect PASS**

Run: `npx jest src/main/core/__tests__/read-diagnostics.test.ts`
Then: `npx tsc -p tsconfig.typecheck.json && npx eslint --fix src/main/core/read-diagnostics.ts src/main/core/boot.ts src/main/main.ts src/main/core/__tests__/read-diagnostics.test.ts`

- [ ] **Step 6: Commit**

```bash
printf 'feat(reads): readDiagnostics next to dbDiagnostics, plus KIA_READ_DIAG_FILE dump (#146)\n' > /tmp/msg-r7
git add src/main/core/read-diagnostics.ts src/main/core/__tests__/read-diagnostics.test.ts
git commit -F /tmp/msg-r7 -- src/main/core/read-diagnostics.ts src/main/core/__tests__/read-diagnostics.test.ts src/main/core/boot.ts src/main/main.ts
```

---

### Task 8: External MCP latency probe

Spec §6 "Probe". Runs the fixed workload from OUTSIDE the app, as ChatGPT/Claude would.

**Files:**
- Create: `scripts/mcp-latency-probe.mjs`, `scripts/mcp-latency-probe-workload.mjs`, `src/main/core/mcp/__tests__/latency-probe.test.ts`, `src/main/core/mcp/__tests__/latency-probe-workload.test.ts`

**Interfaces:**
- Consumes: the loopback MCP endpoint (`http://127.0.0.1:7421/mcp`); tools `search`, `get`, `count`, `digital_memory_info`, `get_schema`; the Task 7 diagnostics file (`--diag`: `snapshotAt`, `reads.fuzzyRuns`, `reads.groups`, `reads.fallbacks`).
- Produces: a JSON report on stdout (last line) `{ label, at, cycles, kinds: { search, get, count, info, loop }, fallbacks? }` where every kind is `{ n, p50, p95, max }` in ms; exit code 0 = ran, 1 = a pass criterion failed (p95 > 2x baseline, or any fallback), 2 = `countBy` was never seen on the reader, 3 = the workload itself was invalid (not 10 DISTINCT existing `get` ids, any `get` during measurement returning null/empty, a fuzzy term that does not increase the app's `reads.fuzzyRuns` counter or returns no hit (needs `--diag`), a baseline-mode run (no `--diag`) without a validated `--ids` file, any kind with fewer samples than the fixed workload promises, or a `--baseline` report that is itself incomplete: sample counts below its own `cycles`, or search/get p95 not > 0). Flags: `--ids <file>` (the validated workload `{ ids, fuzzy }`: the 10 `get` ids plus the fuzzy term; with `--diag` it is (re)validated and written, without `--diag` — the v0.104.0 baseline — it MUST already exist from a validated run and is not re-validated), `--validate-only` (setup + validation only, writes the `--ids` file, exits 0/3).

- [ ] **Step 1: Write the failing test** — `src/main/core/mcp/__tests__/latency-probe.test.ts` (starts a real server in this process; the probe must run as an ASYNC child so the server's event loop stays free)

```ts
/**
 * @jest-environment node
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { openDb } from '../../../db/app-db';
import { startReadDiagnosticsDump } from '../../read-diagnostics';
import { createCorpusQuery } from '../../store/corpus-query';
import { openStore } from '../../store/store';
import { startMcp, type McpServerHandle } from '../server';
import { createInProcessSqlExecutor } from '../tools/raw-sql';

jest.setTimeout(120_000);

const run = promisify(execFile);
const PROBE = path.resolve(__dirname, '..', '..', '..', '..', '..', 'scripts', 'mcp-latency-probe.mjs');

describe('scripts/mcp-latency-probe.mjs', () => {
  let dir: string;
  let handle: McpServerHandle;
  let stopDiag: () => void;
  let diag: string;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-probe-'));
    diag = path.join(dir, 'diag.json');
    const db = await openDb(path.join(dir, 'kiagent.db'));
    const store = openStore(db, {
      encrypt: (s: string) => Buffer.from(s, 'utf8'),
      decrypt: (b: Buffer) => b.toString('utf8'),
      detectLanguages: () => ['eng'],
    });
    const acc = await store.createAccount({ source: 'gmail', identifier: 'me@example.com' });
    await store.commit({
      account: acc.id,
      cursor: 1,
      documents: Array.from({ length: 30 }, (_, i) => ({
        externalId: `m${i}`,
        type: 'email.message',
        title: `Invoice ${i}`,
        markdown: `the invoice and the meeting report ${i}`,
        metadata: { labels: ['INBOX'], from: `p${i % 3}@example.com` },
        createdAt: '2026-01-01T00:00:00Z',
      })),
    });
    // The server reads through a createCorpusQuery whose fuzzyRuns counter is
    // dumped like the app's KIA_READ_DIAG_FILE (same field names, 100 ms cadence).
    const corpus = createCorpusQuery(db, { languageCache: 'data-version' });
    stopDiag = startReadDiagnosticsDump(
      diag,
      async () => ({
        reads: {
          fuzzyRuns: corpus.fuzzyRuns(),
          groups: [{ method: 'countBy', via: 'reader', count: 1 }],
          fallbacks: {},
        },
      }),
      100,
    );
    handle = await startMcp({
      query: corpus.query,
      logSink: { log: () => {} },
      dataDir: dir,
      portCandidates: [0],
      sqlExecutor: createInProcessSqlExecutor(path.join(dir, 'kiagent.db')),
    });
  });

  afterAll(async () => {
    stopDiag();
    await handle.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Common args; a real misspelling by default ("nvoic" occurs inside "Invoice"). */
  const probeArgs = (...extra: string[]) => [
    PROBE,
    '--url', `http://127.0.0.1:${handle.port}/mcp`,
    '--cycles', '1',
    '--interval', '0',
    '--diag', diag,
    '--fuzzy', 'nvoic',
    ...extra,
  ];
  /** Baseline mode: NO --diag, no --fuzzy (the term comes from the validated file). */
  const baselineArgs = (...extra: string[]) => [
    PROBE,
    '--url', `http://127.0.0.1:${handle.port}/mcp`,
    '--cycles', '1',
    '--interval', '0',
    ...extra,
  ];
  const fail3 = (args: string[], stderr: RegExp) =>
    expect(run(process.execPath, args)).rejects.toMatchObject({ code: 3, stderr: expect.stringMatching(stderr) });

  it('runs one cycle of the fixed workload and reports p50/p95 per kind (real misspelling: counter +1)', async () => {
    const ids = path.join(dir, 'ids.json');
    const { stdout } = await run(process.execPath, probeArgs('--label', 'test', '--ids', ids));
    const report = JSON.parse(stdout.trim().split('\n').pop()!);
    expect(report.label).toBe('test');
    const saved = JSON.parse(fs.readFileSync(ids, 'utf8'));
    expect(saved.ids).toHaveLength(10);
    expect(saved.fuzzy).toBe('nvoic');
    expect(report.kinds.search.n).toBe(12); // 10 text searches + 2 recency/filter-only
    expect(report.kinds.get.n).toBe(10);
    expect(report.kinds.count.n).toBe(2); // group_by label + from
    expect(report.kinds.info.n).toBe(1);
    expect(report.kinds.loop.n).toBe(1);
    for (const k of ['search', 'get', 'count', 'info', 'loop']) {
      expect(report.kinds[k].p95).toBeGreaterThanOrEqual(report.kinds[k].p50);
    }
  });

  it('--validate-only validates, writes the workload file and exits 0 without measuring', async () => {
    const ids = path.join(dir, 'validated.json');
    const { stdout } = await run(process.execPath, probeArgs('--validate-only', '--ids', ids));
    expect(JSON.parse(stdout.trim().split('\n').pop()!)).toMatchObject({ validated: true, fuzzy: 'nvoic' });
    expect(JSON.parse(fs.readFileSync(ids, 'utf8'))).toMatchObject({ fuzzy: 'nvoic' });
  });

  it('baseline mode (no --diag) reuses the validated file, takes its fuzzy term and does not re-validate', async () => {
    const ids = path.join(dir, 'validated.json'); // written by the previous test
    const { stdout } = await run(process.execPath, baselineArgs('--ids', ids));
    const report = JSON.parse(stdout.trim().split('\n').pop()!);
    expect(report.kinds.get.n).toBe(10);
    expect(report.kinds.search.n).toBe(12);
  });

  it('baseline mode without a validated workload file exits 3', async () => {
    await fail3(baselineArgs(), /validated run/); // no --ids at all
    await fail3(baselineArgs('--ids', path.join(dir, 'does-not-exist.json')), /validated run/);
    const noFuzzy = path.join(dir, 'no-fuzzy.json');
    fs.writeFileSync(noFuzzy, JSON.stringify({ ids: Array.from({ length: 10 }, (_, i) => `x${i}`) }));
    await fail3(baselineArgs('--ids', noFuzzy), /validated run/);
  });

  it('exit 3 for a STEMMED term: the exact page is full, the fuzzy counter does not move', async () => {
    // 30 "invoice" documents fill the 10-hit page for "invoices": search returns hits,
    // but the trigram fallback never runs, so this term would skip the fuzzy workload.
    await fail3(probeArgs('--fuzzy', 'invoices'), /not fuzzy-only/);
  });

  it('exit 3 when the fuzzy term returns nothing', async () => {
    await fail3(probeArgs('--fuzzy', 'zzqxjk-no-such-substring'), /not fuzzy-only/);
  });

  it('exit 3 when the ids file holds ids that are not documents (null gets) or are not distinct', async () => {
    const fake = path.join(dir, 'fake-ids.json');
    fs.writeFileSync(fake, JSON.stringify({ ids: Array.from({ length: 10 }, (_, i) => `no-such-doc-${i}`), fuzzy: 'nvoic' }));
    await fail3(probeArgs('--ids', fake), /invalid workload/);
    const dup = path.join(dir, 'dup-ids.json');
    fs.writeFileSync(dup, JSON.stringify({ ids: Array.from({ length: 10 }, () => 'same'), fuzzy: 'nvoic' }));
    await fail3(probeArgs('--ids', dup), /DISTINCT/);
  });

  it('exit 3 when the --baseline report has no get samples', async () => {
    const base = path.join(dir, 'bad-baseline.json');
    const k = (n: number, p95: number) => ({ n, p50: p95, p95, max: p95 });
    fs.writeFileSync(
      base,
      JSON.stringify({
        label: 'idle',
        cycles: 2,
        kinds: { search: k(24, 5), get: k(0, 0), count: k(4, 5), info: k(2, 1), loop: k(2, 1) },
      }),
    );
    await fail3(probeArgs('--baseline', base), /baseline get/);
  });
});
```

`src/main/core/mcp/__tests__/latency-probe-workload.test.ts` (the workload helpers are plain ESM, so the test drives them in a child `node` with a scripted fake MCP `call`):

```ts
/** @jest-environment node */
import { execFile } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const WORKLOAD = pathToFileURL(
  path.resolve(__dirname, '..', '..', '..', '..', '..', 'scripts', 'mcp-latency-probe-workload.mjs'),
).href;

const node = async (body: string) => {
  const { stdout } = await run(process.execPath, [
    '--input-type=module',
    '-e',
    `import * as w from ${JSON.stringify(WORKLOAD)};\n${body}`,
  ]);
  return JSON.parse(stdout.trim().split('\n').pop()!);
};

describe('probe workload', () => {
  it('starts BOTH countBy calls before issuing the gets, so the gets overlap the aggregate', async () => {
    const events: string[] = await node(`
      const events = [];
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const call = async (name, args) => {
        const tag = name + ':' + (args.group_by ?? args.id);
        events.push('start:' + tag);
        if (name === 'count') await sleep(300); // a slow countBy
        events.push('end:' + tag);
        return {};
      };
      const timed = async (kind, fn) => fn();
      await w.runGetsAndCounts({ call, timed, ids: ['a', 'b', 'c'] });
      console.log(JSON.stringify(events));
    `);
    const at = (e: string) => events.indexOf(e);
    // both aggregates started first...
    expect(at('start:count:label')).toBeLessThan(at('start:get:a'));
    expect(at('start:count:from')).toBeLessThan(at('start:get:a'));
    // ...and every get was issued AND finished while they were still in flight
    for (const id of ['a', 'b', 'c']) {
      expect(at(`start:get:${id}`)).toBeLessThan(at('end:count:label'));
      expect(at(`end:get:${id}`)).toBeLessThan(at('end:count:label'));
      expect(at(`end:get:${id}`)).toBeLessThan(at('end:count:from'));
    }
  });

  it('a get that returns null / {} is reported as bad, not as a success', async () => {
    const bad: string[] = await node(`
      const call = async (name, args) => (name === 'get' ? (args.id === 'a' ? null : args.id === 'b' ? {} : { id: args.id, title: 't' }) : {});
      const timed = async (kind, fn) => fn();
      console.log(JSON.stringify(await w.runGetsAndCounts({ call, timed, ids: ['a', 'b', 'c'] })));
    `);
    expect(bad).toEqual(['a', 'b']);
  });

  it('validateIds rejects duplicate ids and ids that are not documents', async () => {
    const out = await node(`
      const ids = Array.from({ length: 10 }, (_, i) => 'd' + i);
      const call = async (name, args) => (args.id === 'd3' ? null : { id: args.id, title: 't' });
      console.log(JSON.stringify({
        ok: await w.validateIds(async (n, a) => ({ id: a.id, title: 't' }), ids),
        dup: await w.validateIds(call, Array(10).fill('d1')),
        missing: await w.validateIds(call, ids),
      }));
    `);
    expect(out.ok).toEqual([]);
    expect(out.dup.join(' ')).toMatch(/DISTINCT/);
    expect(out.missing.join(' ')).toMatch(/d3/);
  });

  it('validateFuzzy needs the app fuzzyRuns counter to move AND at least one search hit', async () => {
    const out = await node(`
      // readRuns returns the counter; the search itself bumps it by \`bump\`.
      const mk = (bump, hits) => {
        let runs = 4;
        return {
          call: async () => { runs += bump; return hits; },
          readRuns: async () => runs,
        };
      };
      const run = async (bump, hits, term) => {
        const m = mk(bump, hits);
        return w.validateFuzzy(m.call, term, m.readRuns);
      };
      console.log(JSON.stringify({
        misspelling: await run(1, [{ id: 'x' }], 'nvoic'),
        stemmed: await run(0, [{ id: 'x' }], 'invoices'),
        nothing: await run(1, [], 'zzz'),
      }));
    `);
    expect(out.misspelling).toBeNull();
    expect(out.stemmed).toMatch(/not fuzzy-only/);
    expect(out.nothing).toMatch(/not fuzzy-only/);
  });

  it('checkBaseline rejects a baseline without get samples or with p95 0', async () => {
    const out = await node(`
      const k = (n, p95) => ({ n, p50: p95, p95, max: p95 });
      const good = { cycles: 2, kinds: { search: k(24, 5), get: k(20, 4), count: k(4, 5), info: k(2, 1), loop: k(2, 1) } };
      const noGet = { cycles: 2, kinds: { ...good.kinds, get: k(0, 0) } };
      console.log(JSON.stringify({ good: w.checkBaseline(good), noGet: w.checkBaseline(noGet) }));
    `);
    expect(out.good).toEqual([]);
    expect(out.noGet.join(' ')).toMatch(/baseline get/);
  });

  it('checkSamples flags missing samples and passes a complete report', async () => {
    const out = await node(`
      const full = { search: { n: 24 }, get: { n: 20 }, count: { n: 4 }, info: { n: 2 }, loop: { n: 2 } };
      const short = { ...full, get: { n: 19 }, search: { n: 0 } };
      console.log(JSON.stringify({ ok: w.checkSamples(full, 2), bad: w.checkSamples(short, 2) }));
    `);
    expect(out.ok).toEqual([]);
    expect(out.bad).toHaveLength(2);
    expect(out.bad.join(' ')).toMatch(/get/);
    expect(out.bad.join(' ')).toMatch(/search/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/main/core/mcp/__tests__/latency-probe.test.ts`
Expected: FAIL — probe script missing.

- [ ] **Step 3: Write the workload helpers and the probe**

`scripts/mcp-latency-probe-workload.mjs` (plain ESM, importable by tests):

```js
/** Workload helpers for scripts/mcp-latency-probe.mjs (#146). */
export const EXPECTED_IDS = 10;

/** Per-cycle sample counts the fixed workload promises. */
const PER_CYCLE = { search: 12, get: 10, count: 2, info: 1, loop: 1 };

/** Setup (BEFORE any measurement): up to `want` distinct valid document ids
 *  from the text queries. */
export async function collectIds(call, queries, want = EXPECTED_IDS) {
  const ids = [];
  for (const q of queries) {
    const hits = await call('search', { query: q, limit: 10 });
    for (const h of hits) if (ids.length < want && !ids.includes(h.id)) ids.push(h.id);
    if (ids.length >= want) break;
  }
  return ids;
}

/** A `get` result counts as a document only when it is a non-empty object
 *  without an `error` field (null / {} / error payloads are FAILED samples). */
export const isDocument = (r) =>
  r != null && typeof r === 'object' && !Array.isArray(r) && Object.keys(r).length > 0 && !('error' in r);

/** The concurrent part of a cycle. BOTH `count` group_by calls (they reach
 *  Query.countBy over the whole corpus) are STARTED FIRST, then the gets are
 *  issued, so the gets overlap the aggregates. `timed(kind, fn)` records one
 *  sample per call. Returns the ids whose `get` did NOT return a document (the
 *  caller turns any of them into exit 3: a failed get is never a fast success). */
export async function runGetsAndCounts({ call, timed, ids }) {
  const bad = [];
  const counts = [
    timed('count', () => call('count', { group_by: 'label' })),
    timed('count', () => call('count', { group_by: 'from' })),
  ];
  const gets = ids.map((id) =>
    timed('get', async () => {
      const r = await call('get', { id });
      if (!isDocument(r)) bad.push(id);
      return r;
    }),
  );
  await Promise.all([...counts, ...gets]);
  return bad;
}

/** Setup validation of the `get` ids: exactly `EXPECTED_IDS` DISTINCT ids, each
 *  of which returns a document. Returns problem messages (empty = valid). */
export async function validateIds(call, ids) {
  const problems = [];
  if (!Array.isArray(ids) || new Set(ids).size !== EXPECTED_IDS || ids.length !== EXPECTED_IDS) {
    problems.push(`need exactly ${EXPECTED_IDS} DISTINCT get ids, have ${Array.isArray(ids) ? `${new Set(ids).size} distinct of ${ids.length}` : 0}`);
    return problems;
  }
  for (const id of ids) {
    try {
      if (!isDocument(await call('get', { id }))) problems.push(`get ${id} returned no document`);
    } catch (e) {
      problems.push(`get ${id} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return problems;
}

/** The fuzzy term must really EXECUTE the fuzzy pass on this corpus, and the
 *  search must return something. The proof is the app's own counter
 *  (`reads.fuzzyRuns` in the read diagnostics), not a reimplementation of
 *  stemming here: `readRuns(sinceMs)` resolves the counter from a diagnostics
 *  snapshot taken at or after `sinceMs`. Returns a problem message or null. */
export async function validateFuzzy(call, term, readRuns) {
  const before = await readRuns(Date.now());
  const hits = await call('search', { query: term, limit: 10 });
  const after = await readRuns(Date.now());
  const n = Array.isArray(hits) ? hits.length : 0;
  if (!(after > before) || n === 0) {
    return `fuzzy term "${term}" is not fuzzy-only on this corpus; pick a misspelling (fuzzy runs ${before} -> ${after}, search hits ${n})`;
  }
  return null;
}

/** A baseline report is only comparable if it is itself a complete run. */
export function checkBaseline(base) {
  const problems = [];
  const cycles = Number(base?.cycles ?? 0);
  if (!(cycles > 0)) return ['baseline report has no cycles'];
  for (const p of checkSamples(base.kinds ?? {}, cycles)) problems.push(`baseline ${p}`);
  for (const k of ['search', 'get']) {
    if (!(base.kinds?.[k]?.p95 > 0)) problems.push(`baseline ${k} p95 is not > 0`);
  }
  return problems;
}

/** Returns one message per kind whose sample count differs from the fixed
 *  workload (an empty array = complete). `kinds` is `{ [kind]: { n } }`. */
export function checkSamples(kinds, cycles) {
  const problems = [];
  for (const [kind, per] of Object.entries(PER_CYCLE)) {
    const want = per * cycles;
    const got = kinds[kind]?.n ?? 0;
    if (got !== want) problems.push(`${kind}: ${got} samples, expected ${want}`);
  }
  return problems;
}
```

`scripts/mcp-latency-probe.mjs`:

```js
#!/usr/bin/env node
/**
 * External MCP latency probe (#146 spec §6). An MCP client, outside the app,
 * running a FIXED workload against the loopback server every `--interval` ms:
 *
 *   - 10 text searches (one fuzzy-only term, one account-restricted),
 *   - 2 recency / filter-only searches,
 *   - 1 digital_memory_info,
 *   - the 10 `get` ids (fixed per --ids file) issued CONCURRENTLY with `count`
 *     group_by label and from, which are STARTED FIRST so the gets overlap
 *     Query.countBy over the whole corpus,
 *   - 1 get_schema: static text, no database — its round trip is the proxy for
 *     main-process event-loop lag (converters, #147).
 *
 * Reports p50/p95 for search and get SEPARATELY. Usage:
 *   node scripts/mcp-latency-probe.mjs --url http://127.0.0.1:7421/mcp \
 *     --cycles 24 --interval 5000 --label during-sync --out during-sync.json \
 *     --diag /tmp/kia-read-diag.json --baseline idle.json --ids ids.json
 *   node scripts/mcp-latency-probe.mjs --url … --diag … --ids ids.json --validate-only
 * where --diag is the file the app writes with KIA_READ_DIAG_FILE=/tmp/kia-read-diag.json,
 * --baseline is the --out of an idle run and --ids is the workload file
 * `{ ids: [10 get ids], fuzzy: "<validated term>" }`. Order of use:
 *   1. new build:  --validate-only --diag … --ids ids.json   (validates + writes it)
 *   2. v0.104.0 baseline: --ids ids.json, NO --diag (that build has no
 *      diagnostics): it requires the file from step 1 and does not re-validate.
 *   3. new build measurement: --diag … --ids ids.json (re-validates the fuzzy
 *      term against the app's fuzzyRuns counter every run).
 * Last stdout line = JSON report. Exit 3 = the workload itself was invalid.
 */
import fs from 'node:fs';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import {
  checkBaseline,
  checkSamples,
  collectIds,
  runGetsAndCounts,
  validateFuzzy,
  validateIds,
} from './mcp-latency-probe-workload.mjs';

function parseArgs(argv) {
  const o = {
    url: 'http://127.0.0.1:7421/mcp',
    cycles: 12,
    interval: 5000,
    terms: 'invoice,meeting,report,contract,payment,schedule,project,travel,"thank you"',
    fuzzy: 'rechnung',
    label: 'run',
    out: '',
    diag: '',
    baseline: '',
    ids: '',
    'validate-only': false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const key = a.slice(2);
    if (!(key in o)) throw new Error(`unknown option ${a}`);
    if (typeof o[key] === 'boolean') {
      o[key] = true;
      continue;
    }
    i += 1;
    if (argv[i] === undefined) throw new Error(`${a} needs a value`);
    o[key] = typeof o[key] === 'number' ? Number(argv[i]) : argv[i];
  }
  return o;
}

const percentile = (sorted, p) =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
const stat = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const r = (n) => Math.round(n * 10) / 10;
  return { n: s.length, p50: r(percentile(s, 0.5)), p95: r(percentile(s, 0.95)), max: r(s[s.length - 1] ?? 0) };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const opts = parseArgs(process.argv.slice(2));
const samples = { search: [], get: [], count: [], info: [], loop: [] };

class InvalidWorkload extends Error {}
const invalid = (msg) => {
  throw new InvalidWorkload(msg);
};

const client = new Client({ name: 'kia-latency-probe', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(opts.url)));

async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) throw new Error(`${name}: ${res.content?.[0]?.text}`);
  return JSON.parse(res.content[0].text);
}
async function timed(kind, fn) {
  const t0 = performance.now();
  const r = await fn();
  samples[kind].push(performance.now() - t0);
  return r;
}

/** fuzzyRuns from a diagnostics snapshot written at or after `sinceMs` (the
 *  app stamps `snapshotAt` before it snapshots, every 5 s). */
async function readFuzzyRuns(sinceMs, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const d = JSON.parse(fs.readFileSync(opts.diag, 'utf8'));
      if (d.snapshotAt >= sinceMs && typeof d.reads?.fuzzyRuns === 'number') return d.reads.fuzzyRuns;
    } catch {
      /* not written yet / mid-write: poll again */
    }
    if (Date.now() > end) {
      invalid(`${opts.diag} was not refreshed with reads.fuzzyRuns within ${timeoutMs} ms (KIA_READ_DIAG_FILE set on a build that has fuzzyRuns?)`);
    }
    await sleep(50);
  }
}

async function main() {
  // ── Setup, BEFORE any measurement: the workload must be valid or the numbers
  // mean nothing (exit 3, never a quietly thinner run).
  const validateOnly = opts['validate-only'];
  if (validateOnly && !opts.diag) invalid('--validate-only needs --diag (the fuzzy proof is the app\'s fuzzyRuns counter)');
  if (validateOnly && !opts.ids) invalid('--validate-only needs --ids <file> to write the validated workload to');
  let saved = null;
  if (opts.ids && fs.existsSync(opts.ids)) saved = JSON.parse(fs.readFileSync(opts.ids, 'utf8'));
  if (!opts.diag) {
    // Baseline mode (v0.104.0 has no diagnostics): reuse a VALIDATED workload.
    if (!saved || !Array.isArray(saved.ids) || typeof saved.fuzzy !== 'string' || !saved.fuzzy) {
      invalid('without --diag the probe needs an --ids file produced by a validated run (--validate-only --diag …); none found or it has no validated fuzzy term');
    }
    opts.fuzzy = saved.fuzzy;
  }
  // The 10 text queries: the configured terms, then the fuzzy-only term last.
  const queries = [...opts.terms.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 9), opts.fuzzy];
  while (queries.length < 10) queries.push(queries[queries.length - 1]);
  const accounts = (await call('digital_memory_info')).accounts ?? [];
  const restrictTo = accounts[0]?.source;

  let base = null;
  if (opts.baseline) {
    base = JSON.parse(fs.readFileSync(opts.baseline, 'utf8'));
    const bp = checkBaseline(base);
    if (bp.length > 0) invalid(bp.join('; '));
  }
  const ids = saved?.ids ?? (await collectIds(call, queries));
  const idProblems = await validateIds(call, ids); // 10 distinct ids, each a real document
  if (idProblems.length > 0) invalid(idProblems.join('; '));
  if (opts.diag) {
    const fuzzyProblem = await validateFuzzy(call, opts.fuzzy, readFuzzyRuns);
    if (fuzzyProblem) invalid(fuzzyProblem);
    if (opts.ids) fs.writeFileSync(opts.ids, JSON.stringify({ ids, fuzzy: opts.fuzzy }, null, 2));
  }
  if (validateOnly) {
    process.stdout.write(`${JSON.stringify({ label: opts.label, validated: true, ids, fuzzy: opts.fuzzy })}\n`);
    return 0;
  }

  const badGets = [];
  for (let cycle = 0; cycle < opts.cycles; cycle += 1) {
    const started = performance.now();
    for (let i = 0; i < 10; i += 1) {
      const args = { query: queries[i], limit: 10 };
      if (i === 1 && restrictTo) args.source = restrictTo; // account-restricted
      await timed('search', () => call('search', args));
    }
    for (const extra of [{}, { query: 'has:attachment' }]) {
      await timed('search', () => call('search', { ...extra, limit: 10 })); // recency / filter-only
    }
    await timed('info', () => call('digital_memory_info'));
    badGets.push(...(await runGetsAndCounts({ call, timed, ids }))); // countBy first, gets overlap it
    await timed('loop', () => call('get_schema'));
    const rest = opts.interval - (performance.now() - started);
    if (cycle < opts.cycles - 1 && rest > 0) await sleep(rest);
  }
  if (badGets.length > 0) {
    invalid(`${badGets.length} get call(s) returned no document (a failed get is not a sample): ${[...new Set(badGets)].join(', ')}`);
  }

  const report = {
    label: opts.label,
    at: new Date().toISOString(),
    cycles: opts.cycles,
    kinds: Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, stat(v)])),
  };

  let exitCode = 0;
  const missing = checkSamples(report.kinds, opts.cycles);
  if (missing.length > 0) invalid(`missing samples: ${missing.join('; ')}`);
  if (opts.diag) {
    const diag = JSON.parse(fs.readFileSync(opts.diag, 'utf8'));
    const groups = diag.reads?.groups ?? [];
    const countBy = groups
      .filter((g) => g.method === 'countBy' && g.via === 'reader')
      .reduce((n, g) => n + g.count, 0);
    const fb = diag.reads?.fallbacks ?? {};
    report.fallbacks = fb;
    report.readerCountBy = countBy;
    if (countBy === 0) {
      process.stderr.write('WARN: readDiagnostics shows no countBy execution on the reader\n');
      exitCode = 2;
    }
    if (Object.values(fb).some((n) => n > 0)) {
      process.stderr.write(`FAIL: reader fallbacks fired: ${JSON.stringify(fb)}\n`);
      exitCode = 1;
    }
  }
  if (base) {
    report.vsBaseline = {};
    for (const k of ['search', 'get']) {
      const ratio = report.kinds[k].p95 / base.kinds[k].p95;
      report.vsBaseline[k] = Math.round(ratio * 100) / 100;
      if (ratio > 2) {
        process.stderr.write(`FAIL: ${k} p95 ${report.kinds[k].p95} ms is ${ratio.toFixed(2)}x idle (${base.kinds[k].p95} ms)\n`);
        exitCode = 1;
      }
    }
  }
  for (const [k, v] of Object.entries(report.kinds)) {
    process.stderr.write(`${k.padEnd(7)} n=${String(v.n).padStart(4)}  p50=${v.p50} ms  p95=${v.p95} ms  max=${v.max} ms\n`);
  }
  if (opts.out) fs.writeFileSync(opts.out, JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return exitCode;
}

let code = 0;
try {
  code = await main();
} catch (e) {
  if (e instanceof InvalidWorkload) {
    process.stderr.write(`FAIL (invalid workload): ${e.message}\n`);
    code = 3;
  } else {
    process.stderr.write(`FAIL: ${e instanceof Error ? e.stack : String(e)}\n`);
    code = 1;
  }
} finally {
  await client.close().catch(() => {});
}
// Set the exit code and let the process end by itself: a hard process.exit()
// right after writing to a pipe truncates stdout/stderr on Windows.
process.exitCode = code;
```

- [ ] **Step 4: Run — expect PASS**

Run: `npx jest src/main/core/mcp/__tests__/latency-probe.test.ts`, then `npx jest src/main/core/mcp/__tests__/latency-probe-workload.test.ts`
Then: `npx eslint --fix src/main/core/mcp/__tests__/latency-probe.test.ts src/main/core/mcp/__tests__/latency-probe-workload.test.ts` (the `.mjs` scripts are outside the eslint glob; run `node --check scripts/mcp-latency-probe.mjs scripts/mcp-latency-probe-workload.mjs`).
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
printf 'feat(scripts): external MCP latency probe for read acceptance (#146)\n' > /tmp/msg-r8
git add scripts/mcp-latency-probe.mjs scripts/mcp-latency-probe-workload.mjs src/main/core/mcp/__tests__/latency-probe.test.ts src/main/core/mcp/__tests__/latency-probe-workload.test.ts
git commit -F /tmp/msg-r8 -- scripts/mcp-latency-probe.mjs scripts/mcp-latency-probe-workload.mjs src/main/core/mcp/__tests__/latency-probe.test.ts src/main/core/mcp/__tests__/latency-probe-workload.test.ts
```

---

### Task 9: Gates + spec status

- [ ] **Step 1:** Lint every changed TS file: `git diff --name-only c369815d -- '*.ts' '*.tsx' | xargs npx eslint`. Fix findings.
- [ ] **Step 2:** `npx tsc -p tsconfig.typecheck.json` — clean.
- [ ] **Step 3:** Baseline at v0.104.0 (`c369815d`). Check `git -C ~/work/kiagent-core-agent-sessions rev-parse HEAD`; if it prints `c369815d…`, run the baseline there. If it does NOT, create a temporary worktree at the tag instead and run it there:

```bash
BASE=$TMPDIR/kcore-baseline-v0.104.0
git -C ~/work/kcore-read worktree add "$BASE" v0.104.0
# symlink dependencies exactly like the main worktree (see the worktree-gates recipe).
# jest's setup requires release/app/dist/main/main.js and renderer/renderer.js, so
# release/app/dist and release/app/node_modules are linked too.
ln -s ~/work/kcore-read/node_modules "$BASE/node_modules"
mkdir -p "$BASE/release/app"
ln -s ~/work/kcore-read/release/app/dist "$BASE/release/app/dist"
ln -s ~/work/kcore-read/release/app/node_modules "$BASE/release/app/node_modules"
[ -d ~/work/kcore-read/build/.core ] && mkdir -p "$BASE/build" && ln -s ~/work/kcore-read/build/.core "$BASE/build/.core"
```

Run `npx jest --json --outputFile=/tmp/jest-baseline.json` there (sequential, alone). When done, UNLINK the symlinks BEFORE removing the worktree (so `worktree remove` cannot follow them into the shared directories):

```bash
rm "$BASE/node_modules" "$BASE/release/app/dist" "$BASE/release/app/node_modules"; [ -L "$BASE/build/.core" ] && rm "$BASE/build/.core"
git -C ~/work/kcore-read worktree remove "$BASE"
```

Then in `~/work/kcore-read`: `npx jest --json --outputFile=/tmp/jest-branch.json`. Compare the FAILED suites:

```bash
for f in baseline branch; do
  node -e "const r=require('/tmp/jest-$f.json');console.log(r.testResults.filter(t=>t.status==='failed').map(t=>t.name.replace(/^.*\/src\//,'src/')).sort().join('\n'))" > /tmp/failed-$f.txt
done
/usr/bin/diff /tmp/failed-baseline.txt /tmp/failed-branch.txt
```

(use `/usr/bin/diff`, plain `diff` is a git shell function here.) New reds must be fixed; pre-existing reds (e.g. the known `task8-real-core-adoption`) are recorded, not fixed. Run the heavy suites of this plan alone first if the full run flakes: `reads-no-queue`, `sql-runner-process`, `stdio-entry`.
- [ ] **Step 4: Grep gates** (each must print exactly what is stated):

```bash
git grep -n "rrfMerge" -- src                                   # nothing
git grep -n "corpusLangsCache" -- src                           # nothing
git grep -n "createRawSqlTools(" -- src ':!*__tests__*'         # raw-sql.ts definition, server.ts, stdio-entry.ts - all with an executor
git grep -n "new Database(" -- src/main/core/mcp ':!*__tests__*' # only tools/raw-sql.ts (in-process executor)
git grep -n "sqlExecutor" -- src/main/main.ts                   # exactly the createSqlRunner wiring
git grep -n "createInProcessSqlExecutor" -- src/main/core/mcp/server.ts   # nothing (the server has no in-process default)
git grep -n "p\.store\.read\.\(search\|document\|children\)" -- src/main/main.ts   # nothing
git grep -nE "query\.search\(" -- src/main/core/mcp/tools       # each file also contains project: 'snippet' | 'metadata'
```
- [ ] **Step 5:** Verify the webpack entry names exist in BOTH configs: `git grep -n "sqlRunner:" -- .erb/configs` → two hits.
- [ ] **Step 6:** In the spec, change the status line `**Status:** APPROVED rev 5 (2026-10-08) —` to `**Status:** IMPLEMENTED (local, not released; plan 2026-10-08-mcp-read-worker.md; live acceptance OWED) — was APPROVED rev 5 (2026-10-08) —` and commit:

```bash
printf 'docs(spec): MCP read worker implemented, acceptance owed (#146)\n' > /tmp/msg-r9
git commit -F /tmp/msg-r9 -- docs/superpowers/specs/2026-10-08-mcp-read-worker-design.md
```

### Task 10: Live acceptance (before any core release; NOT executed by the implementing agent)

Needs the founder's machine, the Windows VM and PACKAGED candidate builds. Core is NOT released until every box below passes. Dedicated worktree dev app only for the latency runs (never the shared checkout; one profile — do NOT create fresh profiles, see the cert-mint limit). Record results in the spec §6 and the issue.

- [ ] **Packaged candidates (REQUIRED, macOS AND Windows, before any core release).** In alpha-cent build a release candidate whose `core.lock` pins a LOCAL core tag cut from this branch (`KIA_TEST_BUILD=1`, so the feeds are not touched), per `docs/runbooks/release-testing.md`; build one leg at a time (docker leg first, then mac, then smoke mac, then smoke win; never in parallel). Run `node build/release-smoke.mjs --build-root ~/work/ac-prod-build --asr` on both platforms and require the full stage list green (13 stages). The jest suite cannot prove the Electron utility-process boundary or the packaged better-sqlite3; this step does.
- [ ] **Packaged `query_sql` checks (manual, on the macOS and the Windows candidate, over the packaged app's loopback MCP, with `KIA_READ_DIAG_FILE` set):** (1) `SELECT 1 AS one` returns `[{"one":1}]`; (2) a non-yielding heavy statement (the HEAVY aggregate from `sql-runner-process.test.ts`) is stopped at 10 s with the specified stop message; (3) the diag file then shows `sql.state: 'none'` / `sql.pid: null`, and the former runner pid is gone from the OS process table (`ps` / Task Manager); (4) the next `SELECT 1 AS one` succeeds. Any failure blocks the core release.
- [ ] **Setup (latency runs; order matters: (a) validate on the new build, (b) v0.104.0 baseline with that file, (c) new-build measurement):** build a dev app from this branch; start it with `KIA_READ_DIAG_FILE=/tmp/kia-read-diag.json`. For the "before" numbers use the v0.104.0 build on the SAME corpus/cache state (copy the profile data dir; restore it between runs).
- [ ] **(a) Validate the workload on the NEW build (first, once):** `node scripts/mcp-latency-probe.mjs --url http://127.0.0.1:7421/mcp --validate-only --diag /tmp/kia-read-diag.json --ids ids.json --fuzzy <misspelling or fragment of a word that occurs in this corpus>`. It checks 10 distinct existing `get` ids and that the fuzzy term really runs the fuzzy pass (the app's `reads.fuzzyRuns` rises and the search returns a hit), then writes `ids.json` (`{ ids, fuzzy }`). Exit 3 = not fuzzy-only on this corpus (a stemmed word whose exact page is full, or no hit at all): pick another term and rerun. Never compare numbers from a run that exited 3.
- [ ] **(b) v0.104.0 "before" runs (same corpus/cache state):** `node scripts/mcp-latency-probe.mjs --url http://127.0.0.1:7421/mcp --cycles 24 --interval 5000 --label before-idle --out before-idle.json --ids ids.json` (NO `--diag`: that build has no read diagnostics; the probe requires the validated `ids.json` from (a), takes its fuzzy term from it and does not re-validate). Repeat during a Gmail + Drive initial sync with `--label before-sync --out before-sync.json --baseline before-idle.json`.
- [ ] **(c) New build measurement, idle baseline:** `node scripts/mcp-latency-probe.mjs --url http://127.0.0.1:7421/mcp --cycles 24 --interval 5000 --label idle --out idle.json --ids ids.json --diag /tmp/kia-read-diag.json` (re-validates the fuzzy term against the counter every run).
- [ ] **During sync, macOS weak path:** start with `KIA_HOST_WEAK=1`, trigger a Gmail + Drive initial sync, run the probe with `--label during-sync --out sync.json --baseline idle.json --ids ids.json --diag /tmp/kia-read-diag.json` (still step (c): same `ids.json` from (a)).
- [ ] **During sync, Windows VM:** same on the VM (`ssh win`; the diag path and the probe URL via the VM's loopback; see the Windows UTM recipe).
- [ ] **Pass criteria:** search and get p95 during sync <= ~2x idle p95 (the probe exits 1 otherwise); `fallbacks` all 0; the diag file shows `countBy` executed on the reader (probe exit code 2 otherwise); probe exit code 3 never; `walBytes` does not grow monotonically during the run. If the probe's `loop` kind (get_schema round trip) dominates the remaining latency, record the number and hand it to #147 instead of tuning around it.
- [ ] **Open items to record:** if get p95 fails because of a slow `count`/`countBy`/broad search on the single reader, that is the trigger for a second reader (spec §7), not for tuning here.

### Task 11 (after the core release — NOT in this branch): packaged smoke stage in alpha-cent

Task 10 proves the packaged boundary by hand BEFORE the release; this task automates the same `query_sql` checks as a permanent smoke stage so every later release keeps proving it. After core is released with this branch and alpha-cent's `core.lock` pins it, add a stage to the release smoke (`~/work/alpha-cent/build/release-smoke.mjs`, runbook `docs/runbooks/release-testing.md`), run on macOS AND Windows:

- [ ] Over the packaged app's loopback MCP: `query_sql` `SELECT 1 AS one` returns `[{"one":1}]` (the utility process loaded better-sqlite3).
- [ ] A non-yielding heavy statement (the HEAVY aggregate above) returns the 10 s stop message; then (with `KIA_READ_DIAG_FILE` set for the smoke run) the diag file shows `sql.state: 'none'`, and the former `sql.pid` is gone from the OS process table; the next `SELECT 1 AS one` succeeds.
- [ ] Commit in alpha-cent with the `core.lock` bump.

---

## Self-review (writing-plans checklist, run before commit)

**Spec coverage.** §3.1 read role → Task 3. §3.2 `createCorpusQuery`, `data_version` cache (sample before fill), fuzzy rewrite, projections, line-window move, `rrfMerge` deleted, callers → Tasks 1, 2 (renderer decision stated in Task 2). §3.3 routing → Task 5 (+ gate test). §3.4 runner (states, bounds, adapters, no demotion, executor interface, stdio in-process executor, server owns/stops it, webpack + resolver, `{state,pid}`) → Task 6. §3.5 open order, one wrapper, crash/parked/dead, shutdown order → Tasks 4, 5. §3.6 diagnostics → Tasks 4, 7. §5 tests → each task; "reads don't queue" → Task 5. §6 probe → Task 8; live runs → Tasks 10-11. §7 (second reader) → recorded in Task 10.

**Placeholder scan.** No TBD/TODO. Mechanical moves (Task 1 Steps 3-4) are cut/paste recipes with start/end markers and a verification `sed -n` because the moved code is 300+ existing lines; every NEW code step shows the code.

**Type consistency.** `QUERY_METHODS`/`QueryMethod` (Task 1) used by Tasks 3, 4; `createReadStats/createReadProxy/withWriterFallback` (Task 4) used by `openReads` (Task 5); `Reads.stats` used by `buildReadDiagnostics` (Task 7); `SqlRunnerDiagnostics` (Task 6) used by Task 7; `SqlExecutorHandle` (Task 6) used by `McpDeps.sqlExecutor`; `createWorkerEnv`/`WORKER_ENTRY`/`REPO_ROOT` (Task 3) used by Tasks 5, 6, 8.

**Rev 2 re-check.** Spec coverage: §3.4 bounds now UTF-8-byte and array-overhead exact (Task 6 tests), required executor (Task 6 Step 11), killable-runner isolation proven against a real read worker (Task 6 Step 9), no-queue incl. a reconcile-stage workload (Task 5), probe validity gates (Task 8), packaged candidates before release (Task 10). Placeholders: none added (every new step shows its code or exact command). Type consistency: `MAX_VALUE_BYTES` replaces `MAX_VALUE_CHARS` everywhere (Interfaces, impl, tests); `McpDeps.sqlExecutor` is required in Interfaces, server code, the three server tests, latency-probe test and main.ts; `runGetsAndCounts`/`collectIds`/`checkSamples`/`EXPECTED_IDS` (workload module) are used by the probe and its tests; `BootDeps` no longer gains `dbWorkerExecArgv` (Task 5 Interfaces and Step 4 agree).

**Rev 4 re-check (fuzzyRuns chain).** Same name end to end: `CorpusQuery.fuzzyRuns()` (Task 2, incremented right before `fuzzyCandidatesSql` runs) -> read procedure result `{ value, execMs, fuzzyRuns }` (Task 3 worker-entry + read-role test) -> `ReadRecord.fuzzyRuns?` / `ReadStatsSnapshot.fuzzyRuns` (Task 4, proxy passes `res.fuzzyRuns`) -> `ReadDiagnostics.reads.fuzzyRuns` + dump `snapshotAt` (Task 7) -> probe `readFuzzyRuns`/`validateFuzzy(call, term, readRuns)` (Task 8) -> Task 10 order (a) validate, (b) baseline without `--diag`, (c) measure. The query_sql/FTS-phrase check and `ftsPhraseLiteral` are gone. Note: the counter moves whenever the first page is short, not only for "fuzzy-only" words; that is exactly what the probe needs (the fuzzy pass executed) and a stemmed word with a full exact page is rejected.

**Rev 3 re-check.** Probe exports used by the probe and its tests are consistent: `isDocument`, `runGetsAndCounts` (returns bad ids), `validateIds`, `validateFuzzy` (rev 4: counter-based), `checkBaseline`, `checkSamples`, `collectIds`, `EXPECTED_IDS`; exit-3 causes in the Interfaces, the script and the tests agree; Task 5 reconcile test no longer references `BATCHES`/`overlapped`; Task 2 Step 6 imports (`Document`) match Task 1's trimmed head; no placeholders added.

**Plan-level decisions where the spec is silent** (kept minimal, flagged for the reviewer): `createCorpusQuery` returns `{ query, invalidateLanguages }` (spec shows `Query`; the writer needs the explicit invalidation hook); `McpDeps.sqlExecutor` is REQUIRED with no in-process default (the app passes the runner, gate-tested in main.ts; tests and the stdio sibling inject `createInProcessSqlExecutor`); runner `startTimeoutMs` (20 s) guards a child that never becomes ready; queued waiters survive a timeout stop and run on the fresh child, while an unexpected exit fails everything queued; `truncated: true` also covers a 64 KiB (UTF-8 byte) value cut, and the 1 MiB budget counts the serialized rows array including brackets and commas; `metadata` projection skips the fuzzy pass when the query has negated terms (it cannot fold bodies it does not read); `CorePlatform.reads` is attributed to caller `'other'` and `readsFor(caller)` carries MCP/renderer attribution.

## Review log

rev 1 → rev 2:
- A1: Task 6 `cutValue()` cuts by UTF-8 bytes at a code-point boundary; 1 MiB budget counts the serialized rows array (brackets, commas); row cut sets a hint; tests for non-ASCII, exact boundary, budget, row-cut hint.
- A2: `McpDeps.sqlExecutor` is required, no in-process default in the server; server/session-factory/outbound-routes/latency-probe tests inject one; only stdio-entry builds an in-process executor.
- A3: probe starts both `countBy` calls before the gets (`runGetsAndCounts`); unit test with a controlled slow countBy proves the overlap.
- A4: probe establishes exactly 10 get ids before measurement, persists/reuses them via `--ids`, exits 3 on missing samples, fewer than 10 ids, or a fuzzy term with no results.
- A5: Task 5 adds a real reconcile begin/stage workload test with concurrent reader assertions; Task 6 Step 9 adds a real read worker search/document test while the runaway SQL runs (lag assertion kept).
- A6: stdio bounds test covers the row cap, an oversized (>64 KiB) value and the 1 MiB aggregate through stdio; stdio-entry test in Task 6 lint and commit paths.
- A7: Task 10 requires packaged macOS and Windows candidates (`KIA_TEST_BUILD=1`, local core tag, `release-smoke.mjs --asr`) plus manual `query_sql` checks before any core release; Task 11 is the later automation.
- F1: reads-no-queue default fixture is 8 documents, 120 s timeout, the 300 ms mid-transaction check kept.
- F2: Task 1 `cq-head.ts` imports only `Account, Query` from contracts.
- F3: `BootDeps.dbWorkerExecArgv` dropped.
- F4: Task 2 test: 150 matches, no filter, the oldest 50 rowids never appear among candidates.
- F5: Task 2 merges the new names into the existing `../fuzzy` import in fuzzy.test.ts.
- F6: `sql-runner-entry.ts` exits in the send callback on open error.
- F7: Task 9 baseline uses a temporary v0.104.0 worktree (symlinked deps, unlinked before removal) when the agent-sessions checkout is not at `c369815d`.

rev 2 → rev 3:
- B1: probe validates 10 DISTINCT existing get ids before measuring, treats a null/empty get during measurement as a failure, validates the baseline report (sample counts, p95 > 0) before comparing; all exit 3; regression tests (null gets, duplicate/fake ids, baseline without get samples).
- B2: probe checks the fuzzy term has zero exact FTS matches (query_sql on `documents_fts`) AND at least one search hit, else exit 3 "not fuzzy-only"; rejection tested.
- B3: Task 5 reconcile test is ONE long `reconcileStage` transaction; reader calls finish before it settles and a writer-path control call waits behind it.
- B4: Task 9 baseline worktree also symlinks `release/app/dist` and `release/app/node_modules`; all symlinks unlinked before removal.
- B5: stdio `callSql` uses a definite local `live: Client`.
- B6: Task 2 Step 6 import instruction adds `Document` to the contracts import.
- B7: probe sets `process.exitCode` (main() returns the code, client closed in finally) instead of `process.exit`.
- B8: Task 10 v0.104.0 "before" run omits `--diag`.

rev 3 → rev 4:
- B2 via in-app fuzzyRuns counter (controller ruling): `CorpusQuery.fuzzyRuns()` (Task 2) -> `read` result (Task 3) -> `ReadStats` snapshot (Task 4) -> `readDiagnostics().reads.fuzzyRuns` with `snapshotAt` (Task 7); probe `validateFuzzy` uses the counter with `--diag`, adds `--validate-only`, baseline mode (no `--diag`) requires a validated `--ids` file and does not re-validate; query_sql/FTS check dropped; B1 rules kept; regression tests (stemmed term exit 3, misspelling passes, baseline without validated file exit 3); Task 10 order (a) validate, (b) v0.104.0 baseline, (c) measure.
