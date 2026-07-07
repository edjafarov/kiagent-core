# MCP Activity Feed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A live activity panel on the Connection screen showing every MCP tool call (when, which client, what was searched/fetched — document titles, not ids), fed by an append-only JSONL file that both the main process and the client-spawned stdio sibling write — which also makes stdio queries latch the onboarding "Try a query" step.

**Architecture:** One new module (`src/main/core/mcp/activity.ts`) owns the activity concept: `createActivityLog(dataDir)` gives both processes a path-based appender and gives main a replay-then-tail watcher over `<dataDir>/mcp-activity.jsonl`, plus a pure `summarizeCall` enricher. `attachToolHandlers` (shared by both transports) builds the enriched record per call; main's single watcher pushes batches to the renderer (`push:mcp-activity`) and latches `firstQueryAt` on any success, replacing the HTTP-only `onToolCall` plumbing. Spec: `docs/superpowers/specs/2026-07-06-mcp-activity-feed-design.md`.

**Tech Stack:** TypeScript, Electron, Node `fs` (appendFile / fs.watch on the data dir), Jest, React (renderer), existing IPC push/invoke plumbing.

## Global Constraints

- Titles are the only document content that enters the feed — never snippets, bodies, or markdown (spec "Constraints").
- The stdio entry must keep serving calls when the activity file or its directory is unwritable — `append` failures and `onActivity` callback failures are swallowed (spec "Constraints", "Producers").
- The activity file is `<dataDir>/mcp-activity.jsonl`, sibling of `kiagent.db`; the stdio process derives the directory from its existing `--db` argument — no new CLI arguments (spec "Architecture").
- Writes are path-based per append (`fs.appendFile(path, …)`), never a held fd (spec "Architecture").
- `MCP_ACTIVITY_RECENT_MAX = 200` lives in `src/shared/contracts.ts` (renderer and main both import it); `ROTATE_BYTES = 1_000_000` lives in `activity.ts`.
- `detail` is capped at 20 titles; overflow appends `…and N more`. Untitled documents render as `(untitled)`.
- Only main rotates the file, only at boot, inside `watch()` setup. Only main reads. Both processes append.
- No new dependencies.
- NEVER print, quote, or modify `src/main/sources/gmail/client-credentials.ts`. Never use real API tokens anywhere — test values must be obvious fakes.
- Before every commit run the token scan `git grep -cE "(xox[pbo]-|IGQ|EAA|ntn_|secret_|GOCSPX)[A-Za-z0-9-]{10,}" -- ':!package-lock.json'` (do NOT pipe through `head`); the only acceptable hits are the pre-existing ones in `src/main/core/mcp/server-icon.ts` and `src/main/sources/gmail/client-credentials.ts`, both untouched by your commit.
- Every commit message ends with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_019uWSRjNqDNAX1JQzshht8f`

---

### Task 1: Shared contract + activity module (`createActivityLog` + `summarizeCall`)

**Files:**
- Modify: `src/shared/contracts.ts` (after the `LogStore` interface, ~line 679)
- Create: `src/main/core/mcp/activity.ts`
- Test: `src/main/core/mcp/__tests__/activity.test.ts`

**Interfaces:**
- Consumes: nothing new — `fs`, `path`, jest.
- Produces (later tasks rely on these exact names):
  - `src/shared/contracts.ts`: `interface McpActivityRecord { ts: string; transport: 'http' | 'stdio'; client: string | null; tool: string; ok: boolean; ms: number; summary: string; detail?: string[]; error?: string }` and `const MCP_ACTIVITY_RECENT_MAX = 200`.
  - `src/main/core/mcp/activity.ts`: `interface ActivityLog { append(rec: McpActivityRecord): void; watch(onRecords: (recs: McpActivityRecord[]) => void): () => void; recent(): McpActivityRecord[]; reset(): void }`, `createActivityLog(dataDir: string): ActivityLog`, `summarizeCall(tool: string, args: Record<string, unknown>, result: unknown): { summary: string; detail?: string[] }`, `const ROTATE_BYTES = 1_000_000`.

- [ ] **Step 1: Add the shared contract**

In `src/shared/contracts.ts`, directly after the `LogStore` interface (it ends with `export(): Promise<string>; // zip path, for a bug report` + `}`), add:

```ts
/** One MCP tool call as seen by the user-facing activity feed — the
 *  enriched sibling of the raw 'mcp.call' LogSink audit. Written to
 *  <dataDir>/mcp-activity.jsonl by BOTH processes (main for HTTP sessions,
 *  the mcpStdio sibling for client-spawned stdio); read only by main.
 *  See src/main/core/mcp/activity.ts. */
export interface McpActivityRecord {
  ts: string; // ISO timestamp
  transport: 'http' | 'stdio';
  client: string | null; // MCP initialize clientInfo.name, e.g. "claude-desktop"
  tool: string;
  ok: boolean;
  ms: number;
  summary: string; // one human line, e.g. `search "invoices" → 12 hits`
  detail?: string[]; // document titles touched (absent when none)
  error?: string; // present when ok === false
}

/** Records kept/replayed by the activity feed — the file's rotation target
 *  and the renderer's list cap (shared: the renderer can't import main). */
export const MCP_ACTIVITY_RECENT_MAX = 200;
```

- [ ] **Step 2: Write the failing tests**

Create `src/main/core/mcp/__tests__/activity.test.ts`:

```ts
/**
 * Two halves: (1) createActivityLog — the JSONL append/replay/tail/rotate/
 * reset lifecycle, including a two-writer-instances-one-file case that
 * simulates the main + stdio process pair; (2) summarizeCall — one case per
 * row of the spec's enrichment table.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  MCP_ACTIVITY_RECENT_MAX,
  type McpActivityRecord,
} from '@shared/contracts';

import { createActivityLog, summarizeCall, ROTATE_BYTES } from '../activity';

function rec(over: Partial<McpActivityRecord> = {}): McpActivityRecord {
  return {
    ts: '2026-07-06T10:00:00.000Z',
    transport: 'stdio',
    client: 'claude-desktop',
    tool: 'search',
    ok: true,
    ms: 5,
    summary: 'search "x" → 1 hits',
    ...over,
  };
}

async function until(cond: () => boolean, ms = 4000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('until(): timed out');
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => {
      setTimeout(r, 25);
    });
  }
}

const sleep = (ms: number) =>
  new Promise((r) => {
    setTimeout(r, ms);
  });

describe('createActivityLog', () => {
  let dir: string;
  let stops: Array<() => void>;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-activity-'));
    stops = [];
  });
  afterEach(() => {
    for (const stop of stops) stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const file = () => path.join(dir, 'mcp-activity.jsonl');

  it('watch replays appended records as the first batch', async () => {
    const writer = createActivityLog(dir);
    writer.append(rec({ tool: 'a' }));
    writer.append(rec({ tool: 'b' }));
    await until(() => {
      try {
        return fs.readFileSync(file(), 'utf8').split('\n').length >= 3;
      } catch {
        return false;
      }
    });
    const reader = createActivityLog(dir);
    const got: McpActivityRecord[] = [];
    stops.push(reader.watch((rs) => got.push(...rs)));
    expect(got.map((r) => r.tool)).toEqual(['a', 'b']);
    expect(reader.recent().map((r) => r.tool)).toEqual(['a', 'b']);
  });

  it('a second writer instance reaches a live watcher (two-process shape)', async () => {
    const reader = createActivityLog(dir);
    const got: McpActivityRecord[] = [];
    stops.push(reader.watch((rs) => got.push(...rs)));
    const writerA = createActivityLog(dir);
    const writerB = createActivityLog(dir);
    writerA.append(rec({ tool: 'from-a' }));
    writerB.append(rec({ tool: 'from-b' }));
    await until(() => got.length === 2);
    expect(got.map((r) => r.tool).sort()).toEqual(['from-a', 'from-b']);
  });

  it('replay caps at MCP_ACTIVITY_RECENT_MAX, keeping the newest', async () => {
    const lines = [];
    for (let i = 0; i < MCP_ACTIVITY_RECENT_MAX + 50; i += 1) {
      lines.push(JSON.stringify(rec({ tool: `t${i}` })));
    }
    fs.writeFileSync(file(), `${lines.join('\n')}\n`);
    const reader = createActivityLog(dir);
    const got: McpActivityRecord[] = [];
    stops.push(reader.watch((rs) => got.push(...rs)));
    expect(got).toHaveLength(MCP_ACTIVITY_RECENT_MAX);
    expect(got[0].tool).toBe('t50');
    expect(got[got.length - 1].tool).toBe(`t${MCP_ACTIVITY_RECENT_MAX + 49}`);
  });

  it('buffers a partial line until its newline arrives', async () => {
    const reader = createActivityLog(dir);
    const got: McpActivityRecord[] = [];
    stops.push(reader.watch((rs) => got.push(...rs)));
    const line = JSON.stringify(rec({ tool: 'split' }));
    fs.appendFileSync(file(), line.slice(0, 10));
    await sleep(200);
    expect(got).toHaveLength(0);
    fs.appendFileSync(file(), `${line.slice(10)}\n`);
    await until(() => got.length === 1);
    expect(got[0].tool).toBe('split');
  });

  it('skips malformed lines without crashing', () => {
    fs.writeFileSync(
      file(),
      `not json at all\n${JSON.stringify(rec({ tool: 'good' }))}\n{"half":\n`,
    );
    const reader = createActivityLog(dir);
    const got: McpActivityRecord[] = [];
    stops.push(reader.watch((rs) => got.push(...rs)));
    expect(got.map((r) => r.tool)).toEqual(['good']);
  });

  it('rotates an oversized file at watch() setup, keeping the newest records', () => {
    const fat = rec({ summary: 'x'.repeat(600) });
    const lines = [];
    while (lines.length * 700 < ROTATE_BYTES + 200_000) {
      lines.push(JSON.stringify({ ...fat, tool: `t${lines.length}` }));
    }
    fs.writeFileSync(file(), `${lines.join('\n')}\n`);
    expect(fs.statSync(file()).size).toBeGreaterThan(ROTATE_BYTES);
    const reader = createActivityLog(dir);
    const got: McpActivityRecord[] = [];
    stops.push(reader.watch((rs) => got.push(...rs)));
    expect(fs.statSync(file()).size).toBeLessThan(ROTATE_BYTES);
    expect(got).toHaveLength(MCP_ACTIVITY_RECENT_MAX);
    expect(got[got.length - 1].tool).toBe(`t${lines.length - 1}`);
  });

  it('reset() truncates the file and clears recent()', async () => {
    const log = createActivityLog(dir);
    log.append(rec());
    await until(() => {
      try {
        return fs.statSync(file()).size > 0;
      } catch {
        return false;
      }
    });
    const got: McpActivityRecord[] = [];
    stops.push(log.watch((rs) => got.push(...rs)));
    expect(log.recent()).toHaveLength(1);
    log.reset();
    expect(log.recent()).toHaveLength(0);
    expect(fs.statSync(file()).size).toBe(0);
  });

  it('appends land even when the watcher starts before the file exists', async () => {
    const reader = createActivityLog(dir);
    const got: McpActivityRecord[] = [];
    stops.push(reader.watch((rs) => got.push(...rs)));
    createActivityLog(dir).append(rec({ tool: 'late' }));
    await until(() => got.length === 1);
    expect(got[0].tool).toBe('late');
  });
});

describe('summarizeCall', () => {
  it('search with a query: quotes it, counts hits, details titles', () => {
    const out = summarizeCall('search', { query: 'invoices' }, [
      { title: 'Invoice March' },
      { title: '' },
    ]);
    expect(out.summary).toBe('search "invoices" → 2 hits');
    expect(out.detail).toEqual(['Invoice March', '(untitled)']);
  });

  it('search without query text shows the filters', () => {
    const out = summarizeCall(
      'search',
      { source: 'gmail', type: 'email.thread', from_date: 'x' },
      [],
    );
    expect(out.summary).toBe('search (source=gmail, type=email.thread) → 0 hits');
  });

  it('search with query AND filters shows both', () => {
    const out = summarizeCall('search', { query: 'q', source: 'gmail' }, []);
    expect(out.summary).toBe('search "q" (source=gmail) → 0 hits');
  });

  it('batch search sums hits across sub-results', () => {
    const out = summarizeCall(
      'search',
      { queries: [{ query: 'a' }, { query: 'b' }] },
      [[{ title: 'A' }], [{ title: 'B' }, { title: 'C' }]],
    );
    expect(out.summary).toBe('search ×2 queries → 3 hits');
    expect(out.detail).toEqual(['A', 'B', 'C']);
  });

  it('get single document', () => {
    const out = summarizeCall('get', { id: 'x' }, { title: 'Security alert' });
    expect(out.summary).toBe('fetched 1 document(s)');
    expect(out.detail).toEqual(['Security alert']);
  });

  it('get batch with misses reports not-found count', () => {
    const out = summarizeCall('get', { ids: ['a', 'b'] }, [{ title: 'A' }, null]);
    expect(out.summary).toBe('fetched 1 document(s), 1 not found');
    expect(out.detail).toEqual(['A']);
  });

  it('get single null is a miss', () => {
    const out = summarizeCall('get', { id: 'x' }, null);
    expect(out.summary).toBe('fetched 0 document(s), 1 not found');
    expect(out.detail).toBeUndefined();
  });

  it('get_related names the relation', () => {
    const out = summarizeCall(
      'get_related',
      { document_id: 'd', relation: 'attachments' },
      [{ title: 'invoice.pdf' }],
    );
    expect(out.summary).toBe('related "attachments" → 1 documents');
    expect(out.detail).toEqual(['invoice.pdf']);
  });

  it('count without grouping', () => {
    const out = summarizeCall('count', {}, [{ key: 'all', count: 1234 }]);
    expect(out.summary).toBe('counted: all=1234');
    expect(out.detail).toBeUndefined();
  });

  it('count grouped by source', () => {
    const out = summarizeCall('count', { group_by: 'source' }, [
      { key: 'gmail', count: 980 },
      { key: 'whatsapp', count: 254 },
    ]);
    expect(out.summary).toBe('counted by source: gmail=980, whatsapp=254');
  });

  it('digital_memory_info is a fixed line', () => {
    expect(summarizeCall('digital_memory_info', {}, {}).summary).toBe(
      'read corpus overview',
    );
  });

  it('unknown tools fall back to name + compact truncated args', () => {
    const out = summarizeCall('notion_query', { q: 'y'.repeat(300) }, {});
    expect(out.summary.startsWith('notion_query {"q":"yyy')).toBe(true);
    expect(out.summary.length).toBeLessThanOrEqual('notion_query '.length + 121);
    expect(out.detail).toBeUndefined();
  });

  it('caps detail at 20 titles with an overflow line', () => {
    const hits = Array.from({ length: 25 }, (_, i) => ({ title: `T${i}` }));
    const out = summarizeCall('search', { query: 'q' }, hits);
    expect(out.detail).toHaveLength(21);
    expect(out.detail![20]).toBe('…and 5 more');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx jest src/main/core/mcp/__tests__/activity.test.ts`
Expected: FAIL — `Cannot find module '../activity'` (and, until Step 1 is saved, missing `MCP_ACTIVITY_RECENT_MAX` export).

- [ ] **Step 4: Implement the module**

Create `src/main/core/mcp/activity.ts`:

```ts
/**
 * The MCP activity feed — the enriched, user-facing sibling of the raw
 * LogSink 'mcp.call' audit (core/logs.ts). One concept, one owner: an
 * append-only JSONL file next to kiagent.db that BOTH processes write
 * (main for HTTP sessions, ../../mcp/stdio-entry.ts for client-spawned
 * stdio siblings) and only main reads. The file is the entire
 * cross-process channel: the stdio process may run while the app is
 * closed, so events must survive on disk — watch()'s boot replay is also
 * what latches the onboarding first-query step for those offline queries
 * (see main.ts's watch consumer).
 *
 * Writes are path-based per append (never a held fd) so reset()/rotation
 * never strand a writer on an unlinked inode. Appends are one small line,
 * so concurrent O_APPEND writers don't interleave mid-line. Rotation has a
 * benign race (an append landing between read and rename can be lost) —
 * the feed is an operational trail, not a ledger.
 */
import fs from 'fs';
import path from 'path';

import {
  MCP_ACTIVITY_RECENT_MAX,
  type McpActivityRecord,
} from '@shared/contracts';

export const ROTATE_BYTES = 1_000_000;

const FILE_NAME = 'mcp-activity.jsonl';

export interface ActivityLog {
  /** Append one record — used by main AND the stdio process. Fire-and-forget:
   *  an unwritable feed must never break serving a call. */
  append(rec: McpActivityRecord): void;
  /** Main only. Rotate if oversized, replay the last MCP_ACTIVITY_RECENT_MAX
   *  records on disk as the first batch (synchronously, before returning),
   *  then tail new complete lines until the returned disposer is called. */
  watch(onRecords: (recs: McpActivityRecord[]) => void): () => void;
  /** Main only: the last MCP_ACTIVITY_RECENT_MAX records seen (replay +
   *  live), oldest first. */
  recent(): McpActivityRecord[];
  /** Main only: truncate the file and clear recent() (factory reset). */
  reset(): void;
}

function parseLines(text: string): McpActivityRecord[] {
  const out: McpActivityRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as McpActivityRecord;
      if (rec && typeof rec.ts === 'string' && typeof rec.tool === 'string') {
        out.push(rec);
      }
    } catch {
      /* malformed line (partial write, manual edit) — skip, never crash */
    }
  }
  return out;
}

function rotateIfOversized(file: string): void {
  try {
    if (!fs.existsSync(file) || fs.statSync(file).size <= ROTATE_BYTES) return;
    const keep = parseLines(fs.readFileSync(file, 'utf8')).slice(
      -MCP_ACTIVITY_RECENT_MAX,
    );
    const tmp = `${file}.rotate`;
    fs.writeFileSync(
      tmp,
      keep.map((r) => JSON.stringify(r)).join('\n') + (keep.length ? '\n' : ''),
    );
    fs.renameSync(tmp, file);
  } catch {
    /* best-effort — the tail below still works on the unrotated file */
  }
}

export function createActivityLog(dataDir: string): ActivityLog {
  const file = path.join(dataDir, FILE_NAME);
  const recent: McpActivityRecord[] = [];

  function remember(recs: McpActivityRecord[]): void {
    recent.push(...recs);
    if (recent.length > MCP_ACTIVITY_RECENT_MAX) {
      recent.splice(0, recent.length - MCP_ACTIVITY_RECENT_MAX);
    }
  }

  return {
    append(rec) {
      try {
        fs.appendFile(file, `${JSON.stringify(rec)}\n`, () => {});
      } catch {
        /* unwritable feed must never break serving a call */
      }
    },

    watch(onRecords) {
      rotateIfOversized(file);

      let offset = 0;
      let partial = '';

      // Replay: whatever is on disk (capped) is the first batch, delivered
      // synchronously so boot consumers (the onboarding latch) see offline
      // stdio queries immediately.
      try {
        const text = fs.readFileSync(file, 'utf8');
        offset = Buffer.byteLength(text, 'utf8');
        const lastNl = text.lastIndexOf('\n');
        partial = lastNl < 0 ? text : text.slice(lastNl + 1);
        const replay = parseLines(
          lastNl < 0 ? '' : text.slice(0, lastNl + 1),
        ).slice(-MCP_ACTIVITY_RECENT_MAX);
        if (replay.length) {
          remember(replay);
          onRecords(replay);
        }
      } catch {
        /* no file yet — nothing to replay */
      }

      const readDelta = (): void => {
        let chunk: string;
        try {
          const { size } = fs.statSync(file);
          if (size < offset) {
            // reset() truncated the file under us — start over.
            offset = 0;
            partial = '';
          }
          if (size === offset) return;
          const fd = fs.openSync(file, 'r');
          try {
            const buf = Buffer.alloc(size - offset);
            fs.readSync(fd, buf, 0, buf.length, offset);
            offset = size;
            chunk = buf.toString('utf8');
          } finally {
            fs.closeSync(fd);
          }
        } catch {
          return; // file may not exist yet
        }
        const joined = partial + chunk;
        const lastNl = joined.lastIndexOf('\n');
        if (lastNl < 0) {
          partial = joined;
          return;
        }
        partial = joined.slice(lastNl + 1);
        const recs = parseLines(joined.slice(0, lastNl + 1));
        if (recs.length) {
          remember(recs);
          onRecords(recs);
        }
      };

      // Watch the DIRECTORY, not the file: the file may not exist yet, and
      // rotation/reset replace it — a file watcher would follow the dead
      // inode. dataDir always exists (kiagent.db lives there).
      const watcher = fs.watch(dataDir, (_event, filename) => {
        if (filename === FILE_NAME) readDelta();
      });
      return () => watcher.close();
    },

    recent() {
      return [...recent];
    },

    reset() {
      recent.length = 0;
      try {
        fs.writeFileSync(file, '');
      } catch {
        /* nothing to truncate */
      }
    },
  };
}

const MAX_TITLES = 20;
const MAX_ARGS_CHARS = 120;

/** Titles are the ONLY document content that leaves a tool result for the
 *  feed — never snippets or bodies. */
function titlesOf(items: unknown[]): string[] {
  const titles = items
    .filter(
      (x): x is Record<string, unknown> => x != null && typeof x === 'object',
    )
    .map((x) =>
      typeof x.title === 'string' && x.title.trim() !== ''
        ? x.title
        : '(untitled)',
    );
  if (titles.length > MAX_TITLES) {
    return [
      ...titles.slice(0, MAX_TITLES),
      `…and ${titles.length - MAX_TITLES} more`,
    ];
  }
  return titles;
}

function compactArgs(args: Record<string, unknown>): string {
  let s: string;
  try {
    s = JSON.stringify(args);
  } catch {
    s = String(args);
  }
  return s.length > MAX_ARGS_CHARS ? `${s.slice(0, MAX_ARGS_CHARS)}…` : s;
}

/**
 * Turn a successful tool call into the feed's human line + title list.
 * Shapes come from core/mcp/tools/*: search → SearchHit[] (or SearchHit[][]
 * for batch `queries`), get → LegacyDocument|null (or an array of those for
 * `ids`), get_related → Document[], count → Array<{key, count}>. Unknown
 * (extension) tools fall back to name + compact args, no detail.
 */
export function summarizeCall(
  tool: string,
  args: Record<string, unknown>,
  result: unknown,
): { summary: string; detail?: string[] } {
  const withDetail = (summary: string, items: unknown[]) => {
    const detail = titlesOf(items);
    return detail.length ? { summary, detail } : { summary };
  };

  switch (tool) {
    case 'search': {
      if (Array.isArray(args.queries)) {
        const hits = (Array.isArray(result) ? result : []).flat();
        return withDetail(
          `search ×${args.queries.length} queries → ${hits.length} hits`,
          hits,
        );
      }
      const hits = Array.isArray(result) ? result : [];
      const q =
        typeof args.query === 'string' && args.query.trim() !== ''
          ? `"${args.query}"`
          : null;
      const filters: string[] = [];
      if (typeof args.source === 'string') filters.push(`source=${args.source}`);
      if (typeof args.type === 'string') filters.push(`type=${args.type}`);
      const filterText = filters.length ? `(${filters.join(', ')})` : null;
      const what = [q, filterText].filter(Boolean).join(' ') || '(all)';
      return withDetail(`search ${what} → ${hits.length} hits`, hits);
    }
    case 'get': {
      const items = Array.isArray(result) ? result : [result];
      const found = items.filter((x) => x != null);
      const missing = items.length - found.length;
      const summary =
        missing > 0
          ? `fetched ${found.length} document(s), ${missing} not found`
          : `fetched ${found.length} document(s)`;
      return withDetail(summary, found);
    }
    case 'get_related': {
      const docs = Array.isArray(result) ? result : [];
      const rel = typeof args.relation === 'string' ? args.relation : '?';
      return withDetail(`related "${rel}" → ${docs.length} documents`, docs);
    }
    case 'count': {
      const rows = Array.isArray(result)
        ? (result as Array<{ key?: unknown; count?: unknown }>)
        : [];
      const by =
        typeof args.group_by === 'string' ? ` by ${args.group_by}` : '';
      const parts = rows.map((r) => `${String(r.key)}=${String(r.count)}`);
      return { summary: `counted${by}: ${parts.join(', ') || '—'}` };
    }
    case 'digital_memory_info':
      return { summary: 'read corpus overview' };
    default:
      return { summary: `${tool} ${compactArgs(args)}` };
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx jest src/main/core/mcp/__tests__/activity.test.ts`
Expected: PASS, all cases. If the two-writer or late-file cases flake, the bug is real (dir-watch filtering or offset bookkeeping) — fix the module, do not loosen the test.

- [ ] **Step 6: Typecheck + commit**

Run: `npm run typecheck` — expect clean. Run the token scan (Global Constraints). Then:

```bash
git add src/shared/contracts.ts src/main/core/mcp/activity.ts src/main/core/mcp/__tests__/activity.test.ts
git commit -m "feat(mcp): activity log module — shared JSONL append/tail + call summarizer"
```

(with the Global Constraints trailer lines appended to the message.)

---

### Task 2: Producers — enriched records from both transports

**Files:**
- Modify: `src/main/core/mcp/registry.ts` (the `attachToolHandlers` signature + `tools/call` handler, lines 46–108)
- Rewrite: `src/main/core/mcp/__tests__/registry.test.ts`
- Modify: `src/main/core/mcp/server.ts` (`McpDeps` lines 37–43, `makeSession` line 147)
- Modify: `src/main/mcp/stdio-entry.ts` (imports, header comment, `main()` wiring around line 100)
- Modify: `src/main/main.ts` (ONLY the `startMcp` call-site, ~line 422 — the removed `onToolCall` property must go so typecheck stays green; Task 3 adds its replacement)

**Interfaces:**
- Consumes (Task 1): `McpActivityRecord` from `@shared/contracts`; `summarizeCall`, `createActivityLog` from `../activity` (registry/server) and `../core/mcp/activity` (stdio-entry).
- Produces (Task 3 relies on): `attachToolHandlers(mcp, registry, logSink, onActivity?: (rec: Omit<McpActivityRecord, 'transport'>) => void)`; `McpDeps.onActivity?: (rec: McpActivityRecord) => void` (replacing the removed `McpDeps.onToolCall`). `startMcp` stamps `transport: 'http'`; stdio-entry stamps `transport: 'stdio'` and appends directly.

- [ ] **Step 1: Rewrite the registry tests (failing)**

Replace the whole of `src/main/core/mcp/__tests__/registry.test.ts` with:

```ts
/**
 * Unit-level (no real transport): attachToolHandlers only touches
 * `mcp.server.setRequestHandler` + `mcp.server.getClientVersion`, so a
 * minimal stub capturing the two registered handlers is enough to drive
 * tools/list + tools/call directly.
 */
import type { McpActivityRecord, McpTool } from '@shared/contracts';

import { attachToolHandlers, createToolRegistry } from '../registry';

type ActivityRec = Omit<McpActivityRecord, 'transport'>;

function capture(clientName: string | null = 'claude-desktop') {
  const handlers: Array<(req: unknown) => Promise<unknown>> = [];
  const mcp = {
    server: {
      setRequestHandler: (
        _schema: unknown,
        fn: (req: unknown) => Promise<unknown>,
      ) => handlers.push(fn),
      getClientVersion: () =>
        clientName == null ? undefined : { name: clientName, version: '1.0' },
    },
  } as never;
  return { mcp, handlers }; // handlers[0] = tools/list, handlers[1] = tools/call
}
const logSink = { log: jest.fn() };

const okTool: McpTool = {
  name: 'search',
  description: '',
  inputSchema: {},
  call: async () => [{ title: 'Doc A' }],
};
const boomTool: McpTool = {
  name: 'boom',
  description: '',
  inputSchema: {},
  call: async () => {
    throw new Error('x');
  },
};

it('emits one enriched activity record per successful call', async () => {
  const registry = createToolRegistry([okTool]);
  const { mcp, handlers } = capture();
  const got: ActivityRec[] = [];
  attachToolHandlers(mcp, registry, logSink as never, (r) => got.push(r));
  await handlers[1]({ params: { name: 'search', arguments: { query: 'q' } } });
  expect(got).toHaveLength(1);
  const rec = got[0];
  expect(rec.ok).toBe(true);
  expect(rec.tool).toBe('search');
  expect(rec.client).toBe('claude-desktop');
  expect(rec.summary).toBe('search "q" → 1 hits');
  expect(rec.detail).toEqual(['Doc A']);
  expect(typeof rec.ms).toBe('number');
  expect('transport' in rec).toBe(false); // stamped by the caller, not here
});

it('emits ok:false with the error for throwing tools', async () => {
  const registry = createToolRegistry([boomTool]);
  const { mcp, handlers } = capture();
  const got: ActivityRec[] = [];
  attachToolHandlers(mcp, registry, logSink as never, (r) => got.push(r));
  await handlers[1]({ params: { name: 'boom', arguments: {} } });
  expect(got).toHaveLength(1);
  expect(got[0].ok).toBe(false);
  expect(got[0].error).toBe('x');
  expect(got[0].summary).toBe('boom failed');
});

it('emits ok:false for unknown tools', async () => {
  const registry = createToolRegistry([]);
  const { mcp, handlers } = capture();
  const got: ActivityRec[] = [];
  attachToolHandlers(mcp, registry, logSink as never, (r) => got.push(r));
  await handlers[1]({ params: { name: 'nope', arguments: {} } });
  expect(got).toHaveLength(1);
  expect(got[0].ok).toBe(false);
  expect(got[0].error).toBe('unknown tool');
});

it('client is null when the session has no clientInfo yet', async () => {
  const registry = createToolRegistry([okTool]);
  const { mcp, handlers } = capture(null);
  const got: ActivityRec[] = [];
  attachToolHandlers(mcp, registry, logSink as never, (r) => got.push(r));
  await handlers[1]({ params: { name: 'search', arguments: {} } });
  expect(got[0].client).toBeNull();
});

it('works without onActivity (callers may pass nothing)', async () => {
  const registry = createToolRegistry([okTool]);
  const { mcp, handlers } = capture();
  attachToolHandlers(mcp, registry, logSink as never);
  await expect(
    handlers[1]({ params: { name: 'search', arguments: {} } }),
  ).resolves.not.toThrow();
});

it('a throwing onActivity never breaks the call it records', async () => {
  const registry = createToolRegistry([okTool]);
  const { mcp, handlers } = capture();
  attachToolHandlers(mcp, registry, logSink as never, () => {
    throw new Error('sink exploded');
  });
  const res = (await handlers[1]({
    params: { name: 'search', arguments: {} },
  })) as { isError?: boolean };
  expect(res.isError).toBeUndefined();
});

it('still audits every call to the LogSink (the raw audit is unchanged)', async () => {
  logSink.log.mockClear();
  const registry = createToolRegistry([okTool]);
  const { mcp, handlers } = capture();
  attachToolHandlers(mcp, registry, logSink as never, () => {});
  await handlers[1]({ params: { name: 'search', arguments: {} } });
  expect(logSink.log).toHaveBeenCalledWith(
    'mcp.call',
    'info',
    'search',
    expect.objectContaining({ ok: true }),
  );
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/main/core/mcp/__tests__/registry.test.ts`
Expected: FAIL — the enrichment assertions fail (current signature is `onCallOk?: () => void`, no records are built).

- [ ] **Step 3: Implement the registry producer**

In `src/main/core/mcp/registry.ts`:

Add to the imports:

```ts
import type { McpActivityRecord, McpTool } from '@shared/contracts';

import type { LogSink } from '../engine/engine';
import { summarizeCall } from './activity';
```

(replacing the existing `import type { McpTool } from '@shared/contracts';`)

Replace the `attachToolHandlers` doc comment's last paragraph (the one starting `onCallOk fires per successfully served tool call`) with:

```
 * onActivity receives one enriched activity record per served call (win or
 * lose) — everything except `transport`, which the caller stamps ('http' in
 * server.ts, 'stdio' in mcp/stdio-entry.ts). Optional; and best-effort by
 * contract: a throwing callback or summarizer must never fail the call it
 * records.
```

Replace the function signature and the `CallToolRequestSchema` handler:

```ts
export function attachToolHandlers(
  mcp: McpServer,
  registry: ToolRegistry,
  logSink: LogSink,
  onActivity?: (rec: Omit<McpActivityRecord, 'transport'>) => void,
): void {
  mcp.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...registry.values()].map(toolToWire),
  }));

  mcp.server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name } = req.params;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const started = Date.now();
    const tool = registry.get(name);

    const emit = (ok: boolean, result: unknown, error?: string): void => {
      if (!onActivity) return;
      try {
        const { summary, detail } = ok
          ? summarizeCall(name, args, result)
          : { summary: `${name} failed`, detail: undefined };
        onActivity({
          ts: new Date().toISOString(),
          client: mcp.server.getClientVersion()?.name ?? null,
          tool: name,
          ok,
          ms: Date.now() - started,
          summary,
          ...(detail && detail.length ? { detail } : {}),
          ...(error !== undefined ? { error } : {}),
        });
      } catch {
        /* the feed is best-effort — never break the call it records */
      }
    };

    if (!tool) {
      logSink.log('mcp.call', 'info', name, {
        args,
        ok: false,
        ms: Date.now() - started,
        error: 'unknown tool',
      });
      emit(false, undefined, 'unknown tool');
      return {
        isError: true,
        content: [{ type: 'text', text: `unknown tool '${name}'` }],
      };
    }

    try {
      const result = await tool.call(args);
      logSink.log('mcp.call', 'info', name, {
        args,
        ok: true,
        ms: Date.now() - started,
      });
      emit(true, result);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logSink.log('mcp.call', 'info', name, {
        args,
        ok: false,
        ms: Date.now() - started,
        error: message,
      });
      emit(false, undefined, message);
      // isError (not a thrown protocol error) so the calling LLM sees the
      // real message instead of a generic JSON-RPC failure.
      return { isError: true, content: [{ type: 'text', text: message }] };
    }
  });
}
```

(The `onCallOk?.()` line is gone; everything else in the file is unchanged.)

- [ ] **Step 4: Run registry tests to verify they pass**

Run: `npx jest src/main/core/mcp/__tests__/registry.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Rewire server.ts (HTTP transport)**

In `src/main/core/mcp/server.ts`:

Change the contracts import to include the record type:

```ts
import type { McpActivityRecord, McpTool, Query } from '@shared/contracts';
```

Replace `McpDeps` (currently `onToolCall?: () => void;` with its comment):

```ts
export interface McpDeps {
  query: Query;
  logSink: LogSink;
  dataDir: string;
  /** Receives one enriched activity record per tools/call served in-process
   *  (HTTP sessions — transport 'http' is stamped here). The stdio sibling
   *  produces its own records; see mcp/stdio-entry.ts. */
  onActivity?: (rec: McpActivityRecord) => void;
}
```

In `makeSession`, replace the `attachToolHandlers` call:

```ts
    attachToolHandlers(server, registry, deps.logSink, (rec) =>
      deps.onActivity?.({ ...rec, transport: 'http' }),
    );
```

- [ ] **Step 6: Rewire stdio-entry.ts (stdio transport)**

In `src/main/mcp/stdio-entry.ts`:

Add imports (path + the activity module):

```ts
import path from 'path';
```

and, with the relative imports:

```ts
import { createActivityLog } from '../core/mcp/activity';
```

In the header doc comment, extend the final paragraph with one sentence:

```
 * Every served call is also appended (transport 'stdio') to
 * `<dataDir>/mcp-activity.jsonl` via core/mcp/activity.ts — the app's
 * activity feed and onboarding first-query latch read it at next boot.
```

In `main()`, after the `openStore` try/catch and before `const logSink = stderrLogSink();`, add:

```ts
  // The activity feed rides the same directory as the db — main tails it.
  // Append failures are swallowed inside createActivityLog: an unwritable
  // feed must never break serving a call.
  const activity = createActivityLog(path.dirname(dbPath));
```

Replace the `attachToolHandlers(server, registry, logSink);` line with:

```ts
  attachToolHandlers(server, registry, logSink, (rec) =>
    activity.append({ ...rec, transport: 'stdio' }),
  );
```

- [ ] **Step 7: Clean up the main.ts call-site**

`McpDeps.onToolCall` no longer exists, so main.ts's `startMcp` call must stop passing it or typecheck fails. In `src/main/main.ts` (~line 422), replace the whole `mcp = await startMcp({ … });` statement — including the four-line `// HTTP-transport only: …` comment and the `onToolCall` property — with:

```ts
    mcp = await startMcp({
      query: p.store.read,
      logSink: p.logSink,
      dataDir,
      // Task 3 of this plan wires onActivity here; between these two commits
      // the first-query latch is intentionally absent.
    });
```

- [ ] **Step 8: Full verification + commit**

Run: `npm test` — expected: all suites pass (server.test.ts and tools.test.ts never referenced `onToolCall`/`onCallOk`; if anything fails, fix before committing).
Run: `npm run typecheck` — expect clean.
Run the token scan. Then:

```bash
git add src/main/core/mcp/registry.ts src/main/core/mcp/__tests__/registry.test.ts src/main/core/mcp/server.ts src/main/mcp/stdio-entry.ts src/main/main.ts
git commit -m "feat(mcp): both transports emit enriched activity records (client, summary, titles)"
```

(with the trailer lines.)

---

### Task 3: Main wiring — IPC channels, watcher, latch, reset truncation

**Files:**
- Modify: `src/shared/ipc.ts` (Invokes ~line 203, `Pushes` ~line 291, `INVOKE_CHANNELS` ~line 328, `PUSH_CHANNELS` ~line 358)
- Modify: `src/main/main.ts` (imports ~line 24; module vars ~line 44; `logs:export` handler ~line 284; `maintenance:reset-all` ~line 330; boot `dataDir` block ~line 409; `startMcp` call ~line 422; before-quit ~line 660)

**Interfaces:**
- Consumes (Tasks 1–2): `createActivityLog`, `ActivityLog` from `./core/mcp/activity`; `McpDeps.onActivity`; `McpActivityRecord`, `MCP_ACTIVITY_RECENT_MAX` from `@shared/contracts`.
- Produces (Task 4 relies on): invoke channel `'mcp-activity:recent': { req: void; res: McpActivityRecord[] }`; push channel `'push:mcp-activity': McpActivityRecord[]` (batches, oldest-first within a batch, appended to what the renderer already has).

- [ ] **Step 1: Declare the IPC channels**

In `src/shared/ipc.ts` (which already imports types from `./contracts` — add `McpActivityRecord` to that import list):

After the `'logs:export'` entry in the `Invokes` interface, add:

```ts
  'mcp-activity:recent': { req: void; res: McpActivityRecord[] };
```

In the `Pushes` interface, after `'push:logs': LogRecord[];`:

```ts
  'push:mcp-activity': McpActivityRecord[];
```

In `INVOKE_CHANNELS`, after `'logs:export',`:

```ts
  'mcp-activity:recent',
```

In `PUSH_CHANNELS`, after `'push:logs',`:

```ts
  'push:mcp-activity',
```

Verify preload needs no change (it derives from these lists): `grep -n "PUSH_CHANNELS\|INVOKE_CHANNELS" src/main/preload.ts` — expect both constants referenced.

- [ ] **Step 2: Wire main.ts**

All edits in `src/main/main.ts`:

**(a) Import** — alongside the existing `import { markOnboardingOnce } from './core/prefs';`:

```ts
import { createActivityLog, type ActivityLog } from './core/mcp/activity';
```

**(b) Module vars** — after `let bundledProviders: { localLlm: LocalLlmProvider } | null = null;` (line ~46):

```ts
let activity: ActivityLog | null = null;
let stopActivityWatch: (() => void) | null = null;
```

**(c) Recent handler** — after `handle('logs:export', () => p.logs.export());`:

```ts
  handle('mcp-activity:recent', async () => activity?.recent() ?? []);
```

**(d) Reset** — in the `maintenance:reset-all` handler, after the `await p.prefs.patch({ onboarding: { … } });` block and before `patchState(…)`:

```ts
    // The feed names titles of documents the reset just deleted — truncate
    // it with them. No push needed: the panel re-pulls mcp-activity:recent
    // on next mount (reset lives on Settings; Connection isn't mounted).
    activity?.reset();
```

**(e) Create the log** — in the boot sequence, after `fs.mkdirSync(dataDir, { recursive: true });`:

```ts
    const act = createActivityLog(dataDir);
    activity = act;
```

**(f) startMcp** — replace the whole `mcp = await startMcp({ … });` statement (Task 2 left it with a `// Task 3 of this plan wires onActivity here…` placeholder comment — that comment goes away now):

```ts
    mcp = await startMcp({
      query: p.store.read,
      logSink: p.logSink,
      dataDir,
      onActivity: (rec) => act.append(rec),
    });
```

**(g) The one consumer** — after the `void mcp.clients().then(…)` onboarding-step-2 reconciliation block:

```ts
    // ONE consumer of the activity file, two effects: the live feed push
    // and the onboarding first-query latch. Both transports land here (the
    // stdio sibling appends to the same file), and the boot replay batch
    // covers queries served while the app was closed — which is exactly how
    // stdio clients latch step 3 despite living in another process.
    stopActivityWatch = act.watch((recs) => {
      broadcast('push:mcp-activity', recs);
      if (recs.some((r) => r.ok)) {
        markOnboardingOnce(p.prefs, 'firstQueryAt').catch(() => {});
      }
    });
```

**(h) Dispose** — in the `before-quit` async teardown, before `await bundledProviders?.localLlm.dispose()…`:

```ts
    stopActivityWatch?.();
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck` — expect clean (the `onToolCall` property no longer exists anywhere; `grep -rn "onToolCall" src` must return nothing).
Run: `npm test` — expect all suites green.

- [ ] **Step 4: Manual smoke (dev app)**

With `npm start` running: make any query from Claude Desktop (stdio). Then `tail -2 "$HOME/Library/Application Support/KIAgent-dev/data/mcp-activity.jsonl"` — expect JSON lines with `"transport":"stdio","client":"claude-desktop"` (exact client string may differ; it must be non-null) and a `summary`. If the app was open during the query, the wizard's step 3 latches live; otherwise it latches on next launch.

- [ ] **Step 5: Commit**

Token scan, then:

```bash
git add src/shared/ipc.ts src/main/main.ts
git commit -m "feat(mcp): activity watcher in main — push channel + stdio-aware first-query latch"
```

(with the trailer lines.)

---

### Task 4: Connection screen — ActivityPanel right column

**Files:**
- Create: `src/renderer/screens/Connection/ActivityPanel.tsx`
- Modify: `src/renderer/screens/Connection/index.tsx`
- Modify: `src/renderer/screens/Connection/Connection.css` (append a section)

**Interfaces:**
- Consumes (Task 3): `window.kiagent.invoke('mcp-activity:recent', undefined)` → `McpActivityRecord[]` (oldest first); `window.kiagent.on('push:mcp-activity', batch => …)` (append batches). `MCP_ACTIVITY_RECENT_MAX`, `McpActivityRecord` from `@shared/contracts`.
- Produces: `ActivityPanel(): React.ReactElement` (no props).

- [ ] **Step 1: Create the panel**

Create `src/renderer/screens/Connection/ActivityPanel.tsx`:

```tsx
import React, { useEffect, useState } from 'react';
import type { McpActivityRecord } from '@shared/contracts';
import { MCP_ACTIVITY_RECENT_MAX } from '@shared/contracts';

/**
 * The data-access trail: one row per MCP tool call, newest first, fed by
 * mcp-activity:recent (seed) + push:mcp-activity (live batches) — the same
 * recent+push idiom as Logs.tsx. Rows with detail (document titles) or an
 * error expand on click. Titles are all the panel ever shows of a document.
 */
export function ActivityPanel(): React.ReactElement {
  const [recs, setRecs] = useState<McpActivityRecord[]>([]);
  const [expanded, setExpanded] = useState<McpActivityRecord | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.kiagent
      .invoke('mcp-activity:recent', undefined)
      .then((recent) => {
        if (!cancelled) setRecs(recent.slice(-MCP_ACTIVITY_RECENT_MAX));
      })
      .catch(() => {
        /* seed failure must not block the live push below */
      });
    const off = window.kiagent.on('push:mcp-activity', (batch) => {
      setRecs((prev) => {
        const combined = prev.concat(batch);
        return combined.length > MCP_ACTIVITY_RECENT_MAX
          ? combined.slice(combined.length - MCP_ACTIVITY_RECENT_MAX)
          : combined;
      });
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  const visible = recs.slice().reverse(); // newest first

  return (
    <aside className="conn-activity" aria-label="MCP activity">
      <div className="act-head">
        <h2 className="h-section">Activity</h2>
        <p className="t-meta">
          Every MCP request from connected clients, newest first.
        </p>
      </div>
      <div className="act-list">
        {visible.length === 0 ? (
          <div className="act-empty t-meta">
            No MCP activity yet — connect a client and run a query.
          </div>
        ) : (
          visible.map((rec, i) => (
            <ActivityRow
              key={`${rec.ts}-${i}`}
              rec={rec}
              expanded={expanded === rec}
              onToggle={() => setExpanded(expanded === rec ? null : rec)}
            />
          ))
        )}
      </div>
    </aside>
  );
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return sameDay
    ? hm
    : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
}

// Memoized like Logs.tsx's LogRow: records are immutable, so untouched rows
// skip re-rendering when a batch lands.
const ActivityRow = React.memo(function ActivityRow(props: {
  rec: McpActivityRecord;
  expanded: boolean;
  onToggle: () => void;
}): React.ReactElement {
  const { rec, expanded, onToggle } = props;
  const expandable = Boolean(rec.detail?.length || rec.error);
  return (
    <button
      type="button"
      className={rec.ok ? 'act-row' : 'act-row err'}
      onClick={expandable ? onToggle : undefined}
      aria-expanded={expandable ? expanded : undefined}
    >
      <div className="act-line">
        <span className="act-when mono">{fmtWhen(rec.ts)}</span>
        <span className="act-client">{rec.client ?? rec.transport}</span>
      </div>
      <div className="act-summary">{rec.summary}</div>
      {expanded && (
        <div className="act-detail">
          {rec.error ? <div className="act-error">{rec.error}</div> : null}
          {rec.detail?.map((t, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <div key={i} className="act-title">
              {t}
            </div>
          ))}
        </div>
      )}
    </button>
  );
});
```

- [ ] **Step 2: Two-column layout in index.tsx**

In `src/renderer/screens/Connection/index.tsx`, add the import:

```tsx
import { ActivityPanel } from './ActivityPanel';
```

and replace the returned JSX (keeping everything currently inside `.conn-body` as the left column):

```tsx
  return (
    <div className="dash-shell">
      <div className="conn-body conn-columns">
        <div className="conn-main">
          <ConnectionHub port={port} />

          <div className="div-h" />

          <div className="conn-group">
            <LocalClients port={port} />
            <ManualSetup
              summary={
                port != null
                  ? `local URL http://127.0.0.1:${port}/mcp & config snippets`
                  : 'local URL & config snippets'
              }
            >
              {port != null ? (
                <pre className="code-block wrap">
                  {buildLocalHttpSnippet(port)}
                </pre>
              ) : (
                <p className="t-meta">
                  Waiting for the local MCP server to report a port before a
                  snippet can be built.
                </p>
              )}
              <div className="lbl-section">stdio (Claude Desktop / Codex)</div>
              <p className="t-meta">
                Claude Desktop and Codex connect over stdio, which needs an
                absolute path to this app&apos;s executable that the renderer
                doesn&apos;t have access to — use each app&apos;s Connect
                button above (it writes the stdio entry for you), or see the
                docs for the raw command/args/env snippet.
              </p>
            </ManualSetup>
          </div>
        </div>

        <ActivityPanel />
      </div>
    </div>
  );
```

Also extend the file's header doc comment list of "deliberate differences" with one bullet:

```
 *  - A third element legacy never had: the ActivityPanel right column — the
 *    MCP data-access trail (see specs/2026-07-06-mcp-activity-feed-design.md).
```

- [ ] **Step 3: Styles**

Append to `src/renderer/screens/Connection/Connection.css`:

```css
/* ── Activity feed (right column) ────────────────────────────────────── */
/* .conn-body keeps being the screen frame; in columns mode the two children
   own their scroll independently so a long feed never scrolls the hub. */
.conn-body.conn-columns {
  flex-direction: row;
  gap: 0;
  padding: 0;
  overflow: hidden;
}
.conn-main {
  flex: 1 1 auto;
  min-width: 0;
  overflow-y: auto;
  padding: 16px 20px 22px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.conn-main > * {
  flex-shrink: 0;
}
.conn-activity {
  flex: 0 0 360px;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--border-subtle);
  background: var(--bg-muted);
}
.act-head {
  padding: 16px 16px 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.act-head .h-section {
  margin: 0;
}
.act-head .t-meta {
  margin: 0;
}
.act-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}
.act-empty {
  padding: 16px;
}
.act-row {
  display: block;
  width: 100%;
  text-align: left;
  background: none;
  border: 0;
  border-bottom: 1px solid var(--border-subtle);
  padding: 8px 16px;
  cursor: pointer;
  font: inherit;
  color: var(--text-primary);
}
.act-row:hover {
  background: var(--bg-canvas);
}
.act-row.err .act-summary {
  color: var(--error-solid);
}
.act-line {
  display: flex;
  gap: 8px;
  align-items: baseline;
}
.act-when {
  font-size: 11px;
  color: var(--text-secondary);
}
.act-client {
  font-size: 11px;
  color: var(--text-secondary);
  border: 1px solid var(--border-subtle);
  padding: 0 6px;
}
.act-summary {
  margin-top: 2px;
  font-size: 12px;
  overflow-wrap: anywhere;
}
.act-detail {
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.act-title {
  font-size: 11px;
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}
.act-error {
  font-size: 11px;
  color: var(--error-solid);
  overflow-wrap: anywhere;
}
@media (max-width: 900px) {
  .conn-body.conn-columns {
    flex-direction: column;
    overflow-y: auto;
  }
  .conn-main {
    overflow-y: visible;
    flex: none;
  }
  .conn-activity {
    flex: none;
    max-height: 320px;
    border-left: 0;
    border-top: 1px solid var(--border-subtle);
  }
}
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck` — expect clean.
Run: `npm test` — expect all suites green.
Run: `npm run lint` — expect zero NEW errors versus the pre-existing baseline (compare against `git stash`-clean run if unsure).
Manual: with `npm start` running, open Connection — panel renders on the right with either the empty state or real rows; run a query from any connected client and watch a row appear live; click a search row to expand titles.

- [ ] **Step 5: Commit**

Token scan, then:

```bash
git add src/renderer/screens/Connection/ActivityPanel.tsx src/renderer/screens/Connection/index.tsx src/renderer/screens/Connection/Connection.css
git commit -m "feat(connection): activity panel — live MCP data-access trail"
```

(with the trailer lines.)
