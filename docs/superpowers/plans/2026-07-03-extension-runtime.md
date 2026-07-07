# Extension Runtime (Plan A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An installed extension (local tarball/dir for now) activates in its own utilityProcess, contributes Sources the engine syncs and MCP tools clients can call, gated by consented capabilities.

**Architecture:** One `utilityProcess` per enabled extension speaks a typed RPC protocol over structured-clone messages. All capability enforcement lives main-side in `HostRouter` (this is the runtime `gate()`); contributed sources register into the existing `SourceRegistry` as demand-driven proxies, so engine/scheduler/connect-flow work unchanged. The 3-phase installer (preview → consent → commit) handles local refs only; GitHub refs land in Plan B.

**Tech Stack:** Electron `utilityProcess`, `child_process.fork` (tests), zod (already a dep), `semver` + `tar` (new deps), better-sqlite3 (PrivateDb, main-side), jest + ts-jest (node env via docblock).

**Spec:** `docs/superpowers/specs/2026-07-03-extension-marketplace-design.md`. Read it if a requirement seems ambiguous — it governs.

## Global Constraints

- **No extension code ever executes in the main process.** Preview/discovery validate `manifest.json` only; code runs only inside the child process.
- **All capability enforcement lives in the main process** (`HostRouter`). The child's host proxy is shape-only sugar.
- Caps map 1:1 to host namespaces. There is **no `db.write` cap** — store writes are engine-committed return values.
- `PLATFORM_API_VERSION = '1.0.0'`. Extension id regex: `^[a-z0-9-]+\.[a-z0-9-]+$` (e.g. `kia.notion`).
- Unknown `caps` strings are **rejected** at validation. Legacy manifests (have `hostApi`/`permissions`, lack `engine`+`caps`) are rejected with exactly: `This extension was built for the legacy app and is not compatible with this build.`
- `files` and `commands` caps are declared-but-rejected: calls fail with `…not supported in this build yet`.
- Consent is all-or-nothing per manifest; the consents table is append-only (never delete rows); updates always re-consent.
- `state.json` written with mode `0o600`. `installed.json` is installer-owned frozen records; enabled-state lives ONLY in `state.json`.
- Pull is demand-driven (`src-next` per batch); **one wire crossing per batch, never per item** (`toDocument` runs child-side).
- `src/shared/contracts.ts` stays type-only — runtime constants go in `src/shared/extension-rpc.ts`.
- Regression gates after EVERY task: `npx jest` fully green (39 suites / 311 tests at plan start, growing), and `npx tsc --noEmit` shows **exactly the 4 pre-existing errors** (tmp-promise ×2, MCP SDK resolution-mode, franc-min) and nothing new.
- SECURITY: NEVER print, quote, or modify `src/main/sources/gmail/client-credentials.ts`.

**Conventions:** tests live in `__tests__/` beside the code, named `*.test.ts`, with `/** @jest-environment node */` docblock (default env is jsdom). Path aliases `@shared/*`, `@main/*` work in src and tests. Run a single file with `npx jest src/main/platform/__tests__/manifest.test.ts`.

---

### Task 1: Dependencies + shared types (wire protocol, Manifest.entry, AppState.extensions)

**Files:**
- Modify: `package.json` (via npm install)
- Create: `src/shared/extension-rpc.ts`
- Modify: `src/shared/contracts.ts` (Manifest gains `entry`; add `ExtensionStatus`, `ExtensionSnapshot`; `AppState` gains `extensions`)
- Modify: `src/main/core/app-projection.ts` (+ its test `src/main/core/__tests__/app-projection.test.ts`)
- Modify: `src/main/main.ts` (seed + preserve the new non-feed slice)

**Interfaces (produced, used by every later task):**
- `PLATFORM_API_VERSION: '1.0.0'`, `MainToChild`, `ChildToMain`, `WireBatch`, `Contributions`, `ToolDescriptor` from `@shared/extension-rpc`
- `Manifest` now has `entry: string`; `ExtensionStatus`, `ExtensionSnapshot` from `@shared/contracts`

- [ ] **Step 1: Install deps**

```bash
npm install semver tar && npm install -D @types/semver @types/tar
```

- [ ] **Step 2: Create `src/shared/extension-rpc.ts`**

```ts
/**
 * Wire protocol between the main process and an extension host child
 * (utilityProcess in prod, child_process.fork in tests). Shared by both
 * sides; contracts.ts stays type-only, so the runtime version constant
 * lives here.
 *
 * Direction of `call`: host-surface calls originate child→main (ns = a Cap,
 * 'base', or the 'auth'/'session' callback namespaces); source/tool
 * invocations originate main→child (ns 'source' | 'tool'). Replies mirror
 * the call's id. Everything else is a one-way notification.
 */
import type {
  Cap,
  DocumentInput,
  ExternalRef,
  PullPhase,
  SourceDescriptor,
} from './contracts';

export const PLATFORM_API_VERSION = '1.0.0';

/** A Batch after the child mapped items through the source's toDocument —
 *  the generic Item type never crosses the wire. */
export interface WireBatch {
  phase: PullPhase;
  items: DocumentInput[];
  deletions?: ExternalRef[];
  cursor: unknown;
  estimateTotal?: number;
}

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: unknown;
  tier?: 'standard' | 'powerful';
}

/** Serializable summary of what activate() returned; the callable objects
 *  stay in the child, main registers proxies. */
export interface Contributions {
  sources: Array<{
    descriptor: SourceDescriptor;
    hasFetchBytes: boolean;
    hasReconcile: boolean;
  }>;
  tools: ToolDescriptor[];
}

export interface ExtensionBootstrap {
  kind: 'bootstrap';
  v: 1;
  extensionId: string;
  entryAbsPath: string;
  dataDir: string;
  caps: Cap[];
}

export type MainToChild =
  | ExtensionBootstrap
  | { kind: 'call'; id: number; ns: 'source' | 'tool'; method: string; args: unknown[] }
  | { kind: 'reply'; id: number; ok: boolean; value?: unknown; error?: string }
  | { kind: 'event'; name: string; payload: unknown }
  | { kind: 'src-next'; pullId: number }
  | { kind: 'src-abort'; pullId: number }
  | { kind: 'deactivate' };

export type ChildToMain =
  | { kind: 'ready' }
  | { kind: 'activated'; contributions: Contributions }
  | { kind: 'errored'; error: string }
  | { kind: 'call'; id: number; ns: string; method: string; args: unknown[] }
  | { kind: 'reply'; id: number; ok: boolean; value?: unknown; error?: string }
  | { kind: 'src-batch'; pullId: number; batch: WireBatch }
  | { kind: 'src-refs'; pullId: number; refs: ExternalRef[] }
  | { kind: 'src-done'; pullId: number }
  | { kind: 'src-error'; pullId: number; error: string };
```

- [ ] **Step 3: Extend `src/shared/contracts.ts`**

In the `Manifest` interface (line ~447), after `engine: string; // platform semver range` add:

```ts
  /** Relative path to the CJS bundle, e.g. 'dist/index.js' — must resolve
   *  inside the extension directory (containment-checked at validation). */
  entry: string;
```

After the `ExtensionModule` interface (end of §7, line ~539) add:

```ts
/** Runtime status of an installed extension, projected into AppState. */
export type ExtensionStatus =
  | 'disabled'
  | 'needs-consent'
  | 'activating'
  | 'activated'
  | 'errored';

export interface ExtensionSnapshot {
  id: string;
  name: string;
  version: string;
  origin: 'marketplace' | 'dev';
  enabled: boolean;
  status: ExtensionStatus;
  error?: string;
  caps: Cap[];
  sourceIds: string[];
  ref?: string;
}
```

In `AppState` (line ~598) add a field after `prefs: AppPrefs;`:

```ts
  extensions: ExtensionSnapshot[];
```

- [ ] **Step 4: Thread the new slice through the projection**

`src/main/core/app-projection.ts` — add to `AppStateExtras`:

```ts
  extensions(): ExtensionSnapshot[];
```

(import `ExtensionSnapshot` type from `@shared/contracts`) and in `init()`'s returned object add:

```ts
        extensions: extras.extensions(),
```

Update `src/main/core/__tests__/app-projection.test.ts`: every place a fake `AppStateExtras` object is constructed gains `extensions: () => []`, and any full-`AppState` literal gains `extensions: []`. Run the file to find them all: `npx jest src/main/core/__tests__/app-projection.test.ts`.

- [ ] **Step 5: `src/main/main.ts` — seed + preserve the non-feed slice**

Three mechanical edits (the extensions slice follows the exact pattern of `mcp`/`identity`):
1. In the initial `lastPush` state literal (~line 361-376) add `extensions: [],` after `prefs: p.prefs.get(),`.
2. In the `p.createAppProjection({...})` extras (~line 377) add `extensions: () => extensionsPlatform?.snapshot() ?? [],` — and near the module-level `let mcp` declaration add `let extensionsPlatform: { snapshot(): ExtensionSnapshot[] } | null = null;` (typed structurally for now; Task 12 replaces it with the real `ExtensionPlatform`). Import `ExtensionSnapshot` type from `@shared/contracts`.
3. In the `p.engine.project(...)` callback's preserve list (~line 403-410) add `extensions: lastPush.state.extensions,` beside `mcp: lastPush.state.mcp,`.

- [ ] **Step 6: Gates + commit**

```bash
npx jest src/main/core/__tests__/app-projection.test.ts && npx tsc --noEmit ; npx jest
git add -A && git commit -m "feat(extensions): wire protocol types, Manifest.entry, AppState.extensions slice"
```

`tsc` must show only the 4 pre-existing errors. Full suite green.

---

### Task 2: Manifest validation (`src/main/platform/manifest.ts`)

**Files:**
- Create: `src/main/platform/manifest.ts`
- Test: `src/main/platform/__tests__/manifest.test.ts`

**Interfaces:**
- Consumes: `PLATFORM_API_VERSION` from `@shared/extension-rpc`; `Manifest`, `ExtensionId` from `@shared/contracts`
- Produces: `class ManifestError extends Error`; `parseManifest(raw: unknown): Manifest`; `validateManifestDir(dir: string): { manifest: Manifest; entryAbsPath: string }`

- [ ] **Step 1: Write the failing tests**

`src/main/platform/__tests__/manifest.test.ts`:

```ts
/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { ManifestError, parseManifest, validateManifestDir } from '../manifest';

const GOOD = {
  id: 'test.basic',
  name: 'Basic',
  version: '1.0.0',
  engine: '^1.0.0',
  entry: 'dist/index.js',
  caps: ['net'],
  contributes: { sources: ['basicsrc'] },
};

describe('parseManifest', () => {
  it('accepts a valid manifest', () => {
    const m = parseManifest(GOOD);
    expect(m.id).toBe('test.basic');
    expect(m.caps).toEqual(['net']);
    expect(m.contributes.sources).toEqual(['basicsrc']);
  });

  it('defaults contributes to {}', () => {
    const { contributes: _drop, ...rest } = GOOD;
    expect(parseManifest(rest).contributes).toEqual({});
  });

  it('rejects unknown caps (legacy silently dropped them — we refuse)', () => {
    expect(() => parseManifest({ ...GOOD, caps: ['net', 'teleport'] })).toThrow(ManifestError);
  });

  it('rejects a legacy-format manifest with the exact message', () => {
    const legacy = {
      id: 'kia.notion', displayName: 'Notion', version: '1.2.0',
      hostApi: '^2.0.0', entry: 'dist/index.js', permissions: ['net'],
    };
    expect(() => parseManifest(legacy)).toThrow(
      'This extension was built for the legacy app and is not compatible with this build.',
    );
  });

  it('rejects bad ids (must be publisher.name)', () => {
    expect(() => parseManifest({ ...GOOD, id: 'gmail' })).toThrow(ManifestError);
    expect(() => parseManifest({ ...GOOD, id: 'Test.Basic' })).toThrow(ManifestError);
  });

  it('rejects an engine range this platform does not satisfy', () => {
    expect(() => parseManifest({ ...GOOD, engine: '^2.0.0' })).toThrow(/requires platform/);
  });

  it('rejects invalid semver version and invalid engine range', () => {
    expect(() => parseManifest({ ...GOOD, version: 'one' })).toThrow(ManifestError);
    expect(() => parseManifest({ ...GOOD, engine: 'not-a-range' })).toThrow(ManifestError);
  });
});

describe('validateManifestDir', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kia-manifest-'));
    fs.mkdirSync(path.join(dir, 'dist'));
    fs.writeFileSync(path.join(dir, 'dist', 'index.js'), 'module.exports = {};');
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(GOOD));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('returns the manifest and absolute entry path', () => {
    const { manifest, entryAbsPath } = validateManifestDir(dir);
    expect(manifest.id).toBe('test.basic');
    expect(entryAbsPath).toBe(path.join(dir, 'dist', 'index.js'));
  });

  it('rejects an entry escaping the directory', () => {
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify({ ...GOOD, entry: '../outside.js' }),
    );
    expect(() => validateManifestDir(dir)).toThrow(/inside the extension directory/);
  });

  it('rejects a missing entry file and a missing manifest.json', () => {
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ ...GOOD, entry: 'nope.js' }));
    expect(() => validateManifestDir(dir)).toThrow(/entry not found/);
    fs.rmSync(path.join(dir, 'manifest.json'));
    expect(() => validateManifestDir(dir)).toThrow(/manifest.json/);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx jest src/main/platform/__tests__/manifest.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `src/main/platform/manifest.ts`**

```ts
/**
 * manifest.json validation — the ONLY thing that runs against an extension
 * before consent. Never loads extension code. Rejections are user-facing
 * strings (they surface in the install UI).
 */
import fs from 'fs';
import path from 'path';

import semver from 'semver';
import { z } from 'zod';

import type { ExtensionId, Manifest } from '@shared/contracts';
import { PLATFORM_API_VERSION } from '@shared/extension-rpc';

export class ManifestError extends Error {}

const ID_RE = /^[a-z0-9-]+\.[a-z0-9-]+$/;
const CAPS = ['query', 'net', 'files', 'db', 'ui', 'commands', 'inference', 'events'] as const;

const schema = z.object({
  id: z.string().regex(ID_RE, "extension id must look like 'publisher.name'"),
  name: z.string().min(1),
  version: z.string().refine((v) => semver.valid(v) !== null, 'version must be valid semver'),
  engine: z.string().refine((r) => semver.validRange(r) !== null, 'engine must be a semver range'),
  entry: z.string().min(1),
  caps: z.array(z.enum(CAPS)),
  contributes: z
    .object({
      sources: z.array(z.string()).optional(),
      workers: z.array(z.string()).optional(),
      tools: z.array(z.string()).optional(),
      providers: z.array(z.string()).optional(),
      commands: z.array(z.object({ id: z.string(), title: z.string() })).optional(),
    })
    .default({}),
});

export function parseManifest(raw: unknown): Manifest {
  if (raw !== null && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    const looksLegacy = ('hostApi' in o || 'permissions' in o) && !('engine' in o && 'caps' in o);
    if (looksLegacy) {
      throw new ManifestError(
        'This extension was built for the legacy app and is not compatible with this build.',
      );
    }
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ManifestError(`invalid manifest: ${first.path.join('.')} — ${first.message}`);
  }
  const m = parsed.data;
  if (!semver.satisfies(PLATFORM_API_VERSION, m.engine)) {
    throw new ManifestError(
      `requires platform ${m.engine}; this build is ${PLATFORM_API_VERSION}`,
    );
  }
  return { ...m, id: m.id as ExtensionId };
}

export function validateManifestDir(dir: string): { manifest: Manifest; entryAbsPath: string } {
  const manifestPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new ManifestError('no manifest.json found in the extension package');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    throw new ManifestError('manifest.json is not valid JSON');
  }
  const manifest = parseManifest(raw);
  const root = path.resolve(dir);
  const entryAbsPath = path.resolve(root, manifest.entry);
  const rel = path.relative(root, entryAbsPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new ManifestError('entry must resolve inside the extension directory');
  }
  if (!fs.existsSync(entryAbsPath)) {
    throw new ManifestError(`entry not found: ${manifest.entry}`);
  }
  return { manifest, entryAbsPath };
}
```

- [ ] **Step 4: Run tests** — `npx jest src/main/platform/__tests__/manifest.test.ts` → PASS.

- [ ] **Step 5: Gates + commit**

```bash
npx tsc --noEmit ; npx jest
git add src/main/platform && git commit -m "feat(extensions): manifest schema validation with legacy-format rejection"
```

---

### Task 3: Disk state + discovery (`src/main/platform/extensions.ts`)

**Files:**
- Create: `src/main/platform/extensions.ts`
- Test: `src/main/platform/__tests__/extensions.test.ts`

**Interfaces:**
- Consumes: `validateManifestDir` (Task 2)
- Produces:
  - `interface InstalledRecord { id: string; version: string; ref: string; integrity: string | null; installedAt: string; origin: 'marketplace' | 'dev' }`
  - `readInstalled(extDir: string): InstalledRecord[]` / `writeInstalled(extDir: string, records: InstalledRecord[]): void`
  - `readEnabledState(extDir: string): Record<string, { enabled: boolean }>` / `writeEnabledState(extDir, state): void` (mode 0o600)
  - `interface DiscoveredExtension { dirName: string; dir: string; manifest?: Manifest; entryAbsPath?: string; error?: string }`
  - `discoverExtensions(extDir: string): DiscoveredExtension[]`

- [ ] **Step 1: Write the failing tests**

`src/main/platform/__tests__/extensions.test.ts`:

```ts
/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  discoverExtensions,
  readEnabledState,
  readInstalled,
  writeEnabledState,
  writeInstalled,
} from '../extensions';

const GOOD = {
  id: 'test.basic', name: 'Basic', version: '1.0.0', engine: '^1.0.0',
  entry: 'index.js', caps: ['net'], contributes: { sources: ['basicsrc'] },
};

function writeExt(extDir: string, dirName: string, manifest: unknown): void {
  const dir = path.join(extDir, dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = {};');
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
}

describe('extension disk state', () => {
  let extDir: string;
  beforeEach(() => {
    extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kia-extdir-'));
  });
  afterEach(() => fs.rmSync(extDir, { recursive: true, force: true }));

  it('installed.json round-trips and defaults to []', () => {
    expect(readInstalled(extDir)).toEqual([]);
    const rec = {
      id: 'test.basic', version: '1.0.0', ref: 'file:/tmp/x', integrity: null,
      installedAt: '2026-07-03T00:00:00.000Z', origin: 'dev' as const,
    };
    writeInstalled(extDir, [rec]);
    expect(readInstalled(extDir)).toEqual([rec]);
  });

  it('state.json round-trips, defaults to {}, and is mode 0600', () => {
    expect(readEnabledState(extDir)).toEqual({});
    writeEnabledState(extDir, { 'test.basic': { enabled: false } });
    expect(readEnabledState(extDir)).toEqual({ 'test.basic': { enabled: false } });
    const mode = fs.statSync(path.join(extDir, 'state.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('discovers valid extensions and reports invalid ones as errors', () => {
    writeExt(extDir, 'test.basic', GOOD);
    writeExt(extDir, 'bad.one', { ...GOOD, id: 'bad.one', caps: ['teleport'] });
    fs.writeFileSync(path.join(extDir, 'installed.json'), '[]'); // files are skipped
    const found = discoverExtensions(extDir);
    expect(found).toHaveLength(2);
    const ok = found.find((f) => f.dirName === 'test.basic')!;
    expect(ok.manifest?.id).toBe('test.basic');
    expect(ok.entryAbsPath).toBe(path.join(extDir, 'test.basic', 'index.js'));
    const bad = found.find((f) => f.dirName === 'bad.one')!;
    expect(bad.manifest).toBeUndefined();
    expect(bad.error).toMatch(/invalid manifest/);
  });

  it('returns [] when the extensions dir does not exist yet', () => {
    expect(discoverExtensions(path.join(extDir, 'missing'))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx jest src/main/platform/__tests__/extensions.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/main/platform/extensions.ts`**

```ts
/**
 * Disk-state helpers for userData/extensions/ — the installer-owned frozen
 * records (installed.json), the mutable enabled map (state.json, 0o600),
 * and manifest-only discovery. No extension code is ever loaded here.
 */
import fs from 'fs';
import path from 'path';

import type { Manifest } from '@shared/contracts';

import { validateManifestDir } from './manifest';

export interface InstalledRecord {
  id: string;
  version: string;
  ref: string;
  integrity: string | null; // SRI sha512 TOFU pin; null for origin 'dev'
  installedAt: string;
  origin: 'marketplace' | 'dev';
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

export function readInstalled(extDir: string): InstalledRecord[] {
  return readJson<InstalledRecord[]>(path.join(extDir, 'installed.json'), []);
}

export function writeInstalled(extDir: string, records: InstalledRecord[]): void {
  fs.mkdirSync(extDir, { recursive: true });
  fs.writeFileSync(path.join(extDir, 'installed.json'), JSON.stringify(records, null, 2));
}

export function readEnabledState(extDir: string): Record<string, { enabled: boolean }> {
  return readJson<Record<string, { enabled: boolean }>>(path.join(extDir, 'state.json'), {});
}

export function writeEnabledState(
  extDir: string,
  state: Record<string, { enabled: boolean }>,
): void {
  fs.mkdirSync(extDir, { recursive: true });
  fs.writeFileSync(path.join(extDir, 'state.json'), JSON.stringify(state, null, 2), {
    mode: 0o600,
  });
}

export interface DiscoveredExtension {
  dirName: string;
  dir: string;
  manifest?: Manifest;
  entryAbsPath?: string;
  error?: string;
}

export function discoverExtensions(extDir: string): DiscoveredExtension[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(extDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: DiscoveredExtension[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(extDir, e.name);
    try {
      const { manifest, entryAbsPath } = validateManifestDir(dir);
      out.push({ dirName: e.name, dir, manifest, entryAbsPath });
    } catch (err) {
      out.push({ dirName: e.name, dir, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}
```

- [ ] **Step 4: Run tests** — PASS. Note: `writeFileSync` with `mode` only applies at creation; that's fine (file is created by us).

- [ ] **Step 5: Gates + commit**

```bash
npx tsc --noEmit ; npx jest
git add src/main/platform && git commit -m "feat(extensions): disk state (installed/state.json) and manifest discovery"
```

---

### Task 4: Transports + RpcEndpoint (`src/main/platform/transport.ts`)

**Files:**
- Create: `src/main/platform/transport.ts`
- Test: `src/main/platform/__tests__/transport.test.ts`
- Test fixture: `src/main/platform/__tests__/fixtures/echo-child.js` (plain CJS, forked for the real-process test)

**Interfaces:**
- Consumes: `MainToChild`/`ChildToMain` types (Task 1)
- Produces:
  - `interface WireChannel { send(msg: unknown): void; onMessage(cb: (msg: unknown) => void): () => void; close(): void }`
  - `interface HostTransport extends WireChannel { onExit(cb: (code: number | null) => void): () => void; kill(): void }`
  - `createInMemoryHostPair(): { main: HostTransport; child: WireChannel; simulateExit(code: number | null): void }`
  - `nodeForkTransport(modulePath: string, opts?: { execArgv?: string[]; env?: NodeJS.ProcessEnv; cwd?: string }): HostTransport`
  - `utilityProcessTransport(modulePath: string, serviceName: string): HostTransport` (prod-only, thin, not unit-tested)
  - `interface RpcEndpoint { call(ns: string, method: string, args: unknown[]): Promise<unknown>; onCall(h: (ns: string, method: string, args: unknown[]) => Promise<unknown>): void; post(msg: Record<string, unknown>): void; onNotify(cb: (msg: { kind: string } & Record<string, unknown>) => void): () => void; dispose(reason: string): void }`
  - `createRpcEndpoint(channel: WireChannel): RpcEndpoint`

- [ ] **Step 1: Write the failing tests**

`src/main/platform/__tests__/transport.test.ts`:

```ts
/** @jest-environment node */
import path from 'path';

import { createInMemoryHostPair, createRpcEndpoint, nodeForkTransport } from '../transport';

describe('createRpcEndpoint over the in-memory pair', () => {
  it('correlates call → reply in both directions', async () => {
    const { main, child } = createInMemoryHostPair();
    const mainEp = createRpcEndpoint(main);
    const childEp = createRpcEndpoint(child);
    childEp.onCall(async (ns, method, args) => `${ns}.${method}(${args.join(',')})`);
    mainEp.onCall(async (ns) => `main saw ${ns}`);
    await expect(mainEp.call('query', 'search', [1, 2])).resolves.toBe('query.search(1,2)');
    await expect(childEp.call('auth', 'prompt', [])).resolves.toBe('main saw auth');
  });

  it('propagates handler errors as rejections with the message', async () => {
    const { main, child } = createInMemoryHostPair();
    const mainEp = createRpcEndpoint(main);
    createRpcEndpoint(child).onCall(async () => {
      throw new Error('CAP_DENIED: nope');
    });
    await expect(mainEp.call('db', 'exec', [])).rejects.toThrow('CAP_DENIED: nope');
  });

  it('delivers non-call messages to onNotify and dispose rejects in-flight calls', async () => {
    const { main, child } = createInMemoryHostPair();
    const mainEp = createRpcEndpoint(main);
    const childEp = createRpcEndpoint(child);
    const seen: string[] = [];
    childEp.onNotify((m) => seen.push(m.kind));
    mainEp.post({ kind: 'src-next', pullId: 1 });
    await new Promise((r) => { setTimeout(r, 10); });
    expect(seen).toEqual(['src-next']);

    const pending = mainEp.call('query', 'count', []); // child has no onCall → hangs
    mainEp.dispose('process exited');
    await expect(pending).rejects.toThrow('process exited');
  });
});

describe('nodeForkTransport (real child process)', () => {
  it('round-trips a message with an echoing plain-JS child and reports exit', async () => {
    const fixture = path.join(__dirname, 'fixtures', 'echo-child.js');
    const t = nodeForkTransport(fixture);
    const got = new Promise<unknown>((resolve) => {
      const off = t.onMessage((m) => { off(); resolve(m); });
    });
    t.send({ kind: 'ping', n: 41 });
    await expect(got).resolves.toEqual({ kind: 'pong', n: 42 });
    const exited = new Promise<number | null>((resolve) => t.onExit(resolve));
    t.send({ kind: 'quit' });
    await expect(exited).resolves.toBe(0);
  }, 15000);
});
```

`src/main/platform/__tests__/fixtures/echo-child.js`:

```js
// Plain-CJS echo child for transport tests — no build step needed.
process.on('message', (m) => {
  if (m && m.kind === 'ping') process.send({ kind: 'pong', n: m.n + 1 });
  if (m && m.kind === 'quit') process.exit(0);
});
```

- [ ] **Step 2: Run to verify failure** — `npx jest src/main/platform/__tests__/transport.test.ts` → FAIL.

- [ ] **Step 3: Implement `src/main/platform/transport.ts`**

```ts
/**
 * Process transports for extension hosts + the bidirectional call/reply
 * endpoint both sides speak. utilityProcess does not exist under jest, so
 * everything above the transport is written against WireChannel/HostTransport
 * and tested over the in-memory pair or child_process.fork.
 */
import { fork } from 'child_process';

export interface WireChannel {
  send(msg: unknown): void;
  onMessage(cb: (msg: unknown) => void): () => void;
  close(): void;
}

export interface HostTransport extends WireChannel {
  onExit(cb: (code: number | null) => void): () => void;
  kill(): void;
}

export function createInMemoryHostPair(): {
  main: HostTransport;
  child: WireChannel;
  simulateExit(code: number | null): void;
} {
  const toChild = new Set<(m: unknown) => void>();
  const toMain = new Set<(m: unknown) => void>();
  const exitCbs = new Set<(code: number | null) => void>();
  let closed = false;
  const deliver = (subs: Set<(m: unknown) => void>, msg: unknown) => {
    if (closed) return;
    queueMicrotask(() => {
      if (!closed) subs.forEach((cb) => cb(msg));
    });
  };
  const simulateExit = (code: number | null) => {
    if (closed) return;
    closed = true;
    exitCbs.forEach((cb) => cb(code));
  };
  return {
    main: {
      send: (m) => deliver(toChild, m),
      onMessage: (cb) => {
        toMain.add(cb);
        return () => toMain.delete(cb);
      },
      onExit: (cb) => {
        exitCbs.add(cb);
        return () => exitCbs.delete(cb);
      },
      kill: () => simulateExit(null),
      close: () => simulateExit(null),
    },
    child: {
      send: (m) => deliver(toMain, m),
      onMessage: (cb) => {
        toChild.add(cb);
        return () => toChild.delete(cb);
      },
      close: () => simulateExit(0),
    },
    simulateExit,
  };
}

export function nodeForkTransport(
  modulePath: string,
  opts?: { execArgv?: string[]; env?: NodeJS.ProcessEnv; cwd?: string },
): HostTransport {
  const cp = fork(modulePath, [], {
    serialization: 'advanced',
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    execArgv: opts?.execArgv ?? [],
    env: opts?.env ?? process.env,
    cwd: opts?.cwd,
  });
  return {
    send: (m) => {
      try {
        cp.send(m as object);
      } catch {
        /* raced an exit — the onExit path owns recovery */
      }
    },
    onMessage: (cb) => {
      cp.on('message', cb);
      return () => cp.off('message', cb);
    },
    onExit: (cb) => {
      const h = (code: number | null) => cb(code);
      cp.on('exit', h);
      return () => cp.off('exit', h);
    },
    kill: () => cp.kill(),
    close: () => cp.kill(),
  };
}

/** Prod transport. Kept thin and untested — everything above it is covered
 *  over the other two transports. */
export function utilityProcessTransport(modulePath: string, serviceName: string): HostTransport {
  // Lazy-required so importing this module under jest (no electron) is safe.
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  const { utilityProcess } = require('electron') as typeof import('electron');
  const child = utilityProcess.fork(modulePath, [], { serviceName, stdio: 'ignore' });
  return {
    send: (m) => child.postMessage(m),
    onMessage: (cb) => {
      const h = (e: Electron.MessageEvent) => cb(e.data);
      child.on('message', h);
      return () => {
        child.off('message', h);
      };
    },
    onExit: (cb) => {
      const h = (code: number) => cb(code);
      child.on('exit', h);
      return () => {
        child.off('exit', h);
      };
    },
    kill: () => {
      child.kill();
    },
    close: () => {
      child.kill();
    },
  };
}

export interface RpcEndpoint {
  call(ns: string, method: string, args: unknown[]): Promise<unknown>;
  onCall(h: (ns: string, method: string, args: unknown[]) => Promise<unknown>): void;
  post(msg: Record<string, unknown>): void;
  onNotify(cb: (msg: { kind: string } & Record<string, unknown>) => void): () => void;
  dispose(reason: string): void;
}

interface CallMsg { kind: 'call'; id: number; ns: string; method: string; args: unknown[] }
interface ReplyMsg { kind: 'reply'; id: number; ok: boolean; value?: unknown; error?: string }

export function createRpcEndpoint(channel: WireChannel): RpcEndpoint {
  let nextId = 1;
  let disposed = false;
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  const notifySubs = new Set<(msg: { kind: string } & Record<string, unknown>) => void>();
  let handler: ((ns: string, method: string, args: unknown[]) => Promise<unknown>) | null = null;

  const offMessage = channel.onMessage((raw) => {
    const msg = raw as { kind?: string };
    if (!msg || typeof msg.kind !== 'string') return;
    if (msg.kind === 'call') {
      const c = msg as CallMsg;
      const h = handler;
      const reply = (ok: boolean, value?: unknown, error?: string) =>
        channel.send({ kind: 'reply', id: c.id, ok, value, error } satisfies ReplyMsg);
      if (!h) {
        reply(false, undefined, 'no call handler installed');
        return;
      }
      h(c.ns, c.method, c.args).then(
        (value) => reply(true, value),
        (e) => reply(false, undefined, e instanceof Error ? e.message : String(e)),
      );
      return;
    }
    if (msg.kind === 'reply') {
      const r = msg as ReplyMsg;
      const p = pending.get(r.id);
      if (!p) return;
      pending.delete(r.id);
      if (r.ok) p.resolve(r.value);
      else p.reject(new Error(r.error ?? 'remote error'));
      return;
    }
    notifySubs.forEach((cb) => cb(msg as { kind: string } & Record<string, unknown>));
  });

  return {
    call(ns, method, args) {
      if (disposed) return Promise.reject(new Error('endpoint disposed'));
      const id = nextId;
      nextId += 1;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        channel.send({ kind: 'call', id, ns, method, args } satisfies CallMsg);
      });
    },
    onCall(h) {
      handler = h;
    },
    post(msg) {
      if (!disposed) channel.send(msg);
    },
    onNotify(cb) {
      notifySubs.add(cb);
      return () => notifySubs.delete(cb);
    },
    dispose(reason) {
      if (disposed) return;
      disposed = true;
      offMessage();
      const err = new Error(reason);
      pending.forEach((p) => p.reject(err));
      pending.clear();
      notifySubs.clear();
    },
  };
}
```

- [ ] **Step 4: Run tests** — PASS.

- [ ] **Step 5: Gates + commit**

```bash
npx tsc --noEmit ; npx jest
git add src/main/platform && git commit -m "feat(extensions): host transports (utilityProcess/fork/in-memory) and RPC endpoint"
```

---

### Task 5: Capability surfaces + event bus (`src/main/platform/host-surfaces.ts`)

**Files:**
- Create: `src/main/platform/host-surfaces.ts`
- Test: `src/main/platform/__tests__/host-surfaces.test.ts`

**Interfaces:**
- Consumes: `Query`, `LogLevel` from `@shared/contracts`; better-sqlite3
- Produces:
  - `class CapError extends Error {}`
  - `interface EventBus { emit(from: string, event: string, payload: unknown): void; subscribe(extensionId: string, event: string, deliver: (payload: unknown) => void): () => void }` + `createEventBus(): EventBus`
  - `type Surfaces = Record<string, Record<string, (...args: unknown[]) => unknown>>`
  - `buildSurfaces(deps: SurfaceDeps): { surfaces: Surfaces; close(): void }` where `SurfaceDeps = { extensionId: string; dataDir: string; query: Query; inference: { complete(prompt: string, opts?: { maxTokens?: number; lane?: 'interactive' | 'background' }): Promise<string>; see(image: Uint8Array, prompt: string, opts?: { mime?: string; lane?: 'interactive' | 'background' }): Promise<string>; read(image: Uint8Array, opts?: { mime?: string; lane?: 'interactive' | 'background' }): Promise<string> }; notify(msg: string, level?: LogLevel): void; bus: EventBus; deliverEvent(name: string, payload: unknown): void }`

**Semantics to implement (from the spec §3.7):**
- `query.*` → delegate `search/document/children/byExternalId/count/accounts` to `deps.query`.
- `net.fetch(url, init)` → global `fetch`; only `http:`/`https:` URLs; `init` subset `{ method, headers, body }` (body `string | Uint8Array`); returns `{ status, statusText, headers: Record<string,string>, body: Uint8Array }`.
- `db.exec(sql, params?)` / `db.query(sql, params?)` → lazily-opened better-sqlite3 file at `<dataDir>/private.db` (`fs.mkdirSync(dataDir, { recursive: true })` first). `exec` with no params uses `db.exec(sql)` (multi-statement DDL), with params uses `prepare(sql).run(...params)`; `query` uses `prepare(sql).all(...params)`.
- `ui.notify(msg, level?)` → `deps.notify(msg, level)`.
- `inference.complete/see/read` → delegate with `lane` forced to `'interactive'` (override whatever the caller passed).
- `events.on(event)` → `bus.subscribe(extensionId, event, (p) => deliverEvent(event, p))`, disposer kept in a per-event map; `events.off(event)` disposes; `events.emit(event, payload)` → `bus.emit(extensionId, event, payload)`. Bus delivers to ALL subscribers of that event name (including the emitter).
- `files.*` (list/read/write/move) and `commands.*` (register) → every method throws `new CapError("the '<ns>' capability is not supported in this build yet")`.
- `close()` → close the private db if opened, dispose all event subscriptions.

- [ ] **Step 1: Write the failing tests**

`src/main/platform/__tests__/host-surfaces.test.ts`:

```ts
/** @jest-environment node */
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

import type { Query } from '@shared/contracts';

import { buildSurfaces, CapError, createEventBus } from '../host-surfaces';

const fakeQuery = {
  document: jest.fn(async () => null),
  children: jest.fn(async () => []),
  byExternalId: jest.fn(async () => null),
  search: jest.fn(async () => [{ id: 'd1' }]),
  count: jest.fn(async () => 7),
  accounts: jest.fn(async () => []),
} as unknown as Query;

function makeDeps(overrides: Partial<Parameters<typeof buildSurfaces>[0]> = {}) {
  const bus = createEventBus();
  const events: Array<{ name: string; payload: unknown }> = [];
  return {
    events,
    deps: {
      extensionId: 'test.basic',
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'kia-ext-data-')),
      query: fakeQuery,
      inference: {
        complete: jest.fn(async (_p: string, opts?: { lane?: string }) => `lane:${opts?.lane}`),
        see: jest.fn(async () => 'seen'),
        read: jest.fn(async () => 'read'),
      },
      notify: jest.fn(),
      bus,
      deliverEvent: (name: string, payload: unknown) => events.push({ name, payload }),
      ...overrides,
    },
  };
}

describe('buildSurfaces', () => {
  it('query delegates and count round-trips', async () => {
    const { deps } = makeDeps();
    const { surfaces, close } = buildSurfaces(deps);
    await expect(surfaces.query.count({})).resolves.toBe(7);
    await expect(surfaces.query.search({})).resolves.toEqual([{ id: 'd1' }]);
    close();
  });

  it('db is a private sqlite file under dataDir that round-trips rows', async () => {
    const { deps } = makeDeps();
    const { surfaces, close } = buildSurfaces(deps);
    await surfaces.db.exec('CREATE TABLE t (a TEXT)');
    await surfaces.db.exec('INSERT INTO t VALUES (?)', ['hello']);
    await expect(surfaces.db.query('SELECT a FROM t')).resolves.toEqual([{ a: 'hello' }]);
    close();
    expect(fs.existsSync(path.join(deps.dataDir, 'private.db'))).toBe(true);
  });

  it('net.fetch hits a real server and returns bytes; rejects non-http urls', async () => {
    const srv = http.createServer((_req, res) => {
      res.writeHead(201, { 'x-kia': 'yes' });
      res.end('body!');
    });
    await new Promise<void>((r) => { srv.listen(0, '127.0.0.1', r); });
    const port = (srv.address() as { port: number }).port;
    const { deps } = makeDeps();
    const { surfaces, close } = buildSurfaces(deps);
    const res = (await surfaces.net.fetch(`http://127.0.0.1:${port}/`)) as {
      status: number; headers: Record<string, string>; body: Uint8Array;
    };
    expect(res.status).toBe(201);
    expect(res.headers['x-kia']).toBe('yes');
    expect(Buffer.from(res.body).toString()).toBe('body!');
    await expect(surfaces.net.fetch('file:///etc/passwd')).rejects.toThrow(/http/);
    close();
    srv.close();
  });

  it('inference forces the interactive lane', async () => {
    const { deps } = makeDeps();
    const { surfaces, close } = buildSurfaces(deps);
    await expect(
      surfaces.inference.complete('p', { lane: 'background' } as never),
    ).resolves.toBe('lane:interactive');
    close();
  });

  it('events: on delivers bus emissions, off stops them, emit reaches other subscribers', async () => {
    const bus = createEventBus();
    const a = makeDeps({ bus });
    const b = makeDeps({ bus, extensionId: 'other.ext' } as never);
    const sa = buildSurfaces(a.deps);
    const sb = buildSurfaces(b.deps);
    sa.surfaces.events.on('ping');
    sb.surfaces.events.emit('ping', { n: 1 });
    await new Promise((r) => { setTimeout(r, 5); });
    expect(a.events).toEqual([{ name: 'ping', payload: { n: 1 } }]);
    sa.surfaces.events.off('ping');
    sb.surfaces.events.emit('ping', { n: 2 });
    await new Promise((r) => { setTimeout(r, 5); });
    expect(a.events).toHaveLength(1);
    sa.close();
    sb.close();
  });

  it('files and commands throw CapError', async () => {
    const { deps } = makeDeps();
    const { surfaces, close } = buildSurfaces(deps);
    expect(() => surfaces.files.read('x')).toThrow(CapError);
    expect(() => surfaces.commands.register('c')).toThrow(/not supported in this build yet/);
    close();
  });
});
```

- [ ] **Step 2: Run to verify failure**, then implement `src/main/platform/host-surfaces.ts`:

```ts
/**
 * The REAL capability implementations behind HostFor<G> namespaces — all
 * main-side; the child only holds proxies. One instance per extension per
 * host incarnation. files/commands are declared-but-rejected in this build
 * (spec §3.7): the cap validates and consents, but calls fail loudly.
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import type { LogLevel, Query } from '@shared/contracts';

export class CapError extends Error {}

export interface EventBus {
  emit(from: string, event: string, payload: unknown): void;
  subscribe(extensionId: string, event: string, deliver: (payload: unknown) => void): () => void;
}

export function createEventBus(): EventBus {
  const subs = new Map<string, Set<(payload: unknown) => void>>();
  return {
    emit(_from, event, payload) {
      subs.get(event)?.forEach((cb) => cb(payload));
    },
    subscribe(_extensionId, event, deliver) {
      let set = subs.get(event);
      if (!set) {
        set = new Set();
        subs.set(event, set);
      }
      set.add(deliver);
      return () => {
        set!.delete(deliver);
      };
    },
  };
}

export type Surfaces = Record<string, Record<string, (...args: unknown[]) => unknown>>;

export interface SurfaceDeps {
  extensionId: string;
  dataDir: string;
  query: Query;
  inference: {
    complete(prompt: string, opts?: { maxTokens?: number; lane?: 'interactive' | 'background' }): Promise<string>;
    see(image: Uint8Array, prompt: string, opts?: { mime?: string; lane?: 'interactive' | 'background' }): Promise<string>;
    read(image: Uint8Array, opts?: { mime?: string; lane?: 'interactive' | 'background' }): Promise<string>;
  };
  notify(msg: string, level?: LogLevel): void;
  bus: EventBus;
  /** Ships a host event to the child (endpoint.post({kind:'event',…})). */
  deliverEvent(name: string, payload: unknown): void;
}

const unsupported = (ns: string) => () => {
  throw new CapError(`the '${ns}' capability is not supported in this build yet`);
};

export function buildSurfaces(deps: SurfaceDeps): { surfaces: Surfaces; close(): void } {
  let db: Database.Database | null = null;
  const openDb = () => {
    if (!db) {
      fs.mkdirSync(deps.dataDir, { recursive: true });
      db = new Database(path.join(deps.dataDir, 'private.db'));
    }
    return db;
  };
  const eventSubs = new Map<string, () => void>();

  const surfaces: Surfaces = {
    query: {
      search: (q) => deps.query.search((q ?? {}) as never),
      document: (id) => deps.query.document(id as never),
      children: (id) => deps.query.children(id as never),
      byExternalId: (ref) => deps.query.byExternalId(ref as never),
      count: (q) => deps.query.count((q ?? {}) as never),
      accounts: () => deps.query.accounts(),
    },
    net: {
      async fetch(url, init) {
        const u = String(url);
        if (!/^https?:\/\//.test(u)) throw new Error('net.fetch only supports http(s) URLs');
        const i = (init ?? {}) as { method?: string; headers?: Record<string, string>; body?: string | Uint8Array };
        const res = await fetch(u, { method: i.method, headers: i.headers, body: i.body });
        return {
          status: res.status,
          statusText: res.statusText,
          headers: Object.fromEntries(res.headers.entries()),
          body: new Uint8Array(await res.arrayBuffer()),
        };
      },
    },
    db: {
      async exec(sql, params) {
        const d = openDb();
        const p = (params ?? []) as unknown[];
        if (p.length === 0) d.exec(String(sql));
        else d.prepare(String(sql)).run(...p);
      },
      async query(sql, params) {
        return openDb().prepare(String(sql)).all(...(((params ?? []) as unknown[])));
      },
    },
    ui: {
      notify: (msg, level) => deps.notify(String(msg), level as LogLevel | undefined),
    },
    inference: {
      complete: (prompt, opts) =>
        deps.inference.complete(String(prompt), { ...(opts as object), lane: 'interactive' }),
      see: (image, prompt, opts) =>
        deps.inference.see(image as Uint8Array, String(prompt), { ...(opts as object), lane: 'interactive' }),
      read: (image, opts) =>
        deps.inference.read(image as Uint8Array, { ...(opts as object), lane: 'interactive' }),
    },
    events: {
      on(event) {
        const name = String(event);
        if (eventSubs.has(name)) return;
        eventSubs.set(
          name,
          deps.bus.subscribe(deps.extensionId, name, (p) => deps.deliverEvent(name, p)),
        );
      },
      off(event) {
        const name = String(event);
        eventSubs.get(name)?.();
        eventSubs.delete(name);
      },
      emit(event, payload) {
        deps.bus.emit(deps.extensionId, String(event), payload);
      },
    },
    files: {
      list: unsupported('files'),
      read: unsupported('files'),
      write: unsupported('files'),
      move: unsupported('files'),
    },
    commands: { register: unsupported('commands') },
  };

  return {
    surfaces,
    close() {
      eventSubs.forEach((off) => off());
      eventSubs.clear();
      db?.close();
      db = null;
    },
  };
}
```

- [ ] **Step 3: Run tests** — PASS.

- [ ] **Step 4: Gates + commit**

```bash
npx tsc --noEmit ; npx jest
git add src/main/platform && git commit -m "feat(extensions): capability surfaces (query/net/db/ui/inference/events) and event bus"
```

---

### Task 6: HostRouter — the runtime gate() (`src/main/platform/host-router.ts`)

**Files:**
- Create: `src/main/platform/host-router.ts`
- Test: `src/main/platform/__tests__/host-router.test.ts`

**Interfaces:**
- Consumes: `Surfaces` (Task 5); `Cap`, `LogLevel` from contracts; `LogSink` shape `{ log(scope: string, level: LogLevel, msg: string, fields?: Record<string, unknown>): void }` (import type from `@main/core/engine/engine`)
- Produces: `createHostRouter(opts: { extensionId: string; granted: ReadonlySet<Cap>; surfaces: Surfaces; logSink: LogSink }): { dispatch(ns: string, method: string, args: unknown[]): Promise<unknown> }`

**Semantics:** `ns === 'base'` is ungated: only method `log(level, msg)` → `logSink.log('extension:<id>', level, msg)`. Otherwise ns must be one of the 8 cap names (the 1:1 map IS the permission table); ungranted → log `permission-violation` (level `warn`, fields `{ ns, method }`) and throw `` `CAP_DENIED: extension was not granted the '<cap>' capability` ``; unknown ns or method → plain Error.

- [ ] **Step 1: Write the failing tests**

`src/main/platform/__tests__/host-router.test.ts`:

```ts
/** @jest-environment node */
import type { Cap } from '@shared/contracts';

import { createHostRouter } from '../host-router';

const logs: Array<{ scope: string; level: string; msg: string; fields?: unknown }> = [];
const logSink = { log: (scope: string, level: never, msg: string, fields?: never) => logs.push({ scope, level, msg, fields }) };

const surfaces = {
  query: { count: jest.fn(async () => 3) },
  net: { fetch: jest.fn(async () => ({ status: 200 })) },
} as never;

function router(granted: Cap[]) {
  logs.length = 0;
  return createHostRouter({ extensionId: 'test.basic', granted: new Set(granted), surfaces, logSink });
}

describe('createHostRouter', () => {
  it('dispatches granted namespaces to the surface', async () => {
    await expect(router(['query']).dispatch('query', 'count', [{}])).resolves.toBe(3);
  });

  it('denies ungranted caps with CAP_DENIED and logs a permission-violation', async () => {
    const r = router(['query']);
    await expect(r.dispatch('net', 'fetch', ['http://x'])).rejects.toThrow(
      "CAP_DENIED: extension was not granted the 'net' capability",
    );
    expect(logs).toContainEqual(
      expect.objectContaining({ scope: 'extension:test.basic', msg: 'permission-violation' }),
    );
  });

  it('base.log is always available and unknown ns/method fail', async () => {
    const r = router([]);
    await expect(r.dispatch('base', 'log', ['info', 'hi'])).resolves.toBeUndefined();
    expect(logs).toContainEqual(expect.objectContaining({ msg: 'hi' }));
    await expect(r.dispatch('teleport', 'go', [])).rejects.toThrow(/unknown namespace/);
    await expect(r.dispatch('query', 'nope', [])).rejects.toThrow(/unknown method/);
  });
});
```

- [ ] **Step 2: Run to verify failure**, then implement `src/main/platform/host-router.ts`:

```ts
/**
 * THE runtime gate() (concept/model.ts §5): every host call an extension
 * makes lands here BEFORE any real capability code runs. Greenfield caps
 * map 1:1 to host namespaces, so the permission table is this lookup —
 * no per-method map like the legacy 38-method HOST_SURFACE needed.
 */
import type { Cap, LogLevel } from '@shared/contracts';
import type { LogSink } from '@main/core/engine/engine';

import type { Surfaces } from './host-surfaces';

const NS_CAP: Record<string, Cap> = {
  query: 'query',
  net: 'net',
  files: 'files',
  db: 'db',
  ui: 'ui',
  commands: 'commands',
  inference: 'inference',
  events: 'events',
};

export function createHostRouter(opts: {
  extensionId: string;
  granted: ReadonlySet<Cap>;
  surfaces: Surfaces;
  logSink: LogSink;
}): { dispatch(ns: string, method: string, args: unknown[]): Promise<unknown> } {
  const scope = `extension:${opts.extensionId}`;
  return {
    async dispatch(ns, method, args) {
      if (ns === 'base') {
        if (method === 'log') {
          opts.logSink.log(scope, args[0] as LogLevel, String(args[1]));
          return undefined;
        }
        throw new Error(`unknown method base.${method}`);
      }
      const cap = NS_CAP[ns];
      if (!cap) throw new Error(`unknown namespace ${ns}`);
      if (!opts.granted.has(cap)) {
        opts.logSink.log(scope, 'warn', 'permission-violation', { ns, method });
        throw new Error(`CAP_DENIED: extension was not granted the '${cap}' capability`);
      }
      const fn = opts.surfaces[ns]?.[method];
      if (!fn) throw new Error(`unknown method ${ns}.${method}`);
      return fn(...args);
    },
  };
}
```

- [ ] **Step 3: Run tests** — PASS. **Step 4: Gates + commit**

```bash
npx tsc --noEmit ; npx jest
git add src/main/platform && git commit -m "feat(extensions): HostRouter cap gating (the runtime gate())"
```

---

### Task 7: Child runtime — bootstrap, host proxy, activate, tools (`src/main/platform/extension-host-entry.ts`)

Replaces the `export {}` stub. Webpack already builds this file as the `extensionHost` entry in BOTH `.erb/configs/webpack.config.main.dev.ts` and `.erb/configs/webpack.config.main.prod.ts` — no config change needed.

**Files:**
- Modify: `src/main/platform/extension-host-entry.ts` (replace stub)
- Test: `src/main/platform/__tests__/extension-host-entry.test.ts`

**Interfaces:**
- Consumes: `WireChannel`, `createRpcEndpoint` (Task 4); wire types (Task 1)
- Produces:
  - `interface ChildDeps { requireModule?(p: string): unknown; exit?(code: number): void }`
  - `runExtensionHost(channel: WireChannel, deps?: ChildDeps): void` — exported for in-process tests
  - `connectParentChannel(): WireChannel` — utilityProcess (`process.parentPort`) vs node fork (`process.send`) adapter
  - Auto-runs ONLY when `process.parentPort` exists (utilityProcess) or `process.env.KIA_EXT_HOST_CHILD === '1'` (test forks) — a bare jest import must NOT start anything.

**Child behavior (spec §3.5/§3.6):** on `bootstrap` → `requireModule(entryAbsPath)`, take `mod.default ?? mod` as `ExtensionModule` → send `{ready}` → build the remote host from `bootstrap.caps` → `await module.activate(host)` → send `{activated, contributions}` (descriptors only; sources/tools kept in child maps). Any throw → `{errored, error}`. `deactivate` → `await module.deactivate?.()` → `exit(0)`. Host proxy: each cap namespace's methods call `endpoint.call(ns, method, args)`; `self` is local from bootstrap; `log` → `base.log`; `events.on(event, cb)` keeps a local `Map<string, Set<cb>>`, calls `events.on` remotely once per event name, returns a disposer that calls `events.off` when the last cb is removed; incoming `{kind:'event'}` dispatches to local cbs. Tool calls arrive as main→child `call` with `ns:'tool'`, `method:<toolName>`, `args:[argsObject]`.

Known method lists for proxying: `query: search/document/children/byExternalId/count/accounts`; `net: fetch`; `db: exec/query`; `ui: notify`; `inference: complete/see/read`; `files: list/read/write/move`; `commands: register`.

This task implements everything EXCEPT the source runner (`source` ns calls + `src-next`/`src-abort`), which is Task 8 in the same file.

- [ ] **Step 1: Write the failing tests**

`src/main/platform/__tests__/extension-host-entry.test.ts`:

```ts
/** @jest-environment node */
import type { Cap } from '@shared/contracts';
import type { ChildToMain, Contributions } from '@shared/extension-rpc';

import { runExtensionHost } from '../extension-host-entry';
import { createInMemoryHostPair, createRpcEndpoint } from '../transport';

const BOOT = {
  kind: 'bootstrap' as const,
  v: 1 as const,
  extensionId: 'test.basic',
  entryAbsPath: '/virtual/entry.js',
  dataDir: '/virtual/data',
  caps: ['query', 'net'] as Cap[],
};

/** Boots the child runtime in-process against a scripted module. */
function boot(mod: unknown) {
  const { main, child } = createInMemoryHostPair();
  const mainEp = createRpcEndpoint(main);
  const exit = jest.fn();
  const requireModule = jest.fn(() => mod);
  runExtensionHost(child, { requireModule, exit });
  const waitFor = <K extends ChildToMain['kind']>(kind: K) =>
    new Promise<Extract<ChildToMain, { kind: K }>>((resolve) => {
      const off = mainEp.onNotify((m) => {
        if (m.kind === kind) {
          off();
          resolve(m as never);
        }
      });
    });
  return { mainEp, exit, requireModule, waitFor };
}

describe('runExtensionHost — bootstrap/activate', () => {
  it('requires the entry, activates, and reports contribution descriptors', async () => {
    const activate = jest.fn(async () => ({
      sources: [],
      tools: [{ name: 'echo', description: 'd', inputSchema: {}, call: async (a: unknown) => a }],
    }));
    const { mainEp, waitFor, requireModule } = boot({ default: { activate } });
    const activated = waitFor('activated');
    const ready = waitFor('ready');
    mainEp.post(BOOT);
    await ready;
    const { contributions } = (await activated) as { contributions: Contributions };
    expect(requireModule).toHaveBeenCalledWith('/virtual/entry.js');
    expect(contributions.tools).toEqual([
      { name: 'echo', description: 'd', inputSchema: {}, tier: undefined },
    ]);
    expect(activate).toHaveBeenCalled();
  });

  it('host proxy: activate() can call query through the endpoint; self is local', async () => {
    let seenSelf: unknown;
    const mod = {
      async activate(host: { self: { id: string; dataDir: string }; query: { count(q: unknown): Promise<number> } }) {
        seenSelf = host.self;
        const n = await host.query.count({});
        return { tools: [{ name: 't', description: String(n), inputSchema: {}, call: async () => n }] };
      },
    };
    const { mainEp, waitFor } = boot(mod);
    mainEp.onCall(async (ns, method) => (ns === 'query' && method === 'count' ? 42 : null));
    const activated = waitFor('activated');
    mainEp.post(BOOT);
    const { contributions } = (await activated) as { contributions: Contributions };
    expect(seenSelf).toEqual({ id: 'test.basic', dataDir: '/virtual/data' });
    expect(contributions.tools[0].description).toBe('42');
  });

  it('tool calls dispatch to the kept tool object', async () => {
    const mod = {
      async activate() {
        return { tools: [{ name: 'sum', description: '', inputSchema: {}, call: async (a: { x: number }) => a.x + 1 }] };
      },
    };
    const { mainEp, waitFor } = boot(mod);
    const activated = waitFor('activated');
    mainEp.post(BOOT);
    await activated;
    await expect(mainEp.call('tool', 'sum', [{ x: 4 }])).resolves.toBe(5);
  });

  it('a throwing activate sends errored; deactivate runs the hook then exits 0', async () => {
    const bad = boot({ activate: async () => { throw new Error('boom'); } });
    const errored = bad.waitFor('errored');
    bad.mainEp.post(BOOT);
    expect((await errored).error).toMatch(/boom/);

    const deactivate = jest.fn();
    const good = boot({ activate: async () => ({}), deactivate });
    const activated = good.waitFor('activated');
    good.mainEp.post(BOOT);
    await activated;
    good.mainEp.post({ kind: 'deactivate' });
    await new Promise((r) => { setTimeout(r, 10); });
    expect(deactivate).toHaveBeenCalled();
    expect(good.exit).toHaveBeenCalledWith(0);
  });

  it('events: remote emissions dispatch to locally-registered callbacks', async () => {
    const seen: unknown[] = [];
    const mod = {
      async activate(host: { events: { on(e: string, cb: (p: unknown) => void): () => void } }) {
        host.events.on('ping', (p) => seen.push(p));
        return {};
      },
    };
    const { mainEp, waitFor } = boot(mod);
    mainEp.onCall(async () => undefined); // accepts the events.on registration
    const activated = waitFor('activated');
    mainEp.post(BOOT);
    await activated;
    mainEp.post({ kind: 'event', name: 'ping', payload: { n: 1 } });
    await new Promise((r) => { setTimeout(r, 10); });
    expect(seen).toEqual([{ n: 1 }]);
  });
});
```

- [ ] **Step 2: Run to verify failure**, then replace `src/main/platform/extension-host-entry.ts`:

```ts
/**
 * Extension host CHILD entry — the module utilityProcess forks (webpack
 * `extensionHost` entry; test forks run it via ts-node with
 * KIA_EXT_HOST_CHILD=1). Loads ONE extension bundle, hands it a remote-host
 * proxy whose every namespaced call crosses to main (where HostRouter — the
 * real gate — enforces caps), and runs its contributed sources/tools on
 * demand. Exports runExtensionHost for in-process tests; a bare import
 * starts nothing.
 */
import type { Cap, ExtensionModule, McpTool, Source } from '@shared/contracts';
import type { Contributions, ExtensionBootstrap, MainToChild } from '@shared/extension-rpc';

import { createRpcEndpoint, type RpcEndpoint, type WireChannel } from './transport';

export interface ChildDeps {
  requireModule?(p: string): unknown;
  exit?(code: number): void;
}

const NS_METHODS: Record<string, string[]> = {
  query: ['search', 'document', 'children', 'byExternalId', 'count', 'accounts'],
  net: ['fetch'],
  db: ['exec', 'query'],
  ui: ['notify'],
  inference: ['complete', 'see', 'read'],
  files: ['list', 'read', 'write', 'move'],
  commands: ['register'],
};

function buildRemoteHost(
  endpoint: RpcEndpoint,
  boot: ExtensionBootstrap,
  eventCbs: Map<string, Set<(p: unknown) => void>>,
): Record<string, unknown> {
  const host: Record<string, unknown> = {
    self: { id: boot.extensionId, dataDir: boot.dataDir },
    log: (level: unknown, msg: unknown) => {
      void endpoint.call('base', 'log', [level, msg]).catch(() => {});
    },
  };
  for (const cap of boot.caps) {
    if (cap === 'events') {
      host.events = {
        on(event: string, cb: (p: unknown) => void) {
          let set = eventCbs.get(event);
          if (!set) {
            set = new Set();
            eventCbs.set(event, set);
            void endpoint.call('events', 'on', [event]).catch(() => {});
          }
          set.add(cb);
          return () => {
            set!.delete(cb);
            if (set!.size === 0) {
              eventCbs.delete(event);
              void endpoint.call('events', 'off', [event]).catch(() => {});
            }
          };
        },
        emit(event: string, payload: unknown) {
          void endpoint.call('events', 'emit', [event, payload]).catch(() => {});
        },
      };
      continue;
    }
    const methods = NS_METHODS[cap];
    if (!methods) continue;
    const nsObj: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    for (const m of methods) {
      nsObj[m] = (...args: unknown[]) => endpoint.call(cap, m, args);
    }
    host[cap] = nsObj;
  }
  return host;
}

export function runExtensionHost(channel: WireChannel, deps: ChildDeps = {}): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  const requireModule = deps.requireModule ?? ((p: string) => require(p));
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const endpoint = createRpcEndpoint(channel);

  let mod: ExtensionModule | null = null;
  const sources = new Map<string, Source>();
  const tools = new Map<string, McpTool>();
  const eventCbs = new Map<string, Set<(p: unknown) => void>>();
  // Task 8 fills these in: active pulls keyed by pullId.
  const pulls = new Map<
    number,
    { iterator: AsyncIterator<unknown>; abort: AbortController; source: Source; mode: 'batch' | 'refs' }
  >();

  const fail = (e: unknown) =>
    endpoint.post({ kind: 'errored', error: e instanceof Error ? e.message : String(e) });

  async function onBootstrap(boot: ExtensionBootstrap): Promise<void> {
    try {
      const loaded = requireModule(boot.entryAbsPath) as { default?: ExtensionModule };
      mod = (loaded.default ?? loaded) as ExtensionModule;
      if (typeof mod.activate !== 'function') throw new Error('extension has no activate()');
      endpoint.post({ kind: 'ready' });
      const host = buildRemoteHost(endpoint, boot, eventCbs);
      const contrib = await mod.activate(host as never);
      for (const s of contrib.sources ?? []) sources.set(s.descriptor.id, s);
      for (const t of contrib.tools ?? []) tools.set(t.name, t);
      const contributions: Contributions = {
        sources: [...sources.values()].map((s) => ({
          descriptor: s.descriptor,
          hasFetchBytes: typeof s.fetchBytes === 'function',
          hasReconcile: typeof s.reconcile === 'function',
        })),
        tools: [...tools.values()].map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          tier: t.tier,
        })),
      };
      endpoint.post({ kind: 'activated', contributions });
    } catch (e) {
      fail(e);
    }
  }

  endpoint.onCall(async (ns, method, args) => {
    if (ns === 'tool') {
      const tool = tools.get(method);
      if (!tool) throw new Error(`unknown tool ${method}`);
      return tool.call(args[0] as Record<string, unknown>);
    }
    if (ns === 'source') {
      return handleSourceCall(method, args); // Task 8
    }
    throw new Error(`unexpected main→child namespace ${ns}`);
  });

  // Task 8 replaces this stub with the real source runner.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async function handleSourceCall(method: string, args: unknown[]): Promise<unknown> {
    throw new Error(`source calls not implemented yet: ${method}`);
  }

  endpoint.onNotify((raw) => {
    const msg = raw as MainToChild;
    if (msg.kind === 'bootstrap') {
      void onBootstrap(msg);
      return;
    }
    if (msg.kind === 'event') {
      eventCbs.get(msg.name)?.forEach((cb) => cb(msg.payload));
      return;
    }
    if (msg.kind === 'src-next' || msg.kind === 'src-abort') {
      handleSourceNotify(msg); // Task 8
      return;
    }
    if (msg.kind === 'deactivate') {
      void (async () => {
        try {
          await mod?.deactivate?.();
        } catch {
          /* deactivate errors must not block exit */
        }
        pulls.forEach((p) => p.abort.abort());
        exit(0);
      })();
    }
  });

  // Task 8 replaces this stub too.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars, @typescript-eslint/no-empty-function
  function handleSourceNotify(_msg: { kind: 'src-next' | 'src-abort'; pullId: number }): void {}
}

/** utilityProcess (parentPort) vs node fork (process.send) adapter. */
export function connectParentChannel(): WireChannel {
  const pp = (process as unknown as { parentPort?: { postMessage(m: unknown): void; on(ev: 'message', h: (e: { data: unknown }) => void): void; off(ev: 'message', h: (e: { data: unknown }) => void): void } }).parentPort;
  if (pp) {
    return {
      send: (m) => pp.postMessage(m),
      onMessage: (cb) => {
        const h = (e: { data: unknown }) => cb(e.data);
        pp.on('message', h);
        return () => pp.off('message', h);
      },
      close: () => {},
    };
  }
  return {
    send: (m) => process.send?.(m),
    onMessage: (cb) => {
      const h = (m: unknown) => cb(m);
      process.on('message', h);
      return () => {
        process.off('message', h);
      };
    },
    close: () => {},
  };
}

const isUtilityChild = Boolean((process as unknown as { parentPort?: unknown }).parentPort);
if (isUtilityChild || process.env.KIA_EXT_HOST_CHILD === '1') {
  // Under stdio-less utilityProcess, console must not throw; reroute to stderr
  // like mcp/stdio-entry.ts does.
  // eslint-disable-next-line no-console
  console.log = console.error.bind(console);
  process.on('uncaughtException', (e) => {
    process.stderr.write(`[ext-host] uncaught: ${e.message}\n`);
    process.exit(1);
  });
  process.on('unhandledRejection', (e) => {
    process.stderr.write(`[ext-host] unhandled: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
  runExtensionHost(connectParentChannel());
}
```

- [ ] **Step 3: Run tests** — `npx jest src/main/platform/__tests__/extension-host-entry.test.ts` → PASS (source tests come in Task 8).

- [ ] **Step 4: Gates + commit**

```bash
npx tsc --noEmit ; npx jest
git add src/main/platform && git commit -m "feat(extensions): child host runtime — bootstrap, remote-host proxy, tools, lifecycle"
```

---

### Task 8: Child runtime — the source runner (same file)

**Files:**
- Modify: `src/main/platform/extension-host-entry.ts` (fill the two Task-7 stubs)
- Test: extend `src/main/platform/__tests__/extension-host-entry.test.ts`

**Interfaces:**
- Consumes: wire messages (Task 1); the `pulls` map scaffolded in Task 7
- Produces (wire behavior the Task-9 proxy relies on):
  - main→child call `('source','connect',[connectId, sourceId])` → runs `source.connect(authProxy)` where each auth verb calls `('auth', verb, [connectId, ...verbArgs])`; returns `{identifier, config}`
  - main→child call `('source','pull-open',[pullId, sourceId, account, cursor])` → constructs the iterator + session, returns `null`; each `{kind:'src-next', pullId}` advances the iterator ONCE and answers with exactly one of `src-batch` (items already through `toDocument`, flattened, nulls dropped) / `src-done` / `src-error`
  - `('source','fetch-bytes',[sessionId, sourceId, account, doc])` → `Uint8Array | null`
  - `('source','reconcile-open',[pullId, sourceId, account])` → `src-next` answers with `src-refs` / `src-done` / `src-error`
  - `{kind:'src-abort', pullId}` → aborts that pull's controller and best-effort `iterator.return()`
  - session verbs cross as child→main calls `('session','credentials'|[pullId])` / `('session','log',[pullId, level, msg])`

- [ ] **Step 1: Add the failing tests** (append to the Task-7 test file):

```ts
describe('runExtensionHost — source runner', () => {
  const account = { id: 'acc1', source: 'basicsrc', identifier: 'x', config: {}, status: 'connecting', cursor: null, createdAt: 'now' };

  function sourceMod() {
    const pulled: unknown[] = [];
    const mod = {
      async activate() {
        return {
          sources: [
            {
              descriptor: { id: 'basicsrc', name: 'Basic', documentTypes: ['t'], auth: 'password' as const },
              async connect(auth: { prompt(s: unknown): Promise<Record<string, unknown>> }) {
                const a = await auth.prompt({ fields: ['password'] });
                return { identifier: `user-${a.password}` };
              },
              async *pull(session: { credentials(): Promise<unknown>; signal: AbortSignal }, cursor: { n: number } | null) {
                pulled.push(cursor);
                const creds = (await session.credentials()) as { password?: string } | null;
                yield { phase: 'backfill', items: [{ v: `a-${creds?.password}` }, { v: 'skip' }, { v: 'b' }], cursor: { n: 1 } };
                if (session.signal.aborted) return;
                yield { phase: 'live', items: [{ v: 'c' }], cursor: { n: 2 } };
              },
              toDocument(item: { v: string }) {
                if (item.v === 'skip') return null;
                if (item.v === 'b') {
                  return [
                    { externalId: 'b1', type: 't', title: 'b1', markdown: 'b1', metadata: {}, createdAt: null },
                    { externalId: 'b2', type: 't', title: 'b2', markdown: 'b2', metadata: {}, createdAt: null },
                  ];
                }
                return { externalId: item.v, type: 't', title: item.v, markdown: item.v, metadata: {}, createdAt: null };
              },
              async fetchBytes(_s: unknown, doc: { id: string }) {
                return new Uint8Array([1, 2, Number(doc.id.length)]);
              },
            },
          ],
        };
      },
    };
    return { mod, pulled };
  }

  it('connect proxies auth verbs; pull is demand-driven with toDocument applied child-side', async () => {
    const { mod } = sourceMod();
    const { mainEp, waitFor } = boot(mod);
    mainEp.onCall(async (ns, method, args) => {
      if (ns === 'auth' && method === 'prompt') return { password: 'pw' };
      if (ns === 'session' && method === 'credentials') return { password: 'tok' };
      if (ns === 'session' && method === 'log') return undefined;
      throw new Error(`unexpected ${ns}.${method}`);
    });
    const activated = waitFor('activated');
    mainEp.post(BOOT);
    await activated;

    await expect(mainEp.call('source', 'connect', [11, 'basicsrc'])).resolves.toEqual({
      identifier: 'user-pw',
    });

    await mainEp.call('source', 'pull-open', [21, 'basicsrc', account, null]);
    const batch1 = waitFor('src-batch');
    mainEp.post({ kind: 'src-next', pullId: 21 });
    const b1 = await batch1;
    // 3 items → skip dropped, 'b' fanned out to 2 docs → 3 DocumentInputs
    expect(b1.batch.items.map((i: { externalId: string }) => i.externalId)).toEqual(['a-tok', 'b1', 'b2']);
    expect(b1.batch.cursor).toEqual({ n: 1 });

    const batch2 = waitFor('src-batch');
    mainEp.post({ kind: 'src-next', pullId: 21 });
    expect((await batch2).batch.phase).toBe('live');

    const done = waitFor('src-done');
    mainEp.post({ kind: 'src-next', pullId: 21 });
    await done;
  });

  it('src-abort aborts the session signal; fetch-bytes round-trips bytes', async () => {
    const { mod } = sourceMod();
    const { mainEp, waitFor } = boot(mod);
    mainEp.onCall(async (ns, method) => {
      if (ns === 'session' && method === 'credentials') return null;
      return undefined;
    });
    const activated = waitFor('activated');
    mainEp.post(BOOT);
    await activated;

    await mainEp.call('source', 'pull-open', [31, 'basicsrc', account, null]);
    const batch1 = waitFor('src-batch');
    mainEp.post({ kind: 'src-next', pullId: 31 });
    await batch1;
    mainEp.post({ kind: 'src-abort', pullId: 31 });
    const done = waitFor('src-done');
    mainEp.post({ kind: 'src-next', pullId: 31 });
    await done; // aborted signal → generator returned early

    const bytes = (await mainEp.call('source', 'fetch-bytes', [41, 'basicsrc', account, { id: 'doc99' }])) as Uint8Array;
    expect([...bytes]).toEqual([1, 2, 5]);
  });

  it('a throwing pull surfaces as src-error', async () => {
    const mod = {
      async activate() {
        return {
          sources: [{
            descriptor: { id: 's', name: 's', documentTypes: [], auth: 'none' as const },
            async connect() { return { identifier: 'i' }; },
            // eslint-disable-next-line require-yield
            async *pull(): AsyncGenerator<never> { throw new Error('pull broke'); },
            toDocument: () => null,
          }],
        };
      },
    };
    const { mainEp, waitFor } = boot(mod);
    const activated = waitFor('activated');
    mainEp.post(BOOT);
    await activated;
    await mainEp.call('source', 'pull-open', [51, 's', account, null]);
    const err = waitFor('src-error');
    mainEp.post({ kind: 'src-next', pullId: 51 });
    expect((await err).error).toMatch(/pull broke/);
  });
});
```

- [ ] **Step 2: Run to verify the new tests fail**, then replace the two Task-7 stubs in `extension-host-entry.ts`:

```ts
  function makeSession(pullId: number, account: unknown, abort: AbortController) {
    return {
      account,
      signal: abort.signal,
      credentials: () => endpoint.call('session', 'credentials', [pullId]),
      log: (level: unknown, msg: unknown) => {
        void endpoint.call('session', 'log', [pullId, level, msg]).catch(() => {});
      },
    };
  }

  function toWireItems(source: Source, items: unknown[]): unknown[] {
    const out: unknown[] = [];
    for (const item of items) {
      const d = source.toDocument(item);
      if (d == null) continue;
      if (Array.isArray(d)) out.push(...d);
      else out.push(d);
    }
    return out;
  }

  async function handleSourceCall(method: string, args: unknown[]): Promise<unknown> {
    if (method === 'connect') {
      const [connectId, sourceId] = args as [number, string];
      const source = sources.get(sourceId);
      if (!source) throw new Error(`unknown source ${sourceId}`);
      const auth = {
        oauth: (scopes: string[]) => endpoint.call('auth', 'oauth', [connectId, scopes]),
        showQr: (qr: string) => {
          void endpoint.call('auth', 'showQr', [connectId, qr]).catch(() => {});
        },
        prompt: (schema: unknown) => endpoint.call('auth', 'prompt', [connectId, schema]),
        status: (msg: string) => {
          void endpoint.call('auth', 'status', [connectId, msg]).catch(() => {});
        },
      };
      return source.connect(auth as never);
    }
    if (method === 'pull-open') {
      const [pullId, sourceId, account, cursor] = args as [number, string, unknown, unknown];
      const source = sources.get(sourceId);
      if (!source) throw new Error(`unknown source ${sourceId}`);
      const abort = new AbortController();
      const session = makeSession(pullId, account, abort);
      const iterator = source.pull(session as never, cursor)[Symbol.asyncIterator]();
      pulls.set(pullId, { iterator, abort, source, mode: 'batch' });
      return null;
    }
    if (method === 'reconcile-open') {
      const [pullId, sourceId, account] = args as [number, string, unknown];
      const source = sources.get(sourceId);
      if (!source?.reconcile) throw new Error(`source ${sourceId} has no reconcile`);
      const abort = new AbortController();
      const session = makeSession(pullId, account, abort);
      const iterator = source.reconcile(session as never)[Symbol.asyncIterator]();
      pulls.set(pullId, { iterator, abort, source, mode: 'refs' });
      return null;
    }
    if (method === 'fetch-bytes') {
      const [sessionId, sourceId, account, doc] = args as [number, string, unknown, unknown];
      const source = sources.get(sourceId);
      if (!source?.fetchBytes) throw new Error(`source ${sourceId} has no fetchBytes`);
      const abort = new AbortController();
      const session = makeSession(sessionId, account, abort);
      return (await source.fetchBytes(session as never, doc as never)) ?? null;
    }
    throw new Error(`unknown source method ${method}`);
  }

  function handleSourceNotify(msg: { kind: 'src-next' | 'src-abort'; pullId: number }): void {
    const pull = pulls.get(msg.pullId);
    if (!pull) return;
    if (msg.kind === 'src-abort') {
      pull.abort.abort();
      void pull.iterator.return?.(undefined).catch(() => {});
      return;
    }
    void (async () => {
      try {
        const r = await pull.iterator.next();
        if (r.done) {
          pulls.delete(msg.pullId);
          endpoint.post({ kind: 'src-done', pullId: msg.pullId });
          return;
        }
        if (pull.mode === 'refs') {
          endpoint.post({ kind: 'src-refs', pullId: msg.pullId, refs: r.value });
          return;
        }
        const b = r.value as { phase: unknown; items: unknown[]; deletions?: unknown; cursor: unknown; estimateTotal?: number };
        endpoint.post({
          kind: 'src-batch',
          pullId: msg.pullId,
          batch: {
            phase: b.phase,
            items: toWireItems(pull.source, b.items),
            deletions: b.deletions,
            cursor: b.cursor,
            estimateTotal: b.estimateTotal,
          },
        });
      } catch (e) {
        pulls.delete(msg.pullId);
        endpoint.post({
          kind: 'src-error',
          pullId: msg.pullId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    })();
  }
```

(Remove the two `eslint-disable` stub comments from Task 7.)

- [ ] **Step 3: Run the file's tests** — PASS. **Step 4: Gates + commit**

```bash
npx tsc --noEmit ; npx jest
git add src/main/platform && git commit -m "feat(extensions): child source runner — demand-driven pull, connect/auth, fetch-bytes, reconcile"
```

---

### Task 9: Main-side source proxy set (`src/main/platform/source-proxy.ts`)

**Files:**
- Create: `src/main/platform/source-proxy.ts`
- Test: `src/main/platform/__tests__/source-proxy.test.ts`

**Interfaces:**
- Consumes: `RpcEndpoint` (Task 4); `Contributions` entry shape (Task 1); child wire behavior (Task 8)
- Produces:
  - `createSourceProxySet(endpoint: RpcEndpoint): SourceProxySet` where
  - `interface SourceProxySet { handleCall(ns: string, method: string, args: unknown[]): Promise<unknown>; makeSource(entry: Contributions['sources'][number]): Source; abortAll(reason: string): void; dispose(): void }`

**Semantics (spec §3.8):** `makeSource` returns a real `Source` whose `toDocument` is identity (`(d) => d`, items already mapped child-side). `pull` is an async generator: allocate `pullId`, register the live `session` under it (so child `('session',…)` calls route back), `await endpoint.call('source','pull-open',…)`, then loop `post src-next` → await exactly one inbox message → yield batch / return on done / throw on error. `session.signal` abort → `post src-abort` + wake the wait loop + return. `connect` registers the passed `AuthChannel` under a `connectId` so child `('auth',…)` calls route to it. `fetchBytes`/`reconcile` only attached when the entry's flags say so. `handleCall` routes `ns 'auth'` → registered AuthChannel verb, `ns 'session'` → registered session's `credentials`/`log`; anything else throws. `abortAll(reason)` pushes an error into every open stream (used on process exit). `dispose()` unhooks the notify subscription.

- [ ] **Step 1: Write the failing tests** — pair the REAL child runtime with the proxy over the in-memory transport; drive it like the engine would:

`src/main/platform/__tests__/source-proxy.test.ts`:

```ts
/** @jest-environment node */
import type { AuthChannel, Batch, DocumentInput, Session, Source } from '@shared/contracts';
import type { Cap } from '@shared/contracts';
import type { Contributions } from '@shared/extension-rpc';

import { runExtensionHost } from '../extension-host-entry';
import { createSourceProxySet } from '../source-proxy';
import { createInMemoryHostPair, createRpcEndpoint } from '../transport';

const BOOT = {
  kind: 'bootstrap' as const, v: 1 as const, extensionId: 'test.basic',
  entryAbsPath: '/virtual/e.js', dataDir: '/virtual/d', caps: [] as Cap[],
};
const account = { id: 'acc1', source: 'basicsrc', identifier: 'x', config: {}, status: 'connecting', cursor: null, createdAt: 'now' } as never;

const fixtureModule = {
  async activate() {
    return {
      sources: [{
        descriptor: { id: 'basicsrc', name: 'Basic', documentTypes: ['t'], auth: 'password' as const },
        async connect(auth: AuthChannel) {
          const a = await auth.prompt({});
          auth.status('connected');
          return { identifier: String(a.user) };
        },
        async *pull(session: Session, cursor: { n: number } | null) {
          let n = cursor?.n ?? 0;
          while (n < 3) {
            if (session.signal.aborted) return;
            yield { phase: 'backfill', items: [{ n }], cursor: { n: n + 1 }, estimateTotal: 3 };
            n += 1;
          }
        },
        toDocument(item: { n: number }) {
          return { externalId: `e${item.n}`, type: 't', title: `t${item.n}`, markdown: 'm', metadata: {}, createdAt: null };
        },
      }],
    };
  },
};

async function setup() {
  const { main, child } = createInMemoryHostPair();
  const mainEp = createRpcEndpoint(main);
  const proxySet = createSourceProxySet(mainEp);
  mainEp.onCall((ns, m, a) => proxySet.handleCall(ns, m, a));
  const activated = new Promise<Contributions>((resolve) => {
    const off = mainEp.onNotify((msg) => {
      if (msg.kind === 'activated') { off(); resolve(msg.contributions as Contributions); }
    });
  });
  runExtensionHost(child, { requireModule: () => fixtureModule, exit: jest.fn() });
  mainEp.post(BOOT);
  const contributions = await activated;
  const source = proxySet.makeSource(contributions.sources[0]);
  return { source, proxySet, mainEp };
}

function makeSession(signal?: AbortSignal): Session {
  return {
    account,
    signal: signal ?? new AbortController().signal,
    credentials: async () => ({ password: 'pw' }),
    log: jest.fn(),
  } as never;
}

describe('source proxy ↔ real child runtime', () => {
  it('connect routes AuthChannel verbs back to the caller', async () => {
    const { source } = await setup();
    const prompt = jest.fn(async () => ({ user: 'eve' }));
    const status = jest.fn();
    const auth = { prompt, status, oauth: jest.fn(), showQr: jest.fn() } as never as AuthChannel;
    await expect(source.connect(auth)).resolves.toEqual({ identifier: 'eve' });
    expect(prompt).toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith('connected');
  });

  it('pull yields identity-mapped DocumentInput batches in demand order and resumes from a cursor', async () => {
    const { source } = await setup();
    const got: Array<Batch<unknown, DocumentInput>> = [];
    for await (const b of source.pull(makeSession(), { n: 1 })) got.push(b as never);
    expect(got).toHaveLength(2);
    expect((got[0].items[0] as DocumentInput).externalId).toBe('e1');
    expect(source.toDocument(got[0].items[0] as never)).toBe(got[0].items[0]); // identity
  });

  it('aborting the session signal ends the pull promptly', async () => {
    const { source } = await setup();
    const ac = new AbortController();
    const got: unknown[] = [];
    for await (const b of source.pull(makeSession(ac.signal), null)) {
      got.push(b);
      ac.abort();
    }
    expect(got.length).toBeLessThanOrEqual(2);
  });

  it('abortAll fails an in-flight pull with the given reason', async () => {
    const { source, proxySet } = await setup();
    const it = source.pull(makeSession(), null)[Symbol.asyncIterator]();
    await it.next(); // one batch through
    const second = it.next();
    proxySet.abortAll('extension process exited');
    await expect(second).rejects.toThrow('extension process exited');
  });
});
```

- [ ] **Step 2: Run to verify failure**, then implement `src/main/platform/source-proxy.ts`:

```ts
/**
 * Main-side Source proxies over a host RPC endpoint — what the engine
 * actually drives. toDocument is identity (the child pre-maps items), pull
 * is demand-driven (one src-next per batch — engine backpressure for free),
 * and the auth/session callback namespaces route here, keyed by the
 * stream/connect id allocated per operation.
 */
import type {
  AuthChannel,
  Batch,
  Credentials,
  Document,
  DocumentInput,
  ExternalRef,
  LogLevel,
  Session,
  Source,
} from '@shared/contracts';
import type { Contributions, WireBatch } from '@shared/extension-rpc';

import type { RpcEndpoint } from './transport';

type Inbox =
  | { kind: 'batch'; batch: WireBatch }
  | { kind: 'refs'; refs: ExternalRef[] }
  | { kind: 'done' }
  | { kind: 'error'; error: string };

interface StreamState {
  inbox: Inbox[];
  wake: (() => void) | null;
}

export interface SourceProxySet {
  handleCall(ns: string, method: string, args: unknown[]): Promise<unknown>;
  makeSource(entry: Contributions['sources'][number]): Source;
  abortAll(reason: string): void;
  dispose(): void;
}

export function createSourceProxySet(endpoint: RpcEndpoint): SourceProxySet {
  let nextId = 1;
  const auths = new Map<number, AuthChannel>();
  const sessions = new Map<number, { credentials(): Promise<Credentials | null>; log(l: LogLevel, m: string): void }>();
  const streams = new Map<number, StreamState>();

  const push = (pullId: number, msg: Inbox) => {
    const s = streams.get(pullId);
    if (!s) return;
    s.inbox.push(msg);
    s.wake?.();
    s.wake = null;
  };

  const offNotify = endpoint.onNotify((raw) => {
    const m = raw as { kind: string; pullId?: number; batch?: WireBatch; refs?: ExternalRef[]; error?: string };
    if (m.kind === 'src-batch') push(m.pullId!, { kind: 'batch', batch: m.batch! });
    else if (m.kind === 'src-refs') push(m.pullId!, { kind: 'refs', refs: m.refs! });
    else if (m.kind === 'src-done') push(m.pullId!, { kind: 'done' });
    else if (m.kind === 'src-error') push(m.pullId!, { kind: 'error', error: m.error ?? 'source error' });
  });

  /** Shared demand-driven stream loop for pull (batches) and reconcile (refs). */
  async function* stream(
    openMethod: 'pull-open' | 'reconcile-open',
    openArgs: unknown[],
    session: Session,
    pullId: number,
  ): AsyncGenerator<Inbox> {
    const state: StreamState = { inbox: [], wake: null };
    streams.set(pullId, state);
    sessions.set(pullId, {
      credentials: () => session.credentials(),
      log: (l, m) => session.log(l, m),
    });
    const onAbort = () => {
      endpoint.post({ kind: 'src-abort', pullId });
      state.wake?.();
      state.wake = null;
    };
    session.signal.addEventListener('abort', onAbort, { once: true });
    try {
      await endpoint.call('source', openMethod, [pullId, ...openArgs]);
      for (;;) {
        if (session.signal.aborted) return;
        endpoint.post({ kind: 'src-next', pullId });
        while (state.inbox.length === 0) {
          if (session.signal.aborted) return;
          // eslint-disable-next-line no-await-in-loop
          await new Promise<void>((r) => {
            state.wake = r;
          });
        }
        const msg = state.inbox.shift()!;
        if (msg.kind === 'done') return;
        if (msg.kind === 'error') throw new Error(msg.error);
        yield msg;
      }
    } finally {
      streams.delete(pullId);
      sessions.delete(pullId);
      session.signal.removeEventListener('abort', onAbort);
    }
  }

  return {
    async handleCall(ns, method, args) {
      if (ns === 'auth') {
        const [id, ...rest] = args as [number, ...unknown[]];
        const auth = auths.get(id);
        if (!auth) throw new Error('no active connect flow for this call');
        const verb = (auth as unknown as Record<string, (...a: unknown[]) => unknown>)[method];
        if (!verb) throw new Error(`unknown auth verb ${method}`);
        return verb.call(auth, ...rest);
      }
      if (ns === 'session') {
        const [id, ...rest] = args as [number, ...unknown[]];
        const session = sessions.get(id);
        if (!session) throw new Error('no active session for this call');
        if (method === 'credentials') return session.credentials();
        if (method === 'log') {
          session.log(rest[0] as LogLevel, String(rest[1]));
          return undefined;
        }
        throw new Error(`unknown session verb ${method}`);
      }
      throw new Error(`unknown namespace ${ns}`);
    },

    makeSource(entry) {
      const { descriptor } = entry;
      const source: Source<unknown, DocumentInput> = {
        descriptor,
        async connect(auth) {
          const id = nextId;
          nextId += 1;
          auths.set(id, auth);
          try {
            return (await endpoint.call('source', 'connect', [id, descriptor.id])) as {
              identifier: string;
              config?: Record<string, unknown>;
            };
          } finally {
            auths.delete(id);
          }
        },
        async *pull(session, cursor) {
          const pullId = nextId;
          nextId += 1;
          for await (const msg of stream('pull-open', [descriptor.id, session.account, cursor], session, pullId)) {
            if (msg.kind === 'batch') yield msg.batch as unknown as Batch<unknown, DocumentInput>;
          }
        },
        toDocument(item) {
          return item; // child already mapped through the real toDocument
        },
      };
      if (entry.hasFetchBytes) {
        source.fetchBytes = async (session: Session, doc: Document) => {
          const id = nextId;
          nextId += 1;
          sessions.set(id, {
            credentials: () => session.credentials(),
            log: (l, m) => session.log(l, m),
          });
          try {
            const v = await endpoint.call('source', 'fetch-bytes', [id, descriptor.id, session.account, doc]);
            return v == null ? null : (v as Uint8Array);
          } finally {
            sessions.delete(id);
          }
        };
      }
      if (entry.hasReconcile) {
        source.reconcile = async function* reconcile(session: Session) {
          const pullId = nextId;
          nextId += 1;
          for await (const msg of stream('reconcile-open', [descriptor.id, session.account], session, pullId)) {
            if (msg.kind === 'refs') yield msg.refs;
          }
        };
      }
      return source as Source;
    },

    abortAll(reason) {
      streams.forEach((_s, pullId) => push(pullId, { kind: 'error', error: reason }));
      auths.clear();
    },

    dispose() {
      offNotify();
    },
  };
}
```

- [ ] **Step 3: Run tests** — PASS. **Step 4: Gates + commit**

```bash
npx tsc --noEmit ; npx jest
git add src/main/platform && git commit -m "feat(extensions): main-side source proxies (demand-driven pull, auth/session routing)"
```

---

### Task 10: Host process supervisor (`src/main/platform/host-process.ts`)

**Files:**
- Create: `src/main/platform/host-process.ts`
- Test: `src/main/platform/__tests__/host-process.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 4–9
- Produces:

```ts
export interface HostDeps {
  extensionId: string;
  entryAbsPath: string;
  dataDir: string;
  caps: Cap[];
  transportFactory(): HostTransport;
  /** Builds per-incarnation surfaces; deliverEvent posts {kind:'event'} to the child. */
  makeSurfaces(deliverEvent: (name: string, payload: unknown) => void): { surfaces: Surfaces; close(): void };
  logSink: LogSink;
  onStatus(status: ExtensionStatus, error?: string): void;
  /** Register proxies with the app; returns the unregister function. */
  registerContributions(c: Contributions, makeSource: (e: Contributions['sources'][number]) => Source): () => void;
  now?(): number;          // injectable clock for the crash-loop breaker
  killAfterMs?: number;    // deactivate → kill escalation, default 2000
  readyTimeoutMs?: number; // default 10000
  activateTimeoutMs?: number; // default 30000
}
export function createExtensionHost(deps: HostDeps): { start(): Promise<void>; stop(): Promise<void> };
```

**Semantics (spec §3.3/§3.5):**
- `start()`: status `activating` → fork transport → endpoint → proxySet (Task 9) → surfaces (`makeSurfaces`) → router (Task 6) → `endpoint.onCall` routes `auth`/`session` → proxySet, everything else → router → post `bootstrap` → await `ready` (timeout) → await `activated` or `errored` (timeout) → `registerContributions` → status `activated`. Failure at any point: kill transport, status `errored` with the message. `start()` resolves once activated (or rejects — callers treat a rejection as `errored`; the status callback already fired).
- Crash (transport exit while not stopping): `proxySet.abortAll('extension process exited')`, `surfaces.close()`, `endpoint.dispose(…)`, run the unregister fn; record `now()` in a crash list, drop entries older than 60 000 ms; if `>= 3` remain → status `errored('crash loop: 3 crashes in 60s')` and stay down; else re-run the incarnation (fresh fork).
- `stop()`: mark stopping, post `deactivate`, wait for exit up to `killAfterMs`, then `kill()`; cleanup as above; status `disabled`. Idempotent.

- [ ] **Step 1: Write the failing tests**

`src/main/platform/__tests__/host-process.test.ts`:

```ts
/** @jest-environment node */
import type { Cap, ExtensionStatus } from '@shared/contracts';
import type { Contributions } from '@shared/extension-rpc';

import { runExtensionHost } from '../extension-host-entry';
import { createExtensionHost } from '../host-process';
import { createInMemoryHostPair } from '../transport';

const noopLog = { log: jest.fn() };

function makeDeps(mod: unknown, overrides: Record<string, unknown> = {}) {
  const statuses: Array<{ status: ExtensionStatus; error?: string }> = [];
  const pairs: Array<ReturnType<typeof createInMemoryHostPair>> = [];
  const registered: Contributions[] = [];
  const unregistered: number[] = [];
  const deps = {
    extensionId: 'test.basic',
    entryAbsPath: '/virtual/e.js',
    dataDir: '/virtual/d',
    caps: ['net'] as Cap[],
    transportFactory: () => {
      const pair = createInMemoryHostPair();
      pairs.push(pair);
      runExtensionHost(pair.child, { requireModule: () => mod, exit: (c) => pair.simulateExit(c) });
      return pair.main;
    },
    makeSurfaces: () => ({ surfaces: { net: { fetch: async () => ({ status: 200 }) } } as never, close: jest.fn() }),
    logSink: noopLog,
    onStatus: (status: ExtensionStatus, error?: string) => statuses.push({ status, error }),
    registerContributions: (c: Contributions) => {
      registered.push(c);
      return () => unregistered.push(1);
    },
    killAfterMs: 50,
    readyTimeoutMs: 1000,
    activateTimeoutMs: 1000,
    ...overrides,
  };
  return { deps, statuses, pairs, registered, unregistered };
}

const okModule = {
  async activate() {
    return { sources: [], tools: [{ name: 't', description: '', inputSchema: {}, call: async () => 1 }] };
  },
  deactivate: jest.fn(),
};

describe('createExtensionHost', () => {
  it('start() activates, registers contributions, reports status transitions', async () => {
    const { deps, statuses, registered } = makeDeps(okModule);
    const host = createExtensionHost(deps as never);
    await host.start();
    expect(statuses.map((s) => s.status)).toEqual(['activating', 'activated']);
    expect(registered).toHaveLength(1);
    expect(registered[0].tools[0].name).toBe('t');
    await host.stop();
  });

  it('an activate() error lands in errored without registering anything', async () => {
    const { deps, statuses, registered } = makeDeps({ activate: async () => { throw new Error('nope'); } });
    const host = createExtensionHost(deps as never);
    await expect(host.start()).rejects.toThrow(/nope/);
    expect(statuses.at(-1)).toEqual({ status: 'errored', error: expect.stringMatching(/nope/) });
    expect(registered).toHaveLength(0);
  });

  it('stop() deactivates cleanly and unregisters', async () => {
    const { deps, statuses, unregistered } = makeDeps(okModule);
    const host = createExtensionHost(deps as never);
    await host.start();
    await host.stop();
    expect(unregistered).toHaveLength(1);
    expect(statuses.at(-1)?.status).toBe('disabled');
  });

  it('a crash restarts the host; 3 crashes in 60s trip the breaker', async () => {
    let t = 0;
    const { deps, statuses, pairs, unregistered } = makeDeps(okModule, { now: () => t });
    const host = createExtensionHost(deps as never);
    await host.start();
    // three crashes at t=1s, 2s, 3s — breaker trips on the third
    for (let i = 0; i < 3; i += 1) {
      t += 1000;
      const base = statuses.length; // wait for NEW transitions, not the stale 'activated'
      const settled = new Promise<void>((resolve) => {
        const iv = setInterval(() => {
          const last = statuses.at(-1);
          if (statuses.length > base && (last?.status === 'activated' || last?.status === 'errored')) {
            clearInterval(iv);
            resolve();
          }
        }, 5);
      });
      pairs[pairs.length - 1].simulateExit(1);
      // eslint-disable-next-line no-await-in-loop
      await settled;
    }
    expect(statuses.at(-1)).toEqual({ status: 'errored', error: expect.stringMatching(/crash loop/) });
    expect(unregistered.length).toBeGreaterThanOrEqual(3);
    expect(pairs).toHaveLength(3); // 1 initial + 2 restarts; third crash stays down
  });
});
```

- [ ] **Step 2: Run to verify failure**, then implement `src/main/platform/host-process.ts`:

```ts
/**
 * Per-extension process supervisor: fork → handshake → activate → register
 * proxies; on crash, clean teardown + restart behind a 3-in-60s breaker
 * (spec §3.3). Everything is written against HostTransport so jest drives
 * it over the in-memory pair with the real child runtime in-process.
 */
import type { Cap, ExtensionStatus, Source } from '@shared/contracts';
import type { Contributions } from '@shared/extension-rpc';
import type { LogSink } from '@main/core/engine/engine';

import { createHostRouter } from './host-router';
import type { Surfaces } from './host-surfaces';
import { createSourceProxySet } from './source-proxy';
import { createRpcEndpoint, type HostTransport } from './transport';

const CRASH_LOOP_MAX = 3;
const CRASH_LOOP_WINDOW_MS = 60_000;

export interface HostDeps {
  extensionId: string;
  entryAbsPath: string;
  dataDir: string;
  caps: Cap[];
  transportFactory(): HostTransport;
  makeSurfaces(deliverEvent: (name: string, payload: unknown) => void): {
    surfaces: Surfaces;
    close(): void;
  };
  logSink: LogSink;
  onStatus(status: ExtensionStatus, error?: string): void;
  registerContributions(
    c: Contributions,
    makeSource: (e: Contributions['sources'][number]) => Source,
  ): () => void;
  now?(): number;
  killAfterMs?: number;
  readyTimeoutMs?: number;
  activateTimeoutMs?: number;
}

interface Incarnation {
  endpoint: ReturnType<typeof createRpcEndpoint>;
  transport: HostTransport;
  cleanup(): void;
}

export function createExtensionHost(deps: HostDeps): {
  start(): Promise<void>;
  stop(): Promise<void>;
} {
  const now = deps.now ?? Date.now;
  const killAfterMs = deps.killAfterMs ?? 2000;
  const scope = `extension:${deps.extensionId}`;
  let stopping = false;
  let stopped = true;
  let current: Incarnation | null = null;
  const crashes: number[] = [];

  function waitNotify(
    endpoint: Incarnation['endpoint'],
    kinds: string[],
    timeoutMs: number,
    what: string,
  ): Promise<{ kind: string } & Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`timed out waiting for ${what}`));
      }, timeoutMs);
      const off = endpoint.onNotify((m) => {
        if (!kinds.includes(m.kind)) return;
        clearTimeout(timer);
        off();
        resolve(m);
      });
    });
  }

  async function spawn(): Promise<void> {
    deps.onStatus('activating');
    const transport = deps.transportFactory();
    const endpoint = createRpcEndpoint(transport);
    const proxySet = createSourceProxySet(endpoint);
    const surfacesHandle = deps.makeSurfaces((name, payload) =>
      endpoint.post({ kind: 'event', name, payload }),
    );
    const router = createHostRouter({
      extensionId: deps.extensionId,
      granted: new Set(deps.caps),
      surfaces: surfacesHandle.surfaces,
      logSink: deps.logSink,
    });
    endpoint.onCall((ns, method, args) =>
      ns === 'auth' || ns === 'session'
        ? proxySet.handleCall(ns, method, args)
        : router.dispatch(ns, method, args),
    );

    let unregister: (() => void) | null = null;
    let exited = false;
    const cleanup = () => {
      proxySet.abortAll('extension process exited');
      proxySet.dispose();
      surfacesHandle.close();
      endpoint.dispose('extension process exited');
      unregister?.();
      unregister = null;
    };
    current = { endpoint, transport, cleanup };

    transport.onExit((code) => {
      if (exited) return;
      exited = true;
      cleanup();
      current = null;
      if (stopping || stopped) return;
      // Crash path.
      crashes.push(now());
      while (crashes.length > 0 && now() - crashes[0] > CRASH_LOOP_WINDOW_MS) crashes.shift();
      deps.logSink.log(scope, 'warn', 'extension process exited unexpectedly', { code });
      if (crashes.length >= CRASH_LOOP_MAX) {
        stopped = true;
        deps.onStatus('errored', `crash loop: ${CRASH_LOOP_MAX} crashes in 60s`);
        return;
      }
      void spawn().catch((e) => {
        stopped = true;
        deps.onStatus('errored', e instanceof Error ? e.message : String(e));
      });
    });

    try {
      const readyOrError = waitNotify(
        endpoint,
        ['ready', 'errored'],
        deps.readyTimeoutMs ?? 10_000,
        'ready',
      );
      endpoint.post({
        kind: 'bootstrap',
        v: 1,
        extensionId: deps.extensionId,
        entryAbsPath: deps.entryAbsPath,
        dataDir: deps.dataDir,
        caps: deps.caps,
      });
      const first = await readyOrError;
      if (first.kind === 'errored') throw new Error(String(first.error));
      const outcome = await waitNotify(
        endpoint,
        ['activated', 'errored'],
        deps.activateTimeoutMs ?? 30_000,
        'activation',
      );
      if (outcome.kind === 'errored') throw new Error(String(outcome.error));
      const contributions = outcome.contributions as Contributions;
      unregister = deps.registerContributions(contributions, proxySet.makeSource);
      deps.onStatus('activated');
    } catch (e) {
      exited = true; // suppress the crash path for this deliberate teardown
      cleanup();
      transport.kill();
      current = null;
      stopped = true;
      deps.onStatus('errored', e instanceof Error ? e.message : String(e));
      throw e;
    }
  }

  return {
    async start() {
      stopping = false;
      stopped = false;
      crashes.length = 0;
      await spawn();
    },
    async stop() {
      if (stopped && !current) {
        deps.onStatus('disabled');
        return;
      }
      stopping = true;
      stopped = true;
      const inc = current;
      if (inc) {
        const exited = new Promise<void>((resolve) => {
          inc.transport.onExit(() => resolve());
        });
        inc.endpoint.post({ kind: 'deactivate' });
        const timer = setTimeout(() => inc.transport.kill(), killAfterMs);
        await exited;
        clearTimeout(timer);
      }
      deps.onStatus('disabled');
    },
  };
}
```

- [ ] **Step 3: Run tests** — PASS. **Step 4: Gates + commit**

```bash
npx tsc --noEmit ; npx jest
git add src/main/platform && git commit -m "feat(extensions): host process supervisor with crash-loop breaker"
```

---

### Task 11: Installer — local refs (`src/main/marketplace/installer.ts`)

**Files:**
- Create: `src/main/marketplace/installer.ts`
- Test: `src/main/marketplace/__tests__/installer.test.ts`

**Interfaces:**
- Consumes: `validateManifestDir` (Task 2); `InstalledRecord`, `readInstalled`, `writeInstalled` (Task 3); `tar`
- Produces:

```ts
export interface PendingInstall {
  token: string;
  stagingDir: string;
  manifest: Manifest;
  sizeBytes: number;
  integrity: string | null; // always null for local refs (dev installs)
  ref: string;              // normalized, e.g. 'file:/abs/path'
}
export interface InstallerDeps {
  extDir: string;
  /** sourceId → owning id ('builtin' or an extension id) for collision checks. */
  sourceIdOwners(): Record<string, string>;
}
export function createInstaller(deps: InstallerDeps): {
  preview(ref: string): Promise<PendingInstall>;
  commit(token: string): Promise<{ manifest: Manifest; record: InstalledRecord; dir: string }>;
  discardAll(): void;
};
```

**Semantics (spec §4.2, local subset):**
- `preview(ref)`: `github:`/`http(s):` refs → `Error('marketplace installs are not available yet — install from a local path')`. Otherwise resolve as filesystem path: directory → `fs.cpSync(abs, staging, { recursive: true })`; `.tgz` file → `tar.x({ file: abs, cwd: staging, strip: 1 })` (tar rejects path traversal itself); anything else → error. Then `validateManifestDir(staging)`, source-id collision check (`owner && owner !== manifest.id` → `` `source id '<sid>' is already provided by <owner>` ``), compute `sizeBytes` (recursive sum), stage under a `crypto.randomUUID()` token. Pending map capped at **8**: staging the 9th evicts (and `rmSync`s) the oldest. **No extension code executes.**
- `commit(token)`: unknown token → throw. Target `path.join(extDir, manifest.id)`. If target exists (update): move `target/data` aside → `rmSync(target)` → move staging → move `data/` back. Move = `fs.renameSync` with `EXDEV` fallback to `cpSync`+`rmSync`. Upsert the `InstalledRecord` (`{ id, version, ref, integrity: null, installedAt: new Date().toISOString(), origin: 'dev' }`) into `installed.json`. Consent recording + activation are the ORCHESTRATOR's job (Task 12), not the installer's.
- `discardAll()`: rm every pending staging dir (shutdown hygiene).

- [ ] **Step 1: Write the failing tests**

`src/main/marketplace/__tests__/installer.test.ts`:

```ts
/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import * as tar from 'tar';

import { createInstaller } from '../installer';

const MANIFEST = {
  id: 'test.basic', name: 'Basic', version: '1.0.0', engine: '^1.0.0',
  entry: 'index.js', caps: ['net'], contributes: { sources: ['basicsrc'] },
};

function makeExtDirFixture(root: string, manifest: unknown = MANIFEST): string {
  const dir = path.join(root, 'pkg');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports={activate:async()=>({})};');
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  return dir;
}

describe('createInstaller (local refs)', () => {
  let tmp: string;
  let extDir: string;
  let owners: Record<string, string>;
  let installer: ReturnType<typeof createInstaller>;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kia-inst-'));
    extDir = path.join(tmp, 'extensions');
    owners = { gmail: 'builtin' };
    installer = createInstaller({ extDir, sourceIdOwners: () => owners });
  });
  afterEach(() => {
    installer.discardAll();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('previews a directory and commits it into extDir with an installed.json record', async () => {
    const pkg = makeExtDirFixture(tmp);
    const pending = await installer.preview(pkg);
    expect(pending.manifest.id).toBe('test.basic');
    expect(pending.integrity).toBeNull();
    expect(pending.sizeBytes).toBeGreaterThan(0);

    const { record, dir } = await installer.commit(pending.token);
    expect(dir).toBe(path.join(extDir, 'test.basic'));
    expect(fs.existsSync(path.join(dir, 'manifest.json'))).toBe(true);
    expect(record).toMatchObject({ id: 'test.basic', version: '1.0.0', origin: 'dev' });
    const onDisk = JSON.parse(fs.readFileSync(path.join(extDir, 'installed.json'), 'utf8'));
    expect(onDisk).toHaveLength(1);
    // token is one-shot
    await expect(installer.commit(pending.token)).rejects.toThrow(/unknown|expired/);
  });

  it('previews a .tgz (strip:1) and rejects marketplace refs', async () => {
    const pkg = makeExtDirFixture(tmp);
    const tgz = path.join(tmp, 'pkg.tgz');
    // npm-pack convention: one top-level dir ('pkg/…') that strip:1 drops.
    await tar.c({ gzip: true, file: tgz, cwd: tmp }, ['pkg']);
    const pending = await installer.preview(tgz);
    expect(pending.manifest.id).toBe('test.basic');
    await expect(installer.preview('github:kia-plugins/x')).rejects.toThrow(/not available yet/);
    await expect(installer.preview('https://example.com/x.tgz')).rejects.toThrow(/not available yet/);
  });

  it('rejects source-id collisions owned by someone else, allows self-updates', async () => {
    owners = { basicsrc: 'other.ext' };
    await expect(installer.preview(makeExtDirFixture(tmp))).rejects.toThrow(/already provided by other.ext/);
    owners = { basicsrc: 'test.basic' };
    await expect(installer.preview(makeExtDirFixture(tmp))).resolves.toBeDefined();
  });

  it('update preserves data/ and evicts the oldest pending beyond 8', async () => {
    const pkg = makeExtDirFixture(tmp);
    const p1 = await installer.preview(pkg);
    const { dir } = await installer.commit(p1.token);
    fs.mkdirSync(path.join(dir, 'data'));
    fs.writeFileSync(path.join(dir, 'data', 'keep.txt'), 'precious');

    const p2 = await installer.preview(makeExtDirFixture(path.join(tmp, 'v2'), { ...MANIFEST, version: '1.1.0' }));
    await installer.commit(p2.token);
    expect(fs.readFileSync(path.join(dir, 'data', 'keep.txt'), 'utf8')).toBe('precious');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')).version).toBe('1.1.0');

    const first = await installer.preview(pkg);
    for (let i = 0; i < 8; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await installer.preview(pkg);
    }
    await expect(installer.commit(first.token)).rejects.toThrow(/unknown|expired/);
  });

  it('rejects an invalid package (bad manifest) at preview', async () => {
    const bad = makeExtDirFixture(tmp, { ...MANIFEST, caps: ['teleport'] });
    await expect(installer.preview(bad)).rejects.toThrow(/invalid manifest/);
  });
});
```

Note on the tgz test: build the archive so it has ONE top-level directory (npm-pack convention) — `tar.c({ gzip: true, file: tgz, cwd: tmp }, ['pkg'])` produces entries `pkg/…`, and `strip: 1` drops that prefix. Adjust the test's `tar.c` call to exactly that if the `prefix` variant above proves awkward — the assertion is what matters.

- [ ] **Step 2: Run to verify failure**, then implement `src/main/marketplace/installer.ts`:

```ts
/**
 * 3-phase installer (spec §4.2), Plan-A subset: LOCAL refs only (absolute
 * dir or .tgz — the dev loop). preview stages + validates, commit moves
 * into userData/extensions/ and records installed.json. Consent recording
 * and activation belong to the extension platform, not here. GitHub/npm
 * refs, SRI/TOFU pinning and update checks arrive with Plan B — `integrity`
 * is already carried so Plan B only swaps resolveRef.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import * as tar from 'tar';

import type { Manifest } from '@shared/contracts';

import { validateManifestDir } from '@main/platform/manifest';
import { readInstalled, writeInstalled, type InstalledRecord } from '@main/platform/extensions';

const MAX_PENDING = 8;

export interface PendingInstall {
  token: string;
  stagingDir: string;
  manifest: Manifest;
  sizeBytes: number;
  integrity: string | null;
  ref: string;
}

export interface InstallerDeps {
  extDir: string;
  sourceIdOwners(): Record<string, string>;
}

function duSync(dir: string): number {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += duSync(p);
    else total += fs.statSync(p).size;
  }
  return total;
}

function moveDir(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

export function createInstaller(deps: InstallerDeps) {
  const pending = new Map<string, PendingInstall>();

  const evict = (token: string) => {
    const p = pending.get(token);
    if (!p) return;
    pending.delete(token);
    fs.rmSync(p.stagingDir, { recursive: true, force: true });
  };

  return {
    async preview(ref: string): Promise<PendingInstall> {
      if (/^github:/.test(ref) || /^https?:/.test(ref)) {
        throw new Error('marketplace installs are not available yet — install from a local path');
      }
      const abs = path.resolve(ref);
      if (!fs.existsSync(abs)) throw new Error(`no such path: ${ref}`);
      const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kia-ext-stage-'));
      try {
        const stat = fs.statSync(abs);
        if (stat.isDirectory()) {
          fs.cpSync(abs, stagingDir, { recursive: true });
        } else if (abs.endsWith('.tgz') || abs.endsWith('.tar.gz')) {
          await tar.x({ file: abs, cwd: stagingDir, strip: 1 });
        } else {
          throw new Error('local ref must be a directory or a .tgz');
        }
        const { manifest } = validateManifestDir(stagingDir);
        const owners = deps.sourceIdOwners();
        for (const sid of manifest.contributes.sources ?? []) {
          const owner = owners[sid];
          if (owner && owner !== manifest.id) {
            throw new Error(`source id '${sid}' is already provided by ${owner}`);
          }
        }
        const entry: PendingInstall = {
          token: crypto.randomUUID(),
          stagingDir,
          manifest,
          sizeBytes: duSync(stagingDir),
          integrity: null,
          ref: `file:${abs}`,
        };
        pending.set(entry.token, entry);
        if (pending.size > MAX_PENDING) evict(pending.keys().next().value as string);
        return entry;
      } catch (e) {
        fs.rmSync(stagingDir, { recursive: true, force: true });
        throw e;
      }
    },

    async commit(token: string): Promise<{ manifest: Manifest; record: InstalledRecord; dir: string }> {
      const p = pending.get(token);
      if (!p) throw new Error('unknown or expired install token — run preview again');
      pending.delete(token);
      fs.mkdirSync(deps.extDir, { recursive: true });
      const dir = path.join(deps.extDir, p.manifest.id);
      let dataBackup: string | null = null;
      if (fs.existsSync(dir)) {
        const dataDir = path.join(dir, 'data');
        if (fs.existsSync(dataDir)) {
          dataBackup = `${dir}.data-backup`;
          fs.rmSync(dataBackup, { recursive: true, force: true });
          fs.renameSync(dataDir, dataBackup);
        }
        fs.rmSync(dir, { recursive: true, force: true });
      }
      moveDir(p.stagingDir, dir);
      if (dataBackup) fs.renameSync(dataBackup, path.join(dir, 'data'));
      const record: InstalledRecord = {
        id: p.manifest.id,
        version: p.manifest.version,
        ref: p.ref,
        integrity: p.integrity,
        installedAt: new Date().toISOString(),
        origin: 'dev',
      };
      const records = readInstalled(deps.extDir).filter((r) => r.id !== record.id);
      writeInstalled(deps.extDir, [...records, record]);
      return { manifest: p.manifest, record, dir };
    },

    discardAll(): void {
      [...pending.keys()].forEach(evict);
    },
  };
}
```

- [ ] **Step 3: Run tests** — PASS. **Step 4: Gates + commit**

```bash
npx tsc --noEmit ; npx jest
git add src/main/marketplace && git commit -m "feat(extensions): 3-phase installer, local-ref subset (dev loop)"
```

---

### Task 12: Orchestrator + SourceRegistry.unregister + IPC + main.ts wiring

**Files:**
- Create: `src/main/platform/extension-platform.ts`
- Modify: `src/main/core/boot.ts` (SourceRegistry gains `unregister`)
- Modify: `src/shared/ipc.ts` (4 channels + `ExtensionPreview` type)
- Modify: `src/main/main.ts` (create/start the platform, IPC handlers, shutdown hook)
- Test: `src/main/platform/__tests__/extension-platform.test.ts`
- Test fixture (committed, reused by Task 13): `src/main/platform/__tests__/fixtures/ext-basic/manifest.json` + `index.js`

**Interfaces:**
- Consumes: everything from Tasks 2–11
- Produces:

```ts
// extension-platform.ts
export interface ExtensionPlatformDeps {
  extDir: string;
  store: CoreStore;
  sources: SourceRegistry;                 // with unregister
  scheduler: CoreScheduler;
  registerTool(tool: McpTool): () => void;
  inference: SurfaceDeps['inference'];
  logSink: LogSink;
  notify(msg: string, level?: LogLevel): void;
  transportFactory(extensionId: string): HostTransport;
  onChange(snapshot: ExtensionSnapshot[]): void;
}
export interface ExtensionPlatform {
  start(): Promise<void>;
  stop(): Promise<void>;
  snapshot(): ExtensionSnapshot[];
  installPreview(ref: string): Promise<ExtensionPreview | { ok: false; error: string }>;
  installCommit(token: string): Promise<{ ok: boolean; id?: string; error?: string }>;
  uninstall(id: string): Promise<{ ok: boolean; error?: string }>;
  setEnabled(id: string, enabled: boolean): Promise<{ ok: boolean; error?: string }>;
}
export function createExtensionPlatform(deps: ExtensionPlatformDeps): ExtensionPlatform;
```

- [ ] **Step 1: `src/main/core/boot.ts`** — add to the `SourceRegistry` interface: `unregister(id: string): void;` and to the impl object:

```ts
    unregister(id) {
      registry.delete(id);
    },
```

- [ ] **Step 2: `src/shared/ipc.ts`** — after the `ScheduledJob` interface add:

```ts
export interface ExtensionPreview {
  ok: true;
  token: string;
  id: string;
  name: string;
  version: string;
  caps: Cap[];
  sizeBytes: number;
  integrity: string | null;
}
```

(add `Cap` to the type imports from `./contracts`). In `Invokes`, after the `'update:check'` entry add:

```ts
  /** Stage a local extension package (dir or .tgz). Marketplace refs: Plan B. */
  'extension:install-preview': {
    req: { ref: string };
    res: ExtensionPreview | { ok: false; error: string };
  };
  /** Records consent for the staged manifest's caps, installs, hot-activates. */
  'extension:install-commit': {
    req: { token: string };
    res: { ok: boolean; id?: string; error?: string };
  };
  'extension:uninstall': { req: { id: string }; res: { ok: boolean; error?: string } };
  'extension:set-enabled': {
    req: { id: string; enabled: boolean };
    res: { ok: boolean; error?: string };
  };
```

and append the four literals to `INVOKE_CHANNELS` (before the closing `] as const`):

```ts
  'extension:install-preview',
  'extension:install-commit',
  'extension:uninstall',
  'extension:set-enabled',
```

- [ ] **Step 3: Commit the test fixture** `src/main/platform/__tests__/fixtures/ext-basic/`:

`manifest.json`:

```json
{
  "id": "test.basic",
  "name": "Basic Test Extension",
  "version": "1.0.0",
  "engine": "^1.0.0",
  "entry": "index.js",
  "caps": ["net"],
  "contributes": { "sources": ["basicsrc"] }
}
```

`index.js` (plain CJS — loadable by jest's require AND a forked node):

```js
/** Minimal end-to-end fixture: one 'none'-auth source yielding two docs. */
module.exports = {
  async activate() {
    return {
      sources: [
        {
          descriptor: {
            id: 'basicsrc',
            name: 'Basic Source',
            documentTypes: ['basic.item'],
            auth: 'none',
          },
          async connect() {
            return { identifier: 'basic-account', config: {} };
          },
          async *pull(session, cursor) {
            const start = (cursor && cursor.n) || 0;
            for (let n = start; n < 2; n += 1) {
              if (session.signal.aborted) return;
              yield {
                phase: n === 0 ? 'backfill' : 'live',
                items: [{ n }],
                cursor: { n: n + 1 },
                estimateTotal: 2,
              };
            }
          },
          toDocument(item) {
            return {
              externalId: `basic-${item.n}`,
              type: 'basic.item',
              title: `Basic doc ${item.n}`,
              markdown: `body ${item.n}`,
              metadata: {},
              createdAt: '2026-01-01T00:00:00.000Z',
            };
          },
        },
      ],
      tools: [
        {
          name: 'basic_echo',
          description: 'echoes',
          inputSchema: { type: 'object' },
          call: async (args) => ({ echoed: args }),
        },
      ],
    };
  },
};
```

- [ ] **Step 4: Write the failing orchestrator test**

`src/main/platform/__tests__/extension-platform.test.ts`:

```ts
/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { ExtensionSnapshot, McpTool, Source } from '@shared/contracts';

import { openStore, type CoreStore } from '@main/core/store/store';

import { createExtensionPlatform, type ExtensionPlatform } from '../extension-platform';
import { runExtensionHost } from '../extension-host-entry';
import { createInMemoryHostPair } from '../transport';

const FIXTURE = path.join(__dirname, 'fixtures', 'ext-basic');

describe('createExtensionPlatform', () => {
  let tmp: string;
  let store: CoreStore;
  let platform: ExtensionPlatform;
  let snapshots: ExtensionSnapshot[][];
  let registry: Map<string, Source>;
  let tools: Map<string, McpTool>;

  function makePlatform(): ExtensionPlatform {
    return createExtensionPlatform({
      extDir: path.join(tmp, 'extensions'),
      store,
      sources: {
        register: (s: Source) => void registry.set(s.descriptor.id, s),
        get: (id: string) => registry.get(id),
        list: () => [...registry.values()].map((s) => s.descriptor),
        unregister: (id: string) => void registry.delete(id),
      },
      scheduler: { register: jest.fn(), unregister: jest.fn(), jobs: jest.fn(async () => []), trigger: jest.fn(), env: {} } as never,
      registerTool: (t) => {
        tools.set(t.name, t);
        return () => tools.delete(t.name);
      },
      inference: { complete: async () => '', see: async () => '', read: async () => '' },
      logSink: { log: jest.fn() },
      notify: jest.fn(),
      // In-process "fork": the real child runtime over the in-memory pair,
      // loading the fixture with jest's own require.
      transportFactory: () => {
        const pair = createInMemoryHostPair();
        runExtensionHost(pair.child, { exit: (c) => pair.simulateExit(c) });
        return pair.main;
      },
      onChange: (snap) => snapshots.push(snap),
    });
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kia-extplat-'));
    store = openStore(path.join(tmp, 'kiagent.db'), {
      encrypt: (s) => Buffer.from(s, 'utf8'),
      decrypt: (b) => b.toString('utf8'),
      detectLanguages: () => [],
    });
    snapshots = [];
    registry = new Map();
    tools = new Map();
    platform = makePlatform();
  });

  afterEach(async () => {
    await platform.stop();
    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function installFixture(): Promise<string> {
    const preview = await platform.installPreview(FIXTURE);
    if (!('token' in preview)) throw new Error(`preview failed: ${JSON.stringify(preview)}`);
    expect(preview.caps).toEqual(['net']);
    const commit = await platform.installCommit(preview.token);
    expect(commit).toEqual({ ok: true, id: 'test.basic' });
    return preview.token;
  }

  it('install → consent recorded → activated: source + tool registered, snapshot correct', async () => {
    await platform.start(); // empty dir — no-op
    await installFixture();
    expect(registry.has('basicsrc')).toBe(true);
    expect(tools.has('basic_echo')).toBe(true);
    const consent = await store.consents.latest('test.basic' as never);
    expect(consent?.caps).toEqual(['net']);
    const last = snapshots.at(-1)!;
    expect(last).toEqual([
      expect.objectContaining({ id: 'test.basic', status: 'activated', enabled: true, sourceIds: ['basicsrc'] }),
    ]);
  });

  it('setEnabled(false) unregisters and persists; a restarted platform respects it', async () => {
    await platform.start();
    await installFixture();
    await expect(platform.setEnabled('test.basic', false)).resolves.toEqual({ ok: true });
    expect(registry.has('basicsrc')).toBe(false);
    expect(tools.has('basic_echo')).toBe(false);

    await platform.stop();
    registry.clear();
    platform = makePlatform();
    await platform.start();
    expect(platform.snapshot()).toEqual([
      expect.objectContaining({ id: 'test.basic', status: 'disabled', enabled: false }),
    ]);
    expect(registry.has('basicsrc')).toBe(false);
  });

  it('an installed extension with no consent parks in needs-consent at boot', async () => {
    await platform.start();
    await installFixture();
    await platform.stop();
    // wipe consent history only
    await store.maintenance.resetAll();
    registry.clear();
    platform = makePlatform();
    await platform.start();
    expect(platform.snapshot()).toEqual([
      expect.objectContaining({ id: 'test.basic', status: 'needs-consent' }),
    ]);
    expect(registry.has('basicsrc')).toBe(false);
  });

  it('uninstall refuses while accounts exist, then removes everything', async () => {
    await platform.start();
    await installFixture();
    await store.createAccount({ source: 'basicsrc', identifier: 'a', config: {}, status: 'live' });
    await expect(platform.uninstall('test.basic')).resolves.toEqual({
      ok: false,
      error: "Remove this connector's sources before uninstalling it.",
    });
    const acct = (await store.read.accounts()).find((a) => a.source === 'basicsrc')!;
    await store.removeAccount(acct.id);
    await expect(platform.uninstall('test.basic')).resolves.toEqual({ ok: true });
    expect(fs.existsSync(path.join(tmp, 'extensions', 'test.basic'))).toBe(false);
    expect(registry.has('basicsrc')).toBe(false);
    expect(platform.snapshot()).toEqual([]);
  });
});
```

NOTE for the implementer: `store.createAccount` / `store.removeAccount` are the CoreStore account verbs used across existing store tests — check `src/main/core/store/__tests__/store.test.ts` for their exact signatures if these two calls need adjusting; the assertion intent is fixed (uninstall refuses with that exact message while an account on a contributed source exists).

- [ ] **Step 5: Implement `src/main/platform/extension-platform.ts`**

```ts
/**
 * The extension platform orchestrator — owns the per-extension state
 * machine (spec §3.3: disabled → activating → activated | needs-consent |
 * errored), glues installer → consent → host supervisor → SourceRegistry/
 * MCP registration, and projects ExtensionSnapshot[] into AppState via
 * onChange. All IPC handlers call methods here.
 */
import path from 'path';
import fs from 'fs';

import type {
  Cap,
  ConsentRecord,
  ExtensionId,
  ExtensionSnapshot,
  ExtensionStatus,
  LogLevel,
  Manifest,
  McpTool,
  Source,
} from '@shared/contracts';
import type { ExtensionPreview } from '@shared/ipc';
import type { Contributions } from '@shared/extension-rpc';

import type { CoreStore } from '@main/core/store/store';
import type { CoreScheduler } from '@main/core/scheduler';
import type { SourceRegistry } from '@main/core/boot';
import type { LogSink } from '@main/core/engine/engine';

import { createInstaller } from '@main/marketplace/installer';

import {
  discoverExtensions,
  readEnabledState,
  readInstalled,
  writeEnabledState,
  writeInstalled,
  type InstalledRecord,
} from './extensions';
import { createExtensionHost } from './host-process';
import { buildSurfaces, createEventBus, type SurfaceDeps } from './host-surfaces';
import type { HostTransport } from './transport';

export interface ExtensionPlatformDeps {
  extDir: string;
  store: CoreStore;
  sources: SourceRegistry;
  scheduler: CoreScheduler;
  registerTool(tool: McpTool): () => void;
  inference: SurfaceDeps['inference'];
  logSink: LogSink;
  notify(msg: string, level?: LogLevel): void;
  transportFactory(extensionId: string): HostTransport;
  onChange(snapshot: ExtensionSnapshot[]): void;
}

interface Entry {
  manifest: Manifest;
  dir: string;
  entryAbsPath: string;
  record?: InstalledRecord;
  enabled: boolean;
  status: ExtensionStatus;
  error?: string;
  host: ReturnType<typeof createExtensionHost> | null;
  sourceIds: string[];
}

export interface ExtensionPlatform {
  start(): Promise<void>;
  stop(): Promise<void>;
  snapshot(): ExtensionSnapshot[];
  installPreview(ref: string): Promise<ExtensionPreview | { ok: false; error: string }>;
  installCommit(token: string): Promise<{ ok: boolean; id?: string; error?: string }>;
  uninstall(id: string): Promise<{ ok: boolean; error?: string }>;
  setEnabled(id: string, enabled: boolean): Promise<{ ok: boolean; error?: string }>;
}

export function createExtensionPlatform(deps: ExtensionPlatformDeps): ExtensionPlatform {
  const entries = new Map<string, Entry>();
  const bus = createEventBus();

  const installer = createInstaller({
    extDir: deps.extDir,
    sourceIdOwners: () => {
      const owners: Record<string, string> = {};
      for (const d of deps.sources.list()) owners[d.id] = 'builtin';
      for (const [id, e] of entries) {
        for (const sid of e.manifest.contributes.sources ?? []) owners[sid] = id;
      }
      return owners;
    },
  });

  const snapshot = (): ExtensionSnapshot[] =>
    [...entries.values()].map((e) => ({
      id: e.manifest.id,
      name: e.manifest.name,
      version: e.manifest.version,
      origin: e.record?.origin ?? 'dev',
      enabled: e.enabled,
      status: e.status,
      error: e.error,
      caps: e.manifest.caps as Cap[],
      sourceIds: e.manifest.contributes.sources ?? [],
      ref: e.record?.ref,
    }));

  const changed = () => deps.onChange(snapshot());

  const setStatus = (e: Entry, status: ExtensionStatus, error?: string) => {
    e.status = status;
    e.error = error;
    changed();
  };

  async function consentCovers(manifest: Manifest): Promise<boolean> {
    const rec = await deps.store.consents.latest(manifest.id);
    return rec !== null && manifest.caps.every((c) => rec.caps.includes(c));
  }

  function registerContributions(
    e: Entry,
    c: Contributions,
    makeSource: (entry: Contributions['sources'][number]) => Source,
  ): () => void {
    const registeredSources: string[] = [];
    const toolDisposers: Array<() => void> = [];
    for (const s of c.sources) {
      const existing = deps.sources.get(s.descriptor.id);
      if (existing && !e.sourceIds.includes(s.descriptor.id)) {
        deps.logSink.log(
          `extension:${e.manifest.id}`,
          'warn',
          `source id '${s.descriptor.id}' already registered — skipping`,
        );
        continue;
      }
      deps.sources.register(makeSource(s));
      registeredSources.push(s.descriptor.id);
    }
    e.sourceIds = registeredSources;
    for (const t of c.tools) {
      toolDisposers.push(
        deps.registerTool({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
          tier: t.tier,
          call: (args) => e.host!.callTool(t.name, args),
        }),
      );
    }
    bus.emit('platform', 'extension.activated', { id: e.manifest.id });
    return () => {
      for (const sid of registeredSources) {
        deps.sources.unregister(sid);
        void deps.store.read
          .accounts()
          .then((accounts) => {
            accounts
              .filter((a) => a.source === sid)
              .forEach((a) => deps.scheduler.unregister(`source:${sid}:${a.id}`));
          })
          .catch(() => {});
      }
      toolDisposers.forEach((d) => d());
      bus.emit('platform', 'extension.deactivated', { id: e.manifest.id });
    };
  }

  async function activate(e: Entry): Promise<void> {
    if (!(await consentCovers(e.manifest))) {
      setStatus(e, 'needs-consent');
      return;
    }
    const host = createExtensionHost({
      extensionId: e.manifest.id,
      entryAbsPath: e.entryAbsPath,
      dataDir: path.join(e.dir, 'data'),
      caps: e.manifest.caps as Cap[],
      transportFactory: () => deps.transportFactory(e.manifest.id),
      makeSurfaces: (deliverEvent) =>
        buildSurfaces({
          extensionId: e.manifest.id,
          dataDir: path.join(e.dir, 'data'),
          query: deps.store.read,
          inference: deps.inference,
          notify: deps.notify,
          bus,
          deliverEvent,
        }),
      logSink: deps.logSink,
      onStatus: (status, error) => setStatus(e, status, error),
      registerContributions: (c, makeSource) => registerContributions(e, c, makeSource),
    });
    e.host = host;
    await host.start().catch(() => {
      /* status already 'errored' via onStatus */
    });
  }

  async function deactivate(e: Entry): Promise<void> {
    await e.host?.stop();
    e.host = null;
  }

  async function loadEntry(dir: string): Promise<Entry | null> {
    const found = discoverExtensions(path.dirname(dir)).find((d) => d.dir === dir);
    if (!found) return null;
    const state = readEnabledState(deps.extDir);
    const records = readInstalled(deps.extDir);
    if (!found.manifest || !found.entryAbsPath) {
      // Invalid on disk — track it as errored so the UI can show why.
      return null;
    }
    const e: Entry = {
      manifest: found.manifest,
      dir: found.dir,
      entryAbsPath: found.entryAbsPath,
      record: records.find((r) => r.id === found.manifest!.id),
      enabled: state[found.manifest.id]?.enabled ?? true,
      status: 'disabled',
      error: undefined,
      host: null,
      sourceIds: [],
    };
    entries.set(found.manifest.id, e);
    return e;
  }

  return {
    async start() {
      fs.mkdirSync(deps.extDir, { recursive: true });
      const state = readEnabledState(deps.extDir);
      const records = readInstalled(deps.extDir);
      for (const found of discoverExtensions(deps.extDir)) {
        if (!found.manifest || !found.entryAbsPath) {
          deps.logSink.log('extensions', 'error', `invalid extension in ${found.dirName}: ${found.error}`);
          continue;
        }
        entries.set(found.manifest.id, {
          manifest: found.manifest,
          dir: found.dir,
          entryAbsPath: found.entryAbsPath,
          record: records.find((r) => r.id === found.manifest!.id),
          enabled: state[found.manifest.id]?.enabled ?? true,
          status: 'disabled',
          error: undefined,
          host: null,
          sourceIds: [],
        });
      }
      changed();
      for (const e of entries.values()) {
        // eslint-disable-next-line no-await-in-loop
        if (e.enabled) await activate(e);
      }
    },

    async stop() {
      installer.discardAll();
      for (const e of entries.values()) {
        // eslint-disable-next-line no-await-in-loop
        await deactivate(e);
      }
    },

    snapshot,

    async installPreview(ref) {
      try {
        const p = await installer.preview(ref);
        return {
          ok: true,
          token: p.token,
          id: p.manifest.id,
          name: p.manifest.name,
          version: p.manifest.version,
          caps: p.manifest.caps as Cap[],
          sizeBytes: p.sizeBytes,
          integrity: p.integrity,
        };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },

    async installCommit(token) {
      try {
        const { manifest, dir } = await installer.commit(token);
        const existing = entries.get(manifest.id);
        if (existing) await deactivate(existing);
        const consent: ConsentRecord = {
          extensionId: manifest.id as ExtensionId,
          caps: manifest.caps as Cap[],
          manifestVersion: manifest.version,
          grantedAt: new Date().toISOString(),
        };
        await deps.store.consents.record(consent);
        const state = readEnabledState(deps.extDir);
        state[manifest.id] = { enabled: true };
        writeEnabledState(deps.extDir, state);
        const e = await loadEntry(dir);
        if (!e) throw new Error('committed extension failed re-discovery');
        changed();
        await activate(e);
        return { ok: true, id: manifest.id };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    },

    async uninstall(id) {
      const e = entries.get(id);
      if (!e) return { ok: false, error: `no such extension: ${id}` };
      const sourceIds = e.manifest.contributes.sources ?? [];
      const accounts = await deps.store.read.accounts();
      if (accounts.some((a) => sourceIds.includes(a.source))) {
        return { ok: false, error: "Remove this connector's sources before uninstalling it." };
      }
      await deactivate(e);
      fs.rmSync(e.dir, { recursive: true, force: true });
      writeInstalled(deps.extDir, readInstalled(deps.extDir).filter((r) => r.id !== id));
      const state = readEnabledState(deps.extDir);
      delete state[id];
      writeEnabledState(deps.extDir, state);
      entries.delete(id);
      changed();
      return { ok: true };
    },

    async setEnabled(id, enabled) {
      const e = entries.get(id);
      if (!e) return { ok: false, error: `no such extension: ${id}` };
      e.enabled = enabled;
      const state = readEnabledState(deps.extDir);
      state[id] = { enabled };
      writeEnabledState(deps.extDir, state);
      if (enabled) await activate(e);
      else {
        await deactivate(e);
        setStatus(e, 'disabled');
      }
      changed();
      return { ok: true };
    },
  };
}
```

**Implementer note — `callTool`:** the tool proxy above calls `e.host.callTool(name, args)`. Add this method to Task 10's `createExtensionHost` return (it did not need it until now): keep a reference to the current incarnation's endpoint and expose

```ts
    callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
      if (!current) return Promise.reject(new Error('extension is not running'));
      return current.endpoint.call('tool', name, args === undefined ? [undefined] : [args]);
    },
```

(update Task 10's interface + add a small test there: after `start()`, `host.callTool('t', {})` resolves `1`).

- [ ] **Step 6: `src/main/main.ts` wiring**

1. Imports: `Notification` added to the electron import; `createExtensionPlatform, type ExtensionPlatform` from `./platform/extension-platform`; `utilityProcessTransport` from `./platform/transport`.
2. Retype the Task-1 placeholder: `let extensionsPlatform: ExtensionPlatform | null = null;`
3. After the `patchState` definition and BEFORE `registerIpc(...)` insert:

```ts
    extensionsPlatform = createExtensionPlatform({
      extDir: path.join(app.getPath('userData'), 'extensions'),
      store: p.store,
      sources: p.sources,
      scheduler: p.scheduler,
      registerTool: (t) => (mcp ? mcp.registerTool(t) : () => {}),
      inference: p.inference,
      logSink: p.logSink,
      notify: (msg) => {
        new Notification({ title: 'KIAgent', body: msg }).show();
      },
      transportFactory: (id) =>
        utilityProcessTransport(path.join(__dirname, 'extensionHost.js'), `kia-ext:${id}`),
      onChange: (extensions) => patchState({ extensions }),
    });
```

4. Change `registerIpc` signature to accept `extensions: ExtensionPlatform` as a 5th parameter and register inside it:

```ts
  handle('extension:install-preview', ({ ref }) => extensions.installPreview(ref));
  handle('extension:install-commit', ({ token }) => extensions.installCommit(token));
  handle('extension:uninstall', ({ id }) => extensions.uninstall(id));
  handle('extension:set-enabled', ({ id, enabled }) => extensions.setEnabled(id, enabled));
```

Call site becomes `registerIpc(p, () => lastPush, patchState, bundled, extensionsPlatform);`

5. AFTER `registerIpc(...)` and the `p.engine.project(...)` block, BEFORE `resumeAccounts(p)` (line ~446): `await extensionsPlatform.start();` — extension sources must be registered before accounts resume.
6. In the `before-quit` shutdown sequence, before `platform?.shutdown()`: `await extensionsPlatform?.stop().catch(() => {});`

- [ ] **Step 7: Run everything + commit**

```bash
npx jest src/main/platform/__tests__/extension-platform.test.ts   # PASS
npx tsc --noEmit ; npx jest                                        # full suite green, 4 pre-existing tsc errors
git add -A && git commit -m "feat(extensions): platform orchestrator, extension IPC, main-process wiring"
```

---

### Task 13: Real-process integration test + LEFTOVERS note

**Files:**
- Test: `src/main/platform/__tests__/extension-e2e.test.ts`
- Modify: `docs/rebuild/LEFTOVERS.md` (item #1)

**Interfaces:** consumes everything; produces no new API. This is the proof the utilityProcess-shaped stack works across a REAL process boundary: the same child entry file, forked with node + ts-node, drives the engine into a real store.

- [ ] **Step 1: Write the e2e test**

`src/main/platform/__tests__/extension-e2e.test.ts`:

```ts
/** @jest-environment node */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { AuthChannel, ExtensionSnapshot, Source } from '@shared/contracts';

import { createEngine } from '@main/core/engine/engine';
import { openStore, type CoreStore } from '@main/core/store/store';

import { createExtensionPlatform, type ExtensionPlatform } from '../extension-platform';
import { nodeForkTransport } from '../transport';

jest.setTimeout(120_000);

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const CHILD_ENTRY = path.resolve(__dirname, '../extension-host-entry.ts');
const FIXTURE = path.join(__dirname, 'fixtures', 'ext-basic');

describe('extension runtime e2e (real forked child)', () => {
  let tmp: string;
  let store: CoreStore;
  let platform: ExtensionPlatform;
  const registry = new Map<string, Source>();
  const snapshots: ExtensionSnapshot[][] = [];

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kia-e2e-'));
    store = openStore(path.join(tmp, 'kiagent.db'), {
      encrypt: (s) => Buffer.from(s, 'utf8'),
      decrypt: (b) => b.toString('utf8'),
      detectLanguages: () => [],
    });
    platform = createExtensionPlatform({
      extDir: path.join(tmp, 'extensions'),
      store,
      sources: {
        register: (s) => void registry.set(s.descriptor.id, s),
        get: (id) => registry.get(id),
        list: () => [...registry.values()].map((s) => s.descriptor),
        unregister: (id) => void registry.delete(id),
      },
      scheduler: { register: jest.fn(), unregister: jest.fn(), jobs: jest.fn(async () => []), trigger: jest.fn(), env: {} } as never,
      registerTool: () => () => {},
      inference: { complete: async () => '', see: async () => '', read: async () => '' },
      logSink: { log: (...a) => process.stderr.write(`${JSON.stringify(a)}\n`) },
      notify: () => {},
      transportFactory: () =>
        nodeForkTransport(CHILD_ENTRY, {
          cwd: REPO_ROOT,
          execArgv: ['-r', 'ts-node/register/transpile-only', '-r', 'tsconfig-paths/register'],
          env: {
            ...process.env,
            KIA_EXT_HOST_CHILD: '1',
            TS_NODE_TRANSPILE_ONLY: '1',
            TS_NODE_PROJECT: path.join(REPO_ROOT, 'tsconfig.json'),
          },
        }),
      onChange: (s) => snapshots.push(s),
    });
  });

  afterAll(async () => {
    await platform.stop();
    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('installs, activates in a real child, and the engine syncs its documents', async () => {
    await platform.start();
    const preview = await platform.installPreview(FIXTURE);
    expect(preview).toMatchObject({ ok: true, id: 'test.basic' });
    const commit = await platform.installCommit((preview as { token: string }).token);
    expect(commit).toEqual({ ok: true, id: 'test.basic' });
    expect(registry.has('basicsrc')).toBe(true);

    const engine = createEngine({
      store,
      sources: { get: (id) => registry.get(id), list: () => [], register: () => {} } as never,
      inference: { complete: async () => '', see: async () => '', read: async () => '' } as never,
      convert: async (d) => d,
      logs: { log: () => {} },
      refreshers: new Map(),
    });
    const auth = { prompt: async () => ({}), oauth: async () => ({}), showQr: () => {}, status: () => {} } as never as AuthChannel;
    const account = await engine.connect(registry.get('basicsrc')!, auth);
    expect(account.identifier).toBe('basic-account');

    const handle = engine.run(account);
    const deadline = Date.now() + 60_000;
    // eslint-disable-next-line no-await-in-loop
    while ((await store.read.count({ account: account.id })) < 2 && Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => { setTimeout(r, 200); });
    }
    await handle.stop();
    const docs = await store.read.search({ account: account.id });
    expect(docs.map((d) => d.externalId).sort()).toEqual(['basic-0', 'basic-1']);

    // uninstall is refused while the account lives, then succeeds after removal
    await expect(platform.uninstall('test.basic')).resolves.toMatchObject({ ok: false });
    await engine.remove(account.id);
    await expect(platform.uninstall('test.basic')).resolves.toEqual({ ok: true });
    expect(registry.has('basicsrc')).toBe(false);
  });
});
```

Implementer notes:
- If `engine.remove` has a different name on `Engine` (check `src/shared/contracts.ts` `Engine.remove` / the engine impl), use the store-level account removal the orchestrator test used. The intent is fixed: clear the account, then uninstall succeeds.
- If ts-node path-alias resolution fails in the forked child (`Cannot find module '@shared/...'`), the known fix is `TS_NODE_PROJECT` + `tsconfig-paths/register` exactly as above; verify `tsconfig.json` has `baseUrl`/`paths` for `@shared/*` (it does — jest maps the same aliases).
- This file is slow (~15–40 s); keep it as ONE `it` so the fork cost is paid once.

- [ ] **Step 2: Run it** — `npx jest src/main/platform/__tests__/extension-e2e.test.ts` → PASS.

- [ ] **Step 3: Update `docs/rebuild/LEFTOVERS.md` item #1** — replace its body with a note that the runtime landed (manifest validation, consent-gated utilityProcess host, source/tool proxies, local-path installer, `extension:*` IPC, AppState projection — plan `docs/superpowers/plans/2026-07-03-extension-runtime.md`) and that the REMAINING gap is Plan B: GitHub catalog + marketplace UI + ConsentModal + Notion port (spec §9). Keep the item number.

- [ ] **Step 4: Final gates + commit**

```bash
npx tsc --noEmit ; npx jest
git add -A && git commit -m "test(extensions): real-fork e2e — install, activate, engine sync, uninstall"
```

---

## Manual verification (after all tasks, human-driven)

1. `npm start`. In the app's devtools console:

```js
// Stage the committed fixture (adjust the absolute repo path):
await window.kiagent.invoke('extension:install-preview', { ref: '/Users/edjafarov/work/kiagent-core/src/main/platform/__tests__/fixtures/ext-basic' })
// → { ok: true, token: '…', caps: ['net'], … }
await window.kiagent.invoke('extension:install-commit', { token: '<token from above>' })
// → { ok: true, id: 'test.basic' }
```

2. Sources screen → "Add source" should now offer **Basic Source**; connecting it syncs 2 documents.
3. An MCP client (or the MCP e2e pattern) sees the `basic_echo` tool.
4. `await window.kiagent.invoke('extension:set-enabled', { id: 'test.basic', enabled: false })` → Activity Monitor shows the `kia-ext:test.basic` process exit.
5. `await window.kiagent.invoke('extension:uninstall', { id: 'test.basic' })` → refused until the account is removed in the UI, then succeeds.

## Plan self-review notes (already applied)

- `@types/tar` is unnecessary if the installed `tar` major ships its own types (v7 does) — Task 1 installs it anyway; drop it if npm warns it's stubbed.
- Task 10's `createExtensionHost` gains `callTool` in Task 12 (documented there) — Task 10's tests don't reference it.
- `ExtensionStatus` deliberately has NO transient `'enabled'` value (the spec's state diagram shows `enabled` as a transition input, not an observable state).
- Workers/providers contributions, `files`/`commands` cap implementations, GitHub refs, TOFU pinning, ConsentModal UI, and the Marketplace screen are **Plan B / out of scope** (spec §9–10) — do not add them.



