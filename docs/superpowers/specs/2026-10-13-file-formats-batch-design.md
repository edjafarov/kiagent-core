# File formats batch: Office, e-books, transcripts, mail archives, ZIP, PST

Status: r3 (fable + codex-astra rounds 1–2 folded in) · 2026-10-13
Scope came from the format coverage review (value ≥ 3 and difficulty ≤ 2,
plus PST). Deferred formats are filed as `priority:low` issues #148–#164.

## Problem

Kia ignores or under-reads formats users have in quantity:

- **Not indexed at all:** `.pptx`, `.odt`, `.ods`, `.epub`, `.doc`, `.rtf`,
  Thunderbird mail folders (extensionless mbox), every `.zip` (so Google
  Takeout, WhatsApp, LinkedIn and Slack exports), Outlook `.pst`.
- **Indexed badly:** a local `.mbox` is ONE document capped at 500
  messages (`parsers.ts` `MBOX_MAX_MESSAGES`); `.srt`/`.vtt` are raw text
  full of timestamps; `.vcf` and `.enex` are raw text/XML with base64.
- **Cloud is narrower than local:** a Drive/OneDrive `.xls`, or a `.csv`
  reported with a generic MIME, is `unsupported`; none of the new formats
  above would be converted from the cloud.

## Goals

1. Each format in scope becomes searchable text with its natural title,
   from local folders; single-file formats also from Drive/OneDrive.
2. Files that hold many items (mailboxes, archives, address books, note
   exports, PST) become **one document per item**, so search, `get` and
   People work per message/contact/note, with no 500-message cap.
3. Existing rows come back without user action (policy re-enumeration).
4. Memory stays bounded for multi-GB containers.

## Non-goals

- Formats in issues #148–#164.
- Containers in the **cloud** (a `.zip`/`.pst`/`.mbox` on Drive). Cloud
  gets the single-file formats only.
- Attachments inside a contained message as their own documents. Names
  only, like `.eml`/`.msg` today (children are one level deep).
- Feeding `contact.card` into People (a follow-up in the People
  extension; mbox/PST correspondents DO reach People, see B1).
- A UI affordance to "add Thunderbird": the user adds the profile folder
  as a normal local root (`DEFAULT_EXCLUDE_GLOBS` does not block it).
- Encrypted ZIP members; a zip inside a zip.
- Mail-source `.mbox` attachments (IMAP/Gmail children) keep today's
  single-document parser with its 500-message cap.

## Design overview

Two mechanisms, deliberately separate:

- **A. Single-file formats** reuse the existing pipeline: a new
  `ConvertibleKind`, a parser in the converter child, policy admission.
  No new architecture.
- **B. Containers** add ONE capability to the local-folder source:
  *expansion*. A container file stays one `file` document (a summary as
  its markdown) and gets **child documents** with deterministic ids,
  produced page by page by the converter child reading the file **by
  path**, committed through the source's own batches.

Expansion lives in the source, not the convert worker, because worker
`session.emit` commits under the worker's synthetic account; children
must share the file's account (parent resolution, account removal,
reconcile exemption of children of a listed parent). The source already
owns the path, cursor and account; the converter child already gives
crash isolation and a timeout. **No engine change** besides one line in
the reconcile guard (B3).

## A. Single-file formats

| Format | Kind | Parser (converter child) | New dependency |
|---|---|---|---|
| `.pptx` | `presentation` | jszip + @xmldom/xmldom: `ppt/presentation.xml` slide order → `ppt/slides/slideN.xml` text, `ppt/notesSlides/*`, `docProps/core.xml` | none (both ship via mammoth; declare them in `release/app`) |
| `.odt` | `odf-text` | jszip: `content.xml` paragraphs, headings, lists, tables; `meta.xml` title | none |
| `.ods` | `spreadsheet` | SheetJS (already reads ODS) | none |
| `.epub` | `epub` | jszip: `META-INF/container.xml` → OPF metadata + spine → XHTML → turndown | none |
| `.doc` | `word97` | `word-extractor` (MIT, pure JS): body, headers/footers, footnotes, comments | `word-extractor` |
| `.rtf` | `rtf` | in-house RTF→text stripper (control words, `\'hh` per `\ansicpg`, `\u` escapes, skip `\pict` and `\*` destinations) | none |
| `.srt` `.vtt` | `subtitles` | in-house: drop cue numbers and timing lines, merge cues, a `[mm:ss]` marker per minute | none |

Rules shared by all of A:

- **Markdown shape.** First line `# <title>` (document title from
  properties, else filename). PPTX: `## Slide N — <slide title>`, body,
  then `### Notes`. EPUB: chapter headings in spine order. Output stays
  capped by `MAX_MARKDOWN_CHARS` (2 MiB).
- **Zip safety (OOXML/ODF/EPUB).** Read only the parts named above;
  refuse a part whose uncompressed size (central directory) exceeds
  20 MiB; stop after 50 MiB inflated in total. Media is never inflated.
- **Policy.** Add the MIMEs to `LOCAL_CONVERTER_MIMES` and, except
  subtitles, to `CLOUD_CONVERTER_MIMES`; move `srt`/`vtt` from
  `LOCAL_TEXT_EXTENSIONS` to the converter pipeline. Extend the cloud
  extension rescue (today `{msg, eml}`) with `{pptx, odt, ods, epub, doc,
  rtf, csv, xls, html}` for generic MIMEs, and add
  `application/vnd.ms-excel` to `CLOUD_CONVERTER_MIMES` (closes the cloud
  `.xls`/`.csv` gap). Caps and the `docCap` ladder are unchanged.
- **Failure.** A parser throw records `conversion.status = 'failed'`
  exactly like DOCX today; the file keeps its name-only row.
- **RTF reuse.** `.msg` files whose only body is compressed RTF (today
  indexed as headers + attachment names) get their body through
  `@kenjiuno/decompressrtf` (already shipped with msgreader) + the same
  stripper.

## B. Containers (local-folder only)

### B1. What is a container

| Container | Detected by | Child type | Child externalId | Child content |
|---|---|---|---|---|
| mbox | `.mbox`; extensionless file with a sibling `<name>.msf` (Thunderbird) | `email.message` | `<absPath>#msg:<sha1(Message-ID) or sha1(raw headers)>` | `renderMail` layout |
| PST | `.pst` | `email.message` | `<absPath>#pst:<NID>` | `renderMail` layout; `metadata.folder` |
| ZIP | `.zip` (Takeout, WhatsApp, LinkedIn, Slack exports…) | `file` | `<absPath>#zip:<member path>` | the member rendered by the A parsers; nested mailboxes see B2 |
| vCard | `.vcf` (always, even one card) | `contact.card` | `<absPath>#vcf:<UID or sha1(FN+first EMAIL)>` | `# Name`, org, title, emails, phones, address, note; PHOTO/LOGO/SOUND dropped |
| Evernote | `.enex` | `note` | `<absPath>#enex:<sha1(title+created)>` | ENML → turndown; tags, created/updated, source URL; resource filenames listed |

- `email.message` children are built like IMAP items: metadata `from:
  string`, `to: string[]`, `cc: string[]`, `replyTo`, `references`,
  `date`, `subject`, `messageId`; `contactEvidence` from the shared
  `extractMessageEvidence` (`sources/email-evidence.ts`); automated mail
  dropped by `isAutomatedMessage` (`imap/filter.ts`), as IMAP does. Both
  helpers are pure and run in the converter child. People's mention and
  signature scans then pick up mbox/PST correspondents with no People
  change.
- Every child inherits the container's `scopeRootId`, so folder
  deselection archives children with the container (scope handling in
  `write-tx` archives by `scope_root_id`, not by parent).
- Children carry `metadata.conversion = {status:'ok'}` and
  `metadata.extraction` set, and **no `absPath`**, so the convert, vision
  and audio workers skip them and `fetchBytes` returns null for them.
  ZIP media members (images, audio, video) are name-only children.
- The container row is `type: 'file'` whose markdown is a summary
  (`# Inbox — 4,812 messages, 2014–2026`; top folders for PST; member
  list head for ZIP) and which carries `metadata.conversion =
  {status:'ok'}` from its first emission (first emission markdown:
  `# <name>` + "Reading…", ≥ `HAS_TEXT_CHARS`), so workers never chase it.
- `descriptor.documentTypes` of local-folder gains `email.message`,
  `contact.card`, `note` (extensions discover accounts by type).

### B2. Expansion op (converter child)

One new child op, paged and **path-based** (no bytes cross the boundary):

```ts
{ op: 'expandPage'; path: string; kind: ContainerKind;
  resume: unknown | null;            // opaque, from the previous page
  budget: { items: number; bytes: number } }
→ { items: ChildItem[]; resume: unknown | null; summary?: string }
```

- Returns up to `budget.items` children (default 200) or `budget.bytes`
  of rendered markdown (default 16 MiB). `resume: null` means done.
  `resume` is per kind and tiny: byte offset (mbox), NID cursor (PST),
  `{member, inner}` (ZIP), card/note index (vCard/ENEX).
- **Input bounds, not just output bounds.** mbox and ENEX stream and
  hand at most **8 MiB raw per item** to the item parser (`simpleParser`
  for mail, `@xmldom/xmldom` for one ENEX `<note>`); an oversized item
  keeps its headers and the body prefix, and its tail (normally base64
  attachments or ENEX `<resource>` data) is discarded unparsed, with a
  "truncated" note. ENEX is split on `<note>`/`</note>` boundaries by a
  line scanner; `sax` is not shipped and is not added.
- ZIP: `yauzl` random access, one member at a time. Each member is
  routed by the **same policy** as a local file:
  `decideFileIndexing({profile:'local-folder', filename: member,
  sizeBytes})` → `ignore` skips it (sensitive basenames inside a zipped
  repo included); `inline-text` decodes it with the same NUL sniff as
  `buildItem` (Takeout/Slack/WhatsApp `.json`/`.txt`/`.csv`/`.html`);
  `converter` runs `parseDetailed` (all kinds, A included); `vision`/
  `audio` → name-only child; `container` → nested expansion (below).
  Ordinary members over 20 MiB uncompressed are name-only. 100:1 ratio
  and 100k-children guards.
- **Mailboxes/vCards/ENEX inside a ZIP** (Takeout's `All mail Including
  Spam and Trash.mbox`): the member is streamed to a managed temp file
  (`<userData>/expand-tmp/<sha1(absPath+member)>`) and then paged by the
  same path-based pager; `resume = {member, inner}`. The temp file is
  deleted when the member finishes, on container change, and at startup
  for any file no cursor references; if it is missing on resume it is
  re-extracted. Exempt from the 20 MiB member cap; skipped (name-only)
  when free disk is below 2× the member size. Children are flat under the
  ZIP: `<absPath>#zip:<member>#msg:<id>`.
- Thunderbird: messages whose `X-Mozilla-Status` has bit `0x0008`
  (expunged, not compacted) are skipped.
- **Runner.** `ConverterJob` gains the path variant; the runner's queue
  accounting counts path jobs as 0 bytes; the per-job timeout applies per
  page. The `Converter` interface (and its inline implementation) gets
  `expandPage`. One converter process, shared with the convert worker.

### B3. Source integration

- **Wiring.** `localFolderSource` becomes
  `createLocalFolderSource({ converter })` (the `createImapSource()`
  pattern); `registerBundledSources` receives the platform converter from
  `main.ts`. No `Session`, SDK or public Source contract change.

- **Admission (branch order is part of the spec).** In
  `decideFileIndexing`, a new **container branch sits right after step 2
  (`no-extension`)**, before the archive, text and converter steps, on the
  `local-folder` profile only: `.mbox`, `.pst`, `.zip`, `.vcf`, `.enex`,
  or `mime === 'application/mbox'` → `{kind:'index', pipeline:'container',
  bytes:'none'}`, no size cap (containers are read by path, never
  buffered). Placing it first is what keeps local `.zip` out of the
  `ARCHIVE_MIMES` check, `.vcf` out of `LOCAL_TEXT_EXTENSIONS` and
  `application/mbox` out of `LOCAL_CONVERTER_MIMES` (all three lists are
  left as they are for the cloud profile). Step 2 gains one exception:
  `mime === 'application/mbox'`. In `convertibleKind`, `subtitles` is
  matched before the `text/*` fallback.
  The `.msf` sibling check lives in **`decideLocalFile`/`isIngestible`**
  (one `existsSync` per extensionless file), the single gate that
  `walkPaths`, `reconcile`, `countFiles` and the watcher filter use.
  `incrementalRescanRoot` builds its `newlyAdmitted` candidate through the
  same adapter (today it calls `resolvePathMime` directly), so an
  unchanged Thunderbird folder is re-admitted on the version-4 upgrade.
  If both the mbox and its `.msf` vanish, the watcher may filter the
  unlink; reconcile is the backstop.

- **One writer for the container row.** The scan path (backfill, rescan,
  watcher `add`/`change`, policy re-emission) never emits a container
  document and never turns a container into a deletion: `buildItem`
  returns a `{ container: absPath, stat }` marker that `buildBatch`
  routes into the cursor's `expansions` record. The **expander** is the
  only writer of the container row: a placeholder (`# <name>` + "Reading…",
  `conversion: ok`) in the first page's batch, the summary in the last
  page's batch. A real unlink still emits the deletion (watcher `unlink`,
  reconcile), which archives the container and its children.

- **Cursor record.** The local-folder cursor gains
  `expansions: { [absPath]: Expansion }`:

  ```ts
  type Expansion =
    | { state: 'pending'; size: number; mtimeMs: number;
        resume: unknown | null; cleared: boolean; attempts: number }
    | { state: 'done'; size: number; mtimeMs: number; end?: number }
    | { state: 'failed'; size: number; mtimeMs: number };
  ```

  Only `pending` records are scheduled. `done` and `failed` are compact
  and kept until the file changes or leaves scope (an address book of many
  single-card `.vcf` files costs one small record each). `end` is the mbox
  byte offset after the last message read. `cleared` records that the
  full-path deletion batch has committed (below), so a restart between
  the deletion and the re-emission resumes the re-emission instead of
  deleting again. Each page's children are yielded as one batch whose
  cursor carries the advanced record, so progress commits with the
  children and survives restarts.

- **Change detection.**
  - **mbox (incl. Thunderbird):** size only, never mtime. Thunderbird
    rewrites `X-Mozilla-Status` flags in place on every read/flag change
    (mtime moves, size does not).
    - Size unchanged → nothing (flag changes are picked up at the next
      compaction, which shrinks the file).
    - Size grew and the bytes at `end` start a `From ` line (or `end` is
      the old EOF) → **append fast path**: resume from `end`; only new
      messages are written.
    - Otherwise (shrank, or `end` no longer lands on a message boundary)
      → full path.
    - The fallback child id `sha1(raw headers)` excludes `X-Mozilla-*`
      and `Status`/`X-Status` headers, so flag flips never mint new ids.
  - **PST, ZIP, vCard, ENEX:** `size` or `mtimeMs` changed → full path,
    except that a PST is only re-expanded once its mtime has been stable
    for 10 minutes (Outlook writes an open PST continuously).
  - **Full path:** yield a deletions-only batch for the container
    (`Batch.deletions` → `archiveByRef` → `archiveChildren` archives it
    and all its children) with `cleared: true` in its cursor, then the
    pages from `resume: null`. `upsertDocument` un-archives every
    re-emitted child; whatever is not re-emitted stays archived. The two
    are separate batches because deletions apply after documents within
    one commit. Accepted costs: a full re-expansion rewrites every child,
    and the container's items are missing from search while it runs.

- **Driving.** One loop, watcher first:
  1. The watcher is created **before** any expansion work (today it is
     created inside `watchLoop` with `ignoreInitial: true`, so starting
     it after a long expansion would miss changes made meanwhile).
  2. Backfill and incremental rescan run as today, recording containers
     as `pending`.
  3. The loop then alternates: one pending fs-event batch, then one page
     of the oldest `pending` expansion; it blocks on the watcher only when
     no expansion is pending. The initial drain and steady state are the
     same path.
  4. A page that throws or times out bumps `attempts`; at 3 the record
     becomes `failed` (the container's summary row says "Could not read
     this file") until its size or mtime changes. Ordinary indexing never
     waits on a failing container.

- **Deletion and scope.** Deleting or un-admitting a container archives
  it and its children via the existing parent cascade; deselecting its
  folder archives them via the inherited `scopeRootId`. Both drop the
  `expansions` record (and any temp file), so re-adding re-expands.

- **Reconcile guard.** `reconcile` keeps listing files only (children of
  a listed parent are exempt in `unlisted()`). The store's
  `reconcileDiff` counts only **top-level** rows (`parent_id IS NULL` in
  both its live and gone counts), so deleting a 100k-message PST while
  the app was closed does not trip "the listing shrank suspiciously".
  `archiveBatchTx` is unchanged and still cascades to children. This is
  the one store change.

### B4. PST

- Library: `pst-extractor` (MIT, pure JS port of java-libpst, 1.12.0,
  2026-01), opened on the file path. **Phase 3 starts with a spike** on a
  real multi-GB PST: converter child RSS < 400 MB through the whole file;
  resume by NID; cost of re-opening a multi-GB file per page (if high,
  the child keeps the open handle between pages of the same container);
  bodies as text/HTML, RTF-only bodies through the A-section RTF path;
  behaviour on a PST Outlook has open. If the spike fails the memory bar,
  PST drops to an issue and phases 1–2 are unaffected.
- Children: messages only (no calendar/contacts/tasks items in v1),
  `metadata.folder` set, attachment names in the markdown.
- A locked PST (Windows, `EBUSY`): keep `resume`, do not count an
  attempt, retry next pass.

## Re-enumeration (per phase)

Each independently shipped phase bumps `FILE_POLICY_VERSION` and lists
every newly admitted extension, local and cloud:

| Phase | Version | `ADMITTED_SINCE[v]` |
|---|---|---|
| 1 | 3 | `pptx, odt, ods, epub, doc, rtf, srt, vtt, csv, xls, html` (the last three for cloud rescue) |
| 2 | 4 | `mbox, zip, vcf, enex` (+ extensionless mbox via the `.msf` rule, re-checked by the rescan) |
| 3 | 5 | `pst` |

`newlyAdmitted` re-emits rows whose extension is listed for any version
above the stored one, so upgrading from any intermediate release works.
Tests cover v2→v5 directly and v3→v4→v5 stepwise. `.mbox`/`.vcf`/`.enex`
were already indexed (single doc or raw text); re-emission turns them into
containers.

## Rollout

1. **Phase 1 (core):** section A + version 3.
2. **Phase 2 (core):** section B for mbox (incl. Thunderbird), ZIP,
   vCard, ENEX + version 4 + the reconcile-ratio change.
3. **Phase 3 (core):** PST behind the spike + version 5.
4. **Cloud:** regenerate `@kiagent/connector-sdk` with the phase-1
   policy, release it, bump OneDrive and Google Docs connectors (they pin
   different SDK versions today) and release them via the Marketplace.
   Independent of phases 2–3.
5. **alpha-cent:** update the `extensions/documents` policy mirror and
   `fs-mirrors.test.ts`; declare `jszip`, `@xmldom/xmldom`,
   `word-extractor`, `yauzl`, `pst-extractor` in `release/app` and root
   `package.json`; `.gitattributes` binary lines for new fixtures.

## Testing

- Per parser: a small real fixture (`*.ext binary` in `.gitattributes`)
  plus empty, corrupt and oversized-part cases.
- Policy: `file-indexability.test.ts` rows for every new extension on
  both profiles; SDK `generate.test.mjs` green; upgrade tests per the
  re-enumeration table.
- Expansion:
  - mbox fixture (3 messages) → 3 children + summary; append one → fast
    path writes exactly 1; rewrite with one removed → full path leaves
    exactly that one archived; restart mid-expansion resumes from cursor.
  - Same delete/re-add shape for ZIP members and vCard cards.
  - A quiet root (no file events) still drains a pending expansion.
  - One oversized message (30 MB attachment) keeps child RSS bounded and
    yields a truncated child.
  - Takeout-shaped ZIP with a nested `.mbox` → flat children under the
    ZIP; temp file removed after.
  - Workers: container and children never get a `conversion` marker
    other than `ok`, and vision/convert do not fetch them.
  - Reconcile with a deleted 1k-child container does not trip the guard.
  - An ordinary file changed during a long initial expansion is indexed
    (watcher started first).
  - Thunderbird flag rewrite (same size, new mtime) writes nothing;
    restart after the full-path deletion batch re-emits without a second
    deletion; a `failed` container stays quiet across restart until it
    changes.
  - The scan path never overwrites the container summary (watch `change`
    and policy re-emission).
  - Upgrade: an extensionless Thunderbird mbox older than the root
    watermark is admitted on the version-4 re-enumeration.
- Thunderbird: extensionless + `.msf` admitted by scan AND watcher;
  without `.msf` ignored; expunged message skipped.
- Memory gate (phases 2–3): a 2 GB mbox and the PST spike file keep the
  converter child under 400 MB RSS.
