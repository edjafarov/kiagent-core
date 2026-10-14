# File formats Phase 2 (containers: mbox, Thunderbird, ZIP, vCard, ENEX) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local `.mbox` (and a Thunderbird extensionless mail folder), `.zip`, `.vcf` and `.enex` becomes one container `file` row plus one child document per message / member / card / note, expanded page by page in the converter child, with policy version 4.

**Architecture:** A new path-based converter op `expandPage` (child-side pagers under `src/main/core/converter/containers/`) returns child items for one bounded page plus an opaque `resume`. The local-folder source records containers in its cursor (`expansions`) from the scan path and drives one page at a time between watcher events; it is the only writer of the container row and of children. Full re-expansion is a deletions-only batch (parent cascade archives children) followed by re-emission (upsert un-archives). The store's reconcile guard counts only top-level rows.

**Tech Stack:** TypeScript, jest, mailparser (shipped), `@xmldom/xmldom` (declared in Phase 1), turndown (shipped), `yauzl` 2.10 (shipped via word-extractor; declared here), `extractMessageEvidence` (`sources/email-evidence.ts`), `isAutomatedMessage` (`sources/imap/filter.ts`).

**Spec:** `docs/superpowers/specs/2026-10-13-file-formats-batch-design.md` — section B (B1–B3), Re-enumeration row "2", Rollout step 2, Testing "Expansion".

## Global Constraints

- Containers are **local-folder only**; the cloud profile is unchanged (`.zip` stays `archive`, `.vcf` stays text/*, `.mbox` stays converter there).
- Container decision: `{kind:'index', pipeline:'container', bytes:'none'}`, no size cap, branch placed right after `no-extension` (step 2), local profile only. Step 2 lets `mime === 'application/mbox'` through (Thunderbird).
- `FILE_POLICY_VERSION = 4`; `ADMITTED_SINCE[4] = mbox, zip, vcf, enex`.
- Child externalId: `<containerExternalId>#<key>` with key `msg:<sha1>`, `zip:<member>`, `vcf:<id>`, `enex:<sha1>`; the container externalId is `toAbsPosix(absPath)`.
- Children: `parent = {externalId: container, type:'file'}`, inherit `scopeRootId`, `metadata.conversion = {status:'ok'}`, `metadata.extraction = {container: <kind>}`, **no `absPath`**.
- Container row: `type:'file'`, same metadata as an ordinary local file plus `conversion: {status:'ok'}` and `container: {kind}`; markdown is `# <name>\n\nReading…` (first page) then the summary (last page), or `# <name>\n\nCould not read this file.` when failed.
- Page budget defaults: `items 200`, `bytes 16 MiB` of rendered markdown, `ms 20_000` (checked after each item). Raw input per mail/note item ≤ 8 MiB (tail discarded, child marked truncated).
- ZIP: members routed by `decideFileIndexing({profile:'local-folder', …})`; ordinary members over 20 MiB uncompressed, ratio > 100:1, encrypted, nested `.zip/.pst/.mbox/.vcf/.enex` → name-only children (Phase 2b handles nested mailboxes); stop at 100 000 children.
- Thunderbird: messages with `X-Mozilla-Status & 0x0008` (expunged) are skipped; the fallback id hash excludes `X-Mozilla-*`, `Status`, `X-Status`; mbox change detection is by size only.
- Expansion records carry `v` (expander version per kind, all `1` now); a `done`/`failed` record with an older `v` is treated as changed.
- Only one store change: `reconcileDiff` counts `parent_id IS NULL` rows only.
- Builds/tests sequential. Commits without `Co-Authored-By`; `git commit -F` when the message has backticks.

## Review Focus

1. An mbox that is still being appended to while expanded (Thunderbird receiving mail): the last message may be cut mid-write → no crash, the next append fast-path resumes at a `From ` boundary or falls back to the full path. (Task 7 test: grow file whose old `end` is not a boundary.)
2. A ZIP whose member claims a small size but inflates huge (forged local header) → yauzl's size validation or our byte counter stops it; the member becomes name-only, the page continues. (Task 5 test.)
3. App restart between the full-path deletion batch and the first re-emitted page → re-emission resumes, no second deletion, children reappear. (Task 8 test.)
4. A container deleted while the app was closed → reconcile archives it and its children without tripping "the listing shrank suspiciously", and the stale `expansions` record is dropped. (Tasks 1 and 8 tests.)
5. A vCard with folded lines, quoted-printable `N`/`FN` (old Outlook exports) and a base64 PHOTO → readable name, PHOTO dropped. (Task 4 test.)

---

## File structure

- Create `src/main/core/converter/containers/types.ts` — `ContainerKind`, `ChildItem`, `ExpandBudget`, `ExpandResult`, `EXPANDER_VERSION`, `containerKindOf(filename, mime)`.
- Create `src/main/core/converter/containers/records.ts` — byte-offset line reader that yields raw records (start/end markers, per-record byte cap) from a file at an offset.
- Create `src/main/core/converter/containers/mbox.ts`, `vcard.ts`, `enex.ts`, `zip.ts` — one pager each.
- Create `src/main/core/converter/containers/index.ts` — `expandPage(path, kind, resume, budget)` dispatcher.
- Modify `src/main/core/converter/protocol.ts`, `converter.ts`, `runner.ts`, `src/main/converter/worker.ts` — the `expandPage` op.
- Modify `src/main/core/converter/parsers.ts` — export `renderMail`, `MailParts`.
- Modify `src/main/core/store/write-tx.ts` — reconcile counts.
- Modify `src/shared/file-indexability.ts` — `'container'` pipeline, branch, v4.
- Modify `src/main/sources/local-folder/ingestible.ts` (`.msf` rule, `localCandidate`), `scanner.ts` (`buildItem` container marker), `cursor.ts` (`expansions`), `to-document.ts` (prebuilt items), `watch.ts` (watcher split into start + event batch), `local-folder-source.ts` (factory, driver loop), `index.ts`; create `src/main/sources/local-folder/expansion.ts` (record transitions + page → batch).
- Modify `src/main/sources/index.ts`, `src/main/main.ts` — pass the converter.
- Modify `src/main/core/mcp/tools/schema-doc.ts` if `schema-doc-drift.test.ts` requires the new local-folder document types.
- `package.json`, `release/app/package.json` — `yauzl` `^2.10.0`, `@types/yauzl` (dev, root).

---

### Task 1: Reconcile guard counts top-level rows only

**Files:**
- Modify: `src/main/core/store/write-tx.ts` (`reconcileDiff`)
- Test: the existing reconcile store test file (find with `git grep -ln "reconcileDiff" src/main/core/store/__tests__`)

**Interfaces:**
- Produces: `reconcileDiff` → `{listedCount, liveCount, deletionCount}` where `liveCount` and `deletionCount` count only rows with `parent_id IS NULL`; `archiveBatchTx` unchanged.

- [ ] **Step 1: Failing test.** In the reconcile store tests, commit a `file` parent `a` with 1 000 children (`parent: {externalId:'a', type:'file'}`) plus 3 unrelated top-level files; stage a listing of only the 3 files; `reconcileDiff` → `liveCount === 4`, `deletionCount === 1`; then archive chunks → `a` and all 1 000 children archived.
- [ ] **Step 2:** Run it: FAIL (`liveCount` 1004, `deletionCount` 1001).
- [ ] **Step 3: Implement.** In `reconcileDiff` change the counts query to `FROM documents WHERE ${ELIGIBLE} AND parent_id IS NULL`. Update the comment above it: children live and die with their parent, so the guard judges the listing on top-level rows only (a 100k-message mailbox deleted offline is one row of shrinkage).
- [ ] **Step 4:** Run the store and engine reconcile tests (`npx jest src/main/core/store src/main/core/engine -t reconcile`): PASS. If an engine test asserted child counts in the refusal message, update it to the top-level number.
- [ ] **Step 5: Commit** `fix(store): reconcile's mass-archive guard counts top-level rows only`.

---

### Task 2: Container types, record reader, `expandPage` op plumbing

**Files:**
- Create: `src/main/core/converter/containers/types.ts`, `records.ts`, `index.ts`
- Modify: `protocol.ts`, `converter.ts`, `runner.ts`, `src/main/converter/worker.ts`
- Test: `src/main/core/converter/__tests__/containers-records.test.ts`, extend `runner.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ContainerKind = 'mbox' | 'zip' | 'vcard' | 'enex';
  export const EXPANDER_VERSION: Record<ContainerKind, number> = { mbox: 1, zip: 1, vcard: 1, enex: 1 };
  export interface ChildItem {
    key: string;                 // 'msg:<sha1>' | 'zip:<member>' | 'vcf:<id>' | 'enex:<sha1>'
    type: 'email.message' | 'file' | 'contact.card' | 'note';
    title: string;
    markdown: string | null;
    metadata: Record<string, unknown>;
    createdAt: string | null;
  }
  export interface ExpandBudget { items: number; bytes: number; ms: number }
  export const DEFAULT_EXPAND_BUDGET: ExpandBudget = { items: 200, bytes: 16 * 1024 * 1024, ms: 20_000 };
  export interface ExpandResult {
    items: ChildItem[];
    resume: unknown | null;      // null = done
    summary?: string;            // set on the last page
    end?: number;                // mbox: byte offset after the last message read
  }
  export function containerKindOf(filename: string, mime: string): ContainerKind | null;
  // records.ts
  export interface RawRecord { raw: Buffer; start: number; end: number; truncated: boolean }
  export function readRecords(path: string, offset: number, opts: {
    isStart(line: Buffer, prevBlank: boolean): boolean;
    isEnd?(line: Buffer): boolean;   // inclusive end line; absent = next start ends a record
    maxRecordBytes: number;
  }): AsyncGenerator<RawRecord>;
  // index.ts
  export function expandPage(path: string, kind: ContainerKind, resume: unknown | null, budget: ExpandBudget): Promise<ExpandResult>;
  // Converter interface
  expandPage(path: string, kind: ContainerKind, resume: unknown | null, budget?: ExpandBudget, signal?: AbortSignal): Promise<ExpandResult>;
  ```
- `ConverterJob` gains `{ op: 'expandPage'; path: string; kind: ContainerKind; resume: unknown | null; budget: ExpandBudget }`; the runner charges such jobs 0 queued bytes.

- [ ] **Step 1: Failing tests.** `containers-records.test.ts` writes a temp file and asserts:
  - mbox-style starts (`From ` after a blank line or at offset 0) split three records with exact `start`/`end` byte offsets (UTF-8 multibyte content before a boundary keeps offsets in bytes);
  - CRLF files split the same way;
  - reading from the middle record's `start` yields the last two;
  - a record over `maxRecordBytes` yields its first `maxRecordBytes` bytes with `truncated: true` and the following record intact;
  - `isEnd` mode (`BEGIN:VCARD`/`END:VCARD`) ignores text between records.
  In `runner.test.ts` (fake child pattern already used there): an `expandPage` job is submitted with `queuedBytes` unchanged and its reply is returned.
- [ ] **Step 2:** Run: FAIL (modules missing).
- [ ] **Step 3: Implement.**
  - `readRecords`: open the file (`fs.promises.open`), read 1 MiB chunks from `offset`, split on `\n` (0x0A) keeping a carry-over buffer for a partial line, track absolute byte positions. A record starts at a line where `isStart(line, prevBlank)`; it ends before the next start (or at an inclusive `isEnd` line, or EOF). Append lines to the current record until it would exceed `maxRecordBytes`, then set `truncated` and drop further lines until the record ends. Close the handle in `finally`. Never holds more than one record plus one chunk.
  - `containerKindOf`: ext `mbox` or mime `application/mbox` → `mbox`; `zip` → `zip`; `vcf` → `vcard`; `enex` → `enex`; else null.
  - `index.ts`: switch on kind, lazy-free static imports of the four pagers (added in Tasks 3–5; until then each case throws `Error('expander not implemented: <kind>')`).
  - `protocol.ts`: add the job variant (import the types from `./containers/types`).
  - `worker.ts`: `run()` handles `expandPage` before touching `req.bytes` (`const bytes = 'bytes' in req ? new Uint8Array(req.bytes) : null`).
  - `converter.ts`: `Converter.expandPage`; `createInlineConverter` calls `expandPage` from `./containers` through `run(signal, …)`.
  - `runner.ts`: `submit` uses `const bytes = 'bytes' in job ? job.bytes.byteLength : 0;` and the public method `expandPage: (path, kind, resume, budget = DEFAULT_EXPAND_BUDGET, signal) => submit({op:'expandPage', path, kind, resume, budget}, signal) as Promise<ExpandResult>`.
  - Extend the parsers purity test to scan `containers/` too.
- [ ] **Step 4:** Run `npx jest src/main/core/converter`: PASS.
- [ ] **Step 5: Commit** `feat(converter): expandPage op and the container record reader`.

---

### Task 3: mbox pager (incl. Thunderbird)

**Files:**
- Create: `src/main/core/converter/containers/mbox.ts`
- Modify: `parsers.ts` (export `renderMail`, `MailParts`)
- Test: `src/main/core/converter/__tests__/containers-mbox.test.ts`

**Interfaces:**
- Consumes: `readRecords`, `renderMail`, `extractMessageEvidence`, `isAutomatedMessage`, `simpleParser`.
- Produces: `expandMbox(path, resume: MboxResume | null, budget): Promise<ExpandResult>` with `interface MboxResume { offset: number; count: number; first: string | null; last: string | null }` (`first`/`last` are ISO dates for the summary).

- [ ] **Step 1: Failing tests** (temp files written by the test):
  - 3 messages (one with `Message-ID`, one without, one `>From ` escaped body line) → 3 `email.message` children; keys `msg:<sha1(Message-ID)>` and `msg:<sha1(headers)>`; metadata `{from, to[], cc[], replyTo, references, date, subject, messageId, contactEvidence}`; markdown via `renderMail` contains `**From:**` and the unescaped `From ` line; `resume === null`; `summary === '# inbox.mbox — 3 messages, 2024–2026'`; `end === file size`.
  - budget `items: 2` → first page 2 items + resume; second page from resume → 1 item + summary; concatenated keys equal the single-page run.
  - A `Precedence: bulk` message is not emitted (counted in nothing).
  - Thunderbird: `X-Mozilla-Status: 0009` message skipped; the same message with `X-Mozilla-Status: 0001` vs `0003` hashes to the same fallback key.
  - A 30 MB attachment message with `maxRecordBytes` 8 MiB → child exists, `metadata.truncated === true`, markdown has the subject; the following message is intact.
  - `resume = {offset: <start of message 3>, …}` (append fast path) → only message 3.
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3: Implement** `mbox.ts`:
  - `isStart = (line, prevBlank) => (prevBlank || atOffset0) && line starts with 'From '` (the reader passes `prevBlank` true for offset 0).
  - Per record: strip the `From ` envelope line; unescape `^>(>*From )` → `$1` per line; split raw headers (up to the first blank line) for the fallback hash, excluding `X-Mozilla-*`, `Status`, `X-Status` header lines (case-insensitive, with folded continuation lines).
  - `X-Mozilla-Status` parsed as hex; `& 0x0008` → skip.
  - `simpleParser(raw)`; build headers map like `imap/parse.ts`; `isAutomatedMessage(headers, from)` → skip; `extractMessageEvidence({messageKey: messageId ?? key, author: from, at, plain: mail.text ?? '', html})`.
  - Child: `type 'email.message'`, `title subject || '(no subject)'`, `markdown renderMail({...body: mail.text ?? htmlToMarkdown(html)})` (truncated → append `\n\n[truncated]`), `createdAt date`.
  - Stop when `items.length === budget.items`, rendered bytes ≥ `budget.bytes`, or `Date.now() - t0 ≥ budget.ms`; `resume = {offset: nextRecordStart, count, first, last}`; at EOF `resume = null`, `end = lastRecordEnd`, `summary = '# <basename> — <count formatted with en-US grouping> messages, <yearFirst>–<yearLast>'` (`, <year>` when equal; no dates → no year part).
- [ ] **Step 4:** Run: PASS.
- [ ] **Step 5: Commit** `feat(converter): mbox pager — one child per message, Thunderbird-aware`.

---

### Task 4: vCard and ENEX pagers

**Files:**
- Create: `src/main/core/converter/containers/vcard.ts`, `enex.ts`
- Test: `src/main/core/converter/__tests__/containers-vcard-enex.test.ts`

**Interfaces:**
- Produces: `expandVcard(path, resume: {offset:number;count:number}|null, budget)`, `expandEnex(path, resume: {offset:number;count:number}|null, budget, html: (s: string) => Promise<string>)`.

- [ ] **Step 1: Failing tests:**
  - vCard 3.0 + 4.0 cards, folded lines (`\r\n ` continuation), `ENCODING=QUOTED-PRINTABLE;CHARSET=UTF-8` FN, `PHOTO;ENCODING=b:` base64 → `contact.card` children titled by FN (fallback N, then first EMAIL), markdown `# Name` then `**Organization:**`, `**Title:**`, `**Email:**`, `**Phone:**`, `**Address:**`, note; no base64 in markdown; key `vcf:<UID>` or `vcf:<sha1(FN+first EMAIL)>`; summary `# contacts.vcf — 2 contacts`.
  - A single-card `.vcf` → one child (always a container).
  - ENEX with 2 notes (one with `<resource>` base64 and `<en-media>`), tags, created/updated (`20240115T101500Z`), `<source-url>` → `note` children, markdown from ENML via turndown with tags/source/resource filenames listed, key `enex:<sha1(title+created)>`, `createdAt` ISO; summary `# notes.enex — 2 notes`.
  - A note over 8 MiB raw → truncated child (title kept from the head).
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3: Implement.** vCard: `readRecords` with `isStart = BEGIN:VCARD`, `isEnd = END:VCARD`; unfold; parse `NAME;PARAMS:VALUE` (case-insensitive names, group prefixes `item1.EMAIL`); decode QUOTED-PRINTABLE + CHARSET; unescape `\,` `\;` `\n`; drop PHOTO/LOGO/SOUND/KEY. ENEX: `isStart` line contains `<note>`, `isEnd` line contains `</note>`; parse the record with `parseXml` from `../formats/xml`; `<content>` is CDATA ENML → strip `<en-media>`/`<en-todo>` → `html()` (the shared `htmlToMarkdown`); resource `file-name` from `<resource-attributes>`; dates `yyyyMMddTHHmmssZ` → ISO.
- [ ] **Step 4:** Run: PASS.
- [ ] **Step 5: Commit** `feat(converter): vCard and Evernote ENEX pagers`.

---

### Task 5: ZIP pager

**Files:**
- Create: `src/main/core/converter/containers/zip.ts`
- Test: `src/main/core/converter/__tests__/containers-zip.test.ts`
- Modify: `package.json`, `release/app/package.json` (`yauzl` `^2.10.0`; root dev `@types/yauzl` matching 2.10)

**Interfaces:**
- Consumes: `decideFileIndexing`, `resolvePathMime` (`sources/local-folder/mime.ts` — pure), `parseDetailed`, `capMarkdown`.
- Produces: `expandZip(path, resume: {index:number;count:number}|null, budget)`.

- [ ] **Step 1: Failing tests** (JSZip-built fixtures written to temp files):
  - members `a.txt`, `b.csv`, `c.html`, `d.docx` (reuse `tinyDocx` shape), `e.png`, `f.mbox`, `.env`, `dir/` → children `zip:a.txt` (text), `zip:b.csv`/`zip:c.html`/`zip:d.docx` (converted markdown), `zip:e.png` and `zip:f.mbox` name-only (`markdown null`), no child for `.env` or the directory; metadata `{member, filename, mime, ext, sizeBytes, mtime}`; summary `# x.zip — 6 files` followed by the member list head.
  - a member with a forged small size in both headers (patch like Phase 1's zip test) that inflates to 25 MiB → name-only child, page continues with the next member.
  - a text member with NUL bytes → name-only.
  - budget `items: 2` paging resumes by entry index with identical keys.
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3: Implement.** `yauzl.open(path, {lazyEntries: true, autoClose: false, validateEntrySizes: true})`, iterate with `readEntry()`, skip entries before `resume.index`. Per file entry: `decideFileIndexing({profile:'local-folder', filename: basename, path: member, mime: resolvePathMime(member), sizeBytes: entry.uncompressedSize})`; `ignore` → skip; encrypted (`generalPurposeBitFlag & 1`), ratio `uncompressed/compressed > 100` with `uncompressed > 1 MiB`, `uncompressed > 20 MiB`, pipeline not `inline-text`/`converter`, or `bytes !== 'eager'` → name-only. Otherwise `openReadStream`, accumulate with a 20 MiB counter (destroy + name-only on overflow or stream error); inline-text → NUL sniff then UTF-8; converter → `parseDetailed(bytes, mime, basename)` (null markdown → name-only; throw → name-only with `metadata.conversionError`). Stop at budget or 100 000 total children (`summary` notes "first 100,000 files"). Close the zipfile in `finally`.
- [ ] **Step 4:** Run: PASS.
- [ ] **Step 5: Commit** `feat(converter): ZIP pager — members indexed by the local file policy`.

---

### Task 6: Policy — container pipeline, `.msf` rule, version 4

**Files:**
- Modify: `src/shared/file-indexability.ts`, `src/main/sources/local-folder/ingestible.ts`, `local-folder-source.ts` (rescan candidate through the adapter)
- Test: `src/shared/__tests__/file-indexability.test.ts`, `src/main/sources/local-folder/__tests__/ingestible.test.ts`

**Interfaces:**
- Produces: `FilePipeline` adds `'container'`; `localCandidate(absPath: string, sizeBytes?: number): FileIndexCandidate` (applies the Thunderbird override) used by `decideLocalFile` and by `incrementalRescanRoot`'s `newlyAdmitted` call; `FILE_POLICY_VERSION === 4`.

- [ ] **Step 1: Failing tests:**
  - local `a.mbox`, `a.zip`, `a.vcf`, `a.enex`, and an extensionless file with mime `application/mbox` → `{kind:'index', pipeline:'container', bytes:'none'}` at any size (also 5 GB);
  - cloud `a.zip` → `{ignore, archive}`, cloud `a.vcf` (`text/vcard`) → converter as before, cloud `a.mbox` unchanged;
  - an extensionless `Inbox` with sibling `Inbox.msf` (temp dir) → `decideLocalFile` container; without `.msf` → `no-extension`;
  - `newlyAdmitted(local container, 3) === true`; `FILE_POLICY_VERSION === 4`.
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3: Implement.** In `decideFileIndexing`, after step 2: `if (local && (CONTAINER_EXTENSIONS.has(ext) || mime === 'application/mbox')) return {kind:'index', pipeline:'container', bytes:'none'}` with `CONTAINER_EXTENSIONS = new Set(['mbox','zip','vcf','enex'])`; step 2 exempts `mime === 'application/mbox'`. `ADMITTED_SINCE[4]`. `ingestible.ts`: `localCandidate` sets `mime = 'application/mbox'` when the basename has no extension and `fs.existsSync(absPath + '.msf')`; `decideLocalFile` uses it. `incrementalRescanRoot` builds its `newlyAdmitted` candidate with `localCandidate(e.absPath, e.stats.size)`. `scanner.ts` `entryReadCost` already returns 0 for `bytes:'none'`.
- [ ] **Step 4:** Run `npx jest src/shared src/main/sources/local-folder`: the policy tests PASS; existing local-folder tests that expected `.vcf` inline text are updated to the container decision.
- [ ] **Step 5: Commit** `feat(policy): local containers (mbox, Thunderbird, zip, vcf, enex) — file policy v4`.

---

### Task 7: Expansion records and page → batch

**Files:**
- Create: `src/main/sources/local-folder/expansion.ts`
- Modify: `cursor.ts`, `to-document.ts`
- Test: `src/main/sources/local-folder/__tests__/expansion.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // cursor.ts
  export type Expansion =
    | { state: 'pending'; kind: ContainerKind; v: number; size: number; mtimeMs: number;
        resume: unknown | null; cleared: boolean; attempts: number; notBefore?: number }
    | { state: 'done'; kind: ContainerKind; v: number; size: number; mtimeMs: number; end?: number }
    | { state: 'failed'; kind: ContainerKind; v: number; size: number; mtimeMs: number };
  // LocalFolderCursor gains `expansions?: Record<string, Expansion>` (key = container externalId)
  // to-document.ts
  export type LocalFolderItem = LocalFileItem | { prebuilt: DocumentInput };
  // expansion.ts
  export function noteContainer(prev: Expansion | undefined, kind: ContainerKind, stats: {size:number; mtimeMs:number}): Expansion;
  export function nextPending(exps: Record<string, Expansion>, now: number): string | null; // oldest due
  export async function expansionStep(input: {
    externalId: string; absPath: string; rec: Extract<Expansion,{state:'pending'}>;
    scopeRootId?: string; converter: Pick<Converter,'expandPage'>; now: number;
  }): Promise<{ items: LocalFolderItem[]; deletions: ExternalRef[]; rec: Expansion | null }>;
  ```
- `noteContainer` rules: unchanged (`done`/`failed`, same `v`, and for mbox same size / others same size and mtime) → same record; mbox `done` whose size grew → `pending` with `resume = {offset: end, count, …}` carried from the summary state? (keep `resume = {offset: end}`; the pager fills defaults) and `cleared: true`; anything else → `pending` full path (`resume: null, cleared: false, attempts: 0`). An existing `pending` whose file changed restarts the full path.
- `expansionStep`:
  - file missing (stat throws ENOENT) → `rec: null` (drop), no items;
  - `!rec.cleared && rec.resume === null` → `deletions: [{externalId, type:'file'}]`, `rec = {...rec, cleared: true}` (the deletion batch);
  - mbox append (`cleared` and resume has `offset` but no `count`): if the 5 bytes at `offset` are not `From ` → treat as full path (`cleared:false, resume:null`, no items this step);
  - otherwise `converter.expandPage`: success → children as `{prebuilt}` items (shape in Global Constraints), plus the container row item when `rec.resume === null` (placeholder) or `result.resume === null` (summary); `rec` → next pending or `done {end}`;
  - `ConverterUnavailableError` → same rec with `notBefore = now + 60_000`, no attempt counted; any other error → `attempts + 1`, at 3 → `failed` plus the container row "Could not read this file.".

- [ ] **Step 1: Failing tests** with a fake converter: the transitions above, each as one test (first expansion = deletion step then placeholder page then summary page; append fast path; append into a non-boundary falls back; three failures → failed + row; unavailable → notBefore, attempts unchanged; missing file → drop; children carry parent/scopeRootId/conversion/extraction and no absPath).
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3: Implement** (`toDocument` returns `item.prebuilt` for prebuilt items; the container row is built by a `containerRow(absPath, stats, markdown, kind, scopeRootId)` helper reusing `toDocument`'s file metadata).
- [ ] **Step 4:** Run: PASS.
- [ ] **Step 5: Commit** `feat(local-folder): expansion records and page batches`.

---

### Task 8: Source driving — watcher first, scan records, one page at a time

**Files:**
- Modify: `local-folder-source.ts`, `watch.ts`, `scanner.ts`, `index.ts`; `src/main/sources/index.ts`, `src/main/main.ts`
- Test: `src/main/sources/local-folder/__tests__/local-folder-containers.test.ts` (real temp dirs, inline converter, `watch: false` and a watched variant)

**Interfaces:**
- Produces: `createLocalFolderSource(deps: { converter: Pick<Converter,'expandPage'> }): Source<LocalFolderCursor, LocalFolderItem>`; `localFolderSource` stays exported for tests built with the inline converter; `registerBundledSources(register, broker, converter)`; descriptor `documentTypes: ['file', 'email.message', 'contact.card', 'note']`.
- `buildItem` returns `{ container: ContainerKind }` for container files (no read); `buildBatch` routes those into the expansions state (never an item, never a deletion).
- `watch.ts` splits into `startWatcher(rootPaths, session)` → `{ take(): FsEvent | undefined; wait(ms?: number): Promise<void>; close(): Promise<void> }` and `eventBatch(ev, cursor, …)`; `watchLoop` is removed.

- [ ] **Step 1: Failing tests:**
  - backfill of a root with `a.txt` and `inbox.mbox` (3 messages), `watch:false` → the container row (summary), 3 children with parent links, `a.txt`; cursor `expansions['…/inbox.mbox'].state === 'done'`;
  - second pull with nothing changed → zero items;
  - append a message → exactly 1 new child, no deletion batch;
  - rewrite with one message removed → that child archived, the other two live;
  - restart after the deletion batch (feed the persisted cursor with `cleared:true`, `resume:null`) → no second deletion, children re-emitted;
  - quiet root with a pending expansion and `watch:true` → drained without any fs event (abort after the summary commits);
  - a `.txt` written while a big (budget `items:1`) expansion is in progress gets indexed (watcher started before expansion);
  - deleting the container → deletion + record dropped; un-scoping its root drops the record (`manageFolders` / prune);
  - a Thunderbird `Inbox` + `Inbox.msf` admitted by backfill AND by a watcher `add`.
- [ ] **Step 2:** Run: FAIL.
- [ ] **Step 3: Implement.**
  - `pull()`: `const watcher = isWatchEnabled ? startWatcher(rootPaths, session) : null` BEFORE the backfill/rescan; `state.expansions` seeded from the cursor (pruned to configured roots); every yielded batch's cursor gets `expansions: snapshot`; after the scan and the stamp batch, loop: `ev = watcher?.take()` → yield `eventBatch` (container events update `state` instead of building an item; container `unlink` drops the record and yields the deletion); else `id = nextPending(state, now)` → `expansionStep` → yield `{phase:'live', items, deletions, cursor}`; else if no watcher → return; else `await watcher.wait(msUntilNextNotBefore)`. Close the watcher in `finally`.
  - `pruneToConfiguredRoots` also drops `expansions` entries not under a configured root.
  - `sources/index.ts` takes `converter` and registers `createLocalFolderSource({converter})`; `main.ts` passes `p.converter`; update `schema-doc-drift.test.ts` callers and schema docs for the new local-folder types if the drift test demands it.
- [ ] **Step 4:** Run `npx jest src/main/sources src/main/core/mcp`: PASS.
- [ ] **Step 5: Commit** `feat(local-folder): expand containers into child documents`.

---

### Task 9: End-to-end, worker skip, memory gate, full gates

**Files:**
- Test: `src/main/sources/local-folder/__tests__/local-folder-containers-e2e.test.ts` (engine + store + convert/vision workers attached), `scripts/` none — the memory gate is a manual script in the scratchpad, recorded in the commit message.

- [ ] **Step 1: Tests:** with the real engine (pattern from `convert-pipeline.test.ts`), sync a root holding `inbox.mbox`, `x.zip` (txt+docx members), `c.vcf`, `n.enex` → children searchable (`store.read.search`), convert and vision workers never write a conversion marker other than `ok` on containers or children and never call `fetchBytes` for them (spy), reconcile after deleting `inbox.mbox` archives it and its children without a refusal.
- [ ] **Step 2:** Run them; fix in Tasks 1–8 if red.
- [ ] **Step 3: Memory gate (manual):** generate a 2 GB mbox (repeat a 50 KB message with a 1 MB attachment every 20th message) in the scratchpad, run the inline pager page-by-page in a fresh `node --expose-gc` process via a scratch script, record peak RSS (bar: < 400 MB).
- [ ] **Step 4: Full gates (sequential):** `npm run build:main`, `npx jest`, `npm run typecheck`, eslint on touched dirs, prettier check on touched files, bundled-child smoke (fork `release/app/dist/main/worker.js`, `expandPage` on a 3-message mbox).
- [ ] **Step 5: Commit** `test(local-folder): containers end to end`.

---

## Amendments after the design review (astra, 2026-10-13)

These override the tasks above where they disagree.

1. **Every rescan inspects container records**, independent of the mtime/ctime watermark: `incrementalRescanRoot` calls `noteContainer` for every walked container (unchanged ones are a no-op unless their `v` is outdated), and when a root's walk completes, records under that root that the walk did not visit are dropped with a container deletion in the same batch.
2. **The driver alternates**: each loop iteration takes at most one watcher event and then at most one due expansion step; it waits only when neither can run.
3. **`tail` instead of `end`**: the last page of an mbox returns `tail = {offset, count, first, last, append: true}`; the `done` record keeps it; a grown mbox resumes with that `tail` (so the summary counts the whole mailbox). The pager validates the boundary itself and answers `{items: [], resume: null, restart: true}` when the bytes at `offset` are not `From ` — the source then takes the full path. `ExpandResult.end` is replaced by `tail?: unknown` and `restart?: true`.
4. **Long lines**: the record reader fragments any line longer than 64 KiB (already implemented in Task 2, tested with a 3 MiB single line).
5. **A missing container file** (ENOENT at step time) yields its deletion and drops the record in the same batch.
6. **Policy activation moves into Task 8**: Task 6's container branch and the v4 bump land in the same commit as the source integration, so no intermediate commit can stamp v4 without expansion.
7. **Cancellation**: `expansionStep` takes `signal` (the session's) and passes it to `converter.expandPage`; an abort neither counts an attempt nor changes the record.
8. Task 1 was implemented before this review (`2a3dff8a`).
