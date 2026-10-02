# Outlook `.msg` Indexing Implementation Plan (core + connectors)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Outlook `.msg` files (local folders, OneDrive, Google Drive, mail attachments) and cloud `.eml` files are indexed with the same markdown layout as a local `.eml`.

**Architecture:**
- `.msg` maps to the existing `'email'` converter kind; `emailToMarkdown` dispatches it to `msgToMarkdown`, built on `@kenjiuno/msgreader`.
- Both formats render through one shared `renderMail()`, so the layout cannot drift.
- The policy admits `.msg` on both profiles and cloud `.eml`, with an extension rescue for generic MIMEs.
- Recovery rides the large-file plan's `FILE_POLICY_VERSION` bump (local `newlyAdmitted` via `ADMITTED_SINCE[2]`; cloud re-enumeration) and its convert-worker v2 replay (attachments). **No version is bumped here.**

**Tech Stack:** TypeScript, jest + ts-jest, `@kenjiuno/msgreader` 1.28.0 (Apache-2.0, pure JS), mailparser, turndown.

**Spec:** `docs/superpowers/specs/2026-10-02-outlook-msg-indexing-design.md` (r2)

## Global Constraints

- Lands **on top of** the large-file core plan (`2026-10-02-large-file-indexing.md`), in the same core release. It needs that plan's Task 1 (`bytes`, `ADMITTED_SINCE`), Task 3 (local recovery) and Task 5 (convert worker v2).
- The convert worker stays at `version: 2`, and `FILE_POLICY_VERSION` stays at 2. Do not bump either.
- `@kenjiuno/msgreader` is declared in **both** `release/app/package.json` (the packaged runtime, next to `mailparser`) and the root `package.json` (dev/tests), in kiagent-core **and** in alpha-cent's mirrors of both files.
- Body preference: plain `body` → `bodyHtml` → `html` bytes (decoded as UTF-8) → `htmlToMarkdown`.
- Commits: no `Co-Authored-By` line, never `--no-verify`, never amend. Builds and tests run sequentially.

**Spec deviation (deliberate).** The spec's third body source, the decompressed RTF, is **not** implemented. All 13 upstream sample messages that carry RTF also carry a plain `body`, and the realistic "no plain body" case ("new Outlook") ships HTML bytes. That case is covered here, with a real fixture. An RTF-only message still indexes its headers and attachment names. If one ever shows up empty in the field, add the RTF branch then.

## Setup

```bash
cd ~/work/kcore-indexing-specs     # on feat/large-file-indexing, after its Tasks 1, 3 and 5
git switch -c feat/outlook-msg     # or continue on the same branch; one core release either way
```

## Review Focus

1. **A received Exchange message whose sender is an X.500 DN** (`/O=EXCHANGELABS/…`). The From line must show the display name, not the DN. Fixture `sent2.msg`, Task 2.
2. **A "new Outlook" `.msg` with an empty plain body and only HTML bytes.** The body text must still be indexed. Fixture `html-only.msg`, Task 2.
3. **A `.msg` attached inside a `.msg`.** The attachment's `fileName` is undefined (only `name`), and the attachment list must not crash or print `undefined`. Fixture `msg-in-msg.msg`, Task 2.
4. **A cloud `.msg` that Graph or Drive reports as `application/octet-stream`.** It must be downloaded and converted, not ignored. Task 3 (policy) and Task 5 (connector fixture).
5. **A file that is not a real `.msg`** (renamed, truncated). It must record `conversion: failed` through the existing path, never crash the converter. Task 2.

---

### Task 1: Dependency and fixtures

**Files:**
- Modify: `package.json`, `release/app/package.json`, both lockfiles
- Create: `src/main/core/engine/__tests__/fixtures/msg/` (8 files plus `NOTICE`)

- [ ] **Step 1: OSS IQ check (the spec requires a re-run)**

```bash
OSSIQ_GITHUB_TOKEN=$(gh auth token) uvx --from ossiq ossiq info @kenjiuno/msgreader . --format agent
```

- **`block`:** stop and report.
- **`warn`/`ok`:** pin `recommended_version` when set, else `1.28.0`.
- **Tool crash again** (`UnboundLocalError: anyof_constraints`, seen on 2026-10-02): pin `1.28.0` and say so in the commit message.

- [ ] **Step 2: Declare the dependency in both manifests**

```bash
npm i --save-exact @kenjiuno/msgreader@1.28.0
npm i --prefix release/app --save-exact @kenjiuno/msgreader@1.28.0
node -e "require('@kenjiuno/msgreader')" && echo ok
```

- [ ] **Step 3: Copy the upstream fixtures (Apache-2.0)**

```bash
F=src/main/core/engine/__tests__/fixtures/msg; mkdir -p "$F"
U=https://raw.githubusercontent.com/HiraokaHyperTools/msgreader/v1.28.0/test
get() { curl -fsSL -o "$F/$2" "$U/$(python3 -c 'import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))' "$1")"; }
get "Simple.msg" plain.msg
get "attachmentFiles.msg" attachments.msg
get "Subject.msg" to-cc-bcc.msg
get "newOutlook Microsoft Outlook test.msg" html-only.msg
get "Hello +CJK.msg" unicode-cjk.msg
get "nonUnicodeMail.msg" ansi.msg
get "msgInMsg.msg" msg-in-msg.msg
get "sent2.msg" sent2.msg
ls -la "$F"   # 8 files, ~230 KB total
```

If the `v1.28.0` tag path 404s, use `master`. The files were inspected on 2026-10-02:

| File | Subject | Notable |
|---|---|---|
| `plain.msg` | Simple | body `Simple` |
| `attachments.msg` | attachmentFiles | from `hmailuser <hmailuser@hmailserver.test>`; attachments jpg.jpg, png.png, tif.tif |
| `to-cc-bcc.msg` | Subject | To `ToUser <to@example.com>`, Cc `ToCc <cc@example.com>`, Bcc `bcc@example.com` |
| `html-only.msg` | Microsoft Outlook テスト メッセージ | empty `body`; `html` bytes (UTF-8); text starts `この電子メール メッセージは` |
| `unicode-cjk.msg` | Hello +CJK | body has `你好`, `こんにちは`, `안녕하세요` |
| `ansi.msg` | Non Unicode mail subject | body `Non Unicode mail body!` |
| `msg-in-msg.msg` | I have attachments! | attachments: an embedded message (`name` only) and `green.png` |
| `sent2.msg` | Sending test | sender `UnoKenji`, senderEmail is an Exchange `/O=…` DN |

Write `$F/NOTICE`:

```
These .msg files are copied unmodified (renamed) from
https://github.com/HiraokaHyperTools/msgreader/tree/v1.28.0/test
Copyright HiraokaHyperTools, licensed under the Apache License 2.0.
```

The spec asked for a German fixture with umlauts. None exists upstream, and making one needs Outlook. `unicode-cjk.msg` (Unicode) and `ansi.msg` (codepage) exercise the same two decoding paths. The live check (Task 6) uses a real German message.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json release/app/package.json release/app/package-lock.json src/main/core/engine/__tests__/fixtures/msg
git commit -m "deps: @kenjiuno/msgreader 1.28.0 + upstream .msg fixtures"
```

---

### Task 2: `msgToMarkdown` and a shared mail renderer

**Files:**
- Modify: `src/main/core/engine/convert.ts` (`convertibleKind`, `emailToMarkdown`, new `renderMail`, `msgToMarkdown`)
- Test: `src/main/core/engine/__tests__/convert-email.test.ts`

**Interfaces:**
- Produces:
  - `convertibleKind('application/vnd.ms-outlook' | *, 'x.msg') === 'email'`
  - `renderMail(m: MailParts): Promise<string>` (module-private)

```ts
interface MailParts { subject?: string; from?: string; to?: string; cc?: string; date?: Date; attachments: string[]; body: string }
```

- [ ] **Step 1: Failing tests**

Append to `convert-email.test.ts`:

```ts
// Merge into the file's existing top-of-file imports (lint: import/first, no duplicates):
import fs from 'node:fs';
import path from 'node:path';
import { createConverter, convertibleKind } from '../convert';

const FIX = path.join(__dirname, 'fixtures', 'msg');
const msg = (name: string) => ({
  externalId: name, type: 'file', title: name, markdown: null,
  binary: { bytes: new Uint8Array(fs.readFileSync(path.join(FIX, name))), mime: 'application/vnd.ms-outlook', filename: name },
  metadata: {},
}) as never;

describe('converter: Outlook .msg', () => {
  const convert = createConverter(logs as never);

  it('routes .msg to the email kind by MIME or by extension alone', () => {
    expect(convertibleKind('application/vnd.ms-outlook', 'a.msg')).toBe('email');
    expect(convertibleKind('application/octet-stream', 'A.MSG')).toBe('email');
    expect(convertibleKind(null, 'a.msg')).toBe('email');
  });

  it('renders the same layout as .eml: subject heading, From, To, Date, body', async () => {
    const md = (await convert(msg('attachments.msg'))).markdown!;
    expect(md.startsWith('# attachmentFiles')).toBe(true);
    expect(md).toContain('**From:** hmailuser <hmailuser@hmailserver.test>');
    expect(md).toContain('**To:** hmailuser@hmailserver.test');
    expect(md).toMatch(/\*\*Date:\*\* 2023-11-01T00:48:31/);
    expect(md).toContain('**Attachments:** jpg.jpg, png.png, tif.tif');
  });

  it('lists To and Cc, never Bcc', async () => {
    const md = (await convert(msg('to-cc-bcc.msg'))).markdown!;
    expect(md).toContain('**To:** ToUser <to@example.com>');
    expect(md).toContain('**Cc:** ToCc <cc@example.com>');
    expect(md).not.toContain('bcc@example.com');
    expect(md).toContain('Message');
  });

  it('falls back to the HTML bytes when the plain body is empty (new Outlook)', async () => {
    const md = (await convert(msg('html-only.msg'))).markdown!;
    expect(md).toContain('# Microsoft Outlook テスト メッセージ');
    expect(md).toContain('この電子メール メッセージは');
    expect(md).not.toContain('<meta');
  });

  it('keeps Unicode and ANSI bodies intact', async () => {
    const cjk = (await convert(msg('unicode-cjk.msg'))).markdown!;
    expect(cjk).toContain('你好');
    expect(cjk).toContain('안녕하세요');
    expect((await convert(msg('ansi.msg'))).markdown).toContain('Non Unicode mail body!');
  });

  it('names an embedded-message attachment by its name and never prints undefined', async () => {
    const md = (await convert(msg('msg-in-msg.msg'))).markdown!;
    expect(md).toContain('**Attachments:** Microsoft Outlook テスト メッセージ, green.png');
    expect(md).not.toContain('undefined');
  });

  it('shows the display name, not an Exchange X.500 DN, for an EX sender', async () => {
    const md = (await convert(msg('sent2.msg'))).markdown!;
    expect(md).toContain('**From:** UnoKenji');
    expect(md).not.toContain('/O=EXCHANGELABS');
  });

  it('an extensionless attachment with the Outlook MIME is parsed by msgreader, not mailparser', async () => {
    const m = msg('plain.msg') as any;
    const out = await convert({ ...m, title: 'attachment', binary: { ...m.binary, filename: 'attachment' } } as never);
    expect(out.markdown!.startsWith('# Simple')).toBe(true);
  });

  it('a file that is not a real .msg leaves markdown null (convert worker records failed)', async () => {
    const bad = { ...(msg('plain.msg') as any), binary: { bytes: new Uint8Array(64), mime: 'application/vnd.ms-outlook', filename: 'bad.msg' } };
    const out = await convert(bad as never);
    expect(out.markdown ?? null).toBeNull();
    expect(out.binary).toBeUndefined();
  });

  it('.eml output is unchanged apart from the new Cc line', async () => {
    const parts = (await convert(input('note.eml', 'message/rfc822', EML))).markdown!.split('\n\n');
    expect(parts[0]).toBe('# Notes on the Analytical Engine');
    // mailparser 3.9 quotes display names ("Ada Lovelace"); pin layout + order, not its quoting
    expect(parts[1]).toMatch(/^\*\*From:\*\* "?Ada Lovelace"? <ada@example\.com>$/);
    expect(parts[2]).toMatch(/^\*\*To:\*\* "?Charles Babbage"? <charles@example\.com>$/);
    expect(parts[3]).toBe('**Date:** 1843-08-12T09:00:00.000Z');
  });
});
```

The convert-worker path (`parse()` throwing → `record('failed')`) already has coverage. The "not a real .msg" case only pins that `parse` throws rather than returning garbage. `createConverter` swallows the throw and returns markdown-less, as the last existing test in this file shows.

- [ ] **Step 2: Run, and confirm they fail**

Run: `npx jest src/main/core/engine/__tests__/convert-email.test.ts`
Expected: FAIL. `.msg` returns null today, and there is no `Cc` line.

- [ ] **Step 3: Implement**

In `convertibleKind`, extend the email branch:

```ts
  if (
    m === 'message/rfc822' ||
    m === 'application/mbox' ||
    m === 'application/vnd.ms-outlook' ||
    ['eml', 'emlx', 'mbox', 'msg'].includes(ext)
  )
    return 'email';
```

Then extract the shared renderer, and make the `.eml` `render` use it:

```ts
interface MailParts { subject?: string; from?: string; to?: string; cc?: string; date?: Date; attachments: string[]; body: string }

/** The ONE email layout, for .eml/.emlx/.mbox (mailparser) and .msg
 *  (msgreader) alike, so search sees the same shape whatever the format. */
function renderMail(m: MailParts): string {
  const head: string[] = [];
  if (m.subject) head.push(`# ${m.subject}`);
  if (m.from) head.push(`**From:** ${m.from}`);
  if (m.to) head.push(`**To:** ${m.to}`);
  if (m.cc) head.push(`**Cc:** ${m.cc}`);
  if (m.date && !Number.isNaN(m.date.getTime())) head.push(`**Date:** ${m.date.toISOString()}`);
  if (m.attachments.length > 0) head.push(`**Attachments:** ${m.attachments.join(', ')}`);
  return [head.join('\n\n'), m.body.trim()].filter(Boolean).join('\n\n');
}
```

In `emailToMarkdown`, `render` becomes:

```ts
  const render = async (raw: Buffer): Promise<string> => {
    const mail = await simpleParser(raw);
    const addr = (v: unknown): string =>
      v && typeof v === 'object' && 'text' in (v as Record<string, unknown>)
        ? String((v as { text?: string }).text ?? '') : '';
    const list = (v: unknown) => (Array.isArray(v) ? v.map(addr).join(', ') : addr(v));
    return renderMail({
      subject: mail.subject, from: addr(mail.from), to: list(mail.to), cc: list(mail.cc), date: mail.date,
      attachments: (mail.attachments ?? []).map((a) => a.filename).filter((n): n is string => Boolean(n)),
      // `text` is the decoded text/plain part; fall back to the HTML part.
      body: mail.text ?? (mail.html ? await htmlToMarkdown(mail.html) : ''),
    });
  };
  // Outlook's binary CFB format: by extension OR by MIME (an extensionless
  // attachment carries only the MIME; mailparser would read nothing from it).
  if (ext === 'msg' || mime === 'application/vnd.ms-outlook') return msgToMarkdown(buf);
```

Add that line before the `emlx` branch. `emailToMarkdown` gains a `mime` parameter: `parse()` passes the lower-cased MIME it already has (`emailToMarkdown(buf, ext, (mime ?? '').toLowerCase())`). Update the function's doc comment: "`.msg` goes through msgreader".

```ts
/** Outlook .msg → the same markdown as .eml. Body: plain text, else the HTML
 *  body (string or, from "new Outlook", raw UTF-8 bytes). RTF-only messages
 *  index headers + attachment names (see plan: deliberate spec deviation). */
async function msgToMarkdown(buf: Buffer): Promise<string> {
  // A typed lazy require, NOT `await import()`: under module node16 a dynamic
  // import of this CJS package yields the class at `.default.default` (TS2351
  // "not constructable"). Same pattern as local-folder/mime.ts. Verified with
  // tsc (node16) + runtime on 2026-10-02.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { default: MsgReader } = require('@kenjiuno/msgreader') as typeof import('@kenjiuno/msgreader');
  // DataView: no copy, and correct for small Buffers living in Node's shared pool.
  const d = new MsgReader(new DataView(buf.buffer, buf.byteOffset, buf.byteLength)).getFileData();
  if (d.error) throw new Error(`msg: ${d.error}`);
  // An Exchange sender carries an X.500 DN ("/O=…"), not an address: show the name.
  const who = (name?: string, email?: string): string => {
    const addr = email && !email.startsWith('/') ? email : undefined;
    if (name && addr && name !== addr) return `${name} <${addr}>`;
    return name ?? addr ?? '';
  };
  const rcpt = (type: 'to' | 'cc') =>
    (d.recipients ?? [])
      .filter((r) => r.recipType === type)
      .map((r) => who(r.name, r.smtpAddress ?? r.email))
      .filter(Boolean)
      .join(', ');
  // `html` bytes are decoded as UTF-8 (new Outlook writes UTF-8). Classic
  // Outlook messages with codepage HTML always carry a plain `body`, so they
  // never reach this branch.
  const html = d.bodyHtml ?? (d.html ? new TextDecoder().decode(d.html) : undefined);
  const body = d.body?.trim() ? d.body : html ? await htmlToMarkdown(html) : '';
  const when = d.messageDeliveryTime ?? d.clientSubmitTime;
  return renderMail({
    subject: d.subject,
    from: who(d.senderName, d.senderSmtpAddress ?? d.senderEmail),
    to: rcpt('to'),
    cc: rcpt('cc'),
    date: when ? new Date(when) : undefined,
    attachments: (d.attachments ?? []).map((a) => a.fileName ?? a.name).filter((n): n is string => Boolean(n)),
    body,
  });
}
```

If `tsc` rejects the `recipType`/`smtpAddress` access, check the field names in `node_modules/@kenjiuno/msgreader/lib/MsgReader.d.ts` (`FieldsData`). The names above were read from 1.28.0's runtime output. Keep `(r as { smtpAddress?: string })` casts to a minimum.

- [ ] **Step 4: Run, and confirm they pass**

Run: `npx jest src/main/core/engine/__tests__/convert-email.test.ts && npx tsc -p tsconfig.json --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/core/engine/convert.ts src/main/core/engine/__tests__/convert-email.test.ts
git commit -m "feat(convert): Outlook .msg via msgreader; one renderMail for every email format (+Cc)"
```

---

### Task 3: Policy admits `.msg` and cloud `.eml`

**Files:**
- Modify: `src/shared/file-indexability.ts` (`LOCAL_CONVERTER_MIMES`, `CLOUD_CONVERTER_MIMES`, converter branch, `ADMITTED_SINCE`)
- Test: `src/shared/__tests__/file-indexability.test.ts`

- [ ] **Step 1: Failing tests**

Flip the existing `'cloud eml'` case to `{ kind: 'index', pipeline: 'converter', bytes: 'eager' }`, and rewrite the comment above it: "Email: both profiles convert it; .msg and cloud .eml since policy v2". Append:

```ts
const msgCases: Case[] = [
  ['local msg', { profile: 'local-folder', filename: 'm.msg', mime: 'application/vnd.ms-outlook', sizeBytes: 100, path: '/d/m.msg' },
    { kind: 'index', pipeline: 'converter', bytes: 'eager' }],
  ['cloud msg (outlook mime)', { profile: 'cloud-drive', filename: 'm.msg', mime: 'application/vnd.ms-outlook', sizeBytes: 100 },
    { kind: 'index', pipeline: 'converter', bytes: 'eager' }],
  ['cloud msg (octet-stream, ext rescue)', { profile: 'cloud-drive', filename: 'm.msg', mime: 'application/octet-stream', sizeBytes: 100 },
    { kind: 'index', pipeline: 'converter', bytes: 'eager' }],
  ['cloud eml (octet-stream, ext rescue)', { profile: 'cloud-drive', filename: 'm.eml', mime: 'application/octet-stream', sizeBytes: 100 },
    { kind: 'index', pipeline: 'converter', bytes: 'eager' }],
  ['cloud msg (no mime, ext rescue)', { profile: 'cloud-drive', filename: 'm.msg', sizeBytes: 100 },
    { kind: 'index', pipeline: 'converter', bytes: 'eager' }],
  ['cloud octet-stream without msg/eml ext stays unsupported', { profile: 'cloud-drive', filename: 'blob', mime: 'application/octet-stream', sizeBytes: 100 },
    { kind: 'ignore', reason: 'unsupported' }],
  ['cloud msg over eager cap → none', { profile: 'cloud-drive', filename: 'm.msg', mime: 'application/vnd.ms-outlook', sizeBytes: MAX_CLOUD_BINARY_BYTES + 1 },
    { kind: 'index', pipeline: 'converter', bytes: 'none' }],
];
it.each(msgCases)('%s', (_n, c, want) => expect(decideFileIndexing(c)).toEqual(want));

it('newlyAdmitted re-emits an eager local .msg for a version-1 cursor only', () => {
  const c = { profile: 'local-folder' as const, filename: 'm.msg', mime: 'application/vnd.ms-outlook', sizeBytes: 100, path: '/d/m.msg' };
  expect(newlyAdmitted(c, 1)).toBe(true);
  expect(newlyAdmitted(c, FILE_POLICY_VERSION)).toBe(false);
  expect(newlyAdmitted({ ...c, filename: 'm.eml', mime: 'message/rfc822', path: '/d/m.eml' }, 1)).toBe(false); // local eml was always admitted
});
```

Verify the local MIME claim: `node -e "console.log(require('mime').getType('a.msg'))"` must print `application/vnd.ms-outlook`. If it does not, add `msg: 'application/vnd.ms-outlook'` to the fallback table in `src/main/sources/local-folder/mime.ts`.

- [ ] **Step 2: Run, and confirm they fail**

Run: `npx jest src/shared/__tests__/file-indexability.test.ts`
Expected: FAIL on the new and flipped cases.

- [ ] **Step 3: Implement**

```ts
export const LOCAL_CONVERTER_MIMES = new Set([
  …existing…,
  'application/vnd.ms-outlook',
]);
const CLOUD_CONVERTER_MIMES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-outlook',
  'message/rfc822',
]);
/** Saved-email extensions Graph/Drive commonly report with no or a generic
 *  MIME; the converter dispatches on the extension, so they are safe to admit. */
const CLOUD_EMAIL_EXT_RESCUE = new Set(['msg', 'eml']);

export const ADMITTED_SINCE: Record<number, ReadonlySet<string>> = {
  2: new Set(['msg']),
};
```

In step 9 (the converter branch):

```ts
  const generic = mime === '' || mime === 'application/octet-stream';
  const converter = local
    ? LOCAL_CONVERTER_MIMES.has(mime)
    : mime.startsWith('text/') || CLOUD_CONVERTER_MIMES.has(mime) ||
      (generic && CLOUD_EMAIL_EXT_RESCUE.has(ext));
```

Rewrite step 9's comment: drop the "cloud .eml is unsupported" paragraph, and say that cloud admits saved email (`.msg`/`.eml`) by MIME or, for a generic MIME, by extension.

**SDK note.** The SDK copies this file verbatim. The large-file plan's SDK task (Task 9) regenerates it after this task lands. Run that SDK task's `npm test` again if it already ran.

- [ ] **Step 4: Run, and confirm they pass**

Run: `npx jest src/shared src/main/sources/local-folder`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared src/main/sources/local-folder
git commit -m "feat(policy): admit Outlook .msg everywhere and saved email on cloud drives (policy v2)"
```

---

### Task 4: Upgrade recovery (engine integration)

**Files:**
- Test: `src/main/core/engine/__tests__/engine.test.ts`, `src/main/sources/local-folder/__tests__/local-folder-source.test.ts`

These are tests only. The mechanisms come from the large-file plan (Task 3 local recovery; Task 5 convert v2 replay), and these tests pin that `.msg` rides them.

- [ ] **Step 1: Local: an unchanged, previously ignored `.msg` is emitted after upgrade**

In `local-folder-source.test.ts`, next to the large-file recovery tests:

```ts
it('an old cursor emits an unchanged .msg the old policy ignored', async () => {
  fs.copyFileSync(path.join(MSG_FIX, 'plain.msg'), path.join(root, 'mail.msg'));
  const old = { roots: { [root]: { completedAt: new Date(Date.now() + 60_000).toISOString() } } };
  const batches = await collect(pull(sessionFor([root], { watch: false }), old));
  const items = batches.flatMap((b) => b.items);
  expect(items.map((i) => path.basename(i.absPath))).toEqual(['mail.msg']);
  expect(items[0].binary).not.toBeNull(); // eager bytes, converted at commit
});
```

`MSG_FIX = path.join(__dirname, '../../../core/engine/__tests__/fixtures/msg')`. Adjust the relative path to the test file's location.

- [ ] **Step 2: Attachment: a `.msg` attachment is a convert candidate**

The v2 replay itself is pinned by the large-file plan's upgrade test: `worker:convert:v2` starts at cursor 0 whatever v1 did. The only `.msg`-specific fact is candidacy. In `convert-worker.test.ts`:

```ts
it('an octet-stream .msg attachment and an extensionless Outlook-MIME one are convert candidates', () => {
  expect(isConvertCandidate(doc({ type: 'attachment', title: 'fwd.msg', markdown: null,
    metadata: { mime: 'application/octet-stream', filename: 'fwd.msg', sizeBytes: 20480 } }))).toBe(true);
  expect(isConvertCandidate(doc({ type: 'attachment', title: 'attachment', markdown: null,
    metadata: { mime: 'application/vnd.ms-outlook', filename: 'attachment', sizeBytes: 20480 } }))).toBe(true);
});
```

- [ ] **Step 3: Run**

Run: `npx jest src/main/workers/convert src/main/sources/local-folder -t "msg"`
Expected: PASS. These tests pass as soon as Tasks 2–3 and the large-file plan are in; there is no red phase of their own. Confirm each one fails when you temporarily revert Task 3's `ADMITTED_SINCE[2]` and `convertibleKind` changes (mutation check), then restore them.

- [ ] **Step 4: Commit**

```bash
git add src/main/workers/convert/__tests__ src/main/sources/local-folder/__tests__
git commit -m "test(msg): upgrade recovery for local .msg files and mail .msg attachments"
```

---

### Task 5: Connector fixture tests (OneDrive + gdrive), on the connectors-plan branches

**Files:**
- Test: `~/work/onedrive-kia-connector/src/__tests__/ingest.test.ts`
- Test: `~/work/google-docs-kia-connector/src/__tests__/backfill.test.ts`

These need no code change: `chooseRoute` uses the SDK policy from Task 3. Do this after the connectors plan's Task 1, with an SDK tarball packed **after** Task 3 above.

- [ ] **Step 1: OneDrive**

```ts
it('a .msg reported as octet-stream downloads and emits binary', async () => {
  const { source, calls } = makeSource({
    deltaPages: { [deltaUrl('FA')]: { value: [driveFile('m1', 'Fwd.msg', { file: { mimeType: 'application/octet-stream' } })],
      '@odata.deltaLink': finalLink('FA', 'TOK1') } },
    downloads: { 'https://download.example/m1': new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]) },
  });
  const { session } = makeSession({ config: oneRoot });
  const items = ((await collect(source.pull(session, null))) as B[]).flatMap((b) => b.items);
  expect(items.map((i) => [i.file.id, i.extractionStatus])).toEqual([['m1', 'ok']]);
  expect(source.toDocument(items[0]).binary?.filename).toBe('Fwd.msg');
  expect(calls).toContain('https://download.example/m1');
});
```

- [ ] **Step 2: gdrive**

```ts
it('a .msg reported as octet-stream downloads and emits binary', async () => {
  const { source } = makeSource({ startPageToken: 'spt-1',
    lists: { root: [binaryFile('m1', 'Fwd.msg', 'application/octet-stream')] },
    media: { m1: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]) } });
  const { session } = makeSession();
  const items = ((await collect(source.pull(session, null))) as B[]).flatMap((b) => b.items);
  expect(items.map((i) => [i.file.id, i.extractionStatus])).toEqual([['m1', 'ok']]);
});
```

- [ ] **Step 3: Run each repo's suite (sequentially) and commit in each repo**

```bash
npx jest && git add src/__tests__ && git commit -m "test: Outlook .msg files are downloaded and handed to the engine"
```

---

### Task 6: alpha-cent overlay manifests and live check

**Files (alpha-cent):**
- Modify: `release/app/package.json`, `release/app/package-lock.json` (next to `mailparser`)
- Modify: `package.json`, `package-lock.json` (root; alpha-cent mirrors core's root dev deps)

- [ ] **Step 1: Declare the dependency in alpha-cent**

This is done in the alpha-cent worktree that takes the `core.lock` bump for this core release (release runbook), not the shared `~/work/alpha-cent` checkout.

```bash
npm i --save-exact @kenjiuno/msgreader@1.28.0
npm i --prefix release/app --save-exact @kenjiuno/msgreader@1.28.0
git add package.json package-lock.json release/app/package.json release/app/package-lock.json
git commit -m "deps: @kenjiuno/msgreader for core's .msg converter"
```

The packaged-app gate is the release smoke (`node build/release-smoke.mjs`). An undeclared runtime dep would make every `.msg` record `conversion: failed`, so also check this on the packaged build:

```bash
ls <unpacked app>/resources/app.asar.unpacked/node_modules/@kenjiuno/msgreader 2>/dev/null || npx asar list <app.asar> | grep -m1 msgreader
```

- [ ] **Step 2: Live check (dev app, dedicated worktree and profile)**

- Copy four real-world shapes into a local-folder root: a received Exchange mail, a sent mail, a German mail with umlauts, and a forwarded mail with a `.msg` attachment. Use the founder's own Outlook exports; never client data.
- Through MCP `search`, each is findable by subject and by a body phrase.
- The umlauts are intact in `get`.

## Self-Review notes

- **Spec coverage:**
  - Parser and declaration → T1, T2.
  - Body preference → T2. The RTF branch is a documented deviation.
  - `convertibleKind` → T2.
  - Policy, local and cloud, plus ext rescue → T3.
  - The `FILE_POLICY_VERSION` ride → T3 (`ADMITTED_SINCE`) and T4.
  - Connectors → T5.
  - Recovery table → T4 (local, attachments) and the connectors plan's re-enumeration (cloud).
  - Testing list → T2–T6.
  - The alpha-cent manifests → T6.
- **No version bumps.** The convert worker stays at v2 and `FILE_POLICY_VERSION` at 2, both from the large-file plan.
