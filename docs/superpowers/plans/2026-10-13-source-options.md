# Source Options + Skip Subagent Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connectors can declare boolean per-account options, rendered as toggles on the account page. Agent Sessions uses one, "Skip subagent sessions" (default on), to stop indexing subagent sessions and to archive the ones already indexed.

**Architecture:**
- **Core:** a runtime `SourceDescriptor.options` list, validated when an extension registers.
  - Values live in `accounts.config.options.<key>`. Only a new store op writes them, and every wholesale config write keeps them inside the same transaction.
  - A new `accounts:set-option` channel goes through `engine.setOption`, which restarts the loop like `updateConfig`.
  - An Options card in SourceDetail.
- **Connector:** the connector reads the option from `session.account.config` and classifies subagent units. While skipping, it emits deletion-only batches of ≤ 500 refs before any render. Each batch removes only its own chunk's `fps` entries in the cursor it carries.

**Tech Stack:** TypeScript, Electron main + React renderer, better-sqlite3 (DB worker), jest 29 (+ jsdom/testing-library), node:test for the SDK, esbuild + ts-jest for the connector.

**Spec:** `docs/superpowers/specs/2026-10-13-source-options-design.md` (rev 4, SATISFIED)

## Global Constraints

- **Option type:** boolean only. `SourceOption = {key, label, description?, type:'boolean', default}`.
  - key: `/^[a-z][A-Za-z0-9]{0,39}$/`;
  - label ≤ 60 chars, description ≤ 200;
  - ≤ 8 options, unique keys.
- **Storage:** `accounts.config.options.<key>`. Effective value: `typeof config.options?.[key] === 'boolean' ? that : option.default`.
- **Store rule:** every wholesale config write (`config` op, `create` upsert, `applyFolderScope`) keeps the row's `options`. A non-plain-object `options` counts as absent, and an incoming `options` key is always dropped. Only the new `option` op changes `options`.
- **Option write:** the `option` op logs only on a real change (`changes === 0` → `logged: false`).
- **`setOption`:** grants **no** reconcile allowance. `updateConfig` refuses an `options` key.
- **Versions:**
  - `PLATFORM_API_VERSION` 2.11.0 → **2.12.0**;
  - SDK **1.9.0** (exports `optionValue`);
  - connector **1.1.0**, manifest `engine` **^2.12.0**.
- **Connector option:** `{ key: 'skipSubagents', type: 'boolean', default: true, label: 'Skip subagent sessions', description: "Don't index sessions started by another agent (reviews, explorers). Your own sessions, plans, tasks, memory and prompts are still indexed." }`.
- **Deletion batches:** ≤ 500 refs, `items: []`, emitted before any render. `RENDER_VERSION` stays 1, and there are no new cursor fields.
- **Repo rules:**
  - commit messages have **no** Co-Authored-By line;
  - never amend, rebase, reset or stash;
  - builds and tests run sequentially;
  - core gates are `npx jest <paths>` and `npx tsc -p tsconfig.typecheck.json`; never `npm test`'s pre-scripts.

## Review Focus

1. **Turning skip on for an account with ~9k indexed subagents, crash after the first deletion batch:** the remaining subagents are still removed on the next pull. Pinned in Task 8, "crash after first chunk".
2. **A Claude task list under a session id (it has `parentH`):** it must not be classified as a subagent and must not be deleted. Pinned in Task 7 and Task 8.
3. **Re-adding an already-connected Agent Sessions identifier:** the user's unchecked option survives. Pinned in Task 2, "create upsert keeps options".
4. **A folder-scoped connector's Save while options exist:** the options survive. Pinned in Task 2, "applyFolderScope keeps options".
5. **An existing user pulls with default config `{}`:** skip is effectively on, and existing connector tests that index subagents must opt out explicitly. Pinned in Task 7, which updates the fixtures.

---

## Part A — core (worktree `/Users/edjafarov/work/kcore-options`, branch `feat/source-options`)

`node_modules` is a symlink to `/Users/edjafarov/work/kiagent-core/node_modules`, and is gitignored.

### Task 1: Shared contract — `SourceOption`, `optionValue`, `validateSourceOptions`

**Files:**
- Modify: `src/shared/contracts.ts` (`SourceDescriptor` at :471)
- Create: `src/shared/source-options.ts`
- Test: `src/shared/__tests__/source-options.test.ts`

**Interfaces:**
- Produces:
  - `interface SourceOption { key: string; label: string; description?: string; type: 'boolean'; default: boolean }` (contracts.ts);
  - `SourceDescriptor.options?: SourceOption[]`;
  - `optionValue(descriptor: Pick<SourceDescriptor,'options'> | undefined, config: Record<string, unknown> | undefined, key: string): boolean | undefined` (undefined when the key is undeclared);
  - `validateSourceOptions(options: unknown): string | null` (an error message, or null when valid);
  - `isPlainObject(v: unknown): v is Record<string, unknown>`.

- [ ] **Step 1: Write the failing test**

```ts
// src/shared/__tests__/source-options.test.ts
import { isPlainObject, optionValue, validateSourceOptions } from '../source-options';
import type { SourceOption } from '../contracts';

const opt = (o: Partial<SourceOption> = {}): SourceOption => ({
  key: 'skipSubagents', label: 'Skip subagent sessions', type: 'boolean', default: true, ...o,
});

describe('optionValue', () => {
  const d = { options: [opt()] };
  it('falls back to the default when unset', () => expect(optionValue(d, {}, 'skipSubagents')).toBe(true));
  it('reads config.options.<key> when boolean', () =>
    expect(optionValue(d, { options: { skipSubagents: false } }, 'skipSubagents')).toBe(false));
  it('ignores a non-boolean stored value', () =>
    expect(optionValue(d, { options: { skipSubagents: 'no' } }, 'skipSubagents')).toBe(true));
  it('ignores a non-object options', () => expect(optionValue(d, { options: null }, 'skipSubagents')).toBe(true));
  it('ignores a top-level key of the same name', () =>
    expect(optionValue(d, { skipSubagents: false }, 'skipSubagents')).toBe(true));
  it('is undefined for an undeclared key', () => expect(optionValue(d, {}, 'other')).toBeUndefined());
  it('is undefined with no descriptor', () => expect(optionValue(undefined, {}, 'skipSubagents')).toBeUndefined());
});

describe('validateSourceOptions', () => {
  it('accepts undefined and a valid list', () => {
    expect(validateSourceOptions(undefined)).toBeNull();
    expect(validateSourceOptions([opt(), opt({ key: 'b', description: 'x' })])).toBeNull();
  });
  it.each([
    ['not an array', {}],
    ['more than 8', Array.from({ length: 9 }, (_, i) => opt({ key: `k${i}` }))],
    ['duplicate key', [opt(), opt()]],
    ['bad key pattern', [opt({ key: 'Skip' })]],
    ['bad key pattern (proto)', [opt({ key: '__proto__' })]],
    ['non-boolean type', [{ ...opt(), type: 'string' }]],
    ['non-boolean default', [{ ...opt(), default: 'yes' }]],
    ['long label', [opt({ label: 'x'.repeat(61) })]],
    ['empty label', [opt({ label: '' })]],
    ['long description', [opt({ description: 'x'.repeat(201) })]],
  ])('rejects %s', (_name, input) => expect(validateSourceOptions(input)).toEqual(expect.any(String)));
});

it('isPlainObject', () => {
  expect(isPlainObject({})).toBe(true);
  expect(isPlainObject(null)).toBe(false);
  expect(isPlainObject([])).toBe(false);
  expect(isPlainObject('x')).toBe(false);
});
```

- [ ] **Step 2: Run it.** Run: `npx jest src/shared/__tests__/source-options.test.ts`. Expected: FAIL, "Cannot find module '../source-options'".

- [ ] **Step 3: Implement.** In `src/shared/contracts.ts`, add the following directly above `export interface SourceDescriptor`:

```ts
/** A per-account boolean setting a connector declares on its RUNTIME
 *  descriptor. Core renders it as a toggle on the account page and stores the
 *  value at `accounts.config.options.<key>`; the connector reads it in `pull`
 *  via `optionValue`. Validated at extension registration
 *  (`validateSourceOptions`). */
export interface SourceOption {
  key: string;
  label: string;
  description?: string;
  type: 'boolean';
  default: boolean;
}
```

Then add this member to `SourceDescriptor`, after `compose?`:

```ts
  /** Per-account toggles (≤ 8). Values live in `account.config.options`. */
  options?: SourceOption[];
```

Create `src/shared/source-options.ts`:

```ts
import type { SourceDescriptor, SourceOption } from './contracts';

export const MAX_SOURCE_OPTIONS = 8;
const KEY = /^[a-z][A-Za-z0-9]{0,39}$/;

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The effective value of a declared option: the stored boolean at
 *  `config.options[key]`, else the declared default. `undefined` when the
 *  descriptor does not declare `key`. */
export function optionValue(
  descriptor: Pick<SourceDescriptor, 'options'> | undefined,
  config: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const opt = descriptor?.options?.find((o) => o.key === key);
  if (!opt) return undefined;
  const stored = isPlainObject(config?.options) ? config.options[key] : undefined;
  return typeof stored === 'boolean' ? stored : opt.default;
}

/** null when valid, else a one-line reason. */
export function validateSourceOptions(options: unknown): string | null {
  if (options === undefined) return null;
  if (!Array.isArray(options)) return 'options must be an array';
  if (options.length > MAX_SOURCE_OPTIONS) return `at most ${MAX_SOURCE_OPTIONS} options`;
  const seen = new Set<string>();
  for (const o of options as Array<Partial<SourceOption>>) {
    if (!isPlainObject(o)) return 'each option must be an object';
    if (typeof o.key !== 'string' || !KEY.test(o.key)) return `option key '${String(o.key)}' is invalid`;
    if (seen.has(o.key)) return `option key '${o.key}' is duplicated`;
    seen.add(o.key);
    if (o.type !== 'boolean') return `option '${o.key}' must have type 'boolean'`;
    if (typeof o.default !== 'boolean') return `option '${o.key}' needs a boolean default`;
    if (typeof o.label !== 'string' || o.label.length === 0 || o.label.length > 60)
      return `option '${o.key}' label must be 1–60 characters`;
    if (o.description !== undefined && (typeof o.description !== 'string' || o.description.length > 200))
      return `option '${o.key}' description must be ≤ 200 characters`;
  }
  return null;
}
```

- [ ] **Step 4: Run it.** Run: `npx jest src/shared/__tests__/source-options.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/shared/contracts.ts src/shared/source-options.ts src/shared/__tests__/source-options.test.ts
git commit -m "feat(contracts): SourceOption + optionValue/validateSourceOptions"
```

### Task 2: Store — `keepOptions` on every wholesale config write + `option` op

**Files:**
- Modify: `src/main/core/store/write-tx.ts`:
  - `AccountWriteOp` :212;
  - `accountWriteTx` `create` :593 and `config` :646;
  - `applyFolderScopeTx` UPDATE ~:1211.
- Modify: `src/main/core/store/store.ts`: the interface near :213 and the impl near :986.
- Test: `src/main/core/store/__tests__/account-options.test.ts`

**Interfaces:**
- Consumes: `isPlainObject` (Task 1).
- Produces:
  - `AccountWriteOp` member `{ op: 'option'; id: AccountId; key: string; value: boolean }`;
  - `CoreStore.setAccountOption(id: AccountId, key: string, value: boolean): Promise<void>`.

- [ ] **Step 1: Write the failing test**

```ts
// src/main/core/store/__tests__/account-options.test.ts
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDb } from '../../../db/app-db';
import { openStore, type CoreStore } from '../store';

let dir: string;
let store: CoreStore;
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-opts-'));
  store = openStore(await openDb(path.join(dir, 'test.db')), {
    encrypt: (s: string) => Buffer.from(s, 'utf8'),
    decrypt: (b: Buffer) => b.toString('utf8'),
    detectLanguages: () => [],
  });
});
afterEach(async () => {
  await store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
const make = (config: Record<string, unknown> = {}) =>
  store.createAccount({ source: 'claude-code', identifier: '~/.claude', config });

it('setAccountOption writes options.<key> and keeps other keys', async () => {
  const a = await make({ roots: ['/x'] });
  await store.setAccountOption(a.id, 'skipSubagents', false);
  await store.setAccountOption(a.id, 'other', true);
  expect((await store.account(a.id))?.config).toEqual({ roots: ['/x'], options: { skipSubagents: false, other: true } });
});

it('setAccountOption logs only on a real change', async () => {
  const a = await make();
  await store.setAccountOption(a.id, 'skipSubagents', false);
  const head = await store.headSeq();
  await store.setAccountOption(a.id, 'skipSubagents', false);
  expect(await store.headSeq()).toBe(head);
});

it('setAccountOption replaces a non-object options', async () => {
  const a = await make();
  await store.setAccountConfig(a.id, { x: 1 }); // options absent
  await store.setAccountOption(a.id, 'k', true);
  expect((await store.account(a.id))?.config).toEqual({ x: 1, options: { k: true } });
});

it('config op keeps the row options and drops an incoming options', async () => {
  const a = await make();
  await store.setAccountOption(a.id, 'skipSubagents', false);
  await store.setAccountConfig(a.id, { outbound: { mode: 'review' }, options: { skipSubagents: true } });
  expect((await store.account(a.id))?.config).toEqual({ outbound: { mode: 'review' }, options: { skipSubagents: false } });
});

it('config op drops an incoming options when the row has none', async () => {
  const a = await make();
  await store.setAccountConfig(a.id, { options: { skipSubagents: true } });
  expect((await store.account(a.id))?.config).toEqual({});
});

it('create upsert keeps options (re-add) and a fresh insert never seeds them', async () => {
  const fresh = await make({ options: { skipSubagents: false } });
  expect((await store.account(fresh.id))?.config).toEqual({});
  await store.setAccountOption(fresh.id, 'skipSubagents', false);
  const again = await make({ connector: 1 });
  expect(again.id).toBe(fresh.id);
  expect((await store.account(fresh.id))?.config).toEqual({ connector: 1, options: { skipSubagents: false } });
});

it('applyFolderScope keeps options', async () => {
  const a = await make({ folderRoots: [] });
  await store.setAccountOption(a.id, 'k', false);
  const acc = await store.account(a.id);
  const res = await store.applyFolderScope({
    accountId: a.id,
    config: { folderRoots: [{ id: 'r1' }] },
    cursor: null,
    archiveScopeRootIds: [],
    reattributeScopeRoots: [],
    archiveRefs: [],
    expectedConfigJson: JSON.stringify(acc!.config),
  });
  expect(res.stale).toBe(false);
  expect((await store.account(a.id))?.config).toEqual(expect.objectContaining({ options: { k: false } }));
});

it('two option writes with a whole-config write between keep both', async () => {
  const a = await make();
  await Promise.all([
    store.setAccountOption(a.id, 'a', true),
    store.setAccountConfig(a.id, { z: 1 }),
    store.setAccountOption(a.id, 'b', false),
  ]);
  expect((await store.account(a.id))?.config.options).toEqual({ a: true, b: false });
});
```

- [ ] **Step 2: Run it.** Run: `npx jest src/main/core/store/__tests__/account-options.test.ts`. Expected: FAIL, "store.setAccountOption is not a function", plus the keep-options assertions.

- [ ] **Step 3: Implement `write-tx.ts`.**

  1. Add `import { isPlainObject } from '@shared/source-options';` with the other `@shared` imports.
  2. Add `| { op: 'option'; id: AccountId; key: string; value: boolean }` to `AccountWriteOp`.
  3. Above `const accountWriteTx`, add:

```ts
  // Spec §3.3: `config.options` belongs to the `option` op alone. Every
  // wholesale config write keeps the row's current options (read in THIS
  // transaction) and drops whatever `options` the caller sent, so neither a
  // connector's connect/manageFolders result nor an engine caller can set or
  // reset them. A non-object stored value counts as none.
  const keepOptions = (
    rowConfigJson: string | undefined,
    next: Record<string, unknown>,
  ): Record<string, unknown> => {
    const { options: _dropped, ...rest } = next;
    let row: unknown;
    try {
      row = rowConfigJson
        ? (JSON.parse(rowConfigJson) as Record<string, unknown>).options
        : undefined;
    } catch {
      row = undefined;
    }
    return isPlainObject(row) ? { ...rest, options: row } : rest;
  };
  const configById = (id: AccountId): string | undefined =>
    (conn.prepare(`SELECT config FROM accounts WHERE id = ?`).get(id) as
      | { config: string }
      | undefined)?.config;
```

  4. In `case 'create'`, before the INSERT, add:

```ts
          const prior = conn
            .prepare(`SELECT config FROM accounts WHERE source = ? AND identifier = ?`)
            .get(w.source, w.identifier) as { config: string } | undefined;
```

     Then replace `JSON.stringify(w.config ?? {})` with `JSON.stringify(keepOptions(prior?.config, w.config ?? {}))`.
  5. In `case 'config'`, change `const value = JSON.stringify(w.config);` to `const value = JSON.stringify(keepOptions(configById(w.id), w.config));`.
  6. Add a new case after `config`:

```ts
        case 'option': {
          // Read-modify-write inside the account transaction: atomic against
          // every other account write (one DB worker, one tx at a time).
          const raw = configById(w.id);
          if (raw === undefined) return { id: w.id, logged: false };
          const cfg = JSON.parse(raw) as Record<string, unknown>;
          const options = isPlainObject(cfg.options) ? cfg.options : {};
          const value = JSON.stringify({ ...cfg, options: { ...options, [w.key]: w.value } });
          const r = conn
            .prepare(`UPDATE accounts SET config = ? WHERE id = ? AND config IS NOT ?`)
            .run(value, w.id, value);
          if (r.changes === 0) return { id: w.id, logged: false };
          appendChange('account', w.id);
          return { id: w.id, logged: true };
        }
```

  7. In `applyFolderScopeTx`, change `JSON.stringify(withLegacyMirror(acc.source, input.config))` to `JSON.stringify(withLegacyMirror(acc.source, keepOptions(acc.config, input.config)))`.

- [ ] **Step 4: Implement `store.ts`.** In the `CoreStore` interface, add after `setAccountConfig`:

```ts
  /** Spec §3.3: the ONLY writer of `config.options.<key>`; logs only on a
   *  real change. */
  setAccountOption(id: AccountId, key: string, value: boolean): Promise<void>;
```

In the impl, after `async setAccountConfig`, add:

```ts
    async setAccountOption(id, key, value) {
      const { logged } = await accountWrite({ op: 'option', id, key, value });
      if (logged) emitCommit();
    },
```

If `tsc` reports another `CoreStore` implementer (a read-proxy or fake), add the same method there by delegating.

- [ ] **Step 5: Run.** Run: `npx jest src/main/core/store/__tests__/account-options.test.ts src/main/core/store/__tests__/store.test.ts src/main/core/store/__tests__/write-tx.test.ts src/main/core/store/__tests__/folder-scope-migration.test.ts`. Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add src/main/core/store
git commit -m "feat(store): config.options owned by setAccountOption; wholesale writes keep it"
```

### Task 3: Engine — `setOption`, `updateConfig` refuses `options`

**Files:**
- Modify: `src/main/core/engine/flow-errors.ts`
- Modify: `src/main/core/engine/engine.ts` (the interface near :467, the impl after `updateConfig` ~:2032)
- Modify: `src/main/core/engine/flow-telemetry.ts:78` (classify the new error)
- Test: `src/main/core/engine/__tests__/source-options.test.ts`

**Interfaces:**
- Consumes:
  - `optionValue` (Task 1);
  - `store.setAccountOption` (Task 2);
  - `deps.sources.get(id)?.descriptor`.
- Produces:
  - `Engine.setOption(accountId: AccountId, key: string, value: boolean): Promise<void>`;
  - `export class OptionConfigError extends Error {}`.

- [ ] **Step 1: Write the failing test**

```ts
// src/main/core/engine/__tests__/source-options.test.ts
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Batch, DocumentInput, Source } from '@shared/contracts';
import { openDb } from '../../../db/app-db';
import { openStore, type CoreStore } from '../../store/store';
import { createEngine } from '../engine';
import { OptionConfigError } from '../flow-errors';

let dir: string;
let store: CoreStore;
let pulls: Array<Record<string, unknown>>;
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-engopt-'));
  store = openStore(await openDb(path.join(dir, 'test.db')), {
    encrypt: (s: string) => Buffer.from(s, 'utf8'),
    decrypt: (b: Buffer) => b.toString('utf8'),
    detectLanguages: () => [],
  });
  pulls = [];
});
afterEach(async () => {
  await store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function source(): Source<number, DocumentInput> {
  return {
    descriptor: {
      id: 'opt', name: 'Opt', documentTypes: ['note'], auth: 'none',
      options: [{ key: 'skip', label: 'Skip', type: 'boolean', default: true }],
    },
    async connect() { return { identifier: 'me' }; },
    async *pull(session, cursor): AsyncGenerator<Batch<number, DocumentInput>> {
      pulls.push(session.account.config);
      yield { phase: 'live', items: [], cursor: (cursor ?? 0) + 1 };
    },
    toDocument: (i) => i,
  };
}
const flow = { oauth: async () => ({}), showQr: () => {}, prompt: async () => ({}), status: () => {}, pickFolders: async () => [] };
function makeEngine(src: Source) {
  return createEngine({
    store,
    sources: { get: (id) => (id === src.descriptor.id ? src : undefined) },
    inference: { complete: async () => '', see: async () => '', read: async () => '', hear: async () => '' },
    convert: async (i) => i,
    logs: { log: () => {} },
  });
}
const waitFor = async (f: () => Promise<boolean> | boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await f()) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error('timeout');
};

it('setOption persists options.<key> and keeps other config', async () => {
  const src = source();
  const engine = makeEngine(src);
  const acc = await engine.connect(src, flow);
  await store.setAccountConfig(acc.id, { keep: 1 });
  await engine.setOption(acc.id, 'skip', false);
  expect((await store.account(acc.id))?.config).toEqual({ keep: 1, options: { skip: false } });
});

it('setOption rejects an undeclared key and a non-boolean', async () => {
  const src = source();
  const engine = makeEngine(src);
  const acc = await engine.connect(src, flow);
  await expect(engine.setOption(acc.id, 'nope', true)).rejects.toBeInstanceOf(OptionConfigError);
  await expect(engine.setOption(acc.id, 'skip', 'x' as unknown as boolean)).rejects.toBeInstanceOf(OptionConfigError);
});

it('setOption restarts a running loop with the new config; a no-op does not restart', async () => {
  const src = source();
  const engine = makeEngine(src);
  const acc = await engine.connect(src, flow);
  const h = engine.run(acc);
  await waitFor(() => pulls.length === 1);
  await engine.setOption(acc.id, 'skip', true); // equals the default → no-op
  await new Promise((r) => setTimeout(r, 200));
  expect(pulls).toHaveLength(1);
  await engine.setOption(acc.id, 'skip', false);
  await waitFor(() => pulls.length === 2);
  expect(pulls[1]).toEqual({ options: { skip: false } });
  await h.stop();
});

it('setOption leaves a paused account paused', async () => {
  const src = source();
  const engine = makeEngine(src);
  const acc = await engine.connect(src, flow);
  const h = engine.run(acc);
  await waitFor(() => pulls.length === 1);
  await store.setAccountStatus(acc.id, { status: 'paused' });
  await engine.setOption(acc.id, 'skip', false);
  await new Promise((r) => setTimeout(r, 200));
  expect((await store.account(acc.id))?.status).toBe('paused');
  expect(pulls).toHaveLength(1);
  await h.stop();
});

it('updateConfig refuses an options key', async () => {
  const src = source();
  const engine = makeEngine(src);
  const acc = await engine.connect(src, flow);
  await expect(engine.updateConfig(acc.id, { options: { skip: false } })).rejects.toBeInstanceOf(OptionConfigError);
});
```

- [ ] **Step 2: Run it.** Run: `npx jest src/main/core/engine/__tests__/source-options.test.ts`. Expected: FAIL, because `OptionConfigError` is not exported and `engine.setOption` is not a function.

- [ ] **Step 3: Implement.**
  - **`flow-errors.ts`:** append

```ts
/** A per-account option write named an undeclared key, a non-boolean value,
 *  or arrived through a door that does not own `config.options`. */
export class OptionConfigError extends Error {}
```

  - **`flow-telemetry.ts`:** next to the `FolderScopeConfigError` line, add `if (err instanceof OptionConfigError) return 'option-validate';`. Import it, and widen the returned union type if it is a literal union.
  - **`engine.ts` interface:** after `updateConfig(...)`, add:

```ts
  /** Set one declared boolean option (`config.options.<key>`); restarts a
   *  running loop like updateConfig, but grants no reconcile allowance. */
  setOption(accountId: AccountId, key: string, value: boolean): Promise<void>;
```

  - **`engine.ts` imports:** import `OptionConfigError` from `./flow-errors` and `optionValue` from `@shared/source-options`.
  - **`updateConfig` impl:** right after the `folderRoots` refusal, add:

```ts
      if (Object.prototype.hasOwnProperty.call(config, 'options'))
        throw new OptionConfigError(
          'options cannot be written through accounts:update-config — use accounts:set-option',
        );
```

  - **New method** after `updateConfig`:

```ts
    async setOption(
      accountId: AccountId,
      key: string,
      value: boolean,
    ): Promise<void> {
      // Same contention guards as updateConfig (C-28.1).
      const heldBy = activeByAccount.get(accountId);
      if (heldBy !== undefined) throw new AccountFlowBusyError(heldBy);
      if (transitionIntents.has(accountId))
        throw new AccountFlowBusyError('account-transition');
      const existing = await store.account(accountId);
      if (!existing) throw new OptionConfigError(`unknown account ${accountId}`);
      const descriptor = deps.sources.get(existing.source)?.descriptor;
      const current = optionValue(descriptor, existing.config, key);
      if (current === undefined)
        throw new OptionConfigError(`'${key}' is not an option of ${existing.source}`);
      if (typeof value !== 'boolean')
        throw new OptionConfigError(`option '${key}' takes true or false`);
      if (current === value) return;
      await store.setAccountOption(accountId, key, value);
      // No grantAllowance: an option is not a scope change (spec §3.4).
      if (!running.has(`account:${accountId}`)) return;
      const fresh = await store.account(accountId);
      if (fresh && fresh.status !== 'paused' && fresh.status !== 'needsReauth')
        engine.run(fresh);
    },
```

- [ ] **Step 4: Run.** Run: `npx jest src/main/core/engine/__tests__/source-options.test.ts src/main/core/engine/__tests__/account-flows.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/main/core/engine
git commit -m "feat(engine): setOption; updateConfig refuses options"
```

### Task 4: Extension registration gate + platform API 2.12.0

**Files:**
- Modify: `src/main/platform/extension-platform.ts:756-775`
- Modify: `src/shared/extension-rpc.ts:29` (`PLATFORM_API_VERSION = '2.12.0'`)
- Create fixture: `src/main/platform/__tests__/fixtures/ext-options/manifest.json`, `index.js`
- Test: `src/main/platform/__tests__/extension-platform.test.ts` (add one `it` after the F6 undeclared-source test, ~:1835)

**Interfaces:** Consumes `validateSourceOptions` (Task 1).

- [ ] **Step 1: Write the fixture and the failing test.**

`fixtures/ext-options/manifest.json`:

```json
{
  "id": "test.options",
  "name": "Options Test Extension",
  "version": "1.0.0",
  "engine": "^2.0.0",
  "entry": "index.js",
  "caps": ["net"],
  "contributes": { "sources": ["goodopts", "badopts"], "senders": [] }
}
```

`fixtures/ext-options/index.js`:

```js
/** Source options gate: 'goodopts' declares a valid option and registers;
 *  'badopts' declares an invalid one and is skipped with a warning. */
module.exports = {
  async activate() {
    const makeSource = (id, options) => ({
      descriptor: { id, name: id, documentTypes: ['basic.item'], auth: 'none', options },
      async connect() { return { identifier: 'acct', config: {} }; },
      async *pull() {},
      toDocument(item) { return item; },
    });
    return {
      sources: [
        makeSource('goodopts', [{ key: 'skipThings', label: 'Skip things', type: 'boolean', default: true }]),
        makeSource('badopts', [{ key: 'Bad Key', label: 'x', type: 'boolean', default: true }]),
      ],
      tools: [],
    };
  },
};
```

In the test file, add next to `FIXTURE_UNDECLARED` at :35:

```ts
const FIXTURE_OPTIONS = path.join(__dirname, 'fixtures', 'ext-options');
```

Add the test after the F6 test:

```ts
  it('registerContributions skips a source whose options fail validation; a valid options list reaches the registry', async () => {
    await platform.start();
    const preview = await platform.installPreview(FIXTURE_OPTIONS);
    if (!('token' in preview)) throw new Error(`preview failed: ${JSON.stringify(preview)}`);
    await expect(platform.installCommit(preview.token)).resolves.toEqual({ ok: true, id: 'test.options' });
    expect(registry.has('goodopts')).toBe(true);
    expect(registry.has('badopts')).toBe(false);
    expect(registry.get('goodopts')?.descriptor.options).toEqual([
      { key: 'skipThings', label: 'Skip things', type: 'boolean', default: true },
    ]);
    expect(logs).toContainEqual(
      expect.objectContaining({
        scope: 'extension:test.options',
        level: 'warn',
        msg: expect.stringContaining("source 'badopts' has invalid options"),
      }),
    );
    await expect(platform.uninstall('test.options')).resolves.toEqual({ ok: true });
  });
```

If the registry in this test file exposes a differently named getter than `get`, use whatever the F6 test's `registry` offers.

- [ ] **Step 2: Run it.** Run: `npx jest src/main/platform/__tests__/extension-platform.test.ts -t "invalid options"`. Expected: FAIL, because `registry.has('badopts')` is true.

- [ ] **Step 3: Implement.** In the `for (const s of c.sources)` loop, after the "already registered" gate and before `deps.sources.register(makeSource(s))`, add:

```ts
      const badOptions = validateSourceOptions(s.descriptor.options);
      if (badOptions !== null) {
        deps.logSink.log(
          `extension:${e.manifest.id}`,
          'warn',
          `source '${s.descriptor.id}' has invalid options (${badOptions}) — skipping`,
        );
        continue;
      }
```

Import `validateSourceOptions` from `@shared/source-options`. Set `PLATFORM_API_VERSION = '2.12.0'` in `src/shared/extension-rpc.ts`.

- [ ] **Step 4: Run.** Run: `npx jest src/main/platform/__tests__/extension-platform.test.ts`. Expected: PASS. If a test pins `'2.11.0'`, update it to `'2.12.0'`: `grep -rn "2\.11\.0" src --include='*.test.ts'`.

- [ ] **Step 5: Commit.**

```bash
git add src/main/platform src/shared/extension-rpc.ts
git commit -m "feat(platform): validate source options at registration; platform API 2.12.0"
```

### Task 5: `accounts:set-option` channel + Options card

**Files:**
- Modify: `src/shared/ipc.ts` (`Invokes` near :432, `INVOKE_CHANNEL_MAP` near :707)
- Modify: `src/main/main.ts` (handler after `'accounts:update-config'` :627)
- Create: `src/renderer/screens/Sources/sections/Options.tsx`
- Modify: `src/renderer/screens/Sources/SourceDetail.tsx` (import + mount after `<Cadence account={a} />` :190)
- Test: `src/renderer/screens/Sources/sections/__tests__/Options.test.tsx`

**Interfaces:**
- Consumes: `optionValue` (Task 1), `engine.setOption` (Task 3).
- Produces: invoke `'accounts:set-option'`, `req: { accountId: AccountId; key: string; value: boolean }`, `res: void`, and the component `Options(props: { account: Account; descriptor: SourceDescriptor })`.

- [ ] **Step 1: Write the failing test**

```tsx
// src/renderer/screens/Sources/sections/__tests__/Options.test.tsx
import '@testing-library/jest-dom';
import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { Account, SourceDescriptor } from '@shared/contracts';
import { Options } from '../Options';

const descriptor = {
  id: 'claude-code', name: 'Claude Code', documentTypes: [], auth: 'none',
  options: [{ key: 'skipSubagents', label: 'Skip subagent sessions', description: 'Not indexed.', type: 'boolean', default: true }],
} as SourceDescriptor;
const account = (config: Record<string, unknown> = {}) =>
  ({ id: 'a1', source: 'claude-code', identifier: '~/.claude', config, status: 'live', cursor: null, createdAt: '' }) as unknown as Account;

let invoke: jest.Mock;
beforeEach(() => {
  invoke = jest.fn(() => Promise.resolve(undefined));
  (window as unknown as { kiagent: unknown }).kiagent = { invoke };
});

test('shows the effective default', () => {
  render(<Options account={account()} descriptor={descriptor} />);
  expect(screen.getByRole('switch', { name: 'Skip subagent sessions' })).toHaveAttribute('aria-checked', 'true');
  expect(screen.getByText('Not indexed.')).toBeInTheDocument();
});

test('shows a stored value', () => {
  render(<Options account={account({ options: { skipSubagents: false } })} descriptor={descriptor} />);
  expect(screen.getByRole('switch', { name: 'Skip subagent sessions' })).toHaveAttribute('aria-checked', 'false');
});

test('toggling invokes accounts:set-option and disables while pending', async () => {
  let resolve!: () => void;
  invoke.mockImplementation(() => new Promise<void>((r) => { resolve = r; }));
  render(<Options account={account()} descriptor={descriptor} />);
  const sw = screen.getByRole('switch', { name: 'Skip subagent sessions' });
  fireEvent.click(sw);
  expect(invoke).toHaveBeenCalledWith('accounts:set-option', { accountId: 'a1', key: 'skipSubagents', value: false });
  expect(sw).toBeDisabled();
  expect(sw).toHaveAttribute('aria-checked', 'false');
  await act(async () => { resolve(); });
  expect(sw).not.toBeDisabled();
});

test('an error reverts the toggle and shows the message', async () => {
  invoke.mockImplementation(() => Promise.reject(new Error('another folder or reconnect flow is already running')));
  render(<Options account={account()} descriptor={descriptor} />);
  const sw = screen.getByRole('switch', { name: 'Skip subagent sessions' });
  await act(async () => { fireEvent.click(sw); });
  expect(sw).toHaveAttribute('aria-checked', 'true');
  expect(screen.getByRole('alert')).toHaveTextContent('Finishing the current sync step — try again in a moment');
});
```

- [ ] **Step 2: Run it.** Run: `npx jest src/renderer/screens/Sources/sections/__tests__/Options.test.tsx`. Expected: FAIL, "Cannot find module '../Options'".

- [ ] **Step 3: Implement.**
  - **`ipc.ts` `Invokes`:** after `'accounts:update-outbound'`, add:

```ts
  /** One declared boolean source option (`config.options.<key>`) — spec
   *  source-options §3.4. Restarts a running loop; no reconcile allowance. */
  'accounts:set-option': {
    req: { accountId: AccountId; key: string; value: boolean };
    res: void;
  };
```

  - **`ipc.ts` `INVOKE_CHANNEL_MAP`:** after `'accounts:update-outbound': 0,`, add `'accounts:set-option': 0,`.
  - **`main.ts`:** after the `'accounts:update-config'` handler, add:

```ts
    'accounts:set-option': ({ accountId, key, value }) =>
      p.engine.setOption(accountId, key, value),
```

  - **`Options.tsx`:**

```tsx
import React, { useState } from 'react';
import { Card, CardHeader, SettingsRow, Toggle } from '@shared/web-ui/ui';
import type { Account, SourceDescriptor } from '@shared/contracts';
import { optionValue } from '@shared/source-options';

/** Connector-declared boolean options (spec source-options §3.5). Values live
 *  in account.config.options and are written ONLY via accounts:set-option. */
export function Options(props: {
  account: Account;
  descriptor: SourceDescriptor;
}): React.ReactElement | null {
  const { account, descriptor } = props;
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  if (!descriptor.options?.length) return null;

  const set = async (key: string, value: boolean) => {
    setError(null);
    setPending((p) => ({ ...p, [key]: value }));
    try {
      await window.kiagent.invoke('accounts:set-option', { accountId: account.id, key, value });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(/already running|transition/i.test(msg) ? 'Finishing the current sync step — try again in a moment' : msg);
    } finally {
      setPending(({ [key]: _done, ...rest }) => rest);
    }
  };

  return (
    <Card>
      <CardHeader label="Options" />
      {descriptor.options.map((o) => {
        const inFlight = Object.prototype.hasOwnProperty.call(pending, o.key);
        const checked = inFlight ? pending[o.key] : optionValue(descriptor, account.config, o.key) ?? o.default;
        return (
          <SettingsRow
            key={o.key}
            title={o.label}
            description={o.description}
            control={
              <Toggle aria-label={o.label} checked={checked} disabled={inFlight} onChange={(next) => void set(o.key, next)} />
            }
          />
        );
      })}
      {error && <div role="alert" className="field-error">{error}</div>}
    </Card>
  );
}
```

  - **`SourceDetail.tsx`:** add `import { Options } from './sections/Options';`, and after `<Cadence account={a} />` add:

```tsx
              {descriptor?.options?.length ? <Options account={a} descriptor={descriptor} /> : null}
```

  `checked` must reflect the stored value after a successful write. The accounts list refreshes from the account change the store emits; once the pending entry is removed, the component reads `account.config` again.

- [ ] **Step 4: Run.** Run: `npx jest src/renderer/screens/Sources` and then `npx tsc -p tsconfig.typecheck.json`. Expected: PASS, and tsc exits with 0 errors (the `INVOKE_CHANNEL_MAP` `satisfies` check proves the channel is in both places).

- [ ] **Step 5: Commit.**

```bash
git add src/shared/ipc.ts src/main/main.ts src/renderer/screens/Sources
git commit -m "feat(sources): accounts:set-option + Options card"
```

### Task 6: SDK 1.9.0 exports `optionValue`

**Files:**
- Modify: `sdk/connector-sdk/scripts/generate.mjs` (file list), `sdk/connector-sdk/src/index.ts`
- Modify: `sdk/connector-sdk/test/generate.test.mjs` (`GENERATED_SHARED`)
- Modify: `sdk/connector-sdk/package.json` and `package-lock.json` (version 1.9.0, both lock fields), `README.md` ("Current release" line)

**Interfaces:** Produces `import { optionValue, validateSourceOptions, type SourceOption } from '@kiagent/connector-sdk'`.

- [ ] **Step 1: Write the failing test.** Add `'source-options.ts'` to `GENERATED_SHARED` in `test/generate.test.mjs`, and append:

```js
test('compiled entrypoint exposes optionValue', async () => {
  const sdk = await import(join(sdkRoot, 'dist', 'index.js'));
  assert.equal(sdk.optionValue({ options: [{ key: 'k', label: 'K', type: 'boolean', default: true }] }, {}, 'k'), true);
});
```

- [ ] **Step 2: Run it.** Run: `cd sdk/connector-sdk && node --test test/generate.test.mjs` (it builds nothing itself). Expected: FAIL, because `generated/source-options.ts` is missing.

- [ ] **Step 3: Implement.**
  - Add `'source-options.ts'` to the copy list in `scripts/generate.mjs`.
  - Add `export * from './generated/source-options';` to `src/index.ts`.
  - Set `"version": "1.9.0"` in `package.json` and in both `package-lock.json` version fields.
  - Leave `kiagentCore` as is until the release task. `package.test.mjs` pins it to core's package version; if that test currently passes, keep it passing.
  - README: change "Current release" to `**1.9.0**` and platform API **2.12.0**.

- [ ] **Step 4: Run.** Run: `cd sdk/connector-sdk && npm test`. Expected: all node:test files PASS. If `package.test.mjs` fails only on `kiagentCore` vs core's version, set `kiagentCore` to core's `package.json` version.

- [ ] **Step 5: Commit.**

```bash
git add sdk/connector-sdk
git commit -m "feat(sdk): 1.9.0 — optionValue, SourceOption"
```

- [ ] **Step 6: Run the full core gate.** Run sequentially: `npx tsc -p tsconfig.typecheck.json`, then `npx jest src/shared src/main/core/store src/main/core/engine src/main/platform src/renderer/screens/Sources > /tmp/…/core-gate.txt 2>&1; tail -40` of that file. Expected: 0 tsc errors, and jest all green apart from failures already documented on origin/dev. Record any such failure by name.

---

## Part B — connector (worktree `/Users/edjafarov/work/asc-skip-subagents`, branch `feat/skip-subagents` off `origin/main`)

Setup, done once before Task 7:

```bash
cd /Users/edjafarov/work/agent-sessions-kia-connector && git fetch -q origin
git worktree add -b feat/skip-subagents /Users/edjafarov/work/asc-skip-subagents origin/main
cd /Users/edjafarov/work/kcore-options/sdk/connector-sdk && npm pack --pack-destination /Users/edjafarov/work/asc-skip-subagents/vendor
cd /Users/edjafarov/work/asc-skip-subagents && npm ci && npm install --save-dev ./vendor/kiagent-connector-sdk-1.9.0.tgz
```

`vendor/` stays out of git: add `vendor/` to `.gitignore`. Release Task R3 swaps in the released URL. Commit package.json and the lock only in R3. Until then, keep the `file:` dependency uncommitted, or commit it on the branch and replace it in R3.

### Task 7: Read the option, declare it, classify subagent units

**Files:**
- Modify: `src/sync.ts` (`Unit` gains `subagent?: ExternalRef`)
- Modify: `src/source.ts` (declare `options`, read `skip`, pass it to `runSync`)
- Modify: `src/claude/source.ts:12-31` (subagent `ref`)
- Modify: `src/codex/source.ts:61-72` (subagent `ref` when `parentH`)
- Modify: `src/doc.ts` (export the option constant)
- Test: `src/__tests__/claude-source.test.ts`, `src/__tests__/codex-source.test.ts`

**Interfaces:**
- Produces:
  - `Unit.subagent?: { externalId: string; type: 'agent.session' }`;
  - `runSync({..., skipSubagents: boolean})`;
  - `export const SKIP_SUBAGENTS: SourceOption` in `src/doc.ts`.

- [ ] **Step 1: Write the failing tests.**

  In `claude-source.test.ts`:
  - change the `pull` helper to take a `skip` flag: `async function pull(src, cursor, stopAfter?, skip = false)`;
  - call `src.pull(fakeSession({ account: { config: { options: { skipSubagents: skip } } } }), cursor)`;
  - every existing call keeps its current behaviour (`skip = false`), which is the fixture update for Review Focus 5.

  Then add:

```ts
it('declares the skipSubagents option, default on', () => {
  expect(claudeSource(fsFiles(root)).descriptor.options).toEqual([
    expect.objectContaining({ key: 'skipSubagents', type: 'boolean', default: true }),
  ]);
});

it('default config ({}) skips subagent sessions but keeps sessions, tasks, plans, memory', async () => {
  const src = claudeSource(fsFiles(root));
  const docs: DocumentInput[] = [];
  for await (const b of src.pull(fakeSession(), null)) docs.push(...b.items);
  const ids = docs.map((d) => d.externalId);
  expect(ids).toContain(`session:${S1}`);
  expect(ids).toContain(`tasks:${S1}`);
  expect(ids.some((i) => i.includes('/agent-') || i === `session:${S1}/a1` || i === `session:${S2}/a2`)).toBe(false);
});
```

  Adapt the task externalId to whatever `renderTasks` emits; check the existing test for the exact id. Make the matching change in `codex-source.test.ts`'s `pull` helper (`skip = false` default), and add:

```ts
it('skip on: a thread with a parent is not emitted; the parent is', async () => {
  // reuse the file's existing parent/child rollout fixture
  const { ids } = await pull(codexSource(fsFiles(root)), null, undefined, true);
  expect(ids).toContain(`session:${PARENT_ID}`);
  expect(ids).not.toContain(`session:${CHILD_ID}`);
});
```

  `PARENT_ID` and `CHILD_ID` are the ids the file's existing subagent test already uses; reuse those constants or literals.

- [ ] **Step 2: Run them.** Run: `npx jest src/__tests__/claude-source.test.ts src/__tests__/codex-source.test.ts`. Expected: the new tests FAIL (`descriptor.options` undefined, subagents emitted), and the existing ones still PASS.

- [ ] **Step 3: Implement.**
  - **`src/doc.ts`:** add `import type { SourceOption } from '@kiagent/connector-sdk';` and:

```ts
export const SKIP_SUBAGENTS: SourceOption = {
  key: 'skipSubagents', type: 'boolean', default: true, label: 'Skip subagent sessions',
  description: "Don't index sessions started by another agent (reviews, explorers). Your own sessions, plans, tasks, memory and prompts are still indexed.",
};
```

  - **`src/sync.ts` `Unit`:** add `subagent?: { externalId: string; type: 'agent.session' };`. Add `skipSubagents?: boolean` to the `runSync` options object. Task 8 uses it; for now, accept the field and filter `o.units` with `const units = o.skipSubagents ? o.units.filter((u) => !u.subagent) : o.units;`. The filter runs **after** the `recordParent` loop, so cached parents are still recorded. Concretely: keep `byH` and the `recordParent` loop over **all** units, then build `ordered` from units that are not skipped.
  - **`src/source.ts` `makeSource`:** set the descriptor to `{ ..., cadence: { every: '15m' }, options: [SKIP_SUBAGENTS] }`. In `pull`:

```ts
      const skipSubagents = optionValue({ options: [SKIP_SUBAGENTS] }, session.account.config, SKIP_SUBAGENTS.key) ?? true;
      for await (const b of runSync({ cursor: c, units, session, maxDocs: opts?.maxDocs, skipSubagents })) {
```

    Import `optionValue` from `@kiagent/connector-sdk`.
  - **`src/claude/source.ts` `sessionUnit`:** add `subagent: sub ? { externalId: \`session:${sessionId}/${sub.agentId}\`, type: 'agent.session' } : undefined,`. This is the same id `sessionDocument` builds from `key: \`${sessionId}/${sub.agentId}\``.
  - **`src/codex/source.ts`:** in the unit literal, add `subagent: parentH ? { externalId: \`session:${id}\`, type: 'agent.session' } : undefined,`.

- [ ] **Step 4: Run.** Run: `npx jest` and then `npx tsc --noEmit`. Expected: all PASS, 0 errors.

- [ ] **Step 5: Commit.**

```bash
git add src .gitignore
git commit -m "feat: skipSubagents option (default on) — subagent units not rendered while skipping"
```

### Task 8: Cleanup — deletion-only batches with per-chunk `fps` removal

**Files:**
- Modify: `src/sync.ts` (`runSync`)
- Test: `src/__tests__/sync.test.ts`

**Interfaces:** Consumes `Unit.subagent` and `runSync({skipSubagents})` from Task 7. Produces the exported `DELETE_CHUNK = 500`.

- [ ] **Step 1: Write the failing tests.**

  In `sync.test.ts`:
  - extend `Spec` with `sub?: boolean`;
  - in `units()`, add `subagent: s.sub ? { externalId: \`session:${s.key}\`, type: 'agent.session' as const } : undefined`;
  - extend `drain` to take `skip?: boolean` and pass `skipSubagents: opts.skip` to `runSync`.

  Then add:

```ts
it('skip on: indexed subagents are deleted in a deletion-only batch before any render; a second pull emits nothing', async () => {
  const specs: Spec[] = [{ key: 'm' }, { key: 'm/s1', parent: 'm', sub: true }, { key: 't', parent: 'm' }];
  const c = (await drain(C0(), specs)).cursor; // indexed with skip off
  renders = [];
  const on = await drain(c, specs, { skip: true });
  expect(on.batches[0]).toEqual(expect.objectContaining({ items: [], deletions: [{ externalId: 'session:m/s1', type: 'agent.session' }] }));
  expect(on.batches.flatMap((b) => b.deletions ?? [])).toHaveLength(1); // task 't' (has parentH) untouched
  expect(renders).toEqual([]);
  const again = await drain(on.cursor, specs, { skip: true });
  expect(again.batches.flatMap((b) => b.deletions ?? [])).toEqual([]);
});

it('skip on: deletions are chunked by DELETE_CHUNK; crash after first chunk → replay deletes the rest', async () => {
  const subs: Spec[] = Array.from({ length: DELETE_CHUNK + 3 }, (_, i) => ({ key: `m/s${String(i).padStart(4, '0')}`, parent: 'm', sub: true }));
  const specs: Spec[] = [{ key: 'm' }, ...subs];
  const c = (await drain(C0(), specs, { maxDocs: 1000 })).cursor;
  const crashed = await drain(c, specs, { skip: true, stopAfter: 1 });
  expect(crashed.batches[0].deletions).toHaveLength(DELETE_CHUNK);
  const rest = await drain(crashed.cursor, specs, { skip: true });
  expect(rest.batches.flatMap((b) => b.deletions ?? [])).toHaveLength(3);
});

it('skip off after on: subagents re-render, others do not', async () => {
  const specs: Spec[] = [{ key: 'm' }, { key: 'm/s1', parent: 'm', sub: true }];
  let c = (await drain(C0(), specs)).cursor;
  c = (await drain(c, specs, { skip: true })).cursor;
  renders = [];
  await drain(c, specs, { skip: false });
  expect(renders).toEqual(['m/s1']);
});

it('skip on, fresh cursor: a subagent is never rendered and nothing is deleted', async () => {
  const r = await drain(C0(), [{ key: 'm' }, { key: 'm/s1', parent: 'm', sub: true }], { skip: true });
  expect(renders).toEqual(['m']);
  expect(r.batches.flatMap((b) => b.deletions ?? [])).toEqual([]);
});
```

  Import `DELETE_CHUNK` from `'../sync'`.

- [ ] **Step 2: Run them.** Run: `npx jest src/__tests__/sync.test.ts`. Expected: FAIL, because `DELETE_CHUNK` is not exported and no deletions are emitted.

- [ ] **Step 3: Implement in `runSync`.**
  - Add `export const DELETE_CHUNK = 500;` near `MAX_DOCS`.
  - After the `recordParent` loop, and before `depth`/`ordered`, replace the Task 7 filter with:

```ts
  // Spec §4.3: while skipping, subagent units are never rendered, and any that
  // were indexed (an fps entry exists, ok or failed) are deleted FIRST, in
  // deletion-only batches. Each batch removes only ITS chunk's fps entries,
  // so a crash between batches leaves the rest to be retried next pull.
  const skipped = o.skipSubagents ? [...byH.values()].filter((u) => u.subagent) : [];
  for (const u of skipped) byH.delete(u.uh);
  const cleanup = skipped.filter((u) => fps[u.uh] !== undefined).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (let i = 0; i < cleanup.length; i += DELETE_CHUNK) {
    const chunk = cleanup.slice(i, i + DELETE_CHUNK);
    for (const u of chunk) delete fps[u.uh];
    yield { phase, items: [], deletions: chunk.map((u) => u.subagent!), cursor: checkpoint(cur.pass) };
    if (o.session.signal.aborted) return;
  }
```

    `ordered` is built from `byH.values()`, which now excludes the skipped units. Remove the earlier Task 7 `units` filter line.
  - Keep `depthOf`'s use of `byH`. A kept child of a skipped parent does not exist: tasks parent to main sessions, and nested Codex subagents are themselves skipped.
  - The `Batch` type import already allows `deletions`. Its element type is `ExternalRef` from the SDK; `subagent` matches it structurally.

- [ ] **Step 4: Run.** Run: `npx jest`, then `npx tsc --noEmit`, then `npm run build`. Expected: all PASS, 0 errors, and the bundle builds. The bundle-load test in `npx jest` covers `dist`.

- [ ] **Step 5: Commit.**

```bash
git add src
git commit -m "feat: archive indexed subagent sessions while skipping (≤500-ref deletion batches, per-chunk fps)"
```

### Task 9: Manifest, version, README

**Files:** `manifest.json`, `package.json` (version only), `README.md`

- [ ] **Step 1.** `manifest.json`: set `"version": "1.1.0"` and `"engine": "^2.12.0"`. `package.json`: set `"version": "1.1.0"`.
- [ ] **Step 2.** README:
  - in the "What is indexed" table, add a note under **Subagent session**: "skipped by default — see Options";
  - add a section:

```markdown
## Options

Each source has **Skip subagent sessions** on its account page (on by default). While it is on, sessions started by another agent — reviews, explorers, Codex child threads — are not indexed, and any already indexed are removed on the next sync. Turn it off to index them again (a few minutes for thousands of sessions). Subagent sessions whose files Claude Code or Codex already deleted cannot be removed by the connector and stay searchable.

Requires KIA with platform API 2.12.0 or later.
```

- [ ] **Step 3.** Run `npx jest` and `npx tsc --noEmit`. Expected: PASS. Then commit:

```bash
git add manifest.json package.json README.md
git commit -m "chore: 1.1.0 — engine ^2.12.0, README Options"
```

---

## Part C — release (user-gated: run only on an explicit "roll it out")

- **R1 core:** merge `feat/source-options` → kiagent-core `dev` (PR), then release-it to **v0.111.0**. Record the peeled tag sha.
- **R2 SDK:**
  - set `kiagentCore` to `0.111.0` and keep version 1.9.0 (both lock fields);
  - run `sdk/connector-sdk/scripts/release.sh`, which creates `sdk-v1.9.0` with the tgz.
- **R3 connector:**
  - replace the vendored dependency with `https://github.com/edjafarov/kiagent-core/releases/download/sdk-v1.9.0/kiagent-connector-sdk-1.9.0.tgz`;
  - run `npm install`, `npx jest`, `npx tsc --noEmit` and `npm run build`;
  - merge to main, tag `v1.1.0`, and create the GitHub release with the packed tgz (same as v1.0.0). CI must be green.
- **R4 alpha-cent:** bump `core.lock` to v0.111.0 (peeled sha), re-stage `build/.core`, and run the overlay typecheck. An app release is needed before Marketplace users can install connector 1.1.0.
