# Agent Sessions connector (Claude Code + Codex) — design

Date: 2026-09-23 · Status: draft r3 (after fable + astra round 2)

## 1. Goal

Index the user's local coding-agent history into KIA so it is searchable (and
reachable over MCP) next to mail, docs and chats. v1 covers **Claude Code** and
**Codex**:

- sessions (the conversation transcript, condensed), including subagent
  transcripts linked to their parent,
- plans, task lists, memory files,
- the typed-prompt history.

Out of scope for v1: cost/token/quota metrics, near-real-time ingestion (hooks,
OTel, file watching), resume/launch actions, other agents (Cursor, OpenCode, …),
Claude Cowork's second root (`~/Library/Application Support/Claude/…`),
repo-local `CLAUDE.md`/`AGENTS.md` files (outside the granted roots), and
granting a folder that appears only after the extension was activated without a
restart (§3.3).

Success = after installing the extension from the Marketplace (one consent
screen that names the folders it reads) and adding the two sources, every
session/subagent/plan/tasklist/memory/prompt-day appears as a row in the
ordinary `documents` table, searchable by the existing FTS/MCP tools, and stays
current on the normal cadence.

Non-goal: mirroring deletions. Claude Code deletes transcripts after
`cleanupPeriodDays` (30 by default). KIA deliberately **keeps** what it indexed.
The sources implement no `reconcile`.

## 2. Deliverables

1. **kiagent-core: manifest-declared file roots** (branch
   `feat/local-agent-sessions`, worktree `../kiagent-core-agent-sessions`),
   `PLATFORM_API_VERSION` 2.2.0 → **2.3.0** (new optional manifest field).
2. **`@kiagent/connector-sdk` 1.4.0** — regenerated contracts (`Manifest` and
   `ConsentRecord` live in `src/shared/contracts.ts`, which
   `sdk/connector-sdk/scripts/generate.mjs` copies verbatim).
3. **`kia-plugins/agent-sessions-kia-connector`** (new repo, local dir
   `/Users/edjafarov/work/agent-sessions-kia-connector`): one extension
   `kia.agent-sessions` contributing two sources, `claude-code` and `codex`.

alpha-cent receives only a `core.lock` bump after the core release.

## 3. Core: manifest-declared file roots

### 3.0 Threat model (explicit)

Extension child processes are **not OS-sandboxed**: marketplace connectors
already `import 'node:fs'` directly (whatsapp, telegram). `ScopedFiles` is
therefore a least-privilege *API* and a *consent* mechanism, not a security
boundary against a malicious extension. The design goal is: (a) the consent
screen truthfully lists what an honest extension will read, (b) a grant never
exceeds what the user consented to, and (c) an installed package cannot widen
its grants without a new consent. Pre-existing path-race properties of
`scoped-files.ts` (ancestor checks before open-by-path) are unchanged and out
of scope.

### 3.1 Manifest

New optional top-level key (the schema is strict, so this is a schema change):

```json
"fileRoots": [
  { "id": "claude", "path": "~/.claude", "purpose": "Claude Code sessions, plans, tasks, memory and prompt history" },
  { "id": "codex",  "path": "~/.codex",  "purpose": "Codex sessions, memory and prompt history" }
]
```

Validation in `parseManifest` (`src/main/platform/manifest.ts`):

- `fileRoots` requires `caps` to include `files` (`PLUGIN_FILES_CAP_REQUIRED`).
- `fileRoots` is **external-tier only** in v1: `tier: 'bundled'` with
  `fileRoots` is rejected (`PLUGIN_FILE_ROOTS_TIER_DENIED`). Bundled extensions
  keep `mainApi.grantRoot`. Consequence: an extension's roots are either all
  trusted (bundled) or all declared (external) — no provenance field and no id
  collisions between the two kinds.
- `id` matches `^[a-z][a-z0-9-]{0,31}$`, unique within the manifest. Max 8
  entries.
- `path` (lexical check): starts with `~/`, no NUL, no `.`/`..` segments, not
  `~/` itself.
- `purpose`: non-empty, ≤ 200 chars — shown verbatim on the consent modal.
- Roots are **read-only** (no `access` field).

`Manifest` type, `ExtensionPreview`, `ExtensionSnapshot` and the renderer's
`ConsentRequest` gain `fileRoots: Array<{ id; path; purpose }>` (always an
array; `[]` when absent), carrying the unexpanded `~/…` path for display.

### 3.2 Consent binds the roots

- `ConsentRecord` gains `fileRootsDigest: string` = sha256 of the canonical JSON
  of `[{id, path}]` sorted by id (`purpose` is display copy and excluded).
  Append-only store migration adds a `file_roots_digest TEXT` column to
  `consents`; existing rows read as `null`.
- Both `consents.record(...)` sites (`installCommit` ~`extension-platform.ts:1300`,
  `grantConsent` ~`:1465`) write the digest of the manifest being consented.
- `consentCovers(manifest)` additionally requires
  `rec.fileRootsDigest === digest(manifest.fileRoots)`; a `null` digest matches
  only a manifest with no or empty `fileRoots` (`digest([])` is defined as
  `null`). Canonical form: `JSON.stringify` of `[{id, path}]` sorted by `id`,
  keys in that order, no whitespace. So a same-version, same-caps manifest
  whose roots changed (edited in place, or a republished tag) drops to
  `needs-consent` and gets no grants.

### 3.3 Granting — `reconcileDeclaredRoots`

A platform-owned function in `extension-platform.ts` (never reachable by the
extension). For an external extension `e` whose consent covers its manifest:

1. Home: `home = realpath(os.homedir())`. For each declared root, `abs =
   path.join(home, rel)`; if `abs` does not exist (`ENOENT`) or is not a
   directory → the root is **ungranted** (and any existing grant with that id is
   revoked); logged at `info`. Else `real = realpath(abs)` (a symlinked
   `~/.claude` → `~/dotfiles/claude` is fine — the user consented to the
   logical path).
2. Refuse (root ungranted, logged at `warn`) when `real` is not strictly inside
   `home`, equals `home`, is inside or contains the app's `userData` directory (new
   `ExtensionPlatformDeps.userDataDir`, passed from `main.ts`),
   or, counted in path segments relative to home, is `Library` or
   `Library/<x>` (refused) — `Library/<x>/<y>/…` is allowed. A symlink resolving
   outside home (e.g. to `/Volumes/…`) is therefore refused; the connector's
   error text says the folder "must resolve inside your home folder".
3. If a grant with this id exists, its stored path equals `real`, it is
   `writable === false`, and a fresh `lstat(real)` matches its stored
   `dev`/`ino`, keep it (a restored writable grant — e.g. left by a bundled
   copy that once shadowed this id — is never retained). Otherwise **revoke
   first**, then `fileRoots.grant(e.id, real, { id, name: <~/ path>, writable:
   false })`.
4. Revoke every granted root of `e` whose id is not declared (stale after an
   update).
5. If anything changed — or a previous save is still marked dirty —
   `persistFileRoots()` (new `ExtensionPlatformDeps` member; `main.ts` passes
   the same function it gives `buildMainApi`). A failure is logged and the
   in-memory state kept.

   Fix in `createFileRootsPersistence` (`file-roots.ts`), which today chains
   writes on a promise that never recovers from a rejection (one failure
   poisons every later save, bundled grants included): each write is chained
   on `write.catch(() => {})`, a `dirty` flag is set before and cleared only
   after a successful rename, and a call while dirty re-writes the current
   snapshot even with no new changes.

Single call site, already serialized per extension by the platform lifecycle
(no new locking): **at activation**, after the `consentCovers` check
(~`extension-platform.ts:924`) and before `host.start()`. `installCommit` and
`grantConsent` both activate right after recording consent (when enabled), so
install/update/review are covered; a disabled extension gets its grants at the
next enable. This also heals a root whose directory appeared later or was
recreated — **on the next activation** (app restart or disable/enable). No lazy
granting from inside `roots()` in v1.

Also: `consentCovers === false` at activation → revoke all of `e`'s roots.
**Uninstall** → revoke all of `e`'s roots, then persist.

### 3.4 Consent surface

- `ConsentModal.tsx` renders "Reads these folders on your computer" with each
  root's `path` and `purpose`, plus the sentence "The extension can read
  everything inside these folders." — install, update and review modes. The
  data flows through the preview builder (`installer.preview`), the platform
  snapshot, and both consent-request builders in
  `src/renderer/screens/Marketplace/Detail.tsx` (~l.99).
- `cap-catalog.ts`: replace the stale `files` copy ("Not yet supported…") with
  "Read files in the folders listed below" (elevated).

### 3.5 What the extension sees

`host.files.roots()` returns the granted roots (`{ id: 'claude', name:
'~/.claude', writable: false }`); other calls take `{ root: 'claude', rel:
'projects/…' }`. Existing limits: 16 MiB per `read`, ≤ 1000 entries per `list`
page, `MAX_CURSORS = 256` (connector pages lists sequentially). No new SDK
methods.

### 3.7 Do not project source cursors into `AppState`

Every commit appends an `account` change whose `Account` includes the parsed
cursor (`store.ts` `toAccount`); `app-projection.ts` copies it into `AppState`,
which `main.ts` broadcasts to every window (throttled 100 ms). No renderer code
reads `.cursor`, and the engine reads cursors via `store.account()`, not the
feed. Change: `app-projection.ts` `init`/`apply` drop `cursor` from projected
accounts (type: `Omit<Account, 'cursor'>` in `AppState`). Benefits every
source; required here because this connector's cursor is hundreds of KB.
Test: `app-projection.account-cursor-not-projected`.

### 3.6 Core tests (named; each must be shown red against a mutant)

- `manifest.fileRoots.requires-files-cap`, `.rejects-bundled-tier`,
  `.rejects-lexical-escape` (`~/..`, `/abs`, `~`, `~/`, `~/a/../b`, NUL),
  `.rejects-duplicate-id`, `.accepts-valid`.
- `consent.digest-recorded-on-install|update|review`,
  `consent.same-version-root-change-needs-consent`,
  `consent.legacy-null-digest-covers-only-rootless`.
- `reconcile.grants-declared-after-consent`, `.missing-dir-ungranted-not-error`,
  `.missing-replacement-revokes-old-grant`, `.non-directory-ungranted`,
  `.symlinked-root-granted-at-realpath`, `.refuses-realpath-outside-home`,
  `.refuses-userData-and-home-and-library`, `.regrants-on-identity-change`,
  `.revokes-undeclared`, `.revokes-all-when-consent-lapses`,
  `.revokes-all-on-uninstall`, `.persists-and-restores-across-restart`,
  `.restored-writable-grant-not-retained`.
- `file-roots.persistence.recovers-after-failure` (fail once, then a bundled
  `grantRoot` and a reconcile both persist), `.dirty-snapshot-retried-without-changes`.
- `consent-ui.install|update|review-shows-folders` (through the real
  preview/snapshot builders, not a hand-built modal prop).

## 4. Connector: `kia.agent-sessions`

### 4.1 Manifest and layout

```json
{
  "id": "kia.agent-sessions",
  "name": "Agent Sessions",
  "engine": "^2.3.0",
  "entry": "dist/index.js",
  "caps": ["files"],
  "fileRoots": [ …as §3.1… ],
  "contributes": { "sources": ["claude-code", "codex"], "senders": [] },
  "icon": "icon.png"
}
```

No `net`, no `query`. Repo mirrors the other connectors (esbuild bundle, jest,
SDK tgz devDependency, zero runtime deps):

```
src/index.ts        activate(host) → { sources: [claudeSource(host.files), codexSource(host.files)] }
src/files.ts        listAll(ref) (sequential paging), statOrNull, streamLines(ref) (4 MiB reads)
src/sync.ts         unit model, fingerprint diff, batching, cursor (shared by both sources)
src/transcript.ts   Turn model + markdown renderer with budget
src/redact.ts       secret redaction
src/claude/*.ts     discovery + record → Turn parsing
src/codex/*.ts      discovery + record → Turn parsing
```

### 4.2 Sources

Both: `auth: 'none'`, `cadence: { every: '15m' }`, `documentTypes` per §4.4.
`connect()` calls `files.roots()`; if its root is absent it throws
`"~/.claude was not found or not permitted (it must resolve inside your home folder) — run Claude Code once, restart KIA, then add this source"`
(resp. `~/.codex`/Codex). Otherwise returns `{ identifier: '~/.claude', config: {} }`.

### 4.3 Change detection — per-document units, fingerprints, parent order

A **unit** is one source file (or one small file group) that renders into
exactly **one** document (except `history`, §4.5). Each unit has a stable `key`,
an optional `parentKey`, and a **fingerprint**:

```
fp = hash( RENDER_VERSION, tz, for each file: rel, size, mtimeMs, dev, ino,
           + named render dependencies (§4.5/§4.6) )
```

`RENDER_VERSION` is a connector constant bumped whenever parsing, filtering,
redaction or markdown layout changes, so a fix re-renders history once. `tz`
is the local IANA timezone (times and prompt-day grouping depend on it). A
content change that preserves path, size, mtime and inode is undetectable —
accepted (neither CLI rewrites files that way).

```ts
type Cursor = {
  fps: Record<string, string>;       // unit key → fp of the last committed render
  parents: Record<string, string>;   // Codex subagent key → parent key (Claude parents derive from the path)
  pass: 'initial' | 'done';
};
```

Each `pull(session, cursor)`:

1. **Discover** exhaustively (every relevant directory listed every tick; no
   watermark, no shortcuts): `units: Map<key, {fp, files, parentKey?}>`.
2. **Diff**: `changed = { u | cursor.fps[u.key] !== u.fp }`. Additionally, for
   every changed unit whose key had **no** previous fp (a newly appearing
   parent), add all its known children (by `parentKey`) to `changed` — this is
   how a child committed before its parent existed gets re-emitted once the
   parent row exists.
3. **Order**: topological by `parentKey` (a parent before any of its children),
   ties broken by key. Parents therefore commit in the same or an earlier batch
   than their children; the engine's `reconcileParents` resolves same-batch
   links and an existing parent row resolves earlier ones.
4. **Render + batch**: process in order; yield a batch whenever it reaches 25
   documents or 8 MiB of rendered markdown — never holding more than that —
   with `cursor = { fps: previous fps ∪ fps of units fully emitted so far,
   parents, pass }`, `phase = pass === 'initial' ? 'backfill' : 'live'`. No
   `estimateTotal` (the engine counts expanded documents and seeds from the
   stored count; a per-tick unit total would lie).
5. **Terminal batch**: always yield one final batch (possibly `items: []`)
   with `pass: 'done'`, the complete `fps` (units not discovered this tick are
   dropped from it; their documents are kept — §1) and `parents`.

A unit whose parse throws is logged and committed with its fingerprint (a
corrupt file cannot wedge the source; its next change retries it). Crash
resume re-diffs against the last committed map, so exactly the uncommitted
units are redone. Ties, clock skew and future mtimes are irrelevant: the
comparison is equality, not order.

Cursor size: ~12k units here. `fps` keys are stored as 11-char base64url
hashes of the unit key and values as 11-char fingerprint hashes (~30 B per
entry ≈ 0.35 MB). The cursor is written to `accounts.cursor` once per batch
and is **not** broadcast to windows: core deliverable §3.7 strips `cursor`
from the projected `Account` in `AppState`.

`upsertDocument` dedups by content hash, so re-emitted children and re-rendered
unchanged documents are no-op writes.

### 4.4 Documents

Everything goes through `toDocument` → `upsertDocument` → the shared
`documents` table (key `(accountId, externalId, type)`).

| type | one per | externalId | title |
|---|---|---|---|
| `agent.session` | session **or** subagent transcript | `session:<id>` (Claude subagent: `session:<sessionId>/<agentId>`) | §4.5/§4.6; fallback: first user prompt (≤ 80 chars) → `Session <id8>` |
| `agent.plan` | Claude plan file | `plan:<file name>` | first `# ` heading → file name |
| `agent.tasks` | Claude task list | `tasks:<listId>` | `Tasks — <listId8>` |
| `agent.memory` | memory/instructions file | `memory:<rel path>` | `<project label> — <file name>` |
| `agent.prompts` | calendar day (local tz) of prompt history | `prompts:<YYYY-MM-DD>` | `Prompts — <YYYY-MM-DD>` |

Subagents are ordinary `agent.session` documents with `metadata.role =
'subagent'` and `parent: { externalId: 'session:<parentId>', type:
'agent.session' }` — one type, so a Codex subagent whose parent is itself a
subagent links the same way. `agent.tasks` uses the same `parent` shape when
its list id is a known session id. A parent that was deleted by cleanup
before it was ever indexed stays unresolved (`parentId = null`;
`metadata.parentSessionId` still set).

`createdAt` = first record timestamp (sessions), file mtime (plans, memory),
earliest task file mtime (tasks), first prompt of the day (prompts).

Common `metadata`: `{ agent: 'claude-code' | 'codex', role?: 'main' |
'subagent', cwd?, gitBranch?, sessionId?, parentSessionId?, model?,
cliVersion?, sourcePath }` (`sourcePath` = `~/.claude/…` display path). `url`
unset.

Session markdown:

```
# <title>
Agent: Claude Code 2.1.267 · Project: ~/work/alpha-cent · Branch: dev
Started 2026-09-23 10:02 · Resume: `claude --resume <sessionId>`   (codex: `codex resume <id>`)

## User — 10:02
<prompt text>

## Assistant — 10:03
<assistant text>
→ Bash: git status -sb
→ Edit: src/main/foo.ts
→ Agent: Map core plugin install+files+source APIs
```

Turn model and rendering (both agents):

- **Turns kept**: user-typed text, assistant visible text, one line per tool
  call `→ <tool>: <summary>` (summary = first of `command`, `cmd`,
  `file_path`, `path`, `pattern`, `description`, `url`, `prompt` if the input
  is a JSON object; else the first line of the raw input/arguments string;
  160 chars max).
- **Dropped**: tool results/outputs, thinking/reasoning (incl. encrypted
  content), hook output, attachments, file-history snapshots, token/usage
  records, mode/permission records, system/developer messages, compaction
  summaries, injected context (§4.5/§4.6).
- **Streaming with a record bound**: `streamLines` reads 4 MiB chunks through
  the whole file and yields lines of at most **1 MiB**. A longer line is not
  buffered: the reader discards bytes until the next newline, counts it, and
  the renderer emits `… (1 oversized record skipped)` at that position (these
  are almost always tool outputs — e.g. an 8.9 MB Codex output record seen on
  this machine). `JSON.parse` only ever sees ≤ 1 MiB. Unparsable lines
  (including a partial last line of a file being written) are skipped.
- **Budget**: rendered markdown ≤ **512 KiB** per document: whole turns from
  the head until 256 KiB, a ring buffer of whole turns for the last 256 KiB,
  `… N turns omitted …` between them if anything was dropped. A single turn
  longer than 16 KiB is cut to 16 KiB with `… (truncated)`.
- **Redaction** (§4.7) runs on every source string before any cut.

### 4.5 Discovery — Claude Code (root `claude`)

| unit key | files | parentKey | render deps |
|---|---|---|---|
| `c:<sessionId>` | `projects/<proj>/<sessionId>.jsonl` | — | — |
| `c:<sessionId>/<agentId>` | `projects/<proj>/<sessionId>/subagents/agent-<agentId>.jsonl` + sibling `agent-<agentId>.meta.json` if present | `c:<sessionId>` (from the path) | — |
| `t:<listId>` | `tasks/<listId>/*.json` (`.lock`/`.highwatermark` ignored; a dir with no task JSON yields no unit) | `c:<listId>` if that session unit exists | — |
| `plan:<name>` | `plans/*.md` | — | — |
| `memory:<rel>` | `projects/<proj>/memory/**` text files (`.md`, `.txt`), `CLAUDE.md` if present | — | — |
| `history` | `history.jsonl` | — | — |

Subagent files whose parent `.jsonl` was removed by cleanup (common) are
ordinary units; their parent link resolves only if the parent was indexed
earlier.

Walk per tick: `projects/` (1 list), each `projects/<proj>/` (~170), each
`<sessionId>/` dir and its `subagents/` (~1.2k), `tasks/` + each `tasks/<id>/`
(~170), `plans/`, each `memory/` — ≈ 1.5k sequential list calls here. The plan
includes a benchmark of a full unchanged tick and of the backfill through the
real host API (target: unchanged tick < 10 s), measured before any
optimisation is considered.

Record → Turn (Claude). Record-level exclusions come **first**, regardless of
content representation:

1. Drop the record if `isMeta` or `isCompactSummary`, or `type` is anything
   but `user`/`assistant` (`attachment`, `system`, `queue-operation`, `mode`,
   `permission-mode`, `file-history-snapshot`, `last-prompt`, …; `ai-title`
   feeds the title only).
2. `user`: take the text — the string content, or the concatenated `text`
   parts of array content (`tool_result` parts dropped; a record with only
   `tool_result` parts yields nothing). Then apply the **injected-wrapper
   filter** (below). Text starting with `[Request interrupted` is dropped.
3. `assistant`: `text` parts → assistant turn; `tool_use` parts → tool lines;
   `thinking`, `redacted_thinking`, `server_tool_use`, `*_tool_result` dropped.
4. `isSidechain` is **not** a filter (every subagent record has it).

Injected-wrapper filter (shared module `wrappers.ts`, both agents): a text is
dropped when, trimmed, it consists only of one or more blocks whose tag names
are all in an explicit allowlist (case-insensitive):
Claude — `task-notification`, `system-reminder`, `local-command-caveat`,
`local-command-stdout`, `local-command-stderr`, `bash-stdout`, `bash-stderr`,
`user-prompt-submit-hook`; Codex — `environment_context`,
`user_instructions`, `recommended_plugins`, `subagent_notification`,
`turn_aborted`, `INSTRUCTIONS`, `guardian_tool_descriptions`,
`guardian_context_omission`, `realtime_delegation`,
`external_codex_apps_writing_block_edits`, `skill`. Special cases: a block set of
`command-name`/`command-message`/`command-args` renders as `/name args`;
`bash-input` renders as `! <command>`. A Codex part starting with
`# AGENTS.md instructions` is dropped. Unknown tags are **kept** (fail-open:
user-authored XML is never dropped); each allowlist entry has a fixture.

Title: the **last** `ai-title` record's text seen while streaming; subagent
title: `.meta.json` description / agent type → first prompt. Metadata from
records: `cwd`, `gitBranch`, `version` → `cliVersion`, first assistant
`message.model` → `model`.

Tasks: task JSON `{id, subject, description, status, blocks, blockedBy}` →
checklist `- [x] subject — description` ordered by numeric `id`.

Prompts (`history.jsonl`, rows `{display, pastedContents, timestamp (epoch
**ms**), project, sessionId}`): streamed whole, grouped by local calendar day
into one `agent.prompts` document per day (the one multi-document unit; its
docs have no parents), lines `- 10:02 · <project label> · <display> ·
session <id8>`. `pastedContents` is dropped. All days are re-rendered when the
file changes; unchanged days are hash-deduped by the engine.

### 4.6 Discovery — Codex (root `codex`)

| unit key | files | parentKey | render deps |
|---|---|---|---|
| `x:<threadId>` | the rollout under `sessions/YYYY/MM/DD/` or `archived_sessions/` (thread id = UUID at the end of the filename) | the parent thread's key, from the first record (`payload.parent_thread_id`, else `source.subagent.thread_spawn.parent_thread_id`) | the thread's `session_index.jsonl` title (last row per id by `updated_at`) |
| `memory:<rel>` | `AGENTS.md`, `memories/**` text files | — | — |
| `history` | `history.jsonl` | — | — |

`parentKey` of an unchanged Codex unit is taken from `cursor.parents`; of a
changed unit, from its first line (read before ordering — one small read per
changed rollout). `session_index.jsonl` and every day directory are read/listed
each tick.

Record → Turn (Codex), two on-disk generations:

- **Current** (first line `{type:'session_meta', payload}`): subagent iff a
  parent thread id is present; `source.subagent.thread_spawn.agent_nickname`
  → subagent title. `response_item` payloads: `message` user/assistant → turn
  (`developer` dropped; user parts pass the injected-wrapper filter);
  `agent_message` → assistant turn from `content[].text`; `function_call` /
  `custom_tool_call` → tool line (`name` + summary per §4.4 from
  `arguments`/`input`); `*_output`, `reasoning` dropped. `turn_context.model` →
  metadata. All other top-level types (`event_msg`, `token_count`,
  `token_usage_record`, `world_state`, …) ignored.
- **Legacy** (Aug–Sep 2025; first line `{id, timestamp, instructions, git}`,
  then bare `{type:'message', role, content}` / `{record_type}` lines): the
  first line gives id/started/git; bare records are handled as their
  `response_item` equivalents.

Prompts (`history.jsonl`, rows `{session_id, ts (epoch **seconds**), text}`):
same per-day documents as Claude.

### 4.7 Redaction (`redact.ts`)

Applied to **every emitted string**: each source string (turn text, tool
summary, title candidate, prompt-history line, task subject/description,
plan/memory body, metadata string values) before any truncation, and once more
over the final `title`, `markdown` and metadata strings (idempotent). Rules:

- PEM blocks `-----BEGIN [A-Z ]*PRIVATE KEY-----` through the matching END, or
  to the end of the string when unterminated.
- Token shapes: `sk-ant-…`, `sk-[A-Za-z0-9_-]{20,}`, `ghp_|gho_|ghs_|github_pat_…`,
  `xox[abprs]-…`, `AKIA[0-9A-Z]{16}`, `AIza[0-9A-Za-z_-]{35}`, JWT
  `eyJ[\w-]+\.[\w-]+\.[\w-]+`, `Bearer <≥20 chars>`.
- Assignments whose key contains `password|passwd|secret|token|api[_-]?key|
  access[_-]?key|private[_-]?key` (bare, `"quoted"` or `'quoted'`, followed by
  `=` or `:`) **and** whose value (bare run of non-space, or a complete quoted
  string including spaces) is ≥ 12 chars and contains both a letter and a digit
  → value becomes `[redacted]`. This leaves `token: string` and
  `password: z.string()` alone.

A safety net on top of dropping tool output — the README states that a pasted
secret matching no pattern is indexed.

### 4.8 Tests (named, fixture-driven)

Fixtures are redacted real captures from this machine (Claude 2.1.x incl. a
subagent pair, an array-form `isMeta` record and a compaction summary; Codex
0.155.x current + one legacy 2025-08 rollout + a nested-subagent pair with the
same filename second), each ≤ 50 KB, under `test/fixtures/`.

- `claude.session.turns-and-tool-lines`, `.drops-tool-results`,
  `.drops-thinking-and-attachments`, `.drops-compact-summary`,
  `.drops-array-form-isMeta`, `.renders-slash-command`, `.renders-bash-input`,
  `.title-last-ai-title`, `.subagent-not-emptied-by-sidechain`.
- `wrappers.<each allowlist tag>-dropped`, `.unknown-tag-kept`,
  `.multi-block-user-xml-kept`, `.case-insensitive-INSTRUCTIONS`.
- `claude.orphan-subagent-renders`, `.lock-only-tasks-dir-no-unit`,
  `claude.tasks.checklist-order`, `claude.prompts.local-day-ms`,
  `.drops-pasted`, `claude.memory.txt-and-md`.
- `codex.current.agent-message-is-assistant`, `.filters-injected-context`,
  `.nested-subagent-links-parent`, `.title-from-session-index-last-wins`,
  `.rename-changes-fingerprint`, `codex.legacy.renders-turns`,
  `codex.prompts.local-day-seconds`.
- `render.budget-head-tail-omission`, `.turn-cut-at-16k`,
  `.streams-multi-chunk-file` (> 16 MiB synthetic),
  `.oversized-record-skipped-without-buffering` (> 1 MiB line; assert peak
  line buffer ≤ 1 MiB), `.skips-partial-last-line`.
- `redact.<each pattern>`, `.quoted-json-key`, `.quoted-value-with-spaces`,
  `.unterminated-pem`, `.leaves-type-annotations`,
  `.applied-to-prompt-lines|task-bodies|metadata|titles`.
- `sync.appended-unit-reprocessed` (the A-at-900/B-at-1200 case),
  `.same-mtime-different-size`, `.inode-change-reprocessed`, `.future-mtime`,
  `.render-version-bump-rerenders-all`, `.crash-resume-redoes-only-uncommitted`,
  `.corrupt-unit-committed-and-retried-on-change`, `.terminal-batch-always`,
  `.backfill-then-live-phase`, `.vanished-key-dropped-docs-kept`,
  `.parent-before-child-across-batch-boundary` (same-second Codex pair, batch
  size forced to 1), `.late-parent-reemits-children`,
  `.batch-never-exceeds-25-docs-or-8MiB` (a 479-subagent family).
- `connect.missing-root-message`, `bundleLoadSmoke`, plus the benchmarks
  (§4.5) recorded in the PR.

Every gate lists its mutant (e.g. stop dropping tool results → red).

## 5. Rollout

1. Core branch → PR → release v0.91.0 (platform 2.3.0) + SDK 1.4.0 →
   alpha-cent `core.lock` bump.
2. Connector repo under `kia-plugins` (topic `kia-plugin`), release `1.0.0`
   with the standard tgz asset.
3. Manual smoke on this machine: install → consent lists `~/.claude` and
   `~/.codex` → add both sources → backfill completes (no progress bar — no `estimateTotal`) →
   spot-check search for a known prompt, a subagent linked to its parent, a
   nested Codex subagent, a plan, a prompt-day; continue a Claude session and
   confirm the next tick rewrites only that family.

## 6. Risks

- **Format drift.** Both CLIs change JSONL often. Unknown record types are
  ignored by design; a structural break shows up as short transcripts, not
  crashes. Fixtures are refreshed per connector release.
- **Backfill cost.** ~12k units (cursor ≈ 0.9 MB per committed batch), ~7.5 GB streamed once (whole files, 4 MiB
  reads). Rendered output ≤ 512 KiB per session doc. A long-running active
  session > 100 MB is re-streamed on every tick it changes — accepted for v1,
  revisit if the benchmark shows it matters.
- **Secrets.** Tool output dropped + redaction; residual risk documented.
- **Restart needed** for a folder created after activation (§3.3).
