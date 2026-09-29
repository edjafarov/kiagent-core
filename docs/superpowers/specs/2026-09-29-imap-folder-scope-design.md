# IMAP folder scope — design

Status: draft for review (2026-09-29). Branch `feat/imap-folder-scope` (core).

## Problem

The built-in IMAP source (`src/main/sources/imap/`) syncs a fixed set:
the `\All` mailbox (or an "All Mail"-named one, else `INBOX`) plus Sent
(`folders.ts#resolveMailboxes`). On every non-Gmail server (Fastmail, iCloud,
Dovecot/cPanel hosts, privateemail.com…) there is no All-Mail mailbox, so
mail the user FILED into their own folders (`Projects/Acme`, `Receipts`,
`Archive`) is never indexed and there is no way to turn it on. Gmail, MS365,
Drive and local folders already offer a "Tracked folders" picker; IMAP does
not.

## Research (what well-behaved IMAP clients do)

- Enumerate with LIST; honour RFC 6154 SPECIAL-USE (`\All \Archive \Drafts
  \Flagged \Junk \Sent \Trash`). Never sync `\Noselect` / `\NonExistent`
  entries — they hold no messages — but show a `\Noselect` parent as a
  container in the tree. Hierarchy comes from the per-mailbox delimiter
  (`/` or `.`), which imapflow exposes as `delimiter` / `parentPath`.
- Gmail over IMAP exposes every label as a folder and every message in
  `[Gmail]/All Mail`; syncing All Mail plus label folders duplicates mail.
  Clients either sync All Mail only or dedupe on `X-GM-MSGID`. `\All`
  excludes Spam and Trash.
- One message == one mailbox on non-Gmail servers; our externalId
  `mailbox:uidvalidity:uid` is already per-mailbox, so no dedupe is needed
  outside the Gmail case.

Sources: RFC 6154; imapflow `list()`/`listTree()` docs; Gmail IMAP
extensions (X-GM-MSGID/X-GM-LABELS); imapsync/IMAPdedup duplicate FAQs.

## Decision

Make IMAP a folder-scoped source (`descriptor.folderScope: true`) using the
EXISTING contract (`manageFolders`, `FolderPickerSpec`, `folderRoots`,
`archiveRefs`) — no core engine, store, IPC or renderer changes. The
Tracked folders card, the Manage folders flow, the reconcile allowance and
the legacy-undeclared rule all come for free.

### Scope model

- `config.folderRoots: {id, name}[]`; `id` = the mailbox PATH as LIST
  returns it (INBOX normalised to `INBOX`), `name` = the path for display.
- **Special folders** — Trash, Junk, Drafts — are recognised by SPECIAL-USE
  (`\Trash \Junk \Drafts`) OR by name (mirroring `SENT_NAMES`: Trash,
  Deleted Items/Messages, Junk, Spam, Bulk Mail, Drafts). They are NEVER part
  of the folder tree and never covered by a parent root. Trash and Junk are
  offered as separate top-level OPT-IN rows ("Trash", "Junk"); Drafts is
  never synced. This is the only way to represent the opt-in with the
  picker's covering-root semantics (contracts.ts:483; the renderer shows a
  covered descendant checked-but-inert).
- **Two picker shapes, one resolver:**
  - *All-Mail server* (a `\All` mailbox exists — Gmail): the picker offers
    exactly `All Mail` (required) + the Trash/Junk opt-ins, mirroring the
    Gmail source's bucket model (gmail-source.ts:117). Label folders are
    not offered, so the Gmail duplicate case cannot be selected.
  - *Folder server* (everything else): the real mailbox tree (via
    `delimiter`/`parentPath`) minus special folders, + the Trash/Junk
    opt-ins. A root covers its SUBTREE: a mailbox is in scope when its path
    equals a root id or starts with `rootId + delimiter`.
- Never synced: `\Noselect` / `\NonExistent` mailboxes (a `\Noselect`
  parent is shown in the tree as a container and, as a root, covers its
  children).
- **Defaults** (connect, and the legacy picker preselection): today's
  `resolveMailboxes` paths, plus the `\Archive` special-use mailbox when
  there is no `\All`. NOTE: on `INBOX.`-namespace servers (Courier/cPanel)
  the `INBOX` root therefore covers every user folder (minus specials) —
  that is intended; indexing filed mail is the point of this change.
- **Legacy accounts** (no `folderRoots` key — every existing IMAP account):
  resolution is EXACTLY today's `resolveMailboxes`. Consequence, stated
  plainly: flipping `folderScope: true` makes them *undeclared*, and engine
  §5.3 then SKIPS reconcile for them until the user's first Save — upstream
  deletions stop being archived for those accounts until then (unlike MS365,
  legacy IMAP did reconcile). Accepted under the no-backward-compat rule;
  the Tracked folders card already reads "Default folders — Manage to
  change" for them (TrackedFolders.tsx:299).
- A root whose path no longer exists resolves to nothing (no throw). An
  empty resolved set makes pull/reconcile throw as today (reconcile can
  never mass-archive off an empty listing).
- Every document is stamped `scopeRootId` = the root that covers its
  mailbox (message AND attachments), so the store's folder-scoped
  "unattributed row" warning (write-tx.ts:615) never fires. Stamps are
  bookkeeping only; archiving uses `archiveRefs`.

One pure module, `scope.ts`, owns: `rootsOf(config)` (null = undeclared),
`isSpecial(folder)`, `resolveScopedMailboxes(folders, roots|null)` →
`{path, rootId}[]`, `defaultRoots(folders)`, `pickerModel(folders)`
(roots/children/expand). `pull`, `reconcile`, `connect` and `manageFolders`
all call `resolveScopedMailboxes`; nothing else decides which mailboxes are
synced.

`client.ts#listFolders` additionally returns `delimiter` and `parentPath`
(already on imapflow's ListResponse); `flags` already carries
`\noselect`/`\nonexistent`.

### connect()

NO picker (both reviews, blocking): IMAP has no `reauthenticate`, so
Reconnect after an expired app-password runs `connect()` again; a picker
there sets `usedPicker` and bypasses the engine's scope-preservation guard
(engine.ts:857-876), resetting the user's selection while the cursor
survives. Like Gmail, connect writes `folderRoots = defaultRoots(folders)`;
the engine then preserves an existing account's scope (or its legacy
absence) on re-add/reconnect. Manage folders is the only picker entry.

### manageFolders(session, channel)

1. Connect with stored credentials, list folders once, close BEFORE the
   picker opens; no network after it.
2. Picker (`purpose:'manage'`, `multiSelect`): the model above; preselected
   = current roots (legacy: the defaults), `expand` = their ancestors,
   `note` = "Mail in folders you untick is removed from kia."
3. Validate: at least one non-special root (All Mail on an All-Mail
   server), else throw a user-facing error; nothing is written.
4. `before` = keys of the cursor; `after` = resolve(next roots) paths.
   `removed = before \ after`.
5. `archiveRefs` = for each removed mailbox, its cursor generation
   `uidValidity × 1..lastUid` as `email.message` refs (the same cleanup
   `syncMailboxOnce` already does on a UIDVALIDITY reset; unknown refs are
   ignored; attachments cascade with their parent). Cursor-derived, not
   `listUids`, so mail indexed and since moved out of the folder is covered
   too, and Save cannot fail on a second connection.
6. Return `{config: {...config, folderRoots}, cursor: cursor minus removed
   entries, archiveScopeRootIds: [], archiveRefs}`. `res.archived > 0` earns
   the engine's `full` reconcile allowance as intended.

### pull()

- Mailboxes come from `resolveScopedMailboxes`, and each item carries its
  `rootId` for the stamp.
- The live loop re-LISTs folders every 15 polls (~15 min) and re-resolves:
  a newly created subfolder under a ticked folder is picked up; a mailbox
  that disappeared upstream simply stops being polled (reconcile archives
  its mail).
- A mailbox with NO cursor entry on a returning account (newly ticked or
  newly discovered) syncs with phase `backfill` and
  `estimateTotal = status.exists`, so the import shows progress.

### reconcile()

Lists only `resolveScopedMailboxes` mailboxes. For declared accounts,
anything outside the scope not archived at Save is caught here under the
normal breaker.

## Out of scope

- X-GM-MSGID dedupe (All-Mail servers are offered All Mail + opt-ins only,
  so overlapping labels cannot be selected).
- Per-folder counts in the picker (`count` omitted — STATUS per node is slow
  on big servers).
- Renamed folders: a renamed ticked folder drops out of scope (its mail is
  reconciled away) — same as local-folder paths. Not worth a rename tracker.
- UI changes: none; Tracked folders + picker are generic.

## Tests (named requirements)

1. Legacy config (no `folderRoots`) resolves byte-for-byte as
   `resolveMailboxes` today — same list, same order.
2. Root covers its subtree using each mailbox's delimiter (`/` and `.`);
   `INBOX` matching is case-insensitive.
3. Special folders (by SPECIAL-USE and by name) never appear in the tree,
   are never covered by a parent root, and are synced only when their
   top-level opt-in row is ticked; Drafts never.
4. All-Mail server: picker roots are exactly All Mail + Trash/Junk opt-ins;
   no label folders.
5. `\Noselect` parent as a root covers its children and is never itself
   `status`-ed; `\NonExistent` never appears.
6. Root path that no longer exists → excluded, no throw; all roots gone →
   pull and reconcile throw.
7. manageFolders narrowing → `archiveRefs` = the removed mailboxes' cursor
   generations (uidValidity × 1..lastUid); cursor drops exactly those
   entries; no network call after the picker resolves.
8. manageFolders widening → no `archiveRefs`; next pull syncs the new
   mailbox with phase `backfill` and an estimate.
9. manageFolders legacy account → picker preselects the defaults.
10. connect → no picker; `folderRoots` = defaults.
11. Live loop re-LIST: a subfolder created under a ticked root after the
    session started is synced within the refresh interval.
12. Every emitted document (message + attachments) carries `scopeRootId` =
    the covering root.
13. Reconcile yields refs only for resolved mailboxes.
