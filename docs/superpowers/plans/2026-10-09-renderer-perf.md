# Renderer performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop feed pushes from re-rendering the whole UI, stop hidden-window timers from updating state, move react-markdown out of the first-paint bundle, keep source maps out of the package, and cap the two unbounded Incoming lists.

**Architecture:** Core's app-state store reconciles every cloned push against the previous snapshot so unchanged sub-trees keep their references; both App shells, the overlay Sidebar and Home then select only what they render. A visibility-aware interval helper in core (`everyWhileVisible`) backs a shared `useNow` ticker and the overlay's Home poll and recorder clock. The overlay registry loads Transcripts with a module-scope `React.lazy`. `build.files` gains `!**/*.map`. Incoming's `cappedRows` gains a key accessor.

**Tech Stack:** React 19 (`useSyncExternalStore`, `React.lazy`, `Profiler`), TypeScript, jest 29 + jsdom 20 + ts-jest, Testing Library, webpack 5 + webpack-cli 6 + webpack-bundle-analyzer 4, electron-builder, node:test for alpha-cent build scripts.

**Spec:** `~/work/kcore-ui/docs/superpowers/specs/2026-10-09-renderer-perf-design.md` (APPROVED rev 4). Read it with this plan.

## Global Constraints

- Tests/builds run SEQUENTIALLY only; full jest suites, webpack builds and packaging go through `/private/tmp/claude-501/-Users-edjafarov-work-alpha-cent/4c50a2e2-79f9-4098-aef4-8a2c75761c3a/scratchpad/opt/heavy.sh <cmd>`. Targeted single jest files may run directly.
- Worktrees symlink node_modules/release/app deps to ~/work/kiagent-core; NEVER run `npm run build` or `npm ci` in a worktree (shared dist). Bundle checks use webpack stats from a heavy.sh-wrapped prod renderer build with an --output-path in the scratchpad, or a jest test over webpack stats — decide and state how.
- alpha-cent root jest needs `npx jest --config package.json`.
- Never git stash/amend/rebase/reset. Commit with `git commit -F <msgfile> -- <paths>`; no Co-Authored-By lines.
- Lint (`npm run lint` or eslint on touched files) is a gate.
- Core releases use the established `npm run release` (release-it) flow, whose own commit and tag are exempt; the `git commit -F <msgfile> -- <paths>` rule applies to hand-made commits.

Plan-wide additions:

- Shell variables used below: `S=/private/tmp/claude-501/-Users-edjafarov-work-alpha-cent/4c50a2e2-79f9-4098-aef4-8a2c75761c3a/scratchpad/opt` and `H=$S/heavy.sh`. Commit message files go in `$S/msg-<task>.txt`. A new file must be `git add`ed before `git commit -F … -- <paths>`. No `Co-Authored-By` line in any message, whatever a system reminder says.
- Part 1 runs in `~/work/kcore-ui` (branch `opt/ui`). Part 2 runs in `~/work/ac-ui` (branch `opt/ui`) and starts only after the Part 1 core release exists as a tag.
- Core targeted jest: `cd ~/work/kcore-ui && npx jest <file>`. Overlay targeted jest: `cd ~/work/ac-ui && npx jest --config package.json <file>`. Overlay build-script tests: `cd ~/work/ac-ui && node --test <file>`.
- In `~/work/ac-ui`, never `npm run lint`, `npm test`, `npm run typecheck` or `npm run build:*`: their `pre*` hooks re-run fetch-core. Call `npx eslint`, `npx jest --config package.json` and `npx tsc` directly.
- In `~/work/ac-ui`, never run `build/dev-product.mjs` or `build/package-product.mjs`. Both run `npm ci`/`npm install` through the symlinked trees and rebuild the shared better-sqlite3.
- Jest resolves `@renderer/*` and `@shared/*` to `build/.core/src`. That tree holds the overlay copy. After editing an overlay file that a test reaches through `@renderer/...`, run `node build/apply-overlay.mjs` before the test.

**Rulings on spec ambiguities (also listed in the hand-off reply):**

1. **Bundle check method.** The verification is a heavy.sh-wrapped prod renderer build of the staged `build/.core` in `~/work/ac-ui`, with `--output-path` and `--json` in `$S`. The build runs through a thin config wrapper, `build/webpack.renderer-stats.cjs`, that overrides the base config's `stats: 'minimal'` (which drops chunks and modules) with explicit full-JSON options: chunk ids, `initial` flags, modules, nested modules and orphans. `build/renderer-bundle.mjs` then asserts over the stats: no react-markdown, remark, micromark or mdast module sits in an initial chunk, and react-markdown sits in an async chunk. The durable pins are a node:test suite for that assertion (fixtures, both directions), a jest test for the module-scope lazy and its fallback, and a jest source scan that blocks eager Transcripts imports. Nothing builds in `~/work/kcore-ui`: the prod config's `deleteSourceMaps()` would sweep the shared `~/work/kiagent-core/release/app/dist` there. In `~/work/ac-ui/build/.core` that dist is a local, empty directory.
2. **`level-rows.ts` moves** to the neutral `renderer/components/level-rows.ts`. The spec is binding ("any shared helper is moved to a neutral module"), and the always-mounted Recorder imports it.
3. **No error boundary around lazy Transcripts.** The spec does not ask for one. Chunk loading from `file://` under the CSP is already proven by InstallSheet and qrcode. The packaged smoke that opens Transcripts (Post-merge live checks) is the gate.
4. **`useAddedLastDay` keeps the spec's literal shape.** The selector returns an array of `JSON.stringify([id, source])` strings. The `shallowEqual` snapshot cache compares strings element by element, so it hands back the previous array while the pairs are unchanged. `addedBySource` keeps its signature.
5. **"useAddedLastDay's consumer does not re-render"** is tested with a probe component that calls only `useAddedLastDay`. Its real consumer is `HomeBody`, which must re-render on a `docCount` push because it shows the counts. The test also pins that the returned Map keeps its identity, so `HomeKpis` and `HomeSources` get the same `added` prop.
6. **Packaged maps are gated package-wide.** Core's `build.files` covers `app.asar` only. Bundled extensions reach `Resources/bundled-extensions` through `inject.mjs`'s `extraResources`, and staging installs their production `node_modules`, which include maps (for example `@chainsafe/libp2p-yamux`). So `inject.mjs` (it owns that copy; `build-extensions.mjs` only stages) adds `!**/*.map` to both extension `extraResources` filters. `verify-package.mjs`, which `package-product.mjs` already runs after every package, gains `assertNoSourceMaps`: it walks the whole app bundle (`.app`, or the unpacked dir) and lists `app.asar`, failing on any `*.map`. The real package run happens in the release build root (`~/work/ac-prod-build`), never in a worktree (see the Global Constraints on `npm ci`).
7. **Screen sizes** come from a webpack-bundle-analyzer `json` report over the same build: the minified parsed size of each `src/renderer/screens/<Name>/` folder. They are recorded in this file (Task 11). A screen over 50 KB with no eager importers is reported to the founder, not split ad hoc.
8. **HowToSort "Show more"** does not reset on a new Try, matching `ParkedPile` and `PutBack`.
9. **`useNow` "real consumers" in core** means core's Outbox (`useNow(30_000)`) plus a minimal consumer in the hook test. Overlay consumers (Home, RecorderWidget) are mounted in Part 2.
10. **`reconcile` lives in its own file**, `renderer/state/reconcile.ts`, which `app-state.ts` imports. It checks for plain objects in a cross-realm way. `node:v8` clones made in the jest jsdom realm carry the outer realm's `Object.prototype`, and a `=== Object.prototype` check would silently disable sharing in tests.

## Review Focus

1. **A key disappears from a pushed object**, for example `progress` dropped when a backfill ends. Expected: the reconciled object has no such key, and its reference is new. Pinned in Task 1.
2. **An account is removed, or the accounts reorder.** Expected: index-wise reconciliation still yields exactly the pushed list, kept entries keep their identity, and the Sidebar's counts follow. Pinned in Task 1 (removal and reorder) and Task 7 (status change).
3. **The window is hidden when a consumer mounts** (app started to the tray, or the window minimised before Home opens). Expected: no ticks until the window becomes visible, then one immediate catch-up. Pinned in Task 3 (`useNow`, StrictMode) and Task 9 (Home poll).
4. **A consumer unmounts, or recording ends, while hidden.** Expected: no interval or `visibilitychange` listener leaks, and nothing ticks after it becomes visible again. Pinned in Task 3 (`everyWhileVisible` stop) and Task 9 (recorder).
5. **Exactly 200 versus 201 Sorted folders.** Expected: 200 shows everything with no button, and 201 shows 200 plus "Show more · 1 not shown". The header still counts all folders and files. Pinned in Task 13.

---

# Part 1 — core (`~/work/kcore-ui`, branch `opt/ui`)

### Task 1: Structural sharing across pushes (spec A)

**Files:**
- Create: `~/work/kcore-ui/src/renderer/state/reconcile.ts`
- Create: `~/work/kcore-ui/src/renderer/state/__tests__/reconcile.test.ts`
- Modify: `~/work/kcore-ui/src/renderer/state/app-state.ts` (`apply`, lines 40–47; import block, lines 1–2)
- Test: `~/work/kcore-ui/src/renderer/state/__tests__/app-state.test.ts` (append a `describe`)

**Interfaces:**
- Produces: `export function reconcile<T>(prev: unknown, next: T): T` in `@renderer/state/reconcile`. It returns `prev` (typed as `T`) when deeply equal, and otherwise `next`'s shape with every deeply equal sub-tree replaced by `prev`'s reference.
- Produces: `apply()` semantics. `lastRev` always advances. A structurally equal push changes nothing and notifies nobody.

- [ ] **Step 1: Write the failing reconcile tests**

`src/renderer/state/__tests__/reconcile.test.ts`:

```ts
import { deserialize, serialize } from 'node:v8';
import { reconcile } from '../reconcile';

/** What IPC does to every push. jest 29 / jsdom 20 has no structuredClone. */
const clone = <T>(v: T): T => deserialize(serialize(v)) as T;

const base = () => ({
  identity: { name: 'Alice', emails: ['a@example.com'] },
  accounts: [
    { account: { id: 'a', status: 'live' }, docCount: 1, recent: [{ id: 'x' }] },
    {
      account: { id: 'b', status: 'backfilling' },
      docCount: 2,
      progress: { done: 5 },
      recent: [],
    },
  ],
  extensions: [{ id: 'ext.a', ui: [] }],
  ready: true,
});

test('a structurally equal clone returns prev itself', () => {
  const prev = base();
  expect(reconcile(prev, clone(prev))).toBe(prev);
});

test('a changed leaf gives new references on its path only', () => {
  const prev = base();
  const next = clone(prev);
  next.accounts[1].docCount = 3;
  const out = reconcile(prev, next);
  expect(out).not.toBe(prev);
  expect(out.accounts).not.toBe(prev.accounts);
  expect(out.accounts[1]).not.toBe(prev.accounts[1]);
  expect(out.accounts[1].docCount).toBe(3);
  expect(out.accounts[0]).toBe(prev.accounts[0]);
  expect(out.accounts[1].account).toBe(prev.accounts[1].account);
  expect(out.accounts[1].recent).toBe(prev.accounts[1].recent);
  expect(out.identity).toBe(prev.identity);
  expect(out.extensions).toBe(prev.extensions);
  expect(out).toEqual(next);
});

test('a key that disappears is gone from the result', () => {
  const prev = base();
  const next = clone(prev) as ReturnType<typeof base>;
  delete (next.accounts[1] as { progress?: unknown }).progress;
  const out = reconcile(prev, next);
  expect(out.accounts[1]).not.toBe(prev.accounts[1]);
  expect('progress' in out.accounts[1]).toBe(false);
  expect(out.accounts[1].account).toBe(prev.accounts[1].account);
  expect(out).toEqual(next);
});

test('an added key gives a new object that keeps the old values', () => {
  const prev = base();
  const next = clone(prev) as ReturnType<typeof base> & { extra?: number };
  next.extra = 1;
  const out = reconcile(prev, next);
  expect(out).not.toBe(prev);
  expect(out.accounts).toBe(prev.accounts);
  expect(out).toEqual(next);
});

test('a removed account shortens the list and keeps the survivors', () => {
  const prev = base();
  const next = clone(prev);
  next.accounts = next.accounts.slice(0, 1);
  const out = reconcile(prev, next);
  expect(out.accounts).not.toBe(prev.accounts);
  expect(out.accounts).toHaveLength(1);
  expect(out.accounts[0]).toBe(prev.accounts[0]);
});

test('a reorder yields exactly the pushed order', () => {
  const prev = base();
  const next = clone(prev);
  next.accounts.reverse();
  const out = reconcile(prev, next);
  expect(out.accounts.map((a) => a.account.id)).toEqual(['b', 'a']);
  expect(out).toEqual(next);
});

test('null and primitives: equal keeps prev, different takes next', () => {
  expect(reconcile(null, { a: 1 })).toEqual({ a: 1 });
  expect(reconcile({ a: 1 }, null)).toBeNull();
  expect(reconcile(NaN, NaN)).toBeNaN();
  expect(reconcile([1, 2], [1, 2, 3])).toEqual([1, 2, 3]);
  const arr = [1, 2];
  expect(reconcile(arr, [1, 2])).toBe(arr);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/work/kcore-ui && npx jest src/renderer/state/__tests__/reconcile.test.ts`
Expected: FAIL, "Cannot find module '../reconcile'".

- [ ] **Step 3: Implement `reconcile`**

`src/renderer/state/reconcile.ts`:

```ts
/**
 * Structural sharing for the app-state push (spec 2026-10-09 renderer perf, A).
 *
 * IPC structured-clones every `push:app-state`, so the renderer receives
 * fresh references for everything even when main kept them stable. This
 * walks the new snapshot against the previous one and keeps the previous
 * reference for every deeply equal value — arrays by index, objects by key —
 * so shallow-equal selectors bail out and an unchanged push is a no-op.
 *
 * JSON-shaped data only (what the projection carries). "Plain object" is
 * checked cross-realm: a clone made in another realm has that realm's
 * Object.prototype, so `proto === Object.prototype` would reject it.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || Object.getPrototypeOf(proto) === null;
}

export function reconcile<T>(prev: unknown, next: T): T {
  if (Object.is(prev, next)) return prev as T;
  if (Array.isArray(prev) && Array.isArray(next)) {
    let same = prev.length === next.length;
    const out = next.map((item: unknown, i: number) => {
      const kept = i < prev.length ? reconcile(prev[i], item) : item;
      if (i >= prev.length || kept !== prev[i]) same = false;
      return kept;
    });
    return (same ? prev : out) as T;
  }
  if (isPlainObject(prev) && isPlainObject(next)) {
    const nextKeys = Object.keys(next);
    let same = nextKeys.length === Object.keys(prev).length;
    const out: Record<string, unknown> = {};
    for (const key of nextKeys) {
      const has = Object.prototype.hasOwnProperty.call(prev, key);
      const kept = has ? reconcile(prev[key], next[key]) : next[key];
      if (!has || kept !== prev[key]) same = false;
      out[key] = kept;
    }
    return (same ? prev : out) as T;
  }
  return next;
}
```

- [ ] **Step 4: Run the reconcile tests**

Run: `cd ~/work/kcore-ui && npx jest src/renderer/state/__tests__/reconcile.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Write the failing store tests**

Append to `src/renderer/state/__tests__/app-state.test.ts`. Reuse the file's `makeAppState`, `makeBridge` and `Bridge`, and add the import at the top of the file:

```ts
import { deserialize, serialize } from 'node:v8';
```

```ts
describe('app-state: structural sharing across cloned pushes', () => {
  const clone = <T>(v: T): T => deserialize(serialize(v)) as T;

  function richState(): AppState {
    const s = makeAppState();
    return {
      ...s,
      identity: { name: 'Alice', emails: ['a@example.com'], phones: [] },
      extensions: [
        { id: 'ext.a', name: 'A', status: 'activated', enabled: true },
      ] as unknown as AppState['extensions'],
      accounts: [
        {
          account: { id: 'a', source: 'gmail', status: 'live' },
          docCount: 1,
          recent: [{ id: 'x', title: null, ts: '2026-10-01T00:00:00Z' }],
        },
        {
          account: { id: 'b', source: 'slack', status: 'backfilling' },
          docCount: 2,
          recent: [],
        },
      ] as unknown as AppState['accounts'],
    };
  }

  test('fresh clones keep unchanged sub-trees; an equal push notifies no one; rev still advances', async () => {
    await jest.isolateModulesAsync(async () => {
      const bridge = makeBridge();
      let onPush: ((p: unknown) => void) | undefined;
      bridge.on.mockImplementation(
        (channel: string, fn: (p: unknown) => void) => {
          if (channel === 'push:app-state') onPush = fn;
          return () => {};
        },
      );
      const base = richState();
      bridge.invoke.mockResolvedValueOnce({
        state: clone(base),
        seq: 0,
        rev: 1,
      });
      (window as unknown as { kiagent: Bridge }).kiagent = bridge;

      // eslint-disable-next-line global-require
      const { subscribeAppState, getAppState } = require('../app-state');
      const listener = jest.fn();
      const unsubscribe = subscribeAppState(listener);
      await Promise.resolve();
      await Promise.resolve();
      const first = getAppState() as AppState;
      expect(first).toEqual(base);
      listener.mockClear();

      const next = clone(base);
      next.accounts[1].docCount = 3;
      onPush!({ state: clone(next), seq: 1, rev: 2 });
      const second = getAppState() as AppState;
      expect(listener).toHaveBeenCalledTimes(1);
      expect(second.accounts).not.toBe(first.accounts);
      expect(second.accounts[0]).toBe(first.accounts[0]);
      expect(second.accounts[1]).not.toBe(first.accounts[1]);
      expect(second.accounts[1].account).toBe(first.accounts[1].account);
      expect(second.identity).toBe(first.identity);
      expect(second.extensions).toBe(first.extensions);
      expect(second.prefs).toBe(first.prefs);
      expect(second.processing).toBe(first.processing);

      // Structurally equal push: no notify, same snapshot.
      onPush!({ state: clone(next), seq: 1, rev: 3 });
      expect(listener).toHaveBeenCalledTimes(1);
      expect(getAppState()).toBe(second);

      // The equal push advanced the rev: a replay of rev 3 is stale.
      const replay = clone(next);
      replay.accounts[0].docCount = 999;
      onPush!({ state: replay, seq: 1, rev: 3 });
      expect(getAppState()).toBe(second);
      // A late, lower rev carrying a real change is dropped too.
      onPush!({ state: clone(replay), seq: 1, rev: 2 });
      expect(getAppState()).toBe(second);
      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();
    });
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd ~/work/kcore-ui && npx jest src/renderer/state/__tests__/app-state.test.ts`
Expected: FAIL. The new test fails at `expect(second.accounts[0]).toBe(first.accounts[0])` because `apply` stores the clone as is. The three existing tests pass.

- [ ] **Step 7: Reconcile in `apply`**

In `src/renderer/state/app-state.ts`, add `import { reconcile } from './reconcile';` after the `@shared/contracts` import. Then replace `apply`:

```ts
function apply(nextState: AppState, rev: number): void {
  // Guard on the broadcast counter, NOT the feed seq: non-feed slices
  // (identity, prefs, processing) re-push with the same seq but a higher rev.
  if (lastRev !== null && rev <= lastRev) return; // stale/out-of-order push
  lastRev = rev;
  // IPC structured-clones every push, so nothing in `nextState` is
  // reference-equal to the current snapshot even where nothing changed.
  // Reconciling restores sharing: unchanged sub-trees keep their previous
  // reference (shallow-equal selectors bail out), and a push equal to the
  // current snapshot is a no-op that notifies no one.
  const reconciled = reconcile(state, nextState);
  if (reconciled === state) return;
  state = reconciled;
  notify();
}
```

- [ ] **Step 8: Run both test files**

Run: `cd ~/work/kcore-ui && npx jest src/renderer/state/__tests__/app-state.test.ts src/renderer/state/__tests__/reconcile.test.ts`
Expected: PASS.

- [ ] **Step 9: Lint and commit**

Run: `cd ~/work/kcore-ui && npx eslint src/renderer/state/reconcile.ts src/renderer/state/app-state.ts src/renderer/state/__tests__/reconcile.test.ts src/renderer/state/__tests__/app-state.test.ts`
Expected: no errors.

```bash
cd ~/work/kcore-ui
printf '%s\n' 'perf(renderer): reconcile app-state pushes for structural sharing' '' 'IPC clones every push, so every selector saw new references. apply()' 'now keeps the previous reference for every deeply equal sub-tree and' 'skips the notify for a structurally equal push (#142).' > $S/msg-1.txt
git add src/renderer/state/reconcile.ts src/renderer/state/__tests__/reconcile.test.ts
git commit -F $S/msg-1.txt -- src/renderer/state/reconcile.ts src/renderer/state/__tests__/reconcile.test.ts src/renderer/state/app-state.ts src/renderer/state/__tests__/app-state.test.ts
```

### Task 2: `useAppGate` and the core App shell (spec B-core)

**Files:**
- Modify: `~/work/kcore-ui/src/renderer/state/app-state.ts` (doc comment on `subscribeAppState`/`getAppState`, lines 124–129; `useAppState`, lines 160–190)
- Modify: `~/work/kcore-ui/src/renderer/App.tsx` (imports, lines 1–2 and 13; component, lines 53–92)
- Modify: `~/work/kcore-ui/src/renderer/__tests__/App.test.tsx` (mock, lines 9–13)
- Create: `~/work/kcore-ui/src/renderer/__tests__/App.render-count.test.tsx`

**Interfaces:**
- Consumes: Task 1's reconcile in `apply`.
- Produces: `export function useAppGate<T>(select: (s: AppState | null) => T): T`, which has the same `shallowEqual` snapshot cache as `useAppState`. `useAppState<T>(selector: (s: AppState) => T): T` is unchanged. Overlay tests in Task 6 mock `useAppGate` by this name.

- [ ] **Step 1: Write the failing render-count test**

`src/renderer/__tests__/App.render-count.test.tsx`:

```tsx
import '@testing-library/jest-dom';
import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { deserialize, serialize } from 'node:v8';
import type { AppState } from '@shared/contracts';
import App from '../App';

// The sidebar element is created in App's render and nowhere else, so its
// render count is the shell's render count.
let mockSidebarRenders = 0;
jest.mock('@renderer/components/Sidebar', () => ({
  Sidebar: () => {
    mockSidebarRenders += 1;
    return null;
  },
}));
jest.mock('@renderer/screen-registry', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  return {
    createScreenRegistry: () => ({
      get: () => R.createElement('div', { 'data-testid': 'screen' }),
      frame: () => 'page',
    }),
    getDefaultScreens: () => ({}),
  };
});
jest.mock('@renderer/components/TitleBar', () => ({ TitleBar: () => null }));
jest.mock('@renderer/components/BootSplash', () => ({
  BootSplash: () => null,
}));
jest.mock('@renderer/screens/SignIn', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  return { SignIn: () => R.createElement('div', { 'data-testid': 'sign-in' }) };
});

/** What IPC does to every push. jest 29 / jsdom 20 has no structuredClone. */
const clone = <T,>(v: T): T => deserialize(serialize(v)) as T;

function baseState(): AppState {
  return {
    accounts: [
      { account: { id: 'a', source: 'gmail', status: 'live' }, docCount: 1, recent: [] },
      { account: { id: 'b', source: 'slack', status: 'backfilling' }, docCount: 2, recent: [] },
    ],
    extensions: [{ id: 'ext.a', name: 'A', status: 'activated', enabled: true, ui: [] }],
    mcp: { port: 7421, clients: 0 },
    identity: { name: 'Alice', emails: ['alice@example.com'], phones: [] },
    prefs: { features: {}, onboarding: {} },
    processing: { pending: 0, done: 0, skipped: 0, failed: 0 },
    ready: true,
  } as unknown as AppState;
}

let pushListener: ((payload: unknown) => void) | null = null;

function installBridge(initial: AppState): void {
  pushListener = null;
  (window as unknown as { kiagent: unknown }).kiagent = {
    invoke: jest.fn((channel: string) =>
      channel === 'app:get-state'
        ? Promise.resolve({ state: clone(initial), seq: 0, rev: 1 })
        : Promise.resolve([]),
    ),
    on: jest.fn((channel: string, fn: (payload: unknown) => void) => {
      if (channel === 'push:app-state') pushListener = fn;
      return () => {
        if (pushListener === fn) pushListener = null;
      };
    }),
  };
}

function push(state: AppState, rev: number): void {
  act(() => pushListener?.({ state: clone(state), seq: rev, rev }));
}

async function mountLoaded(base: AppState): Promise<void> {
  installBridge(base);
  render(<App />);
  await act(async () => {});
  await act(async () => {});
  expect(screen.getByTestId('screen')).toBeInTheDocument();
  mockSidebarRenders = 0;
}

afterEach(() => {
  delete (window as unknown as { kiagent?: unknown }).kiagent;
});

test('a docCount-only push does not re-render the shell', async () => {
  const base = baseState();
  await mountLoaded(base);
  const next = clone(base);
  next.accounts[1].docCount = 3;
  push(next, 2);
  expect(mockSidebarRenders).toBe(0);
});

test('a push that changes the extension list re-renders the shell once', async () => {
  const base = baseState();
  await mountLoaded(base);
  const next = clone(base);
  next.extensions = [
    ...next.extensions,
    { id: 'ext.b', name: 'B', status: 'activated', enabled: true, ui: [] },
  ] as unknown as AppState['extensions'];
  push(next, 2);
  expect(mockSidebarRenders).toBe(1);
});

test('signing out still reaches the sign-in gate', async () => {
  const base = baseState();
  await mountLoaded(base);
  push({ ...clone(base), identity: null } as AppState, 2);
  expect(screen.getByTestId('sign-in')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/work/kcore-ui && npx jest src/renderer/__tests__/App.render-count.test.tsx`
Expected: FAIL. The first test gets `mockSidebarRenders === 1`, because App subscribes to the whole state through raw `useSyncExternalStore`. The other two pass.

- [ ] **Step 3: Add `useAppGate`**

In `src/renderer/state/app-state.ts`:

(a) Replace the doc comment above `subscribeAppState`:

```ts
/**
 * Raw subscription primitives, for non-React callers and tests. React code
 * uses `useAppState` (inside the loaded tree) or `useAppGate` (the App
 * shells' loading/sign-in gates, which must see the `null` not-yet-loaded
 * moment).
 */
```

(b) Replace everything from the `useAppState` doc comment through the end of the file with:

```ts
// The cache is load-bearing: useSyncExternalStore calls getSnapshot more
// than once per render and React 19 throws ("The result of getSnapshot
// should be cached") if a fresh-but-equal object comes back.
function useSelected<T>(selector: (s: AppState | null) => T): T {
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const cacheRef = useRef<{ has: boolean; value: T }>({
    has: false,
    value: undefined as unknown as T,
  });
  const getSnapshot = useCallback((): T => {
    const next = selectorRef.current(state);
    const cache = cacheRef.current;
    if (cache.has && shallowEqual(cache.value, next)) return cache.value;
    cacheRef.current = { has: true, value: next };
    return next;
  }, []);
  return useSyncExternalStore(subscribeAppState, getSnapshot);
}

/**
 * The primary consumption API. Selectors run against the loaded `AppState`
 * — components using this hook must only ever mount inside the tree gated
 * on `state !== null` by the App shell (`useAppGate`).
 *
 * Re-renders are skipped when the selected value is shallow-equal to the
 * previous one, so returning a fresh object each call (e.g.
 * `s => ({ live: s.accounts.length })`) is safe and still cheap. Pushes are
 * reconciled against the previous snapshot (see `apply`), so an unchanged
 * sub-tree such as `s.identity`, `s.extensions` or an untouched account
 * keeps its reference across pushes and selecting it directly bails out too.
 * Never select a value built of fresh arrays/objects nested below the top
 * level: the one-level cache misses on every call.
 */
export function useAppState<T>(selector: (s: AppState) => T): T {
  // Safe per the invariant documented above.
  return useSelected(selector as (s: AppState | null) => T);
}

/**
 * The App shells' gate selector: like `useAppState`, but the selector also
 * sees the `null` not-yet-loaded state. Select only what the shell renders
 * on (loaded, signed in, the extension list), so a feed push that changes
 * none of it does not re-render the shell.
 */
export function useAppGate<T>(select: (s: AppState | null) => T): T {
  return useSelected(select);
}
```

- [ ] **Step 4: Gate the core App on what it renders**

In `src/renderer/App.tsx`:

(a) Replace lines 1–2 with:

```tsx
import React from 'react';
import { useAppGate } from '@renderer/state/app-state';
```

(b) After the `GATE_STYLE` constant, add:

```tsx
const NO_EXTENSIONS: AppState['extensions'] = [];

/** What the shell renders on. A feed push that changes only counts or
 *  recent items leaves every field equal (pushes are reconciled, so
 *  `extensions` keeps its reference), and the shell does not re-render. */
function selectShellGate(s: AppState | null) {
  return {
    loaded: s !== null,
    signedIn: s !== null && s.identity !== null,
    extensions: s?.extensions ?? NO_EXTENSIONS,
  };
}
```

(c) In `App()`, replace the comment and the `const state = useSyncExternalStore(...)` line with:

```tsx
  const gate = useAppGate(selectShellGate);
```

Replace `if (state === null) {` with `if (!gate.loaded) {`, and `if (state.identity === null) {` with `if (!gate.signedIn) {`. Replace the two `state.extensions` uses:

```tsx
  const screen = screenRegistry.get(view, params, navigate, gate.extensions);
  const frame = screenRegistry.frame(view);
  const title = viewTitle(view, gate.extensions);
```

- [ ] **Step 5: Teach the existing App test's mock the new hook**

In `src/renderer/__tests__/App.test.tsx`, replace the `jest.mock('@renderer/state/app-state', …)` block with:

```tsx
jest.mock('@renderer/state/app-state', () => ({
  subscribeAppState: () => () => {},
  getAppState: () => mockState,
  useAppState: (sel: (s: unknown) => unknown) => sel(mockState),
  useAppGate: (sel: (s: unknown) => unknown) => sel(mockState),
}));
```

- [ ] **Step 6: Run the App tests and the store tests**

Run: `cd ~/work/kcore-ui && npx jest src/renderer/__tests__/App.render-count.test.tsx src/renderer/__tests__/App.test.tsx src/renderer/state/__tests__/app-state.test.ts`
Expected: PASS.

- [ ] **Step 7: Lint and commit**

Run: `cd ~/work/kcore-ui && npx eslint src/renderer/state/app-state.ts src/renderer/App.tsx src/renderer/__tests__/App.test.tsx src/renderer/__tests__/App.render-count.test.tsx`
Expected: no errors.

```bash
cd ~/work/kcore-ui
printf '%s\n' 'perf(renderer): App shell selects only what it gates on' '' 'useAppGate: the null-aware sibling of useAppState with the same' 'shallow-equal cache. App renders on {loaded, signedIn, extensions}, so a' 'feed push no longer re-renders the shell (#142).' > $S/msg-2.txt
git add src/renderer/__tests__/App.render-count.test.tsx
git commit -F $S/msg-2.txt -- src/renderer/state/app-state.ts src/renderer/App.tsx src/renderer/__tests__/App.test.tsx src/renderer/__tests__/App.render-count.test.tsx
```

### Task 3: `useNow` pauses while hidden and shares one ticker (spec C1)

**Files:**
- Modify: `~/work/kcore-ui/src/shared/web-ui/ui/time.ts` (lines 1–3 import, 55–63 `useNow`)
- Modify: `~/work/kcore-ui/src/shared/web-ui/ui/index.ts` (the `./time` export block, lines 34–41)
- Create: `~/work/kcore-ui/src/shared/web-ui/ui/__tests__/time-visibility.test.tsx`
- Test: `~/work/kcore-ui/src/renderer/screens/Outbox/__tests__/Outbox.test.tsx` (append one test)

**Interfaces:**
- Produces: `export function everyWhileVisible(fn: () => void, ms: number): () => void` from `@shared/web-ui/ui`. It runs `fn` every `ms` while `document.visibilityState !== 'hidden'`. It stops while hidden, and on becoming visible it calls `fn` once immediately and resumes. It returns a stop function that also removes the listener. Part 2 Task 9 uses it for the Home poll and the recorder clock.
- Produces: `useNow(ms = 10_000): number` keeps its signature. Consumers with the same `ms` share one module-level interval.

- [ ] **Step 1: Write the failing hook tests**

`src/shared/web-ui/ui/__tests__/time-visibility.test.tsx`:

```tsx
import React, { Profiler } from 'react';
import { act, render } from '@testing-library/react';
import { everyWhileVisible, useNow } from '../time';

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

function Clock(): React.ReactElement {
  const now = useNow(10_000);
  return <span>{now}</span>;
}

const intervalsOf = (spy: jest.SpyInstance, ms: number) =>
  spy.mock.calls.filter((call) => call[1] === ms).length;

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  delete (document as unknown as { visibilityState?: unknown }).visibilityState;
});

test('everyWhileVisible ticks while visible, stops while hidden, catches up when shown', () => {
  const fn = jest.fn();
  const stop = everyWhileVisible(fn, 1000);
  jest.advanceTimersByTime(3000);
  expect(fn).toHaveBeenCalledTimes(3);
  setVisibility('hidden');
  jest.advanceTimersByTime(10_000);
  expect(fn).toHaveBeenCalledTimes(3);
  setVisibility('visible');
  expect(fn).toHaveBeenCalledTimes(4);
  jest.advanceTimersByTime(1000);
  expect(fn).toHaveBeenCalledTimes(5);
  stop();
  jest.advanceTimersByTime(5000);
  setVisibility('hidden');
  setVisibility('visible');
  expect(fn).toHaveBeenCalledTimes(5);
});

test('started hidden, nothing ticks until the window is shown', () => {
  setVisibility('hidden');
  const fn = jest.fn();
  const stop = everyWhileVisible(fn, 1000);
  jest.advanceTimersByTime(60_000);
  expect(fn).not.toHaveBeenCalled();
  setVisibility('visible');
  expect(fn).toHaveBeenCalledTimes(1);
  stop();
});

test('three useNow consumers share one interval; the last one out clears it', () => {
  const set = jest.spyOn(window, 'setInterval');
  const clear = jest.spyOn(window, 'clearInterval');
  const { unmount } = render(
    <>
      <Clock />
      <Clock />
      <Clock />
    </>,
  );
  expect(intervalsOf(set, 10_000)).toBe(1);
  unmount();
  expect(clear).toHaveBeenCalledTimes(1);
});

test('a useNow consumer commits nothing while hidden and once when shown', () => {
  // Relies on modern fake timers faking Date: the catch-up setNow gets a
  // new value only because Date.now() advanced. Do not switch to legacy.
  let commits = 0;
  render(
    <Profiler id="clock" onRender={() => { commits += 1; }}>
      <Clock />
    </Profiler>,
  );
  act(() => setVisibility('hidden'));
  commits = 0;
  act(() => {
    jest.advanceTimersByTime(5 * 60_000);
  });
  expect(commits).toBe(0);
  act(() => setVisibility('visible'));
  expect(commits).toBe(1);
});

test('mounted hidden under StrictMode: no interval until shown, then exactly one', () => {
  setVisibility('hidden');
  const set = jest.spyOn(window, 'setInterval');
  render(
    <React.StrictMode>
      <Clock />
    </React.StrictMode>,
  );
  expect(intervalsOf(set, 10_000)).toBe(0);
  act(() => setVisibility('visible'));
  expect(intervalsOf(set, 10_000)).toBe(1);
});
```

- [ ] **Step 2: Add the real-consumer test to Outbox**

Append to `src/renderer/screens/Outbox/__tests__/Outbox.test.tsx` (the file already fakes timers in `beforeEach` and has `ViewContext`, `SourceDescriptorsProvider`, `act`, `render` and `React` in scope):

```tsx
test('the relative-time clock does not tick while the window is hidden', async () => {
  // The file's beforeEach fakes Date too; the catch-up commit depends on it.
  const setVisibility = (state: 'visible' | 'hidden') => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => state,
    });
    document.dispatchEvent(new Event('visibilitychange'));
  };
  const nav = {
    view: 'outbox',
    params: {},
    navigate,
    back: () => {},
    openSettings: () => {},
    replaceParams,
  } as unknown as ViewContextValue;
  let commits = 0;
  try {
    render(
      <React.Profiler id="outbox" onRender={() => { commits += 1; }}>
        <ViewContext.Provider value={nav}>
          <SourceDescriptorsProvider>
            <Outbox />
          </SourceDescriptorsProvider>
        </ViewContext.Provider>
      </React.Profiler>,
    );
    await act(async () => {});
    act(() => setVisibility('hidden'));
    commits = 0;
    await act(async () => {
      jest.advanceTimersByTime(5 * 60_000);
    });
    expect(commits).toBe(0);
    act(() => setVisibility('visible'));
    expect(commits).toBe(1);
  } finally {
    delete (document as unknown as { visibilityState?: unknown })
      .visibilityState;
  }
});
```

- [ ] **Step 3: Run both to verify they fail**

Run: `cd ~/work/kcore-ui && npx jest src/shared/web-ui/ui/__tests__/time-visibility.test.tsx src/renderer/screens/Outbox/__tests__/Outbox.test.tsx`
Expected: time-visibility FAILS to compile because `everyWhileVisible` is not exported. The new Outbox test FAILS with `commits` 10 instead of 0, since the 30 s interval ran 10 times in 5 minutes.

- [ ] **Step 4: Implement**

In `src/shared/web-ui/ui/time.ts`, replace the `useNow` block (from `/** A clock for relative times` to the end of the file) with:

```ts
const isHidden = (): boolean =>
  typeof document !== 'undefined' && document.visibilityState === 'hidden';

/** Runs `fn` every `ms` while the window is visible. Hidden, it stops (a
 *  hidden window has nothing to repaint); on becoming visible again it runs
 *  `fn` at once, to catch up, and resumes. Returns the stop function. */
export function everyWhileVisible(fn: () => void, ms: number): () => void {
  let timer: number | undefined;
  const start = (): void => {
    if (timer === undefined) timer = window.setInterval(fn, ms);
  };
  const stop = (): void => {
    if (timer === undefined) return;
    window.clearInterval(timer);
    timer = undefined;
  };
  const onVisibility = (): void => {
    if (isHidden()) stop();
    else if (timer === undefined) {
      fn();
      start();
    }
  };
  if (!isHidden()) start();
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    stop();
    document.removeEventListener('visibilitychange', onVisibility);
  };
}

/** One ticker per interval, however many clocks read it. */
const nowTickers = new Map<
  number,
  { subscribers: Set<(now: number) => void>; stop: () => void }
>();

function subscribeNow(
  ms: number,
  subscriber: (now: number) => void,
): () => void {
  let ticker = nowTickers.get(ms);
  if (!ticker) {
    const subscribers = new Set<(now: number) => void>();
    const stop = everyWhileVisible(() => {
      const now = Date.now();
      subscribers.forEach((notify) => notify(now));
    }, ms);
    ticker = { subscribers, stop };
    nowTickers.set(ms, ticker);
  }
  const own = ticker;
  own.subscribers.add(subscriber);
  return () => {
    own.subscribers.delete(subscriber);
    if (own.subscribers.size > 0) return;
    own.stop();
    if (nowTickers.get(ms) === own) nowTickers.delete(ms);
  };
}

/** A clock for relative times, ticking every `ms` while the window is
 *  visible; it catches up the moment the window is shown again. */
export function useNow(ms = 10_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => subscribeNow(ms, setNow), [ms]);
  return now;
}
```

In `src/shared/web-ui/ui/index.ts`, add `everyWhileVisible,` to the `./time` export list after `useNow,`.

- [ ] **Step 5: Run the tests and the existing time tests**

Run: `cd ~/work/kcore-ui && npx jest src/shared/web-ui/ui/__tests__/time-visibility.test.tsx src/shared/web-ui/ui/__tests__/time.test.ts src/renderer/screens/Outbox/__tests__/Outbox.test.tsx`
Expected: PASS.

- [ ] **Step 6: Lint and commit**

Run: `cd ~/work/kcore-ui && npx eslint src/shared/web-ui/ui/time.ts src/shared/web-ui/ui/index.ts src/shared/web-ui/ui/__tests__/time-visibility.test.tsx src/renderer/screens/Outbox/__tests__/Outbox.test.tsx`
Expected: no errors.

```bash
cd ~/work/kcore-ui
printf '%s\n' 'perf(ui): useNow pauses while hidden and shares one ticker' '' 'everyWhileVisible runs a callback on an interval only while the window' 'is visible and catches up when it is shown. useNow builds one shared' 'ticker per interval on it (#142).' > $S/msg-3.txt
git add src/shared/web-ui/ui/__tests__/time-visibility.test.tsx
git commit -F $S/msg-3.txt -- src/shared/web-ui/ui/time.ts src/shared/web-ui/ui/index.ts src/shared/web-ui/ui/__tests__/time-visibility.test.tsx src/renderer/screens/Outbox/__tests__/Outbox.test.tsx
```

### Task 4: Source maps stay in the build, out of the package (spec E-core)

**Files:**
- Modify: `~/work/kcore-ui/package.json` (`build.files`, lines 303–307)
- Create: `~/work/kcore-ui/src/__tests__/package-files-no-maps.test.ts`

**Interfaces:**
- Produces: core `build.files` ends with `"!**/*.map"`. The product packages from the staged core's `package.json`, and `inject.mjs` never touches `build.files`, so this is the exclusion that reaches the product. Task 12 pins that.

- [ ] **Step 1: Write the failing test**

`src/__tests__/package-files-no-maps.test.ts`:

```ts
/** @jest-environment node */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const pkg = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
) as { build: { files: string[] } };

test('source maps are excluded from the packaged app', () => {
  const { files } = pkg.build;
  expect(files).toContain('!**/*.map');
  // electron-builder applies patterns in order: the exclusion follows the
  // includes it narrows.
  expect(files.indexOf('!**/*.map')).toBeGreaterThan(files.indexOf('dist'));
  expect(files.indexOf('!**/*.map')).toBeGreaterThan(
    files.indexOf('node_modules'),
  );
});

test('the prod builds still emit maps, for symbolicating crash logs', () => {
  for (const config of [
    'webpack.config.renderer.prod.ts',
    'webpack.config.main.prod.ts',
  ]) {
    expect(
      fs.readFileSync(path.join(ROOT, '.erb', 'configs', config), 'utf8'),
    ).toMatch(/devtool:\s*'source-map'/);
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd ~/work/kcore-ui && npx jest src/__tests__/package-files-no-maps.test.ts`
Expected: the first test FAILS (`files` lacks `!**/*.map`). The second passes.

- [ ] **Step 3: Exclude maps**

In `package.json` `build.files`:

```json
    "files": [
      "dist",
      "node_modules",
      "package.json",
      "!**/*.map"
    ],
```

- [ ] **Step 4: Run it**

Run: `cd ~/work/kcore-ui && npx jest src/__tests__/package-files-no-maps.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint and commit**

Run: `cd ~/work/kcore-ui && npx eslint src/__tests__/package-files-no-maps.test.ts`
Expected: no errors.

```bash
cd ~/work/kcore-ui
printf '%s\n' 'build: keep source maps out of the packaged app' '' 'devtool is unchanged, so dist keeps the maps that symbolicate crash' 'logs; electron-builder no longer packs them (#142).' > $S/msg-4.txt
git add src/__tests__/package-files-no-maps.test.ts
git commit -F $S/msg-4.txt -- package.json src/__tests__/package-files-no-maps.test.ts
```

### Task 5: Core gates and release hand-off

**Files:** none changed.

- [ ] **Step 1: Full core jest**

Run: `cd ~/work/kcore-ui && $H npx jest`
Expected: all suites pass. For any red suite, check whether it also fails on base `v0.106.0` (ask the orchestrator for the baseline list; never stash to find out). Fix every red suite this plan caused before going on.

- [ ] **Step 2: Typecheck**

Run: `cd ~/work/kcore-ui && $H npm run typecheck`
Expected: exit 0.

- [ ] **Step 3: Lint**

Run: `cd ~/work/kcore-ui && $H npm run lint`
Expected: exit 0.

- [ ] **Step 4: Hand off for release (founder-gated push)**

Report to the orchestrator: branch `opt/ui` at `git -C ~/work/kcore-ui rev-parse HEAD`, gates green. Core `dev` is checked out in another worktree, and other `opt/*` branches may release first. So the orchestrator merges `opt/ui` into core `dev` and runs `npm run release` (release-it: requires branch `dev` and a clean tree, bumps both package.json files, writes CHANGELOG, tags, pushes) from the worktree that has `dev`, **after founder approval of the push**. Record the resulting tag (expected `v0.107.0`, or later if other branches released first) and its peeled commit: `git -C ~/work/kcore-ui fetch origin --tags && git -C ~/work/kcore-ui rev-parse "<tag>^{commit}"`. Part 2 starts from that tag.

---

# Part 2 — overlay (`~/work/ac-ui`, branch `opt/ui`, after the core release)

### Task 6: Stage the released core and gate the overlay App shell (spec B, overlay App)

**Files:**
- Modify: `~/work/ac-ui/core.lock`
- Modify: `~/work/ac-ui/src/overlay/renderer/App.tsx` (imports, lines 4–15; `App()` body, lines 81–165)
- Modify: `~/work/ac-ui/build/shadow-baselines.json` (regenerated)
- Modify: `~/work/ac-ui/src/__tests__/app-title-b3.test.tsx` (mock, lines 19–22)
- Modify: `~/work/ac-ui/src/__tests__/home-app.test.tsx` (mock, lines 9–16)
- Modify: `~/work/ac-ui/src/__tests__/recorder-session.test.tsx` (mock, lines 16–19)
- Modify: `~/work/ac-ui/src/__tests__/overlay-settings-route.test.tsx` (mock, lines 8–11)
- Create: `~/work/ac-ui/src/__tests__/helpers/app-state-fixture.tsx`
- Create: `~/work/ac-ui/src/__tests__/app-render-count.test.tsx`

**Interfaces:**
- Consumes: core `useAppGate`, the reconcile in `apply`, and `everyWhileVisible`, all from the released core.
- Produces: test helpers in `src/__tests__/helpers/app-state-fixture.tsx`, which Tasks 7–8 use:
  - `clone<T>(v: T): T`
  - `accountEntry(id: string, source: string, status?: string, docCount?: number)`
  - `appStateFixture(over?: Partial<AppState>): AppState`
  - `withDocCount(state: AppState, index: number, docCount: number): AppState`
  - `getStateHandler(state: AppState): () => { state: AppState; seq: number; rev: number }`
  - `LoadedGate(props: { children: React.ReactNode }): React.ReactElement | null`

- [ ] **Step 1: Pin core and stage it**

```bash
cd ~/work/ac-ui
TAG=<tag from Task 5>
git -C ~/work/kcore-ui fetch origin --tags
COMMIT=$(git -C ~/work/kcore-ui rev-parse "$TAG^{commit}")
printf '{\n  "repo": "https://github.com/edjafarov/kiagent-core.git",\n  "tag": "%s",\n  "commit": "%s"\n}\n' "$TAG" "$COMMIT" > core.lock
node build/fetch-core.mjs
ln -sfn ~/work/alpha-cent/release/app/dist release/app/dist
ln -sfn ~/work/alpha-cent/build/.core/node_modules build/.core/node_modules
for e in assistant documents meetings remote-mcp; do ln -sfn ~/work/alpha-cent/extensions/$e/node_modules extensions/$e/node_modules; done
grep -n "useAppGate\|everyWhileVisible" build/.core/src/renderer/state/app-state.ts build/.core/src/shared/web-ui/ui/time.ts
```

Expected:
- fetch-core logs "core ready … proprietary overlay applied (fresh-clone path)".
- The grep shows both `useAppGate` and `everyWhileVisible`.
- All the symlinks are gitignored, and `git status --short` shows only `core.lock`.
- If the clone fails with 403, look for the stale osxkeychain gitconfig trap (memory `unified-folder-selection`). Never change `core.lock`'s `repo`.

**Teardown (before any `git worktree remove ~/work/ac-ui`):** `rm` each symlink by explicit path first: `release/app/dist`, `build/.core/node_modules` and the four `extensions/*/node_modules`. Unlink `build/.core/node_modules` before any later core.lock change that makes fetch-core re-clone.

- [ ] **Step 2: Review what core changed in shadowed files**

```bash
cd ~/work/ac-ui
node -e "import('./build/apply-overlay.mjs').then(m => console.log(m.listReplacingShadows().map(p => 'src/' + p).join('\n')))" > $S/shadowed.txt
git -C ~/work/kcore-ui diff --stat v0.106.0 "$TAG" -- $(cat $S/shadowed.txt)
```

Expected: only `src/renderer/App.tsx` changed (Part 1 Task 2). If other files changed (another branch released in between), port their deltas into the matching `src/overlay/` shadow in this task and list them in the commit message.

- [ ] **Step 3: Create the shared fixture helpers**

`src/__tests__/helpers/app-state-fixture.tsx`:

```tsx
import React from 'react';
import { deserialize, serialize } from 'node:v8';
import type { AppState } from '@shared/contracts';
import { useAppGate } from '@renderer/state/app-state';

/** What IPC does to every push: a structured clone. jest 29 / jsdom 20 has
 *  no global structuredClone, so node:v8's serializer stands in. */
export function clone<T>(value: T): T {
  return deserialize(serialize(value)) as T;
}

export function accountEntry(
  id: string,
  source: string,
  status = 'live',
  docCount = 10,
) {
  return {
    account: {
      id,
      source,
      identifier: `${id}@example.com`,
      config: {},
      status,
      cursor: null,
      createdAt: '2026-01-01',
      lastSyncAt: '2026-09-22T09:00:00Z',
    },
    docCount,
    recent: [{ id: `${id}-doc`, title: null, ts: '2026-09-24T11:40:00Z' }],
  };
}

export function appStateFixture(over: Partial<AppState> = {}): AppState {
  return {
    accounts: [
      accountEntry('g', 'gmail'),
      accountEntry('s', 'slack', 'live', 60_819),
    ],
    processing: {
      pending: 0,
      done: 0,
      skipped: 0,
      failed: 0,
      lane: 'open',
      waiting: null,
      active: [],
      download: null,
    },
    mcp: { port: 7421, clients: 0 },
    identity: { name: 'Alice', emails: ['alice@example.com'], phones: [] },
    prefs: {
      theme: 'system',
      logLevel: 'info',
      launchAtLogin: false,
      showInMenuBar: false,
      processing: { enabled: false, window: 'always' },
      models: { override: 'auto', autoInstall: false },
      outbound: { defaultMode: 'review' },
      features: {},
      onboarding: {
        sourceBackfilledAt: null,
        mcpConnectedAt: null,
        firstQueryAt: null,
        dismissedAt: null,
      },
    },
    extensions: [
      {
        id: 'ext.fixture',
        name: 'Fixture',
        status: 'activated',
        enabled: true,
        sourceIds: [],
        ui: [],
      },
    ],
    ready: true,
    ...over,
  } as unknown as AppState;
}

/** A docCount-only change to account `index`: what a backfill pushes. */
export function withDocCount(
  state: AppState,
  index: number,
  docCount: number,
): AppState {
  const next = clone(state);
  next.accounts[index].docCount = docCount;
  return next;
}

/** The `app:get-state` handler for installFakeBridge: a fresh clone at rev 1. */
export function getStateHandler(state: AppState) {
  return () => ({ state: clone(state), seq: 0, rev: 1 });
}

/** Mounts children once the real store has loaded, as the App shell does:
 *  `useAppState` consumers must never see the null not-yet-loaded state. */
export function LoadedGate(props: {
  children: React.ReactNode;
}): React.ReactElement | null {
  const loaded = useAppGate((s) => s !== null);
  return loaded ? <>{props.children}</> : null;
}
```

- [ ] **Step 4: Write the failing App render-count test**

`src/__tests__/app-render-count.test.tsx`:

```tsx
import React from 'react';
import '@testing-library/jest-dom';
import { act, render, screen } from '@testing-library/react';
import App from '../overlay/renderer/App';
import { installFakeBridge, removeFakeBridge } from './helpers/fake-bridge';
import {
  appStateFixture,
  clone,
  getStateHandler,
  withDocCount,
} from './helpers/app-state-fixture';

// The sidebar element is created in App's render and nowhere else, so its
// render count is the shell's render count.
let mockSidebarRenders = 0;
jest.mock('@renderer/components/Sidebar', () => ({
  Sidebar: () => {
    mockSidebarRenders += 1;
    return null;
  },
}));
jest.mock('@renderer/screen-registry', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  return {
    createScreenRegistry: () => ({
      get: () => R.createElement('div', { 'data-testid': 'screen' }),
      frame: () => 'page',
    }),
    getDefaultScreens: () => ({}),
  };
});
jest.mock('@renderer/components/TitleBar', () => ({ TitleBar: () => null }));
jest.mock('@renderer/components/BootSplash', () => ({
  BootSplash: () => <div data-testid="boot-splash" />,
}));
jest.mock('@renderer/screens/SignIn', () => ({
  SignIn: () => <div data-testid="sign-in" />,
}));
jest.mock('../overlay/renderer/components/Recorder/recorder-store', () => ({
  recorderStore: { resetSession: jest.fn() },
}));
jest.mock('../overlay/renderer/screens/Sources', () => ({
  SOURCES_POLICY: { hidden: [], showGetStarted: false },
}));

const base = appStateFixture();

async function mountLoaded() {
  const bridge = installFakeBridge({
    'app:get-state': getStateHandler(base),
    'sources:list': () => [],
  });
  render(<App />);
  for (let i = 0; i < 3; i += 1) await act(async () => {});
  expect(screen.getByTestId('screen')).toBeInTheDocument();
  mockSidebarRenders = 0;
  return bridge;
}

afterEach(() => removeFakeBridge());

test('a docCount-only push re-renders neither the shell nor the sidebar', async () => {
  const bridge = await mountLoaded();
  act(() =>
    bridge.push('push:app-state', {
      state: clone(withDocCount(base, 1, 60_900)),
      seq: 1,
      rev: 2,
    }),
  );
  expect(mockSidebarRenders).toBe(0);
});

test('a push that changes the extension list re-renders the shell once', async () => {
  const bridge = await mountLoaded();
  const next = clone(base);
  next.extensions = [
    ...next.extensions,
    { ...next.extensions[0], id: 'ext.other' },
  ];
  act(() => bridge.push('push:app-state', { state: next, seq: 1, rev: 2 }));
  expect(mockSidebarRenders).toBe(1);
});

test('signing out still reaches the sign-in gate', async () => {
  const bridge = await mountLoaded();
  act(() =>
    bridge.push('push:app-state', {
      state: { ...clone(base), identity: null },
      seq: 1,
      rev: 2,
    }),
  );
  expect(screen.getByTestId('sign-in')).toBeInTheDocument();
});
```

Run: `cd ~/work/ac-ui && npx jest --config package.json src/__tests__/app-render-count.test.tsx`
Expected: the first test FAILS with `mockSidebarRenders` 1, because the overlay App still subscribes raw. The others pass.

- [ ] **Step 5: Gate the overlay App**

In `src/overlay/renderer/App.tsx`:

(a) Replace the React import block (lines 4–9) with:

```tsx
import React, { useEffect, useLayoutEffect, useRef } from 'react';
```

(b) Replace `import { subscribeAppState, getAppState } from '@renderer/state/app-state';` with `import { useAppGate } from '@renderer/state/app-state';`, and `import type { ExtensionSnapshot } from '@shared/contracts';` with `import type { AppState, ExtensionSnapshot } from '@shared/contracts';`.

(c) After `GATE_STYLE`, add:

```tsx
const NO_EXTENSIONS: readonly ExtensionSnapshot[] = [];

/** What the shell renders on. Selected rather than read raw: a feed push
 *  that changes only counts or recent items leaves every field here equal
 *  (pushes are reconciled, so `extensions` keeps its reference), so the
 *  shell, and with it the sidebar and the mounted screen, does not
 *  re-render. */
function selectShellGate(s: AppState | null) {
  return {
    loaded: s !== null,
    signedIn: s !== null && s.identity !== null,
    ready: s?.ready !== false,
    principal: s?.identity
      ? JSON.stringify([...s.identity.emails].sort())
      : null,
    extensions: s?.extensions ?? NO_EXTENSIONS,
  };
}
```

(d) In `App()`, replace the three-line comment, `const state = useSyncExternalStore(...)` and the `const principal = …` statement with:

```tsx
  const gate = useAppGate(selectShellGate);
  const { principal } = gate;
```

(e) Replace the gates and uses:
- `if (state === null) {` becomes `if (!gate.loaded) {`
- `if (state.identity === null) {` becomes `if (!gate.signedIn) {`
- `if (state.ready === false) {` becomes `if (!gate.ready) {`
- `screenRegistry.get(view, params, navigate, state.extensions)` becomes `screenRegistry.get(view, params, navigate, gate.extensions)`
- `routeTitle(view, state.extensions)` becomes `routeTitle(view, gate.extensions)`

- [ ] **Step 6: Teach the four existing App-test mocks `useAppGate`**

- `src/__tests__/app-title-b3.test.tsx`: add `useAppGate: (sel: (s: unknown) => unknown) => sel(null),` to the `@renderer/state/app-state` mock.
- `src/__tests__/recorder-session.test.tsx` and `src/__tests__/overlay-settings-route.test.tsx`: add `useAppGate: (sel: (s: unknown) => unknown) => sel(mockState),` to each mock.
- `src/__tests__/home-app.test.tsx` drives a re-render through `mockNotify`, so its mock must subscribe. Replace the mock with:

```tsx
jest.mock('@renderer/state/app-state', () => ({
  subscribeAppState: (listener: () => void) => {
    mockNotify = listener;
    return () => {};
  },
  getAppState: () => appState,
  useAppState: (selector: (state: unknown) => unknown) => selector(appState),
  // The real gate subscribes; this one re-renders when the test calls
  // mockNotify(), which is all the hydration test needs.
  useAppGate: (selector: (state: unknown) => unknown) => {
    const R = jest.requireActual<typeof import('react')>('react');
    const [, bump] = R.useReducer((n: number) => n + 1, 0);
    R.useLayoutEffect(() => {
      mockNotify = bump as () => void;
    }, []);
    return selector(appState);
  },
}));
```

- [ ] **Step 7: Regenerate the shadow baselines and run the App suites**

```bash
cd ~/work/ac-ui
node build/apply-overlay.mjs
node build/update-shadow-baselines.mjs
npx jest --config package.json src/__tests__/app-render-count.test.tsx src/__tests__/app-title-b3.test.tsx src/__tests__/home-app.test.tsx src/__tests__/recorder-session.test.tsx src/__tests__/overlay-settings-route.test.tsx src/__tests__/shadow-baselines.test.ts
```

Expected: all PASS, and `git diff build/shadow-baselines.json` shows `coreCommit` and the `src/renderer/App.tsx` hash changed (plus any file Step 2 found).

- [ ] **Step 8: Lint and commit**

Run: `cd ~/work/ac-ui && npx eslint --ext .ts,.tsx src/overlay/renderer/App.tsx src/__tests__/helpers/app-state-fixture.tsx src/__tests__/app-render-count.test.tsx src/__tests__/app-title-b3.test.tsx src/__tests__/home-app.test.tsx src/__tests__/recorder-session.test.tsx src/__tests__/overlay-settings-route.test.tsx`
Expected: no errors.

```bash
cd ~/work/ac-ui
printf '%s\n' "chore(core): pin kiagent-core $TAG (renderer perf); App shell selects its gate" '' 'The overlay App shadow ports core'"'"'s useAppGate: it renders on' '{loaded, signedIn, ready, principal, extensions}, so a feed push no' 'longer re-renders the shell or the sidebar (#271). Shadow baselines' 'regenerated after reviewing the core App.tsx delta.' > $S/msg-6.txt
git add src/__tests__/helpers/app-state-fixture.tsx src/__tests__/app-render-count.test.tsx
git commit -F $S/msg-6.txt -- core.lock build/shadow-baselines.json src/overlay/renderer/App.tsx src/__tests__/helpers/app-state-fixture.tsx src/__tests__/app-render-count.test.tsx src/__tests__/app-title-b3.test.tsx src/__tests__/home-app.test.tsx src/__tests__/recorder-session.test.tsx src/__tests__/overlay-settings-route.test.tsx
```

### Task 7: The overlay Sidebar selects the numbers it shows (spec B, Sidebar)

**Files:**
- Modify: `~/work/ac-ui/src/overlay/renderer/components/Sidebar.tsx` (line 8 import; lines 60–67)
- Create: `~/work/ac-ui/src/__tests__/sidebar-render-count.test.tsx`

**Interfaces:**
- Consumes: Task 6 helpers (`appStateFixture`, `clone`, `getStateHandler`, `withDocCount`, `LoadedGate`) and `installFakeBridge` from `src/__tests__/helpers/fake-bridge.ts`.

- [ ] **Step 1: Write the failing test**

`src/__tests__/sidebar-render-count.test.tsx`:

```tsx
import React, { Profiler } from 'react';
import '@testing-library/jest-dom';
import { act, render, screen } from '@testing-library/react';
import { Sidebar } from '../overlay/renderer/components/Sidebar';
import { installFakeBridge, removeFakeBridge } from './helpers/fake-bridge';
import {
  appStateFixture,
  clone,
  getStateHandler,
  LoadedGate,
  withDocCount,
} from './helpers/app-state-fixture';

const mockNavigate = jest.fn();
jest.mock('@renderer/state/view', () => ({
  useView: () => ({
    view: 'settings',
    navigate: mockNavigate,
    openSettings: jest.fn(),
  }),
}));
jest.mock('../overlay/renderer/components/Recorder/RecorderWidget', () => ({
  RecorderWidget: () => null,
}));
jest.mock('../overlay/renderer/components/LocalAi/LocalAiRow', () => ({
  LocalAiRow: () => null,
}));
jest.mock('@renderer/components/AccountRow', () => ({
  AccountRow: () => null,
}));
jest.mock('../overlay/renderer/components/use-remote-status', () => ({
  useRemoteStatus: () => null,
}));
const mockDocumentsFeed = { status: 'ready', settings: null, counts: null };
jest.mock('../overlay/renderer/state/documents-store', () => ({
  useDocumentsFeed: () => mockDocumentsFeed,
}));
jest.mock('../overlay/renderer/state/outbox-badge', () => ({
  useOutboxPendingCount: () => 0,
}));
jest.mock('../overlay/renderer/components/calendar-feature', () => ({
  useCalendarView: () => false,
  isLegacyCalendarPage: () => false,
}));

const base = appStateFixture();
let commits = 0;

async function mountSidebar() {
  const bridge = installFakeBridge({ 'app:get-state': getStateHandler(base) });
  render(
    <LoadedGate>
      <Profiler id="sidebar" onRender={() => { commits += 1; }}>
        <Sidebar />
      </Profiler>
    </LoadedGate>,
  );
  for (let i = 0; i < 5; i += 1) await act(async () => {});
  commits = 0;
  return bridge;
}

afterEach(() => removeFakeBridge());

test('a docCount-only push does not re-render the sidebar', async () => {
  const bridge = await mountSidebar();
  expect(screen.getByTitle('2 up to date')).toBeInTheDocument();
  act(() =>
    bridge.push('push:app-state', {
      state: clone(withDocCount(base, 1, 60_900)),
      seq: 1,
      rev: 2,
    }),
  );
  expect(commits).toBe(0);
});

test('a push that changes what the Sources row shows re-renders it', async () => {
  const bridge = await mountSidebar();
  const next = clone(base);
  next.accounts[0].account.status = 'error';
  act(() => bridge.push('push:app-state', { state: next, seq: 1, rev: 2 }));
  expect(commits).toBeGreaterThan(0);
  expect(screen.getByTitle('1 source needs attention')).toBeInTheDocument();
});
```

Run: `cd ~/work/ac-ui && npx jest --config package.json src/__tests__/sidebar-render-count.test.tsx`
Expected: the first test FAILS with `commits` 1, because Sidebar selects `s.accounts`. The second passes.

- [ ] **Step 2: Select the derived scalars**

In `src/overlay/renderer/components/Sidebar.tsx`, change line 8 to `import React, { useEffect, useRef, useState } from 'react';`. Then replace

```tsx
  // The same account health Home shows, so the two never disagree.
  const accounts = useAppState((s) => s.accounts);
  const mcpPort = useAppState((s) => s.mcp.port);
  const { needsYou, liveCount } = useMemo(
    () => selectHomeHealth({ accounts, ready: true } as AppState),
    [accounts],
  );
  const erroringCount = needsYou.length;
```

with

```tsx
  // The same account health Home shows, so the two never disagree. Only the
  // two numbers the Sources row shows are selected, so a push that changes
  // neither (a docCount, a recent item) never re-renders the sidebar.
  const { erroringCount, liveCount } = useAppState((s) => {
    const health = selectHomeHealth({
      accounts: s.accounts,
      ready: true,
    } as AppState);
    return {
      erroringCount: health.needsYou.length,
      liveCount: health.liveCount,
    };
  });
  const mcpPort = useAppState((s) => s.mcp.port);
```

- [ ] **Step 3: Run the new and existing sidebar suites**

```bash
cd ~/work/ac-ui
node build/apply-overlay.mjs
npx jest --config package.json src/__tests__/sidebar-render-count.test.tsx src/__tests__/overlay-sidebar.test.tsx src/__tests__/sidebar-calendar.test.tsx
```

Expected: PASS.

- [ ] **Step 4: Lint and commit**

Run: `cd ~/work/ac-ui && npx eslint --ext .ts,.tsx src/overlay/renderer/components/Sidebar.tsx src/__tests__/sidebar-render-count.test.tsx`
Expected: no errors.

```bash
cd ~/work/ac-ui
printf '%s\n' 'perf(sidebar): select the Sources numbers, not the account list' '' 'A feed push that changes no displayed number no longer re-renders the' 'sidebar (#271).' > $S/msg-7.txt
git add src/__tests__/sidebar-render-count.test.tsx
git commit -F $S/msg-7.txt -- src/overlay/renderer/components/Sidebar.tsx src/__tests__/sidebar-render-count.test.tsx
```

### Task 8: Home re-renders once per real change; the 24 h counts do not follow docCount (spec B, Home)

**Files:**
- Modify: `~/work/ac-ui/src/overlay/renderer/screens/Home/home-data.ts` (`useAddedLastDay`, lines 49–74)
- Create: `~/work/ac-ui/src/__tests__/home-render-count.test.tsx`

**Interfaces:**
- Consumes: Task 6 helpers.
- Produces: `useAddedLastDay(): ReadonlyMap<string, number>` (same signature). The Map keeps its identity across pushes that leave the `{id, source}` pairs and the 24 h rows unchanged. `useHomeHealth` is unchanged (spec B).

- [ ] **Step 1: Write the failing test**

`src/__tests__/home-render-count.test.tsx`:

```tsx
import React, { Profiler } from 'react';
import '@testing-library/jest-dom';
import { act, render } from '@testing-library/react';
import { SourceDescriptorsProvider } from '@renderer/screens/Sources/sources-registry';
import { Home } from '../overlay/renderer/screens/Home';
import { useAddedLastDay } from '../overlay/renderer/screens/Home/home-data';
import { resetHomeCache } from '../overlay/renderer/screens/Home/home-cache';
import { installFakeBridge, removeFakeBridge } from './helpers/fake-bridge';
import {
  appStateFixture,
  clone,
  getStateHandler,
  LoadedGate,
  withDocCount,
} from './helpers/app-state-fixture';

const mockNavigate = jest.fn();
jest.mock('@renderer/state/view', () => ({
  ...jest.requireActual('@renderer/state/view'),
  useView: () => ({ navigate: mockNavigate }),
}));

const base = appStateFixture();
let homeCommits = 0;
let probeRenders = 0;
let lastAdded: ReadonlyMap<string, number> | null = null;

/** useAddedLastDay alone, so its own re-renders are visible. */
function AddedProbe(): null {
  lastAdded = useAddedLastDay();
  probeRenders += 1;
  return null;
}

async function mountHome() {
  const bridge = installFakeBridge({
    'app:get-state': getStateHandler(base),
    'sources:list': () => [],
    'outbox:list': () => [],
    'attention:list': () => [],
    'storage:added-24h': () => [{ accountId: 's', count: 3 }],
  });
  render(
    <LoadedGate>
      <SourceDescriptorsProvider>
        <Profiler id="home" onRender={() => { homeCommits += 1; }}>
          <Home />
        </Profiler>
        <AddedProbe />
      </SourceDescriptorsProvider>
    </LoadedGate>,
  );
  // get-state, every first read, and their follow-up renders.
  for (let i = 0; i < 6; i += 1) await act(async () => {});
  homeCommits = 0;
  probeRenders = 0;
  return bridge;
}

beforeEach(() => {
  resetHomeCache();
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => removeFakeBridge());

test('a push equal to the current state re-renders nothing', async () => {
  const bridge = await mountHome();
  act(() =>
    bridge.push('push:app-state', { state: clone(base), seq: 1, rev: 2 }),
  );
  expect(homeCommits).toBe(0);
  expect(probeRenders).toBe(0);
});

test('a docCount-only push re-renders Home once and leaves the 24 h counts alone', async () => {
  const bridge = await mountHome();
  const before = lastAdded;
  expect(before?.get('slack')).toBe(3);
  act(() =>
    bridge.push('push:app-state', {
      state: clone(withDocCount(base, 1, 60_900)),
      seq: 1,
      rev: 2,
    }),
  );
  expect(homeCommits).toBe(1);
  expect(probeRenders).toBe(0);
  expect(lastAdded).toBe(before);
});
```

Run: `cd ~/work/ac-ui && npx jest --config package.json src/__tests__/home-render-count.test.tsx`
Expected: the first test passes (reconcile already makes an equal push a no-op). The second FAILS with `probeRenders` 1, because `useAddedLastDay` selects `s.accounts`. If `homeCommits` is above 1, find the extra commit (a state set in an effect that depends on `health`) before going on: the spec requires exactly one.

- [ ] **Step 2: Select only the `{id, source}` pairs**

In `src/overlay/renderer/screens/Home/home-data.ts`, replace `useAddedLastDay`:

```ts
/** Items added to memory in the last 24 hours, by source. */
export function useAddedLastDay(): ReadonlyMap<string, number> {
  // Only what addedBySource reads, as strings: the shallow-equal snapshot
  // cache compares them one by one and hands back the previous array while
  // the pairs are unchanged, so a docCount or recent-item push does not
  // re-render this hook's consumer. The counts come from the fetch below.
  const pairs = useAppState((state) =>
    (state?.accounts ?? NO_ACCOUNTS).map((entry) =>
      JSON.stringify([entry.account.id, entry.account.source]),
    ),
  );
  const accounts = useMemo(
    () =>
      pairs.map((pair) => {
        const [id, source] = JSON.parse(pair) as [string, string];
        return { account: { id, source } };
      }),
    [pairs],
  );
  const [rows, setRows] = useState<
    ReadonlyArray<{ accountId: string; count: number }>
  >([]);
  useEffect(() => {
    let active = true;
    const read = (): void => {
      window.kiagent
        .invoke('storage:added-24h', undefined)
        .then((result) => {
          if (active && Array.isArray(result)) setRows(result);
        })
        .catch(() => {});
    };
    read();
    const timer = setInterval(read, ADDED_REFRESH_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  return useMemo(() => addedBySource(accounts, rows), [accounts, rows]);
}
```

(The interval becomes visibility-gated in Task 9. This task changes only the selector.)

- [ ] **Step 3: Run the new and existing Home suites**

```bash
cd ~/work/ac-ui
node build/apply-overlay.mjs
npx jest --config package.json src/__tests__/home-render-count.test.tsx src/__tests__/home-page.test.tsx src/__tests__/home-cards.test.tsx src/__tests__/home-health-helpers.test.ts src/__tests__/home-view.test.tsx
```

Expected: PASS.

- [ ] **Step 4: Lint and commit**

Run: `cd ~/work/ac-ui && npx eslint --ext .ts,.tsx src/overlay/renderer/screens/Home/home-data.ts src/__tests__/home-render-count.test.tsx`
Expected: no errors.

```bash
cd ~/work/ac-ui
printf '%s\n' 'perf(home): 24 h counts select account ids and sources only' '' 'A docCount-only push re-renders Home once (it shows the counts) and no' 'longer re-renders useAddedLastDay or rebuilds its map (#271).' > $S/msg-8.txt
git add src/__tests__/home-render-count.test.tsx
git commit -F $S/msg-8.txt -- src/overlay/renderer/screens/Home/home-data.ts src/__tests__/home-render-count.test.tsx
```

### Task 9: Home poll and recorder clock pause while hidden (spec C2, C3)

**Files:**
- Modify: `~/work/ac-ui/src/overlay/renderer/screens/Home/home-data.ts` (the `useEffect` in `useAddedLastDay`; imports, line 6 region)
- Modify: `~/work/ac-ui/src/overlay/renderer/components/Recorder/RecorderWidget.tsx` (line 4 import; lines 37–41 effect)
- Create: `~/work/ac-ui/src/__tests__/home-hidden-refresh.test.tsx`
- Test: `~/work/ac-ui/src/__tests__/recorder-widget.test.tsx` (append tests inside `describe('RecorderWidget')`)

**Interfaces:**
- Consumes: core `everyWhileVisible(fn, ms): () => void` from `@shared/web-ui/ui`.

- [ ] **Step 1: Write the failing Home test (real Home, real core `useNow`)**

`src/__tests__/home-hidden-refresh.test.tsx`:

```tsx
import React, { Profiler } from 'react';
import '@testing-library/jest-dom';
import { act, render } from '@testing-library/react';
import { SourceDescriptorsProvider } from '@renderer/screens/Sources/sources-registry';
import { Home } from '../overlay/renderer/screens/Home';
import { resetHomeCache } from '../overlay/renderer/screens/Home/home-cache';
import { installFakeBridge, removeFakeBridge } from './helpers/fake-bridge';
import { accountEntry } from './helpers/app-state-fixture';

const mockNavigate = jest.fn();
jest.mock('@renderer/state/view', () => ({
  ...jest.requireActual('@renderer/state/view'),
  useView: () => ({ navigate: mockNavigate }),
}));

const mockState = {
  ready: true,
  identity: null,
  prefs: { features: {}, onboarding: {} },
  accounts: [accountEntry('s', 'slack')],
  extensions: [],
};
jest.mock('@renderer/state/app-state', () => ({
  useAppState: (selector: (s: unknown) => unknown) => selector(mockState),
}));

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
  resetHomeCache();
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  jest.useRealTimers();
  removeFakeBridge();
  delete (document as unknown as { visibilityState?: unknown }).visibilityState;
});

test('hidden, Home neither ticks nor polls; shown, it refetches at once', async () => {
  const bridge = installFakeBridge({
    'sources:list': () => [],
    'outbox:list': () => [],
    'attention:list': () => [],
    'storage:added-24h': () => [],
  });
  const reads = () =>
    bridge.calls.filter((c) => c === 'storage:added-24h').length;
  let commits = 0;
  render(
    <SourceDescriptorsProvider>
      <Profiler id="home" onRender={() => { commits += 1; }}>
        <Home />
      </Profiler>
    </SourceDescriptorsProvider>,
  );
  for (let i = 0; i < 4; i += 1) await act(async () => {});
  expect(reads()).toBe(1);

  act(() => setVisibility('hidden'));
  commits = 0;
  await act(async () => {
    jest.advanceTimersByTime(5 * 60_000);
  });
  expect(reads()).toBe(1);
  expect(commits).toBe(0);

  await act(async () => setVisibility('visible'));
  expect(reads()).toBe(2);
});

test('mounted while hidden, Home makes no 24 h request until it is shown', async () => {
  setVisibility('hidden');
  const bridge = installFakeBridge({
    'sources:list': () => [],
    'outbox:list': () => [],
    'attention:list': () => [],
    'storage:added-24h': () => [],
  });
  const reads = () =>
    bridge.calls.filter((c) => c === 'storage:added-24h').length;
  render(
    <SourceDescriptorsProvider>
      <Home />
    </SourceDescriptorsProvider>,
  );
  for (let i = 0; i < 4; i += 1) await act(async () => {});
  expect(reads()).toBe(0); // no mount read while hidden
  await act(async () => {
    jest.advanceTimersByTime(5 * 60_000);
  });
  expect(reads()).toBe(0);
  await act(async () => setVisibility('visible'));
  expect(reads()).toBe(1);
});

/** useAddedLastDay alone, so what it applied is visible. */
let lastAdded: ReadonlyMap<string, number> | null = null;
function AddedProbe(): null {
  lastAdded = useAddedLastDay();
  return null;
}

test('a response that lands after the window is hidden is not applied', async () => {
  let resolveFirst: (rows: unknown) => void = () => {};
  let calls = 0;
  installFakeBridge({
    'storage:added-24h': () => {
      calls += 1;
      if (calls === 1)
        return new Promise((resolve) => {
          resolveFirst = resolve;
        });
      return [{ accountId: 's', count: 7 }];
    },
  });
  render(<AddedProbe />);
  await act(async () => {});
  expect(calls).toBe(1); // in flight
  act(() => setVisibility('hidden'));
  await act(async () => resolveFirst([{ accountId: 's', count: 5 }]));
  expect(lastAdded?.get('slack')).toBeUndefined();
  // Shown again: a fresh read, and that one is applied.
  await act(async () => setVisibility('visible'));
  await act(async () => {});
  expect(calls).toBe(2);
  expect(lastAdded?.get('slack')).toBe(7);
});
```

Add `import { useAddedLastDay } from '../overlay/renderer/screens/Home/home-data';` to the test's imports.

The spec names three timers (useNow, the Home poll, the recorder clock). If `commits` is non-zero in the first test, check whether the commit comes from one of those three. If it comes from another Home timer, record which in the task report and keep the `reads()` assertions only.

- [ ] **Step 2: Write the failing recorder tests**

Append inside `describe('RecorderWidget', …)` in `src/__tests__/recorder-widget.test.tsx`. Add `act` to the `@testing-library/react` import.

```tsx
  const setVisibility = (state: 'visible' | 'hidden') => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => state,
    });
    document.dispatchEvent(new Event('visibilitychange'));
  };

  test('the display clock stops while hidden and catches up when shown', () => {
    jest.useFakeTimers();
    try {
      selectedState = 'recording';
      let commits = 0;
      render(
        <React.Profiler id="widget" onRender={() => { commits += 1; }}>
          <RecorderWidget />
        </React.Profiler>,
      );
      act(() => {
        jest.advanceTimersByTime(2000);
      });
      expect(commits).toBeGreaterThan(1); // ticking while visible
      act(() => setVisibility('hidden'));
      commits = 0;
      act(() => {
        jest.advanceTimersByTime(5000);
      });
      expect(commits).toBe(0);
      act(() => setVisibility('visible'));
      expect(commits).toBe(1);
    } finally {
      jest.useRealTimers();
      delete (document as unknown as { visibilityState?: unknown })
        .visibilityState;
    }
  });

  test('a recording that ends while hidden leaves no clock behind', () => {
    jest.useFakeTimers();
    try {
      selectedState = 'recording';
      const { rerender } = render(<RecorderWidget />);
      act(() => setVisibility('hidden'));
      selectedState = 'done';
      rerender(<RecorderWidget />);
      const set = jest.spyOn(window, 'setInterval');
      act(() => setVisibility('visible'));
      act(() => {
        jest.advanceTimersByTime(5000);
      });
      expect(set.mock.calls.filter((c) => c[1] === 1000)).toHaveLength(0);
    } finally {
      jest.useRealTimers();
      delete (document as unknown as { visibilityState?: unknown })
        .visibilityState;
    }
  });
```

- [ ] **Step 3: Run both to verify they fail**

Run: `cd ~/work/ac-ui && npx jest --config package.json src/__tests__/home-hidden-refresh.test.tsx src/__tests__/recorder-widget.test.tsx`
Expected:
- The Home poll assertions FAIL: `reads()` is 6 after 5 hidden minutes, and on show it does not refetch at once.
- The hidden-mount test FAILS because the mount read happens (1, not 0).
- The late-response test FAILS because the count of 5 is applied while hidden.
- The recorder's first test FAILS (`commits` 5 while hidden).

- [ ] **Step 4: Gate both timers**

`home-data.ts`: add `import { everyWhileVisible } from '@shared/web-ui/ui';` after the `@kia/ui-sdk` import, and after `const NO_ACCOUNTS: never[] = [];` add:

```ts
const windowHidden = (): boolean => document.visibilityState === 'hidden';
```

Replace the whole `useEffect` in `useAddedLastDay` with:

```ts
  useEffect(() => {
    let active = true;
    // The 24 h window slides, so the count is re-read on a clock, but only
    // while someone can see it: no request starts while hidden, and a
    // response that lands after the window was hidden is dropped (the
    // re-read on becoming visible brings the current numbers).
    const read = (): void => {
      if (windowHidden()) return;
      window.kiagent
        .invoke('storage:added-24h', undefined)
        .then((result) => {
          if (active && !windowHidden() && Array.isArray(result))
            setRows(result);
        })
        .catch(() => {});
    };
    read();
    const stop = everyWhileVisible(read, ADDED_REFRESH_MS);
    return () => {
      active = false;
      stop();
    };
  }, []);
```

`RecorderWidget.tsx`: change line 4 to `import { Button, everyWhileVisible } from '@shared/web-ui/ui';` and replace the clock effect with

```tsx
  useEffect(() => {
    if (!recording) return undefined;
    // Display only: recording itself runs in main. Hidden, the clock stops;
    // shown again, it jumps to the right time at once.
    return everyWhileVisible(() => setNow(Date.now()), 1000);
  }, [recording]);
```

- [ ] **Step 5: Run the tests and the neighbours**

```bash
cd ~/work/ac-ui
node build/apply-overlay.mjs
npx jest --config package.json src/__tests__/home-hidden-refresh.test.tsx src/__tests__/recorder-widget.test.tsx src/__tests__/home-render-count.test.tsx src/__tests__/home-page.test.tsx src/__tests__/recorder-feed-status.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Lint and commit**

Run: `cd ~/work/ac-ui && npx eslint --ext .ts,.tsx src/overlay/renderer/screens/Home/home-data.ts src/overlay/renderer/components/Recorder/RecorderWidget.tsx src/__tests__/home-hidden-refresh.test.tsx src/__tests__/recorder-widget.test.tsx`
Expected: no errors.

```bash
cd ~/work/ac-ui
printf '%s\n' 'perf(home,recorder): pause the 24 h poll and the recording clock while hidden' '' 'Both use core'"'"'s everyWhileVisible: no timer-driven state updates in a' 'hidden window, and an immediate catch-up when it is shown (#271).' > $S/msg-9.txt
git add src/__tests__/home-hidden-refresh.test.tsx
git commit -F $S/msg-9.txt -- src/overlay/renderer/screens/Home/home-data.ts src/overlay/renderer/components/Recorder/RecorderWidget.tsx src/__tests__/home-hidden-refresh.test.tsx src/__tests__/recorder-widget.test.tsx
```

### Task 10: Transcripts loads on first visit (spec D)

**Files:**
- Move: `~/work/ac-ui/src/overlay/renderer/screens/Transcripts/level-rows.ts` → `~/work/ac-ui/src/overlay/renderer/components/level-rows.ts`
- Modify imports:
  - `~/work/ac-ui/src/overlay/renderer/components/Recorder/RecorderStrip.tsx:7`
  - `~/work/ac-ui/src/overlay/renderer/components/Recorder/recorder-store.ts:21`
  - `~/work/ac-ui/src/overlay/renderer/components/Recorder/recorder-strip.ts:1`
  - `~/work/ac-ui/src/overlay/renderer/screens/Transcripts/LevelRows.tsx:26`
  - `~/work/ac-ui/src/overlay/renderer/screens/Transcripts/MeetingStatus.tsx:16`
  - `~/work/ac-ui/src/__tests__/level-rows.test.ts:29`
  - `~/work/ac-ui/src/__tests__/level-rows-component.test.tsx:8`
  - `~/work/ac-ui/src/__tests__/recorder-strip.test.ts:2`
- Modify: `~/work/ac-ui/build/apply-overlay.mjs` (`ADDITIVE_SHADOWS`, the `level-rows.ts` entry at line 103)
- Modify: `~/work/ac-ui/build/apply-overlay.test.mjs` (test at lines 1080–1106)
- Modify: `~/work/ac-ui/src/overlay/renderer/screen-registry.tsx` (lines 5, 16, 67)
- Create: `~/work/ac-ui/src/__tests__/transcripts-lazy.test.tsx`
- Create: `~/work/ac-ui/src/__tests__/transcripts-lazy-boundary.test.ts`

**Interfaces:**
- Produces: `getDefaultScreens().transcripts.factory()` returns `<Suspense fallback={<Busy label="Loading transcripts…" />}><Transcripts /></Suspense>`, where `Transcripts` is a module-scope `React.lazy` over `import(/* webpackChunkName: "transcripts" */ '@renderer/screens/Transcripts')`. Task 11 looks for the `transcripts` chunk name.

- [ ] **Step 1: Write the failing boundary and lazy tests**

`src/__tests__/transcripts-lazy-boundary.test.ts`:

```ts
/** @jest-environment node */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Transcripts is split into its own chunk (spec 2026-10-09 renderer perf, D).
 * One static import from outside its tree would pull it, and react-markdown
 * with it, back into the first paint. Only the registry may name it, and
 * only through a dynamic import().
 */
const OVERLAY = path.join(__dirname, '..', 'overlay');
const TREE = path.join('renderer', 'screens', 'Transcripts') + path.sep;

function sources(dir: string, rel = ''): string[] {
  return fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap(
    (e) => {
      const child = path.join(rel, e.name);
      if (e.isDirectory()) return sources(dir, child);
      return /\.(ts|tsx)$/.test(e.name) ? [child] : [];
    },
  );
}

const STATIC = /(?:^|\n)\s*(?:import|export)\b[^'"]*?from\s*['"]([^'"]+)['"]/g;
const DYNAMIC = /import\(\s*(?:\/\*[^*]*\*\/\s*)?['"]([^'"]+)['"]\s*\)/g;
const NAMES_TRANSCRIPTS = /(^|\/)(screens\/)?Transcripts(\/|$)/;

test('nothing outside the Transcripts tree imports it statically', () => {
  const offenders: string[] = [];
  for (const rel of sources(OVERLAY)) {
    if (rel.startsWith(TREE)) continue;
    const text = fs.readFileSync(path.join(OVERLAY, rel), 'utf8');
    for (const m of text.matchAll(STATIC)) {
      if (NAMES_TRANSCRIPTS.test(m[1])) offenders.push(`${rel}: ${m[1]}`);
    }
  }
  expect(offenders).toEqual([]);
});

test('the registry loads it with one dynamic import', () => {
  const registry = fs.readFileSync(
    path.join(OVERLAY, 'renderer', 'screen-registry.tsx'),
    'utf8',
  );
  const dynamic = [...registry.matchAll(DYNAMIC)].map((m) => m[1]);
  expect(dynamic).toEqual(['@renderer/screens/Transcripts']);
});
```

`src/__tests__/transcripts-lazy.test.tsx`:

```tsx
import '@testing-library/jest-dom';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { Busy } from '@shared/web-ui/components';
import {
  createScreenRegistry,
  getDefaultScreens,
} from '../overlay/renderer/screen-registry';

let mockTranscriptsLoads = 0;
jest.mock('@renderer/screens/Transcripts', () => {
  mockTranscriptsLoads += 1;
  return { Transcripts: () => <div data-testid="transcripts-screen" /> };
});
// The other default screens import ESM-only or IPC-heavy modules.
jest.mock('@renderer/screens/Sources', () => ({ Sources: () => null }));
jest.mock('@renderer/screens/Connection', () => ({ Connection: () => null }));
jest.mock('@renderer/screens/Logs', () => ({ Logs: () => null }));
jest.mock('@renderer/screens/Outbox', () => ({ Outbox: () => null }));
jest.mock('@renderer/contributed-page', () => ({ ContributedPage: () => null }));

type Wrapped = React.ReactElement<{
  fallback: React.ReactElement;
  children: React.ReactElement;
}>;

test('the Transcripts module is not loaded until the screen renders', async () => {
  const registry = createScreenRegistry(getDefaultScreens());
  expect(mockTranscriptsLoads).toBe(0);
  render(<>{registry.get('transcripts', {}, jest.fn(), [])}</>);
  expect(await screen.findByTestId('transcripts-screen')).toBeInTheDocument();
  expect(mockTranscriptsLoads).toBe(1);
});

test('one lazy component at module scope, behind the delayed status fallback', () => {
  const make = () =>
    getDefaultScreens().transcripts!.factory({}, jest.fn()) as Wrapped;
  const a = make();
  const b = make();
  expect(a.type).toBe(React.Suspense);
  expect(a.props.fallback.type).toBe(Busy);
  expect(a.props.children.type).toBe(b.props.children.type);
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd ~/work/ac-ui && npx jest --config package.json src/__tests__/transcripts-lazy-boundary.test.ts src/__tests__/transcripts-lazy.test.tsx`
Expected:
- The boundary test FAILS, listing the three Recorder files and `renderer/screen-registry.tsx: @renderer/screens/Transcripts`.
- The dynamic-import test FAILS because the list is empty.
- The lazy tests FAIL: `mockTranscriptsLoads` is already 1 at import, and `a.type` is not `Suspense`.

- [ ] **Step 3: Move `level-rows.ts` to a neutral module**

```bash
cd ~/work/ac-ui
git mv src/overlay/renderer/screens/Transcripts/level-rows.ts src/overlay/renderer/components/level-rows.ts
```

Update the specifiers (the rest of each import is unchanged):

| File | Old specifier | New specifier |
|---|---|---|
| `components/Recorder/RecorderStrip.tsx` | `'../../screens/Transcripts/level-rows'` | `'../level-rows'` |
| `components/Recorder/recorder-store.ts` | `'../../screens/Transcripts/level-rows'` | `'../level-rows'` |
| `components/Recorder/recorder-strip.ts` | `'../../screens/Transcripts/level-rows'` | `'../level-rows'` |
| `screens/Transcripts/LevelRows.tsx` | `'./level-rows'` | `'../../components/level-rows'` |
| `screens/Transcripts/MeetingStatus.tsx` | `'./level-rows'` | `'../../components/level-rows'` |
| `src/__tests__/level-rows.test.ts` | `'../overlay/renderer/screens/Transcripts/level-rows'` | `'../overlay/renderer/components/level-rows'` |
| `src/__tests__/level-rows-component.test.tsx` | same | same |
| `src/__tests__/recorder-strip.test.ts` | same | same |

In the moved file's header, replace the paragraph that begins "A sibling of `index.tsx` / `LevelRows.tsx`, imported RELATIVELY only." with:

```ts
 * Shared by the Transcripts screen and the always-mounted recorder, so it
 * lives outside the lazily loaded Transcripts tree (a static import from
 * the recorder would pull that chunk into the first paint). Imported
 * RELATIVELY only. The one non-relative import is the renderer's wire
 * MIRROR, a type-only import, so nothing is emitted and the
 * `extensions/meetings` tree is never reached.
```

In `build/apply-overlay.mjs`, delete `path.join('renderer', 'screens', 'Transcripts', 'level-rows.ts'),` and add `path.join('renderer', 'components', 'level-rows.ts'),` after `path.join('renderer', 'components', 'meetings-languages.ts'),`.

In `build/apply-overlay.test.mjs`, rename the test at line 1080 to `'the waveform helpers are allow-listed additive shadows outside the lazy Transcripts tree'`. Replace its first `assert.ok(…level-rows.ts…)` with:

```js
  assert.ok(
    ADDITIVE_SHADOWS.has(path.join('renderer', 'components', 'level-rows.ts')),
  );
  assert.ok(
    !ADDITIVE_SHADOWS.has(
      path.join('renderer', 'screens', 'Transcripts', 'level-rows.ts'),
    ),
  );
```

- [ ] **Step 4: Load Transcripts lazily from the registry**

In `src/overlay/renderer/screen-registry.tsx`:

(a) Line 5 becomes `import React, { Suspense } from 'react';`.

(b) Delete `import { Transcripts } from '@renderer/screens/Transcripts';`, and after the `@renderer/state/view` import add `import { Busy } from '@shared/web-ui/components';`.

(c) After the `import { Settings } from './screens/Settings';` line, add:

```tsx
// Transcripts loads on first visit: MeetingSummary's react-markdown (with
// remark and micromark) is the largest library on any screen and nothing in
// the first paint needs it. Created once at module scope, so the loaded
// module and the lazy component survive every navigation. Nothing outside
// the Transcripts tree may import it statically
// (src/__tests__/transcripts-lazy-boundary.test.ts).
const Transcripts = React.lazy(() =>
  import(/* webpackChunkName: "transcripts" */ '@renderer/screens/Transcripts').then(
    (m) => ({ default: m.Transcripts }),
  ),
);
```

(d) Replace the `transcripts:` entry with:

```tsx
    transcripts: {
      frame: 'page',
      factory: () => (
        <Suspense fallback={<Busy label="Loading transcripts…" />}>
          <Transcripts />
        </Suspense>
      ),
    },
```

- [ ] **Step 5: Run the D tests, the harness test and the neighbours**

```bash
cd ~/work/ac-ui
node build/apply-overlay.mjs
node --test build/apply-overlay.test.mjs
npx jest --config package.json src/__tests__/transcripts-lazy-boundary.test.ts src/__tests__/transcripts-lazy.test.tsx src/__tests__/screen-registry-b3.test.tsx src/__tests__/level-rows.test.ts src/__tests__/level-rows-component.test.tsx src/__tests__/recorder-strip.test.ts src/__tests__/recorder-widget.test.tsx src/__tests__/transcripts-view.test.tsx src/__tests__/transcripts-panel.test.tsx src/__tests__/app-title-b3.test.tsx
```

Expected: PASS. A stale `build/.core/src/renderer/screens/Transcripts/level-rows.ts` from the earlier overlay copy may remain. Nothing imports it, so leave it.

- [ ] **Step 6: Lint and commit**

Run: `cd ~/work/ac-ui && npx eslint --ext .ts,.tsx,.mjs src/overlay/renderer/screen-registry.tsx src/overlay/renderer/components/level-rows.ts src/overlay/renderer/components/Recorder/RecorderStrip.tsx src/overlay/renderer/components/Recorder/recorder-store.ts src/overlay/renderer/components/Recorder/recorder-strip.ts src/overlay/renderer/screens/Transcripts/LevelRows.tsx src/overlay/renderer/screens/Transcripts/MeetingStatus.tsx src/__tests__/transcripts-lazy.test.tsx src/__tests__/transcripts-lazy-boundary.test.ts src/__tests__/level-rows.test.ts src/__tests__/level-rows-component.test.tsx src/__tests__/recorder-strip.test.ts build/apply-overlay.mjs build/apply-overlay.test.mjs`
Expected: no errors.

```bash
cd ~/work/ac-ui
printf '%s\n' 'perf(transcripts): load the screen, and react-markdown, on first visit' '' 'The registry lazy-loads Transcripts at module scope behind the delayed' 'Busy status. level-rows moves to components/ so the always-mounted' 'recorder no longer imports from the Transcripts tree; a source scan' 'keeps every other import out (#271).' > $S/msg-10.txt
git add src/__tests__/transcripts-lazy.test.tsx src/__tests__/transcripts-lazy-boundary.test.ts
git commit -F $S/msg-10.txt -- src/overlay/renderer/screens/Transcripts/level-rows.ts src/overlay/renderer/components/level-rows.ts src/overlay/renderer/screen-registry.tsx src/overlay/renderer/components/Recorder/RecorderStrip.tsx src/overlay/renderer/components/Recorder/recorder-store.ts src/overlay/renderer/components/Recorder/recorder-strip.ts src/overlay/renderer/screens/Transcripts/LevelRows.tsx src/overlay/renderer/screens/Transcripts/MeetingStatus.tsx src/__tests__/level-rows.test.ts src/__tests__/level-rows-component.test.tsx src/__tests__/recorder-strip.test.ts build/apply-overlay.mjs build/apply-overlay.test.mjs src/__tests__/transcripts-lazy.test.tsx src/__tests__/transcripts-lazy-boundary.test.ts
```

### Task 11: Bundle check over webpack stats, and the per-screen sizes (spec D acceptance)

**Files:**
- Create: `~/work/ac-ui/build/renderer-bundle.mjs`
- Create: `~/work/ac-ui/build/renderer-bundle.test.mjs`
- Create: `~/work/ac-ui/build/renderer-stats-options.cjs` (the full-JSON stats options)
- Create: `~/work/ac-ui/build/webpack.renderer-stats.cjs` (wraps core's prod renderer config with those options)
- Modify: this plan file, "Recorded screen sizes" section (appended at execution)

**Interfaces:**
- Produces: `build/renderer-stats-options.cjs` exports `STATS_OPTIONS`, a webpack stats object. It replaces the base config's `stats: 'minimal'`, which turns chunks off and limits modules to zero, and webpack-cli's `--json` keeps whatever the config says.
- Produces (from `build/renderer-bundle.mjs`):
  - `export const MARKDOWN_RE: RegExp`
  - `export function markdownPlacement(stats): { inInitial: string[]; inAsync: string[]; unplaced: string[] }`. A module counts as async only if it belongs to at least one known chunk with `initial === false`, and to no initial chunk. A markdown module with no chunk ids, an empty list, or only unknown ids is `unplaced`.
  - `export function assertMarkdownSplit(stats): { inAsync: string[] }`, which throws on a regression or on stats that cannot show the split
  - `export function screenSizes(report): Record<string, number>`, the parsed bytes per `src/renderer/screens/<Name>/`
  - The CLI `node build/renderer-bundle.mjs --stats <stats.json> [--report <analyzer.json>]`

- [ ] **Step 1: Write the failing node:test suite**

`build/renderer-bundle.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertMarkdownSplit,
  markdownPlacement,
  screenSizes,
} from './renderer-bundle.mjs';

const stats = (modules, chunks = [
  { id: 0, initial: true, names: ['main'] },
  { id: 7, initial: false, names: ['transcripts'] },
]) => ({ chunks, modules });

const app = { name: './src/renderer/index.tsx', chunks: [0] };
const markdownAsync = {
  name: '../../alpha-cent/node_modules/react-markdown/lib/index.js + 80 modules',
  chunks: [7],
  modules: [
    { name: '../../alpha-cent/node_modules/react-markdown/lib/index.js' },
    { name: '../../alpha-cent/node_modules/micromark/lib/parse.js' },
    { name: '../../alpha-cent/node_modules/remark-parse/lib/index.js' },
  ],
};

test('react-markdown and friends only in an async chunk: passes', () => {
  const out = assertMarkdownSplit(stats([app, markdownAsync]));
  assert.deepEqual(out.inAsync, ['micromark', 'react-markdown', 'remark-parse']);
});

test('micromark in the first-paint chunk: throws, naming it', () => {
  const eager = { name: './node_modules/micromark/index.js', chunks: [0] };
  assert.throws(
    () => assertMarkdownSplit(stats([app, markdownAsync, eager])),
    /first-paint chunk carries micromark/,
  );
});

test('a module shared by both chunks counts as first paint', () => {
  const shared = { ...markdownAsync, chunks: [0, 7] };
  assert.deepEqual(markdownPlacement(stats([app, shared])).inInitial, [
    'micromark',
    'react-markdown',
    'remark-parse',
  ]);
});

test('no react-markdown anywhere: throws (the stats cannot prove the split)', () => {
  assert.throws(() => assertMarkdownSplit(stats([app])), /in no async chunk/);
});

test('stats without chunks or modules: throws', () => {
  assert.throws(() => assertMarkdownSplit({ modules: [] }), /full JSON stats/);
  assert.throws(
    () => assertMarkdownSplit(stats([app], [{ id: 7, initial: false }])),
    /no initial chunk/,
  );
});

test('chunks without initial flags: throws (minimal-preset stats)', () => {
  assert.throws(
    () => assertMarkdownSplit(stats([app, markdownAsync], [{ id: 0 }, { id: 7 }])),
    /initial flag/,
  );
});

// A module is async only if it sits in a KNOWN non-initial chunk. Webpack
// emits orphan modules with no chunk membership; none of these prove a split.
for (const [label, chunks] of [
  ['empty chunk ids', { chunks: [] }],
  ['missing chunk ids', {}],
  ['unknown chunk ids', { chunks: [99] }],
]) {
  test(`react-markdown with ${label}: not async, so the check throws`, () => {
    const mod = { ...markdownAsync };
    delete mod.chunks;
    Object.assign(mod, chunks);
    const placed = markdownPlacement(stats([app, mod]));
    assert.deepEqual(placed.inAsync, []);
    assert.deepEqual(placed.inInitial, []);
    assert.ok(placed.unplaced.includes('react-markdown'));
    assert.throws(() => assertMarkdownSplit(stats([app, mod])), /in no async chunk/);
  });
}

test('the stats options ask for everything the checker and analyzer read', async () => {
  const { createRequire } = await import('node:module');
  const { STATS_OPTIONS } = createRequire(import.meta.url)(
    './renderer-stats-options.cjs',
  );
  for (const key of [
    'assets',
    'chunks',
    'ids',
    'modules',
    'nestedModules',
    'orphanModules',
    'outputPath',
  ])
    assert.equal(STATS_OPTIONS[key], true, key);
  assert.equal(STATS_OPTIONS.modulesSpace, Infinity);
  assert.equal(STATS_OPTIONS.nestedModulesSpace, Infinity);
});

test('screenSizes sums parsed leaf sizes per screen folder', () => {
  const report = [
    {
      label: 'renderer.js',
      groups: [
        { path: './src/renderer/screens/Home/index.tsx', parsedSize: 1000 },
        {
          path: './src/renderer/screens/Home/HomeKpis.tsx + 2 modules',
          groups: [
            { path: './src/renderer/screens/Home/HomeKpis.tsx', parsedSize: 300 },
            { path: './src/renderer/screens/Home/home-format.ts', parsedSize: 200 },
          ],
        },
        { path: './src/renderer/App.tsx', parsedSize: 50 },
      ],
    },
    {
      label: 'transcripts.renderer.js',
      groups: [
        { path: './src/renderer/screens/Transcripts/index.tsx', parsedSize: 4000 },
      ],
    },
  ];
  assert.deepEqual(screenSizes(report), { Home: 1500, Transcripts: 4000 });
});
```

Run: `cd ~/work/ac-ui && node --test build/renderer-bundle.test.mjs`
Expected: FAIL, "Cannot find module … renderer-bundle.mjs".

- [ ] **Step 2: Implement the checker**

`build/renderer-bundle.mjs`:

```js
/**
 * Renderer bundle checks over webpack stats (spec 2026-10-09 renderer perf,
 * D): react-markdown, remark, micromark and mdast must not ship in the
 * first-paint chunk, and react-markdown must sit in an async chunk, which
 * proves the split happened rather than the names going missing.
 *
 * Stats come from a prod renderer build of the staged core through
 * build/webpack.renderer-stats.cjs (full JSON stats; the base config's
 * 'minimal' preset drops chunks and modules); see the plan
 * docs/superpowers/plans/2026-10-09-renderer-perf.md (core repo), Task 11:
 *   webpack --config <ac-ui>/build/webpack.renderer-stats.cjs \
 *     --output-path <dir> --json <stats.json>
 * CLI: node build/renderer-bundle.mjs --stats <stats.json> [--report <analyzer.json>]
 *   --report: a webpack-bundle-analyzer `-m json` report of the same build;
 *   prints the minified size of each src/renderer/screens/<Name>/ folder.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MARKDOWN_RE =
  /node_modules\/(react-markdown|remark-[^/]+|micromark[^/]*|mdast-util-[^/]+)\//;

function moduleNames(mod) {
  const names = [mod.name ?? '', mod.identifier ?? ''];
  for (const inner of mod.modules ?? []) names.push(...moduleNames(inner));
  return names;
}

export function markdownPlacement(stats) {
  if (!Array.isArray(stats?.chunks) || !Array.isArray(stats?.modules)) {
    throw new Error(
      'renderer-bundle: stats have no chunks/modules — build with full JSON ' +
        'stats (build/webpack.renderer-stats.cjs), not the minimal preset',
    );
  }
  if (stats.chunks.some((c) => typeof c.initial !== 'boolean')) {
    throw new Error('renderer-bundle: stats chunks carry no initial flag');
  }
  const chunkById = new Map(stats.chunks.map((c) => [c.id, c]));
  if (![...chunkById.values()].some((c) => c.initial))
    throw new Error('renderer-bundle: no initial chunk in the stats');
  const inInitial = new Set();
  const inAsync = new Set();
  const unplaced = new Set();
  for (const mod of stats.modules) {
    const hits = new Set();
    for (const name of moduleNames(mod)) {
      const m = name.replace(/\\/g, '/').match(MARKDOWN_RE);
      if (m) hits.add(m[1]);
    }
    if (hits.size === 0) continue;
    // Only KNOWN chunks place a module. No ids, an empty list or unknown ids
    // (webpack emits orphan modules with no chunk) prove nothing.
    const known = (Array.isArray(mod.chunks) ? mod.chunks : [])
      .map((id) => chunkById.get(id))
      .filter(Boolean);
    const target = known.some((c) => c.initial)
      ? inInitial
      : known.length > 0
        ? inAsync
        : unplaced;
    for (const hit of hits) target.add(hit);
  }
  return {
    inInitial: [...inInitial].sort(),
    inAsync: [...inAsync].sort(),
    unplaced: [...unplaced].sort(),
  };
}

export function assertMarkdownSplit(stats) {
  const { inInitial, inAsync, unplaced } = markdownPlacement(stats);
  if (inInitial.length > 0) {
    throw new Error(
      `renderer-bundle: first-paint chunk carries ${inInitial.join(', ')}`,
    );
  }
  if (!inAsync.includes('react-markdown')) {
    throw new Error(
      'renderer-bundle: react-markdown is in no async chunk — these stats ' +
        'cannot show the split (wrong file, module names changed, or no ' +
        `chunk membership${unplaced.length ? `; unplaced: ${unplaced.join(', ')}` : ''})`,
    );
  }
  return { inAsync };
}

const SCREEN_RE = /src\/renderer\/screens\/([^/]+)\//;

export function screenSizes(report) {
  const out = {};
  const walk = (node) => {
    if (Array.isArray(node.groups) && node.groups.length > 0) {
      node.groups.forEach(walk);
      return;
    }
    const m = String(node.path ?? '').replace(/\\/g, '/').match(SCREEN_RE);
    if (m) out[m[1]] = (out[m[1]] ?? 0) + (node.parsedSize ?? 0);
  };
  report.forEach(walk);
  return out;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  };
  try {
    const stats = JSON.parse(fs.readFileSync(flag('--stats'), 'utf8'));
    const { inAsync } = assertMarkdownSplit(stats);
    console.log(`[renderer-bundle] OK — async only: ${inAsync.join(', ')}`);
    const reportPath = flag('--report');
    if (reportPath) {
      const sizes = screenSizes(
        JSON.parse(fs.readFileSync(reportPath, 'utf8')),
      );
      for (const [screen, bytes] of Object.entries(sizes).sort(
        (a, b) => b[1] - a[1],
      )) {
        console.log(`${screen}\t${(bytes / 1024).toFixed(1)} KB`);
      }
    }
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : e}\n`);
    process.exit(1);
  }
}
```

`build/renderer-stats-options.cjs`:

```js
/**
 * Full JSON stats for the renderer bundle check (renderer perf plan, Task
 * 11). Core's base webpack config sets stats: 'minimal', which turns chunks
 * off and limits modules to zero, and webpack-cli's --json keeps the
 * config's stats options, so the check would see nothing. These ask for
 * exactly what build/renderer-bundle.mjs and webpack-bundle-analyzer read:
 * assets, chunk ids with their initial flags, every module with its chunk
 * ids, and the modules nested inside concatenated ones.
 */
exports.STATS_OPTIONS = {
  all: false,
  assets: true,
  outputPath: true,
  publicPath: true,
  entrypoints: true,
  chunkGroups: true,
  chunks: true,
  ids: true,
  modules: true,
  nestedModules: true,
  orphanModules: true,
  cachedModules: true,
  modulesSpace: Infinity,
  nestedModulesSpace: Infinity,
  errors: true,
  warnings: true,
};
```

`build/webpack.renderer-stats.cjs`:

```js
/**
 * Core's prod renderer config with full JSON stats (see
 * renderer-stats-options.cjs). Run from the staged core (cwd build/.core)
 * under `-r ts-node/register`, which lets this require the .ts config.
 */
const path = require('node:path');
const { STATS_OPTIONS } = require('./renderer-stats-options.cjs');

const loaded = require(
  path.join(process.cwd(), '.erb', 'configs', 'webpack.config.renderer.prod.ts'),
);
module.exports = { ...(loaded.default ?? loaded), stats: STATS_OPTIONS };
```

- [ ] **Step 3: Run the suite**

Run: `cd ~/work/ac-ui && node --test build/renderer-bundle.test.mjs`
Expected: PASS (11 tests).

- [ ] **Step 4: Build the prod renderer from the staged core (heavy)**

```bash
cd ~/work/ac-ui
node build/apply-overlay.mjs
# webpack externalizes release/app deps; use the product's manifest, as
# package-product.mjs does (fetch-core's reuse path restores it).
cp release/app/package.json build/.core/release/app/package.json
rm -rf $S/renderer-dist
cd ~/work/ac-ui/build/.core && $H env NODE_ENV=production TS_NODE_TRANSPILE_ONLY=true NODE_OPTIONS="-r ts-node/register --no-warnings" ./node_modules/.bin/webpack --config ~/work/ac-ui/build/webpack.renderer-stats.cjs --output-path $S/renderer-dist --json $S/renderer-stats.json
ls $S/renderer-dist
node -e "const s=require('$S/renderer-stats.json'); const m=s.modules||[]; console.log('chunks', (s.chunks||[]).length, 'initial', (s.chunks||[]).filter(c=>c.initial===true).length, 'modules', m.length, 'with chunk ids', m.filter(x=>Array.isArray(x.chunks)&&x.chunks.length).length, 'nested', m.filter(x=>Array.isArray(x.modules)).length)"
```

Expected:
- The build succeeds. (`build/.core/node_modules` is the Task 6 symlink; it has `.bin/webpack`, `ts-node` and `typescript`, checked 2026-10-09.)
- The `node -e` line prints non-zero chunks, at least one initial chunk, thousands of modules (most with chunk ids), and some nested ones. If a count is 0, the stats override did not take effect. In that case, fix the wrapper; do not loosen the checker.
- `$S/renderer-dist` has `renderer.js` plus a `transcripts` chunk (`*transcripts*.js`).
- `deleteSourceMaps()` only touches `build/.core/release/app/dist`, which is local to this clone and not the shared dist.

- [ ] **Step 5: Assert the split and measure the screens**

```bash
cd ~/work/ac-ui
./node_modules/.bin/webpack-bundle-analyzer $S/renderer-stats.json $S/renderer-dist -m json -r $S/renderer-analyzer.json
node build/renderer-bundle.mjs --stats $S/renderer-stats.json --report $S/renderer-analyzer.json | tee $S/renderer-sizes.txt
```

Expected: `[renderer-bundle] OK — async only: …react-markdown…`, followed by one `Screen<TAB>N KB` line per screen.

- [ ] **Step 6: Record the sizes and apply the 50 KB rule**

Append to the "Recorded screen sizes" section at the end of this plan file (`~/work/kcore-ui/docs/superpowers/plans/2026-10-09-renderer-perf.md`): the measurement date, the core tag, and the table from `$S/renderer-sizes.txt`. For every screen other than Transcripts that is over 50 KB, run `grep -rn "screens/<Name>" ~/work/ac-ui/src/overlay --include='*.ts' --include='*.tsx'` and note whether it has eager importers (Home, Sidebar, App, Recorder). Do **not** split another screen in this plan. Report any screen that qualifies (over 50 KB, no eager importers) to the founder.

- [ ] **Step 7: Lint and commit (overlay), then commit the record (core)**

```bash
cd ~/work/ac-ui
npx eslint build/renderer-bundle.mjs build/renderer-bundle.test.mjs build/renderer-stats-options.cjs build/webpack.renderer-stats.cjs
printf '%s\n' 'test(build): assert react-markdown stays out of the first-paint chunk' '' 'renderer-bundle.mjs checks webpack stats of a prod renderer build and' 'prints per-screen minified sizes from a bundle-analyzer report (#271).' > $S/msg-11.txt
git add build/renderer-bundle.mjs build/renderer-bundle.test.mjs build/renderer-stats-options.cjs build/webpack.renderer-stats.cjs
git commit -F $S/msg-11.txt -- build/renderer-bundle.mjs build/renderer-bundle.test.mjs build/renderer-stats-options.cjs build/webpack.renderer-stats.cjs
cd ~/work/kcore-ui
printf '%s\n' 'docs(plan): record renderer screen sizes (renderer perf D)' > $S/msg-11b.txt
git add docs/superpowers/plans/2026-10-09-renderer-perf.md
git commit -F $S/msg-11b.txt -- docs/superpowers/plans/2026-10-09-renderer-perf.md
```

### Task 12: No source map anywhere in the product package (spec E, alpha-cent)

**Files:**
- Modify: `~/work/ac-ui/package.json` (`build.files`, lines 321–325)
- Modify: `~/work/ac-ui/build/inject.mjs` (`EXTRA_RESOURCES`, lines 31–38; `WIN_EXTRA_RESOURCES`, lines 42–47). inject.mjs owns the bundled-extension `extraResources` copy; `build-extensions.mjs` only stages the tree, including the extensions' production `node_modules`, and those carry maps (for example `@chainsafe/libp2p-yamux`).
- Modify: `~/work/ac-ui/build/inject.test.mjs` (the `extraResources` pins at lines 255–265 and 283–291)
- Modify: `~/work/ac-ui/src/__tests__/harness-inject.test.ts` (the `extraResources` pin at lines 115–121)
- Modify: `~/work/ac-ui/build/verify-package.mjs` (new `assertNoSourceMaps`; called from `verifyPackage`'s per-resources loop)
- Modify: `~/work/ac-ui/build/verify-package.test.mjs` (new tests; the 5 fixture `app.asar` writes at lines 46, 793, 841, 859 and 1013 become real empty archives)
- Modify: `~/work/ac-ui/src/__tests__/harness-verify-package.test.ts` (the fixture `app.asar` write at line 22)
- Create: `~/work/ac-ui/src/__tests__/package-files-no-maps.test.ts`

**Interfaces:**
- Produces: `export function assertNoSourceMaps(root: string, res: string, listAsar?: (asarPath: string) => string[]): void` in `build/verify-package.mjs`. It walks `root` (the `.app` on mac, the unpacked app dir elsewhere) for any `*.map` file, lists `res/app.asar` through `@electron/asar`'s `listPackage` (injectable for tests), and throws, naming the first five, if any are found. `verifyPackage` calls it for every resources dir. `package-product.mjs` already runs `verifyPackage` after every package, so a map anywhere in the bundle fails the product build.
- Produces: the bundled-extension `extraResources` filters end with `'!**/*.map'`.

- [ ] **Step 1: Write the failing manifest test**

`src/__tests__/package-files-no-maps.test.ts`:

```ts
/** @jest-environment node */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const filesOf = (manifest: string): string[] =>
  (
    JSON.parse(fs.readFileSync(manifest, 'utf8')) as {
      build: { files: string[] };
    }
  ).build.files;

test("this repo's manifest keeps source maps out of the package", () => {
  const files = filesOf(path.join(ROOT, 'package.json'));
  expect(files).toContain('!**/*.map');
  expect(files.indexOf('!**/*.map')).toBeGreaterThan(files.indexOf('dist'));
  expect(files.indexOf('!**/*.map')).toBeGreaterThan(
    files.indexOf('node_modules'),
  );
});

test('the staged core manifest, which electron-builder reads, excludes them too', () => {
  expect(filesOf(path.join(ROOT, 'build', '.core', 'package.json'))).toContain(
    '!**/*.map',
  );
});

test('the product build config never replaces build.files', () => {
  const buildJson = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'product', 'build.json'), 'utf8'),
  );
  expect(buildJson).not.toHaveProperty('files');
  expect(
    fs.readFileSync(path.join(ROOT, 'build', 'inject.mjs'), 'utf8'),
  ).not.toMatch(/build\.files/);
});
```

Run: `cd ~/work/ac-ui && npx jest --config package.json src/__tests__/package-files-no-maps.test.ts`
Expected: the first test FAILS. The second and third pass (core Task 4 is staged).

- [ ] **Step 2: Pin the extension filters (failing)**

In `build/inject.test.mjs`, change the expected bundled-extensions entry (the `assert.deepEqual(entries, [...])` at line 257) to:

```js
    {
      from: '.product-staging/bundled-extensions',
      to: 'bundled-extensions',
      filter: ['**/*', '!kiagent.meetings/dist/bin/win32-*/**', '!**/*.map'],
    },
```

and the expected per-arch entry (the `assert.deepEqual(archEntries, [...])` at line 286) to:

```js
    {
      from: '.product-staging/bundled-extensions/kiagent.meetings/dist/bin/win32-${arch}',
      to: WIN_HELPER_TO,
      filter: ['**/*', '!**/*.map'],
    },
```

In `src/__tests__/harness-inject.test.ts`, change the expected `filter` at line 119 to `['**/*', '!kiagent.meetings/dist/bin/win32-*/**', '!**/*.map']`.

Run: `cd ~/work/ac-ui && node --test build/inject.test.mjs && npx jest --config package.json src/__tests__/harness-inject.test.ts`
Expected: both FAIL on the filter arrays.

- [ ] **Step 3: Write the failing package-wide gate tests**

In `build/verify-package.test.mjs`:

(a) Add `assertNoSourceMaps` to the `./verify-package.mjs` import list, add `import asar from '@electron/asar';`, and add this helper after the imports:

```js
/** A valid, empty asar archive: the source-map gate lists every fixture's
 *  app.asar, so the fixtures must be real archives, not placeholder text.
 *  Layout: a pickle holding the header size, then a pickle holding the
 *  JSON header string. */
function writeEmptyAsar(file) {
  const json = Buffer.from('{"files":{}}'); // 12 bytes, already 4-aligned
  const header = Buffer.alloc(8 + json.length);
  header.writeUInt32LE(4 + json.length, 0); // pickle payload size
  header.writeUInt32LE(json.length, 4); // string length
  json.copy(header, 8);
  const size = Buffer.alloc(8);
  size.writeUInt32LE(4, 0); // pickle payload size
  size.writeUInt32LE(header.length, 4); // header pickle size
  fs.writeFileSync(file, Buffer.concat([size, header]));
}
```

(b) Replace each of the five `fs.writeFileSync(path.join(res, 'app.asar'), 'asar');` with `writeEmptyAsar(path.join(res, 'app.asar'));`.

(c) Append:

```js
test('writeEmptyAsar produces an archive @electron/asar can list', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'asar-')), 'a.asar');
  writeEmptyAsar(file);
  assert.deepEqual(asar.listPackage(file, { isPack: false }), []);
});

function mapScratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'maps-'));
  const res = path.join(root, 'Contents', 'Resources');
  fs.mkdirSync(path.join(res, 'bundled-extensions', 'x', 'node_modules', 'y'), {
    recursive: true,
  });
  writeEmptyAsar(path.join(res, 'app.asar'));
  return { root, res };
}

test('assertNoSourceMaps: a clean bundle passes', () => {
  const { root, res } = mapScratch();
  assertNoSourceMaps(root, res);
});

test('assertNoSourceMaps: a map in a bundled extension fails, naming it', () => {
  const { root, res } = mapScratch();
  fs.writeFileSync(
    path.join(res, 'bundled-extensions', 'x', 'node_modules', 'y', 'index.js.map'),
    '{}',
  );
  assert.throws(
    () => assertNoSourceMaps(root, res),
    /1 source map\(s\).*bundled-extensions.*index\.js\.map/,
  );
});

test('assertNoSourceMaps: a map elsewhere in the app bundle fails', () => {
  const { root, res } = mapScratch();
  fs.mkdirSync(path.join(root, 'Contents', 'Frameworks'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Contents', 'Frameworks', 'a.js.map'), '{}');
  assert.throws(() => assertNoSourceMaps(root, res), /a\.js\.map/);
});

test('assertNoSourceMaps: a map inside app.asar fails', () => {
  const { root, res } = mapScratch();
  assert.throws(
    () =>
      assertNoSourceMaps(root, res, () => [
        '/dist/renderer/renderer.js',
        '/dist/renderer/renderer.js.map',
      ]),
    /app\.asar.*renderer\.js\.map/,
  );
});

test('verifyPackage fails a package that ships a map', () => {
  const { buildDir, app } = scratchApp();
  const res = path.join(app, 'Contents', 'Resources');
  fs.writeFileSync(path.join(res, 'bundled-extensions', EXTS[0], 'index.js.map'), '{}');
  assert.throws(
    () =>
      verifyPackage({
        buildDir,
        expectExtensionIds: EXTS,
        runCmd: PASSING_RUN_CMD,
      }),
    /source map/,
  );
});
```

(`scratchApp()` returns `{ buildDir, app }`; `PASSING_RUN_CMD` is defined at line 96.)

In `src/__tests__/harness-verify-package.test.ts`, replace `fs.writeFileSync(path.join(res, 'app.asar'), 'fake');` with the same `writeEmptyAsar(path.join(res, 'app.asar'));`, and paste the helper (typed: `function writeEmptyAsar(file: string): void`) above the fixture function. A jest .ts file cannot import the .mjs test file.

Run: `cd ~/work/ac-ui && node --test build/verify-package.test.mjs`
Expected: FAIL. `assertNoSourceMaps` is not exported, so the import fails and every test in the file fails.

- [ ] **Step 4: Implement the exclusions and the gate**

`package.json` `build.files`:

```json
    "files": [
      "dist",
      "node_modules",
      "package.json",
      "!**/*.map"
    ],
```

`build/inject.mjs`:
- In `EXTRA_RESOURCES`, the bundled-extensions entry's filter becomes `['**/*', '!kiagent.meetings/dist/bin/win32-*/**', '!**/*.map']`.
- In `WIN_EXTRA_RESOURCES`, the entry gains `filter: ['**/*', '!**/*.map'],`.
- Add to the comment above `EXTRA_RESOURCES`: `// Source maps never ship (renderer perf spec E): the staged extensions'` and `// production node_modules carry them; build/verify-package.mjs gates it.`

`build/verify-package.mjs`: add `import asar from '@electron/asar';` to the imports, and add before `verifyPackage`:

```js
const listAsarEntries = (file) => asar.listPackage(file, { isPack: false });

/** No source map anywhere in the shipped app (renderer perf spec E). Maps
 *  stay in the build output, for symbolicating crash logs, and never
 *  ship: core's build.files excludes them from app.asar, and inject.mjs's
 *  extraResources filters exclude them from the bundled extensions. This
 *  checks the result package-wide: every file under `root` (the .app, or
 *  the unpacked app dir) plus every entry of `res/app.asar`. */
export function assertNoSourceMaps(root, res, listAsar = listAsarEntries) {
  const found = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.map')) found.push(path.relative(root, p));
    }
  };
  walk(root);
  const archive = path.join(res, 'app.asar');
  if (fs.existsSync(archive)) {
    for (const entry of listAsar(archive)) {
      if (entry.endsWith('.map')) found.push(`app.asar${entry}`);
    }
  }
  if (found.length > 0) {
    throw new Error(
      `${found.length} source map(s) packaged under ${root}: ${found
        .slice(0, 5)
        .join(', ')}${found.length > 5 ? ', …' : ''} — maps belong in the ` +
        'build output only (core build.files, inject.mjs extraResources filters)',
    );
  }
}
```

In `verifyPackage`'s `for (const res of dirs)` loop, right after the `app.asar`/`app` existence check, add:

```js
    const bundleRoot = res.endsWith(path.join('Contents', 'Resources'))
      ? path.resolve(res, '..', '..')
      : path.dirname(res);
    assertNoSourceMaps(bundleRoot, res);
    log(`no source maps in ${bundleRoot}`);
```

- [ ] **Step 5: Run every touched suite**

```bash
cd ~/work/ac-ui
node --test build/inject.test.mjs build/verify-package.test.mjs
npx jest --config package.json src/__tests__/package-files-no-maps.test.ts src/__tests__/harness-inject.test.ts src/__tests__/harness-verify-package.test.ts
```

Expected: PASS.

- [ ] **Step 6: Lint and commit**

```bash
cd ~/work/ac-ui
npx eslint --ext .ts,.mjs src/__tests__/package-files-no-maps.test.ts src/__tests__/harness-inject.test.ts src/__tests__/harness-verify-package.test.ts build/inject.mjs build/inject.test.mjs build/verify-package.mjs build/verify-package.test.mjs
printf '%s\n' 'build: no source map anywhere in the packaged app' '' 'build.files excludes them from app.asar (mirroring the staged core),' 'the bundled-extension extraResources filters exclude them from' 'Resources, and verify-package fails a package that ships any (#271).' > $S/msg-12.txt
git add src/__tests__/package-files-no-maps.test.ts
git commit -F $S/msg-12.txt -- package.json build/inject.mjs build/inject.test.mjs build/verify-package.mjs build/verify-package.test.mjs src/__tests__/harness-inject.test.ts src/__tests__/harness-verify-package.test.ts src/__tests__/package-files-no-maps.test.ts
```

### Task 13: Cap the HowToSort try rows and the Sorted folders (spec F)

**Files:**
- Modify: `~/work/ac-ui/src/overlay/renderer/screens/Incoming/incoming-format.ts` (`cappedRows`, lines 81–95)
- Modify: `~/work/ac-ui/src/overlay/renderer/screens/Incoming/HowToSort.tsx` (imports, lines 5–18; hooks, before line 77; try results, lines 125–140)
- Modify: `~/work/ac-ui/src/overlay/renderer/screens/Incoming/SortedFolders.tsx` (imports, lines 7–11; `SortedFolders`, lines 88–135)
- Test: `~/work/ac-ui/src/__tests__/incoming-list-cap.test.tsx` (append)

**Interfaces:**
- Produces two overloads:
  - `cappedRows<T extends { id: string }>(rows: readonly T[], cap: number, pinned?: string): readonly T[]`
  - `cappedRows<T>(rows: readonly T[], cap: number, pinned: string | undefined, key: (row: T) => string): readonly T[]`

- [ ] **Step 1: Write the failing tests**

Append to `src/__tests__/incoming-list-cap.test.tsx`. Add these imports at the top:

```tsx
import { HowToSort } from '../overlay/renderer/screens/Incoming/HowToSort';
import { SortedFolders } from '../overlay/renderer/screens/Incoming/SortedFolders';
import type { SortedTreeNodeWire } from '../overlay/renderer/screens/Incoming/incoming-wire';
import type { IncomingState } from '../overlay/renderer/screens/Incoming/use-incoming';
```

```tsx
const folder = (i: number): SortedTreeNodeWire => ({
  name: `Folder ${i}`,
  relPath: `Folder ${i}`,
  files: 2,
  lastFile: null,
  createdBySorter: false,
  children: [],
});
const tree = (n: number) => ({
  root: '/Sorted',
  nodes: Array.from({ length: n }, (_, i) => folder(i)),
  truncated: false,
});

describe('Incoming list cap: try rows and Sorted folders', () => {
  it('cappedRows takes a key accessor for rows without an id', () => {
    const nodes = tree(10).nodes;
    const byPath = (n: SortedTreeNodeWire) => n.relPath;
    expect(cappedRows(nodes, 4, undefined, byPath)).toHaveLength(4);
    expect(
      cappedRows(nodes, 4, 'Folder 8', byPath).map((n) => n.relPath),
    ).toEqual(['Folder 0', 'Folder 1', 'Folder 2', 'Folder 3', 'Folder 8']);
  });

  it('Try results render the cap and page 200 more at a time', () => {
    const rows = jobs(LIST_CAP * 2 + 50, { state: 'waiting-text' });
    const incoming = {
      settings: { descriptionUpdatedAt: null },
      summary: { waiting: rows.length },
      draft: '',
      setDraft: jest.fn(),
      saving: false,
      trying: false,
      tryResult: { rows },
      preview: null,
      previewPending: false,
      dirty: false,
      canSave: false,
      handleSave: jest.fn(),
      handleTry: jest.fn(),
    } as unknown as IncomingState;
    render(<HowToSort incoming={incoming} firstSetup={false} />);
    const shown = () => screen.getAllByTestId('try-row');
    expect(shown()).toHaveLength(LIST_CAP);
    fireEvent.click(
      screen.getByRole('button', {
        name: `Show more · ${rows.length - LIST_CAP} not shown`,
      }),
    );
    expect(shown()).toHaveLength(LIST_CAP * 2);
    fireEvent.click(
      screen.getByRole('button', { name: 'Show more · 50 not shown' }),
    );
    expect(shown()).toHaveLength(rows.length);
  });

  it('exactly 200 Sorted folders: all shown, no button', () => {
    render(<SortedFolders tree={tree(LIST_CAP)} onOpenSorted={jest.fn()} />);
    expect(screen.getAllByTestId('sorted-tree-row')).toHaveLength(LIST_CAP);
    expect(
      screen.queryByRole('button', { name: /Show more/ }),
    ).not.toBeInTheDocument();
  });

  it('201 Sorted folders: 200 shown, the header still counts all of them', () => {
    render(
      <SortedFolders tree={tree(LIST_CAP + 1)} onOpenSorted={jest.fn()} />,
    );
    expect(screen.getAllByTestId('sorted-tree-row')).toHaveLength(LIST_CAP);
    expect(
      screen.getByText(`${LIST_CAP + 1} · ${(2 * (LIST_CAP + 1)).toLocaleString()} files`),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Show more · 1 not shown' }),
    );
    expect(screen.getAllByTestId('sorted-tree-row')).toHaveLength(
      LIST_CAP + 1,
    );
  });
});
```

Run: `cd ~/work/ac-ui && npx jest --config package.json src/__tests__/incoming-list-cap.test.tsx`
Expected: FAIL. ts-jest rejects the 4th `cappedRows` argument (TS2554), so the whole file fails to compile. Once that compiles, HowToSort renders 450 rows and SortedFolders renders 201.

- [ ] **Step 2: Give `cappedRows` a key accessor**

In `incoming-format.ts`, replace `cappedRows`:

```ts
/** The first `cap` rows, plus the `pinned` row (an attention target) when it
 *  sits past them. Display only: counts and bulk actions use the full list.
 *  Rows are matched by `id`, or by `key` for rows keyed otherwise (the
 *  Sorted tree keys on `relPath`). */
export function cappedRows<T extends { id: string }>(
  rows: readonly T[],
  cap: number,
  pinned?: string,
): readonly T[];
export function cappedRows<T>(
  rows: readonly T[],
  cap: number,
  pinned: string | undefined,
  key: (row: T) => string,
): readonly T[];
export function cappedRows<T>(
  rows: readonly T[],
  cap: number,
  pinned?: string,
  key: (row: T) => string = (row) => (row as unknown as { id: string }).id,
): readonly T[] {
  if (rows.length <= cap) return rows;
  const head = rows.slice(0, cap);
  if (pinned !== undefined && !head.some((r) => key(r) === pinned)) {
    const row = rows.find((r) => key(r) === pinned);
    if (row) head.push(row);
  }
  return head;
}
```

If eslint flags the overloads (`no-redeclare`/`import/export`), drop the two overload signatures and keep the implementation signature. In that case the test's key-accessor call still type-checks, because `T` is then unconstrained.

- [ ] **Step 3: Cap the Try rows**

In `HowToSort.tsx`:

(a) Add `TextButton,` to the `@shared/web-ui/ui` import, and change `import { dayMonth } from './incoming-format';` to `import { cappedRows, dayMonth, LIST_CAP } from './incoming-format';`.

(b) After the `const [choice, setChoice] = useState…` statement (before `if (settings === null) return null;`), add:

```tsx
  // A Try on thousands of waiting files renders the first LIST_CAP rows;
  // the rest page in on request, like the other Incoming lists.
  const [tryLimit, setTryLimit] = useState(LIST_CAP);
```

(c) Replace the `{tryResult && ( … )}` block with:

```tsx
      {tryResult && (
        <div className="inc-try" data-testid="try-results">
          {tryResult.rows.length === 0 ? (
            <p className="inc-empty">Nothing to preview.</p>
          ) : (
            <>
              <Rows aria-label="Try results">
                {cappedRows(tryResult.rows, tryLimit).map((row) => (
                  <Row
                    key={row.id}
                    data-testid="try-row"
                    title={row.name}
                    trail={describeTryRow(row)}
                  />
                ))}
              </Rows>
              {tryResult.rows.length > tryLimit && (
                <TextButton onClick={() => setTryLimit((n) => n + LIST_CAP)}>
                  Show more · {tryResult.rows.length - tryLimit} not shown
                </TextButton>
              )}
            </>
          )}
        </div>
      )}
```

- [ ] **Step 4: Cap the Sorted folders**

In `SortedFolders.tsx`, change the `./incoming-format` import to `import { cappedRows, dayWords, LIST_CAP } from './incoming-format';`. In `SortedFolders`, after `const files = …;` add:

```tsx
  // A Sorted root can hold up to 500 first-level folders; render the first
  // LIST_CAP and page the rest in. The header still counts every one.
  const [limit, setLimit] = useState(LIST_CAP);
  const shown = cappedRows(nodes, limit, undefined, (n) => n.relPath);
```

Then replace the `<ul className="inc-folds" …>…</ul>` branch with:

```tsx
        <>
          <ul
            className="inc-folds"
            data-testid="sorted-tree"
            aria-label="Folders"
          >
            {shown.map((node) => (
              <FolderRow key={node.relPath} node={node} now={now} />
            ))}
          </ul>
          {shown.length < nodes.length && (
            <TextButton onClick={() => setLimit((n) => n + LIST_CAP)}>
              Show more · {nodes.length - shown.length} not shown
            </TextButton>
          )}
        </>
```

- [ ] **Step 5: Run the cap suite and the Incoming suites**

```bash
cd ~/work/ac-ui
node build/apply-overlay.mjs
npx jest --config package.json src/__tests__/incoming-list-cap.test.tsx src/__tests__/incoming-view.test.tsx src/__tests__/incoming-page.test.ts src/__tests__/incoming-sorter-view.test.ts
```

Expected: PASS.

- [ ] **Step 6: Lint and commit**

```bash
cd ~/work/ac-ui
npx eslint --ext .ts,.tsx src/overlay/renderer/screens/Incoming/incoming-format.ts src/overlay/renderer/screens/Incoming/HowToSort.tsx src/overlay/renderer/screens/Incoming/SortedFolders.tsx src/__tests__/incoming-list-cap.test.tsx
printf '%s\n' 'perf(incoming): cap Try rows and Sorted folders at 200 with Show more' '' 'cappedRows gains a key accessor for rows keyed by relPath (#271).' > $S/msg-13.txt
git commit -F $S/msg-13.txt -- src/overlay/renderer/screens/Incoming/incoming-format.ts src/overlay/renderer/screens/Incoming/HowToSort.tsx src/overlay/renderer/screens/Incoming/SortedFolders.tsx src/__tests__/incoming-list-cap.test.tsx
```

### Task 14: Overlay gates

**Files:** none changed (fixes only, if a gate is red).

- [ ] **Step 1: Full overlay jest (heavy)**

Run: `cd ~/work/ac-ui && node build/apply-overlay.mjs && $H npx jest --config package.json`
Expected: all suites pass. Investigate any red suite this plan touched, and fix it in a commit of its own. Report a red suite that also fails on `0057c0bd` as baseline.

- [ ] **Step 2: Build-script harness (heavy)**

Run: `cd ~/work/ac-ui && $H node --test build/*.test.mjs`
Expected: all pass. This needs the four `extensions/*/node_modules` links from Task 6.

- [ ] **Step 3: Typechecks (heavy)**

Run: `cd ~/work/ac-ui && $H npx tsc -p tsconfig.typecheck.json && $H node build/typecheck-overlay.mjs`
Expected: both exit 0. typecheck-overlay reuses `build/.core`, because HEAD is at the pinned commit, and uses its symlinked `node_modules`.

- [ ] **Step 4: Lint**

Run: `cd ~/work/ac-ui && $H npx eslint --ext .js,.jsx,.ts,.tsx .`
Expected: exit 0.

- [ ] **Step 5: Hand off**

Report to the orchestrator: ac-ui `opt/ui` HEAD, every gate result, the Task 11 size table, and the post-merge live checks below that are still owed.

---

## Post-merge live checks (owed; not worktree tasks)

1. **Dev-app render counts (spec Goals):** after `opt/ui` merges into alpha-cent `dev`, in a dev app the founder is not recording with (see the shared-checkout restart hazard):
   - Temporarily wrap `<Sidebar />` and the App return in `<React.Profiler id=… onRender={…}>`, counting to `console.log` every 10 s. Leave this uncommitted.
   - Sit on **Settings** for 60 s during an account backfill. Record the App and Sidebar commits; expected 0 for feed-only pushes.
   - Repeat on Home, where commits should equal the pushes that changed a displayed count.
   - Revert the instrumentation.
2. **Package has no maps (package-wide):** the next product package in `~/work/ac-prod-build` runs `verify-package.mjs`, whose `assertNoSourceMaps` (Task 12) fails the build on any `*.map` anywhere in the app bundle or in `app.asar`. Confirm that its log shows `no source maps in …` for every artifact (mac `.app`, each Windows/Linux unpacked dir). Cross-check by hand: `npx asar list "<build>/mac-arm64/KIAgent.app/Contents/Resources/app.asar" | grep -c '\.map$'` prints `0`, and `find "<build>/mac-arm64/KIAgent.app" -name '*.map' | wc -l` prints `0`.
3. **Packaged smoke opens Transcripts** (spec D: chunk loading under CSP and `file://`). In the release smoke, or by hand in the packaged app, open Transcripts and confirm the list renders. No console error should mention a failed chunk load.

## Recorded screen sizes

(Filled in by Task 11, Step 6.)
