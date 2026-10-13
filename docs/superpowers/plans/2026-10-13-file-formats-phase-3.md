# File formats Phase 3 — Outlook PST Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local `.pst` becomes a container whose email messages are child documents. The work is paged in the converter child and resumes by folder NID plus child index.

**Architecture:** This is a fifth container kind, `pst`, in the Phase 2 framework. The changes:

- A new pager `containers/pst.ts` (pure, runs in the converter child) and a `pst` case in `expandPage`.
- Policy v5 admits `.pst` for the local profile only.
- The source admits a `.pst` only when it starts with the `!BDN` magic.
- The expansion records gain two rules: a 10-minute quiet period, and a busy deferral.

The store, engine and cloud are unchanged.

**Tech Stack:** `pst-extractor` 1.12.0 (MIT, pure JS, synchronous `fs.readSync` on the path), mailparser-free rendering through the existing `renderMail`, `htmlToMarkdown` and `rtfToText`.

**Spec:** `docs/superpowers/specs/2026-10-13-file-formats-batch-design.md` §B4, plus §B3 (records, driving) and the re-enumeration section.

## Spike result (2026-10-13, gate for this phase — PASSED)

The spike ran under Electron 42 as node, with `scratchpad/pstspike/spike.cjs`.

**Real 2 GB PST** (Enron `zl_dasovich-j_000.pst`, CC-BY-3.0, sha256 `9b6aaee9…87cb`):
- 33,422 messages and 12,123 attachments (names only) walked in **15 s**.
- **Peak RSS 174 MB** (bar 400).
- Open takes 8 ms and a reopen 1 ms, so **no handle cache between pages is needed**.
- Resume works: in a fresh `PSTFile`, `new PSTFolder(pst, pst.getDescriptorIndexNode(Long.fromNumber(nid)))` + `moveChildCursorTo(i)` returned exactly the next message (21 ms, in a 12,514-message folder).

**Outlook-written `.ost`** (pst-extractor's MIT test data, 16 MB, 2.1 MB gzipped):
- Bodies: 21 HTML-only, 25 RTF-only, 1 empty. This covers every body kind the Enron PST lacks (all plain text there).
- Folders contain `IPM.Appointment` and `IPM.Schedule.Meeting.*` items next to `IPM.Note`.
- Search folders (`Finder/Reminders`) enumerate no children, and no message NID appears in two folders.

Open questions the spike settles:
- **Outlook holding the file open:** this cannot be tested on macOS (no Outlook). The spec rule stands: `EBUSY`/`EPERM`/`EACCES` on open → a busy deferral.
- **Logic Pro presets also use `.pst`** (`/Library/Application Support/Logic/Plug-In Settings/**/*.pst`, found on this Mac). Hence the magic sniff.

## Global Constraints

- The local profile only; the cloud profile never admits `.pst`.
- `FILE_POLICY_VERSION = 5`; `ADMITTED_SINCE[5] = new Set(['pst'])`.
- `EXPANDER_VERSION.pst = 1`.
- Children are messages only (spec B4). An item is a message when its `messageClass` starts with `IPM.Note` or `IPM.Schedule.Meeting` (case-insensitive). That excludes appointments, contacts, tasks and sticky notes.
- Child key `pst:<message NID>`, so the externalId is `<absPath>#pst:<NID>`. NIDs are stable inside a file, so a re-expansion un-archives the same ids.
- Child shape = the mbox child shape (IMAP metadata + `extractMessageEvidence` + the `isAutomatedMessage` skip), plus `metadata.folder` (the folder path below the root, joined with ` / `).
- A locked PST (`EBUSY`/`EPERM`/`EACCES` when opening): keep `resume`, count no attempt, set `notBefore = now + 5 min`.
- Quiet period: a `pst` record does no work until `now − mtimeMs ≥ 10 min`. Its existing children stay live until the full path actually starts.
- No new store/engine change. No commits with Co-Authored-By. Jest runs one at a time.

## Review Focus

1. **A Logic/other non-PST `.pst`** must never become a container row or a "Could not read this file" document. It is ignored like any unknown binary. Test: a `.pst` with random bytes → no item, no record.
2. **Outlook writing the PST while we read** (desktop Outlook keeps an open PST and rewrites it continuously). The quiet period plus the stamp check in `expansionStep` (which already exists) must restart rather than page a mixed file. Test: mtime newer than 10 min → no step work; changed mid-expansion → full path.
3. **Resume after a child crash or timeout:** the NID+index `resume` must be JSON-plain (numbers/strings only) and must not depend on any in-child cache. Test: drain page by page through `expandPage` with a fresh call each time (items 7), and compare with a one-shot drain (same keys, same order, no duplicates).
4. **An Exchange (`EX`) sender address** (`/O=ENRON/OU=...`) must not become the `from` address. Test: `fromOf` prefers the SMTP address from the transport headers, then `sentRepresentingEmailAddress` when it contains `@`, otherwise the display name only.
5. **A busy file on Windows** must not burn attempts or mark the PST failed. Test: an open that throws `{code:'EBUSY'}` → `ContainerBusyError`, the record is deferred 5 min with `attempts` unchanged.

---

### Task 1: PST pager

**Files:**
- Create: `src/main/core/converter/containers/pst.ts`
- Modify: `src/main/core/converter/containers/types.ts` (`ContainerKind` + `'pst'`, `EXPANDER_VERSION.pst = 1`, `containerKindOf` `.pst`, `ChildItem.key` doc)
- Modify: `src/main/core/converter/containers/index.ts` (the `case 'pst'` branch)
- Create: `src/main/core/converter/__tests__/fixtures/containers/outlook-sample.pst.gz` (pst-extractor's `pstextractortest@outlook.com.ost`, MIT; gzipped, 2.1 MB; `.gitattributes` binary)
- Test: `src/main/core/converter/__tests__/containers-pst.test.ts`
- Deps: `pst-extractor@1.12.0` in the root `package.json` `dependencies` and in `release/app/package.json`, next to `yauzl`.

**Interfaces:**
- Produces: `expandPst(path, resume: PstResume | null, budget): Promise<ExpandResult>`; `class ContainerBusyError extends Error { name = 'ContainerBusyError' }` (exported from `containers/types.ts`, so main can test `e.name` without importing the pager).
- `PstResume = { folders: { nid: number; path: string }[]; fi: number; child: number; count: number; skipped: number; first: string | null; last: string | null; byFolder: Record<string, number> }`. `folders` is the DFS order, computed on the first page (at most `MAX_PST_FOLDERS = 10_000`; past that the walk stops and the summary says so). `fi` is the index of the current folder, and `child` the cursor inside it.

Steps:
- [ ] Write the failing tests (the fixture gunzipped into a tmp dir as `sample.pst`):
  - A one-shot drain (budget items 10_000) yields exactly the messages: count = the number of `IPM.Note*` + `IPM.Schedule.Meeting*` items. No `IPM.Appointment` titles appear; every key matches `/^pst:\d+$/`; keys are unique.
  - Body kinds: an HTML-only message renders as markdown with no `<p>` or `<html>` tags, and an RTF-only message renders as text with no `{\rtf`.
  - `metadata.folder` is `'Inbox'` for an inbox message (the path below `IPM_SUBTREE`/`Top of Personal Folders`, see `folderLabel`).
  - A paged drain (items 7, a fresh `expandPst` call per page, the resume through `JSON.parse(JSON.stringify(...))`) gives the same keys in the same order as the one-shot drain.
  - The last page has `summary` matching `/^# sample\.pst — \d+ messages/` and lists the top folders. `resume` is null.
  - A file with random bytes throws an `Error` whose message contains `not a PST`. It is not a `ContainerBusyError`.
  - An `fs.openSync` mock throwing `{code:'EBUSY'}` → the call rejects with `name === 'ContainerBusyError'`.
- [ ] Implement `pst.ts`:
  - `open(path)`: `new PSTFile(path)`. It maps `EBUSY`/`EPERM`/`EACCES` to `ContainerBusyError`, and the library's `Invalid file header` to `Error('pst: not a PST file')`.
  - First page: walk the folders DFS from `getRootFolder()`, collecting `{nid: f.descriptorNodeId.toNumber(), path}` for folders with `contentCount > 0`.
  - Each page: for `folders[fi]`, build `new PSTFolder(pst, pst.getDescriptorIndexNode(Long.fromNumber(nid)))`, then `moveChildCursorTo(child)` and `getNextChild()` until the budget runs out (items/bytes/ms, as the mbox pager) or the folder ends (then `fi++`, `child = 0`). `child` advances for every item, kept or not.
  - Children go through `messageChild(m, folderPath)`:
    - Class filter.
    - `fromOf(m)`: transport headers `From:`, then `sentRepresentingEmailAddress` when it contains `@` (with name), then `senderEmailAddress` when it contains `@`, then the name.
    - Recipients from `getRecipient(i)` (`recipientType` 1 → to, 2 → cc; `smtpAddress || emailAddress` when it contains `@`).
    - `date = clientSubmitTime ?? messageDeliveryTime`; `messageId = internetMessageId` without the angle brackets.
    - `isAutomatedMessage(headersOf(transportMessageHeaders), from)` → skip (`skipped++`).
    - Body: `body` → `bodyHTML` via `htmlToMarkdown` → `bodyRTF` via `rtfToText`.
    - Attachment names via `getAttachment(i).longFilename || filename`.
    - `renderMail`, `capMarkdown`, then evidence as in `mbox.ts`.
    - `metadata` = the mbox shape + `folder`. `createdAt = date`.
  - `pst.close()` in `finally` on every page.
  - `folderLabel(path)` drops the leading root segments (`Top of Personal Folders`, `Root - Mailbox`, `IPM_SUBTREE`).
  - The summary: `# <name> — N messages, YYYY–YYYY`, then the top 10 folders by count (`- Inbox — 1,204`).
- [ ] Run: `npx jest --config package.json src/main/core/converter/__tests__/containers-pst.test.ts`. Expected: PASS.
- [ ] Commit `feat(converter): Outlook PST pager — messages by folder NID and index`.

### Task 2: Policy v5, magic sniff, quiet period, busy deferral

**Files:**
- Modify: `src/shared/file-indexability.ts` (`CONTAINER_EXTENSIONS` + `pst`, `FILE_POLICY_VERSION = 5`, `ADMITTED_SINCE[5]`)
- Modify: `src/main/sources/local-folder/scanner.ts`: `containerAt(absPath): Promise<ContainerKind | null>` = `containerOf` + for `pst` read 4 bytes == `!BDN` (else null). `buildItem`'s container branch uses it.
- Modify: `src/main/sources/local-folder/local-folder-source.ts`: the incremental `changed()` container check (line ~417) uses `containerAt`.
- Modify: `src/main/sources/local-folder/expansion.ts`:
  - `fullPath(kind, at, now)`: for `pst` with `now − at.mtimeMs < PST_QUIET_MS` (10 min), set `notBefore = at.mtimeMs + PST_QUIET_MS`. Used by `noteContainer` and `restamped`.
  - In the `expandPage` catch: `e.name === 'ContainerBusyError'` → `{...rec, notBefore: now + PST_BUSY_MS}` (5 min), with no attempt.
- Tests: `src/shared/__tests__/file-indexability*.test.ts` (v5 + local-only), `expansion.test.ts` (quiet period on note and restamp, busy deferral), `local-folder-containers.test.ts` (a random-bytes `.pst` → no item and no record; the sample PST with mtime 11 min old → children with `parent` = the pst and `metadata.folder`; the same file touched now → no children yet, record `notBefore ≈ mtime + 10 min`).

Steps: write the failing tests → implement → run the three suites → commit `feat(local-folder): Outlook PST containers — file policy v5`.

### Task 3: Gates

- [ ] `npm run build:main`. Then a bundled-child run on the 2 GB PST: `expandPage(path,'pst',resume, DEFAULT_EXPAND_BUDGET)` through `release/app/dist/main/worker.js`, page after page, under `ELECTRON_RUN_AS_NODE`. Bar: child peak RSS < 400 MB, every page < 20 s, message count = the spike count minus skips. Record the pages, the time and the peak.
- [ ] Check `release/app` resolves `pst-extractor` (and `long`, `iconv-lite`, `uuid-parse`) from `release/app/node_modules` after `npm i --ignore-scripts` there. The worker must not need the root `node_modules`.
- [ ] Full `npx jest` (note load-only flakes separately), `npm run typecheck`, eslint + prettier on touched files.
- [ ] Final fable + astra review of the Phase 3 diff; one merged fix round.

## Out of scope (say so, do not build)

- `.ost` (Outlook 2013+ offline cache). pst-extractor read the sample, but modern OSTs are often 4K-page or compressed, and Outlook keeps them locked. This becomes a follow-up issue.
- Calendar, contacts and tasks inside a PST (spec B4: messages only in v1).
- PSTs in the cloud, or inside a ZIP (a nested `.pst` member stays name-only).

---

## Design revision r2 (fable + astra design review, 2026-10-13) — OVERRIDES the tasks above

1. **No source-side sniff.**
   - `.pst` is a container by extension (policy), like the other kinds. Delete `containerAt`.
   - The **one** admission check lives in `expansionStep`. For `kind === 'pst'` and `rec.resume === null` (before the deletion batch of a full path, i.e. also on every restart), `probePst(absPath)` opens the file in main and reads 4 bytes:
     - `EBUSY`/`EPERM`/`EACCES` → `{...rec, notBefore: now + 5 min}`. No attempt, `cleared` untouched, so the existing children stay live for the whole Outlook session.
     - Read OK but not `!BDN` → **rejected**: the record becomes `{state:'done', kind:'pst', v, size, mtimeMs, rejected: true}`, and the step yields a deletion of the container ref (it archives any older row and children). It emits no row. A stamp change re-probes it through `noteContainer`'s full path.
     - Other I/O errors → the existing retry (`notBefore + EXPANSION_RETRY_MS`, no attempt).
   - Mid-expansion busy: the pager's `ContainerBusyError` gives the same 5-minute deferral, with no attempt and the resume kept.
   - Tests:
     - EBUSY at the probe on a pending full-path record → deferred, no deletion, `cleared` false.
     - Random bytes → no row and a `rejected` done record. The next pull with the same stamp does nothing.
     - A persisted pending PST replaced by a Logic preset while stopped → rejected, no "Could not read" row.
     - A watcher `change` on a locked, already-noted PST → record kept, no deletion.
2. **Library cursor, not a count.**
   - After every `getNextChild()`, `child = folder.currentEmailIndex`. This reaches into a private field, pinned like the yauzl walk fields: `pst-extractor` exact `1.12.0`, and a test asserts the field exists and moves.
   - Test: stub `PSTUtil.detectAndLoadPSTObject` to throw for one row index, drain with page size 1 → no duplicate keys, and `count` = the one-shot count.
3. **Per-item isolation.**
   - `messageChild` is wrapped per item in try/catch, which counts `skipped` (the library does the same for its own load failures). One corrupt message never fails the archive.
   - A page-level throw (open, folder lookup) still goes through attempts.
4. **Re-stat after the page, success or failure (all kinds).**
   - In `expansionStep`, after `expandPage` returns or throws, `lstat` again. If `changedSince(rec, stats2)`, discard the result or error and return `restamped(rec, stats2)`, with no attempt counted. This covers Outlook writing during a page, including the last one.
   - Test: a converter mock that rewrites the file inside the call, on a middle page and on the final page.
5. **Resume = position, re-walked.**
   - Every page re-walks the folder DFS (measured ~10 ms for 58 folders on the 2 GB file; capped at `MAX_PST_FOLDERS = 2000`, past which the summary says "first 2,000 folders").
   - `PstResume = { fi: number; nid: number; child: number; count: number; skipped: number; first: string|null; last: string|null; byFolder: number[] }` (`byFolder` indexed by `fi`).
   - Same-stamp drift is detected and restarts (`{restart: true}`): `folders[fi].nid !== resume.nid`, the folder lookup throws, or `child > folder.contentCount` on resume. Arbitrary same-stamp edits beyond that are outside the contract; size/mtime + quiet period is the change signal, as for the other kinds.
   - Tests: an emptied folder and a missing NID → restart.
6. **Bounded bodies.**
   - `body`/`bodyHTML` are sliced to `MAX_MESSAGE_BYTES` (8 MB, as mbox) before `htmlToMarkdown`/evidence, marked `truncated`.
   - RTF: read the raw compressed property (`PR_RTF_COMPRESSED` 0x1009) and check the LZFu header's raw size (bytes 4–7) ≤ 8 MB before decompressing. Past that the RTF body is skipped (headers-only child).
   - Folder discovery is counted in the page's `ms` budget (`started` set before the walk).
7. **Addresses.**
   - `isAddr(s) = /^[^\s@<>]+@[^\s@<>]+$/` after trimming. The transport `From:` is unfolded and decoded (mailparser `simpleParser` on the header block only), then used only if its address passes `isAddr`. Otherwise use `sentRepresentingEmailAddress`, then `senderEmailAddress` (each through `isAddr`), else the display name only.
   - Recipients: `smtpAddress`, else `emailAddress`, through `isAddr`. Otherwise keep `displayName` (internal Exchange recipients stay visible in `to`/`cc`).
   - Test: an EX-DN transport header with a valid SMTP property → the property wins; `All Enron Worldwide@ENRON` is not an address.
8. **Quiet period clamp:** `notBefore = min(mtimeMs, now) + 10 min`.
9. **Deps:** `pst-extractor` **exact** `1.12.0` and `long` in the root `package.json` and `release/app/package.json`. The gate checks that the worker resolves both from `release/app/node_modules`.
10. **Gate addition:** the 2 GB run prints every folder where walked < `contentCount`. Any *mail* folder short of its count is investigated (the library's fallback table) before release.
