# File formats batch: Office, e-books, transcripts, mail archives, ZIP, PST

Status: r1 (draft for review) · 2026-10-13
Scope came from the format coverage review (value ≥ 3 and difficulty ≤ 2,
plus PST). Deferred formats are filed as `priority:low` issues #148–#164.

## Problem

Kia ignores or under-reads formats users have in quantity:

- **Not indexed at all:** `.pptx`, `.odt`, `.ods`, `.epub`, `.doc`, `.rtf`,
  Thunderbird mail folders (extensionless mbox), every `.zip` (so Google
  Takeout, WhatsApp, LinkedIn and Slack exports), Outlook `.pst`.
- **Indexed badly:** `.mbox` is ONE document capped at 500 messages
  (`parsers.ts` `MBOX_MAX_MESSAGES`); `.srt`/`.vtt` are raw text full of
  timestamps; `.vcf` and `.enex` are raw text/XML with base64 blobs.
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
4. Memory stays bounded for multi-GB containers (PST, Takeout parts,
   long-lived Thunderbird folders).

## Non-goals

- Formats in issues #148–#164 (ODP, OLM, Numbers, Pages, Keynote, `.ics`,
  TAR, 7z, RAR, OST, OneNote, Maildir, MHTML, webarchive, ipynb, Kindle).
- Containers in the **cloud** (a `.zip`/`.pst`/`.mbox` on Drive). Cloud
  gets the single-file formats only; containers are local-folder only.
- Attachments inside a message from a container as their own documents.
  Names only, like `.eml` and `.msg` today (children are one level deep).
- Feeding vCard contacts into People. Cards become documents of a new type;
  People adopting that type is a follow-up in the People extension.
- A UI affordance to "add Thunderbird". The user adds the profile folder as
  a normal local root (nothing in `DEFAULT_EXCLUDE_GLOBS` blocks it).
- Password-protected ZIP members, nested archives (a zip inside a zip).

## Design overview

Two mechanisms, deliberately separate:

- **A. Single-file formats** reuse the existing pipeline unchanged:
  a new `ConvertibleKind`, a parser in the converter child, policy
  admission, `FILE_POLICY_VERSION` 3. No new architecture.
- **B. Containers** add ONE new capability to the local-folder source:
  *expansion*. A container file stays one `file` document (a short summary
  as its markdown) and gets **child documents** with deterministic ids,
  produced page by page by the converter child reading the file **by
  path**, and committed through the source's normal batches.

Why expansion lives in the source, not the convert worker: worker
`session.emit` commits under the worker's synthetic account, but children
must share the file's account (parent resolution, account removal,
reconcile exemption of children whose parent is listed). The source
already owns the path, the cursor and the account; the converter child
already gives crash isolation and a timeout.

## A. Single-file formats

| Format | Kind | Parser (converter child) | New dependency |
|---|---|---|---|
| `.pptx` | `presentation` | jszip + @xmldom/xmldom: `ppt/presentation.xml` slide order → `ppt/slides/slideN.xml` text, `ppt/notesSlides/*`, `docProps/core.xml` | none (both already ship via mammoth; declare them in `release/app`) |
| `.odt` | `odf-text` | jszip: `content.xml` paragraphs, headings, lists, tables; `meta.xml` title | none |
| `.ods` | `spreadsheet` | SheetJS (already reads ODS) | none |
| `.epub` | `epub` | jszip: `META-INF/container.xml` → OPF metadata + spine → XHTML → turndown | none |
| `.doc` | `word97` | `word-extractor` (MIT, pure JS): body, headers/footers, footnotes, comments | `word-extractor` |
| `.rtf` | `rtf` | small in-house RTF→text stripper (control words, `\'hh` with `\ansicpg`, `\u` escapes, skip `\pict`/`\*` destinations) | none |
| `.srt` `.vtt` | `subtitles` | in-house: drop cue numbers and timing lines, merge cues, a `[mm:ss]` marker per minute | none |

Rules shared by all of A:

- **Markdown shape.** First line `# <title>` (document title from
  properties, else filename). PPTX: `## Slide N — <slide title>`, body,
  then `### Notes`. EPUB: chapter headings from the spine order.
  Output stays capped by `MAX_MARKDOWN_CHARS` (2 MiB).
- **Zip safety for OOXML/ODF/EPUB parts.** Read only the parts named
  above; refuse any single part whose uncompressed size (central
  directory) exceeds 20 MiB, and stop after 50 MiB inflated in total.
  Media parts are never inflated.
- **Policy.** Add the MIMEs to `LOCAL_CONVERTER_MIMES` and, except
  subtitles, to `CLOUD_CONVERTER_MIMES`; move `srt`/`vtt` from
  `LOCAL_TEXT_EXTENSIONS` to the converter pipeline. Extend the cloud
  extension rescue (today `{msg, eml}`) with `{pptx, odt, ods, epub, doc,
  rtf, csv, xls, html}` for generic MIMEs, and add
  `application/vnd.ms-excel` to `CLOUD_CONVERTER_MIMES` (closes the cloud
  `.xls`/`.csv` gap). Size caps and the `docCap` ladder are unchanged.
- **Re-enumeration.** `FILE_POLICY_VERSION = 3`,
  `ADMITTED_SINCE[3] = {pptx, odt, ods, epub, doc, rtf, srt, vtt}`.
  `srt`/`vtt` rows were eager text; listing them re-emits them so they
  convert. Cloud rows come back when each connector picks up the new SDK.
- **Failure.** A parser throw records `conversion.status = 'failed'`
  exactly like DOCX today; the file keeps its name-only row.

## B. Containers (local-folder only)

### B1. What is a container

| Container | Detected by | Child type | Child externalId suffix | Child content |
|---|---|---|---|---|
| mbox (`.mbox`, and Thunderbird) | `.mbox` ext; extensionless file with a sibling `<name>.msf` | `email.message` | `#msg:<sha1(Message-ID) or sha1(headers)>` | email layout (`renderMail`) |
| PST | `.pst` | `email.message` | `#pst:<NID>` | email layout; folder path in metadata |
| ZIP | `.zip` (incl. Takeout, WhatsApp, LinkedIn, Slack exports) | `file` | `#zip:<member path>` | the member, converted as if it were a local file of that name |
| vCard | `.vcf` with more than one card | `contact.card` | `#vcf:<UID or sha1(FN+EMAIL)>` | `# Name`, org, title, emails, phones, address, note; PHOTO dropped |
| Evernote | `.enex` | `note` | `#enex:<sha1(title+created)>` | ENML → turndown; tags, created/updated, source URL |

Children use the `email.message` metadata shape the IMAP source writes
(`from`, `to`, `cc`, `date`, `subject`, `messageId`), so People's existing
mention scan picks up mbox and PST correspondents with no People change.

The container's own row stays `type: 'file'` with a summary markdown
(`# Inbox — 4,812 messages, 2014–2026`, top folders for PST, member count
for ZIP) so the file itself remains findable by name and content summary.

### B2. Expansion protocol (converter child)

One new child op, paged and **path-based** (no bytes cross the boundary):

```ts
{ op: 'expandPage'; path: string; kind: ContainerKind;
  resume: unknown | null;           // opaque, from the previous page
  budget: { items: number; bytes: number } }
→ { items: ChildItem[]; resume: unknown | null; summary?: string }
```

- The child opens the file read-only, seeks/streams from `resume`, and
  returns up to `budget.items` children (default 200) or `budget.bytes`
  of rendered markdown (default 16 MiB). `resume: null` means done.
- `resume` is per kind and tiny: a byte offset (mbox), a NID cursor (PST),
  a central-directory index (ZIP), a card/note index (vCard/ENEX).
- **Memory.** mbox and ENEX stream; ZIP uses `yauzl` random access (one
  member at a time); PST uses `pst-extractor` on the file path. The child
  never holds the whole file. The existing per-job timeout applies per
  page, not per file.
- ZIP members: a member whose own name the policy would admit is rendered
  in the child by the same parsers as A (members ≤ 20 MiB uncompressed;
  larger members get a name-only child). Members that are themselves
  mailboxes (Takeout's `All mail Including Spam and Trash.mbox`) are
  expanded **in place**: their messages become children of the ZIP file
  with suffix `#zip:<member>#msg:<id>`. Parenting stays one level deep.
  Expansion is capped at 100k children per container and a 100:1
  compression ratio per member (zip-bomb guard).
- Thunderbird: messages whose `X-Mozilla-Status` has bit `0x0008`
  (expunged, not yet compacted) are skipped.

### B3. Source integration

- **Policy.** `decideFileIndexing` gains `pipeline: 'container'` for
  `.mbox`, `.pst`, `.zip`, `.vcf`, `.enex` (removing `zip` from
  `ARCHIVE_EXTENSIONS` for the local profile only) with `bytes: 'none'`
  and **no size cap**: containers are read by path, never buffered.
  Extensionless files stay `no-extension` unless the caller passes
  `mime: 'application/mbox'`; the local walker does that for a file whose
  sibling `<name>.msf` exists. The shared function stays pure.
- **Cursor.** The local-folder cursor gains
  `expansions: { [absPath]: { stamp, resume, generation } }` where
  `stamp = size + mtimeMs`. `pull` interleaves: after each normal file
  batch it runs one `expandPage` for the oldest pending expansion and
  yields its children as a batch (parent ref = the container's
  `{externalId: absPath, type: 'file'}`). The container's own doc is
  emitted in the normal file batch first, so the parent always exists.
- **Change detection.**
  - Container `stamp` unchanged → nothing to do.
  - Changed → new `generation`, `resume = null`, re-expand. Unchanged
    children are no-op writes (content hash short-circuit).
  - **mbox append fast path:** if the file only grew and a hash of its
    first 64 KiB is unchanged, resume from the previous end offset with
    the same generation (Thunderbird appends; compaction rewrites and
    trips the full path).
- **Stale children.** When a generation finishes (`resume: null`), the
  source re-emits the container doc with
  `metadata.expansion = { generation, complete: true, count }`. The
  engine, on committing a `file` doc carrying a completed generation,
  archives that doc's children whose `metadata.expansion.generation` is
  older. Children carry their generation in metadata. This is the only
  engine change; it is a few lines in `write-tx` next to the existing
  "archive parent archives children" path.
- **Deletion and reconcile.** Deleting or un-admitting the container
  file archives its children through the existing parent→children
  archive path. `reconcile` keeps listing files only; children of a
  listed parent are already exempt in `unlisted()`.
- **Watcher.** chokidar `change` on a container updates its stamp; the
  next `pull` picks it up. Thunderbird rewrites folders often; the
  append fast path keeps that cheap.
- **Fairness.** One expansion page per file batch keeps a 10 GB PST from
  starving ordinary files; expansion resumes across restarts from the
  cursor.

### B4. PST specifics

- Library: `pst-extractor` (MIT, pure JS port of java-libpst, 1.12.0,
  2026-01). **Phase 3 starts with a spike** on a real multi-GB PST:
  child RSS < 400 MB across the whole file, resume by NID works, bodies
  available as text/HTML; RTF-only bodies go through
  `@kenjiuno/decompressrtf` + the A-section RTF stripper. If the spike
  fails the memory bar, PST drops to an issue; the rest ships.
- Children: messages only (no calendar/contacts/tasks items in v1).
  Folder path in `metadata.folder`; attachment names in the markdown.
- A PST open in Outlook can be locked on Windows: the child opens with
  shared read; on `EBUSY` the expansion keeps its resume and retries
  next pass.

### B5. vCard and ENEX

- A `.vcf` with exactly one card stays a single document (A-style, kind
  `vcard`), so a lone contact file reads naturally.
- vCard 2.1 quoted-printable + `CHARSET=` are decoded; PHOTO/LOGO/SOUND
  are dropped before rendering. Library: `vcard4` (ISC) or an in-house
  line parser if `vcard4` mishandles 2.1 (decide in the plan with a
  fixture).
- ENEX: streamed with `sax` (already present via mammoth) one `<note>` at
  a time; resources are dropped, their filenames listed.

## Rollout

1. **Phase 1 (core):** section A local + `FILE_POLICY_VERSION` 3.
2. **Phase 2 (core):** section B with mbox (incl. Thunderbird), ZIP,
   vCard, ENEX.
3. **Phase 3 (core):** PST behind the spike.
4. **Cloud:** regenerate `@kiagent/connector-sdk` with the new policy,
   release it, bump both connectors (OneDrive, Google Docs) and release
   them through the Marketplace. Independent of phases 2–3.
5. **alpha-cent:** update the `extensions/documents` policy mirror and
   `fs-mirrors.test.ts`; declare `jszip`, `@xmldom/xmldom`,
   `word-extractor`, `yauzl`, `pst-extractor` in `release/app` and root
   `package.json`; `.gitattributes` binary lines for new fixtures.

## Testing

- Per parser: a small real fixture (binary fixtures get `*.ext binary`
  in `.gitattributes`) plus the empty/corrupt/oversized-part cases.
- Policy: `file-indexability.test.ts` rows for every new extension and
  both profiles; SDK `generate.test.mjs` stays green.
- Expansion: a fixture mbox with 3 messages → 3 children + summary; append
  one → fast path adds 1, generation unchanged; rewrite (delete one) →
  new generation archives exactly 1. Same shape for ZIP (member removed)
  and vCard. Restart mid-expansion resumes from the cursor.
- Thunderbird: extensionless file + `.msf` admitted; without `.msf`
  ignored; expunged message skipped.
- Memory gate (phases 2–3): a 2 GB mbox and the PST spike file keep the
  converter child under 400 MB RSS.

## Open questions for review

1. Is the `metadata.expansion.generation` sweep in `write-tx` the
   simplest correct way to drop stale children, or is there an existing
   primitive to reuse?
2. Should ZIP members use type `file` (and get the convert worker's OCR /
   vision follow-ups) or always be rendered inline in the child (simpler,
   no `fetchBytes` for virtual paths)? The draft renders inline and skips
   OCR/vision for members.
