# Mail folder scope — Microsoft 365 folders and Gmail Trash/Spam

Status: DRAFT r1 (r0 reviewed by fable + codex astra, both NOT SATISFIED; dispositions in §7)
Date: 2026-09-24

## 1. What the user asked for

> "I would like … inside running extension to be able to use checkboxes to specify getting data from these folders too, also other special folder if there are those … its about microsoft 365 … and gmail deleted/trash archived"

- **Microsoft 365:** on a connected account, a checkbox tree of Outlook mail folders decides what is indexed. This covers the special folders (Archive, Deleted Items, Junk Email, Drafts, Conversation History …) plus the user's own folders and subfolders.
- **Gmail:** checkboxes for **Trash** and **Spam**. Archived Gmail mail (not in the Inbox) is already indexed, because `threads.list` without `labelIds` returns everything except SPAM/TRASH. It stays included.

Non-goals:
- Gmail per-label or per-category selection.
- The Exchange Online Archive *mailbox*.
- Calendar and contacts.
- Any new settings surface.
- Per-message filtering inside a thread: a thread document is the whole conversation, as today.

## 2. What exists (verified 2026-09-24)

**Core ships the checkbox UI and the atomic scope commit.** OneDrive and Google Drive use it today.
- `SourceDescriptor.folderScope` enables the **Tracked folders** card (`TrackedFolders.tsx`) and `accounts:start-manage-folders`.
- `Source.manageFolders(session, FolderSelectionChannel)` opens the shared tree picker (`pickFolders`: modes, roots, children, count, selected, expand). It returns `FolderScopeUpdate {config.folderRoots, cursor, archiveScopeRootIds, reattributeScopeRoots?}`.
- `engine.applyScope` quiesces the account, commits config, cursor and archival in one transaction (`store.applyFolderScope`), and restarts the loop. An empty root set is refused.
- `Source.reconcile()` is a full listing of upstream refs. The engine diffs it against live docs and archives the unlisted ones. It runs concurrently with every pull and has a `startSeq` TOCTOU guard.
  - A mass-archive breaker refuses an empty listing, or one that shrinks >50% (above a minimum), unless the one-shot `reconcileAllowances` is set.
  - `applyScope` sets the allowance only when `res.archived > 0` (C-35).
- `manageFolders` and `reconcile` are both proxied to marketplace connectors (`source-proxy.ts:328,342`). google-docs and OneDrive already implement them.
- Upsert: a live row with an unchanged content hash is skipped, including its scope stamp. Otherwise `scope_root_id = COALESCE(new, old)` and `archived_at = NULL`, so re-emitting revives. `contentHash` covers title, markdown, url, metadata and createdAt (`write-tx.ts:26,300`).
- Folder-scoped accounts committing a doc without `scopeRootId` only log a warn (`write-tx.ts:568`).

**Microsoft 365 connector** (v2.0.6):
- It walks message delta for `inbox` and `sentitems` only. Delta is per folder and not recursive, so subfolders, Archive and custom folders are never indexed.
- It ingests a conversation via mailbox-wide `/me/messages?$filter=conversationId eq …`.
- `@removed` entries carry only an id and are dropped.
- It has no `reconcile`, so deleted or moved mail stays indexed.
- Failed conversation fetches are logged and dropped from the queue.
- It emits one document type (`email.thread`, externalId = conversationId) and no children.

**Gmail** (core):
- `threads.list` backfill (spam/trash excluded), then `history.list` sweeps.
- A thread that 404s becomes a deletion. A thread trashed after indexing stays live with a TRASH label.
- It emits a thread doc plus attachment child docs.
- Metadata includes the union of labels, so any label change alters the hash.

**APIs** (learn.microsoft.com; developers.google.com):
- Graph:
  - Well-known folder names are locale-independent (archive, deleteditems, drafts, inbox, junkemail, sentitems, conversationhistory, …).
  - `GET /me/mailFolders` lists top level; `/{id}/childFolders` lists children. Both are paginated.
  - Message delta is per folder. A move out yields `@removed`.
  - `GET /me/mailFolders/{id}/messages?$select=conversationId&$top=1000` lists ids cheaply.
  - `Mail.Read` covers all of it.
- Gmail:
  - `threads.list` takes `q` (search syntax: `in:trash`, `in:spam`) and `includeSpamTrash`.
  - `history.list` has a single optional `labelId` and does not exclude spam/trash.
  - Labels live on messages, and a thread's labels are their union.

## 3. Microsoft 365 design (connector repo, SDK 1.4.0)

**Principle: selection scopes enumeration; `reconcile` is the authority on removal.** No watched folders, no message→conversation map, no per-message body filtering.

### 3.1 Selection
- `descriptor.folderScope = true`. `config.folderRoots: FolderRootSelection[]` with `id` = Graph folder id and `name` = `displayName` (display only).
- A selected folder covers its subtree. The **tracked set** = selected roots plus all descendants.
- **Discovery** runs at the start of every pull and every reconcile: a fully paginated `childFolders` walk (no cap).
  - If discovery fails, the pull and reconcile fail for this tick; nothing is archived off a partial set.
  - The tracked set is recorded in the cursor (`folders` keys).
- **Picker:**
  - One mode, "Mail folders". `roots` = `/me/mailFolders` (paginated, non-hidden, `searchfolders` excluded). `children` = `childFolders`. No `count`: Graph's `totalItemCount` is not a subtree count, and the picker contract expects one.
  - `selected` = current roots. `expand` = ancestor ids from `parentFolderId`.
  - Junk Email is labelled "Junk Email (may contain phishing)".
- **Defaults:**
  - New accounts: `connect()` writes Inbox, Sent Items and Archive, with ids resolved from the well-known names. The picker does not open at connect, so sign-in stays one step.
  - Legacy accounts (config without `folderRoots`) read as Inbox + Sent Items.
- **Intentional change on upgrade:** Inbox and Sent subfolders become tracked, because covering semantics now apply.

### 3.2 Pull
- **Cursor v2:**
  ```
  { v:2, phase:'enumerate'|'ingest'|'live',
    folders: Record<folderId, FolderState>,
    pending: string[], total?: number,
    retry: Array<{id: string, n: number}> }
  ```
  - A legacy cursor maps `inbox`/`sentitems` keys to their resolved ids, keeping the delta links. No re-download.
- **Every pull:** discovery. Tracked folders with no state get `{next: initialDeltaUrl(id)}`. States of untracked folders are dropped.
- **Enumeration** of new folders runs inside `live` before the delta sweep. Their conversationIds join `pending`. This is how widening, new subfolders and folders moved into the subtree get ingested. The existing `enumerate` phase covers first backfill.
- `accumulate` loses the junk/deleted exclusion and the `isDraft` skip. A folder is in scope if selected, and drafts in a tracked folder count.
  - Ingest keeps the whole-conversation fetch (today's body semantics).
  - The doc gets `scopeRootId` = the first root in config order that covers the folder the conversation was enumerated from. The stamp is informational only (§3.4); it exists to satisfy R5.
- **No dropped work:** a non-auth conversation fetch failure moves the id into `retry`, committed with the batch.
  - `retry` is drained first on the next pull.
  - An id that fails 5 consecutive pulls is logged and dropped. Its thread stays at its last indexed version; if it is gone upstream, reconcile archives it.
- Expired delta (410) keeps today's 14-day re-prime for adds. Reconcile covers removals, so the gap only affects old mail moved in during the outage.

### 3.3 Reconcile
- `reconcile()` = discovery, then for each tracked folder, page `messages?$select=conversationId&$top=1000`. It yields `{externalId: conversationId, type:'email.thread'}`, deduplicated per page run. This is the complete identity set, since the connector emits no children.
- A thread with at least one message in a tracked folder stays. Everything else archives on the next reconcile:
  - hard deletions
  - moves to untracked folders (Deleted Items, Junk, custom)
  - deselected folders
  - folders moved out of the subtree
  - legacy unstamped rows
- Cost: one request per 1000 messages in tracked folders per reconcile. Throttled by §5.2 to once per 6 h, plus immediately after a scope save.

### 3.4 manageFolders
- It returns `archiveScopeRootIds: []` always.
  - Stamps cannot see mixed conversations (Inbox + Sent), so archive-by-stamp would archive in-scope threads that nothing revives.
  - Reconcile is exact and runs right after the save (§5.1/5.2).
  - Removed mail stays searchable for at most one reconcile pass: seconds after Save on a running account; on a paused account, until resume.
- The cursor transform drops removed folders' states. Added roots get their states on the next pull's discovery.
- Coverage uses the whole new selection (OneDrive C-46 addendum). Root order: retained roots in prior order, then new ones.

## 4. Gmail design (core)

**Principle: a thread has exactly one bucket; the bucket is its stamp.** Because the bucket is a function of the thread and labels are in the hash, a bucket change always re-emits and re-stamps. That makes archive-by-stamp exact, and Gmail needs no reconcile.

- **Buckets**, as pseudo-folders in the same picker (one mode, no children):
  - `mail` "All mail — Inbox, Sent, archived and labelled"
  - `TRASH` "Trash"
  - `SPAM` "Spam (may contain phishing)"
  - `mail` is always selected. `manageFolders` rejects a selection without it: removing it would archive the mailbox, and unticking All mail is not what the user asked for.
- **Thread bucket:** `mail` if any message has neither TRASH nor SPAM; else `TRASH` if any message has TRASH; else `SPAM`.
  - A thread is in scope if its bucket is selected. The document is the whole thread, as today.
  - The thread and all its attachment children carry `scopeRootId` = bucket.
- **Product decision (not the user's words):** with the default `[mail]`, a thread whose every message is in Trash becomes a **deletion** of the thread and its attachment refs. Today such a thread lingers until Gmail purges it after 30 days, then 404s into a deletion anyway, so this makes deletion immediate. Trashing one message of a multi-message thread keeps the thread (bucket stays `mail`).
- **Query rule (compositional):**
  - default `[mail]` → today's call, unchanged
  - otherwise `includeSpamTrash=true`, plus `q=-in:spam` when SPAM is not selected, or `q=-in:trash` when TRASH is not selected
  - Each thread is classified client-side by bucket regardless of query, so the query only saves fetches.
- **Cursor:**
  ```
  { historyId, tasks: Array<{ q: string|null, includeSpamTrash: boolean, pageToken: string|null }> }
  ```
  - The legacy `{mode:'backfill',…}` maps to one task. `{mode:'delta'}` maps to `tasks: []`.
  - Pull drains tasks in order (page tokens checkpointed per page as today), then runs one history sweep from `historyId`. `historyId` is captured when the first task is created and never moved forward past unfinished tasks.
  - **Widening** (adding TRASH or SPAM) appends a task (`in:trash` or `in:spam`, `includeSpamTrash=true`) and keeps any unfinished tasks.
  - **Narrowing** removes queued tasks for the removed bucket, and `archiveScopeRootIds` = the removed buckets, which archives threads and attachments exactly.
- **Legacy rows** (NULL stamp) are all bucket `mail` or trashed-after-index.
  - `mail` rows never need archiving by stamp, since `mail` can't be removed.
  - Trashed-after-index rows are re-emitted or deleted the next time history touches them, and are otherwise purged via the 30-day 404 path.
  - No migration of document rows.
- **Config:** `connect()` writes `folderRoots:[{id:'mail',…}]`. Existing accounts with no `folderRoots` read as `[mail]` (see §5.3 for the card).
- `readMessageEvidence` is unchanged; the whole-thread model makes it consistent with the indexed body.

## 5. Core changes

1. **Reconcile allowance on narrowing.** `applyScope` grants `reconcileAllowances` when the save removes ≥1 root (prior `folderRoots` ids minus new), not only when `res.archived > 0`.
   - C-35's concern, pure widening disarming the empty-listing guard, still holds: a widening removes nothing.
   - Without this, MS365's `archiveScopeRootIds: []` narrowing trips the >50% breaker.
2. **Reconcile cadence.** Add optional `SourceDescriptor.reconcileEvery?: Cadence`.
   - The engine runs a reconcile when none has completed within that cadence (in-memory, per account) or an allowance is pending.
   - Absent means every pull, as today.
   - MS365 sets `{every:'6h'}`.
3. **Default roots on the card.** `TrackedFolders` renders an empty `folderRoots` on a `folderScope` source as "Default folders — Manage to change". `manageFolders` pre-selects the source's resolved defaults, and the first Save persists them.
4. **Gmail** per §4.
5. Contracts regenerate into SDK 1.5.0. MS365 needs `reconcileEvery`, so it ships on SDK 1.5.0 and engine `^2.4.0`.

## 6. Tests that pin behaviour

**MS365:**
- Discovery:
  - picks up a new subfolder, which gets initial delta and its threads ingest
  - a folder moved out of the subtree drops its state, and reconcile no longer lists its conversations
  - a failed discovery fails the pull and reconcile without archiving
- Reconcile:
  - lists a conversation with Inbox + Sent messages once
  - conversation only in Deleted Items → unlisted when Deleted Items is untracked, listed when tracked
- manageFolders:
  - removing Inbox → `archiveScopeRootIds: []`
  - dropped folder states
  - allowance granted (core test)
- Retry:
  - fetch failure → id in `retry` committed with batch, succeeds next pull
  - 5 failures → dropped with log
- Legacy cursor → v2 with the same delta links and no enumeration.
- New account connect writes Inbox, Sent Items, Archive.

**Gmail:**
- Bucket function: all-trash → TRASH; one live message → mail; spam+trash → TRASH.
- Default selection:
  - thread fully trashed after index → deletion of the thread and its attachment refs
  - one message trashed → thread kept
- Selections `[mail, TRASH]`:
  - trashed thread live, stamped TRASH, attachments stamped TRASH
  - narrowing to `[mail]` archives exactly those
- Widening during an unfinished backfill keeps the old task and appends the new one; `historyId` unchanged.
- The query rule for each selection.
- `manageFolders` rejects a selection without `mail`.

**Core:**
- Allowance on root removal with `res.archived = 0`, no allowance on pure widening.
- `reconcileEvery` skip and run.
- Card default text.

## 7. Review dispositions (r0)

| # | Finding | Disposition |
|---|---|---|
| fable 2 / astra 1 | Legacy NULL-stamped rows escape scope | MS365: reconcile is authoritative and stamp-independent. Gmail: legacy rows are bucket `mail` (never removable) or trashed-after-index (history/404 path). |
| fable 3 | Per-message body filtering over-engineered | Adopted: whole-conversation documents, no watched folders. |
| astra 2 | Archive-at-save can strand mixed threads | MS365 archives nothing at save; reconcile decides. Gmail buckets are per thread, so a mixed thread is impossible. |
| astra 3 / Q4 | Moves and hard deletes leak | Reconcile listing of tracked folders. |
| astra 4 | Gmail attachments survive | Attachments stamped with the thread bucket; deletions include attachment refs. |
| astra 5 | Expired cursors miss exits | MS365: reconcile covers removals. Gmail 404-expiry gap is pre-existing and unchanged by this work → follow-up (not in scope). |
| astra 6 | Failed fetches consumed | `retry` list in cursor, 5-strike drop. |
| astra 7 / Q5 | Gmail widening overwrites work | Task queue + fixed `historyId`. |
| astra 8 / Q1 | Unchanged rows never re-stamp | MS365 stamps are informational only. Gmail: the bucket is derived from labels, which are in the hash, so a bucket change is a content change. |
| astra 9 | Topology changes, 500 cap | Full pagination, fail closed, reconcile covers exits. |
| astra 10 | Evidence endpoint bypasses filtering | Moot under whole-thread semantics. |
| astra 11 | Drafts rule | Pure container scope. |
| astra 12 | Compat claim false | Stated as an intentional change (§3.1). |
| astra 13 | Ancestor replacement | Coverage against the whole new selection (MS365 archives nothing at save anyway). |
| astra 14 | Folder count | `count` omitted. |
| fable 4 | Trash-deletion attribution | Recorded as a product decision (§4). |
| fable 5 | Gmail `mail` deselectable | Rejected by `manageFolders`. |
| fable 6 | Archive in the default | New MS365 accounts default to Inbox, Sent Items, Archive. |
| fable 8 | Gmail query table | Compositional rule. |
| Q2 | Archive at save vs later | MS365: later, by reconcile (seconds, allowance-gated). Gmail: at save, exact. |
| Q3 | Legacy config | Source default plus card text; first Save persists. |
| Q6 | Picker at connect | No. |
