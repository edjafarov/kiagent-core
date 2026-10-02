# Outlook `.msg` files: index them like `.eml`

Status: r2 (fable + codex-astra round 1 folded in) · 2026-10-02
Ships in the same core release as the large-file spec and reuses its §6
(policy re-enumeration) and §3 (convert worker version bump).

## Problem

Outlook "Save As" `.msg` files in folders are not indexed at all. A
client's data room lost four legal correspondence emails this way.

- `.msg` is Outlook's binary OLE/CFB format, which `mailparser` can't read.
- `decideFileIndexing` returns `ignore: unsupported`: its MIME,
  `application/vnd.ms-outlook`, is in neither converter set.
- `convertibleKind` has no case for it, so `.msg` **attachments** are not
  parsed either. Forwarded-as-attachment Outlook mails are common in
  Gmail, IMAP and ms365.
- Cloud `.eml` is `unsupported` too; the policy comment marks that as
  deferred widening.

## Goals

- A `.msg` in a local folder, OneDrive or Google Drive, or attached to an
  email, is indexed with the same markdown as an `.eml`: subject as title,
  headers, body and attachment names.
- Cloud `.eml` is indexed too.
- Files and attachments that are already present come back without user
  action.

## Non-goals

- Indexing attachments *inside* a `.msg` as their own documents. Names
  only, like `.eml`.
- `.pst` / `.ost` archives.
- Threading with mail-source messages.
- **Setting `created_at` from the message date.** `.eml` doesn't do it
  either: the scanner uses birthtime/mtime, and `parse()` and `EnrichInput`
  have no channel for it. If wanted, that is a follow-up covering both
  formats.

## Design

### Parser

Add `@kenjiuno/msgreader`. It is pure JS, Apache-2.0, v1.28.0, and has two
deps (`iconv-lite`, `@kenjiuno/decompressrtf`).

- **Where to declare it.** Like `mailparser`, it goes in
  `release/app/package.json` (the packaged runtime) **and** in the root
  `package.json` (dev and tests), in both kiagent-core and alpha-cent's
  overlay manifests. A missing packaged dep would make the `import()` fail
  and record every `.msg` as `failed`.
- **OSS IQ.** It crashed on 2026-10-02 (`UnboundLocalError:
  anyof_constraints`, an ossiq bug). Re-run it at implementation time with
  `OSSIQ_GITHUB_TOKEN` set, and pin the recommended version.

In `core/engine/convert.ts`:

- `convertibleKind` maps `application/vnd.ms-outlook` **or ext `msg`** to
  the existing `'email'` kind. It already falls back on the extension for
  `eml`/`emlx`/`mbox`, and every caller passes the filename. So a cloud
  `.msg` arriving as `application/octet-stream` parses with **no connector
  MIME change**.
- `emailToMarkdown(buf, ext)` dispatches `ext === 'msg'` to a new
  `msgToMarkdown(buf)`, which emits the **same markdown layout** as
  `.eml`: subject, From, To, Cc, Date, blank line, body, attachment names.
- **Body preference:**
  1. Plain `body`.
  2. Otherwise `bodyHtml` → `htmlToMarkdown`.
  3. Otherwise the decompressed RTF body. Use its encapsulated HTML when
     `\fromhtml1` is present; otherwise strip control words.
- A parse failure becomes `conversion: failed` through the existing path.

### Policy (`file-indexability.ts`)

- Local: add `application/vnd.ms-outlook` to `LOCAL_CONVERTER_MIMES`.
  `mime@3` already maps `.msg` to it (verified).
- Cloud:
  - Add `application/vnd.ms-outlook` and `message/rfc822` to
    `CLOUD_CONVERTER_MIMES`.
  - **Ext rescue.** The cloud converter branch is MIME-only today. When the
    MIME is missing or `application/octet-stream` and the ext is `msg` or
    `eml`, route to `converter`. Graph and Drive commonly report these
    files that way.
- Size: the same caps as other non-PDF documents (large-file spec §1–2).
- This widening is part of the large-file spec's `FILE_POLICY_VERSION`
  bump.

### Connectors

OneDrive and gdrive pick the policy up through the SDK's verbatim
`file-indexability.ts` (`chooseRoute`). Each connector needs the SDK bump,
a fixture test, and the release they already get for the large-file spec.
They keep emitting the provider MIME; the engine dispatches on the
extension.

### Recovering existing files and attachments

| Where | Mechanism |
|---|---|
| Local, OneDrive, gdrive files with no row | large-file §6 policy re-enumeration (same version bump) |
| Mail attachments already past the convert worker's cursor | large-file §3 convert worker version bump (same bump) |

## Testing

- **Fixtures:**
  - plain-text `.msg`;
  - HTML-body `.msg`;
  - RTF-only `.msg` (encapsulated HTML);
  - `.msg` with attachments;
  - German `.msg` with umlauts in subject and body.

  Generate them with Outlook once, or reuse msgreader's test fixtures if
  the licence allows.
- `convert.ts`: the markdown matches the `.eml` layout, and umlauts are
  intact.
- **Policy table:**
  - local `.msg` → converter;
  - cloud `.msg` as `vnd.ms-outlook` → converter;
  - cloud `.msg` / `.eml` as `octet-stream` → converter;
  - cloud `.msg` with no ext and `octet-stream` → unsupported.
- **Connector fixture:** a `.msg` drive item downloads and emits binary.
  The engine converts it via the extension.
- **Upgrade (engine integration):**
  - A local folder with an unchanged, previously ignored `.msg` and an old
    cursor indexes it after upgrade.
  - A Gmail attachment `.msg` already consumed by the old convert worker is
    parsed after the version bump.
- **Live:** the four real-world shapes in a local folder are findable by
  subject and body phrase through MCP search.
