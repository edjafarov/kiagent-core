# Outbox History Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Spec phase 9 — an in-app Outbox screen in the core renderer: recent outbound drafts with status, plus Review & send (opens the served confirm page), Discard, Try again (re-confirm a provably-not-sent failure), and Draft again (duplicate a terminal row into a fresh draft).

**Architecture:** A new top-level renderer screen (`screens/Outbox/`) wired through the existing view-state navigation (no router). Data flows over four new typed IPC channels handled by a `registerOutboundIpc` delegate; the renderer refetches on mount and after every mutation (`App` keys screens on `${view}:${epoch}`, so re-navigation remounts them — no push channel needed, YAGNI). The service gains two **panel-only** methods: `confirmUrlFor` (fresh confirm URL for a row that is still openable — pending drafts *and* retryable failures) and `redraft` (duplicate a `failed`/`expired`/`discarded` row into a fresh draft under the account's effective mode). All send-failure classification happens main-side and rides the wire.

**Tech Stack:** TypeScript, React (plain global CSS, `@shared/web-ui` primitives), Electron IPC, jest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-23-unified-outbound-design.md` §10, §13, §12 phase 9.

## Global Constraints

- Repo: `/Users/edjafarov/work/kiagent-core`, branch `dev`, baseline HEAD `8e58256` (v0.58.0). The whole phase 1–8 outbound arc is landed; this is the last phase.
- Never amend/rebase/reset; never bypass commit hooks; no `Co-Authored-By`/promo in commit messages. Subagents do NOT commit — the orchestrator commits serially. No worktrees (jest silently ignores tests under `.claude/worktrees/*`).
- The preload bridge rejects renderer-invoked channels missing from `INVOKE_CHANNELS` (`src/shared/ipc.ts`) — `src/main/preload.ts:4-7` builds its runtime allowlist from that array. jest never catches a missing entry. **No alpha-cent overlay change is needed** (see Task 4).
- The renderer never receives arbitrary URLs to open: `outbox:open-confirm`/`outbox:redraft` take a draft id and main-process code mints + opens the URL (`shell.openExternal`, injected for testability). Confirmation itself never happens in-app — spec §13 (user decision): served pages only.
- **The two panel methods are never MCP/JSON-plane exposed.** They go on `OutboundService` only, never on `OutboundToolApi` (`service.ts:86-100`), and no `/outbox/api` op is added for them (`routes.ts:339-379` dispatches that interface by name). Both carry an explicit "panel-only" comment so a later reviewer doesn't add ops "for symmetry".
- **All error classification is main-side.** `src/main/outbound/error-copy.ts` is main-process code; the renderer must never import it. The shaped projection (`error`, `errorDetail`, `canRetry`, `deliveryUncertain`) rides on `OutboxPanelRow`.
- **Design tokens mandate `border-radius: 0`** (`src/shared/web-ui/tokens.css:96-100`, "Radius — SHARP throughout. Do not soften."). No new CSS may introduce a rounded corner.
- No new push channels, no `AppState` slice — mount-refetch + refetch-after-mutation only.
- Reuse `@shared/web-ui` primitives (`Busy`, `Pill`) and `.btn` class strings; there is NO Button/Card primitive and no CSS modules/Tailwind — plain global CSS, one sheet per screen.
- Final gate (Task 4, orchestrator-run): FULL `npm test` + `npm run lint` + `npm run typecheck`.

## Parallel Execution Guide (subagent-driven)

Implementers on **opus**, one per task, same checkout:

- **Wave 1:** Task 1 — service panel surface **+ the entire `src/shared/ipc.ts` change** (wire type, `Invokes` entries, `INVOKE_CHANNELS` entries). Everything downstream consumes this one file.
- **Wave 2:** Task 2 ∥ Task 3, **concurrently**. Disjoint file sets: Task 2 owns `src/main/outbound/ipc.ts`, `src/main/main.ts`, `src/main/outbound/__tests__/ipc.test.ts`; Task 3 owns the five renderer files. Neither touches `src/shared/ipc.ts` (Task 1 already did).
- **Wave 3:** Task 4 — full gates + handoff report.

**Mid-wave gate discipline (load-bearing).** Wave-2 agents run TARGETED gates only — Task 2 runs `npx jest src/main/outbound`, Task 3 runs per-file `npx eslint`. A repo-wide `npm run typecheck` or `npm run lint` from inside Wave 2 sees the *other* agent's half-written files and fails spuriously, which sends an implementer off fixing files they do not own. The orchestrator runs repo-wide typecheck + lint ONCE after the wave completes, before committing either task.

**Note for Task 3:** it typechecks against Task 1's `Invokes` entries with no handler existing anywhere yet. That is expected — `Invokes` is the contract; the handler's existence is a runtime fact nothing typechecks.

## File Structure

| File | Owner | Change | Responsibility |
| --- | --- | --- | --- |
| `src/shared/contracts.ts` | Task 1 | modify | `OutboxRow.createdVia` gains `'panel'` (line 434) |
| `src/main/core/store/outbox.ts` | Task 1 | modify | `OutboxDraftInput.createdVia` (line 34) + `OutboxRowSql.created_via` (line 90) gain `'panel'` |
| `src/main/core/mcp/tools/schema-doc.ts` | Task 1 | modify | model-facing `created_via` prose names all three values (lines 298-301) |
| `src/main/outbound/service.ts` | Task 1 | modify | `confirmUrlFor`, `redraft` |
| `src/shared/ipc.ts` | Task 1 | modify | `OutboxPanelRow` wire type + 4 `outbox:*` `Invokes` entries + 4 `INVOKE_CHANNELS` entries |
| `src/main/outbound/__tests__/service.test.ts` | Task 1 | modify | service-level tests |
| `src/main/outbound/ipc.ts` | Task 2 | create | `registerOutboundIpc` delegate (list/discard/redraft/open-confirm) |
| `src/main/outbound/__tests__/ipc.test.ts` | Task 2 | create | delegate tests |
| `src/main/main.ts` | Task 2 | modify | thread `outbound` into `registerIpc`; register the delegate |
| `src/renderer/state/view.ts` | Task 3 | modify | `'outbox'` view |
| `src/renderer/screen-registry.tsx` | Task 3 | modify | Outbox screen factory |
| `src/renderer/components/TopBar.tsx` | Task 3 | modify | Outbox nav tab |
| `src/renderer/screens/Outbox/index.tsx` | Task 3 | create | the screen |
| `src/renderer/screens/Outbox/Outbox.css` | Task 3 | create | screen styles |

---

### Task 1: Service panel surface + the shared IPC contract

**Files:**
- Modify: `src/shared/contracts.ts`, `src/main/core/store/outbox.ts`, `src/main/core/mcp/tools/schema-doc.ts`, `src/main/outbound/service.ts`, `src/shared/ipc.ts`
- Test: `src/main/outbound/__tests__/service.test.ts` (insert inside the existing outer describe)

**Interfaces:**
- Consumes (all already exist at `8e58256`, all in scope inside `createOutboundService`'s closure):
  - `modeFor(account: Account): ConfirmMode` — `service.ts:180-189`, private closure.
  - `accountFor(id: string): Promise<Account>` — `service.ts:191-201`; throws `outbound: unknown account '<id>'` when gone and the `sending from '<source>' accounts is not supported yet — supported: …` error when the source has no sender. Read live against `SenderLookup`, so an extension sender registered after construction counts.
  - `confirmUrl(draftId, mode): Promise<string>` — `service.ts:220-226`, the async half that fetches the secret. **Use this one.** `buildConfirmUrl` (`service.ts:206-218`) is the sync half `listOutbox` uses to amortize one secret decrypt over N rows — wrong tool for a single-row panel call.
  - `assertReady()` — `service.ts:173-175`.
  - `expiresAt(): string` — `service.ts:291-292`, `new Date(nowMs() + DRAFT_TTL_MS).toISOString()`. Call the closure; do not re-inline the expression.
  - `shapeOutboundError` — already imported at `service.ts:24`.
  - `deps.store.outbox.expireOverdue() / .get() / .create()`.
- Produces (used by Tasks 2 and 3): the two `OutboundService` methods and the whole `src/shared/ipc.ts` surface below.

**Behavior contract (encode in tests):**

- `confirmUrlFor(draftId)`:
  ```
  await store.outbox.expireOverdue()
  row = await store.outbox.get(draftId); if (!row) return null
  if (row.status === 'draft')  return confirmUrl(row.id, row.confirmMode)
  if (row.status === 'failed' && shapeOutboundError(row.error ?? '').canRetry)
      return confirmUrl(row.id, row.confirmMode)   // lands on failedPage's Try again
  return null
  ```
  The failed branch is not a new affordance — it re-opens a path that already ships: a fresh token for a failed row → `peekByToken` returns `{kind:'gone', row}` (`service.ts:691`) → `gonePage` (`routes.ts:121-125`) → `failedPage` with a live **Try again** POST when `shaped.canRetry` (`pages.ts:217-218`) → `confirmByToken`'s retry gate + CAS (`service.ts:706-734`). Tokens are not one-use; the row *status* is the gate, and the CAS from-state is the observed status, so this can never double-send. Chat-mode rows need no special-casing: `routes.ts:176-187` falls a chat token through to the FULL review page on purpose.
  `confirmUrlFor` deliberately does **not** call `assertReady()` — a non-openable row must return `null` (so the caller can name its status) rather than throw a readiness error. A cold server surfaces naturally from `confirmUrl` → `baseFor()`.
- `redraft(draftId)`:
  - `assertReady()` first — same reason every drafting tool does it (`service.ts:155-158`): refuse before the insert, so a cold/unset base can never leave an orphan draft row behind.
  - unknown id → `Error("redraft: unknown draft '<id>'")`.
  - status `delivery_unknown` → **REFUSED**, naming the status and telling the user to check Sent first. This is the shipped anti-double-send posture: `routes.ts:126-132` and `executeSend`'s comment (`service.ts:370-378`, *"a bookkeeping throw here must never be reported as 'failed' (that would invite the user to re-draft and double-send)"*). A re-draft button on a maybe-delivered row is exactly what both were written to prevent.
  - status `draft` / `sending` / `sent` → `Error("only failed, expired, or discarded drafts can be re-drafted — this one is '<status>'")`.
  - allowed source statuses are EXACTLY `failed | expired | discarded`.
  - `accountFor(row.accountId)` supplies the account-gone and unsupported-source refusals for free.
  - creates via `store.outbox.create` with the FULL 13-field `OutboxDraftInput` (`src/main/core/store/outbox.ts:22-36` — **not** `contracts.ts`), including `accountId`. `store.outbox.create` (`outbox.ts:171-217`) already runs `expireOverdue()` and enforces `OUTBOX_PENDING_CAP` (20) before insert, so "pending-cap gates apply exactly as at draft_reply time" needs no extra code.
  - Returns the new `OutboxRow`; the old row is untouched (the table is an audit log — `transition` never scrubs).

- [ ] **Step 1: Write the failing tests**

Insert into `src/main/outbound/__tests__/service.test.ts` **inside the outer `describe('outbound service — drafts', …)` (opens line 65), after the `tokenOf` helper (`service.test.ts:471-472`) and immediately BEFORE the nested `describe('remote transport', …)` block (line ~957)**. Do NOT append at EOF — the file has a separate top-level `describe('composeSenders')` at line 1006 and the outer describe closes at ~line 1004; anything appended lands out of scope and loses `service`/`store`/`docId`/`sendMock`.

Reuse the existing `tokenOf` helper — do not re-inline the split.

```ts
  it('confirmUrlFor mints a link for a pending draft and stops at terminal rows', async () => {
    const r = await service.draftReply({ documentId: docId, body: 'Yo' });
    const url = await service.confirmUrlFor(r.draft_id);
    expect(url).toContain('/outbox/confirm/');
    await service.cancelByToken(tokenOf(r));
    expect(await service.confirmUrlFor(r.draft_id)).toBeNull();
    expect(await service.confirmUrlFor('nope')).toBeNull();
  });

  it('confirmUrlFor re-mints for a provably-not-sent failure (Try again)', async () => {
    // `smtp transient 421: …` matches SMTP_TRANSIENT (error-copy.ts:108-117)
    // → kind 'transient', canRetry true. The stored summary re-shapes to the
    // same verdict (the module is a fixed point), which is what the panel and
    // failedPage both read.
    sendMock.mockRejectedValueOnce(new Error('smtp transient 421: mailbox busy'));
    const r = await service.draftReply({ documentId: docId, body: 'Retry me' });
    await service.confirmByToken(tokenOf(r));
    expect((await store.outbox.get(r.draft_id))?.status).toBe('failed');

    const url = await service.confirmUrlFor(r.draft_id);
    expect(url).toContain('/outbox/confirm/');
    // …and that URL really is a live retry: confirming it sends.
    const outcome = await service.confirmByToken(url!.split('/outbox/confirm/')[1]);
    expect(outcome.kind).toBe('sent');
  });

  it('confirmUrlFor returns null for an ambiguous failure', async () => {
    // No transient/auth/unsupported marker → kind 'unknown', canRetry false:
    // the message MAY have gone out, so no retry affordance.
    sendMock.mockRejectedValueOnce(new Error('socket hang up'));
    const r = await service.draftReply({ documentId: docId, body: 'Uncertain' });
    await service.confirmByToken(tokenOf(r));
    expect(await service.confirmUrlFor(r.draft_id)).toBeNull();
  });

  it('redraft duplicates a failed row verbatim under the current mode', async () => {
    sendMock.mockRejectedValueOnce(new Error('smtp transient 421: mailbox busy'));
    const r = await service.draftReply({ documentId: docId, body: 'Original' });
    await service.confirmByToken(tokenOf(r));

    const old = await store.outbox.get(r.draft_id);
    const fresh = await service.redraft(r.draft_id);
    expect(fresh.id).not.toBe(r.draft_id);
    expect(fresh.status).toBe('draft');
    expect(fresh.createdVia).toBe('panel');
    expect(fresh.accountId).toBe(old!.accountId);
    expect(fresh.bodyMarkdown).toBe('Original');
    expect(fresh.recipientDisplay).toBe(r.recipient_display);
    expect(fresh.to).toEqual(old!.to);
    expect(fresh.cc).toEqual(old!.cc);
    expect(fresh.subject).toBe(old!.subject);
    expect(fresh.threading).toEqual(old!.threading);
    expect(fresh.replyToDocumentId).toBe(old!.replyToDocumentId);
    // The old row is history, never scrubbed.
    expect((await store.outbox.get(r.draft_id))?.status).toBe('failed');
  });

  it('redraft works on a discarded row', async () => {
    const r = await service.draftReply({ documentId: docId, body: 'Cancelled' });
    await service.cancelByToken(tokenOf(r));
    const fresh = await service.redraft(r.draft_id);
    expect(fresh.status).toBe('draft');
    expect(fresh.bodyMarkdown).toBe('Cancelled');
  });

  it('redraft refuses pending and sent rows', async () => {
    const pending = await service.draftReply({ documentId: docId, body: 'a' });
    await expect(service.redraft(pending.draft_id)).rejects.toThrow(/'draft'/);

    const ok = await service.draftReply({ documentId: docId, body: 'b' });
    await service.confirmByToken(tokenOf(ok));
    await expect(service.redraft(ok.draft_id)).rejects.toThrow(/'sent'/);
  });

  it('redraft refuses delivery_unknown rows — check Sent first', async () => {
    const r = await service.draftReply({ documentId: docId, body: 'maybe sent' });
    // Simulate a process death mid-send WITHOUT touching either clock:
    // a row parked in 'sending' is what the boot sweep converts.
    await store.outbox.transition(r.draft_id, ['draft'], 'sending');
    await store.outbox.recoverOrphanedSending();
    expect((await store.outbox.get(r.draft_id))?.status).toBe('delivery_unknown');

    await expect(service.redraft(r.draft_id)).rejects.toThrow(
      /delivery_unknown[\s\S]*Sent folder/,
    );
  });
```

**Clock hazard — do not work around it:** the service's injectable `nowMs` and the store's own `deps.now()` are DIFFERENT clocks (`service.ts:143-147`). Fast-forwarding `nowMs` does not move `expireOverdue`'s sweep. No test here may rely on that; the `delivery_unknown` test above deliberately uses `recoverOrphanedSending` instead of any expiry trick.

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/main/outbound/__tests__/service.test.ts`
Expected: FAIL — `service.confirmUrlFor is not a function` / `service.redraft is not a function`.

- [ ] **Step 3: Widen `createdVia` — FOUR sites**

Three are typechecked, one is model-facing prose that nothing checks.

1. `src/shared/contracts.ts:434` — `OutboxRow`:
```ts
  createdVia: 'mcp-local' | 'mcp-remote' | 'panel';
```

2. `src/main/core/store/outbox.ts:34` — `OutboxDraftInput`:
```ts
  createdVia: 'mcp-local' | 'mcp-remote' | 'panel';
```

3. `src/main/core/store/outbox.ts:90` — `OutboxRowSql` (the raw SQL row type; `toRow` at `outbox.ts:116` assigns it straight through, so missing this one is a typecheck error):
```ts
  created_via: 'mcp-local' | 'mcp-remote' | 'panel';
```

4. `src/main/core/mcp/tools/schema-doc.ts:298-301` — the schema documentation the MODEL reads. Replace the `notes` string:
```ts
        {
          name: 'created_via',
          type: 'TEXT',
          notes:
            "'mcp-local' or 'mcp-remote' — which MCP plane created it — or " +
            "'panel' when the user re-drafted it from the in-app Outbox screen.",
        },
```

No migration: the `created_via` column has **no CHECK constraint** in the current (v5) DDL — `src/main/core/store/schema.ts:220` is a bare `created_via TEXT NOT NULL`. (Migrations live in `src/main/core/store/schema.ts`; there is no migrations file under `src/main/db/`.)

- [ ] **Step 4: Implement the two service methods**

`src/main/outbound/service.ts` — extend the `OutboundService` interface (`service.ts:114-122`, after `setRemoteBaseUrl`):

```ts
  /** Panel support (spec §10): a fresh confirm URL for a row the user can
   *  still act on — a pending draft, or a `failed` row whose stored error
   *  PROVES the message was never accepted (that one lands on failedPage's
   *  shipped "Try again"). Null for everything else.
   *
   *  PANEL-ONLY — never an `/outbox/api` op, never on `OutboundToolApi`:
   *  routes.ts:339-379 dispatches that interface by name over the loopback
   *  JSON plane, and these two must stay off it. */
  confirmUrlFor(draftId: string): Promise<string | null>;
  /** Panel support (spec §10): duplicate a terminal row (`failed`,
   *  `expired`, `discarded` — NEVER `delivery_unknown`) into a fresh draft.
   *  Content, recipients and threading copied verbatim; mode re-frozen from
   *  the account's effective setting; fresh 24h TTL; createdVia 'panel'.
   *
   *  PANEL-ONLY — see confirmUrlFor. */
  redraft(draftId: string): Promise<OutboxRow>;
```

Then add both to the returned object literal (`service.ts:424`ff) — put them after `cancelByToken` so the panel surface reads as one block:

```ts
    async confirmUrlFor(draftId) {
      // No assertReady() on purpose: a row that is not openable must return
      // null so the caller can name its status, rather than throwing a
      // readiness error. A cold base still surfaces from confirmUrl below.
      await deps.store.outbox.expireOverdue();
      const row = await deps.store.outbox.get(draftId);
      if (!row) return null;
      if (row.status === 'draft') return confirmUrl(row.id, row.confirmMode);
      // A failed row is re-confirmable ONLY when its stored error classifies
      // as provably-not-sent — the same gate confirmByToken applies
      // (service.ts:706-714). The token lands on gonePage → failedPage,
      // which ships a live "Try again" POST, and the CAS there uses the
      // OBSERVED status as its from-state, so this cannot double-send.
      // Strictly better than re-drafting for this class: same row, shipped
      // page, shipped copy.
      if (
        row.status === 'failed' &&
        shapeOutboundError(row.error ?? '').canRetry
      ) {
        return confirmUrl(row.id, row.confirmMode);
      }
      return null;
    },

    async redraft(draftId) {
      // Same readiness gate every drafting tool uses, and for the same
      // reason (service.ts:155-158): refuse BEFORE the insert, so a cold or
      // unset base can never leave an orphan draft row behind.
      assertReady();
      await deps.store.outbox.expireOverdue();
      const row = await deps.store.outbox.get(draftId);
      if (!row) throw new Error(`redraft: unknown draft '${draftId}'`);
      if (row.status === 'delivery_unknown') {
        // Deliberately NOT re-draftable. executeSend's fail() comment
        // (service.ts:370-378) and routes.ts:126-132 both exist to stop the
        // app from inviting a duplicate send on a message that MAY have gone
        // out. This refusal is that policy at the service boundary.
        throw new Error(
          `this message may already have been sent — its status is ` +
            `'delivery_unknown'. Check your Sent folder before creating a ` +
            `new draft.`,
        );
      }
      if (
        row.status !== 'failed' &&
        row.status !== 'expired' &&
        row.status !== 'discarded'
      ) {
        throw new Error(
          `only failed, expired, or discarded drafts can be re-drafted — ` +
            `this one is '${row.status}'`,
        );
      }
      // Account-gone and unsupported-source refusals, identical to
      // draft_reply time (service.ts:191-201), read live off the lookup.
      const account = await accountFor(row.accountId as string);
      // Deliberately NO re-resolution: outboundRef / to / cc / threading are
      // copied verbatim off the frozen row. Re-running the resolver could
      // surface the "this document has no reply target" refusal
      // (service.ts:494-498) for a row that already HAS a valid target, and
      // could silently re-target a reply if the thread moved.
      // create() itself runs expireOverdue() and enforces
      // OUTBOX_PENDING_CAP (outbox.ts:171-217) — no extra gate needed here.
      return deps.store.outbox.create({
        accountId: row.accountId,
        kind: row.kind,
        replyToDocumentId: row.replyToDocumentId,
        outboundRef: row.outboundRef,
        recipientDisplay: row.recipientDisplay,
        to: row.to,
        cc: row.cc,
        subject: row.subject,
        bodyMarkdown: row.bodyMarkdown,
        threading: row.threading,
        // The account's effective mode — per-account override, else the
        // global default. NOT the old row's frozen mode, which is history.
        // Note this can resolve to 'chat' from a GLOBAL setting flipped
        // since: the fresh row then carries no confirm URL of its own, and
        // the panel's own link falls through to the FULL review page
        // (routes.ts:176-187). Intended, and strictly stronger.
        confirmMode: modeFor(account),
        createdVia: 'panel',
        expiresAt: expiresAt(),
      });
    },
```

- [ ] **Step 5: Add the shared IPC contract**

All of `src/shared/ipc.ts` is Task 1's — Tasks 2 and 3 both consume it and neither touches it.

**(a) Import `OutboxStatus`.** In the `from './contracts'` type-import list (`ipc.ts:1-21`), alphabetically after `OAuthSourceBinding` and before `ProviderStatus`:

```ts
  OAuthSourceBinding,
  OutboxStatus,
  ProviderStatus,
```

**(b) Add the wire type**, with the other wire types (`ipc.ts:32-158`) — immediately above the `/** invoke(channel, payload) → response. */` comment at `ipc.ts:160`:

```ts
/** One row of the in-app Outbox history panel (spec §10).
 *
 *  The error fields are a MAIN-SIDE projection: `error-copy.ts` lives under
 *  `src/main/` and the renderer must not import across that layer, so the
 *  IPC mapper runs `shapeOutboundError` and ships the verdict. */
export interface OutboxPanelRow {
  draftId: string;
  status: OutboxStatus;
  kind: 'reply' | 'new';
  /** The account's `identifier`; '(removed)' if it vanished. */
  accountLabel: string;
  recipientDisplay: string;
  subject: string | null;
  /** First 140 chars of the body, whitespace-collapsed to one line. */
  bodyPreview: string;
  /** Human sentence for the row: `shaped.message` for 'failed', the stored
   *  sentence verbatim for 'delivery_unknown', null for every other status
   *  (a retried failed→sent row keeps its stale error in the DB by design). */
  error: string | null;
  /** `shaped.summary` — the technical one-liner, rendered behind a
   *  <details>Technical details</details>. Null unless status is 'failed'. */
  errorDetail: string | null;
  /** `shaped.canRetry` — gates the "Try again" action (re-confirm the SAME
   *  row; provably-not-sent failures only). */
  canRetry: boolean;
  /** The message MAY have gone out — gates OFF one-click "Draft again". */
  deliveryUncertain: boolean;
  createdAt: string;
  sentAt: string | null;
}
```

**(c) Add the four `Invokes` entries** as a new block immediately after `'mcp-activity:recent'` (`ipc.ts:257`):

```ts
  /** Outbox history panel: recent outbound rows, newest first. */
  'outbox:list': { req: { limit?: number }; res: OutboxPanelRow[] };
  /** Discard a pending draft (no-op if it left 'draft' meanwhile). */
  'outbox:discard': { req: { draftId: string }; res: void };
  /** Duplicate a terminal row into a fresh draft and open its confirm page. */
  'outbox:redraft': { req: { draftId: string }; res: { draftId: string } };
  /** Open the confirm page for a still-actionable row in the default
   *  browser (pending drafts, and retryable failures → "Try again"). */
  'outbox:open-confirm': { req: { draftId: string }; res: void };
```

**(d) Add the four channel strings** to `INVOKE_CHANNELS` in the SAME position — immediately after `'mcp-activity:recent'` (`ipc.ts:398`). The array mirrors the interface's declaration order 1:1 and `] as const satisfies readonly InvokeChannel[]` (`ipc.ts:426`) enforces the sync at compile time:

```ts
  'mcp-activity:recent',
  'outbox:list',
  'outbox:discard',
  'outbox:redraft',
  'outbox:open-confirm',
  'mcp:info',
```

`RendererApi` (`ipc.ts:437-446`) needs no change.

- [ ] **Step 6: Run the outbound suite + typecheck, expect PASS**

Run: `npx jest src/main/outbound` — Expected: PASS, all pre-existing tests untouched.
Run: `npm run typecheck` — Expected: clean. (Task 1 is the only wave-1 task, so a repo-wide typecheck is safe here — it also proves the four `createdVia` sites and the `Invokes`/`INVOKE_CHANNELS` sync.)

- [ ] **Step 7: Commit**

```bash
cd /Users/edjafarov/work/kiagent-core
git add src/shared/contracts.ts src/main/core/store/outbox.ts src/main/core/mcp/tools/schema-doc.ts src/main/outbound/service.ts src/shared/ipc.ts src/main/outbound/__tests__/service.test.ts
git commit -m "feat(outbound): panel surface — confirmUrlFor + redraft + outbox:* IPC contract"
```

---

### Task 2: IPC delegate + main.ts wiring

**Runs concurrently with Task 3.** You own `src/main/outbound/ipc.ts`, `src/main/outbound/__tests__/ipc.test.ts`, `src/main/main.ts` — nothing else. `src/shared/ipc.ts` already carries the four channels and `OutboxPanelRow` (Task 1); do not edit it. **Do not run `npm run typecheck` or `npm run lint`** — another agent is mid-edit in the renderer and you will see their red. Your gate is `npx jest src/main/outbound`.

**Files:**
- Create: `src/main/outbound/ipc.ts`, `src/main/outbound/__tests__/ipc.test.ts`
- Modify: `src/main/main.ts`

**Interfaces:**
- Consumes: `service.confirmUrlFor` / `service.redraft` (Task 1), `store.outbox.expireOverdue/listRecent/get/transition`, `store.account(id: AccountId): Promise<Account | null>` (`store.ts:75`), `shapeOutboundError` from `./error-copy`, the `Invokes`/`OutboxPanelRow` types from `@shared/ipc`.
- Produces:

```ts
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

**Shape note (read before "fixing" it):** this is a single deps object with a `keyof Invokes`-generic `handle`, and it returns `void`. `registerUpdaterIpc` (`src/main/updater/ipc.ts:5-26`) is different — two positional args, a stringly-typed `handle`, and it returns an unsubscribe. That is fine and intentional: the generic shape is better typed and is what makes this task's tests type-safe. **The only thing borrowed from the updater is the call-site bridge idiom** `handle(channel as never, fn as never)` (`main.ts:520-524`). Do not "align" the signatures.

**Behavior contract:**

- `outbox:list`:
  - `await store.outbox.expireOverdue()` FIRST — `listOutbox` does (`service.ts:551-552`) and skipping it shows a stale `'draft'` row whose "Review & send" then dies with a status error.
  - clamp: `Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.floor(limit as number))) : 50` — SQLite treats a negative `LIMIT` as **unbounded**, which is why the service clamps at its own boundary (`service.ts:553-562`); this handler bypasses that clamp, so re-apply it (finite-guarded so `NaN`/`Infinity` fall back to 50 instead of poisoning the arithmetic).
  - then `store.outbox.listRecent(clamped)` (newest first).
  - `accountLabel` from `store.account(row.accountId)?.identifier`, `'(removed)'` when null, memoized per call. (The outbox FK is `ON DELETE CASCADE`, `schema.ts:205` — removing an account erases its rows, so the `'(removed)'` branch is near-dead. Keep it; do NOT build a test around it.)
  - `bodyPreview = row.bodyMarkdown.replace(/\s+/g, ' ').trim().slice(0, 140)`.
  - error projection, gated on CURRENT status:
    - `failed` → run `shapeOutboundError(row.error ?? '')`; `error = shaped.message`, `errorDetail = shaped.summary`, `canRetry = shaped.canRetry`, `deliveryUncertain = shaped.kind === 'unknown'`.
    - `delivery_unknown` → `error = row.error` **verbatim** (it is already a human sentence — `outbox.ts:253-255`; re-shaping would wrap it in a `send failed: ` prefix), `errorDetail = null`, `canRetry = false`, `deliveryUncertain = true`.
    - **every other status** → `error/errorDetail = null`, `canRetry/deliveryUncertain = false`. `transition` only ever SETs patch fields (`outbox.ts:42-48`), so a retried `failed → sending → sent` row keeps its stale error string by design; reading it ungated paints a red failure line under a green "Sent" row.
- `outbox:discard`: `store.outbox.transition(draftId, ['draft'], 'discarded')`, result ignored (a lost race is fine; the panel refetches).
- `outbox:redraft`: `service.redraft` → `confirmUrlFor(newRow.id)` → `openExternal(url)` when non-null → `{ draftId: newRow.id }`. Service errors propagate to the renderer as rejected invokes.
- `outbox:open-confirm`: `confirmUrlFor(draftId)`; non-null → `openExternal(url)`; null → throw naming the status (the handler re-reads the row for it).
- **Every URL-minting call is wrapped** so `baseFor()`'s bare internal throw `outbound: server not ready` (`service.ts:158-171`) never reaches a user's screen. (`outbox:discard` mints nothing and needs no wrapper.)

- [ ] **Step 1: Write the failing tests**

Create `src/main/outbound/__tests__/ipc.test.ts`. The harness mirrors `service.test.ts:30-98` (temp-dir store, imap account + email doc fixture, jest.fn sender):

```ts
import fs from 'fs';
import os from 'os';
import path from 'path';

import type {
  AccountId,
  DocumentInput,
  Prefs,
  Sender,
} from '@shared/contracts';
import type { Invokes } from '@shared/ipc';

import { openDb } from '../../db/app-db';
import { openStore, type CoreStore } from '../../core/store/store';
import { registerOutboundIpc } from '../ipc';
import { createOutboundService, type OutboundService } from '../service';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};

const logSink = { log: () => {} };

function fakePrefs(): Prefs {
  const p = {} as unknown as ReturnType<Prefs['get']>;
  return { get: () => p, patch: async () => {}, onChange: () => () => {} };
}

const emailDoc = (): DocumentInput => ({
  externalId: 'INBOX:1:100',
  type: 'email.message',
  title: 'Numbers',
  markdown: 'body',
  metadata: {
    from: 'Alice <alice@example.com>',
    to: ['me@example.com'],
    date: '2026-07-01T00:00:00Z',
    mailbox: 'INBOX',
    uid: 100,
    messageId: 'orig@x',
  },
  createdAt: '2026-07-01T00:00:00Z',
});

const IMAP_CFG = {
  host: 'imap.example.com',
  port: 993,
  secure: true,
  user: 'me@example.com',
};

type Handler = (req: unknown) => Promise<unknown> | unknown;

describe('outbound ipc delegate', () => {
  let dir: string;
  let store: CoreStore;
  let service: OutboundService;
  let docId: string;
  let sendMock: jest.Mock;
  let handlers: Map<string, Handler>;
  let opened: string[];

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-outipc-'));
    store = openStore(await openDb(path.join(dir, 'test.db')), deps);
    const account = await store.createAccount({
      source: 'imap',
      identifier: 'me@example.com@imap.example.com',
      config: IMAP_CFG,
    });
    await store.commit({
      account: account.id as AccountId,
      documents: [emailDoc()],
      cursor: null,
    });
    const hits = await store.read.search({ limit: 10 });
    docId = hits[0].id as string;

    sendMock = jest.fn(async () => ({ externalMessageId: '<sent@x>' }));
    service = createOutboundService({
      store,
      prefs: fakePrefs(),
      senders: new Map<string, Sender>([['imap', { send: sendMock }]]),
      logSink,
    });
    service.setBaseUrl('http://127.0.0.1:7421');

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

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const invoke = <C extends keyof Invokes>(c: C, req: Invokes[C]['req']) =>
    handlers.get(c)!(req) as Promise<Invokes[C]['res']>;

  const tokenOf = (r: { confirm_url?: string }) =>
    r.confirm_url!.split('/outbox/confirm/')[1];

  it('registers the four outbox channels', () => {
    expect([...handlers.keys()].sort()).toEqual([
      'outbox:discard',
      'outbox:list',
      'outbox:open-confirm',
      'outbox:redraft',
    ]);
  });

  it('outbox:list maps rows to the panel shape', async () => {
    await service.draftReply({
      documentId: docId,
      body: 'A long body \n with newlines '.repeat(30),
    });
    const rows = await invoke('outbox:list', {});
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('draft');
    expect(rows[0].kind).toBe('reply');
    expect(rows[0].accountLabel).toBe('me@example.com@imap.example.com');
    expect(rows[0].bodyPreview.length).toBeLessThanOrEqual(140);
    expect(rows[0].bodyPreview).not.toMatch(/\n/);
    // A pending row carries no error projection at all.
    expect(rows[0].error).toBeNull();
    expect(rows[0].errorDetail).toBeNull();
    expect(rows[0].canRetry).toBe(false);
    expect(rows[0].deliveryUncertain).toBe(false);
  });

  it('outbox:list clamps the limit (a negative LIMIT is UNBOUNDED in SQLite)', async () => {
    await service.draftReply({ documentId: docId, body: 'a' });
    await service.draftReply({ documentId: docId, body: 'b' });
    expect(await invoke('outbox:list', { limit: -1 })).toHaveLength(1);
    expect(await invoke('outbox:list', { limit: 9999 })).toHaveLength(2);
  });

  it('outbox:list shapes failed rows and marks ambiguity', async () => {
    sendMock.mockRejectedValueOnce(new Error('socket hang up'));
    const r = await service.draftReply({ documentId: docId, body: 'x' });
    await service.confirmByToken(tokenOf(r));

    const [row] = await invoke('outbox:list', {});
    expect(row.status).toBe('failed');
    expect(row.canRetry).toBe(false);
    expect(row.deliveryUncertain).toBe(true);
    // Human sentence up front, technical one-liner behind <details>.
    expect(row.error).toMatch(/could not confirm delivery/i);
    expect(row.errorDetail).toContain('socket hang up');
    expect(row.error).not.toBe(row.errorDetail);
  });

  it('outbox:list marks a provably-not-sent failure retryable', async () => {
    sendMock.mockRejectedValueOnce(new Error('smtp transient 421: mailbox busy'));
    const r = await service.draftReply({ documentId: docId, body: 'x' });
    await service.confirmByToken(tokenOf(r));

    const [row] = await invoke('outbox:list', {});
    expect(row.canRetry).toBe(true);
    expect(row.deliveryUncertain).toBe(false);
  });

  it('outbox:list never shows a stale error on a retried row', async () => {
    // The regression this gate exists for: `transition` only ever SETs patch
    // fields (outbox.ts:42-48), so a failed→sent row keeps its old error
    // string in the DB by design. Reading it ungated paints red text on a
    // green row.
    sendMock.mockRejectedValueOnce(new Error('smtp transient 421: mailbox busy'));
    const r = await service.draftReply({ documentId: docId, body: 'x' });
    await service.confirmByToken(tokenOf(r));
    expect((await invoke('outbox:list', {}))[0].canRetry).toBe(true);

    // Try again: re-confirm the SAME row via a freshly minted panel URL.
    const retryUrl = await service.confirmUrlFor(r.draft_id);
    const outcome = await service.confirmByToken(
      retryUrl!.split('/outbox/confirm/')[1],
    );
    expect(outcome.kind).toBe('sent');

    const [row] = await invoke('outbox:list', {});
    expect(row.status).toBe('sent');
    expect(row.error).toBeNull();
    expect(row.errorDetail).toBeNull();
    expect(row.canRetry).toBe(false);
    expect(row.deliveryUncertain).toBe(false);
    expect((await store.outbox.get(r.draft_id))?.error).not.toBeNull(); // audit trail intact
  });

  it('outbox:discard discards pending drafts and tolerates races', async () => {
    const r = await service.draftReply({ documentId: docId, body: 'x' });
    await invoke('outbox:discard', { draftId: r.draft_id });
    expect((await store.outbox.get(r.draft_id))?.status).toBe('discarded');
    await invoke('outbox:discard', { draftId: r.draft_id }); // second: no throw
  });

  it('outbox:open-confirm opens actionable rows and names the status otherwise', async () => {
    const r = await service.draftReply({ documentId: docId, body: 'x' });
    await invoke('outbox:open-confirm', { draftId: r.draft_id });
    expect(opened[0]).toContain('/outbox/confirm/');

    await invoke('outbox:discard', { draftId: r.draft_id });
    await expect(
      invoke('outbox:open-confirm', { draftId: r.draft_id }),
    ).rejects.toThrow(/status is 'discarded'/);
  });

  it('outbox:redraft creates a fresh draft and opens its page', async () => {
    sendMock.mockRejectedValueOnce(new Error('socket hang up'));
    const r = await service.draftReply({ documentId: docId, body: 'orig' });
    await service.confirmByToken(tokenOf(r));

    const { draftId } = await invoke('outbox:redraft', { draftId: r.draft_id });
    expect(draftId).not.toBe(r.draft_id);
    expect((await store.outbox.get(draftId))?.status).toBe('draft');
    expect((await store.outbox.get(draftId))?.createdVia).toBe('panel');
    expect(opened.some((u) => u.includes('/outbox/confirm/'))).toBe(true);
  });

  it('reports a cold local server in human words', async () => {
    const cold = createOutboundService({
      store,
      prefs: fakePrefs(),
      senders: new Map<string, Sender>([['imap', { send: sendMock }]]),
      logSink,
    }); // never setBaseUrl'd
    const coldHandlers = new Map<string, Handler>();
    registerOutboundIpc({
      handle: (channel, fn) => coldHandlers.set(channel, fn as Handler),
      service: cold,
      store,
      openExternal: async () => {},
    });
    const r = await service.draftReply({ documentId: docId, body: 'x' });
    await expect(
      coldHandlers.get('outbox:open-confirm')!({ draftId: r.draft_id }),
    ).rejects.toThrow(/local server is not running/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/main/outbound/__tests__/ipc.test.ts`
Expected: FAIL — module `../ipc` does not exist.

- [ ] **Step 3: Implement the delegate**

Create `src/main/outbound/ipc.ts`:

```ts
/**
 * IPC delegate for the in-app Outbox history panel (spec §10).
 *
 * SECURITY POSTURE: the renderer never sends or receives a URL. It sends a
 * draft id; this module mints the signed confirm URL main-side and hands it
 * to the injected `openExternal`. Confirmation itself never happens in-app —
 * spec §13 (user decision): served pages only, POST behind a button.
 *
 * CLASSIFICATION POSTURE: `error-copy.ts` is main-process code and the
 * renderer must not import across that layer, so every failure verdict is
 * computed HERE and rides the wire on `OutboxPanelRow`.
 */
import type { Account, AccountId, OutboxRow } from '@shared/contracts';
import type { Invokes, OutboxPanelRow } from '@shared/ipc';

import type { CoreStore } from '../core/store/store';
import { shapeOutboundError } from './error-copy';
import type { OutboundService } from './service';

/** `baseFor()` throws this bare internal string when the loopback server
 *  never bound (service.ts:158-171). It must never reach a user's screen. */
const NOT_READY = 'outbound: server not ready';
const NOT_READY_HUMAN =
  'the local server is not running — try restarting the app';

/** Wraps any call that can reach `baseFor()`. */
async function minting<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes(NOT_READY)) throw new Error(NOT_READY_HUMAN);
    throw e;
  }
}

/** The row's error projection, gated on its CURRENT status.
 *
 *  `transition` only ever SETs patch fields (outbox.ts:42-48) — the table is
 *  an audit log — so a retried failed→sending→sent row still carries its old
 *  `error` string. Reading it ungated would paint a red failure line under a
 *  green "Sent" row. This mirrors the same gate `listOutbox` applies for the
 *  model (service.ts:582-587). */
function errorFieldsOf(
  row: OutboxRow,
): Pick<
  OutboxPanelRow,
  'error' | 'errorDetail' | 'canRetry' | 'deliveryUncertain'
> {
  if (row.status === 'failed') {
    const shaped = shapeOutboundError(row.error ?? '');
    return {
      error: shaped.message,
      errorDetail: shaped.summary,
      canRetry: shaped.canRetry,
      deliveryUncertain: shaped.kind === 'unknown',
    };
  }
  if (row.status === 'delivery_unknown') {
    // Already a human sentence (outbox.ts:253-255, recoverOrphanedSending).
    // Running it through shapeOutboundError would wrap a perfectly good
    // sentence in a `send failed: ` prefix.
    return {
      error: row.error,
      errorDetail: null,
      canRetry: false,
      deliveryUncertain: true,
    };
  }
  return {
    error: null,
    errorDetail: null,
    canRetry: false,
    deliveryUncertain: false,
  };
}

export function registerOutboundIpc(deps: {
  handle: <C extends keyof Invokes>(
    channel: C,
    fn: (
      req: Invokes[C]['req'],
    ) => Promise<Invokes[C]['res']> | Invokes[C]['res'],
  ) => void;
  service: OutboundService;
  store: CoreStore;
  /** `shell.openExternal` in production; injected so tests can observe it. */
  openExternal: (url: string) => Promise<void>;
}): void {
  const { handle, service, store, openExternal } = deps;

  handle('outbox:list', async ({ limit }) => {
    // The sweep and the [1,100] RANGE clamp `service.listOutbox` applies
    // (service.ts:551-562), which this path would otherwise bypass. Without
    // the sweep the panel shows a stale 'draft' row whose Review & send then
    // dies; without the clamp a negative LIMIT reads as UNBOUNDED in SQLite
    // and returns the whole table, and NaN/Infinity would poison the math.
    await store.outbox.expireOverdue();
    const clamped = Number.isFinite(limit)
      ? Math.min(100, Math.max(1, Math.floor(limit as number)))
      : 50;
    const rows = await store.outbox.listRecent(clamped);

    const labels = new Map<AccountId, string>();
    const out: OutboxPanelRow[] = [];
    for (const row of rows) {
      let label = labels.get(row.accountId);
      if (label === undefined) {
        const account: Account | null = await store.account(row.accountId);
        // The outbox FK is ON DELETE CASCADE (schema.ts:205), so removing an
        // account erases its rows — '(removed)' is only reachable if the
        // account vanished between listRecent and this lookup.
        label = account?.identifier ?? '(removed)';
        labels.set(row.accountId, label);
      }
      out.push({
        draftId: row.id,
        status: row.status,
        kind: row.kind,
        accountLabel: label,
        recipientDisplay: row.recipientDisplay,
        subject: row.subject,
        bodyPreview: row.bodyMarkdown.replace(/\s+/g, ' ').trim().slice(0, 140),
        createdAt: row.createdAt,
        sentAt: row.sentAt,
        ...errorFieldsOf(row),
      });
    }
    return out;
  });

  handle('outbox:discard', async ({ draftId }) => {
    // Result ignored on purpose: losing the race (the row left 'draft'
    // meanwhile) is a fine outcome — the panel refetches and shows whatever
    // actually happened. Mints nothing, so no `minting` wrapper is needed.
    await store.outbox.transition(draftId, ['draft'], 'discarded');
  });

  handle('outbox:open-confirm', async ({ draftId }) => {
    const url = await minting(() => service.confirmUrlFor(draftId));
    if (!url) {
      // Name the ACTUAL status, the way the service does elsewhere
      // (service.ts:652-656). Do not say the draft is merely still pending
      // or not: confirmUrlFor also serves retryable failed rows, so a
      // pending/not-pending phrasing is wrong for every failed row that IS
      // openable and misleading for the ones that aren't.
      const row = await store.outbox.get(draftId);
      throw new Error(
        `this draft can no longer be opened — its status is ` +
          `'${row?.status ?? 'unknown'}'`,
      );
    }
    await openExternal(url);
  });

  handle('outbox:redraft', async ({ draftId }) => {
    // redraft() calls assertReady() before its insert, so a cold base throws
    // here rather than leaving an orphan row.
    const fresh = await minting(() => service.redraft(draftId));
    // Under a GLOBAL 'chat' default the fresh row's frozen mode is 'chat' and
    // the model would get no link — but the panel mints one anyway and
    // routes.ts:176-187 falls a chat token through to the FULL review page.
    // Intended, and strictly stronger than what the model can offer.
    const url = await minting(() => service.confirmUrlFor(fresh.id));
    if (url) await openExternal(url);
    return { draftId: fresh.id };
  });
}
```

- [ ] **Step 4: Wire it into `main.ts`**

Four edits, all with real anchors. **Nothing moves** — `createOutboundService` is already called at `main.ts:600`, 264 lines *before* `registerIpc(...)` runs at `main.ts:864`.

1. `main.ts:53` — add the type export to the existing import:
```ts
import { createOutboundService, type OutboundService } from './outbound/service';
```

2. Next to it (keep the outbound imports together, `main.ts:53-55`):
```ts
import { registerOutboundIpc } from './outbound/ipc';
```

3. `main.ts:241-249` — `registerIpc`'s signature gains an eighth parameter, threaded exactly the way `broker`/`catalog` are:
```ts
function registerIpc(
  p: CorePlatform,
  getLastPush: () => AppStatePush,
  patchState: (partial: Partial<AppState>) => void,
  bundled: { localLlm: LocalLlmProvider },
  extensions: ExtensionPlatform,
  catalog: MarketplaceCatalog,
  broker: ConnectBroker,
  outbound: OutboundService,
): void {
```

4. Inside `registerIpc`, after the extension handles (`main.ts:546-556`) and before the closing brace at `main.ts:557`:
```ts

  // Outbox history panel (spec §10). `handle` is the local generic helper
  // (main.ts:250-257); the `as never` double-cast is the same bridge the
  // updater delegate uses at main.ts:520-524.
  registerOutboundIpc({
    handle: (channel, fn) => handle(channel as never, fn as never),
    service: outbound,
    store: p.store,
    openExternal: (url) => shell.openExternal(url),
  });
```
`shell` is already imported (`main.ts:12`) and already used at `main.ts:227/234/497` — no import change.

5. `main.ts:864-872` — the call site passes the `outbound` created at `main.ts:600`:
```ts
    registerIpc(
      p,
      () => lastPush,
      patchState,
      bundled,
      extensionsPlatform,
      catalog,
      broker,
      outbound,
    );
```

- [ ] **Step 5: Targeted gate, expect PASS**

Run: `npx jest src/main/outbound` — Expected: PASS.
Do NOT run `npm run typecheck` / `npm run lint`: Task 3 is editing the renderer concurrently. The orchestrator runs both repo-wide after the wave.

- [ ] **Step 6: Report for commit** (the orchestrator commits)

```bash
git add src/main/outbound/ipc.ts src/main/outbound/__tests__/ipc.test.ts src/main/main.ts
git commit -m "feat(outbound): outbox panel IPC — list/discard/redraft/open-confirm delegate"
```

---

### Task 3: Renderer — Outbox screen + navigation

**Runs concurrently with Task 2.** You own the five renderer files listed below and nothing else. `src/shared/ipc.ts` already declares `OutboxPanelRow` and the four `outbox:*` channels (Task 1) — do not edit it, and do not touch anything under `src/main/`. **You will typecheck against `Invokes` entries with no handler existing yet — that is expected and correct**; `Invokes` is the contract, and no compiler checks that a handler was registered. **Do not run `npm run typecheck` or `npm run lint`** (Task 2 is mid-edit in `src/main/main.ts`); your gate is per-file `npx eslint`.

**Files:**
- Modify: `src/renderer/state/view.ts`, `src/renderer/screen-registry.tsx`, `src/renderer/components/TopBar.tsx`
- Create: `src/renderer/screens/Outbox/index.tsx`, `src/renderer/screens/Outbox/Outbox.css`

**Interfaces (all verified at `8e58256` — no hedges, no alternates to check):**
- `Busy` (`components.tsx:180`), `Pill` (`components.tsx:94-105`, takes `{ variant, children, title? }`), and `PillVariant` (`components.tsx:92`, **exported**: `'live' | 'working' | 'error' | 'paused' | 'info'`) from `@shared/web-ui/components`.
- `formatRelativeCompact` from `@renderer/screens/Sources/format` (`format.ts:30`). There is no existing cross-screen consumer to copy; use the path alias, matching `screen-registry.tsx:3-7`'s house style.
- `.btn` / `.btn.sm` / `.btn.ghost` / `.btn.destructive` (`components.css:46/60/70/72`); `.h-section` and `.t-meta` (`components.css:185-186`).
- Tri-state list + `withBusy` idiom from `screens/Connection/LocalClients.tsx:41-96` — port it faithfully (`null` = loading, `[]` = empty, `finally { setBusyId(null); refresh(); }`).
- `window.kiagent.invoke` typing via `src/renderer/global.d.ts:1-7`; `declare module '*.css'` (`global.d.ts:18`) makes `import './Outbox.css'` typecheck.

**Action matrix (the whole point of this task — implement exactly this):**

| row state | actions |
| --- | --- |
| `draft` | **Review & send** (`outbox:open-confirm`) + **Discard** behind a two-click Confirm/Cancel |
| `failed` && `canRetry` | single **Try again** → `outbox:open-confirm` (re-confirms the SAME row; cannot double-send) |
| `failed` && `!canRetry` && `deliveryUncertain` | error sentence + **Draft again** behind the SAME two-click Confirm/Cancel idiom as Discard |
| `failed` && `!canRetry` && `!deliveryUncertain` | one-click **Draft again** (the unsupported-source class) |
| `expired` / `discarded` | one-click **Draft again** |
| `delivery_unknown` | **NO actions** — render the stored check-your-Sent-folder sentence only |
| `sent` / `sending` | no actions |

Rationale, worth keeping in the code comments: retrying the same row is CAS-gated on the observed status (`service.ts:706-734`) so it cannot duplicate; re-drafting a *maybe-delivered* row can, which is what `routes.ts:126-132` and `service.ts:370-378` exist to prevent. Hence "Try again" wherever the failure is provably pre-delivery, and deliberate friction wherever it isn't.

- [ ] **Step 1: View + registry + nav tab**

`src/renderer/state/view.ts:10-15` — add `| 'outbox'` to the `View` union (after `'logs'`):

```ts
export type View =
  | 'sources'
  | 'connection'
  | 'logs'
  | 'outbox'
  | 'marketplace'
  | 'settings';
```

`src/renderer/screen-registry.tsx` — import beside the others (`screen-registry.tsx:1-7`):

```ts
import { Outbox } from '@renderer/screens/Outbox';
```

and add the entry inside `getDefaultScreens()` next to `marketplace` (`screen-registry.tsx:40`), following that sibling exactly:

```tsx
    outbox: { factory: () => <Outbox />, usesTopBar: true },
```

`src/renderer/components/TopBar.tsx` — **there is no Logs tab** (Logs is reached from `screens/Sources/ErrorCard.tsx:101` and draws its own bar). The real tab order is Sources → Marketplace → Connection → the Settings icon button (`TopBar.tsx:58-89`). Add the active flag beside `TopBar.tsx:40-42`:

```ts
  const isOutboxActive = view === 'outbox';
```

and insert the tab **after the Sources `NavTab` and before the Marketplace `NavTab`**:

```tsx
      <NavTab
        label="Outbox"
        icon="mail"
        active={isOutboxActive}
        onClick={() => navigate('outbox')}
      />
```

`icon="mail"` is a real sprite id. `Icon` renders `<use href={`#i-${name}`}/>` (`icon-sprite.tsx:255-273`), so an unknown name renders an EMPTY svg silently — there is no send/paper-plane glyph in the roster, and `"logs"` is not an id (the real one is `"log"`). Do not substitute.

- [ ] **Step 2: Implement the screen**

`src/renderer/screens/Outbox/index.tsx`:

```tsx
import React, { useCallback, useEffect, useState } from 'react';
import { Busy, Pill, type PillVariant } from '@shared/web-ui/components';
import type { OutboxPanelRow } from '@shared/ipc';
import { formatRelativeCompact } from '@renderer/screens/Sources/format';
import './Outbox.css';

/**
 * Outbox history (spec §10) — what the outbound layer has done lately.
 * Confirmation itself happens on the app-served pages (spec §13, user
 * decision): every action here either opens one of those pages or writes a
 * row's status; there is no in-app Send button.
 *
 * Refetches on mount (App keys screens on `${view}:${epoch}`, so
 * re-navigating remounts this) and after every action — no push channel.
 *
 * All failure classification arrives pre-computed on the wire
 * (`canRetry` / `deliveryUncertain`): error-copy.ts is main-process code and
 * must not be imported here.
 */

const STATUS_PILL: Record<
  OutboxPanelRow['status'],
  { v: PillVariant; label: string }
> = {
  draft: { v: 'info', label: 'Pending' },
  sending: { v: 'working', label: 'Sending' },
  sent: { v: 'live', label: 'Sent' },
  failed: { v: 'error', label: 'Failed' },
  discarded: { v: 'paused', label: 'Discarded' },
  expired: { v: 'paused', label: 'Expired' },
  delivery_unknown: { v: 'error', label: 'Delivery unknown' },
};

type RowAction =
  | 'review' // pending: Review & send + two-click Discard
  | 'retry' // provably-not-sent failure: re-confirm the SAME row
  | 'redraft' // one-click Draft again
  | 'redraft-guarded' // Draft again behind a two-click confirm
  | 'none';

function actionFor(r: OutboxPanelRow): RowAction {
  if (r.status === 'draft') return 'review';
  if (r.status === 'failed') {
    // Re-confirming the same row is CAS-gated on its observed status
    // (service.ts:706-734), so it can never duplicate a send. Re-drafting
    // can. So a failure that PROVES pre-delivery rejection gets the shipped
    // Try-again page, never a fresh draft.
    if (r.canRetry) return 'retry';
    // 'Delivery uncertain': the message MAY have gone out. A one-click
    // Draft again here is exactly the double-send invitation
    // routes.ts:126-132 and service.ts:370-378 were written to prevent, so
    // it sits behind the same friction as Discard.
    return r.deliveryUncertain ? 'redraft-guarded' : 'redraft';
  }
  if (r.status === 'expired' || r.status === 'discarded') return 'redraft';
  // 'sent', 'sending', and 'delivery_unknown' offer nothing. The last one is
  // deliberate: the service refuses to re-draft it, and the row's own stored
  // sentence already tells the user to check their Sent folder.
  return 'none';
}

export function Outbox(): React.ReactElement {
  const [rows, setRows] = useState<OutboxPanelRow[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{
    id: string;
    message: string;
  } | null>(null);

  const refresh = useCallback(() => {
    void window.kiagent
      .invoke('outbox:list', {})
      .then(setRows)
      .catch(() => setRows([]));
  }, []);

  useEffect(() => refresh(), [refresh]);

  async function withBusy(id: string, run: () => Promise<unknown>) {
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

  const openConfirm = (id: string) =>
    void withBusy(id, () =>
      window.kiagent.invoke('outbox:open-confirm', { draftId: id }),
    );
  const discard = (id: string) =>
    void withBusy(id, () =>
      window.kiagent.invoke('outbox:discard', { draftId: id }),
    );
  const redraft = (id: string) =>
    void withBusy(id, () =>
      window.kiagent.invoke('outbox:redraft', { draftId: id }),
    );

  return (
    <div className="outbox-screen">
      <div className="h-section">Outbox</div>
      <p className="t-meta">
        Recent outbound drafts. Nothing is sent without your confirmation —
        pending drafts wait for you on their own review page.
      </p>
      {rows === null ? (
        <Busy label="Loading outbox…" />
      ) : rows.length === 0 ? (
        <p className="t-meta outbox-empty">
          No recent outbound drafts — ask your assistant to draft a reply.
        </p>
      ) : (
        <div className="outbox-list">
          {rows.map((r) => {
            const pill = STATUS_PILL[r.status];
            const action = actionFor(r);
            const busy = busyId === r.draftId;
            const confirming = confirmingId === r.draftId;
            return (
              <div className="outbox-row" key={r.draftId}>
                <div className="outbox-main">
                  <div className="outbox-target">
                    <span className="outbox-recipient">
                      {r.recipientDisplay}
                    </span>
                    {r.subject && <span className="t-meta"> — {r.subject}</span>}
                  </div>
                  <div className="t-meta outbox-preview">{r.bodyPreview}</div>
                  {r.error && (
                    <div className="outbox-error">
                      {r.error}
                      {r.errorDetail && (
                        <details className="outbox-detail">
                          <summary>Technical details</summary>
                          {r.errorDetail}
                        </details>
                      )}
                    </div>
                  )}
                  {rowError?.id === r.draftId && (
                    <div className="outbox-error">{rowError.message}</div>
                  )}
                </div>
                <div className="t-meta outbox-when">
                  {formatRelativeCompact(r.sentAt ?? r.createdAt)}
                </div>
                <Pill variant={pill.v} title={r.accountLabel}>
                  {pill.label}
                </Pill>
                <div className="outbox-actions">
                  {action === 'review' && !confirming && (
                    <>
                      <button
                        type="button"
                        className="btn sm"
                        disabled={busy}
                        onClick={() => openConfirm(r.draftId)}
                      >
                        {busy ? 'Opening…' : 'Review & send'}
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
                  {action === 'review' && confirming && (
                    <>
                      <button
                        type="button"
                        className="btn destructive sm"
                        disabled={busy}
                        onClick={() => discard(r.draftId)}
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
                  {action === 'retry' && (
                    <button
                      type="button"
                      className="btn sm"
                      disabled={busy}
                      onClick={() => openConfirm(r.draftId)}
                    >
                      {busy ? 'Opening…' : 'Try again'}
                    </button>
                  )}
                  {action === 'redraft' && (
                    <button
                      type="button"
                      className="btn sm"
                      disabled={busy}
                      onClick={() => redraft(r.draftId)}
                    >
                      {busy ? 'Drafting…' : 'Draft again'}
                    </button>
                  )}
                  {action === 'redraft-guarded' && !confirming && (
                    <button
                      type="button"
                      className="btn ghost sm"
                      disabled={busy}
                      onClick={() => setConfirmingId(r.draftId)}
                    >
                      Draft again
                    </button>
                  )}
                  {action === 'redraft-guarded' && confirming && (
                    <>
                      <button
                        type="button"
                        className="btn sm"
                        disabled={busy}
                        onClick={() => redraft(r.draftId)}
                      >
                        {busy ? 'Drafting…' : 'Confirm new draft'}
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

**Copy constraint:** neither the header nor the empty state may promise a permanent audit trail. The outbox FK is `ON DELETE CASCADE` (`schema.ts:205`) — removing an account silently erases its rows. "Recent outbound drafts…" is the honest framing; do not upgrade it to "everything you've ever sent".

`src/renderer/screens/Outbox/Outbox.css`:

```css
/* Outbox history list — matches the density of the Connection lists.
   Corners stay SQUARE: tokens.css:96-100 sets every radius token to 0
   ("Radius — SHARP throughout. Do not soften."). No border-radius here. */
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
  border: 1px solid var(--border-subtle);
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
  color: var(--error-solid);
  font-size: 12px;
  margin-top: 2px;
}
.outbox-detail {
  margin-top: 2px;
  color: var(--text-secondary);
}
.outbox-detail summary {
  cursor: pointer;
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

These are the real token names (`tokens.css:33`, `47`, `27`). There is no `--border` and no `--danger`; a `var(--border, …)` form would silently ship its off-palette fallback literal. Never write a fallback for a token that exists.

- [ ] **Step 3: Targeted gate**

Run:
```bash
npx eslint src/renderer/screens/Outbox/index.tsx src/renderer/components/TopBar.tsx src/renderer/screen-registry.tsx src/renderer/state/view.ts
```
Expected: clean (jsx-a11y rules are active — keep every `type="button"`).

Do NOT run `npm run typecheck` / `npm run lint`: Task 2 is editing `src/main/main.ts` concurrently. The orchestrator runs both repo-wide after the wave.

- [ ] **Step 4: Report for commit** (the orchestrator commits)

```bash
git add src/renderer/state/view.ts src/renderer/screen-registry.tsx src/renderer/components/TopBar.tsx src/renderer/screens/Outbox/index.tsx src/renderer/screens/Outbox/Outbox.css
git commit -m "feat(outbound): Outbox history screen — list, review/discard/retry/redraft actions"
```

---

### Task 4: Full gates + handoff notes

**Files:** none new — verification and report only.

- [ ] **Step 1: Full suite**

Run: `npm test` — Expected: PASS. (Unrelated flakes under load → re-run the file in isolation; standing repo rule.)

- [ ] **Step 2: Lint + typecheck**

Run: `npm run lint` && `npm run typecheck` — Expected: clean. This is the first repo-wide run since Wave 2 went parallel, so it is the real gate on both tasks' files together.

- [ ] **Step 3: Write the completion report** (chat message, not a file), including:

- **Overlay note (no action required):** alpha-cent needs **no** change for this. `src/main/preload.ts:4-7` builds the renderer allowlist from **core's own** `INVOKE_CHANNELS`, and the four `outbox:*` channels ship inside it. `REMOTE_INVOKE_CHANNELS` in `build/apply-overlay.mjs` is only for channels the *overlay itself adds* (e.g. `remote-mcp:*`), which is why the historical `devices`/`connected-clients` breakage needed it and this does not; `patchIpcChannel` is marker-guarded and would skip a core-shipped channel as a no-op anyway. Bumping `core.lock` is sufficient.
- Manual smoke checklist:
  1. Draft via MCP → the Outbox tab shows it Pending; **Review & send** opens the browser page; confirm there → the row flips to Sent on refetch (re-enter the tab).
  2. Discard is two-click; the row lands Discarded; **Draft again** on it creates a fresh Pending row and opens its page.
  3. Set the global default mode to **chat** (Settings → Advanced) and draft via MCP → the model gets no link, but the panel's **Review & send** opens the FULL review page. The panel is the only non-model surface where a chat draft can be page-confirmed — verify it works.
  4. Force a **retryable** failure → the row shows Failed with a human sentence, a `Technical details` disclosure, and a single **Try again** button; clicking it lands on the shipped failedPage and the send succeeds; the row then reads **Sent with no error text**. *Mechanism:* the retryable class is keyed on the `smtp transient <code>: …` prefix that `senders/smtp.ts:152-162` stamps on an exhausted 4xx deferral — point an account's SMTP config at a server that answers 421/451, or temporarily edit that branch to always throw the label.
  5. Force an **ambiguous** failure (kill the network mid-send) → the row shows the "check your Sent folder" sentence and **Draft again is two-click**, never one.
  6. Produce a `delivery_unknown` row → it renders its stored sentence with **no actions at all**. *Mechanism:* park a row in `sending` (kill the app mid-send, or set the status directly) and restart — `recoverOrphanedSending` sweeps it at boot, which is the only producer of that status.
  7. Empty profile → empty-state copy renders.
- Spec cross-off: phase 9 of `docs/superpowers/specs/2026-07-23-unified-outbound-design.md` §12 — the LAST phase; the whole spec arc is now implemented.
