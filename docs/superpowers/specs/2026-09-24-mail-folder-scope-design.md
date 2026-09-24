# Mail folder scope — Microsoft 365 folders and Gmail Trash/Spam

Status: DRAFT r0 (for fable + codex astra review)
Date: 2026-09-24

## 1. What the user asked for

> "I would like … inside running extension to be able to use checkboxes to specify getting data from these folders too, also other special folder if there are those … its about microsoft 365 … and gmail deleted/trash archived"

- **Microsoft 365:** on a connected account, a checkbox list of Outlook mail folders decides what is indexed. That includes the special folders (Archive, Deleted Items, Junk Email, Drafts, Conversation History …) and the user's own folders and subfolders.
- **Gmail:** the same control for Trash and Spam. Archived mail (not in the Inbox) is already indexed. `threads.list` with no `labelIds` returns everything except SPAM/TRASH, and that stays the default.
- Existing accounts keep indexing exactly what they index today. No re-download on upgrade.

Non-goals:
- Gmail per-label or per-category selection (Promotions, Social …). The request names only deleted, trash and archived.
- Exchange Online Archive *mailbox* (a separate mailbox, not the `archive` folder).
- Calendar, contacts and OneNote.
- A new settings surface in core.

## 2. What exists (verified 2026-09-24)

**Core already ships the whole UI and commit path for per-account folder scope.** OneDrive and Google Drive use it.

- `SourceDescriptor.folderScope: true` enables the **Tracked folders** card (`src/renderer/screens/Sources/sections/TrackedFolders.tsx`) and `accounts:start-manage-folders`.
- `Source.manageFolders(session, FolderSelectionChannel)` opens the shared checkbox tree picker (`pickFolders(FolderPickerSpec)`: modes, `roots`, `children`, `count`, `selected`, `expand`, `purpose:'manage'`). It returns a `FolderScopeUpdate {config: {folderRoots}, cursor, archiveScopeRootIds, reattributeScopeRoots?}`.
  - Core's `engine.applyScope` quiesces the account and commits config, cursor and archival in ONE transaction (`store.applyFolderScope`).
  - An empty root set is refused.
- It is proxied to out-of-process marketplace connectors: `source-proxy.ts:342`, `extension-host-entry.ts:538`. SDK generated contracts carry `manageFolders`/`FolderScopeUpdate`/`scopeRootId`.
- `DocumentInput.scopeRootId` stamps each document with the root that brought it in. Archival is by `scope_root_id IN (…)`, never set-difference (R8/A-1).
- A later upsert of an archived row revives it (`write-tx.ts:325`, `archived_at=NULL`), with no re-download.

**Microsoft 365 connector today** (`kia-plugins/ms365-kia-connector` v2.0.6, SDK 1.3.0):
- It walks `/me/mailFolders/{inbox|sentitems}/messages/delta` only (`MAIL_FOLDERS` const). Graph message delta is **per folder, not recursive**, so Inbox subfolders, Archive and custom folders are never indexed.
- `accumulate` skips `isDraft` and messages parented in junk/deleted.
- It ingests per conversation via `/me/messages?$filter=conversationId eq …`, which returns messages from **every** folder, including Deleted Items and Junk. A thread's document can therefore contain a reply the user deleted.
- `@removed` delta entries carry only `id` (no `conversationId`), so `accumulate` drops them. A message moved or deleted out of Inbox never updates its thread.
- Cursor: `{phase, folders: Record<'inbox'|'sentitems', FolderState>, pending?, total?}`.

**Graph facts** (learn.microsoft.com, mailFolder / message-delta / mailFolder-delta):
- Well-known names are locale-independent: archive, clutter, conflicts, conversationhistory, deleteditems, drafts, inbox, junkemail, localfailures, msgfolderroot, outbox, recoverableitemsdeletions, scheduled, searchfolders, sentitems, serverfailures, syncissues.
- `GET /me/mailFolders` lists top-level non-hidden folders (`includeHiddenFolders=true` for hidden ones). `/{id}/childFolders` lists children. Each folder has `displayName`, `parentFolderId`, `childFolderCount`, `totalItemCount`.
- Message delta: `$select`, `$top`, `$filter=receivedDateTime ge|gt`. A message deleted or moved out of the folder yields `@removed {reason:'deleted'}`. Works for personal (MSA) accounts per folder.
- `Mail.Read` (already granted) covers all of this.

**Gmail today** (core `src/main/sources/gmail`):
- `threads.list` (no labelIds, `includeSpamTrash` default false), then `history.list` sweeps. A thread 404 is a deletion.
- A thread trashed *after* indexing is re-fetched with 200 and stays live, now carrying the TRASH label. Only expunged threads archive. Today's behaviour on Trash is therefore inconsistent: new trash is never indexed, old mail that gets trashed is kept.
- API: `threads.list` `labelIds` are AND semantics, `q` takes search syntax (`in:trash`, `-in:spam`), and `includeSpamTrash` exists. `history.list` accepts a single `labelId` and does not filter spam/trash. Labels live on messages; a thread's labels are the union.

## 3. Design

### 3.1 One model for both: roots + a recheck pass

Both sources become `folderScope` sources. Each document is stamped with a `scopeRootId`, and a thread may draw messages from several roots. Every source follows the same four rules:

1. **Membership is per message.** A message is *in scope* when its container (Outlook folder / Gmail bucket) is covered by a selected root. A thread document contains only in-scope messages. A thread with zero in-scope messages is a **deletion**.
2. **Stamp** = the first selected root, in config order, that covers any in-scope message of the thread. It is deterministic and re-derived on every emit.
3. **Narrowing (roots removed)** in `manageFolders`:
   - `archiveScopeRootIds` = the removed roots that no retained root covers.
   - `reattributeScopeRoots` = removed roots covered by a retained ancestor (MS365 only; Gmail buckets never nest).
   - The returned cursor carries `recheck: [removed container ids]`.
   - On its next pull the source lists the thread ids that have messages in those containers (ids only), re-fetches each and applies rule 1. Threads still in scope elsewhere are re-emitted: the upsert revives and re-stamps the row and drops the removed folder's messages from the body. The rest stay archived.
   - Cost is proportional to the removed folders' size, not the mailbox.
   - A multi-folder thread (Inbox + Sent, stamped Inbox, user removes Inbox) is unsearchable for one pull at most.
4. **Widening (roots added):** `archiveScopeRootIds = []`. The cursor adds initial delta/list state for the new containers. The next pull enumerates them and ingests their threads, and rule 2 re-stamps any that were already indexed.

### 3.2 Microsoft 365 (connector repo, SDK 1.4.0, no core change)

- `descriptor.folderScope = true`. `config.folderRoots: FolderRootSelection[]` with `id` = Graph folder id and `name` = `displayName` (display only).
- **Default roots** = Inbox + Sent Items (well-known names resolved to ids). `connect()` writes them and does NOT open the picker: sign-in stays one step, and the card is where scope is edited.
  - A legacy account (no `folderRoots`, legacy cursor) is migrated lazily: it counts as default roots, and the legacy cursor's `inbox`/`sentitems` delta links are re-keyed by resolved id. No re-download.
  - The Tracked folders card reads `config.folderRoots`, so the first pull after upgrade must also persist the default roots (see open question Q3).
- **Picker:** one mode `Mail folders`.
  - `roots()` = `GET /me/mailFolders?$top=100` (top level, non-hidden). `children(id)` = `childFolders`. `count(id)` = `totalItemCount`, which is free and already in the listing.
  - `selected` = current roots. `expand` = ancestors of selected roots (from `parentFolderId`).
  - `searchfolders` is excluded (virtual views, no messages of their own). Outbox is listed.
- **Covering semantics:** a selected folder covers its subtree. The tracked-folder set = selected roots plus all descendants, re-listed at the start of each pull with a recursive `childFolders` walk, capped at 500 folders with a logged warning. A new subfolder appears automatically on the next tick and gets an initial delta.
- **Cursor v2:**
  ```
  { v: 2, phase, folders: Record<folderId, FolderState>, pending?, total?, recheck?: folderId[] }
  ```
  Per folder the delta is keyed by id. Folders that left the tracked set drop their state.
- **Ingest:** `fetchConversationMessages` stays, then filters by `parentFolderId ∈ tracked`.
  - Drafts: a message in Drafts is in scope only when Drafts is tracked. This replaces the `isDraft` skip, since drafts live in Drafts.
  - Deleted Items and Junk become ordinary selectable folders. `resolveExcludedFolderIds` goes.
- **Moves out of a tracked folder** (`@removed` has no conversationId):
  - Deleted Items and Junk Email are always *watched*: their delta runs even when not selected, `$select=conversationId`, used only to find conversations to re-fetch, never to ingest their messages.
  - Delete-to-trash and mark-as-junk (the common moves) therefore re-render or delete the thread within one tick.
  - A move into another untracked custom folder leaves the thread stale until it next changes. This is a documented limit (Q4).
- **Tick cost:** one delta request per tracked folder plus the two watched folders, plus one `childFolders` walk. For typical mailboxes (<50 folders) that is fine at 15 min.

### 3.3 Gmail (core, `src/main/sources/gmail`)

- `descriptor.folderScope = true`. Buckets are pseudo-folders in the same picker, with no children:
  - `mail` = "All mail (Inbox, Sent, archived and labelled mail)"
  - `TRASH` = "Trash"
  - `SPAM` = "Spam"
  - Default `[mail]`.
- **Message bucket:** TRASH if it has label TRASH, else SPAM if it has SPAM, else `mail`.
- **Backfill query** is derived from the selection:

  | Selected | Query |
  |---|---|
  | `mail` only | today's call (no flags) |
  | `mail` + `TRASH` | `includeSpamTrash=true&q=-in:spam` |
  | `mail` + `SPAM` | `includeSpamTrash=true&q=-in:trash` |
  | all three | `includeSpamTrash=true` |
  | `TRASH` only | `q=in:trash&includeSpamTrash=true` |
  | `SPAM` only | `q=in:spam&includeSpamTrash=true` |
  | `TRASH` + `SPAM` | `q=in:trash OR in:spam` + `includeSpamTrash=true` |

- **Delta:** `history.list` unchanged. Re-fetched threads go through rule 1.
  - **Behaviour change, intended:** with the default selection, trashing a thread now archives it.
  - This fixes the inconsistency above and matches "deleted/trash archived".
- **Recheck** for a removed bucket = `threads.list q=in:trash` (or `in:spam`), ids only, then re-fetch.
- **Cursor:** gains an optional `recheck?: ('TRASH'|'SPAM'|'mail')[]` and `q` stays derivable from config.
  - A widening save resets to a *scoped* backfill of just the added buckets: `{mode:'backfill', pageToken:null, q:<added-only query>, historyId: current}`.
  - This happens while delta continues from the kept historyId (Q5).
- Existing accounts: missing `folderRoots` reads as `[mail]`. A core store migration writes `folderRoots:[{id:'mail',…}]` for every gmail account, so the card renders (append-only migration, Q3).

### 3.4 Release

- MS365: connector v2.1.0 on SDK 1.4.0, engine `^2.3.0`. Marketplace update BEFORE restart; invalid extensions silently drop.
- Gmail: core minor release, then an alpha-cent `core.lock` bump.
- Independent; either can ship first.

## 4. Tests that pin behaviour

- MS365:
  - conversation with messages in Inbox + Deleted Items, only Inbox tracked → body excludes the deleted message
  - all messages move to Deleted Items → deletion within one tick via the watched folder
  - narrowing Inbox with a thread in Inbox + Sent → archived at save, revived and re-stamped `sentitems` after the recheck pull, body without Inbox messages
  - widening adds Archive → its threads ingest and existing ones re-stamp by config order
  - new subfolder under a tracked root appears → initial delta next tick
  - legacy cursor → v2 with the same delta links, zero re-enumeration
  - Drafts untracked → draft excluded; tracked → included
- Gmail:
  - default selection + thread trashed after index → deletion
  - `mail+TRASH` → trashed thread live, stamped TRASH when all its messages are trashed
  - partial trash inside a thread → body excludes the trashed message under default
  - backfill query table (each row)
  - removing TRASH → archive TRASH-stamped threads, recheck re-renders mail-stamped threads that contained trashed messages

## 5. Open questions for review

- **Q1.** Is rule 2 (stamp = first covering root in config order) sound given `hashSkip`-style skips? MS365 and Gmail do not `hashSkip`: every re-fetched thread is re-emitted, so a re-stamp always lands. Confirm.
- **Q2.** Is "archive at save, revive on recheck" acceptable, or should narrowing archive nothing and let the recheck pull emit deletions (no gap, but removed mail stays searchable until the next pull)?
- **Q3.** Legacy accounts: a lazy default in the source vs a core migration writing `folderRoots`. MS365 is a marketplace connector and cannot run a core migration; it could persist roots only through `manageFolders` or connect. Does the card need a fallback, or should `pull` be allowed to return a config patch?
- **Q4.** Moves into untracked custom folders: accept staleness, or watch every folder's delta (cost = folder count per tick)?
- **Q5.** Gmail widening: scoped backfill of added buckets while keeping the delta watermark. Is a second cursor field cleaner than reusing `mode:'backfill'`?
- **Q6.** Should MS365 `connect()` show the picker (like local-folder) instead of defaulting silently?
