# Agent Sessions connector (Claude Code + Codex) — design

Date: 2026-09-23 · Status: draft r2 (after fable + astra round 1)

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
  only a manifest with no `fileRoots`. So a same-version, same-caps manifest
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
   `home`, equals `home`, is inside or contains the app's `userData` directory,
   or is inside or equal to `~/Library` as a whole (`~/Library/<sub>/…` deeper
   than two levels is allowed).
3. If a grant with this id exists and its stored path equals `real` and a fresh
   `lstat(real)` matches its stored `dev`/`ino`, keep it. Otherwise **revoke
   first**, then `fileRoots.grant(e.id, real, { id, name: <~/ path>, writable:
   false })`.
4. Revoke every granted root of `e` whose id is not declared (stale after an
   update).
5. If anything changed, `persistFileRoots()` (new `ExtensionPlatformDeps`
   member; `main.ts` passes the same persistence function it already gives
   `buildMainApi`). A persistence failure is logged and the in-memory state kept
   (it is re-derived on the next activation).

Call sites — both already serialized per extension by the platform lifecycle,
so no new locking:

- right after each `consents.record(...)` (install, update, review), before the
  extension is (re)started;
- at activation, after the `consentCovers` check (~`extension-platform.ts:924`)
  and before `host.start()`. This also heals a root whose directory appeared
  later or was recreated — **on the next activation** (app restart or
  disable/enable). No lazy granting from inside `roots()` in v1.

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
  `.revokes-all-on-uninstall`, `.persists-and-restores-across-restart`.
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
`"~/.claude was not found or not permitted — run Claude Code once, restart KIA, then add this source"`
(resp. `~/.codex`/Codex). Otherwise returns `{ identifier: '~/.claude', config: {} }`.

### 4.3 Change detection — per-unit fingerprints, no watermark

A **unit** is the smallest group of files that renders into a fixed set of
documents. Each unit has a stable `key` and a **fingerprint** = a short hash of
the `(rel, size, mtimeMs)` of every file in the unit plus any render
dependency that lives outside it (§4.5/§4.6 name them).

```ts
type Cursor = {
  fps: Record<string, string>;   // unit key → fingerprint of the last committed render
  pass: 'initial' | 'done';
};
```

Each `pull(session, cursor)`:

1. **Discover**: walk the discovery set exhaustively (every relevant directory
   is listed every tick — no watermark, no parent-gated shortcuts), building
   `units: Map<key, {fp, files, order}>`.
2. **Diff**: `changed = units where cursor.fps[key] !== fp`, sorted by the
   unit's `order` (§4.5/§4.6 — guarantees parents before children).
   Keys in `cursor.fps` no longer discovered are removed from the next cursor
   (documents are kept — §1).
3. **Render**: process `changed` in order; after every 25 units (or 8 MiB of
   rendered markdown) yield `{ phase, items, cursor: {fps: fps ∪ processed,
   pass}, estimateTotal: changed.length }` with `phase = cursor.pass ===
   'initial' ? 'backfill' : 'live'`.
4. **Terminal batch**: always yield one final batch (possibly `items: []`)
   with `pass: 'done'` and the full fingerprint map — also when `changed` was
   empty, ended on a batch boundary, or held only skipped units.

A unit whose parse throws is logged and **committed with its fingerprint** (so a
corrupt file cannot wedge the source; its next modification changes the
fingerprint and it is retried). Crash resume: the next pull re-diffs against
the last committed map, so exactly the uncommitted units are redone.
Ordering, ties, clock skew and future mtimes are irrelevant: the comparison is
equality of fingerprints, not order.

Cursor size: one entry per unit (~2k Claude families + ~1k Codex threads + a
few hundred small files here) ≈ 200 KB of JSON, written once per batch.

`upsertDocument` dedups by content hash, so a unit whose files changed but whose
rendering did not produce a no-op write.

### 4.4 Documents

Everything goes through `toDocument` → `upsertDocument` → the shared
`documents` table (key `(accountId, externalId, type)`).

| type | one per | externalId | title |
|---|---|---|---|
| `agent.session` | session **or** subagent transcript | `session:<id>` (Claude subagent: `session:<sessionId>/<agentId>`) | see §4.5/§4.6; fallback: first user prompt (≤ 80 chars) → `Session <id8>` |
| `agent.plan` | Claude plan file | `plan:<file name>` | first `# ` heading → file name |
| `agent.tasks` | Claude task list of one session | `tasks:<sessionId>` | `Tasks — <session title if in the same unit, else id8>` |
| `agent.memory` | memory/instructions file | `memory:<rel path>` | `<project label> — <file name>` |
| `agent.prompts` | calendar day (local time) of prompt history | `prompts:<YYYY-MM-DD>` | `Prompts — <YYYY-MM-DD>` |

Subagents are ordinary `agent.session` documents with `metadata.role =
'subagent'` and `parent: { externalId: 'session:<parentId>', type:
'agent.session' }` — one type, so a Codex subagent whose parent is itself a
subagent links the same way. `agent.tasks` has the same `parent` shape.
Parent resolution relies on §4.3 ordering: a parent is committed in the same
batch or an earlier one (the engine's `reconcileParents` covers the same batch,
the parent row covers earlier ones). A parent whose file was already deleted by
cleanup and was never indexed stays unresolved (`parentId = null`,
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
  summaries, and injected context (rules in §4.5/§4.6).
- **Streaming**: files are read with `streamLines` in 4 MiB chunks through the
  whole file (no raw head/tail skipping); records are filtered into turns as
  they stream, so memory stays O(budget). An unparsable line (including a
  partial last line of a file being written) is skipped.
- **Budget**: rendered markdown ≤ **512 KiB** per document: whole turns from
  the head until 256 KiB, a ring buffer of whole turns for the last 256 KiB,
  and `… N turns omitted …` between them if anything was dropped. A single turn
  longer than 16 KiB is cut to 16 KiB with `… (truncated)`.
- **Redaction** runs on each turn's text *before* the per-turn cut and before
  the budget (§4.7).

### 4.5 Discovery — Claude Code (root `claude`)

| unit key | files | order |
|---|---|---|
| `c:<proj>/<sessionId>` (family) | `projects/<proj>/<sessionId>.jsonl` (optional), every `projects/<proj>/<sessionId>/subagents/agent-*.jsonl` + sibling `agent-*.meta.json`, `tasks/<sessionId>/*.json` | earliest file mtime in the family |
| `plan:<name>` | `plans/*.md` | mtime |
| `memory:<rel>` | `projects/<proj>/memory/**` text files (`.md`, `.txt`), `CLAUDE.md` if present | mtime |
| `history` | `history.jsonl` | last |

A family renders parent-first in one batch: the session doc (if its `.jsonl`
exists), then each subagent doc, then the tasks doc. A family with only a
`subagents/` dir (parent `.jsonl` removed by cleanup — common) still renders its
subagents. A `tasks/<id>/` dir holding only `.lock`/`.highwatermark` yields no
doc.

Walk per tick: `projects/` (1 list), each `projects/<proj>/` (~170), each
`<sessionId>/` dir and its `subagents/` (~1.2k), `tasks/` + each `tasks/<id>/`
(~170), `plans/`, each `memory/`. ≈ 1.5k list calls on this machine; the plan
includes a benchmark of a full unchanged tick through the real host API
(target < 10 s, measured before any optimisation is considered).

Record → Turn (Claude):

- Title: the **last** `ai-title` record's text seen while streaming; subagent
  title: `.meta.json` description / agent type → first prompt.
- `user` with string content → user turn, unless: `isMeta`, `isCompactSummary`,
  or the trimmed text is **one XML-tagged block only** (`^<([a-z-]+)[^>]*>[\s\S]*</\1>$`
  — covers `task-notification`, `local-command-*`, `system-reminder`, …) →
  dropped; exception: a block set made of `<command-name>`/`<command-message>`
  /`<command-args>` renders as `/name args`. Text starting with
  `[Request interrupted` is dropped.
- `user` with `tool_result` content → dropped. `user` with `text` parts →
  user turn from the text parts.
- `assistant` → `text` parts become the assistant turn; `tool_use` parts become
  tool lines; `thinking`, `server_tool_use`, `*_tool_result` dropped.
- Everything else (`attachment`, `system`, `queue-operation`, `mode`,
  `permission-mode`, `file-history-snapshot`, `last-prompt`, …) → ignored.
- `isSidechain` is **not** used as a filter (every subagent record has it).
- metadata from records: `cwd`, `gitBranch`, `version` → `cliVersion`,
  `message.model` of the first assistant record → `model`.

Prompts (`history.jsonl`, rows `{display, pastedContents, timestamp, project,
sessionId}`): streamed whole, grouped by local calendar day → one doc per day,
lines `- 10:02 · <project label> · <display>` (+ ` · session <id8>`).
`pastedContents` is **dropped** (likeliest home of pasted secrets). All days are
re-rendered when the file changes; unchanged days are hash-deduped by the
engine.

### 4.6 Discovery — Codex (root `codex`)

| unit key | files | order |
|---|---|---|
| `x:<threadId>` | the rollout file for that thread under `sessions/YYYY/MM/DD/` or `archived_sessions/` (thread id = UUID at the end of the filename) | thread creation time from the filename (`rollout-<ISO>-<uuid>.jsonl`) |
| `memory:<rel>` | `AGENTS.md`, `memories/**` text files | mtime |
| `history` | `history.jsonl` | last |

Render dependency: the thread's `session_index.jsonl` title (last row per id by
`updated_at`) is folded into the unit fingerprint, so a rename re-renders the
session. `session_index.jsonl` and each day directory are read/listed every
tick.

Ordering by creation time puts every parent thread before its spawned children
(a child cannot be created before its parent).

Record → Turn (Codex), two on-disk generations:

- **Current** (first line `{type:'session_meta', payload}`):
  `payload.parent_thread_id` (or `source.subagent.thread_spawn.parent_thread_id`)
  → `role: 'subagent'` with that parent; `source.subagent.thread_spawn.agent_nickname`
  → subagent title. `response_item` payloads: `message` user/assistant → turn
  (`developer` dropped); `agent_message` → assistant turn from `content[].text`;
  `function_call` / `custom_tool_call` → tool line (`name` + summary per §4.4
  from `arguments`/`input`); `*_output`, `reasoning` → dropped.
  `turn_context.model` → metadata. All other top-level types (`event_msg`,
  `token_count`, `token_usage_record`, `world_state`, …) ignored.
- **Legacy** (Aug–Sep 2025; first line `{id, timestamp, instructions, git}`,
  then bare `{type:'message', role, content}` / `{record_type}` lines): the
  first line gives id/started/git; bare `message`/`function_call` records are
  handled as their `response_item` equivalents.
- Injected user context is dropped when a user `input_text` part, trimmed, is
  one XML-tagged block only (same regex as Claude — covers
  `<environment_context>`, `<user_instructions>`, `<recommended_plugins>`, …) or
  starts with `# AGENTS.md instructions`.

Prompts (`history.jsonl`, rows `{session_id, ts, text}`): same per-day docs.

### 4.7 Redaction (`redact.ts`)

Applied to titles, turn texts, tool summaries and memory/plan bodies, on the
full string before any truncation:

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

It is a safety net on top of dropping tool output — documented as such in the
README (a pasted secret in a prompt that matches no pattern is indexed).

### 4.8 Tests (named, fixture-driven)

Fixtures are redacted real captures from this machine (Claude 2.1.x incl. a
subagent pair and a compaction summary; Codex 0.155.x current + one legacy
2025-08 rollout + a nested-subagent pair), each ≤ 50 KB, under
`test/fixtures/`.

- `claude.session.turns-and-tool-lines`, `.drops-tool-results`,
  `.drops-thinking-and-attachments`, `.drops-compact-summary`,
  `.drops-sole-xml-block-turns`, `.renders-slash-command`,
  `.title-last-ai-title`, `.subagent-not-emptied-by-sidechain`.
- `claude.family.parent-first-in-one-batch`, `.orphan-subagents-still-render`,
  `.lock-only-tasks-dir-no-doc`, `claude.tasks.checklist-order`,
  `claude.prompts.local-day-and-drops-pasted`, `claude.memory.txt-and-md`.
- `codex.current.agent-message-is-assistant`, `.filters-injected-context`,
  `.nested-subagent-links-parent`, `.title-from-session-index-last-wins`,
  `.rename-changes-fingerprint`, `codex.legacy.renders-turns`.
- `render.budget-head-tail-omission`, `.turn-cut-at-16k`,
  `.streams-multi-chunk-file` (> 16 MiB synthetic), `.skips-partial-last-line`.
- `redact.<each pattern>`, `.quoted-json-key`, `.quoted-value-with-spaces`,
  `.unterminated-pem`, `.leaves-type-annotations`.
- `sync.appended-unit-reprocessed` (the A-at-900/B-at-1200 case from review),
  `.same-mtime-different-size`, `.future-mtime`, `.crash-resume-redoes-only-uncommitted`,
  `.corrupt-unit-committed-and-retried-on-change`, `.terminal-batch-always`,
  `.backfill-then-live-phase`, `.vanished-key-dropped-docs-kept`.
- `connect.missing-root-message`, `bundleLoadSmoke`, plus the tick benchmark
  (§4.5) recorded in the PR.

Every gate lists its mutant (e.g. stop dropping tool results → red).

## 5. Rollout

1. Core branch → PR → release v0.91.0 (platform 2.3.0) + SDK 1.4.0 →
   alpha-cent `core.lock` bump.
2. Connector repo under `kia-plugins` (topic `kia-plugin`), release `1.0.0`
   with the standard tgz asset.
3. Manual smoke on this machine: install → consent lists `~/.claude` and
   `~/.codex` → add both sources → backfill completes with a progress bar →
   spot-check search for a known prompt, a subagent linked to its parent, a
   nested Codex subagent, a plan, a prompt-day; continue a Claude session and
   confirm the next tick rewrites only that family.

## 6. Risks

- **Format drift.** Both CLIs change JSONL often. Unknown record types are
  ignored by design; a structural break shows up as short transcripts, not
  crashes. Fixtures are refreshed per connector release.
- **Backfill cost.** ~3k units, ~7.5 GB streamed once (whole files, 4 MiB
  reads). Rendered output ≤ 512 KiB per session doc. A long-running active
  session > 100 MB is re-streamed on every tick it changes — accepted for v1,
  revisit if the benchmark shows it matters.
- **Secrets.** Tool output dropped + redaction; residual risk documented.
- **Restart needed** for a folder created after activation (§3.3).
