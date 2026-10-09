# Window-first boot and dormant extension hosts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The main window opens without waiting for utility-process extensions (#140). Allowlisted, idle utility hosts are soft-stopped and woken on demand (#137).

**Architecture:** Part A splits `whenReady`'s tail into a pure `bootTail(deps)`. The tail runs: discovery → in-process (`unsafe.mainProcess`) start bounded at 5 s → window → `startBackground()`. The background chain resumes the accounts it can run now, starts the scheduler, then starts utility extensions. A `BootQueue` holds the accounts whose extension source has not registered yet and starts each one once when the source registers. Part B moves the source proxy set, and the tool/sender bindings, from the host incarnation to the host. An idle host can then kill its child while every registration stays in place. The first call of any kind wakes it through `ensureLive()`. Part C is the alpha-cent follow-up: SignIn waits for remote-mcp, the dev product config, the allowlist, and the core pin.

**Tech Stack:** TypeScript, Electron main process, jest (ts-jest), zod (product config), React 19 (overlay SignIn), `node --test` (alpha-cent build harness).

**Spec:** `/Users/edjafarov/work/kcore-boot/docs/superpowers/specs/2026-10-09-window-first-boot-and-dormant-hosts-design.md` (APPROVED rev 5; binding). Read it next to this plan.

**Repos:**
- Parts A and B: kiagent-core worktree `~/work/kcore-boot`, branch `opt/boot`, base `v0.106.0`.
- Part C: alpha-cent, executed later in a fresh alpha-cent worktree, after the core release that contains A+B. Every Part C task is marked **[alpha-cent]**.

## Global Constraints

- Tests/builds run SEQUENTIALLY only; full jest suites, builds and packaging go through `/private/tmp/claude-501/-Users-edjafarov-work-alpha-cent/4c50a2e2-79f9-4098-aef4-8a2c75761c3a/scratchpad/opt/heavy.sh <cmd>`. Targeted single jest files may run directly.
- Worktrees symlink node_modules/release/app deps to ~/work/kiagent-core; NEVER run `npm run build` or `npm ci` in a worktree (shared dist).
- Never git stash/amend/rebase/reset. Commit with `git commit -F <msgfile> -- <paths>`; no Co-Authored-By lines.
- `npm run lint` (or eslint on touched files) and `npx tsc --noEmit -p .` are gates.

Plan-wide conventions derived from those:
- **Commit message file.** Each commit block starts with `MSG=/private/tmp/claude-501/-Users-edjafarov-work-alpha-cent/4c50a2e2-79f9-4098-aef4-8a2c75761c3a/scratchpad/opt/boot-commit-msg.txt`. Shell state does not persist between tool calls, so run each block as one command, with that line included.
- **New files.** A new file must be `git add`ed before `git commit -F "$MSG" -- <paths>`, because a pathspec commit cannot pick up untracked files.
- **Targeted jest in core.** Run `npx jest <file>` from `~/work/kcore-boot`.
- **Full core suite.** Run `/private/tmp/claude-501/-Users-edjafarov-work-alpha-cent/4c50a2e2-79f9-4098-aef4-8a2c75761c3a/scratchpad/opt/heavy.sh npx jest`, called `heavy.sh npx jest` below.
- **Lint on touched files.** Run `npx eslint <files>`.
- **Typecheck.** Run `npx tsc --noEmit -p .`.
- **alpha-cent jest.** It needs `--config package.json`, for example `npx jest --config package.json src/__tests__/overlay-signin.test.tsx`.
- **Execution order.** Task order matters. Part A lands and passes on its own before Part B starts. Part C starts only after a core release that contains A+B.

### Cross-workstream note (record in the PR description)

Two parallel workstreams also edit `src/main/main.ts`:
- **sync:** MCP foreground enter/leave plus admission wiring.
- **db:** boot-time hooks around `pruneAttempts` and the scheduler.

To keep merges mechanical, this plan replaces only the `whenReady` tail. The tail runs from the old `// A broken extensions dir …` comment to the end of the `app.on('activate', …)` block. It becomes a call to `bootTail(deps)` (`src/main/boot-tail.ts`).

Edits outside the tail are each three lines or fewer. They are listed in Task A7 Step 1. Two consequences for the other workstreams:
- `p.scheduler.start()` is no longer a line in main.ts. On the normal path it is the `startScheduler` dep of `startBackground` (`src/main/core/boot-background.ts`), so the db workstream's "hooks around scheduler" must target `boot-background.ts` / the `startBackground({...})` deps.
- `p.store.pruneAttempts(...)` stays above the tail and is untouched.

## Review Focus

1. **A needs-consent connector whose consent is never granted.** Its boot-pending accounts stay queued silently: no `runAccount`, no `no source registered` line, no log spam. Pinned in Task A2 ("needs-consent keeps the queue, silently").
2. **A crash respawn registers the same source id a second time after its queue already drained.** No second dispatch. Pinned in Task A2 ("a re-registration after drain dispatches nothing").
3. **A worker respawn or a Reset all deactivates an enabled extension (status `'disabled'` with `enabled: true`) while its accounts are queued.** That is transient, so nothing is released. Only `enabled: false`, an uninstall or `'errored'` releases. Pinned in Task A2 ("transient disabled does not release").
4. **A call arrives while a host is mid-soft-stop (deactivate posted, child not yet exited).** It waits for the stop to finish, then wakes the host and gets its result. It never hits the dying endpoint. Pinned in Task B4 ("a call during the soft stop waits and then wakes").
5. **A user disables a dormant connector while a wake is in flight.** The waiting caller gets `extension is not running`, the kept registrations are disposed exactly once, and no live host is left behind. Pinned in Task B4 ("disable cancels a wake in flight").

## Spec ambiguities ruled on (binding for this plan)

1. **Re-reading an account.** `store.read.account(id)` does not exist (`store.read` is a `Query` with `accounts()` only), so the queue re-reads with `CoreStore.account(id)`, the call sync-now and the cadence tick already use.
2. **Unsubscribing from registrations.** The spec's `onRegister` / `offRegister` pair is a single `onRegister(cb): () => void`. The returned function is the off.
3. **`runOrQueue` input.** `runOrQueue(account, intent)` takes the `Account` its IPC handler already read. The handler keeps its own paused check and its `engine.resume` call.
4. **Tray Sync now (spec: explicit).** It keeps triggering the existing `source:*` cadence jobs (registered accounts), and in addition hands every non-worker, non-paused account to `BootQueue.syncPending(accounts)`, which calls `runOrQueue(account, 'explicit')` for each account whose source is boot-pending. So a tray Retry queues a `needsReauth` boot-pending account (or upgrades its queued auto entry) and it starts on registration. Accounts with a registered source are untouched by `syncPending` (their cadence job covers them), so nothing runs twice.
5. **Release on failure applies the same intent filter as registration.** Paused accounts are dropped, and auto entries for `needsReauth` accounts are dropped. Everything else goes through `runAccount`, which logs today's `no source registered` line.
6. **"disabled" means `enabled: false`.** This applies to both the queue release and the overlay SignIn gate. Status `'disabled'` while `enabled: true` is a transient deactivate during a worker respawn or a Reset all, and is ignored.
7. **Attention pins.** The surface exposes `attention.publish` / `attention.resolve`, with no "ask". Any `attention.*` call from the child pins the host. `events.on` and `files.watch` also pin. Pins are taken in host-process.ts's `endpoint.onCall`, not in host-surfaces.ts.
8. **A wake emits no `'activating'`.** The snapshot stays `activated` + `dormant: true` until the host is live again.
9. **Handshake retries during a wake keep the kept registrations.** Only an error, a crash-loop give-up or a hard stop disposes them.
10. **The kill switch is read in the platform.** `KIA_DORMANT_HOSTS=0` is read at each activation in extension-platform.ts, so it is unit-testable. main.ts passes `product.dormantExtensions` through unchanged.
11. **Boot timing lines go through electron-log's `log.info`.** The `[boot] window shown` line comes from the window's `showOnce`, which runs on ready-to-show or on the fallback.
12. **`KIA_TEST_HANG_EXT=<id>` hangs that utility connector until killed.** Its handshake times out and retries, exactly like a starved process. It is honoured only when `!app.isPackaged`.
13. **Allowlist scope (Part C).** The allowlist is the seven 15/30-minute connectors whose audit is clean. Exclusions:
    - `kia.google-calendar`: its 5-min cadence is no longer than `DORMANT_AFTER_MS`, so it would never idle.
    - `kia.slack`: the spec lists it as live (socket mode). The audit found no socket, but it stays out until that is verified on a live account.
    - `kia.telegram` and `kia.whatsapp`: live pulls.

---

# Part A — window does not wait for utility extensions (#140)

## File map (Part A)

| File | Change |
|---|---|
| `src/main/core/boot.ts` | `SourceRegistrations.onRegister`; `CorePlatform.sources` type; `resumeAccounts(platform, { defer })` |
| `src/main/core/boot-background.ts` (new) | `createBootQueue`, `startBackground` |
| `src/main/core/boot-timing.ts` (new) | `createBootTimer` (`[boot] <step> +<ms>` lines) |
| `src/main/boot-tail.ts` (new) | `bootTail(deps)`, `formatInProcess(report)` |
| `src/main/platform/extension-platform.ts` | `load()` marks enabled entries `'activating'`; `running` moves to start; `startInProcess()`, `startUtility()`, `whenSettled`, activation duration log, `hostTimeouts.handshakeRetryDelayMs` |
| `src/main/platform/transport.ts` | `createHungTransport()` |
| `src/main/factory-reset.ts` | `finishInterruptedReset` (no extension start); old name kept as a wrapper A4→A7, deleted in A7 |
| `src/main/main.ts` | tail → `bootTail`; ≤3-line touches listed in A7 |
| tests | `core/__tests__/source-registry.test.ts`, `core/__tests__/resume-accounts.test.ts` (new), `core/__tests__/boot-background.test.ts` (new), `core/__tests__/boot-timing.test.ts` (new), `__tests__/boot-tail.test.ts` (new), `platform/__tests__/helpers/platform-harness.ts` (new), `platform/__tests__/extension-platform-boot.test.ts` (new), `platform/__tests__/fixtures/ext-bundled-slow/` (new), `platform/__tests__/hung-transport.test.ts` (new), `__tests__/factory-reset.test.ts` |

---

### Task A1: Source registry `onRegister` + `resumeAccounts` defer hook

**Files:**
- Modify: `src/main/core/boot.ts:61-108` (SourceRegistry block), `:142-145` (CorePlatform.sources), `:402-427` (resumeAccounts)
- Test: `src/main/core/__tests__/source-registry.test.ts` (append), `src/main/core/__tests__/resume-accounts.test.ts` (create)

**Interfaces:**
- Produces:
  - `export interface SourceRegistrations { onRegister(cb: (sourceId: string) => void): () => void }`
  - `createSourceRegistry(): SourceRegistry & SourceRegistrations`
  - `CorePlatform.sources: SourceRegistry & SourceRegistrations`
  - `resumeAccounts(platform: CorePlatform, opts?: { defer?(account: Account): boolean; signal?: AbortSignal }): Promise<Map<string, Handle>>`. When `defer` returns true for an account whose source is not registered, that account is skipped silently, with no warn line. When `signal` is aborted, nothing more starts: it is checked after the account read and before each dispatch (spec: quit/reset halts the chain, no starts after abort).

- [ ] **Step 1: Write the failing tests**

Append to `src/main/core/__tests__/source-registry.test.ts`:

```ts
describe('createSourceRegistry — onRegister (#140)', () => {
  it('tells each listener the id of every registration, until it unsubscribes', () => {
    const sources = createSourceRegistry();
    const seen: string[] = [];
    const off = sources.onRegister((id) => seen.push(id));
    sources.register(src('gmail'));
    sources.register(src('gmail')); // a crash respawn re-registers: told again
    off();
    sources.register(src('imap'));
    expect(seen).toEqual(['gmail', 'gmail']);
  });

  it('a throwing listener never breaks registration or the other listeners', () => {
    const sources = createSourceRegistry();
    const seen: string[] = [];
    sources.onRegister(() => {
      throw new Error('boom');
    });
    sources.onRegister((id) => seen.push(id));
    sources.register(src('gmail'));
    expect(sources.get('gmail')).toBeDefined();
    expect(seen).toEqual(['gmail']);
  });
});
```

Create `src/main/core/__tests__/resume-accounts.test.ts`:

```ts
/** @jest-environment node */
import type { Account, AccountId } from '@shared/contracts';

import { resumeAccounts } from '../boot';
import type { CorePlatform } from '../boot';

function account(id: string, source: string, status: Account['status'] = 'live'): Account {
  return {
    id: id as AccountId,
    source,
    identifier: `${id}@example.com`,
    config: {},
    status,
    cursor: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

/** The slice of CorePlatform resumeAccounts → runAccount touches. */
function fakePlatform(accounts: Account[], registered: string[]) {
  const logs: string[] = [];
  const runs: string[] = [];
  const p = {
    store: { read: { accounts: async () => accounts } },
    sources: {
      get: (id: string) =>
        registered.includes(id) ? { descriptor: { id } } : undefined,
    },
    logSink: { log: (_s: string, _l: string, msg: string) => logs.push(msg) },
    engine: {
      run: (a: Account) => {
        runs.push(a.id);
        return {};
      },
    },
    scheduler: { register: jest.fn() },
  } as unknown as CorePlatform;
  return { p, logs, runs };
}

describe('resumeAccounts — defer (#140)', () => {
  it('runs registered sources and warns for unregistered ones, as before', async () => {
    const { p, logs, runs } = fakePlatform(
      [account('a1', 'gmail'), account('a2', 'kia.notion')],
      ['gmail'],
    );
    await resumeAccounts(p);
    expect(runs).toEqual(['a1']);
    expect(logs).toEqual([
      "account a2@example.com: source 'kia.notion' not registered — skipping",
    ]);
  });

  it('a deferred account is skipped silently; an undeferred one still warns', async () => {
    const { p, logs, runs } = fakePlatform(
      [account('a2', 'notion'), account('a3', 'gone')],
      [],
    );
    const deferred: string[] = [];
    await resumeAccounts(p, {
      defer: (a) => {
        if (a.source !== 'notion') return false;
        deferred.push(a.id);
        return true;
      },
    });
    expect(runs).toEqual([]);
    expect(deferred).toEqual(['a2']);
    expect(logs).toEqual([
      "account a3@example.com: source 'gone' not registered — skipping",
    ]);
  });

  it('an abort while the account read is unresolved starts nothing', async () => {
    const { p, runs } = fakePlatform([], ['gmail']);
    let release!: (a: Account[]) => void;
    (p.store.read as { accounts: () => Promise<Account[]> }).accounts = () =>
      new Promise<Account[]>((r) => (release = r));
    const ac = new AbortController();
    const resumed = resumeAccounts(p, { signal: ac.signal });
    ac.abort(); // quit / Reset all while the read is in flight
    release([account('a1', 'gmail')]);
    await expect(resumed).resolves.toEqual(new Map());
    expect(runs).toEqual([]);
  });

  it('an abort between dispatches stops the remaining accounts', async () => {
    const { p, runs } = fakePlatform(
      [account('a1', 'gmail'), account('a2', 'gmail')],
      ['gmail'],
    );
    const ac = new AbortController();
    (p.engine as { run: (a: Account) => unknown }).run = (a: Account) => {
      runs.push(a.id);
      ac.abort();
      return {};
    };
    await resumeAccounts(p, { signal: ac.signal });
    expect(runs).toEqual(['a1']);
  });

  it('never offers paused or needsReauth accounts to defer', async () => {
    const { p } = fakePlatform(
      [account('a1', 'notion', 'paused'), account('a2', 'notion', 'needsReauth')],
      [],
    );
    const defer = jest.fn(() => true);
    await resumeAccounts(p, { defer });
    expect(defer).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx jest src/main/core/__tests__/source-registry.test.ts src/main/core/__tests__/resume-accounts.test.ts`
Expected: FAIL. `sources.onRegister is not a function`, and `defer` is ignored, so the second test sees a warn for `notion`.

- [ ] **Step 3: Implement**

In `src/main/core/boot.ts`, after `export interface SourceRegistry { … }` add:

```ts
/** #140: told the id of every `register()` call — including a crash
 *  respawn's re-registration of the same id. The window-first boot queue
 *  starts boot-pending accounts from here. Returns the unsubscribe. */
export interface SourceRegistrations {
  onRegister(cb: (sourceId: string) => void): () => void;
}
```

Replace `createSourceRegistry`'s signature, its `register`, and add `onRegister`:

```ts
export function createSourceRegistry(): SourceRegistry & SourceRegistrations {
  const registry = new Map<string, Source>();
  const listeners = new Set<(sourceId: string) => void>();
  return {
    register(source) {
      registry.set(source.descriptor.id, source);
      for (const cb of [...listeners]) {
        try {
          cb(source.descriptor.id);
        } catch {
          // A listener never breaks a registration (or the next listener).
        }
      }
    },
    onRegister(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    get: (id) => registry.get(id),
    // … list() and unregister() unchanged …
```

In `interface CorePlatform` change `sources: SourceRegistry;` to `sources: SourceRegistry & SourceRegistrations;`.

Replace `resumeAccounts`:

```ts
/** Resume sync for every non-paused account and register cadence jobs.
 *  `defer` (#140): offered each account whose source is NOT registered yet;
 *  returning true means the caller queued it for that source's registration,
 *  so it is skipped without today's "not registered — skipping" line.
 *  `signal` (#140): once aborted (quit, interactive Reset all) nothing more
 *  starts — checked after the read and before every dispatch. */
export async function resumeAccounts(
  platform: CorePlatform,
  opts: { defer?(account: Account): boolean; signal?: AbortSignal } = {},
): Promise<Map<string, Handle>> {
  const handles = new Map<string, Handle>();
  const accounts = await platform.store.read.accounts();
  for (const account of accounts) {
    if (opts.signal?.aborted) break;
    if (account.source === 'worker') continue; // synthetic accounts don't sync
    if (account.status === 'paused') continue;
    // Same resting-state rule as the cadence tick: a needsReauth account
    // must not resume hammering a revoked credential at every boot.
    if (account.status === 'needsReauth') continue;
    if (!platform.sources.get(account.source)) {
      if (opts.defer?.(account)) continue;
      platform.logSink.log(
        'engine',
        'warn',
        `account ${account.identifier}: source '${account.source}' not registered — skipping`,
      );
      continue;
    }
    handles.set(account.id, runAccount(platform, account));
  }
  return handles;
}
```

- [ ] **Step 4: Run the tests to verify they pass, then typecheck**

Run: `npx jest src/main/core/__tests__/source-registry.test.ts src/main/core/__tests__/resume-accounts.test.ts`
Expected: PASS.

Run: `npx tsc --noEmit -p .`
Expected: clean, or only `Property 'onRegister' is missing` errors in test fakes typed as a full `CorePlatform['sources']`. For each such fake, add `onRegister: () => () => {},` and re-run until clean. Fakes cast through `as never` / `as unknown as CorePlatform` need nothing.

- [ ] **Step 5: Lint and commit**

Run: `npx eslint src/main/core/boot.ts src/main/core/__tests__/source-registry.test.ts src/main/core/__tests__/resume-accounts.test.ts`

```bash
MSG=/private/tmp/claude-501/-Users-edjafarov-work-alpha-cent/4c50a2e2-79f9-4098-aef4-8a2c75761c3a/scratchpad/opt/boot-commit-msg.txt
cd ~/work/kcore-boot
printf '%s\n' 'feat(core): source registry onRegister + resumeAccounts defer hook (#140)' > "$MSG"
git add src/main/core/__tests__/resume-accounts.test.ts
git commit -F "$MSG" -- src/main/core/boot.ts src/main/core/__tests__/source-registry.test.ts src/main/core/__tests__/resume-accounts.test.ts
```
(Add any test fake you touched in Step 4 to the path list.)

---

### Task A2: Boot queue and the background chain

**Files:**
- Create: `src/main/core/boot-background.ts`
- Test: `src/main/core/__tests__/boot-background.test.ts`

**Interfaces:**
- Consumes: `SourceRegistrations.onRegister` (A1); `resumeAccounts(p, { defer })` (A1, wired in A7).
- Produces:
  - `export type StartIntent = 'auto' | 'explicit'`
  - `export interface BootQueueDeps { readAccount(id: AccountId): Promise<Account | null>; isRegistered(sourceId: string): boolean; onRegister(cb: (sourceId: string) => void): () => void; runAccount(account: Account): void; log(level: 'info' | 'warn' | 'error', msg: string): void }`
  - `export interface BootQueue { arm(snapshot: readonly ExtensionSnapshot[]): void; defer(account: Account): boolean; runOrQueue(account: Account, intent: StartIntent): void; syncPending(accounts: readonly Account[]): void; onSnapshot(snapshot: readonly ExtensionSnapshot[]): void; stop(): void }`
  - `export function createBootQueue(deps: BootQueueDeps): BootQueue`
  - `export interface StartBackgroundDeps { resumeReady(signal: AbortSignal): Promise<void>; startScheduler(): void; startUtilityExtensions(): Promise<void>; mark(step: string, detail?: string): void; log(level: 'info' | 'warn' | 'error', msg: string): void; signal: AbortSignal }`
  - `export function startBackground(deps: StartBackgroundDeps): Promise<void>`. It never rejects.

- [ ] **Step 1: Write the failing tests**

Create `src/main/core/__tests__/boot-background.test.ts`:

```ts
/** @jest-environment node */
import type {
  Account,
  AccountId,
  ExtensionSnapshot,
  ExtensionStatus,
} from '@shared/contracts';

import {
  createBootQueue,
  startBackground,
  type BootQueueDeps,
} from '../boot-background';

function account(
  id: string,
  source: string,
  status: Account['status'] = 'live',
): Account {
  return {
    id: id as AccountId,
    source,
    identifier: `${id}@example.com`,
    config: {},
    status,
    cursor: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function ext(
  id: string,
  sourceIds: string[],
  status: ExtensionStatus = 'activating',
  enabled = true,
): ExtensionSnapshot {
  return {
    id,
    name: id,
    version: '1.0.0',
    origin: 'marketplace',
    enabled,
    status,
    caps: [],
    sourceIds,
    oauthSources: [],
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function harness(accounts: Account[]) {
  const db = new Map(accounts.map((a) => [a.id as string, a]));
  const registered = new Set<string>();
  const listeners = new Set<(id: string) => void>();
  const runs: string[] = [];
  const logs: string[] = [];
  const deps: BootQueueDeps = {
    readAccount: async (id) => db.get(id) ?? null,
    isRegistered: (sid) => registered.has(sid),
    onRegister: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    runAccount: (a) => runs.push(a.id),
    log: (_level, msg) => logs.push(msg),
  };
  const register = (sid: string) => {
    registered.add(sid);
    [...listeners].forEach((cb) => cb(sid));
  };
  return { deps, db, register, runs, logs, listeners };
}

describe('createBootQueue', () => {
  it('a late source resumes its queued accounts exactly once', async () => {
    const h = harness([account('a1', 'notion'), account('a2', 'notion')]);
    const q = createBootQueue(h.deps);
    q.arm([ext('kia.notion', ['notion'])]);
    expect(q.defer(account('a1', 'notion'))).toBe(true);
    expect(q.defer(account('a2', 'notion'))).toBe(true);
    expect(h.runs).toEqual([]);
    h.register('notion');
    await flush();
    expect(h.runs).toEqual(['a1', 'a2']);
  });

  it('a re-registration after drain dispatches nothing (crash respawn)', async () => {
    const h = harness([account('a1', 'notion')]);
    const q = createBootQueue(h.deps);
    q.arm([ext('kia.notion', ['notion'])]);
    q.defer(account('a1', 'notion'));
    h.register('notion');
    await flush();
    h.register('notion');
    await flush();
    expect(h.runs).toEqual(['a1']);
    expect(h.listeners.size).toBe(0); // nothing pending: unsubscribed
  });

  it('a removed or paused account is not resumed', async () => {
    const h = harness([account('a1', 'notion'), account('a2', 'notion')]);
    const q = createBootQueue(h.deps);
    q.arm([ext('kia.notion', ['notion'])]);
    q.defer(account('a1', 'notion'));
    q.defer(account('a2', 'notion'));
    h.db.delete('a1'); // removed while queued
    h.db.set('a2', account('a2', 'notion', 'paused')); // paused while queued
    h.register('notion');
    await flush();
    expect(h.runs).toEqual([]);
  });

  it('a slow extension delays only its own accounts', async () => {
    const h = harness([account('a1', 'notion'), account('b1', 'hubspot')]);
    const q = createBootQueue(h.deps);
    q.arm([ext('kia.notion', ['notion']), ext('kia.hubspot', ['hubspot'])]);
    q.defer(account('a1', 'notion'));
    q.defer(account('b1', 'hubspot'));
    h.register('hubspot'); // notion never registers
    await flush();
    expect(h.runs).toEqual(['b1']);
  });

  it('only declared, enabled, non-errored, unregistered sources are boot-pending', () => {
    const h = harness([]);
    h.register('gmail');
    const q = createBootQueue(h.deps);
    q.arm([
      ext('kia.a', ['a']),
      ext('kia.b', ['b'], 'errored'),
      ext('kia.c', ['c'], 'disabled', false),
      ext('bundled', ['gmail']),
    ]);
    expect(q.defer(account('x', 'a'))).toBe(true);
    expect(q.defer(account('x', 'b'))).toBe(false);
    expect(q.defer(account('x', 'c'))).toBe(false);
    expect(q.defer(account('x', 'gmail'))).toBe(false);
    expect(q.defer(account('x', 'nobody'))).toBe(false);
  });

  it('runOrQueue runs a registered or non-pending source now, writing nothing to the queue', () => {
    const h = harness([]);
    h.register('gmail');
    const q = createBootQueue(h.deps);
    q.arm([ext('kia.notion', ['notion'])]);
    q.runOrQueue(account('g', 'gmail'), 'explicit');
    q.runOrQueue(account('o', 'other'), 'explicit');
    expect(h.runs).toEqual(['g', 'o']);
  });

  it('sync-now on a boot-pending account starts nothing yet, so no "no source registered" error is written', () => {
    const h = harness([account('a1', 'notion')]);
    const q = createBootQueue(h.deps);
    q.arm([ext('kia.notion', ['notion'])]);
    q.runOrQueue(account('a1', 'notion'), 'explicit');
    expect(h.runs).toEqual([]); // runAccount → engine.run is what logs the error
  });

  it('a manual Retry on a needsReauth boot-pending account runs on registration', async () => {
    const h = harness([account('a1', 'notion', 'needsReauth')]);
    const q = createBootQueue(h.deps);
    q.arm([ext('kia.notion', ['notion'])]);
    q.runOrQueue(account('a1', 'notion', 'needsReauth'), 'explicit');
    h.register('notion');
    await flush();
    expect(h.runs).toEqual(['a1']);
  });

  it('an auto entry for a needsReauth account is dropped on registration', async () => {
    const h = harness([account('a1', 'notion')]);
    const q = createBootQueue(h.deps);
    q.arm([ext('kia.notion', ['notion'])]);
    q.defer(account('a1', 'notion'));
    h.db.set('a1', account('a1', 'notion', 'needsReauth'));
    h.register('notion');
    await flush();
    expect(h.runs).toEqual([]);
  });

  it('Resume of a paused account before registration runs it on registration', async () => {
    // accounts:resume has already committed 'connecting' via engine.resume.
    const h = harness([account('a1', 'notion', 'connecting')]);
    const q = createBootQueue(h.deps);
    q.arm([ext('kia.notion', ['notion'])]);
    q.runOrQueue(account('a1', 'notion', 'connecting'), 'explicit');
    h.register('notion');
    await flush();
    expect(h.runs).toEqual(['a1']);
  });

  it('tray Sync now queues boot-pending accounts as explicit and leaves the rest to cadence', async () => {
    const h = harness([
      account('a1', 'notion', 'needsReauth'),
      account('a2', 'notion', 'paused'),
      account('g1', 'gmail'),
    ]);
    h.register('gmail');
    const q = createBootQueue(h.deps);
    q.arm([ext('kia.notion', ['notion'])]);
    q.syncPending([
      account('a1', 'notion', 'needsReauth'),
      account('a2', 'notion', 'paused'),
      account('g1', 'gmail'),
      account('w', 'worker'),
    ]);
    expect(h.runs).toEqual([]); // gmail is the cadence job's, notion waits
    h.register('notion');
    await flush();
    expect(h.runs).toEqual(['a1']); // explicit: needsReauth retried; paused never
  });

  it('an explicit entry upgrades an auto one and is never downgraded', async () => {
    const h = harness([account('a1', 'notion', 'needsReauth')]);
    const q = createBootQueue(h.deps);
    q.arm([ext('kia.notion', ['notion'])]);
    q.runOrQueue(account('a1', 'notion', 'needsReauth'), 'explicit');
    expect(q.defer(account('a1', 'notion', 'needsReauth'))).toBe(true); // auto after explicit
    h.register('notion');
    await flush();
    expect(h.runs).toEqual(['a1']); // still explicit: needsReauth allowed
  });

  it.each([
    ['errored', ext('kia.notion', ['notion'], 'errored')],
    ['disabled', ext('kia.notion', ['notion'], 'disabled', false)],
  ])(
    'an entry %s before registering releases its queued accounts (auto and explicit) through runAccount',
    async (_why, after) => {
      const h = harness([account('a1', 'notion'), account('a2', 'notion')]);
      const q = createBootQueue(h.deps);
      q.arm([ext('kia.notion', ['notion'])]);
      q.defer(account('a1', 'notion'));
      q.runOrQueue(account('a2', 'notion'), 'explicit');
      q.onSnapshot([after]);
      await flush();
      expect(h.runs).toEqual(['a1', 'a2']);
      q.onSnapshot([after]); // released once
      await flush();
      expect(h.runs).toEqual(['a1', 'a2']);
    },
  );

  it('an uninstalled entry (absent from the snapshot) releases its accounts', async () => {
    const h = harness([account('a1', 'notion')]);
    const q = createBootQueue(h.deps);
    q.arm([ext('kia.notion', ['notion'])]);
    q.defer(account('a1', 'notion'));
    q.onSnapshot([]);
    await flush();
    expect(h.runs).toEqual(['a1']);
  });

  it('transient disabled does not release (enabled entry deactivated by a worker respawn or Reset all)', async () => {
    const h = harness([account('a1', 'notion')]);
    const q = createBootQueue(h.deps);
    q.arm([ext('kia.notion', ['notion'])]);
    q.defer(account('a1', 'notion'));
    q.onSnapshot([ext('kia.notion', ['notion'], 'disabled', true)]);
    await flush();
    expect(h.runs).toEqual([]);
  });

  it('needs-consent keeps the queue, silently', async () => {
    const h = harness([account('a1', 'notion')]);
    const q = createBootQueue(h.deps);
    q.arm([ext('kia.notion', ['notion'])]);
    q.defer(account('a1', 'notion'));
    q.onSnapshot([ext('kia.notion', ['notion'], 'needs-consent')]);
    await flush();
    expect(h.runs).toEqual([]);
    expect(h.logs).toEqual([]);
    h.register('notion'); // consent granted later → source registers → drains
    await flush();
    expect(h.runs).toEqual(['a1']);
  });

  it('after stop() nothing queued is ever started and runOrQueue falls back to runAccount', async () => {
    const h = harness([account('a1', 'notion')]);
    const q = createBootQueue(h.deps);
    q.arm([ext('kia.notion', ['notion'])]);
    q.defer(account('a1', 'notion'));
    q.stop();
    h.register('notion');
    q.onSnapshot([]);
    await flush();
    expect(h.runs).toEqual([]);
    expect(q.defer(account('a1', 'notion'))).toBe(false);
    q.runOrQueue(account('a1', 'notion'), 'explicit');
    expect(h.runs).toEqual(['a1']);
  });

  it('a failing re-read is logged and the next account still starts', async () => {
    const h = harness([account('a2', 'notion')]);
    const q = createBootQueue({
      ...h.deps,
      readAccount: async (id) => {
        if (id === 'a1') throw new Error('db gone');
        return h.db.get(id) ?? null;
      },
    });
    q.arm([ext('kia.notion', ['notion'])]);
    q.defer(account('a1', 'notion'));
    q.defer(account('a2', 'notion'));
    h.register('notion');
    await flush();
    expect(h.runs).toEqual(['a2']);
    expect(h.logs[0]).toMatch(/a1.*db gone/);
  });
});

describe('startBackground', () => {
  function deps(overrides: Partial<Parameters<typeof startBackground>[0]> = {}) {
    const calls: string[] = [];
    const ac = new AbortController();
    const d = {
      resumeReady: jest.fn(async () => {
        calls.push('resume');
      }),
      startScheduler: jest.fn(() => {
        calls.push('scheduler');
      }),
      startUtilityExtensions: jest.fn(async () => {
        calls.push('utility');
      }),
      mark: jest.fn((step: string) => {
        calls.push(`mark:${step}`);
      }),
      log: jest.fn(),
      signal: ac.signal,
      ...overrides,
    };
    return { d, calls, ac };
  }

  it('runs resume → scheduler → utility extensions, in that order', async () => {
    const { d, calls } = deps();
    await startBackground(d);
    expect(calls).toEqual([
      'resume',
      'scheduler',
      'mark:scheduler started',
      'utility',
      'mark:utility extensions started',
    ]);
  });

  it('hands its signal to resumeReady', async () => {
    const { d } = deps();
    await startBackground(d);
    expect(d.resumeReady).toHaveBeenCalledWith(d.signal);
  });

  it('abort halts the chain', async () => {
    const { d, calls, ac } = deps();
    d.resumeReady.mockImplementationOnce(async () => {
      calls.push('resume');
      ac.abort();
    });
    await startBackground(d);
    expect(calls).toEqual(['resume']);
  });

  it('a thrown step is logged and the chain goes on', async () => {
    const { d, calls } = deps();
    d.resumeReady.mockRejectedValueOnce(new Error('db busy'));
    await expect(startBackground(d)).resolves.toBeUndefined();
    expect(d.log).toHaveBeenCalledWith('error', 'boot: resume failed: db busy');
    expect(calls).toContain('scheduler');
    expect(calls).toContain('utility');
  });

  it('a never-settling utility start leaves the scheduler running and never rejects', async () => {
    const { d, calls } = deps({
      startUtilityExtensions: jest.fn(() => new Promise<void>(() => {})),
    });
    void startBackground(d);
    await flush();
    expect(calls).toEqual(['resume', 'scheduler', 'mark:scheduler started']);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/main/core/__tests__/boot-background.test.ts`
Expected: FAIL with `Cannot find module '../boot-background'`.

- [ ] **Step 3: Implement `src/main/core/boot-background.ts`**

```ts
/**
 * Window-first boot (#140): what runs AFTER the window exists.
 *
 * `createBootQueue` holds the accounts whose extension source has not
 * registered yet ("boot-pending": declared by a loaded, enabled, non-errored
 * extension) and starts each exactly once when that source registers — or,
 * when the owning extension errors, is disabled or uninstalled first, once
 * through today's path (`runAccount`, which logs today's `no source
 * registered` line). Every user-initiated start (sync-now, Resume) goes
 * through `runOrQueue`.
 *
 * `startBackground` is the post-window chain: resume what can run now,
 * start the scheduler, then start the utility-process extensions.
 *
 * Both are pure over injected deps — no Electron — so they unit-test directly.
 */
import type { Account, AccountId, ExtensionSnapshot } from '@shared/contracts';

export type StartIntent = 'auto' | 'explicit';
type Level = 'info' | 'warn' | 'error';

export interface BootQueueDeps {
  /** Re-reads one account at dispatch (CoreStore.account); null once removed. */
  readAccount(id: AccountId): Promise<Account | null>;
  isRegistered(sourceId: string): boolean;
  /** SourceRegistrations.onRegister — returns the unsubscribe. */
  onRegister(cb: (sourceId: string) => void): () => void;
  /** Today's start path (core/boot.ts runAccount). */
  runAccount(account: Account): void;
  log(level: Level, msg: string): void;
}

export interface BootQueue {
  /** Marks the boot-pending sources from the post-load() snapshot and starts
   *  listening for their registration. */
  arm(snapshot: readonly ExtensionSnapshot[]): void;
  /** resumeAccounts' `defer`: queues an automatic start for a boot-pending
   *  account and returns true; false leaves today's behaviour. */
  defer(account: Account): boolean;
  /** sync-now / Resume: runs now, or queues behind a boot-pending source
   *  (no error status written). */
  runOrQueue(account: Account, intent: StartIntent): void;
  /** Tray Sync now: `runOrQueue(account, 'explicit')` for every non-worker,
   *  non-paused account whose source is boot-pending; all others are left to
   *  their cadence job (the tray triggers those itself). */
  syncPending(accounts: readonly Account[]): void;
  /** The platform's snapshot (deps.onChange): releases the queue of an entry
   *  that errored, was disabled or was uninstalled before registering. */
  onSnapshot(snapshot: readonly ExtensionSnapshot[]): void;
  /** Quit / interactive factory reset: nothing queued is started afterwards. */
  stop(): void;
}

const message = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

export function createBootQueue(deps: BootQueueDeps): BootQueue {
  /** Boot-pending source id → the extension that declares it. */
  const pending = new Map<string, string>();
  /** Boot-pending source id → queued account ids with their strongest intent. */
  const queued = new Map<string, Map<AccountId, StartIntent>>();
  let off: (() => void) | null = null;
  let stopped = false;

  const isPending = (sourceId: string): boolean =>
    !stopped && pending.has(sourceId) && !deps.isRegistered(sourceId);

  function enqueue(account: Account, intent: StartIntent): void {
    let q = queued.get(account.source);
    if (!q) {
      q = new Map();
      queued.set(account.source, q);
    }
    // An explicit start upgrades a queued automatic one; never the reverse.
    if (q.get(account.id) !== 'explicit') q.set(account.id, intent);
  }

  /** Today's rules: nothing starts a paused account (Resume has already
   *  cleared it by the time it queues); an automatic start never retries a
   *  needsReauth account, the user's explicit Retry does. */
  function shouldStart(
    account: Account | null,
    intent: StartIntent,
  ): account is Account {
    if (!account || account.status === 'paused') return false;
    return intent === 'explicit' || account.status !== 'needsReauth';
  }

  async function dispatch(
    sourceId: string,
    why: 'registered' | 'released',
  ): Promise<void> {
    const q = queued.get(sourceId);
    queued.delete(sourceId);
    pending.delete(sourceId);
    if (pending.size === 0) {
      off?.();
      off = null;
    }
    if (!q) return;
    for (const [id, intent] of q) {
      if (stopped) return;
      try {
        // eslint-disable-next-line no-await-in-loop
        const fresh = await deps.readAccount(id);
        if (stopped) return;
        if (shouldStart(fresh, intent)) deps.runAccount(fresh);
      } catch (err) {
        deps.log(
          'error',
          `boot: account ${id} (${why} source '${sourceId}') did not start: ${message(err)}`,
        );
      }
    }
  }

  return {
    arm(snapshot) {
      if (stopped) return;
      for (const e of snapshot) {
        if (!e.enabled || e.status === 'errored') continue;
        for (const sourceId of e.sourceIds)
          if (!deps.isRegistered(sourceId)) pending.set(sourceId, e.id);
      }
      if (pending.size > 0 && !off)
        off = deps.onRegister((sourceId) => {
          if (pending.has(sourceId)) void dispatch(sourceId, 'registered');
        });
    },

    defer(account) {
      if (!isPending(account.source)) return false;
      enqueue(account, 'auto');
      return true;
    },

    runOrQueue(account, intent) {
      if (isPending(account.source)) {
        enqueue(account, intent);
        return;
      }
      deps.runAccount(account);
    },

    syncPending(accounts) {
      for (const account of accounts) {
        if (account.source === 'worker' || account.status === 'paused') continue;
        if (isPending(account.source)) enqueue(account, 'explicit');
      }
    },

    onSnapshot(snapshot) {
      if (stopped || pending.size === 0) return;
      const byId = new Map(snapshot.map((e) => [e.id, e]));
      for (const [sourceId, extensionId] of [...pending]) {
        const e = byId.get(extensionId);
        // Status 'disabled' while still enabled is a transient deactivate (a
        // DB-worker respawn re-activation, a Reset all) — not a release.
        // needs-consent keeps the queue: it drains when consent registers it.
        if (e && e.enabled && e.status !== 'errored') continue;
        if (deps.isRegistered(sourceId)) continue;
        void dispatch(sourceId, 'released');
      }
    },

    stop() {
      stopped = true;
      off?.();
      off = null;
      pending.clear();
      queued.clear();
    },
  };
}

export interface StartBackgroundDeps {
  /** Today's resume, restricted to registered sources (boot-pending ones
   *  queue through BootQueue.defer). Receives `signal` and must stop
   *  starting accounts once it aborts (resumeAccounts' `signal`). */
  resumeReady(signal: AbortSignal): Promise<void>;
  startScheduler(): void;
  /** Starts each utility-process extension; per extension, not awaited as a
   *  whole by anything the user waits on. */
  startUtilityExtensions(): Promise<void>;
  mark(step: string, detail?: string): void;
  log(level: Level, msg: string): void;
  /** Aborted on quit (before extensionsPlatform.stop()) and by an
   *  interactive factory reset. */
  signal: AbortSignal;
}

/** The post-window chain. Every step is logged, never rejects. */
export async function startBackground(deps: StartBackgroundDeps): Promise<void> {
  const step = async (name: string, run: () => unknown): Promise<boolean> => {
    if (deps.signal.aborted) return false;
    try {
      await run();
    } catch (err) {
      deps.log('error', `boot: ${name} failed: ${message(err)}`);
    }
    return !deps.signal.aborted;
  };
  if (!(await step('resume', () => deps.resumeReady(deps.signal)))) return;
  if (!(await step('scheduler start', () => deps.startScheduler()))) return;
  deps.mark('scheduler started');
  if (!(await step('utility extensions', () => deps.startUtilityExtensions())))
    return;
  // NOT "all settled": a host resolves start() as soon as a handshake retry
  // is merely scheduled. Settlement is decided from extension statuses by
  // BootTimer.armSettled (wired in main.ts's startUtilityExtensions).
  deps.mark('utility extensions started');
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx jest src/main/core/__tests__/boot-background.test.ts`
Expected: PASS (all).

- [ ] **Step 5: Lint, typecheck, commit**

Run: `npx eslint src/main/core/boot-background.ts src/main/core/__tests__/boot-background.test.ts && npx tsc --noEmit -p .`

```bash
MSG=/private/tmp/claude-501/-Users-edjafarov-work-alpha-cent/4c50a2e2-79f9-4098-aef4-8a2c75761c3a/scratchpad/opt/boot-commit-msg.txt
cd ~/work/kcore-boot
printf '%s\n' 'feat(core): boot queue + post-window background chain (#140)' > "$MSG"
git add src/main/core/boot-background.ts src/main/core/__tests__/boot-background.test.ts
git commit -F "$MSG" -- src/main/core/boot-background.ts src/main/core/__tests__/boot-background.test.ts
```

---

### Task A3: Extension platform — discovery shows "starting", in-process start bounded, utility start split

**Files:**
- Modify: `src/main/platform/extension-platform.ts`. Affected areas:
  - the `hostTimeouts` type (`:296-304`) and the `Entry` interface (`:322-339`);
  - the `ExtensionPlatform` interface (`:368-426`) and the `running` handling (`:506-526`);
  - `setStatus` (`:617-631`) and `activate()` (`:842-1063`);
  - `loadEntries` (`:1089-1160`) and the returned `load`/`start` (`:1232-1272`).
- Create: `src/main/platform/__tests__/helpers/platform-harness.ts`; `src/main/platform/__tests__/fixtures/ext-bundled-slow/{manifest.json,index.js}`; `src/main/platform/__tests__/extension-platform-boot.test.ts`

**Interfaces:**
- Produces:
  - `export const IN_PROCESS_READY_MS = 5_000`
  - `export interface InProcessStartReport { activatedMs: Record<string, number>; pending: string[] }`
  - `ExtensionPlatform.startInProcess(opts?: { boundMs?: number }): Promise<InProcessStartReport>`. It starts the enabled `unsafe.mainProcess` entries and resolves once each has left `'activating'`, or at the bound. Activation continues in the background past the bound.
  - `ExtensionPlatform.startUtility(signal?: AbortSignal): Promise<void>`. It starts every enabled entry that is not in-process, and resolves when each `activate()` has returned. The boot signal (quit / interactive Reset all) is propagated into those activations:
    - a queued activation whose turn comes after the abort is skipped;
    - a pending activation's own controller (`e.activation`) is aborted the moment the boot signal aborts, which cancels the `prepare` call it is awaiting;
    - after the consent/preparation awaits, the existing pre-spawn check (`activation.signal.aborted || e.host !== host || !e.enabled`, with no `await` between it and `host.start()`) stops the reserved host instead of spawning it.
    - `activate(e, bootSignal?)` gains that optional second parameter; every other caller (`setEnabled`, worker respawn, install, `start()`, `startInProcess()`) passes none and is unchanged.
  - `ExtensionPlatform.start()` is unchanged in meaning: it starts every enabled entry.
  - `ExtensionPlatformDeps.hostTimeouts.handshakeRetryDelayMs?(attempt: number): number`, passed through to the host.
  - Internal `whenSettled(id, timeoutMs): Promise<boolean>`. It resolves true when entry `id` is absent or its status is not `'activating'`, and false at the timeout.
  - A `load()` snapshot shows enabled entries as `status: 'activating'` and disabled ones as `'disabled'`.
  - `createHarness()` in `__tests__/helpers/platform-harness.ts`, reused by Part B.

- [ ] **Step 1: Create the slow bundled fixture**

`src/main/platform/__tests__/fixtures/ext-bundled-slow/manifest.json`:
```json
{
  "id": "test.bundled-slow",
  "name": "Bundled Slow Test Extension",
  "version": "1.0.0",
  "engine": "^2.0.0",
  "entry": "index.js",
  "caps": ["unsafe.mainProcess"],
  "contributes": { "tools": ["slow.probe"], "senders": [] }
}
```

`src/main/platform/__tests__/fixtures/ext-bundled-slow/index.js`:
```js
/** In-process fixture whose FIRST activation is slow by a test-controlled
 *  amount. The control object arrives as `extras.mainProcess.slowFirstActivate`
 *  (the platform's `mainApi` dep), shared by reference with the test: the
 *  module is loaded through native Module._load (not Jest's VM, so Jest's
 *  globalThis is not visible here) and the in-process tier busts its require
 *  cache on every exit, so module state cannot carry "already slowed once". */
module.exports = {
  async activate(_host, extras) {
    const slow =
      extras && extras.mainProcess ? extras.mainProcess.slowFirstActivate : null;
    if (slow && slow.ms) {
      const ms = slow.ms;
      slow.ms = 0;
      await new Promise((r) => setTimeout(r, ms));
    }
    return {
      sources: [],
      tools: [
        {
          name: 'slow.probe',
          description: 'probe',
          inputSchema: { type: 'object' },
          async call() {
            return { ok: true };
          },
        },
      ],
    };
  },
};
```

- [ ] **Step 2: Create the shared harness**

`src/main/platform/__tests__/helpers/platform-harness.ts`:
```ts
/** Shared harness for the #140/#137 platform suites: a real store, fake
 *  source/sender/tool registries, and the real child runtime over in-memory
 *  pairs (one fresh pair per spawn — exactly what a wake needs). */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type {
  ExtensionSnapshot,
  McpTool,
  Sender,
  Source,
} from '@shared/contracts';
import { openDb } from '@main/db/app-db';
import { openStore, type CoreStore } from '@main/core/store/store';

import {
  createExtensionPlatform,
  type ExtensionPlatform,
  type ExtensionPlatformDeps,
} from '../../extension-platform';
import { runExtensionHost } from '../../extension-host-entry';
import { createInMemoryHostPair } from '../../transport';

export const FIXTURES = path.join(__dirname, '..', 'fixtures');

export async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('waitFor timed out');
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 10));
  }
}

export interface PlatformHarness {
  tmp: string;
  store: CoreStore;
  registry: Map<string, Source>;
  tools: Map<string, McpTool>;
  logs: Array<{ scope: string; level: string; msg: string }>;
  snapshots: ExtensionSnapshot[][];
  /** transportFactory (utility-process) spawns, per extension id. */
  spawns: Map<string, number>;
  counts: { registerTool: number };
  scheduler: { register: jest.Mock; unregister: jest.Mock };
  make(overrides?: Partial<ExtensionPlatformDeps>): ExtensionPlatform;
  /** Copies a fixture into <tmp>/bundled and returns that bundledDir. */
  copyBundled(fixture: string): string;
  /** installPreview + installCommit through `platform`; returns the id. */
  install(platform: ExtensionPlatform, fixture: string): Promise<string>;
  close(): Promise<void>;
}

export async function createHarness(): Promise<PlatformHarness> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kia-boot-'));
  const store = openStore(await openDb(path.join(tmp, 'kiagent.db')), {
    encrypt: (s) => Buffer.from(s, 'utf8'),
    decrypt: (b) => b.toString('utf8'),
    detectLanguages: () => [],
  });
  const registry = new Map<string, Source>();
  const senders = new Map<string, Sender>();
  const tools = new Map<string, McpTool>();
  const logs: PlatformHarness['logs'] = [];
  const snapshots: ExtensionSnapshot[][] = [];
  const spawns = new Map<string, number>();
  const counts = { registerTool: 0 };
  const scheduler = { register: jest.fn(), unregister: jest.fn() };
  const h: PlatformHarness = {
    tmp,
    store,
    registry,
    tools,
    logs,
    snapshots,
    spawns,
    counts,
    scheduler,
    make: (overrides = {}) =>
      createExtensionPlatform({
        extDir: path.join(tmp, 'extensions'),
        store,
        attention: {
          publish: async () => ({ rejected: [] }),
          resolve: async () => ({ rejected: [] }),
        } as never,
        sources: {
          register: (s: Source) => void registry.set(s.descriptor.id, s),
          get: (id: string) => registry.get(id),
          list: () => [...registry.values()].map((s) => s.descriptor),
          unregister: (id: string) => void registry.delete(id),
        },
        senders: {
          register: (id: string, s: Sender) => void senders.set(id, s),
          get: (id: string) => senders.get(id),
          ids: () => [...senders.keys()],
          unregister: (id: string) => void senders.delete(id),
        },
        scheduler: {
          ...scheduler,
          jobs: jest.fn(async () => []),
          trigger: jest.fn(),
          env: {},
        } as never,
        registerTool: (t) => {
          counts.registerTool += 1;
          tools.set(t.name, t);
          return () => tools.delete(t.name);
        },
        inference: {
          complete: async () => '',
          see: async () => '',
          read: async () => '',
          hear: async () => '',
          describe: async () => null,
        },
        laneState: () => 'open',
        logSink: {
          log: (scope: string, level: string, msg: string) =>
            logs.push({ scope, level, msg }),
        } as never,
        notify: jest.fn(),
        transportFactory: (id) => {
          spawns.set(id, (spawns.get(id) ?? 0) + 1);
          const pair = createInMemoryHostPair();
          runExtensionHost(pair.child, { exit: (c) => pair.simulateExit(c) });
          return pair.main;
        },
        onChange: (snap) => snapshots.push(snap),
        ...overrides,
      }),
    copyBundled: (fixture) => {
      const bundledDir = path.join(tmp, 'bundled');
      fs.cpSync(path.join(FIXTURES, fixture), path.join(bundledDir, fixture), {
        recursive: true,
      });
      return bundledDir;
    },
    install: async (platform, fixture) => {
      const preview = await platform.installPreview(fixture);
      if (!('token' in preview)) throw new Error(JSON.stringify(preview));
      const result = await platform.installCommit(preview.token);
      if (!result.ok || !result.id) throw new Error(result.error);
      return result.id;
    },
    close: async () => {
      await store.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    },
  };
  return h;
}
```

- [ ] **Step 3: Write the failing tests**

`src/main/platform/__tests__/extension-platform-boot.test.ts`:
```ts
/** @jest-environment node */
import fs from 'fs';
import path from 'path';

import type { ExtensionPlatform } from '../extension-platform';
import { writeEnabledState } from '../extensions';
import {
  createHarness,
  FIXTURES,
  waitFor,
  type PlatformHarness,
} from './helpers/platform-harness';

describe('extension platform boot split (#140)', () => {
  let h: PlatformHarness;
  let platform: ExtensionPlatform | null = null;
  const status = (id: string) =>
    platform!.snapshot().find((e) => e.id === id)?.status;

  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    await platform?.stop();
    platform = null;
    await h.close();
  });

  /** test.basic installed (consented) through a first platform, then stopped. */
  async function installBasic(): Promise<void> {
    const first = h.make();
    await first.start();
    await h.install(first, path.join(FIXTURES, 'ext-basic'));
    await first.stop();
    h.registry.clear();
    h.tools.clear();
    h.counts.registerTool = 0;
    h.spawns.clear(); // the install spawned test.basic once; count from here
  }

  it('load() shows enabled entries as activating, disabled ones as disabled, and activates none', async () => {
    const bundledDir = h.copyBundled('ext-bundled');
    h.copyBundled('ext-bundled-slow');
    fs.mkdirSync(path.join(h.tmp, 'extensions'), { recursive: true });
    writeEnabledState(path.join(h.tmp, 'extensions'), {
      'test.bundled-slow': { enabled: false },
    });
    platform = h.make({ bundledDir });
    await platform.load();
    expect(status('test.bundled')).toBe('activating');
    expect(status('test.bundled-slow')).toBe('disabled');
    expect(h.counts.registerTool).toBe(0);
  });

  it('startInProcess() activates only unsafe.mainProcess entries; startUtility() starts the rest', async () => {
    await installBasic();
    platform = h.make({ bundledDir: h.copyBundled('ext-bundled') });
    await platform.load();
    const report = await platform.startInProcess();
    expect(report.pending).toEqual([]);
    expect(Object.keys(report.activatedMs)).toEqual(['test.bundled']);
    expect(status('test.bundled')).toBe('activated');
    expect(status('test.basic')).toBe('activating');
    expect(h.registry.has('basicsrc')).toBe(false);
    expect(h.spawns.get('test.basic')).toBeUndefined();

    await platform.startUtility();
    expect(status('test.basic')).toBe('activated');
    expect(h.registry.has('basicsrc')).toBe(true);
  });

  it('startInProcess() returns at the bound when a first handshake times out; the retry activates later', async () => {
    platform = h.make({
      bundledDir: h.copyBundled('ext-bundled-slow'),
      // extras.mainProcess for unsafe.mainProcess entries (extension-platform
      // passes deps.mainApi to the in-process runtime).
      mainApi: { slowFirstActivate: { ms: 400 } },
      hostTimeouts: { activateTimeoutMs: 100, handshakeRetryDelayMs: () => 300 },
    });
    await platform.load();
    const t0 = Date.now();
    const report = await platform.startInProcess({ boundMs: 150 });
    expect(Date.now() - t0).toBeLessThan(380);
    expect(report.pending).toEqual(['test.bundled-slow']);
    expect(status('test.bundled-slow')).toBe('activating');
    expect(
      h.logs.some((l) => /still activating.*test\.bundled-slow/.test(l.msg)),
    ).toBe(true);
    await waitFor(() => status('test.bundled-slow') === 'activated', 3000);
    expect(h.tools.has('slow.probe')).toBe(true);
  });

  it('logs how long each activation took', async () => {
    platform = h.make({ bundledDir: h.copyBundled('ext-bundled') });
    await platform.load();
    await platform.startInProcess();
    expect(
      h.logs.some(
        (l) =>
          l.scope === 'extension:test.bundled' &&
          /^activated in \d+ ms$/.test(l.msg),
      ),
    ).toBe(true);
  });

  it('startUtility(signal): an abort during an unresolved consent read starts no transport', async () => {
    await installBasic();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let consentReads = 0;
    // The store with consents.latest held until `release` (Proxy keeps every
    // other store method bound to the real store).
    const gatedStore = new Proxy(h.store, {
      get(target, key, receiver) {
        if (key !== 'consents') return Reflect.get(target, key, receiver);
        const consents = target.consents;
        return new Proxy(consents, {
          get(c, k, r) {
            if (k !== 'latest') return Reflect.get(c, k, r);
            return async (id: string) => {
              consentReads += 1;
              await gate;
              return c.latest(id);
            };
          },
        });
      },
    });
    platform = h.make({ store: gatedStore });
    await platform.load();
    const ac = new AbortController();
    const started = platform.startUtility(ac.signal);
    await waitFor(() => consentReads > 0); // test.basic is mid-consent-read
    ac.abort(); // quit / Reset all
    release();
    await started;
    expect(h.spawns.get('test.basic')).toBeUndefined();
    expect(h.registry.has('basicsrc')).toBe(false);
  });

  it('startUtility(signal) already aborted spawns nothing (queued activations are skipped)', async () => {
    await installBasic();
    platform = h.make();
    await platform.load();
    const ac = new AbortController();
    ac.abort();
    await platform.startUtility(ac.signal);
    expect(h.spawns.get('test.basic')).toBeUndefined();
    expect(status('test.basic')).toBe('activating'); // never touched
  });

  it('a DB-worker respawn after load() but before any start activates nothing', async () => {
    let respawn: (() => void) | undefined;
    platform = h.make({
      bundledDir: h.copyBundled('ext-bundled'),
      db: {
        onWorkerRespawn: (cb: () => void) => {
          respawn = cb;
          return () => {};
        },
      } as never,
    });
    await platform.load();
    respawn!();
    await new Promise((r) => setTimeout(r, 50));
    expect(status('test.bundled')).toBe('activating');
    expect(h.counts.registerTool).toBe(0);
  });
});
```

- [ ] **Step 4: Run to verify failure**

Run: `npx jest src/main/platform/__tests__/extension-platform-boot.test.ts`
Expected: FAIL. `load()` shows `'disabled'` for enabled entries, `startInProcess is not a function`, and `hostTimeouts.handshakeRetryDelayMs` is a TS error.

- [ ] **Step 5: Implement in `extension-platform.ts`**

(a) After `IN_PROCESS_KILL_AFTER_MS` add:
```ts
/** #140: the most the window waits for in-process (`unsafe.mainProcess`)
 *  entries to report 'activated'. Activation keeps going past it. */
export const IN_PROCESS_READY_MS = 5_000;

export interface InProcessStartReport {
  /** ms from startInProcess() to 'activated', per entry that made it. */
  activatedMs: Record<string, number>;
  /** Entries still 'activating' at the bound. */
  pending: string[];
}
```

(b) `HostDeps.handshakeRetryDelayMs?(attempt)` already exists in host-process.ts (`:117`, used at `:426` as `(deps.handshakeRetryDelayMs ?? handshakeRetryDelayMs)(handshakeTimeouts)`), and `activate()` already spreads `...deps.hostTimeouts` into `createExtensionHost`. Only the platform-side type is missing. In `hostTimeouts?: {…}` add:
```ts
    /** Backoff before handshake-retry `attempt` (test seam; default 10 s ×3). */
    handshakeRetryDelayMs?(attempt: number): number;
```

(c) In `interface Entry` add:
```ts
  /** When the current activation began — for the "activated in" log line. */
  activationStartedAt?: number;
```

(d) In `interface ExtensionPlatform`, after `start(): Promise<void>;` add:
```ts
  /** #140: starts the enabled in-process (`unsafe.mainProcess`) entries and
   *  resolves once each has left 'activating' — or at `boundMs` (default
   *  IN_PROCESS_READY_MS), logging the ones still pending. Never awaits a
   *  handshake retry; activation continues in the background. */
  startInProcess(opts?: { boundMs?: number }): Promise<InProcessStartReport>;
  /** #140: starts every enabled utility-process entry (all but in-process).
   *  Resolves when each activate() returned. `signal` (the boot chain's):
   *  once aborted, nothing further spawns — queued activations are skipped
   *  and pending ones cancelled before host.start(). */
  startUtility(signal?: AbortSignal): Promise<void>;
```

(e) Just after `const changed = () => deps.onChange(snapshot());` add the settle watchers:
```ts
  /** Re-checked on every status change: the waiters behind whenSettled. */
  const statusWatchers = new Set<() => void>();

  /** Resolves true once entry `id` is gone or no longer 'activating';
   *  false at `timeoutMs`. */
  function whenSettled(id: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (settled: boolean) => {
        if (timer) clearTimeout(timer);
        statusWatchers.delete(check);
        resolve(settled);
      };
      function check(): void {
        if (entries.get(id)?.status !== 'activating') done(true);
      }
      statusWatchers.add(check);
      timer = setTimeout(() => done(false), timeoutMs);
      timer.unref?.();
      check();
    });
  }
```

(f) Replace `setStatus` with:
```ts
  const setStatus = (e: Entry, status: ExtensionStatus, error?: string) => {
    if (status === 'activated' && e.status !== 'activated') {
      e.activatedAt = new Date().toISOString();
      if (e.activationStartedAt !== undefined)
        deps.logSink.log(
          `extension:${e.manifest.id}`,
          'info',
          `activated in ${Date.now() - e.activationStartedAt} ms`,
        );
    }
    // The status is otherwise only visible to the renderer; a failed
    // activation must leave a trace in the log.
    if (status === 'errored' && (e.status !== 'errored' || e.error !== error))
      deps.logSink.log(
        `extension:${e.manifest.id}`,
        'error',
        `extension errored: ${error ?? 'unknown error'}`,
      );
    e.status = status;
    e.error = error;
    changed();
    for (const check of [...statusWatchers]) check();
  };
```

(g) In `activate()`:
- change the signature to `async function activate(e: Entry, bootSignal?: AbortSignal): Promise<void> {`;
- immediately after `e.host = host;` add `e.activationStartedAt = Date.now();`;
- immediately after `e.activation = activation;` (`:1008`) add the boot-signal link:
  ```ts
    // #140: quit / interactive Reset all during consent or preparation must
    // never be followed by a spawn. Aborting this activation's controller
    // cancels `prepare`, and the pre-spawn check below (no await between it
    // and host.start()) stops the reserved host instead of starting it.
    const onBootAbort = () => activation.abort();
    if (bootSignal?.aborted) activation.abort();
    else bootSignal?.addEventListener('abort', onBootAbort, { once: true });
  ```
- wrap everything from the existing `try {` (consent check) through the final `e.activation = undefined;` after `host.start()` in an outer `try { … } finally { bootSignal?.removeEventListener('abort', onBootAbort); }`, so a finished activation never keeps a listener on the long-lived boot signal. The body inside is unchanged: the existing check `if (activation.signal.aborted || e.host !== host || !e.enabled) { await host.stop(); e.host = null; e.activation = undefined; return; }` (`:1036`) already sits after the consent and preparation awaits, with no await between it and `await host.start()`, so it is the "right before spawn" check.

(h) In `loadEntries()`:
- delete the line `running = true;`. It moves to `startEntries`, so a DB-worker respawn between `load()` and the first start re-activates nothing.
- in BOTH `entries.set(...)` literals, compute `enabled` once and use it for both fields:
```ts
      const enabled = state[found.manifest.id]?.enabled ?? true;
      entries.set(found.manifest.id, {
        // …unchanged fields…
        enabled,
        // #140: the window opens before most activations — an enabled entry
        // reads as "starting" from discovery on (ContributedUnavailable).
        status: enabled ? 'activating' : 'disabled',
        // …unchanged fields…
      });
```
(`loadEntry`, the install path, keeps `status: 'disabled'`: `activate()` runs right after it.)

(i) Above `return {` add the shared start body:
```ts
  const inProcessEntry = (e: Entry): boolean =>
    e.manifest.caps.includes('unsafe.mainProcess');

  /** start()'s per-id body for the entries `pick` selects. Discovery first
   *  (a no-op once loaded); `running` from here on gates the worker-respawn
   *  re-activation. Parallel across extensions, serialized per id. */
  function startEntries(
    pick: (e: Entry) => boolean,
    bootSignal?: AbortSignal,
  ): Promise<void> {
    loadEntries();
    running = true;
    const ids = [...entries.values()]
      .filter(pick)
      .map((e) => e.manifest.id);
    return Promise.all(
      ids.map((id) =>
        runExclusive(id, async () => {
          const e = entries.get(id);
          if (!e || !e.enabled) return;
          // #140: a queued activation whose turn comes after quit / Reset all.
          if (bootSignal?.aborted) return;
          // Already failed in this process — a reset at boot that could
          // not reset its data. Its marker is for the next start, which
          // rearms it; consuming it here would activate nothing and
          // lose the marker.
          if (e.status === 'errored') return;
          if (fs.existsSync(recoveryMarkerPath(deps.extDir, id))) {
            try {
              await rearmPlugin(e);
              clearRecoveryMarker(deps.extDir, id);
            } catch (error) {
              const recoveryError = recoveryRequiredError(id, error);
              setStatus(e, 'errored', recoveryError.message);
              return;
            }
          }
          await activate(e, bootSignal);
        }),
      ),
    ).then(() => undefined);
  }
```

(j) Replace the returned `start()` body with `await startEntries(() => true);`, keeping its existing comment block above the call. Add after it:
```ts
    async startInProcess(opts = {}) {
      const boundMs = opts.boundMs ?? IN_PROCESS_READY_MS;
      const t0 = Date.now();
      loadEntries();
      const ids = [...entries.values()]
        .filter((e) => e.enabled && inProcessEntry(e))
        .map((e) => e.manifest.id);
      startEntries(inProcessEntry).catch((error) =>
        deps.logSink.log(
          'extensions',
          'error',
          `in-process extensions failed to start: ${String(error)}`,
        ),
      );
      const activatedMs: Record<string, number> = {};
      await Promise.all(
        ids.map(async (id) => {
          const left = Math.max(0, boundMs - (Date.now() - t0));
          if (
            (await whenSettled(id, left)) &&
            entries.get(id)?.status === 'activated'
          )
            activatedMs[id] = Date.now() - t0;
        }),
      );
      const pending = ids.filter(
        (id) => entries.get(id)?.status === 'activating',
      );
      if (pending.length > 0)
        deps.logSink.log(
          'extensions',
          'warn',
          `in-process extensions still activating after ${boundMs} ms: ${pending.join(', ')} — opening the window anyway`,
        );
      return { activatedMs, pending };
    },

    async startUtility(signal) {
      await startEntries((e) => !inProcessEntry(e), signal);
    },
```

- [ ] **Step 6: Run the new suite, then the existing platform suites**

Run: `npx jest src/main/platform/__tests__/extension-platform-boot.test.ts`
Expected: PASS.

Run: `npx jest src/main/platform/__tests__/extension-platform.test.ts src/main/platform/__tests__/extension-e2e.test.ts src/main/platform/__tests__/ui-capability-integration.test.ts`
Expected: PASS. If an assertion right after `load()` expected `'disabled'` for an enabled entry, change it to `'activating'` and cite #140 in the test comment. The existing `load()` tests only assert `!== 'activated'`, so none should need changing.

- [ ] **Step 7: Lint, typecheck, commit**

Run: `npx eslint src/main/platform/extension-platform.ts src/main/platform/__tests__/extension-platform-boot.test.ts src/main/platform/__tests__/helpers/platform-harness.ts && npx tsc --noEmit -p .`

```bash
MSG=/private/tmp/claude-501/-Users-edjafarov-work-alpha-cent/4c50a2e2-79f9-4098-aef4-8a2c75761c3a/scratchpad/opt/boot-commit-msg.txt
cd ~/work/kcore-boot
printf '%s\n' 'feat(platform): in-process start bounded at 5 s, utility start split, starting status at discovery (#140)' > "$MSG"
git add src/main/platform/__tests__/helpers/platform-harness.ts src/main/platform/__tests__/fixtures/ext-bundled-slow src/main/platform/__tests__/extension-platform-boot.test.ts
git commit -F "$MSG" -- src/main/platform/extension-platform.ts src/main/platform/__tests__/helpers/platform-harness.ts src/main/platform/__tests__/fixtures/ext-bundled-slow src/main/platform/__tests__/extension-platform-boot.test.ts
```

---

### Task A4: Split the interrupted-reset finish from extension start

**Files:**
- Modify: `src/main/factory-reset.ts:116-167`
- Test: `src/main/__tests__/factory-reset.test.ts:14,425-513`

**Interfaces:**
- Produces:
  - `export interface InterruptedResetDeps { journal: Pick<ResetJournal, 'pending' | 'end'>; confirmFinish(): Promise<boolean>; loadExtensions(): Promise<void>; reset(): Promise<FactoryResetOutcome> }`. The `startExtensions` field is removed.
  - `export async function finishInterruptedReset(deps: InterruptedResetDeps): Promise<FactoryResetOutcome | null>`. It never starts extensions. `startAfterInterruptedReset` stays as a thin compatibility wrapper (finish, then `startExtensions()`) until Task A7 migrates main.ts and deletes it, so every commit typechecks.

- [ ] **Step 1: Update the tests first**

In `src/main/__tests__/factory-reset.test.ts`:
- line 14: import `finishInterruptedReset` instead of `startAfterInterruptedReset`.
- replace the whole `describe('startAfterInterruptedReset', …)` block with:

```ts
describe('finishInterruptedReset', () => {
  const finished: FactoryResetOutcome = {
    ok: true,
    coreWiped: true,
    failed: [],
    error: null,
  };

  function boot(pending: boolean, answer: boolean) {
    const calls: string[] = [];
    const d = {
      journal: {
        pending: () => pending,
        end: jest.fn(() => {
          calls.push('journal.end');
        }),
      },
      confirmFinish: jest.fn(async () => {
        calls.push('ask');
        return answer;
      }),
      loadExtensions: jest.fn(async () => {
        calls.push('load');
      }),
      reset: jest.fn(async () => {
        calls.push('reset');
        return finished;
      }),
    };
    return { d, calls };
  }

  it('does nothing when no reset was left unfinished', async () => {
    const { d, calls } = boot(false, true);
    await expect(finishInterruptedReset(d)).resolves.toBeNull();
    expect(calls).toEqual([]);
  });

  it('finishes an unfinished reset on the user’s word, with extensions loaded and none started', async () => {
    const { d, calls } = boot(true, true);
    await expect(finishInterruptedReset(d)).resolves.toBe(finished);
    expect(calls).toEqual(['ask', 'load', 'reset']);
  });

  it('the reset completes before the caller’s next step', async () => {
    const { d, calls } = boot(true, true);
    d.reset.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 30));
      calls.push('reset');
      return finished;
    });
    await finishInterruptedReset(d).then(() => calls.push('start extensions'));
    expect(calls).toEqual(['ask', 'load', 'reset', 'start extensions']);
  });

  it('keeps what is left when the user says so, and does not ask again', async () => {
    const { d, calls } = boot(true, false);
    await expect(finishInterruptedReset(d)).resolves.toBeNull();
    expect(calls).toEqual(['ask', 'journal.end']);
    expect(d.reset).not.toHaveBeenCalled();
  });

  it('a reset that throws is reported', async () => {
    const { d, calls } = boot(true, true);
    d.reset.mockRejectedValueOnce(new Error('EACCES: permission denied'));
    await expect(finishInterruptedReset(d)).resolves.toEqual({
      ok: false,
      coreWiped: false,
      failed: [],
      error: 'EACCES: permission denied',
    });
    expect(calls).toEqual(['ask', 'load']);
  });

  it('extensions that cannot be found stop the finish: nothing is reset and the record stays', async () => {
    const { d, calls } = boot(true, true);
    d.loadExtensions.mockRejectedValueOnce(new Error('ENOTDIR: extensions'));
    await expect(finishInterruptedReset(d)).resolves.toEqual({
      ok: false,
      coreWiped: false,
      failed: [],
      error: 'ENOTDIR: extensions',
    });
    expect(calls).toEqual(['ask']);
    expect(d.reset).not.toHaveBeenCalled();
    expect(d.journal.end).not.toHaveBeenCalled();
  });

  it('a record that cannot be dropped does not stop the boot', async () => {
    const { d, calls } = boot(true, false);
    d.journal.end.mockImplementationOnce(() => {
      throw new Error('EPERM');
    });
    await expect(finishInterruptedReset(d)).resolves.toBeNull();
    expect(calls).toEqual(['ask']);
  });
});
```
(The "extensions still start after a failed reset" guarantee moves to `boot-tail.test.ts`, Task A5.)

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/main/__tests__/factory-reset.test.ts`
Expected: FAIL. `finishInterruptedReset` is not exported.

- [ ] **Step 3: Implement**

In `src/main/factory-reset.ts`, delete `startExtensions` from `InterruptedResetDeps`. Then replace `startAfterInterruptedReset` with:

```ts
/**
 * Boot, when the last Reset all never finished: let the user decide, because
 * some data is deleted and some is not. Finish: the reset runs with the
 * extensions loaded and none active, so none runs on the half-deleted data.
 * Keep: the record is dropped. Nothing is deleted without that answer.
 * Resolves with the finished reset's outcome, or null.
 *
 * Starting extensions is the CALLER's next step (boot-tail.ts) — it runs only
 * after this resolves, so "nothing syncs before the reset finishes" holds.
 */
export async function finishInterruptedReset(
  deps: InterruptedResetDeps,
): Promise<FactoryResetOutcome | null> {
  if (!deps.journal.pending()) return null;
  if (await deps.confirmFinish()) {
    // Not finding the extensions stops the finish before it starts: the
    // reset would otherwise wipe core, skip every extension's data, and
    // drop the record. The record stays, so the question comes back.
    return deps
      .loadExtensions()
      .then(() => deps.reset())
      .catch(
        (err): FactoryResetOutcome => ({
          ok: false,
          coreWiped: false,
          failed: [],
          error: message(err),
        }),
      );
  }
  try {
    deps.journal.end();
  } catch {
    // Then the question comes back at the next start.
  }
  return null;
}
```
Directly below it, keep a compatibility wrapper so `main.ts` (still calling the old name until A7) typechecks and behaves exactly as today. Task A7 deletes it together with the main.ts migration:
```ts
/** @deprecated #140 compatibility for main.ts until bootTail lands (Task A7
 *  deletes this). Today's behaviour: finish (or keep), then start every
 *  extension. */
export async function startAfterInterruptedReset(
  deps: InterruptedResetDeps & { startExtensions(): Promise<void> },
): Promise<FactoryResetOutcome | null> {
  const outcome = await finishInterruptedReset(deps);
  await deps.startExtensions();
  return outcome;
}
```
Also update `src/main/reset-journal.ts:9`, which mentions `startAfterInterruptedReset`, to `finishInterruptedReset`.

- [ ] **Step 4: Run to verify pass**

Run: `npx jest src/main/__tests__/factory-reset.test.ts src/main/__tests__/reset-journal.test.ts`
Expected: PASS.

Run: `npx tsc --noEmit -p .`
Expected: clean (main.ts still calls the compatibility wrapper with its `startExtensions`).

- [ ] **Step 5: Lint and commit**

Run: `npx eslint src/main/factory-reset.ts src/main/reset-journal.ts src/main/__tests__/factory-reset.test.ts`

```bash
MSG=/private/tmp/claude-501/-Users-edjafarov-work-alpha-cent/4c50a2e2-79f9-4098-aef4-8a2c75761c3a/scratchpad/opt/boot-commit-msg.txt
cd ~/work/kcore-boot
printf '%s\n' 'refactor(reset): finishInterruptedReset no longer starts extensions (#140)' > "$MSG"
git commit -F "$MSG" -- src/main/factory-reset.ts src/main/reset-journal.ts src/main/__tests__/factory-reset.test.ts
```
(Every task in this plan commits a tree that passes tsc and lint; no gate is skipped.)

---

### Task A5: `bootTail` and boot timing

**Files:**
- Create: `src/main/boot-tail.ts`, `src/main/core/boot-timing.ts`
- Test: `src/main/__tests__/boot-tail.test.ts`, `src/main/core/__tests__/boot-timing.test.ts`

**Interfaces:**
- Consumes: `InProcessStartReport` (A3); `FactoryResetOutcome` (`@shared/ipc`).
- Produces:
  - `export interface BootTimer { mark(step: string, detail?: string): void; observe(snapshot: readonly ExtensionSnapshot[]): void }`
  - `export function createBootTimer(write: (line: string) => void, now?: () => number): BootTimer`. It writes `[boot] <step> +<ms>ms[ (detail)]`. `observe` writes `[boot] extension <id> activated +<ms>ms` once per id, through handshake retries, until settlement.
  - `BootTimer.armSettled(snapshot)`: called once every utility start has been issued. From then on, the first snapshot (this one or a later `observe`) with no entry in `'activating'` writes `[boot] all settled` once, and observation stops. A retrying host stays `'activating'`, so its later activation is still logged.
  - `export interface BootTailDeps { journalPending(): boolean; finishInterruptedReset(): Promise<FactoryResetOutcome | null>; loadExtensions(): Promise<void>; armQueue(): void; startInProcess(): Promise<InProcessStartReport>; startAllExtensions(): Promise<void>; resumeAll(): Promise<void>; startScheduler(): void; registerActivate(): void; createWindow(): Promise<void>; startBackground(): Promise<void>; mark(step: string, detail?: string): void; logError(error: unknown): void }`
  - `export async function bootTail(d: BootTailDeps): Promise<FactoryResetOutcome | null>`
  - `export function formatInProcess(report: InProcessStartReport): string`

- [ ] **Step 1: Write the failing tests**

`src/main/core/__tests__/boot-timing.test.ts`:
```ts
import type { ExtensionSnapshot } from '@shared/contracts';

import { createBootTimer } from '../boot-timing';

const snap = (id: string, status: ExtensionSnapshot['status']) =>
  ({ id, status }) as ExtensionSnapshot;

describe('createBootTimer', () => {
  it('writes [boot] lines with ms since process start and an optional detail', () => {
    const lines: string[] = [];
    let t = 1234.4;
    const timer = createBootTimer((l) => lines.push(l), () => t);
    timer.mark('bootCore');
    t = 2000;
    timer.mark('in-process extensions active', 'kiagent.remote-mcp 120ms');
    expect(lines).toEqual([
      '[boot] bootCore +1234ms',
      '[boot] in-process extensions active +2000ms (kiagent.remote-mcp 120ms)',
    ]);
  });

  it('logs each extension activation once; all settled waits for statuses, then observation stops', () => {
    const lines: string[] = [];
    const timer = createBootTimer((l) => lines.push(l), () => 10);
    timer.observe([snap('a', 'activating')]);
    timer.observe([snap('a', 'activated')]);
    timer.observe([snap('a', 'activated')]);
    timer.armSettled([snap('a', 'activated')]);
    timer.observe([snap('b', 'activated')]);
    timer.mark('window shown'); // marks still write
    expect(lines).toEqual([
      '[boot] extension a activated +10ms',
      '[boot] all settled +10ms',
      '[boot] window shown +10ms',
    ]);
  });

  it('handshake timeout → retry → activated: the late activation is logged, then all settled', () => {
    const lines: string[] = [];
    const timer = createBootTimer((l) => lines.push(l), () => 10);
    // startUtility() returned with kia.slow's retry merely scheduled:
    timer.armSettled([snap('kia.fast', 'activated'), snap('kia.slow', 'activating')]);
    timer.observe([snap('kia.fast', 'activated'), snap('kia.slow', 'activating')]); // retry
    expect(lines).toEqual(['[boot] extension kia.fast activated +10ms']);
    timer.observe([snap('kia.fast', 'activated'), snap('kia.slow', 'activated')]);
    expect(lines).toEqual([
      '[boot] extension kia.fast activated +10ms',
      '[boot] extension kia.slow activated +10ms',
      '[boot] all settled +10ms',
    ]);
  });

  it('errored and needs-consent entries count as settled', () => {
    const lines: string[] = [];
    const timer = createBootTimer((l) => lines.push(l), () => 10);
    timer.armSettled([snap('x', 'errored'), snap('y', 'needs-consent')]);
    expect(lines).toEqual(['[boot] all settled +10ms']);
  });
});
```

`src/main/__tests__/boot-tail.test.ts`:
```ts
/** @jest-environment node */
import type { FactoryResetOutcome } from '@shared/ipc';

import { bootTail, formatInProcess, type BootTailDeps } from '../boot-tail';
import type { InProcessStartReport } from '../platform/extension-platform';

const flush = () => new Promise((r) => setTimeout(r, 0));

function deps(journal = false) {
  const calls: string[] = [];
  const step = (name: string) =>
    jest.fn(async () => {
      calls.push(name);
    });
  const d = {
    journalPending: () => journal,
    finishInterruptedReset: jest.fn(async (): Promise<FactoryResetOutcome | null> => {
      calls.push('finish-reset');
      return null;
    }),
    loadExtensions: step('load'),
    armQueue: jest.fn(() => {
      calls.push('arm');
    }),
    startInProcess: jest.fn(async (): Promise<InProcessStartReport> => {
      calls.push('in-process');
      return { activatedMs: { 'kiagent.remote-mcp': 120 }, pending: [] };
    }),
    startAllExtensions: step('start-all'),
    resumeAll: step('resume-all'),
    startScheduler: jest.fn(() => {
      calls.push('scheduler');
    }),
    registerActivate: jest.fn(() => {
      calls.push('activate-handler');
    }),
    createWindow: step('window'),
    startBackground: step('background'),
    mark: jest.fn(),
    logError: jest.fn(),
  } satisfies BootTailDeps;
  return { d, calls };
}

describe('bootTail', () => {
  it('normal path: load → arm → in-process start → window → background', async () => {
    const { d, calls } = deps();
    await expect(bootTail(d)).resolves.toBeNull();
    expect(calls).toEqual([
      'load',
      'arm',
      'in-process',
      'activate-handler',
      'window',
      'background',
    ]);
    expect(d.resumeAll).not.toHaveBeenCalled();
    expect(d.startScheduler).not.toHaveBeenCalled(); // background owns it
    expect(d.mark).toHaveBeenCalledWith(
      'in-process extensions active',
      'kiagent.remote-mcp 120ms',
    );
  });

  it('the window is created before any utility activation settles', async () => {
    const { d, calls } = deps();
    d.startBackground.mockImplementation(() => {
      calls.push('background'); // recorded at invocation; the promise never settles
      return new Promise<void>(() => {});
    });
    await bootTail(d); // resolves although the background never settles
    expect(calls.indexOf('window')).toBeGreaterThan(-1);
    expect(calls.indexOf('window')).toBeLessThan(calls.indexOf('background'));
  });

  it('the journal path stays fully sequential, and extensions start even after a failed reset', async () => {
    const { d, calls } = deps(true);
    d.finishInterruptedReset.mockImplementationOnce(async () => {
      calls.push('finish-reset');
      return { ok: false, coreWiped: false, failed: [], error: 'EACCES' };
    });
    const outcome = await bootTail(d);
    expect(outcome?.ok).toBe(false);
    expect(calls).toEqual([
      'finish-reset',
      'start-all',
      'resume-all',
      'scheduler',
      'activate-handler',
      'window',
    ]);
    expect(d.startBackground).not.toHaveBeenCalled();
    expect(d.armQueue).not.toHaveBeenCalled();
  });

  it('a discovery failure still opens the window with zero extensions, and does not reject', async () => {
    const { d, calls } = deps();
    d.loadExtensions.mockRejectedValueOnce(new Error('ENOTDIR: extensions'));
    d.startInProcess.mockRejectedValueOnce(new Error('ENOTDIR: extensions'));
    await expect(bootTail(d)).resolves.toBeNull(); // handleBootFailure is the .catch — never reached
    expect(calls).toContain('window');
    expect(d.logError).toHaveBeenCalledTimes(2);
  });

  it('an in-process extension that errors before first paint still opens the window', async () => {
    const { d, calls } = deps();
    d.startInProcess.mockResolvedValueOnce({ activatedMs: {}, pending: [] });
    await bootTail(d);
    expect(calls).toContain('window');
  });

  it('a rejecting background chain is logged, never unhandled', async () => {
    const { d } = deps();
    d.startBackground.mockRejectedValueOnce(new Error('late'));
    await bootTail(d);
    await flush();
    expect(d.logError).toHaveBeenCalledWith(new Error('late'));
  });
});

describe('formatInProcess', () => {
  it('lists per-extension ms and the pending ones', () => {
    expect(
      formatInProcess({
        activatedMs: { 'kiagent.remote-mcp': 120, 'kiagent.meetings': 80 },
        pending: ['kiagent.assistant'],
      }),
    ).toBe('kiagent.remote-mcp 120ms, kiagent.meetings 80ms; pending: kiagent.assistant');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/main/__tests__/boot-tail.test.ts src/main/core/__tests__/boot-timing.test.ts`
Expected: FAIL. Neither module exists yet.

- [ ] **Step 3: Implement**

`src/main/core/boot-timing.ts`:
```ts
/**
 * #140 acceptance evidence: `[boot] <step> +<ms>ms` lines, ms since process
 * start (performance.now()'s origin), written through the caller's logger.
 */
import type { ExtensionSnapshot } from '@shared/contracts';

export interface BootTimer {
  mark(step: string, detail?: string): void;
  /** Feed every platform snapshot; logs each extension's first 'activated'
   *  (handshake retries included) until settlement. */
  observe(snapshot: readonly ExtensionSnapshot[]): void;
  /** Every start has been issued: 'all settled' is written by the first
   *  snapshot with no entry still 'activating' (decided from statuses, never
   *  from start() returning — a host resolves start() on a scheduled retry). */
  armSettled(snapshot: readonly ExtensionSnapshot[]): void;
}

export function createBootTimer(
  write: (line: string) => void,
  now: () => number = () => performance.now(),
): BootTimer {
  const seen = new Set<string>();
  let armed = false;
  let settled = false;
  const mark = (step: string, detail?: string): void => {
    write(`[boot] ${step} +${Math.round(now())}ms${detail ? ` (${detail})` : ''}`);
  };
  const observe = (snapshot: readonly ExtensionSnapshot[]): void => {
    if (settled) return;
    for (const e of snapshot) {
      if (e.status !== 'activated' || seen.has(e.id)) continue;
      seen.add(e.id);
      mark(`extension ${e.id} activated`);
    }
    if (armed && !snapshot.some((e) => e.status === 'activating')) {
      settled = true;
      mark('all settled');
    }
  };
  return {
    mark,
    observe,
    armSettled(snapshot) {
      armed = true;
      observe(snapshot);
    },
  };
}
```

`src/main/boot-tail.ts`:
```ts
/**
 * #140 window-first boot: the tail of main.ts's whenReady, extracted so its
 * ORDER is unit-testable without Electron. Everything above it (bootCore,
 * mcp, registerIpc, engine.project) is unchanged.
 *
 * - Interrupted reset journaled: today's fully sequential path (reset dialog
 *   → reset → all extensions → resume → scheduler → window). Rare; keeps
 *   "nothing syncs before the reset finishes" trivially true.
 * - Otherwise: discovery → arm the boot queue → in-process extensions
 *   (bounded at IN_PROCESS_READY_MS) → window → background chain
 *   (resume ready accounts → scheduler → utility extensions).
 *
 * Extension discovery/start failures are inert (logged, window still
 * opens); nothing here may reach handleBootFailure for them.
 */
import type { FactoryResetOutcome } from '@shared/ipc';

import type { InProcessStartReport } from './platform/extension-platform';

export interface BootTailDeps {
  journalPending(): boolean;
  finishInterruptedReset(): Promise<FactoryResetOutcome | null>;
  loadExtensions(): Promise<void>;
  /** BootQueue.arm(extensions.snapshot()) — after discovery, before any
   *  in-process source can register. */
  armQueue(): void;
  startInProcess(): Promise<InProcessStartReport>;
  /** Journal path only: every enabled extension, awaited. */
  startAllExtensions(): Promise<void>;
  /** Journal path only: today's resumeAccounts. */
  resumeAll(): Promise<void>;
  startScheduler(): void;
  /** app.on('activate', showMainWindow) — registered before the window. */
  registerActivate(): void;
  createWindow(): Promise<void>;
  /** startBackground(...) — fired, never awaited. */
  startBackground(): Promise<void>;
  mark(step: string, detail?: string): void;
  /** 'extension platform failed to start' — the old inert() log line. */
  logError(error: unknown): void;
}

export function formatInProcess(report: InProcessStartReport): string {
  const done = Object.entries(report.activatedMs)
    .map(([id, ms]) => `${id} ${ms}ms`)
    .join(', ');
  return report.pending.length > 0
    ? `${done}; pending: ${report.pending.join(', ')}`
    : done;
}

export async function bootTail(
  d: BootTailDeps,
): Promise<FactoryResetOutcome | null> {
  // A broken extensions dir (e.g. `extensions` exists as a plain file, so
  // mkdirSync throws) must be fully inert — never abort boot, or no window
  // ever opens.
  const inert = async (step: () => Promise<unknown>): Promise<void> => {
    try {
      await step();
    } catch (error) {
      d.logError(error);
    }
  };

  if (d.journalPending()) {
    const outcome = await d.finishInterruptedReset();
    await inert(() => d.startAllExtensions());
    await d.resumeAll();
    d.startScheduler();
    d.registerActivate();
    await d.createWindow();
    return outcome;
  }

  await inert(() => d.loadExtensions());
  d.mark('extensions loaded');
  d.armQueue();
  const report = await d.startInProcess().catch((error: unknown) => {
    d.logError(error);
    return null;
  });
  d.mark(
    'in-process extensions active',
    report ? formatInProcess(report) : undefined,
  );
  d.registerActivate();
  d.mark('createWindow start');
  await d.createWindow();
  d.mark('window loaded');
  void d.startBackground().catch((error: unknown) => d.logError(error));
  return null;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx jest src/main/__tests__/boot-tail.test.ts src/main/core/__tests__/boot-timing.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint and commit**

Run: `npx eslint src/main/boot-tail.ts src/main/core/boot-timing.ts src/main/__tests__/boot-tail.test.ts src/main/core/__tests__/boot-timing.test.ts`

```bash
MSG=/private/tmp/claude-501/-Users-edjafarov-work-alpha-cent/4c50a2e2-79f9-4098-aef4-8a2c75761c3a/scratchpad/opt/boot-commit-msg.txt
cd ~/work/kcore-boot
printf '%s\n' 'feat(boot): bootTail order + [boot] timing lines (#140)' > "$MSG"
git add src/main/boot-tail.ts src/main/core/boot-timing.ts src/main/__tests__/boot-tail.test.ts src/main/core/__tests__/boot-timing.test.ts
git commit -F "$MSG" -- src/main/boot-tail.ts src/main/core/boot-timing.ts src/main/__tests__/boot-tail.test.ts src/main/core/__tests__/boot-timing.test.ts
```

---

### Task A6: Dev-only hung transport (`KIA_TEST_HANG_EXT`)

**Files:**
- Modify: `src/main/platform/transport.ts` (append after `createInMemoryHostPair`)
- Test: `src/main/platform/__tests__/hung-transport.test.ts`

**Interfaces:**
- Produces: `export function createHungTransport(): HostTransport`. The child never answers. `kill()` / `close()` fire the exit callbacks once.

- [ ] **Step 1: Write the failing test**

```ts
/** @jest-environment node */
import { createExtensionHost } from '../host-process';
import { createHungTransport } from '../transport';

describe('createHungTransport', () => {
  it('fires exit once on kill, never answers', () => {
    const t = createHungTransport();
    const exits: Array<number | null> = [];
    const onMsg = jest.fn();
    t.onMessage(onMsg);
    t.onExit((c) => exits.push(c));
    t.send({ kind: 'bootstrap' });
    t.kill();
    t.kill();
    t.close();
    expect(exits).toEqual([null]);
    expect(onMsg).not.toHaveBeenCalled();
  });

  it('a host on it times out its handshake and stays activating (retrying), never errored', async () => {
    const statuses: string[] = [];
    const host = createExtensionHost({
      extensionId: 'kia.hung',
      entryAbsPath: '/virtual/e.js',
      dataDir: '/virtual/d',
      caps: [],
      transportFactory: createHungTransport,
      makeSurfaces: () => ({ surfaces: {} as never, close: () => {} }),
      logSink: { log: jest.fn() },
      onStatus: (s) => statuses.push(s),
      registerContributions: () => () => {},
      readyTimeoutMs: 30,
      handshakeRetryDelayMs: () => 60_000,
    });
    await host.start(); // settles once the retry is scheduled
    expect(statuses).toEqual(['activating', 'activating']);
    await host.stop();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/main/platform/__tests__/hung-transport.test.ts`
Expected: FAIL. `createHungTransport` is not exported.

- [ ] **Step 3: Implement**

Append to `src/main/platform/transport.ts`:
```ts
/** Dev-only (#140 measurement, `KIA_TEST_HANG_EXT=<id>`): a utility transport
 *  whose child never answers. The host sees a handshake timeout and retries
 *  — exactly a starved process — so time-to-window can be measured with one
 *  connector stuck. `kill()`/`close()` fire the exit callbacks once. */
export function createHungTransport(): HostTransport {
  const exits = new Set<(code: number | null) => void>();
  let exited = false;
  const exit = (code: number | null) => {
    if (exited) return;
    exited = true;
    exits.forEach((cb) => cb(code));
  };
  return {
    send: () => {},
    onMessage: () => () => {},
    onExit: (cb) => {
      exits.add(cb);
      return () => {
        exits.delete(cb);
      };
    },
    kill: () => exit(null),
    close: () => exit(0),
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx jest src/main/platform/__tests__/hung-transport.test.ts src/main/platform/__tests__/transport.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint and commit**

```bash
MSG=/private/tmp/claude-501/-Users-edjafarov-work-alpha-cent/4c50a2e2-79f9-4098-aef4-8a2c75761c3a/scratchpad/opt/boot-commit-msg.txt
cd ~/work/kcore-boot
npx eslint src/main/platform/transport.ts src/main/platform/__tests__/hung-transport.test.ts
printf '%s\n' 'feat(platform): dev-only hung transport for boot measurements (#140)' > "$MSG"
git add src/main/platform/__tests__/hung-transport.test.ts
git commit -F "$MSG" -- src/main/platform/transport.ts src/main/platform/__tests__/hung-transport.test.ts
```

---

### Task A7: Wire main.ts (tail → `bootTail`, run-or-queue, abort, timing)

**Files:**
- Modify: `src/main/main.ts`

**Interfaces:**
- Consumes: everything from A1–A6.
- Produces: module-level `bootQueue: BootQueue | null`, `bootChain: { stop(): void } | null`, `bootTimer: BootTimer`; `function startAccount(p: CorePlatform, account: Account): void`.

- [ ] **Step 1: Make the non-tail edits (each ≤3 lines; this list is exhaustive)**

1. Imports. Make these changes:
   - `import type { Account, AppState, AccountId, SchedulerEnv, Seq } from '@shared/contracts';`
   - add `import { createBootQueue, startBackground, type BootQueue } from './core/boot-background';`
   - add `import { createBootTimer } from './core/boot-timing';`
   - add `import { bootTail } from './boot-tail';`
   - in the factory-reset import, replace `startAfterInterruptedReset,` with `finishInterruptedReset,`, and delete the `startAfterInterruptedReset` compatibility wrapper (and its doc comment) from `src/main/factory-reset.ts` — main.ts was its only caller (`grep -rn startAfterInterruptedReset src` must print nothing afterwards)
   - change the transport import to `import { createHungTransport, utilityProcessTransport } from './platform/transport';`
2. Module lets, right after `let quitting = false;`:
   ```ts
   // #140: the boot queue (sync-now/Resume run-or-queue) and the post-window chain's stop.
   let bootQueue: BootQueue | null = null;
   let bootChain: { stop(): void } | null = null;
   const bootTimer = createBootTimer((line) => log.info(line));
   ```
3. A top-level helper, placed right above `function registerIpc(`:
   ```ts
   /** sync-now and Resume (#140): run now, or queue behind a boot-pending extension source. */
   function startAccount(p: CorePlatform, account: Account): void {
     if (bootQueue) bootQueue.runOrQueue(account, 'explicit');
     else runAccount(p, account);
   }
   ```
4. In `registerIpc` handlers:
   - `'accounts:resume'`: change `if (account) runAccount(p, account);` to `if (account) startAccount(p, account);`.
   - `'accounts:sync-now'`: change `if (account && account.status !== 'paused') runAccount(p, account);` to `if (account && account.status !== 'paused') startAccount(p, account);`.
5. In `factoryResetDeps`, make this the first statement of the `pauseSources: async () => {` body:
   ```ts
      bootChain?.stop(); // an interactive Reset all halts the boot chain first (#140)
   ```
6. In `createWindow`'s `showOnce`, after `mainWindow.show();` add `bootTimer.mark('window shown');`.
6a. In the tray's `syncNow` (`createTray(…, { … syncNow: () => { void (async () => {`, ~`:1180`), after the `await Promise.allSettled(…);` statement add:
   ```ts
            // #140 (spec: tray Sync now is explicit): boot-pending accounts have no cadence job yet.
            bootQueue?.syncPending(await p.store.read.accounts());
   ```
7. After `platform = await bootCore({...});` add `bootTimer.mark('bootCore');`. After `mcp = await startMcp({...});` add `bootTimer.mark('mcp');`. After the `registerIpc(...)` call add `bootTimer.mark('ipc');`.
8. Replace the two sequential awaits for the initial push with one `Promise.all`:
   ```ts
    const [initialLedger, initialIdentity] = await Promise.all([
      p.store.ledgerCountsAll(p.engine.activeConsumers()),
      p.store.identity.get(),
    ]);
   ```
   and in the `lastPush` literal use `identity: initialIdentity,`.
9. Make these two changes inside `createExtensionPlatform({...})`:
   - `onChange`: after `attention.setExtensions(extensions);` add:
     ```ts
        bootTimer.observe(extensions);
        bootQueue?.onSnapshot(extensions);
     ```
   - `transportFactory: (id) =>`: prefix the existing `utilityProcessTransport(...)` expression with:
     ```ts
        !app.isPackaged && process.env.KIA_TEST_HANG_EXT === id
          ? createHungTransport()
          :
     ```
10. In `app.on('before-quit', (event) => {`, keep that line byte-identical, because the overlay's `patchQuitSignals` anchors on it. After `quitting = true;` add:
    ```ts
     bootChain?.stop(); // #140: nothing further resumes or starts once quitting
    ```

- [ ] **Step 2: Replace the whenReady tail**

Replace everything from the comment `// A broken extensions dir (e.g. \`extensions\` exists as a plain file, so` through the closing `});` of `app.on('activate', () => { showMainWindow(); });` with the block below. The `.catch(handleBootFailure…)` after it stays unchanged.

```ts
    // #140 window-first boot: the order lives in boot-tail.ts; this block only
    // wires it. Utility-process extensions start AFTER the window.
    const extensions = extensionsPlatform;
    const journal = createResetJournal(dataDir);
    const queue = createBootQueue({
      readAccount: (id: AccountId) => p.store.account(id),
      isRegistered: (sourceId) => p.sources.get(sourceId) !== undefined,
      onRegister: (cb) => p.sources.onRegister(cb),
      runAccount: (account) => {
        runAccount(p, account);
      },
      log: (level, msg) => p.logSink.log('engine', level, msg),
    });
    const background = new AbortController();
    bootQueue = queue;
    bootChain = {
      stop: () => {
        background.abort();
        queue.stop();
      },
    };
    const finishedReset = await bootTail({
      journalPending: () => journal.pending(),
      finishInterruptedReset: () =>
        finishInterruptedReset({
          journal,
          confirmFinish: async () =>
            (
              await dialog.showMessageBox({
                type: 'warning',
                message: 'Reset all did not finish',
                detail:
                  'The last Reset all stopped before it was done, so some of ' +
                  'your data may be deleted already and some not. Finish it now ' +
                  'to delete the rest, or keep what is left.',
                buttons: ['Finish reset', 'Keep what is left'],
                defaultId: 0,
                cancelId: 1,
              })
            ).response === 0,
          loadExtensions: () => extensions.load(),
          reset: () => runFactoryReset(factoryResetDeps(p, patchState)),
        }),
      loadExtensions: () => extensions.load(),
      armQueue: () => queue.arm(extensions.snapshot()),
      startInProcess: () => extensions.startInProcess(),
      startAllExtensions: () => extensions.start(),
      resumeAll: async () => {
        await resumeAccounts(p);
      },
      startScheduler: () => p.scheduler.start(),
      registerActivate: () => {
        app.on('activate', () => {
          showMainWindow();
        });
      },
      createWindow,
      startBackground: () =>
        startBackground({
          resumeReady: async (signal) => {
            await resumeAccounts(p, { defer: (a) => queue.defer(a), signal });
          },
          startScheduler: () => p.scheduler.start(),
          startUtilityExtensions: async () => {
            // The boot signal: quit / Reset all cancels pending activations
            // before any further utility host spawns (#140).
            await extensions.startUtility(background.signal);
            // 'all settled' comes from statuses, not from startUtility()
            // returning (a handshake retry resolves start early).
            bootTimer.armSettled(extensions.snapshot());
          },
          mark: (step, detail) => bootTimer.mark(step, detail),
          log: (level, msg) => p.logSink.log('platform', level, msg),
          signal: background.signal,
        }),
      mark: (step, detail) => bootTimer.mark(step, detail),
      logError: (err) =>
        p.logSink.log('platform', 'error', 'extension platform failed to start', {
          error: err instanceof Error ? err.message : String(err),
        }),
    });
    if (finishedReset) {
      const nameOf = (id: string) =>
        extensions.snapshot().find((e) => e.id === id)?.name ?? id;
      void dialog.showMessageBox({
        type: finishedReset.ok ? 'info' : 'warning',
        message: finishedReset.ok
          ? 'Reset all finished'
          : 'Reset all did not finish',
        detail: describeResetOutcome(finishedReset, nameOf),
      });
    }
  })
```
(Check that the old `inert` helper and the old `const extensions = extensionsPlatform;` are gone, with no duplicate declarations.)

- [ ] **Step 3: Gates**

Run: `npx tsc --noEmit -p .`
Expected: clean.

Run: `npx eslint src/main/main.ts`
Expected: clean.

Run: `npx jest src/main/__tests__/ipc-handler-coverage.test.ts src/main/__tests__/boot-tail.test.ts src/main/__tests__/factory-reset.test.ts`
Expected: PASS.

Run: `/private/tmp/claude-501/-Users-edjafarov-work-alpha-cent/4c50a2e2-79f9-4098-aef4-8a2c75761c3a/scratchpad/opt/heavy.sh npx jest`
Expected: PASS. Fix only regressions this part caused. A failure that also fails on `v0.106.0` is pre-existing: note it in the PR, do not fix it here.

Run: `/private/tmp/claude-501/-Users-edjafarov-work-alpha-cent/4c50a2e2-79f9-4098-aef4-8a2c75761c3a/scratchpad/opt/heavy.sh npm run lint`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
MSG=/private/tmp/claude-501/-Users-edjafarov-work-alpha-cent/4c50a2e2-79f9-4098-aef4-8a2c75761c3a/scratchpad/opt/boot-commit-msg.txt
cd ~/work/kcore-boot
cat > "$MSG" <<'EOF'
feat(boot): window-first boot — window no longer waits for utility extensions (#140)

whenReady's tail is bootTail(): discovery, in-process extensions bounded at
5 s, window, then resume → scheduler → utility extensions in the background.
Boot-pending accounts start once when their source registers; sync-now and
Resume run-or-queue. [boot] timing lines are the acceptance evidence.
EOF
git commit -F "$MSG" -- src/main/main.ts src/main/factory-reset.ts
```

---

### Task A8 (CONTROLLER): Time-to-window measurement, Mac + Windows VM

This is not an implementer task. The controller runs and records it after A7 is merged into a build.

- [ ] **Step 1: Mac dev app, before.** Run the current pinned app (core `v0.106.0`) with one connector delayed. Before has no hang hatch, so delay it by using a profile where a utility connector is slow, or else record plain boot. From the log, record the time from process start to the window `ready-to-show`.
- [ ] **Step 2: Mac dev app, after.** Use an alpha-cent worktree that stages this core commit with `KIA_CORE_LOCK`/`fetch-core --dest`. Never run the dev app in the shared checkout. Use an already-staged dev worktree (the `~/work/ac-dev146` pattern: symlinked node_modules and `.env`, existing staged extensions). Never run `stageExtensions`, `npm ci` or `npm run build` inside it; any staging happens beforehand, outside it, under `heavy.sh`. Launch with `KIA_TEST_HANG_EXT=<a utility connector id, e.g. kia.notion>`. Record:
  - all `[boot] …` lines from the log;
  - `[boot] window shown +<ms>`;
  - `[boot] all settled`, which does not appear while the hung connector keeps retrying (it stays `'activating'`); every other utility extension's `[boot] extension … activated` line still appears.

  Expected: `window shown` comes before any utility `extension … activated` line, and it is not delayed by the hung connector.
- [ ] **Step 3: Windows VM** (`ssh win`; see the windows-utm-vm-test-recipe memory). Repeat Steps 1–2 with a packaged test build, using `KIA_TEST_HANG_EXT` only in an unpackaged run. For a packaged run, record plain before/after without the hatch.
- [ ] **Step 4: Record** both machines' before/after numbers in issue #140, as a comment with the `[boot]` excerpts.

---

# Part B — dormant utility hosts (#137)

Start only after Part A is committed and its gates are green.

## File map (Part B)

| File | Change |
|---|---|
| `src/main/product.ts` | `dormantExtensions?: string[]` in schema + `ProductConfig` |
| `src/main/platform/source-proxy.ts` | `ProxyBinding` (`ensureLive`/`endpoint`/`begin`); `bind`/`unbind`; every verb goes through `ensureLive` + in-flight |
| `src/main/platform/host-process.ts` | one proxy set per host; in-flight count; pins from `endpoint.onCall`; idle timer; `sleep()` (soft stop); `ensureLive()` (wake, 60 s bound, shared); kept registration + `sameContributions`; hard stop of a dormant host |
| `src/shared/contracts.ts` | `ExtensionSnapshot.dormant?: boolean` |
| `src/main/platform/extension-platform.ts` | `dormantExtensions` / `dormantAfterMs` deps; eligibility + `KIA_DORMANT_HOSTS=0`; `onDormant` → snapshot |
| `src/main/main.ts` | `dormantExtensions: product.dormantExtensions,` (one line inside `createExtensionPlatform({...})`) |
| tests | `__tests__/product.test.ts`, `platform/__tests__/source-proxy-binding.test.ts` (new), `platform/__tests__/host-process-dormancy.test.ts` (new), `platform/__tests__/extension-platform-dormant.test.ts` (new, includes the e2e) |

---

### Task B1: Product config `dormantExtensions`

**Files:**
- Modify: `src/main/product.ts`
- Test: `src/main/__tests__/product.test.ts`

**Interfaces:**
- Produces: `ProductConfig.dormantExtensions?: string[]`

- [ ] **Step 1: Write the failing tests** (append inside `describe('loadProductConfig', …)`)

```ts
  it('carries dormantExtensions and keeps every other key (#137)', () => {
    fs.writeFileSync(
      path.join(tmp, 'product.json'),
      JSON.stringify({
        productName: 'Acme',
        macUpdatesEnabled: true,
        bundledExtensionsDir: 'bx',
        dormantExtensions: ['kia.notion', 'kia.hubspot'],
      }),
    );
    expect(loadProductConfig([tmp])).toEqual({
      productName: 'Acme',
      macUpdatesEnabled: true,
      bundledExtensionsDir: 'bx',
      dormantExtensions: ['kia.notion', 'kia.hubspot'],
    });
  });

  it('leaves dormantExtensions absent when the config omits it', () => {
    fs.writeFileSync(
      path.join(tmp, 'product.json'),
      JSON.stringify({ productName: 'Acme' }),
    );
    expect(loadProductConfig([tmp]).dormantExtensions).toBeUndefined();
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/main/__tests__/product.test.ts`
Expected: FAIL. The first test gets defaults, because the strict schema rejects the unknown key.

- [ ] **Step 3: Implement**

In `schema`, add `dormantExtensions: z.array(z.string().min(1)).optional(),`. In `ProductConfig` add:
```ts
  /**
   * #137: utility (marketplace) extensions allowed to go dormant when idle —
   * the product's audited allowlist (no timers, sockets or file watchers
   * outside pulls). Absent/empty: none; core alone changes nothing.
   */
  dormantExtensions?: string[];
```

- [ ] **Step 4: Run to verify pass, then lint and commit**

Run: `npx jest src/main/__tests__/product.test.ts && npx eslint src/main/product.ts src/main/__tests__/product.test.ts`

```bash
MSG=/private/tmp/claude-501/-Users-edjafarov-work-alpha-cent/4c50a2e2-79f9-4098-aef4-8a2c75761c3a/scratchpad/opt/boot-commit-msg.txt
cd ~/work/kcore-boot
printf '%s\n' 'feat(product): dormantExtensions allowlist in product config (#137)' > "$MSG"
git commit -F "$MSG" -- src/main/product.ts src/main/__tests__/product.test.ts
```

---

### Task B2: Source proxy set follows the host, not the incarnation

**Files:**
- Modify: `src/main/platform/source-proxy.ts`
- Test: `src/main/platform/__tests__/source-proxy-binding.test.ts`

**Interfaces:**
- Produces:
  - `export interface ProxyBinding { ensureLive(): Promise<void>; endpoint(): RpcEndpoint; begin(): () => void }`
  - `createSourceProxySet(target: RpcEndpoint | ProxyBinding): SourceProxySet`. Passing a bare endpoint keeps today's behaviour, so the existing source-proxy tests are unchanged.
  - `SourceProxySet.bind(endpoint: RpcEndpoint): void`. It starts a fresh stream table and the notify subscription.
  - `SourceProxySet.unbind(endpoint: RpcEndpoint): void`. It is a no-op unless `endpoint` is the bound one.
  - `dispose()` = unbind the current endpoint.
- Semantics:
  - Every verb calls `begin()` first, then `await ensureLive()`, then `endpoint()`. The verbs are connect, pull/reconcile streams, fetchBytes, listAddressedTo, manageFolders and reauthenticate.
  - A pull/reconcile stream holds its `begin()` until it ends, errors or aborts.
  - An auth/session map entry is created only after `ensureLive()` resolved. A soft stop's `abortAll` runs while the caller waits, and it can never wipe that entry.

- [ ] **Step 1: Write the failing tests**

```ts
/** @jest-environment node */
import type { Session } from '@shared/contracts';
import type { Contributions } from '@shared/extension-rpc';

import { createSourceProxySet, type ProxyBinding } from '../source-proxy';
import type { RpcEndpoint } from '../transport';

type Notify = (m: { kind: string } & Record<string, unknown>) => void;

function fakeEndpoint(call: RpcEndpoint['call'] = jest.fn(async () => undefined)) {
  const notifies = new Set<Notify>();
  const ep = {
    call,
    onCall: jest.fn(),
    post: jest.fn(),
    onNotify: jest.fn((cb: Notify) => {
      notifies.add(cb);
      return () => notifies.delete(cb);
    }),
    dispose: jest.fn(),
  } as unknown as RpcEndpoint;
  const emit = (m: { kind: string } & Record<string, unknown>) =>
    [...notifies].forEach((cb) => cb(m));
  return { ep, emit, notifies };
}

const entry = {
  descriptor: { id: 'src', name: 'Src', documentTypes: ['x'], auth: 'none' },
  hasFetchBytes: false,
  hasReconcile: false,
  hasManageFolders: false,
  hasReauthenticate: false,
} as Contributions['sources'][number];

function binding(ep: RpcEndpoint, live: () => Promise<void> = async () => {}) {
  let open = 0;
  const b: ProxyBinding & { open(): number } = {
    ensureLive: jest.fn(live),
    endpoint: () => ep,
    begin: () => {
      open += 1;
      let ended = false;
      return () => {
        if (!ended) open -= 1;
        ended = true;
      };
    },
    open: () => open,
  };
  return b;
}

describe('createSourceProxySet over a ProxyBinding (#137)', () => {
  it('a verb waits for ensureLive, then calls the current endpoint, and is in flight meanwhile', async () => {
    const { ep } = fakeEndpoint(jest.fn(async () => ({ identifier: 'me' })));
    let release!: () => void;
    const b = binding(ep, () => new Promise<void>((r) => (release = r)));
    const set = createSourceProxySet(b);
    const pending = set.makeSource(entry).connect({} as never);
    await Promise.resolve();
    expect(b.open()).toBe(1);
    expect(ep.call).not.toHaveBeenCalled();
    release();
    await expect(pending).resolves.toEqual({ identifier: 'me' });
    expect(ep.call).toHaveBeenCalledWith('source', 'connect', [1, 'src']);
    expect(b.open()).toBe(0);
  });

  it('an ensureLive rejection rejects the verb and ends its in-flight mark', async () => {
    const { ep } = fakeEndpoint();
    const b = binding(ep, async () => {
      throw new Error('extension is not running');
    });
    const set = createSourceProxySet(b);
    await expect(set.makeSource(entry).connect({} as never)).rejects.toThrow(
      'extension is not running',
    );
    expect(b.open()).toBe(0);
  });

  it('the connect flow survives an abortAll that lands while it waits for the wake', async () => {
    let set!: ReturnType<typeof createSourceProxySet>;
    const status = jest.fn(async () => undefined);
    const { ep } = fakeEndpoint(
      jest.fn(async (_ns: string, _m: string, args: unknown[]) => {
        await set.handleCall('auth', 'status', [args[0], 'hi']);
        return { identifier: 'me' };
      }),
    );
    let release!: () => void;
    const b = binding(ep, () => new Promise<void>((r) => (release = r)));
    set = createSourceProxySet(b);
    const pending = set.makeSource(entry).connect({ status } as never);
    set.abortAll('extension process exited'); // the soft stop's teardown
    release();
    await expect(pending).resolves.toEqual({ identifier: 'me' });
    expect(status).toHaveBeenCalledWith('hi');
  });

  it('a pull stays in flight from open until the stream ends', async () => {
    const { ep, emit } = fakeEndpoint();
    const b = binding(ep);
    const set = createSourceProxySet(b);
    set.bind(ep);
    (ep.post as jest.Mock).mockImplementation((m: { kind: string; pullId: number }) => {
      if (m.kind !== 'src-next') return;
      queueMicrotask(() =>
        emit(
          (ep.post as jest.Mock).mock.calls.filter((c) => c[0].kind === 'src-next').length === 1
            ? { kind: 'src-batch', pullId: m.pullId, batch: { phase: 'live', items: [], cursor: 1 } }
            : { kind: 'src-done', pullId: m.pullId },
        ),
      );
    });
    const session = {
      account: { id: 'a1' },
      signal: new AbortController().signal,
      credentials: async () => null,
      log: () => {},
    } as unknown as Session;
    const it = set.makeSource(entry).pull(session, null)[Symbol.asyncIterator]();
    await it.next(); // first batch
    expect(b.open()).toBe(1);
    await it.next(); // done
    expect(b.open()).toBe(0);
  });

  it('bind() moves the notify subscription to the new endpoint', () => {
    const one = fakeEndpoint();
    const two = fakeEndpoint();
    const set = createSourceProxySet(binding(one.ep));
    set.bind(one.ep);
    set.bind(two.ep);
    expect(one.notifies.size).toBe(0);
    expect(two.notifies.size).toBe(1);
    set.unbind(one.ep); // not the bound one: no-op
    expect(two.notifies.size).toBe(1);
    set.unbind(two.ep);
    expect(two.notifies.size).toBe(0);
  });

  it('a bare endpoint keeps today’s behaviour (bound at construction)', () => {
    const { ep, notifies } = fakeEndpoint();
    const set = createSourceProxySet(ep);
    expect(notifies.size).toBe(1);
    set.dispose();
    expect(notifies.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/main/platform/__tests__/source-proxy-binding.test.ts`
Expected: FAIL. There is no `bind`, a ProxyBinding is not accepted, and `ProxyBinding` is not exported.

- [ ] **Step 3: Implement in `source-proxy.ts`**

(a) Add the binding type and the `SourceProxySet` members:
```ts
/** #137: how a host-lifetime proxy set reaches whichever incarnation is live.
 *  `begin()` marks one operation in flight (the returned function ends it,
 *  idempotent); `ensureLive()` wakes a dormant host and resolves once it is
 *  activated; `endpoint()` is the current incarnation's endpoint. */
export interface ProxyBinding {
  ensureLive(): Promise<void>;
  endpoint(): RpcEndpoint;
  begin(): () => void;
}

export interface SourceProxySet {
  handleCall(ns: string, method: string, args: unknown[]): Promise<unknown>;
  makeSource(entry: Contributions['sources'][number]): Source;
  abortAll(reason: string | Error): void;
  /** Attach to a new incarnation: fresh stream table, notify subscription. */
  bind(endpoint: RpcEndpoint): void;
  /** Detach from `endpoint` (no-op if another one is bound). */
  unbind(endpoint: RpcEndpoint): void;
  dispose(): void;
}
```

(b) At the top of `createSourceProxySet`, change the signature and resolve the binding:
```ts
export function createSourceProxySet(
  target: RpcEndpoint | ProxyBinding,
): SourceProxySet {
  // Inline `'call' in target` at each use so TS narrows `target` itself.
  const fixedEndpoint: RpcEndpoint | null = 'call' in target ? target : null;
  const binding: ProxyBinding =
    'call' in target
      ? { ensureLive: async () => {}, endpoint: () => target, begin: () => () => {} }
      : target;
```

(c) Replace `const offNotify = endpoint.onNotify((raw) => {…});` with a named handler plus bind state:
```ts
  const onNotify = (raw: { kind: string } & Record<string, unknown>) => {
    // …the existing body of the onNotify callback, unchanged…
  };
  let bound: RpcEndpoint | null = null;
  let offNotify: (() => void) | null = null;
  function unbind(endpoint: RpcEndpoint): void {
    if (endpoint !== bound) return;
    offNotify?.();
    offNotify = null;
    bound = null;
  }
  function bind(endpoint: RpcEndpoint): void {
    if (bound) unbind(bound);
    streams.clear();
    bound = endpoint;
    offNotify = endpoint.onNotify(onNotify);
  }
  /** One main→child operation: in flight from before the wake to the end. */
  async function live<T>(fn: (endpoint: RpcEndpoint) => Promise<T>): Promise<T> {
    const end = binding.begin();
    try {
      await binding.ensureLive();
      return await fn(binding.endpoint());
    } finally {
      end();
    }
  }
```
(`streams` is declared above this point, as today.)

(d) In `stream()`, replace its first lines through `session.signal.addEventListener('abort', onAbort, { once: true });` with:
```ts
    // In flight from open until the stream ends, errors or aborts (#137): a
    // live pull never ends, so its host never idles.
    const end = binding.begin();
    let endpoint: RpcEndpoint;
    try {
      await binding.ensureLive();
      endpoint = binding.endpoint();
    } catch (err) {
      end();
      throw err;
    }
    const state: StreamState = { inbox: [], wake: null };
    streams.set(pullId, state);
    sessions.set(pullId, {
      credentials: () => session.credentials(),
      log: (l, m) => session.log(l, m),
    });
    const onAbort = () => {
      endpoint.post({ kind: 'src-abort', pullId } satisfies MainToChild);
      state.wake?.();
      state.wake = null;
      streams.delete(pullId);
      sessions.delete(pullId);
      session.signal.removeEventListener('abort', onAbort);
      end();
    };
    session.signal.addEventListener('abort', onAbort, { once: true });
```
In its `finally` add `end();` after the existing three statements. The rest of `stream()` already uses the local `endpoint`.

(e) In `handleCall`'s `pickFolders` branch, change `endpoint.call('source', verb, [id, ...a])` to `binding.endpoint().call('source', verb, [id, ...a])`.

(f) Route each `makeSource` verb through `live`, and register its map entry INSIDE the callback:
```ts
        async connect(auth) {
          const id = nextId;
          nextId += 1;
          try {
            return (await live((endpoint) => {
              auths.set(id, { channel: auth, verbs: AUTH_VERBS });
              return endpoint.call('source', 'connect', [id, descriptor.id]);
            })) as { identifier: string; config?: Record<string, unknown> };
          } finally {
            auths.delete(id);
          }
        },
```
Apply the same shape to the other four verbs: move the `sessions.set` / `auths.set` lines into the `live((endpoint) => { … })` callback and leave the `finally` deletes where they are.
- `fetchBytes`: `sessions.set`, then call `'fetch-bytes'`.
- `listAddressedTo`: `sessions.set`, then call `'list-addressed-to'`, then validate the rows after `live` returns.
- `manageFolders`: `auths.set` + `sessions.set`, then call `'manage-folders'`.
- `reauthenticate`: `auths.set`, then call `'reauthenticate'`.

`pull` and `reconcile` already go through `stream()`.

(g) Replace the returned `dispose()` with `dispose() { if (bound) unbind(bound); },` and add `bind, unbind,` to the returned object. After building the object, if `fixedEndpoint` is set, call `bind(fixedEndpoint)` before returning:
```ts
  const set: SourceProxySet = { /* …handleCall, makeSource, abortAll, bind, unbind, dispose… */ };
  if (fixedEndpoint) bind(fixedEndpoint);
  return set;
```

- [ ] **Step 4: Run new + existing proxy suites**

Run: `npx jest src/main/platform/__tests__/source-proxy-binding.test.ts src/main/platform/__tests__/source-proxy.test.ts src/main/platform/__tests__/source-proxy-addressed.test.ts src/main/platform/__tests__/source-proxy-manage-folders.test.ts src/main/platform/__tests__/source-proxy-picker.test.ts src/main/platform/__tests__/host-process.test.ts`
Expected: PASS. host-process still builds a per-incarnation set from a bare endpoint, and that path is unchanged.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
MSG=/private/tmp/claude-501/-Users-edjafarov-work-alpha-cent/4c50a2e2-79f9-4098-aef4-8a2c75761c3a/scratchpad/opt/boot-commit-msg.txt
cd ~/work/kcore-boot
npx eslint src/main/platform/source-proxy.ts src/main/platform/__tests__/source-proxy-binding.test.ts && npx tsc --noEmit -p .
printf '%s\n' 'refactor(platform): source proxy set binds to the live endpoint through a host binding (#137)' > "$MSG"
git add src/main/platform/__tests__/source-proxy-binding.test.ts
git commit -F "$MSG" -- src/main/platform/source-proxy.ts src/main/platform/__tests__/source-proxy-binding.test.ts
```

---

### Task B3: Host — one proxy set per host, in-flight tracking, pins, idle soft stop

**Files:**
- Modify: `src/main/platform/host-process.ts`
- Test: `src/main/platform/__tests__/host-process-dormancy.test.ts` (create; B4 extends it)

**Interfaces:**
- Consumes: `ProxyBinding`, `bind`/`unbind` (B2).
- Produces:
  - `HostDeps.dormancy?: { idleMs: number; wakeTimeoutMs?: number }`. When it is absent, the host never sleeps.
  - `HostDeps.onDormant?(dormant: boolean): void`. It is called with true after a soft stop, and with false on wake or on a hard stop of a sleeping/dormant host.
  - Pins: an `attention.*`, `events.on` or `files.watch` call from the child pins the incarnation. A pinned incarnation never sleeps. A new incarnation starts unpinned.
  - In flight: `callTool`/`callUi`/`callSender` and every proxy verb count from call to settle. A pull counts from open to end.
  - Soft stop: after `idleMs` with nothing in flight, the host posts `deactivate` and waits for the exit (kill backstop `killAfterMs`). Every registration stays in place. No status change is emitted, only `onDormant(true)`.

- [ ] **Step 1: Write the failing tests**

`src/main/platform/__tests__/host-process-dormancy.test.ts`:
```ts
/** @jest-environment node */
import type { Cap, ExtensionStatus, Session, Source } from '@shared/contracts';
import type { Contributions } from '@shared/extension-rpc';

import { runExtensionHost } from '../extension-host-entry';
import { createExtensionHost } from '../host-process';
import { createInMemoryHostPair } from '../transport';

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
const IDLE = 40;

export function makeDormantHost(
  mod: unknown,
  overrides: Record<string, unknown> = {},
) {
  const statuses: ExtensionStatus[] = [];
  const dormant: boolean[] = [];
  const registered: Contributions[] = [];
  const unregistered: number[] = [];
  const logs: string[] = [];
  let makeSource!: (e: Contributions['sources'][number]) => Source;
  let spawns = 0;
  const host = createExtensionHost({
    extensionId: 'kia.test',
    entryAbsPath: '/virtual/e.js',
    dataDir: '/virtual/d',
    caps: ['net'] as Cap[],
    transportFactory: () => {
      spawns += 1;
      const pair = createInMemoryHostPair();
      runExtensionHost(pair.child, {
        requireModule: () => mod,
        exit: (c) => pair.simulateExit(c),
      });
      return pair.main;
    },
    makeSurfaces: () => ({ surfaces: {} as never, close: jest.fn() }),
    logSink: { log: (_s: string, _l: string, msg: string) => logs.push(msg) },
    onStatus: (s: ExtensionStatus) => statuses.push(s),
    onDormant: (d: boolean) => dormant.push(d),
    registerContributions: (c: Contributions, ms: typeof makeSource) => {
      registered.push(c);
      makeSource = ms;
      return () => unregistered.push(1);
    },
    killAfterMs: 50,
    readyTimeoutMs: 1000,
    activateTimeoutMs: 1000,
    dormancy: { idleMs: IDLE },
    ...overrides,
  });
  return {
    host,
    statuses,
    dormant,
    registered,
    unregistered,
    logs,
    spawns: () => spawns,
    source: () => makeSource,
  };
}

export const toolModule = {
  async activate() {
    return {
      sources: [],
      tools: [{ name: 't', description: '', inputSchema: {}, call: async (a: unknown) => ({ echoed: a }) }],
    };
  },
};

describe('host soft stop (#137)', () => {
  it('an idle host goes dormant: child exits, registrations stay, no status change', async () => {
    const h = makeDormantHost(toolModule);
    await h.host.start();
    await sleepMs(IDLE * 4);
    expect(h.dormant).toEqual([true]);
    expect(h.unregistered).toEqual([]);
    expect(h.statuses).toEqual(['activating', 'activated']);
    await h.host.stop();
  });

  it('without dormancy a host never sleeps', async () => {
    const h = makeDormantHost(toolModule, { dormancy: undefined });
    await h.host.start();
    await sleepMs(IDLE * 4);
    expect(h.dormant).toEqual([]);
    await h.host.stop();
  });

  it('does not sleep while a tool call is in flight; sleeps once it settles', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const mod = {
      async activate() {
        return {
          sources: [],
          tools: [{ name: 'slow', description: '', inputSchema: {}, call: async () => { await gate; return 1; } }],
        };
      },
    };
    const h = makeDormantHost(mod);
    await h.host.start();
    const call = h.host.callTool('slow', {});
    await sleepMs(IDLE * 4);
    expect(h.dormant).toEqual([]);
    release();
    await expect(call).resolves.toBe(1);
    await sleepMs(IDLE * 4);
    expect(h.dormant).toEqual([true]);
    await h.host.stop();
  });

  it('a pull session is in flight from open to end; a live pull never idles', async () => {
    const mod = {
      async activate() {
        return {
          sources: [
            {
              descriptor: { id: 'live', name: 'Live', documentTypes: ['x'], auth: 'none' },
              async connect() {
                return { identifier: 'x' };
              },
              async *pull(session: Session) {
                yield { phase: 'live', items: [], cursor: 1 };
                await new Promise((r) => session.signal.addEventListener('abort', r));
              },
              toDocument: (i: unknown) => i,
            },
          ],
          tools: [],
        };
      },
    };
    const h = makeDormantHost(mod);
    await h.host.start();
    const ac = new AbortController();
    const session = {
      account: { id: 'a1' },
      signal: ac.signal,
      credentials: async () => null,
      log: () => {},
    } as unknown as Session;
    const src = h.source()(h.registered[0].sources[0]);
    const it = src.pull(session, null)[Symbol.asyncIterator]();
    await it.next();
    await sleepMs(IDLE * 4);
    expect(h.dormant).toEqual([]); // the open live pull holds the host
    ac.abort();
    await it.next();
    await sleepMs(IDLE * 4);
    expect(h.dormant).toEqual([true]);
    await h.host.stop();
  });

  it.each([
    ['events.on', ['events'], { events: { on: jest.fn(), off: jest.fn(), emit: jest.fn() } },
      (host: { events: { on(e: string, cb: () => void): void } }) => host.events.on('x', () => {})],
    ['attention.publish', ['attention'], { attention: { publish: async () => ({ rejected: [] }), resolve: async () => ({ rejected: [] }) } },
      (host: { attention: { publish(i: unknown[]): Promise<unknown> } }) => void host.attention.publish([])],
    ['files.watch', ['files'], { files: { watch: jest.fn(async () => ({ watchId: 1 })) } },
      (host: { files: { watch(r: unknown, cb: () => void): unknown } }) => void host.files.watch({ root: 'r', rel: '' }, () => {})],
  ])('a host that uses %s is pinned and never sleeps', async (_name, caps, surfaces, use) => {
    const mod = {
      async activate(host: never) {
        (use as (h: never) => void)(host);
        return { sources: [], tools: [] };
      },
    };
    const h = makeDormantHost(mod, {
      caps,
      makeSurfaces: () => ({ surfaces, close: jest.fn() }),
    });
    await h.host.start();
    await sleepMs(IDLE * 4);
    expect(h.dormant).toEqual([]);
    expect(h.logs.some((m) => /pinned/.test(m))).toBe(true);
    await h.host.stop();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/main/platform/__tests__/host-process-dormancy.test.ts`
Expected: FAIL. The host never sleeps (`dormant` stays `[]`), and `dormancy` / `onDormant` are TS errors.

- [ ] **Step 3: Implement in `host-process.ts`**

(a) Constants and helper, after `HANDSHAKE_RETRY_MAX_MS`:
```ts
/** #137: a wake gives up (callers get 'extension is not running') after this. */
const WAKE_TIMEOUT_MS = 60_000;
/** #137: child→main calls that pin the incarnation (it must keep running). */
const PIN_CALLS: ReadonlySet<string> = new Set(['events.on', 'files.watch']);

/** Order-insensitive deep compare of two wire Contributions payloads (plain
 *  JSON data: descriptors, flags, tool schemas, sender ids). */
export function sameContributions(a: Contributions, b: Contributions): boolean {
  const stable = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(stable)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v as Record<string, unknown>)
              .sort()
              .map((k) => [k, stable((v as Record<string, unknown>)[k])]),
          )
        : v;
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}
```

(b) `HostDeps` additions:
```ts
  /** #137: idle soft stop. Absent → the host never goes dormant. */
  dormancy?: { idleMs: number; wakeTimeoutMs?: number };
  /** #137: true after a soft stop; false on wake or hard stop of a dormant host. */
  onDormant?(dormant: boolean): void;
```

(c) Add `ensureLive(): Promise<void>;` to the returned type. Its docs: "#137: resolves once the host is live, waking a dormant one; rejects 'extension is not running' when stopped or after the wake bound".

(d) Host-level state, after `let retryTimer …`:
```ts
  // #137 dormancy. `phase` is only about dormancy: a stopped or crashed host
  // is 'live' with `current` null.
  type Phase = 'live' | 'sleeping' | 'dormant' | 'waking';
  let phase: Phase = 'live';
  let inFlight = 0;
  let pinned = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** The live registrations, kept across a soft stop and a wake. */
  let registration: { contributions: Contributions; dispose: () => void } | null = null;
  const wakeWaiters = new Set<{
    resolve(): void;
    reject(e: Error): void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  const notRunning = () => new Error('extension is not running');

  function disposeRegistration(): void {
    const r = registration;
    registration = null;
    r?.dispose();
  }

  function clearIdle(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  }

  function armIdle(): void {
    clearIdle();
    if (!deps.dormancy || pinned || phase !== 'live' || inFlight > 0) return;
    if (!current || stopping || stopped) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      void sleep();
    }, deps.dormancy.idleMs);
    idleTimer.unref?.();
  }

  /** Marks one operation in flight; the returned function ends it. */
  function begin(): () => void {
    inFlight += 1;
    clearIdle();
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      inFlight -= 1;
      if (inFlight === 0) armIdle();
    };
  }

  function pin(reason: string): void {
    if (pinned) return;
    pinned = true;
    clearIdle();
    if (deps.dormancy)
      deps.logSink.log(scope, 'info', 'extension host pinned (stays running)', { reason });
  }

  function settleWake(error: Error | null): void {
    for (const w of wakeWaiters) {
      clearTimeout(w.timer);
      if (error) w.reject(error);
      else w.resolve();
    }
    wakeWaiters.clear();
  }

  /** A wake that will not complete (error, crash loop): back to plain state. */
  function failWake(): void {
    if (phase === 'waking') {
      phase = 'live';
      deps.onDormant?.(false);
    }
    settleWake(notRunning());
  }

  /** Soft stop: the child goes, every registration stays. */
  async function sleep(): Promise<void> {
    const inc = current;
    if (!deps.dormancy || !inc || phase !== 'live' || pinned || inFlight > 0) return;
    if (stopping || stopped) return;
    phase = 'sleeping';
    const exited = new Promise<void>((resolve) => {
      inc.transport.onExit(() => resolve());
    });
    inc.endpoint.post({ kind: 'deactivate' } satisfies MainToChild);
    const timer = setTimeout(() => {
      deps.logSink.log(scope, 'warn', 'deactivate-overran-kill-backstop', { killAfterMs });
      inc.transport.kill();
    }, killAfterMs);
    await exited;
    await inc.cleanupDone;
    clearTimeout(timer);
    if (phase !== 'sleeping') return; // stop() took over
    phase = 'dormant';
    deps.logSink.log(scope, 'info', 'extension host is dormant');
    deps.onDormant?.(true);
  }

  // ONE proxy set for the host's lifetime (#137): sources registered by an
  // earlier incarnation keep working across a soft stop and a wake.
  const proxySet = createSourceProxySet({
    ensureLive: () => ensureLive(),
    endpoint: () => {
      if (!current) throw notRunning();
      return current.endpoint;
    },
    begin,
  });

  /** Placeholder until B4: a dormant host cannot be woken yet. */
  function ensureLive(): Promise<void> {
    if (phase === 'live' && current) return Promise.resolve();
    return Promise.reject(notRunning());
  }

  async function callLive<T>(fn: (inc: Incarnation) => Promise<T>): Promise<T> {
    const end = begin();
    try {
      await ensureLive();
      const inc = current;
      if (!inc) throw notRunning();
      return await fn(inc);
    } finally {
      end();
    }
  }
```

(e) Changes in `spawn()`:
- First statements: replace `deps.onStatus('activating');` with:
  ```ts
    // A wake keeps the snapshot 'activated' + dormant until live again (#137).
    if (phase !== 'waking') deps.onStatus('activating');
    pinned = false;
  ```
- Delete the locals `let unregister …` and `let proxySet …`.
- Replace `proxySet = createSourceProxySet(endpoint);` with `proxySet.bind(endpoint);`.
- In `cleanup`'s body, replace `proxySet?.abortAll(teardownError); proxySet?.dispose();` with:
  ```ts
          proxySet.abortAll(teardownError);
          if (endpoint) proxySet.unbind(endpoint);
  ```
  Replace `unregister?.(); unregister = null;` with the line below, keeping the existing comment above it and adding the #137 sentence:
  ```ts
          // #137: kept across a soft stop and across a wake's handshake
          // retries — only a live incarnation's exit disposes.
          if (phase === 'live') disposeRegistration();
  ```
- In `onExit`, change `if (stopping || stopped) return;` to:
  ```ts
        if (stopping || stopped || phase === 'sleeping') return;
  ```
  In its crash-loop branch, after `rejectStart(new Error(msg));` add:
  ```ts
          failWake();
          disposeRegistration();
  ```
- Replace `endpoint.onCall((ns, method, args, context) => …)` with:
  ```ts
      endpoint.onCall((ns, method, args, context) => {
        // #137 runtime pins: a host that subscribes to events, publishes
        // attention or watches files must keep running.
        if (ns === 'attention' || PIN_CALLS.has(`${ns}.${method}`))
          pin(`${ns}.${method}`);
        return ns === 'auth' || ns === 'session'
          ? proxySet.handleCall(ns, method, args)
          : router.dispatch(ns, method, args, context);
      });
  ```
- Replace the success tail, from `const contributions = …` through `resolveStart();`, with:
  ```ts
      const contributions = outcome.contributions as Contributions;
      if (
        !registration ||
        !sameContributions(registration.contributions, contributions)
      ) {
        disposeRegistration();
        registration = {
          contributions,
          dispose: deps.registerContributions(contributions, proxySet.makeSource),
        };
      }
      handshakeTimeouts = 0;
      if (phase === 'waking') {
        phase = 'live';
        deps.logSink.log(scope, 'info', 'dormant extension host is live again');
        deps.onDormant?.(false);
        settleWake(null);
      } else {
        deps.onStatus('activated');
      }
      resolveStart();
      armIdle();
  ```
- In the `catch`, after `deps.onStatus('errored', errMsg(e));` add `failWake(); disposeRegistration();`.
- In the `catch`'s `HandshakeTimeout` branch (`:424-441`), the retry emits `deps.onStatus('activating', …)`. Guard it so a wake keeps the snapshot `activated` + dormant (ruling 8):
  ```ts
        if (phase !== 'waking')
          deps.onStatus(
            'activating',
            `${e.message}; retrying in ${Math.round(delay / 1000)}s`,
          );
  ```
- `sleep()` awaits `inc.cleanupDone`. That field already exists on `Incarnation` (`:123`), and `onExit` sets it (`:296`) before any later `onExit` listener fires, so no change is needed.

(f) In the returned object:
- `start()`: no change.
- `stop()`: insert at the top, after the `retryTimer` clear:
  ```ts
      clearIdle();
      const wasAsleep = phase !== 'live';
      // stop() owns the outcome from here: a sleep in progress must not
      // finish into 'dormant', a wake must not finish into 'live'.
      phase = 'live';
      settleWake(notRunning());
      if (wasAsleep) deps.onDormant?.(false);
  ```
  Then add `disposeRegistration();`:
  - in the early-return branch, before `deps.onStatus('disabled');`;
  - at the end, before `stopping = false; deps.onStatus('disabled');`.
- Replace the three call methods:
  ```ts
    callTool(name, args) {
      return callLive((inc) => inc.endpoint.call('tool', name, [args]));
    },
    callUi(name, payload, options) {
      return callLive((inc) => inc.endpoint.call('ui', name, [payload], options));
    },
    // (existing comment kept)
    callSender(sourceId, intent, ctx) {
      return callLive(
        (inc) => inc.endpoint.call('send', sourceId, [intent, ctx]) as Promise<SendResult>,
      );
    },
    ensureLive,
  ```

- [ ] **Step 4: Run new + existing host suites**

Run: `npx jest src/main/platform/__tests__/host-process-dormancy.test.ts src/main/platform/__tests__/host-process.test.ts src/main/platform/__tests__/extension-e2e.test.ts src/main/platform/__tests__/extension-platform.test.ts`
Expected: PASS. Without `dormancy`, behaviour is unchanged.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
MSG=/private/tmp/claude-501/-Users-edjafarov-work-alpha-cent/4c50a2e2-79f9-4098-aef4-8a2c75761c3a/scratchpad/opt/boot-commit-msg.txt
cd ~/work/kcore-boot
npx eslint src/main/platform/host-process.ts src/main/platform/__tests__/host-process-dormancy.test.ts && npx tsc --noEmit -p .
printf '%s\n' 'feat(platform): host-lifetime proxies, in-flight tracking, pins and idle soft stop (#137)' > "$MSG"
git add src/main/platform/__tests__/host-process-dormancy.test.ts
git commit -F "$MSG" -- src/main/platform/host-process.ts src/main/platform/__tests__/host-process-dormancy.test.ts
```

---

### Task B4: Host — wake on demand, contribution compare, bounds, hard stop

**Files:**
- Modify: `src/main/platform/host-process.ts` (replace the placeholder `ensureLive`)
- Test: `src/main/platform/__tests__/host-process-dormancy.test.ts` (append)

**Interfaces:**
- Produces: `ensureLive()`. Behaviour by phase:
  - Live: resolves at once.
  - Dormant: spawns through the normal path and resolves only on `activated`, across handshake retries. Concurrent callers share the spawn. Each waiter is bounded by `dormancy.wakeTimeoutMs ?? 60 s` and then rejects with `extension is not running`.
  - Sleeping: waits for the stop to finish, then wakes.
  - Stopped (`stop()`): all waiters reject.
- Wake with equal contributions skips registration. Different contributions dispose the kept registration, then register again, which emits `extension.deactivated`/`activated` through the disposer/registerContributions.

- [ ] **Step 1: Write the failing tests** (append to `host-process-dormancy.test.ts`)

```ts
import { createHungTransport } from '../transport';

async function dormantHost(mod: unknown, overrides: Record<string, unknown> = {}) {
  const h = makeDormantHost(mod, overrides);
  await h.host.start();
  await sleepMs(IDLE * 4);
  expect(h.dormant).toEqual([true]);
  return h;
}

const senderModule = {
  async activate() {
    return {
      sources: [],
      tools: [],
      senders: { fixsrc: { send: async () => ({ externalMessageId: 'sent' }) } },
    };
  },
};
const sourceModule = {
  async activate() {
    return {
      sources: [{
        descriptor: { id: 'src', name: 'Src', documentTypes: ['x'], auth: 'none' },
        async connect() { return { identifier: 'me' }; },
        async *pull() {},
        toDocument: (i: unknown) => i,
      }],
      tools: [],
    };
  },
};

describe('host wake (#137)', () => {
  it('a tool call wakes a dormant host and returns the right result', async () => {
    const h = await dormantHost(toolModule);
    await expect(h.host.callTool('t', { x: 1 })).resolves.toEqual({ echoed: { x: 1 } });
    expect(h.spawns()).toBe(2);
    expect(h.dormant).toEqual([true, false]);
    expect(h.statuses).toEqual(['activating', 'activated']); // no 'activating' on wake
    await h.host.stop();
  });

  it('a sender call wakes it', async () => {
    const h = await dormantHost(senderModule);
    await expect(
      h.host.callSender('fixsrc', { accountId: 'a', kind: 'reply', outboundRef: {}, bodyMarkdown: 'x' } as never, { credentials: null }),
    ).resolves.toEqual({ externalMessageId: 'sent' });
    await h.host.stop();
  });

  it('a source verb wakes it', async () => {
    const h = await dormantHost(sourceModule);
    const src = h.source()(h.registered[0].sources[0]);
    await expect(src.connect({} as never)).resolves.toEqual({ identifier: 'me' });
    expect(h.spawns()).toBe(2);
    await h.host.stop();
  });

  it('concurrent wakes share one spawn', async () => {
    const h = await dormantHost(toolModule);
    await Promise.all([h.host.callTool('t', { n: 1 }), h.host.callTool('t', { n: 2 })]);
    expect(h.spawns()).toBe(2);
    await h.host.stop();
  });

  it('equal contributions skip registration on wake', async () => {
    const h = await dormantHost(toolModule);
    await h.host.callTool('t', { n: 1 });
    expect(h.registered).toHaveLength(1);
    expect(h.unregistered).toEqual([]);
    await h.host.stop();
  });

  it('different contributions re-register on wake (old disposer first)', async () => {
    let n = 0;
    const mod = {
      async activate() {
        n += 1;
        return { sources: [], tools: [{ name: n === 1 ? 't' : 't2', description: '', inputSchema: {}, call: async () => n }] };
      },
    };
    const h = await dormantHost(mod);
    await h.host.ensureLive();
    expect(h.unregistered).toEqual([1]);
    expect(h.registered.map((c) => c.tools[0].name)).toEqual(['t', 't2']);
    await h.host.stop();
  });

  it('ensureLive waits for activated across a handshake retry', async () => {
    let spawn = 0;
    const h = await dormantHost(toolModule, {
      readyTimeoutMs: 50,
      handshakeRetryDelayMs: () => 20,
      transportFactory: () => {
        spawn += 1;
        if (spawn === 2) return createHungTransport(); // the wake's first try
        const pair = createInMemoryHostPair();
        runExtensionHost(pair.child, { requireModule: () => toolModule, exit: (c) => pair.simulateExit(c) });
        return pair.main;
      },
    });
    await expect(h.host.callTool('t', { n: 7 })).resolves.toEqual({ echoed: { n: 7 } });
    expect(spawn).toBe(3);
    expect(h.statuses).not.toContain('errored');
    await h.host.stop();
  });

  it('the wake is bounded', async () => {
    let spawn = 0;
    const h = await dormantHost(toolModule, {
      dormancy: { idleMs: IDLE, wakeTimeoutMs: 100 },
      readyTimeoutMs: 5_000,
      transportFactory: () => {
        spawn += 1;
        if (spawn > 1) return createHungTransport();
        const pair = createInMemoryHostPair();
        runExtensionHost(pair.child, { requireModule: () => toolModule, exit: (c) => pair.simulateExit(c) });
        return pair.main;
      },
    });
    const t0 = Date.now();
    await expect(h.host.callTool('t', { n: 1 })).rejects.toThrow('extension is not running');
    expect(Date.now() - t0).toBeLessThan(1_000);
    await h.host.stop();
  });

  it('disable cancels a wake in flight', async () => {
    let spawn = 0;
    const h = await dormantHost(toolModule, {
      readyTimeoutMs: 5_000,
      transportFactory: () => {
        spawn += 1;
        if (spawn > 1) return createHungTransport();
        const pair = createInMemoryHostPair();
        runExtensionHost(pair.child, { requireModule: () => toolModule, exit: (c) => pair.simulateExit(c) });
        return pair.main;
      },
    });
    const call = h.host.callTool('t', { n: 1 });
    await sleepMs(10);
    await h.host.stop();
    await expect(call).rejects.toThrow('extension is not running');
    expect(h.unregistered).toEqual([1]); // kept registration disposed exactly once
    expect(h.statuses[h.statuses.length - 1]).toBe('disabled');
  });

  it('hard stop of a dormant host disposes the kept registration and reports disabled', async () => {
    const h = await dormantHost(toolModule);
    await h.host.stop();
    expect(h.unregistered).toEqual([1]);
    expect(h.dormant).toEqual([true, false]);
    expect(h.statuses[h.statuses.length - 1]).toBe('disabled');
    await expect(h.host.callTool('t', { n: 1 })).rejects.toThrow('extension is not running');
  });

  it('a call during the soft stop waits and then wakes', async () => {
    let deactivating!: () => void;
    const started = new Promise<void>((r) => (deactivating = r));
    const mod = {
      ...toolModule,
      async deactivate() {
        deactivating();
        await sleepMs(30);
      },
    };
    const h = makeDormantHost(mod);
    await h.host.start();
    await started; // the idle soft stop is mid-teardown
    await expect(h.host.callTool('t', { n: 'late' })).resolves.toEqual({ echoed: { n: 'late' } });
    expect(h.spawns()).toBe(2);
    await h.host.stop();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/main/platform/__tests__/host-process-dormancy.test.ts -t 'host wake'`
Expected: FAIL. Calls on a dormant host reject `extension is not running` (the B3 placeholder).

- [ ] **Step 3: Implement**

Replace the placeholder `ensureLive` with:
```ts
  function beginWake(): void {
    phase = 'waking';
    stopping = false;
    stopped = false;
    crashes.length = 0;
    handshakeTimeouts = 0;
    deps.logSink.log(scope, 'info', 'waking dormant extension host');
    launchSpawn();
  }

  /** #137: live → now; dormant → spawn and wait for 'activated' (shared,
   *  bounded); sleeping → after the stop finishes; stopped → reject. */
  function ensureLive(): Promise<void> {
    if (phase === 'live')
      return current ? Promise.resolve() : Promise.reject(notRunning());
    return new Promise<void>((resolve, reject) => {
      const w = {
        resolve,
        reject,
        timer: setTimeout(() => {
          wakeWaiters.delete(w);
          reject(notRunning());
        }, deps.dormancy?.wakeTimeoutMs ?? WAKE_TIMEOUT_MS),
      };
      w.timer.unref?.();
      wakeWaiters.add(w);
      if (phase === 'dormant') beginWake();
      // 'sleeping': sleep() wakes on its way out; 'waking': joins this spawn.
    });
  }
```
At the end of `sleep()`, after `deps.onDormant?.(true);`, add:
```ts
    // A call that arrived mid-teardown is waiting: wake straight away.
    if (wakeWaiters.size > 0) beginWake();
```

- [ ] **Step 4: Run all host and platform suites**

Run: `npx jest src/main/platform/__tests__/host-process-dormancy.test.ts src/main/platform/__tests__/host-process.test.ts src/main/platform/__tests__/hung-transport.test.ts src/main/platform/__tests__/extension-e2e.test.ts src/main/platform/__tests__/extension-platform.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
MSG=/private/tmp/claude-501/-Users-edjafarov-work-alpha-cent/4c50a2e2-79f9-4098-aef4-8a2c75761c3a/scratchpad/opt/boot-commit-msg.txt
cd ~/work/kcore-boot
npx eslint src/main/platform/host-process.ts src/main/platform/__tests__/host-process-dormancy.test.ts && npx tsc --noEmit -p .
printf '%s\n' 'feat(platform): wake dormant hosts on demand, keep equal registrations (#137)' > "$MSG"
git commit -F "$MSG" -- src/main/platform/host-process.ts src/main/platform/__tests__/host-process-dormancy.test.ts
```

---

### Task B5: Platform eligibility, snapshot `dormant`, kill switch, main.ts pass-through, e2e

**Files:**
- Modify: `src/shared/contracts.ts` (`ExtensionSnapshot`), `src/main/platform/extension-platform.ts`, `src/main/main.ts` (one line)
- Test: `src/main/platform/__tests__/extension-platform-dormant.test.ts` (create)

**Interfaces:**
- Consumes: `HostDeps.dormancy` / `onDormant` (B3), `ensureLive` (B4), `ProductConfig.dormantExtensions` (B1), `createHarness` (A3).
- Produces:
  - `export const DORMANT_AFTER_MS = 5 * 60_000`
  - `ExtensionPlatformDeps.dormantExtensions?: readonly string[]`, and `dormantAfterMs?: number` as a test seam
  - `ExtensionSnapshot.dormant?: boolean`, present only when true
- Eligibility: all of the following must hold.
  - The entry is not `unsafe.mainProcess` and its origin is not `'bundled'`.
  - Its id is in `dormantExtensions`.
  - `process.env.KIA_DORMANT_HOSTS !== '0'` at activation.

- [ ] **Step 1: Write the failing tests**

```ts
/** @jest-environment node */
import path from 'path';

import type { ExtensionPlatform } from '../extension-platform';
import {
  createHarness,
  FIXTURES,
  waitFor,
  type PlatformHarness,
} from './helpers/platform-harness';

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BASIC = path.join(FIXTURES, 'ext-basic');

describe('dormant utility hosts (#137)', () => {
  let h: PlatformHarness;
  let platform: ExtensionPlatform;
  const snap = (id: string) => platform.snapshot().find((e) => e.id === id);

  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    await platform.stop();
    await h.close();
    delete process.env.KIA_DORMANT_HOSTS;
  });

  async function startWith(overrides = {}) {
    platform = h.make({ dormantExtensions: ['test.basic'], dormantAfterMs: 40, ...overrides });
    await platform.start();
    await h.install(platform, BASIC);
  }

  it('e2e: activate → dormant → a tool call wakes the host and returns the right result', async () => {
    await startWith();
    await waitFor(() => snap('test.basic')?.dormant === true);
    expect(snap('test.basic')?.status).toBe('activated');
    // soft stop keeps tools/list and the source identical
    expect([...h.tools.keys()]).toEqual(['basic_echo']);
    expect(h.registry.has('basicsrc')).toBe(true);
    const before = h.counts.registerTool;

    await expect(h.tools.get('basic_echo')!.call({ x: 1 })).resolves.toEqual({
      echoed: { x: 1 },
    });
    expect(h.spawns.get('test.basic')).toBe(2);
    expect(snap('test.basic')?.dormant).toBeUndefined();
    expect(h.counts.registerTool).toBe(before); // equal contributions: no re-registration
  });

  it('a source verb wakes it too', async () => {
    await startWith();
    await waitFor(() => snap('test.basic')?.dormant === true);
    await expect(h.registry.get('basicsrc')!.connect({} as never)).resolves.toEqual({
      identifier: 'basic-account',
      config: {},
    });
  });

  it('an extension not on the allowlist never goes dormant', async () => {
    await startWith({ dormantExtensions: [] });
    await sleepMs(200);
    expect(snap('test.basic')?.dormant).toBeUndefined();
    expect(h.spawns.get('test.basic')).toBe(1);
  });

  it('KIA_DORMANT_HOSTS=0 disables dormancy', async () => {
    process.env.KIA_DORMANT_HOSTS = '0';
    await startWith();
    await sleepMs(200);
    expect(snap('test.basic')?.dormant).toBeUndefined();
  });

  it('an allowlisted in-process (unsafe.mainProcess) extension is never dormant', async () => {
    platform = h.make({
      bundledDir: h.copyBundled('ext-bundled'),
      dormantExtensions: ['test.bundled'],
      dormantAfterMs: 40,
    });
    await platform.start();
    await sleepMs(200);
    expect(snap('test.bundled')?.status).toBe('activated');
    expect(snap('test.bundled')?.dormant).toBeUndefined();
  });

  it('hard stop of a dormant host: registrations and cadence go, status disabled', async () => {
    await startWith();
    const account = await h.store.createAccount({
      source: 'basicsrc',
      identifier: 'basic-account',
      config: {},
      status: 'live',
    });
    await waitFor(() => snap('test.basic')?.dormant === true);
    expect(await platform.setEnabled('test.basic', false)).toEqual({ ok: true });
    expect(h.tools.has('basic_echo')).toBe(false);
    expect(h.registry.has('basicsrc')).toBe(false);
    expect(snap('test.basic')?.status).toBe('disabled');
    expect(snap('test.basic')?.dormant).toBeUndefined();
    expect(h.scheduler.unregister).toHaveBeenCalledWith(`source:basicsrc:${account.id}`);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/main/platform/__tests__/extension-platform-dormant.test.ts`
Expected: FAIL. `dormantExtensions` is not a dep (TS), and nothing goes dormant.

- [ ] **Step 3: Implement**

(a) `src/shared/contracts.ts`, in `ExtensionSnapshot` after `activatedAt?`:
```ts
  /** #137: the host is soft-stopped (no process) while every contribution
   *  stays registered; the next call wakes it. Status stays 'activated'.
   *  Present only when true. */
  dormant?: boolean;
```

(b) `extension-platform.ts`:
- After `IN_PROCESS_READY_MS` add:
  ```ts
  /** #137: idle time before an allowlisted utility host soft-stops. */
  export const DORMANT_AFTER_MS = 5 * 60_000;
  ```
- `ExtensionPlatformDeps` additions:
  ```ts
  /** #137: utility extensions that may go dormant when idle — the product's
   *  audited allowlist (product.json `dormantExtensions`). Absent/empty: none.
   *  `KIA_DORMANT_HOSTS=0` disables dormancy regardless. Never applies to
   *  bundled or `unsafe.mainProcess` entries. */
  dormantExtensions?: readonly string[];
  /** Test seam for DORMANT_AFTER_MS. */
  dormantAfterMs?: number;
  ```
- `Entry`: add `dormant?: boolean;`.
- `snapshot()`: after `activatedAt: e.activatedAt,` add `...(e.dormant ? { dormant: true } : {}),`.
- `setStatus`: as its first statement add `if (status !== 'activated') e.dormant = false;`.
- `activate()`: after `const inProcess = …` add:
  ```ts
    const dormancy =
      !inProcess &&
      e.origin !== 'bundled' &&
      process.env.KIA_DORMANT_HOSTS !== '0' &&
      (deps.dormantExtensions ?? []).includes(e.manifest.id)
        ? { idleMs: deps.dormantAfterMs ?? DORMANT_AFTER_MS }
        : undefined;
  ```
  In the `createExtensionHost({ … })` literal, before `...(inProcess ? { killAfterMs … } : {})`, add:
  ```ts
      ...(dormancy ? { dormancy } : {}),
      onDormant: (dormant) => {
        if (e.host !== host) return; // a replaced host's late signal
        e.dormant = dormant;
        changed();
      },
  ```

(c) `src/main/main.ts`, inside `createExtensionPlatform({...})` after `bundledDir: bundledExtensionsDir,`:
```ts
      dormantExtensions: product.dormantExtensions,
```

- [ ] **Step 4: Run, then the full gates**

Run: `npx jest src/main/platform/__tests__/extension-platform-dormant.test.ts src/main/platform/__tests__/extension-platform.test.ts src/main/platform/__tests__/extension-platform-boot.test.ts`
Expected: PASS.

Run: `npx tsc --noEmit -p .`
Expected: clean.

Run: `/private/tmp/claude-501/-Users-edjafarov-work-alpha-cent/4c50a2e2-79f9-4098-aef4-8a2c75761c3a/scratchpad/opt/heavy.sh npx jest`
Expected: PASS, excepting failures that are pre-existing on `v0.106.0`.

Run: `/private/tmp/claude-501/-Users-edjafarov-work-alpha-cent/4c50a2e2-79f9-4098-aef4-8a2c75761c3a/scratchpad/opt/heavy.sh npm run lint`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
MSG=/private/tmp/claude-501/-Users-edjafarov-work-alpha-cent/4c50a2e2-79f9-4098-aef4-8a2c75761c3a/scratchpad/opt/boot-commit-msg.txt
cd ~/work/kcore-boot
cat > "$MSG" <<'EOF'
feat(platform): dormant utility hosts behind the product allowlist (#137)

Allowlisted marketplace hosts soft-stop after 5 idle minutes and wake on the
next call; registrations, tools/list and cadence stay. KIA_DORMANT_HOSTS=0
disables it. Core alone changes nothing (empty allowlist).
EOF
git add src/main/platform/__tests__/extension-platform-dormant.test.ts
git commit -F "$MSG" -- src/shared/contracts.ts src/main/platform/extension-platform.ts src/main/main.ts src/main/platform/__tests__/extension-platform-dormant.test.ts
```

After B5, the controller releases core with Parts A and B. That release is the core version Part C pins.

---

# Part C — alpha-cent overlay follow-up [alpha-cent]

Part C runs in a fresh alpha-cent worktree, created from alpha-cent `dev` after the core release that contains A+B. Follow the worktree-gates-via-symlinked-deps memory: symlink deps, never `npm ci` in the worktree, and unlink before removing the worktree. Run targeted jest as `npx jest --config package.json <file>`, and the harness tests as `node --test build/<file>.test.mjs`.

### Per-connector dormancy audit (recorded 2026-10-09; each repo on `main`)

Scope: non-test `src/` of each connector. Across all eleven repos the grep found:
- no `fs.watch`, `chokidar`, `host.files.watch` or `.watch(`;
- no `host.events.on`, `host.attention.*`, `host.ui.*` or `ui.handle`;
- no `ws`, `net.connect`, `tls.connect`, socket-mode or `keepAlive` outside a pull.

Every `activate()` returns `{ sources: [...] }`.

| Connector @ HEAD | Manifest id | Cadence | Caps | Timers | Sockets | Watchers | Live pull | Verdict |
|---|---|---|---|---|---|---|---|---|
| agent-sessions @ 6c7dd66 | kia.agent-sessions | 15m | files | none | none | none (host.files used only inside pulls) | no | **allow** |
| google-docs @ e2febb0 | kia.google-docs | 15m | net, query | retry sleep in request, `src/client.ts:114` | none | none | no | **allow** |
| instagram @ 4aa6676 | kia.instagram | 15m | net, query, send | retry sleep in request, `src/client.ts:138` | none | none | no (bounded delta sweep) | **allow** |
| ms365 @ 9b6c82f | kia.ms365 | 15m | net, send | retry sleep in request, `src/graph-client.ts:164` | none | none | no (bounded delta sweep) | **allow** |
| onedrive @ dead8d2 | kia.onedrive | 15m | net, query | retry sleep in request, `src/client.ts:120` | none | none | no (bounded delta sweep) | **allow** |
| hubspot @ 2809308 | kia.hubspot | 30m | net | retry sleep in request, `src/client.ts:64` | none | none | no | **allow** |
| notion @ 039931d | kia.notion | 30m | net | retry sleep in request, `src/client.ts:90` | none | none | no | **allow** |
| google-calendar @ d9b48f8 | kia.google-calendar | 5m | net, query | none | none | none | no | exclude: a 5-min cadence never idles 5 min, no saving |
| slack @ 8451324 | kia.slack | 15m | net, send | retry sleep in request, `src/client.ts:127` | none found | none | no found | exclude: the spec lists it as socket-mode live; verify on a live account before adding |
| telegram @ ba35869 | kia.telegram | 15m | net, query, send | `src/runtime.ts:327` flush debounce; FloodWait sleep | MTProto `TelegramClient`, `src/client.ts:64` (autoReconnect) | none | **yes**, `src/source.ts:199` | exclude: live |
| whatsapp @ e2451f7 | kia.whatsapp | 15m | net, query, send | `src/socket.ts:144` reconnect; `src/runtime.ts:399,430` | Baileys socket, `src/source.ts:116` | none | **yes**, `src/source.ts:196` | exclude: live |

The retry sleeps are created inside a request and resolve on their own. google-docs, ms365 and onedrive each state at `client.ts:27` / `graph-client.ts:29` that "the connector no longer arms its own timers". Dormancy can therefore only take effect between pulls, never mid-request: a request in flight counts as in flight.

Allowlist: `["kia.agent-sessions", "kia.google-docs", "kia.instagram", "kia.ms365", "kia.onedrive", "kia.hubspot", "kia.notion"]`.

---

### Task C1 [alpha-cent]: Dev product config copies `dormantExtensions`

**Files:**
- Create: `build/dev-product-config.mjs`, `build/dev-product-config.test.mjs`
- Modify: `build/dev-product.mjs` (step 2, `writeJson(PRODUCT_JSON, {...})`)

**Interfaces:**
- Produces: `export function devProductConfig({ product, stagedDir }): { productName: string; bundledExtensionsDir: string; dormantExtensions?: string[] }`

- [ ] **Step 1: Write the failing test**

`build/dev-product-config.test.mjs`:
```js
import assert from 'node:assert';
import { test } from 'node:test';
import { devProductConfig } from './dev-product-config.mjs';

test('copies dormantExtensions from product/product.json into the dev config', () => {
  assert.deepStrictEqual(
    devProductConfig({
      product: { productName: 'KIAgent', macUpdatesEnabled: true, dormantExtensions: ['kia.notion'] },
      stagedDir: '/abs/staged',
    }),
    { productName: 'KIAgent', bundledExtensionsDir: '/abs/staged', dormantExtensions: ['kia.notion'] },
  );
});

test('omits the key when product.json has none (older core rejects unknown keys)', () => {
  assert.deepStrictEqual(
    devProductConfig({ product: { productName: 'KIAgent' }, stagedDir: '/abs/staged' }),
    { productName: 'KIAgent', bundledExtensionsDir: '/abs/staged' },
  );
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test build/dev-product-config.test.mjs`
Expected: FAIL. The module does not exist.

- [ ] **Step 3: Implement**

`build/dev-product-config.mjs`:
```js
/**
 * The dev app's product.json (written by dev-product.mjs). Side-effect-free
 * so it is testable without importing dev-product.mjs (which fetches core at
 * load). macUpdatesEnabled stays off in dev; dormantExtensions (#137) is
 * copied from product/product.json so a dev measurement runs with the same
 * allowlist as the packaged app. Core's product schema is strict — the key
 * is written only when present.
 */
export function devProductConfig({ product, stagedDir }) {
  return {
    productName: 'KIAgent',
    bundledExtensionsDir: stagedDir,
    ...(Array.isArray(product.dormantExtensions)
      ? { dormantExtensions: product.dormantExtensions }
      : {}),
  };
}
```
In `build/dev-product.mjs` add `import { devProductConfig } from './dev-product-config.mjs';` and replace step 2's `writeJson(PRODUCT_JSON, { productName: 'KIAgent', bundledExtensionsDir: STAGED });` with:
```js
writeJson(
  PRODUCT_JSON,
  devProductConfig({
    product: JSON.parse(fs.readFileSync(path.join(ROOT, 'product', 'product.json'), 'utf8')),
    stagedDir: STAGED,
  }),
);
```

- [ ] **Step 4: Run, lint, commit**

Run: `node --test build/dev-product-config.test.mjs && npx eslint build/dev-product.mjs build/dev-product-config.mjs build/dev-product-config.test.mjs`
Expected: PASS / clean.

```bash
MSG=/private/tmp/claude-501/-Users-edjafarov-work-alpha-cent/4c50a2e2-79f9-4098-aef4-8a2c75761c3a/scratchpad/opt/boot-commit-msg.txt
printf '%s\n' 'build(dev): dev product config copies dormantExtensions (#137)' > "$MSG"
git add build/dev-product-config.mjs build/dev-product-config.test.mjs
git commit -F "$MSG" -- build/dev-product.mjs build/dev-product-config.mjs build/dev-product-config.test.mjs
```

---

### Task C2 [alpha-cent]: SignIn waits for remote-mcp's activation

**Files:**
- Modify: `src/overlay/renderer/screens/SignIn.tsx`
- Test: `src/__tests__/overlay-signin.test.tsx`

**Interfaces:**
- Consumes: `useAppState` from `@renderer/state/app-state` (core). SignIn mounts inside App.tsx's `state !== null` gate, so the hook is legal. `ExtensionSnapshot.status`/`enabled`, where the remote-mcp id is `kiagent.remote-mcp`.
- Dependency to keep in mind: an empty or absent remote-mcp entry means "absent", not "not yet loaded". That holds only because core runs `extensions.load()` before `createWindow()`, and `patchState` updates `lastPush` synchronously (`app:get-state` returns it).
- Gate:
  - Entry `activated` → read `auth:expected-account` and `auth:skip-allowed`. Read them again on every later transition into `activated`.
  - `activating`, or a transient `'disabled'` while `enabled: true` → `expected` is (re)set to `undefined` (the existing no-actions loading state) and `skipAllowed` to `false`, also when it had been `activated` before; no invoke is sent.
  - `errored`, `enabled: false` (user-disabled), absent, or `needs-consent` → `null` (fresh), as today's catch path does.

- [ ] **Step 1: Update the tests**

At the top of `src/__tests__/overlay-signin.test.tsx`, after the imports:
```tsx
import type { ExtensionSnapshot } from '@shared/contracts';

let mockExtensions: Array<Partial<ExtensionSnapshot>> = [];
jest.mock('@renderer/state/app-state', () => ({
  useAppState: (sel: (s: { extensions: unknown[] }) => unknown) =>
    sel({ extensions: mockExtensions }),
}));
const remoteMcp = (status: ExtensionSnapshot['status'], enabled = true) => [
  { id: 'kiagent.remote-mcp', status, enabled },
];

beforeEach(() => {
  mockExtensions = remoteMcp('activated'); // every existing case: remote-mcp up
});
```
Append:
```tsx
describe('remote-mcp readiness (#140)', () => {
  test('ready → starting → ready: actions hide while starting and both channels are read again', async () => {
    const invoke = mockKiagent({ provider: 'google', email: 'me@x.com' });
    const view = render(<SignIn />);
    expect(await screen.findByText('me@x.com')).toBeInTheDocument();
    mockExtensions = remoteMcp('disabled', true); // worker respawn deactivates it
    view.rerender(<SignIn />);
    await waitFor(() => expect(screen.queryByText('me@x.com')).toBeNull());
    expect(screen.queryByRole('button', { name: /Sign in/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /skip/i })).toBeNull();
    invoke.mockClear();
    mockExtensions = remoteMcp('activated');
    view.rerender(<SignIn />);
    expect(await screen.findByText('me@x.com')).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith('auth:expected-account', undefined);
    expect(invoke).toHaveBeenCalledWith('auth:skip-allowed', undefined);
  });

  test('shows no actions and invokes nothing while remote-mcp is activating', async () => {
    mockExtensions = remoteMcp('activating');
    const invoke = mockKiagent({ provider: 'google', email: 'me@x.com' });
    render(<SignIn />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('button', { name: /Sign in/i })).toBeNull();
    expect(invoke).not.toHaveBeenCalledWith('auth:expected-account', undefined);
  });

  test('reads both channels once remote-mcp turns activated', async () => {
    mockExtensions = remoteMcp('activating');
    const invoke = mockKiagent({ provider: 'google', email: 'me@x.com' });
    const view = render(<SignIn />);
    mockExtensions = remoteMcp('activated');
    view.rerender(<SignIn />);
    expect(await screen.findByText('me@x.com')).toBeInTheDocument();
    expect(invoke).toHaveBeenCalledWith('auth:expected-account', undefined);
    expect(invoke).toHaveBeenCalledWith('auth:skip-allowed', undefined);
  });

  test.each([
    ['errored', remoteMcp('errored')],
    ['user-disabled', remoteMcp('disabled', false)],
    ['absent', []],
  ])('degrades to the fresh state when remote-mcp is %s', async (_why, exts) => {
    mockExtensions = exts;
    const invoke = mockKiagent({ provider: 'google', email: 'me@x.com' });
    render(<SignIn />);
    expect(
      await screen.findByRole('button', { name: /Sign in with Microsoft/i }),
    ).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith('auth:expected-account', undefined);
  });
});
```
(Check that the existing returning-device test asserts the email text the same way. If it uses a different query, mirror that query in "reads both channels" and "ready → starting → ready". Add `waitFor` to the file's `@testing-library/react` import if it is not there. If `mockKiagent` does not return a `jest.Mock`, adapt `invoke.mockClear()` to whatever handle it returns. The skip-button query must match the existing skip test's button name.)

- [ ] **Step 2: Run to verify failure**

Run: `npx jest --config package.json src/__tests__/overlay-signin.test.tsx`
Expected: the new `remote-mcp readiness` cases FAIL. Today's effect invokes on mount whatever the status is, so the activating and degrade cases fail. The existing cases PASS.

- [ ] **Step 3: Implement in `SignIn.tsx`**

Add the import `import { useAppState } from '@renderer/state/app-state';` and a constant `const REMOTE_MCP_ID = 'kiagent.remote-mcp';`. Replace the mount-only `useEffect(() => { … }, []);` with:
```tsx
  // #140: the window can open before remote-mcp (which registers the two
  // auth channels) has activated. Read them only once it has — and again on
  // every later activation; until then stay in the no-actions loading state.
  // `[]`/absent means absent: core discovers extensions before the window.
  const remoteMcp = useAppState((s): 'ready' | 'starting' | 'gone' => {
    const e = s.extensions.find((x) => x.id === REMOTE_MCP_ID);
    if (!e || !e.enabled || e.status === 'errored' || e.status === 'needs-consent')
      return 'gone';
    if (e.status === 'activated') return 'ready';
    return 'starting'; // activating, or a transient deactivate while enabled
  });

  useEffect(() => {
    if (remoteMcp === 'gone') {
      // No auth extension: the fresh state, as a failed lookup degrades.
      setExpected(null);
      setSkipAllowed(false);
      return undefined;
    }
    if (remoteMcp === 'starting') {
      // Back to the no-actions loading state — also after an earlier
      // activation (worker respawn): stale buttons and a stale skip
      // permission must not stay actionable while the channels are gone.
      setExpected(undefined);
      setSkipAllowed(false);
      return undefined;
    }
    let alive = true;
    kiagent()
      .invoke('auth:expected-account', undefined)
      .then((res) => {
        if (alive) setExpected(res ?? null);
      })
      .catch(() => {
        // A failed lookup degrades to the fresh state; main still enforces
        // the account match.
        if (alive) setExpected(null);
      });
    kiagent()
      .invoke('auth:skip-allowed', undefined)
      .then((res) => {
        // Anything but an explicit yes keeps the button hidden.
        if (alive) setSkipAllowed(res === true);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [remoteMcp]);
```
Also update the component doc comment by appending a sentence: "Initial state waits for remote-mcp's activation (#140)."

- [ ] **Step 4: Run, lint, commit**

Run: `npx jest --config package.json src/__tests__/overlay-signin.test.tsx src/__tests__/shadow-baselines.test.ts`
Expected: PASS. If `shadow-baselines` pins a hash/baseline of the SignIn shadow, update it in the way that test's header describes.

Run: `npx eslint src/overlay/renderer/screens/SignIn.tsx src/__tests__/overlay-signin.test.tsx`

```bash
MSG=/private/tmp/claude-501/-Users-edjafarov-work-alpha-cent/4c50a2e2-79f9-4098-aef4-8a2c75761c3a/scratchpad/opt/boot-commit-msg.txt
printf '%s\n' 'fix(signin): wait for remote-mcp activation before reading the expected account (#140)' > "$MSG"
git commit -F "$MSG" -- src/overlay/renderer/screens/SignIn.tsx src/__tests__/overlay-signin.test.tsx
```
(Add the shadow-baseline file to the path list if Step 4 changed it.)

---

### Task C3 [alpha-cent]: Pin the core release, add the allowlist, re-verify overlay anchors (one commit)

**Files:**
- Modify: `core.lock`, `product/product.json`

Spec B1 requires the `product.json` key to land in the same commit as the core pin that knows it, never before. An older core falls back to defaults on any unknown key and drops the product name.

- [ ] **Step 1: Bump `core.lock`** to the released core tag that contains Parts A and B. Use the peeled commit, per the dev-backlog memory:
```json
{
  "repo": "https://github.com/edjafarov/kiagent-core.git",
  "tag": "<vX.Y.Z>",
  "commit": "<peeled commit of vX.Y.Z>"
}
```
Get the commit with `git -C ~/work/kiagent-core rev-parse "<vX.Y.Z>^{commit}"`.

- [ ] **Step 2: Add the allowlist** to `product/product.json`:
```json
{
  "productName": "KIAgent",
  "macUpdatesEnabled": true,
  "dormantExtensions": [
    "kia.agent-sessions",
    "kia.google-docs",
    "kia.instagram",
    "kia.ms365",
    "kia.onedrive",
    "kia.hubspot",
    "kia.notion"
  ]
}
```

- [ ] **Step 3: Re-verify the overlay anchors by running them, not by eyeballing.** Run these in the worktree, one heavy step at a time. Expected: every step is clean, and `apply-overlay` prints its shadows without `anchor not found`.
  - `node build/fetch-core.mjs`. It re-clones `build/.core`, so never run it where a dev app is running.
  - `node build/apply-overlay.mjs`. It must not throw on any anchor, `patchQuitSignals` included: `app.on('before-quit', (event) => {` must still exist, unchanged.
  - `node --test build/apply-overlay.test.mjs build/dev-product-config.test.mjs`
  - `/private/tmp/claude-501/-Users-edjafarov-work-alpha-cent/4c50a2e2-79f9-4098-aef4-8a2c75761c3a/scratchpad/opt/heavy.sh npm run typecheck:overlay`
  - `npx jest --config package.json src/__tests__/overlay-signin.test.tsx`
  - `/private/tmp/claude-501/-Users-edjafarov-work-alpha-cent/4c50a2e2-79f9-4098-aef4-8a2c75761c3a/scratchpad/opt/heavy.sh npx jest --config package.json`
  - `/private/tmp/claude-501/-Users-edjafarov-work-alpha-cent/4c50a2e2-79f9-4098-aef4-8a2c75761c3a/scratchpad/opt/heavy.sh npm run lint`

- [ ] **Step 4: Commit both files together**

```bash
MSG=/private/tmp/claude-501/-Users-edjafarov-work-alpha-cent/4c50a2e2-79f9-4098-aef4-8a2c75761c3a/scratchpad/opt/boot-commit-msg.txt
cat > "$MSG" <<'EOF'
chore(core): pin kiagent-core <vX.Y.Z> (window-first boot, dormant hosts) + dormancy allowlist

dormantExtensions lists the audited 15/30-min connectors (no timers, sockets
or watchers outside pulls); google-calendar (5-min), slack (unverified live),
telegram and whatsapp (live pulls) stay out. Same commit as the pin: an older
core rejects the unknown key.
EOF
git commit -F "$MSG" -- core.lock product/product.json
```

---

### Task C4 (CONTROLLER) [alpha-cent]: Measurements with the overlay

- [ ] **Step 1: RSS and process count 15 min after boot, founder Mac.**
  - *Before:* the current release, with no allowlist. Record:
    - utility process count (`ps -axo pid,rss,command | grep kia-ext:`);
    - summed RSS of those processes;
    - main-process RSS.
  - *After:* this release, with the allowlist in product.json. The controller runs it from an already-staged dev worktree, following the `~/work/ac-dev146` pattern: node_modules and `.env` are symlinked, and the staged extensions already exist. Inside that symlinked worktree the controller never runs `stageExtensions` (which `node build/dev-product.mjs` triggers when staging is absent), `npm ci`, or `npm run build`. Any staging or extension build happens beforehand, outside the worktree, through `/private/tmp/claude-501/-Users-edjafarov-work-alpha-cent/4c50a2e2-79f9-4098-aef4-8a2c75761c3a/scratchpad/opt/heavy.sh`. A packaged build is the alternative. Record the same three numbers at 15 minutes after boot, plus the `extension host is dormant` / `waking dormant extension host` lines.
  - *Expected:* about 4–6 fewer utility processes' RSS at steady state.
- [ ] **Step 2: Time-to-window with the overlay.** If A8 used a core-only stand-in, repeat it with the overlay build on Mac and the Windows VM. Confirm that SignIn shows the returning-device state once `kiagent.remote-mcp` activates, with no fresh-state flash.
- [ ] **Step 3: Record both** in issues #140 and #137.
