# Large-File Indexing: OneDrive + Google Drive Connectors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** OneDrive and Google Drive files over the 25 MiB eager cap get a findable, metadata-only row (never downloaded at ingest), and existing accounts re-enumerate once so files the old policy ignored come back without user action.

**Architecture:**
- Both connectors already route every file through the SDK's verbatim `decideFileIndexing` (`chooseRoute`). The binary route now carries the policy's `bytes` field.
- `bytes !== 'eager'` produces the metadata-only item shape each connector already has, with `extraction_status` set to the `bytes` value (`'deferred'` / `'none'`), no download and `markdown: ''`. Core's convert worker fetches `deferred` rows later through `fetchBytes`, which refuses `none`.
- `hashSkip` pins a row when the stored `extraction_status` equals the status the current route would write. One rule covers `ok`, `deferred` and `none`, and a later policy change that alters the route re-fetches automatically.
- Each cursor gains `policy_version`. It is stamped at each connector's single existing stamping site, and a stale value triggers exactly one re-enumeration.

**Tech Stack:** TypeScript, jest + ts-jest, esbuild, `@kiagent/connector-sdk` (GitHub-release tgz).

**Spec:** `docs/superpowers/specs/2026-10-02-large-file-indexing-design.md` (r4): §1 "Connectors", §5 recovery table, §6 OneDrive/gdrive, Rollout step 3. The core plan `docs/superpowers/plans/2026-10-02-large-file-indexing.md` (P1) produces the policy and SDK this plan consumes.

## Global Constraints

- The policy is never re-implemented in a connector. `bytes`, `MAX_FETCH_BYTES` and `FILE_POLICY_VERSION` come from `@kiagent/connector-sdk`.
- `extraction_status` values written by these connectors: `'ok'` (eager, downloaded), `'deferred'`, `'none'`, `'failed'`. gdrive keeps reading its legacy `'unsupported'`/`'too-large'` values but never writes them.
- Cursors without `policy_version` count as version 1.
- Media stays `ignore: too-large`: cloud images > 20 MiB, and all cloud audio/video. Only documents gain metadata-only rows.
- Release order (spec Rollout): core release with SDK → alpha-cent pin + app release → **then** these connector releases. The connectors keep `engine: "^2.0.0"`: an old core given a metadata-only PDF just records `too-large`, and the core v2 convert-worker replay later re-admits it.
- Plugin releases: `manifest.json` version bumps only in the release commit. Plugin repos have no prepack hook (`npm pack` ships disk state). Release order: bump commit → `npm run build` → `npm test` → `npm pack` → push → `gh release`.
- Commits: no `Co-Authored-By` line, never `--no-verify`, never amend.
- Builds and tests run sequentially, one repo at a time.

## Setup (once, after P1 Task 1 is committed in core)

```bash
# Build an SDK tarball from the core worktree that carries P1 Task 1.
cd ~/work/kcore-indexing-specs/sdk/connector-sdk
npm run build && npm pack --pack-destination "$TMPDIR"
ls "$TMPDIR"/kiagent-connector-sdk-*.tgz      # e.g. kiagent-connector-sdk-1.8.0.tgz (P1 bumps the version)

cd ~/work/onedrive-kia-connector && git switch -c feat/large-files
cd ~/work/google-docs-kia-connector && git switch -c feat/large-files
```

During development each connector installs that local tarball. Task 5 swaps it for the released URL; never release with a `file:` dependency.

## Review Focus

1. **A 60 MiB PDF that was already converted, then seen again with an unchanged eTag/md5.** It must stay pinned by `hashSkip`: re-emitting `markdown: ''` would discard the worker's converted text. Owned by Tasks 2 and 3.
2. **An upgraded OneDrive account whose app was closed for days.** The re-enumeration must not lose the deletions the old delta token would have reported (OneDrive has no reconcile pass). Owned by Task 2b.
3. **An unknown-size PDF that turns out to be 40 MiB after download.** It becomes a `deferred` item without bytes, not an ignore plus deletion. Owned by Tasks 2 and 3.
4. **A 30 MiB PNG.** It is still ignored, and a pre-existing row is still archived. Owned by Tasks 2 and 3.
5. **A crash mid-re-enumeration.** The resumed walk continues; it never restarts from scratch forever, and never skips the rest. Owned by Tasks 2b and 3b.

---

### Task 1: Move both connectors onto the new SDK (no behaviour change)

**Files (each repo):**
- Modify: `package.json`, `package-lock.json`
- Modify: `src/testing/harness.ts` (`fakeDoc`)

The SDK's `Document` type made `ingestSeq` required after 1.3.0. Both repos' `fakeDoc` fails `tsc` on it; this was verified against sdk-v1.7.0 on 2026-10-02, and all jest suites still passed.

- [ ] **Step 1: Install the local tarball (OneDrive first)**

```bash
cd ~/work/onedrive-kia-connector
npm i -D "$TMPDIR"/kiagent-connector-sdk-1.8.0.tgz
```

- [ ] **Step 2: Fix the fixture type**

In `src/testing/harness.ts` `fakeDoc`, add `ingestSeq: 1,` next to `seq: 1,`.

- [ ] **Step 3: Gates**

Run: `npx tsc --noEmit && npx jest`
Expected: clean typecheck. All suites pass except the policy-dependent cases that Task 2 rewrites (the oversized-PDF ingest tests in `ingest.test.ts`). Note which ones fail; nothing else may.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src/testing/harness.ts
git commit -m "chore: connector SDK with the bytes-aware file policy (local tgz)"
```

- [ ] **Step 5: Repeat Steps 1–4 in `~/work/google-docs-kia-connector`** (its `fakeDoc` is at `src/testing/harness.ts:354`).

---

### Task 2: OneDrive: `bytes`-aware routing and metadata-only items

**Files:**
- Modify: `src/mime-route.ts`
- Modify: `src/source.ts` (`OneDriveItem.extractionStatus`, `hashSkip`, `failedItem` → `metadataItem`, `buildItem`, `pageChunks`, `fetchBytes`)
- Test: `src/__tests__/ingest.test.ts`

**Interfaces:**
- Consumes: SDK `decideFileIndexing` → `{ kind:'index'; pipeline; bytes:'eager'|'deferred'|'none' }`.
- Produces:
  - `OneDriveRoute = { kind:'binary'; pipeline:'converter'|'vision'; bytes:'eager'|'deferred'|'none' } | { kind:'ignore'; reason }`
  - `OneDriveItem.extractionStatus: 'ok'|'deferred'|'none'|'failed'`
  - `statusFor(route): 'ok'|'deferred'|'none'`

- [ ] **Step 1: Rewrite the oversized-PDF tests and add new ones (failing)**

In `ingest.test.ts`, replace the five size-cap tests:
- "skips all content I/O for a declared-too-large file";
- "the declared-size cap is inclusive";
- "downloads, then drops, an unknown-declared-size file";
- "post-download-oversize … archived via exactly one deletion";
- "post-download-oversize does NOT emit a deletion".

Use the following. `MAX_FETCH_BYTES` is imported from `@kiagent/connector-sdk`.

```ts
import { MAX_FETCH_BYTES } from '@kiagent/connector-sdk';
const MiB = 1024 * 1024;
const one = (id: string, name: string, over = {}) => ({
  [deltaUrl('FA')]: { value: [driveFile(id, name, over)], '@odata.deltaLink': finalLink('FA', 'TOK1') },
});

it('a 60 MiB PDF becomes a metadata-only deferred item: no item-GET, no download', async () => {
  const { source, calls } = makeSource({ deltaPages: one('big', 'big.pdf', { size: 60 * MiB }) });
  const { session } = makeSession({ config: oneRoot });
  const items = ((await collect(source.pull(session, null))) as B[]).flatMap((b) => b.items);
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({ markdown: '', extractionStatus: 'deferred' });
  expect(items[0].bytes).toBeUndefined();
  expect(source.toDocument(items[0]).metadata).toMatchObject({
    extraction_status: 'deferred', mime: 'application/pdf', filename: 'big.pdf', sizeBytes: 60 * MiB,
  });
  expect(calls.some((u) => u.includes('download.example'))).toBe(false);
  expect(calls.some((u) => u.includes('/me/drive/items/big') && !u.includes('/delta'))).toBe(false);
});

it('the eager cap is inclusive: size === cap downloads, cap+1 is deferred', async () => {
  const { source } = makeSource({
    deltaPages: { [deltaUrl('FA')]: { value: [
      driveFile('atcap', 'exact.pdf', { size: MAX_BINARY_BYTES }),
      driveFile('overcap', 'over.pdf', { size: MAX_BINARY_BYTES + 1 }),
    ], '@odata.deltaLink': finalLink('FA', 'TOK1') } },
    downloads: { 'https://download.example/atcap': new Uint8Array([1]) },
  });
  const { session } = makeSession({ config: oneRoot });
  const items = ((await collect(source.pull(session, null))) as B[]).flatMap((b) => b.items);
  expect(items.map((i) => [i.file.id, i.extractionStatus])).toEqual([['atcap', 'ok'], ['overcap', 'deferred']]);
});

it('a PDF over MAX_FETCH_BYTES and a 30 MiB docx are metadata-only "none" items', async () => {
  const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const { source } = makeSource({
    deltaPages: { [deltaUrl('FA')]: { value: [
      driveFile('huge', 'huge.pdf', { size: MAX_FETCH_BYTES + 1 }),
      driveFile('doc', 'big.docx', { size: 30 * MiB, file: { mimeType: DOCX } }),
    ], '@odata.deltaLink': finalLink('FA', 'TOK1') } },
  });
  const { session } = makeSession({ config: oneRoot });
  const items = ((await collect(source.pull(session, null))) as B[]).flatMap((b) => b.items);
  expect(items.map((i) => [i.file.id, i.extractionStatus])).toEqual([['huge', 'none'], ['doc', 'none']]);
});

it('a 30 MiB PNG is still ignored, and its pre-existing live row is archived', async () => {
  const query = fakeQuery([fakeDoc('img', 'file', { etag: 'old', extraction_status: 'ok' })]);
  const { source } = makeSource({ deltaPages: one('img', 'big.png', { size: 30 * MiB, file: { mimeType: 'image/png' } }) }, query);
  const { session } = makeSession({ config: oneRoot });
  const batches = (await collect(source.pull(session, null))) as B[];
  expect(batches.flatMap((b) => b.items)).toEqual([]);
  expect(batches.flatMap((b) => b.deletions ?? [])).toEqual([{ externalId: 'img', type: 'file' }]);
});

it('unknown declared size, 40 MiB after download → deferred item without bytes, no deletion', async () => {
  const query = fakeQuery([fakeDoc('ns', 'file', { etag: 'etag-OLD', extraction_status: 'ok' })]);
  const { source } = makeSource({
    deltaPages: one('ns', 'n.pdf', { size: undefined }),
    downloads: { 'https://download.example/ns': new Uint8Array(40 * MiB) },
  }, query);
  const { session } = makeSession({ config: oneRoot });
  const batches = (await collect(source.pull(session, null))) as B[];
  const items = batches.flatMap((b) => b.items);
  expect(items.map((i) => i.extractionStatus)).toEqual(['deferred']);
  expect(items[0].bytes).toBeUndefined();
  expect(batches.flatMap((b) => b.deletions ?? [])).toEqual([]);
});

it('unknown declared size, 30 MiB PNG after download → still ignored + archived', async () => {
  const query = fakeQuery([fakeDoc('ni', 'file', { etag: 'etag-OLD', extraction_status: 'ok' })]);
  const { source } = makeSource({
    deltaPages: one('ni', 'n.png', { size: undefined, file: { mimeType: 'image/png' } }),
    downloads: { 'https://download.example/ni': new Uint8Array(30 * MiB) },
  }, query);
  const { session } = makeSession({ config: oneRoot });
  const batches = (await collect(source.pull(session, null))) as B[];
  expect(batches.flatMap((b) => b.items)).toEqual([]);
  expect(batches.flatMap((b) => b.deletions ?? [])).toEqual([{ externalId: 'ni', type: 'file' }]);
});

it('hash-skip pins a deferred row whose eTag is unchanged (keeps the worker-converted text)', async () => {
  const query = fakeQuery([fakeDoc('big', 'file', { etag: 'etag-big-1', extraction_status: 'deferred' })]);
  const { source } = makeSource({ deltaPages: one('big', 'big.pdf', { size: 60 * MiB }) }, query);
  const { session } = makeSession({ config: oneRoot });
  expect(((await collect(source.pull(session, null))) as B[]).flatMap(ids)).toEqual([]);
});

it('hash-skip does NOT pin when the route changed (stored deferred, now eager after a shrink)', async () => {
  const query = fakeQuery([fakeDoc('f', 'file', { etag: 'etag-f-1', extraction_status: 'deferred' })]);
  const { source } = makeSource({
    deltaPages: one('f', 'f.pdf', { size: 1000 }),
    downloads: { 'https://download.example/f': new Uint8Array([1]) },
  }, query);
  const { session } = makeSession({ config: oneRoot });
  expect(((await collect(source.pull(session, null))) as B[]).flatMap((b) => b.items).map((i) => i.extractionStatus)).toEqual(['ok']);
});
```

In the `fetchBytes` tests (grep `fetchBytes` in `src/__tests__/`, or add to `document.test.ts`):

```ts
it('fetchBytes serves a deferred 60 MiB PDF and refuses a "none" one without any network call', async () => {
  const { fetchFn, calls } = graphFetch({
    gets: { big: { '@microsoft.graph.downloadUrl': 'https://download.example/big' } },
    downloads: { 'https://download.example/big': new Uint8Array([7]) },
  });
  const source = createOneDriveSource(makeHost(fetchFn, fakeQuery()), instantClock);
  const { session } = makeSession({ config: oneRoot });
  const doc = (id: string, size: number) => fakeDoc(id, 'file',
    { drive_item_id: id, mime_type: 'application/pdf', filename: `${id}.pdf`, size_bytes: size });
  expect(await source.fetchBytes!(session, doc('big', 60 * MiB))).toEqual(new Uint8Array([7]));
  const before = calls.length;
  expect(await source.fetchBytes!(session, doc('huge', MAX_FETCH_BYTES + 1))).toBeNull();
  expect(calls.length).toBe(before);
});
```

Check the `graphFetch` world key for item GETs in `src/testing/harness.ts`, and match it (the existing "refreshes the downloadUrl" test shows the shape).

- [ ] **Step 2: Run, and confirm they fail**

Run: `npx jest src/__tests__/ingest.test.ts src/__tests__/document.test.ts`
Expected: FAIL. Oversized PDFs are dropped today, and `extractionStatus` has no `'deferred'`.

- [ ] **Step 3: Implement**

`src/mime-route.ts`: carry the policy's `bytes` through, and refresh the module doc's cap paragraph: "Documents over the eager cap still get a row (`bytes: 'deferred' | 'none'`); only media is `too-large`."

```ts
export type OneDriveRoute =
  | { kind: 'binary'; pipeline: 'converter' | 'vision'; bytes: 'eager' | 'deferred' | 'none' }
  | { kind: 'ignore'; reason: FileIgnoreReason };

export function chooseRoute(mimeType: string, filename: string, sizeBytes?: number): OneDriveRoute {
  const d = decideFileIndexing({ profile: 'cloud-drive', filename, mime: mimeType, sizeBytes });
  return d.kind === 'ignore'
    ? d
    : { kind: 'binary', pipeline: d.pipeline === 'vision' ? 'vision' : 'converter', bytes: d.bytes };
}

/** The `extraction_status` a row built from this route carries. */
export function statusFor(route: Extract<OneDriveRoute, { kind: 'binary' }>): 'ok' | 'deferred' | 'none' {
  return route.bytes === 'eager' ? 'ok' : route.bytes;
}
```

`src/source.ts`:

1. `OneDriveItem.extractionStatus: 'ok' | 'deferred' | 'none' | 'failed';`. Update its doc comment: deferred/none are metadata-only rows for documents over the eager cap.
2. `hashSkip(deps, itemId, etag, want: 'ok' | 'deferred' | 'none')`: replace `if (meta.extraction_status !== 'ok') return false;` with `if (meta.extraction_status !== want) return false;`. Rewrite the doc comment: "pins only a row whose stored status is the one the current route would write; `'failed'`, legacy `'unsupported'`/`'too-large'`, and any route change re-fetch".
3. Rename `failedItem` to `metadataItem(raw, status, displayPath, rootFolderId)` returning `{ file: raw, markdown: '', extractionStatus: status, displayPath, rootFolderId }`. Update its one caller to pass `'failed'`.
4. `buildItem(raw, root, route, deps, deletions)` takes the pre-check route from `pageChunks`:

```ts
const want = statusFor(route);
if (await hashSkip(deps, raw.id, raw.eTag, want)) return null;
if (route.bytes !== 'eager') return metadataItem(raw, route.bytes, displayPath, root.rootFolderId);
// …existing downloadUrl refresh + download unchanged…
const postRoute = chooseRoute(mime, raw.name, bytes.byteLength);
if (postRoute.kind === 'ignore') { /* existing ignore + deletion branch, unchanged */ }
if (postRoute.bytes !== 'eager') {
  // Unknown declared size, oversized document: keep the row, drop the bytes.
  return metadataItem(raw, postRoute.bytes, displayPath, root.rootFolderId);
}
return { file: raw, markdown: null, bytes, extractionStatus: 'ok', displayPath, rootFolderId: root.rootFolderId };
```

5. `pageChunks`: pass `route` into `buildItem(raw, root, route, deps, deletions)`.
6. `fetchBytes`: replace `if (chooseRoute(mime, filename, size).kind === 'ignore') return null;` with:

```ts
const route = chooseRoute(mime, filename, size);
if (route.kind === 'ignore' || route.bytes === 'none') return null;
```

The module doc for `fetchBytes` gains: "`deferred` rows are served (core's convert worker fetches them under `MAX_FETCH_BYTES`); `none` rows never are".

- [ ] **Step 4: Run, and confirm they pass**

Run: `npx tsc --noEmit && npx jest`
Expected: PASS, all suites.

- [ ] **Step 5: Commit**

```bash
git add src/mime-route.ts src/source.ts src/__tests__/
git commit -m "feat: metadata-only rows for documents over the eager cap"
```

---

### Task 2b: OneDrive: `policy_version` re-enumeration

**Files:**
- Modify: `src/source.ts` (`OneDriveCursor`, `pull`)
- Test: `src/__tests__/delta.test.ts`, plus cursor literals across `src/__tests__/`

**Interfaces:**
- Consumes: SDK `FILE_POLICY_VERSION`.
- Produces: `OneDriveCursor.policy_version?: number`.

**Design.** A stale cursor (`(policy_version ?? 1) < FILE_POLICY_VERSION`) does two things in the same `pull`:
1. If the normalized cursor is live (`backfillDone`), it first drains one ordinary `delta()` with the **old** version stamped. This catches up deletions the old tokens would report; OneDrive has no reconcile, so a fresh enumeration can never report them.
2. It then runs `backfill()` from a null cursor (a delta from scratch, as ms365 2.2.0's `attachments:1` did), stamped with the **new** version.

A crash during step 1 replays step 1. A crash during step 2 resumes the backfill, since its `backfill` state is in a cursor already carrying the new version. `hashSkip` makes re-seen files free, apart from the listing.

- [ ] **Step 1: Failing tests**

```ts
import { FILE_POLICY_VERSION } from '@kiagent/connector-sdk';

it('an old cursor without policy_version catches up deletions, then re-enumerates from scratch once', async () => {
  const query = fakeQuery([
    fakeDoc('gone', 'file', { etag: 'e', extraction_status: 'ok' }),
    fakeDoc('kept', 'file', { etag: 'etag-kept-1', extraction_status: 'ok' }),
  ]);
  const { source, calls } = makeSource({
    deltaPages: {
      // old token: reports the deletion
      [`${GRAPH_BASE}/me/drive/items/FA/delta?token=OLD`]: {
        value: [{ id: 'gone', name: 'g.pdf', deleted: { state: 'deleted' } }],
        '@odata.deltaLink': finalLink('FA', 'OLD2'),
      },
      // from scratch: an already-indexed file (hash-skipped) + a 60 MiB PDF the old policy ignored
      [deltaUrl('FA')]: {
        value: [driveFile('kept', 'k.pdf'), driveFile('big', 'big.pdf', { size: 60 * 1024 * 1024 })],
        '@odata.deltaLink': finalLink('FA', 'NEW'),
      },
    },
  }, query);
  const { session } = makeSession({ config: oneRoot });
  const old = { delta_tokens: { FA: 'OLD' }, scope_roots: ['FA'] };

  const batches = (await collect(source.pull(session, old))) as B[];

  expect(batches.flatMap((b) => b.deletions ?? [])).toEqual([{ externalId: 'gone', type: 'file' }]);
  expect(batches.flatMap(ids)).toEqual(['big']);
  expect(calls.some((u) => u.includes('download.example'))).toBe(false);
  expect(batches.at(-1)!.cursor).toEqual({ delta_tokens: { FA: 'NEW' }, scope_roots: ['FA'], policy_version: FILE_POLICY_VERSION });
  // catch-up batches still carry the old version: a crash there replays the catch-up
  const firstBackfill = batches.findIndex((b) => b.cursor.backfill);
  expect(batches.slice(0, firstBackfill).every((b) => (b.cursor.policy_version ?? 1) === 1)).toBe(true);
});

it('a current cursor polls delta normally (no re-enumeration)', async () => {
  const { source, calls } = makeSource({ deltaPages: {
    [`${GRAPH_BASE}/me/drive/items/FA/delta?token=T`]: { value: [], '@odata.deltaLink': finalLink('FA', 'T2') },
  } });
  const { session } = makeSession({ config: oneRoot });
  await collect(source.pull(session, { delta_tokens: { FA: 'T' }, scope_roots: ['FA'], policy_version: FILE_POLICY_VERSION }));
  expect(calls.some((u) => u === deltaUrl('FA'))).toBe(false);
});

it('a crash mid re-enumeration resumes the backfill, not the catch-up', async () => {
  // cursor as stamped by a backfill batch of the re-walk
  const mid = { delta_tokens: {}, scope_roots: ['FA'], policy_version: FILE_POLICY_VERSION,
                backfill: { root_index: 0, next_link: `${deltaUrl('FA')}&page=2` } };
  const { source, calls } = makeSource({ deltaPages: {
    [`${deltaUrl('FA')}&page=2`]: { value: [], '@odata.deltaLink': finalLink('FA', 'NEW') },
  } });
  const { session } = makeSession({ config: oneRoot });
  await collect(source.pull(session, mid));
  expect(calls.filter((u) => u.includes('/delta'))).toEqual([`${deltaUrl('FA')}&page=2`]);
});
```

Match `deltaUrl`/`next_link` spelling to `src/testing/harness.ts` and the existing backfill-resume test in `batch-budget.test.ts` (`:219`).

- [ ] **Step 2: Run, and confirm they fail**

Run: `npx jest src/__tests__/delta.test.ts`
Expected: FAIL (no re-enumeration, no `policy_version`).

- [ ] **Step 3: Implement**

`OneDriveCursor` gains:

```ts
/** `FILE_POLICY_VERSION` this cursor's coverage was enumerated under. ABSENT
 *  = 1. A stale value triggers one delta-from-scratch re-enumeration so
 *  files the old policy ignored get rows (`pull`). */
policy_version?: number;
```

`pull`, replacing the walk selection and the stamping loop:

```ts
async *pull(session: Session, cursor: OneDriveCursor | null) {
  const client = clientFor(session);
  const roots = rootsConfig(session);
  const scopeRoots = roots.map((r) => r.rootFolderId);
  const start = normalizeCursor(cursor, roots);
  const processed = new Set<string>();
  const fromVersion = cursor?.policy_version ?? 1;
  const stale = cursor != null && fromVersion < FILE_POLICY_VERSION;
  // ONE stamping site (see the seven internal cursor literals note) — now
  // stamping scope_roots AND policy_version.
  const stamp = async function* (walk: AsyncGenerator<Batch<OneDriveCursor, OneDriveItem>>, version: number) {
    for await (const batch of walk) {
      yield { ...batch, cursor: { ...batch.cursor, scope_roots: scopeRoots, policy_version: version } };
    }
  };
  if (stale) {
    // Catch up what the OLD tokens know (deletions above all — OneDrive has no
    // reconcile, and a from-scratch enumeration never reports them), then
    // re-enumerate under the new policy. Each phase is resumable on its own.
    if (backfillDone(start, roots)) {
      yield* stamp(delta(client, session, host.query, host.net.fetch, start!, roots, processed, budget), fromVersion);
      processed.clear();
    }
    yield* stamp(backfill(client, session, host.query, host.net.fetch, null, roots, processed, budget), FILE_POLICY_VERSION);
    return;
  }
  const walk = !backfillDone(start, roots)
    ? backfill(client, session, host.query, host.net.fetch, start, roots, processed, budget)
    : delta(client, session, host.query, host.net.fetch, start!, roots, processed, budget);
  yield* stamp(walk, FILE_POLICY_VERSION);
}
```

A stale cursor that is mid-backfill (`!backfillDone`) skips the catch-up: its tokens are incomplete anyway. It restarts as a fresh backfill, which is the same cost as the ongoing one.

Add `policy_version: FILE_POLICY_VERSION` to every cursor literal that test expectations compare with `toEqual`, and to every cursor **input** that represents a live, current account. Run `grep -n "scope_roots" src/__tests__/*.ts` to find them all. Inputs that deliberately model a pre-upgrade cursor keep no version.

- [ ] **Step 4: Run, and confirm everything passes**

Run: `npx tsc --noEmit && npx jest`
Expected: PASS, all suites.

- [ ] **Step 5: Commit**

```bash
git add src/source.ts src/__tests__/
git commit -m "feat: one-time re-enumeration when the file policy version changes"
```

---

### Task 3: gdrive: `bytes`-aware routing and metadata-only items

**Files:**
- Modify: `src/export-map.ts`, `src/source.ts` (`DriveItem.extractionStatus`, `hashSkip`, `metadataOnly`, `buildItem`, `fetchBytes`)
- Test: `src/__tests__/backfill.test.ts`, `src/__tests__/reconcile-and-document.test.ts`

**Interfaces:**
- Produces:
  - `DriveRoute` binary arm gains `bytes`
  - `statusFor(route)`, same as OneDrive
  - `DriveItem.extractionStatus: 'ok'|'deferred'|'none'|'unsupported'|'too-large'|'failed'` (the last three stay for legacy reads; `'unsupported'` and `'too-large'` are no longer written)

- [ ] **Step 1: Failing tests**

In `backfill.test.ts`, find the existing "routing (unsupported / too-large)" cases that expect an oversized PDF to be ignored (grep `MAX_BINARY_BYTES`). Change them to use an **image** over `MAX_CLOUD_IMAGE_BYTES` for the ignore expectation, and add:

```ts
import { MAX_FETCH_BYTES } from '@kiagent/connector-sdk';
const MiB = 1024 * 1024;

it('a 60 MiB PDF is a metadata-only deferred item with no media download', async () => {
  const { source, calls } = makeSource({
    startPageToken: 'spt-1',
    lists: { root: [pdf('big', 'big.pdf', { size: String(60 * MiB) })] },
  });
  const { session } = makeSession();
  const items = ((await collect(source.pull(session, null))) as B[]).flatMap((b) => b.items);
  expect(items.map((i) => [i.file.id, i.extractionStatus, i.markdown])).toEqual([['big', 'deferred', '']]);
  expect(calls.some((u) => u.includes('alt=media'))).toBe(false);
  expect(source.toDocument(items[0]).metadata).toMatchObject({ mime: 'application/pdf', filename: 'big.pdf', sizeBytes: 60 * MiB });
});

it('a PDF over MAX_FETCH_BYTES is a "none" item', async () => {
  const { source } = makeSource({ startPageToken: 'spt-1',
    lists: { root: [pdf('huge', 'huge.pdf', { size: String(MAX_FETCH_BYTES + 1) })] } });
  const { session } = makeSession();
  const items = ((await collect(source.pull(session, null))) as B[]).flatMap((b) => b.items);
  expect(items.map((i) => i.extractionStatus)).toEqual(['none']);
});

it('unknown size, 40 MiB after download → deferred item without bytes', async () => {
  const { source } = makeSource({ startPageToken: 'spt-1',
    lists: { root: [pdf('ns', 'ns.pdf', { size: undefined })] },
    media: { ns: new Uint8Array(40 * MiB) } });
  const { session } = makeSession();
  const items = ((await collect(source.pull(session, null))) as B[]).flatMap((b) => b.items);
  expect(items.map((i) => [i.extractionStatus, i.bytes])).toEqual([['deferred', undefined]]);
});

it('hash-skip pins an unchanged deferred row and re-fetches when the route changed', async () => {
  const query = fakeQuery([
    fakeDoc('big', 'file', { md5_checksum: 'md5-big-1', extraction_status: 'deferred' }),
    fakeDoc('was', 'file', { md5_checksum: 'md5-was-1', extraction_status: 'deferred' }),
  ]);
  const { source } = makeSource({ startPageToken: 'spt-1',
    lists: { root: [pdf('big', 'big.pdf', { size: String(60 * MiB) }), pdf('was', 'was.pdf')] },
    media: { was: new Uint8Array([1]) } }, query);
  const { session } = makeSession();
  const items = ((await collect(source.pull(session, null))) as B[]).flatMap((b) => b.items);
  expect(items.map((i) => [i.file.id, i.extractionStatus])).toEqual([['was', 'ok']]);
});
```

In `reconcile-and-document.test.ts`:

```ts
it('reconcile keeps deferred and none files in the live set; an oversized image is omitted', async () => {
  const { source } = makeSource({ lists: { root: [
    pdf('big', 'big.pdf', { size: String(60 * 1024 * 1024) }),
    pdf('huge', 'huge.pdf', { size: String(MAX_FETCH_BYTES + 1) }),
    binaryFile('img', 'big.png', 'image/png', { size: String(30 * 1024 * 1024) }),
  ] } });
  const { session } = makeSession();
  const refs = (await collect(source.reconcile!(session))).flat();
  expect(refs.map((r) => r.externalId).sort()).toEqual(['big', 'huge']);
});

it('fetchBytes serves deferred and refuses none before any request', async () => {
  const { source, calls } = makeSource({ media: { big: new Uint8Array([7]) } });
  const { session } = makeSession();
  const doc = (id: string, size: number) => fakeDoc(id, 'file',
    { drive_file_id: id, mime_type: 'application/pdf', size_bytes: size }, { title: `${id}.pdf` });
  expect(await source.fetchBytes!(session, doc('big', 60 * 1024 * 1024))).toEqual(new Uint8Array([7]));
  const before = calls.length;
  expect(await source.fetchBytes!(session, doc('huge', MAX_FETCH_BYTES + 1))).toBeNull();
  expect(calls.length).toBe(before);
});
```

- [ ] **Step 2: Run, and confirm they fail**

Run: `npx jest src/__tests__/backfill.test.ts src/__tests__/reconcile-and-document.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`src/export-map.ts`. In the module doc's point 2, replace "caps converter/PDF binaries at …" with "documents over the eager cap keep a metadata-only row (`bytes`); images over 20 MiB are ignored".

```ts
export type DriveRoute =
  | { kind: 'native' }
  | { kind: 'binary'; pipeline: 'converter' | 'vision'; bytes: 'eager' | 'deferred' | 'none' }
  | { kind: 'ignore'; reason: FileIgnoreReason };
// in chooseRoute:
  return d.kind === 'ignore'
    ? d
    : { kind: 'binary', pipeline: d.pipeline === 'vision' ? 'vision' : 'converter', bytes: d.bytes };

export function statusFor(route: Extract<DriveRoute, { kind: 'binary' }>): 'ok' | 'deferred' | 'none' {
  return route.bytes === 'eager' ? 'ok' : route.bytes;
}
```

`src/source.ts`:

1. `DriveItem.extractionStatus: 'ok' | 'deferred' | 'none' | 'unsupported' | 'too-large' | 'failed';`.
2. `hashSkip(deps, fileId, type, metaKey, value, want: 'ok' | 'deferred' | 'none' = 'ok')`: replace `!== 'ok'` with `!== want`, and update the comment as for OneDrive. The native-doc call keeps the default `'ok'`.
3. `metadataOnly(file, docType, extractionStatus: 'deferred' | 'none' | 'failed', …)`. Its comment changes to: "EMPTY-STRING markdown, no binary: core's convert worker enrolls a `deferred` row and fetches it through `fetchBytes`".
4. In `buildItem`'s binary branch:

```ts
// route.kind === 'binary'
if (await hashSkip(deps, file.id, 'file', 'md5_checksum', file.md5Checksum, statusFor(route))) return null;
if (route.bytes !== 'eager') {
  return { kind: 'item', item: metadataOnly(file, 'file', route.bytes, displayPath, root.rootFolderId) };
}
const bytes = await deps.client.request<Uint8Array>(mediaUrl(file.id), { responseType: 'bytes' });
// Post-download re-check for the rare unknown-size file: the SAME policy on the real length.
const post = chooseRoute(file.mimeType, file.name, bytes.byteLength);
if (post.kind === 'ignore') return { kind: 'ignored', reason: post.reason, fileId: file.id };
if (post.kind === 'binary' && post.bytes !== 'eager') {
  return { kind: 'item', item: metadataOnly(file, 'file', post.bytes, displayPath, root.rootFolderId) };
}
```

Delete the `binaryCap` lines and the now-unused `MAX_CLOUD_IMAGE_BYTES` import if nothing else uses it.

5. `fetchBytes`: replace `if (chooseRoute(mime, filename, size).kind !== 'binary') return null;` with:

```ts
const route = chooseRoute(mime, filename, size);
if (route.kind !== 'binary' || route.bytes === 'none') return null;
```

The `reconcile()` and count-walk code needs no change: deferred and none routes are `binary`, not `ignore`, so the tests above pin that they are included.

- [ ] **Step 4: Run, and confirm they pass**

Run: `npx tsc --noEmit && npx jest`
Expected: PASS, all suites.

- [ ] **Step 5: Commit**

```bash
git add src/export-map.ts src/source.ts src/__tests__/
git commit -m "feat: metadata-only rows for documents over the eager cap"
```

---

### Task 3b: gdrive: `policy_version` re-enumeration

**Files:**
- Modify: `src/source.ts` (`DriveCursor`, `withScopeRoots`, `pull`)
- Test: `src/__tests__/folder-scope.test.ts` (it already pins the `scope_roots` mismatch re-walk), plus cursor literals across `src/__tests__/`

**Design.** A stale `policy_version` joins the existing `scope_roots` mismatch condition: the same `backfill()` re-walk, keeping the saved `page_token`. Deletions are covered by `reconcile()`. `withScopeRoots` (the single stamping site) also stamps `policy_version: FILE_POLICY_VERSION`. A crash mid-walk leaves `backfill_done: false`, so the walk resumes as today.

- [ ] **Step 1: Failing tests**

```ts
import { FILE_POLICY_VERSION } from '@kiagent/connector-sdk';

it('a live cursor without policy_version re-walks once, keeping its page_token', async () => {
  const { source, calls } = makeSource({
    lists: { root: [pdf('big', 'big.pdf', { size: String(60 * 1024 * 1024) })] },
  });
  const { session } = makeSession();
  const old = { page_token: 'PT-7', backfill_done: true, scope_roots: ['root'] };
  const batches = (await collect(source.pull(session, old))) as B[];
  expect(batches.flatMap(ids)).toEqual(['big']);
  expect(calls.some((u) => u.includes('/changes/startPageToken'))).toBe(false);
  expect(batches.at(-1)!.cursor).toEqual({ page_token: 'PT-7', backfill_done: true, scope_roots: ['root'], policy_version: FILE_POLICY_VERSION });
});

it('a current cursor goes straight to delta', async () => {
  const { source, calls } = makeSource({ changes: { 'PT-7': { changes: [], newStartPageToken: 'PT-8' } } });
  const { session } = makeSession();
  await collect(source.pull(session, { page_token: 'PT-7', backfill_done: true, scope_roots: ['root'], policy_version: FILE_POLICY_VERSION }));
  expect(calls.some((u) => u.includes('/drive/v3/files?'))).toBe(false);
});
```

Match the scope-root id and the default config shape to the existing `folder-scope.test.ts` cases (`scopeRootIds` canonicalizes `'root'`).

- [ ] **Step 2: Run, and confirm they fail**

Run: `npx jest src/__tests__/folder-scope.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
export interface DriveCursor {
  page_token: string;
  backfill_done: boolean;
  scope_roots?: string[];
  /** `FILE_POLICY_VERSION` this coverage was walked under; ABSENT = 1. A
   *  stale value forces one re-walk, exactly like a scope_roots mismatch. */
  policy_version?: number;
}
```

In `withScopeRoots`, stamp `{ ...batch.cursor, scope_roots: scopeRoots, policy_version: FILE_POLICY_VERSION }`. Keep the name, and extend its doc comment: "also stamps `policy_version`; one owner for both".

In `pull`:

```ts
const stalePolicy = (cursor?.policy_version ?? 1) < FILE_POLICY_VERSION;
if (!cursor || !cursor.backfill_done || stalePolicy || !sameRootSet(cursor.scope_roots, scopeRoots)) {
```

Update the phase-switch comment: "…or the file policy admitted files the previous walk ignored".

Add `policy_version: FILE_POLICY_VERSION` to the cursor literals in test expectations and current-account inputs (`grep -n "backfill_done" src/__tests__/*.ts`). Pre-upgrade inputs stay as they are.

- [ ] **Step 4: Run, and confirm everything passes**

Run: `npx tsc --noEmit && npx jest`
Expected: PASS, all suites.

- [ ] **Step 5: Commit**

```bash
git add src/source.ts src/__tests__/
git commit -m "feat: one-time re-walk when the file policy version changes"
```

---

### Task 4: Release (after core and app releases; sequential, one repo at a time)

**Precondition:** core's release containing P1 is published, the `sdk-vX.Y.Z` release exists, and the alpha-cent app release pinning that core is live.

- [ ] **Step 1: Swap the SDK to the released tarball (each repo)**

```bash
npm i -D https://github.com/edjafarov/kiagent-core/releases/download/sdk-vX.Y.Z/kiagent-connector-sdk-X.Y.Z.tgz
grep -n '"file:' package.json && echo "STOP: local tgz still pinned" || true
npx tsc --noEmit && npx jest
git commit -am "chore: connector SDK X.Y.Z"
```

- [ ] **Step 2: Release.** OneDrive goes 2.2.1 → 2.3.0 and gdrive 2.3.1 → 2.4.0.

Make the release commit: bump `manifest.json`, `package.json` and `package-lock.json` (the root and `packages[""]` version). Then run `npm run build`, `npm test`, `npm pack` (check the tgz lists `dist/index.js`), push the branch to `main`, and run `gh release create vX.Y.Z <tgz>`. Follow each repo's previous release commit (`git show 1f9a707 --stat`, `git show e2febb0 --stat`) for the exact files.

- [ ] **Step 3: Live check (dev or packaged app, never both on the same profile)**

- Update both connectors via Marketplace.
- In OneDrive and in Drive, put one 77 MB PDF and one 30 MB docx in a tracked folder.
- Both are findable by filename right after the next sync.
- The PDF's body text is findable once the convert worker has run.
- The docx stays name-only.
- On the account that existed before the upgrade, the extension log shows exactly one re-enumeration, and no download for unchanged files.

## Self-Review notes

- **Spec §1 connectors.** `deferred`/`none` items are covered by Tasks 2 and 3. gdrive `reconcile` keeps them (Task 3 test). OneDrive no longer archives them, because they are no longer an ignore route (Task 2's "no deletion" tests). `fetchBytes` serves deferred and refuses none (Tasks 2 and 3).
- **Spec §6.** OneDrive's delta-from-scratch is Task 2b, with an added deletion catch-up. gdrive's handling, like a `scope_roots` mismatch, is Task 3b.
- **Spec Testing, "Connectors" list.**
  - The 60 MiB, zero-download, one-item case: Tasks 2 and 3.
  - "Survives reconcile": Task 3.
  - The 150 MiB file with null bytes: Tasks 2 and 3.
  - The old cursor triggering exactly one re-enumeration: Tasks 2b and 3b.
- **`.msg` / cloud `.eml`** (msg spec) arrives through the same SDK policy, `FILE_POLICY_VERSION` bump and re-enumeration, with no connector code. Its fixture test belongs to the `.msg` plan, which adds one ingest case per connector there.
