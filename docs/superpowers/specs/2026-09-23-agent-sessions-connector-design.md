# Agent Sessions connector (Claude Code + Codex) — design

Date: 2026-09-23 · Status: draft for review

## 1. Goal

Index the user's local coding-agent history into KIA so it is searchable (and
reachable over MCP) next to mail, docs and chats. v1 covers **Claude Code** and
**Codex**:

- sessions (the conversation transcript, condensed),
- subagent transcripts, linked to their parent session,
- plans, task lists, memory files,
- the typed-prompt history.

Out of scope for v1: cost/token/quota metrics, near-real-time ingestion (hooks,
OTel, file watching), resume/launch actions, other agents (Cursor, OpenCode, …),
Claude Cowork's second root (`~/Library/Application Support/Claude/…`),
repo-local `CLAUDE.md`/`AGENTS.md` files (they live outside the granted roots).

Success = after installing the extension from the Marketplace (one consent
screen that names the folders it reads) and adding the two sources, every
session/subagent/plan/tasklist/memory/prompt-day appears as a row in the ordinary
`documents` table, searchable by the existing FTS/MCP tools, and stays current
on the normal cadence.

Non-goal: mirroring deletions. Claude Code deletes transcripts after
`cleanupPeriodDays` (30 by default). KIA deliberately **keeps** what it indexed —
that is a feature. The sources implement no `reconcile`.

## 2. Two deliverables

1. **kiagent-core: manifest-declared file roots** (branch
   `feat/local-agent-sessions`, worktree `../kiagent-core-agent-sessions`). A
   marketplace extension can declare the local folders it needs; the consent
   modal shows them; granting consent grants the roots. Today no external
   extension can obtain a root at all (only `mainApi.files.grantRoot`, reachable
   only by `unsafe.mainProcess` bundled extensions).
2. **`kia-plugins/agent-sessions-kia-connector`** (new repo, local dir
   `/Users/edjafarov/work/agent-sessions-kia-connector`): one extension
   `kia.agent-sessions` contributing two sources, `claude-code` and `codex`.

alpha-cent receives only a `core.lock` bump after the core release; no overlay
change.

## 3. Core: manifest-declared file roots

### 3.1 Manifest

New optional top-level key (the schema is strict, so this is a schema change):

```json
"fileRoots": [
  { "id": "claude", "path": "~/.claude", "purpose": "Claude Code sessions, plans, tasks, memory and prompt history" },
  { "id": "codex",  "path": "~/.codex",  "purpose": "Codex sessions, memory and prompt history" }
]
```

Validation in `parseManifest` (`src/main/platform/manifest.ts`):

- `fileRoots` requires `caps` to include `files` (`PLUGIN_FILES_CAP_REQUIRED`),
  mirroring the `db`→`database` and `ui`→`contributes.ui` rules.
- `id` matches `^[a-z][a-z0-9-]{0,31}$`, unique within the manifest.
- `path` must start with `~/`, is resolved against `os.homedir()`, and after
  `path.normalize` must still be strictly inside the home directory (rejects
  `~/..`, `~/`, `~` alone, absolute paths, NUL). Max 8 entries.
- `purpose`: non-empty string, ≤ 200 chars — shown verbatim on the consent modal.
- Roots are **read-only**. There is no `access` field; a write-capable declared
  root is out of scope.

`Manifest` type, `ExtensionPreview` and `ExtensionSnapshot` gain
`fileRoots: Array<{ id; path; purpose }>` (always an array; `[]` when absent),
carrying the **unexpanded** `~/…` path for display.

### 3.2 Consent surface

- `ConsentModal.tsx` renders a "Reads these folders on your computer" section
  listing each root's `path` and `purpose`, for install, update and review modes.
- `cap-catalog.ts`: replace the stale `files` copy ("Not yet supported…") with
  "Read files in the folders listed below" (risk: elevated — local personal data).
- Consent storage is unchanged: `consentCovers` already requires
  `rec.manifestVersion === manifest.version`, so any manifest change (including a
  changed `fileRoots` list) re-prompts; the roots need no separate consent record.

### 3.3 Granting — the declared-root reconciler

One function, `reconcileDeclaredRoots(e: Entry)`, in
`extension-platform.ts`, owned by the platform (never callable by the extension):

- For each declared root: resolve the absolute path. If a grant with that `id`
  exists for this extension and still resolves (same path, same `dev`/`ino`),
  keep it. Otherwise call `fileRoots.grant(extensionId, absPath, { id, name: path,
  writable: false })`. A missing directory (`ENOENT`) or non-directory is **not**
  an error: the root simply stays ungranted and is logged at `info`.
- For an **external-tier** extension, revoke every granted root whose id is not
  declared (external extensions have no other grant path, so any undeclared
  root is stale — e.g. dropped by an update). Bundled extensions are never
  revoked here (they may hold `mainApi` grants).
- Persist via the existing `persistFileRoots` after any change.

It runs:

1. after consent is recorded (install, update, review — the
   `consents.record(...)` sites in `extension-platform.ts`),
2. at every activation of an extension whose consent covers its manifest,
   before `activate()` is called (heals a root whose directory appeared later,
   or whose identity changed because the user deleted and recreated it),
3. lazily inside `ScopedFiles.roots()` for the calling extension (so a user who
   installs Codex *after* KIA can add the Codex source without restarting).

On **uninstall**, all of the extension's roots are revoked.

Identity-change re-grant (step 2/3) is acceptable for declared roots because the
user consented to the *path*, not the inode. Roots granted through
`mainApi.grantRoot` keep today's strict identity semantics.

### 3.4 What the extension sees

Nothing new in the SDK surface: `host.files.roots()` returns the granted roots
(`{ id: 'claude', name: '~/.claude', writable: false }`), and every other
`ScopedFiles` call takes `{ root: 'claude', rel: 'projects/…' }`. Existing limits
apply (16 MiB per read, 1000 entries per list page). No SDK release is required
unless `Manifest` is part of the generated contracts; if it is, SDK 1.4.0 ships
the regenerated types.

### 3.5 Core tests (named)

- `manifest.fileRoots.requires-files-cap`, `.rejects-escape` (`~/..`, `/abs`,
  `~`, `~/a/../../b`), `.rejects-duplicate-id`, `.accepts-valid`.
- `reconcile.grants-declared-on-consent`, `.missing-dir-is-not-error`,
  `.grants-when-dir-appears-via-roots()`, `.regrants-on-identity-change`,
  `.revokes-undeclared-for-external`, `.never-revokes-bundled`,
  `.revokes-all-on-uninstall`, `.no-grant-without-consent` (an extension whose
  consent does not cover its manifest gets no roots, even via `roots()`).
- `ConsentModal` renders the folder list in install/update/review.
Each gate must be shown red against a mutant (skip the grant, skip the revoke,
drop the escape check).

## 4. Connector: `kia.agent-sessions`

### 4.1 Manifest

```json
{
  "id": "kia.agent-sessions",
  "name": "Agent Sessions",
  "engine": "^2.1.0",
  "entry": "dist/index.js",
  "caps": ["files"],
  "fileRoots": [ …as §3.1… ],
  "contributes": { "sources": ["claude-code", "codex"], "senders": [] },
  "icon": "icon.png"
}
```

No `net`, no `query`. `engine` is bumped to whatever `PLATFORM_API_VERSION`
the core change ships as (a minor bump — new optional manifest field).

Repo layout mirrors the other connectors (esbuild bundle, jest, vendored SDK
tgz devDependency, zero runtime deps):

```
src/index.ts            activate(host) → { sources: [claudeSource(host), codexSource(host)] }
src/fs-walk.ts          ScopedFiles helpers: listAll(dir), statOrNull, readJsonl (bounded)
src/scan.ts             shared (mtime,path) change scan + cursor type
src/render.ts           Transcript → markdown with head/tail byte budget
src/redact.ts           secret redaction
src/claude/*.ts         discovery + parsers for Claude files
src/codex/*.ts          discovery + parsers for Codex files
```

### 4.2 Sources

Both sources: `auth: 'none'`, `cadence: { every: '15m' }`,
`documentTypes` as in §4.4. `connect()` calls `host.files.roots()`; if its root
(`claude` / `codex`) is not granted it throws
`"~/.claude was not found — run Claude Code once, then add this source again"`
(resp. Codex). Otherwise it returns `{ identifier: '<root display path>', config: {} }`.
One account per source; adding a second is a no-op replace (same identifier).

### 4.3 Change detection — one uniform scan

Every file the connector reads is a **unit**: a (root-relative) path mapped to
one parser. Each `pull()`:

1. Walks the discovery set (§4.5) with `ScopedFiles.list`, collecting
   `{ rel, mtimeMs, size }` for every unit file.
2. Keeps units with `(mtimeMs, rel) > cursor` (tuple order), sorted ascending.
3. Parses them in that order, yielding a batch every 25 units (or 8 MiB of
   rendered markdown) with `cursor = (mtimeMs, rel)` of the last unit in the
   batch.
4. The first full pass is `phase: 'backfill'`; once a pass reaches the end with
   `cursor.initialPassDone = true` it becomes `'live'`.

```ts
type Cursor = { mtimeMs: number; rel: string; initialPassDone: boolean };
```

A unit whose file is appended again gets a newer mtime and is re-parsed whole
and re-upserted; `upsertDocument`'s content-hash dedup makes unchanged
re-renders free. A crash between batches resumes after the last committed unit.

Edge: a file modified *during* the pass with an mtime ≤ cursor is impossible
(mtimes only grow for a live file); a file whose mtime goes backwards (restored
from backup) is not re-read — accepted.

A unit whose parse throws is logged and skipped (the cursor still advances past
it, so one corrupt file cannot wedge the source); the next modification
re-parses it.

### 4.4 Documents

All go through `toDocument` → the engine's `upsertDocument` → the shared
`documents` table (keyed `(accountId, externalId, type)`), exactly like every
other connector.

| type | one per | externalId | title | createdAt |
|---|---|---|---|---|
| `agent.session` | top-level session | `session:<sessionId>` | agent title → first user prompt (≤ 80 chars) → `Session <id8>` | first record timestamp |
| `agent.subagent` | subagent transcript | `subagent:<agentId or threadId>` | `<parent title> › <subagent description or agent type>` | first record timestamp |
| `agent.plan` | Claude plan file | `plan:<file name>` | first `# ` heading → file name | file mtime |
| `agent.tasks` | Claude task list (per session) | `tasks:<sessionId>` | `Tasks — <parent title if known, else id8>` | earliest task file mtime |
| `agent.memory` | memory/instructions file | `memory:<rel path>` | `<project label> — <file name>` | file mtime |
| `agent.prompts` | calendar day of prompt history | `prompts:<YYYY-MM-DD>` | `Prompts — <YYYY-MM-DD>` | first prompt that day |

`parent: ExternalRef` links `agent.subagent` and `agent.tasks` to their
`agent.session` (`{ externalId: 'session:<id>', type: 'agent.session' }`).

Common `metadata`: `{ agent: 'claude-code' | 'codex', cwd?, gitBranch?,
project?, sessionId?, parentSessionId?, model?, cliVersion?, sourcePath }`
(`sourcePath` = `~/.claude/…` display path). `url` is unset (no stable URL).

Session/subagent markdown:

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
→ Subagent: "Map core plugin install+files+source APIs" (see linked subagent)
```

Rendering rules (both agents):

- Kept: user-typed text, assistant visible text, one line per tool call
  (`→ <tool>: <summary>`, summary = the most descriptive input field —
  command / file_path / pattern / description / url — truncated to 160 chars).
- Dropped: tool **results/outputs**, thinking/reasoning, hook output,
  attachments, file-history snapshots, token/usage records, mode/permission
  records, system/developer messages, and injected context (Claude:
  `isMeta` user records, `<command-*>`/`<local-command-*>`/`<system-reminder>`
  wrappers are unwrapped to their human part or dropped; Codex: user
  `input_text` parts starting with `<environment_context>`,
  `<user_instructions>`, `# AGENTS.md instructions`, `<INSTRUCTIONS>`).
- Budget: markdown ≤ **512 KiB**. The renderer keeps whole turns from the head
  until 256 KiB and a ring buffer of whole turns for the last 256 KiB; if
  anything was dropped it inserts `… N turns omitted …`.
- Large files: a unit file > 32 MiB is read as its first 16 MiB and last
  16 MiB only (tail starts at the first newline after the seek). The budget
  above means the middle could never be rendered anyway. A truncated/partial
  trailing JSON line is ignored.

Redaction (`redact.ts`) runs on every emitted string (titles, prompts,
assistant text, tool summaries): private-key blocks, `sk-…`/`sk-ant-…`,
`ghp_/gho_/github_pat_…`, `xox[abprs]-…`, `AKIA[0-9A-Z]{16}`, `AIza…`,
JWT-shaped `eyJ….….…`, `Bearer <token>`, and `(password|secret|token|api[_-]?key)
\s*[=:]\s*\S+` → `[redacted]`. Deliberately conservative; it is a safety net on
top of dropping tool output, not a DLP system.

### 4.5 Discovery — Claude Code (root `claude`)

| unit | path | parser |
|---|---|---|
| session | `projects/<proj>/<sessionId>.jsonl` | Claude transcript; title = last `ai-title` record; skips `isSidechain: true` lines |
| subagent | `projects/<proj>/<sessionId>/subagents/agent-*.jsonl` (+ sibling `.meta.json` for description/agent type when present) | Claude transcript, `parentSessionId = <sessionId>` |
| plan | `plans/*.md` | verbatim markdown (budget + redaction apply) |
| tasks | `tasks/<sessionId>/*.json` (unit = the directory; its mtime key = max file mtime) | checklist `- [x] subject — description` ordered by numeric id; `.lock`/`.highwatermark` ignored |
| memory | `projects/<proj>/memory/*.md`, `CLAUDE.md` | verbatim |
| prompts | `history.jsonl` | grouped by local calendar day of `timestamp` → one `agent.prompts` doc per day: `- 10:02 · <project> · <display>` |

Subagent discovery cost: the walk lists `projects/*/` every tick (≈ one list
call per project), but descends into `<sessionId>/subagents/` only for sessions
whose own `.jsonl` changed since the cursor minus a 1-hour overlap (a running
subagent always coincides with its parent session being written). This keeps a
tick at O(projects + changed sessions) list calls instead of O(all sessions).

`<proj>` label for display = the decoded directory name (`-Users-x-work-a` →
`~/work/a`) — best effort, cosmetic only; the authoritative `cwd` comes from the
records.

### 4.6 Discovery — Codex (root `codex`)

| unit | path | parser |
|---|---|---|
| session / subagent | `sessions/YYYY/MM/DD/rollout-*.jsonl`, `archived_sessions/**/rollout-*.jsonl` | Codex rollout. `session_meta.payload.source.subagent.thread_spawn.parent_thread_id` present → `agent.subagent` with that parent; else `agent.session`. Title from `session_index.jsonl` (`id → thread_name`, read once per pull) → first user prompt |
| memory | `AGENTS.md`, `memories/**/*.md` | verbatim |
| prompts | `history.jsonl` (`{session_id, ts, text}`) | per-day `agent.prompts` docs |

Codex rollouts can be resumed and appended long after their day directory was
created, so the whole `sessions/` tree is listed every tick (≈ one list call per
day directory — a few hundred per year of use).

Codex record handling: `response_item` `message` (user/assistant; `developer`
dropped), `function_call` / `custom_tool_call` → tool line (summary = `cmd`
field if JSON-parsable, else first line of input, 160 chars), `*_output`
dropped, `reasoning` dropped, `event_msg`/`token_count`/`world_state`/
`turn_context` dropped except `turn_context.model` → metadata.

### 4.7 Tests (named, fixture-driven)

Fixtures are **redacted real captures** from this machine (Claude 2.1.x, Codex
0.155.x), checked in under `test/fixtures/`, each ≤ 50 KB.

- `claude.session.renders-turns-and-tool-lines`, `.drops-tool-results`,
  `.drops-thinking-and-attachments`, `.unwraps-command-wrappers`,
  `.title-from-last-ai-title`, `.skips-sidechain-lines`.
- `claude.subagent.links-parent`, `claude.tasks.checklist-order`,
  `claude.prompts.groups-by-local-day`, `claude.memory.verbatim`.
- `codex.session.filters-injected-context`, `.subagent-from-thread-spawn`,
  `.title-from-session-index`, `.drops-outputs-and-reasoning`.
- `render.budget.head-tail-with-omission-marker`,
  `render.large-file-reads-head-and-tail-only`, `render.ignores-partial-last-line`.
- `redact.*` one case per pattern + a no-false-positive case on ordinary prose.
- `scan.cursor.resumes-after-last-unit`, `.reparses-appended-file`,
  `.corrupt-unit-skipped-and-cursor-advances`, `.backfill-then-live-phase`,
  `.subagent-descent-only-for-changed-sessions`.
- `connect.missing-root-message`, `bundleLoadSmoke`.
Mutation evidence required per gate (e.g. stop dropping tool results → the
`drops-tool-results` gate goes red).

## 5. Rollout

1. Core branch → PR → release (minor) → alpha-cent `core.lock` bump.
2. Connector repo created under `kia-plugins` (topic `kia-plugin`), release
   `1.0.0` with the standard tgz asset.
3. Manual smoke on this machine (13k sessions, 5.3 GB Claude + 2.2 GB Codex):
   install → consent shows both folders → add both sources → backfill completes
   → spot-check search for a known prompt, a subagent linked to its parent, a
   plan, a prompt-day; then continue a Claude session and confirm the next tick
   updates that one document only.

## 6. Risks

- **Format drift.** Both CLIs change their JSONL weekly-ish. Parsers ignore
  unknown record types by design; a structural break shows up as empty/short
  transcripts, not crashes. Mitigation: fixtures refreshed per release.
- **Backfill volume.** ~13k units, ~7.5 GB on disk, but head/tail reading caps
  bytes read per file at 32 MiB and rendered output at 512 KiB, so the corpus
  grows by at most a few GB of FTS text in the worst case (typical sessions are
  far below budget).
- **Secrets.** Dropping tool output removes the main leak path; redaction is a
  second layer. User prompts can still contain pasted secrets that the
  patterns miss — documented in the connector README.
