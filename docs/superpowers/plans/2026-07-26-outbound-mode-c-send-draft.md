# Outbound Mode C (`send_draft`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add spec phase 6 — chat-confirmation mode ('chat', spec's "mode C"): a per-account opt-in where the model renders the draft in chat, the user agrees, and the model calls a new `send_draft` tool; guarded by a per-account sends/hour rate limit.

**Architecture:** Everything builds on the phase-1 plan's surfaces (`docs/superpowers/plans/2026-07-23-unified-outbound-phase1.md` — **prerequisite: fully landed**). `ConfirmMode` gains `'chat'` (migration v5 widens the `confirm_mode` CHECK via table rebuild). The service gains `sendDraft`, which reuses the exact send pipeline `confirmByToken` uses (extracted into a shared `executeSend`). Chat-mode draft results omit the confirm URL and instruct the model to get explicit user agreement. The global default mode stays restricted to `'review' | 'link'` — mode C is per-account-only relaxation (spec §5).

**Tech Stack:** TypeScript, Electron main process, SQLite (forward-only migrations), jest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-23-unified-outbound-design.md` §4 (`send_draft`), §5 (mode C), §12 phase 6.

## Global Constraints

- Repo: `/Users/edjafarov/work/kiagent-core`, branch `dev`. **Prerequisite: the phase-1 outbound plan is fully landed** (schema v4, `OutboxStore`, `OutboundService`, tools, routes, settings). Verify before starting: `npx jest src/main/outbound -v` passes and `src/main/outbound/service.ts` exists.
- Never `git commit --amend`, never rebase, never `git reset` — the user runs concurrent sessions on this checkout. Never bypass commit hooks. Commit messages: NO `Co-Authored-By`, NO promo lines.
- Subagents do NOT commit; the orchestrator commits serially after review. No worktrees (jest silently ignores tests under `.claude/worktrees/*`).
- Timestamps are TEXT ISO-8601 strings (`new Date(ms).toISOString()`), matching the rest of the store.
- The global default mode (prefs) must NEVER become `'chat'` — sanitize keeps it `'review' | 'link'`. Only `Account.config.outbound.mode` may be `'chat'`, set by explicit user action in the account's Outbound settings.
- `send_draft` has NO transport gate (unlike the drafting tools' phase-1 `assertLocal`): a draft row can only exist if drafting was permitted on that transport, the user's consent is observed by the model regardless of transport, and the app-side gates are the chat-mode opt-in + the rate limit. Known accepted edge: a chat-mode draft created locally could be sent by a remote caller holding a valid JWT — bounded by the opt-in, the rate limit, and the draft cap.
- Final gate: FULL `npm test` + `npm run lint` + `npm run typecheck` — all green before the last commit.

## Parallel Execution Guide (subagent-driven)

Implementer subagents run on **sonnet** (standing repo rule), one per task, same checkout:

- **Wave 1:** Task 1 (contracts + migration v5 + store)
- **Wave 2:** Task 2 (service: `sendDraft` + chat results) ∥ Task 4 (settings UI + prefs guard) — disjoint files
- **Wave 3:** Task 3 (tool + proxy + routes)
- **Wave 4:** Task 5 (full gates + handoff)

## File Structure

| File | Change | Responsibility |
| --- | --- | --- |
| `src/shared/contracts.ts` | modify | `ConfirmMode` gains `'chat'` |
| `src/main/core/store/schema.ts` | modify | migration v5: rebuild `outbox` with widened CHECK |
| `src/main/core/store/outbox.ts` | modify | `countSentSince` for the rate limit |
| `src/main/outbound/service.ts` | modify | `executeSend` extraction, `sendDraft`, chat tool results, `CONFIRM_TTL_MS.chat` |
| `src/main/core/mcp/tools/send-draft.ts` | create | the `send_draft` MCP tool |
| `src/main/core/mcp/tools.ts` | modify | register `send_draft` (+ unavailable fallback) |
| `src/main/outbound/routes.ts` | modify | `/outbox/api` op `sendDraft`; chat rows render the review page |
| `src/main/mcp/outbound-proxy.ts` | modify | proxy op `sendDraft` |
| `src/renderer/screens/Sources/sections/Outbound.tsx` | modify | chat option + trust warning |

---

### Task 1: `'chat'` mode — contracts, migration v5, store support

**Files:**
- Modify: `src/shared/contracts.ts` (the `ConfirmMode` type from phase-1 Task 1)
- Modify: `src/main/core/store/schema.ts` (append v5 to `MIGRATIONS`)
- Modify: `src/main/core/store/outbox.ts` (add `countSentSince`)
- Test: `src/main/core/store/__tests__/outbox.test.ts` (append)

**Interfaces:**
- Consumes: the phase-1 v4 `outbox` DDL (replicated below — the rebuild must keep every column identical except the `confirm_mode` CHECK), `OutboxStore`/`createOutboxStore` from phase-1 Task 2.
- Produces (used by Tasks 2, 3, 4):

```ts
// contracts.ts
export type ConfirmMode = 'review' | 'link' | 'chat';

// outbox.ts — added to OutboxStore:
/** Rows that reached 'sent' at or after sinceIso, for the mode-C rate limit. */
countSentSince(accountId: AccountId, sinceIso: string): Promise<number>;
```

- [ ] **Step 1: Write the failing tests**

Append to `src/main/core/store/__tests__/outbox.test.ts`, inside the existing `describe('outbox schema (migration v4)')` block (rename that describe to `'outbox schema'` while here):

```ts
  it('accepts chat as a confirm mode (migration v5)', async () => {
    await expect(
      db.run(
        `INSERT INTO outbox (id, account_id, kind, recipient_display,
           body_markdown, confirm_mode, status, created_via, created_at, expires_at)
         VALUES ('c1', 'a', 'new', 'r', 'b', 'chat', 'draft', 'mcp-local', 't', 't')`,
      ),
    ).resolves.not.toThrow();
  });

  it('still rejects unknown confirm modes after the rebuild', async () => {
    await expect(
      db.run(
        `INSERT INTO outbox (id, account_id, kind, recipient_display,
           body_markdown, confirm_mode, status, created_via, created_at, expires_at)
         VALUES ('c2', 'a', 'new', 'r', 'b', 'bogus', 'draft', 'mcp-local', 't', 't')`,
      ),
    ).rejects.toThrow(/CHECK/);
  });

  it('keeps the account-status index across the rebuild', async () => {
    const idx = (await db.all(`PRAGMA index_list(outbox)`)).map(
      (r) => r.name as string,
    );
    expect(idx).toContain('idx_outbox_account_status');
  });
```

And inside the `describe('outbox store')` block (it has `store`, `accountId`, and the `draft()` helper from phase-1):

```ts
  it('countSentSince counts only sent rows inside the window', async () => {
    const a = await store.outbox.create(draft());
    const b = await store.outbox.create(draft());
    await store.outbox.create(draft()); // stays a draft
    await store.outbox.transition(a.id, ['draft'], 'sending');
    await store.outbox.transition(a.id, ['sending'], 'sent', {
      sentAt: '2026-07-26T10:30:00.000Z',
    });
    await store.outbox.transition(b.id, ['draft'], 'sending');
    await store.outbox.transition(b.id, ['sending'], 'sent', {
      sentAt: '2026-07-26T09:00:00.000Z', // outside the window below
    });
    expect(
      await store.outbox.countSentSince(accountId, '2026-07-26T10:00:00.000Z'),
    ).toBe(1);
    expect(
      await store.outbox.countSentSince(accountId, '2026-07-26T08:00:00.000Z'),
    ).toBe(2);
  });

  it('stores and returns chat confirm mode', async () => {
    const row = await store.outbox.create(draft({ confirmMode: 'chat' }));
    expect((await store.outbox.get(row.id))?.confirmMode).toBe('chat');
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/main/core/store/__tests__/outbox.test.ts -v`
Expected: FAIL — the chat INSERT hits the v4 CHECK; `countSentSince` is not a function; the TS cast on `confirmMode: 'chat'` fails typecheck in-editor (jest may still run it — the CHECK failure is the authoritative signal).

- [ ] **Step 3: Widen `ConfirmMode`**

In `src/shared/contracts.ts`, replace the phase-1 `ConfirmMode` declaration (and its doc comment) with:

```ts
/** How a draft gets user confirmation. 'review' = full app-served review page
 *  (spec mode A, the default); 'link' = in-chat review + short-TTL signed
 *  link landing on a minimal Send-button page (spec mode B); 'chat' =
 *  in-chat review + explicit user agreement observed by the model, sent via
 *  the send_draft tool (spec mode C — per-account opt-in, never the global
 *  default). */
export type ConfirmMode = 'review' | 'link' | 'chat';
```

- [ ] **Step 4: Add migration v5**

In `src/main/core/store/schema.ts`, append to `MIGRATIONS` after the v4 entry:

```ts
  // v5 — widen outbox.confirm_mode to allow 'chat' (spec mode C). SQLite
  // cannot ALTER a CHECK, so rebuild the table; the explicit column lists
  // make the copy total and order-independent. Nothing references outbox,
  // so the rename/drop is FK-safe.
  `
  DROP INDEX idx_outbox_account_status;
  ALTER TABLE outbox RENAME TO outbox_v4;
  CREATE TABLE outbox (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('reply','new')),
    reply_to_document_id TEXT,
    outbound_ref TEXT,
    recipient_display TEXT NOT NULL,
    to_json TEXT NOT NULL DEFAULT '[]',
    cc_json TEXT NOT NULL DEFAULT '[]',
    subject TEXT,
    body_markdown TEXT NOT NULL,
    threading_json TEXT,
    confirm_mode TEXT NOT NULL CHECK (confirm_mode IN ('review','link','chat')),
    status TEXT NOT NULL CHECK (status IN
      ('draft','sending','sent','failed','discarded','expired','delivery_unknown')),
    error TEXT,
    external_message_id TEXT,
    created_via TEXT NOT NULL,
    created_at TEXT NOT NULL,
    sent_at TEXT,
    expires_at TEXT NOT NULL
  );
  INSERT INTO outbox (id, account_id, kind, reply_to_document_id, outbound_ref,
    recipient_display, to_json, cc_json, subject, body_markdown, threading_json,
    confirm_mode, status, error, external_message_id, created_via, created_at,
    sent_at, expires_at)
  SELECT id, account_id, kind, reply_to_document_id, outbound_ref,
    recipient_display, to_json, cc_json, subject, body_markdown, threading_json,
    confirm_mode, status, error, external_message_id, created_via, created_at,
    sent_at, expires_at
  FROM outbox_v4;
  DROP TABLE outbox_v4;
  CREATE INDEX idx_outbox_account_status ON outbox(account_id, status);
  `,
```

(The v4 entry ran multi-statement SQL through the same runner, so the mechanism is proven. Keep the new table's column set byte-identical to v4 apart from the CHECK — the outbox.test.ts column-list assertion from phase-1 guards this.)

- [ ] **Step 5: Add `countSentSince` to the store**

In `src/main/core/store/outbox.ts`, add to the `OutboxStore` interface:

```ts
  /** Rows that reached 'sent' at or after sinceIso, for the mode-C rate limit. */
  countSentSince(accountId: AccountId, sinceIso: string): Promise<number>;
```

and to the returned object in `createOutboxStore` (beside `countDrafts`, mirroring its query style):

```ts
    async countSentSince(accountId, sinceIso) {
      const rows = await db.all(
        `SELECT COUNT(*) AS n FROM outbox
         WHERE account_id = ? AND status = 'sent' AND sent_at >= ?`,
        [accountId, sinceIso],
      );
      return Number(rows[0]?.n ?? 0);
    },
```

(ISO-8601 strings compare correctly as text — same convention the TTL sweeps rely on.)

- [ ] **Step 6: Run tests, expect PASS**

Run: `npx jest src/main/core/store/__tests__/outbox.test.ts -v`
Expected: PASS (all cases, including the untouched v4-era ones).
Also run: `npx jest src/main/core/store src/main/outbound -v`
Expected: PASS — the rebuild must not disturb any phase-1 behavior.

- [ ] **Step 7: Commit**

```bash
cd /Users/edjafarov/work/kiagent-core
git add src/shared/contracts.ts src/main/core/store/schema.ts src/main/core/store/outbox.ts src/main/core/store/__tests__/outbox.test.ts
git commit -m "feat(outbound): 'chat' confirm mode — schema v5 rebuild + sent-window counter"
```

---

### Task 2: Service — `sendDraft`, shared send pipeline, chat tool results

**Files:**
- Modify: `src/main/outbound/service.ts`
- Test: `src/main/outbound/__tests__/service.test.ts` (append)

**Interfaces:**
- Consumes: Task 1 (`ConfirmMode` incl. `'chat'`, `countSentSince`), phase-1 `OutboundService` internals (`modeFor`, `toolResult`, `confirmByToken`, `assertLocal` — see refactor contract below).
- Produces (used by Task 3):

```ts
export interface SendDraftResult {
  draft_id: string;
  status: 'sent';
  recipient_display: string;
  external_message_id: string | null;
}

// OutboundToolApi gains (JSON-serializable like the rest):
sendDraft(a: { draftId: string }): Promise<SendDraftResult>;

// DraftToolResult.confirm_url becomes OPTIONAL:
confirm_url?: string; // absent for chat-mode drafts

// CONFIRM_TTL_MS becomes total over the widened ConfirmMode:
export const CONFIRM_TTL_MS: Record<ConfirmMode, number> = {
  review: 30 * 60_000,
  link: 5 * 60_000,
  chat: 30 * 60_000, // page-confirm fallback via list_outbox re-links
};
```

Behavior contract (encode in tests):
- `modeFor(account)` accepts `'chat'` from `config.outbound.mode` (if phase-1 validated against a literal list, extend it; the prefs default can never be `'chat'` — Task 4 guards that).
- Chat-mode draft results: `to`/`cc`/`subject`/`body` populated (like link mode — the model must render the draft verbatim), NO `confirm_url`, and `instruction` exactly:
  `Show the user this draft exactly as written — recipient, subject, and body verbatim — and ask whether to send it. Call send_draft with this draft_id ONLY after the user explicitly agrees in this conversation. If they want changes, create a new draft instead. Never call send_draft without a clear yes.`
- `listOutbox` still re-issues confirm URLs for chat-mode `draft` rows (page confirm is a strictly-stronger fallback; TTL = 30 min per `CONFIRM_TTL_MS.chat`).
- **Refactor:** extract the post-CAS portion of `confirmByToken` (account+sender lookup → build `SendIntent` → `sender.send` → terminal transition + log) into a private `executeSend(row: OutboxRow): Promise<ConfirmOutcome>`; `confirmByToken` becomes verify → CAS → `executeSend`. Behavior byte-identical — the phase-1 pipeline tests must pass untouched. Reference shape:

```ts
  async function executeSend(row: OutboxRow): Promise<ConfirmOutcome> {
    const account = await deps.store.account(row.accountId);
    const sender = account ? senders.get(account.source) : undefined;
    if (!account || !sender) {
      const error = account
        ? `no sender for source '${account.source}'`
        : 'account no longer exists';
      await deps.store.outbox.transition(row.id, ['sending'], 'failed', { error });
      deps.logSink.log('outbound', 'error', `send failed: ${error}`);
      const failed = (await deps.store.outbox.get(row.id)) ?? row;
      return { kind: 'failed', row: failed, error };
    }
    const intent: SendIntent = {
      accountId: row.accountId,
      kind: row.kind,
      outboundRef: row.outboundRef ?? undefined,
      to: row.to,
      cc: row.cc,
      subject: row.subject ?? undefined,
      bodyMarkdown: row.bodyMarkdown,
      threading: row.threading ?? undefined,
    };
    try {
      const result = await sender.send(intent);
      await deps.store.outbox.transition(row.id, ['sending'], 'sent', {
        sentAt: nowIso(),
        externalMessageId: result.externalMessageId ?? null,
      });
      deps.logSink.log('outbound', 'info', `sent draft ${row.id}`);
      const sent = (await deps.store.outbox.get(row.id)) ?? row;
      return { kind: 'sent', row: sent };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      await deps.store.outbox.transition(row.id, ['sending'], 'failed', { error });
      deps.logSink.log('outbound', 'error', `send failed: ${error}`);
      const failed = (await deps.store.outbox.get(row.id)) ?? row;
      return { kind: 'failed', row: failed, error };
    }
  }
```

  (Reconcile with the landed phase-1 body — keep whatever it does; the extraction only removes duplication.)
- `sendDraft` (full implementation below): NO transport gate (see Global Constraints), lazy expiry sweep first, then: unknown id → Error naming it; row mode ≠ `'chat'` → Error `send_draft is only honored for chat-mode drafts — this draft is mode '<mode>'. Use list_outbox to get its confirmation link instead.`; account gone → Error; account's CURRENT mode ≠ `'chat'` → Error naming the current mode (frozen row mode AND live opt-in must both be chat); rate limit `countSentSince(accountId, iso(now − 1h)) >= sendsPerHourFor(account)` → Error naming count + limit + the Outbound settings; CAS `transition(['draft'],'sending')` false → Error naming the current status (races/single-use); then `executeSend` — `sent` → `SendDraftResult`, anything else → throw `send failed: <error>` (the row is already recorded `failed`).

```ts
function sendsPerHourFor(account: Account): number {
  const cfg = (account.config.outbound ?? {}) as { sendsPerHour?: unknown };
  const n = Number(cfg.sendsPerHour);
  return Number.isFinite(n) && n > 0 ? n : 30;
}
```

- [ ] **Step 1: Write the failing tests**

Append to `src/main/outbound/__tests__/service.test.ts` inside the top-level describe (reuses `service`, `store`, `accountId`, `docId`, `sendMock` and the phase-1 `IMAP_CFG`; the helper below opts the account into chat):

```ts
  const optIntoChat = (extra: Record<string, unknown> = {}) =>
    store.setAccountConfig(accountId, {
      ...IMAP_CFG,
      outbound: { mode: 'chat', ...extra },
    });

  it('chat-mode draft results carry the body but no confirm url', async () => {
    await optIntoChat();
    const r = await service.draftReply({ documentId: docId, body: 'Yo' });
    expect(r.mode).toBe('chat');
    expect(r.confirm_url).toBeUndefined();
    expect(r.body).toBe('Yo');
    expect(r.instruction).toMatch(/explicitly agrees/);
    expect((await store.outbox.get(r.draft_id))?.confirmMode).toBe('chat');
  });

  it('sendDraft sends a chat-mode draft', async () => {
    await optIntoChat();
    const r = await service.draftReply({ documentId: docId, body: 'Yo' });
    const out = await service.sendDraft({ draftId: r.draft_id });
    expect(out.status).toBe('sent');
    expect(out.recipient_display).toBe(r.recipient_display);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect((await store.outbox.get(r.draft_id))?.status).toBe('sent');
  });

  it('sendDraft refuses non-chat drafts, naming the mode', async () => {
    const r = await service.draftReply({ documentId: docId, body: 'Yo' });
    await expect(service.sendDraft({ draftId: r.draft_id })).rejects.toThrow(
      /mode 'review'.*list_outbox/,
    );
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('sendDraft refuses when the account left chat mode after drafting', async () => {
    await optIntoChat();
    const r = await service.draftReply({ documentId: docId, body: 'Yo' });
    await store.setAccountConfig(accountId, {
      ...IMAP_CFG,
      outbound: { mode: 'review' },
    });
    await expect(service.sendDraft({ draftId: r.draft_id })).rejects.toThrow(
      /no longer/i,
    );
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('sendDraft enforces the per-account hourly rate limit', async () => {
    await optIntoChat({ sendsPerHour: 1 });
    const a = await service.draftReply({ documentId: docId, body: 'one' });
    await service.sendDraft({ draftId: a.draft_id });
    const b = await service.draftReply({ documentId: docId, body: 'two' });
    await expect(service.sendDraft({ draftId: b.draft_id })).rejects.toThrow(
      /rate limit/i,
    );
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('sendDraft is single-use', async () => {
    await optIntoChat();
    const r = await service.draftReply({ documentId: docId, body: 'Yo' });
    await service.sendDraft({ draftId: r.draft_id });
    await expect(service.sendDraft({ draftId: r.draft_id })).rejects.toThrow(
      /'sent'/,
    );
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('sendDraft surfaces a transport failure and records it', async () => {
    await optIntoChat();
    sendMock.mockRejectedValueOnce(new Error('SMTP 550 relay denied'));
    const r = await service.draftReply({ documentId: docId, body: 'Yo' });
    await expect(service.sendDraft({ draftId: r.draft_id })).rejects.toThrow(
      /550/,
    );
    const row = await store.outbox.get(r.draft_id);
    expect(row?.status).toBe('failed');
    expect(row?.error).toMatch(/550/);
  });

  it('list_outbox still re-links pending chat drafts (page fallback)', async () => {
    await optIntoChat();
    const r = await service.draftReply({ documentId: docId, body: 'Yo' });
    const listing = await service.listOutbox({});
    const item = listing.find((x) => x.draft_id === r.draft_id);
    expect(item?.confirm_url).toContain('/outbox/confirm/');
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/main/outbound/__tests__/service.test.ts -v`
Expected: FAIL — `sendDraft` is not a function; chat drafts fall into the review branch.

- [ ] **Step 3: Implement** per the behavior contract and code above: widen `CONFIRM_TTL_MS`, make `confirm_url` optional on `DraftToolResult`, add the chat branch to the result composer, extract `executeSend`, add `sendsPerHourFor` + `sendDraft`, and add `sendDraft` to `OutboundToolApi`/`OutboundService`.

- [ ] **Step 4: Run the full outbound suite, expect PASS**

Run: `npx jest src/main/outbound -v`
Expected: PASS — including every phase-1 test untouched (the `executeSend` extraction must be behavior-neutral).

- [ ] **Step 5: Commit**

```bash
git add src/main/outbound/service.ts src/main/outbound/__tests__/service.test.ts
git commit -m "feat(outbound): sendDraft — chat-mode pipeline with live opt-in check + hourly rate limit"
```

---

### Task 3: `send_draft` tool + proxy op + route handling

**Files:**
- Create: `src/main/core/mcp/tools/send-draft.ts`
- Modify: `src/main/core/mcp/tools.ts` (register), `src/main/outbound/routes.ts` (`/outbox/api` op + chat page mapping), `src/main/mcp/outbound-proxy.ts` (op passthrough)
- Test: `src/main/core/mcp/__tests__/outbound-tools.test.ts`, `src/main/core/mcp/__tests__/outbound-routes.test.ts` (append)

**Interfaces:**
- Consumes: `OutboundToolApi.sendDraft` (Task 2), phase-1 tool/registration/proxy/route patterns.
- Produces: MCP tool named exactly `send_draft`, `tier: 'standard'`; `/outbox/api` accepts `{ op: 'sendDraft', args }`; the stdio proxy forwards `sendDraft`; `GET /outbox/confirm/<token>` on a chat-mode draft renders the FULL review page (chat's page fallback is the strictly-stronger surface).

- [ ] **Step 1: Write the failing tests**

Append to `src/main/core/mcp/__tests__/outbound-tools.test.ts` (harness from phase-1 Task 6; note `IMAP_CFG` — mirror the config object used in `beforeEach`):

```ts
  it('send_draft sends a chat-mode draft end to end', async () => {
    await store.setAccountConfig(accountId, {
      host: 'imap.example.com',
      port: 993,
      secure: true,
      user: 'me@example.com',
      outbound: { mode: 'chat' },
    });
    const draft = (await call('draft_reply', {
      document_id: docId,
      body: 'Yes, works for me.',
    })) as { draft_id: string; confirm_url?: string };
    expect(draft.confirm_url).toBeUndefined();
    const sent = (await call('send_draft', { draft_id: draft.draft_id })) as {
      status: string;
    };
    expect(sent.status).toBe('sent');
    expect((await store.outbox.get(draft.draft_id))?.status).toBe('sent');
  });

  it('send_draft names the mode for non-chat accounts', async () => {
    const draft = (await call('draft_reply', {
      document_id: docId,
      body: 'Hi',
    })) as { draft_id: string };
    await expect(call('send_draft', { draft_id: draft.draft_id })).rejects.toThrow(
      /chat-mode/,
    );
  });

  it('send_draft is registered but unavailable without an outbound service', async () => {
    const cold = buildBuiltinTools(store.read);
    const t = cold.find((x) => x.name === 'send_draft');
    expect(t).toBeDefined();
    await expect(t!.call({ draft_id: 'x' })).rejects.toThrow(
      /unavailable on this transport/i,
    );
  });
```

Append to `src/main/core/mcp/__tests__/outbound-routes.test.ts` (harness from phase-1 Task 8 — `base`, `accountId`, `docId`, `store`, the `api` helper if one exists; otherwise post JSON to `${base}/outbox/api` exactly as the phase-1 tests do):

```ts
  it('/outbox/api handles the sendDraft op', async () => {
    await store.setAccountConfig(accountId, {
      ...IMAP_CFG,
      outbound: { mode: 'chat' },
    });
    const draftRes = await fetch(`${base}/outbox/api`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        op: 'draftReply',
        args: { documentId: docId, body: 'ok' },
      }),
    });
    const draft = (await draftRes.json()) as {
      ok: boolean;
      result: { draft_id: string };
    };
    const sendRes = await fetch(`${base}/outbox/api`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        op: 'sendDraft',
        args: { draftId: draft.result.draft_id },
      }),
    });
    const sent = (await sendRes.json()) as {
      ok: boolean;
      result: { status: string };
    };
    expect(sent.ok).toBe(true);
    expect(sent.result.status).toBe('sent');
  });

  it('a chat-mode draft renders the full review page as fallback', async () => {
    await store.setAccountConfig(accountId, {
      ...IMAP_CFG,
      outbound: { mode: 'chat' },
    });
    const r = await service.draftReply({ documentId: docId, body: 'page me' });
    const item = (await service.listOutbox({})).find(
      (x) => x.draft_id === r.draft_id,
    );
    const page = await fetch(item!.confirm_url!);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('page me');
    expect(html).toContain('Cancel'); // review page, not the minimal link page
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/main/core/mcp/__tests__/outbound-tools.test.ts src/main/core/mcp/__tests__/outbound-routes.test.ts -v`
Expected: FAIL — no `send_draft` tool; `/outbox/api` rejects the `sendDraft` op; chat draft has no page mapping.

- [ ] **Step 3: Implement the tool**

`src/main/core/mcp/tools/send-draft.ts` (mirror the structure of `draft-reply.ts` from phase-1 exactly — imports, `McpTool` shape, zod/JSON-schema style, snake_case args):

```ts
/**
 * `send_draft` — sends a pending draft after the user explicitly agreed in
 * chat (spec §5 mode C). Only honored when BOTH the draft's frozen mode and
 * the account's current mode are 'chat'; other accounts confirm on an
 * app-served page (the draft result carries the link). The app-side gates
 * are the per-account chat opt-in and an hourly rate limit — the user's
 * consent itself is observed by the model, which is why chat mode is
 * opt-in and never the default.
 */
import type { OutboundToolApi } from '../../../outbound/service';
import type { McpTool } from '../tools';

export function sendDraftTool(outbound: OutboundToolApi): McpTool {
  return {
    name: 'send_draft',
    tier: 'standard',
    description:
      'Send a pending outbound draft after the user has explicitly agreed in this conversation. Only works for accounts set to chat confirmation mode; for every other account, present the confirm link from the draft result instead. The draft must have been shown to the user verbatim first.',
    inputSchema: {
      type: 'object',
      properties: {
        draft_id: {
          type: 'string',
          description: 'The draft_id returned by draft_reply or draft_message.',
        },
      },
      required: ['draft_id'],
    },
    call: async (args) => {
      const draftId = String(args.draft_id ?? '');
      if (!draftId) throw new Error('draft_id is required');
      return outbound.sendDraft({ draftId });
    },
  };
}
```

(Adjust the `McpTool` property names to whatever `draft-reply.ts` landed with — schema key, tier field, call signature — this file must be a sibling clone in style.)

- [ ] **Step 4: Register + wire the seams**

- `src/main/core/mcp/tools.ts`: add `send_draft` beside the three phase-1 outbound tools — including the `unavailableOutbound` fallback branch (same error text) when `outbound` is undefined.
- `src/main/outbound/routes.ts`:
  - the `/outbox/api` op dispatch gains `sendDraft: (args) => outbound.sendDraft(args as { draftId: string })` in whatever op-map shape phase-1 landed;
  - the GET confirm branch maps mode `'chat'` to `reviewPage` (change the mode dispatch to `mode === 'link' ? linkPage(...) : reviewPage(...)`).
- `src/main/mcp/outbound-proxy.ts`: the proxy's `OutboundToolApi` implementation gains `sendDraft: (a) => call('sendDraft', a)` following the phase-1 method-to-op pattern.

- [ ] **Step 5: Run tests, expect PASS**

Run: `npx jest src/main/core/mcp src/main/mcp src/main/outbound -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/core/mcp/tools/send-draft.ts src/main/core/mcp/tools.ts src/main/outbound/routes.ts src/main/mcp/outbound-proxy.ts src/main/core/mcp/__tests__/outbound-tools.test.ts src/main/core/mcp/__tests__/outbound-routes.test.ts
git commit -m "feat(outbound): send_draft tool — registered, proxied over /outbox/api, chat page fallback"
```

---

### Task 4: Settings — chat opt-in UI + global-default guard

**Files:**
- Modify: `src/renderer/screens/Sources/sections/Outbound.tsx`
- Test: `src/main/core/__tests__/prefs.test.ts` (append)

**Interfaces:**
- Consumes: `ConfirmMode` (Task 1), the phase-1 `Outbound.tsx` section + `accounts:update-outbound` channel (no IPC changes here).
- Produces: the per-account mode select offers `chat`; the GLOBAL default (Settings → Advanced) does NOT — and prefs sanitize proves it.

- [ ] **Step 1: Write the failing prefs test**

Append to `src/main/core/__tests__/prefs.test.ts` beside the phase-1 outbound test:

```ts
  it('never allows chat as the global outbound default', async () => {
    const prefs = createPrefs(dir);
    await prefs.patch({
      outbound: { defaultMode: 'chat' as unknown as 'review' },
    });
    expect(prefs.get().outbound.defaultMode).toBe('review');
  });
```

- [ ] **Step 2: Run it**

Run: `npx jest src/main/core/__tests__/prefs.test.ts -v`
Expected: PASS already — phase-1's sanitize (`=== 'link' ? 'link' : 'review'`) maps everything else to `review`. This test pins that this stays true now that `ConfirmMode` includes `'chat'` (a future "helpful" widening of sanitize would fail it). If it FAILS, sanitize drifted — restrict it back to `'review' | 'link'`.

Also confirm the `AppPrefs.outbound` doc comment and the type still say the default is `'review' | 'link'` territory: in `src/shared/contracts.ts` change the `AppPrefs` slice to make the restriction explicit in the type system:

```ts
  /** Outbound confirmation default; per-account override lives in
   *  Account.config.outbound.mode. 'chat' (mode C) is deliberately NOT
   *  allowed as a global default — it can only be chosen per account, in
   *  that account's Outbound settings (spec §5). */
  outbound: { defaultMode: Exclude<ConfirmMode, 'chat'> };
```

Run: `npm run typecheck` — Expected: clean (the Advanced.tsx select only offers review/link, so the narrowed type holds).

- [ ] **Step 3: Add the chat option to the per-account section**

In `src/renderer/screens/Sources/sections/Outbound.tsx`, in the mode `<select>`, after the `link` option add:

```tsx
          <option value="chat">Chat confirmation (trusts the assistant)</option>
```

and immediately after the closing `</select>` of that field-row, add a conditional warning (reuse the muted/hint text class that `ConnectorConfig.tsx` uses for helper copy — check before inventing one):

```tsx
        {cfg.mode === 'chat' && (
          <div className="hint">
            The assistant sends after you agree in chat — the app itself will
            not show a review page. Sends are capped at 30 per hour for this
            account.
          </div>
        )}
```

- [ ] **Step 4: Gates**

Run: `npm run typecheck` — Expected: clean.
Run: `npm run lint` — Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/shared/contracts.ts src/renderer/screens/Sources/sections/Outbound.tsx src/main/core/__tests__/prefs.test.ts
git commit -m "feat(outbound): per-account chat-mode opt-in in settings; global default stays page-based"
```

---

### Task 5: Full gates + handoff notes

**Files:** none new — verification and report only.

- [ ] **Step 1: Full suite**

Run: `npm test`
Expected: PASS, zero failures. (If unrelated flakes appear under load, re-run the failing file in isolation — standing repo rule.)

- [ ] **Step 2: Lint + typecheck**

Run: `npm run lint` — Expected: clean.
Run: `npm run typecheck` — Expected: clean.

- [ ] **Step 3: Write the completion report** (chat message, not a file), including:

- Manual smoke checklist:
  1. Settings → source account → Outbound → set mode to "Chat confirmation"; confirm the warning copy renders.
  2. In an MCP client: `draft_reply` on a doc from that account → result has body but no URL; agree in chat → `send_draft` → sent; check the Sent mailbox.
  3. `send_draft` on a review-mode account's draft → error names the mode and points at `list_outbox`.
  4. Two quick sends with `sendsPerHour: 1` set manually in config → second is rate-limited.
  5. DB with pre-existing v4 outbox rows upgrades cleanly (open an existing profile; confirm history intact).
- Release handoff: core version bump + tag ride the NEXT core release; alpha-cent picks it up via `core.lock`. No new renderer IPC channels — `REMOTE_INVOKE_CHANNELS` in `build/apply-overlay.mjs` needs NO change for this phase.
- Spec cross-off: phase 6 of `docs/superpowers/specs/2026-07-23-unified-outbound-design.md` §12.
