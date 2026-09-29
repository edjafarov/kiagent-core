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
- A root covers its SUBTREE: a mailbox is in scope when its path equals a
  root id or starts with `rootId + delimiter`. New subfolders the user
  creates later under a ticked folder are picked up automatically.
- Never synced even inside a ticked subtree: `\Noselect`, `\NonExistent`,
  and `\Trash` / `\Junk` / `\Drafts` UNLESS that exact mailbox is itself a
  root (explicit opt-in, like Gmail's Trash/Spam buckets).
- Gmail rule: if an in-scope mailbox carries `\All`, the resolved set is
  that `\All` mailbox plus any explicitly-rooted `\Trash`/`\Junk`; every
  other in-scope mailbox is dropped (it is a label view of All Mail).
- No `folderRoots` key (every existing account = legacy/undeclared):
  resolution is EXACTLY today's `resolveMailboxes`. Engine §5.3 already
  skips reconcile for an undeclared folder-scoped account until its first
  Save; that is the accepted MS365 precedent.
- Default selection (connect, and the legacy picker's preselection): today's
  `resolveMailboxes` paths, plus the `\Archive` special-use mailbox when
  there is no `\All`.
- A root whose path no longer exists resolves to nothing (no throw). If the
  whole resolved set is empty, pull/reconcile throw as today (so reconcile
  can never mass-archive off an empty listing).

One pure module, `scope.ts`, owns: `rootsOf(config)` (null = undeclared),
`resolveScopedMailboxes(folders, roots|null)`, `defaultRoots(folders)`,
`pickerTree(folders)` (roots/children/expand). `pull`, `reconcile`,
`connect` and `manageFolders` all call `resolveScopedMailboxes`; nothing
else decides which mailboxes are synced.

`client.ts#listFolders` additionally returns `delimiter` and `parentPath`
(already on imapflow's ListResponse); `flags` already carries
`\noselect`/`\nonexistent`.

### connect()

After the credential check (the client is closed first — the picker can sit
open for minutes), open `auth.pickFolders({purpose:'connect', …})` with the
defaults preselected and their ancestors in `expand`, tree callbacks served
from the one folder list already fetched. Store `folderRoots` from the
answer. Cancelling the picker cancels the connect (same as local-folder).

### manageFolders(session, channel)

1. Connect with stored credentials, list folders once, close before the
   picker opens.
2. Picker: `purpose:'manage'`, preselected = current roots (legacy: the
   defaults), `expand` = their ancestors, `note` = "Mail in folders you
   untick is removed from kia. Trash, Junk and Drafts inside a ticked folder
   are skipped unless you tick them on their own."
3. `before` = resolve(prev roots | legacy) ∪ keys of the cursor;
   `after` = resolve(next roots). `removed = before \ after`.
4. For each removed mailbox: if it still exists, reconnect and `listUids`
   + `status` → `archiveRefs` with `buildExternalId(path, uidValidity, uid)`,
   type `email.message` (attachments cascade — the store archives live
   children with their parent). If it no longer exists, use the cursor
   entry's `uidValidity` × `1..lastUid` (unknown refs are ignored).
5. Return `{config: {...config, folderRoots}, cursor: cursor minus removed
   entries, archiveScopeRootIds: [], archiveRefs}`. IMAP documents carry no
   `scope_root_id`; archiveRefs is the exact per-document mechanism the
   contract provides for this (as MS365 uses it). `res.archived > 0` then
   earns the engine's `full` reconcile allowance, as intended.
6. Empty picker answer or empty `after` → throw a user-facing error; nothing
   is written.

### pull()

Unchanged except: mailboxes come from `resolveScopedMailboxes`; and a
mailbox with NO cursor entry on a returning account (a newly ticked folder)
syncs with phase `backfill` and `estimateTotal = status.exists`, so the
progress bar shows its import instead of a silent "live" ingest. Cursor
entries for mailboxes no longer resolved are left alone (manageFolders
already removed the ones the user unticked).

### reconcile()

Lists only `resolveScopedMailboxes` mailboxes. (Engine skips it for legacy
accounts; for declared accounts, anything outside the scope that was not
archived at Save is caught here, under the normal breaker.)

## Out of scope

- X-GM-MSGID dedupe (the `\All` rule removes the Gmail duplication case).
- Per-folder counts in the picker (`count` omitted — STATUS per node is slow
  on big servers).
- Renamed folders: a renamed ticked folder drops out of scope (its mail is
  reconciled away) — same as local-folder paths. Not worth a rename tracker.
- UI changes: none; Tracked folders + picker are generic.

## Tests (named requirements)

1. Legacy config (no `folderRoots`) resolves byte-for-byte as
   `resolveMailboxes` today — same list, same order.
2. Root covers its subtree using each mailbox's delimiter (`/` and `.`);
   `INBOX` root matching is case-insensitive.
3. `\Trash`/`\Junk`/`\Drafts` inside a ticked subtree are skipped; ticked
   on their own they are synced.
4. Gmail `\All` rule: All Mail + label folders ticked → only All Mail
   (+ explicitly ticked Spam/Trash).
5. `\Noselect` parent as a root covers its children and is never itself
   `status`-ed; `\NonExistent` never appears.
6. Root path that no longer exists → excluded, no throw; all roots gone →
   pull and reconcile throw (no empty listing).
7. manageFolders narrowing → `archiveRefs` = exactly the removed mailboxes'
   present UIDs; cursor drops exactly those entries; config carries the new
   roots.
8. manageFolders widening → no `archiveRefs`; next pull syncs the new
   mailbox with phase `backfill`.
9. manageFolders on a legacy account → picker preselects the defaults.
10. connect → picker opens with defaults preselected and `expand` =
    their ancestors; `folderRoots` stored; cancel rejects connect.
11. Reconcile yields refs only for resolved mailboxes.
