# Guided Add-Source Flow — Design

**Date:** 2026-07-06
**Status:** Approved

## Motivation

The add-source connect flow renders `auth.prompt()` schemas as bare inputs: a
Slack install shows one unlabeled-looking password field ("User OAuth Token
(xoxp-…)") and a Submit button — no explanation of where the token comes from,
no link to api.slack.com, no copyable app manifest. The legacy renderer
(alpha-cent's vendored kiagent-core) had manifest-declared wizard steps
(`instruction`, `show-copyable`, `input-fields`) that walked the user through
setup. Two UX bugs compound it: the Cancel button is a near-invisible ghost
button in the panel head, and clicking **Sources** in the top bar while the
add-source panel (or source detail) is open does nothing — `navigate('sources')`
is a no-op when the view is already `sources`, so in-screen state never resets.

## 1. Schema guidance conventions

Guidance lives **in the prompt schema** the source already sends through
`auth.prompt(schema)` (contracts.ts `AuthChannel`). The schema passes to the
renderer verbatim today; no platform/contract/IPC change is needed. The
renderer's best-effort schema reader (`schemaFields` in `AddSourcePanel.tsx`)
learns these OPTIONAL conventions:

Schema level:

- `description: string` — intro line rendered under the "Connect {Source}"
  heading.
- `'x-steps'`: `Array<{ title: string; body?: string; link?: string; copy?: string }>`
  — numbered setup steps rendered above the form fields.
  - `title` (required) — bold step heading. A step without a string title is
    skipped.
  - `body` — plain-text explanation ("On the app page: Install App → Install
    to Workspace.").
  - `link` — URL rendered as an "Open ↗" button. Only `https:` URLs render;
    anything else is ignored (extension-supplied content must not open
    arbitrary protocols). Clicking opens the system browser.
  - `copy` — preformatted copyable content (e.g. the Slack app-manifest YAML)
    rendered as a read-only monospace block with a **Copy** button
    (`navigator.clipboard.writeText`, "Copied ✓" feedback for 2 s).

Field level (inside `properties.<key>`):

- `description: string` — helper text under the input.
- `examples: [string, ...]` — `examples[0]` becomes the input `placeholder`
  (standard JSON Schema keyword; `xoxp-…`, `imap.example.com`).
- Existing conventions unchanged: `title` → label, `format: 'password'` /
  key-name heuristic → masked input, `format: 'folder-path'` /
  `'folder-paths'` → picker.

All parsing stays best-effort and tolerant: a malformed `x-steps` entry (or a
schema without any of this) renders exactly like today — fields only. Old
connectors keep working unmodified.

## 2. Renderer: wizard-card redesign of the flow panel

The flow stays **in place** (swapped over the Sources body, not a modal). When
a flow is active, `AddSourcePanel` renders a centered wizard card
(max-width 560 px, `.card` chrome) instead of the current bare `.as-flow`
column:

- **Header:** `SourceIcon` (size 28) + `h-section` heading "Connect {label}"
  (label via existing `sourceLabel`). Schema `description` renders under it
  as `t-meta`.
- **Steps:** numbered cards — accent number badge, bold title, `t-meta` body,
  optional "Open ↗" button (`btn sm`), optional copy block (read-only
  `textarea`-style monospace block + Copy button).
- **Form:** existing field rendering (labels, password masking,
  FolderPickerField) plus placeholder and helper-text conventions above.
- **Footer:** right-aligned `Cancel` (plain bordered `btn sm` — visible, not
  ghost) + primary `Connect` (renames today's "Submit"). Enter in a text
  field submits.
- **Other flow states** (status spinner, QR, done, error) render inside the
  same card chrome with the same footer (done → primary `Done`; error →
  `← Back` + `Cancel`).
- The tile-grid (no active flow) keeps its current layout; its head Cancel
  becomes the same visible bordered button.

CSS lives in `Sources.css` next to the existing `.as-*` classes (new
`.as-wizard`, `.as-step`, `.as-step-num`, `.as-copy`, `.as-wizard-foot`).

## 3. Navigation: top-bar click always returns to the list

`App.tsx`'s resolved-view state gains an `epoch: number` that increments on
EVERY `navigate()` call — including re-navigating to the current view. The
rendered screen is keyed on `` `${view}:${epoch}` ``, so a same-view nav click
remounts the screen and resets its local state (`adding` panel, `detail`
sub-view). Same-view re-navigation does NOT push a history entry (no duplicate
back stops). Cross-view navigation behavior is unchanged (screens already
remount when the component changes).

## 4. Main process: external links

`main.ts` (window creation site, `src/main/main.ts:138`): add
`webContents.setWindowOpenHandler` → `shell.openExternal(url)` for `https:`
URLs and `{ action: 'deny' }` always, plus a `will-navigate` guard preventing
in-window navigation away from the app. This is what makes the "Open ↗" step
buttons (rendered as `window.open`/anchor clicks) land in the system browser
instead of a raw Electron window. Applies app-wide (README links in the
marketplace detail benefit too).

## 5. Connector releases and builtin schema updates

Content ported from alpha-cent's connector manifests
(`alpha-cent-connectors-ext/src/main/connectors/manifests.ts` and
`slack/manifest.ts`):

- **kia.slack v2.0.2** — prompt schema gains `x-steps`:
  1. "Create the Slack app" / "api.slack.com/apps → Create New App → From a
     manifest → paste this:" / link `https://api.slack.com/apps?new_app=1` /
     copy = the connector's app-manifest YAML (already in its README; scopes
     from `SLACK_USER_SCOPES`).
  2. "Install to your workspace" / "On the app page: Install App → Install to
     Workspace, then copy the User OAuth Token from OAuth & Permissions."
  Token field gains `examples: ['xoxp-…']`.
- **kia.notion v2.1.2** — `x-steps`:
  1. "Create an integration" / "Create one, then copy the Internal
     Integration Secret." / link `https://www.notion.so/my-integrations`.
  2. "Share pages" / "In Notion, open each page/database → ••• → Connections
     → add it."
  Secret field gains `examples: ['ntn_…']`.
- **Builtin imap** (`src/main/sources/imap/source.ts`, in-repo, no release):
  field `examples`/`description` (host `imap.example.com`, note that
  credentials stay in the OS keychain).
- Gmail (builtin OAuth), local-folder (picker), google-docs (OAuth), and
  whatsapp (QR) need no step content; whatsapp may add a one-line
  `auth.status()` hint ("Open WhatsApp → Settings → Linked devices") without
  a version bump — optional, not part of this scope.

Release process as before: version bump, `files` unchanged, `npm pack`,
GitHub release with tgz; released assets never mutated.

## 6. Testing

- `wizard-schema` parsing unit tests: `x-steps` extraction (valid, missing
  title skipped, non-https link dropped, non-array ignored), `examples[0]`
  placeholder, field `description`.
- `AddSourcePanel` render tests: schema with steps renders numbered titles,
  Open button (href/click → `window.open` spy), Copy button writes clipboard,
  placeholder present; schema without conventions renders as today; footer
  Cancel visible in flow and grid states.
- Nav reset test: with the add panel open, `navigate('sources')` remounts
  Sources and shows the list again; history has no duplicate entry.
- Main window-open handler unit test if the window-creation module is
  testable; otherwise covered by lint/typecheck + manual smoke.

## Out of scope

- No modal; no multi-page wizard steps (all steps show at once, like
  alpha-cent).
- No AuthChannel/contract changes.
- No markdown in step bodies (plain text only).
