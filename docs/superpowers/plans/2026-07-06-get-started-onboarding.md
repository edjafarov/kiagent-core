# Get-Started Onboarding Checklist + Client Disconnect — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port alpha-cent's "Get started" 3-step checklist onto greenfield kiagent-core signals, plus a Disconnect button for connected MCP clients.

**Architecture:** Main process latches four nullable ISO timestamps into `AppPrefs.onboarding` via an idempotent `markOnboardingOnce`; the existing `push:app-state` prefs slice carries them to the renderer (no new IPC for the checklist). Disconnect adds one new IPC channel + a `disconnect` transform per client adapter.

**Tech Stack:** TypeScript, Electron (main), React (renderer), Jest.

**Spec:** `docs/superpowers/specs/2026-07-06-get-started-onboarding-design.md`

## Global Constraints

- Latches are "ever completed": nothing ever writes a latch back to null except nothing — no un-check paths. `dismissedAt` is set by the renderer Skip only.
- `core/` stays Electron-free: no Electron imports in `core/prefs.ts`, `core/mcp/registry.ts`, `core/mcp/clients.ts`, `core/mcp/server.ts`.
- No new IPC channels except `mcp:disconnect-client`.
- The stdio entry (`src/main/mcp/stdio-entry.ts`) must keep working unchanged — the new `attachToolHandlers` callback parameter must be optional.
- Step 1 shows NO percent/ETA (spec non-goal).
- Repo test command: `npm test -- <path>` (Jest). Typecheck: `npm run typecheck` if present, else `npx tsc --noEmit`.
- Commit messages end with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_019uWSRjNqDNAX1JQzshht8f`

---

### Task 1: `AppPrefs.onboarding` contract + prefs sanitize/merge + `markOnboardingOnce`

**Files:**
- Modify: `src/shared/contracts.ts` (AppPrefs, ~line 634)
- Modify: `src/main/core/prefs.ts`
- Test: `src/main/core/__tests__/prefs.test.ts` (extend existing)

**Interfaces:**
- Produces: `OnboardingPrefs` (exported from `@shared/contracts`), `AppPrefs.onboarding: OnboardingPrefs`, and `markOnboardingOnce(prefs: Prefs, key: keyof OnboardingPrefs, nowIso?: string): Promise<boolean>` exported from `src/main/core/prefs.ts`. Tasks 2 and 4 consume these.

- [ ] **Step 1: Read the two files, then write failing tests** appended to `src/main/core/__tests__/prefs.test.ts` (adapt to the file's existing harness — it already creates a Prefs against a temp dir; reuse that helper):

```ts
describe('onboarding prefs', () => {
  it('defaults all onboarding latches to null', () => {
    const p = makePrefs(); // reuse the existing test factory in this file
    expect(p.get().onboarding).toEqual({
      sourceBackfilledAt: null,
      mcpConnectedAt: null,
      firstQueryAt: null,
      dismissedAt: null,
    });
  });

  it('sanitizes garbage onboarding values to null and keeps valid strings', () => {
    // write a prefs.json containing onboarding: { sourceBackfilledAt: 42,
    // mcpConnectedAt: '', firstQueryAt: '2026-07-06T00:00:00.000Z' } via the
    // same on-disk seeding the existing sanitize tests use, then load.
    expect(loaded.onboarding.sourceBackfilledAt).toBeNull();
    expect(loaded.onboarding.mcpConnectedAt).toBeNull();
    expect(loaded.onboarding.firstQueryAt).toBe('2026-07-06T00:00:00.000Z');
    expect(loaded.onboarding.dismissedAt).toBeNull();
  });

  it('patch deep-merges onboarding without clobbering sibling latches', async () => {
    const p = makePrefs();
    await p.patch({ onboarding: { ...p.get().onboarding, mcpConnectedAt: 'A' } });
    await p.patch({ onboarding: { ...p.get().onboarding, firstQueryAt: 'B' } });
    expect(p.get().onboarding.mcpConnectedAt).toBe('A');
    expect(p.get().onboarding.firstQueryAt).toBe('B');
  });

  it('markOnboardingOnce sets when null, no-ops when set', async () => {
    const p = makePrefs();
    expect(await markOnboardingOnce(p, 'firstQueryAt', 'T1')).toBe(true);
    expect(await markOnboardingOnce(p, 'firstQueryAt', 'T2')).toBe(false);
    expect(p.get().onboarding.firstQueryAt).toBe('T1');
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npm test -- src/main/core/__tests__/prefs.test.ts` → FAIL (onboarding missing).

- [ ] **Step 3: Implement.** In `src/shared/contracts.ts`, immediately before `AppPrefs`:

```ts
/** Get-started checklist latches — nullable ISO timestamps, set once by the
 *  main process when each step's real signal fires. "Ever completed": a later
 *  disconnect/removal never un-checks a step. */
export interface OnboardingPrefs {
  sourceBackfilledAt: string | null; // step 1 — any account reaches 'live'
  mcpConnectedAt: string | null;     // step 2 — first MCP client connected
  firstQueryAt: string | null;       // step 3 — first tools/call served
  dismissedAt: string | null;        // manual Skip
}
```

and inside `AppPrefs` add the field `onboarding: OnboardingPrefs;`.

In `src/main/core/prefs.ts`:
- `DEFAULT_PREFS` gains `onboarding: { sourceBackfilledAt: null, mcpConnectedAt: null, firstQueryAt: null, dismissedAt: null },`
- add above `sanitize`:

```ts
function isoOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
```

- `sanitize` gains:

```ts
onboarding: {
  sourceBackfilledAt: isoOrNull(r.onboarding?.sourceBackfilledAt),
  mcpConnectedAt: isoOrNull(r.onboarding?.mcpConnectedAt),
  firstQueryAt: isoOrNull(r.onboarding?.firstQueryAt),
  dismissedAt: isoOrNull(r.onboarding?.dismissedAt),
},
```

- `patch` gains a merge branch alongside the existing ones: `onboarding: { ...current.onboarding, ...(p.onboarding ?? {}) },`
- new export at the bottom (import `OnboardingPrefs` type):

```ts
/** Idempotent onboarding latch: writes now() only if `key` is still null.
 *  Shared by every latch site (source-live, client-connect, first-query) —
 *  and by future ones (a remote-MCP OAuth grant handler calls this same
 *  helper), so "connected" stays one latch no matter which transport set it. */
export async function markOnboardingOnce(
  prefs: Prefs,
  key: keyof OnboardingPrefs,
  nowIso: string = new Date().toISOString(),
): Promise<boolean> {
  const cur = prefs.get().onboarding;
  if (cur[key] != null) return false;
  await prefs.patch({ onboarding: { ...cur, [key]: nowIso } });
  return true;
}
```

- [ ] **Step 4: Run tests** — `npm test -- src/main/core/__tests__/prefs.test.ts` → PASS. Also `npm test -- src/main/core` to catch fallout, and typecheck.
- [ ] **Step 5: Commit** — `feat(prefs): onboarding latch block + markOnboardingOnce`.

---

### Task 2: Latch hooks — `onCallOk` in registry, `McpDeps.onToolCall`, main.ts wiring

**Files:**
- Modify: `src/main/core/mcp/registry.ts` (`attachToolHandlers`, ~line 53)
- Modify: `src/main/core/mcp/server.ts` (`McpDeps` ~line 37; `attachToolHandlers` call ~line 144)
- Modify: `src/main/main.ts` (`mcp:connect-client` handler ~line 268; `startMcp` call ~line 384; `p.engine.project` callback ~line 511)
- Test: `src/main/core/mcp/__tests__/registry.test.ts` (new)

**Interfaces:**
- Consumes: `markOnboardingOnce` from Task 1.
- Produces: `attachToolHandlers(mcp, registry, logSink, onCallOk?: () => void)`; `McpDeps.onToolCall?: () => void`.

- [ ] **Step 1: Write failing test** `src/main/core/mcp/__tests__/registry.test.ts`. Stub the McpServer shape — `attachToolHandlers` only touches `mcp.server.setRequestHandler`:

```ts
import { attachToolHandlers, createToolRegistry } from '../registry';
import type { McpTool } from '@shared/contracts';

function capture() {
  const handlers: Array<(req: unknown) => Promise<unknown>> = [];
  const mcp = {
    server: { setRequestHandler: (_schema: unknown, fn: (req: unknown) => Promise<unknown>) => handlers.push(fn) },
  } as never;
  return { mcp, handlers }; // handlers[0] = tools/list, handlers[1] = tools/call
}
const logSink = { log: jest.fn() };

it('fires onCallOk exactly once per successful tool call', async () => {
  const ok: McpTool = { name: 't', description: '', inputSchema: {}, call: async () => ({ hi: 1 }) } as McpTool;
  const registry = createToolRegistry([ok]);
  const { mcp, handlers } = capture();
  const onCallOk = jest.fn();
  attachToolHandlers(mcp, registry, logSink as never, onCallOk);
  await handlers[1]({ params: { name: 't', arguments: {} } });
  expect(onCallOk).toHaveBeenCalledTimes(1);
});

it('does not fire onCallOk for unknown tools or throwing tools', async () => {
  const boom: McpTool = { name: 'boom', description: '', inputSchema: {}, call: async () => { throw new Error('x'); } } as McpTool;
  const registry = createToolRegistry([boom]);
  const { mcp, handlers } = capture();
  const onCallOk = jest.fn();
  attachToolHandlers(mcp, registry, logSink as never, onCallOk);
  await handlers[1]({ params: { name: 'nope', arguments: {} } });
  await handlers[1]({ params: { name: 'boom', arguments: {} } });
  expect(onCallOk).not.toHaveBeenCalled();
});
```

(Adapt `McpTool` construction / `createToolRegistry` signature to what registry.ts actually exports — read it first; the assertions are the requirement.)

- [ ] **Step 2: Run to verify failure** (extra-arg overload missing / callback never fired).

- [ ] **Step 3: Implement.**
  - `registry.ts`: `attachToolHandlers(mcp, registry, logSink, onCallOk?: () => void)`; in the success branch of the CallTool handler (after `const result = await tool.call(args);` and its log line), add `onCallOk?.();`. Doc comment: "onCallOk fires per successfully served tool call — the onboarding first-query latch rides it; optional so the stdio entry (separate process, no prefs access) passes nothing."
  - `server.ts`: `McpDeps` gains `/** Fires per successful tools/call served in-process (HTTP sessions). */ onToolCall?: () => void;`. The per-session attach becomes `attachToolHandlers(server, registry, deps.logSink, deps.onToolCall);`.
  - `main.ts`:
    - `startMcp({ query: ..., logSink: ..., dataDir, onToolCall: () => { void markOnboardingOnce(p.prefs, 'firstQueryAt'); } })` (import `markOnboardingOnce` from `./core/prefs`).
    - `mcp:connect-client` handler body becomes:
      ```ts
      await mcp?.connectClient(id);
      void markOnboardingOnce(p.prefs, 'mcpConnectedAt');
      ```
    - Right after `mcp = await startMcp(...)` add startup reconciliation:
      ```ts
      // Onboarding step 2 reconciliation: a client connected in an earlier
      // run (config file already carries our entry) counts as done.
      void mcp.clients().then((cs) => {
        if (cs.some((c) => c.connected)) void markOnboardingOnce(p.prefs, 'mcpConnectedAt');
      }).catch(() => {});
      ```
    - In the `p.engine.project(projection, (state, seq) => { ... })` callback, before the broadcast, add:
      ```ts
      // Onboarding step 1: any account that has ever reached 'live'. Also
      // covers startup — the projection's init() snapshot flows through here.
      if (state.accounts.some((a) => a.account.status === 'live'))
        void markOnboardingOnce(p.prefs, 'sourceBackfilledAt');
      ```
      Verify the projection's initial state actually flows through this callback on boot (check `engine.project` in `core/engine/engine.ts`); if it does NOT, add an explicit boot-time check after `bootCore`: read `p.store.read.accounts()` and latch if any status is `'live'`.

- [ ] **Step 4: Run** — `npm test -- src/main/core/mcp` → PASS; typecheck (confirms stdio-entry still compiles with the optional param).
- [ ] **Step 5: Commit** — `feat(onboarding): latch source-live, client-connect, first-query in main`.

---

### Task 3: Disconnect — adapter transform, server handle, IPC, LocalClients button

**Files:**
- Modify: `src/main/core/mcp/clients.ts` (`ClientAdapter`, `jsonAdapter`, `tomlAdapter`)
- Modify: `src/main/core/mcp/server.ts` (`McpServerHandle` + implementation)
- Modify: `src/shared/ipc.ts` (channel map ~line 210 + channel list ~line 330)
- Modify: `src/main/main.ts` (handler next to `mcp:connect-client`)
- Modify: `src/renderer/screens/Connection/LocalClients.tsx`
- Test: `src/main/core/mcp/__tests__/clients.test.ts` (new)

**Interfaces:**
- Produces: `ClientAdapter.disconnect(text: string | null): string`; `McpServerHandle.disconnectClient(id: string): Promise<void>`; IPC `'mcp:disconnect-client': { req: { id: string }; res: void }`.

- [ ] **Step 1: Write failing tests** `src/main/core/mcp/__tests__/clients.test.ts` using the exported `buildClientRegistry` (pure text transforms — no fs):

```ts
import { buildClientRegistry } from '../clients';

const registry = buildClientRegistry({
  localUrl: 'http://127.0.0.1:7421/mcp',
  stdioEntry: { command: '/x/app', args: ['/x/mcpStdio.js', '--db', '/x/kia.db'], env: { ELECTRON_RUN_AS_NODE: '1' } },
});

describe.each(registry.map((a) => [a.id, a] as const))('%s adapter', (_id, a) => {
  it('disconnect(connect(null)) round-trips to not-connected', () => {
    const connected = a.connect(null);
    expect(a.isConnected(connected)).toBe(true);
    const disconnected = a.disconnect(connected);
    expect(a.isConnected(disconnected)).toBe(false);
  });

  it('disconnect preserves foreign entries', () => {
    const withOurs = a.connect(a.id === 'codex'
      ? 'other_key = "keep"\n[mcp_servers.Other]\ncommand = "other"\n'
      : JSON.stringify(a.id === 'vscode'
          ? { servers: { Other: { url: 'http://other' } }, keep: true }
          : { mcpServers: { Other: { url: 'http://other' } }, keep: true }));
    const after = a.disconnect(withOurs);
    expect(a.isConnected(after)).toBe(false);
    expect(after).toContain('Other');
    expect(after).toContain('keep');
  });

  it('disconnect of a config without our entry is a no-op-shaped write', () => {
    expect(a.isConnected(a.disconnect(null))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure** (`disconnect` not a function).

- [ ] **Step 3: Implement.**
  - `ClientAdapter` gains `/** Return new config text with our entry removed (preserves everything else). */ disconnect(text: string | null): string;`
  - `jsonAdapter` gains:
    ```ts
    disconnect(text) {
      const root = parseJsonRoot(text); // throws on malformed — applyConfigChange catches, file untouched
      const container = { ...jsonContainer(root, containerKey) };
      delete container[SERVER_KEY];
      root[containerKey] = container;
      return `${JSON.stringify(root, null, 2)}\n`;
    },
    ```
  - `tomlAdapter` gains:
    ```ts
    disconnect(text) {
      const root = text && text.trim() ? (TOML.parse(text) as Record<string, unknown>) : {};
      const servers = { ...tomlServers(root) };
      delete servers[SERVER_KEY];
      root.mcp_servers = servers;
      return TOML.stringify(root as TOML.JsonMap);
    },
    ```
  - `server.ts` `McpServerHandle` gains `disconnectClient(id: string): Promise<void>;`, implemented next to `connectClient` (no stdio-entry-script guard needed — removal never writes a launch command):
    ```ts
    async disconnectClient(id: string) {
      const adapter = clientAdapters.find((a) => a.id === id);
      if (!adapter) throw new Error(`disconnectClient: unknown client '${id}'`);
      const result = applyConfigChange(adapter.configPath, (text) => adapter.disconnect(text));
      if (!result.ok) throw new Error(`disconnectClient(${id}): ${result.error}`);
      deps.logSink.log('mcp', 'info', `disconnected client ${id}`, { path: result.path, backup: result.backupPath });
    },
    ```
  - `shared/ipc.ts`: add `'mcp:disconnect-client': { req: { id: string }; res: void };` beside `mcp:connect-client` and the string to the channel allow-list.
  - `main.ts`: `handle('mcp:disconnect-client', async ({ id }) => { await mcp?.disconnectClient(id); });` — deliberately no onboarding write (latches never regress).
  - `LocalClients.tsx`: extract the shared busy pattern; connected branch becomes pill + button:
    ```tsx
    {c.connected ? (
      <>
        <Pill variant="live">Connected</Pill>
        <button
          type="button"
          className="btn sm"
          disabled={busyId === c.id}
          aria-label={`Disconnect ${c.name}`}
          onClick={() => void disconnect(c)}
        >
          Disconnect
        </button>
      </>
    ) : ( /* existing Connect button */ )}
    ```
    with `disconnect` mirroring `connect` (`mcp:disconnect-client`, same setBusyId/refresh-in-finally). Update the file's header comment — it currently documents the absence of a disconnect channel.

- [ ] **Step 4: Run** — `npm test -- src/main/core/mcp` → PASS; typecheck; lint if configured.
- [ ] **Step 5: Commit** — `feat(mcp): disconnect client — adapter transform, IPC, Connection button`.

---

### Task 4: GetStartedPanel + onboarding-steps derive + CSS + navigation threading

**Files:**
- Create: `src/renderer/screens/Sources/onboarding-steps.ts`
- Create: `src/renderer/screens/Sources/GetStartedPanel.tsx`
- Test: `src/renderer/screens/Sources/__tests__/onboarding-steps.test.ts`
- Modify: `src/renderer/screens/Sources/Sources.css` (append `.ob-*` block)
- Modify: `src/renderer/screen-registry.tsx` (pass `navigate` to Sources)
- Modify: `src/renderer/screens/Sources/index.tsx`, `SourcesList.tsx` (thread nav, mount panel)

**Interfaces:**
- Consumes: `OnboardingPrefs` from `@shared/contracts`; `useAppState`; IPC `prefs:patch`.
- Produces: `deriveOnboarding(onboarding: OnboardingPrefs): { step1Done; step2Done; step3Done; visible }`, `step1Meta(accounts: AppState['accounts'], done: boolean): string`.

- [ ] **Step 1: Write failing tests** `onboarding-steps.test.ts`:

```ts
import { deriveOnboarding, step1Meta } from '../onboarding-steps';

const none = { sourceBackfilledAt: null, mcpConnectedAt: null, firstQueryAt: null, dismissedAt: null };
const all = { sourceBackfilledAt: 'a', mcpConnectedAt: 'b', firstQueryAt: 'c', dismissedAt: null };

it('visible while any step is open, steps map from latches', () => {
  expect(deriveOnboarding(none)).toEqual({ step1Done: false, step2Done: false, step3Done: false, visible: true });
  expect(deriveOnboarding({ ...none, mcpConnectedAt: 'b' }).step2Done).toBe(true);
});
it('collapses when all three latch', () => {
  expect(deriveOnboarding(all).visible).toBe(false);
});
it('hidden when dismissed even with open steps', () => {
  expect(deriveOnboarding({ ...none, dismissedAt: 'd' }).visible).toBe(false);
});

const acct = (status: string) => ({ account: { status } as never, docCount: 0, recent: [] });
it('step1Meta variants', () => {
  expect(step1Meta([], false)).toMatch(/first source/i);
  expect(step1Meta([acct('backfilling')], false)).toMatch(/backfilling/i);
  expect(step1Meta([acct('pending')], false)).toMatch(/setting up/i);
  expect(step1Meta([acct('live')], true)).toBe('1 source connected');
  expect(step1Meta([acct('live'), acct('live')], true)).toBe('2 sources connected');
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement `onboarding-steps.ts`:**

```ts
import type { AppState, OnboardingPrefs } from '@shared/contracts';

export interface OnboardingDerived {
  step1Done: boolean;
  step2Done: boolean;
  step3Done: boolean;
  visible: boolean;
}

/** Pure mapping from the persisted latches to the checklist display state.
 *  Visible until every step latches or the user skips — the panel collapses
 *  on its own the moment the first successful MCP query lands. */
export function deriveOnboarding(onboarding: OnboardingPrefs): OnboardingDerived {
  const step1Done = onboarding.sourceBackfilledAt != null;
  const step2Done = onboarding.mcpConnectedAt != null;
  const step3Done = onboarding.firstQueryAt != null;
  return {
    step1Done,
    step2Done,
    step3Done,
    visible: onboarding.dismissedAt == null && !(step1Done && step2Done && step3Done),
  };
}

/** Meta line under "Add a source" — live status, deliberately no %/ETA
 *  (greenfield has no backfill total estimate; spec non-goal). */
export function step1Meta(accounts: AppState['accounts'], done: boolean): string {
  if (done) {
    const n = accounts.length;
    return n > 0 ? `${n} source${n === 1 ? '' : 's'} connected` : 'Source connected';
  }
  const status = accounts[0]?.account.status;
  if (status == null) return 'Connect your first source to start building your memory.';
  if (status === 'backfilling') return 'Backfilling — syncing your history…';
  return 'Setting up your first source…';
}
```

**Implement `GetStartedPanel.tsx`** (structure ported from alpha-cent main's `GetStartedPanel.tsx`, data source swapped to the pushed AppState):

```tsx
import React from 'react';
import { useAppState } from '@renderer/state/app-state';
import { Icon } from '@shared/web-ui/icon-sprite';
import { deriveOnboarding, step1Meta } from './onboarding-steps';

export function GetStartedPanel(props: {
  onOpenConnection: () => void;
}): React.ReactElement | null {
  const onboarding = useAppState((s) => s.prefs.onboarding);
  const accounts = useAppState((s) => s.accounts);
  const d = deriveOnboarding(onboarding);
  if (!d.visible) return null;

  const dismiss = (): void => {
    // Full-object patch: prefs.patch deep-merges, but sending the whole block
    // keeps the renderer honest about the Partial<AppPrefs> contract.
    void window.kiagent.invoke('prefs:patch', {
      onboarding: { ...onboarding, dismissedAt: new Date().toISOString() },
    });
  };

  return (
    <div className="ob-panel" data-testid="get-started-panel">
      <div className="ob-head">
        <div className="ob-head-text">
          <span className="ob-title">Get started with KIAgent</span>
          <span className="ob-sub">
            Add a source, connect your LLM, then try a query — that&rsquo;s it.
          </span>
        </div>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn sm" data-testid="onboarding-skip" onClick={dismiss}>
          Skip
        </button>
      </div>
      <div className="ob-checklist">
        <Step done={d.step1Done} label="Add a source" meta={step1Meta(accounts, d.step1Done)} testId="onboarding-step-source" />
        <Step
          done={d.step2Done}
          label="Connect your LLM"
          meta={d.step2Done ? 'LLM connected.' : 'Point Claude Code · Cursor · VS Code at KIAgent.'}
          testId="onboarding-step-mcp"
          action={d.step2Done ? undefined : (
            <button type="button" className="btn primary sm" data-testid="onboarding-open-connection" onClick={props.onOpenConnection}>
              Open Connection tab
              <Icon name="arrow-right" size={12} />
            </button>
          )}
        />
        <Step
          done={d.step3Done}
          label="Try a query"
          meta={d.step3Done ? 'First query received.' : 'Ask your connected LLM about your data.'}
          testId="onboarding-step-query"
        />
      </div>
    </div>
  );
}

function Step(props: {
  done: boolean;
  label: string;
  meta: string;
  testId: string;
  action?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className={`ob-step${props.done ? ' done' : ''}`} data-testid={props.testId} data-done={props.done}>
      <span className={`ob-step-icon${props.done ? ' done' : ''}`} aria-hidden>✓</span>
      <span className="ob-step-body">
        <span className="ob-step-label">{props.label}</span>
        <span className="ob-step-meta">{props.meta}</span>
      </span>
      {props.action}
    </div>
  );
}
```

(Verify `Icon`'s import path + `name="arrow-right"` against `@shared/web-ui/icon-sprite` — sprite id `i-arrow-right` exists; if the greenfield `Icon` API differs, match it. Verify `useAppState` selector usage against `SourcesList.tsx`.)

**Append to `Sources.css`** (checklist subset ported from alpha-cent; verify each `--var` exists in greenfield's tokens — the same names are used elsewhere in this file):

```css
/* Get-started onboarding checklist */
.ob-panel { display: flex; flex-direction: column; gap: 12px; margin-bottom: 16px; }
.ob-head { display: flex; align-items: flex-end; gap: 10px; }
.ob-head-text { display: flex; flex-direction: column; gap: 2px; }
.ob-title { font-size: var(--text-base); font-weight: 600; color: var(--text-primary); }
.ob-sub { font-size: var(--text-xs); color: var(--text-tertiary); }
.ob-checklist { background: var(--bg-surface); border: 1px solid var(--border-subtle); box-shadow: var(--shadow-xs); }
.ob-step { display: flex; align-items: center; gap: 10px; padding: 10px 14px; }
.ob-step + .ob-step { border-top: 1px solid var(--border-subtle); }
.ob-step-icon {
  flex-shrink: 0; width: 16px; height: 16px;
  display: flex; align-items: center; justify-content: center;
  border: 1.5px solid var(--text-tertiary); border-radius: 50%;
  background: transparent; color: transparent;
  font-size: 10px; line-height: 1;
}
.ob-step-icon.done { background: var(--accent-solid); border-color: var(--accent-solid); color: #fff; }
.ob-step.done .ob-step-label { color: var(--text-secondary); }
.ob-step-body { flex: 1; display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.ob-step-label { font-size: var(--text-base); color: var(--text-primary); }
.ob-step-meta { font-size: var(--text-xs); color: var(--text-tertiary); }
```

**Thread navigation + mount:**
- `screen-registry.tsx`: `sources: { factory: (_params, navigate) => <Sources onOpenConnection={() => navigate('connection')} />, usesTopBar: true },`
- `Sources/index.tsx`: `export function Sources(props: { onOpenConnection: () => void })` — pass through to `<SourcesList onOpenConnection={props.onOpenConnection} … />` (detail view unaffected).
- `SourcesList.tsx`: accept `onOpenConnection: () => void`; render `<GetStartedPanel onOpenConnection={props.onOpenConnection} />` as the first child of `.dash-body`, above the header row.

- [ ] **Step 4: Run** — `npm test -- src/renderer/screens/Sources` → PASS; typecheck; full suite `npm test` green.
- [ ] **Step 5: Commit** — `feat(onboarding): get-started checklist on Sources screen`.

---

### Final verification (whole branch)

- [ ] Full suite `npm test` + typecheck + lint.
- [ ] Whole-branch code review (subagent), fixes if needed.
- [ ] Append ledger entry to `.superpowers/sdd/progress.md`.
