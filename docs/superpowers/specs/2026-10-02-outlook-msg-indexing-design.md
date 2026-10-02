# Outlook `.msg` files: index them like `.eml`

Status: r1 (draft) · 2026-10-02

## Problem

Outlook "Save As" `.msg` files sitting in folders are not indexed at all. A
client's data room lost four legal correspondence emails this way.

- `.msg` is Outlook's binary OLE/CFB format, not MIME, so `mailparser`
  cannot read it.
- `decideFileIndexing` returns `ignore: unsupported` for it on both
  profiles. Its MIME (`application/vnd.ms-outlook`) is in neither
  `LOCAL_CONVERTER_MIMES` nor `CLOUD_CONVERTER_MIMES`.
- `convertibleKind` has no case for it, so `.msg` **attachments** (Gmail,
  IMAP, ms365: forwarded-as-attachment Outlook mails are common) are not
  parsed either.

A second, smaller gap in the same place: cloud `.eml` is also
`unsupported`. The policy comment calls this out as deliberately deferred
"widening".

## Goals

- A `.msg` in a local folder, OneDrive or Google Drive, or attached to an
  email, is indexed with the same markdown shape as an `.eml`: subject as
  title; headers; body; attachment names.
- Cloud `.eml` is indexed too, since the cloud set is being widened anyway.

## Non-goals

- Indexing attachments *inside* a `.msg` as their own documents. We list
  their names, exactly like `.eml` today. Recursing is a separate feature.
- `.pst` / `.ost` mail stores (MB–GB archives; a different problem).
- Threading `.msg` files with mail from mail sources.

## Design

### Parser

Add `@kenjiuno/msgreader` as a dependency of the core runtime and of
`release/app`, like `mailparser`. It is:

- pure JS (no native build);
- Apache-2.0;
- v1.28.0, maintained, with two deps (`iconv-lite`,
  `@kenjiuno/decompressrtf`).

An OSS IQ check was attempted on 2026-10-02 but the tool crashed (an ossiq
bug, not a package finding). Re-run it at implementation time and pin the
recommended version.

In `core/engine/convert.ts`:

- `convertibleKind` maps MIME `application/vnd.ms-outlook` or ext `msg` to
  the existing `'email'` kind.
- `emailToMarkdown(buf, ext)` dispatches `ext === 'msg'` to a new
  `msgToMarkdown(buf)`.

`msgToMarkdown` emits the **same markdown layout** `emailToMarkdown`
produces for `.eml`: subject, From, To, Cc, Date, a blank line, the body,
then the attachment-names line. One layout means search snippets and the
MCP `get` view look the same whatever the mail format.

**Body preference:**

1. The plain `body`.
2. If that is empty, `bodyHtml` → the existing `htmlToMarkdown`.
3. If that is empty, the decompressed RTF body with control words stripped.
   For Outlook, RTF-only bodies are usually encapsulated HTML; when the RTF
   contains `\fromhtml1`, extract and use that HTML.

**Dates:** `messageDeliveryTime`, falling back to `clientSubmitTime`. Also
set the doc's `created_at` to that date, so the mail sorts by when it was
sent rather than by file mtime. This matches what local `.eml` does today;
confirm in `local-folder` scanner where it reads `mail.date`.

A file that fails to parse is recorded `conversion.status: 'failed'` by the
existing path. Nothing new is needed.

### Policy (`file-indexability.ts`)

- Add `application/vnd.ms-outlook` to `LOCAL_CONVERTER_MIMES`.
  - Local MIME comes from the extension via the `mime` package, which maps
    `msg` to it. Verify, and add an explicit ext mapping in
    `local-folder/mime.ts` if not.
- Add `application/vnd.ms-outlook` and `message/rfc822` to
  `CLOUD_CONVERTER_MIMES`.
- **Cloud ext fallback:** Graph and Drive often report `.msg` / `.eml` as
  `application/octet-stream`. In the cloud converter branch, a generic or
  missing MIME with ext `msg` or `eml` is admitted as the canonical MIME.
  The connectors pass that canonical MIME on to the engine.

Size: the same eager cap as other converter types. Email files are small;
no special case.

### Connectors

OneDrive and gdrive pick the policy up through the SDK's verbatim copy of
`file-indexability.ts` (`chooseRoute`), so each needs only:

- an SDK bump;
- a test fixture;
- a release.

The engine does the conversion. Connectors already ship converter-route
bytes as `DocumentInput.binary`, so there is no parser in the connectors.

**Existing files:** a `.msg` that was ignored has no row and is unchanged
upstream.

- gdrive's next full walk picks it up.
- OneDrive needs the cursor re-enumeration bump. If the large-file spec's
  OneDrive release ships at the same time, **one** cursor bump covers both.
- Local folders pick it up on the next rescan only if the rescan re-lists
  unchanged files the policy now admits. Confirm `incrementalRescanRoot`
  behaviour. If it filters on mtime only, bump the local policy version so
  one full rescan runs. The `schemaVersion` gate from strict indexability is
  the precedent.

### Attachments

Gmail, IMAP and ms365 attachments flow through the convert worker via
`convertibleKind`, so `.msg` attachments are parsed with no source change.

## Testing

- **Fixtures:**
  - a plain-text `.msg`;
  - an HTML-body `.msg`;
  - an RTF-only `.msg` (encapsulated HTML);
  - a `.msg` with attachments;
  - a German `.msg` with umlauts in subject and body (encoding through
    `iconv-lite`).

  Generate them with Outlook once, or use the msgreader repo's test
  fixtures if their licence allows.
- `convert.ts` unit tests check the markdown matches the `.eml` layout,
  with no mojibake in umlauts.
- Policy table tests:
  - local `.msg` → converter;
  - cloud `.msg` with `application/vnd.ms-outlook` → converter;
  - cloud `.msg` / `.eml` with `application/octet-stream` → converter;
  - cloud `.msg` over the eager cap → as the large-file spec decides.
- OneDrive / gdrive connector fixture tests: a `.msg` drive item downloads
  and emits binary with the canonical MIME.
- Live check: drop the four real-world `.msg` shapes into a local folder and
  find them by subject and body text through MCP search.
