# Outbound Gmail Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Spec phase 5 — Gmail accounts become sendable: `gmail.send` scope, a bundled gmail Sender (`users.messages.send` with `threadId`), and grounded reply resolution from Gmail thread documents.

**Architecture:** Four core moves. (1) `bearerFetch` learns POST + a `maxAttempts` override — the survey confirmed it is GET-only today, and sends must never auto-retry (non-idempotent). (2) `Credentials` gains a `scope` field (Google returns it; `exchange()` currently drops it) so the sender can fail fast with a reconnect message for pre-send accounts — re-consent IS reconnect (`prompt=consent` always forces the full screen; no incremental-auth machinery exists). (3) A gmail reply resolver reads the thread doc's `messages[]` (per-message `from` + RFC `Message-ID` exist today; per-message `to`/`cc` arrive with the phase-7 enrichment — the resolver is forward-compatible and falls back to reply-to-sender with an explicit warning, per spec §4). (4) A `gmail` Sender joins `buildBundledSenders`, refreshing tokens engine-style (60s margin, vault write-back). The sent message re-enters the corpus via the existing `history.list` delta — no append step. The alpha-cent gmail-gate keeps its OWN scope list and consent copy; both must move in the same release.

**Tech Stack:** TypeScript, nodemailer `MailComposer` (already a release/app dependency from phase 1), Gmail REST API, jest with mocked fetch.

**Spec:** `docs/superpowers/specs/2026-07-23-unified-outbound-design.md` §7 (Gmail API), §12 phase 5.

## Global Constraints

- **Prerequisite:** the phase-1 outbound plan fully landed in kiagent-core. Tasks 1–5 run in `/Users/edjafarov/work/kiagent-core` (dev); Task 6 runs in `/Users/edjafarov/work/alpha-cent` (dev) after the core is staged there (`core.lock` bump + `npm run start:product -- --force`).
- Never amend/rebase/reset; never bypass hooks; no `Co-Authored-By`/promo. Subagents do NOT commit. No worktrees for jest.
- **Send is never auto-retried** — `maxAttempts: 1` on the send call. A failed send lands the row in `failed` via the phase-1 pipeline; the human decides.
- **Two scope lists move together**: core `GMAIL_SCOPES` (`src/main/sources/gmail/oauth.ts:15`) and alpha-cent `GATE_SCOPES.gmail` (`extensions/remote-mcp/src/gmail-gate/connect.ts:19`). The gate bypasses core's `connect()` entirely — updating one without the other ships a split-brain consent.
- **Restricted-scope placement**: `gmail.send` goes on the TESTING project `kia-publicca` only (console Data-access page — manual step, Task 6 handoff). Never touch the production project `kiagent-496015` — restricted scopes there re-trigger the parked CASA assessment (runbook `docs/runbooks/gmail-gate-testing-project.md`).
- Scope assertions today are all `toContain`/by-reference — adding `gmail.send` breaks ZERO tests. Each repo's task therefore ADDS an exact-equality scope assertion so future drift is caught.
- `metadata.messages[].id` is the RFC 5322 `Message-ID` (bracketed, from the raw header); `metadata.gmailThreadId` is the API thread id. Do not confuse them: RFC ids go into `In-Reply-To`/`References` headers, the API id goes into the send call's `threadId` field.
- Final gates per repo: FULL `npm test` + lint + typecheck.

## Parallel Execution Guide (subagent-driven)

Implementers on **sonnet**, one per task, same checkout:

- **Wave 1 (core):** Task 1 (POST-capable fetch + send call) ∥ Task 2 (scopes + `Credentials.scope`) ∥ Task 3 (resolver + identity + service dispatch) — disjoint files
- **Wave 2 (core):** Task 4 (gmail Sender + registry)
- **Wave 3 (core):** Task 5 (gates + staging handoff)
- **Wave 4 (alpha-cent):** Task 6 (gate scopes + consent copy + gates)

## File Structure

| Repo | File | Change | Responsibility |
| --- | --- | --- | --- |
| core | `src/main/sources/gmail/bearer-fetch.ts` | modify | `method`/`body`/`contentType`/`maxAttempts` |
| core | `src/main/sources/gmail/gmail-api.ts` | modify | `sendGmailMessage` |
| core | `src/main/sources/gmail/oauth.ts` | modify | `gmail.send` in `GMAIL_SCOPES`; persist `scope` |
| core | `src/shared/contracts.ts` | modify | `Credentials.scope?` |
| core | `src/main/outbound/resolve-gmail.ts` | create | grounded gmail reply resolution |
| core | `src/main/outbound/identity.ts` | modify | gmail: identifier IS the address |
| core | `src/main/outbound/service.ts` | modify | per-source resolver dispatch |
| core | `src/main/outbound/senders/gmail.ts` | create | the Sender |
| core | `src/main/outbound/senders/index.ts` | modify | register `'gmail'` |
| alpha-cent | `extensions/remote-mcp/src/gmail-gate/connect.ts` | modify | `GATE_SCOPES.gmail` + send |
| alpha-cent | `src/overlay/renderer/components/GmailGate/GmailGateModal.tsx` | modify | consent copy covers send |

---

### Task 1: `bearerFetch` POST support + `sendGmailMessage`

**Files:**
- Modify: `src/main/sources/gmail/bearer-fetch.ts`, `src/main/sources/gmail/gmail-api.ts`
- Test: `src/main/sources/gmail/__tests__/bearer-fetch.test.ts`, `src/main/sources/gmail/__tests__/gmail-api.test.ts` (append to existing files; create if a file is missing, mirroring the sibling harness)

**Interfaces:**
- Consumes: existing `bearerFetch<T>(url, getToken, opts)` (retry loop re-enters `fetch` per attempt with a fresh token; retries 429/5xx/quota-403; 401 → `SourceAuthError`; error text `` `${errorPrefix} ${status} ${url} ${body}` `` is regexed elsewhere — DO NOT change its shape).
- Produces (used by Task 4):

```ts
// BearerFetchOpts gains:
  /** HTTP method; default GET. */
  method?: string;
  /** Request body — a STRING (reusable across retry attempts, never a stream). */
  body?: string;
  /** content-type header, set only when body is present. */
  contentType?: string;
  /** Retry-attempt cap override; default the module's MAX_ATTEMPTS. Pass 1
   *  for non-idempotent calls (send) — a retried send can double-deliver. */
  maxAttempts?: number;

// gmail-api.ts gains:
export interface GmailSendResult { id: string; threadId: string }
/** POST users/me/messages/send. `raw` is the full RFC822 message; threadId
 *  (the Gmail API thread id, NOT an RFC Message-ID) threads the reply.
 *  Never retried (maxAttempts 1). */
export function sendGmailMessage(
  auth: { credentials(): Promise<Credentials | null> },
  raw: Buffer,
  threadId?: string,
): Promise<GmailSendResult>;
```

Also loosen the private `tokenFor(session)` parameter type to `{ credentials(): Promise<Credentials | null> }` — it only calls `.credentials()`; the Sender is not a pull `Session`.

- [ ] **Step 1: Write the failing tests**

Bearer-fetch (mirror the existing test file's fetch-mocking style):

```ts
  it('passes method, body, and content-type through', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ done: true }));
    await bearerFetch('https://x/y', async () => 'tok', {
      errorPrefix: 'gmail',
      method: 'POST',
      body: '{"a":1}',
      contentType: 'application/json',
    });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"a":1}');
    expect(init.headers['content-type']).toBe('application/json');
    expect(init.headers.Authorization).toBe('Bearer tok');
  });

  it('maxAttempts 1 never retries a retryable failure', async () => {
    fetchMock.mockResolvedValueOnce(status(500, 'boom'));
    await expect(
      bearerFetch('https://x/y', async () => 'tok', {
        errorPrefix: 'gmail',
        method: 'POST',
        body: '{}',
        maxAttempts: 1,
      }),
    ).rejects.toThrow(/gmail 500/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
```

Gmail-api:

```ts
  it('sendGmailMessage posts base64url raw with the thread id', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ id: 'm9', threadId: 't3' }));
    const auth = { credentials: async () => ({ accessToken: 'tok' }) };
    const r = await sendGmailMessage(auth, Buffer.from('From: a\r\n\r\nhi'), 't3');
    expect(r).toEqual({ id: 'm9', threadId: 't3' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
    );
    const body = JSON.parse(init.body);
    expect(body.threadId).toBe('t3');
    expect(Buffer.from(body.raw, 'base64url').toString()).toContain('hi');
  });
```

(Adapt `okJson`/`status`/`fetchMock` helper names to what the existing tests actually define; if headers are a `Headers` instance in the mock, read them accordingly.)

- [ ] **Step 2: Run to verify failure** — `npx jest src/main/sources/gmail -v` — FAIL.

- [ ] **Step 3: Implement**

- `bearer-fetch.ts`: extend `BearerFetchOpts`; in the fetch call spread `method`, `body`, and conditionally the `content-type` header; the retry loop's exit condition uses `opts.maxAttempts ?? MAX_ATTEMPTS`. No behavior change for existing GET callers.
- `gmail-api.ts`:

```ts
export interface GmailSendResult {
  id: string;
  threadId: string;
}

export function sendGmailMessage(
  auth: { credentials(): Promise<Credentials | null> },
  raw: Buffer,
  threadId?: string,
): Promise<GmailSendResult> {
  return bearerFetch<GmailSendResult>(
    `${BASE}/messages/send`,
    () => tokenFor(auth),
    {
      errorPrefix: 'gmail',
      logTag: '[gmail]',
      method: 'POST',
      contentType: 'application/json',
      body: JSON.stringify({
        raw: raw.toString('base64url'),
        ...(threadId ? { threadId } : {}),
      }),
      // Sending is not idempotent: a retried 5xx could double-deliver.
      maxAttempts: 1,
    },
  );
}
```

- [ ] **Step 4: Run to verify PASS** — `npx jest src/main/sources/gmail -v`.

- [ ] **Step 5: Commit**

```bash
cd /Users/edjafarov/work/kiagent-core
git add src/main/sources/gmail/bearer-fetch.ts src/main/sources/gmail/gmail-api.ts src/main/sources/gmail/__tests__
git commit -m "feat(gmail): POST-capable bearerFetch + sendGmailMessage (never auto-retried)"
```

---

### Task 2: Scopes + `Credentials.scope`

**Files:**
- Modify: `src/main/sources/gmail/oauth.ts`, `src/shared/contracts.ts`
- Test: `src/main/sources/gmail/__tests__/oauth.test.ts` (append)

**Interfaces:**
- Consumes: `GMAIL_SCOPES` (`oauth.ts:15`), `exchange()` (~`oauth.ts:169` — currently DROPS `body.scope`), `googleRefresher` (`oauth.ts:185`), `Credentials` (`contracts.ts:110-118` — no scope field today).
- Produces (used by Task 4): `Credentials.scope?: string` (the space-separated granted-scope string Google returns; old vault blobs parse to `undefined` — unknown, not "missing"); `GMAIL_SCOPES` = readonly + send.

- [ ] **Step 1: Write the failing tests**

Append to `oauth.test.ts`:

```ts
  it('requests exactly readonly + send (pinned — scope drift must be loud)', () => {
    expect(GMAIL_SCOPES).toEqual([
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
    ]);
  });

  it('exchange persists the granted scope string', async () => {
    // mirror the file's existing exchange() harness/mocks; the mocked token
    // response body gains: scope: 'https://www.googleapis.com/auth/gmail.readonly'
    const creds = await exchangeUnderTest(); // the harness's exchange invocation
    expect(creds.scope).toBe('https://www.googleapis.com/auth/gmail.readonly');
  });
```

(Adapt the second test to the file's real exchange harness — the point is: token response `scope` → `Credentials.scope`.)

- [ ] **Step 2: Run to verify failure** — `npx jest src/main/sources/gmail/__tests__/oauth.test.ts -v` — FAIL.

- [ ] **Step 3: Implement**

- `contracts.ts` `Credentials`: add

```ts
  /** Space-separated scopes Google reported as granted at exchange/refresh
   *  time. Absent on blobs written before this field existed — treat
   *  undefined as "unknown", never as "missing". */
  scope?: string;
```

- `oauth.ts`: `GMAIL_SCOPES` becomes the two-element array (readonly first). `exchange()`'s return gains `scope: body.scope,`; `googleRefresher`'s return gains `scope: body.scope ?? creds.scope,`.

- [ ] **Step 4: Run gmail + store suites, expect PASS** — `npx jest src/main/sources/gmail src/main/core/store -v`.

- [ ] **Step 5: Commit**

```bash
git add src/shared/contracts.ts src/main/sources/gmail/oauth.ts src/main/sources/gmail/__tests__/oauth.test.ts
git commit -m "feat(gmail): request gmail.send + persist granted scopes in the vault blob"
```

---

### Task 3: Gmail reply resolution + identity + service dispatch

**Files:**
- Create: `src/main/outbound/resolve-gmail.ts`
- Modify: `src/main/outbound/identity.ts`, `src/main/outbound/service.ts`
- Test: `src/main/outbound/__tests__/resolve-gmail.test.ts` (create), `src/main/outbound/__tests__/identity.test.ts` + `service.test.ts` (append)

**Interfaces:**
- Consumes: gmail thread-doc metadata as written TODAY (`to-document.ts:71-98`): `{ gmailThreadId, from, to, cc, participants, messages: [{ id, from, date, snippet }] }` where `messages[].id` is the RFC Message-ID and per-message `to`/`cc` DO NOT exist yet (phase 7 adds them — this resolver must handle both shapes).
- Produces (used by Task 4 via the outbox row, and by the phase-7 plan's end-to-end tests):

```ts
// resolve-gmail.ts
export interface GmailReplyResolution {
  to: string[];
  cc: string[];
  recipientDisplay: string;
  threading: {
    gmailThreadId: string;
    inReplyTo?: string;    // bracketed RFC id of the thread's last message
    references?: string[]; // bracketed RFC id chain, oldest first
  };
  warnings: string[];
}
/** Grounded reply targets from a gmail thread document. Never guesses:
 *  missing metadata → explicit Error; un-enriched reply_all → falls back to
 *  reply-to-sender WITH a warning (spec §4). */
export function resolveGmailReply(
  doc: Document,
  selfAddresses: string[],
  replyAll: boolean,
): GmailReplyResolution;

// identity.ts — senderAddressFor/selfAddressesFor gain a gmail branch:
// gmail's Account.identifier IS the mailbox address (users.getProfile at
// connect) — return it directly; config.outbound.fromAddress is IGNORED for
// gmail (Gmail rejects non-alias From headers).
```

Behavior contract:
- `metadata.gmailThreadId` missing or `messages` empty → Error `this Gmail document is missing thread metadata — re-sync the account and try again`.
- Address matching: extract the email from display strings (`"Alice <alice@x.com>"` → `alice@x.com`, bare address → itself), compare lowercased.
- `reply` (default): target = the LAST message whose `from` is not self → `to = [that from]`. All messages self-sent → if the last message has an enriched `to` array, `to = last.to minus self` + warning `Replying to a thread where you sent the last message — targeting its original recipients`; empty after filtering or not enriched → Error `this thread only contains messages from you — use draft_message to start a new email instead`.
- `reply_all`: `last = messages[messages.length - 1]`. If `Array.isArray(last.to)` (enriched doc): `to = dedupe([last.from, ...last.to]) minus self`, `cc = (last.cc ?? []) minus self`; `to` empty → the only-you Error above. Else (un-enriched): behave exactly like `reply` and push warning `reply_all fell back to reply-to-sender: this thread was synced before per-message recipients were stored; it will carry them after its next re-sync`.
- `threading.inReplyTo` = bracket(last.id) when non-empty; `references` = every non-empty `messages[].id` bracketed, oldest-first; `bracket(id)` adds `<>` only if absent (gmail stores the raw header, usually already bracketed).
- `recipientDisplay = to.join(', ')`.
- Service dispatch (`draftReply`): `doc.metadata.outbound` (universality hook) stays FIRST and unchanged; otherwise dispatch on `account.source` — `'gmail'` → `resolveGmailReply`, else the existing `resolveImapReply`. Map the resolution into the row exactly as the imap path does (to/cc/threading/recipientDisplay; warnings ride the tool result).

- [ ] **Step 1: Write the failing tests**

`resolve-gmail.test.ts` (pure function — no store):

```ts
import type { Document } from '@shared/contracts';
import { resolveGmailReply } from '../resolve-gmail';

const SELF = ['me@gmail.com'];
const doc = (over: Partial<Record<string, unknown>> = {}): Document =>
  ({
    id: 'd1',
    accountId: 'a1',
    type: 'email.thread',
    title: 'T',
    markdown: '',
    metadata: {
      gmailThreadId: 't123',
      messages: [
        { id: '<m1@x>', from: 'Alice <alice@x.com>', date: 'D', snippet: 's' },
        { id: '<m2@x>', from: 'me@gmail.com', date: 'D', snippet: 's' },
        { id: '<m3@x>', from: 'Bob <bob@x.com>', date: 'D', snippet: 's' },
      ],
      ...over,
    },
  }) as unknown as Document;

describe('resolveGmailReply', () => {
  it('reply targets the last non-self sender with full threading', () => {
    const r = resolveGmailReply(doc(), SELF, false);
    expect(r.to).toEqual(['Bob <bob@x.com>']);
    expect(r.threading).toEqual({
      gmailThreadId: 't123',
      inReplyTo: '<m3@x>',
      references: ['<m1@x>', '<m2@x>', '<m3@x>'],
    });
    expect(r.warnings).toEqual([]);
  });

  it('reply_all on an un-enriched doc falls back with a warning', () => {
    const r = resolveGmailReply(doc(), SELF, true);
    expect(r.to).toEqual(['Bob <bob@x.com>']);
    expect(r.cc).toEqual([]);
    expect(r.warnings[0]).toMatch(/fell back to reply-to-sender/);
  });

  it('reply_all uses enriched per-message recipients minus self', () => {
    const r = resolveGmailReply(
      doc({
        messages: [
          {
            id: '<m9@x>',
            from: 'Alice <alice@x.com>',
            date: 'D',
            snippet: 's',
            to: ['me@gmail.com', 'Carol <carol@x.com>'],
            cc: ['dave@x.com'],
          },
        ],
      }),
      SELF,
      true,
    );
    expect(r.to).toEqual(['Alice <alice@x.com>', 'Carol <carol@x.com>']);
    expect(r.cc).toEqual(['dave@x.com']);
    expect(r.warnings).toEqual([]);
  });

  it('errors loudly on missing metadata and self-only threads', () => {
    expect(() =>
      resolveGmailReply(doc({ gmailThreadId: undefined }), SELF, false),
    ).toThrow(/missing thread metadata/);
    expect(() =>
      resolveGmailReply(
        doc({
          messages: [{ id: '<m1@x>', from: 'me@gmail.com', date: 'D', snippet: 's' }],
        }),
        SELF,
        false,
      ),
    ).toThrow(/only contains messages from you/);
  });
});
```

`identity.test.ts` append:

```ts
  it('gmail accounts send as their identifier', () => {
    const acc = {
      id: 'g1',
      source: 'gmail',
      identifier: 'me@gmail.com',
      config: {},
    } as unknown as Account;
    expect(senderAddressFor(acc)).toBe('me@gmail.com');
    expect(selfAddressesFor(acc)).toEqual(['me@gmail.com']);
  });
```

`service.test.ts` append — a gmail account + `email.thread` doc fixture (metadata as in the resolver tests), senders map extended with `['gmail', { send: sendMock }]`; assert `draftReply` on the gmail doc resolves recipients via the thread metadata and freezes the row with `threading.gmailThreadId`.

- [ ] **Step 2: Run to verify failure** — `npx jest src/main/outbound -v` — FAIL.

- [ ] **Step 3: Implement** per the behavior contract (resolver is a pure module; identity gets the gmail early-return; service gets the two-line dispatch).

- [ ] **Step 4: Run to verify PASS** — `npx jest src/main/outbound -v`.

- [ ] **Step 5: Commit**

```bash
git add src/main/outbound/resolve-gmail.ts src/main/outbound/identity.ts src/main/outbound/service.ts src/main/outbound/__tests__
git commit -m "feat(outbound): grounded gmail reply resolution + gmail sender identity + per-source dispatch"
```

---

### Task 4: The gmail Sender + registry

**Files:**
- Create: `src/main/outbound/senders/gmail.ts`
- Modify: `src/main/outbound/senders/index.ts`
- Test: `src/main/outbound/senders/__tests__/gmail.test.ts` (create), the bundled-senders test in `smtp.test.ts` (update)

**Interfaces:**
- Consumes: `sendGmailMessage` (Task 1), `Credentials.scope` (Task 2), `senderAddressFor` (Task 3), `googleRefresher` (`@main/sources/gmail/oauth`), `CoreStore` (`account`, `vault.load/save`), `MailComposer` (same import path the phase-1 smtp sender uses — reuse its compose helper if smtp.ts landed one; otherwise the local `composeRaw` below).
- Produces: `createGmailSender(deps: { store: CoreStore; refresher?: typeof googleRefresher }): Sender`; `buildBundledSenders` returns `imap` + `gmail`.

Full implementation (`senders/gmail.ts`):

```ts
/**
 * Bundled Gmail transport: users.messages.send with the stored thread id.
 * Token refresh mirrors the engine's session semantics (60s margin, vault
 * write-back) because sends run outside any pull session. The sent message
 * re-enters the corpus through the normal history.list delta — no append.
 * Never auto-retried: a duplicate email is worse than a failed row.
 */
import MailComposer from 'nodemailer/lib/mail-composer';

import type { Credentials, SendIntent, Sender, SendResult } from '@shared/contracts';

import type { CoreStore } from '../../core/store/store';
import { googleRefresher } from '../../sources/gmail/oauth';
import { sendGmailMessage } from '../../sources/gmail/gmail-api';
import { senderAddressFor } from '../identity';

const REFRESH_MARGIN_MS = 60_000;

function composeRaw(opts: {
  from: string;
  to: string[];
  cc?: string[];
  subject?: string;
  text: string;
  inReplyTo?: string;
  references?: string[];
}): Promise<Buffer> {
  const mail = new MailComposer({
    from: opts.from,
    to: opts.to,
    cc: opts.cc?.length ? opts.cc : undefined,
    subject: opts.subject,
    text: opts.text,
    inReplyTo: opts.inReplyTo,
    references: opts.references?.length ? opts.references : undefined,
  });
  return new Promise((resolve, reject) => {
    mail.compile().build((err, message) => {
      if (err) reject(err);
      else resolve(message);
    });
  });
}

export function createGmailSender(deps: {
  store: CoreStore;
  refresher?: typeof googleRefresher;
}): Sender {
  const refresh = deps.refresher ?? googleRefresher;

  async function freshCredentials(accountId: string): Promise<Credentials | null> {
    const creds = await deps.store.vault.load(accountId);
    if (!creds) return null;
    const expiringSoon =
      creds.expiresAt !== undefined &&
      Date.parse(creds.expiresAt) < Date.now() + REFRESH_MARGIN_MS;
    if (!expiringSoon) return creds;
    const fresh = await refresh(creds);
    if (!fresh) return creds;
    await deps.store.vault.save(accountId, fresh);
    return fresh;
  }

  return {
    async send(intent: SendIntent): Promise<SendResult> {
      const account = await deps.store.account(intent.accountId);
      if (!account) throw new Error('the sending account no longer exists');
      const reconnectMsg = `this Gmail account was connected before sending existed — reconnect ${account.identifier} in Settings to grant send permission`;
      const creds = await freshCredentials(intent.accountId);
      if (!creds?.accessToken)
        throw new Error(`no Gmail credentials — reconnect ${account.identifier}`);
      // Fail fast when we KNOW the grant predates gmail.send; unknown
      // (pre-scope-tracking blob) falls through to the API's verdict.
      if (creds.scope && !creds.scope.includes('gmail.send'))
        throw new Error(reconnectMsg);

      const threading = (intent.threading ?? {}) as {
        gmailThreadId?: string;
        inReplyTo?: string;
        references?: string[];
      };
      const raw = await composeRaw({
        from: senderAddressFor(account),
        to: intent.to ?? [],
        cc: intent.cc,
        subject: intent.subject,
        text: intent.bodyMarkdown,
        inReplyTo: threading.inReplyTo,
        references: threading.references,
      });
      try {
        const r = await sendGmailMessage(
          { credentials: () => freshCredentials(intent.accountId) },
          raw,
          threading.gmailThreadId,
        );
        return { externalMessageId: r.id };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficientPermissions/i.test(msg))
          throw new Error(reconnectMsg);
        throw e;
      }
    },
  };
}
```

`senders/index.ts`: the map becomes

```ts
  return new Map<string, Sender>([
    ['imap', createSmtpSender({ store: deps.store })],
    ['gmail', createGmailSender({ store: deps.store })],
  ]);
```

- [ ] **Step 1: Write the failing tests** — `gmail.test.ts` with a real temp store (harness like `smtp.test.ts`), a gmail account (`identifier: 'me@gmail.com'`, `config: {}`), vault seeded via `store.vault.save`, global fetch mocked:

1. Happy path: valid non-expiring creds with `scope` containing send → `send()` POSTs to `/messages/send`, body `raw` decodes to a message containing the recipient and `In-Reply-To`, `threadId` present, result `externalMessageId` = API `id`.
2. Expired creds → injected `refresher` called once, its result saved back to the vault (assert `store.vault.load` afterwards returns the fresh token) and used for the send.
3. `scope` present WITHOUT `gmail.send` → rejects with `/reconnect/` and fetch was never called.
4. API 403 with `ACCESS_TOKEN_SCOPE_INSUFFICIENT` body → rejects with `/reconnect/`.
5. `buildBundledSenders` keys become `['imap', 'gmail']` (update the phase-1 assertion in `smtp.test.ts`).

- [ ] **Step 2: FAIL** — `npx jest src/main/outbound/senders -v`.
- [ ] **Step 3: Implement** (code above; adjust the MailComposer import to match smtp.ts exactly).
- [ ] **Step 4: PASS** — `npx jest src/main/outbound -v`.
- [ ] **Step 5: Commit**

```bash
git add src/main/outbound/senders/gmail.ts src/main/outbound/senders/index.ts src/main/outbound/senders/__tests__
git commit -m "feat(outbound): bundled gmail sender — thread-aware send, engine-style token refresh, reconnect guidance"
```

---

### Task 5: Core gates + staging handoff

- [ ] **Step 1:** `npm test` && `npm run lint` && `npm run typecheck` — all green.
- [ ] **Step 2:** Report with the handoff: bump alpha-cent `core.lock` + re-stage `build/.core` (`npm run start:product -- --force`) before Task 6; note that a gmail draft round-trip needs a real account smoke (mock-only coverage here).

---

### Task 6: alpha-cent — gate scopes, consent copy, docs

**Repo:** `/Users/edjafarov/work/alpha-cent` (prereq: Task 5 handoff done).

**Files:**
- Modify: `extensions/remote-mcp/src/gmail-gate/connect.ts` (`GATE_SCOPES.gmail`), `extensions/remote-mcp/src/auth/__tests__/oauth.test.ts`, `src/overlay/renderer/components/GmailGate/GmailGateModal.tsx`, `.env.example`, `.github/workflows/release.yml` (scope-listing comments), `docs/runbooks/gmail-gate-testing-project.md`

- [ ] **Step 1: Failing test first** — in `extensions/remote-mcp/src/gmail-gate/__tests__/connect.test.ts` (or a new assertion beside the existing referential ones) pin the list EXACTLY:

```ts
  it('gmail gate requests exactly readonly + send', () => {
    expect(GATE_SCOPES.gmail).toEqual([
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
    ]);
  });
```

And in `auth/__tests__/oauth.test.ts`: extend line ~53's `toContain('gmail.readonly')` with a sibling `toContain('.../gmail.send')`; extend the identity-only test (~line 74) with `expect(scope).not.toContain('gmail.send');`.

- [ ] **Step 2: Implement**

- `connect.ts:19`: `gmail: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'],`
- `GmailGateModal.tsx` (~line 244): the copy currently says Google reviews apps that may **read** Gmail — extend it to name sending honestly, e.g. `…before an app may read ${label} — or send from it. KIAgent asks for both: reading builds your corpus, and sending powers draft replies that YOU confirm before anything goes out.` Also extend the trust line (~130) to `Everything stays on this machine — and nothing is ever sent without your explicit confirmation.` (No test asserts this prose; re-read the rendered modal manually.)
- `.env.example` (~line 23) + `release.yml` (~line 151): update the scope-listing comment text to include `gmail.send`.
- Runbook `docs/runbooks/gmail-gate-testing-project.md` (~lines 19, 72): add `gmail.send` to the scope tables/steps.

- [ ] **Step 3: Gates** — `npm test`, lint, typecheck — green. Commit (never sweeping the unrelated untracked `docs/*.md` files):

```bash
cd /Users/edjafarov/work/alpha-cent
git add extensions/remote-mcp/src/gmail-gate extensions/remote-mcp/src/auth/__tests__/oauth.test.ts src/overlay/renderer/components/GmailGate/GmailGateModal.tsx .env.example .github/workflows/release.yml docs/runbooks/gmail-gate-testing-project.md
git commit -m "feat(gmail-gate): consent + scopes cover gmail.send"
```

- [ ] **Step 4: Report** with the remaining MANUAL steps (not automatable):
  1. Google console, project `kia-publicca` ONLY: add `https://www.googleapis.com/auth/gmail.send` on the Data-access page (`https://console.cloud.google.com/auth/scopes?project=kia-publicca`). Restricted scope — free while the project stays in Testing. NEVER add it to `kiagent-496015`.
  2. Existing gmail accounts: re-consent IS reconnect (`prompt=consent`, no incremental auth). Testing-cohort users already re-auth weekly (7-day refresh-token expiry), so the reconnect lands naturally; the sender's error copy walks anyone who sends first.
  3. Smoke with a real founding-cohort account: connect → draft_reply on a gmail thread → confirm page → verify the reply lands IN THREAD in Gmail Sent, and the corpus picks it up on the next delta pull.
- Spec cross-off: phase 5 of §12.
