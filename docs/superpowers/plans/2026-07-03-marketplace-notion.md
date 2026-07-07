# Plan B — Marketplace + Notion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the marketplace real: browse the `kia-plugins` GitHub org in-app, install extensions
with a consent modal, get update badges — and ship the Notion connector rewritten against the new
contract as release `v2.0.0`.

**Architecture:** Plan B of `docs/superpowers/specs/2026-07-03-extension-marketplace-design.md`
(§4 catalog/installer refs/IPC, §5 renderer, §6 Notion, §8 testing). Plan A (the runtime) is
complete on this branch: `src/main/platform/` + `src/main/marketplace/installer.ts` all shipped
and reviewed. Plan B adds: the GitHub catalog port (`github-source`/`github-cache`/`update-check`
from branch `main`), `github:`/`https:` refs + SRI/TOFU in the installer behind an injected
`download` seam, `marketplace:*` IPC + one new `extension:grant-consent` channel, the functional
Marketplace screen + ConsentModal, and the Notion v2 extension (separate repo
`~/work/notion-kia-connector`, branch `v2`, published via `gh`).

**Tech stack:** existing `tar`/`semver`/`zod`/`nock`/`react-markdown@^9.1.0` (all already in
package.json), Node ≥22 global `fetch`, `@testing-library/react` (present, unused until now),
esbuild (Notion repo).

## Global Constraints

Every task's requirements implicitly include these.

1. **NEVER print, quote, or modify `src/main/sources/gmail/client-credentials.ts`.**
2. `npx tsc --noEmit` baseline is exactly **6 pre-existing errors** (tmp-promise ×2, MCP SDK
   resolution-mode, franc-min/language.ts, minizlib zstd ×2). Zero NEW errors.
   *Amended at T10 (controller adjudication): baseline is **7** from T10 on —
   `Detail.tsx` importing ESM-only `react-markdown` adds a TS1479 identical in kind to the
   franc-min entry; the production webpack renderer build compiles it fine (verified), and
   the brief forbade require/shim hacks. Same precedent, same disposition: documented, not
   worked around.*
3. Full suite `npx jest` green (50 suites / 385 tests at plan start — grows with each task).
   Notion-repo tasks run `npm test` inside `~/work/notion-kia-connector` instead.
4. Org/topic constants: `MARKETPLACE_ORG = 'kia-plugins'`, `PLUGIN_TOPIC = 'kia-plugin'`.
   GitHub API base `https://api.github.com`. Catalog cache TTL **5 minutes**, User-Agent
   **`kiagent`** (greenfield brand; the legacy value `alpha-cent` must NOT be ported).
5. Installable release = **latest non-prerelease** release with a `.tgz` asset. No prerelease
   fallback (deliberate delta from legacy `?? releases[0]`), no version picker.
6. Installed marketplace refs are stored **pinned**: `github:owner/repo@<tag>`. Update check
   strips the pin before resolving latest.
7. Integrity = SRI `sha512-<base64>` TOFU pin. Same id+version reinstall with different bytes
   fails with exactly: `integrity check failed: bytes differ from the pinned install for this
   version`. `origin: 'dev'` (local refs) never pins.
8. Consent is all-or-nothing per manifest; updates ALWAYS re-show consent; consent rows are
   append-only (never deleted). The renderer gates `install-commit` behind ConsentModal;
   `install-commit` itself still records consent (unchanged Plan-A behavior).
9. Exact user-facing strings already shipped and load-bearing (tests assert them):
   - `marketplace installs are not available yet — install from a local path` (only when no
     `download` dep is wired)
   - `Remove this connector's sources before uninstalling it.`
   - `This extension was built for the legacy app and is not compatible with this build.`
10. Notion manifest is EXACTLY:
    `{ "id": "kia.notion", "name": "Notion", "version": "2.0.0", "engine": "^1.0.0",
    "entry": "dist/index.js", "caps": ["net"], "contributes": { "sources": ["notion"] } }`.
11. Extensions use `host.net.fetch` for ALL network I/O (never global fetch in extension code).
    Its response shape is `{ status, statusText, headers: Record<string,string> (lowercase keys),
    body: Uint8Array }` — not a WHATWG Response.
12. Renderer idioms: `useAppState(selector)` from `src/renderer/state/app-state.ts` for AppState;
    `window.kiagent.invoke(channel, payload)` for commands; new IPC channels need BOTH an
    `Invokes` entry and an `INVOKE_CHANNELS` array entry in `src/shared/ipc.ts`.
13. Reference code locations (read-only): legacy catalog on branch `main` via
    `git show main:src/main/marketplace/<file>.ts`; Notion v1 source at
    `~/work/notion-kia-connector` branch `main` (v2 work happens on branch `v2` of that repo).

## File Map

| Task | Files |
|---|---|
| T1 | `src/main/platform/__tests__/fixtures/ext-basic/index.js`, `__tests__/extension-e2e.test.ts` |
| T2 | `src/main/marketplace/installer.ts`, `__tests__/installer.test.ts`, `src/main/platform/__tests__/host-surfaces.test.ts` |
| T3 | NEW `src/main/marketplace/github-ref.ts`, `github-cache.ts` + tests |
| T4 | NEW `src/main/marketplace/github-source.ts`, `update-check.ts` + tests |
| T5 | `src/main/marketplace/installer.ts`, `src/main/platform/extension-platform.ts` + tests |
| T6 | `src/main/platform/extension-platform.ts`, `src/shared/ipc.ts`, `src/main/main.ts` + tests |
| T7 | NEW `src/main/marketplace/catalog.ts` + test, `src/shared/ipc.ts`, `src/main/main.ts` |
| T8 | NEW `src/renderer/components/ConsentModal.tsx`, `ConsentModal.css`, `cap-catalog.ts` + test |
| T9 | `src/renderer/screens/Marketplace/index.tsx`, `Marketplace.css`, NEW `rows.ts` + tests |
| T10 | NEW `src/renderer/screens/Marketplace/Detail.tsx`, `index.tsx`, `Marketplace.css` + tests |
| T11–T13 | `~/work/notion-kia-connector` branch `v2` (separate repo) |
| T14 | docs + publish (controller-led) |

Dependency / wave sketch (files disjoint within a wave):
W0 = T1, T2, T3, T8, T11 · W1 = T4, T5, T12 · W2 = T6, T13 · W3 = T7 · W4 = T9 · W5 = T10 · W6 = T14.

---

### Task 1: Reconcile-over-RPC e2e (carry-forward — MUST land before the Notion port)

The whole reconcile path exists (child `reconcile-open` at `extension-host-entry.ts:186`, proxy
`hasReconcile` at `source-proxy.ts:191`, engine `reconcilePass` at `engine.ts:145` with the
startSeq TOCTOU guard) but has ZERO end-to-end coverage. Notion v2 relies on it.

**Files:**
- Modify: `src/main/platform/__tests__/fixtures/ext-basic/index.js`
- Modify: `src/main/platform/__tests__/extension-e2e.test.ts`
- Test: the e2e file itself

**Interfaces:**
- Consumes: `Source.reconcile?(session): AsyncIterable<ExternalRef[]>` (contracts.ts:320);
  engine runs reconcile once per `engine.run()` cycle, concurrent with pull, and only archives
  stored docs whose `seq <= startSeq` (the snapshot taken at cycle start).
- Produces: fixture `ext-basic` now has `reconcile` (so `hasReconcile: true` crosses the wire).

- [ ] **Step 1: Add `reconcile` to the fixture source** (`fixtures/ext-basic/index.js`), after
  `toDocument`:

```js
          async *reconcile(session) {
            if (session.signal.aborted) return;
            // Lists ONLY basic-0 as live upstream. During the first engine
            // cycle both docs commit AFTER reconcile's startSeq snapshot, so
            // the TOCTOU guard archives nothing; a SECOND cycle sees basic-1
            // stored below startSeq and absent upstream -> archived.
            yield [{ externalId: 'basic-0', type: 'basic.item' }];
          },
```

- [ ] **Step 2: Extend the e2e test.** In `extension-e2e.test.ts`, after the existing
  `docs.map(...)` assertion (line 99) and BEFORE the uninstall block, insert:

```ts
    // Reconcile over RPC: a second engine cycle diffs the child's listing
    // (only basic-0 lives upstream) against the store and archives basic-1.
    // Cycle 1 above archived nothing — both docs committed after reconcile's
    // startSeq snapshot (the engine's TOCTOU guard) — which this implicitly
    // proves too: count was 2 at the end of cycle 1.
    const handle2 = engine.run(account);
    const deadline2 = Date.now() + 60_000;
    // eslint-disable-next-line no-await-in-loop
    while ((await store.read.count({ account: account.id })) > 1 && Date.now() < deadline2) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => { setTimeout(r, 200); });
    }
    await handle2.stop();
    expect(await store.read.count({ account: account.id })).toBe(1);
    const live = await store.read.search({ account: account.id });
    expect(live.map((d) => d.externalId)).toEqual(['basic-0']);
```

  If `store.read.count`/`search` do NOT exclude archived docs by default, switch the assertion to
  whatever the store's real archived-visibility contract is (check `store.ts` — default queries
  hide `archived_at IS NOT NULL` rows) and assert `basic-1` has a non-null archived timestamp.

- [ ] **Step 3: Run** `npx jest src/main/platform/__tests__/extension-e2e.test.ts` — the new
  assertions must pass. Run it TWICE back-to-back (flake bar from Plan A).
- [ ] **Step 4:** `npx tsc --noEmit` (baseline 6). Full `npx jest` green.

---

### Task 2: Carry-forward hardening — events self-delivery pin + `data/`-shipping rejection

**Files:**
- Modify: `src/main/marketplace/installer.ts`
- Modify: `src/main/marketplace/__tests__/installer.test.ts`
- Modify: `src/main/platform/__tests__/host-surfaces.test.ts`

**Interfaces:** none new. Behavior pin + one new preview rejection.

- [ ] **Step 1: Events self-delivery test** (host-surfaces.test.ts). The bus
  (`host-surfaces.ts:21-39`) delivers to ALL subscribers of an event including the emitter —
  pin that as contract:

```ts
  it('delivers events to the emitter itself when subscribed (self-delivery contract)', () => {
    const bus = createEventBus();
    const got: unknown[] = [];
    const a = buildSurfaces({ ...surfaceDeps('ext.a', bus), deliverEvent: (n, p) => got.push([n, p]) });
    (a.surfaces.events.on as (e: string) => void)('ping');
    (a.surfaces.events.emit as (e: string, p: unknown) => void)('ping', { v: 1 });
    expect(got).toEqual([['ping', { v: 1 }]]);
    a.close();
  });
```

  Adapt `surfaceDeps` to however the existing tests in that file construct `SurfaceDeps`
  (there are existing events tests — follow their helper exactly). Also add a one-line doc
  comment on `createEventBus` in `host-surfaces.ts`:
  `Delivery includes the emitter itself when subscribed — self-delivery is part of the contract.`

- [ ] **Step 2: `data/` rejection tests first** (installer.test.ts, using that file's existing
  fixture/tgz helpers):
  - a `.tgz` whose root contains `data/anything.txt` → `preview` rejects with EXACTLY
    `package ships a 'data/' directory — 'data/' is reserved for extension-private state`,
    staging dir cleaned up.
  - a local DIRECTORY ref containing `data/junk.txt` → `preview` SUCCEEDS and the staged copy
    contains NO `data/` (dev-loop convenience: an in-place-run extension dir is installable;
    its runtime `data/` is simply not copied).

- [ ] **Step 3: Implement in `installer.ts` preview.** For the directory branch, exclude the
  top-level `data/` from the copy:

```ts
        if (stat.isDirectory()) {
          fs.cpSync(abs, stagingDir, {
            recursive: true,
            filter: (src) => src !== path.join(abs, 'data'),
          });
        }
```

  After extraction/copy (both branches), before `validateManifestDir`:

```ts
        if (fs.existsSync(path.join(stagingDir, 'data'))) {
          throw new Error(
            "package ships a 'data/' directory — 'data/' is reserved for extension-private state",
          );
        }
```

  (The directory branch can never hit this; the guard catches `.tgz` packages — and later,
  marketplace downloads, which reuse the same extraction path.)

- [ ] **Step 4:** `npx jest src/main/marketplace src/main/platform/__tests__/host-surfaces.test.ts`
  green; `npx tsc --noEmit` baseline 6.

---

### Task 3: `github-ref` + `github-cache` (port from branch `main`)

**Files:**
- Create: `src/main/marketplace/github-ref.ts`
- Create: `src/main/marketplace/github-cache.ts`
- Test: `src/main/marketplace/__tests__/github-ref.test.ts`, `__tests__/github-cache.test.ts`

**Interfaces:**
- Produces: `parseGitHubRef(ref): { owner, repo, tag? } | null`; `formatGitHubRef(owner, repo)`;
  `GitHubRateLimitError`; `createGitHubCache({ cacheFile, ttlMs?, now?, fetchImpl? }) → { getJSON<T>(url), getText(url) }`.

- [ ] **Step 1: Port both files.** Source of truth: `git show main:src/main/marketplace/github-ref.ts`
  and `git show main:src/main/marketplace/github-cache.ts`. Port VERBATIM with exactly one delta:
  in `github-cache.ts`, both `User-Agent` header values change `'alpha-cent'` → `'kiagent'`.
  Cache mechanics to preserve exactly: 5-min default TTL; ETag `If-None-Match` on stale hits;
  304 refreshes `fetchedAt` and returns cached body; 403-with-`X-RateLimit-Remaining: 0` or any
  429 → stale body if present else `GitHubRateLimitError`; network throw / non-ok → stale body
  if present else rethrow; `getText` uncached; JSON persistence (full-file rewrite) at
  `deps.cacheFile` with `mkdirSync recursive` on the dirname.

- [ ] **Step 2: Write the tests** (fresh — do not port legacy tests blind). `github-ref.test.ts`:
  parses `github:kia-plugins/notion-kia-connector`, `github:o/r@v2.0.0` (tag captured), rejects
  `github:junk`, `https://x`, `owner/repo`; `formatGitHubRef` round-trips. `github-cache.test.ts`
  with injected `fetchImpl` (jest.fn returning `new Response(...)`) + injected `now` + a
  `mkdtempSync` cacheFile:
  1. fresh fetch stores body+etag; second call within TTL does NOT call fetchImpl.
  2. past TTL, sends `If-None-Match`, a 304 response refreshes and returns cached body.
  3. 429 → returns stale body when cached; throws `GitHubRateLimitError` when not.
  4. fetch rejection → stale body when cached; rethrows when not.
  5. persistence: a NEW `createGitHubCache` over the same file serves the cached body without
     any fetch (within TTL).
  6. `getText` never caches (two calls → two fetches).

- [ ] **Step 3:** `npx jest src/main/marketplace` green; `npx tsc --noEmit` baseline 6.

---

### Task 4: `github-source` + `update-check` (port, retargeted to spec v1 shapes)

**Files:**
- Create: `src/main/marketplace/github-source.ts`
- Create: `src/main/marketplace/update-check.ts`
- Test: `src/main/marketplace/__tests__/github-source.test.ts`, `__tests__/update-check.test.ts`

**Interfaces:**
- Consumes: Task 3 exports. Type-only: `MarketplaceListItem`, `PluginDetail`, `UpdateInfo` do
  NOT exist in `@shared/ipc` yet (Task 7 adds them) — define them LOCALLY in these two files and
  export them; Task 7 will move them to `@shared/ipc` and re-import. (Keeps this task
  independent of `ipc.ts`, which other tasks edit.)
- Produces:

```ts
// github-source.ts
export const MARKETPLACE_ORG = 'kia-plugins';
export const PLUGIN_TOPIC = 'kia-plugin';
export interface MarketplaceListItem {
  owner: string; repo: string; fullName: string;
  displayName: string; description: string;
  installedId?: string; // filled by catalog.ts (Task 7), never here
}
export interface PluginDetail {
  listing: MarketplaceListItem;
  readmeMarkdown: string;
  latest: { tag: string; version: string; publishedAt: string;
            tarballUrl: string | null; prerelease: boolean } | null;
}
export function createGitHubSource(deps: { cache: Cache; org?: string; topic?: string }): {
  listOrgPlugins(): Promise<MarketplaceListItem[]>;
  getDetail(owner: string, repo: string): Promise<PluginDetail>;
  resolveGitHubRef(ref: string): Promise<{ tarballUrl: string; version: string; tag: string } | null>;
  downloadAsset(url: string): Promise<Buffer>;
};
// update-check.ts
export interface UpdateInfo { id: string; installedVersion: string; latestVersion: string; ref: string }
export function checkUpdates(deps: {
  installed: Array<{ id: string; version: string; ref?: string }>;
  resolveLatest: (ref: string) => Promise<{ version: string } | null>;
}): Promise<UpdateInfo[]>;
```

- [ ] **Step 1: Port `github-source.ts`** from `git show main:src/main/marketplace/github-source.ts`
  with these deltas (everything else verbatim — endpoints, `toVersion` via
  `semver.coerce`, `tgzAsset` first-`.tgz`-asset match, parallel `getDetail` fetches, README via
  `https://raw.githubusercontent.com/{owner}/{repo}/HEAD/README.md` with `.catch(() => '')`):
  1. `PluginListing` → `MarketplaceListItem` (drop the `topics` field; `displayName = r.name`).
  2. `PluginDetail.releases: ReleaseInfo[]` → `latest` (trimmed v1): map releases with the
     legacy `toReleaseInfo`, then `latest = mapped.find((r) => !r.prerelease) ?? null` — note:
     spec §4.1, latest NON-prerelease only, NO `?? releases[0]` fallback. Keep `notes` out of the
     `latest` shape (drop the field — no Changelog tab in v1).
  3. `resolveGitHubRef` additionally returns the picked release's `tag` (needed to build the
     pinned installed ref). Pinned-ref behavior unchanged: an `@tag` ref picks that exact tag;
     an unpinned ref picks the first non-prerelease — for resolve, KEEP the legacy
     `?? releases[0]` fallback? NO — same spec rule applies: `releases.find((r) => !r.prerelease) ?? null`,
     return `null` when nothing installable.
  4. Add `downloadAsset`:

```ts
  async function downloadAsset(url: string): Promise<Buffer> {
    const r = await (deps.fetchImpl ?? fetch)(url, {
      headers: { 'User-Agent': 'kiagent', Accept: 'application/octet-stream' },
      redirect: 'follow',
    });
    if (!r.ok) throw new Error(`download failed: ${r.status} ${url}`);
    return Buffer.from(await r.arrayBuffer());
  }
```

  and add optional `fetchImpl?: typeof fetch` to the deps for testability (cache handles its own
  fetch injection; `downloadAsset` bypasses the cache deliberately — release assets are
  one-shot, large, and redirect to S3).

- [ ] **Step 2: Port `update-check.ts`** from `git show main:src/main/marketplace/update-check.ts`
  with one delta: `installed` items are `{ id, version, ref? }` (ref optional — snapshots of
  dev installs carry `file:` refs or none); guard `if (!rec.ref?.startsWith('github:')) continue;`
  and keep the tag-strip comment + `semver.valid × 2 + semver.gt` comparison verbatim.

- [ ] **Step 3: Tests.** `github-source.test.ts` with an injected fake cache (`getJSON`/`getText`
  jest.fns keyed by URL):
  - `listOrgPlugins` hits the exact search URL
    `https://api.github.com/search/repositories?q=org:kia-plugins+topic:kia-plugin&per_page=100`
    and maps items.
  - `getDetail` returns README text, and `latest` skips prereleases (fixture: releases
    `[v3.0.0-beta (prerelease, tgz), v2.0.0 (tgz), v1.0.0 (tgz)]` → latest tag `v2.0.0`).
  - `latest: null` when only prereleases exist.
  - `latest.tarballUrl: null` when the release has no `.tgz` asset.
  - `resolveGitHubRef('github:o/r@v1.0.0')` picks the pinned tag; unpinned picks latest
    non-prerelease and returns its `tag`; returns null for garbage refs and for
    no-installable-release.
  - `downloadAsset` (injected fetchImpl): ok → Buffer with the body bytes; 404 → throws
    `/download failed: 404/`.
  `update-check.test.ts`: pinned installed ref `github:o/r@v1.0.0` calls `resolveLatest` with
  the BARE `github:o/r` (capture arg); reports update only when `semver.gt`; skips `file:` refs
  and refless records; swallows per-repo `resolveLatest` rejections (that record just reports
  nothing).

- [ ] **Step 4:** `npx jest src/main/marketplace` green; `npx tsc --noEmit` baseline 6.

---

### Task 5: Installer marketplace refs + SRI/TOFU (behind an injected `download` seam)

**Files:**
- Modify: `src/main/marketplace/installer.ts`
- Modify: `src/main/platform/extension-platform.ts` (deps pass-through only)
- Test: `src/main/marketplace/__tests__/installer.test.ts`

No import of Task 3/4 code — the resolver arrives as a closure (wired in Task 7). This task can
run in the same wave as Task 4.

**Interfaces:**
- Produces (installer.ts):

```ts
export interface InstallerDeps {
  extDir: string;
  sourceIdOwners(): Record<string, string>;
  /** Resolves a marketplace ref (github:owner/repo[@tag] or http(s) URL) to
   *  tarball bytes + the PINNED ref to record. Absent → marketplace refs are
   *  rejected exactly as in Plan A. */
  download?: (ref: string) => Promise<{ bytes: Buffer; pinnedRef: string }>;
}
// PendingInstall gains: origin: 'marketplace' | 'dev';
```

- Produces (extension-platform.ts): `ExtensionPlatformDeps` gains
  `download?: InstallerDeps['download']`, forwarded into the internal `createInstaller` call
  (`extension-platform.ts:111`). Nothing else in the platform changes.

- [ ] **Step 1: Failing tests** (installer.test.ts; reuse the file's tgz-building helper — it
  already builds fixture tarballs):

```ts
  describe('marketplace refs', () => {
    const tgzBytesOf = async (version: string) => {/* build a valid ext tgz (id 'mkt.demo', that version) and read its bytes */};

    it('still rejects marketplace refs when no download dep is wired', async () => {
      await expect(installer.preview('github:kia-plugins/x')).rejects.toThrow(/not available yet/);
      await expect(installer.preview('https://example.com/x.tgz')).rejects.toThrow(/not available yet/);
    });

    it('downloads, pins integrity, and records origin marketplace + pinned ref', async () => {
      const bytes = await tgzBytesOf('1.0.0');
      const download = jest.fn(async () => ({ bytes, pinnedRef: 'github:o/r@v1.0.0' }));
      const inst = createInstaller({ ...baseDeps, download });
      const p = await inst.preview('github:o/r');
      expect(download).toHaveBeenCalledWith('github:o/r');
      expect(p.integrity).toMatch(/^sha512-/);
      expect(p.ref).toBe('github:o/r@v1.0.0');
      expect(p.origin).toBe('marketplace');
      const { record } = await inst.commit(p.token);
      expect(record).toMatchObject({ origin: 'marketplace', ref: 'github:o/r@v1.0.0', integrity: p.integrity });
    });

    it('TOFU: same id+version with different bytes is rejected; same bytes and version bumps pass', async () => {
      // install v1.0.0 (pin), then:
      // preview of a REBUILT v1.0.0 tgz with an extra file -> rejects with EXACTLY
      //   'integrity check failed: bytes differ from the pinned install for this version'
      // preview of byte-identical v1.0.0 -> ok; preview of v2.0.0 (different bytes) -> ok
    });

    it('local refs still work and never pin', async () => {
      const p = await installer.preview(FIXTURE_DIR);
      expect(p.integrity).toBeNull();
      expect(p.origin).toBe('dev');
    });

    it('cleans staging and propagates when download rejects', async () => {
      const inst = createInstaller({ ...baseDeps, download: async () => { throw new Error('offline'); } });
      await expect(inst.preview('github:o/r')).rejects.toThrow('offline');
    });
  });
```

  Flesh the TOFU test out with real assertions (the comment lines above are the required cases,
  not placeholders to leave as comments).

- [ ] **Step 2: Implement.** In `preview`:

```ts
    async preview(ref: string): Promise<PendingInstall> {
      const isMarketplace = /^github:/.test(ref) || /^https?:/.test(ref);
      if (isMarketplace && !deps.download) {
        throw new Error('marketplace installs are not available yet — install from a local path');
      }
      const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kia-ext-stage-'));
      try {
        let integrity: string | null = null;
        let recordRef: string;
        if (isMarketplace) {
          const { bytes, pinnedRef } = await deps.download!(ref);
          integrity = `sha512-${crypto.createHash('sha512').update(bytes).digest('base64')}`;
          recordRef = pinnedRef;
          const tgzPath = `${stagingDir}.tgz`;
          fs.writeFileSync(tgzPath, bytes);
          try {
            await tar.x({ file: tgzPath, cwd: stagingDir, strip: 1 });
          } finally {
            fs.rmSync(tgzPath, { force: true });
          }
        } else {
          const abs = path.resolve(ref);
          if (!fs.existsSync(abs)) throw new Error(`no such path: ${ref}`);
          recordRef = `file:${abs}`;
          // ... existing dir-copy (with the Task-2 data/ filter) / local-tgz branches unchanged
        }
        // ... existing data/ guard, validateManifestDir, source-id collision checks unchanged
        if (integrity) {
          const prior = readInstalled(deps.extDir).find((r) => r.id === manifest.id);
          if (prior && prior.version === manifest.version && prior.integrity && prior.integrity !== integrity) {
            throw new Error('integrity check failed: bytes differ from the pinned install for this version');
          }
        }
        const entry: PendingInstall = {
          token: crypto.randomUUID(),
          stagingDir, manifest,
          sizeBytes: duSync(stagingDir),
          integrity,
          ref: recordRef,
          origin: isMarketplace ? 'marketplace' : 'dev',
        };
        // ... pending.set / MAX_PENDING eviction unchanged
      } catch (e) {
        fs.rmSync(stagingDir, { recursive: true, force: true });
        throw e;
      }
    },
```

  In `commit`: `origin: p.origin` replaces the hardcoded `'dev'`. Update the file's header
  comment (the "Plan B" sentence now describes reality). In `extension-platform.ts`: add the
  optional dep + forward `download: deps.download` in the `createInstaller({...})` call.

- [ ] **Step 3:** `npx jest src/main/marketplace src/main/platform` green (platform tests confirm
  the deps change is inert); `npx tsc --noEmit` baseline 6.

---

### Task 6: `extension:grant-consent` — the needs-consent → activated path

Spec §3.4 mandates a "Review permissions" action that records fresh consent from the ON-DISK
manifest and activates; the spec's IPC table omitted its channel — this task completes it
(`extension:grant-consent`; the spec doc gets updated in Task 14).

**Files:**
- Modify: `src/main/platform/extension-platform.ts`
- Modify: `src/shared/ipc.ts`
- Modify: `src/main/main.ts`
- Test: `src/main/platform/__tests__/extension-platform.test.ts`

**Interfaces:**
- Produces: `ExtensionPlatform.grantConsent(id: string): Promise<{ ok: boolean; error?: string }>`;
  IPC `'extension:grant-consent': { req: { id: string }; res: { ok: boolean; error?: string } }`.

- [ ] **Step 1: Failing test** (extension-platform.test.ts, using that file's existing in-memory
  harness and fixture helpers):

```ts
  it('grant-consent records the on-disk manifest caps and activates a needs-consent extension', async () => {
    // 1. install-preview + install-commit the basic fixture -> status 'activated'
    // 2. setEnabled(id, false)
    // 3. store.consents.record({ extensionId: id, caps: [], manifestVersion: '0.0.0-stale', grantedAt: ... })
    //    (latest-wins: the stale row no longer covers the manifest)
    // 4. setEnabled(id, true) -> snapshot status 'needs-consent'
    // 5. grantConsent(id) -> { ok: true }; snapshot status 'activated'
    // 6. store.consents.latest(id) now matches manifest caps + version
    // Also: grantConsent('nope.nope') -> { ok: false, error: 'no such extension: nope.nope' }
  });
```

  Implement with real assertions at each numbered point.

- [ ] **Step 2: Implement** in the returned object of `createExtensionPlatform`, beside
  `setEnabled`:

```ts
    async grantConsent(id) {
      return runExclusive(id, async () => {
        const e = entries.get(id);
        if (!e) return { ok: false, error: `no such extension: ${id}` };
        const consent: ConsentRecord = {
          extensionId: e.manifest.id as ExtensionId,
          caps: e.manifest.caps as Cap[],
          manifestVersion: e.manifest.version,
          grantedAt: new Date().toISOString(),
        };
        await deps.store.consents.record(consent);
        if (e.enabled) await activate(e);
        changed();
        return { ok: true };
      });
    },
```

  Add `grantConsent` to the `ExtensionPlatform` interface with the doc comment: consent is read
  from the ON-DISK manifest (never renderer-supplied caps) — the renderer only confirms.

- [ ] **Step 3: Wire IPC.** `src/shared/ipc.ts`: add the `Invokes` entry (place it right after
  `extension:set-enabled`) + `'extension:grant-consent'` in `INVOKE_CHANNELS`. `src/main/main.ts`
  (in `registerIpc`, beside the other extension handlers at ~line 333):
  `handle('extension:grant-consent', ({ id }) => extensions.grantConsent(id));`

- [ ] **Step 4:** `npx jest src/main/platform` green; `npx tsc --noEmit` baseline 6.

---

### Task 7: Marketplace catalog module + `marketplace:*` IPC + main wiring

**Files:**
- Create: `src/main/marketplace/catalog.ts`
- Test: `src/main/marketplace/__tests__/catalog.test.ts`
- Modify: `src/shared/ipc.ts` (types move here + 3 channels)
- Modify: `src/main/marketplace/github-source.ts`, `update-check.ts` (re-import moved types)
- Modify: `src/main/main.ts`

**Interfaces:**
- Consumes: Task 4 (`createGitHubSource`, `checkUpdates`, `parseGitHubRef`, `formatGitHubRef`),
  Task 5 (`download` platform dep), `ExtensionSnapshot` (has `ref?`).
- Produces: `MarketplaceListItem`/`PluginDetail`/`UpdateInfo` now exported from `@shared/ipc`
  (single home; github-source.ts/update-check.ts import them from there — delete the local
  copies). IPC:

```ts
  /** Official kia-plugins catalog (5-min cached). Rejects on first-ever fetch failure. */
  'marketplace:list': { req: void; res: MarketplaceListItem[] };
  'marketplace:detail': { req: { owner: string; repo: string }; res: PluginDetail };
  'marketplace:check-updates': { req: void; res: UpdateInfo[] };
```

  plus the three `INVOKE_CHANNELS` entries (before the `extension:*` block).

- Produces (catalog.ts):

```ts
import { formatGitHubRef } from './github-ref';
import { checkUpdates } from './update-check';
import type { createGitHubSource } from './github-source';
import type { ExtensionSnapshot } from '@shared/contracts';
import type { MarketplaceListItem, PluginDetail, UpdateInfo } from '@shared/ipc';

export function createMarketplaceCatalog(deps: {
  source: ReturnType<typeof createGitHubSource>;
  snapshot(): ExtensionSnapshot[];
}) {
  const installedIdFor = (owner: string, repo: string): string | undefined => {
    const bare = formatGitHubRef(owner, repo);
    return deps.snapshot().find((s) => s.ref === bare || s.ref?.startsWith(`${bare}@`))?.id;
  };
  return {
    async list(): Promise<MarketplaceListItem[]> {
      const items = await deps.source.listOrgPlugins();
      return items.map((i) => ({ ...i, installedId: installedIdFor(i.owner, i.repo) }));
    },
    async detail(owner: string, repo: string): Promise<PluginDetail> {
      const d = await deps.source.getDetail(owner, repo);
      return { ...d, listing: { ...d.listing, installedId: installedIdFor(owner, repo) } };
    },
    async checkUpdates(): Promise<UpdateInfo[]> {
      return checkUpdates({
        installed: deps.snapshot(),
        resolveLatest: (ref) => deps.source.resolveGitHubRef(ref),
      });
    },
  };
}
export type MarketplaceCatalog = ReturnType<typeof createMarketplaceCatalog>;
```

- [ ] **Step 1: Move the types.** Cut `MarketplaceListItem`/`PluginDetail` from github-source.ts
  and `UpdateInfo` from update-check.ts into `src/shared/ipc.ts` (beside `ExtensionPreview`);
  re-import. Add the three `Invokes` entries + channel-array entries.
- [ ] **Step 2: catalog.ts + test.** Test with a fake `source` and a mutable snapshot array:
  `installedId` matches a bare ref, a pinned ref (`github:o/r@v1.0.0`), and is undefined for
  `file:` refs / other repos; `detail` decorates its listing; `checkUpdates` passes snapshots
  through and resolves via the source (capture the stripped ref).
- [ ] **Step 3: main.ts wiring.** Above the `createExtensionPlatform` call (~line 417):

```ts
    const ghCache = createGitHubCache({
      cacheFile: path.join(app.getPath('userData'), 'extensions', 'github-cache.json'),
    });
    const ghSource = createGitHubSource({ cache: ghCache });
```

  Add to the `createExtensionPlatform` deps:

```ts
      download: async (ref) => {
        if (ref.startsWith('github:')) {
          const parsed = parseGitHubRef(ref);
          const resolved = parsed && (await ghSource.resolveGitHubRef(ref));
          if (!parsed || !resolved) throw new Error(`no installable release for ${ref}`);
          return {
            bytes: await ghSource.downloadAsset(resolved.tarballUrl),
            pinnedRef: `${formatGitHubRef(parsed.owner, parsed.repo)}@${resolved.tag}`,
          };
        }
        return { bytes: await ghSource.downloadAsset(ref), pinnedRef: ref };
      },
```

  After the platform exists:
  `const catalog = createMarketplaceCatalog({ source: ghSource, snapshot: () => extensionsPlatform!.snapshot() });`
  Pass `catalog` into `registerIpc` (add a parameter) and register:

```ts
    handle('marketplace:list', () => catalog.list());
    handle('marketplace:detail', ({ owner, repo }) => catalog.detail(owner, repo));
    handle('marketplace:check-updates', () => catalog.checkUpdates());
```

  Invoke rejections surface to the renderer as rejected promises — the screen (Task 9/10)
  catches them; no try/catch needed here (matches the file's existing handler style).
- [ ] **Step 4:** Full `npx jest` green; `npx tsc --noEmit` baseline 6.

---

### Task 8: ConsentModal + cap catalog (renderer component, first RTL test in the repo)

**Files:**
- Create: `src/renderer/components/cap-catalog.ts`
- Create: `src/renderer/components/ConsentModal.tsx`
- Create: `src/renderer/components/ConsentModal.css`
- Test: `src/renderer/components/__tests__/ConsentModal.test.tsx`

**Interfaces:**
- Consumes: `Cap` from `@shared/contracts`; `Icon` from `@shared/web-ui/icon-sprite` (valid
  names used below: `search`, `external`, `folder`, `database`, `info`, `settings`, `spark`,
  `log`, `shield`, `x` — all exist in the sprite).
- Produces:

```ts
// cap-catalog.ts
export interface CapInfo { label: string; description: string; risk: 'normal' | 'elevated'; icon: string }
export const CAP_CATALOG: Record<Cap, CapInfo>;
// ConsentModal.tsx
export interface ConsentRequest {
  mode: 'install' | 'update' | 'review';
  id: string; name: string; version: string; caps: Cap[];
  sizeBytes?: number; integrity?: string | null; ref?: string;
}
export function ConsentModal(props: {
  request: ConsentRequest;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}): React.ReactElement;
```

- [ ] **Step 1: cap-catalog.ts** — exact copy (spec §5):

```ts
import type { Cap } from '@shared/contracts';

export interface CapInfo {
  label: string;
  description: string;
  risk: 'normal' | 'elevated';
  icon: string;
}

/** Renderer-side registry of what each capability means to a human.
 *  `query` is elevated: it reads the entire indexed corpus — and combined
 *  with `net`, an extension could send that data elsewhere. The description
 *  says so plainly (the consent modal is the exfiltration-awareness moment). */
export const CAP_CATALOG: Record<Cap, CapInfo> = {
  query: {
    label: 'Read your indexed documents',
    description:
      'Can read everything KIAgent has indexed, across all your accounts. ' +
      'Combined with internet access, an extension could send that data elsewhere — ' +
      'only grant this to extensions you trust.',
    risk: 'elevated',
    icon: 'search',
  },
  net: {
    label: 'Access the internet',
    description: 'Can make network requests to any host.',
    risk: 'normal',
    icon: 'external',
  },
  files: {
    label: 'Access approved folders',
    description: 'Not yet supported in this build — calls fail even if granted.',
    risk: 'normal',
    icon: 'folder',
  },
  db: {
    label: 'Keep its own private database',
    description: 'Stores its own data in a private database, separate from your documents.',
    risk: 'normal',
    icon: 'database',
  },
  ui: {
    label: 'Show notifications',
    description: 'Can show system notifications.',
    risk: 'normal',
    icon: 'info',
  },
  commands: {
    label: 'Register commands',
    description: 'Not yet supported in this build — calls fail even if granted.',
    risk: 'normal',
    icon: 'settings',
  },
  inference: {
    label: 'Use your AI models',
    description: 'Can run prompts against the models configured in KIAgent.',
    risk: 'normal',
    icon: 'spark',
  },
  events: {
    label: 'React to platform events',
    description: 'Can send and receive signals shared between extensions.',
    risk: 'normal',
    icon: 'log',
  },
};
```

- [ ] **Step 2: ConsentModal.tsx.** Model the mechanics EXACTLY on
  `src/renderer/screens/Sources/RemoveAccountModal.tsx` (busy state wrapping an async
  `onConfirm`, Escape listener disabled while busy, backdrop click-to-cancel,
  `role="dialog" aria-modal`, inner `stopPropagation`):

```tsx
import React, { useEffect, useState } from 'react';
import { Icon } from '@shared/web-ui/icon-sprite';
import { CAP_CATALOG } from './cap-catalog';
import './ConsentModal.css';

const TITLES = {
  install: 'Install',
  update: 'Update',
  review: 'Review permissions for',
} as const;
const CONFIRM = {
  install: { idle: 'Install', busy: 'Installing…' },
  update: { idle: 'Update', busy: 'Updating…' },
  review: { idle: 'Grant permissions', busy: 'Granting…' },
} as const;

function fmtSize(bytes?: number): string | null {
  if (bytes === undefined) return null;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
```

  Body: header `{TITLES[mode]} {name}` + meta line `v{version} · {fmtSize} · {ref}`; when
  `integrity` present, a `t-meta` row `Integrity {integrity.slice(0, 24)}…`; then one
  `.cm-cap-row` per cap (`.cm-cap-row.elevated` adds the accent border + a
  `<Icon name="shield" size={12} />` "Elevated" tag) with the icon, `label`, and `description`
  from `CAP_CATALOG`; `caps.length === 0` renders the single line
  `This extension requests no capabilities.`; footer = primary `.btn.sm` confirm (label from
  `CONFIRM[mode]`, busy-aware) + `.btn.ghost.sm` Cancel. Updates and installs are the same
  consent (all-or-nothing; updates always re-consent — Global Constraint 8).

- [ ] **Step 3: ConsentModal.css.** Find the `.ra-modal-backdrop`/`.ra-modal` rules
  (`grep -rn 'ra-modal-backdrop' src/renderer --include='*.css'`), copy them as
  `.cm-backdrop`/`.cm-modal` (do NOT reuse the `ra-` classes — they belong to the Sources
  screen's stylesheet and this component must be self-contained), then add: `.cm-modal
  { max-width: 460px; }`, `.cm-caps { display: flex; flex-direction: column; gap: 8px;
  margin: 12px 0; max-height: 300px; overflow-y: auto; }`, `.cm-cap-row { display: flex;
  gap: 10px; align-items: flex-start; }`, `.cm-cap-row.elevated { border-left: 2px solid
  var(--accent-text); padding-left: 8px; }` and small type styles reusing `.t-meta` idioms.

- [ ] **Step 4: RTL test** (`ConsentModal.test.tsx` — the repo's FIRST component test; jsdom is
  already the default `testEnvironment`, `@testing-library/react` + `@testing-library/jest-dom`
  are installed; import `'@testing-library/jest-dom'` at the top of the file):
  - renders name, version, and one row per cap with the CAP_CATALOG label;
  - `query` row has the `elevated` class and the Elevated tag; `net` row does not;
  - confirm button calls `onConfirm`, shows the busy label while a pending promise is unresolved,
    and cancel/Escape are disabled while busy;
  - Escape calls `onCancel` when idle; backdrop click cancels; inner click does not.
- [ ] **Step 5:** `npx jest src/renderer/components` green; `npx tsc --noEmit` baseline 6.

---

### Task 9: Marketplace screen — rows model + list pane

**Files:**
- Create: `src/renderer/screens/Marketplace/rows.ts`
- Test: `src/renderer/screens/Marketplace/__tests__/rows.test.ts`
- Modify: `src/renderer/screens/Marketplace/index.tsx` (full rewrite)
- Modify: `src/renderer/screens/Marketplace/Marketplace.css`
- Test: `src/renderer/screens/Marketplace/__tests__/Marketplace.test.tsx`

**Interfaces:**
- Consumes: `marketplace:list`, `marketplace:check-updates` (Task 7), `useAppState`
  (`src/renderer/state/app-state.ts:130`), `ExtensionSnapshot`.
- Produces (rows.ts — pure, the RTL-free logic home, precedent:
  `src/renderer/components/folder-picker/selection.ts`):

```ts
import type { ExtensionSnapshot } from '@shared/contracts';
import type { MarketplaceListItem, UpdateInfo } from '@shared/ipc';

export type MarketplaceFilter = 'all' | 'official' | 'installed';

export interface MarketplaceRow {
  key: string;                        // 'gh:owner/repo' | 'ext:<id>'
  title: string;
  subtitle: string;                   // catalog description, or 'v1.2.3 · dev install'
  catalog?: MarketplaceListItem;
  installed?: ExtensionSnapshot;      // live AppState match (source of truth for installed-ness)
  updateAvailable: boolean;
}

/** Matches an installed snapshot to a catalog repo by ref: bare github ref or @-pinned. */
export function matchInstalled(item: MarketplaceListItem, extensions: ExtensionSnapshot[]): ExtensionSnapshot | undefined;

/** Catalog rows first (org order), then installed-but-not-in-catalog rows (dev installs).
 *  filter: 'official' = catalog rows only; 'installed' = rows with `installed`;
 *  query: case-insensitive substring on title. */
export function buildRows(
  items: MarketplaceListItem[],
  extensions: ExtensionSnapshot[],
  updates: UpdateInfo[],
  filter: MarketplaceFilter,
  query: string,
): MarketplaceRow[];
```

  `matchInstalled` uses the ref rule `e.ref === 'github:o/r' || e.ref?.startsWith('github:o/r@')`.
  `updateAvailable` = the matched (or installed-only) snapshot's id appears in `updates`.
  Installed-ness comes from LIVE AppState, not the list response's `installedId` (which is a
  point-in-time hint main-side; AppState updates push automatically after install/uninstall).

- [ ] **Step 1: rows.ts + rows.test.ts** (pure jest, no RTL): catalog+installed merge; dev
  install (`file:` ref) appears only as an installed-only row; pinned-ref matching; filter
  semantics for all three pills; search matches title case-insensitively; update flag mapping.
- [ ] **Step 2: Rewrite `index.tsx`.** Keep the chrome classes (`.mkt-shell/.mkt-pane/.mkt-left/
  .mkt-right/.mkt-header/.mkt-search/.mkt-filters/.mkt-list`) and replace the inert internals:

```tsx
const FILTERS: Array<{ key: MarketplaceFilter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'official', label: 'Official store' },
  { key: 'installed', label: 'Installed' },
];
```

  State: `items: MarketplaceListItem[] | null`, `listError: string | null`,
  `updates: UpdateInfo[]`, `query`, `filter` (default `'all'`), `selectedKey: string | null`.
  `const extensions = useAppState((s) => s.extensions);`
  Mount effect (once): `marketplace:list` → items or `listError` (message: the thrown error's
  `message`); `marketplace:check-updates` → updates, failures ignored (`.catch(() => {})`) —
  spec: badge data is best-effort, fetched once per mount. Guard both with an `alive` flag.
  Left pane: search input (enabled now, `aria-label="Search plugins"`), the three pills
  (`.btn.ghost.sm`, active pill gets class `active`), then:
  - `items === null && !listError` → `.mkt-list-empty` with `Loading catalog…`
  - `listError` → `.mkt-list-empty` with the error text and a `Retry` `.btn.ghost.sm` that
    re-runs the mount fetch (extract it to a function)
  - rows: `<button type="button" className={row.key === selectedKey ? 'mkt-row selected' : 'mkt-row'} onClick={...}>`
    with title, subtitle (`.t-meta`), and badges: `Installed` (when `row.installed`), `Update`
    (when `row.updateAvailable`), `Disabled` (installed && !enabled) as `.mkt-badge` spans
    (`.mkt-badge.update` accent-tinted).
  Right pane for this task: when a row is selected render
  `<div className="mkt-notice card"><p className="t-meta">Detail pane arrives in the next task.</p></div>`
  placeholder — Task 10 replaces it; keep the existing empty-state notice card (reworded:
  `Select an extension to see details.`) when nothing is selected.
- [ ] **Step 3: CSS additions** (`Marketplace.css`): `.mkt-row` (full-width, text-left, padding
  8px 10px, border-radius, hover `var(--bg-muted)` tint, `.selected` accent-subtle
  background), `.mkt-row-title` row with `.mkt-badge { font-size: 10px; padding: 1px 6px;
  border: 1px solid var(--border-subtle); border-radius: 999px; }`,
  `.mkt-badge.update { background: var(--accent-subtle); color: var(--accent-text);
  border-color: transparent; }`, `.mkt-filters .btn.active { background: var(--accent-subtle);
  color: var(--accent-text); }`.
- [ ] **Step 4: RTL test** (`Marketplace.test.tsx`). Mock the bridge and the app-state hook:

```tsx
const invoke = jest.fn();
beforeEach(() => {
  invoke.mockReset();
  (window as unknown as { kiagent: unknown }).kiagent = { invoke, on: () => () => {} };
});
jest.mock('../../../state/app-state', () => ({
  useAppState: (sel: (s: unknown) => unknown) => sel(mockState),
}));
```

  (`mockState` a mutable module-level `{ extensions: [...] }`; verify the relative path against
  the real import in index.tsx.) Cases: list renders catalog rows after `marketplace:list`
  resolves; a `file:`-ref snapshot appears as an installed-only row; pill `Installed` filters;
  search filters; `Update` badge appears for an id returned by `marketplace:check-updates`;
  list rejection renders the error and Retry re-invokes.
- [ ] **Step 5:** `npx jest src/renderer` green; `npx tsc --noEmit` baseline 6. If tsc trips on
  importing `react-markdown` — not used in this task — ignore; that's Task 10's concern.

---

### Task 10: Marketplace detail pane — README, caps, actions, consent flows

**Files:**
- Create: `src/renderer/screens/Marketplace/Detail.tsx`
- Modify: `src/renderer/screens/Marketplace/index.tsx` (mount Detail; pass the selected row)
- Modify: `src/renderer/screens/Marketplace/Marketplace.css`
- Test: `src/renderer/screens/Marketplace/__tests__/Detail.test.tsx`

**Interfaces:**
- Consumes: Task 7 IPC + `extension:install-preview/install-commit/uninstall/set-enabled`
  (existing) + `extension:grant-consent` (Task 6) + `ConsentModal`/`ConsentRequest` (Task 8);
  `react-markdown@^9.1.0` (default export `Markdown`; already a dependency, first use).
- Produces: `Detail(props: { row: MarketplaceRow }): React.ReactElement`.

- [ ] **Step 1: Detail.tsx.** State: `detail: PluginDetail | null`, `detailError: string | null`,
  `consent: (ConsentRequest & { token?: string }) | null`, `busy: boolean`,
  `actionError: string | null`. Effect keyed on `row.key`: reset all state; when `row.catalog`,
  invoke `marketplace:detail` (alive-guarded, error → `detailError`). Live snapshot:
  `const installed = useAppState((s) => s.extensions).find((e) => e.id === row.installed?.id);`
  (live status beats the row prop, which only changes when the parent re-renders the list).

  Layout (right pane, scrollable — see CSS step): header (title, version line
  `installed v{installed.version}` / `latest {detail.latest?.version ?? '—'}`), `actionError`
  as a `.mkt-error` notice when set, the action block, caps section for installed extensions
  (one compact row per `installed.caps` entry from `CAP_CATALOG` — label only + elevated tag),
  README section: `<div className="mkt-readme"><Markdown>{detail.readmeMarkdown}</Markdown></div>`
  when catalog detail is loaded (`readmeMarkdown` may be empty → render
  `No README.` in `.t-meta`); `detailError` → error notice instead; installed-only rows (dev
  installs) show caps + actions, no README section.

  Action block logic (exactly these states, in priority order):
  1. NOT installed, `detail.latest?.tarballUrl` truthy → primary **Install** button.
  2. NOT installed, detail loaded but no installable latest → disabled button
     **No installable release yet**.
  3. Installed, `row.updateAvailable` → primary **Update** + the installed-state controls below.
  4. Installed → disabled **Installed** button (when no update), **Enable/Disable** toggle
     (`extension:set-enabled` with `!installed.enabled`; label `Disable` when enabled, `Enable`
     when disabled), **Uninstall** (`.btn.destructive.sm`).
  5. Installed, `installed.status === 'needs-consent'` → primary **Review permissions** replaces
     Install/Update.
  6. Installed, `installed.status === 'errored'` → `.mkt-error` notice with `installed.error`
     above the controls.

  Flows:

```tsx
  async function beginInstall(mode: 'install' | 'update'): Promise<void> {
    if (!row.catalog) return;
    setActionError(null);
    setBusy(true);
    try {
      const ref = `github:${row.catalog.owner}/${row.catalog.repo}`;
      const p = await window.kiagent.invoke('extension:install-preview', { ref });
      if (!('token' in p)) {
        setActionError(p.error);
        return;
      }
      setConsent({ mode, token: p.token, id: p.id, name: p.name, version: p.version,
                   caps: p.caps, sizeBytes: p.sizeBytes, integrity: p.integrity, ref });
    } finally {
      setBusy(false);
    }
  }

  function beginReview(): void {
    if (!installed) return;
    setConsent({ mode: 'review', id: installed.id, name: installed.name,
                 version: installed.version, caps: installed.caps, ref: installed.ref });
  }

  async function confirmConsent(): Promise<void> {
    if (!consent) return;
    const r = consent.mode === 'review'
      ? await window.kiagent.invoke('extension:grant-consent', { id: consent.id })
      : await window.kiagent.invoke('extension:install-commit', { token: consent.token! });
    if (!r.ok) setActionError(r.error ?? 'operation failed');
    setConsent(null);
  }

  async function uninstall(): Promise<void> {
    if (!installed) return;
    setActionError(null);
    setBusy(true);
    try {
      const r = await window.kiagent.invoke('extension:uninstall', { id: installed.id });
      if (!r.ok) setActionError(r.error ?? 'uninstall failed');
    } finally {
      setBusy(false);
    }
  }
```

  Render `<ConsentModal request={consent} onCancel={() => setConsent(null)} onConfirm={confirmConsent} />`
  when `consent` is set. Cancelling an install-mode consent just drops the token (pending
  previews are capped at 8 and evicted FIFO main-side — no cleanup call needed). After a
  successful commit/uninstall/toggle, no manual refetch of installed state: AppState pushes it.
  The update badge (`row.updateAvailable`) does not clear until the next screen mount — accepted
  v1 behavior; do not add a refetch loop.

- [ ] **Step 2: index.tsx + CSS.** Replace the Task-9 placeholder with
  `<Detail key={selectedRow.key} row={selectedRow} />` (the `key` remount resets Detail state on
  selection change — belt and braces with the effect). CSS: `.mkt-right { align-items: stretch;
  justify-content: flex-start; overflow-y: auto; flex-direction: column; }` (replace the
  centered empty-state alignment — move centering onto a `.mkt-right-empty` wrapper used only
  when nothing is selected), `.mkt-actions { display: flex; gap: 8px; flex-wrap: wrap;
  align-items: center; margin: 10px 0; }`, `.mkt-error { border: 1px solid
  var(--border-subtle); border-left: 3px solid #c33; padding: 8px 10px; }`,
  `.mkt-readme { line-height: 1.55; }` plus `.mkt-readme h1/h2/h3/pre/code/img { max-width:
  100%; }` sanity rules, `.mkt-caps { display: flex; flex-direction: column; gap: 6px;
  margin: 8px 0; }`.
- [ ] **Step 3: RTL tests** (`Detail.test.tsx`). Same bridge/app-state mocking pattern as Task 9
  plus `jest.mock('react-markdown', () => (p: { children: string }) => <div data-testid="md">{p.children}</div>)`
  — react-markdown v9 is ESM-only and must be mocked under ts-jest, both here and in any test
  that renders Detail. Cases:
  - catalog row → `marketplace:detail` invoked; README markdown text lands in the pane;
  - Install click → `extension:install-preview` invoked with `github:owner/repo`; ConsentModal
    opens listing the preview caps; Confirm → `extension:install-commit` with the token;
  - preview `{ ok: false, error }` → inline `.mkt-error`, no modal;
  - commit `{ ok: false, error }` → modal closes, inline error shows;
  - `needs-consent` snapshot → **Review permissions** button; clicking opens the modal with the
    SNAPSHOT caps; confirm → `extension:grant-consent` with the id (no preview call);
  - uninstall refusal (`{ ok: false, error: "Remove this connector's sources before uninstalling it." }`)
    renders that exact message;
  - no installable release (latest null / tarballUrl null) → disabled
    **No installable release yet**;
  - enabled toggle calls `extension:set-enabled` with the inverted flag.
- [ ] **Step 4:** `npx jest src/renderer` green ×2 (RTL suites can flake on unawaited updates —
  wrap invoke-settling assertions in `await screen.findBy…`/`waitFor`); `npx tsc --noEmit`
  baseline 6. If tsc newly errors on the `react-markdown` import under the repo's
  moduleResolution, do NOT hack around it with `require` — report BLOCKED with the exact error.

---

### Task 11: Notion v2 — repo scaffold, vendored contract, build + pack pipeline

**Repo:** `~/work/notion-kia-connector`, branch `v2` (created by the controller off `main`).
v1 source stays readable at branch `main` (`git show main:src/client.ts` etc.).

**Files (all in that repo):**
- Rewrite: `package.json`, `tsconfig.json`, `manifest.json`, `README.md`
- Create: `build.mjs`, `src/kiagent-contracts.ts` (vendored), `src/index.ts`, `src/source.ts`
  (walking skeleton), `jest.config.js`
- Delete: ALL v1 `src/*.ts` files and v1 configs not listed above (clean rewrite; git history
  keeps v1)

**Interfaces:**
- Produces: `npm run build` → `dist/index.js` (single CJS bundle); `npm pack` →
  `notion-kia-connector-2.0.0.tgz` whose contents are `package/manifest.json`, `package/dist/`,
  `package/README.md` (the installer's `tar.x strip:1` lands `manifest.json` at the extension
  root); `createNotionSource(host: HostFor<'net'>): Source<NotionCursor, NotionItem>` (skeleton).

- [ ] **Step 1: Vendor the contract.** Copy `kiagent-core`'s `src/shared/contracts.ts` VERBATIM
  to `src/kiagent-contracts.ts` (it is runtime-free — types only — and compiles standalone).
  Header comment: `Vendored snapshot of kiagent-core src/shared/contracts.ts @ <short-sha> —
  the contract IS the SDK (LEFTOVERS #15); do not edit, re-vendor.`
- [ ] **Step 2: manifest.json** — the Global-Constraint-10 literal, byte-for-byte.
- [ ] **Step 3: package.json** (v2 rewrite):

```json
{
  "name": "notion-kia-connector",
  "version": "2.0.0",
  "private": true,
  "description": "Notion connector for KIAgent (new extension platform)",
  "files": ["manifest.json", "dist", "README.md"],
  "scripts": {
    "build": "node build.mjs",
    "test": "jest",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@types/jest": "^29.5.0",
    "esbuild": "^0.24.0",
    "jest": "^29.7.0",
    "ts-jest": "^29.2.0",
    "typescript": "^5.6.0"
  }
}
```

  `jest.config.js`: `module.exports = { testEnvironment: 'node', transform: { '^.+\\.tsx?$': ['ts-jest', { diagnostics: false }] } };`
  `tsconfig.json`: `strict: true`, `module: commonjs`, `target: es2022`, `moduleResolution: node`,
  `types: ["jest", "node"]`, include `src`. `build.mjs`:

```js
import { build } from 'esbuild';
await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: 'dist/index.js',
});
```

- [ ] **Step 4: Walking skeleton.** `src/source.ts`:

```ts
import type { AuthChannel, HostFor, Session, Source } from './kiagent-contracts';

export interface NotionCursor {
  /** High-water mark: newest last_edited_time fully ingested (ISO-8601). */
  lastEditedTime: string | null;
  /** Notion pagination cursor mid-backfill — crash-safe resume point. */
  nextCursor?: string;
}
export interface NotionItem {
  page: { id: string; url?: string; last_edited_time: string; created_time?: string;
          parent?: { type?: string }; properties?: Record<string, unknown> };
  markdown: string;
}

export function createNotionSource(host: HostFor<'net'>): Source<NotionCursor, NotionItem> {
  return {
    descriptor: {
      id: 'notion',
      name: 'Notion',
      documentTypes: ['notion.page'],
      auth: 'password',
      cadence: { every: '30m' },
    },
    async connect(_auth: AuthChannel) {
      throw new Error('not implemented yet');
    },
    // eslint-disable-next-line require-yield
    async *pull(_session: Session, _cursor: NotionCursor | null) {
      throw new Error('not implemented yet');
    },
    toDocument() {
      return null;
    },
  };
}
```

  `src/index.ts` — port the v1 CJS-interop pattern EXACTLY (see `git show main:src/index.ts` in
  this repo for the proven esbuild dual-export lines), with the v2 body:

```ts
import type { ExtensionModule } from './kiagent-contracts';
import { createNotionSource } from './source';

const mod = {
  async activate(host) {
    return { sources: [createNotionSource(host)] };
  },
} satisfies ExtensionModule<'net'>;

export default mod;
```

  The kiagent child loader does `loaded.default ?? loaded` (`extension-host-entry.ts:98-99`),
  so an esbuild-CJS `exports.default` works as-is — only add v1's extra interop lines if v1's
  index actually has them.
- [ ] **Step 5: README.md** — user-facing skeleton (Task 13 finishes it): what it does, setup
  (create an internal integration at notion.so/my-integrations → copy the secret → share the
  pages/databases with the integration → paste the secret in KIAgent's connect flow).
- [ ] **Step 6: Verify the pipeline.**

```bash
npm install && npm run build && npm run typecheck && npm pack
tar -tzf notion-kia-connector-2.0.0.tgz   # expect package/manifest.json, package/dist/index.js, package/README.md
node -e "const m=require('./dist/index.js'); const x=m.default??m; if(typeof x.activate!=='function')process.exit(1)"
```

  All succeed. (No jest tests yet — that's fine; `jest --passWithNoTests` is NOT needed because
  Task 12 lands tests before any CI concern; if `npm test` is run in this task, use
  `npx jest --passWithNoTests`.)

---

### Task 12: Notion v2 — client, block renderer, page markdown (ports from v1)

**Repo:** `~/work/notion-kia-connector` branch `v2`.

**Files:**
- Create: `src/client.ts`, `src/render.ts`, `src/pages.ts`
- Test: `src/__tests__/client.test.ts`, `src/__tests__/render.test.ts`

**Interfaces:**
- Consumes: `HostFor<'net'>['net']['fetch']` — shape
  `(url: string, init?: unknown) => Promise<unknown>` resolving to
  `{ status: number; statusText: string; headers: Record<string, string>; body: Uint8Array }`
  (header keys lowercase). v1 reference: `git show main:src/client.ts`, `main:src/render.ts`,
  `main:src/page-builder.ts` in this repo.
- Produces:

```ts
// client.ts
export type NetFetch = (url: string, init?: unknown) => Promise<unknown>;
export class NotionApiError extends Error {
  constructor(public notionCode: string, public httpStatus: number, message: string);
}
export class NotionClient {
  constructor(deps: { fetch: NetFetch; token: string;
                      sleep?: (ms: number) => Promise<void>; now?: () => number });
  request<T>(method: 'GET' | 'POST', pathname: string, body?: unknown): Promise<T>;
  paginate<T>(pathname: string, body: Record<string, unknown>): AsyncGenerator<T[]>; // POST start_cursor
  paginateGet<T>(pathname: string): AsyncGenerator<T[]>;                             // GET ?start_cursor
}
// render.ts
export function renderBlocks(blocks: NotionBlock[], depth?: number): string;
// pages.ts
export function fetchBlockTree(client: NotionClient, blockId: string): Promise<NotionBlock[]>;
export function buildMarkdown(page: NotionItem['page'], blocks: NotionBlock[]): string;
export function pageTitle(page: NotionItem['page']): string | null;
```

- [ ] **Step 1: `client.ts` port.** From v1 `src/client.ts`, preserving VERBATIM: base
  `https://api.notion.com/v1`, header `notion-version: 2022-06-28`, the 3-rps throttle
  (`MIN_INTERVAL_MS = Math.ceil(1000 / 3)`, sleep-until `lastCallAt + MIN_INTERVAL_MS`), 429
  handling (`retry-after` header, clamp [1, 60] s, default 5 s, ≤ 5 retries), transient
  network/5xx exponential backoff (1 s × 2ⁿ, ≤ 4 retries), `NotionApiError` with 401 pass-through,
  both paginators (`start_cursor`/`has_more`/`next_cursor` POST; `?start_cursor=&page_size=100`
  GET). Deltas:
  1. All I/O through `deps.fetch` (the host surface), NEVER global fetch. Response adapter:

```ts
  interface HostResponse { status: number; statusText: string; headers: Record<string, string>; body: Uint8Array }
  // json = JSON.parse(new TextDecoder().decode(res.body)); retry-after = res.headers['retry-after']
```

  2. Token is a constructor dep (per-pull instance — see Task 13), sent as
     `authorization: Bearer ${token}`.
  3. Injectable `sleep`/`now` (default `setTimeout` promise / `Date.now`) so tests never wait.
  4. DROP from v1: users directory, safeStorage/token blob code, `db` access — v2's client is
     fetch-only.
- [ ] **Step 1.5: Types.** Port the SUBSET of v1 `src/types.ts` these files need (block/rich-text
  shapes for the renderer, plus a search-result page shape) into a new `src/notion-types.ts`:
  `NotionBlock`, `NotionRichText`, and
  `NotionSearchResult = { object: string; id: string; url?: string; archived?: boolean;
  in_trash?: boolean; last_edited_time: string; created_time?: string;
  parent?: { type?: string }; properties?: Record<string, unknown> }` (align `NotionItem['page']`
  in source.ts to reuse it). Drop v1 types that served users/token/account-store.

- [ ] **Step 2: `render.ts` port.** From v1 `src/render.ts`, near-verbatim: `renderRichText`
  (code/bold/italic/strikethrough/link), `renderBlock` switch (headings/bullets/numbered/todos/
  quote/callout/fenced code with language/divider/media `[caption](url)`/equations `$$…$$`/
  container types emitting `''`), `renderBlocks` recursion (blank-line joins, two-space child
  indent, flattened depth for emit-nothing containers), `renderTable` as one contiguous GFM
  block. ONE delta: v1's `@mention` user resolution (injected `resolve` callback) is dropped —
  mention spans render their `plain_text` directly. Also port v1's `fetchBlockTree` (recursive
  `/blocks/{id}/children` GET pagination, no recursion into `child_page`/`child_database`) into
  `pages.ts`, plus v1 `page-builder.ts`'s properties preamble (`**Name:** value` lines for
  non-title properties: rich_text/select/status/multi_select/date/number/checkbox/url/email/
  phone_number; `people` renders names present in the payload — no directory lookups) as
  `buildMarkdown(page, blocks)` = preamble (database rows only, i.e. `parent.type ===
  'database_id'`) + rendered body; and `pageTitle` (v1's title-property extraction).
- [ ] **Step 3: Tests.**
  - `render.test.ts`: port v1's render tests (`git show main:src/__tests__/…` — adapt paths) and
    ensure coverage of: every block type in the switch, GFM table, nested indent, todo states,
    code fence language, mention → plain text.
  - `client.test.ts` (scripted `fetch` fn + recorded `sleep` calls + fake `now`): throttle
    spaces consecutive requests ≥ 334 ms; 429 with `retry-after: 2` sleeps 2000 and retries
    (and clamps `retry-after: 999` → 60 000, missing → 5000); gives up after 5 rate-limit
    retries; 500 backs off 1000/2000/4000/8000 then throws; 401 throws `NotionApiError` with
    `httpStatus === 401`; `paginate` follows `next_cursor` to exhaustion; `paginateGet` builds
    the query string.
- [ ] **Step 4:** `npm test` green; `npm run typecheck` clean; `npm run build` still succeeds.

---

### Task 13: Notion v2 — connect / pull / reconcile, toDocument, pack

**Repo:** `~/work/notion-kia-connector` branch `v2`.

**Files:**
- Modify: `src/source.ts` (replace the skeleton)
- Test: `src/__tests__/source.test.ts`
- Modify: `README.md` (finish)

**Interfaces:**
- Consumes: Tasks 11–12. Engine facts (kiagent-core side): `session.credentials()` returns the
  vaulted `Credentials` whose `password` field the engine captured from `auth.prompt` answers
  (`engine.ts:320-321`); the engine re-runs `pull` on the descriptor cadence after it returns;
  `reconcile` runs once per engine cycle concurrently with pull (TOCTOU-guarded).
- Produces: the finished `Source<NotionCursor, NotionItem>`.

- [ ] **Step 1: `connect(auth)`** — prompt schema follows the imap precedent
  (`kiagent-core src/main/sources/imap/source.ts:94-104`); the field key MUST be `password`
  (that is what the engine vaults):

```ts
    async connect(auth) {
      const answers = await auth.prompt({
        type: 'object',
        required: ['password'],
        properties: {
          password: { type: 'string', title: 'Internal Integration Secret', format: 'password' },
        },
      });
      const token = typeof answers.password === 'string' ? answers.password.trim() : '';
      if (!/^(ntn_|secret_)/.test(token)) {
        throw new Error('that does not look like a Notion internal integration secret (ntn_… or secret_…)');
      }
      const client = new NotionClient({ fetch: host.net.fetch, token });
      const me = await client.request<{ name?: string; bot?: { workspace_name?: string } }>('GET', '/users/me');
      return { identifier: me.bot?.workspace_name ?? me.name ?? 'notion', config: {} };
    },
```

- [ ] **Step 2: `pull(session, cursor)`.** Token helper first:

```ts
  async function requireToken(session: Session): Promise<string> {
    const creds = await session.credentials();
    const token = creds?.password;
    if (!token) throw new Error('no Notion credentials — reconnect the account');
    return token;
  }
```

  Dispatch: `cursor === null || cursor.lastEditedTime === null || cursor.nextCursor` → backfill;
  otherwise → delta.

  **Backfill (ascending — resumable):** POST `/search` body
  `{ filter: { property: 'object', value: 'page' }, sort: { direction: 'ascending',
  timestamp: 'last_edited_time' }, page_size: 100, start_cursor: cursor?.nextCursor }` —
  hand-page (NOT via `paginate`) because each search page must yield a batch carrying the NEXT
  `start_cursor`. Per search page: skip `archived`/`in_trash` results; for each page, abort-check
  `session.signal`, `fetchBlockTree` + `buildMarkdown` → item; track
  `maxEdited = max(last_edited_time)`; then
  `yield { phase: 'backfill', items, cursor: { lastEditedTime: maxEdited, nextCursor: next ?? undefined } }`.
  (A crash mid-search-page resumes AT that page and re-ingests it — upserts are idempotent by
  externalId.) When `has_more` is false: yield a final
  `{ phase: 'live', items: [], cursor: { lastEditedTime: maxEdited ?? new Date(0).toISOString() } }`
  (v1's zero-page floor trick — delta must never see a null cursor) and return.

  **Delta (descending, floor-break — v1's proven shape; deliberate refinement of spec §6's
  "ascending", which governs backfill only; Task 14 updates the spec wording):**
  `floorMs = Date.parse(lastEditedTime) - 60_000` (Notion rounds `last_edited_time` to the
  minute — v1's `OVERLAP_MS`). Page `/search` DESCENDING; collect non-trashed pages until an
  item's `last_edited_time <= floorMs` (labeled break out of both loops, v1 `delta.ts`);
  non-page/trashed items still advance a `maxEdited` tracker but are not ingested. Process the
  collected pages OLDEST-FIRST (reverse), fetch blocks → items, and yield in slices of 20:
  `{ phase: 'live', items: slice, cursor: { lastEditedTime: <max last_edited_time in-or-before this slice> } }`
  so the cursor only ever covers fully-ingested pages. Nothing new → return without yielding.

- [ ] **Step 3: `toDocument(item)`** — PURE (spec §6 field mapping, `createdAt` =
  `last_edited_time` as specced):

```ts
    toDocument({ page, markdown }) {
      return {
        externalId: page.id,
        type: 'notion.page',
        title: pageTitle(page),
        markdown,
        url: page.url,
        metadata: {
          parentType: page.parent?.type,
          lastEditedTime: page.last_edited_time,
          createdTime: page.created_time,
        },
        createdAt: page.last_edited_time,
      };
    },
```

- [ ] **Step 4: `reconcile(session)`** — full live listing, one ref page per search page:

```ts
    async *reconcile(session) {
      const token = await requireToken(session);
      const client = new NotionClient({ fetch: host.net.fetch, token });
      for await (const results of client.paginate<NotionSearchResult>('/search', {
        filter: { property: 'object', value: 'page' },
        page_size: 100,
      })) {
        if (session.signal.aborted) return;
        yield results
          .filter((p) => !p.archived && !p.in_trash)
          .map((p) => ({ externalId: p.id, type: 'notion.page' }));
      }
    },
```

- [ ] **Step 5: Tests** (`source.test.ts`, scripted `host.net.fetch` keyed on URL+body — build a
  tiny helper that records calls and pops queued responses; JSON bodies encoded to `Uint8Array`):
  - connect: prompt schema has the `password` key + `format: 'password'`; bad token rejected
    BEFORE any fetch; good token hits `/users/me` and returns the workspace name identifier.
  - backfill: 2 search pages (has_more true → false) yield 2 backfill batches with
    `nextCursor` then a final live flip batch; cursor high-water = max last_edited_time;
    archived/in_trash results skipped; resume from `{ lastEditedTime, nextCursor }` starts AT
    that search cursor.
  - delta: given stored `lastEditedTime`, a descending page whose tail is older than
    floor − 60 s stops paging; newer pages are ingested oldest-first; cursor advances to the
    newest ingested; nothing-new yields no batches.
  - reconcile: yields externalId refs, skipping trashed.
  - toDocument: exact field mapping (pure — no client involved).
  - pull without vaulted password → throws `/reconnect the account/`.
- [ ] **Step 6: Finish README.md** (install from KIAgent marketplace, integration setup steps,
  what gets indexed, the 30-minute cadence, privacy note: data flows only between Notion's API
  and the local index via the platform's `net` capability). Rebuild + repack:
  `npm test && npm run typecheck && npm run build && npm pack` all green.

---

### Task 14: Publish v2.0.0 + real-org verification + docs (CONTROLLER-LED — no subagent)

- [ ] **Step 1: Notion release.** In `~/work/notion-kia-connector`: merge `v2` → `main`
  (ff or merge commit), push, then
  `gh release create v2.0.0 notion-kia-connector-2.0.0.tgz --title "v2.0.0 — KIAgent extension platform" --notes "<notes: rewritten against the new extension contract; requires the new KIAgent build; v1.x remains for the legacy app>"`.
  Confirm topic `kia-plugin` still on the repo.
- [ ] **Step 2: Real-org smoke** (kiagent-core, scratch script — not committed): create
  `createGitHubCache` (temp cacheFile) + `createGitHubSource`; assert `listOrgPlugins()` lists
  the 4 repos; `resolveGitHubRef('github:kia-plugins/notion-kia-connector')` → version `2.0.0` +
  tag `v2.0.0`; `downloadAsset` + `createInstaller` (temp extDir, the Task-7 download closure
  inlined) `preview('github:kia-plugins/notion-kia-connector')` → ok, caps `['net']`,
  integrity pinned; `preview('github:kia-plugins/slack-kia-connector')` → rejects with the
  legacy-format error (Global Constraint 9). Then the app-level manual walkthrough is owed to
  the human: browse → install Notion → paste a real token → watch a workspace sync (real
  credentials are the human's to enter; never script them).
- [ ] **Step 3: Docs.**
  - `docs/rebuild/LEFTOVERS.md` #1: marketplace + Notion shipped (runtime AND catalog/UI);
    #16: Marketplace screen no longer inert.
  - `concept/gaps.md` #20: note the consent UI + catalog landed.
  - Spec `2026-07-03-extension-marketplace-design.md`: §4.3 add the `extension:grant-consent`
    row; §6 delta-direction wording (ascending backfill / descending floor-break delta, vendored
    contract at `src/kiagent-contracts.ts`); §5 note `Added by you` filter dropped (three pills).
  - `TODO.md`: tick the marketplace line if present.
- [ ] **Step 4:** Full `npx jest` ×2 green, `npx tsc --noEmit` baseline 6, ledger + memory
  updates, commits, final whole-branch review per SDD.

---

## Execution protocol (SDD controller notes)

- Wave schedule (disjoint files): **W0** T1, T2, T3, T8, T11 · **W1** T4, T5, T12 · **W2** T6,
  T13 · **W3** T7 · **W4** T9 · **W5** T10 · **W6** T14. `installer.ts` is touched by T2 then
  T5; `extension-platform.ts` by T5 then T6; `ipc.ts`/`main.ts` by T6 then T7;
  `Marketplace/index.tsx` by T9 then T10 — never in the same wave.
- Parallel-wave protocol (Plan A precedent): implementers leave work UNCOMMITTED, run only their
  own test file + `npx tsc --noEmit`, run NO git commands; the controller commits per task with
  explicit paths. Notion-repo tasks follow the same rule inside `~/work/notion-kia-connector`
  (controller creates branch `v2` before W0 and commits there).
- Every subagent dispatch includes: "NEVER print, quote, or modify
  `src/main/sources/gmail/client-credentials.ts`."
- T14 is controller-led: publishing to GitHub is an outward-facing action (pre-authorized by the
  user's Plan-B decisions) and must not be delegated.
