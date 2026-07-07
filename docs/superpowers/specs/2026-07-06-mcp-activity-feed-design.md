# MCP Activity Feed — Design

**Date:** 2026-07-06
**Status:** Approved direction (approach A: shared activity file), spec for planning.

## Goal

Show users how their data is accessed over MCP: a live right-side panel on the
Connection screen listing every tool call — when, by which client, what was
asked (search queries), and what came back (document titles, not ids). The
same plumbing carries tool calls from the stdio sibling process back to the
main app, which fixes the known onboarding gap: queries from stdio clients
(Claude Desktop, Codex) currently never latch the "Try a query" step
(`firstQueryAt`), because they are served in a separate process with no prefs
access (see 2026-07-06-get-started-onboarding-design.md, "Accepted
limitation" — this spec removes that limitation).

## Non-goals

- No queryable audit history (date-range queries, per-client reports). The
  feed is a capped recent-events stream. If full history is ever wanted, a
  future importer can fold the JSONL into the corpus DB app-side; nothing
  here has to be undone.
- No consent/permission gating of tool calls — display only.
- No remote-MCP activity (no remote transport exists in this build).
- No per-event delete/redact UI.

## Architecture: the activity file is the channel

The main process and the stdio sibling share no IPC — the stdio process is
spawned by the MCP client (Claude Desktop), possibly while the app is closed.
Their only rendezvous is the filesystem. So the activity stream is an
append-only JSONL file next to the database:

```
<userData>/data/mcp-activity.jsonl     (sibling of kiagent.db, prefs.json)
```

- **Both processes append** one JSON line per tool call. The stdio process
  derives the directory from the `--db` path it already receives — no new
  CLI arguments, existing client configs keep working.
- **Only main reads**: it replays the last `RECENT_MAX` records at boot, then
  tails the file with `fs.watch`. Each new record is (a) pushed to the
  renderer and (b) latched into onboarding on success.
- **Only main rotates**, once, at boot, before the watcher starts.

Writes are path-based per append (`fs.appendFile(path, line)`, mirroring
`logs.ts`) — never a held fd — so truncation by reset and rotation by a
newer boot never strand a writer on an unlinked inode. Appends are small
(one line, well under 4 KB) so concurrent O_APPEND writers do not interleave
mid-line. The rotation instant has a benign race (an append landing between
read and rename can be lost); the feed is an operational trail, not a ledger.

Why not the DB: "only the app writes `kiagent.db`" is a deliberate invariant
(the stdio entry opens the store with dummy vault codecs *because* it can
never write), reset's `VACUUM` needs the database quiet, and SQLite has no
cross-process change signal — main would still need an fs watcher. Why not
an HTTP endpoint on the local MCP server: the port is dynamic, the app may
be closed (events must survive), and persistence needs a file anyway.

## Record shape

New shared type in `src/shared/contracts.ts`:

```ts
/** One MCP tool call as seen by the user-facing activity feed. */
export interface McpActivityRecord {
  ts: string;                     // ISO timestamp
  transport: 'http' | 'stdio';
  client: string | null;          // MCP initialize clientInfo.name, e.g. "claude-desktop"
  tool: string;                   // 'search' | 'get' | ... | extension tool name
  ok: boolean;
  ms: number;
  summary: string;                // one human line, see summarizeCall
  detail?: string[];              // document titles touched (absent when none)
  error?: string;                 // present when ok === false
}
```

`client` comes from `mcp.server.getClientVersion()?.name ?? null` — the SDK
exposes the initialize handshake's `clientInfo` on the low-level `Server`
(`@modelcontextprotocol/sdk` `server/index.d.ts`, `getClientVersion()`).
Both transports have it: each HTTP session and each stdio process serves
exactly one initialized client.

## New module: `src/main/core/mcp/activity.ts`

Sibling of `core/logs.ts`; owns the whole activity concept.

```ts
// RECENT_MAX = 200 lives in src/shared/contracts.ts next to McpActivityRecord
// (the renderer caps its list to the same value and cannot import main code).
export const ROTATE_BYTES = 1_000_000;  // rotate when file exceeds ~1 MB

export interface ActivityLog {
  /** Append one record (used by main AND the stdio process). Fire-and-forget. */
  append(rec: McpActivityRecord): void;
  /** Main only. Rotate if oversized, replay last RECENT_MAX as the first
   *  batch, then tail new complete lines until disposed. */
  watch(onRecords: (recs: McpActivityRecord[]) => void): () => void;
  /** Main only: last RECENT_MAX records seen (replay + live), newest LAST. */
  recent(): McpActivityRecord[];
  /** Main only: truncate the file and clear recent() (factory reset). */
  reset(): void;
}

export function createActivityLog(dataDir: string): ActivityLog;
```

Implementation constraints:

- `append` serializes to one line; malformed lines found while reading are
  skipped, never crash the reader.
- `watch` remembers its byte offset, reads only the delta on each `fs.watch`
  event, and buffers a trailing partial line until its newline arrives.
- Rotation: read file, keep last `RECENT_MAX` parseable records, write to a
  temp file, rename over. Runs only inside `watch()` setup, only when the
  file exceeds `ROTATE_BYTES`.
- No timers, no polling loop — `fs.watch` only.

### `summarizeCall` — the enrichment

Pure function in the same file, called by the producer at record-build time:

```ts
export function summarizeCall(
  tool: string,
  args: Record<string, unknown>,
  result: unknown,
): { summary: string; detail?: string[] };
```

Per builtin tool (shapes from `core/mcp/tools/*`):

| tool | summary | detail |
|---|---|---|
| `search` (single) | `search "<query>" → N hits` (no query text → `search (filters) → N hits`; include `source`/`type` filter values when present) | hit titles (`SearchHit.title`), untitled → `(untitled)` |
| `search` (batch `queries`) | `search ×K queries → N hits` (N = total across sub-results) | titles across all sub-results |
| `get` | `fetched N document(s)` (nulls excluded from N; `M not found` appended when nulls present) | `LegacyDocument.title` of non-null docs |
| `get_related` | `related "<relation>" → N documents` | `Document.title` of results |
| `count` | `counted: all=1234` / `counted by source: gmail=980, whatsapp=254` | none |
| `digital_memory_info` | `read corpus overview` | none |
| unknown / extension tools | `<tool> <compact JSON args, truncated to 120 chars>` | none |
| failed call (any tool) | `<tool> failed` | none (error text rides `error`) |

`detail` is capped at 20 titles; more → append `…and N more`. Titles are the
only document content that leaves the tool result for the feed — never
snippets or bodies.

## Producers

`attachToolHandlers` (core/mcp/registry.ts) replaces its `onCallOk?: () =>
void` parameter with:

```ts
onActivity?: (rec: Omit<McpActivityRecord, 'transport'>) => void;
```

Inside the existing `tools/call` handler (success, failure, and
unknown-tool paths alike) it builds the record — `ts`, `client` via
`mcp.server.getClientVersion()`, `tool`, `ok`, `ms`, `summary`/`detail` via
`summarizeCall`, `error` — and invokes the callback. The existing
`logSink.log('mcp.call', …)` audit is unchanged; LogSink stays the raw audit
contract, activity is the enriched user-facing stream.

Callers stamp the transport and write:

- **server.ts (HTTP):** `McpDeps` drops `onToolCall` and gains
  `onActivity?: (rec: McpActivityRecord) => void`; `makeSession` passes
  `(rec) => deps.onActivity?.({ ...rec, transport: 'http' })`.
- **stdio-entry.ts:** builds `createActivityLog(path.dirname(dbPath))` and
  passes `(rec) => activity.append({ ...rec, transport: 'stdio' })`.
  `append` failures are swallowed (never break serving a call).

## The one consumer: main.ts

- Create `const activity = createActivityLog(dataDir)` alongside logs/prefs.
- Pass `onActivity: (rec) => activity.append(rec)` into `startMcp` (replacing
  the deleted `onToolCall` latch site).
- `activity.watch((recs) => { … })`:
  - broadcast `push:mcp-activity` with the batch;
  - if any record has `ok === true`, call
    `markOnboardingOnce(p.prefs, 'firstQueryAt').catch(() => {})`.
    The replay batch participates — a query served by the stdio process
    while the app was closed latches step 3 at next boot. The set-once
    guard in `markOnboardingOnce` makes repeat calls free.
- Dispose the watcher on quit alongside the other disposers.
- **Factory reset** (`maintenance:reset-all` handler): call
  `activity.reset()` in the same block that clears the onboarding latches —
  the feed must not name titles of documents that no longer exist. Ordering:
  reset the store, clear latches, truncate activity, then push fresh state.
  No clear-broadcast is needed: screens mount per navigation and the reset
  button lives on the Settings screen, so the Connection panel can never be
  visible during a reset — it re-pulls `mcp-activity:recent` on next mount.

The deleted plumbing: `McpDeps.onToolCall`, its `startMcp` wiring, and the
`onToolCall` latch site in main.ts (with its stdio-limitation comment). The
onboarding spec's step-3 signal becomes "any successful activity record".

## IPC surface (src/shared/ipc.ts)

```ts
// Invokes
'mcp-activity:recent': { req: void; res: McpActivityRecord[] };
// Pushes
'push:mcp-activity': McpActivityRecord[];
```

Registered in `INVOKE_CHANNELS` / push channel list exactly like
`logs:recent` / `push:logs`. `mcp-activity:recent` returns
`activity.recent()`.

## UI: Connection screen right panel

`Connection/index.tsx` becomes a two-column layout: the existing
`ConnectionHub` + `LocalClients` + `ManualSetup` column on the left, new
`ActivityPanel` on the right (`.conn-columns` grid in Connection.css; on
narrow widths the panel stacks below).

New `src/renderer/screens/Connection/ActivityPanel.tsx`:

- On mount: `invoke('mcp-activity:recent')`; subscribe to
  `push:mcp-activity`; render newest first; cap the in-memory list at
  `RECENT_MAX` (imported from `@shared/contracts`).
- Row: time (`HH:MM`, with date shown for non-today records), client pill
  (raw `client` string; `null` → transport label), summary line. Rows with
  `detail` expand on click to show the title list. `ok === false` rows use
  the existing error styling and show `error` when expanded.
- Header: "Activity" + one-line explainer ("Every MCP request from connected
  clients, newest first.").
- Empty state: "No MCP activity yet — connect a client and run a query."
- Follows the `Logs.tsx` consumption pattern (recent + push); no new state
  library concepts.

## Testing

- **activity.test.ts** (main-process suite): append→watch round-trip; two
  `createActivityLog` instances on one file (two-process simulation) both
  visible to one watcher; replay caps at `RECENT_MAX`; partial-line write
  (append a record in two chunks) neither crashes nor duplicates; malformed
  line skipped; rotation shrinks an oversized file and keeps the newest
  records; `reset()` empties file and `recent()`.
- **summarizeCall tests**: one case per row of the table above, including
  batch search, get with nulls, title cap at 20, unknown tool truncation.
- **registry.test.ts**: `onActivity` fires with `ok:true` + client name
  (fake initialize / stubbed `getClientVersion`), with `ok:false` + `error`
  on a throwing tool, and on unknown tool; absent callback still works.
- **Latch**: watcher-batch-with-ok → `markOnboardingOnce` called; batch of
  only failures → not called (unit-testable by extracting the batch handler
  or via a prefs-backed integration case in main-adjacent tests).
- **Existing tests updated**: registry/server tests that used `onCallOk` /
  `onToolCall` move to the new parameter; onboarding spec's stdio-limitation
  comment/test expectations updated.

## Constraints

- Never log document bodies/snippets into the activity file — titles only.
- The stdio entry must keep working when the activity file or its directory
  is unwritable (swallow append errors; serving calls always wins).
- `mcp-activity.jsonl` lives in `dataDir` and is covered by the same
  dev/prod userData split as the database (KIAgent-dev in dev).
- No new dependencies.
