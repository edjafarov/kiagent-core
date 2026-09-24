# Mail folder scope — Microsoft 365 folders and Gmail Trash/Spam

Status: DRAFT r6 (r0–r5 reviewed by fable + codex astra; dispositions in §7–§12)
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
- `manageFolders` and `reconcile` are both proxied to marketplace connectors (`source-proxy.ts:328,342`). google-docs implements `reconcile`; OneDrive implements `manageFolders` and has no `reconcile`.
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
- Thread metadata holds the union of labels, so a bucket change need NOT change the hash (A on message 1 + B unlabelled → B also trashed: same union). Attachment metadata holds no labels.

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

**Principles.**
- Selection scopes enumeration and retention.
- The content hash sees scope: folder membership is document metadata, so a move always re-emits, re-stamps and revives.
- Narrowing is archived **exactly at Save**, in core's transaction, from a list the connector computes.
- `reconcile` removes mail that leaves scope *without* a Save (deletions and moves), under the platform's normal safeguards.
- No watched folders, no message→conversation map, no per-message body filtering.

### 3.1 Selection
- `descriptor.folderScope = true`. `config.folderRoots: FolderRootSelection[]` with `id` = Graph folder id and `name` = `displayName` (display only).
- A selected folder covers its subtree. The **tracked set** = selected roots plus all descendants.
- **Discovery** runs at the start of every pull, every reconcile and every `manageFolders`: a fully paginated `childFolders` walk with no cap. If it fails, that operation fails: no archiving, no cursor change.
- **Picker:**
  - One mode, "Mail folders". `roots` = `/me/mailFolders` (paginated, non-hidden, `searchfolders` excluded). `children` = `childFolders`.
  - No `count`: Graph's `totalItemCount` is not the subtree count the picker contract expects.
  - `selected` = current roots. `expand` = ancestor ids from `parentFolderId`.
  - Junk Email is labelled "Junk Email (may contain phishing)".
- **New accounts:** `connect()` writes Inbox, Sent Items and Archive (ids resolved from well-known names). There is no picker at connect.
- **Legacy accounts** (config without `folderRoots`) behave exactly as today until the user first saves a selection:
  - enumeration: Inbox + Sent Items. Covering semantics now include their subfolders; this is the one intentional widening.
  - retention: **everything already indexed**. Reconcile is not run for a legacy account (§3.3, §5.3). Like the legacy connector, nothing is ever removed except via the existing zero-message deletion path. Users who "process" mail by deleting or archiving keep what they have, and there is no new listing cost.
  - The card shows "Default folders — Manage to change" (§5.2). The picker pre-selects Inbox + Sent Items.

### 3.2 Pull
- **Cursor v2:**
  ```
  { v:2, phase:'enumerate'|'ingest'|'live',
    folders: Record<folderId, FolderState>,
    pending: string[], total?: number,
    retry: Array<{ id: string, n: number }> }
  ```
  - A legacy cursor maps its `inbox`/`sentitems` keys to resolved ids in every phase, keeping `next`/`delta` links, `pending` and `total`. No re-download.
- **Every pull:** discovery. Tracked folders with no state get `{next: initialDeltaUrl(id)}`, and states of untracked folders are dropped.
  - New folders enumerate inside `live` before the delta sweep, and their conversationIds join `pending`. This covers widening, new subfolders and folders moved into the subtree.
  - The existing `enumerate` phase covers first backfill.
- `accumulate` loses the junk/deleted exclusion and the `isDraft` skip; eligibility is folder membership only.
- **Emission gate:** every fetched conversation, whether from pending, retry or delta, is emitted only if at least one message's `parentFolderId` is in the **retention set**. Otherwise it is a deletion. A stale queue entry therefore cannot resurrect excluded mail.
  - Retention set = tracked set; for legacy accounts, the gate is today's rule (emit any non-empty conversation).
  - `CONV_SELECT` already includes `parentFolderId`.
- The document gains `metadata.folders` = sorted unique `parentFolderId`s of its messages, so a move between folders changes the hash (§3.3 relies on this).
  - `scopeRootId` = the first root in config order that covers any member folder. It is informational: MS365 never archives by stamp.
- **Retry:** a non-auth conversation fetch failure goes into `retry` with its count, committed with the batch.
  - `retry` is attempted first on every pull and is never dropped or evicted (no cap). Above 1 000 entries a `warn` is logged each pull; ids are ~100 bytes, so the cursor stays small in any realistic failure mode.
  - From 5 consecutive failures, the id is logged at `warn` each pull.
- Expired delta (410) keeps today's 14-day re-prime. Reconcile covers removals during the gap; old mail moved *into* scope during the gap is not re-found (pre-existing, unchanged).

### 3.3 Reconcile
- `reconcile()` = discovery, then page `messages?$select=conversationId&$top=1000` for every folder in the tracked set. Not run for legacy accounts (see below). It yields `{externalId: conversationId, type:'email.thread'}`. This is the complete identity set: the connector emits no children.
- It archives hard deletions, and moves out of the tracked set (e.g. to untracked Deleted Items or custom folders, or a folder moved out of the subtree), with no Save involved.
- **Race** (astra r1-2): a thread moves Inbox→Sent while the listing runs, so it may be listed in neither folder and gets archived.
  - The move is also a delta event in Sent, so pull re-fetches the thread.
  - Its `metadata.folders` changed, so the upsert is not skipped, and upserting an archived row revives it.
  - If pull processed the move *before* the reconcile diff, its emit has seq > `startSeq`, and the TOCTOU guard excludes it.
  - Either way the thread ends live.
- **Guarantee, stated narrowly.** Graph listings are not snapshots. A user moving the same conversation *back and forth* between tracked folders during the seconds a listing runs (astra r2-2 round trip) can end up with a live, in-scope thread archived. It reappears when the conversation next changes: a new message or move goes delta → re-fetch → revive. Until then it is unsearchable, but it is not lost (archived rows keep content for the 30-day purge window). The design accepts this window rather than adding a revive-on-listing platform rule. A one-way move is fully covered by the argument above and pinned by tests.
- **Legacy accounts** have no reconcile until their first Save. Core skips `reconcile` for a `folderScope` account whose config declares no scope at all, meaning neither `folderRoots` nor a legacy mirror key (`roots`, `paths`) (§5.3). An account with no declared scope has nothing to reconcile against. There is no connector-side signalling, and no error on the account.
- Safeguards are the platform's, unchanged: an empty listing or a >50% shrink is refused and surfaced on the account. Mass deletion upstream is rare, and the refusal message's "re-save settings" escape hatch applies.
- Runs every pull, as for every reconcile connector. Cost ≈ Σ over tracked folders of max(1, ⌈messages/1000⌉) requests plus one discovery walk; per pass the request count is logged. Example: a 100 000-message tracked set is ~100 requests per 15-min tick, ~9 600/day, well inside Graph's per-mailbox limits. A cadence knob is deferred until measured.

### 3.4 manageFolders
- Discovery for the prior and new selections.
- Then list conversationIds for (prior tracked set) \ (new tracked set) = `leaving`, and for the new tracked set = `staying`. This is the same paged `$select=conversationId` listing, and the card shows its normal "Saving…" meanwhile.
- **Guarantee, stated narrowly:** exact relative to those two listings. A user bulk-moving mail between a removed and a kept folder during the seconds of the Save listing can leave some removed mail live. That is a leak, never a loss. Reconcile removes it on a later pass. If the breaker refuses that pass, the refusal message's "re-save settings" now works: saving an unchanged selection grants the one-shot allowance (§5.7).
- Returns `archiveRefs = leaving \ staying` (conversation refs), `archiveScopeRootIds: []` and the cursor with removed folders' states dropped.
  - Core applies `archiveRefs` in the scope transaction (§5.1). Mixed threads (Inbox + Sent, Inbox removed) are in `staying` and are never archived.
  - A thread that moves between listing and commit is repaired by the §3.3 race argument.
- Pure widening skips the listing: `leaving` is empty.
- Coverage uses the whole new selection. Root order: retained roots in prior order, then new ones.
- **A legacy account's first Save** does no `leaving` listing. It returns `archiveRefs: []`, and core grants the one-shot reconcile allowance because the save *declares scope for the first time* (§5.7).
  - `applyScope` restarts the loop immediately. That first reconcile lists the new tracked set through the existing staged, memory-bounded reconcile machinery, and archives exactly *indexed − staying*, including conversations deleted upstream.
  - If that pass is lost (crash, abort, failed discovery), a later pass may be refused by the breaker; re-saving the unchanged selection re-grants the allowance (§5.7).
  - The picker shows, **before submission**, the note "Mail outside the selected folders will be removed from the index" (a new optional `FolderPickerSpec.note`, §5.4). MS365 sets it on every manage picker.
  - No count is shown: an upstream count includes never-indexed mail.

## 4. Gmail design (core)

**Principle: a thread has exactly one bucket; the bucket is its stamp AND part of its hash.**

- **Buckets**, as pseudo-folders in the same picker (one mode, no children):
  - `mail` "All mail — Inbox, Sent, archived and labelled"
  - `TRASH` "Trash"
  - `SPAM` "Spam (may contain phishing)"
  - `mail` is always selected; `manageFolders` rejects a selection without it.
- **Thread bucket:** `mail` if any message has neither TRASH nor SPAM; else `TRASH` if any message has TRASH; else `SPAM`.
  - Drafts and chats carry neither label, so they count as `mail`.
  - A thread is in scope if its bucket is selected. The document is the whole thread, as today.
- **Bucket is hashed:** thread metadata and every attachment child's metadata gain `scopeBucket`, and all carry `scopeRootId` = bucket.
  - A bucket change is therefore always a content change: it re-stamps thread and children, and archive-by-stamp is exact.
  - A legacy row (NULL stamp, no `scopeBucket`) is re-stamped the first time it is re-emitted. Every widening task re-emits every thread it lists, so legacy trash is stamped before a later narrowing can rely on it.
- **Out of scope ⇒ deletion** of the thread ref plus the attachment refs built from the fetched thread (same builder as `toDocument`). The 404 path is unchanged (pre-existing: it cannot name children).
- **Product decision (not the user's words):** with the default `[mail]`, a thread whose every message is in Trash is deleted from the index immediately. Today it lingers until Gmail's 30-day purge. Trashing one message of a multi-message thread keeps the thread.
- **Query rule:**
  - default `[mail]` → today's call
  - any optional bucket selected → `includeSpamTrash=true` with no `q`, classified locally
  - No negative filters: a message may carry both SPAM and TRASH.
- **Cursor:**
  ```
  { historyId, tasks: Array<{ q: string|null, includeSpamTrash: boolean, pageToken: string|null }> }
  ```
  - Legacy `{mode:'backfill', pageToken, historyId}` → `{historyId, tasks:[{q:null, includeSpamTrash:false, pageToken}]}`. Legacy `{mode:'delta', historyId}` → `{historyId, tasks:[]}`.
  - Pull drains tasks in order. A page's items and the advanced `pageToken` commit together, and the final page's batch removes the task in the same commit. Then one history sweep runs from `historyId`.
  - `historyId` is captured only when a cursor is created from `null`; widening never recaptures it.
  - **Widening** appends `{q:'in:trash'|'in:spam', includeSpamTrash:true, pageToken:null}` and keeps unfinished tasks.
  - **Narrowing** drops queued tasks for the removed bucket, and `archiveScopeRootIds` = removed buckets.
- **Config:** `connect()` writes `folderRoots:[{id:'mail', name:'All mail'}]`. No `folderRoots` reads as `[mail]`, and the card shows default text (§5.2).
- `readMessageEvidence` is unchanged; whole-thread semantics make it consistent with the body.

## 5. Core changes

1. **`FolderScopeUpdate.archiveRefs?: ExternalRef[]`.** `store.applyFolderScope` archives each ref (existing `archiveByRef`) in the same transaction, after `reattributeScopeRoots` and alongside `archiveScopeRootIds`.
   - `res.archived` counts them, so a narrowing that archives grants the one-shot reconcile allowance exactly as C-35 intends.
   - Contract doc: a removed root must be covered by `archiveScopeRootIds`, `reattributeScopeRoots`, **or** by refs the source lists in `archiveRefs` (computed by listing what leaves).
   - `res.archived` counts rows actually archived (non-null `archiveByRef` returns, distinct rows), so duplicate refs and refs overlapping an archived stamp count once. Applied after `reattributeScopeRoots`. The existing reattribute/archive contradiction guard stays.
2. **Default roots on the card.** `TrackedFolders` renders an empty `folderRoots` on a `folderScope` source as "Default folders — Manage to change".
3. **No reconcile without declared scope.** The engine skips `reconcilePass` for an account whose source has `descriptor.folderScope` and whose config has none of `folderRoots` (array), `roots`, `paths`. Drive accounts created by the packaged Drive 2.1.6 connector carry `roots` without `folderRoots` (seen in a real DB checkpoint), so they keep reconciling. Only a scope-less MS365 legacy account is skipped.
4. **`FolderPickerSpec.note?: string`**, rendered as one muted line above the picker's Save button.
5. **Gmail** per §4.
6. SDK 1.5.0 carries `archiveRefs` and `note`. MS365 v2.1.0 ships on SDK 1.5.0 with engine `^2.4.0`, since `archiveRefs` must be honoured. Gmail ships with the same core release.
7. **Allowance rule in `applyScope`** (extends C-35, never relaxes it for widening). The one-shot reconcile allowance is granted when any of these holds:
   - (a) `res.archived > 0` (today's rule)
   - (b) the prior config declared no scope, i.e. first declaration
   - (c) the new root id set equals the prior one, i.e. an explicit re-save, which is the action the breaker's refusal message asks for

   A pure widening (new ⊋ prior) still grants nothing.

   **Allowances (b) and (c) are ratio-only.** They bypass the >50% shrink check but **never** the empty-listing refusal (`listedCount === 0`). Only (a), whose archival already happened in the Save transaction, keeps today's full bypass.
   - A lost staging table (DB-worker restart, `engine.test.ts` lost-listing case) diffs as `listedCount 0`, so it is still refused under (b) or (c).
   - A discovery or listing failure throws before the diff.
   - So a routine unchanged Save can authorise a large *verified* shrink but can never archive a corpus off an empty or broken listing.
   - Cost: a tracked set that is genuinely empty upstream (the user selected only empty folders) cannot clean up via reconcile. That case is visible as the refusal on the card and is accepted.

   Implementation: `reconcileAllowances` holds a kind (`'full' | 'ratio'`), and `reconcilePass` takes it instead of a boolean.
8. **Reconcile staging continuity** (closes a pre-existing hole that any allowance widens).
   - Today `reconcileStage`/`reconcileDiff`/`reconcileArchive` call `ensureListingTable()` (`write-tx.ts:893-925`), which silently **recreates** the connection-scoped TEMP table after a DB-worker restart. A pass that loses its first N pages and stages the rest therefore diffs as a small, non-empty listing.
   - Fix: `reconcileBegin` creates the table and a TEMP marker row `(account_id, pass_id)` and returns `pass_id`. `reconcileStage`, `reconcileDiff` and `reconcileArchive` take `pass_id` and **throw `ReconcileStagingLost`** when the marker is missing; they never recreate. `reconcilePass` treats that throw like a listing failure: no diff, no archive, error logged.
   - With continuity guaranteed, a listing that reaches the diff is complete, so every allowance kind is safe against lost staging.
   - Regression tests: restart between two stage batches under each allowance kind (`full`, `ratio`, none) → nothing archived.

Dropped from r1: the id-difference allowance heuristic (replaced by `archiveRefs` + the explicit rule in §5.7) and `reconcileEvery` (unmeasured cost; per-pull reconcile as for every other connector).

## 6. Tests that pin behaviour

**MS365:**
- Discovery:
  - picks up a new subfolder
  - a folder moved out of the subtree is dropped
  - failure → pull, reconcile and `manageFolders` fail without side effects
- Emission gate:
  - a pending id whose messages all left the retention set → deletion, not emit
  - a legacy account keeps a thread whose messages all moved to Deleted Items (no reconcile runs)
- `metadata.folders`: moving a message Inbox→Archive changes the hash
- Race:
  - thread archived by reconcile, then the Sent delta re-fetch → revived
  - move emitted before the diff → excluded by `startSeq`
- `manageFolders`:
  - removing Inbox with an Inbox+Sent thread → not in `archiveRefs`
  - an Inbox-only thread → in `archiveRefs`
  - pure widening → no listing, `archiveRefs` empty
  - legacy first Save → `archiveRefs: []`, allowance granted (core), and the next reconcile archives indexed − staying, including upstream-deleted conversations
  - the note is visible in the modal before Save, through the child → proxy → broker → renderer path (an end-to-end test over the real serializers, not just "set")
- Retry:
  - failure → id in `retry` with the batch
  - success later → emitted
  - never dropped or evicted
- Legacy cursor, every phase → v2 with the same links, pending and total.
- `connect()` writes Inbox, Sent Items, Archive.

**Gmail:**
- Bucket: all-trash → TRASH; one live message → mail; SPAM+TRASH on one message → TRASH; drafts/chats → mail.
- Same label union, different bucket → hash differs.
- Attachments carry `scopeBucket` and the stamp.
- Default selection:
  - fully trashed thread → deletion of thread + attachment refs
  - one message trashed → kept
- `[mail, TRASH]`:
  - trashed thread live, thread + attachments stamped TRASH
  - narrowing archives exactly those
- Legacy NULL-stamped trash thread → stamped by the widening task.
- Widening mid-backfill keeps the old task; `historyId` unchanged.
- Legacy cursor mappings.
- A selection without `mail` is rejected.

**Core:**
- `archiveRefs` archived in the scope transaction.
- `res.archived` counts them and the allowance follows.
- The contract/SDK carries the field.
- Card default text.
- Allowance: granted on (a), (b) and (c), and not on a pure widening.
- (b) and (c) under a lost staging table or an empty listing → refused, nothing archived (reuse the lost-listing regression test).
- (b) and (c) with a complete >50% shrink → archived.
- Skip rule: MS365 legacy account skipped; Drive account with only `roots` still reconciles.

## 7. Review dispositions (r0)

| # | Finding | Disposition |
|---|---|---|
| fable 2 / astra 1 | Legacy NULL-stamped rows escape scope | MS365: stamps never drive archiving (`archiveRefs` + reconcile). Gmail: `scopeBucket` hashed; legacy rows re-stamped on re-emit (§4). |
| fable 3 | Per-message body filtering over-engineered | Adopted: whole-conversation documents. |
| astra 2 | Archive-at-save strands mixed threads | MS365 `archiveRefs` = leaving \ staying; Gmail one bucket per thread. |
| astra 3 / Q4 | Moves and hard deletes leak | Reconcile over the retention set; `metadata.folders` keeps moves safe. |
| astra 4 | Gmail attachments survive | Attachments stamped + hashed with the bucket; deletions carry attachment refs. |
| astra 5 | Expired cursors miss exits | MS365 reconcile. Gmail history-expiry gap is pre-existing, not touched by this work. |
| astra 6 | Failed fetches consumed | Durable `retry`, never dropped. |
| astra 7 / Q5 | Gmail widening overwrites work | Task queue; `historyId` never recaptured. |
| astra 8 / Q1 | Unchanged rows never re-stamp | Membership (MS365) and bucket (Gmail) are in hashed metadata. |
| astra 9 | Topology changes, 500 cap | Full pagination, fail closed, reconcile covers exits. |
| astra 10–14 | Evidence, drafts, compat, ancestor replacement, count | Whole-thread semantics; container rule; intentional changes stated; whole-selection coverage; `count` omitted. |
| fable 4, 5, 6, 8 | Trash attribution, `mail` deselect, Archive default, query table | Product decision stated; rejected; new-account default includes Archive; simplified further in r2. |

## 8. Review dispositions (r1)

| # | Finding | Disposition |
|---|---|---|
| fable 2 | Upgrade archives delete-to-process users' corpus | Legacy retention = whole mailbox until first Save (§3.1); the first Save shows the count. |
| fable 3 | Drop `reconcileEvery` | Dropped. |
| fable 4 | Allowance rule | Replaced by `archiveRefs`; allowance follows `res.archived` as today. |
| astra r1-1 | Label union ≠ bucket; attachments unlabelled | `scopeBucket` in thread and attachment metadata. |
| astra r1-2 | Concurrent reconcile archives a moved thread | `metadata.folders` makes the move a content change → revive or TOCTOU exclusion (§3.3). |
| astra r1-3 | Allowance not durable or success-sensitive | No longer relied on: narrowing is archived in the Save transaction. |
| astra r1-4 | Root-id subtraction heuristic | Removed. |
| astra r1-5 | Reconcile breaker blocks legitimate bulk removal | Platform behaviour shared by every reconcile connector; scope edits no longer depend on it. Accepted. |
| astra r1-6 | Queues resurrect excluded conversations | Emission gate on retention-set membership. |
| astra r1-7 | Legacy Gmail NULL stamps | Hashed bucket → widening re-stamps every listed thread. |
| astra r1-8 | Attachment refs on deletion | Built from the fetched thread; the 404 path is pre-existing and unchanged. |
| astra r1-9 | Negative query filters drop overlapping labels | No `q` when an optional bucket is selected; classify locally. |
| astra r1-10 | Five-strike drop loses work | Never dropped, no eviction (r3). |
| astra r1-11 | Legacy drafts not re-enumerated | Accepted: drafts live in Drafts, which legacy never tracked; a draft in Inbox/Sent pre-upgrade is not back-filled. Its conversation body already includes it (whole-conversation fetch). |
| astra r1-12 | Contract says every removed root must be listed | Contract gains the `archiveRefs` clause (§5.1). OneDrive reference corrected (§2). |

## 9. Review dispositions (r2)

| # | Finding | Disposition |
|---|---|---|
| fable r2-3 | Drop `metadata.folders` from the hash | **Declined.** Revival is hash-independent only for rows already archived. The case that needs the hash is a move processed by pull *before* the reconcile diff: with an unchanged hash the upsert is skipped, the row keeps its old seq and the diff archives it with nothing left to revive it. Cost accepted: a move within tracked folders is a feed "updated" event. |
| fable r2-2 | Legacy cost, count wording | Legacy has no reconcile at all; no count shown. |
| astra r2-1 | Legacy whole-mailbox reconcile can archive with no revive path | Legacy accounts do not reconcile until their first Save (§3.3, §5.3). |
| astra r2-2 | Round-trip move during a listing | Guarantee narrowed and documented, with its recovery path (§3.3). One-way move covered and tested. |
| astra r2-3 | Save listings are not a snapshot | Guarantee narrowed: exact relative to the listings; a concurrent bulk move leaks (never loses) until reconcile (§3.4). |
| astra r2-4 | Warning not visible before submit; count inaccurate | `FolderPickerSpec.note` before submission; no count. |
| astra r2-5 | Legacy cost | Gone (no legacy reconcile); tracked-set cost formula documented. |
| astra r1-10 (re-check) | Retry eviction | No cap, no eviction; warn above 1 000. |
| astra (archiveRefs notes) | Count semantics, ordering | Specified in §5.1. |

## 10. Review dispositions (r3)

| # | Finding | Disposition |
|---|---|---|
| astra r3-1 | Skip rule disables Drive reconcile (`roots` without `folderRoots`) | Rule narrowed to "no `folderRoots`, `roots` or `paths`" (§5.3), plus a Drive regression test. |
| astra r3-2 | First Save computes U−S, not I−S | First Save lists nothing; the allowance plus the next reconcile archive exactly I−S (§3.4). |
| astra r3-3 | "Re-save settings" unreachable | Unchanged re-save grants the allowance (§5.7c); the refusal message becomes true for folder-scoped accounts. |
| astra r3-4 | Whole-mailbox `archiveRefs` unbounded | Gone: legacy cleanup goes through the staged reconcile. Ordinary narrowing lists only removed folders (bounded by what the user unticked). |
| astra r3-5 | Note test | End-to-end over the real serializers. |

## 11. Review dispositions (r4)

| # | Finding | Disposition |
|---|---|---|
| astra r4-1 | (b)/(c) bypass the empty-listing guard → lost staging archives the corpus | (b)/(c) are ratio-only allowances; the empty-listing refusal stays armed; tests on the lost-listing path (§5.7). |
| astra r4 (consumption timing) | Allowance spent at pass start | Not a blocker per reviewer; recovery = unchanged re-save, now valid. |

## 12. Review dispositions (r5)

| # | Finding | Disposition |
|---|---|---|
| astra r5-1 | Partial staging loss, restaged tail → ratio allowance archives the corpus | Staging continuity (§5.8): the staging functions throw on a missing pass marker and never recreate. |
| astra r5-2 | (a) full bypass + lost staging | Same fix: a lost staging table can no longer reach the diff under any allowance. (a) keeps its full bypass (today's C-35 semantics), which is now safe. |
