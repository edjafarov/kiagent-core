# Outbox History Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Spec phase 9 — an in-app Outbox screen in the core renderer: recent outbound drafts with status, plus Review & send (opens the confirm page), Discard, and Draft again (re-draft a failed/expired row) actions.

**Architecture:** A new top-level renderer screen (`screens/Outbox/`) wired through the existing view-state navigation (no router). Data flows over four new typed IPC channels handled by a `registerOutboundIpc` delegate (mirroring `registerUpdaterIpc`); the renderer refetches on mount and after every mutation (the app remounts screens on re-navigation, so no push channel is needed — YAGNI). The service gains two panel-only methods: `confirmUrlFor` (fresh page link for a pending draft) and `redraft` (duplicate a terminal row into a fresh draft under the account's CURRENT mode).

**Tech Stack:** TypeScript, React (plain global CSS, `@shared/web-ui` primitives), Electron IPC, jest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-23-unified-outbound-design.md` §10, §12 phase 9.

## Global Constraints

- Repo: `/Users/edjafarov/work/kiagent-core`, branch `dev`. **Prerequisite: the phase-1 outbound plan is fully landed** (`docs/superpowers/plans/2026-07-23-unified-outbound-phase1.md`). Independent of the remote-confirm / gmail / mode-C plans — must land cleanly whether or not they have.
- Never amend/rebase/reset; never bypass commit hooks; no `Co-Authored-By`/promo in commit messages. Subagents do NOT commit — the orchestrator commits serially. No worktrees (jest silently ignores tests under `.claude/worktrees/*`).
- The preload bridge rejects renderer-invoked channels missing from `INVOKE_CHANNELS` (`src/shared/ipc.ts`) — and the alpha-cent overlay ALSO needs them in `REMOTE_INVOKE_CHANNELS` (`build/apply-overlay.mjs`), recorded as a handoff note (Task 4). jest never catches a missing entry.
- The renderer never receives arbitrary URLs to open: `outbox:open-confirm`/`outbox:redraft` take a draft id and main-process code mints + opens the URL (`shell.openExternal`, injected for testability).
- No new push channels, no `AppState` slice — mount-refetch + refetch-after-mutation only.
- Reuse `@shared/web-ui` primitives (`Busy`, `Pill`) and `.btn` class strings; there is NO Button/Card primitive and no CSS modules/Tailwind — plain global CSS, one sheet per screen.
- Final gate: FULL `npm test` + `npm run lint` + `npm run typecheck`.

## Parallel Execution Guide (subagent-driven)

Implementers on **sonnet**, one per task, same checkout:

- **Wave 1:** Task 1 (service panel surface)
- **Wave 2:** Task 2 (IPC channels + delegate)
- **Wave 3:** Task 3 (renderer screen + navigation)
- **Wave 4:** Task 4 (full gates + handoff)

(Strictly serial by data dependency — each task consumes the previous one's surface. The win here is fresh per-task reviewers, not concurrency.)

## File Structure

| File | Change | Responsibility |
| --- | --- | --- |
| `src/shared/contracts.ts` | modify | `createdVia` gains `'panel'` |
| `src/main/outbound/service.ts` | modify | `confirmUrlFor`, `redraft` |
| `src/shared/ipc.ts` | modify | `OutboxPanelRow` wire type + 4 `outbox:*` channels |
| `src/main/outbound/ipc.ts` | create | `registerOutboundIpc` delegate (list/discard/redraft/open) |
| `src/main/main.ts` | modify | wire the delegate |
| `src/renderer/state/view.ts` | modify | `'outbox'` view |
| `src/renderer/screen-registry.tsx` | modify | Outbox screen factory |
| `src/renderer/components/TopBar.tsx` | modify | Outbox nav tab |
| `src/renderer/screens/Outbox/index.tsx` | create | the screen |
| `src/renderer/screens/Outbox/Outbox.css` | create | screen styles |

---

### Task 1: Service panel surface — `confirmUrlFor` + `redraft`

**Files:**
- Modify: `src/shared/contracts.ts`, `src/main/outbound/service.ts`
- Test: `src/main/outbound/__tests__/service.test.ts` (append)

**Interfaces:**
- Consumes: phase-1 `OutboundService` internals (`modeFor`, the URL-minting used by `listOutbox`, `DRAFT_TTL_MS`), `OutboxStore.create/get/transition`.
- Produces (used by Task 2), added to `OutboundService` (NOT to `OutboundToolApi` — these are panel-only, never MCP-exposed):

```ts
  /** Panel support: fresh confirm URL for a pending draft (chat-mode rows
   *  land on the full review page, strictly stronger). Null unless the row
   *  is status 'draft'. */
  confirmUrlFor(draftId: string): Promise<string | null>;
  /** Panel support: duplicate a terminal row (failed/expired/discarded/
   *  delivery_unknown) into a fresh draft — content, recipients, and
   *  threading copied verbatim; mode re-frozen from the account's CURRENT
   *  setting; fresh 24h TTL; createdVia 'panel'. Pending-cap and
   *  sender-availability gates apply exactly as at draft_reply time. */
  redraft(draftId: string): Promise<OutboxRow>;
```

Contracts change: `OutboxRow.createdVia` and `OutboxDraftInput.createdVia` widen to `'mcp-local' | 'mcp-remote' | 'panel'` (the `created_via` column has no CHECK — no migration needed).

Behavior contract (encode in tests):
- `confirmUrlFor`: `expireOverdue()` first; unknown id or status ≠ `'draft'` → `null`; else mint exactly the URL `listOutbox` would re-issue (same signer, same per-mode TTL).
- `redraft`: unknown id → Error naming it; status `'draft'`/`'sending'`/`'sent'` → Error `only failed, expired, discarded, or delivery-unknown drafts can be re-drafted — this one is '<status>'`; account gone → Error; account's source no longer in `senders` → the same unsupported-source error `draftReply` uses. Creates via `store.outbox.create` with fields copied from the old row (`kind`, `replyToDocumentId`, `outboundRef`, `recipientDisplay`, `to`, `cc`, `subject`, `bodyMarkdown`, `threading`), `confirmMode: modeFor(account)` (CURRENT setting — the old row's frozen mode is history), `createdVia: 'panel'`, `expiresAt: now + DRAFT_TTL_MS`. Returns the new row; the old row is untouched.

- [ ] **Step 1: Write the failing tests**

Append to `src/main/outbound/__tests__/service.test.ts` inside the top-level describe (reuses `service`, `store`, `docId`, `sendMock` from the phase-1 harness):

```ts
  it('confirmUrlFor mints a link for pending drafts only', async () => {
    const r = await service.draftReply({ documentId: docId, body: 'Yo' });
    const url = await service.confirmUrlFor(r.draft_id);
    expect(url).toContain('/outbox/confirm/');
    await service.cancelByToken(url!.split('/outbox/confirm/')[1]);
    expect(await service.confirmUrlFor(r.draft_id)).toBeNull();
    expect(await service.confirmUrlFor('nope')).toBeNull();
  });

  it('redraft duplicates a failed row under the current mode', async () => {
    sendMock.mockRejectedValueOnce(new Error('SMTP 421 try later'));
    const r = await service.draftReply({ documentId: docId, body: 'Original' });
    const token = r.confirm_url!.split('/outbox/confirm/')[1];
    await service.confirmByToken(token); // lands in 'failed'
    const fresh = await service.redraft(r.draft_id);
    expect(fresh.id).not.toBe(r.draft_id);
    expect(fresh.status).toBe('draft');
    expect(fresh.bodyMarkdown).toBe('Original');
    expect(fresh.recipientDisplay).toBe(r.recipient_display);
    expect(fresh.createdVia).toBe('panel');
    expect((await store.outbox.get(r.draft_id))?.status).toBe('failed');
  });

  it('redraft refuses pending and sent rows', async () => {
    const pending = await service.draftReply({ documentId: docId, body: 'a' });
    await expect(service.redraft(pending.draft_id)).rejects.toThrow(/'draft'/);
    const ok = await service.draftReply({ documentId: docId, body: 'b' });
    await service.confirmByToken(ok.confirm_url!.split('/outbox/confirm/')[1]);
    await expect(service.redraft(ok.draft_id)).rejects.toThrow(/'sent'/);
  });
```

(If the phase-1 harness names the confirm-token helper differently — e.g. a shared `tokenOf` — reuse it instead of the inline splits.)

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/main/outbound/__tests__/service.test.ts -v`
Expected: FAIL — `confirmUrlFor`/`redraft` are not functions.

- [ ] **Step 3: Implement**

- `src/shared/contracts.ts`: widen both `createdVia` declarations to `'mcp-local' | 'mcp-remote' | 'panel'` (update the doc comment: `'panel'` = re-drafted from the in-app Outbox screen).
- `src/main/outbound/service.ts`: implement both methods per the behavior contract. `confirmUrlFor` must call the SAME private URL-mint helper `listOutbox` uses (extract one if phase-1 landed it inline — the signer, TTL table, and base URL must have exactly one home). Add both to the `OutboundService` interface.

- [ ] **Step 4: Run the outbound suite, expect PASS**

Run: `npx jest src/main/outbound -v`
Expected: PASS, phase-1 tests untouched.

- [ ] **Step 5: Commit**

```bash
cd /Users/edjafarov/work/kiagent-core
git add src/shared/contracts.ts src/main/outbound/service.ts src/main/outbound/__tests__/service.test.ts
git commit -m "feat(outbound): panel surface — confirmUrlFor + redraft (createdVia 'panel')"
```

---

### Task 2: IPC — wire types, channels, `registerOutboundIpc`

**Files:**
- Modify: `src/shared/ipc.ts`, `src/main/main.ts`
- Create: `src/main/outbound/ipc.ts`
- Test: `src/main/outbound/__tests__/ipc.test.ts`

**Interfaces:**
- Consumes: Task 1 (`confirmUrlFor`, `redraft`), `OutboundService`, `CoreStore.outbox` + `store.account`, the `Invokes`/`INVOKE_CHANNELS` conventions in `src/shared/ipc.ts` (interface at ~line 161, array at ~line 362 — `] as const satisfies readonly InvokeChannel[]` enforces sync), the delegate pattern from `registerUpdaterIpc` (`src/main/main.ts:509-513`).
- Produces (used by Task 3):

```ts
// src/shared/ipc.ts — beside the other wire types (e.g. McpInfo):
export interface OutboxPanelRow {
  draftId: string;
  status: OutboxStatus;          // import type from '@shared/contracts'
  kind: 'reply' | 'new';
  accountLabel: string;          // account identifier, '(removed)' if gone
  recipientDisplay: string;
  subject: string | null;
  bodyPreview: string;           // first 140 chars, single line
  error: string | null;
  createdAt: string;             // ISO
  sentAt: string | null;         // ISO
}

// Invokes entries (grouped as a new `outbox:` block, after `mcp-activity:recent`):
  /** Outbox history panel: recent outbound rows, newest first. */
  'outbox:list': { req: { limit?: number }; res: OutboxPanelRow[] };
  /** Discard a pending draft (no-op if it left 'draft' meanwhile). */
  'outbox:discard': { req: { draftId: string }; res: void };
  /** Duplicate a terminal row into a fresh draft and open its confirm page. */
  'outbox:redraft': { req: { draftId: string }; res: { draftId: string } };
  /** Open the confirm page for a pending draft in the default browser. */
  'outbox:open-confirm': { req: { draftId: string }; res: void };

// src/main/outbound/ipc.ts:
export function registerOutboundIpc(deps: {
  handle: <C extends keyof Invokes>(
    channel: C,
    fn: (req: Invokes[C]['req']) => Promise<Invokes[C]['res']> | Invokes[C]['res'],
  ) => void;
  service: OutboundService;
  store: CoreStore;
  openExternal: (url: string) => Promise<void>; // shell.openExternal, injected for tests
}): void;
```

Behavior contract:
- `outbox:list`: `listRecent(limit ?? 50)` mapped to `OutboxPanelRow` — `accountLabel` from `store.account(row.accountId)` (`identifier`; `'(removed)'` when null; cache lookups per call), `bodyPreview = row.bodyMarkdown.replace(/\s+/g, ' ').trim().slice(0, 140)`.
- `outbox:discard`: `transition(draftId, ['draft'], 'discarded')` — result ignored (a lost race is fine; the panel refetches).
- `outbox:redraft`: `service.redraft` → `confirmUrlFor(newRow.id)` → `openExternal(url)` when non-null → `{ draftId: newRow.id }`. Service errors propagate to the renderer as rejected invokes.
- `outbox:open-confirm`: `confirmUrlFor(draftId)`; null → throw `Error('draft is no longer pending')`; else `openExternal(url)`.

- [ ] **Step 1: Write the failing tests**

Create `src/main/outbound/__tests__/ipc.test.ts` — reuse the store/service harness shape from `service.test.ts` (temp-dir store, imap account + doc fixture, jest.fn sender). Capture handlers with a fake `handle`:

```ts
import type { Invokes } from '@shared/ipc';
import { registerOutboundIpc } from '../ipc';

// …harness setup identical to service.test.ts beforeEach (store, service, docId)…

type Handler = (req: unknown) => Promise<unknown> | unknown;
let handlers: Map<string, Handler>;
let opened: string[];

beforeEach(() => {
  handlers = new Map();
  opened = [];
  registerOutboundIpc({
    handle: (channel, fn) => handlers.set(channel, fn as Handler),
    service,
    store,
    openExternal: async (url) => {
      opened.push(url);
    },
  });
});

const invoke = <C extends keyof Invokes>(c: C, req: Invokes[C]['req']) =>
  handlers.get(c)!(req) as Promise<Invokes[C]['res']>;

it('registers the four outbox channels', () => {
  expect([...handlers.keys()].sort()).toEqual([
    'outbox:discard',
    'outbox:list',
    'outbox:open-confirm',
    'outbox:redraft',
  ]);
});

it('outbox:list maps rows to panel shape', async () => {
  await service.draftReply({ documentId: docId, body: 'A long body '.repeat(30) });
  const rows = await invoke('outbox:list', {});
  expect(rows).toHaveLength(1);
  expect(rows[0].status).toBe('draft');
  expect(rows[0].accountLabel).toBe('me@example.com@imap.example.com');
  expect(rows[0].bodyPreview.length).toBeLessThanOrEqual(140);
  expect(rows[0].bodyPreview).not.toMatch(/\n/);
});

it('outbox:discard discards pending drafts and tolerates races', async () => {
  const r = await service.draftReply({ documentId: docId, body: 'x' });
  await invoke('outbox:discard', { draftId: r.draft_id });
  expect((await store.outbox.get(r.draft_id))?.status).toBe('discarded');
  await invoke('outbox:discard', { draftId: r.draft_id }); // second: no throw
});

it('outbox:open-confirm opens the page for pending drafts only', async () => {
  const r = await service.draftReply({ documentId: docId, body: 'x' });
  await invoke('outbox:open-confirm', { draftId: r.draft_id });
  expect(opened[0]).toContain('/outbox/confirm/');
  await invoke('outbox:discard', { draftId: r.draft_id });
  await expect(
    invoke('outbox:open-confirm', { draftId: r.draft_id }),
  ).rejects.toThrow(/no longer pending/);
});

it('outbox:redraft creates a fresh draft and opens its page', async () => {
  sendMock.mockRejectedValueOnce(new Error('boom'));
  const r = await service.draftReply({ documentId: docId, body: 'orig' });
  await service.confirmByToken(r.confirm_url!.split('/outbox/confirm/')[1]);
  const { draftId } = await invoke('outbox:redraft', { draftId: r.draft_id });
  expect(draftId).not.toBe(r.draft_id);
  expect((await store.outbox.get(draftId))?.status).toBe('draft');
  expect(opened.some((u) => u.includes('/outbox/confirm/'))).toBe(true);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/main/outbound/__tests__/ipc.test.ts -v`
Expected: FAIL — module `../ipc` does not exist.

- [ ] **Step 3: Implement**

- `src/shared/ipc.ts`: add `OutboxPanelRow` (import `OutboxStatus` as a type from `@shared/contracts`), the four `Invokes` entries, and the four channel strings in `INVOKE_CHANNELS` (keep the array's grouping/ordering convention).
- `src/main/outbound/ipc.ts`: implement per the behavior contract; module doc comment states the security posture (renderer sends draft ids, never URLs — main mints and opens).
- `src/main/main.ts`: inside `registerIpc`, after the extension block (~line 545), add:

```ts
  registerOutboundIpc({
    handle: (channel, fn) => handle(channel as never, fn as never),
    service: outbound,
    store: p.store,
    openExternal: (url) => shell.openExternal(url),
  });
```

with imports `import { registerOutboundIpc } from './outbound/ipc';` and `shell` from `'electron'` (it may already be imported). NOTE: `outbound` is created just before `startMcp` in phase-1's wiring (`main.ts` ~line 589) but `registerIpc` runs earlier from boot — pass the service into `registerIpc` the same way `broker`/`catalog` etc. are passed (add an `outbound: OutboundService` parameter and thread it from the boot call site at ~line 811; move the `createOutboundService` call ABOVE the `registerIpc` invocation if needed — it has no ordering dependency on `startMcp`, which only consumes it).

- [ ] **Step 4: Run tests + typecheck, expect PASS**

Run: `npx jest src/main/outbound -v` — Expected: PASS.
Run: `npm run typecheck` — Expected: clean (proves the `Invokes`/`INVOKE_CHANNELS` sync and the main.ts threading).

- [ ] **Step 5: Commit**

```bash
git add src/shared/ipc.ts src/main/outbound/ipc.ts src/main/outbound/__tests__/ipc.test.ts src/main/main.ts
git commit -m "feat(outbound): outbox panel IPC — list/discard/redraft/open-confirm delegate"
```

---

### Task 3: Renderer — Outbox screen + navigation

**Files:**
- Modify: `src/renderer/state/view.ts`, `src/renderer/screen-registry.tsx`, `src/renderer/components/TopBar.tsx`
- Create: `src/renderer/screens/Outbox/index.tsx`, `src/renderer/screens/Outbox/Outbox.css`

**Interfaces:**
- Consumes: `outbox:*` channels + `OutboxPanelRow` (Task 2), `Busy`/`Pill` from `@shared/web-ui/components`, `formatRelativeCompact` from `../Sources/format`, `.btn`/`.btn.sm`/`.btn.ghost`/`.btn.destructive` class strings, the tri-state list idiom from `screens/Connection/LocalClients.tsx` (null = loading, [] = empty), the two-click inline confirm idiom (Discard → Confirm/Cancel — a modal per row is too heavy).
- Produces: view `'outbox'` reachable from the top bar; no exports consumed elsewhere.

- [ ] **Step 1: Add the view + registry + tab**

- `src/renderer/state/view.ts` (~line 10): add `| 'outbox'` to the `View` union (after `'logs'`).
- `src/renderer/screen-registry.tsx` (~line 28): `import { Outbox } from '@renderer/screens/Outbox';` and add `outbox: { factory: () => <Outbox />, usesTopBar: true },` following the `marketplace` sibling exactly.
- `src/renderer/components/TopBar.tsx`: add between the Logs and Marketplace tabs, mirroring the `NavTab` sibling pattern (`const isOutboxActive = view === 'outbox';` beside the others):

```tsx
      <NavTab
        label="Outbox"
        icon="logs"
        active={isOutboxActive}
        onClick={() => navigate('outbox')}
      />
```

  Icon: check `@shared/web-ui/icon-sprite` for a send/paper-plane glyph id first and use it if one exists; `"logs"` is the fallback shown above.

- [ ] **Step 2: Implement the screen**

`src/renderer/screens/Outbox/index.tsx`:

```tsx
import React, { useCallback, useEffect, useState } from 'react';
import { Busy, Pill, type PillVariant } from '@shared/web-ui/components';
import type { OutboxPanelRow } from '@shared/ipc';
import { formatRelativeCompact } from '../Sources/format';
import './Outbox.css';

/**
 * Outbox history — the audit surface over the outbox table (spec §10).
 * Confirmation itself happens on app-served pages; this screen lists what
 * happened and offers: Review & send (pending), Discard (pending, two-click),
 * Draft again (terminal failures). Refetches on mount (re-navigation remounts
 * screens) and after every action — no push channel.
 */

const STATUS_PILL: Record<OutboxPanelRow['status'], { v: PillVariant; label: string }> = {
  draft: { v: 'info', label: 'Pending' },
  sending: { v: 'working', label: 'Sending' },
  sent: { v: 'live', label: 'Sent' },
  failed: { v: 'error', label: 'Failed' },
  discarded: { v: 'paused', label: 'Discarded' },
  expired: { v: 'paused', label: 'Expired' },
  delivery_unknown: { v: 'error', label: 'Delivery unknown' },
};

const REDRAFTABLE: ReadonlySet<OutboxPanelRow['status']> = new Set([
  'failed',
  'expired',
  'discarded',
  'delivery_unknown',
]);

export function Outbox(): React.ReactElement {
  const [rows, setRows] = useState<OutboxPanelRow[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);

  const refresh = useCallback(() => {
    void window.kiagent
      .invoke('outbox:list', {})
      .then(setRows)
      .catch(() => setRows([]));
  }, []);

  useEffect(() => refresh(), [refresh]);

  async function withBusy(id: string, run: () => Promise<unknown>): Promise<void> {
    setBusyId(id);
    setRowError(null);
    try {
      await run();
    } catch (e) {
      setRowError({ id, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusyId(null);
      setConfirmingId(null);
      refresh(); // re-read actual state — a failed write stays as it was
    }
  }

  return (
    <div className="outbox-screen">
      <div className="h-section">Outbox</div>
      <p className="t-meta">
        Nothing here is sent without your confirmation — pending drafts wait for
        you on their review page.
      </p>
      {rows === null ? (
        <Busy label="Loading outbox…" />
      ) : rows.length === 0 ? (
        <p className="t-meta outbox-empty">
          No outbound drafts yet — ask your assistant to draft a reply.
        </p>
      ) : (
        <div className="outbox-list">
          {rows.map((r) => {
            const pill = STATUS_PILL[r.status];
            const busy = busyId === r.draftId;
            return (
              <div className="outbox-row" key={r.draftId}>
                <div className="outbox-main">
                  <div className="outbox-target">
                    <span className="outbox-recipient">{r.recipientDisplay}</span>
                    {r.subject && <span className="t-meta"> — {r.subject}</span>}
                  </div>
                  <div className="t-meta outbox-preview">{r.bodyPreview}</div>
                  {r.error && <div className="outbox-error">{r.error}</div>}
                  {rowError?.id === r.draftId && (
                    <div className="outbox-error">{rowError.message}</div>
                  )}
                </div>
                <div className="t-meta outbox-when">
                  {formatRelativeCompact(r.sentAt ?? r.createdAt)}
                </div>
                <Pill variant={pill.v}>{pill.label}</Pill>
                <div className="outbox-actions">
                  {r.status === 'draft' && confirmingId !== r.draftId && (
                    <>
                      <button
                        type="button"
                        className="btn sm"
                        disabled={busy}
                        onClick={() =>
                          void withBusy(r.draftId, () =>
                            window.kiagent.invoke('outbox:open-confirm', {
                              draftId: r.draftId,
                            }),
                          )
                        }
                      >
                        Review &amp; send
                      </button>
                      <button
                        type="button"
                        className="btn ghost sm"
                        disabled={busy}
                        onClick={() => setConfirmingId(r.draftId)}
                      >
                        Discard
                      </button>
                    </>
                  )}
                  {r.status === 'draft' && confirmingId === r.draftId && (
                    <>
                      <button
                        type="button"
                        className="btn destructive sm"
                        disabled={busy}
                        onClick={() =>
                          void withBusy(r.draftId, () =>
                            window.kiagent.invoke('outbox:discard', {
                              draftId: r.draftId,
                            }),
                          )
                        }
                      >
                        {busy ? 'Discarding…' : 'Confirm'}
                      </button>
                      <button
                        type="button"
                        className="btn ghost sm"
                        disabled={busy}
                        onClick={() => setConfirmingId(null)}
                      >
                        Cancel
                      </button>
                    </>
                  )}
                  {REDRAFTABLE.has(r.status) && (
                    <button
                      type="button"
                      className="btn sm"
                      disabled={busy}
                      onClick={() =>
                        void withBusy(r.draftId, () =>
                          window.kiagent.invoke('outbox:redraft', {
                            draftId: r.draftId,
                          }),
                        )
                      }
                    >
                      {busy ? 'Drafting…' : 'Draft again'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
```

(Check `PillVariant` is exported from `@shared/web-ui/components` (~line 92); if it's not exported, export the type there rather than duplicating the union. If `formatRelativeCompact` rejects the import path from a sibling screen, import it exactly the way another cross-screen consumer does — do NOT copy the function.)

`src/renderer/screens/Outbox/Outbox.css`:

```css
/* Outbox history list — matches the density of the Connection lists. */
.outbox-screen {
  padding: 16px 20px;
  max-width: 860px;
}
.outbox-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 12px;
}
.outbox-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--border, rgba(127, 127, 127, 0.25));
  border-radius: 8px;
}
.outbox-main {
  flex: 1;
  min-width: 0;
}
.outbox-recipient {
  font-weight: 600;
}
.outbox-preview {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.outbox-error {
  color: var(--danger, #c0392b);
  font-size: 12px;
  margin-top: 2px;
}
.outbox-when {
  white-space: nowrap;
}
.outbox-actions {
  display: flex;
  gap: 6px;
}
.outbox-empty {
  margin-top: 12px;
}
```

(Check `tokens.css` for the real border/danger custom-property names and use those — the `var(--…, fallback)` forms above are placeholders to replace, not to ship blindly.)

- [ ] **Step 3: Gates**

Run: `npm run typecheck` — Expected: clean.
Run: `npm run lint` — Expected: clean (jsx-a11y rules are active — keep the `type="button"` attributes and add `aria-label`s if lint asks).

- [ ] **Step 4: Commit**

```bash
git add src/renderer/state/view.ts src/renderer/screen-registry.tsx src/renderer/components/TopBar.tsx src/renderer/screens/Outbox/index.tsx src/renderer/screens/Outbox/Outbox.css
git commit -m "feat(outbound): Outbox history screen — list, review/discard/redraft actions"
```

---

### Task 4: Full gates + handoff notes

**Files:** none new — verification and report only.

- [ ] **Step 1: Full suite**

Run: `npm test` — Expected: PASS. (Unrelated flakes under load → re-run the file in isolation; standing repo rule.)

- [ ] **Step 2: Lint + typecheck**

Run: `npm run lint` && `npm run typecheck` — Expected: clean.

- [ ] **Step 3: Write the completion report** (chat message, not a file), including:

- **Overlay handoff (load-bearing):** alpha-cent must add ALL FOUR channels to `REMOTE_INVOKE_CHANNELS` in `build/apply-overlay.mjs` when bumping `core.lock` — `outbox:list`, `outbox:discard`, `outbox:redraft`, `outbox:open-confirm` (entry shape `{ marker, ch, inv }`; the `inv` lines need the `OutboxPanelRow` import available in the patched ipc.ts — it ships with core, so only the channel entries are needed). The preload silently rejects unlisted channels; the panel would render an eternal empty state in the product build — exactly the failure mode that shipped broken once before.
- Manual smoke checklist:
  1. Draft something via MCP → Outbox tab shows it Pending; Review & send opens the browser page; confirm there → row flips to Sent on refetch (re-enter the tab).
  2. Discard is two-click; the row lands Discarded; Draft again on it creates a fresh Pending row and opens its page.
  3. Kill SMTP creds → confirm a draft → row shows Failed + error text; Draft again works.
  4. Empty profile → empty-state copy renders.
- Spec cross-off: phase 9 of `docs/superpowers/specs/2026-07-23-unified-outbound-design.md` §12 — the LAST phase; note the spec arc is fully planned once phases 4–8 land.
