# Agent Sessions Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Marketplace extension read declared local folders with install-time consent (kiagent-core), and ship `kia.agent-sessions`, which indexes Claude Code and Codex history into the shared `documents` table.

**Architecture:** Core gains a manifest `fileRoots` field, a consent digest that binds it, a platform-owned reconciler that grants read-only roots at activation, a consent-modal section, a non-poisoning root persistence writer, and a cursor-free AppState projection. The connector is a new standalone repo: a generic fingerprint-diff sync engine (`sync.ts`) drives two sources whose discovery/parsers turn JSONL/markdown files into `DocumentInput`s.

**Tech Stack:** TypeScript, Electron main + React renderer (core), zod (manifest), better-sqlite3 (store), jest; connector: TypeScript, esbuild, jest/ts-jest, `@kiagent/connector-sdk`.

**Spec:** `docs/superpowers/specs/2026-09-23-agent-sessions-connector-design.md` (kiagent-core worktree `/Users/edjafarov/work/kiagent-core-agent-sessions`, branch `feat/local-agent-sessions`). Read it before starting any task — section numbers (§) below refer to it.

## Global Constraints

- Core worktree: `/Users/edjafarov/work/kiagent-core-agent-sessions` (branch `feat/local-agent-sessions`). Connector repo: `/Users/edjafarov/work/agent-sessions-kia-connector` (new, branch `main`).
- `PLATFORM_API_VERSION` 2.2.0 → `2.3.0`; connector manifest `engine: "^2.3.0"`; SDK `1.3.0` → `1.4.0` with `kiagentCore` set to the core release version (`0.91.0`).
- `fileRoots`: external tier only; `id` `^[a-z][a-z0-9-]{0,31}$`; `path` must start `~/`, no NUL, no empty/`.`/`..` segments, not `~/` itself; `purpose` 1–200 chars; ≤ 8 entries; requires cap `files`; read-only (no `access` field).
- Consent digest: sha256 hex of `JSON.stringify([{id, path}] sorted by id)`; `null` for absent/empty `fileRoots`; `ConsentRecord.fileRootsDigest: string | null`.
- Store migrations are append-only (never edit v1–v4).
- Connector: `caps: ["files"]` only; sources `claude-code`, `codex`; `auth: 'none'`; `cadence: { every: '15m' }`; no `reconcile`; zero runtime dependencies.
- Document types exactly: `agent.session`, `agent.plan`, `agent.tasks`, `agent.memory`, `agent.prompts`.
- Limits: read chunk 4 MiB; max line 1 MiB; doc markdown ≤ 512 KiB (256 KiB head + 256 KiB tail); per-turn cut 16 KiB; tool summary 160 chars; batch ≤ 25 docs or 8 MiB markdown; no `estimateTotal`.
- Commit messages: conventional style, **no `Co-Authored-By` line** (repo owner preference). Never `git stash`, never amend, never `--no-verify`.
- zsh: never store a command with arguments in a scalar (`C="node x"; $C` does not word-split); use arrays.
- Do not push, tag, publish or create GitHub repos until Part C, and only after the user says go.

## Review Focus

1. **A root folder that does not exist yet** (user has no `~/.codex`): install must succeed, the Codex source's `connect()` must fail with the "not found or not permitted" message, the Claude source must work. → Task A4 `.missing-dir-ungranted-not-error`, Tasks B6/B8 `connect.missing-root-message`.
2. **A session file being written while it is read** (active Claude session): the partial last line must be skipped, not crash the unit, and the next tick must re-render it. → Task B1 `.skips-partial-last-line`, Task B4 `.appended-unit-reprocessed`.
3. **A huge single record** (8.9 MB Codex tool output line): peak line buffer ≤ 1 MiB and an `… (1 oversized record skipped)` marker. → Task B1 `.oversized-record-skipped-without-buffering`.
4. **Ordinary prose and code in prompts that look like secrets** (`token: string`, `password: z.string()`): must survive redaction. → Task B2 `.leaves-type-annotations`.
5. **An installed extension whose manifest is edited in place** (same version/caps, a new root added): must drop to `needs-consent` and lose every grant. → Task A5 `consent.same-version-root-change-needs-consent`.

---

# Part A — kiagent-core

Setup once (no `npm ci` — reuse the main checkout's dependencies):

```bash
cd /Users/edjafarov/work/kiagent-core-agent-sessions
ln -sfn /Users/edjafarov/work/kiagent-core/node_modules node_modules
ln -sfn /Users/edjafarov/work/kiagent-core/release/app/node_modules release/app/node_modules
git status --short   # must show nothing new (both paths are gitignored)
```

Gates used by every Part A task (run from the worktree root):
- `npx jest <paths>` for the task's tests
- `npx tsc -p tsconfig.typecheck.json` (full typecheck)
- `npx eslint <changed files>`

Before removing the worktree later, `rm` the two symlinks first.

### Task A1: Manifest `fileRoots` field + platform 2.3.0

**Files:**
- Modify: `src/shared/contracts.ts` (add `DeclaredFileRoot`; `Manifest.fileRoots?`)
- Modify: `src/main/platform/manifest.ts` (schema, validation, `declaredFileRoots`, `isHomeRelativePath`)
- Modify: `src/shared/extension-rpc.ts:29` (`PLATFORM_API_VERSION = '2.3.0'`)
- Test: `src/main/platform/__tests__/manifest-file-roots.test.ts` (new)

**Interfaces:**
- Produces: `interface DeclaredFileRoot { id: string; path: string; purpose: string }` (contracts); `Manifest.fileRoots?: DeclaredFileRoot[]`; `declaredFileRoots(m: Pick<Manifest,'fileRoots'>): DeclaredFileRoot[]` and `isHomeRelativePath(p: string): boolean` (manifest.ts).

- [ ] **Step 1: Write the failing tests**

```ts
// src/main/platform/__tests__/manifest-file-roots.test.ts
/** @jest-environment node */
import { parseManifest, declaredFileRoots, isHomeRelativePath } from '../manifest';

const BASE = {
  id: 'kia.files',
  name: 'Files',
  version: '1.0.0',
  engine: '^2.3.0',
  entry: 'index.js',
  caps: ['files'],
  contributes: { sources: [], senders: [] },
};
const ROOT = { id: 'claude', path: '~/.claude', purpose: 'Claude history' };

describe('manifest.fileRoots', () => {
  it('accepts-valid', () => {
    const m = parseManifest({ ...BASE, fileRoots: [ROOT] });
    expect(declaredFileRoots(m)).toEqual([ROOT]);
  });

  it('defaults to an empty list', () => {
    expect(declaredFileRoots(parseManifest(BASE))).toEqual([]);
  });

  it('requires-files-cap', () => {
    expect(() => parseManifest({ ...BASE, caps: [], fileRoots: [ROOT] })).toThrow(
      /PLUGIN_FILES_CAP_REQUIRED/,
    );
  });

  it('rejects-bundled-tier', () => {
    expect(() =>
      parseManifest({ ...BASE, fileRoots: [ROOT] }, { tier: 'bundled' }),
    ).toThrow(/PLUGIN_FILE_ROOTS_TIER_DENIED/);
  });

  it.each(['~/..', '/abs', '~', '~/', '~/a/../b', '~/a/./b', '~//a', '~/a/', 'x/~/a', '~/a\0b'])(
    'rejects-lexical-escape %p',
    (p) => {
      expect(isHomeRelativePath(p)).toBe(false);
      expect(() => parseManifest({ ...BASE, fileRoots: [{ ...ROOT, path: p }] })).toThrow(
        /invalid manifest: fileRoots/,
      );
    },
  );

  it('rejects-duplicate-id', () => {
    expect(() =>
      parseManifest({ ...BASE, fileRoots: [ROOT, { ...ROOT, path: '~/.other' }] }),
    ).toThrow(/duplicate fileRoots id 'claude'/);
  });

  it('rejects bad id, empty/long purpose, more than 8 roots', () => {
    expect(() => parseManifest({ ...BASE, fileRoots: [{ ...ROOT, id: 'Bad' }] })).toThrow();
    expect(() => parseManifest({ ...BASE, fileRoots: [{ ...ROOT, purpose: '' }] })).toThrow();
    expect(() =>
      parseManifest({ ...BASE, fileRoots: [{ ...ROOT, purpose: 'x'.repeat(201) }] }),
    ).toThrow();
    const nine = Array.from({ length: 9 }, (_, i) => ({ ...ROOT, id: `r${i}`, path: `~/r${i}` }));
    expect(() => parseManifest({ ...BASE, fileRoots: nine })).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/main/platform/__tests__/manifest-file-roots.test.ts`
Expected: FAIL — `declaredFileRoots`/`isHomeRelativePath` are not exported.

- [ ] **Step 3: Implement**

In `src/shared/contracts.ts`, next to `interface Manifest` (~line 1030) add, and add the field to `Manifest`:

```ts
/** A local folder a marketplace extension declares it will read. `path` is
 *  home-relative (`~/…`) and shown verbatim on the consent modal. */
export interface DeclaredFileRoot {
  id: string;
  path: string;
  purpose: string;
}
```

```ts
  /** Platform 2.3.0: read-only local folders this extension asks to read.
   *  External tier only; requires the `files` cap. Bound into consent via
   *  `ConsentRecord.fileRootsDigest`. */
  fileRoots?: DeclaredFileRoot[];
```

In `src/main/platform/manifest.ts`, above `const schema`:

```ts
const FILE_ROOT_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** `~/<seg>/<seg>…` with no empty, `.` or `..` segment and no NUL — the
 *  lexical half of the containment rule; the reconciler re-checks the
 *  realpath against the home directory at grant time. */
export function isHomeRelativePath(p: string): boolean {
  if (!p.startsWith('~/') || p.includes('\0')) return false;
  const rest = p.slice(2);
  if (rest === '') return false;
  return rest.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

const fileRootSchema = z.strictObject({
  id: z.string().regex(FILE_ROOT_ID_RE, 'fileRoots id must match ^[a-z][a-z0-9-]{0,31}$'),
  path: z
    .string()
    .refine(isHomeRelativePath, "fileRoots path must be '~/<relative path>' without '.', '..' or empty segments"),
  purpose: z.string().min(1).max(200),
});
```

Add to `schema` (after `database`): `fileRoots: z.array(fileRootSchema).max(8).optional(),`

In `parseManifest`, after the privileged-caps check:

```ts
  const fileRoots = m.fileRoots ?? [];
  if (fileRoots.length > 0) {
    if (!m.caps.includes('files'))
      throw new ManifestError(
        'PLUGIN_FILES_CAP_REQUIRED: the files capability is required for fileRoots',
      );
    if (tier === 'bundled')
      throw new ManifestError(
        'PLUGIN_FILE_ROOTS_TIER_DENIED: fileRoots is for marketplace extensions — bundled extensions use mainApi.grantRoot',
      );
    const seen = new Set<string>();
    for (const r of fileRoots) {
      if (seen.has(r.id))
        throw new ManifestError(`invalid manifest: fileRoots — duplicate fileRoots id '${r.id}'`);
      seen.add(r.id);
    }
  }
```

Below `oauthSourceBindings` add:

```ts
/** This extension's declared local folders — THE way to consume
 *  `fileRoots`, defaulting to `[]`. */
export function declaredFileRoots(
  manifest: Pick<Manifest, 'fileRoots'>,
): DeclaredFileRoot[] {
  return manifest.fileRoots ?? [];
}
```

(import `DeclaredFileRoot` from `@shared/contracts` alongside the existing imports). In `src/shared/extension-rpc.ts` set `PLATFORM_API_VERSION = '2.3.0'`.

- [ ] **Step 4: Run tests + existing manifest suites**

Run: `npx jest src/main/platform/__tests__/manifest`
Expected: PASS (all manifest suites). If any suite pins `2.2.0`, update it to `2.3.0` (grep: `grep -rn "2\.2\.0" src --include=*.ts`).

- [ ] **Step 5: Mutation evidence** — temporarily delete the `tier === 'bundled'` branch → `rejects-bundled-tier` must go red; restore. Temporarily make `isHomeRelativePath` return `p.startsWith('~/')` → the `~/..`, `~/a/../b` cases go red; restore. Record both in the task report.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
npx tsc -p tsconfig.typecheck.json
npx eslint src/main/platform/manifest.ts src/shared/contracts.ts src/shared/extension-rpc.ts src/main/platform/__tests__/manifest-file-roots.test.ts
git add -A src/shared/contracts.ts src/main/platform/manifest.ts src/shared/extension-rpc.ts src/main/platform/__tests__/manifest-file-roots.test.ts
git commit -m "feat(platform): manifest fileRoots declaration (platform 2.3.0)"
```

### Task A2: Consent binds the declared roots (digest + migration v5)

**Files:**
- Modify: `src/shared/contracts.ts:283` (`ConsentRecord.fileRootsDigest`)
- Modify: `src/main/platform/manifest.ts` (`fileRootsDigest`)
- Modify: `src/main/core/store/schema.ts` (append migration v5 to `MIGRATIONS`, ~line 1073)
- Modify: `src/main/core/store/store.ts:1120-1155` (`consents.latest/record`)
- Modify: `src/main/platform/extension-platform.ts` (`consentCovers` ~590; both `ConsentRecord` literals ~1300, ~1467)
- Test: `src/main/platform/__tests__/manifest-file-roots.test.ts` (digest), `src/main/core/store/__tests__/consents-digest.test.ts` (new), `src/main/platform/__tests__/extension-platform.test.ts` (new describe, see Task A5 — the consent-gate tests live there because they need a fixture)

**Interfaces:**
- Consumes: `DeclaredFileRoot`, `declaredFileRoots` (A1).
- Produces: `fileRootsDigest(roots: readonly DeclaredFileRoot[] | undefined): string | null`; `ConsentRecord.fileRootsDigest: string | null`.

- [ ] **Step 1: Failing tests**

Append to `manifest-file-roots.test.ts`:

```ts
import { fileRootsDigest } from '../manifest';
import { createHash } from 'crypto';

describe('fileRootsDigest', () => {
  it('is null for absent or empty roots', () => {
    expect(fileRootsDigest(undefined)).toBeNull();
    expect(fileRootsDigest([])).toBeNull();
  });
  it('hashes the canonical id-sorted {id,path} list, ignoring purpose', () => {
    const a = { id: 'codex', path: '~/.codex', purpose: 'x' };
    const b = { id: 'claude', path: '~/.claude', purpose: 'y' };
    const expected = createHash('sha256')
      .update('[{"id":"claude","path":"~/.claude"},{"id":"codex","path":"~/.codex"}]')
      .digest('hex');
    expect(fileRootsDigest([a, b])).toBe(expected);
    expect(fileRootsDigest([b, { ...a, purpose: 'changed' }])).toBe(expected);
    expect(fileRootsDigest([b, { ...a, path: '~/.codex2' }])).not.toBe(expected);
  });
});
```

Create `src/main/core/store/__tests__/consents-digest.test.ts` (copy the `openDb`/`openStore` imports and store construction from the top of `src/main/platform/__tests__/extension-platform.test.ts`):

```ts
/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../db';           // same import the platform test uses
import { openStore } from '../store';

describe('consents.fileRootsDigest', () => {
  let tmp: string;
  let store: Awaited<ReturnType<typeof openStore>>;
  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kia-consent-'));
    store = openStore(await openDb(path.join(tmp, 'kiagent.db')), {
      encrypt: (s) => Buffer.from(s, 'utf8'),
      decrypt: (b) => b.toString('utf8'),
      detectLanguages: () => [],
    });
  });
  afterEach(async () => {
    await store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('null-digest-round-trips and a string digest round-trips', async () => {
    const base = { extensionId: 'x.y' as never, caps: ['files'] as never, manifestVersion: '1.0.0', grantedAt: 't' };
    await store.consents.record({ ...base, fileRootsDigest: null });
    expect((await store.consents.latest('x.y' as never))?.fileRootsDigest).toBeNull();
    await store.consents.record({ ...base, fileRootsDigest: 'abc' });
    expect((await store.consents.latest('x.y' as never))?.fileRootsDigest).toBe('abc');
  });
});
```

(If the import paths differ, use exactly the ones at the top of `extension-platform.test.ts`.)

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/main/platform/__tests__/manifest-file-roots.test.ts src/main/core/store/__tests__/consents-digest.test.ts`
Expected: FAIL (no `fileRootsDigest`, no column).

- [ ] **Step 3: Implement**

`contracts.ts` `ConsentRecord` — add `fileRootsDigest: string | null;` with comment `/** sha256 of the consented manifest's fileRoots ({id,path}); null = none. */`.

`manifest.ts`:

```ts
import { createHash } from 'crypto';

/** The consent binding for `fileRoots`: sha256 hex of the id-sorted
 *  `[{id, path}]` JSON (purpose is display copy, excluded). `null` when the
 *  manifest declares none — equal to a legacy consent row's NULL. */
export function fileRootsDigest(
  roots: readonly DeclaredFileRoot[] | undefined,
): string | null {
  if (!roots || roots.length === 0) return null;
  const canon = [...roots]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((r) => ({ id: r.id, path: r.path }));
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex');
}
```

`schema.ts` — append after the v4 entry inside `MIGRATIONS`:

```ts
  // v5 — consent binds manifest-declared file roots (platform 2.3.0).
  // Legacy rows read NULL, which covers only manifests without fileRoots.
  `
    ALTER TABLE consents ADD COLUMN file_roots_digest TEXT;
  `,
```

`store.ts` consents: add `file_roots_digest: string | null;` to the row type, map `fileRootsDigest: r.file_roots_digest ?? null`, and write it:

```ts
        await db.run(
          `INSERT INTO consents(extension_id, caps, manifest_version, granted_at, file_roots_digest)
           VALUES(?, ?, ?, ?, ?)`,
          [c.extensionId, JSON.stringify(c.caps), c.manifestVersion, c.grantedAt, c.fileRootsDigest ?? null],
        );
```

`extension-platform.ts`:

```ts
  async function consentCovers(manifest: Manifest): Promise<boolean> {
    const rec = await deps.store.consents.latest(manifest.id);
    return (
      rec !== null &&
      rec.manifestVersion === manifest.version &&
      manifest.caps.every((c) => rec.caps.includes(c)) &&
      (rec.fileRootsDigest ?? null) === fileRootsDigest(manifest.fileRoots)
    );
  }
```

and in both `const consent: ConsentRecord = {…}` literals add `fileRootsDigest: fileRootsDigest(manifest.fileRoots),` (use `e.manifest` in `grantConsent`). Import `fileRootsDigest` from `./manifest`.

- [ ] **Step 4: Run** the two new suites plus `npx jest src/main/core/store src/main/platform/__tests__/extension-platform.test.ts`. Expected: PASS. If a store test asserts the schema version or migration count (grep `user_version` / `MIGRATIONS` in `src/main/core/store/__tests__`), bump the expected value by one.

- [ ] **Step 5: Mutation evidence** — drop the digest clause from `consentCovers` (the A5 test `consent.same-version-root-change-needs-consent` will cover it — note it here and re-run after A5); make `fileRootsDigest` include `purpose` → the "ignoring purpose" case goes red; restore.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
npx tsc -p tsconfig.typecheck.json && npx eslint src/main/platform/manifest.ts src/main/core/store/schema.ts src/main/core/store/store.ts src/main/platform/extension-platform.ts
git add -A src/shared/contracts.ts src/main/platform/manifest.ts src/main/core/store src/main/platform/extension-platform.ts src/main/platform/__tests__/manifest-file-roots.test.ts
git commit -m "feat(platform): bind declared file roots into consent (store v5)"
```

### Task A3: File-root persistence recovers after a failed write

**Files:**
- Modify: `src/main/platform/file-roots.ts:51-66` (`createFileRootsPersistence`)
- Test: `src/main/platform/__tests__/file-roots.test.ts` (append)

**Interfaces:**
- Produces: `interface FileRootsPersistence { (): Promise<void>; isDirty(): boolean }`; `createFileRootsPersistence(filePath, registry): FileRootsPersistence` (callers typed `() => Promise<void>` stay compatible).

- [ ] **Step 1: Failing tests** (append inside the file's top-level `describe` or a new one)

```ts
import { createFileRootsPersistence, restoreFileRootsFromFile } from '../file-roots';
import { readFile, chmod } from 'node:fs/promises';

describe('file root persistence', () => {
  it('recovers-after-failure: one failed write does not poison later saves', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kiagent-persist-'));
    const target = join(dir, 'file-roots.json');
    const registry = createFileRootRegistry();
    const persist = createFileRootsPersistence(target, registry);
    await chmod(dir, 0o500); // rename into a read-only dir fails
    await registry.grant('documents', rootPath, { id: 'a', name: 'A', writable: true });
    await expect(persist()).rejects.toThrow();
    expect(persist.isDirty()).toBe(true);
    await chmod(dir, 0o700);
    await registry.grant('kia.x', rootPath, { id: 'b', name: 'B', writable: false });
    await persist();
    expect(persist.isDirty()).toBe(false);
    const saved = JSON.parse(await readFile(target, 'utf8'));
    expect(saved.map((r: { id: string }) => r.id).sort()).toEqual(['a', 'b']);
    await rm(dir, { recursive: true, force: true });
  });

  it('dirty-snapshot-retried-without-changes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kiagent-persist-'));
    const target = join(dir, 'file-roots.json');
    const registry = createFileRootRegistry();
    const persist = createFileRootsPersistence(target, registry);
    await registry.grant('kia.x', rootPath, { id: 'b', name: 'B', writable: false });
    await chmod(dir, 0o500);
    await expect(persist()).rejects.toThrow();
    await chmod(dir, 0o700);
    await persist(); // no registry change in between
    const fresh = createFileRootRegistry();
    await restoreFileRootsFromFile(target, fresh);
    expect(await fresh.roots('kia.x')).toEqual([{ id: 'b', name: 'B', writable: false }]);
    await rm(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run** `npx jest src/main/platform/__tests__/file-roots.test.ts` — Expected: FAIL (`isDirty` missing; the second save rejects because the chain is poisoned).

- [ ] **Step 3: Implement**

```ts
export interface FileRootsPersistence {
  (): Promise<void>;
  /** True while a requested save has not yet succeeded. */
  isDirty(): boolean;
}

export function createFileRootsPersistence(
  filePath: string,
  registry: FileRootRegistry,
): FileRootsPersistence {
  let chain: Promise<void> = Promise.resolve();
  let requested = 0;
  let saved = 0;
  const persist = (async () => {
    const mine = ++requested;
    // Chain on a recovered promise: a previous failure must never poison
    // later saves (bundled grants share this writer).
    const run = chain
      .catch(() => undefined)
      .then(async () => {
        if (saved >= mine) return; // a later snapshot already covered this request
        const upTo = requested;
        const temporary = `${filePath}.${process.pid}.tmp`;
        await fsp.writeFile(temporary, JSON.stringify(registry.snapshot(), null, 2));
        await fsp.rename(temporary, filePath);
        saved = Math.max(saved, upTo);
      });
    chain = run;
    await run;
  }) as FileRootsPersistence;
  persist.isDirty = () => saved < requested;
  return persist;
}
```

- [ ] **Step 4: Run** the file-roots suite and `npx jest src/main/__tests__ -t fileRoots` (any suite touching main wiring). Expected: PASS.

- [ ] **Step 5: Mutation evidence** — replace `chain.catch(() => undefined).then` with `chain.then` → `recovers-after-failure` red; remove the `saved >= mine` guard → still green (it is an optimisation; say so in the report); restore.

- [ ] **Step 6: Commit**

```bash
npx tsc -p tsconfig.typecheck.json && npx eslint src/main/platform/file-roots.ts
git add src/main/platform/file-roots.ts src/main/platform/__tests__/file-roots.test.ts
git commit -m "fix(platform): file-root persistence recovers after a failed write"
```

### Task A4: `reconcileDeclaredRoots` (pure module)

**Files:**
- Create: `src/main/platform/declared-roots.ts`
- Test: `src/main/platform/__tests__/declared-roots.test.ts`

**Interfaces:**
- Consumes: `FileRootRegistry`, `FileRootsPersistence` (A3), `DeclaredFileRoot` (A1).
- Produces:
  ```ts
  reconcileDeclaredRoots(o: {
    registry: FileRootRegistry; extensionId: string;
    declared: readonly DeclaredFileRoot[]; home: string; userDataDir?: string;
    persist?: FileRootsPersistence; log: (level: 'info' | 'warn', msg: string) => void;
  }): Promise<void>
  revokeAllRoots(registry: FileRootRegistry, extensionId: string,
    persist?: FileRootsPersistence, log?: (level: 'info' | 'warn', msg: string) => void): Promise<void>
  ```

- [ ] **Step 1: Failing tests**

```ts
// src/main/platform/__tests__/declared-roots.test.ts
/** @jest-environment node */
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileRootRegistry, createFileRootsPersistence, restoreFileRootsFromFile } from '../file-roots';
import { reconcileDeclaredRoots, revokeAllRoots } from '../declared-roots';

const EXT = 'kia.agent-sessions';
const CLAUDE = { id: 'claude', path: '~/.claude', purpose: 'p' };

describe('reconcileDeclaredRoots', () => {
  let home: string;
  let registry: ReturnType<typeof createFileRootRegistry>;
  let logs: string[];
  const run = (declared = [CLAUDE], extra: Record<string, unknown> = {}) =>
    reconcileDeclaredRoots({
      registry, extensionId: EXT, declared, home,
      log: (level, msg) => logs.push(`${level}:${msg}`), ...extra,
    });

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'kia-home-')));
    registry = createFileRootRegistry();
    logs = [];
  });
  afterEach(() => rm(home, { recursive: true, force: true }));

  it('grants-declared-after-consent (read-only, named by the ~/ path)', async () => {
    await mkdir(join(home, '.claude'));
    await run();
    expect(await registry.roots(EXT)).toEqual([{ id: 'claude', name: '~/.claude', writable: false }]);
    expect((await registry.resolve(EXT, 'claude')).path).toBe(join(home, '.claude'));
  });

  it('missing-dir-ungranted-not-error', async () => {
    await expect(run()).resolves.toBeUndefined();
    expect(await registry.roots(EXT)).toEqual([]);
    expect(logs.some((l) => l.startsWith('info:'))).toBe(true);
  });

  it('missing-replacement-revokes-old-grant', async () => {
    await mkdir(join(home, '.claude'));
    await run();
    await rm(join(home, '.claude'), { recursive: true });
    await run();
    expect(await registry.roots(EXT)).toEqual([]);
  });

  it('non-directory-ungranted', async () => {
    await writeFile(join(home, '.claude'), 'x');
    await run();
    expect(await registry.roots(EXT)).toEqual([]);
  });

  it('symlinked-root-granted-at-realpath', async () => {
    await mkdir(join(home, 'dotfiles', 'claude'), { recursive: true });
    await symlink(join(home, 'dotfiles', 'claude'), join(home, '.claude'));
    await run();
    expect((await registry.resolve(EXT, 'claude')).path).toBe(join(home, 'dotfiles', 'claude'));
  });

  it('refuses-realpath-outside-home', async () => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'kia-out-')));
    await symlink(outside, join(home, '.claude'));
    await run();
    expect(await registry.roots(EXT)).toEqual([]);
    expect(logs.some((l) => l.startsWith('warn:'))).toBe(true);
    await rm(outside, { recursive: true, force: true });
  });

  it('refuses-userData-and-home-and-library', async () => {
    await mkdir(join(home, 'Library', 'Application Support', 'KIAgent'), { recursive: true });
    await mkdir(join(home, 'Library', 'Mail', 'V10'), { recursive: true });
    const userDataDir = join(home, 'Library', 'Application Support', 'KIAgent');
    const declared = [
      { id: 'lib', path: '~/Library', purpose: 'p' },
      { id: 'libx', path: '~/Library/Mail', purpose: 'p' },
      { id: 'ud', path: '~/Library/Application Support/KIAgent', purpose: 'p' },
      { id: 'udparent', path: '~/Library/Application Support', purpose: 'p' },
      { id: 'deep', path: '~/Library/Mail/V10', purpose: 'p' },
    ];
    await run(declared, { userDataDir });
    expect((await registry.roots(EXT)).map((r) => r.id)).toEqual(['deep']);
  });

  it('refuses-symlinked-userData-realpath', async () => {
    await mkdir(join(home, 'kia-data'));
    await mkdir(join(home, 'links'));
    await symlink(join(home, 'kia-data'), join(home, 'links', 'userData'));
    await run([{ id: 'd', path: '~/kia-data', purpose: 'p' }], { userDataDir: join(home, 'links', 'userData') });
    expect(await registry.roots(EXT)).toEqual([]);
  });

  it('regrants-on-identity-change', async () => {
    await mkdir(join(home, '.claude'));
    await run();
    const before = await registry.resolve(EXT, 'claude');
    await rmdir(join(home, '.claude'));
    await mkdir(join(home, '.claude'));
    await run();
    const after = await registry.resolve(EXT, 'claude');
    expect(after.ino).not.toBe(before.ino);
  });

  it('restored-writable-grant-not-retained', async () => {
    await mkdir(join(home, '.claude'));
    await registry.grant(EXT, join(home, '.claude'), { id: 'claude', name: '~/.claude', writable: true });
    await run();
    expect((await registry.roots(EXT))[0].writable).toBe(false);
  });

  it('revokes-undeclared', async () => {
    await mkdir(join(home, '.claude'));
    await mkdir(join(home, '.old'));
    await run([CLAUDE, { id: 'old', path: '~/.old', purpose: 'p' }]);
    await run([CLAUDE]);
    expect((await registry.roots(EXT)).map((r) => r.id)).toEqual(['claude']);
  });

  it('revokes-all (uninstall / consent lapse)', async () => {
    await mkdir(join(home, '.claude'));
    await run();
    await revokeAllRoots(registry, EXT);
    expect(await registry.roots(EXT)).toEqual([]);
  });

  it('persists-and-restores-across-restart; retries a dirty save with no changes', async () => {
    await mkdir(join(home, '.claude'));
    const file = join(home, 'file-roots.json');
    const persist = createFileRootsPersistence(file, registry);
    await run([CLAUDE], { persist });
    const fresh = createFileRootsPersistence(file, createFileRootRegistry());
    const restored = createFileRootRegistry();
    await restoreFileRootsFromFile(file, restored);
    expect(await restored.roots(EXT)).toEqual([{ id: 'claude', name: '~/.claude', writable: false }]);
    expect(fresh.isDirty()).toBe(false);
  });
});
```

- [ ] **Step 2: Run** `npx jest src/main/platform/__tests__/declared-roots.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement** `src/main/platform/declared-roots.ts`:

```ts
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { DeclaredFileRoot } from '@shared/contracts';
import type { FileRootRegistry, FileRootsPersistence } from './file-roots';

type Log = (level: 'info' | 'warn', msg: string) => void;

const inside = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(parent + path.sep);

async function realOrResolved(p: string): Promise<string> {
  try {
    return await fsp.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

/** Resolve one declaration to a grantable directory, or null (ungranted). */
async function resolveDeclared(
  d: DeclaredFileRoot,
  home: string,
  userData: string | undefined,
  log: Log,
): Promise<{ path: string; dev: string; ino: string } | null> {
  const abs = path.join(home, d.path.slice(2));
  let st;
  try {
    st = await fsp.stat(abs);
  } catch {
    log('info', `file root ${d.id} (${d.path}) not found — not granted`);
    return null;
  }
  if (!st.isDirectory()) {
    log('info', `file root ${d.id} (${d.path}) is not a directory — not granted`);
    return null;
  }
  const real = await fsp.realpath(abs);
  const rel = path.relative(home, real);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    log('warn', `file root ${d.id} (${d.path}) resolves outside the home folder — refused`);
    return null;
  }
  const segs = rel.split(path.sep);
  if (segs[0] === 'Library' && segs.length <= 2) {
    log('warn', `file root ${d.id} (${d.path}) is too broad (~/Library or one level below) — refused`);
    return null;
  }
  if (userData && (inside(real, userData) || inside(userData, real))) {
    log('warn', `file root ${d.id} (${d.path}) overlaps the app's own data — refused`);
    return null;
  }
  const l = await fsp.lstat(real, { bigint: true });
  return { path: real, dev: String(l.dev), ino: String(l.ino) };
}

/** Platform-owned: make an EXTERNAL extension's grants equal its consented
 *  declarations (spec §3.3). Never reachable by the extension itself. */
export async function reconcileDeclaredRoots(o: {
  registry: FileRootRegistry;
  extensionId: string;
  declared: readonly DeclaredFileRoot[];
  home: string;
  userDataDir?: string;
  persist?: FileRootsPersistence;
  log: Log;
}): Promise<void> {
  const home = await fsp.realpath(o.home);
  const userData = o.userDataDir ? await realOrResolved(o.userDataDir) : undefined;
  const existing = new Set((await o.registry.roots(o.extensionId)).map((r) => r.id));
  let changed = false;

  for (const d of o.declared) {
    const target = await resolveDeclared(d, home, userData, o.log);
    const prior = existing.has(d.id)
      ? await o.registry.resolve(o.extensionId, d.id).catch(() => undefined)
      : undefined;
    if (
      target &&
      prior &&
      prior.path === target.path &&
      prior.writable === false &&
      prior.dev === target.dev &&
      prior.ino === target.ino
    )
      continue;
    if (existing.has(d.id)) {
      await o.registry.revoke(o.extensionId, d.id); // revoke FIRST (spec §3.3 step 3)
      changed = true;
    }
    if (!target) continue;
    try {
      await o.registry.grant(o.extensionId, target.path, { id: d.id, name: d.path, writable: false });
      changed = true;
    } catch (error) {
      o.log('warn', `file root ${d.id} (${d.path}) could not be granted: ${String(error)}`);
    }
  }
  for (const id of existing) {
    if (o.declared.some((d) => d.id === id)) continue;
    await o.registry.revoke(o.extensionId, id);
    changed = true;
  }
  if (o.persist && (changed || o.persist.isDirty())) {
    await o.persist().catch((error) => o.log('warn', `file roots not persisted: ${String(error)}`));
  }
}

export async function revokeAllRoots(
  registry: FileRootRegistry,
  extensionId: string,
  persist?: FileRootsPersistence,
  log?: Log,
): Promise<void> {
  const roots = await registry.roots(extensionId);
  for (const r of roots) await registry.revoke(extensionId, r.id);
  if (persist && (roots.length > 0 || persist.isDirty()))
    await persist().catch((error) => log?.('warn', `file roots not persisted: ${String(error)}`));
}
```

- [ ] **Step 4: Run** the suite. Expected: PASS.

- [ ] **Step 5: Mutation evidence** — for each, break → confirm red → restore: drop `prior.writable === false` (`restored-writable-grant-not-retained`); drop the `Library` rule (`refuses-…library`); compare `userDataDir` without `realOrResolved` (`refuses-symlinked-userData-realpath`); skip the revoke when `target` is null (`missing-replacement-revokes-old-grant`); drop the undeclared loop (`revokes-undeclared`).

- [ ] **Step 6: Commit**

```bash
npx tsc -p tsconfig.typecheck.json && npx eslint src/main/platform/declared-roots.ts src/main/platform/__tests__/declared-roots.test.ts
git add src/main/platform/declared-roots.ts src/main/platform/__tests__/declared-roots.test.ts
git commit -m "feat(platform): reconcile manifest-declared file roots"
```

### Task A5: Wire the reconciler into the platform lifecycle

**Files:**
- Modify: `src/main/platform/extension-platform.ts` (deps ~l.250; activation ~l.924; uninstall ~l.1433)
- Modify: `src/main/main.ts` (~l.1127: pass `userDataDir`, `persistFileRoots`)
- Create fixture: `src/main/platform/__tests__/fixtures/ext-files/{manifest.json,index.js}`
- Test: `src/main/platform/__tests__/extension-platform.test.ts` (new `describe('declared file roots')`)

**Interfaces:**
- Consumes: `reconcileDeclaredRoots`, `revokeAllRoots` (A4), `declaredFileRoots`, `fileRootsDigest` (A1/A2), `FileRootsPersistence` (A3).
- Produces: `ExtensionPlatformDeps.userDataDir?: string`, `.persistFileRoots?: FileRootsPersistence`, `.homeDir?: string` (test seam; default `os.homedir()`).

- [ ] **Step 1: Fixture**

`fixtures/ext-files/manifest.json`:

```json
{
  "id": "test.files",
  "name": "Files Test Extension",
  "version": "1.0.0",
  "engine": "^2.3.0",
  "entry": "index.js",
  "caps": ["files"],
  "fileRoots": [{ "id": "data", "path": "~/.kia-test-data", "purpose": "Test data" }],
  "contributes": { "sources": [], "senders": [] }
}
```

`fixtures/ext-files/index.js`:

```js
/** Minimal fixture: declares a file root, contributes nothing. */
module.exports = { async activate() { return {}; } };
```

- [ ] **Step 2: Failing tests** — add inside the platform test file (it already has `makePlatform`, `store`, `tmp`):

```ts
import { createFileRootRegistry } from '../file-roots';
const FIXTURE_FILES = path.join(__dirname, 'fixtures', 'ext-files');

describe('declared file roots', () => {
  let home: string;
  let fileRoots: ReturnType<typeof createFileRootRegistry>;
  let filesPlatform: ExtensionPlatform;

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kia-home-')));
    fs.mkdirSync(path.join(home, '.kia-test-data'));
    fileRoots = createFileRootRegistry();
    filesPlatform = makePlatform({ fileRoots, homeDir: home, userDataDir: path.join(tmp, 'userData') });
  });
  afterEach(async () => {
    await filesPlatform.stop();
    fs.rmSync(home, { recursive: true, force: true });
  });

  async function install(): Promise<void> {
    const preview = await filesPlatform.installPreview(FIXTURE_FILES);
    if (!('token' in preview)) throw new Error(JSON.stringify(preview));
    expect(preview.fileRoots).toEqual([{ id: 'data', path: '~/.kia-test-data', purpose: 'Test data' }]);
    expect(await filesPlatform.installCommit(preview.token)).toEqual({ ok: true, id: 'test.files' });
  }

  it('consent.digest-recorded-on-install and roots granted at activation', async () => {
    await filesPlatform.start();
    await install();
    const consent = await store.consents.latest('test.files' as never);
    expect(consent?.fileRootsDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(await fileRoots.roots('test.files')).toEqual([
      { id: 'data', name: '~/.kia-test-data', writable: false },
    ]);
    expect(filesPlatform.snapshot()).toEqual([
      expect.objectContaining({ id: 'test.files', status: 'activated', fileRoots: [
        { id: 'data', path: '~/.kia-test-data', purpose: 'Test data' },
      ] }),
    ]);
  });

  it('consent.same-version-root-change-needs-consent (and revokes every grant)', async () => {
    await filesPlatform.start();
    await install();
    const installed = path.join(tmp, 'extensions', 'test.files', 'manifest.json');
    const m = JSON.parse(fs.readFileSync(installed, 'utf8'));
    m.fileRoots.push({ id: 'ssh', path: '~/.ssh', purpose: 'sneaky' });
    fs.writeFileSync(installed, JSON.stringify(m));
    await filesPlatform.stop();
    filesPlatform = makePlatform({ fileRoots, homeDir: home });
    await filesPlatform.start();
    expect(filesPlatform.snapshot()).toEqual([
      expect.objectContaining({ id: 'test.files', status: 'needs-consent' }),
    ]);
    expect(await fileRoots.roots('test.files')).toEqual([]);
  });

  it('consent.digest-recorded-on-review (grantConsent) re-grants', async () => {
    await filesPlatform.start();
    await install();
    await fileRoots.revoke('test.files', 'data');
    expect(await filesPlatform.grantConsent('test.files')).toEqual({ ok: true });
    expect((await fileRoots.roots('test.files')).map((r) => r.id)).toEqual(['data']);
  });

  it('reconcile.revokes-all-on-uninstall', async () => {
    await filesPlatform.start();
    await install();
    expect(await filesPlatform.uninstall('test.files')).toEqual({ ok: true });
    expect(await fileRoots.roots('test.files')).toEqual([]);
  });
});
```

If the installed directory is not `extensions/test.files`, locate it with `fs.readdirSync(path.join(tmp, 'extensions'))` in the test and adjust the path (read `installer.commit` for the layout).

- [ ] **Step 3: Run** `npx jest src/main/platform/__tests__/extension-platform.test.ts -t "declared file roots"` — Expected: FAIL (`homeDir` unknown dep, no grants, no `fileRoots` on preview/snapshot).

- [ ] **Step 4: Implement**

`ExtensionPlatformDeps` (next to `fileRoots?`):

```ts
  /** The app's userData dir — a declared root may never cover or sit inside it. */
  userDataDir?: string;
  /** Persists `fileRoots` after a declared-root change (same writer main-api uses). */
  persistFileRoots?: FileRootsPersistence;
  /** Test seam for the home directory declared `~/` paths resolve against. */
  homeDir?: string;
```

In `activate(e)`, replace the consent block with:

```ts
      if (e.origin !== 'bundled' && !(await consentCovers(e.manifest))) {
        if (deps.fileRoots)
          await revokeAllRoots(deps.fileRoots, e.manifest.id, deps.persistFileRoots, (level, msg) =>
            deps.logSink.log('extensions', level, msg),
          );
        e.host = null;
        setStatus(e, 'needs-consent');
        e.activation = undefined;
        return;
      }
      if (e.origin !== 'bundled' && deps.fileRoots) {
        await reconcileDeclaredRoots({
          registry: deps.fileRoots,
          extensionId: e.manifest.id,
          declared: declaredFileRoots(e.manifest),
          home: deps.homeDir ?? os.homedir(),
          userDataDir: deps.userDataDir,
          persist: deps.persistFileRoots,
          log: (level, msg) => deps.logSink.log('extensions', level, msg),
        });
      }
```

(keep the existing comment inside the needs-consent branch). In `uninstall`, immediately before `entries.delete(id);`:

```ts
        if (deps.fileRoots)
          await revokeAllRoots(deps.fileRoots, id, deps.persistFileRoots, (level, msg) =>
            deps.logSink.log('extensions', level, msg),
          );
```

Add `fileRoots: declaredFileRoots(e.manifest),` to `snapshot()` (next to `oauthSources`) and `fileRoots: declaredFileRoots(p.manifest),` to the preview builder (~l.1264). Add `fileRoots: DeclaredFileRoot[]` to `ExtensionPreview` (`src/shared/ipc.ts:153`) and to `ExtensionSnapshot` (find with `grep -rn "interface ExtensionSnapshot" src/shared`). Imports: `os`, `reconcileDeclaredRoots`, `revokeAllRoots` from `./declared-roots`, `declaredFileRoots` from `./manifest`, `FileRootsPersistence` type from `./file-roots`.

`src/main/main.ts` at the `createExtensionPlatform({…})` call that passes `fileRoots` (~l.1127) add `userDataDir: app.getPath('userData'), persistFileRoots,` (`persistFileRoots` is created at ~l.872 in the same scope — if it is not in scope, hoist it the same way `fileRoots` is).

Fix every test/renderer object literal typed `ExtensionPreview`/`ExtensionSnapshot` that now misses `fileRoots` (typecheck lists them; add `fileRoots: []`).

- [ ] **Step 5: Run** `npx jest src/main/platform src/main/__tests__` — Expected: PASS. Then re-run A2's mutation: drop the digest clause from `consentCovers` → `same-version-root-change-needs-consent` red; restore. Also: remove the `revokeAllRoots` call in the needs-consent branch → the same test's `roots` assertion red; remove the uninstall revoke → `revokes-all-on-uninstall` red; restore.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
npx tsc -p tsconfig.typecheck.json
npx eslint src/main/platform/extension-platform.ts src/main/main.ts src/shared/ipc.ts
git add -A src/main/platform src/main/main.ts src/shared
git commit -m "feat(platform): grant declared roots at activation; revoke on lapse/uninstall"
```

### Task A6: Consent modal shows the folders

**Files:**
- Modify: `src/renderer/components/ConsentModal.tsx` (`ConsentRequest.fileRoots?`, folder section)
- Modify: `src/renderer/components/cap-catalog.ts` (`files` entry)
- Modify: `src/renderer/screens/Marketplace/Detail.tsx:106,125` (pass `fileRoots`)
- Test: `src/renderer/screens/Marketplace/__tests__/Detail.test.tsx` (append)

**Interfaces:**
- Consumes: `ExtensionPreview.fileRoots`, `ExtensionSnapshot.fileRoots` (A5).

- [ ] **Step 1: Failing tests** — append to `Detail.test.tsx` (uses the file's own `mockInvoke`, `pluginDetail`, `catalogRow`, `extSnapshot`, `installedOnlyRow`, `mockState` helpers):

```tsx
  const FOLDERS = [{ id: 'claude', path: '~/.claude', purpose: 'Claude Code sessions' }];

  function expectFolders(dialog: HTMLElement): void {
    expect(within(dialog).getByText('Reads these folders on your computer')).toBeInTheDocument();
    expect(within(dialog).getByText('~/.claude')).toBeInTheDocument();
    expect(within(dialog).getByText('Claude Code sessions')).toBeInTheDocument();
    expect(
      within(dialog).getByText('The extension can read everything inside these folders.'),
    ).toBeInTheDocument();
  }

  test('consent-ui.install-shows-folders', async () => {
    mockInvoke({
      'marketplace:detail': () => pluginDetail(),
      'extension:install-preview': () => ({
        ok: true,
        token: 'tok-f',
        id: 'ext.gmail-tools',
        name: 'Gmail Tools',
        version: '1.1.0',
        caps: ['files'],
        oauthSources: [],
        fileRoots: FOLDERS,
        sizeBytes: 2048,
        integrity: null,
      }),
    });
    render(<Detail row={catalogRow()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Install' }));
    expectFolders(await screen.findByRole('dialog'));
  });

  test('consent-ui.review-shows-folders', async () => {
    mockInvoke({ 'extension:grant-consent': () => ({ ok: true }) });
    const snapshot = extSnapshot({ status: 'needs-consent', caps: ['files'], fileRoots: FOLDERS });
    mockState.extensions = [snapshot];
    render(<Detail row={installedOnlyRow({ installed: snapshot })} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Review permissions' }));
    expectFolders(await screen.findByRole('dialog'));
  });
```

Also add `fileRoots: [],` to `extSnapshot`'s defaults in this file and to the snapshot helper in `Marketplace.test.tsx` (~line 66). The update flow renders the same `ConsentModal` branch from the same `ConsentRequest` builder as install, so these two cover it.

- [ ] **Step 2: Run** `npx jest src/renderer/screens/Marketplace` — Expected: FAIL.

- [ ] **Step 3: Implement**

`ConsentRequest`: `fileRoots?: DeclaredFileRoot[];` (import type from `@shared/contracts`) and destructure it. Inside `<div className="cm-perms">`, after the caps/oauth block:

```tsx
            {fileRoots && fileRoots.length > 0 && (
              <div className="cm-folders">
                <div className="cm-perms-label">Reads these folders on your computer</div>
                <div className="cm-caps">
                  {fileRoots.map((r) => (
                    <div key={r.id} className="cm-cap-row elevated">
                      <Icon name="folder" size={14} />
                      <div className="cm-cap-text">
                        <div className="cm-cap-label mono">{r.path}</div>
                        <div className="t-meta">{r.purpose}</div>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="t-meta">The extension can read everything inside these folders.</div>
              </div>
            )}
```

`cap-catalog.ts` `files`:

```ts
  files: {
    label: 'Read approved folders',
    description: 'Read files in the folders listed below.',
    risk: 'elevated',
    icon: 'folder',
  },
```

`Detail.tsx`: add `fileRoots: p.fileRoots,` next to `oauthSources: p.oauthSources,` and `fileRoots: installed.fileRoots,` next to `oauthSources: installed.oauthSources,`.

- [ ] **Step 4: Run** `npx jest src/renderer` — Expected: PASS (fix any cap-catalog snapshot/text assertion that pinned the old `files` copy).

- [ ] **Step 5: Mutation evidence** — drop `fileRoots: p.fileRoots` in Detail → install test red; restore.

- [ ] **Step 6: Commit**

```bash
npx tsc -p tsconfig.typecheck.json && npx eslint src/renderer/components/ConsentModal.tsx src/renderer/components/cap-catalog.ts src/renderer/screens/Marketplace/Detail.tsx
git add -A src/renderer
git commit -m "feat(marketplace): consent modal lists declared folders"
```

### Task A7: Do not project source cursors into AppState

**Files:**
- Modify: `src/main/core/app-projection.ts` (`init` ~l.44, `apply` ~l.70)
- Test: `src/main/core/__tests__/app-projection.test.ts` (append)

- [ ] **Step 1: Failing test** — append to `app-projection.test.ts`:

```ts
describe('account-cursor-not-projected', () => {
  const projection = createAppProjection(extras);
  const withCursor = (id: string, cursor: unknown): Account => ({ ...account(id), cursor });

  it('init strips the cursor', async () => {
    const q = {
      document: jest.fn(async () => null),
      children: jest.fn(async () => []),
      byExternalId: jest.fn(async () => null),
      search: jest.fn(async () => []),
      count: jest.fn(async () => 0),
      accounts: jest.fn(async () => [withCursor('a1', { big: 'x'.repeat(1000) })]),
    } as unknown as Query;
    const s = await projection.init(q);
    expect(s.accounts[0].account.cursor).toBeNull();
    expect(s.accounts[0].account.identifier).toBe('a1@x');
  });

  it('apply strips the cursor on update and on insert', () => {
    const base = {
      accounts: [{ account: account('a1'), docCount: 3, recent: [] }],
      processing: { pending: 0, done: 0, skipped: 0, failed: 0 },
      mcp: { port: null, clients: 0 },
      identity: null,
      prefs: DEFAULT_PREFS,
      extensions: [],
      ready: true,
    };
    const s = projection.apply(base, [
      { seq: 1, kind: 'account', account: withCursor('a1', { n: 1 }) } as Change,
      { seq: 2, kind: 'account', account: withCursor('a2', { n: 2 }) } as Change,
    ]);
    expect(s.accounts.map((a) => a.account.cursor)).toEqual([null, null]);
    expect(s.accounts[0].docCount).toBe(3);
  });
});
```

- [ ] **Step 2: Run** `npx jest src/main/core/__tests__/app-projection.test.ts` — FAIL.

- [ ] **Step 3: Implement** — in `init`: `account: { ...account, cursor: null },`; in `apply`: replace both `c.account` uses with `{ ...c.account, cursor: null }` (define `const projected = { ...c.account, cursor: null };` once). Add a comment: `// Cursors never reach windows: the engine reads them via store.account(); a large source cursor would be cloned to every window per batch.`

- [ ] **Step 4: Run** `npx jest src/main/core src/renderer` + full typecheck — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/core/app-projection.ts src/main/core/__tests__/app-projection.test.ts
git commit -m "perf(core): keep source cursors out of the AppState broadcast"
```

### Task A8: Docs, SDK 1.4.0, full gates

**Files:**
- Modify: `docs/extension-api-reference.md` (manifest `fileRoots` section)
- Modify: `sdk/connector-sdk/package.json` (`version: 1.4.0`, `kiagentCore: 0.91.0`)

- [ ] **Step 1:** In `docs/extension-api-reference.md`, in the manifest section, document `fileRoots` exactly as §3.1–§3.5 state (fields, validation, external-only, consent binding, grant at activation, restart needed for a folder created later, `host.files.roots()` shape). If `src/main/platform/__tests__/connector-authoring-guide.test.ts` pins doc content, run it and update expectations.
- [ ] **Step 2:** Bump the SDK `version` to `1.4.0` and `kiagentCore` to `0.91.0`; run `cd sdk/connector-sdk && npm test` (regenerates contracts from `src/shared`, builds, runs node tests). Expected: PASS and `src/generated/contracts.ts` contains `DeclaredFileRoot` and `fileRootsDigest: string | null`.
- [ ] **Step 3: Full gates** from the worktree root:

```bash
npx tsc -p tsconfig.typecheck.json
npx jest
npx eslint src --ext .ts,.tsx
```

Expected: all green. A failure in a suite untouched by Part A: re-run it alone (known load flakes); if it still fails, check whether it fails on `origin/dev` too before touching it.
- [ ] **Step 4: Commit**

```bash
git add docs/extension-api-reference.md sdk/connector-sdk/package.json sdk/connector-sdk/package-lock.json
git commit -m "docs(platform): fileRoots reference; sdk 1.4.0"
```

---

# Part B — connector repo `agent-sessions-kia-connector`

All paths below are relative to `/Users/edjafarov/work/agent-sessions-kia-connector`. Gates for every Part B task: `npx jest <paths>`, `npm run typecheck`. Part B does not depend on Part A code: it compiles against SDK 1.3.0 (which already types `ScopedFiles`); the SDK and `engine` bump happen in Task C2.

**Fixtures (spec §4.8):** behaviour tests (B5–B8) use inline JSONL records whose shapes were copied from real files on this machine (Claude 2.1.x, Codex 0.155.x current + 2025-08 legacy), so every assertion is exact. Task B9 adds the spec's redacted real captures under `test/fixtures/` (≤ 50 KB each, produced by `scripts/capture-fixture.mjs`, which replaces every free-text string and plants a `DROPPED-SENTINEL` in every field the spec says to drop) and asserts the renderer drops every sentinel and keeps every kept turn. The env-gated real-corpus benchmark (B9) runs on this machine before release.

### Task B1: Scaffold + bounded file access

**Files:**
- Create: `package.json`, `tsconfig.json`, `jest.config.js`, `build.mjs`, `.gitignore`, `LICENSE` (MIT, copy from `../notion-kia-connector/LICENSE`, same holder), `README.md` (stub, finished in B9), `manifest.json`, `icon.png` (copy `../notion-kia-connector/icon.png` as a placeholder — replaced before release in C2), `.github/workflows/ci.yml` (copy `../notion-kia-connector/.github/workflows/ci.yml` verbatim)
- Create: `src/files.ts`, `test/support/fs-files.ts`
- Test: `src/__tests__/files.test.ts`

**Interfaces:**
- Produces (`src/files.ts`):
  ```ts
  export type Files = HostFor<'files'>['files'];
  export interface FileStat { rel: string; name: string; kind: 'file' | 'directory' | 'other'; size: number; mtimeMs: number; dev: string; ino: string }
  export const READ_CHUNK = 4 * 1024 * 1024;
  export const MAX_LINE = 1024 * 1024;
  export const OVERSIZED: unique symbol;
  export function isMissing(e: unknown): boolean;
  export function listDir(files: Files, root: string, rel: string): Promise<FileStat[]>;
  export function readText(files: Files, root: string, rel: string, size: number, cap?: number): Promise<string>;
  export function streamLines(files: Files, root: string, rel: string, size: number,
    opts?: { chunk?: number; maxLine?: number }): AsyncGenerator<string | typeof OVERSIZED>;
  export function firstLine(files: Files, root: string, rel: string, size: number): Promise<string | null>;
  ```
- Produces (`test/support/fs-files.ts`): `fsFiles(roots: Record<string, string>): Files & { reads: Array<{ rel: string; offset: number; maxBytes: number }> }`.

- [ ] **Step 1: Scaffold**

```bash
mkdir -p /Users/edjafarov/work/agent-sessions-kia-connector && cd /Users/edjafarov/work/agent-sessions-kia-connector
git init -b main
mkdir -p src/__tests__ src/claude src/codex test/support .github/workflows
cp ../notion-kia-connector/LICENSE ../notion-kia-connector/icon.png ../notion-kia-connector/build.mjs ../notion-kia-connector/jest.config.js ../notion-kia-connector/tsconfig.json .
cp ../notion-kia-connector/.github/workflows/ci.yml .github/workflows/ci.yml
printf 'node_modules\ndist\n*.tgz\n' > .gitignore
```

`tsconfig.json` — change `"include": ["src"]` to `"include": ["src", "test"]`.

`package.json`:

```json
{
  "name": "agent-sessions-kia-connector",
  "version": "1.0.0",
  "private": true,
  "description": "Claude Code + Codex local session history connector for KIAgent",
  "files": ["manifest.json", "dist", "README.md", "icon.png"],
  "scripts": { "build": "node build.mjs", "test": "jest", "typecheck": "tsc --noEmit" },
  "devDependencies": {
    "@kiagent/connector-sdk": "https://github.com/edjafarov/kiagent-core/releases/download/sdk-v1.3.0/kiagent-connector-sdk-1.3.0.tgz",
    "@types/jest": "^29.5.0",
    "@types/node": "^20.11.0",
    "esbuild": "^0.24.0",
    "jest": "^29.7.0",
    "ts-jest": "^29.2.0",
    "typescript": "^5.6.0"
  }
}
```

`manifest.json`:

```json
{
  "id": "kia.agent-sessions",
  "name": "Agent Sessions",
  "version": "1.0.0",
  "engine": "^2.3.0",
  "entry": "dist/index.js",
  "caps": ["files"],
  "fileRoots": [
    { "id": "claude", "path": "~/.claude", "purpose": "Claude Code sessions, plans, tasks, memory and prompt history" },
    { "id": "codex", "path": "~/.codex", "purpose": "Codex sessions, memory and prompt history" }
  ],
  "contributes": { "sources": ["claude-code", "codex"], "senders": [] },
  "icon": "icon.png"
}
```

Run `npm install`. Expected: lockfile created, no runtime `dependencies`.

- [ ] **Step 2: Test support adapter** — `test/support/fs-files.ts` (a node-fs implementation of the `ScopedFiles` subset the connector uses, plus a read log):

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Files } from '../../src/files';

export function fsFiles(roots: Record<string, string>) {
  const reads: Array<{ rel: string; offset: number; maxBytes: number }> = [];
  const abs = (ref: { root: string; rel: string }): string => {
    const base = roots[ref.root];
    if (!base) throw new Error(`file root ${ref.root} is unknown or revoked`);
    return path.join(base, ref.rel);
  };
  const info = async (p: string) => {
    const st = await fs.lstat(p);
    return {
      kind: st.isSymbolicLink() ? 'other' : st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'other',
      size: st.size, blocks: st.blocks, mtimeMs: st.mtimeMs, dev: String(st.dev), ino: String(st.ino),
      nlink: st.nlink, mode: st.mode, symbolicLink: st.isSymbolicLink(),
    } as const;
  };
  const files = {
    reads,
    async roots() {
      return Object.keys(roots).map((id) => ({ id, name: `~/.${id}`, writable: false }));
    },
    async stat(ref: { root: string; rel: string }) {
      return info(abs(ref));
    },
    async list(ref: { root: string; rel: string }, o: { cursor?: string; limit?: number } = {}) {
      const names = (await fs.readdir(abs(ref))).sort();
      const start = o.cursor ? Number(o.cursor) : 0;
      const limit = o.limit ?? 200;
      const entries = await Promise.all(
        names.slice(start, start + limit).map(async (name) => ({ name, ...(await info(path.join(abs(ref), name))) })),
      );
      return { entries, nextCursor: start + limit < names.length ? String(start + limit) : undefined };
    },
    async read(ref: { root: string; rel: string }, o: { offset?: number; maxBytes?: number } = {}) {
      const maxBytes = o.maxBytes ?? 16 * 1024 * 1024;
      if (maxBytes > 16 * 1024 * 1024) throw new Error('invalid or oversized read');
      reads.push({ rel: ref.rel, offset: o.offset ?? 0, maxBytes });
      const fh = await fs.open(abs(ref), 'r');
      try {
        const buf = Buffer.alloc(maxBytes);
        const { bytesRead } = await fh.read(buf, 0, maxBytes, o.offset ?? 0);
        return new Uint8Array(buf.subarray(0, bytesRead));
      } finally {
        await fh.close();
      }
    },
  };
  return files as unknown as Files & { reads: typeof reads };
}
```

- [ ] **Step 3: Failing tests** — `src/__tests__/files.test.ts`:

```ts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fsFiles } from '../../test/support/fs-files';
import { firstLine, listDir, OVERSIZED, readText, streamLines } from '../files';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'as-files-')); });
afterEach(() => fs.rm(dir, { recursive: true, force: true }));

async function collect(it: AsyncGenerator<string | typeof OVERSIZED>) {
  const out: Array<string | typeof OVERSIZED> = [];
  for await (const x of it) out.push(x);
  return out;
}

it('listDir pages through >1000 entries and returns [] for a missing dir', async () => {
  for (let i = 0; i < 1203; i++) await fs.writeFile(path.join(dir, `f${String(i).padStart(4, '0')}`), '');
  const files = fsFiles({ r: dir });
  const all = await listDir(files, 'r', '');
  expect(all).toHaveLength(1203);
  expect(all[0]).toMatchObject({ name: 'f0000', rel: 'f0000', kind: 'file' });
  expect(await listDir(files, 'r', 'nope')).toEqual([]);
});

it('streams-multi-chunk-file: lines split across chunk boundaries come out whole', async () => {
  const lines = Array.from({ length: 5000 }, (_, i) => JSON.stringify({ i, pad: 'x'.repeat(i % 97) }));
  await fs.writeFile(path.join(dir, 'a.jsonl'), lines.join('\n') + '\n');
  const size = (await fs.stat(path.join(dir, 'a.jsonl'))).size;
  const files = fsFiles({ r: dir });
  const out = await collect(streamLines(files, 'r', 'a.jsonl', size, { chunk: 4096 }));
  expect(out).toEqual(lines);
  expect(files.reads.every((r) => r.maxBytes <= 4096)).toBe(true);
});

it('oversized-record-skipped-without-buffering', async () => {
  const big = JSON.stringify({ type: 'x', out: 'y'.repeat(3 * 1024 * 1024) });
  await fs.writeFile(path.join(dir, 'b.jsonl'), `{"a":1}\n${big}\n{"b":2}\n`);
  const size = (await fs.stat(path.join(dir, 'b.jsonl'))).size;
  const files = fsFiles({ r: dir });
  let peak = 0;
  const out: Array<string | typeof OVERSIZED> = [];
  for await (const x of streamLines(files, 'r', 'b.jsonl', size, { chunk: 256 * 1024, maxLine: 1024 * 1024 })) {
    if (typeof x === 'string') peak = Math.max(peak, x.length);
    out.push(x);
  }
  expect(out).toEqual(['{"a":1}', OVERSIZED, '{"b":2}']);
  expect(peak).toBeLessThanOrEqual(1024 * 1024);
});

it('skips-partial-last-line is left to the parser: an unterminated tail is yielded once', async () => {
  await fs.writeFile(path.join(dir, 'c.jsonl'), '{"a":1}\n{"b":');
  const size = (await fs.stat(path.join(dir, 'c.jsonl'))).size;
  const out = await collect(streamLines(fsFiles({ r: dir }), 'r', 'c.jsonl', size));
  expect(out).toEqual(['{"a":1}', '{"b":']);
});

it('multi-byte UTF-8 split across chunks decodes intact', async () => {
  const line = '日本語テキスト'.repeat(1000);
  await fs.writeFile(path.join(dir, 'u.jsonl'), line + '\n');
  const size = (await fs.stat(path.join(dir, 'u.jsonl'))).size;
  const out = await collect(streamLines(fsFiles({ r: dir }), 'r', 'u.jsonl', size, { chunk: 1001 }));
  expect(out).toEqual([line]);
});

it('readText caps the bytes read; firstLine reads only the first line', async () => {
  await fs.writeFile(path.join(dir, 'p.md'), '# Title\n' + 'z'.repeat(5000));
  const files = fsFiles({ r: dir });
  expect(await readText(files, 'r', 'p.md', 5008, 100)).toHaveLength(100);
  await fs.writeFile(path.join(dir, 'f.jsonl'), '{"first":true}\n{"second":true}\n');
  expect(await firstLine(files, 'r', 'f.jsonl', 31)).toBe('{"first":true}');
});
```

- [ ] **Step 4: Run** `npx jest src/__tests__/files.test.ts` — FAIL (module missing).

- [ ] **Step 5: Implement** `src/files.ts`:

```ts
import type { HostFor } from '@kiagent/connector-sdk';

export type Files = HostFor<'files'>['files'];

export interface FileStat {
  rel: string;
  name: string;
  kind: 'file' | 'directory' | 'other';
  size: number;
  mtimeMs: number;
  dev: string;
  ino: string;
}

export const READ_CHUNK = 4 * 1024 * 1024;
export const MAX_LINE = 1024 * 1024;
export const OVERSIZED: unique symbol = Symbol('oversized');

const joinRel = (a: string, b: string): string => (a ? `${a}/${b}` : b);

/** ScopedFiles errors cross the RPC boundary as plain messages. */
export function isMissing(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /ENOENT|no such file|ENOTDIR|not a directory/i.test(msg);
}

export async function listDir(files: Files, root: string, rel: string): Promise<FileStat[]> {
  const out: FileStat[] = [];
  let cursor: string | undefined;
  do {
    let page;
    try {
      page = await files.list({ root, rel }, { cursor, limit: 1000 });
    } catch (e) {
      if (isMissing(e)) return out;
      throw e;
    }
    for (const e of page.entries)
      out.push({ rel: joinRel(rel, e.name), name: e.name, kind: e.kind, size: e.size, mtimeMs: e.mtimeMs, dev: e.dev, ino: e.ino });
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

export async function readText(files: Files, root: string, rel: string, size: number, cap = 2 * 1024 * 1024): Promise<string> {
  const want = Math.min(size, cap);
  const chunks: Uint8Array[] = [];
  let offset = 0;
  while (offset < want) {
    const bytes = await files.read({ root, rel }, { offset, maxBytes: Math.min(READ_CHUNK, want - offset) });
    if (bytes.length === 0) break;
    chunks.push(bytes);
    offset += bytes.length;
  }
  return new TextDecoder('utf-8').decode(Buffer.concat(chunks));
}

/** Yields whole lines (≤ maxLine chars). A longer line is never buffered:
 *  its bytes are discarded up to the next newline and OVERSIZED is yielded
 *  once in its place. An unterminated final line is yielded as-is (callers
 *  treat unparsable lines as skippable — a file may be mid-write). */
export async function* streamLines(
  files: Files,
  root: string,
  rel: string,
  size: number,
  opts: { chunk?: number; maxLine?: number } = {},
): AsyncGenerator<string | typeof OVERSIZED> {
  const chunk = opts.chunk ?? READ_CHUNK;
  const maxLine = opts.maxLine ?? MAX_LINE;
  const decoder = new TextDecoder('utf-8');
  let offset = 0;
  let buf = '';
  let skipping = false;
  while (offset < size) {
    const bytes = await files.read({ root, rel }, { offset, maxBytes: Math.min(chunk, size - offset) });
    if (bytes.length === 0) break;
    offset += bytes.length;
    const text = decoder.decode(bytes, { stream: true });
    let start = 0;
    for (;;) {
      const nl = text.indexOf('\n', start);
      const piece = nl < 0 ? text.slice(start) : text.slice(start, nl);
      if (skipping) {
        if (nl >= 0) skipping = false;
      } else if (buf.length + piece.length > maxLine) {
        buf = '';
        yield OVERSIZED;
        if (nl < 0) skipping = true;
      } else if (nl >= 0) {
        const line = buf + piece;
        buf = '';
        if (line) yield line;
      } else {
        buf += piece;
      }
      if (nl < 0) break;
      start = nl + 1;
    }
  }
  buf += decoder.decode();
  if (buf && !skipping) yield buf;
}

export async function firstLine(files: Files, root: string, rel: string, size: number): Promise<string | null> {
  // Small chunk: a Codex session_meta line is ~20 KiB; never pull 4 MiB for it.
  for await (const line of streamLines(files, root, rel, size, { chunk: 64 * 1024 })) return typeof line === 'string' ? line : null;
  return null;
}
```

- [ ] **Step 6: Run** tests — PASS. `npm run typecheck` — PASS.

- [ ] **Step 7: Mutation evidence** — remove the `buf.length + piece.length > maxLine` branch → oversized test red; decode each chunk without `{ stream: true }` → UTF-8 test red; restore.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "chore: scaffold agent-sessions connector with bounded file access"
```

### Task B2: Redaction

**Files:** Create `src/redact.ts`; Test `src/__tests__/redact.test.ts`

**Interfaces:** Produces `redact(s: string): string` (idempotent).

- [ ] **Step 1: Failing tests**

```ts
import { redact } from '../redact';

const R = '[redacted]';
it.each([
  ['sk-ant-api03-AbCdEfGhIjKlMnOp1234', `${R}`],
  ['key sk-proj-ABCDEFGHIJKLMNOPQRST1234 end', `key ${R} end`],
  ['ghp_ABCDEFGHIJKLMNOPQRSTuvwx1234', R],
  ['github_pat_11ABCDEFG0123456789_abcdefghij', R],
  ['xoxb-1234567890-abcdefghij', R],
  ['AKIAIOSFODNN7EXAMPLE', R],
  ['AIzaSyA-abcdefghijklmnopqrstuvwxyz01234', R],
  ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', R],
  ['Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123', `Authorization: ${R}`],
])('redact.token %p', (input, expected) => {
  expect(redact(input)).toBe(expected);
});

it('redact.unterminated-pem', () => {
  expect(redact('x\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\nstill key')).toBe('x\n[redacted private key]');
  expect(redact('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\nafter')).toBe('[redacted private key]\nafter');
});

it('redact.quoted-json-key', () => {
  expect(redact('{"password": "hunter2hunter2x"}')).toBe('{"password": "[redacted]"}');
  expect(redact("{'api_key': 'abc123def456ghi'}")).toBe("{'api_key': '[redacted]'}");
});

it('redact.quoted-value-with-spaces', () => {
  expect(redact('DB_PASSWORD="correct horse battery 9"')).toBe('DB_PASSWORD="[redacted]"');
});

it('redact.bare assignment', () => {
  expect(redact('export GITHUB_TOKEN=abc123def456ghi789')).toBe('export GITHUB_TOKEN=[redacted]');
});

it('redact.leaves-type-annotations and prose', () => {
  for (const s of [
    'token: string',
    'password: z.string().min(8)',
    'const apiKey = getKey();',
    'the secret: we ship on Friday',
    'tokenCount = 42',
  ])
    expect(redact(s)).toBe(s);
});

it('is idempotent', () => {
  const once = redact('password="hunter2hunter2x" sk-ant-api03-AbCdEfGhIjKlMnOp1234');
  expect(redact(once)).toBe(once);
});
```

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement** `src/redact.ts`:

```ts
const PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;

const TOKENS: RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{10,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]{5,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g,
];

const KEY = String.raw`[A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)[A-Za-z0-9_.-]*`;
const ASSIGN = new RegExp(
  String.raw`(["']?)(${KEY})\1(\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;}\])]+)`,
  'gi',
);

function looksSecret(value: string): boolean {
  const raw = value.replace(/^["']|["']$/g, '');
  return raw.length >= 12 && /[A-Za-z]/.test(raw) && /\d/.test(raw) && raw !== '[redacted]';
}

/** Safety net, not DLP (spec §4.7). Applied before any truncation. */
export function redact(s: string): string {
  let out = s.replace(PEM, '[redacted private key]');
  for (const re of TOKENS) out = out.replace(re, '[redacted]');
  return out.replace(ASSIGN, (m, q: string, key: string, sep: string, val: string) => {
    if (!looksSecret(val)) return m;
    const masked = val.startsWith('"') ? '"[redacted]"' : val.startsWith("'") ? "'[redacted]'" : '[redacted]';
    return `${q}${key}${q}${sep}${masked}`;
  });
}
```

(The Bearer case: the token rule replaces `Bearer <tok>` with `[redacted]` — matches the test.)

- [ ] **Step 4: Run** — PASS. **Step 5: Mutation** — drop `/\d/.test(raw)` → `leaves-type-annotations` still green but `the secret: we ship…` — add it if not red; drop the `|$` PEM alternative → `unterminated-pem` red; restore.

- [ ] **Step 6: Commit** `git add -A && git commit -m "feat: secret redaction"`

### Task B3: Transcript model, wrapper filter, tool lines, time helpers

**Files:** Create `src/wrappers.ts`, `src/transcript.ts`; Tests `src/__tests__/wrappers.test.ts`, `src/__tests__/transcript.test.ts`

**Interfaces:**
- `classifyUserText(raw: string): { kind: 'keep'; text: string } | { kind: 'drop' }`
- `toolLine(name: string, input: unknown): string`
- `dayKey(ms: number, tz: string): string` (`YYYY-MM-DD`), `hhmm(ms: number, tz: string): string`, `stamp(ms: number, tz: string): string` (`YYYY-MM-DD HH:MM`), `systemTz(): string`, `tildify(p: string): string`
- `class TranscriptBuilder { constructor(tz: string); user(text: string, at?: string): void; assistantText(text: string, at?: string): void; tool(line: string, at?: string): void; marker(text: string): void; readonly firstUserText?: string; body(): string }`
- `interface SessionHeader { title: string; agentLabel: string; cliVersion?: string; cwd?: string; gitBranch?: string; startedAt?: string; resume: string }`
- `renderSession(h: SessionHeader, body: string, tz: string): string`
- `makeTitle(...candidates: Array<string | undefined>): string` (first non-empty first-line, ≤ 80 chars, redacted)
- constants `DOC_BUDGET = 512*1024`, `HALF = 256*1024`, `TURN_CAP = 16*1024`, `SUMMARY_CAP = 160`.

- [ ] **Step 1: Failing tests** — `src/__tests__/wrappers.test.ts`:

```ts
import { classifyUserText } from '../wrappers';

const drop = { kind: 'drop' };
it.each([
  'task-notification', 'system-reminder', 'local-command-caveat', 'local-command-stdout',
  'local-command-stderr', 'bash-stdout', 'bash-stderr', 'user-prompt-submit-hook',
  'environment_context', 'user_instructions', 'recommended_plugins', 'subagent_notification',
  'turn_aborted', 'guardian_tool_descriptions', 'guardian_context_omission',
  'realtime_delegation', 'external_codex_apps_writing_block_edits', 'skill',
])('wrappers.%s-dropped', (tag) => {
  expect(classifyUserText(`<${tag}>\nsome injected body\n</${tag}>`)).toEqual(drop);
});

it('wrappers.case-insensitive-INSTRUCTIONS', () => {
  expect(classifyUserText('<INSTRUCTIONS>do x</INSTRUCTIONS>')).toEqual(drop);
});

it('drops a sequence of allowlisted blocks and whitespace between them', () => {
  expect(classifyUserText('<environment_context>a</environment_context>\n\n<skill>b</skill>')).toEqual(drop);
});

it('wrappers.unknown-tag-kept and multi-block-user-xml-kept', () => {
  const t = '<task>Review X</task>\n<action_safety>careful</action_safety>';
  expect(classifyUserText(t)).toEqual({ kind: 'keep', text: t });
  expect(classifyUserText('<pasted_content>my notes</pasted_content>')).toEqual({
    kind: 'keep', text: '<pasted_content>my notes</pasted_content>',
  });
});

it('renders-slash-command (caveat + command-name/message/args set)', () => {
  const t =
    '<local-command-caveat>Caveat: …</local-command-caveat>\n<command-name>/model</command-name>\n' +
    '<command-message>model</command-message>\n<command-args>opus</command-args>';
  expect(classifyUserText(t)).toEqual({ kind: 'keep', text: '/model opus' });
});

it('renders-bash-input', () => {
  expect(classifyUserText('<bash-input>git status</bash-input>')).toEqual({ kind: 'keep', text: '! git status' });
});

it('drops interruptions and AGENTS.md preambles; keeps plain text', () => {
  expect(classifyUserText('[Request interrupted by user]')).toEqual(drop);
  expect(classifyUserText('# AGENTS.md instructions for /x\n...')).toEqual(drop);
  expect(classifyUserText('  fix the bug  ')).toEqual({ kind: 'keep', text: 'fix the bug' });
  expect(classifyUserText('   ')).toEqual(drop);
});
```

`src/__tests__/transcript.test.ts`:

```ts
import { TranscriptBuilder, dayKey, hhmm, makeTitle, renderSession, toolLine, tildify, HALF, TURN_CAP } from '../transcript';

const TZ = 'Europe/Berlin';

it('toolLine picks the most descriptive field, else the raw first line, capped at 160', () => {
  expect(toolLine('Bash', { command: 'git status -sb', description: 'x' })).toBe('→ Bash: git status -sb');
  expect(toolLine('Edit', { file_path: '/a/b.ts', old_string: 'x' })).toBe('→ Edit: /a/b.ts');
  expect(toolLine('exec_command', '{"cmd":"ls -la"}')).toBe('→ exec_command: ls -la');
  expect(toolLine('exec', 'const r = await tools.exec({})\nmore')).toBe('→ exec: const r = await tools.exec({})');
  expect(toolLine('X', {})).toBe('→ X');
  expect(toolLine('Bash', { command: 'y'.repeat(500) })).toHaveLength('→ Bash: '.length + 160);
});

it('dayKey/hhmm use the given zone', () => {
  const ms = Date.parse('2026-01-01T23:30:00Z');
  expect(dayKey(ms, 'UTC')).toBe('2026-01-01');
  expect(dayKey(ms, TZ)).toBe('2026-01-02');
  expect(hhmm(ms, TZ)).toBe('00:30');
});

it('merges consecutive assistant records into one turn with tool lines', () => {
  const b = new TranscriptBuilder('UTC');
  b.user('hello', '2026-01-01T10:00:00Z');
  b.assistantText('hi', '2026-01-01T10:01:00Z');
  b.tool('→ Bash: ls', '2026-01-01T10:01:05Z');
  b.assistantText('done', '2026-01-01T10:02:00Z');
  expect(b.body()).toBe('## User — 10:00\nhello\n\n## Assistant — 10:01\nhi\n\ndone\n→ Bash: ls');
  expect(b.firstUserText).toBe('hello');
});

it('turn-cut-at-16k', () => {
  const b = new TranscriptBuilder('UTC');
  b.user('a'.repeat(TURN_CAP * 2));
  const body = b.body();
  expect(body.endsWith('… (truncated)')).toBe(true);
  expect(Buffer.byteLength(body)).toBeLessThan(TURN_CAP + 100);
});

it('budget-head-tail-omission', () => {
  const b = new TranscriptBuilder('UTC');
  for (let i = 0; i < 200; i++) b.user(`turn-${i} ` + 'x'.repeat(8000));
  const body = b.body();
  expect(Buffer.byteLength(body)).toBeLessThanOrEqual(2 * HALF + 200);
  expect(body).toContain('turn-0 ');
  expect(body).toContain('turn-199 ');
  expect(body).toMatch(/_… \d+ turns omitted …_/);
});

it('redacts turn text before cutting', () => {
  const b = new TranscriptBuilder('UTC');
  b.user('my key sk-ant-api03-AbCdEfGhIjKlMnOp1234');
  expect(b.body()).toContain('my key [redacted]');
});

it('renderSession header + makeTitle + tildify', () => {
  expect(tildify('/Users/eldar/work/a')).toBe('~/work/a');
  expect(makeTitle(undefined, '  \nFix the login bug\nmore', 'x')).toBe('Fix the login bug');
  expect(makeTitle(undefined, undefined, 'Session 3bd46c2a')).toBe('Session 3bd46c2a');
  const md = renderSession(
    { title: 'T', agentLabel: 'Claude Code', cliVersion: '2.1.267', cwd: '/Users/e/work/a', gitBranch: 'dev',
      startedAt: '2026-09-23T08:02:00Z', resume: 'claude --resume abc' },
    'BODY', 'UTC');
  expect(md).toBe('# T\nAgent: Claude Code 2.1.267 · Project: ~/work/a · Branch: dev\nStarted 2026-09-23 08:02 · Resume: `claude --resume abc`\n\nBODY');
});
```

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement** `src/wrappers.ts`:

```ts
const DROP = new Set(
  [
    // Claude Code
    'task-notification', 'system-reminder', 'local-command-caveat', 'local-command-stdout',
    'local-command-stderr', 'bash-stdout', 'bash-stderr', 'user-prompt-submit-hook',
    // Codex
    'environment_context', 'user_instructions', 'recommended_plugins', 'subagent_notification',
    'turn_aborted', 'instructions', 'guardian_tool_descriptions', 'guardian_context_omission',
    'realtime_delegation', 'external_codex_apps_writing_block_edits', 'skill',
  ].map((t) => t.toLowerCase()),
);
const COMMAND = new Set(['command-name', 'command-message', 'command-args']);
const BLOCK = /<([A-Za-z][A-Za-z0-9_-]*)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/y;

export type Classified = { kind: 'keep'; text: string } | { kind: 'drop' };

/** Explicit allowlist, fail-open: unknown tags and user-authored XML are kept. */
export function classifyUserText(raw: string): Classified {
  const text = raw.trim();
  if (!text) return { kind: 'drop' };
  if (text.startsWith('[Request interrupted') || text.startsWith('# AGENTS.md instructions'))
    return { kind: 'drop' };
  if (!text.startsWith('<')) return { kind: 'keep', text };
  const blocks: Array<{ tag: string; body: string }> = [];
  let pos = 0;
  while (pos < text.length) {
    while (pos < text.length && /\s/.test(text[pos])) pos += 1;
    if (pos >= text.length) break;
    BLOCK.lastIndex = pos;
    const m = BLOCK.exec(text);
    if (!m) return { kind: 'keep', text };
    blocks.push({ tag: m[1].toLowerCase(), body: m[2].trim() });
    pos = BLOCK.lastIndex;
  }
  const tags = blocks.map((b) => b.tag);
  const body = (tag: string) => blocks.find((b) => b.tag === tag)?.body ?? '';
  if (tags.includes('command-name') && tags.every((t) => COMMAND.has(t) || DROP.has(t))) {
    const name = body('command-name');
    const cmd = name.startsWith('/') ? name : `/${name}`;
    const args = body('command-args');
    return { kind: 'keep', text: args ? `${cmd} ${args}` : cmd };
  }
  if (tags.includes('bash-input') && tags.every((t) => t === 'bash-input' || DROP.has(t)))
    return { kind: 'keep', text: `! ${body('bash-input')}` };
  if (tags.every((t) => DROP.has(t))) return { kind: 'drop' };
  return { kind: 'keep', text };
}
```

`src/transcript.ts`:

```ts
import { redact } from './redact';

export const DOC_BUDGET = 512 * 1024;
export const HALF = DOC_BUDGET / 2;
export const TURN_CAP = 16 * 1024;
export const SUMMARY_CAP = 160;
const SUMMARY_KEYS = ['command', 'cmd', 'file_path', 'path', 'pattern', 'description', 'url', 'prompt'];

const bytes = (s: string): number => Buffer.byteLength(s);
const firstLineOf = (s: string): string => s.split('\n').find((l) => l.trim())?.trim() ?? '';

export function systemTz(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}
export function dayKey(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
}
export function hhmm(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
}
export function stamp(ms: number, tz: string): string {
  return `${dayKey(ms, tz)} ${hhmm(ms, tz)}`;
}
export function tildify(p: string): string {
  return p.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~');
}

export function cutBytes(s: string, cap: number, marker = '… (truncated)'): string {
  if (bytes(s) <= cap) return s;
  return Buffer.from(s).subarray(0, cap).toString('utf8').replace(/�$/, '') + '\n' + marker;
}

export function toolLine(name: string, input: unknown): string {
  let obj: unknown = input;
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed === 'object') obj = parsed;
    } catch {
      /* not JSON — raw text */
    }
  }
  let summary = '';
  if (obj && typeof obj === 'object') {
    for (const k of SUMMARY_KEYS) {
      const v = (obj as Record<string, unknown>)[k];
      if (typeof v === 'string' && v.trim()) {
        summary = v;
        break;
      }
    }
  } else if (typeof input === 'string') summary = input;
  summary = redact(firstLineOf(summary)).slice(0, SUMMARY_CAP);
  return summary ? `→ ${name}: ${summary}` : `→ ${name}`;
}

export function makeTitle(...candidates: Array<string | undefined>): string {
  for (const c of candidates) {
    const line = c ? firstLineOf(c) : '';
    if (line) return redact(line).slice(0, 80);
  }
  return 'Session';
}

interface Turn {
  role: 'user' | 'assistant';
  at?: string;
  text: string;
  tools: string[];
}

export class TranscriptBuilder {
  private cur: Turn | null = null;
  private head: string[] = [];
  private headBytes = 0;
  private headFull = false;
  private tail: string[] = [];
  private tailBytes = 0;
  private omitted = 0;
  firstUserText?: string;

  constructor(private readonly tz: string) {}

  user(text: string, at?: string): void {
    this.flush();
    const clean = redact(text);
    if (this.firstUserText === undefined) this.firstUserText = clean;
    this.cur = { role: 'user', at, text: clean, tools: [] };
  }

  assistantText(text: string, at?: string): void {
    const t = this.ensureAssistant(at);
    t.text += (t.text ? '\n\n' : '') + redact(text.trim());
  }

  tool(line: string, at?: string): void {
    this.ensureAssistant(at).tools.push(redact(line));
  }

  marker(text: string): void {
    this.flush();
    this.push(`_${text}_`);
  }

  body(): string {
    this.flush();
    const parts = [...this.head];
    if (this.omitted > 0) parts.push(`_… ${this.omitted} turns omitted …_`);
    parts.push(...this.tail);
    return parts.join('\n\n');
  }

  private ensureAssistant(at?: string): Turn {
    if (this.cur?.role !== 'assistant') {
      this.flush();
      this.cur = { role: 'assistant', at, text: '', tools: [] };
    }
    return this.cur;
  }

  private flush(): void {
    if (!this.cur) return;
    const t = this.cur;
    this.cur = null;
    const when = t.at && !Number.isNaN(Date.parse(t.at)) ? ` — ${hhmm(Date.parse(t.at), this.tz)}` : '';
    const content = [t.text, ...t.tools].filter(Boolean).join('\n');
    this.push(cutBytes(`## ${t.role === 'user' ? 'User' : 'Assistant'}${when}\n${content}`, TURN_CAP));
  }

  private push(s: string): void {
    const n = bytes(s);
    if (!this.headFull && this.headBytes + n <= HALF) {
      this.head.push(s);
      this.headBytes += n;
      return;
    }
    this.headFull = true;
    this.tail.push(s);
    this.tailBytes += n;
    while (this.tailBytes > HALF && this.tail.length > 1) {
      this.tailBytes -= bytes(this.tail.shift() as string);
      this.omitted += 1;
    }
  }
}

export interface SessionHeader {
  title: string;
  agentLabel: string;
  cliVersion?: string;
  cwd?: string;
  gitBranch?: string;
  startedAt?: string;
  resume: string;
}

export function renderSession(h: SessionHeader, body: string, tz: string): string {
  const line1 = [
    `Agent: ${h.agentLabel}${h.cliVersion ? ` ${h.cliVersion}` : ''}`,
    h.cwd ? `Project: ${tildify(h.cwd)}` : '',
    h.gitBranch ? `Branch: ${h.gitBranch}` : '',
  ].filter(Boolean).join(' · ');
  const started = h.startedAt && !Number.isNaN(Date.parse(h.startedAt)) ? `Started ${stamp(Date.parse(h.startedAt), tz)} · ` : '';
  const md = `# ${h.title}\n${line1}\n${started}Resume: \`${h.resume}\`\n\n${body}`;
  return redact(cutBytes(md, DOC_BUDGET + 4096));
}
```

(`renderSession` redacts the whole assembled string once more — the spec's final pass.)

- [ ] **Step 4: Run** both suites — PASS. **Step 5: Mutation** — drop `.map((t) => t.toLowerCase())`/`toLowerCase()` on tags → INSTRUCTIONS red; remove `this.omitted += 1` → budget test red; stop redacting in `user()` → redaction test red; restore.

- [ ] **Step 6: Commit** `git add -A && git commit -m "feat: transcript builder, wrapper filter, tool lines"`

### Task B4: Fingerprint sync engine

**Files:** Create `src/sync.ts`; Test `src/__tests__/sync.test.ts`

**Interfaces:**
- Consumes: `DocumentInput`, `Batch`, `Session` from the SDK; `FileStat` (B1).
- Produces:
  ```ts
  export const RENDER_VERSION = 1;
  export function h(s: string): string;                 // 11-char base64url sha256 prefix
  export interface SyncCursor { v: 1; fps: Record<string, string>; parents: Record<string, string>; pass: 'initial' | 'done'; tz: string }
  export function initialCursor(tz: string): SyncCursor;
  export interface Unit {
    key: string;
    files: Array<Pick<FileStat, 'rel' | 'size' | 'mtimeMs' | 'dev' | 'ino'>>;
    deps?: string[];
    parentH?: string;          // h(parent unit key)
    recordParent?: boolean;    // persist parentH ('' = none) into cursor.parents
    render(): Promise<DocumentInput[]>;
  }
  export function runSync(o: { cursor: SyncCursor; units: Unit[]; session: Pick<Session, 'signal' | 'log'>;
    maxDocs?: number; maxBytes?: number }): AsyncGenerator<Batch<SyncCursor, DocumentInput>>;
  ```

- [ ] **Step 1: Failing tests** — `src/__tests__/sync.test.ts`:

```ts
import type { DocumentInput } from '@kiagent/connector-sdk';
import { fakeSession } from '@kiagent/connector-sdk/testing';
import { h, initialCursor, runSync, type SyncCursor, type Unit } from '../sync';

type Spec = { key: string; mtime?: number; size?: number; ino?: string; parent?: string; fail?: boolean; docs?: number; deps?: string[] };
let renders: string[];
function units(specs: Spec[]): Unit[] {
  return specs.map((s) => ({
    key: s.key,
    files: [{ rel: s.key, size: s.size ?? 10, mtimeMs: s.mtime ?? 1, dev: '1', ino: s.ino ?? '1' }],
    deps: s.deps,
    parentH: s.parent ? h(s.parent) : undefined,
    async render() {
      renders.push(s.key);
      if (s.fail) throw new Error('boom');
      return Array.from({ length: s.docs ?? 1 }, (_, i): DocumentInput => ({
        externalId: `${s.key}#${i}`, type: 'agent.session', title: s.key, markdown: 'm', metadata: {}, createdAt: null,
      }));
    },
  }));
}
async function drain(cursor: SyncCursor, specs: Spec[], opts: { maxDocs?: number; stopAfter?: number } = {}) {
  const batches = [];
  for await (const b of runSync({ cursor, units: units(specs), session: fakeSession(), maxDocs: opts.maxDocs })) {
    batches.push(b);
    if (opts.stopAfter && batches.length >= opts.stopAfter) break; // simulated crash
  }
  return { batches, cursor: batches.at(-1)!.cursor };
}
beforeEach(() => { renders = []; });
const C0 = () => initialCursor('UTC');

it('backfill-then-live-phase and terminal-batch-always', async () => {
  const a = await drain(C0(), [{ key: 'a' }]);
  expect(a.batches.map((b) => b.phase)).toEqual(['backfill']);
  expect(a.cursor.pass).toBe('done');
  const b = await drain(a.cursor, [{ key: 'a' }]);
  expect(b.batches).toEqual([expect.objectContaining({ phase: 'live', items: [] })]);
  expect(renders).toEqual(['a']);
});

it('appended-unit-reprocessed (A at 900 then 1100; B discovered at 1200)', async () => {
  let c = (await drain(C0(), [{ key: 'A', mtime: 900 }])).cursor;
  renders = [];
  c = (await drain(c, [{ key: 'A', mtime: 1100 }, { key: 'B', mtime: 1200 }])).cursor;
  expect(renders.sort()).toEqual(['A', 'B']);
});

it('same-mtime-different-size, inode-change, future-mtime all reprocess', async () => {
  const c = (await drain(C0(), [{ key: 'a' }, { key: 'b' }, { key: 'c' }])).cursor;
  renders = [];
  await drain(c, [{ key: 'a', size: 11 }, { key: 'b', ino: '2' }, { key: 'c', mtime: 9e15 }]);
  expect(renders.sort()).toEqual(['a', 'b', 'c']);
});

it('render-version / deps change re-renders', async () => {
  const c = (await drain(C0(), [{ key: 'a', deps: ['t1'] }])).cursor;
  renders = [];
  await drain(c, [{ key: 'a', deps: ['t2'] }]);
  expect(renders).toEqual(['a']);
});

it('crash-resume-redoes-only-uncommitted', async () => {
  const first = await drain(C0(), [{ key: 'a' }, { key: 'b' }, { key: 'c' }], { maxDocs: 1, stopAfter: 1 });
  renders = [];
  await drain(first.cursor, [{ key: 'a' }, { key: 'b' }, { key: 'c' }]);
  expect(renders).toEqual(['b', 'c']);
});

it('corrupt-unit-committed-and-retried-on-change (+ unchanged tick does not re-read it)', async () => {
  let c = (await drain(C0(), [{ key: 'x', fail: true }])).cursor;
  expect(c.fps[h('x')].startsWith('!')).toBe(true);
  renders = [];
  c = (await drain(c, [{ key: 'x', fail: true }])).cursor;
  expect(renders).toEqual([]);
  await drain(c, [{ key: 'x', mtime: 2 }]);
  expect(renders).toEqual(['x']);
});

it('children-rendered-once-with-new-parent; parent-before-child ordering', async () => {
  const specs = [{ key: 'c:child', parent: 'p' }, { key: 'p' }];
  const c = (await drain(C0(), specs)).cursor;
  expect(renders).toEqual(['p', 'c:child']);
  renders = [];
  await drain(c, specs);
  expect(renders).toEqual([]);
});

it('parent-before-child-across-batch-boundary (same-second pair, batch size 1)', async () => {
  // The child's key sorts FIRST, so only parent-first ordering puts the parent ahead.
  const { batches } = await drain(C0(), [{ key: 'a-child', parent: 'z-parent' }, { key: 'z-parent' }], { maxDocs: 1 });
  expect(batches.flatMap((b) => b.items.map((i) => i.externalId))).toEqual(['z-parent#0', 'a-child#0']);
});

it('late-parent-reemits-children', async () => {
  let c = (await drain(C0(), [{ key: 'kid', parent: 'mom' }])).cursor; // parent not present yet
  renders = [];
  c = (await drain(c, [{ key: 'kid', parent: 'mom' }, { key: 'mom' }])).cursor;
  expect(renders).toEqual(['mom', 'kid']);
});

it('failed-parent-children-reemitted-after-repair', async () => {
  let c = (await drain(C0(), [{ key: 'P', fail: true }, { key: 'C', parent: 'P' }])).cursor;
  renders = [];
  c = (await drain(c, [{ key: 'P', fail: true }, { key: 'C', parent: 'P' }])).cursor;
  expect(renders).toEqual([]);
  await drain(c, [{ key: 'P', mtime: 5 }, { key: 'C', parent: 'P' }]);
  expect(renders).toEqual(['P', 'C']);
});

it('parent-fail-child-commit-crash-repair-resume-links', async () => {
  const specs = [{ key: 'P', fail: true }, { key: 'C', parent: 'P' }];
  const crashed = await drain(C0(), specs, { maxDocs: 1, stopAfter: 1 }); // C committed, then crash
  renders = [];
  await drain(crashed.cursor, [{ key: 'P', mtime: 5 }, { key: 'C', parent: 'P' }]);
  expect(renders).toEqual(['P', 'C']);
});

it('crash-after-parent-commit-reemits-children', async () => {
  const specs = [{ key: 'P' }, { key: 'C', parent: 'P' }];
  const crashed = await drain(C0(), specs, { maxDocs: 1, stopAfter: 1 }); // only P committed
  renders = [];
  await drain(crashed.cursor, specs);
  expect(renders).toEqual(['C']);
});

it('vanished-key-kept-in-fps', async () => {
  const c = (await drain(C0(), [{ key: 'a' }, { key: 'b' }])).cursor;
  const d = (await drain(c, [{ key: 'a' }])).cursor;
  expect(d.fps[h('b')]).toBe(c.fps[h('b')]);
});

it('batch-never-exceeds-25-docs (479-child family); multi-doc unit fp only after its last doc', async () => {
  const specs: Spec[] = [{ key: 'p' }, ...Array.from({ length: 479 }, (_, i) => ({ key: `k${i}`, parent: 'p' }))];
  const { batches } = await drain(C0(), specs);
  expect(Math.max(...batches.map((b) => b.items.length))).toBeLessThanOrEqual(25);
  const multi = await drain(C0(), [{ key: 'hist', docs: 30 }]);
  expect(multi.batches[0].items).toHaveLength(25);
  expect(multi.batches[0].cursor.fps[h('hist')]).toBeUndefined();
  expect(multi.cursor.fps[h('hist')]).toBeDefined();
});

it('batch-never-exceeds-8MiB of markdown', async () => {
  const MiB = 1024 * 1024;
  const big: Unit[] = Array.from({ length: 10 }, (_, i) => ({
    key: `m${i}`,
    files: [{ rel: `m${i}`, size: 1, mtimeMs: 1, dev: '1', ino: '1' }],
    async render() {
      return [{ externalId: `m${i}`, type: 'agent.session', title: 't', markdown: 'x'.repeat(MiB), metadata: {}, createdAt: null }];
    },
  }));
  const sizes: number[] = [];
  for await (const b of runSync({ cursor: C0(), units: big, session: fakeSession() })) sizes.push(b.items.length);
  expect(sizes).toEqual([8, 2]);
});

it('intermediate cursors carry tz', async () => {
  const { batches } = await drain(initialCursor('Asia/Tokyo'), [{ key: 'a' }, { key: 'b' }], { maxDocs: 1 });
  expect(batches.every((b) => b.cursor.tz === 'Asia/Tokyo')).toBe(true);
});
```

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement** `src/sync.ts`:

```ts
import { createHash } from 'node:crypto';
import type { Batch, DocumentInput, PullPhase, Session } from '@kiagent/connector-sdk';
import type { FileStat } from './files';

/** Bump whenever parsing, filtering, redaction or layout changes (spec §4.3). */
export const RENDER_VERSION = 1;
const MAX_DOCS = 25;
const MAX_BYTES = 8 * 1024 * 1024;

export function h(s: string): string {
  return createHash('sha256').update(s).digest('base64url').slice(0, 11);
}

export interface SyncCursor {
  v: 1;
  fps: Record<string, string>;
  parents: Record<string, string>;
  pass: 'initial' | 'done';
  tz: string;
}

export function initialCursor(tz: string): SyncCursor {
  return { v: 1, fps: {}, parents: {}, pass: 'initial', tz };
}

export interface Unit {
  key: string;
  files: Array<Pick<FileStat, 'rel' | 'size' | 'mtimeMs' | 'dev' | 'ino'>>;
  deps?: string[];
  parentH?: string;
  recordParent?: boolean;
  render(): Promise<DocumentInput[]>;
}

const strip = (v: string | undefined): string | undefined => (v?.startsWith('!') ? v.slice(1) : v);
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function* runSync(o: {
  cursor: SyncCursor;
  units: Unit[];
  session: Pick<Session, 'signal' | 'log'>;
  maxDocs?: number;
  maxBytes?: number;
}): AsyncGenerator<Batch<SyncCursor, DocumentInput>> {
  const maxDocs = o.maxDocs ?? MAX_DOCS;
  const maxBytes = o.maxBytes ?? MAX_BYTES;
  const cur = o.cursor;
  const fps = { ...cur.fps };
  const parents = { ...cur.parents };
  const phase: PullPhase = cur.pass === 'initial' ? 'backfill' : 'live';
  const checkpoint = (pass: SyncCursor['pass']): SyncCursor => ({ v: 1, fps: { ...fps }, parents: { ...parents }, pass, tz: cur.tz });

  const byH = new Map<string, Unit & { uh: string }>();
  for (const u of o.units) byH.set(h(u.key), Object.assign(u, { uh: h(u.key) }));
  for (const [uh, u] of byH) if (u.recordParent) parents[uh] = u.parentH ?? '';

  const depth = new Map<string, number>();
  const depthOf = (uh: string, seen: Set<string> = new Set()): number => {
    const known = depth.get(uh);
    if (known !== undefined) return known;
    const p = byH.get(uh)?.parentH;
    let d = 0;
    if (p && byH.has(p) && !seen.has(uh)) {
      seen.add(uh);
      d = depthOf(p, seen) + 1;
    }
    depth.set(uh, d);
    return d;
  };
  const ordered = [...byH.values()].sort(
    (a, b) => depthOf(a.uh) - depthOf(b.uh) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );

  const isOk = (ph: string): boolean => {
    const v = fps[ph];
    return v !== undefined && !v.startsWith('!');
  };
  const base = (u: Unit): string =>
    h(JSON.stringify([RENDER_VERSION, u.files.map((f) => [f.rel, f.size, f.mtimeMs, f.dev, f.ino]), u.deps ?? []]));
  const fpOf = (u: Unit, linked: boolean): string => (u.parentH ? h(`${base(u)}|${linked ? 1 : 0}`) : base(u));

  // Selection: linkedSel is optimistic and never persisted (spec §4.3).
  const selected = new Set<string>();
  for (const u of ordered) {
    const linkedSel = u.parentH ? isOk(u.parentH) || selected.has(u.parentH) : false;
    if (strip(fps[u.uh]) !== fpOf(u, linkedSel)) selected.add(u.uh);
  }

  let items: DocumentInput[] = [];
  let bytes = 0;
  for (const u of ordered) {
    if (!selected.has(u.uh)) continue;
    if (o.session.signal.aborted) return;
    const linkedActual = u.parentH ? isOk(u.parentH) : false;
    let docs: DocumentInput[] = [];
    let ok = true;
    try {
      docs = await u.render();
    } catch (e) {
      ok = false;
      o.session.log('warn', `agent-sessions: ${u.key} skipped: ${errText(e)}`);
    }
    const fp = fpOf(u, linkedActual);
    // A unit's fp enters the map with its LAST document, so the batch that
    // carries that document also carries the fp (never one batch later).
    if (docs.length === 0) fps[u.uh] = ok ? fp : `!${fp}`;
    for (let i = 0; i < docs.length; i++) {
      items.push(docs[i]);
      bytes += Buffer.byteLength(docs[i].markdown ?? '');
      if (i === docs.length - 1) fps[u.uh] = fp;
      if (items.length >= maxDocs || bytes >= maxBytes) {
        yield { phase, items, cursor: checkpoint(cur.pass) };
        items = [];
        bytes = 0;
        if (o.session.signal.aborted) return;
      }
    }
  }
  yield { phase, items, cursor: checkpoint('done') };
}
```

- [ ] **Step 4: Run** — PASS. **Step 5: Mutation** (each must turn a named test red): use `linkedSel` for the committed fp (`parent-fail-child-commit-crash-repair-resume-links`); compare without `strip` (`corrupt-unit…unchanged tick`); sort by key only (`parent-before-child-across-batch-boundary`); set `fps[u.uh]` before pushing docs (`multi-doc unit fp only after its last doc`); set it after the doc loop (`crash-resume-redoes-only-uncommitted`); drop `tz` from `checkpoint` (`intermediate cursors carry tz`); delete vanished keys (`vanished-key-kept-in-fps`). Record the table in the task report.

- [ ] **Step 6: Commit** `git add -A && git commit -m "feat: fingerprint sync engine with parent-first ordering"`

### Task B5: Claude record parser, artifact renderers, prompt days

**Files:**
- Create: `src/doc.ts`, `src/prompts.ts`, `src/claude/session.ts`, `src/claude/artifacts.ts`
- Test: `src/__tests__/claude-session.test.ts`, `src/__tests__/artifacts.test.ts`

**Interfaces:**
- Consumes: `OVERSIZED` (B1); `redact` (B2); `classifyUserText`, `TranscriptBuilder`, `toolLine`, `makeTitle`, `cutBytes`, `dayKey`, `hhmm`, `DOC_BUDGET`, `TURN_CAP` (B3).
- Produces:
  ```ts
  // src/doc.ts
  export type Agent = 'claude-code' | 'codex';
  export const UUID: RegExp;                                   // anchored, case-insensitive
  export function displayPath(root: 'claude' | 'codex', rel: string): string;   // '~/.claude/<rel>'
  export function projectLabel(p: string | undefined): string | undefined;     // last path segment
  export function claudeProjectLabel(dir: string): string;     // '-Users-e-work-a' → 'work-a'
  export function finalize(d: DocumentInput): DocumentInput;   // redact title/markdown/metadata strings, drop empty metadata
  export function parseJson(line: string): Record<string, any> | null;
  export const str: (v: unknown) => string | undefined;        // non-empty string or undefined
  // src/prompts.ts
  export interface PromptRow { atMs: number; text: string; project?: string; sessionId?: string }
  export function claudePromptRow(r: Record<string, any>): PromptRow | null;  // {display, timestamp ms, project, sessionId}
  export function codexPromptRow(r: Record<string, any>): PromptRow | null;   // {text, ts seconds, session_id}
  export function renderPromptDays(rows: PromptRow[], tz: string, agent: Agent, sourcePath: string): DocumentInput[];
  // src/claude/session.ts
  export interface ClaudeSessionInfo { title?: string; cwd?: string; gitBranch?: string; cliVersion?: string; model?: string; startedAt?: string; firstUser?: string; body: string }
  export function parseClaudeSession(lines: AsyncIterable<string | typeof OVERSIZED>, tz: string): Promise<ClaudeSessionInfo>;
  // src/claude/artifacts.ts
  export function renderTasks(listId: string, taskJsons: string[], createdAtMs: number, sourcePath: string): DocumentInput;
  export function renderPlan(name: string, text: string, mtimeMs: number, sourcePath: string): DocumentInput;
  export function renderMemory(agent: Agent, rel: string, label: string | undefined, text: string, mtimeMs: number, sourcePath: string): DocumentInput;
  ```

- [ ] **Step 1: Failing tests** — `src/__tests__/claude-session.test.ts` (record shapes copied from Claude Code 2.1.x files on this machine):

```ts
import { OVERSIZED } from '../files';
import { parseClaudeSession } from '../claude/session';

async function* lines(recs: unknown[]): AsyncGenerator<string | typeof OVERSIZED> {
  for (const r of recs) yield r === OVERSIZED ? OVERSIZED : typeof r === 'string' ? r : JSON.stringify(r);
}
const u = (content: unknown, extra: object = {}) => ({
  type: 'user', timestamp: '2026-09-23T10:02:00Z', cwd: '/Users/e/work/a', gitBranch: 'dev', version: '2.1.267',
  isSidechain: false, sessionId: 's', message: { role: 'user', content }, ...extra,
});
const a = (content: unknown[], extra: object = {}) => ({
  type: 'assistant', timestamp: '2026-09-23T10:03:00Z', isSidechain: false,
  message: { role: 'assistant', model: 'claude-opus-5-5', content }, ...extra,
});
const parse = (recs: unknown[]) => parseClaudeSession(lines(recs), 'UTC');

it('claude.session.turns-and-tool-lines (+ metadata)', async () => {
  const s = await parse([
    { type: 'permission-mode', permissionMode: 'default', sessionId: 's' },
    u('fix the login bug'),
    a([{ type: 'text', text: 'On it' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git status -sb' } }]),
  ]);
  expect(s.body).toBe('## User — 10:02\nfix the login bug\n\n## Assistant — 10:03\nOn it\n→ Bash: git status -sb');
  expect(s).toMatchObject({ cwd: '/Users/e/work/a', gitBranch: 'dev', cliVersion: '2.1.267', model: 'claude-opus-5-5',
    startedAt: '2026-09-23T10:02:00Z', firstUser: 'fix the login bug' });
});

it('claude.session.drops-tool-results', async () => {
  const s = await parse([u('go'), u([{ type: 'tool_result', tool_use_id: 't1', content: 'TOOL-OUTPUT' }])]);
  expect(s.body).not.toContain('TOOL-OUTPUT');
  expect(s.body).toBe('## User — 10:02\ngo');
});

it('claude.session.drops-thinking-and-attachments', async () => {
  const s = await parse([
    u('go'),
    { type: 'attachment', timestamp: '2026-09-23T10:02:30Z', attachment: { content: 'ATTACHED' } },
    { type: 'system', subtype: 'x', content: 'SYSTEM', isMeta: false },
    a([{ type: 'thinking', thinking: 'HIDDEN' }, { type: 'redacted_thinking', data: 'ENC' }, { type: 'text', text: 'ok' }]),
  ]);
  for (const s2 of ['ATTACHED', 'SYSTEM', 'HIDDEN', 'ENC']) expect(s.body).not.toContain(s2);
  expect(s.body).toContain('ok');
});

it('claude.session.drops-compact-summary and drops-array-form-isMeta', async () => {
  const s = await parse([
    u('This session is being continued… COMPACT-TEXT', { isCompactSummary: true }),
    u([{ type: 'text', text: 'META-TEXT' }], { isMeta: true }),
    u('real'),
  ]);
  expect(s.body).toBe('## User — 10:02\nreal');
});

it('claude.session.renders-slash-command and renders-bash-input', async () => {
  const s = await parse([
    u('<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>'),
    u('<local-command-stdout>Set model to opus</local-command-stdout>'),
    u('<bash-input>ls</bash-input>'),
    u('<bash-stdout>a b</bash-stdout><bash-stderr></bash-stderr>'),
  ]);
  expect(s.body).toBe('## User — 10:02\n/model opus\n\n## User — 10:02\n! ls');
});

it('claude.session.title-last-ai-title', async () => {
  const s = await parse([
    { type: 'ai-title', aiTitle: 'First guess', sessionId: 's' }, u('x'),
    { type: 'ai-title', aiTitle: 'Final title', sessionId: 's' },
  ]);
  expect(s.title).toBe('Final title');
});

it('claude.session.subagent-not-emptied-by-sidechain', async () => {
  const s = await parse([u('Review task 7', { isSidechain: true }), a([{ type: 'text', text: 'LGTM' }], { isSidechain: true })]);
  expect(s.body).toContain('Review task 7');
  expect(s.body).toContain('LGTM');
});

it('oversized marker in place; unparsable and interrupted lines skipped', async () => {
  const s = await parse([u('a'), OVERSIZED, '{"type":"us', u('[Request interrupted by user]'), a([{ type: 'text', text: 'b' }])]);
  expect(s.body).toBe('## User — 10:02\na\n\n_… (1 oversized record skipped)_\n\n## Assistant — 10:03\nb');
});
```

`src/__tests__/artifacts.test.ts`:

```ts
import { renderMemory, renderPlan, renderTasks } from '../claude/artifacts';
import { claudePromptRow, codexPromptRow, renderPromptDays } from '../prompts';
import { claudeProjectLabel, finalize } from '../doc';

const SID = '3ecab6cc-0180-4a43-b16c-3596c0de2aab';

it('claude.tasks.checklist-order (numeric id) + parent for a session-shaped list id', () => {
  const t = (id: string, subject: string, status: string, description = '') =>
    JSON.stringify({ id, subject, description, status, blocks: [], blockedBy: [] });
  const d = renderTasks(SID, [t('10', 'ten', 'pending'), t('2', 'two', 'completed', 'done it'), t('1', 'one', 'in_progress')], 5, '~/.claude/tasks/x');
  expect(d.markdown).toBe('# Tasks — 3ecab6cc\n\n- [ ] one\n- [x] two — done it\n- [ ] ten');
  expect(d).toMatchObject({ externalId: `tasks:${SID}`, type: 'agent.tasks', title: 'Tasks — 3ecab6cc',
    parent: { externalId: `session:${SID}`, type: 'agent.session' }, createdAt: new Date(5).toISOString() });
  expect(renderTasks('team-x', [t('1', 'a', 'pending')], 5, 'p').parent).toBeUndefined();
});

it('redact.applied-to-task-bodies', () => {
  const d = renderTasks('l', [JSON.stringify({ id: '1', subject: 'rotate', description: 'old key sk-ant-api03-AbCdEfGhIjKlMnOp1234', status: 'pending' })], 1, 'p');
  expect(d.markdown).toContain('old key [redacted]');
});

it('plan title from first heading, else file name', () => {
  expect(renderPlan('spicy-wall.md', 'intro\n# Ship the thing\nbody', 7, 'p')).toMatchObject({
    externalId: 'plan:spicy-wall.md', type: 'agent.plan', title: 'Ship the thing', markdown: 'intro\n# Ship the thing\nbody' });
  expect(renderPlan('x.md', 'no heading', 7, 'p').title).toBe('x.md');
});

it('claude.memory.txt-and-md titles', () => {
  const rel = 'projects/-Users-e-work-alpha-cent/memory/notes.txt';
  const d = renderMemory('claude-code', rel, claudeProjectLabel('-Users-e-work-alpha-cent'), 'hello', 9, `~/.claude/${rel}`);
  expect(d).toMatchObject({ externalId: `memory:${rel}`, type: 'agent.memory', title: 'work-alpha-cent — notes.txt', markdown: 'hello' });
  expect(renderMemory('claude-code', 'CLAUDE.md', undefined, 'x', 9, '~/.claude/CLAUDE.md').title).toBe('CLAUDE.md');
});

it('claude.prompts.day-in-cursor-tz-ms + drops-pasted + applied-to-prompt-lines', () => {
  const ms = Date.parse('2026-01-01T23:30:00Z');
  const row = claudePromptRow({ display: 'deploy with TOKEN=abc123def456ghi789', pastedContents: { 1: 'PASTED' },
    timestamp: ms, project: '/Users/e/work/alpha-cent', sessionId: SID })!;
  const [utc] = renderPromptDays([row], 'UTC', 'claude-code', '~/.claude/history.jsonl');
  expect(utc).toMatchObject({ externalId: 'prompts:2026-01-01', type: 'agent.prompts', title: 'Prompts — 2026-01-01',
    createdAt: new Date(ms).toISOString() });
  expect(utc.markdown).toBe('# Prompts — 2026-01-01\n\n- 23:30 · alpha-cent · deploy with TOKEN=[redacted] · session 3ecab6cc');
  expect(utc.markdown).not.toContain('PASTED');
  const [berlin] = renderPromptDays([row], 'Europe/Berlin', 'claude-code', 'p');
  expect(berlin.externalId).toBe('prompts:2026-01-02');
});

it('codex.prompts.day-in-cursor-tz-seconds', () => {
  const row = codexPromptRow({ session_id: 'c45386b3-bcb6-42ed-af4e-64edd763b00b', ts: 1756030813, text: 'check the git changes' })!;
  expect(row.atMs).toBe(1756030813000);
  const [d] = renderPromptDays([row], 'UTC', 'codex', '~/.codex/history.jsonl');
  expect(d.externalId).toBe('prompts:2025-08-24');
  expect(d.markdown).toContain('- 10:20 · check the git changes · session c45386b3');
});

it('prompt rows: multi-line display flattened; days sorted; malformed rows rejected', () => {
  expect(claudePromptRow({ display: 'a\n\nb', timestamp: 1 })!.text).toBe('a b');
  expect(claudePromptRow({ display: 'x' })).toBeNull();
  expect(codexPromptRow({ text: 'x', ts: 'soon' })).toBeNull();
  const docs = renderPromptDays(
    [{ atMs: Date.parse('2026-01-02T01:00:00Z'), text: 'b' }, { atMs: Date.parse('2026-01-01T01:00:00Z'), text: 'a' }],
    'UTC', 'codex', 'p');
  expect(docs.map((d) => d.externalId)).toEqual(['prompts:2026-01-01', 'prompts:2026-01-02']);
});

it('redact.applied-to-metadata|titles (finalize)', () => {
  const d = finalize({ externalId: 'e', type: 't', title: 'key sk-ant-api03-AbCdEfGhIjKlMnOp1234', markdown: null,
    metadata: { cwd: '/x/ghp_ABCDEFGHIJKLMNOPQRSTuvwx1234', empty: '', none: undefined, n: 3 }, createdAt: null });
  expect(d.title).toBe('key [redacted]');
  expect(d.metadata).toEqual({ cwd: '/x/[redacted]', n: 3 });
});
```

- [ ] **Step 2: Run** `npx jest src/__tests__/claude-session.test.ts src/__tests__/artifacts.test.ts` — FAIL (modules missing).

- [ ] **Step 3: Implement** `src/doc.ts`:

```ts
import type { DocumentInput } from '@kiagent/connector-sdk';
import { redact } from './redact';

export type Agent = 'claude-code' | 'codex';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

export function parseJson(line: string): Record<string, any> | null {
  try {
    const v = JSON.parse(line);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export function displayPath(root: 'claude' | 'codex', rel: string): string {
  return rel ? `~/.${root}/${rel}` : `~/.${root}`;
}

export function projectLabel(p: string | undefined): string | undefined {
  return p?.split('/').filter(Boolean).pop();
}

/** Claude names project dirs by replacing '/' with '-' in the cwd. */
export function claudeProjectLabel(dir: string): string {
  return dir.replace(/^-(?:Users|home)-[^-]+-/, '') || dir;
}

/** The final redaction pass over every emitted string (spec §4.7). */
export function finalize(d: DocumentInput): DocumentInput {
  const metadata: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d.metadata)) {
    if (v === undefined || v === null || v === '') continue;
    metadata[k] = typeof v === 'string' ? redact(v) : v;
  }
  return {
    ...d,
    title: d.title === null ? null : redact(d.title),
    markdown: d.markdown === null ? null : redact(d.markdown),
    metadata,
  };
}
```

`src/prompts.ts`:

```ts
import type { DocumentInput } from '@kiagent/connector-sdk';
import { finalize, projectLabel, str, type Agent } from './doc';
import { redact } from './redact';
import { cutBytes, dayKey, DOC_BUDGET, hhmm, TURN_CAP } from './transcript';

export interface PromptRow {
  atMs: number;
  text: string;
  project?: string;
  sessionId?: string;
}

const flat = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Claude `history.jsonl`: `{display, pastedContents, timestamp (ms), project, sessionId?}`. */
export function claudePromptRow(r: Record<string, any>): PromptRow | null {
  if (typeof r.timestamp !== 'number' || !str(r.display)) return null;
  return { atMs: r.timestamp, text: flat(r.display), project: str(r.project), sessionId: str(r.sessionId) };
}

/** Codex `history.jsonl`: `{session_id, ts (seconds), text}`. */
export function codexPromptRow(r: Record<string, any>): PromptRow | null {
  if (typeof r.ts !== 'number' || !str(r.text)) return null;
  return { atMs: r.ts * 1000, text: flat(r.text), sessionId: str(r.session_id) };
}

export function renderPromptDays(rows: PromptRow[], tz: string, agent: Agent, sourcePath: string): DocumentInput[] {
  const days = new Map<string, PromptRow[]>();
  for (const r of rows) {
    const day = dayKey(r.atMs, tz);
    const list = days.get(day) ?? [];
    list.push(r);
    days.set(day, list);
  }
  return [...days.keys()].sort().map((day) => {
    const list = (days.get(day) as PromptRow[]).sort((x, y) => x.atMs - y.atMs);
    const lines = list.map((r) =>
      '- ' +
      [hhmm(r.atMs, tz), projectLabel(r.project), cutBytes(redact(r.text), TURN_CAP), r.sessionId ? `session ${r.sessionId.slice(0, 8)}` : undefined]
        .filter(Boolean)
        .join(' · '),
    );
    const title = `Prompts — ${day}`;
    return finalize({
      externalId: `prompts:${day}`,
      type: 'agent.prompts',
      title,
      markdown: cutBytes(`# ${title}\n\n${lines.join('\n')}`, DOC_BUDGET),
      metadata: { agent, sourcePath },
      createdAt: new Date(list[0].atMs).toISOString(),
    });
  });
}
```

`src/claude/session.ts`:

```ts
import { OVERSIZED } from '../files';
import { parseJson, str } from '../doc';
import { TranscriptBuilder, toolLine } from '../transcript';
import { classifyUserText } from '../wrappers';

export interface ClaudeSessionInfo {
  title?: string;
  cwd?: string;
  gitBranch?: string;
  cliVersion?: string;
  model?: string;
  startedAt?: string;
  firstUser?: string;
  body: string;
}

function userText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((p) => p?.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('\n');
}

export async function parseClaudeSession(
  lines: AsyncIterable<string | typeof OVERSIZED>,
  tz: string,
): Promise<ClaudeSessionInfo> {
  const b = new TranscriptBuilder(tz);
  const info: Omit<ClaudeSessionInfo, 'body'> = {};
  for await (const line of lines) {
    if (line === OVERSIZED) {
      b.marker('… (1 oversized record skipped)');
      continue;
    }
    const r = parseJson(line);
    if (!r) continue;
    if (r.type === 'ai-title') {
      info.title = str(r.aiTitle) ?? info.title;
      continue;
    }
    // Record-level exclusions first (spec §4.5 step 1). isSidechain is NOT a filter.
    if ((r.type !== 'user' && r.type !== 'assistant') || r.isMeta || r.isCompactSummary) continue;
    info.cwd ??= str(r.cwd);
    info.gitBranch ??= str(r.gitBranch);
    info.cliVersion ??= str(r.version);
    info.startedAt ??= str(r.timestamp);
    const at = str(r.timestamp);
    const content = r.message?.content;
    if (r.type === 'user') {
      const c = classifyUserText(userText(content));
      if (c.kind === 'keep') b.user(c.text, at);
      continue;
    }
    info.model ??= str(r.message?.model);
    if (!Array.isArray(content)) continue;
    for (const p of content) {
      if (p?.type === 'text' && typeof p.text === 'string' && p.text.trim()) b.assistantText(p.text, at);
      else if (p?.type === 'tool_use' && typeof p.name === 'string') b.tool(toolLine(p.name, p.input), at);
    }
  }
  return { ...info, firstUser: b.firstUserText, body: b.body() };
}
```

`src/claude/artifacts.ts`:

```ts
import type { DocumentInput } from '@kiagent/connector-sdk';
import { finalize, parseJson, str, UUID, type Agent } from '../doc';
import { redact } from '../redact';
import { cutBytes, DOC_BUDGET } from '../transcript';

export function renderTasks(listId: string, taskJsons: string[], createdAtMs: number, sourcePath: string): DocumentInput {
  const tasks = taskJsons
    .map(parseJson)
    .filter((t): t is Record<string, any> => !!t && str(t.subject) !== undefined)
    .sort((x, y) => Number(x.id) - Number(y.id) || String(x.id).localeCompare(String(y.id)));
  const title = `Tasks — ${listId.slice(0, 8)}`;
  const lines = tasks.map((t) => {
    const desc = str(t.description);
    return `- [${t.status === 'completed' ? 'x' : ' '}] ${redact(t.subject)}${desc ? ` — ${redact(desc)}` : ''}`;
  });
  return finalize({
    externalId: `tasks:${listId}`,
    type: 'agent.tasks',
    title,
    markdown: cutBytes(`# ${title}\n\n${lines.join('\n')}`, DOC_BUDGET),
    metadata: { agent: 'claude-code', sessionId: UUID.test(listId) ? listId : undefined, sourcePath },
    createdAt: new Date(createdAtMs).toISOString(),
    ...(UUID.test(listId) ? { parent: { externalId: `session:${listId}`, type: 'agent.session' } } : {}),
  });
}

export function renderPlan(name: string, text: string, mtimeMs: number, sourcePath: string): DocumentInput {
  const heading = /^# (.+)$/m.exec(text)?.[1]?.trim();
  return finalize({
    externalId: `plan:${name}`,
    type: 'agent.plan',
    title: heading || name,
    markdown: cutBytes(redact(text), DOC_BUDGET),
    metadata: { agent: 'claude-code', sourcePath },
    createdAt: new Date(mtimeMs).toISOString(),
  });
}

export function renderMemory(agent: Agent, rel: string, label: string | undefined, text: string, mtimeMs: number, sourcePath: string): DocumentInput {
  const name = rel.split('/').pop() as string;
  return finalize({
    externalId: `memory:${rel}`,
    type: 'agent.memory',
    title: label ? `${label} — ${name}` : name,
    markdown: cutBytes(redact(text), DOC_BUDGET),
    metadata: { agent, sourcePath },
    createdAt: new Date(mtimeMs).toISOString(),
  });
}
```

- [ ] **Step 4: Run** — PASS. `npm run typecheck` — PASS.

- [ ] **Step 5: Mutation evidence** — remove the `r.isMeta` check → `drops-array-form-isMeta` red; accept `tool_result` parts in `userText` → `drops-tool-results` red; `??=` instead of `=` for `ai-title` → `title-last-ai-title` red; `r.ts` without `* 1000` → `day-in-cursor-tz-seconds` red; filter on `!r.isSidechain` → `subagent-not-emptied-by-sidechain` red; sort tasks lexically → `checklist-order` red.

- [ ] **Step 6: Commit** `git add -A && git commit -m "feat: Claude record parser, artifact renderers, prompt days"`

### Task B6: Shared source shell + Claude discovery and source

**Files:**
- Create: `src/source.ts`, `src/claude/source.ts`
- Test: `src/__tests__/claude-source.test.ts`

**Interfaces:**
- Consumes: B1 `Files`, `listDir`, `readText`, `streamLines`, `FileStat`; B4 `runSync`, `initialCursor`, `h`, `Unit`, `SyncCursor`; B5 renderers; B3 `renderSession`, `makeTitle`, `systemTz`.
- Produces:
  ```ts
  // src/source.ts
  export interface SourceOpts { tz?: () => string; maxDocs?: number }
  export function missingRootMessage(root: 'claude' | 'codex'): string;
  export function makeSource(o: {
    id: 'claude-code' | 'codex'; name: string; root: 'claude' | 'codex'; documentTypes: string[];
    files: Files; opts?: SourceOpts;
    discover(files: Files, cursor: SyncCursor): Promise<Unit[]>;
  }): Source<SyncCursor, DocumentInput>;
  export function walkText(files: Files, root: string, rel: string): Promise<FileStat[]>;  // .md/.txt files, recursive
  export function historyUnit(files: Files, root: 'claude' | 'codex', f: FileStat, agent: Agent, tz: string,
    toRow: (r: Record<string, any>) => PromptRow | null): Unit;
  export function memoryUnit(files: Files, root: 'claude' | 'codex', f: FileStat, agent: Agent, label: string | undefined): Unit;
  // src/claude/source.ts
  export const CLAUDE_TYPES: string[];
  export function discoverClaude(files: Files, cursor: SyncCursor): Promise<Unit[]>;
  export function claudeSource(files: Files, opts?: SourceOpts): Source<SyncCursor, DocumentInput>;
  ```

- [ ] **Step 1: Failing tests** — `src/__tests__/claude-source.test.ts`:

```ts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DocumentInput, Source } from '@kiagent/connector-sdk';
import { fakeSession } from '@kiagent/connector-sdk/testing';
import { fsFiles } from '../../test/support/fs-files';
import { claudeSource } from '../claude/source';
import type { SyncCursor } from '../sync';

const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const PROJ = 'projects/-Users-e-work-alpha-cent';
let root: string;

const rec = (type: 'user' | 'assistant', text: string, extra: object = {}) =>
  JSON.stringify({
    type, timestamp: '2026-09-23T10:02:00Z', cwd: '/Users/e/work/alpha-cent', gitBranch: 'dev', version: '2.1.267',
    message: type === 'user' ? { role: 'user', content: text } : { role: 'assistant', model: 'm', content: [{ type: 'text', text }] },
    ...extra,
  }) + '\n';
async function put(rel: string, body: string) {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await fs.writeFile(path.join(root, rel), body);
}
async function pull(src: Source<SyncCursor, DocumentInput>, cursor: SyncCursor | null, stopAfter?: number) {
  const docs: DocumentInput[] = [];
  let last: SyncCursor | null = cursor;
  let n = 0;
  for await (const b of src.pull(fakeSession(), cursor)) {
    docs.push(...b.items);
    last = b.cursor;
    if (stopAfter && ++n >= stopAfter) break;
  }
  return { docs, cursor: last as SyncCursor, ids: docs.map((d) => d.externalId) };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'as-claude-'));
  await put(`${PROJ}/${S1}.jsonl`, rec('user', 'fix login') + rec('assistant', 'done') + JSON.stringify({ type: 'ai-title', aiTitle: 'Login fix' }) + '\n');
  await put(`${PROJ}/${S1}/subagents/agent-a1.jsonl`, rec('user', 'review it', { isSidechain: true }) + rec('assistant', 'LGTM', { isSidechain: true }));
  await put(`${PROJ}/${S1}/subagents/agent-a1.meta.json`, JSON.stringify({ agentType: 'general-purpose', description: 'Review task 7' }));
  await put(`${PROJ}/${S2}/subagents/agent-a2.jsonl`, rec('user', 'orphan work', { isSidechain: true }));
  await put(`${PROJ}/memory/MEMORY.md`, '- index');
  await put(`${PROJ}/memory/notes.txt`, 'notes');
  await put(`${PROJ}/memory/img.png`, 'png');
  await put(`tasks/${S1}/1.json`, JSON.stringify({ id: '1', subject: 'write spec', status: 'completed' }));
  await put(`tasks/${S1}/.lock`, '');
  await put('tasks/lockonly/.lock', '');
  await put('tasks/lockonly/.highwatermark', '3');
  await put('plans/spicy-wall.md', '# Ship it\nbody');
  await put('CLAUDE.md', 'global rules');
  await put('history.jsonl', JSON.stringify({ display: 'fix login', timestamp: Date.parse('2026-09-23T10:02:00Z'), project: '/Users/e/work/alpha-cent', sessionId: S1 }) + '\n');
});
afterEach(() => fs.rm(root, { recursive: true, force: true }));

const source = (tz = 'UTC', maxDocs?: number) => claudeSource(fsFiles({ claude: root }), { tz: () => tz, maxDocs });

it('emits every Claude document type into one stream with parent links', async () => {
  const { docs, ids } = await pull(source(), null);
  expect(ids.sort()).toEqual([
    `memory:${PROJ}/memory/MEMORY.md`, `memory:${PROJ}/memory/notes.txt`, 'memory:CLAUDE.md',
    'plan:spicy-wall.md', 'prompts:2026-09-23',
    `session:${S1}`, `session:${S1}/a1`, `session:${S2}/a2`, `tasks:${S1}`,
  ].sort());
  const byId = new Map(docs.map((d) => [d.externalId, d]));
  expect(byId.get(`session:${S1}`)).toMatchObject({ type: 'agent.session', title: 'Login fix',
    metadata: expect.objectContaining({ agent: 'claude-code', role: 'main', sessionId: S1, cwd: '/Users/e/work/alpha-cent' }) });
  expect(byId.get(`session:${S1}`)!.markdown).toContain('Resume: `claude --resume 11111111-1111-4111-8111-111111111111`');
  expect(byId.get(`session:${S1}/a1`)).toMatchObject({ title: 'Review task 7', parent: { externalId: `session:${S1}`, type: 'agent.session' },
    metadata: expect.objectContaining({ role: 'subagent', parentSessionId: S1 }) });
  expect(byId.get(`tasks:${S1}`)!.parent).toEqual({ externalId: `session:${S1}`, type: 'agent.session' });
  expect(ids.indexOf(`session:${S1}`)).toBeLessThan(ids.indexOf(`session:${S1}/a1`));
});

it('claude.orphan-subagent-renders (parent .jsonl removed by cleanup)', async () => {
  const { docs } = await pull(source(), null);
  const orphan = docs.find((d) => d.externalId === `session:${S2}/a2`)!;
  expect(orphan.markdown).toContain('orphan work');
  expect(orphan.parent).toEqual({ externalId: `session:${S2}`, type: 'agent.session' });
});

it('claude.lock-only-tasks-dir-no-unit', async () => {
  expect((await pull(source(), null)).ids).not.toContain('tasks:lockonly');
});

it('unchanged tick emits nothing; an append re-emits only that session', async () => {
  const first = await pull(source(), null);
  expect((await pull(source(), first.cursor)).ids).toEqual([]);
  await fs.appendFile(path.join(root, `${PROJ}/${S1}.jsonl`), rec('user', 'one more'));
  expect((await pull(source(), first.cursor)).ids).toEqual([`session:${S1}`]);
});

it('sync.task-edit-after-session-cleanup-keeps-parent-ref', async () => {
  const first = await pull(source(), null);
  await fs.rm(path.join(root, `${PROJ}/${S1}.jsonl`));
  await put(`tasks/${S1}/1.json`, JSON.stringify({ id: '1', subject: 'write spec v2', status: 'completed' }));
  const next = await pull(source(), first.cursor);
  const t = next.docs.find((d) => d.externalId === `tasks:${S1}`)!;
  expect(t.parent).toEqual({ externalId: `session:${S1}`, type: 'agent.session' });
});

it('sync.readd-source-keeps-cursor-tz and system-tz-change-does-not-regroup', async () => {
  await put('history.jsonl', JSON.stringify({ display: 'late', timestamp: Date.parse('2026-01-01T23:30:00Z') }) + '\n');
  const first = await pull(source('UTC'), null);
  expect(first.cursor.tz).toBe('UTC');
  expect(first.ids).toContain('prompts:2026-01-01');
  await fs.appendFile(path.join(root, 'history.jsonl'), JSON.stringify({ display: 'later', timestamp: Date.parse('2026-01-01T23:40:00Z') }) + '\n');
  const next = await pull(source('Europe/Berlin'), first.cursor); // OS zone changed / source re-added
  expect(next.ids).toEqual(['prompts:2026-01-01']);
  expect(next.cursor.tz).toBe('UTC');
});

it('sync.intermediate-batch-crash-then-zone-change-keeps-tz', async () => {
  const rows = Array.from({ length: 30 }, (_, i) =>
    JSON.stringify({ display: `p${i}`, timestamp: Date.parse(`2026-03-${String(i + 1).padStart(2, '0')}T23:30:00Z`) })).join('\n');
  await put('history.jsonl', rows + '\n');
  const crashed = await pull(source('UTC', 5), null, 1);
  expect(crashed.cursor.pass).toBe('initial');
  const resumed = await pull(source('Asia/Tokyo'), crashed.cursor);
  expect(resumed.cursor.tz).toBe('UTC');
  const all = new Set([...crashed.ids, ...resumed.ids].filter((i) => i.startsWith('prompts:')));
  expect(all).toEqual(new Set(Array.from({ length: 30 }, (_, i) => `prompts:2026-03-${String(i + 1).padStart(2, '0')}`)));
});

it('connect.missing-root-message (claude)', async () => {
  await expect(claudeSource(fsFiles({})).connect({} as never)).rejects.toThrow(
    '~/.claude was not found or not permitted (it must resolve inside your home folder) — run Claude Code once, restart KIA, then add this source',
  );
  await expect(source().connect({} as never)).resolves.toEqual({ identifier: '~/.claude', config: {} });
});

it('descriptor', () => {
  expect(source().descriptor).toEqual({
    id: 'claude-code', name: 'Claude Code', auth: 'none', cadence: { every: '15m' },
    documentTypes: ['agent.session', 'agent.plan', 'agent.tasks', 'agent.memory', 'agent.prompts'],
  });
});
```

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement** `src/source.ts`:

```ts
import type { DocumentInput, Source } from '@kiagent/connector-sdk';
import { displayPath, parseJson, type Agent } from './doc';
import { listDir, readText, streamLines, type FileStat, type Files } from './files';
import { renderMemory } from './claude/artifacts';
import { renderPromptDays, type PromptRow } from './prompts';
import { initialCursor, runSync, type SyncCursor, type Unit } from './sync';
import { systemTz } from './transcript';

export interface SourceOpts {
  tz?: () => string;
  maxDocs?: number;
}

const LABEL = { claude: 'Claude Code', codex: 'Codex' } as const;

export function missingRootMessage(root: 'claude' | 'codex'): string {
  return `~/.${root} was not found or not permitted (it must resolve inside your home folder) — run ${LABEL[root]} once, restart KIA, then add this source`;
}

export function makeSource(o: {
  id: 'claude-code' | 'codex';
  name: string;
  root: 'claude' | 'codex';
  documentTypes: string[];
  files: Files;
  opts?: SourceOpts;
  discover(files: Files, cursor: SyncCursor): Promise<Unit[]>;
}): Source<SyncCursor, DocumentInput> {
  const tz = o.opts?.tz ?? systemTz;
  return {
    descriptor: { id: o.id, name: o.name, documentTypes: o.documentTypes, auth: 'none', cadence: { every: '15m' } },
    async connect() {
      const roots = await o.files.roots();
      if (!roots.some((r) => r.id === o.root)) throw new Error(missingRootMessage(o.root));
      return { identifier: displayPath(o.root, ''), config: {} };
    },
    async *pull(session, cursor) {
      // tz is fixed by the FIRST pull and carried forever after (spec §4.3).
      const c = cursor && cursor.v === 1 && typeof cursor.tz === 'string' ? cursor : initialCursor(tz());
      const units = await o.discover(o.files, c);
      yield* runSync({ cursor: c, units, session, maxDocs: o.opts?.maxDocs });
    },
    toDocument: (item) => item,
  };
}

const TEXT = /\.(md|txt)$/i;

export async function walkText(files: Files, root: string, rel: string): Promise<FileStat[]> {
  const out: FileStat[] = [];
  for (const e of await listDir(files, root, rel)) {
    if (e.kind === 'directory') out.push(...(await walkText(files, root, e.rel)));
    else if (e.kind === 'file' && TEXT.test(e.name)) out.push(e);
  }
  return out;
}

export function memoryUnit(files: Files, root: 'claude' | 'codex', f: FileStat, agent: Agent, label: string | undefined): Unit {
  return {
    key: `memory:${f.rel}`,
    files: [f],
    async render() {
      const text = await readText(files, root, f.rel, f.size, 1024 * 1024);
      return [renderMemory(agent, f.rel, label, text, f.mtimeMs, displayPath(root, f.rel))];
    },
  };
}

export function historyUnit(
  files: Files,
  root: 'claude' | 'codex',
  f: FileStat,
  agent: Agent,
  tz: string,
  toRow: (r: Record<string, any>) => PromptRow | null,
): Unit {
  return {
    key: 'history',
    files: [f],
    async render() {
      const rows: PromptRow[] = [];
      for await (const line of streamLines(files, root, f.rel, f.size)) {
        if (typeof line !== 'string') continue;
        const r = parseJson(line);
        const row = r && toRow(r);
        if (row) rows.push(row);
      }
      return renderPromptDays(rows, tz, agent, displayPath(root, f.rel));
    },
  };
}
```

`src/claude/source.ts`:

```ts
import type { DocumentInput } from '@kiagent/connector-sdk';
import { claudeProjectLabel, displayPath, finalize, parseJson, str, UUID } from '../doc';
import { listDir, readText, streamLines, type FileStat, type Files } from '../files';
import { claudePromptRow } from '../prompts';
import { historyUnit, makeSource, memoryUnit, walkText, type SourceOpts } from '../source';
import { h, type SyncCursor, type Unit } from '../sync';
import { makeTitle, renderSession } from '../transcript';
import { renderPlan, renderTasks } from './artifacts';
import { parseClaudeSession } from './session';

const R = 'claude';
export const CLAUDE_TYPES = ['agent.session', 'agent.plan', 'agent.tasks', 'agent.memory', 'agent.prompts'];

function sessionUnit(files: Files, tz: string, f: FileStat, sessionId: string, sub?: { agentId: string; meta?: FileStat }): Unit {
  const key = sub ? `c:${sessionId}/${sub.agentId}` : `c:${sessionId}`;
  return {
    key,
    files: sub?.meta ? [f, sub.meta] : [f],
    parentH: sub ? h(`c:${sessionId}`) : undefined,
    async render(): Promise<DocumentInput[]> {
      const info = await parseClaudeSession(streamLines(files, R, f.rel, f.size), tz);
      let meta: Record<string, any> | null = null;
      if (sub?.meta) meta = parseJson(await readText(files, R, sub.meta.rel, sub.meta.size, 64 * 1024));
      const title = sub
        ? makeTitle(str(meta?.description), str(meta?.agentType), info.firstUser, `Session ${sub.agentId.slice(0, 8)}`)
        : makeTitle(info.title, info.firstUser, `Session ${sessionId.slice(0, 8)}`);
      return [
        finalize({
          externalId: sub ? `session:${sessionId}/${sub.agentId}` : `session:${sessionId}`,
          type: 'agent.session',
          title,
          markdown: renderSession(
            { title, agentLabel: 'Claude Code', cliVersion: info.cliVersion, cwd: info.cwd, gitBranch: info.gitBranch,
              startedAt: info.startedAt, resume: `claude --resume ${sessionId}` },
            info.body,
            tz,
          ),
          metadata: {
            agent: 'claude-code', role: sub ? 'subagent' : 'main', cwd: info.cwd, gitBranch: info.gitBranch,
            sessionId: sub ? sub.agentId : sessionId, parentSessionId: sub ? sessionId : undefined,
            model: info.model, cliVersion: info.cliVersion, sourcePath: displayPath(R, f.rel),
          },
          createdAt: info.startedAt ?? null,
          ...(sub ? { parent: { externalId: `session:${sessionId}`, type: 'agent.session' } } : {}),
        }),
      ];
    },
  };
}

export async function discoverClaude(files: Files, cursor: SyncCursor): Promise<Unit[]> {
  const tz = cursor.tz;
  const units: Unit[] = [];
  const top = await listDir(files, R, '');
  const at = (name: string) => top.find((e) => e.name === name);

  if (at('projects')?.kind === 'directory') {
    for (const proj of await listDir(files, R, 'projects')) {
      if (proj.kind !== 'directory') continue;
      for (const e of await listDir(files, R, proj.rel)) {
        if (e.kind === 'file' && e.name.endsWith('.jsonl')) {
          units.push(sessionUnit(files, tz, e, e.name.slice(0, -'.jsonl'.length)));
        } else if (e.kind === 'directory' && e.name === 'memory') {
          for (const m of await walkText(files, R, e.rel)) units.push(memoryUnit(files, R, m, 'claude-code', claudeProjectLabel(proj.name)));
        } else if (e.kind === 'directory' && UUID.test(e.name)) {
          const subs = await listDir(files, R, `${e.rel}/subagents`);
          for (const s of subs) {
            const m = /^agent-(.+)\.jsonl$/.exec(s.name);
            if (s.kind !== 'file' || !m) continue;
            const meta = subs.find((x) => x.kind === 'file' && x.name === `agent-${m[1]}.meta.json`);
            units.push(sessionUnit(files, tz, s, e.name, { agentId: m[1], meta }));
          }
        }
      }
    }
  }

  if (at('tasks')?.kind === 'directory') {
    for (const dir of await listDir(files, R, 'tasks')) {
      if (dir.kind !== 'directory') continue;
      const tfiles = (await listDir(files, R, dir.rel)).filter((f) => f.kind === 'file' && f.name.endsWith('.json') && !f.name.startsWith('.'));
      if (tfiles.length === 0) continue;
      const listId = dir.name;
      units.push({
        key: `t:${listId}`,
        files: tfiles,
        parentH: UUID.test(listId) ? h(`c:${listId}`) : undefined,
        async render() {
          const bodies = await Promise.all(tfiles.map((f) => readText(files, R, f.rel, f.size, 256 * 1024)));
          return [renderTasks(listId, bodies, Math.min(...tfiles.map((f) => f.mtimeMs)), displayPath(R, dir.rel))];
        },
      });
    }
  }

  if (at('plans')?.kind === 'directory') {
    for (const p of await listDir(files, R, 'plans')) {
      if (p.kind !== 'file' || !p.name.endsWith('.md')) continue;
      units.push({
        key: `plan:${p.name}`,
        files: [p],
        async render() {
          return [renderPlan(p.name, await readText(files, R, p.rel, p.size, 1024 * 1024), p.mtimeMs, displayPath(R, p.rel))];
        },
      });
    }
  }

  const claudeMd = at('CLAUDE.md');
  if (claudeMd?.kind === 'file') units.push(memoryUnit(files, R, claudeMd, 'claude-code', undefined));
  const history = at('history.jsonl');
  if (history?.kind === 'file') units.push(historyUnit(files, R, history, 'claude-code', tz, claudePromptRow));
  return units;
}

export function claudeSource(files: Files, opts?: SourceOpts) {
  return makeSource({ id: 'claude-code', name: 'Claude Code', root: R, documentTypes: CLAUDE_TYPES, files, opts, discover: discoverClaude });
}
```

Note: tasks render reads files in parallel (≤ a few dozen small JSON files per list); every other read is sequential.

- [ ] **Step 4: Run** — PASS. `npm run typecheck` — PASS.

- [ ] **Step 5: Mutation evidence** — take `tz()` on every pull instead of `cursor.tz` → both tz tests red; drop the `tfiles.length === 0` guard → `lock-only-tasks-dir-no-unit` red; set the tasks `parent` only when the session unit exists → `task-edit-after-session-cleanup-keeps-parent-ref` red; drop `parentH` from subagent units → parent-before-child order assertion red.

- [ ] **Step 6: Commit** `git add -A && git commit -m "feat: Claude Code source"`

### Task B7: Codex record parser (current + legacy)

**Files:** Create `src/codex/session.ts`; Test `src/__tests__/codex-session.test.ts`

**Interfaces:**
- Consumes: B1 `OVERSIZED`; B3 `TranscriptBuilder`, `toolLine`; B3 `classifyUserText`; B5 `parseJson`, `str`.
- Produces:
  ```ts
  export interface CodexHead { id?: string; parentId?: string; nickname?: string; cwd?: string; gitBranch?: string;
    cliVersion?: string; startedAt?: string; legacy: boolean }
  export function parseCodexHead(line: string | null): CodexHead;
  export interface CodexSessionInfo { head: CodexHead; model?: string; firstUser?: string; body: string }
  export function parseCodexSession(lines: AsyncIterable<string | typeof OVERSIZED>, tz: string): Promise<CodexSessionInfo>;
  ```

- [ ] **Step 1: Failing tests** (record shapes copied from Codex 0.155.1 and 2025-08 rollouts on this machine):

```ts
import { OVERSIZED } from '../files';
import { parseCodexHead, parseCodexSession } from '../codex/session';

const TID = '01a0cf15-e417-76d2-9ec2-824937247a6a';
const PID = '01a0cf14-f6a7-7282-8da4-61b7b0d85200';
async function* lines(recs: unknown[]): AsyncGenerator<string | typeof OVERSIZED> {
  for (const r of recs) yield r === OVERSIZED ? OVERSIZED : typeof r === 'string' ? r : JSON.stringify(r);
}
const meta = (p: object = {}) => ({
  timestamp: '2026-09-23T16:25:13.521Z', type: 'session_meta',
  payload: { id: TID, session_id: TID, timestamp: '2026-09-23T16:25:13.521Z', cwd: '/Users/e/work/a', cli_version: '0.155.1',
    git: { branch: 'dev' }, base_instructions: 'BASE-INSTRUCTIONS', ...p },
});
const ri = (payload: object) => ({ timestamp: '2026-09-23T16:26:00Z', type: 'response_item', payload });
const msg = (role: string, texts: string[], kind = role === 'assistant' ? 'output_text' : 'input_text') =>
  ri({ type: 'message', role, content: texts.map((text) => ({ type: kind, text })) });
const parse = (recs: unknown[]) => parseCodexSession(lines(recs), 'UTC');

it('head: main thread, nested subagent via parent_thread_id, fallback via source.subagent.thread_spawn', () => {
  expect(parseCodexHead(JSON.stringify(meta()))).toMatchObject({ id: TID, parentId: undefined, cwd: '/Users/e/work/a',
    gitBranch: 'dev', cliVersion: '0.155.1', startedAt: '2026-09-23T16:25:13.521Z', legacy: false });
  expect(parseCodexHead(JSON.stringify(meta({ parent_thread_id: PID, agent_nickname: 'Hegel' })))).toMatchObject({ parentId: PID, nickname: 'Hegel' });
  expect(parseCodexHead(JSON.stringify(meta({ source: { subagent: { thread_spawn: { parent_thread_id: PID, agent_nickname: 'Kant' } } } }))))
    .toMatchObject({ parentId: PID, nickname: 'Kant' });
  expect(parseCodexHead(null)).toEqual({ legacy: false });
});

it('codex.current.agent-message-is-assistant', async () => {
  const s = await parse([meta(), ri({ type: 'agent_message', author: '/root', recipient: '/root/x', content: [{ type: 'input_text', text: 'Review the parser' }] })]);
  expect(s.body).toBe('## Assistant — 16:26\nReview the parser');
});

it('codex.current.filters-injected-context (+ developer dropped, AGENTS.md dropped)', async () => {
  const s = await parse([
    meta(),
    msg('developer', ['<skills_instructions>DEV</skills_instructions>']),
    msg('user', ['# AGENTS.md instructions for /Users/e/work/a\n\n<INSTRUCTIONS>rules</INSTRUCTIONS>',
      '<environment_context>\n  <cwd>/x</cwd>\n</environment_context>', 'make the tests pass']),
    msg('user', ['<turn_aborted>aborted</turn_aborted>']),
  ]);
  expect(s.body).toBe('## User — 16:26\nmake the tests pass');
  expect(s.firstUser).toBe('make the tests pass');
});

it('tool calls become lines; outputs, reasoning, events and usage dropped; model from turn_context', async () => {
  const s = await parse([
    meta(),
    { timestamp: 't', type: 'turn_context', payload: { model: 'gpt-5.5-codex', cwd: '/x' } },
    msg('user', ['go']),
    ri({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'REASONING' }], encrypted_content: 'ENC' }),
    ri({ type: 'function_call', name: 'exec_command', namespace: 'x', arguments: '{"cmd":"npm test"}', call_id: 'c1' }),
    ri({ type: 'function_call_output', call_id: 'c1', output: 'FUNC-OUTPUT' }),
    ri({ type: 'custom_tool_call', name: 'apply_patch', input: '*** Begin Patch\n*** Update File: a.ts', call_id: 'c2' }),
    ri({ type: 'custom_tool_call_output', call_id: 'c2', output: 'PATCH-OUTPUT' }),
    { timestamp: 't', type: 'event_msg', payload: { type: 'token_count', info: {} } },
    { timestamp: 't', type: 'token_usage_record', usage: {} },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'BARE' }] }, // legacy-shaped line in a current file
    msg('assistant', ['All green']),
  ]);
  for (const x of ['REASONING', 'ENC', 'FUNC-OUTPUT', 'PATCH-OUTPUT', 'BASE-INSTRUCTIONS', 'BARE']) expect(s.body).not.toContain(x);
  expect(s.body).toBe('## User — 16:26\ngo\n\n## Assistant — 16:26\nAll green\n→ exec_command: npm test\n→ apply_patch: *** Begin Patch');
  expect(s.model).toBe('gpt-5.5-codex');
});

it('codex.legacy.renders-turns', async () => {
  const s = await parse([
    { id: '56f43c72-3946-4ba0-a508-e2bf9f8aec0f', timestamp: '2025-08-20T20:50:14.752Z', instructions: null,
      git: { commit_hash: 'bb7f', branch: 'main' } },
    { record_type: 'state' },
    { type: 'message', id: null, role: 'user', content: [{ type: 'input_text', text: '<environment_context>\ncwd\n</environment_context>' }] },
    { type: 'message', id: null, role: 'user', content: [{ type: 'input_text', text: 'hello legacy' }] },
    { type: 'reasoning', id: 'r', summary: [{ type: 'summary_text', text: 'THINK' }] },
    { type: 'message', id: null, role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
    { type: 'function_call', name: 'shell', arguments: '{"command":["ls"]}', call_id: 'c' },
  ]);
  expect(s.head).toMatchObject({ id: '56f43c72-3946-4ba0-a508-e2bf9f8aec0f', gitBranch: 'main', legacy: true,
    startedAt: '2025-08-20T20:50:14.752Z' });
  expect(s.body).toBe('## User\nhello legacy\n\n## Assistant\nhi\n→ shell');
});

it('oversized record marker', async () => {
  const s = await parse([meta(), msg('user', ['a']), OVERSIZED, msg('assistant', ['b'])]);
  expect(s.body).toContain('_… (1 oversized record skipped)_');
});
```

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement** `src/codex/session.ts`:

```ts
import { OVERSIZED } from '../files';
import { parseJson, str } from '../doc';
import { TranscriptBuilder, toolLine } from '../transcript';
import { classifyUserText } from '../wrappers';

export interface CodexHead {
  id?: string;
  parentId?: string;
  nickname?: string;
  cwd?: string;
  gitBranch?: string;
  cliVersion?: string;
  startedAt?: string;
  legacy: boolean;
}

export function parseCodexHead(line: string | null): CodexHead {
  const r = line ? parseJson(line) : null;
  if (!r) return { legacy: false };
  if (r.type === 'session_meta' && r.payload && typeof r.payload === 'object') {
    const p = r.payload;
    const spawn = p.source?.subagent?.thread_spawn;
    return {
      id: str(p.id),
      parentId: str(p.parent_thread_id) ?? str(spawn?.parent_thread_id),
      nickname: str(p.agent_nickname) ?? str(spawn?.agent_nickname),
      cwd: str(p.cwd),
      gitBranch: str(p.git?.branch),
      cliVersion: str(p.cli_version),
      startedAt: str(p.timestamp) ?? str(r.timestamp),
      legacy: false,
    };
  }
  // Legacy (Aug–Sep 2025): {id, timestamp, instructions, git}.
  if (r.type === undefined && str(r.id) && str(r.timestamp))
    return { id: r.id, gitBranch: str(r.git?.branch), startedAt: r.timestamp, legacy: true };
  return { legacy: false };
}

const partTexts = (content: unknown): string[] =>
  Array.isArray(content) ? content.filter((p) => typeof p?.text === 'string').map((p) => p.text as string) : [];

export interface CodexSessionInfo {
  head: CodexHead;
  model?: string;
  firstUser?: string;
  body: string;
}

export async function parseCodexSession(
  lines: AsyncIterable<string | typeof OVERSIZED>,
  tz: string,
): Promise<CodexSessionInfo> {
  const b = new TranscriptBuilder(tz);
  let head: CodexHead | null = null;
  let model: string | undefined;
  for await (const line of lines) {
    if (line === OVERSIZED) {
      b.marker('… (1 oversized record skipped)');
      continue;
    }
    if (head === null) {
      head = parseCodexHead(line);
      continue;
    }
    const r = parseJson(line);
    if (!r) continue;
    let item: Record<string, any> | null = null;
    if (r.type === 'response_item') item = r.payload;
    else if (r.type === 'turn_context') model ??= str(r.payload?.model);
    else if (head.legacy && typeof r.type === 'string' && !('payload' in r)) item = r;
    if (!item || typeof item !== 'object') continue;
    const at = str(r.timestamp);
    switch (item.type) {
      case 'message':
        if (item.role === 'user') {
          const kept = partTexts(item.content)
            .map(classifyUserText)
            .flatMap((c) => (c.kind === 'keep' ? [c.text] : []));
          if (kept.length) b.user(kept.join('\n\n'), at);
        } else if (item.role === 'assistant') {
          for (const t of partTexts(item.content)) if (t.trim()) b.assistantText(t, at);
        }
        break;
      case 'agent_message':
        for (const t of partTexts(item.content)) if (t.trim()) b.assistantText(t, at);
        break;
      case 'function_call':
        if (typeof item.name === 'string') b.tool(toolLine(item.name, item.arguments), at);
        break;
      case 'custom_tool_call':
        if (typeof item.name === 'string') b.tool(toolLine(item.name, item.input), at);
        break;
      default:
        break; // *_output, reasoning, and anything new: dropped
    }
  }
  return { head: head ?? { legacy: false }, model, firstUser: b.firstUserText, body: b.body() };
}
```

(Legacy records carry no `timestamp`, so their turns render without `— HH:MM`, as the legacy test expects.)

- [ ] **Step 4: Run** — PASS. **Step 5: Mutation** — handle `agent_message` as `user` → `agent-message-is-assistant` red; skip the per-part `classifyUserText` → `filters-injected-context` red; accept bare records when not legacy → `tool calls become lines…` red (`BARE`); drop `?? str(spawn?.parent_thread_id)` → head fallback red.

- [ ] **Step 6: Commit** `git add -A && git commit -m "feat: Codex record parser (current + legacy)"`

### Task B8: Codex discovery and source

**Files:** Create `src/codex/source.ts`; Test `src/__tests__/codex-source.test.ts`

**Interfaces:**
- Consumes: B1, B4, B5 (`codexPromptRow`, `finalize`, `displayPath`, `parseJson`, `str`), B6 (`makeSource`, `memoryUnit`, `historyUnit`, `walkText`, `SourceOpts`), B7.
- Produces: `CODEX_TYPES` (`['agent.session', 'agent.memory', 'agent.prompts']`), `discoverCodex(files, cursor)`, `codexSource(files, opts?)`.

Parent resolution (spec §4.6): a rollout's parent comes from its first record, which Codex never rewrites. Discovery therefore reads the first line only for a thread **not yet in `cursor.parents`**. Every unit sets `recordParent`, so the id is stored (`''` = no parent) in the same checkpoint as the first batch. This gives the same result as "re-read for every changed unit" with fewer reads: an active session changes on every tick, but its first record does not.

- [ ] **Step 1: Failing tests** — `src/__tests__/codex-source.test.ts`:

```ts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DocumentInput, Source } from '@kiagent/connector-sdk';
import { fakeSession } from '@kiagent/connector-sdk/testing';
import { fsFiles } from '../../test/support/fs-files';
import { codexSource } from '../codex/source';
import type { SyncCursor } from '../sync';

const P = '01a0cf14-f6a7-7282-8da4-61b7b0d85200';
const C = '01a0cf15-e417-76d2-9ec2-824937247a6a';
const G = '01a0cf16-0000-7000-8000-000000000001';
const L = '56f43c72-3946-4ba0-a508-e2bf9f8aec0f';
const DAY = 'sessions/2026/09/23';
let root: string;

async function put(rel: string, body: string) {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await fs.writeFile(path.join(root, rel), body);
}
const rollout = (id: string, parent: string | undefined, text: string, nickname?: string) =>
  [
    { timestamp: '2026-09-23T10:00:00Z', type: 'session_meta', payload: { id, timestamp: '2026-09-23T10:00:00Z', cwd: '/Users/e/work/a',
      cli_version: '0.155.1', git: { branch: 'dev' },
      ...(parent ? { parent_thread_id: parent, agent_nickname: nickname, source: { subagent: { thread_spawn: { parent_thread_id: parent } } } } : {}) } },
    { timestamp: '2026-09-23T10:00:05Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n';
const index = (id: string, name: string, at: string) => JSON.stringify({ id, thread_name: name, updated_at: at }) + '\n';

async function pull(src: Source<SyncCursor, DocumentInput>, cursor: SyncCursor | null) {
  const docs: DocumentInput[] = [];
  let last = cursor;
  for await (const b of src.pull(fakeSession(), cursor)) {
    docs.push(...b.items);
    last = b.cursor;
  }
  return { docs, cursor: last as SyncCursor, ids: docs.map((d) => d.externalId) };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'as-codex-'));
  // Same-second filenames: the child sorts BEFORE the parent by name.
  await put(`${DAY}/rollout-2026-09-23T10-00-00-${C}.jsonl`, rollout(C, P, 'child work', 'Hegel'));
  await put(`${DAY}/rollout-2026-09-23T10-00-00-${P}.jsonl`, rollout(P, undefined, 'parent work'));
  await put(`${DAY}/rollout-2026-09-23T10-00-00-${G}.jsonl`, rollout(G, C, 'grandchild work', 'Kant'));
  await put(`archived_sessions/rollout-2025-08-20T20-50-14-${L}.jsonl`,
    JSON.stringify({ id: L, timestamp: '2025-08-20T20:50:14.752Z', instructions: null, git: { branch: 'main' } }) + '\n' +
    JSON.stringify({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'legacy hello' }] }) + '\n');
  await put('session_index.jsonl', index(P, 'Newer name', '2026-09-23T12:00:00Z') + index(P, 'Older name', '2026-09-23T11:00:00Z'));
  await put('history.jsonl', JSON.stringify({ session_id: P, ts: 1758621600, text: 'parent work' }) + '\n');
  await put('AGENTS.md', 'global agent rules');
  await put('memories/notes.md', 'remember this');
});
afterEach(() => fs.rm(root, { recursive: true, force: true }));

const files = () => fsFiles({ codex: root });
const source = (f = files(), maxDocs?: number) => codexSource(f, { tz: () => 'UTC', maxDocs });

it('codex.nested-subagent-links-parent (+ parent-before-child across batch boundary, batch size 1)', async () => {
  const { docs, ids } = await pull(source(files(), 1), null);
  const byId = new Map(docs.map((d) => [d.externalId, d]));
  expect(byId.get(`session:${C}`)).toMatchObject({ title: 'Hegel', parent: { externalId: `session:${P}`, type: 'agent.session' },
    metadata: expect.objectContaining({ agent: 'codex', role: 'subagent', parentSessionId: P }) });
  expect(byId.get(`session:${G}`)!.parent).toEqual({ externalId: `session:${C}`, type: 'agent.session' });
  expect(ids.indexOf(`session:${P}`)).toBeLessThan(ids.indexOf(`session:${C}`));
  expect(ids.indexOf(`session:${C}`)).toBeLessThan(ids.indexOf(`session:${G}`));
  expect(byId.get(`session:${P}`)!.markdown).toContain('Resume: `codex resume 01a0cf14-f6a7-7282-8da4-61b7b0d85200`');
});

it('codex.title-from-session-index-last-wins (by updated_at, not file order)', async () => {
  const { docs } = await pull(source(), null);
  expect(docs.find((d) => d.externalId === `session:${P}`)!.title).toBe('Newer name');
});

it('codex.rename-changes-fingerprint (only the renamed thread re-renders)', async () => {
  const first = await pull(source(), null);
  await fs.appendFile(path.join(root, 'session_index.jsonl'), index(P, 'Renamed', '2026-09-23T13:00:00Z'));
  const next = await pull(source(), first.cursor);
  expect(next.ids).toEqual([`session:${P}`]);
  expect(next.docs[0].title).toBe('Renamed');
});

it('legacy rollout, memory, prompts', async () => {
  const { docs, ids } = await pull(source(), null);
  expect(ids).toEqual(expect.arrayContaining([`session:${L}`, 'memory:AGENTS.md', 'memory:memories/notes.md', 'prompts:2025-09-23']));
  expect(docs.find((d) => d.externalId === `session:${L}`)!.markdown).toContain('legacy hello');
});

it('unchanged tick re-reads no rollout; an appended rollout is re-read in full once', async () => {
  const first = await pull(source(), null);
  const f = files();
  expect((await pull(source(f), first.cursor)).ids).toEqual([]);
  expect(f.reads.filter((r) => r.rel.includes('rollout-'))).toEqual([]);
  await fs.appendFile(path.join(root, `${DAY}/rollout-2026-09-23T10-00-00-${C}.jsonl`),
    JSON.stringify({ timestamp: '2026-09-23T10:05:00Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'more' }] } }) + '\n');
  const g = files();
  const next = await pull(source(g), first.cursor);
  expect(next.ids).toEqual([`session:${C}`]);
  expect(next.docs[0].parent).toEqual({ externalId: `session:${P}`, type: 'agent.session' });
  expect(new Set(g.reads.filter((r) => r.rel.includes('rollout-')).map((r) => r.rel))).toEqual(new Set([`${DAY}/rollout-2026-09-23T10-00-00-${C}.jsonl`]));
});

it('connect.missing-root-message (codex)', async () => {
  await expect(codexSource(fsFiles({})).connect({} as never)).rejects.toThrow(
    '~/.codex was not found or not permitted (it must resolve inside your home folder) — run Codex once, restart KIA, then add this source',
  );
});
```

(`ts: 1758621600` is 2025-09-23T10:00:00Z.)

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement** `src/codex/source.ts`:

```ts
import type { DocumentInput } from '@kiagent/connector-sdk';
import { displayPath, finalize, parseJson, str } from '../doc';
import { firstLine, listDir, streamLines, type FileStat, type Files } from '../files';
import { codexPromptRow } from '../prompts';
import { historyUnit, makeSource, memoryUnit, walkText, type SourceOpts } from '../source';
import { h, type SyncCursor, type Unit } from '../sync';
import { makeTitle, renderSession } from '../transcript';
import { parseCodexHead, parseCodexSession } from './session';

const R = 'codex';
export const CODEX_TYPES = ['agent.session', 'agent.memory', 'agent.prompts'];
const ROLLOUT = /^rollout-.*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

async function walkRollouts(files: Files, rel: string, out: Map<string, FileStat>): Promise<void> {
  for (const e of await listDir(files, R, rel)) {
    if (e.kind === 'directory') await walkRollouts(files, e.rel, out);
    const m = e.kind === 'file' ? ROLLOUT.exec(e.name) : null;
    if (!m) continue;
    const prev = out.get(m[1]);
    if (!prev || e.mtimeMs > prev.mtimeMs) out.set(m[1], e); // archived copy vs live copy: newest wins
  }
}

/** Last row per id by `updated_at` (file order is not trusted). */
async function readIndex(files: Files, f: FileStat | undefined): Promise<Map<string, string>> {
  const best = new Map<string, { name: string; at: string }>();
  if (!f) return new Map();
  for await (const line of streamLines(files, R, f.rel, f.size)) {
    if (typeof line !== 'string') continue;
    const r = parseJson(line);
    const id = str(r?.id);
    const name = str(r?.thread_name);
    const at = str(r?.updated_at) ?? '';
    if (!id || !name) continue;
    const prev = best.get(id);
    if (!prev || at >= prev.at) best.set(id, { name, at });
  }
  return new Map([...best].map(([id, v]) => [id, v.name]));
}

export async function discoverCodex(files: Files, cursor: SyncCursor): Promise<Unit[]> {
  const tz = cursor.tz;
  const top = await listDir(files, R, '');
  const at = (name: string) => top.find((e) => e.name === name);
  const titles = await readIndex(files, at('session_index.jsonl')?.kind === 'file' ? at('session_index.jsonl') : undefined);

  const rollouts = new Map<string, FileStat>();
  for (const dir of ['sessions', 'archived_sessions']) if (at(dir)?.kind === 'directory') await walkRollouts(files, dir, rollouts);

  const units: Unit[] = [];
  for (const [id, f] of rollouts) {
    const key = `x:${id}`;
    const known = cursor.parents[h(key)];
    let parentH: string | undefined;
    if (known !== undefined) parentH = known || undefined;
    else {
      const parentId = parseCodexHead(await firstLine(files, R, f.rel, f.size)).parentId;
      parentH = parentId ? h(`x:${parentId}`) : undefined;
    }
    const indexTitle = titles.get(id);
    units.push({
      key,
      files: [f],
      deps: [indexTitle ?? ''],
      parentH,
      recordParent: true,
      async render(): Promise<DocumentInput[]> {
        const s = await parseCodexSession(streamLines(files, R, f.rel, f.size), tz);
        const parentId = s.head.parentId;
        const title = makeTitle(indexTitle, s.head.nickname, s.firstUser, `Session ${id.slice(0, 8)}`);
        return [
          finalize({
            externalId: `session:${id}`,
            type: 'agent.session',
            title,
            markdown: renderSession(
              { title, agentLabel: 'Codex', cliVersion: s.head.cliVersion, cwd: s.head.cwd, gitBranch: s.head.gitBranch,
                startedAt: s.head.startedAt, resume: `codex resume ${id}` },
              s.body,
              tz,
            ),
            metadata: {
              agent: 'codex', role: parentId ? 'subagent' : 'main', cwd: s.head.cwd, gitBranch: s.head.gitBranch,
              sessionId: id, parentSessionId: parentId, model: s.model, cliVersion: s.head.cliVersion,
              sourcePath: displayPath(R, f.rel),
            },
            createdAt: s.head.startedAt ?? null,
            ...(parentId ? { parent: { externalId: `session:${parentId}`, type: 'agent.session' } } : {}),
          }),
        ];
      },
    });
  }

  const agents = at('AGENTS.md');
  if (agents?.kind === 'file') units.push(memoryUnit(files, R, agents, 'codex', undefined));
  if (at('memories')?.kind === 'directory')
    for (const m of await walkText(files, R, 'memories')) units.push(memoryUnit(files, R, m, 'codex', undefined));
  const history = at('history.jsonl');
  if (history?.kind === 'file') units.push(historyUnit(files, R, history, 'codex', tz, codexPromptRow));
  return units;
}

export function codexSource(files: Files, opts?: SourceOpts) {
  return makeSource({ id: 'codex', name: 'Codex', root: R, documentTypes: CODEX_TYPES, files, opts, discover: discoverCodex });
}
```

- [ ] **Step 4: Run** — PASS. `npm run typecheck` — PASS.

- [ ] **Step 5: Mutation evidence** — read the first line even when `known !== undefined` → the unchanged-tick read assertion red; `deps: []` → `rename-changes-fingerprint` red; keep the first index row instead of the latest `updated_at` → `title-from-session-index-last-wins` red; drop `recordParent` → the unchanged-tick read assertion red; sort units by key only in B4 → batch-boundary order assertion red.

- [ ] **Step 6: Commit** `git add -A && git commit -m "feat: Codex source"`

### Task B9: Entry point, bundle smoke, real-capture fixtures, benchmark, README

**Files:**
- Create: `src/index.ts`, `src/__tests__/bundle-load.test.ts`, `scripts/capture-fixture.mjs`, `test/fixtures/*.jsonl` (generated), `src/__tests__/fixtures.test.ts`, `src/__tests__/real-corpus.bench.test.ts`
- Modify: `README.md`

**Interfaces:** Consumes `claudeSource`, `codexSource`, `parseClaudeSession`, `parseCodexSession`, `streamLines`, `fsFiles`. Produces the default export `ExtensionModule<'files'>`.

- [ ] **Step 1: Entry + bundle smoke (failing first)** — `src/__tests__/bundle-load.test.ts`:

```ts
import { join } from 'node:path';
import { bundleLoadSmoke } from '@kiagent/connector-sdk/testing';

describe('dist bundle loads standalone', () => {
  it('bundleLoadSmoke: activate() returns claude-code then codex', async () => {
    await bundleLoadSmoke({
      root: join(__dirname, '..', '..'),
      selfId: 'kia.agent-sessions',
      sourceIds: ['claude-code', 'codex'],
      host: { self: { id: 'kia.agent-sessions' }, files: { roots: async () => [] } },
    });
  }, 60_000);
});
```

Run → FAIL (no `src/index.ts`). Then `src/index.ts`:

```ts
import type { ExtensionModule } from '@kiagent/connector-sdk';
import { claudeSource } from './claude/source';
import { codexSource } from './codex/source';

const mod = {
  async activate(host) {
    return { sources: [claudeSource(host.files), codexSource(host.files)] };
  },
} satisfies ExtensionModule<'files'>;

export default mod;
module.exports = mod;
```

Run → PASS.

- [ ] **Step 2: Fixture capture script** — `scripts/capture-fixture.mjs` (run by hand on this machine; its output is what gets committed, never the raw files):

```js
#!/usr/bin/env node
// Usage: node scripts/capture-fixture.mjs <agent: claude|codex> <src.jsonl> <dest.jsonl> [maxBytes=50000]
// Keeps whole records up to maxBytes. Every free-text string becomes `text <n>`,
// except strings the spec says to DROP, which become DROPPED-SENTINEL, and XML
// tag skeletons, which keep their tag names so the wrapper filter is exercised.
import fs from 'node:fs';

const [agent, src, dest, max = '50000'] = process.argv.slice(2);
if (!['claude', 'codex'].includes(agent) || !src || !dest) {
  console.error('usage: capture-fixture.mjs <claude|codex> <src> <dest> [maxBytes]');
  process.exit(2);
}
const KEEP = new Set(['type', 'role', 'name', 'status', 'subtype', 'record_type', 'timestamp', 'version', 'cli_version',
  'isMeta', 'isSidechain', 'isCompactSummary', 'id', 'sessionId', 'session_id', 'parent_thread_id', 'model', 'uuid', 'parentUuid']);
const DROP_PARTS = new Set(['thinking', 'redacted_thinking', 'tool_result', 'reasoning', 'function_call_output',
  'custom_tool_call_output', 'server_tool_use', 'web_search_tool_result']);
let n = 0;
const text = (s) => {
  const t = s.trimStart();
  if (t.startsWith('<')) return s.replace(/>([^<]+)</g, (m, inner) => (inner.trim() ? '>x<' : m));
  if (t.startsWith('# AGENTS.md instructions')) return '# AGENTS.md instructions for /Users/test\n\nx';
  return `text ${++n}`;
};
const scrub = (v, key, drop) => {
  if (typeof v === 'string') {
    if (KEEP.has(key)) return v.replace(/\/Users\/[^/"]+/g, '/Users/test');
    return drop ? 'DROPPED-SENTINEL' : text(v);
  }
  if (Array.isArray(v)) return v.map((x) => scrub(x, key, drop));
  if (v && typeof v === 'object') {
    const d = drop || DROP_PARTS.has(v.type) || v.isMeta === true || v.isCompactSummary === true ||
      v.role === 'developer' || ['attachment', 'system', 'file-history-snapshot', 'queue-operation'].includes(v.type);
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k === 'base_instructions' ? 'DROPPED-SENTINEL' : scrub(x, k, d)]));
  }
  return v;
};
const out = [];
let bytes = 0;
for (const line of fs.readFileSync(src, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  let rec;
  try { rec = JSON.parse(line); } catch { continue; }
  const s = JSON.stringify(scrub(rec, '', false));
  if (bytes + s.length + 1 > Number(max)) break;
  out.push(s);
  bytes += s.length + 1;
}
fs.writeFileSync(dest, out.join('\n') + '\n');
console.log(`${agent}: ${out.length} records, ${bytes} bytes → ${dest}`);
```

Capture (pick sources with `grep -l` so each fixture contains the named feature; then read every fixture by hand before committing and confirm it holds no real text, paths or names):

```bash
cd /Users/edjafarov/work/agent-sessions-kia-connector && mkdir -p test/fixtures
# Claude: a main session with a slash command, an isMeta array record and a compaction summary; a subagent pair
M=$(/usr/bin/grep -l '"isCompactSummary":true' ~/.claude/projects/*/*.jsonl | head -1)
node scripts/capture-fixture.mjs claude "$M" test/fixtures/claude-main.jsonl
S=$(ls ~/.claude/projects/*/*/subagents/agent-*.jsonl | head -1)
node scripts/capture-fixture.mjs claude "$S" test/fixtures/claude-subagent.jsonl
# Codex: current main + nested subagent, legacy 2025-08
X=$(/usr/bin/grep -L '"parent_thread_id"' ~/.codex/sessions/2026/09/*/*.jsonl | head -1)
node scripts/capture-fixture.mjs codex "$X" test/fixtures/codex-current.jsonl
Y=$(/usr/bin/grep -l '"parent_thread_id"' ~/.codex/sessions/2026/09/*/*.jsonl | head -1)
node scripts/capture-fixture.mjs codex "$Y" test/fixtures/codex-subagent.jsonl
Z=$(ls ~/.codex/sessions/2025/08/*/*.jsonl | head -1)
node scripts/capture-fixture.mjs codex "$Z" test/fixtures/codex-legacy.jsonl
```

(Use `/usr/bin/grep`: the interactive `grep`/`ls` aliases on this machine add colour codes. The 50 KB cut may fall before a compaction summary; if `grep -c isCompactSummary test/fixtures/claude-main.jsonl` is 0, re-run with a source whose summary comes early, or pass a larger `maxBytes` ≤ 50000 after trimming.)

- [ ] **Step 3: Fixture tests** — `src/__tests__/fixtures.test.ts`:

```ts
import fs from 'node:fs';
import path from 'node:path';
import { parseClaudeSession } from '../claude/session';
import { parseCodexSession } from '../codex/session';

const FIX = path.join(__dirname, '..', '..', 'test', 'fixtures');
async function* lines(file: string) {
  for (const l of fs.readFileSync(path.join(FIX, file), 'utf8').split('\n')) if (l) yield l;
}
const cases: Array<[string, (l: AsyncIterable<string>, tz: string) => Promise<{ body: string }>]> = [
  ['claude-main.jsonl', parseClaudeSession],
  ['claude-subagent.jsonl', parseClaudeSession],
  ['codex-current.jsonl', parseCodexSession],
  ['codex-subagent.jsonl', parseCodexSession],
  ['codex-legacy.jsonl', parseCodexSession],
];

it.each(cases)('%s: real-format capture drops every DROPPED-SENTINEL and keeps real turns', async (file, parse) => {
  expect(fs.statSync(path.join(FIX, file)).size).toBeLessThanOrEqual(50_000);
  const { body } = await parse(lines(file), 'UTC');
  expect(body).not.toContain('DROPPED-SENTINEL');
  expect(body).not.toMatch(/<(system-reminder|environment_context|local-command-caveat|INSTRUCTIONS)>/i);
  expect(body).toMatch(/## User/);
  expect(body).toMatch(/text \d+/);
});

it('the Codex subagent capture names its parent', () => {
  const first = JSON.parse(fs.readFileSync(path.join(FIX, 'codex-subagent.jsonl'), 'utf8').split('\n')[0]);
  expect(first.payload.parent_thread_id ?? first.payload.source?.subagent?.thread_spawn?.parent_thread_id).toBeTruthy();
});
```

Run → PASS. Mutation: make the Claude parser keep `tool_result` parts → red on `claude-main.jsonl` (confirm the capture contains a `tool_result`; if it does not, pick a different source in Step 2).

- [ ] **Step 4: Real-corpus benchmark (env-gated)** — `src/__tests__/real-corpus.bench.test.ts`:

```ts
import os from 'node:os';
import path from 'node:path';
import { fakeSession } from '@kiagent/connector-sdk/testing';
import { fsFiles } from '../../test/support/fs-files';
import { claudeSource } from '../claude/source';
import { codexSource } from '../codex/source';
import type { SyncCursor } from '../sync';

const run = process.env.AGENT_SESSIONS_REAL === '1' ? it : it.skip;

run.each([
  ['claude', claudeSource],
  ['codex', codexSource],
] as const)('%s: backfill then an unchanged tick (< 10 s, 0 docs)', async (root, make) => {
  const files = fsFiles({ [root]: path.join(os.homedir(), `.${root}`) });
  const src = make(files);
  const pull = async (c: SyncCursor | null) => {
    const t0 = Date.now();
    let docs = 0;
    let cursor = c;
    const types: Record<string, number> = {};
    for await (const b of src.pull(fakeSession(), c)) {
      docs += b.items.length;
      for (const d of b.items) types[d.type] = (types[d.type] ?? 0) + 1;
      cursor = b.cursor;
    }
    return { ms: Date.now() - t0, docs, cursor: cursor as SyncCursor, types, cursorBytes: JSON.stringify(cursor).length };
  };
  const backfill = await pull(null);
  const tick = await pull(backfill.cursor);
  console.log(root, { backfill: { ms: backfill.ms, docs: backfill.docs, types: backfill.types, cursorBytes: backfill.cursorBytes },
    unchangedTick: { ms: tick.ms, docs: tick.docs } });
  expect(tick.ms).toBeLessThan(10_000);
  expect(tick.docs).toBeLessThanOrEqual(3); // only sessions active right now (this one) may change
}, 3_600_000);
```

Run: `AGENT_SESSIONS_REAL=1 npx jest src/__tests__/real-corpus.bench.test.ts`. Record both printed objects in the task report and later in the PR (spec §4.5). This measures the connector through a direct-fs adapter. The host-API numbers come from the manual smoke (C4).

- [ ] **Step 5: README** — replace the stub with: what is indexed (the five types, both agents); what is **not** indexed (tool outputs, thinking, attachments, costs/tokens); privacy (read-only access to `~/.claude` and `~/.codex`, asked at install; redaction is a safety net, and a pasted secret that matches no pattern **is** indexed); the restart-after-first-run note (a folder created after KIA started needs a restart); that history is kept after Claude's 30-day cleanup; development (`npm test`, `npm run build`, `AGENT_SESSIONS_REAL=1` benchmark, `scripts/capture-fixture.mjs`).

- [ ] **Step 6: Full gates** — `npm test` (all green, bench skipped), `npm run typecheck`, `npm run build` (`dist/index.js` exists; `grep -c "require(\"node:fs\")\|require('fs')" dist/index.js` → 0: the bundle must not touch the filesystem directly).

- [ ] **Step 7: Commit** `git add -A && git commit -m "feat: entry point, bundle smoke, real-capture fixtures, benchmark, README"`

---

# Part C — release (each step needs the user's explicit go-ahead)

### Task C1: Core release

- [ ] Push `feat/local-agent-sessions`, open a PR to `dev` in `edjafarov/kiagent-core` (body: spec link, Review Focus, gate table). Merge after review.
- [ ] Release core `v0.91.0` and `sdk-v1.4.0` via the core repo's documented release flow (see [[connector-sdk]] runbook in memory). Record the **peeled** commit of the tag (`git rev-parse v0.91.0^{}`).

### Task C2: Connector repo + 1.0.0

- [ ] In the connector, switch the SDK devDependency to `.../sdk-v1.4.0/kiagent-connector-sdk-1.4.0.tgz`, `npm install`, then run all gates again.
- [ ] Replace the placeholder `icon.png` with a real one (square PNG, same size as the other connectors' icons).
- [ ] Create `kia-plugins/agent-sessions-kia-connector` (topic `kia-plugin`), push `main`. CI needs the same git ssh→https rewrite as the other connectors (see [[marketplace-consistency-audit-2026-09-23]]).
- [ ] `npm run build && npm pack`, create GitHub release `1.0.0` with the tgz asset (same asset naming as the notion connector).

### Task C3: alpha-cent `core.lock` bump

- [ ] In `/Users/edjafarov/work/alpha-cent` on `dev`, pin `core.lock` to `v0.91.0` (peeled commit). Then `rm -rf build/.core`, re-stage, `npm ci` in `build/.core`, copy `assets/{whisper,llama,vision}` (see [[vad-hardening-98]], [[dev-assets-root-vision-llama]]). Run the overlay gates. Stop any running dev app first: a lock bump kills it.

### Task C4: Manual smoke + host-API benchmark (spec §5)

- [ ] Start the dev app. Install the connector from the Marketplace. The consent modal lists `~/.claude` and `~/.codex` under "Read approved folders".
- [ ] Add both sources. Backfill completes with no progress bar. Time the backfill and one unchanged tick from the logs, and record both next to the B9 numbers.
- [ ] Spot-check search: a known prompt, a Claude subagent linked to its parent, a nested Codex subagent, a plan, a prompt day.
- [ ] Continue a Claude session and confirm the next tick rewrites only that session.
- [ ] Temporarily rename `~/.codex` and restart. Activation succeeds, and adding Codex shows the "not found or not permitted" message. Restore the folder.
