# Install a connector from any GitHub repo — design

Status: rev 2 (after fable + astra round 1) · 2026-11-15 · core branch
`feat/github-install` (from dev 47d9b968, v0.125.2) + alpha-cent branch
`feat/kiagent-scheme`
Mockup: https://claude.ai/artifact/VfcaZ8gpp8EXyJCXMW9FkC

## Goal

A person can install a connector that is not in the `kia-plugins` store by
pasting its GitHub address, or by clicking an "Add to KIAgent" link
(`kiagent://install?repo=owner/repo`) in the author's README. Nothing is
downloaded until they press Continue, and the consent sheet says honestly
where the code comes from.

## What exists

- `installer.preview(ref)` treats every `github:` ref as a marketplace ref
  and calls the `download` dep (`main.ts` ~1663), which resolves a release,
  downloads its `.tgz`, and builds `pinnedRef` from the *input* owner/repo.
  SRI/TOFU pinning, manifest validation and source-id collision checks run
  in preview. Bundled-id collisions are refused only at commit
  (`extension-platform.ts` ~1816).
- Consent, the "external" sandbox tier, the update check and multi-device
  set sync treat every `github:` ref alike. A follower forwards only the ref
  to the leader, and set entries carry only `{enabled, ref}`.
- `Sources?install=<owner>/<repo>` opens the Install sheet, read once on
  catalog mount.
- `ExtensionPreview` has no `ref`; the renderer keeps the ref the user
  typed.

## Non-goals

- Private repos (no GitHub auth).
- Non-GitHub hosts.
- A review or signing programme, or a trusted-publisher list.
- Extension-id namespaces.

Arbitrary `https://…tgz` refs stay internal; neither new entry point can
produce one.

## Design

### 1. One parser — `src/shared/install-link.ts` (pure)

`parseRepoInput(text): { owner, repo, tag? } | { error }` accepts, after
trimming:
- `https://github.com/<owner>/<repo>`, with an optional trailing `/` or
  `.git`, or `/releases/tag/<tag>` (which sets the tag). It must be
  `https:` with host exactly `github.com` (case-insensitive), and no
  userinfo, port, query or fragment.
- `<owner>/<repo>` and `<owner>/<repo>@<tag>`.
- `github:<owner>/<repo>[@<tag>]`.

`parseInstallLink(url, scheme): { owner, repo, tag? } | null` accepts only
`<scheme>://install?repo=<owner>/<repo>[&tag=<tag>]`:
- host `install`, and an empty path or `/`;
- exactly one `repo`, at most one `tag`, and no other params;
- at most 512 characters in total.

Shared component rules:
- owner matches `^[A-Za-z0-9][A-Za-z0-9-]{0,38}$`;
- repo matches `^[A-Za-z0-9._-]{1,100}$` and is not `.` or `..`;
- tag matches `^[A-Za-z0-9._+-]{1,128}$`.

Values are decoded once, and case is preserved.

`toGithubRef(r)` returns `github:owner/repo[@tag]`.

`provenanceOf(ref)` returns:
- `{kind:'store'}` when the ref is `github:` and the owner equals
  `kia-plugins` (ASCII case-insensitive, exact);
- `{kind:'github', owner, repo}` for any other `github:` ref;
- `{kind:'local'}` for `file:`;
- `{kind:'url'}` for anything else.

`github-ref.ts`'s `parseGitHubRef` adopts the same component rules, so
`github:../..` is rejected. GitHub API and raw paths are built with
`encodeURIComponent` per component.

Parser copy:
- not GitHub → "That isn’t a GitHub repository address."
- anything else unparseable → "Use the repository’s address, like
  github.com/owner/repo."

### 2. Canonical identity and release selection — `github-source.ts`

`resolveGitHubRef(ref)` returns
`{ owner, repo, repoId, tag, version, tarballUrl }` or throws an
`InstallSourceError` with a `code` (copy in brackets):
- `GET /repos/{o}/{r}` gives the canonical `owner.login`, `name` and
  numeric `id`; GitHub follows renames and transfers here.
  - 404 → `not-found` ("Couldn’t find that repository. It may be private —
    only public repositories can be added.").
- With an explicit tag: `GET /repos/{o}/{r}/releases/tags/{tag}`, not a
  search of the first 30 releases.
  - 404 → `no-release`.
  - No `.tgz` asset → `no-release`.
- Without a tag: list releases and keep only stable ones with a `.tgz`
  asset, then pick the newest that runs here.
  - None with a `.tgz` → `no-release` ("This repository has no release to
    install yet.").
  - None that runs here → `needs-newer-app` ("This connector needs a newer
    version of KIAgent.").
- The update check (`latestReleases`) uses the same installable filter.

The `download` dep builds `pinnedRef` from the canonical result:
`github:<owner>/<repo>@<tag>`. `installer.preview` carries `repoId` on the
pending install.

### 3. Publisher guard, bundled guard, store-only privileges — installer

The rules below run in `preview`, for early feedback, and again in
`commit`, under the existing per-id install lock and before anything on
disk changes. `InstalledRecord` gains `repoId`, written at commit for
`github:` installs, so the commit check compares the staged id with the
recorded one and needs no network. A legacy record without `repoId` is
never looked up. It matches only under a narrow store-migration exception:
the recorded owner is `kia-plugins` and the new canonical `owner/repo`
equals the recorded `owner/repo` (ASCII case-insensitive). Only the org can
recreate a name there. The commit then writes `repoId`. Any other legacy
`github:` record has an unverified publisher and is refused as a different
publisher, so the person removes it and installs it again.

`installer.check(token)` runs these guards without touching disk.
`installCommit` calls it under the per-id lock **before** it deactivates
the running extension, so a refused install leaves the existing connector
running. `installer.commit` runs the same guards once more, which needs no
network.

- **Bundled id.** The manifest id belongs to a bundled extension. Refused
  in preview, before consent, as well as at commit.
- **Different publisher.** An installed record with the same id has a
  `github:` ref, and its recorded `repoId` differs from the staged one (or
  it is a legacy record outside the store exception above). A rename or
  transfer of the same repo keeps its id, so it passes. Refused with:
  "<Name> is already installed from <old owner/repo>. This one is from
  <new owner/repo>, a different publisher, so KIAgent won’t replace it. To
  switch, remove <Name> in Settings › Extensions first."
  Local (`file:`) installs and records are unaffected.
- **Store-only OAuth.** A non-store `github:` (or `url`) package whose
  manifest binds any source to a platform OAuth provider (`oauth:
  'google' | 'microsoft' …`) is refused with: "This connector asks to sign
  in through KIAgent’s own Google or Microsoft access, which only store
  connectors can use." The installer depends only on manifests; the
  OAuth-binding helper it uses lives in `@main/platform/manifest`.
- **Store-only dormancy.** The product's `dormantExtensions` allowlist
  applies only to extensions whose provenance is store or bundled.

### 4. Extraction bounds

Every `.tgz` extraction in the installer is capped at 20 000 entries and
512 MiB unpacked. Symlink and hardlink entries are rejected. Breaking any
of these aborts, cleans staging, and shows "package is too large to
install" (for links: "package contains links, which aren’t allowed").

### 5. Approved bytes are the installed bytes, on every device

- `ExtensionPreview` gains `ref`, the pinned canonical ref. The renderer's
  `InstallRequest` uses it in place of the typed ref, so the sheet's Source
  row and provenance come from main's resolution.
- When a follower forwards a marketplace install to the leader, it sends
  `{ref, integrity}`. `installFromRef(ref, {grantConsent, integrity})`
  refuses a download whose sha512 differs: "The release changed after you
  approved it — try installing again."
- Set entries gain an optional `integrity`. The leader writes it from the
  installed record, and reconcile passes it to `installFromRef`. Entries
  written before this change have none, and install as today. A mismatch
  during reconcile, where nobody is at a sheet, reports "This connector’s
  release changed since it was installed on your other device. Update it
  there first." The "try installing again" wording is only for the
  interactive forward.
- **Integrity on every set path.**
  - Seed, offer and union all copy `integrity` from the installed record,
    along with `ref`.
  - `needsInstall` is unchanged. Once every install carries integrity end
    to end, a device can only diverge if it already had before this
    release. A same-version reinstall can't fix that case anyway, because
    the local TOFU pin refuses it.

### 6. "Add from GitHub…" (renderer)

- **Catalog row.** `SourceCatalog.tsx` shows a dashed row directly under
  the store section, even when the store failed to load: "Have a link to a
  connector? · Install one from any public GitHub repository." Its
  secondary button is **Add from GitHub…**.
- **The sheet.** `AddFromGithubSheet` (new, in `src/renderer/extensions/`):
  - title "Add from GitHub";
  - one labelled field, "Repository", with the hint "Also accepts
    owner/repo or owner/repo@v1.2.0";
  - buttons Cancel and **Continue**;
  - optional `initial` text, used by links.
- **Continue.**
  - It runs `parseRepoInput`, then the catalog's existing
    `flow.preview(toGithubRef(r), 'install')`.
  - The sheet stays open while previewing (busy state).
  - Parse or preview errors show under the field.
  - On success, the Add sheet closes and the consent sheet opens.
- **After commit.** Install & connect behaves as the catalog already does.

### 7. Install sheet provenance (renderer)

`originWords` is replaced by `provenanceOf(request.ref)`:
- **store:** "From the store".
- **github:**
  - the meta line shows `github.com/<owner>/<repo>`;
  - above the description, an amber `role="note"` notice reads **Not
    reviewed by KIAgent** — "Published by <owner> on GitHub. It runs with
    the access below — install it only if you trust the publisher."
  - The notice also shows on Update and Review sheets, where provenance
    comes from the snapshot's `ref`.
- **local:** "From a file on this computer".
- **url:** no words.

### 8. `kiagent://` link

**Product gate.**
- `ProductConfig.urlScheme?: string`, validated by zod as
  `^[a-z][a-z0-9+.-]{1,31}$`. When it is absent (the OSS build), nothing
  is registered or handled.
- alpha-cent's `product/product.json` sets `"urlScheme": "kiagent"`.
- Its `product/build.json` gains
  `"protocols": [{ "name": "KIAgent", "schemes": ["kiagent"] }]`, and
  `build/inject.mjs` copies `protocols` into `pkg.build.protocols`, with a
  test.
- Release order: core first, then the app.

**Main** (`src/main/install-links.ts`, wired in `main.ts`):
- Registration and capture:
  - If `urlScheme` is set and `app.isPackaged`, call
    `app.setAsDefaultProtocolClient(scheme)`.
  - macOS: `app.on('open-url')` is registered synchronously at module top
    level, before `whenReady`, and calls `preventDefault()`.
  - Windows/Linux: read startup `process.argv`, and the `argv` of
    `second-instance`.
- Every candidate goes through `parseInstallLink`. An invalid one is logged
  as "ignored install link", without the URL, and dropped.
- **One pending slot; the latest link wins.**
  - A valid link replaces whatever is in the slot, and a sequence number
    increments.
  - Main then sends `push:install-link` (no payload).
  - If the app is past bootstrap, main calls `showMainWindow()`. During
    startup it does not create a window; the normal startup path does.
- The renderer invokes `extension:install-link-take`, which returns
  `{seq, owner, repo, tag?}` or null and clears the slot.

**Renderer** (`useInstallLink`, mounted once at the app root):
- **When it takes the slot.** On mount and on each nudge, it takes the
  slot.
- **Routing.** It navigates to Sources with `add=` (the catalog) and
  `link=<owner>/<repo>[@<tag>]`, `linkSeq=<seq>`.
- **Catalog.** When `linkSeq` changes, the catalog opens
  `AddFromGithubSheet` prefilled with the link's text.
  - It replaces an open Add sheet.
  - It is ignored while a consent sheet is open or a preview is running.
  - The person still presses Continue: a link never downloads anything by
    itself.

### 9. Multi-device

A committed GitHub install is `origin: 'marketplace'` and joins the
extension set with its pinned canonical ref and integrity. The user's other
devices install it as they do store connectors, with consent granted once
by the user, and refuse different bytes (§5).

## Testing

- **`install-link.test.ts`**:
  - accept/reject tables for both parsers: hosts, userinfo, port,
    query/fragment, `..`, encoded slashes, duplicate or unknown params,
    overlong input, control characters, and preserved tag case;
  - `provenanceOf`: `KIA-PLUGINS/x` is store, `attacker/kia-plugins` is
    github.
- **github-source**:
  - canonical owner/repo/id after a rename;
  - an explicit tag resolved directly;
  - a newer source-only release skipped;
  - each error code;
  - encoded path components.
- **installer**:
  - publisher guard: a different repo id is refused, a renamed same repo
    passes, a `file:` record is replaceable;
  - the publisher guard is re-run at commit, so two pending previews can't
    replace each other;
  - bundled id refused in preview;
  - OAuth binding refused for a non-store ref and allowed for a store ref;
  - extraction caps: entries, bytes, symlink;
  - an integrity mismatch is refused by `installFromRef`.
- **extension-platform**:
  - a follower forwards integrity;
  - reconcile passes the set entry's integrity;
  - dormancy is limited to store provenance.
- **install-links (main)**:
  - argv and open-url capture;
  - latest wins and the sequence number increments;
  - take clears the slot;
  - no window is created before bootstrap;
  - nothing is handled without `urlScheme`.
- **Renderer**:
  - AddFromGithubSheet: parse error, preview error keeps it open, success
    previews with the tag;
  - InstallSheet notice per provenance;
  - the catalog opens a prefilled Add sheet when `linkSeq` changes,
    including the same link a second time;
  - a link is ignored while a consent sheet is open.
- **alpha-cent**: `inject.mjs` copies `protocols`.
- **Live**:
  - Dev app: paste a public test repo that has a `.tgz` release, check the
    notice, then cancel.
  - Packaged RC: `open 'kiagent://install?repo=…'` on macOS opens the
    prefilled Add sheet.
