# File Formats Phase 2b — Containers Inside a ZIP — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A mailbox, vCard file or Evernote export inside a local ZIP (Google Takeout's `All mail Including Spam and Trash.mbox`) is expanded into flat children of the ZIP instead of a name-only member.

**Architecture:** The converter child never copies. When the ZIP pager meets an eligible member it returns a resume with `nested = {member, cd, size, crc32, kind, inner: null, items: 0}` and stops the page. The local-folder source (main process) sees `nested` with no scratch file and runs `extractMember`: a pure, streamed, abortable copy from the ZIP into `<scratchDir>/<name>.part`, counted against the declared size and renamed on completion. Later pages page the scratch file through the ZIP pager, which calls the existing path-based pager and maps inner keys to `zip:<member>#<key>`. When the inner pager finishes, the ZIP walk continues.

The scratch name is derived (`scratchName(zipPath, member, kind)`), never persisted. A `replaceRecord` helper is the single write path for expansion records: it deletes the scratch file whenever a record stops being "pending on that nested member". A directory sweep at `pull()` start is the crash backstop. Separately, the ZIP walk resumes from the central-directory offset instead of re-reading from entry 0. `EXPANDER_VERSION.zip` goes from 1 to 2.

**Tech Stack:** TypeScript, yauzl 2.10, node:fs (`statfs`, streams), Jest.

**Spec:** `docs/superpowers/specs/2026-10-13-file-formats-batch-design.md` (B2 "Mailboxes/vCards/ENEX inside a ZIP", Rollout 2b, Testing "(2b)").

## Global Constraints

- **Design change from the spec, recorded here (fable design review):** the member is extracted by the SOURCE in main, streamed and `session.signal`-abortable, not by the converter child. In the child, a multi-GB copy would exceed the runner's 120 s per-job timeout. Three timeouts would fail the whole ZIP, and the shared one-job converter would be blocked meanwhile. Accepted cost: this account's drive loop stalls once per nested member, for the duration of the copy.
- **Scratch files.**
  - Location: `<userData>/expand-tmp/`, owned by the source.
  - Name: `scratchName(zipPath, member, kind) = sha1(zipPath + '\0' + member) + '.' + kind`.
  - Written as `<name>.part` and renamed to `<name>` on completion. Only the final name is ever paged: `records.ts` reads to EOF, so a partial copy would page as a truncated mailbox marked done.
- **Copy cap.** The cap is the entry's declared `uncompressedSize`, exactly.
  - One byte more means the size is forged: delete `.part` and return `'skip'`.
  - Fewer bytes at stream end means truncated or forged: also `'skip'`.
  - Disk guard: `statfs` must show `bavail * bsize >= 2 * uncompressedSize`, else `'skip'`. This guard is sound only because the cap equals the declared size, so never add slack.
- **Outcomes of `extractMember`.** `'ok'`, `'skip'` (forged, short, ENOSPC, no room), or `'mismatch'`. `'mismatch'` means the entry at `nested.cd` no longer has `nested`'s name, size and crc32, i.e. a different ZIP sits at the path.
  - On `'skip'` the source sets `resume.nested.skip = true`. This is the only place the source writes into the opaque resume. The pager then emits one name-only `file` child for the member, as in phase 2, and continues.
  - On `'mismatch'` the source restarts the record on the full path.
- **Child keys.** `zip:<member>#<inner key>`. Children are flat under the ZIP. The inner pager's `tail` and `summary` are discarded; a `tail` must never reach the ZIP's `done` record.
- **Counters.** `MAX_ZIP_CHILDREN` (100 000) is checked against a new `children` counter that includes nested items. `count` stays the member count behind the "N files" line.
- **Summary.** Nested members get their own section, `- <member> — N messages|cards|notes`, kept in `ZipResume.nestedLines`. They appear even beyond `HEAD_NAMES`.
- **What stays name-only.** Nested `.zip` and `.pst` members. Encrypted members. Members with a ratio above 100:1 over 1 MiB. Nested members are exempt from the 20 MiB member cap.
- **No scratch directory.** When `LocalFolderDeps.scratchDir` is absent (tests, tools), the source never extracts; it sets `skip`, so nested members stay name-only.
- **Child purity.** The converter child stays pure: it only ever reads paths. `scratchDir` reaches it as an `expandPage` job field, not as part of the budget.

## Review Focus

1. **A 20 GB Takeout mailbox.** The copy runs in main, abortable, outside any converter job. Ordinary members before it are already committed. Its messages then page in pages of 200 items.
2. **Quit mid-copy.** A `.part` file is never paged. On restart it is swept and the copy restarts. Re-extraction is deterministic, so the same keys come out.
3. **The ZIP changes, is deleted or fails while a nested member is pending.** `replaceRecord` deletes the scratch file in the same loop iteration, not at the next app launch.
4. **A forged member size, larger or smaller than declared.** Always `'skip'`, never a silently truncated mailbox.
5. **A ZIP with 100k members.** A resumed page visits only its own entries. Pinned by a counting test, not a timing test.

---

### Task 1: Central-directory resume for the ZIP walk

**Files:**

- Modify: `src/main/core/converter/containers/zip.ts`
- Test: `src/main/core/converter/__tests__/containers-zip.test.ts`

**Interfaces:**

- Produces:

  - `ZipResume.cd?: number`: the byte offset of the next central-directory header.
  - An internal `openAt(file, cd, index)`.

- [ ] **Step 1: Failing tests.**
  - Build a 300-entry zip and expand it with `budget.items = 50`, counting `entry` events per call. Every resumed page visits at most 51 entries, and the union of keys equals a one-pass run.
  - A pin test that reads `readEntryCursor` and `entriesRead` on an open `ZipFile`. It fails loudly if a yauzl upgrade renames them.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.**
  - After each `entry` event, store `zf.readEntryCursor` (yauzl 2.10 instance fields, consumed only by `_readEntry`) as `state.cd`, next to `index`.
  - On open, when `resume.cd` is set and `typeof zf.readEntryCursor === 'number'`: set `zf.readEntryCursor = cd` and `zf.entriesRead = index` before the first `readEntry()`. Otherwise fall back to the skip scan.
  - A misaligned offset throws on yauzl's signature check, which counts as one attempt. Size and mtime pinning already forces a full path on any change.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `perf(converter): ZIP pages resume at the central-directory offset`.

---

### Task 2: Nested members in the ZIP pager + `extractMember`

**Files:**

- Modify:
  - `src/main/core/converter/containers/{zip,types,index}.ts` (`EXPANDER_VERSION.zip = 2`)
  - `src/main/core/converter/{protocol,worker,converter,runner}.ts` (optional `scratchDir` on the expandPage job)
- Test: `src/main/core/converter/__tests__/containers-zip.test.ts`, `runner.test.ts`

**Interfaces:**

- Produces:

  ```ts
  export interface NestedState {
    member: string;
    cd: number;
    size: number;
    crc32: number;
    kind: 'mbox' | 'vcard' | 'enex';
    inner: unknown | null;
    items: number;
    skip?: true;
  }
  // ZipResume gains: cd?: number; children: number; nestedLines: string[]; nested?: NestedState
  export function scratchName(
    zipPath: string,
    member: string,
    kind: string,
  ): string;
  export async function extractMember(
    zipPath: string,
    nested: NestedState,
    dest: string,
    opts: { signal?: AbortSignal },
  ): Promise<'ok' | 'skip' | 'mismatch'>; // dest.part → rename dest
  // Converter.expandPage(path, kind, resume, budget?, signal?, scratchDir?)
  ```

- [ ] **Step 1: Failing tests.** Zips are built with JSZip in a temp dir.
  - **Happy path.** A zip with `a.txt` + `Takeout/Mail/All mail.mbox` (3 messages):
    - Page 1 returns the txt child and `resume.nested` with `inner: null`.
    - After `extractMember` writes the scratch file, the next pages yield 3 `email.message` children keyed `zip:Takeout/Mail/All mail.mbox#msg:…`.
    - Then the summary, with the line `- Takeout/Mail/All mail.mbox — 3 messages`. The final result has no `tail`.
  - **Paging.** With `items: 2` the pages resume inside the member, and the union of keys equals one pass.
  - **Skip.** With `nested.skip` set, the member becomes one name-only child and the walk continues.
  - **Missing scratch file.** On a later page: the same resume comes back with no items.
  - **`.part` only.** Treated as missing.
  - **Mismatch.** `extractMember` against a different zip at the same path returns `'mismatch'`.
  - **Forged sizes.** A declared size smaller than the actual bytes → `'skip'` with no `.part` left. A stream shorter than declared → `'skip'`.
  - **Disk guard.** A mocked `statfs` with tiny `bavail` → `'skip'`.
  - **Abort.** An aborted signal mid-copy rejects, and the `.part` is removed.
  - **Other kinds.** `.vcf` and `.enex` members → `contact.card` and `note` children. A nested `.zip` → name-only.
  - **Children cap.** With `MAX_ZIP_CHILDREN` patched to 2, a 3-message mbox ends the walk with a "first …" summary.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.** In `expandZip`, when `state.nested` is set:

  - If `skip`: push the name-only child, clear `nested`, continue the walk.
  - Else, if `<scratchDir>/<scratchName>` exists under its final name: call `expandPage(tmp, kind, inner, remaining)`, where `remaining` is the budget minus this page's use (every pager makes at least one item of progress).
    - Map the keys, and add to `children` and `nested.items`.
    - If the inner resume is null, push the nested line, clear `nested` and continue the walk. Otherwise return.
  - Else (no scratch file): return `{items, resume: state}`.

  During the walk, an eligible member (kind via `containerKindOf`, not encrypted, not a bomb) sets `nested` from the entry (`cd` = this entry's header offset, `size`, `crc32`) and returns `{items, resume: state}`. This happens with or without `scratchDir`; the source decides.

  `extractMember`:

  1. Open the zip at `cd` and verify name, size and crc32; on a mismatch return `'mismatch'`.
  2. Apply the `statfs(dirname(dest))` guard.
  3. Pipe through a counting transform capped at `size` into `dest.part`. On `signal`: destroy the stream, unlink the `.part`, rethrow.
  4. Require count === size, then rename to `dest`.

- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(converter): mailboxes, vCards and ENEX inside a ZIP`.

---

### Task 3: Source — extraction, `replaceRecord`, sweep

**Files:**

- Modify:
  - `src/main/sources/local-folder/{expansion,local-folder-source}.ts`
  - `src/main/sources/index.ts`
  - `src/main/main.ts`: `scratchDir: path.join(app.getPath('userData'), 'expand-tmp')`
- Test: `src/main/sources/local-folder/__tests__/{expansion,local-folder-containers}.test.ts`

**Interfaces:**

- Produces:
  - `LocalFolderDeps.scratchDir?: string`; `StepInput.scratchDir?: string`.
  - `replaceRecord(exps, id, next: Expansion | null, scratchDir?)`.
  - `sweepScratch(scratchDir, exps)`.
- `expansionStep` checks before calling the pager. When `rec.kind === 'zip'` and `rec.resume.nested` is set without `skip`, and the scratch file is absent under its final name:

  - No `scratchDir` → set `skip`.
  - Otherwise `await extractMember(...)`:
    - `'skip'` → set `skip`.
    - `'mismatch'` → full path (`resume: null, cleared: false`).
    - `'ok'` → the record is unchanged.
  - Any of these returns with no items; the next step pages.
  - An abort leaves the record unchanged and counts no attempt.

- [ ] **Step 1: Failing tests:**
  - Backfill of a root with `takeout.zip` (txt + 3-message mbox member) and a `scratchDir` → the ZIP summary row, 1 file child, 3 message children with `parent = takeout.zip`, and an empty scratch dir.
  - Without `scratchDir`, the mbox member is one name-only child.
  - At pull start, a stray `x.part` and an unreferenced file are deleted. The scratch file of a pending nested record is kept, and the run finishes it.
  - Deleting the ZIP mid-member (unlink event or rescan): its scratch file is gone in the same loop iteration.
  - Rewriting the ZIP mid-member (`noteContainer` → full path): the scratch file is deleted.
  - Abort during extraction: no `.part` left, record unchanged.
  - A done ZIP record with `v: 1` is re-expanded once.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement.**
  - Every write to `exps` goes through `replaceRecord`: buildBatch, eventBatch, the drive loop, dropUnvisited and prune.
  - `replaceRecord` unlinks `<name>` and `<name>.part` when the previous record was pending on a nested member and the next one is not pending on the same member.
  - At `pull()` start, after the prune: `mkdir -p` the scratch dir, then `sweepScratch`.
- [ ] **Step 4:** Run `npx jest src/main/sources src/main/core/converter` → PASS.
- [ ] **Step 5: Commit** `feat(local-folder): extract nested containers to a scratch directory`.

---

### Task 4: Gates

- [ ] `npm run build:main`. Bundled-child smoke: a Takeout-shaped zip, with `extractMember` run by the smoke script, then `expandPage` through `release/app/dist/main/worker.js` → 3 message children.
- [ ] Memory and time gate: a 2 GB mbox stored (not deflated) in a zip, plus a 200 MB deflated variant. Record the extraction time in a plain Node process; the child's peak RSS must stay under 400 MB while paging.
- [ ] Run the full `npx jest` (note load-only flakes separately), `npm run typecheck`, and eslint + prettier on touched files.
- [ ] Final fable + astra review of the 2b diff.
