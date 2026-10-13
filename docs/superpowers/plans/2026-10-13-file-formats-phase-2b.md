# File Formats Phase 2b — Containers Inside a ZIP — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A mailbox, vCard file or Evernote export inside a local ZIP (Google Takeout's `All mail Including Spam and Trash.mbox`) is expanded into flat children of the ZIP instead of a name-only member.

**Architecture:** The ZIP pager, on reaching an `mbox`/`vcard`/`enex` member, streams it (counted) to a scratch file named `sha1(zipPath + '\0' + member)` in a scratch directory the source passes in, then pages it with the existing path-based pager. `ZipResume` gains `nested: {member, kind, tmp, inner}` so a page boundary inside the member resumes there; when the inner pager finishes, the scratch file is deleted and the ZIP walk continues. The source owns the directory: it creates it, passes it in the budget, and at every `pull()` start deletes scratch files that no pending record references. `EXPANDER_VERSION.zip` 1 → 2 re-expands existing ZIPs once. No policy bump.

**Tech Stack:** TypeScript, yauzl, node:fs (`statfs`), Jest.

**Spec:** `docs/superpowers/specs/2026-10-13-file-formats-batch-design.md` (section B2 "Mailboxes/vCards/ENEX inside a ZIP", Rollout 2b, Testing "(2b)").

## Global Constraints

- Scratch file: `<userData>/expand-tmp/<sha1(absPath + '\0' + member)>.<kind>`; deleted when the member finishes, swept at `pull()` start when no pending record's `resume.nested.tmp` names it; re-extracted when missing on resume.
- Nested members are exempt from the 20 MiB member cap, still subject to the 100:1 ratio guard (above 1 MiB) and to encryption → name-only.
- Skip (name-only) when free disk at the scratch directory is below 2× the member's uncompressed size (`fs.promises.statfs`).
- Child key: `zip:<member>#<inner key>` (externalId `<absPath>#zip:<member>#msg:<id>`); children are flat under the ZIP (parent = the ZIP).
- Nested `.zip` and `.pst` members stay name-only.
- Without a scratch directory (`budget.scratchDir` absent — tests, tools) nested containers stay name-only, as in phase 2.
- The converter child stays pure: no electron/store imports; it learns the directory only from the job.
- `EXPANDER_VERSION.zip = 2`.

## Review Focus

1. A Takeout ZIP whose nested mbox is 5 GB on a disk with 6 GB free → name-only, never fills the disk.
2. The app quits mid-member → on restart the scratch file is reused (or re-extracted if gone), never left behind once the ZIP is done or removed.
3. The ZIP changes while a nested member is mid-expansion → full path; the stale scratch file is swept.
4. A forged member size → the counted copy stops at the real cap (the declared size is attacker-controlled).
5. A 100k-member ZIP: each page re-reads the central directory from entry 0 to reach `resume.index` (phase-2 review) — minutes of skipping outside the page budget. Task 1 also records the central-directory byte offset of the next entry in `ZipResume` and resumes the entry walk there, pinned by a test that times a resume deep into a 50k-entry zip.
6. The nested summary: the ZIP's summary counts members, and the mailbox member's listing says how many messages it held.

---

### Task 1: Nested expansion in the ZIP pager

**Files:**

- Modify: `src/main/core/converter/containers/types.ts` (`ExpandBudget.scratchDir?: string`, `EXPANDER_VERSION.zip = 2`), `src/main/core/converter/containers/zip.ts`
- Test: `src/main/core/converter/__tests__/containers-zip.test.ts`

**Interfaces:**

- Produces: `ZipResume.nested?: { member: string; index: number; kind: 'mbox' | 'vcard' | 'enex'; tmp: string; inner: unknown | null; count: number }`; exported `scratchName(zipPath: string, member: string, kind: ContainerKind): string`.

- [ ] **Step 1: Failing tests** (zips built with JSZip in a temp dir, `scratchDir` a temp dir):
  - a zip with `a.txt` and `Takeout/Mail/All mail.mbox` (3 messages) → 1 file child + 3 `email.message` children keyed `zip:Takeout/Mail/All mail.mbox#msg:…`, `parent` unset (the source sets it), scratch dir empty afterwards;
  - same zip with budget `items: 2` → pages resume inside the member (`resume.nested.inner` non-null), the union of keys equals the one-pass keys, scratch dir empty after the last page;
  - resume with `nested.tmp` deleted between pages → re-extracted, same keys;
  - no `scratchDir` → the mbox member is one name-only `file` child (phase-2 behaviour);
  - a nested member whose uncompressed size is larger than 2× free space (mock `fs.promises.statfs` to report tiny `bavail`) → name-only;
  - a `.vcf` and an `.enex` member → `contact.card` / `note` children;
  - a nested `.zip` member → name-only.
- [ ] **Step 2:** Run `npx jest src/main/core/converter/__tests__/containers-zip.test.ts` → FAIL.
- [ ] **Step 3: Implement.** In `memberChild`'s caller: when `containerKindOf(filename, mime)` is `mbox`/`vcard`/`enex`, the member is not encrypted or a ratio bomb, and `budget.scratchDir` is set: check `statfs(scratchDir)` (`bavail * bsize >= 2 * uncompressedSize`, else name-only); copy the member stream to `tmp = path.join(scratchDir, scratchName(...))` through the same counting transform as `readMember` but with the cap at `uncompressedSize` (+ a 1 MiB slack; overflow → delete tmp, name-only); set `state.nested = {member, index: i, kind, tmp, inner: null, count: 0}`. Then (and on any call where `resume.nested` is set: re-open the zip only to re-extract if `tmp` is missing, by scanning to entry `nested.index`) call `expandPage(tmp, kind, nested.inner, remainingBudget)` from `./index` and map each child key to `zip:<member>#<key>`; `nested.count += items`. Inner `resume === null` → `fs.rm(tmp, {force:true})`, push the member into `head` as `<member> (N messages|cards|notes)`, `count += 1`, clear `nested`, continue the walk at `nested.index + 1`; otherwise return `{items, resume: state}`. Inner `restart` cannot happen (a fresh scratch copy never appends). Summary unchanged otherwise.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(converter): mailboxes, vCards and ENEX inside a ZIP`.

---

### Task 2: Source scratch directory and sweep

**Files:**

- Modify: `src/main/sources/local-folder/local-folder-source.ts` (`LocalFolderDeps.scratchDir?: string`; pass into the budget; sweep at `pull()` start and when a record is dropped or restarted), `src/main/sources/local-folder/expansion.ts` (`StepInput.budget` already exists — the source supplies `{...DEFAULT_EXPAND_BUDGET, scratchDir}`), `src/main/sources/index.ts` and `src/main/main.ts` (`path.join(app.getPath('userData'), 'expand-tmp')`)
- Test: `src/main/sources/local-folder/__tests__/local-folder-containers.test.ts`

**Interfaces:**

- Consumes: `ZipResume.nested.tmp` (Task 1).
- Produces: `sweepScratch(dir: string, exps: Record<string, Expansion>): Promise<void>` (deletes every file in `dir` not named by a pending record's `resume.nested.tmp`; missing dir is fine).

- [ ] **Step 1: Failing tests:**
  - backfill of a root holding `takeout.zip` (txt + 3-message mbox member) with `scratchDir` → ZIP summary row, 1 file child, 3 message children with `parent = takeout.zip`, scratch dir empty;
  - a stray file in the scratch dir at pull start with no pending record → deleted;
  - a pending record whose `resume.nested.tmp` exists → kept, and the run finishes it;
  - a done ZIP record with `v: 1` → re-expanded once on the next pull (`EXPANDER_VERSION.zip` 2).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3: Implement** (`fs.promises.mkdir(dir, {recursive:true})` once per pull; `sweepScratch` after the cursor is pruned, before the scan).
- [ ] **Step 4:** Run `npx jest src/main/sources src/main/core/converter` → PASS.
- [ ] **Step 5: Commit** `feat(local-folder): scratch directory for nested containers`.

---

### Task 3: Gates

- [ ] `npm run build:main`; bundled-child smoke: a Takeout-shaped zip with a 3-message mbox member through `release/app/dist/main/worker.js` (`expandPage`, `budget.scratchDir` = a scratchpad dir) → 3 message children, scratch dir empty.
- [ ] `npx jest` (full, note load-only flakes separately), `npm run typecheck`, eslint + prettier on touched files.
- [ ] Commit any fixture/test fixes as `test(converter): nested containers end to end`.
