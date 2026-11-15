# GitHub install + kiagent:// links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install a connector from any public GitHub repo — pasted, or via
a `kiagent://install?repo=` link — with honest provenance and a
publisher guard.

**Architecture:**
- **Shared parsing and provenance.** One pure module,
  `src/shared/install-link.ts`, is used by main and the renderer.
- **Main decides identity.** It resolves the canonical repo (owner, name,
  numeric id) and pins it.
- **The installer guards.** It enforces the publisher, bundled, OAuth and
  extraction rules at preview and again before deactivation.
- **Integrity across devices.** It travels with forwarded installs and set
  entries.
- **Renderer.** A paste sheet in the catalog. Links only prefill that
  sheet.
- **The scheme is product-gated.** alpha-cent declares it.

**Tech Stack:** Electron, TypeScript, React, zod, `tar`, Jest (+ RTL).

**Spec:** `docs/superpowers/specs/2026-11-15-github-install-design.md`
(commit 53c9ff67). Read it with this plan; copy strings come from it
verbatim.

## Global Constraints

- **Core worktree:** `~/work/kcore-ghinstall`, branch `feat/github-install`.
  `node_modules` is a symlink to kcore-weblogin's; unlink it before
  removing the worktree.
- **Overlay:** `~/work/alpha-cent`, a new branch `feat/kiagent-scheme`
  from dev.
- **Git:** no amend, rebase, reset or stash; `git add` explicit paths only.
  Every commit ends with the two session trailers.
- **Runs:** builds and tests run one after another, never in parallel.
  Gate each task with
  `npx jest <files>` + `npm run typecheck` (core).
- **Copy:** all user-facing copy is exactly as in the spec.
- **Owner check:** the `kia-plugins` comparison is ASCII
  case-insensitive and exact.
- **Logging:** never log a link's URL or query.

## Review Focus

1. Pasting `github.com/Owner/Repo/` with a trailing slash and mixed case
   must work: the case is preserved, and the canonical form comes from the
   API.
2. An update of an already-installed store connector (legacy record, no
   `repoId`) must not be refused (T3 test `legacy store record updates`).
3. A refused commit must leave the running connector active (T3 test
   `refused commit keeps the running extension`).
4. Clicking the same `kiagent://` link twice, after cancelling once, must
   reopen the sheet (T6 test `same link twice reopens`).
5. Store-failed-to-load must still show the "Add from GitHub…" row (T5
   test).

---

### Task 1: Shared parser and provenance

**Files:**
- Create: `src/shared/install-link.ts`
- Test: `src/shared/__tests__/install-link.test.ts`
- Modify: `src/main/marketplace/github-ref.ts`, where the regex adopts the
  shared component rules
- Test: `src/main/marketplace/__tests__/github-ref.test.ts`

**Interfaces (Produces):**
```ts
export interface RepoRef { owner: string; repo: string; tag?: string }
export function parseRepoInput(text: string): RepoRef | { error: string };
export function parseInstallLink(url: string, scheme: string): RepoRef | null;
export function toGithubRef(r: RepoRef): string;          // github:o/r[@t]
export function repoText(r: RepoRef): string;             // o/r[@t] (prefill text)
export type Provenance =
  | { kind: 'store' } | { kind: 'github'; owner: string; repo: string }
  | { kind: 'local' } | { kind: 'url' };
export function provenanceOf(ref: string | undefined): Provenance; // undefined → {kind:'url'}
export const STORE_OWNER = 'kia-plugins';
export const NOT_GITHUB = 'That isn’t a GitHub repository address.';
export const BAD_INPUT = 'Use the repository’s address, like github.com/owner/repo.';
```

- [ ] **Step 1: Write the failing tests, as `it.each` tables.**
  - **Accepted:**
    - `https://github.com/Owner/Repo` gives `{owner:'Owner', repo:'Repo'}`;
    - the same with `/` or `.git` appended, and in mixed host case
      (`HTTPS://GitHub.com/...`);
    - `…/releases/tag/v1.0.0` gives tag `v1.0.0`;
    - `o/r`, `o/r@V1.2.0` (tag case kept) and `github:o/r@t`.
  - **Rejected with NOT_GITHUB:** `https://gitlab.com/a/b` and
    `http://github.com/a/b`.
  - **Rejected with BAD_INPUT:**
    - `https://u:p@github.com/a/b`, `https://github.com:443/a/b`, and
      `…/a/b?x=1` or `#f`;
    - `../x`, `a/..`, `a/b/c`, `a%2Fb/c`;
    - an owner with a leading `-`, an owner of 40 characters;
    - a tag containing `/`, a control character in the input.
  - **`parseInstallLink(…,'kiagent')`:**
    - accepts `kiagent://install?repo=o/r` and `kiagent://install/?repo=o/r&tag=v1`;
    - returns null for `kiagent://other?repo=o/r`, `repo` given twice,
      `&x=1`, a missing `repo`, `https://install?repo=o/r`, a 513-character
      URL, and `repo=o%2Fr%2F..`.
  - **`provenanceOf`:**
    - `github:KIA-PLUGINS/x@v1` is store;
    - `github:attacker/kia-plugins` is github;
    - `file:/x` is local;
    - `https://x/a.tgz` is url.
  - **`github-ref`:** `parseGitHubRef('github:../..')` is null, and
    `parseGitHubRef('github:o/r@v1')` still parses.
- [ ] **Step 2:** `npx jest src/shared/__tests__/install-link.test.ts src/main/marketplace/__tests__/github-ref.test.ts` → FAIL
- [ ] **Step 3: Implement.**
  - Use `new URL()` only for the `https:` form, then check
    `hostname.toLowerCase()==='github.com'` and that `username`,
    `password`, `port`, `search` and `hash` are all empty.
  - Split the path on `/` and decode each segment once with
    `decodeURIComponent`, inside a try.
  - Validate with the spec regexes. `parseGitHubRef` reuses the exported
    `isOwner`, `isRepo` and `isTag` predicates.
- [ ] **Step 4:** the same jest command → PASS; then `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(install): one parser for GitHub repo input and kiagent links`.

### Task 2: Canonical resolve, typed errors, installable selection

**Files:**
- Modify: `src/main/marketplace/github-source.ts`, `src/main/main.ts` (the
  `download:` dep, ~1663)
- Test: `src/main/marketplace/__tests__/github-source.test.ts`

**Interfaces:**
- Consumes `isOwner/isRepo/isTag` (T1).
- Produces:
```ts
export type InstallSourceErrorCode = 'not-found' | 'no-release' | 'needs-newer-app';
export class InstallSourceError extends Error { constructor(public code: InstallSourceErrorCode, message: string) }
export const INSTALL_SOURCE_COPY: Record<InstallSourceErrorCode, string>; // spec §2 copy
resolveGitHubRef(ref: string): Promise<{ owner: string; repo: string; repoId: number; tag: string; version: string; tarballUrl: string }>; // throws InstallSourceError | Error (network)
```
- The `download` dep returns `{ bytes, pinnedRef, repoId }`. The
  `InstallerDeps.download` type widens to include `repoId?: number`.

- [ ] **Step 1: Write the failing tests.**
  - `canonical identity after a rename`: the fake `/repos/old/x` returns
    `{owner:{login:'new'}, name:'X', id:7}`; releases are listed at
    `/repos/new/X/…`; the result is `{owner:'new', repo:'X', repoId:7}`.
  - `explicit tag uses releases/tags`: the fetch URL is
    `/repos/o/r/releases/tags/v%2B1` for tag `v+1`.
  - `newer source-only release is skipped`: v2 has no `.tgz`, v1 does, and
    v1 is picked.
  - `not-found` on a repo 404.
  - `no-release` when no `.tgz` exists, and on a tag 404.
  - `needs-newer-app` when every `.tgz` release has an engine range that
    excludes this platform.
  - `latestReleases ignores releases without a tgz`.
- [ ] **Step 2:** `npx jest src/main/marketplace/__tests__/github-source.test.ts` → FAIL
- [ ] **Step 3: Implement.**
  - Build every URL from `encodeURIComponent` per component.
  - `pickRelease` filters to `!prerelease && tarballUrl`.
  - In `main.ts`, set `pinnedRef = formatGitHubRef(res.owner, res.repo) + '@' + res.tag`
    and pass `repoId`.
  - `installPreview`'s catch maps an `InstallSourceError` to its message;
    other errors keep today's text.
- [ ] **Step 4:** the jest command plus `src/main/marketplace/__tests__/installer.test.ts` → PASS; `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(install): resolve the canonical repo and pick only installable releases`.

**Checkpoint A (≈25%):** fable + astra, pragmatic, on T1–T2. Loop until
both say OK.

### Task 3: Installer guards, check-before-deactivate, extraction caps

**Files:**
- Modify: `src/main/marketplace/installer.ts`,
  `src/main/platform/extensions.ts` (`InstalledRecord.repoId?: number`),
  `src/main/platform/extension-platform.ts` (`installCommit` ~1797, plus
  the installer deps wiring)
- Test: `src/main/marketplace/__tests__/installer.test.ts`,
  `src/main/platform/__tests__/extension-platform.test.ts`

**Interfaces:**
- Consumes `provenanceOf` (T1) and `download → repoId` (T2).
- Produces:
```ts
InstallerDeps.bundledIds(): ReadonlySet<string>;
PendingInstall.repoId: number | null;
installer.check(token: string): void;   // throws the guard error; no disk writes
export const TOO_LARGE = 'package is too large to install';
export const HAS_LINKS = 'package contains links, which aren’t allowed';
export const STORE_ONLY_OAUTH = 'This connector asks to sign in through KIAgent’s own Google or Microsoft access, which only store connectors can use.';
export function differentPublisher(name: string, oldRepo: string, newRepo: string): string; // spec §3 copy
```

- **Guard order:**
  1. bundled id;
  2. OAuth binding (`oauthSourceBindings(manifest).length > 0` while
     provenance is not `store`, and the origin is marketplace);
  3. publisher.
- **Publisher rule:**
  - Find the prior record with a `github:` ref and the same id.
  - If it has a `repoId`, compare it with the staged one.
  - Otherwise, allow only when the prior owner is `kia-plugins`, the
    lowercased `owner/repo` of the prior ref equals the new one's, and the
    new ref is `github:`.
  - Otherwise, refuse.
  - A `file:` prior record, or a new `file:` ref, skips this rule.
- `commit` calls the same guards first and writes `repoId` on the record.
- `extension-platform.installCommit` calls `installer.check(token)` inside
  `runExclusive`, before `deactivate(existing)`. On a throw it returns
  `{ok:false, error}`, with the existing entry untouched.

- [ ] **Step 1: Write the failing tests.**
  - `bundled id refused in preview`.
  - `oauth binding refused for a non-store github ref` / `allowed for kia-plugins`.
  - `different repoId refused with the publisher copy` / `same repoId after rename allowed`.
  - `legacy store record updates` (prior `github:kia-plugins/slack@v1`, no
    repoId; new canonical `kia-plugins/Slack`) is allowed, and the record
    gains a repoId.
  - `legacy non-store record refused`.
  - `file record replaceable`.
  - `two previews, second commit refused` (A commits, then B, with a
    different repoId and the same id, is refused at commit).
  - `extraction: >20000 entries → TOO_LARGE`, `>512 MiB → TOO_LARGE`
    (use a test-only deps override `limits?: {entries, bytes}`), and
    `symlink entry → HAS_LINKS`.
  - In extension-platform.test: `refused commit keeps the running extension`
    (the existing entry stays active, and `deactivate` is never called).
- [ ] **Step 2:** `npx jest src/main/marketplace/__tests__/installer.test.ts src/main/platform/__tests__/extension-platform.test.ts` → FAIL
- [ ] **Step 3: Implement.**
  - Extraction: `tar.x({ …, filter: (p, entry) => … })` counts entries and
    `entry.size`, sets an `overflow` flag (an error can't be thrown from
    the filter), and returns false. After `tar.x`, throw if the flag is
    set. Entry types `SymbolicLink` and `Link` set a `links` flag.
  - Wire `bundledIds` from the platform's bundled entries.
- [ ] **Step 4:** the same command → PASS; then `npx jest src/main/platform` (the full platform folder); `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(install): publisher, bundled and store-only guards before anything changes`.

### Task 4: Integrity across devices, preview ref, store-only dormancy

**Files:**
- Modify:
  - `src/main/platform/extension-platform.ts`: `peekRef` returns
    `integrity`; forward; `installFromRef` options; the `rawInstallFromRef`
    check; dormancy at ~1103; `installPreview` returns `ref`;
  - `src/main/marketplace/installer.ts`: `peekRef` includes `integrity`;
  - `src/main/platform/extension-set.ts`: `integrity?` on entries,
    `LocalExtension`, `setFromLocal`, `recordInstalled`, `union`,
    `ExtensionOps.install(ref, integrity?)`;
  - `src/shared/ipc.ts`: `ExtensionPreview.ref: string`, and
    `'extension:install'` req `{ref, integrity?: string|null}`;
  - `src/main/main.ts:891`, which passes integrity through.
- Test: `extension-set.test.ts`, `extension-set-platform.test.ts`,
  `forwarding.test.ts`, `extension-platform-dormant.test.ts`

**Interfaces:**
```ts
installFromRef(ref: string, opts: { grantConsent: true; integrity?: string | null; context?: 'forward' | 'reconcile' }): Promise<{ok, id?, error?}>;
export const RELEASE_CHANGED_FORWARD = 'The release changed after you approved it — try installing again.';
export const RELEASE_CHANGED_RECONCILE = 'This connector’s release changed since it was installed on your other device. Update it there first.';
```
A mismatch is detected after preview, by comparing `p.integrity` with the
expected value. On a mismatch, discard the token and return the copy for
the context. Callers: the forward handler uses `'forward'`; reconcile uses
`'reconcile'`.

- [ ] **Step 1: Write the failing tests.**
  - `follower forwards integrity`.
  - `installFromRef refuses a different digest (forward copy)` / `(reconcile copy)`.
  - `seed/offer/union carry integrity`.
  - `reconcile passes the set entry's integrity`.
  - `needsInstall unchanged for same ref`.
  - `dormancy only for store provenance` (`kia.notion` from
    `github:someone/x` is not dormant).
  - `installPreview returns the pinned ref`.
- [ ] **Step 2:** run those files → FAIL
- [ ] **Step 3:** implement.
- [ ] **Step 4:** `npx jest src/main/platform src/main/marketplace` → PASS; `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(install): approved bytes are installed bytes on every device`.

**Checkpoint B (≈50%):** fable + astra on T3–T4. Loop until both say OK.

### Task 5: Renderer — Add from GitHub sheet, catalog row, provenance notice

**Files:**
- Create: `src/renderer/extensions/AddFromGithubSheet.tsx` (+ styles in
  `InstallSheet.css`)
- Modify: `src/renderer/screens/Sources/SourceCatalog.tsx` (+
  `SourceCatalog.css`), `src/renderer/extensions/InstallSheet.tsx`,
  `src/renderer/extensions/use-extension-install.ts` (`ref: p.ref`)
- Test: `src/renderer/extensions/__tests__/AddFromGithubSheet.test.tsx`,
  `src/renderer/extensions/__tests__/InstallSheet.test.tsx`,
  `src/renderer/screens/Sources/__tests__/SourceCatalog.test.tsx`

**Interfaces:**
```tsx
export function AddFromGithubSheet(props: {
  initial?: string; busy: boolean; error: string | null;
  onClose(): void; onContinue(ref: string): void;   // ref = toGithubRef(parsed)
}): React.ReactElement;
SourceCatalog props gain: link?: { text: string; seq: number };
```
- The catalog owns the open/closed state: `addOpen` and `addInitial`.
- `onContinue` calls `flow.preview(ref,'install')`. The Add sheet stays
  open while `flow.busy`, closes when `flow.consent` becomes set, and
  shows `flow.error` under the field.

- [ ] **Step 1: Write the failing tests.**
  - `parse error shows BAD_INPUT and does not call onContinue`.
  - `Continue with owner/repo@v1 calls onContinue('github:owner/repo@v1')`.
  - `catalog shows the Add from GitHub row when the store errored`.
  - `preview error stays in the Add sheet`.
  - `github provenance shows the Not reviewed notice and github.com/o/r meta`.
  - `store provenance shows From the store and no notice`.
  - `catalog opens a prefilled Add sheet when link.seq changes` (seq 1,
    then seq 2 with the same text, opens twice).
  - `link ignored while a consent sheet is open`.
- [ ] **Step 2:** run them → FAIL
- [ ] **Step 3: Implement**, using the existing `Sheet`, `Button` and
  `Field` components and the copy from the spec and mockup.
- [ ] **Step 4:** `npx jest src/renderer/extensions src/renderer/screens/Sources` → PASS; `npm run typecheck`.
- [ ] **Step 5: Commit** `feat(install): Add from GitHub sheet and honest provenance on the install sheet`.

### Task 6: kiagent:// link — product gate, main capture, renderer routing

**Files:**
- Modify: `src/main/product.ts` (`urlScheme`)
- Create: `src/main/install-links.ts`
- Test: `src/main/__tests__/install-links.test.ts`,
  `src/main/__tests__/product.test.ts`
- Modify: `src/main/main.ts` (top-level `open-url`, argv, second-instance,
  handler, bootstrap flag), `src/shared/ipc.ts` (`'extension:install-link-take'`
  req `{}` res `{seq:number; owner:string; repo:string; tag?:string} | null`;
  push `'push:install-link': void`; allowlist entries),
  `src/renderer/App.tsx` (mount `useInstallLink`),
  `src/renderer/screens/Sources/SourcesScreen.tsx` (`link`/`linkSeq`
  params → catalog `link` prop)
- Create: `src/renderer/extensions/use-install-link.ts`
- Test: `src/renderer/extensions/__tests__/use-install-link.test.tsx`

**Interfaces:**
```ts
export function createInstallLinks(deps: {
  scheme: string | undefined; isReady(): boolean; show(): void;
  nudge(): void; log(msg: string): void;
}): { offer(candidate: string): void; offerArgv(argv: string[]): void; take(): ({ seq: number } & RepoRef) | null; markReady(): void };
```
- `markReady()` is called after the window's first creation. If something
  is waiting, it calls `show()` + `nudge()`.
- Before ready, `offer` only stores.
- After ready, `offer` stores, then calls `show()` + `nudge()`.

- [ ] **Step 1: Write the failing tests.**
  - `no scheme → offer ignored`.
  - `invalid link logged without the URL and dropped`.
  - `latest wins, seq increments`.
  - `take clears`.
  - `before ready no show(); markReady shows and nudges`.
  - `offerArgv finds the scheme argument`.
  - product: `urlScheme accepted / invalid scheme degrades to defaults`.
  - renderer: `same link twice reopens` (two nudges with seq 1 and 2
    navigate with distinct `linkSeq`).
- [ ] **Step 2:** run → FAIL
- [ ] **Step 3: Implement.**
  - Register `app.on('open-url')` at module top level, next to
    `requestSingleInstanceLock`, so it doesn't depend on product config:
    buffer the raw strings and hand them to `installLinks` once it is
    built.
  - `setAsDefaultProtocolClient(scheme)` only when `app.isPackaged`.
  - The renderer hook takes the slot on mount and on each nudge, then
    `navigate('sources', { add: '', link: repoText(r), linkSeq: String(r.seq) })`.
- [ ] **Step 4:** `npx jest src/main/__tests__/install-links.test.ts src/main/__tests__/product.test.ts src/renderer` → PASS; `npm run typecheck`; `npm run lint` on the changed files.
- [ ] **Step 5: Commit** `feat(install): kiagent://install links open a prefilled Add sheet`.

### Task 7: alpha-cent — declare the scheme

**Files** (alpha-cent, branch `feat/kiagent-scheme`):
- Modify: `product/product.json` (`"urlScheme": "kiagent"`),
  `product/build.json`
  (`"protocols":[{"name":"KIAgent","schemes":["kiagent"]}]`),
  `build/inject.mjs` (`if (buildCfg.protocols) pkg.build.protocols = buildCfg.protocols;`)
- Test: `build/inject.test.mjs`

- [ ] **Step 1:** add the failing test `copies protocols into pkg.build`.
- [ ] **Step 2:** `node --test build/inject.test.mjs` → FAIL.
- [ ] **Step 3:** implement.
- [ ] **Step 4:** run it again → PASS.
- [ ] **Step 5: Commit** `feat(product): declare the kiagent:// scheme`.

  This branch merges only after the core release that accepts `urlScheme`.
  An older core would reject the key and degrade to defaults.

### Task 8: Live check (dev app)

- [ ] Run the dev app on this core: `KIA_CORE_LOCK` points at the local
  worktree tag. Respect the recording guard, and kill orphan llama-servers
  after the restart.
- [ ] In Sources → Add a source, check that the row is visible.
- [ ] Paste a public repo that has a `.tgz` release from outside
  `kia-plugins`, and check:
  - the notice and the `github.com/o/r` meta line appear;
  - Cancel works.
- [ ] Paste `kia-plugins/slack-kia-connector` and check that the sheet
  says "From the store", then Cancel.
- [ ] Paste `gitlab.com/a/b` and check the copy.

**Final review:** fable + astra on the whole branch. Loop until both say
OK.
