# Unified Outbound Layer — Phase 1 (Outbox core, confirm pages, SMTP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** LLM clients can draft replies/messages against the corpus via three new MCP tools; the user confirms on an app-served page (mode "review" or mode "link"); the app sends over SMTP for IMAP accounts and appends the sent message to the IMAP Sent mailbox.

**Architecture:** A new `outbox` table (corpus SQLite, forward-only migration v4) holds frozen drafts with a `draft → sending → sent/failed/discarded/expired` state machine. An `OutboundService` (new `src/main/outbound/`) creates drafts from stored document metadata (the model never supplies addresses), mints HMAC-signed single-use confirm URLs, and runs the send pipeline through an RPC-serializable `Sender` contract. Confirm pages are new routes on the existing loopback MCP HTTP server (raw `http`, inline routing, existing DNS-rebind guard). GET never sends; every send is a POST behind a button.

**Tech Stack:** TypeScript, Electron main process, better-sqlite3 via the async `AppDb` bridge, raw Node `http`, `nodemailer` (new dep), `imapflow` (existing), jest + ts-jest.

**Spec:** `docs/superpowers/specs/2026-07-23-unified-outbound-design.md` (this repo copy; original committed in alpha-cent `9fab318`; both committed alongside this plan). This plan covers spec build-order **phases 1–3 only** (outbox core, confirm pages, SMTP pipeline). Phases 4–9 (remote confirm, Gmail transport, mode C/`send_draft`, reply-all enrichment, Slack pilot, history panel) get their own plans after this lands.

## Global Constraints

- Repo: `/Users/edjafarov/work/kiagent-core`, branch `dev`. All work is core-side; do NOT touch `/Users/edjafarov/work/alpha-cent` in this plan.
- NEVER `git commit --amend`, rebase, or reset — the user runs concurrent sessions on these checkouts. Never bypass commit hooks. Commit messages: conventional style (`feat(outbound): …`), NO `Co-Authored-By` trailer, no promo lines.
- Per-task gate: run the named test file. Final task gate: FULL `npm test` + `npm run lint` + `npm run typecheck` — per-file runs hide breakage; the full suite is the merge gate.
- Timestamps in the `outbox` table are TEXT ISO-8601 (house style — the spec sketch's INTEGER epoch is deliberately not used). Token expiry uses epoch ms (inside the signed token only, never stored).
- Confirmation-mode names in code: `'review'` (spec mode A, the default) and `'link'` (spec mode B). Mode C (`'chat'`, `send_draft`) is phase 6 — NOT in this plan; do not add it to types or UI.
- Constants (defined once in Task 5, reused everywhere): confirm-URL TTL `review` = 30 min, `link` = 5 min; draft row TTL = 24 h; pending cap `OUTBOX_PENDING_CAP = 20` drafts/account (Task 2).
- Confirm URLs: `http://127.0.0.1:<loopback-port>/outbox/confirm/<token>`. GET renders pages only and never mutates; sends/cancels are POST.
- New runtime dependency `nodemailer` goes in `release/app/package.json` ONLY (main-process runtime deps live there — same as `imapflow`); `@types/nodemailer` goes in root `package.json` devDependencies. Jest resolves `release/app/node_modules` via `moduleDirectories` — no jest config change needed.
- Path aliases: `@main/*` → `src/main/*`, `@shared/*` → `src/shared/*` (tsconfig + jest already map them).
- If jest suddenly fails with a better-sqlite3 ABI/NODE_MODULE_VERSION error, run `npm rebuild better-sqlite3` and retry — do not chase phantom failures.

## File Structure

**Created:**

| File | Responsibility |
| --- | --- |
| `src/main/core/store/outbox.ts` | Outbox table access: create/get/list/transition/expire + HMAC secret storage. One table, one module. |
| `src/main/core/store/__tests__/outbox.test.ts` | Outbox store tests. |
| `src/main/outbound/tokens.ts` | Pure HMAC confirm-token sign/verify. |
| `src/main/outbound/__tests__/tokens.test.ts` | Token tests. |
| `src/main/outbound/resolve.ts` | Reply resolution from stored IMAP document metadata. |
| `src/main/outbound/__tests__/resolve.test.ts` | Resolution tests. |
| `src/main/outbound/service.ts` | OutboundService: draft creation, mode lookup, URL minting, confirm/cancel/send pipeline. |
| `src/main/outbound/__tests__/service.test.ts` | Service tests (fake Sender). |
| `src/main/outbound/pages.ts` | Confirm/result HTML pages via `@shared/web-ui` `renderShell`. |
| `src/main/outbound/routes.ts` | `/outbox/*` HTTP route handling for the loopback server. |
| `src/main/outbound/senders/smtp.ts` | SMTP `Sender` (nodemailer) + Sent-append + config derivation. |
| `src/main/outbound/senders/__tests__/smtp.test.ts` | SMTP sender tests (injected fakes). |
| `src/main/outbound/senders/index.ts` | `buildBundledSenders` — source-id → Sender map. |
| `src/main/core/mcp/tools/draft-reply.ts` | `draft_reply` MCP tool. |
| `src/main/core/mcp/tools/draft-message.ts` | `draft_message` MCP tool. |
| `src/main/core/mcp/tools/list-outbox.ts` | `list_outbox` MCP tool. |
| `src/main/core/mcp/__tests__/outbound-tools.test.ts` | Tool tests over a real store + fake sender. |
| `src/main/core/mcp/__tests__/outbound-routes.test.ts` | HTTP route tests over a started loopback server. |
| `src/main/mcp/outbound-proxy.ts` | stdio-process OutboundToolApi proxy → loopback `/outbox/api`. |
| `src/main/mcp/__tests__/outbound-proxy.test.ts` | Proxy tests against a stub HTTP server. |
| `src/renderer/screens/Sources/sections/Outbound.tsx` | Per-account mode + SMTP override UI. |

**Modified:**

| File | Change |
| --- | --- |
| `src/shared/contracts.ts` | Outbox/Sender/ConfirmMode types; `AppPrefs.outbound`. |
| `src/main/core/store/schema.ts` | Migration v4: `outbox` table. |
| `src/main/core/store/store.ts` | `CoreStore.outbox` wired to `createOutboxStore`. |
| `src/main/core/mcp/tools/index.ts` | `buildBuiltinTools(query, outbound?)` + 3 new tools. |
| `src/main/core/mcp/server.ts` | `McpDeps.outbound`, `/outbox/*` dispatch branch, `setBaseUrl` after listen. |
| `src/main/core/mcp/instructions.ts` | Mention outbound tools in server instructions (only if it enumerates tools — check first). |
| `src/main/core/mcp/__tests__/server.test.ts` | `BUILTIN_TOOL_NAMES` gains the three new tools. |
| `src/main/core/prefs.ts` | `outbound.defaultMode` default + sanitize + patch merge. |
| `src/main/core/__tests__/prefs.test.ts` | New sanitize/patch cases. |
| `src/main/sources/imap/types.ts` | `ImapClient.append(...)`. |
| `src/main/sources/imap/client.ts` | `append` implementation over `flow.append`. |
| `src/main/mcp/stdio-entry.ts` | Pass `createOutboundProxy()` into `buildBuiltinTools`. |
| `src/renderer/screens/Settings/Advanced.tsx` | Global default-mode select. |
| `src/renderer/screens/Sources/SourceDetail.tsx` | Render `<Outbound account={a} />` for IMAP accounts. |
| `release/app/package.json` | `nodemailer` dependency. |
| `package.json` | `@types/nodemailer` devDependency. |

---

### Task 1: Shared contracts + outbox schema migration (v4)

**Files:**
- Modify: `src/shared/contracts.ts` (add a new section after the `Source` section, around line 388)
- Modify: `src/main/core/store/schema.ts` (append migration v4 to `MIGRATIONS`)
- Test: `src/main/core/store/__tests__/outbox.test.ts` (new — migration part only)

**Interfaces:**
- Consumes: existing `AccountId`, `DocumentId` branded types in contracts.ts.
- Produces: types `OutboxStatus`, `ConfirmMode`, `OutboxRow`, `SendIntent`, `SendResult`, `Sender` exported from `@shared/contracts`; an `outbox` SQL table (columns exactly as below) that every later task reads/writes.

- [ ] **Step 1: Write the failing migration test**

Create `src/main/core/store/__tests__/outbox.test.ts`:

```ts
import fs from 'fs';
import os from 'os';
import path from 'path';

import { openDb, type AppDb } from '../../../db/app-db';

describe('outbox schema (migration v4)', () => {
  let dir: string;
  let db: AppDb;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-outbox-'));
    db = await openDb(path.join(dir, 'test.db'));
  });

  afterEach(async () => {
    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates the outbox table with the expected columns', async () => {
    const cols = (await db.all(`PRAGMA table_info(outbox)`)).map(
      (r) => r.name as string,
    );
    expect(cols).toEqual([
      'id',
      'account_id',
      'kind',
      'reply_to_document_id',
      'outbound_ref',
      'recipient_display',
      'to_json',
      'cc_json',
      'subject',
      'body_markdown',
      'threading_json',
      'status',
      'error',
      'external_message_id',
      'created_via',
      'created_at',
      'sent_at',
      'expires_at',
    ]);
  });

  it('rejects a status outside the state machine', async () => {
    await expect(
      db.run(
        `INSERT INTO outbox (id, account_id, kind, recipient_display,
           body_markdown, status, created_via, created_at, expires_at)
         VALUES ('x', 'a', 'new', 'r', 'b', 'bogus', 'mcp-local', 't', 't')`,
      ),
    ).rejects.toThrow(/CHECK/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx jest src/main/core/store/__tests__/outbox.test.ts -v`
Expected: FAIL — `cols` is `[]` (no `outbox` table yet).

- [ ] **Step 3: Add the v4 migration**

In `src/main/core/store/schema.ts`, append to the `MIGRATIONS` array (after the v3 function entry, before the closing `];`):

```ts
  // v4 — the outbox: frozen outbound drafts + their audit trail
  // (docs/superpowers/specs/2026-07-23-unified-outbound-design.md). Dedicated
  // table, NOT a document type: drafts are mutable workflow state, and the
  // sent copy re-enters the corpus through normal ingestion. Sent/failed/
  // discarded rows are retained — the table IS the audit log. ON DELETE
  // CASCADE: removing an account removes its outbox history, matching the
  // removeAccount cascade for every other per-account table.
  `
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
    status TEXT NOT NULL CHECK (status IN
      ('draft','sending','sent','failed','discarded','expired')),
    error TEXT,
    external_message_id TEXT,
    created_via TEXT NOT NULL,
    created_at TEXT NOT NULL,
    sent_at TEXT,
    expires_at TEXT NOT NULL
  );
  CREATE INDEX idx_outbox_account_status ON outbox(account_id, status);
  `,
```

- [ ] **Step 4: Add the shared types**

In `src/shared/contracts.ts`, insert a new section right before the `// 4. …` section that follows the SOURCE section (search for the section-divider comment after the `Source` interface, around line 388):

```ts
// ─────────────────────────────────────────────────────────────────────────────
// 3b. OUTBOUND — frozen drafts, user-gated sending
// ─────────────────────────────────────────────────────────────────────────────

export type OutboxStatus =
  | 'draft'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'discarded'
  | 'expired';

/** How a draft gets user confirmation. 'review' = full app-served review page
 *  (spec mode A, the default); 'link' = in-chat review + short-TTL signed
 *  link landing on a minimal Send-button page (spec mode B). Mode C ('chat',
 *  send_draft) arrives in a later phase. */
export type ConfirmMode = 'review' | 'link';

/** One outbox row, frozen at creation. Confirm surfaces render from this row;
 *  nothing the model does after creation can alter what would be sent. */
export interface OutboxRow {
  id: string;
  accountId: AccountId;
  kind: 'reply' | 'new';
  replyToDocumentId: DocumentId | null;
  /** Opaque per-source reply target, round-tripped verbatim to the same
   *  source's Sender. Null unless the source's toDocument wrote
   *  metadata.outbound. */
  outboundRef: unknown;
  recipientDisplay: string;
  to: string[];
  cc: string[];
  subject: string | null;
  bodyMarkdown: string;
  threading: Record<string, unknown> | null;
  status: OutboxStatus;
  error: string | null;
  externalMessageId: string | null;
  createdVia: 'mcp-local' | 'mcp-remote';
  createdAt: string;
  sentAt: string | null;
  expiresAt: string;
}

/** What a Sender is asked to send — plain data in, plain data out, no
 *  callbacks: third-party senders run out-of-process over Connector RPC. */
export interface SendIntent {
  accountId: AccountId;
  kind: 'reply' | 'new';
  outboundRef?: unknown;
  to?: string[];
  cc?: string[];
  subject?: string;
  bodyMarkdown: string;
  threading?: Record<string, unknown>;
}

export interface SendResult {
  externalMessageId?: string;
}

/** Outbound transport for one source id. Reachable ONLY from the send
 *  pipeline — i.e. only after a confirmation gate — never from the MCP
 *  plane directly. */
export interface Sender {
  send(intent: SendIntent): Promise<SendResult>;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx jest src/main/core/store/__tests__/outbox.test.ts -v`
Expected: PASS (both cases).

Also run the existing store suite to prove the migration doesn't break v1–v3 paths:
Run: `npx jest src/main/core/store -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/edjafarov/work/kiagent-core
git add src/shared/contracts.ts src/main/core/store/schema.ts src/main/core/store/__tests__/outbox.test.ts
git commit -m "feat(outbound): outbox schema v4 + shared Sender/OutboxRow contracts"
```

(The spec + this plan ride the first commit.)

---

### Task 2: Outbox store module

**Files:**
- Create: `src/main/core/store/outbox.ts`
- Modify: `src/main/core/store/store.ts` (interface `CoreStore` + `openStore` return object)
- Test: `src/main/core/store/__tests__/outbox.test.ts` (extend)

**Interfaces:**
- Consumes: `AppDb` (`db.all`/`db.run`/`db.batch` — `batch` is the ONLY way to observe `changes` for an UPDATE), `newId` from `@main/core/ids`, types from Task 1.
- Produces (used by Tasks 5, 7, 8, 13):

```ts
export const OUTBOX_PENDING_CAP = 20;

export interface OutboxDraftInput {
  accountId: AccountId;
  kind: 'reply' | 'new';
  replyToDocumentId?: DocumentId | null;
  outboundRef?: unknown;
  recipientDisplay: string;
  to: string[];
  cc: string[];
  subject?: string | null;
  bodyMarkdown: string;
  threading?: Record<string, unknown> | null;
  createdVia: 'mcp-local' | 'mcp-remote';
  expiresAt: string;
}

export interface OutboxStore {
  create(d: OutboxDraftInput): Promise<OutboxRow>; // throws on pending cap
  get(id: string): Promise<OutboxRow | null>;
  listRecent(limit: number): Promise<OutboxRow[]>; // newest first
  /** Atomic compare-and-set; true iff exactly one row moved. */
  transition(
    id: string,
    from: OutboxStatus[],
    to: OutboxStatus,
    patch?: {
      error?: string | null;
      externalMessageId?: string | null;
      sentAt?: string | null;
    },
  ): Promise<boolean>;
  countDrafts(accountId: AccountId): Promise<number>;
  /** draft rows past expires_at → status 'expired'. Called lazily. */
  expireOverdue(): Promise<void>;
  /** Lazily generated 32-byte HMAC secret, sealed with the store's encrypt
   *  codec, persisted in the meta table under 'outboundSecret'. */
  secret(): Promise<Buffer>;
}

export function createOutboxStore(
  db: AppDb,
  deps: {
    now: () => string;
    encrypt(plain: string): Buffer;
    decrypt(blob: Buffer): string;
  },
): OutboxStore;
```

- `CoreStore` (in `store.ts`) gains `outbox: OutboxStore;`.

- [ ] **Step 1: Extend the test file with failing store tests**

Append to `src/main/core/store/__tests__/outbox.test.ts` (add the new imports at the top; the store harness mirrors `store.test.ts`):

```ts
import type { AccountId } from '@shared/contracts';
import { openStore, type CoreStore } from '../store';
import { OUTBOX_PENDING_CAP, type OutboxDraftInput } from '../outbox';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};

describe('outbox store', () => {
  let dir: string;
  let store: CoreStore;
  let accountId: AccountId;

  const draft = (over: Partial<OutboxDraftInput> = {}): OutboxDraftInput => ({
    accountId,
    kind: 'new',
    recipientDisplay: 'bob@example.com',
    to: ['bob@example.com'],
    cc: [],
    subject: 'Hi',
    bodyMarkdown: 'Hello Bob',
    createdVia: 'mcp-local',
    expiresAt: '2099-01-01T00:00:00.000Z',
    ...over,
  });

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-outbox-'));
    store = openStore(await openDb(path.join(dir, 'test.db')), deps);
    const account = await store.createAccount({
      source: 'imap',
      identifier: 'me@example.com',
    });
    accountId = account.id;
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates and reads back a draft row', async () => {
    const row = await store.outbox.create(draft());
    expect(row.status).toBe('draft');
    expect(row.to).toEqual(['bob@example.com']);
    const back = await store.outbox.get(row.id);
    expect(back).toEqual(row);
  });

  it('round-trips threading and outboundRef JSON', async () => {
    const row = await store.outbox.create(
      draft({
        kind: 'reply',
        outboundRef: { channel: 'C123' },
        threading: { inReplyTo: '<m1@x>' },
      }),
    );
    const back = await store.outbox.get(row.id);
    expect(back?.outboundRef).toEqual({ channel: 'C123' });
    expect(back?.threading).toEqual({ inReplyTo: '<m1@x>' });
  });

  it('transition is an atomic compare-and-set', async () => {
    const row = await store.outbox.create(draft());
    expect(await store.outbox.transition(row.id, ['draft'], 'sending')).toBe(
      true,
    );
    // Second attempt from 'draft' must lose: the row is already 'sending'.
    expect(await store.outbox.transition(row.id, ['draft'], 'sending')).toBe(
      false,
    );
    expect(
      await store.outbox.transition(row.id, ['sending'], 'sent', {
        sentAt: '2026-07-23T12:00:00.000Z',
        externalMessageId: '<out@x>',
      }),
    ).toBe(true);
    const back = await store.outbox.get(row.id);
    expect(back?.status).toBe('sent');
    expect(back?.externalMessageId).toBe('<out@x>');
    expect(back?.sentAt).toBe('2026-07-23T12:00:00.000Z');
  });

  it('enforces the per-account pending cap', async () => {
    for (let i = 0; i < OUTBOX_PENDING_CAP; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await store.outbox.create(draft());
    }
    await expect(store.outbox.create(draft())).rejects.toThrow(/pending/i);
    // Non-draft rows don't count against the cap.
    const rows = await store.outbox.listRecent(OUTBOX_PENDING_CAP);
    await store.outbox.transition(rows[0].id, ['draft'], 'discarded');
    await expect(store.outbox.create(draft())).resolves.toBeTruthy();
  });

  it('expireOverdue moves overdue drafts to expired', async () => {
    const row = await store.outbox.create(
      draft({ expiresAt: '2000-01-01T00:00:00.000Z' }),
    );
    await store.outbox.expireOverdue();
    expect((await store.outbox.get(row.id))?.status).toBe('expired');
  });

  it('secret is stable across calls and 32 bytes', async () => {
    const a = await store.outbox.secret();
    const b = await store.outbox.secret();
    expect(a.length).toBe(32);
    expect(a.equals(b)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/main/core/store/__tests__/outbox.test.ts -v`
Expected: FAIL — `../outbox` does not exist / `store.outbox` undefined.

- [ ] **Step 3: Implement `src/main/core/store/outbox.ts`**

```ts
/**
 * Outbox table access — frozen outbound drafts and their state machine
 * (docs/superpowers/specs/2026-07-23-unified-outbound-design.md §3).
 * Composed into CoreStore as `store.outbox` the way vault/identity/consents
 * are; kept in its own module so store.ts doesn't grow another 200 lines.
 */
import { randomBytes } from 'crypto';

import type {
  AccountId,
  DocumentId,
  OutboxRow,
  OutboxStatus,
} from '@shared/contracts';

import { newId } from '../ids';
import type { AppDb } from '../../db/app-db';

export const OUTBOX_PENDING_CAP = 20;

export interface OutboxDraftInput {
  accountId: AccountId;
  kind: 'reply' | 'new';
  replyToDocumentId?: DocumentId | null;
  outboundRef?: unknown;
  recipientDisplay: string;
  to: string[];
  cc: string[];
  subject?: string | null;
  bodyMarkdown: string;
  threading?: Record<string, unknown> | null;
  createdVia: 'mcp-local' | 'mcp-remote';
  expiresAt: string;
}

export interface OutboxStore {
  create(d: OutboxDraftInput): Promise<OutboxRow>;
  get(id: string): Promise<OutboxRow | null>;
  listRecent(limit: number): Promise<OutboxRow[]>;
  transition(
    id: string,
    from: OutboxStatus[],
    to: OutboxStatus,
    patch?: {
      error?: string | null;
      externalMessageId?: string | null;
      sentAt?: string | null;
    },
  ): Promise<boolean>;
  countDrafts(accountId: AccountId): Promise<number>;
  expireOverdue(): Promise<void>;
  secret(): Promise<Buffer>;
}

interface OutboxRowSql {
  id: string;
  account_id: string;
  kind: 'reply' | 'new';
  reply_to_document_id: string | null;
  outbound_ref: string | null;
  recipient_display: string;
  to_json: string;
  cc_json: string;
  subject: string | null;
  body_markdown: string;
  threading_json: string | null;
  status: OutboxStatus;
  error: string | null;
  external_message_id: string | null;
  created_via: 'mcp-local' | 'mcp-remote';
  created_at: string;
  sent_at: string | null;
  expires_at: string;
}

function toRow(r: OutboxRowSql): OutboxRow {
  return {
    id: r.id,
    accountId: r.account_id as AccountId,
    kind: r.kind,
    replyToDocumentId: (r.reply_to_document_id as DocumentId | null) ?? null,
    outboundRef: r.outbound_ref === null ? null : JSON.parse(r.outbound_ref),
    recipientDisplay: r.recipient_display,
    to: JSON.parse(r.to_json) as string[],
    cc: JSON.parse(r.cc_json) as string[],
    subject: r.subject,
    bodyMarkdown: r.body_markdown,
    threading:
      r.threading_json === null
        ? null
        : (JSON.parse(r.threading_json) as Record<string, unknown>),
    status: r.status,
    error: r.error,
    externalMessageId: r.external_message_id,
    createdVia: r.created_via,
    createdAt: r.created_at,
    sentAt: r.sent_at,
    expiresAt: r.expires_at,
  };
}

export function createOutboxStore(
  db: AppDb,
  deps: {
    now: () => string;
    encrypt(plain: string): Buffer;
    decrypt(blob: Buffer): string;
  },
): OutboxStore {
  const get = async (id: string): Promise<OutboxRow | null> => {
    const r = (await db.all(`SELECT * FROM outbox WHERE id = ?`, [id]))[0] as
      | OutboxRowSql
      | undefined;
    return r ? toRow(r) : null;
  };

  const countDrafts = async (accountId: AccountId): Promise<number> => {
    const r = (
      await db.all(
        `SELECT COUNT(*) AS n FROM outbox
          WHERE account_id = ? AND status = 'draft'`,
        [accountId],
      )
    )[0] as { n: number };
    return r.n;
  };

  return {
    get,
    countDrafts,

    async create(d) {
      // Lazy sweep first so stale drafts never occupy cap slots.
      await this.expireOverdue();
      const pending = await countDrafts(d.accountId);
      if (pending >= OUTBOX_PENDING_CAP) {
        throw new Error(
          `outbox: account has ${pending} pending drafts (cap ` +
            `${OUTBOX_PENDING_CAP}) — confirm or cancel existing drafts first ` +
            `(list_outbox shows them).`,
        );
      }
      const id = newId<'outbox'>() as string;
      await db.run(
        `INSERT INTO outbox (id, account_id, kind, reply_to_document_id,
           outbound_ref, recipient_display, to_json, cc_json, subject,
           body_markdown, threading_json, status, created_via, created_at,
           expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
        [
          id,
          d.accountId,
          d.kind,
          d.replyToDocumentId ?? null,
          d.outboundRef === undefined || d.outboundRef === null
            ? null
            : JSON.stringify(d.outboundRef),
          d.recipientDisplay,
          JSON.stringify(d.to),
          JSON.stringify(d.cc),
          d.subject ?? null,
          d.bodyMarkdown,
          d.threading ? JSON.stringify(d.threading) : null,
          d.createdVia,
          deps.now(),
          d.expiresAt,
        ],
      );
      const row = await get(id);
      if (!row) throw new Error('outbox: insert readback failed');
      return row;
    },

    async listRecent(limit) {
      const rows = (await db.all(
        `SELECT * FROM outbox ORDER BY created_at DESC, id DESC LIMIT ?`,
        [limit],
      )) as unknown as OutboxRowSql[];
      return rows.map(toRow);
    },

    async transition(id, from, to, patch = {}) {
      // Single UPDATE = the atomicity primitive; db.batch is the only AppDb
      // surface that reports `changes`, so the compare-and-set rides it.
      const placeholders = from.map(() => '?').join(',');
      const results = await db.batch([
        {
          sql: `UPDATE outbox SET status = ?,
                  error = COALESCE(?, error),
                  external_message_id = COALESCE(?, external_message_id),
                  sent_at = COALESCE(?, sent_at)
                WHERE id = ? AND status IN (${placeholders})`,
          params: [
            to,
            patch.error ?? null,
            patch.externalMessageId ?? null,
            patch.sentAt ?? null,
            id,
            ...from,
          ],
        },
      ]);
      return results[0].changes === 1;
    },

    async expireOverdue() {
      await db.run(
        `UPDATE outbox SET status = 'expired'
          WHERE status = 'draft' AND expires_at <= ?`,
        [deps.now()],
      );
    },

    async secret() {
      const r = (
        await db.all(`SELECT value FROM meta WHERE key = 'outboundSecret'`)
      )[0] as { value: string } | undefined;
      if (r) {
        return Buffer.from(deps.decrypt(Buffer.from(r.value, 'base64')), 'base64');
      }
      const secret = randomBytes(32);
      const sealed = deps.encrypt(secret.toString('base64')).toString('base64');
      await db.run(
        `INSERT INTO meta(key, value) VALUES('outboundSecret', ?)
         ON CONFLICT(key) DO NOTHING`,
        [sealed],
      );
      // Re-read: a concurrent generator may have won the ON CONFLICT race.
      const back = (
        await db.all(`SELECT value FROM meta WHERE key = 'outboundSecret'`)
      )[0] as { value: string };
      return Buffer.from(
        deps.decrypt(Buffer.from(back.value, 'base64')),
        'base64',
      );
    },
  };
}
```

- [ ] **Step 4: Wire into `CoreStore`**

In `src/main/core/store/store.ts`:

1. Add the import near the other local imports:
```ts
import { createOutboxStore, type OutboxStore } from './outbox';
```
2. In `export interface CoreStore extends Store { … }` (line ~65), add one member:
```ts
  outbox: OutboxStore;
```
3. In the object returned by `openStore` (it already has `vault:`, `identity:`, `consents:`, `maintenance:` members — find `vault: {` at ~line 695 and add the sibling right before it):
```ts
    outbox: createOutboxStore(db, {
      now,
      encrypt: deps.encrypt,
      decrypt: deps.decrypt,
    }),
```

- [ ] **Step 5: Run tests**

Run: `npx jest src/main/core/store/__tests__/outbox.test.ts -v`
Expected: PASS (all cases).
Run: `npx jest src/main/core/store -v` — Expected: PASS (no regression).

- [ ] **Step 6: Commit**

```bash
git add src/main/core/store/outbox.ts src/main/core/store/store.ts src/main/core/store/__tests__/outbox.test.ts
git commit -m "feat(outbound): outbox store — drafts, atomic transitions, pending cap, sealed HMAC secret"
```

---

### Task 3: Confirm-token module

**Files:**
- Create: `src/main/outbound/tokens.ts`
- Test: `src/main/outbound/__tests__/tokens.test.ts`

**Interfaces:**
- Consumes: nothing app-specific (pure node `crypto`).
- Produces (used by Tasks 5, 8):

```ts
export function signConfirmToken(
  secret: Buffer,
  draftId: string,
  expiresAtMs: number,
): string;
/** null on bad shape, bad signature, or expiry. */
export function verifyConfirmToken(
  secret: Buffer,
  token: string,
  nowMs: number,
): { draftId: string; expiresAtMs: number } | null;
```

Token wire format: `<draftId>.<expiresAtMs>.<base64url(hmacSha256(secret, "<draftId>.<expiresAtMs>"))>` — draftId is a UUID (no dots), so `split('.')` is unambiguous; the whole token is URL-path-safe.

- [ ] **Step 1: Write the failing test**

Create `src/main/outbound/__tests__/tokens.test.ts`:

```ts
import { signConfirmToken, verifyConfirmToken } from '../tokens';

const SECRET = Buffer.alloc(32, 7);
const ID = '0198f4a2-1111-7000-8000-abcdefabcdef';

describe('confirm tokens', () => {
  it('round-trips a valid token', () => {
    const t = signConfirmToken(SECRET, ID, 2_000_000);
    expect(verifyConfirmToken(SECRET, t, 1_000_000)).toEqual({
      draftId: ID,
      expiresAtMs: 2_000_000,
    });
  });

  it('rejects an expired token', () => {
    const t = signConfirmToken(SECRET, ID, 2_000_000);
    expect(verifyConfirmToken(SECRET, t, 2_000_001)).toBeNull();
  });

  it('rejects a tampered draft id', () => {
    const t = signConfirmToken(SECRET, ID, 2_000_000);
    const other = t.replace(ID, ID.replace('1111', '2222'));
    expect(verifyConfirmToken(SECRET, other, 1_000_000)).toBeNull();
  });

  it('rejects a token signed with a different secret', () => {
    const t = signConfirmToken(Buffer.alloc(32, 8), ID, 2_000_000);
    expect(verifyConfirmToken(SECRET, t, 1_000_000)).toBeNull();
  });

  it('rejects garbage without throwing', () => {
    expect(verifyConfirmToken(SECRET, 'not.a.token', 0)).toBeNull();
    expect(verifyConfirmToken(SECRET, '', 0)).toBeNull();
    expect(verifyConfirmToken(SECRET, 'a.b', 0)).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx jest src/main/outbound/__tests__/tokens.test.ts -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/main/outbound/tokens.ts`**

```ts
/**
 * Signed capability tokens for outbox confirm/cancel URLs
 * (spec §5): HMAC(secret, draftId ‖ expiry). No server-side token table —
 * single-use falls out of the outbox state machine (any non-'draft' status
 * kills the link regardless of TTL).
 */
import { createHmac, timingSafeEqual } from 'crypto';

function sig(secret: Buffer, payload: string): Buffer {
  return createHmac('sha256', secret).update(payload).digest();
}

export function signConfirmToken(
  secret: Buffer,
  draftId: string,
  expiresAtMs: number,
): string {
  const payload = `${draftId}.${expiresAtMs}`;
  return `${payload}.${sig(secret, payload).toString('base64url')}`;
}

export function verifyConfirmToken(
  secret: Buffer,
  token: string,
  nowMs: number,
): { draftId: string; expiresAtMs: number } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [draftId, expStr, mac] = parts;
  const expiresAtMs = Number(expStr);
  if (!draftId || !Number.isFinite(expiresAtMs)) return null;
  const expected = sig(secret, `${draftId}.${expStr}`);
  let given: Buffer;
  try {
    given = Buffer.from(mac, 'base64url');
  } catch {
    return null;
  }
  if (given.length !== expected.length) return null;
  if (!timingSafeEqual(given, expected)) return null;
  if (nowMs > expiresAtMs) return null;
  return { draftId, expiresAtMs };
}
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `npx jest src/main/outbound/__tests__/tokens.test.ts -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/outbound/tokens.ts src/main/outbound/__tests__/tokens.test.ts
git commit -m "feat(outbound): HMAC confirm tokens — sign/verify with TTL, timing-safe"
```

---

### Task 4: Reply resolution from IMAP document metadata

**Files:**
- Create: `src/main/outbound/resolve.ts`
- Test: `src/main/outbound/__tests__/resolve.test.ts`

**Interfaces:**
- Consumes: `Document` from `@shared/contracts`. IMAP `email.message` metadata shape (written by `src/main/sources/imap/source.ts:291-297`): `{ from: string | null, to: string[], date, mailbox, uid, messageId: string | null }` — `messageId` is stored ANGLE-STRIPPED (`parse.ts` `stripAngle`), `from` is a display string like `"Alice <alice@x.com>"`, and there is NO cc and NO references chain.
- Produces (used by Task 5):

```ts
export interface ResolvedReply {
  to: string[];
  cc: string[];
  subject: string | null;      // "Re: <original>" (no double-prefix)
  recipientDisplay: string;    // the original sender display string
  threading: Record<string, unknown>; // { inReplyTo?, references? } RFC-bracketed
  warnings: string[];          // honest gaps, surfaced in the tool result
}
/** Throws Error (message names the gap) when metadata can't ground a reply. */
export function resolveImapReply(
  doc: Document,
  selfEmail: string,
  replyAll: boolean,
): ResolvedReply;
```

- [ ] **Step 1: Write the failing test**

Create `src/main/outbound/__tests__/resolve.test.ts`:

```ts
import type { Document } from '@shared/contracts';

import { resolveImapReply } from '../resolve';

function imapDoc(metadata: Record<string, unknown>): Document {
  return {
    id: 'doc-1',
    accountId: 'acc-1',
    externalId: 'INBOX:1:100',
    type: 'email.message',
    title: 'Quarterly numbers',
    markdown: 'body',
    metadata,
    createdAt: '2026-07-01T00:00:00Z',
    parentId: null,
    contentHash: 'h',
    seq: 1,
    archivedAt: null,
    languages: ['eng'],
    ingestedAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-01T00:00:00Z',
  } as unknown as Document;
}

const META = {
  from: 'Alice Smith <alice@example.com>',
  to: ['me@example.com', 'Bob <bob@example.com>'],
  date: '2026-07-01T00:00:00Z',
  mailbox: 'INBOX',
  uid: 100,
  messageId: 'orig-123@mail.example.com',
};

describe('resolveImapReply', () => {
  it('reply targets the sender with RFC-bracketed threading', () => {
    const r = resolveImapReply(imapDoc(META), 'me@example.com', false);
    expect(r.to).toEqual(['Alice Smith <alice@example.com>']);
    expect(r.cc).toEqual([]);
    expect(r.subject).toBe('Re: Quarterly numbers');
    expect(r.recipientDisplay).toBe('Alice Smith <alice@example.com>');
    expect(r.threading).toEqual({
      inReplyTo: '<orig-123@mail.example.com>',
      references: ['<orig-123@mail.example.com>'],
    });
    expect(r.warnings).toEqual([]);
  });

  it('reply_all adds To recipients minus self, warns about missing cc', () => {
    const r = resolveImapReply(imapDoc(META), 'me@example.com', true);
    expect(r.to).toEqual([
      'Alice Smith <alice@example.com>',
      'Bob <bob@example.com>',
    ]);
    expect(r.warnings.join(' ')).toMatch(/cc/i);
  });

  it('does not double-prefix an existing Re:', () => {
    const doc = imapDoc(META);
    (doc as { title: string }).title = 'RE: Quarterly numbers';
    const r = resolveImapReply(doc, 'me@example.com', false);
    expect(r.subject).toBe('RE: Quarterly numbers');
  });

  it('warns when no Message-ID is stored', () => {
    const r = resolveImapReply(
      imapDoc({ ...META, messageId: null }),
      'me@example.com',
      false,
    );
    expect(r.threading).toEqual({});
    expect(r.warnings.join(' ')).toMatch(/thread/i);
  });

  it('throws when the sender is missing', () => {
    expect(() =>
      resolveImapReply(imapDoc({ ...META, from: null }), 'me@example.com', false),
    ).toThrow(/sender/i);
  });

  it('rejects non-email documents', () => {
    const doc = imapDoc(META);
    (doc as { type: string }).type = 'note';
    expect(() => resolveImapReply(doc, 'me@example.com', false)).toThrow(
      /email\.message/,
    );
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/main/outbound/__tests__/resolve.test.ts -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/main/outbound/resolve.ts`**

```ts
/**
 * Grounded reply resolution (spec §1, §4): recipients and threading come
 * ONLY from stored document metadata — the model supplies no address, and a
 * gap is an explicit error or warning, never a guess.
 *
 * Phase 1 supports IMAP 'email.message' documents. Metadata shape written by
 * sources/imap/source.ts: { from, to, date, mailbox, uid, messageId } —
 * messageId stored angle-stripped, no cc, no references chain.
 */
import type { Document } from '@shared/contracts';

export interface ResolvedReply {
  to: string[];
  cc: string[];
  subject: string | null;
  recipientDisplay: string;
  threading: Record<string, unknown>;
  warnings: string[];
}

/** "Alice <alice@x>" → "alice@x"; bare addresses pass through. */
function addrOf(display: string): string {
  const m = /<([^>]+)>/.exec(display);
  return (m ? m[1] : display).trim().toLowerCase();
}

export function resolveImapReply(
  doc: Document,
  selfEmail: string,
  replyAll: boolean,
): ResolvedReply {
  if (doc.type !== 'email.message') {
    throw new Error(
      `draft_reply: document type '${doc.type}' is not replyable in this ` +
        `build — only 'email.message' (IMAP) documents are supported so far.`,
    );
  }
  const meta = doc.metadata as {
    from?: string | null;
    to?: string[];
    messageId?: string | null;
  };
  const from = meta.from ?? null;
  if (!from) {
    throw new Error(
      'draft_reply: the stored document has no sender metadata — cannot ' +
        'resolve a reply recipient.',
    );
  }

  const warnings: string[] = [];
  const self = selfEmail.trim().toLowerCase();
  const to = [from];
  if (replyAll) {
    const seen = new Set([addrOf(from), self]);
    for (const t of meta.to ?? []) {
      const a = addrOf(t);
      if (!seen.has(a)) {
        seen.add(a);
        to.push(t);
      }
    }
    warnings.push(
      'Cc recipients of the original message are not stored; the reply goes ' +
        'to the original From/To recipients only.',
    );
  }

  const threading: Record<string, unknown> = {};
  if (meta.messageId) {
    // Stored angle-stripped (imap/parse.ts stripAngle) — re-bracket for RFC
    // 5322 In-Reply-To/References headers.
    const bracketed = `<${meta.messageId}>`;
    threading.inReplyTo = bracketed;
    threading.references = [bracketed];
  } else {
    warnings.push(
      'No Message-ID is stored for the original — the reply may not thread ' +
        'on the recipient side.',
    );
  }

  const title = doc.title ?? null;
  const subject =
    title === null ? null : /^re:/i.test(title) ? title : `Re: ${title}`;

  return { to, cc: [], subject, recipientDisplay: from, threading, warnings };
}
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `npx jest src/main/outbound/__tests__/resolve.test.ts -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/outbound/resolve.ts src/main/outbound/__tests__/resolve.test.ts
git commit -m "feat(outbound): grounded IMAP reply resolution — recipients/threading from stored metadata only"
```

---

### Task 5: Outbound service — draft creation, modes, URLs

**Files:**
- Create: `src/main/outbound/service.ts`
- Test: `src/main/outbound/__tests__/service.test.ts`

**Interfaces:**
- Consumes: `CoreStore` (incl. `outbox`, `account(id)`, `read.document`), `Prefs`, `Map<string, Sender>`, `signConfirmToken`, `resolveImapReply`. NOTE: `AppPrefs.outbound` doesn't exist until Task 9 — until then read it defensively: `(prefs.get() as { outbound?: { defaultMode?: ConfirmMode } }).outbound?.defaultMode ?? 'review'`. Task 9 removes the cast.
- Produces (used by Tasks 6, 7, 8, 12, 13):

```ts
export const CONFIRM_TTL_MS: Record<ConfirmMode, number> = {
  review: 30 * 60_000,
  link: 5 * 60_000,
};
export const DRAFT_TTL_MS = 24 * 60 * 60_000;

export interface DraftToolResult {
  draft_id: string;
  mode: ConfirmMode;
  recipient_display: string;
  confirm_url: string;
  to?: string[];          // link mode only
  cc?: string[];          // link mode only
  subject?: string | null; // link mode only
  body?: string;          // link mode only
  warnings: string[];
  instruction: string;
}

export interface OutboxListItem {
  draft_id: string;
  status: OutboxStatus;
  recipient_display: string;
  subject: string | null;
  created_at: string;
  error: string | null;
  confirm_url: string | null; // re-issued for status 'draft', else null
}

/** The slice the MCP tools (and the stdio proxy) need — JSON-serializable
 *  args and results on every method. */
export interface OutboundToolApi {
  draftReply(a: {
    documentId: string;
    body: string;
    replyAll?: boolean;
  }): Promise<DraftToolResult>;
  draftMessage(a: {
    accountId: string;
    to: string[];
    subject: string;
    body: string;
  }): Promise<DraftToolResult>;
  listOutbox(a: { limit?: number }): Promise<OutboxListItem[]>;
}

export type PeekResult =
  | { kind: 'ok'; row: OutboxRow; mode: ConfirmMode }
  | { kind: 'gone'; row: OutboxRow } // any non-draft status
  | { kind: 'invalid' };

export type ConfirmOutcome =
  | { kind: 'sent'; row: OutboxRow }
  | { kind: 'cancelled'; row: OutboxRow }
  | { kind: 'failed'; row: OutboxRow; error: string }
  | { kind: 'already'; row: OutboxRow } // link raced/reused
  | { kind: 'invalid' };

export interface OutboundService extends OutboundToolApi {
  peekByToken(token: string): Promise<PeekResult>;
  confirmByToken(token: string): Promise<ConfirmOutcome>; // Task 7 fills in
  cancelByToken(token: string): Promise<ConfirmOutcome>;  // Task 7 fills in
  setBaseUrl(url: string): void;
}

export function createOutboundService(deps: {
  store: CoreStore;
  prefs: Prefs;
  senders: Map<string, Sender>;
  logSink: LogSink;
  nowMs?: () => number; // injectable clock for tests; default Date.now
}): OutboundService;
```

This task implements draft creation, mode lookup, URL minting, `listOutbox`, and `peekByToken`. `confirmByToken`/`cancelByToken` are added in Task 7 (stub them here to `throw new Error('not implemented')`).

Behavior contract (encode in tests):
- `draftReply`: load document (`store.read.document`) — unknown id → Error naming the id. Load account (`store.account(doc.accountId)`). Account's source not in `senders` → Error `sending from '<source>' accounts is not supported yet — supported: <keys>`. If `doc.metadata.outbound` is `{ ref, display }`, use it for `outboundRef`/`recipientDisplay` (universality hook); otherwise resolve via `resolveImapReply(doc, account.identifier, replyAll)`. Create the row (`kind:'reply'`, `createdVia:'mcp-local'`, `expiresAt = now + DRAFT_TTL_MS` as ISO). Result composed per mode.
- `draftMessage`: account by id (missing → Error), source must be in `senders`, `to` must be non-empty and every entry match `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` (invalid → Error listing the bad entries), `recipient_display = to.join(', ')`, `kind:'new'`.
- Mode lookup: `account.config.outbound?.mode` when `'review'`/`'link'`, else prefs default (see Consumes note), else `'review'`.
- Confirm URL: `${baseUrl}/outbox/confirm/${signConfirmToken(secret, row.id, nowMs() + CONFIRM_TTL_MS[mode])}`. `setBaseUrl` not yet called → Error `'outbound: server not ready'`.
- Result per mode — `review`: NO to/cc/subject/body; instruction: `Draft created — nothing has been sent. Show the user this link to review and send the message: <url> (it expires in 30 minutes; if it expires, call list_outbox for a fresh one).` `link`: includes to/cc/subject/body; instruction: `Draft created — nothing has been sent. Render the draft exactly as returned (recipient, subject, body) for the user to review in chat, then present this link as the send action: <url>. It opens a page with a Send button; the link expires in 5 minutes — call list_outbox for a fresh one if needed.`
- `listOutbox`: `expireOverdue()` first; `listRecent(limit ?? 20)`; rows with status `draft` get a fresh `confirm_url` (their account's current mode TTL), all others `confirm_url: null`.
- `peekByToken`: verify token (bad/expired → `invalid`); row missing → `invalid`; status `draft` → `ok` + current mode; else `gone`.

- [ ] **Step 1: Write the failing tests**

Create `src/main/outbound/__tests__/service.test.ts`:

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

import { openDb } from '../../db/app-db';
import { openStore, type CoreStore } from '../../core/store/store';
import { createOutboundService, type OutboundService } from '../service';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};

const logSink = { log: () => {} };

function fakePrefs(defaultMode?: string): Prefs {
  const p = {
    outbound: defaultMode ? { defaultMode } : undefined,
  } as unknown as ReturnType<Prefs['get']>;
  return { get: () => p, patch: async () => {}, onChange: () => () => {} };
}

const emailDoc = (over: Partial<DocumentInput> = {}): DocumentInput => ({
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
  ...over,
});

describe('outbound service — drafts', () => {
  let dir: string;
  let store: CoreStore;
  let accountId: AccountId;
  let service: OutboundService;
  let docId: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-outsvc-'));
    store = openStore(await openDb(path.join(dir, 'test.db')), deps);
    const account = await store.createAccount({
      source: 'imap',
      identifier: 'me@example.com',
    });
    accountId = account.id;
    await store.commit({
      account: accountId,
      documents: [emailDoc()],
      cursor: null,
    });
    const hits = await store.read.search({ limit: 10 });
    docId = hits[0].id as string;

    const sender: Sender = { send: async () => ({}) };
    service = createOutboundService({
      store,
      prefs: fakePrefs(),
      senders: new Map([['imap', sender]]),
      logSink,
    });
    service.setBaseUrl('http://127.0.0.1:7421');
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('draftReply resolves recipient from the document, mode review by default', async () => {
    const r = await service.draftReply({ documentId: docId, body: 'Thanks!' });
    expect(r.mode).toBe('review');
    expect(r.recipient_display).toBe('Alice <alice@example.com>');
    expect(r.confirm_url).toMatch(
      /^http:\/\/127\.0\.0\.1:7421\/outbox\/confirm\//,
    );
    expect(r.body).toBeUndefined(); // review mode carries no draft fields
    expect(r.instruction).toMatch(/review/i);
    const row = await store.outbox.get(r.draft_id);
    expect(row?.status).toBe('draft');
    expect(row?.to).toEqual(['Alice <alice@example.com>']);
    expect(row?.threading).toEqual({
      inReplyTo: '<orig@x>',
      references: ['<orig@x>'],
    });
  });

  it('link mode (per-account config) returns the full draft for in-chat review', async () => {
    await store.setAccountConfig(accountId, {
      outbound: { mode: 'link' },
    });
    const r = await service.draftReply({ documentId: docId, body: 'Hi' });
    expect(r.mode).toBe('link');
    expect(r.to).toEqual(['Alice <alice@example.com>']);
    expect(r.subject).toBe('Re: Numbers');
    expect(r.body).toBe('Hi');
    expect(r.instruction).toMatch(/render the draft/i);
  });

  it('draftMessage validates recipients and account source', async () => {
    const r = await service.draftMessage({
      accountId,
      to: ['bob@example.com'],
      subject: 'Yo',
      body: 'Hey',
    });
    expect(r.recipient_display).toBe('bob@example.com');
    await expect(
      service.draftMessage({
        accountId,
        to: ['not-an-email'],
        subject: 's',
        body: 'b',
      }),
    ).rejects.toThrow(/not-an-email/);
  });

  it('rejects drafts for accounts with no sender', async () => {
    const gmail = await store.createAccount({
      source: 'gmail',
      identifier: 'g@example.com',
    });
    await expect(
      service.draftMessage({
        accountId: gmail.id,
        to: ['b@x.com'],
        subject: 's',
        body: 'b',
      }),
    ).rejects.toThrow(/not supported yet/);
  });

  it('listOutbox re-issues confirm URLs for pending drafts only', async () => {
    const a = await service.draftReply({ documentId: docId, body: 'one' });
    await store.outbox.transition(a.draft_id, ['draft'], 'discarded');
    const b = await service.draftReply({ documentId: docId, body: 'two' });
    const listing = await service.listOutbox({});
    const byId = new Map(listing.map((i) => [i.draft_id, i]));
    expect(byId.get(b.draft_id)?.confirm_url).toMatch(/\/outbox\/confirm\//);
    expect(byId.get(a.draft_id)?.confirm_url).toBeNull();
    expect(byId.get(a.draft_id)?.status).toBe('discarded');
  });

  it('peekByToken: ok for pending, gone for handled, invalid for garbage', async () => {
    const r = await service.draftReply({ documentId: docId, body: 'x' });
    const token = r.confirm_url.split('/outbox/confirm/')[1];
    const peek = await service.peekByToken(token);
    expect(peek.kind).toBe('ok');
    await store.outbox.transition(r.draft_id, ['draft'], 'discarded');
    expect((await service.peekByToken(token)).kind).toBe('gone');
    expect((await service.peekByToken('garbage')).kind).toBe('invalid');
  });

  it('errors before setBaseUrl', async () => {
    const cold = createOutboundService({
      store,
      prefs: fakePrefs(),
      senders: new Map([['imap', { send: async () => ({}) }]]),
      logSink,
    });
    await expect(
      cold.draftReply({ documentId: docId, body: 'x' }),
    ).rejects.toThrow(/not ready/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/main/outbound/__tests__/service.test.ts -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/main/outbound/service.ts`**

The type/interface blocks in **Interfaces** above (`CONFIRM_TTL_MS` … `OutboundService`) are normative — copy them into the module verbatim, then:

```ts
/**
 * The outbound layer's hub (spec §2): draft creation grounded in stored
 * documents, per-account confirmation modes, signed confirm URLs, and (from
 * Task 7) the confirm/cancel/send pipeline. Everything a tool returns is
 * JSON-serializable so the stdio sibling can proxy it verbatim.
 */
import type {
  Account,
  AccountId,
  ConfirmMode,
  DocumentId,
  OutboxRow,
  OutboxStatus,
  Prefs,
  Sender,
} from '@shared/contracts';

import type { LogSink } from '../core/engine/engine';
import type { CoreStore } from '../core/store/store';
import { resolveImapReply } from './resolve';
import { signConfirmToken, verifyConfirmToken } from './tokens';

// …the normative constant/interface blocks from the task header go here…

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function createOutboundService(deps: {
  store: CoreStore;
  prefs: Prefs;
  senders: Map<string, Sender>;
  logSink: LogSink;
  nowMs?: () => number;
}): OutboundService {
  const nowMs = deps.nowMs ?? (() => Date.now());
  let baseUrl: string | null = null;

  const modeFor = (account: Account): ConfirmMode => {
    const cfg = (account.config as { outbound?: { mode?: unknown } }).outbound;
    if (cfg?.mode === 'review' || cfg?.mode === 'link') return cfg.mode;
    // Optional access on purpose: partial Prefs fakes (tests) and pre-Task-9
    // pref files have no `outbound` slice yet.
    const p = deps.prefs.get() as {
      outbound?: { defaultMode?: ConfirmMode };
    };
    return p.outbound?.defaultMode ?? 'review';
  };

  const accountFor = async (id: string): Promise<Account> => {
    const account = await deps.store.account(id as AccountId);
    if (!account) throw new Error(`outbound: unknown account '${id}'`);
    if (!deps.senders.has(account.source)) {
      throw new Error(
        `sending from '${account.source}' accounts is not supported yet — ` +
          `supported: ${[...deps.senders.keys()].join(', ')}`,
      );
    }
    return account;
  };

  const confirmUrl = async (
    draftId: string,
    mode: ConfirmMode,
  ): Promise<string> => {
    if (!baseUrl) throw new Error('outbound: server not ready');
    const secret = await deps.store.outbox.secret();
    const token = signConfirmToken(
      secret,
      draftId,
      nowMs() + CONFIRM_TTL_MS[mode],
    );
    return `${baseUrl}/outbox/confirm/${token}`;
  };

  const toolResult = async (
    row: OutboxRow,
    mode: ConfirmMode,
    warnings: string[],
  ): Promise<DraftToolResult> => {
    const url = await confirmUrl(row.id, mode);
    if (mode === 'review') {
      return {
        draft_id: row.id,
        mode,
        recipient_display: row.recipientDisplay,
        confirm_url: url,
        warnings,
        instruction:
          `Draft created — nothing has been sent. Show the user this link ` +
          `to review and send the message: ${url} (it expires in 30 ` +
          `minutes; if it expires, call list_outbox for a fresh one).`,
      };
    }
    return {
      draft_id: row.id,
      mode,
      recipient_display: row.recipientDisplay,
      confirm_url: url,
      to: row.to,
      cc: row.cc,
      subject: row.subject,
      body: row.bodyMarkdown,
      warnings,
      instruction:
        `Draft created — nothing has been sent. Render the draft exactly ` +
        `as returned (recipient, subject, body) for the user to review in ` +
        `chat, then present this link as the send action: ${url}. It opens ` +
        `a page with a Send button; the link expires in 5 minutes — call ` +
        `list_outbox for a fresh one if needed.`,
    };
  };

  const expiresAt = (): string =>
    new Date(nowMs() + DRAFT_TTL_MS).toISOString();

  return {
    setBaseUrl(url) {
      baseUrl = url;
    },

    async draftReply({ documentId, body, replyAll }) {
      const doc = await deps.store.read.document(documentId as DocumentId);
      if (!doc) throw new Error(`draft_reply: unknown document '${documentId}'`);
      const account = await accountFor(doc.accountId as string);
      const mode = modeFor(account);

      // Universality hook (spec §6): a source that wrote metadata.outbound
      // owns its reply addressing — the ref is opaque and round-trips to
      // that source's Sender verbatim. Bundled email resolution otherwise.
      const outboundMeta = doc.metadata.outbound as
        | { ref?: unknown; display?: unknown }
        | undefined;
      let row: OutboxRow;
      let warnings: string[] = [];
      if (outboundMeta && typeof outboundMeta.display === 'string') {
        row = await deps.store.outbox.create({
          accountId: account.id,
          kind: 'reply',
          replyToDocumentId: doc.id,
          outboundRef: outboundMeta.ref,
          recipientDisplay: outboundMeta.display,
          to: [],
          cc: [],
          subject: null,
          bodyMarkdown: body,
          createdVia: 'mcp-local',
          expiresAt: expiresAt(),
        });
      } else {
        const r = resolveImapReply(doc, account.identifier, replyAll === true);
        warnings = r.warnings;
        row = await deps.store.outbox.create({
          accountId: account.id,
          kind: 'reply',
          replyToDocumentId: doc.id,
          recipientDisplay: r.recipientDisplay,
          to: r.to,
          cc: r.cc,
          subject: r.subject,
          bodyMarkdown: body,
          threading: r.threading,
          createdVia: 'mcp-local',
          expiresAt: expiresAt(),
        });
      }
      return toolResult(row, mode, warnings);
    },

    async draftMessage({ accountId, to, subject, body }) {
      const account = await accountFor(accountId);
      const bad = to.filter((t) => !EMAIL_RX.test(t.trim()));
      if (to.length === 0 || bad.length > 0) {
        throw new Error(
          `draft_message: invalid recipient address(es): ${bad.join(', ') || '(none given)'}`,
        );
      }
      const mode = modeFor(account);
      const row = await deps.store.outbox.create({
        accountId: account.id,
        kind: 'new',
        recipientDisplay: to.join(', '),
        to,
        cc: [],
        subject,
        bodyMarkdown: body,
        createdVia: 'mcp-local',
        expiresAt: expiresAt(),
      });
      return toolResult(row, mode, []);
    },

    async listOutbox({ limit }) {
      await deps.store.outbox.expireOverdue();
      const rows = await deps.store.outbox.listRecent(limit ?? 20);
      const out: OutboxListItem[] = [];
      for (const row of rows) {
        let url: string | null = null;
        if (row.status === 'draft') {
          const account = await deps.store.account(row.accountId);
          if (account) url = await confirmUrl(row.id, modeFor(account));
        }
        out.push({
          draft_id: row.id,
          status: row.status,
          recipient_display: row.recipientDisplay,
          subject: row.subject,
          created_at: row.createdAt,
          error: row.error,
          confirm_url: url,
        });
      }
      return out;
    },

    async peekByToken(token) {
      const secret = await deps.store.outbox.secret();
      const parsed = verifyConfirmToken(secret, token, nowMs());
      if (!parsed) return { kind: 'invalid' };
      await deps.store.outbox.expireOverdue();
      const row = await deps.store.outbox.get(parsed.draftId);
      if (!row) return { kind: 'invalid' };
      if (row.status !== 'draft') return { kind: 'gone', row };
      const account = await deps.store.account(row.accountId);
      if (!account) return { kind: 'invalid' };
      return { kind: 'ok', row, mode: modeFor(account) };
    },

    async confirmByToken() {
      throw new Error('not implemented'); // Task 7
    },

    async cancelByToken() {
      throw new Error('not implemented'); // Task 7
    },
  };
}
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `npx jest src/main/outbound/__tests__/service.test.ts -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/outbound/service.ts src/main/outbound/__tests__/service.test.ts
git commit -m "feat(outbound): outbound service — grounded drafts, confirm modes, signed URLs"
```

---

### Task 6: MCP tools — draft_reply, draft_message, list_outbox

**Files:**
- Create: `src/main/core/mcp/tools/draft-reply.ts`, `src/main/core/mcp/tools/draft-message.ts`, `src/main/core/mcp/tools/list-outbox.ts`
- Modify: `src/main/core/mcp/tools/index.ts`, `src/main/core/mcp/server.ts` (one line), `src/main/mcp/stdio-entry.ts` (no change yet — verify it still compiles with the optional param), `src/main/core/mcp/__tests__/server.test.ts` (`BUILTIN_TOOL_NAMES`), `src/main/core/mcp/instructions.ts` (only if it enumerates tools)
- Test: `src/main/core/mcp/__tests__/outbound-tools.test.ts`

**Interfaces:**
- Consumes: `OutboundToolApi` from `@main/outbound/service` (Task 5).
- Produces: `buildBuiltinTools(query: Query, outbound?: OutboundToolApi): McpTool[]` — three additional tools named exactly `draft_reply`, `draft_message`, `list_outbox`, every one `tier: 'standard'`. When `outbound` is undefined the tools ARE still registered (no cross-transport tool-list drift) but `call` throws: `Outbound drafting is unavailable on this transport right now — the KIAgent app must be running; its HTTP MCP server handles drafts.` (Task 13 replaces the stdio undefined with a live proxy.)

- [ ] **Step 1: Write the failing tests**

Create `src/main/core/mcp/__tests__/outbound-tools.test.ts` (harness mirrors `tools.test.ts`; real store + real service + fake sender):

```ts
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { AccountId, DocumentInput, Prefs, Sender } from '@shared/contracts';

import { openDb } from '../../../db/app-db';
import { openStore, type CoreStore } from '../../store/store';
import { createOutboundService } from '../../../outbound/service';
import { buildBuiltinTools } from '../tools';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};
const logSink = { log: () => {} };
const fakePrefs = {
  get: () => ({}) as ReturnType<Prefs['get']>,
  patch: async () => {},
  onChange: () => () => {},
} as unknown as Prefs;

describe('outbound MCP tools', () => {
  let dir: string;
  let store: CoreStore;
  let accountId: AccountId;
  let docId: string;
  let tools: ReturnType<typeof buildBuiltinTools>;

  const call = (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`no such tool ${name}`);
    return tool.call(args);
  };

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-outtools-'));
    store = openStore(await openDb(path.join(dir, 'test.db')), deps);
    const account = await store.createAccount({
      source: 'imap',
      identifier: 'me@example.com',
    });
    accountId = account.id;
    const doc: DocumentInput = {
      externalId: 'INBOX:1:1',
      type: 'email.message',
      title: 'Hello',
      markdown: 'hi',
      metadata: {
        from: 'Alice <alice@example.com>',
        to: ['me@example.com'],
        mailbox: 'INBOX',
        uid: 1,
        messageId: 'm1@x',
      },
      createdAt: '2026-07-01T00:00:00Z',
    };
    await store.commit({ account: accountId, documents: [doc], cursor: null });
    docId = (await store.read.search({ limit: 1 }))[0].id as string;

    const sender: Sender = { send: async () => ({}) };
    const outbound = createOutboundService({
      store,
      prefs: fakePrefs,
      senders: new Map([['imap', sender]]),
      logSink,
    });
    outbound.setBaseUrl('http://127.0.0.1:7421');
    tools = buildBuiltinTools(store.read, outbound);
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('registers the three outbound tools', () => {
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(['draft_reply', 'draft_message', 'list_outbox']),
    );
  });

  it('draft_reply creates a draft and returns a confirm url', async () => {
    const r = (await call('draft_reply', {
      document_id: docId,
      body: 'Thanks!',
    })) as { draft_id: string; confirm_url: string };
    expect(r.confirm_url).toContain('/outbox/confirm/');
    expect((await store.outbox.get(r.draft_id))?.status).toBe('draft');
  });

  it('draft_message requires valid recipients', async () => {
    await expect(
      call('draft_message', {
        account_id: accountId,
        to: ['nope'],
        subject: 's',
        body: 'b',
      }),
    ).rejects.toThrow(/nope/);
  });

  it('list_outbox lists drafts newest-first', async () => {
    await call('draft_reply', { document_id: docId, body: 'one' });
    const listing = (await call('list_outbox', {})) as Array<{
      status: string;
    }>;
    expect(listing.length).toBe(1);
    expect(listing[0].status).toBe('draft');
  });

  it('tools are registered but unavailable without an outbound service', async () => {
    const cold = buildBuiltinTools(store.read);
    const names = cold.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['draft_reply']));
    const t = cold.find((x) => x.name === 'draft_reply');
    await expect(t!.call({ document_id: docId, body: 'x' })).rejects.toThrow(
      /unavailable on this transport/i,
    );
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/main/core/mcp/__tests__/outbound-tools.test.ts -v`
Expected: FAIL.

- [ ] **Step 3: Implement the three tool modules**

`src/main/core/mcp/tools/draft-reply.ts`:

```ts
/**
 * `draft_reply` — creates a frozen outbox draft replying to a corpus
 * document. Recipients/threading are resolved by the app from stored
 * metadata; the model supplies no address. Nothing is sent here: the result
 * carries the user-confirmation instructions (spec §4).
 */
import type { OutboundToolApi } from '@main/outbound/service';

export const draftReplyDescription = `Create a DRAFT reply to an email document from the corpus (use the document id from search/get results). The app resolves the recipient and threading from the stored document — do not supply addresses. NOTHING IS SENT by this tool: the result includes an instruction and a confirmation link for the user; follow the instruction exactly.`;

export const draftReplyInputSchema = {
  type: 'object',
  properties: {
    document_id: {
      type: 'string',
      description: 'Corpus document id of the message being replied to',
    },
    body: { type: 'string', description: 'Reply body (plain text/markdown)' },
    reply_all: {
      type: 'boolean',
      description:
        'Also address the other stored recipients of the original (default false)',
    },
  },
  required: ['document_id', 'body'],
} as const;

export function makeDraftReplyTool(outbound: OutboundToolApi) {
  return async function draftReply(
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const a = args as {
      document_id?: string;
      body?: string;
      reply_all?: boolean;
    };
    if (!a.document_id) throw new Error('draft_reply: document_id is required');
    if (!a.body) throw new Error('draft_reply: body is required');
    return outbound.draftReply({
      documentId: a.document_id,
      body: a.body,
      replyAll: a.reply_all === true,
    });
  };
}
```

`src/main/core/mcp/tools/draft-message.ts` (same shape):

```ts
import type { OutboundToolApi } from '@main/outbound/service';

export const draftMessageDescription = `Create a DRAFT email to explicit recipients from one of the user's email accounts (account ids come from digital_memory_info). NOTHING IS SENT by this tool: the result includes an instruction and a confirmation link for the user; follow the instruction exactly.`;

export const draftMessageInputSchema = {
  type: 'object',
  properties: {
    account_id: { type: 'string', description: 'Sending account id' },
    to: {
      type: 'array',
      items: { type: 'string' },
      description: 'Recipient email addresses',
    },
    subject: { type: 'string' },
    body: { type: 'string', description: 'Body (plain text/markdown)' },
  },
  required: ['account_id', 'to', 'subject', 'body'],
} as const;

export function makeDraftMessageTool(outbound: OutboundToolApi) {
  return async function draftMessage(
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const a = args as {
      account_id?: string;
      to?: unknown;
      subject?: string;
      body?: string;
    };
    if (!a.account_id) throw new Error('draft_message: account_id is required');
    if (!Array.isArray(a.to) || a.to.length === 0)
      throw new Error('draft_message: to must be a non-empty array');
    if (!a.subject) throw new Error('draft_message: subject is required');
    if (!a.body) throw new Error('draft_message: body is required');
    return outbound.draftMessage({
      accountId: a.account_id,
      to: a.to.map(String),
      subject: a.subject,
      body: a.body,
    });
  };
}
```

`src/main/core/mcp/tools/list-outbox.ts`:

```ts
import type { OutboundToolApi } from '@main/outbound/service';

export const listOutboxDescription = `List recent outbound drafts and their statuses (draft/sending/sent/failed/discarded/expired). Pending drafts include a fresh confirmation link — use this when a confirm link has expired.`;

export const listOutboxInputSchema = {
  type: 'object',
  properties: {
    limit: { type: 'number', description: 'Max rows (default 20)' },
  },
} as const;

export function makeListOutboxTool(outbound: OutboundToolApi) {
  return async function listOutbox(
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const a = args as { limit?: number };
    return outbound.listOutbox({
      limit: typeof a.limit === 'number' ? a.limit : undefined,
    });
  };
}
```

- [ ] **Step 4: Wire into `buildBuiltinTools`**

In `src/main/core/mcp/tools/index.ts`:

```ts
import type { McpTool, Query } from '@shared/contracts';
import type { OutboundToolApi } from '@main/outbound/service';

import {
  draftMessageDescription,
  draftMessageInputSchema,
  makeDraftMessageTool,
} from './draft-message';
import {
  draftReplyDescription,
  draftReplyInputSchema,
  makeDraftReplyTool,
} from './draft-reply';
import {
  listOutboxDescription,
  listOutboxInputSchema,
  makeListOutboxTool,
} from './list-outbox';
// …existing imports unchanged…

/** When no outbound service exists on this transport (a stdio sibling with
 *  no proxy), the tools still register — the tool LIST must not drift
 *  between transports — but every call explains the situation. */
const unavailableOutbound: OutboundToolApi = {
  draftReply: unavailable,
  draftMessage: unavailable,
  listOutbox: unavailable,
};
async function unavailable(): Promise<never> {
  throw new Error(
    'Outbound drafting is unavailable on this transport right now — the ' +
      'KIAgent app must be running; its HTTP MCP server handles drafts.',
  );
}

export function buildBuiltinTools(
  query: Query,
  outbound?: OutboundToolApi,
): McpTool[] {
  const out = outbound ?? unavailableOutbound;
  const digitalMemoryInfo = makeDigitalMemoryInfoTool(query);
  return [
    // …the existing five entries stay byte-identical…
    {
      name: 'draft_reply',
      description: draftReplyDescription,
      inputSchema: draftReplyInputSchema,
      tier: 'standard',
      call: makeDraftReplyTool(out),
    },
    {
      name: 'draft_message',
      description: draftMessageDescription,
      inputSchema: draftMessageInputSchema,
      tier: 'standard',
      call: makeDraftMessageTool(out),
    },
    {
      name: 'list_outbox',
      description: listOutboxDescription,
      inputSchema: listOutboxInputSchema,
      tier: 'standard',
      call: makeListOutboxTool(out),
    },
  ];
}
```

In `src/main/core/mcp/server.ts` change nothing yet except the call site compiles unchanged (`buildBuiltinTools(deps.query)` — second param optional). Task 8 threads the real service through.

- [ ] **Step 5: Update the drifted assertions**

- `src/main/core/mcp/__tests__/server.test.ts`: find `BUILTIN_TOOL_NAMES` (~line 79) and add `'draft_message'`, `'draft_reply'`, `'list_outbox'` keeping the array's existing order convention (alphabetical — verify and match).
- `grep -n "tool" src/main/core/mcp/instructions.ts` — if the server instructions enumerate tool names, add one sentence: `Outbound: draft_reply / draft_message create user-confirmed drafts (nothing sends without the user's confirmation); list_outbox shows drafts and re-issues confirm links.` If it doesn't enumerate tools, leave it untouched.
- Run `npx jest src/main/core/mcp -v`; fix any other tool-count/name assertions the run surfaces (there are several suites in that directory — the failures name themselves).

- [ ] **Step 6: Run tests, expect PASS**

Run: `npx jest src/main/core/mcp -v`
Expected: PASS (new file + all existing mcp suites).

- [ ] **Step 7: Commit**

```bash
git add src/main/core/mcp/tools/ src/main/core/mcp/__tests__/ src/main/core/mcp/instructions.ts
git commit -m "feat(outbound): draft_reply/draft_message/list_outbox MCP tools on the shared builder"
```

---

### Task 7: Confirm/cancel/send pipeline in the service

**Files:**
- Modify: `src/main/outbound/service.ts` (replace the two stubs)
- Test: `src/main/outbound/__tests__/service.test.ts` (extend)

**Interfaces:**
- Consumes: Task 2 `transition`, Task 5 `peekByToken` internals, `Sender.send`.
- Produces: working `confirmByToken(token): Promise<ConfirmOutcome>` and `cancelByToken(token): Promise<ConfirmOutcome>` (shapes from Task 5's Interfaces block) — used by the HTTP routes (Task 8).

Behavior contract:
- `confirmByToken`: verify → row → must be `draft` (else `already` with the row; missing/bad token → `invalid`). Atomically `transition(id, ['draft'], 'sending')`; a `false` result → `already` (link raced). Look up account + sender (sender missing at THIS point → transition to `failed` with the error, return `failed`). Build `SendIntent` from the row (`accountId, kind, outboundRef ?? undefined, to, cc, subject ?? undefined, bodyMarkdown, threading ?? undefined`). `await sender.send(intent)`; success → `transition(['sending'], 'sent', { sentAt: nowIso, externalMessageId: result.externalMessageId ?? null })` → `sent`; thrown error → `transition(['sending'], 'failed', { error: message })` → `failed`. Log one line via `logSink.log('outbound', 'info'|'error', …)` on each terminal transition.
- `cancelByToken`: verify → row → `transition(['draft'], 'discarded')`; `true` → `cancelled`, `false` with existing row → `already`, no row/bad token → `invalid`.

- [ ] **Step 1: Write the failing tests**

Append to `src/main/outbound/__tests__/service.test.ts` inside the top-level describe (reuses `service`, `store`, `docId` from `beforeEach` — move the fake sender into a `let sendMock: jest.Mock` initialized in `beforeEach` as `sendMock = jest.fn(async () => ({ externalMessageId: '<sent@x>' }))` with `senders: new Map([['imap', { send: sendMock }]])`):

```ts
  const tokenOf = (r: { confirm_url: string }) =>
    r.confirm_url.split('/outbox/confirm/')[1];

  it('confirmByToken sends and records the external id', async () => {
    const r = await service.draftReply({ documentId: docId, body: 'Yo' });
    const out = await service.confirmByToken(tokenOf(r));
    expect(out.kind).toBe('sent');
    expect(sendMock).toHaveBeenCalledTimes(1);
    const intent = sendMock.mock.calls[0][0];
    expect(intent.to).toEqual(['Alice <alice@example.com>']);
    expect(intent.threading).toEqual({
      inReplyTo: '<orig@x>',
      references: ['<orig@x>'],
    });
    const row = await store.outbox.get(r.draft_id);
    expect(row?.status).toBe('sent');
    expect(row?.externalMessageId).toBe('<sent@x>');
    expect(row?.sentAt).toBeTruthy();
  });

  it('a confirm link is single-use', async () => {
    const r = await service.draftReply({ documentId: docId, body: 'Yo' });
    await service.confirmByToken(tokenOf(r));
    const second = await service.confirmByToken(tokenOf(r));
    expect(second.kind).toBe('already');
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('a sender failure lands in failed with the error recorded', async () => {
    sendMock.mockRejectedValueOnce(new Error('SMTP 535 auth failed'));
    const r = await service.draftReply({ documentId: docId, body: 'Yo' });
    const out = await service.confirmByToken(tokenOf(r));
    expect(out.kind).toBe('failed');
    const row = await store.outbox.get(r.draft_id);
    expect(row?.status).toBe('failed');
    expect(row?.error).toMatch(/535/);
  });

  it('cancelByToken discards without sending', async () => {
    const r = await service.draftReply({ documentId: docId, body: 'Yo' });
    const out = await service.cancelByToken(tokenOf(r));
    expect(out.kind).toBe('cancelled');
    expect(sendMock).not.toHaveBeenCalled();
    expect((await store.outbox.get(r.draft_id))?.status).toBe('discarded');
  });

  it('garbage tokens are invalid for both operations', async () => {
    expect((await service.confirmByToken('nope')).kind).toBe('invalid');
    expect((await service.cancelByToken('nope')).kind).toBe('invalid');
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/main/outbound/__tests__/service.test.ts -v`
Expected: FAIL — `not implemented`.

- [ ] **Step 3: Implement the pipeline** (replace both stubs in `service.ts` per the behavior contract above).

- [ ] **Step 4: Run tests, expect PASS**

Run: `npx jest src/main/outbound/__tests__/service.test.ts -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/outbound/service.ts src/main/outbound/__tests__/service.test.ts
git commit -m "feat(outbound): confirm/cancel send pipeline — atomic single-use transitions"
```

---

### Task 8: Confirm pages + loopback routes

**Files:**
- Create: `src/main/outbound/pages.ts`, `src/main/outbound/routes.ts`
- Modify: `src/main/core/mcp/server.ts` (deps + dispatch + baseUrl + registry line)
- Test: `src/main/core/mcp/__tests__/outbound-routes.test.ts`

**Interfaces:**
- Consumes: `OutboundService` (Tasks 5+7), `renderShell`/`esc` from `@shared/web-ui` + `loadShellCss` from `@shared/web-ui/loader-node` (jsdom-unsafe fs reads — routes run in main/node only).
- Produces:

```ts
// pages.ts — pure HTML string builders (variant 'minimal'):
export function reviewPage(row: OutboxRow, p: { confirmPath: string; cancelPath: string }): string; // full draft: recipient (prominent), subject, body (escaped, pre-wrap), POST Confirm + POST Cancel forms
export function linkPage(row: OutboxRow, p: { confirmPath: string }): string;   // recipient line + single POST Send button
export function resultPage(title: string, message: string): string;

// routes.ts:
export function createOutboundRoutes(outbound: OutboundService): {
  /** true = handled; false = not an /outbox path this module owns. */
  handle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean>;
};
```

- `McpDeps` (server.ts) gains `outbound?: OutboundService;`. `startMcp` builds `const outboundRoutes = deps.outbound ? createOutboundRoutes(deps.outbound) : null;`, registry line becomes `buildBuiltinTools(deps.query, deps.outbound)`, and after `listenOnFirstFree` resolves: `deps.outbound?.setBaseUrl(\`http://${HOST}:${port}\`);`.
- Route table (all under the existing `checkLoopbackRequest` guard — Host/Origin hygiene comes free):
  - `GET /outbox/confirm/<token>` → `peekByToken`: `ok`+`review` → `reviewPage`; `ok`+`link` → `linkPage`; `gone` → `resultPage` describing the terminal status (`sent` → "Already sent", `discarded` → "Cancelled", `failed` → "Send failed" + row.error, `expired` → "Draft expired"); `invalid` → 404 `resultPage('Link invalid or expired', …)` telling the user to ask the assistant for a fresh link (list_outbox).
  - `POST /outbox/confirm/<token>` → `confirmByToken` → `resultPage` per outcome (`sent` → "Message sent" + recipient; `failed` → error text + "the draft is kept — ask the assistant to list_outbox"; `already`/`invalid` as above).
  - `POST /outbox/cancel/<token>` → `cancelByToken` → `resultPage`.
  - `POST /outbox/api` → JSON `{ op: 'ping' } → { ok: true, result: { pong: 'kiagent-outbox' } }`; `{ op: 'draftReply' | 'draftMessage' | 'listOutbox', args } → { ok: true, result } | { ok: false, error: string }` (HTTP 200 always; this is the stdio proxy's seam — Task 13).
  - Anything else under `/outbox/` → `false` (server 404s).
- Form buttons post to `p.confirmPath`/`p.cancelPath` (`/outbox/confirm/<token>`, `/outbox/cancel/<token>`) — token stays in the path, never in query params.
- In `server.ts`'s `handler`, insert after the `/healthz` branch and the `url` parse, before the `!== '/mcp'` 404:

```ts
      if (url.pathname.startsWith('/outbox/')) {
        if (outboundRoutes && (await outboundRoutes.handle(req, res, url))) {
          return;
        }
        res.writeHead(404);
        res.end();
        return;
      }
```

- [ ] **Step 1: Write the failing route tests**

Create `src/main/core/mcp/__tests__/outbound-routes.test.ts` — `@jest-environment node` docblock like `server.test.ts`; one `startMcp` for the file over a REAL store (temp dir) + real service + `jest.fn` sender; `fetch` drives it:

```ts
/**
 * @jest-environment node
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { AccountId, DocumentInput, Prefs, Sender } from '@shared/contracts';

import { openDb } from '../../../db/app-db';
import { openStore, type CoreStore } from '../../store/store';
import { createOutboundService, type OutboundService } from '../../../outbound/service';
import { startMcp, type McpServerHandle } from '../server';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};
const logSink = { log: () => {} };
const fakePrefs = {
  get: () => ({}),
  patch: async () => {},
  onChange: () => () => {},
} as unknown as Prefs;

let dir: string;
let store: CoreStore;
let accountId: AccountId;
let docId: string;
let service: OutboundService;
let mcp: McpServerHandle;
let sendMock: jest.Mock;
let base: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-outroutes-'));
  store = openStore(await openDb(path.join(dir, 'test.db')), deps);
  const account = await store.createAccount({
    source: 'imap',
    identifier: 'me@example.com',
  });
  accountId = account.id;
  const doc: DocumentInput = {
    externalId: 'INBOX:1:1',
    type: 'email.message',
    title: 'Hello',
    markdown: 'hi',
    metadata: {
      from: 'Alice <alice@example.com>',
      to: ['me@example.com'],
      mailbox: 'INBOX',
      uid: 1,
      messageId: 'm1@x',
    },
    createdAt: '2026-07-01T00:00:00Z',
  };
  await store.commit({ account: accountId, documents: [doc], cursor: null });
  docId = (await store.read.search({ limit: 1 }))[0].id as string;

  sendMock = jest.fn(async () => ({ externalMessageId: '<sent@x>' }));
  service = createOutboundService({
    store,
    prefs: fakePrefs,
    senders: new Map([['imap', { send: sendMock } as Sender]]),
    logSink,
  });
  mcp = await startMcp({
    query: store.read,
    logSink,
    dataDir: dir,
    outbound: service,
  });
  base = `http://127.0.0.1:${mcp.port}`;
});

afterAll(async () => {
  await mcp.stop();
  await store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const draftUrl = async () => {
  const r = await service.draftReply({ documentId: docId, body: 'Yo' });
  return r.confirm_url;
};

describe('outbox confirm routes', () => {
  it('startMcp injected the base url into the service', async () => {
    expect(await draftUrl()).toContain(base);
  });

  it('GET renders the review page and does NOT send', async () => {
    const url = await draftUrl();
    const res = await fetch(url);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Alice');
    expect(html).toContain('Yo');
    expect(html).toContain('method="POST"');
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('POST confirm sends exactly once; the link then dies', async () => {
    const url = await draftUrl();
    const res = await fetch(url, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/sent/i);
    expect(sendMock).toHaveBeenCalledTimes(1);
    sendMock.mockClear();
    const again = await fetch(url, { method: 'POST' });
    expect(await again.text()).toMatch(/already/i);
    expect(sendMock).not.toHaveBeenCalled();
    const getAfter = await fetch(url);
    expect(await getAfter.text()).toMatch(/already|sent/i);
  });

  it('POST cancel discards without sending', async () => {
    const url = await draftUrl();
    const cancel = url.replace('/outbox/confirm/', '/outbox/cancel/');
    const res = await fetch(cancel, { method: 'POST' });
    expect(await res.text()).toMatch(/cancel/i);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('link mode serves the minimal page', async () => {
    await store.setAccountConfig(accountId, { outbound: { mode: 'link' } });
    const url = await draftUrl();
    const html = await (await fetch(url)).text();
    expect(html).toContain('Alice');
    expect(html).not.toContain('Yo'); // minimal page: recipient + button only
    expect(html).toContain('method="POST"');
    await store.setAccountConfig(accountId, {});
  });

  it('a bad token 404s', async () => {
    const res = await fetch(`${base}/outbox/confirm/garbage`);
    expect(res.status).toBe(404);
  });

  it('/outbox/api answers ping', async () => {
    const res = await fetch(`${base}/outbox/api`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 'ping' }),
    });
    expect(await res.json()).toEqual({
      ok: true,
      result: { pong: 'kiagent-outbox' },
    });
  });

  it('/outbox/api proxies draftReply', async () => {
    const res = await fetch(`${base}/outbox/api`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        op: 'draftReply',
        args: { documentId: docId, body: 'via api' },
      }),
    });
    const body = (await res.json()) as {
      ok: boolean;
      result: { confirm_url: string };
    };
    expect(body.ok).toBe(true);
    expect(body.result.confirm_url).toContain('/outbox/confirm/');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/main/core/mcp/__tests__/outbound-routes.test.ts -v`
Expected: FAIL (`McpDeps` has no `outbound`, routes 404).

- [ ] **Step 3: Implement `pages.ts`**

```ts
/**
 * Outbox confirm-surface HTML (spec §5) — variant 'minimal' pages rendered
 * from the FROZEN outbox row: what the user reviews here is exactly what the
 * app will send, no matter what a prompt-injected session claimed in chat.
 * The recipient line is the load-bearing element on every page.
 */
import { esc, renderShell } from '@shared/web-ui';
import { loadShellCss } from '@shared/web-ui/loader-node';
import type { OutboxRow } from '@shared/contracts';

const css = () => loadShellCss('minimal');

function recipientBlock(row: OutboxRow): string {
  const cc = row.cc.length
    ? `<div class="t-meta">Cc: ${esc(row.cc.join(', '))}</div>`
    : '';
  return `<div style="margin-bottom:12px">
    <div class="t-meta">To</div>
    <div style="font-size:16px;font-weight:600">${esc(row.recipientDisplay)}</div>
    ${row.to.length > 1 ? `<div class="t-meta">${esc(row.to.join(', '))}</div>` : ''}
    ${cc}
  </div>`;
}

export function reviewPage(
  row: OutboxRow,
  p: { confirmPath: string; cancelPath: string },
): string {
  const body = `
  ${recipientBlock(row)}
  ${row.subject ? `<div style="font-weight:600;margin-bottom:8px">${esc(row.subject)}</div>` : ''}
  <pre style="white-space:pre-wrap;font-family:inherit;border:1px solid rgba(127,127,127,.3);border-radius:6px;padding:12px;max-height:50vh;overflow:auto">${esc(row.bodyMarkdown)}</pre>
  <div style="display:flex;gap:8px;margin-top:16px">
    <form method="POST" action="${esc(p.confirmPath)}"><button type="submit" class="btn">Confirm &amp; send</button></form>
    <form method="POST" action="${esc(p.cancelPath)}"><button type="submit" class="btn sm">Cancel</button></form>
  </div>`;
  return renderShell(css(), { title: 'Review and send', variant: 'minimal', body });
}

export function linkPage(row: OutboxRow, p: { confirmPath: string }): string {
  const body = `
  ${recipientBlock(row)}
  <form method="POST" action="${esc(p.confirmPath)}">
    <button type="submit" class="btn">Send</button>
  </form>`;
  return renderShell(css(), { title: 'Send message?', variant: 'minimal', body });
}

export function resultPage(title: string, message: string): string {
  return renderShell(css(), {
    title,
    variant: 'minimal',
    body: `<p>${esc(message)}</p>`,
  });
}
```

- [ ] **Step 4: Implement `routes.ts`**

```ts
/**
 * /outbox/* routes for the loopback MCP HTTP server. GET only renders; every
 * mutation is a POST carrying the signed token in its PATH (spec §5:
 * unfurlers/prefetchers GET links the moment they render — GET must never
 * send). The server's checkLoopbackRequest guard has already vetted
 * Host/Origin before this module runs.
 */
import type http from 'http';

import type { OutboxRow } from '@shared/contracts';

import { linkPage, resultPage, reviewPage } from './pages';
import type { OutboundService } from './service';

function sendHtml(res: http.ServerResponse, status: number, html: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function sendJson(res: http.ServerResponse, body: unknown): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : null);
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function gonePage(row: OutboxRow): string {
  if (row.status === 'sent')
    return resultPage('Already sent', `This message to ${row.recipientDisplay} was already sent.`);
  if (row.status === 'discarded')
    return resultPage('Cancelled', 'This draft was cancelled.');
  if (row.status === 'failed')
    return resultPage(
      'Send failed',
      `${row.error ?? 'Unknown error'} — the draft is kept; ask your assistant to run list_outbox for a fresh link.`,
    );
  if (row.status === 'expired')
    return resultPage('Draft expired', 'Ask your assistant to create the draft again.');
  return resultPage('In progress', 'This draft is being sent.');
}

const INVALID = resultPage(
  'Link invalid or expired',
  'Ask your assistant to run list_outbox for a fresh confirmation link.',
);

export function createOutboundRoutes(outbound: OutboundService): {
  handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
  ): Promise<boolean>;
} {
  return {
    async handle(req, res, url) {
      const confirm = /^\/outbox\/confirm\/([^/]+)$/.exec(url.pathname);
      const cancel = /^\/outbox\/cancel\/([^/]+)$/.exec(url.pathname);

      if (confirm && req.method === 'GET') {
        const peek = await outbound.peekByToken(confirm[1]);
        if (peek.kind === 'invalid') sendHtml(res, 404, INVALID);
        else if (peek.kind === 'gone') sendHtml(res, 200, gonePage(peek.row));
        else {
          const confirmPath = `/outbox/confirm/${confirm[1]}`;
          const cancelPath = `/outbox/cancel/${confirm[1]}`;
          sendHtml(
            res,
            200,
            peek.mode === 'review'
              ? reviewPage(peek.row, { confirmPath, cancelPath })
              : linkPage(peek.row, { confirmPath }),
          );
        }
        return true;
      }

      if (confirm && req.method === 'POST') {
        const out = await outbound.confirmByToken(confirm[1]);
        if (out.kind === 'invalid') sendHtml(res, 404, INVALID);
        else if (out.kind === 'sent')
          sendHtml(
            res,
            200,
            resultPage('Message sent', `Sent to ${out.row.recipientDisplay}.`),
          );
        else if (out.kind === 'failed')
          sendHtml(res, 200, gonePage(out.row));
        else sendHtml(res, 200, gonePage(out.row));
        return true;
      }

      if (cancel && req.method === 'POST') {
        const out = await outbound.cancelByToken(cancel[1]);
        if (out.kind === 'invalid') sendHtml(res, 404, INVALID);
        else if (out.kind === 'cancelled')
          sendHtml(res, 200, resultPage('Cancelled', 'This draft was cancelled.'));
        else sendHtml(res, 200, gonePage(out.row));
        return true;
      }

      if (url.pathname === '/outbox/api' && req.method === 'POST') {
        try {
          const body = (await readJsonBody(req)) as {
            op?: string;
            args?: Record<string, unknown>;
          } | null;
          if (body?.op === 'ping') {
            sendJson(res, { ok: true, result: { pong: 'kiagent-outbox' } });
          } else if (body?.op === 'draftReply') {
            sendJson(res, {
              ok: true,
              result: await outbound.draftReply(
                body.args as Parameters<OutboundService['draftReply']>[0],
              ),
            });
          } else if (body?.op === 'draftMessage') {
            sendJson(res, {
              ok: true,
              result: await outbound.draftMessage(
                body.args as Parameters<OutboundService['draftMessage']>[0],
              ),
            });
          } else if (body?.op === 'listOutbox') {
            sendJson(res, {
              ok: true,
              result: await outbound.listOutbox(
                (body.args ?? {}) as Parameters<OutboundService['listOutbox']>[0],
              ),
            });
          } else {
            sendJson(res, { ok: false, error: `unknown op '${body?.op}'` });
          }
        } catch (err) {
          sendJson(res, {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return true;
      }

      return false;
    },
  };
}
```

- [ ] **Step 5: Wire `server.ts`**

Per the Interfaces block: add `outbound?: OutboundService;` to `McpDeps` (import type from `@main/outbound/service`; import `createOutboundRoutes` from `@main/outbound/routes`); in `startMcp` build `outboundRoutes`, change the registry line to `buildBuiltinTools(deps.query, deps.outbound)`, insert the dispatch branch (code in Interfaces above) after the `url` parse, and after `const port = await listenOnFirstFree(...)` add:

```ts
  deps.outbound?.setBaseUrl(`http://${HOST}:${port}`);
```

- [ ] **Step 6: Run tests, expect PASS**

Run: `npx jest src/main/core/mcp/__tests__/outbound-routes.test.ts -v`
Expected: PASS.
Run: `npx jest src/main/core/mcp -v` — Expected: PASS (server.test.ts unaffected — `outbound` is optional).

- [ ] **Step 7: Commit**

```bash
git add src/main/outbound/pages.ts src/main/outbound/routes.ts src/main/core/mcp/server.ts src/main/core/mcp/__tests__/outbound-routes.test.ts
git commit -m "feat(outbound): loopback confirm pages + routes — GET renders, POST sends, single-use"
```

---

### Task 9: Prefs default mode + Settings/Sources UI

**Files:**
- Modify: `src/shared/contracts.ts` (`AppPrefs`), `src/main/core/prefs.ts`, `src/renderer/screens/Settings/Advanced.tsx`, `src/renderer/screens/Sources/SourceDetail.tsx`
- Create: `src/renderer/screens/Sources/sections/Outbound.tsx`
- Test: `src/main/core/__tests__/prefs.test.ts` (extend)

**Interfaces:**
- Consumes: `ConfirmMode` (Task 1), existing IPC channels `prefs:patch` and `accounts:update-config` — NO new IPC channels (that matters product-side: nothing to add to the overlay's `REMOTE_INVOKE_CHANNELS`). The service keeps its optional-access read of `prefs.get().outbound` (partial Prefs fakes in tests have no `outbound` slice) — this task does NOT change `service.ts`.
- Produces: `AppPrefs.outbound: { defaultMode: ConfirmMode }` (default `{ defaultMode: 'review' }`), account config convention `config.outbound = { mode?: 'review' | 'link', smtp?: { host?: string; port?: number; secure?: boolean } }` consumed by Tasks 5 (mode) and 11 (smtp).

- [ ] **Step 1: Write the failing prefs tests**

In `src/main/core/__tests__/prefs.test.ts` add:

```ts
  it('defaults outbound.defaultMode to review and sanitizes junk', async () => {
    const prefs = createPrefs(dir);
    expect(prefs.get().outbound).toEqual({ defaultMode: 'review' });
    await prefs.patch({
      outbound: { defaultMode: 'bogus' as unknown as 'review' },
    });
    expect(prefs.get().outbound.defaultMode).toBe('review');
    await prefs.patch({ outbound: { defaultMode: 'link' } });
    expect(prefs.get().outbound.defaultMode).toBe('link');
  });
```

(Match the file's existing `dir`/`createPrefs` harness — read it first and mirror its beforeEach.)

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/main/core/__tests__/prefs.test.ts -v`
Expected: FAIL — `outbound` undefined.

- [ ] **Step 3: Implement prefs + contracts**

- `src/shared/contracts.ts`, in `AppPrefs` (line ~710), add after `models`:
```ts
  /** Outbound confirmation default; per-account override lives in
   *  Account.config.outbound.mode. 'review' = full review page (default);
   *  'link' = in-chat review + one-click signed link. */
  outbound: { defaultMode: ConfirmMode };
```
- `src/main/core/prefs.ts`: `DEFAULT_PREFS` gains `outbound: { defaultMode: 'review' }`; `sanitize` gains
```ts
    outbound: {
      defaultMode: r.outbound?.defaultMode === 'link' ? 'link' : 'review',
    },
```
  and `patch`'s deep-merge list gains `outbound: { ...current.outbound, ...(p.outbound ?? {}) },`.
- `src/main/outbound/service.ts` stays untouched — its optional access (`p.outbound?.defaultMode ?? 'review'`) now simply reads the typed slice.

- [ ] **Step 4: Run prefs + outbound tests, expect PASS**

Run: `npx jest src/main/core/__tests__/prefs.test.ts src/main/outbound -v`
Expected: PASS.

- [ ] **Step 5: Renderer — global default select in Advanced pane**

In `src/renderer/screens/Settings/Advanced.tsx`, after the `pref-list` div (line ~102), add a new section:

```tsx
        <div className="lbl-section">Outbound</div>
        <div className="field-row">
          {/* eslint-disable-next-line jsx-a11y/label-has-associated-control */}
          <label htmlFor="adv-outbound-mode" className="lbl">
            Send confirmation
          </label>
          <select
            id="adv-outbound-mode"
            className="cadence-select"
            value={prefs.outbound.defaultMode}
            onChange={(e) =>
              patch({
                outbound: {
                  defaultMode: e.target.value as AppPrefs['outbound']['defaultMode'],
                },
              })
            }
          >
            <option value="review">Review page (recommended)</option>
            <option value="link">One-click confirm link</option>
          </select>
        </div>
```

- [ ] **Step 6: Renderer — per-account section**

Create `src/renderer/screens/Sources/sections/Outbound.tsx`:

```tsx
import React from 'react';
import type { Account, ConfirmMode } from '@shared/contracts';

/**
 * Per-account outbound settings: confirmation-mode override + SMTP overrides
 * (host/port derived from the IMAP host by default — only unusual providers
 * need these). Rides the existing accounts:update-config channel.
 */
export function Outbound(props: { account: Account }): React.ReactElement {
  const { account } = props;
  const cfg = (account.config.outbound ?? {}) as {
    mode?: ConfirmMode;
    smtp?: { host?: string; port?: number };
  };

  const update = (outbound: Record<string, unknown>) => {
    void window.kiagent.invoke('accounts:update-config', {
      accountId: account.id,
      config: { ...account.config, outbound },
    });
  };

  return (
    <section>
      <div className="lbl-section">Outbound</div>
      <div className="field-row">
        {/* eslint-disable-next-line jsx-a11y/label-has-associated-control */}
        <label htmlFor="outbound-mode" className="lbl">
          Send confirmation
        </label>
        <select
          id="outbound-mode"
          className="cadence-select"
          value={cfg.mode ?? ''}
          onChange={(e) =>
            update({
              ...cfg,
              mode: e.target.value === '' ? undefined : (e.target.value as ConfirmMode),
            })
          }
        >
          <option value="">App default</option>
          <option value="review">Review page</option>
          <option value="link">One-click confirm link</option>
        </select>
      </div>
      <div className="field-row">
        {/* eslint-disable-next-line jsx-a11y/label-has-associated-control */}
        <label htmlFor="outbound-smtp-host" className="lbl">
          SMTP host (optional)
        </label>
        <input
          id="outbound-smtp-host"
          className="input"
          placeholder="derived from IMAP host"
          defaultValue={cfg.smtp?.host ?? ''}
          onBlur={(e) =>
            update({
              ...cfg,
              smtp: { ...cfg.smtp, host: e.target.value || undefined },
            })
          }
        />
      </div>
      <div className="field-row">
        {/* eslint-disable-next-line jsx-a11y/label-has-associated-control */}
        <label htmlFor="outbound-smtp-port" className="lbl">
          SMTP port (optional)
        </label>
        <input
          id="outbound-smtp-port"
          className="input"
          placeholder="465"
          defaultValue={cfg.smtp?.port ?? ''}
          onBlur={(e) =>
            update({
              ...cfg,
              smtp: {
                ...cfg.smtp,
                port: e.target.value ? Number(e.target.value) : undefined,
              },
            })
          }
        />
      </div>
    </section>
  );
}
```

In `src/renderer/screens/Sources/SourceDetail.tsx`: `import { Outbound } from './sections/Outbound';` and after `<ConnectorConfig account={a} />` (line ~101) add:

```tsx
        {a.source === 'imap' && <Outbound account={a} />}
```

Check the class names used above (`input`, `field-row`, `lbl`, `cadence-select`) against `ConnectorConfig.tsx`/`Cadence.tsx` — reuse whatever those sections actually use for text inputs and selects; do not invent new CSS.

- [ ] **Step 7: Gates**

Run: `npx jest src/main/core/__tests__/prefs.test.ts -v` — Expected: PASS.
Run: `npm run typecheck` — Expected: clean (renderer TSX included).
Run: `npm run lint` — Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/shared/contracts.ts src/main/core/prefs.ts src/main/core/__tests__/prefs.test.ts src/renderer/screens/Settings/Advanced.tsx src/renderer/screens/Sources/sections/Outbound.tsx src/renderer/screens/Sources/SourceDetail.tsx
git commit -m "feat(outbound): confirmation-mode settings — global default + per-account override and SMTP overrides"
```

---

### Task 10: `ImapClient.append`

**Files:**
- Modify: `src/main/sources/imap/types.ts` (interface), `src/main/sources/imap/client.ts` (implementation), plus every fake implementing `ImapClient` in tests (`grep -rn "fetchMany" src/main/sources/imap/__tests__ src/main/__tests__ 2>/dev/null` and add an `append` stub to each fake the compiler flags)
- Test: whichever existing file tests `client.ts`/the source with fakes — extend it; if none tests the client wrapper directly, add the assertion to `src/main/outbound/senders/__tests__/smtp.test.ts` in Task 11 instead and only do the compile-level change here.

**Interfaces:**
- Produces: on `ImapClient` (types.ts:54-62):

```ts
  /** APPEND a raw RFC822 message to a mailbox (Sent-copy after SMTP send). */
  append(path: string, content: Buffer, flags?: string[]): Promise<void>;
```

- [ ] **Step 1: Add the method to the interface** (`types.ts`, inside `ImapClient` after `fetchMany`), with the doc comment above.

- [ ] **Step 2: Compile to find every fake**

Run: `npm run typecheck`
Expected: errors listing each object literal implementing `ImapClient` without `append` — fix each fake with `append: async () => {}` (or a jest.fn where the test wants to assert).

- [ ] **Step 3: Implement in `client.ts`** (inside the object returned by `connectImapClient`, after `fetchMany`):

```ts
    async append(
      path: string,
      content: Buffer,
      flags?: string[],
    ): Promise<void> {
      await flow.append(path, content, flags ?? ['\\Seen']);
    },
```

- [ ] **Step 4: Gates**

Run: `npm run typecheck` — Expected: clean.
Run: `npx jest src/main/sources/imap -v` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/sources/imap
git commit -m "feat(outbound): ImapClient.append — Sent-mailbox APPEND for the SMTP pipeline"
```

---

### Task 11: SMTP sender

**Files:**
- Modify: `release/app/package.json` (add `"nodemailer": "^6.10.1"` to dependencies, keep alphabetical order), root `package.json` (add `"@types/nodemailer": "^6.4.17"` to devDependencies)
- Create: `src/main/outbound/senders/smtp.ts`
- Test: `src/main/outbound/senders/__tests__/smtp.test.ts`

**Interfaces:**
- Consumes: `CoreStore` (`account(id)`, `vault.load`), `SendIntent`/`SendResult`/`Sender` (Task 1), `ImapAccountConfig` (`@main/sources/imap/types`), `connectImapClient` (`@main/sources/imap/client`), `resolveMailboxes` (`@main/sources/imap/folders`).
- Produces (used by Task 12):

```ts
/** override wins field-by-field; else host 'imap.x.y' → 'smtp.x.y' (other
 *  shapes pass through unchanged), port 465, secure true. */
export function deriveSmtpConfig(
  imap: ImapAccountConfig,
  override?: { host?: string; port?: number; secure?: boolean },
): { host: string; port: number; secure: boolean };

export function createSmtpSender(deps: {
  store: CoreStore;
  /** Test seams — default to the real nodemailer/imapflow paths. */
  createTransport?: (opts: SMTPTransportOptions) => {
    sendMail(mail: {
      envelope: { from: string; to: string[] };
      raw: Buffer;
    }): Promise<unknown>;
  };
  connectImap?: typeof connectImapClient;
}): Sender;
```

Send algorithm (encode in tests):
1. `account = store.account(intent.accountId)` (missing → throw); `creds = store.vault.load(...)`; missing password → throw `smtp: no password stored for account …`.
2. `imapCfg = account.config as unknown as ImapAccountConfig`; `smtpCfg = deriveSmtpConfig(imapCfg, (account.config.outbound as …)?.smtp)`.
3. Compose ONE RFC822 buffer with `MailComposer` (`import MailComposer from 'nodemailer/lib/mail-composer';`): `{ from: account.identifier, to: intent.to, cc: intent.cc?.length ? intent.cc : undefined, subject: intent.subject, text: intent.bodyMarkdown, inReplyTo: intent.threading?.inReplyTo as string | undefined, references: intent.threading?.references as string[] | undefined }`; `const node = mail.compile(); const messageId = node.messageId(); const raw = await node.build();`
4. `transport = createTransport({ host, port, secure, auth: { user: imapCfg.user, pass } })`; `await transport.sendMail({ envelope: { from: addr(account.identifier), to: [...to, ...cc].map(addr) }, raw })` where `addr` strips a display name.
5. Sent-append (best-effort): `client = await connectImap(imapCfg, pass)`; `resolveMailboxes(await client.listFolders())` → the `role === 'sent'` entry; found → `client.append(sent.path, raw)`; always `client.close()`. Append/connect failure must NOT fail the send (the message already left) — log-swallow with a `console.error`-free pattern: accept an optional `log?: (msg: string) => void` dep, default no-op.
6. Return `{ externalMessageId: messageId }`.

- [ ] **Step 1: Install deps**

```bash
cd /Users/edjafarov/work/kiagent-core
npm install --save-dev @types/nodemailer@^6.4.17
cd release/app && npm install nodemailer@^6.10.1 && cd ../..
```

Verify: `node -e "require('/Users/edjafarov/work/kiagent-core/release/app/node_modules/nodemailer/package.json')"` prints nothing (exit 0).
NOTE: if `release/app`'s postinstall (`electron-rebuild`) fails in this environment, fall back to editing `release/app/package.json` by hand and running `npm install --ignore-scripts` there — the rebuild only matters for packaging, not jest.

- [ ] **Step 2: Write the failing tests**

Create `src/main/outbound/senders/__tests__/smtp.test.ts`:

```ts
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { AccountId } from '@shared/contracts';

import { openDb } from '../../../db/app-db';
import { openStore, type CoreStore } from '../../../core/store/store';
import { createSmtpSender, deriveSmtpConfig } from '../smtp';

const deps = {
  encrypt: (s: string) => Buffer.from(s, 'utf8'),
  decrypt: (b: Buffer) => b.toString('utf8'),
  detectLanguages: () => ['eng'],
};

describe('deriveSmtpConfig', () => {
  const imap = { host: 'imap.fastmail.com', port: 993, secure: true, user: 'u' };
  it('maps the imap. prefix to smtp. with submission defaults', () => {
    expect(deriveSmtpConfig(imap)).toEqual({
      host: 'smtp.fastmail.com',
      port: 465,
      secure: true,
    });
  });
  it('passes non-imap-prefixed hosts through', () => {
    expect(deriveSmtpConfig({ ...imap, host: 'mail.example.org' }).host).toBe(
      'mail.example.org',
    );
  });
  it('overrides win field-by-field', () => {
    expect(
      deriveSmtpConfig(imap, { host: 'send.fastmail.com', port: 587, secure: false }),
    ).toEqual({ host: 'send.fastmail.com', port: 587, secure: false });
  });
});

describe('smtp sender', () => {
  let dir: string;
  let store: CoreStore;
  let accountId: AccountId;
  let sendMail: jest.Mock;
  let appended: Array<{ path: string; content: Buffer }>;

  const fakeImapClient = () => ({
    listFolders: async () => [
      { path: 'INBOX', flags: [] },
      { path: 'Sent', specialUse: '\\Sent', flags: [] },
    ],
    status: async () => ({ uidValidity: 1, uidNext: 1, exists: 0 }),
    listUids: async () => [],
    fetchMany: async () => [],
    append: async (p: string, c: Buffer) => {
      appended.push({ path: p, content: c });
    },
    close: async () => {},
  });

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-smtp-'));
    store = openStore(await openDb(path.join(dir, 'test.db')), deps);
    const account = await store.createAccount({
      source: 'imap',
      identifier: 'me@example.com',
      config: { host: 'imap.example.com', port: 993, secure: true, user: 'me@example.com' },
    });
    accountId = account.id;
    await store.vault.save(accountId, { password: 'hunter2' });
    sendMail = jest.fn(async () => ({}));
    appended = [];
  });

  afterEach(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const sender = () =>
    createSmtpSender({
      store,
      createTransport: () => ({ sendMail }),
      connectImap: (async () => fakeImapClient()) as never,
    });

  const intent = {
    accountId,
    kind: 'reply' as const,
    to: ['Alice <alice@example.com>'],
    cc: [],
    subject: 'Re: Numbers',
    bodyMarkdown: 'Thanks!',
    threading: { inReplyTo: '<orig@x>', references: ['<orig@x>'] },
  };

  it('sends a composed RFC822 message with threading headers', async () => {
    const result = await sender().send(intent);
    expect(sendMail).toHaveBeenCalledTimes(1);
    const { envelope, raw } = sendMail.mock.calls[0][0];
    expect(envelope).toEqual({ from: 'me@example.com', to: ['alice@example.com'] });
    const rfc822 = raw.toString('utf8');
    expect(rfc822).toContain('In-Reply-To: <orig@x>');
    expect(rfc822).toContain('References: <orig@x>');
    expect(rfc822).toContain('Subject: Re: Numbers');
    expect(rfc822).toContain('Thanks!');
    expect(result.externalMessageId).toMatch(/^<.+>$/);
  });

  it('appends the same raw bytes to the Sent mailbox', async () => {
    await sender().send(intent);
    expect(appended).toHaveLength(1);
    expect(appended[0].path).toBe('Sent');
    expect(appended[0].content.equals(sendMail.mock.calls[0][0].raw)).toBe(true);
  });

  it('a Sent-append failure does not fail the send', async () => {
    const broken = createSmtpSender({
      store,
      createTransport: () => ({ sendMail }),
      connectImap: (async () => {
        throw new Error('imap down');
      }) as never,
    });
    await expect(broken.send(intent)).resolves.toBeTruthy();
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it('throws without a stored password', async () => {
    await store.vault.delete(accountId);
    await expect(sender().send(intent)).rejects.toThrow(/password/i);
  });
});
```

NOTE: `store.createAccount` — check its signature in `store.ts` (line ~66: `createAccount(a: { source; identifier; config?; … })`); if `config` isn't accepted there, create the account then `store.setAccountConfig(accountId, {...})`.

- [ ] **Step 3: Run to verify failure**

Run: `npx jest src/main/outbound/senders/__tests__/smtp.test.ts -v`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `src/main/outbound/senders/smtp.ts`** per the algorithm in Interfaces. Key imports:

```ts
import MailComposer from 'nodemailer/lib/mail-composer';
import { createTransport as realCreateTransport } from 'nodemailer';

import type { SendIntent, SendResult, Sender } from '@shared/contracts';

import type { CoreStore } from '../../core/store/store';
import { connectImapClient } from '../../sources/imap/client';
import { resolveMailboxes } from '../../sources/imap/folders';
import type { ImapAccountConfig } from '../../sources/imap/types';
```

(If `@types/nodemailer` lacks the `lib/mail-composer` subpath in this version, add a one-line `// eslint-disable-next-line @typescript-eslint/no-var-requires`-free ambient declaration in `src/main/outbound/senders/nodemailer-mail-composer.d.ts` declaring the constructor as `new (opts: Mail.Options) => { compile(): { messageId(): string; build(): Promise<Buffer> } }` — check first with `npm run typecheck`.)

- [ ] **Step 5: Run tests, expect PASS**

Run: `npx jest src/main/outbound/senders/__tests__/smtp.test.ts -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add release/app/package.json release/app/package-lock.json package.json package-lock.json src/main/outbound/senders/
git commit -m "feat(outbound): SMTP sender — nodemailer compose/send + IMAP Sent-append"
```

---

### Task 12: Bundled senders registry + app boot wiring

**Files:**
- Create: `src/main/outbound/senders/index.ts`
- Modify: `src/main/main.ts` (wire service into `startMcp`)
- Test: extend `src/main/outbound/senders/__tests__/smtp.test.ts` with one registry case

**Interfaces:**
- Consumes: `createSmtpSender` (Task 11), `CoreStore`.
- Produces: `buildBundledSenders(deps: { store: CoreStore }): Map<string, Sender>` — key = source id; phase 1 ships exactly one entry: `'imap'`.

- [ ] **Step 1: Write the failing test**

Append to `smtp.test.ts`:

```ts
import { buildBundledSenders } from '../index';

describe('bundled senders', () => {
  it('ships exactly the imap sender in phase 1', async () => {
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'kiagent-snd-'));
    const store2 = openStore(await openDb(path.join(dir2, 't.db')), deps);
    const senders = buildBundledSenders({ store: store2 });
    expect([...senders.keys()]).toEqual(['imap']);
    await store2.close();
    fs.rmSync(dir2, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run to verify failure, then implement `src/main/outbound/senders/index.ts`**

```ts
/**
 * Source-id → Sender map for the send pipeline. Bundled transports register
 * here; extension senders (manifest `send` cap) join in a later phase via the
 * platform. A source with no entry cannot even hold a draft — the service
 * gates draft creation on sender availability.
 */
import type { Sender } from '@shared/contracts';

import type { CoreStore } from '../../core/store/store';
import { createSmtpSender } from './smtp';

export function buildBundledSenders(deps: { store: CoreStore }): Map<string, Sender> {
  return new Map<string, Sender>([['imap', createSmtpSender({ store: deps.store })]]);
}
```

Run: `npx jest src/main/outbound/senders -v` — Expected: PASS.

- [ ] **Step 3: Wire `main.ts`**

In `src/main/main.ts`, find the `mcp = await startMcp({` call (~line 589). Immediately before it insert:

```ts
    const outbound = createOutboundService({
      store: p.store,
      prefs: p.prefs,
      senders: buildBundledSenders({ store: p.store }),
      logSink: p.logSink,
    });
```

and add `outbound,` to the `startMcp({ … })` deps object. Imports at the top of `main.ts`:

```ts
import { createOutboundService } from './outbound/service';
import { buildBundledSenders } from './outbound/senders';
```

Verify `p.prefs` and `p.logSink` exist on the platform object at that point (they do — `bootCore` exposes both; `grep -n "prefs" src/main/core/boot.ts` to confirm the property names, adjust if the platform exposes them under different names).

- [ ] **Step 4: Gates**

Run: `npm run typecheck` — Expected: clean.
Run: `npx jest src/main/outbound src/main/core/mcp -v` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/outbound/senders/index.ts src/main/outbound/senders/__tests__/smtp.test.ts src/main/main.ts
git commit -m "feat(outbound): wire outbound service + bundled smtp sender into app boot"
```

---

### Task 13: stdio parity via loopback proxy

**Files:**
- Create: `src/main/mcp/outbound-proxy.ts`
- Modify: `src/main/mcp/stdio-entry.ts` (one line)
- Test: `src/main/mcp/__tests__/outbound-proxy.test.ts`

**Interfaces:**
- Consumes: `OutboundToolApi` (Task 5), `PORT_CANDIDATES` from `@main/core/mcp/server` (import the constant — do not redeclare), the `/outbox/api` wire protocol (Task 8): request `{ op, args }`, response `{ ok: true, result } | { ok: false, error }`, ping result `{ pong: 'kiagent-outbox' }`.
- Produces: `createOutboundProxy(fetchFn?: typeof fetch): OutboundToolApi` — the stdio sibling's outbound backend. Behavior: probe `http://127.0.0.1:<candidate>/outbox/api` with `{op:'ping'}` (1s timeout via `AbortSignal.timeout(1000)`) across `PORT_CANDIDATES`, cache the winning port; all fail → throw `The KIAgent app is not running — outbound drafting needs the app open. Start KIAgent and try again.`; a cached port whose request then fails at the socket level → clear cache, re-probe once. `{ok:false,error}` responses → `throw new Error(error)` (no re-probe: the app answered).

- [ ] **Step 1: Write the failing tests**

Create `src/main/mcp/__tests__/outbound-proxy.test.ts`:

```ts
/**
 * @jest-environment node
 */
import http from 'http';

import { PORT_CANDIDATES } from '../../core/mcp/server';
import { createOutboundProxy } from '../outbound-proxy';

let server: http.Server;
let hits: Array<{ op: string }>;

function startStub(port: number, behave: 'ok' | 'error'): Promise<void> {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const parsed = JSON.parse(body) as { op: string };
      hits.push(parsed);
      res.setHeader('content-type', 'application/json');
      if (parsed.op === 'ping') {
        res.end(JSON.stringify({ ok: true, result: { pong: 'kiagent-outbox' } }));
      } else if (behave === 'ok') {
        res.end(JSON.stringify({ ok: true, result: { draft_id: 'd1' } }));
      } else {
        res.end(JSON.stringify({ ok: false, error: 'no sender for gmail' }));
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () => resolve()),
  );
}

afterEach(
  () => new Promise<void>((r) => (server ? server.close(() => r()) : r())),
);

beforeEach(() => {
  hits = [];
});

describe('outbound proxy', () => {
  it('probes candidates, then forwards ops to the discovered port', async () => {
    await startStub(PORT_CANDIDATES[1], 'ok'); // 7421 free → probe advances
    const proxy = createOutboundProxy();
    const r = (await proxy.draftReply({ documentId: 'x', body: 'b' })) as {
      draft_id: string;
    };
    expect(r.draft_id).toBe('d1');
    expect(hits.map((h) => h.op)).toEqual(['ping', 'draftReply']);
  });

  it('surfaces app-side errors verbatim', async () => {
    await startStub(PORT_CANDIDATES[0], 'error');
    const proxy = createOutboundProxy();
    await expect(
      proxy.draftMessage({ accountId: 'a', to: ['b@x.co'], subject: 's', body: 'b' }),
    ).rejects.toThrow('no sender for gmail');
  });

  it('explains when the app is not running', async () => {
    const proxy = createOutboundProxy();
    await expect(proxy.listOutbox({})).rejects.toThrow(/app is not running/i);
  });
});
```

(Stub ports come from `PORT_CANDIDATES` — if a developer machine has the real app running during tests, these tests could cross-talk; mirror `server.test.ts`, which already binds those candidates in CI, and accept that limitation.)

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/main/mcp/__tests__/outbound-proxy.test.ts -v`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/main/mcp/outbound-proxy.ts`**

```ts
/**
 * Outbound backend for the stdio sibling process (spec §4): the sibling has
 * a read-only corpus connection and no senders/secret, so draft ops are
 * forwarded to the RUNNING app's loopback server (/outbox/api). If the app
 * isn't running the tools explain that instead of failing mysteriously —
 * draft creation fundamentally needs the app (confirm pages + senders live
 * there).
 */
import { PORT_CANDIDATES } from '../core/mcp/server';
import type { OutboundToolApi } from '../outbound/service';

type ApiResponse =
  | { ok: true; result: unknown }
  | { ok: false; error: string };

export function createOutboundProxy(
  fetchFn: typeof fetch = fetch,
): OutboundToolApi {
  let cachedPort: number | null = null;

  const post = async (port: number, body: unknown): Promise<ApiResponse> => {
    const res = await fetchFn(`http://127.0.0.1:${port}/outbox/api`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    return (await res.json()) as ApiResponse;
  };

  const probe = async (): Promise<number> => {
    for (const port of PORT_CANDIDATES) {
      try {
        const res = await fetchFn(`http://127.0.0.1:${port}/outbox/api`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ op: 'ping' }),
          signal: AbortSignal.timeout(1000),
        });
        const parsed = (await res.json()) as ApiResponse;
        if (
          parsed.ok &&
          (parsed.result as { pong?: string })?.pong === 'kiagent-outbox'
        ) {
          return port;
        }
      } catch {
        /* next candidate */
      }
    }
    throw new Error(
      'The KIAgent app is not running — outbound drafting needs the app ' +
        'open. Start KIAgent and try again.',
    );
  };

  const call = async (op: string, args: unknown): Promise<unknown> => {
    if (cachedPort === null) cachedPort = await probe();
    let response: ApiResponse;
    try {
      response = await post(cachedPort, { op, args });
    } catch {
      // The app may have restarted onto another candidate port — once.
      cachedPort = await probe();
      response = await post(cachedPort, { op, args });
    }
    if (!response.ok) throw new Error(response.error);
    return response.result;
  };

  return {
    draftReply: (a) => call('draftReply', a) as never,
    draftMessage: (a) => call('draftMessage', a) as never,
    listOutbox: (a) => call('listOutbox', a) as never,
  };
}
```

- [ ] **Step 4: Wire `stdio-entry.ts`**

```ts
import { createOutboundProxy } from './outbound-proxy';
```
and change line ~116:
```ts
    ...buildBuiltinTools(store.read, createOutboundProxy()),
```

- [ ] **Step 5: Run tests, expect PASS**

Run: `npx jest src/main/mcp -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/mcp/outbound-proxy.ts src/main/mcp/__tests__/outbound-proxy.test.ts src/main/mcp/stdio-entry.ts
git commit -m "feat(outbound): stdio sibling proxies draft tools to the running app's loopback server"
```

---

### Task 14: Full gates + handoff notes

**Files:**
- No new code. Possibly small fixes surfaced by the full suite.

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: PASS. Fix anything red (typical stragglers: tool-count assertions in mcp suites, `ImapClient` fakes missing `append`, jsdom suites accidentally importing `loader-node` — pages/routes must only be imported from main-process modules).
If better-sqlite3 ABI errors appear: `npm rebuild better-sqlite3`, re-run.

- [ ] **Step 2: Lint + typecheck**

Run: `npm run lint` — Expected: clean (it's a standing gate in this repo).
Run: `npm run typecheck` — Expected: clean.

- [ ] **Step 3: Commit any fixes**

```bash
git add -A src release/app/package.json package.json
git commit -m "test(outbound): full-suite fixes for the outbound layer"
```

(Skip if nothing changed. NEVER `git add` unrelated untracked files.)

- [ ] **Step 4: Report status (do not push, do not release)**

Summarize for the user:
- What landed (tasks 1–13) and the test counts.
- Manual smoke checklist (human, needs a real IMAP account): app boots; `draft_reply` from an MCP client returns a review URL; page shows recipient/body; Confirm sends and the message lands in the recipient inbox + own Sent folder; re-clicking the link shows "Already sent"; mode `link` account shows minimal page; Claude Desktop (stdio) drafting works with the app open and errors helpfully with it closed.
- Release handoff (NOT this plan): core release + tag via the manual runbook, then alpha-cent `core.lock` bump + product fixture smoke (spec §11's product-side check: four outbound tools in `tools/list` — note: three shipped in phase 1; `send_draft` arrives with mode C) + gmail-gate/GTM copy updates ride later phases.

---

## Self-Review Notes (already applied)

- **Spec coverage (phases 1–3):** §3 outbox table → Task 1/2 (TEXT ISO timestamps deviation documented in Global Constraints); §4 tools minus `send_draft` (phase 6) → Task 6; §5 modes A/B, signed URLs, POST-behind-button, Host/Origin → Tasks 3/5/8 (rebind guard covers CSRF hygiene; token in path); §6 Sender contract + opaque-ref hook → Tasks 1/5 (`metadata.outbound` honored in `draftReply`); §7 SMTP + Sent-append + threading → Tasks 10/11 (Gmail transport is phase 5); §8 product overlay → explicitly zero: no new IPC channels used (Task 9 note); §11 testing bullets map to the per-task suites; §12 phase 1–3 build order matches task order.
- **Known cut lines:** `created_via` is always `'mcp-local'` in this plan — the remote transport can't be distinguished in-process today (no per-call transport context in the registry); phase 4 introduces that seam. Mode C absent everywhere by design. Gmail accounts get honest "not supported yet" errors at draft time (sender-availability gate), unblocking cleanly when the gmail sender registers in phase 5.
- **Type consistency check:** `OutboundToolApi` names (`draftReply/draftMessage/listOutbox`) are shared verbatim by service (T5), tools (T6), routes' `/outbox/api` ops (T8), and proxy (T13). `ConfirmOutcome`/`PeekResult` kinds used in T7 service tests match T8's route rendering. `OutboxStore.transition(from[], to, patch)` signature identical in T2 impl and T7 pipeline.
