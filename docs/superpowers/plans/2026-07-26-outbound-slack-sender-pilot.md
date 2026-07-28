# Slack Pilot Extension Sender Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Spec phase 8 — third-party extensions can ship Senders: a `send` capability + `contributes.senders`, sender calls over the existing extension RPC, piloted in the Slack connector (`chat.postMessage`, reply-only via `metadata.outbound`).

**Architecture:** The survey corrected the spec on three points this plan encodes. (1) There is no per-method permission map to extend — host→extension calls are cap-ungated by design (`HostRouter` gates the other direction only), so the `send` cap is enforced at REGISTRATION time (`registerContributions`, the same place undeclared sources are refused) plus the standing rule that senders are reachable only from the confirmation-gated send pipeline. (2) There is no "permission-delta" machinery — consent is an exact-version + cap-superset coverage check; adding `send` invalidates consent by BOTH prongs, and the ConsentModal shows the full cap list. That satisfies the spec's intent; no delta UX is built here (YAGNI). (3) A manifest section alone silently no-ops (`workers`/`providers` prove it) — `senders` must thread through `Contributions`, the `activate()` return slot, and the child dispatcher, with `PLATFORM_API_VERSION` bumped to 1.2.0 (old children answer an unknown `send` namespace with a clean error; old manifests with `engine: ^1.0.0` keep loading). Credentials reach the extension sender as an explicit `SenderContext` second argument (same trust boundary as `session.credentials()` during pulls — the extension already sees the token). The Slack connector writes `metadata.outbound = { ref: {channel, thread_ts?}, display }` from `toDocument`, which the phase-1 service already honors verbatim end to end (ingestion applies no metadata filtering — verified).

**Tech Stack:** TypeScript, zod (manifest), the existing `RpcEndpoint` transport, jest; Slack Web API via the connector's own rate-limited `SlackClient`.

**Spec:** `docs/superpowers/specs/2026-07-23-unified-outbound-design.md` §6, §12 phase 8.

## Global Constraints

- **Prerequisite:** the phase-1 outbound plan fully landed in kiagent-core. Tasks 1–5: `/Users/edjafarov/work/kiagent-core` (dev). Tasks 6–8: `/Users/edjafarov/work/slack-kia-connector` (its default branch), which vendors the platform contracts (`src/kiagent-contracts.ts`) — the connector compiles only after Task 6 re-vendors.
- Never amend/rebase/reset; never bypass hooks; no `Co-Authored-By`/promo. Subagents do NOT commit. No worktrees for jest.
- Extension senders are reachable ONLY through the outbox pipeline after a confirmation gate — which since v0.57.0 includes the `send_draft` tool for chat-mode drafts — never as directly-registered MCP tools. The registry key is the SOURCE id, which preserves "a reply goes back through the same extension that ingested the document" automatically.
- The RPC has NO call timeout (a hung child pends forever) — the host-side sender proxy MUST impose its own (60 s).
- An extension gets a sender registered only when ALL THREE hold: manifest `caps` includes `'send'`, the source id is listed in `contributes.senders`, and the extension actually contributes that source. Anything else → warn + skip (mirror the undeclared-source precedent).
- `metadata.outbound` changes `contentHash` (write-tx.ts hashes metadata), but the Slack source only re-emits recently-active content (backfill latched via `cursor.backfill_done`, 7-day delta window, NO `reconcile()`): only fresh channels/days/threads gain `outbound`. Pre-v2.1.0 docs stay reply-less until the account is re-synced from scratch. Consequences: `draftReply` on such docs must refuse with reply-specific copy (Task 4), and any smoke must use a channel with NEW activity.
- Slack scope reality: adding `chat:write` to the connector's required scopes means EVERY existing Slack account fails the connect-time scope check until the user re-creates the app from the README manifest, reinstalls it, and reconnects. The send path must also fail with that guidance (`missing_scope` at send time).
- Final gates per repo: kiagent-core FULL `npm test` + lint + typecheck; slack-kia-connector's own test/build scripts.
- Parallel-wave implementers gate on TARGETED jest only (`npx jest src/main/platform` / `npx jest src/main/outbound` / connector `npx jest src/__tests__/<file>`); repo-wide typecheck/lint/full-suite belong to Task 5 (core) and Task 8 (connector) — a shared checkout mid-wave contains other agents' half-finished edits. Worktrees are NOT an escape hatch (jest from `.claude/worktrees/*` silently ignores all tests).
- Slack sender error strings MUST end with `reconnect the account in Settings` so core's `error-copy.ts` `AUTH_MARKERS` (`/reconnect .* in Settings|…/i`) classifies them `kind:'auth'`, `canRetry:true`. This is a deliberate cross-repo string coupling; the summary must read as a standalone imperative sentence (the failed page appends ". Then tap Try again."). The extension-proxy TIMEOUT string deliberately matches nothing → `kind:'unknown'`, `canRetry:false` ("may still have been sent") — the honest outcome; do NOT make it retryable.

## Parallel Execution Guide (subagent-driven)

Implementers on **opus** (user directive 2026-07-28), one per task; the orchestrator commits serially per repo:

- **Wave 1 (core):** Task 1 (contracts + manifest + catalog)
- **Wave 2:** Task 2 (RPC + child + host-process) ∥ Task 4 (outbound service/senders/identity — NO `main.ts`) ∥ Task 6 (connector repo — needs only Task 1's contracts to vendor from)
- **Wave 3:** Task 3 (registration + SenderRegistry + ALL `main.ts` wiring incl. `composeSenders` — consumes Task 2's `callSender` AND Task 4's `composeSenders`) ∥ Task 7 (the Slack sender — consumes Task 6)
- **Wave 4:** Task 5 (core repo-wide gates) ∥ Task 8 (connector gates + rollout)

(Original wave order was incoherent: it placed Task 4's `main.ts` wiring before Task 3 created `p.senders`. Resolved by moving ALL `main.ts` changes into Task 3.)

## File Structure

| Repo | File | Change | Responsibility |
| --- | --- | --- | --- |
| core | `src/shared/contracts.ts` | modify | `'send'` cap, `SenderContext`, `activate().senders` |
| core | `src/main/platform/manifest.ts` | modify | `CAPS` + `contributes.senders` + normalizer |
| core | `src/renderer/components/cap-catalog.ts` | modify | consent copy for `send` |
| core | `src/shared/extension-rpc.ts` | modify | `'send'` ns, `Contributions.senders`, version 1.2.0 |
| core | `src/main/platform/extension-host-entry.ts` | modify | collect + dispatch senders |
| core | `src/main/platform/host-process.ts` | modify | `callSender` |
| core | `src/main/core/boot.ts` | modify | `SenderRegistry` on `CorePlatform` |
| core | `src/main/platform/extension-platform.ts` | modify | gated registration + disposer + proxy |
| core | `src/main/outbound/service.ts` | modify | `SenderLookup` normalization |
| core | `src/main/outbound/senders/index.ts` | modify | `composeSenders` |
| core | `src/main/outbound/identity.ts` | modify | explicit email-only compose error |
| core | `src/main/platform/__tests__/fixtures/ext-sender/*` | create | happy-path fixture |
| core | `src/main/platform/__tests__/fixtures/ext-sender-nocap/*` | create | gating fixture |
| slack | `src/kiagent-contracts.ts` | modify | re-vendor `send`/`Sender`/`SenderContext` |
| slack | `manifest.json` | modify | `send` cap + `contributes.senders`, v2.1.0 |
| slack | `src/messages.ts` | modify | `metadata.outbound` on day/thread docs |
| slack | `src/source.ts` | modify | `chat:write` in required scopes |
| slack | `src/sender.ts` | create | the Sender |
| slack | `src/index.ts` | modify | return `senders` from `activate` |

---

### Task 1: `'send'` cap + `contributes.senders` + contracts

**Files:**
- Modify: `src/shared/contracts.ts`, `src/main/platform/manifest.ts`, `src/renderer/components/cap-catalog.ts`
- Test: `src/main/platform/__tests__/manifest.test.ts` (append)

**Interfaces:**
- Consumes: the `Cap` union (`contracts.ts:594-606`), `CAPS` mirror with its `satisfies readonly Cap[]` drift guard (`manifest.ts:28-38`), `CapSurfaces` (`contracts.ts:689-713` — exhaustive, `HostFor` indexes it; `'unsafe.mainProcess': {}` at 712 is the precedent for `send: {}`), `CAP_CATALOG: Record<Cap, CapInfo>` (`cap-catalog.ts:18`; `CapInfo` at 7-12 is `{ label; description; risk: 'normal' | 'elevated'; icon }` — all four REQUIRED, `risk`/`icon` load-bearing at render in `ConsentModal.tsx:153-166`), the `contributes` zod schema (`manifest.ts:88-98` — insert `senders` after `providers` at line 93), the `Manifest` interface (`contracts.ts:636-658` — its `contributes` block at 650-656 MUST also gain `senders?: string[]`, or `senderContributions` will not compile), `ExtensionModule.activate()` return (`contracts.ts:739-744`).
- Produces (used by every later task):

```ts
// contracts.ts — Cap union gains (with doc comment):
  /** May deliver outbound messages through the host's send pipeline — the
   *  host calls the extension's Sender only AFTER a user confirmation gate;
   *  extensions never initiate sends. Not a host namespace: there is no
   *  host.send.* surface. */
  | 'send'

// CapSurfaces gains (forced by exhaustiveness):
  /** Host-initiated only — no extension→host surface. */
  send: {};

// Sender widens (bundled senders ignore ctx; extension senders need it —
// they cannot close over the vault):
export interface SenderContext {
  credentials: Credentials | null;
}
export interface Sender {
  send(intent: SendIntent, ctx?: SenderContext): Promise<SendResult>;
}

// ExtensionModule.activate() return gains:
    /** Senders keyed by SOURCE id — each must be listed in
     *  contributes.senders and its source contributed by this extension. */
    senders?: Record<string, Sender>;

// contracts.ts — Manifest.contributes (650-656) gains:
    senders?: string[];

// manifest.ts — CAPS gains 'send'; contributes schema gains (after providers, line 93):
      senders: z.array(z.string()).optional(),
// plus the normalizer (beside sourceContributions at 140-148 — match its
// Pick<Manifest, 'contributes'> parameter convention):
export function senderContributions(
  manifest: Pick<Manifest, 'contributes'>,
): string[] {
  return manifest.contributes.senders ?? [];
}

// cap-catalog.ts — CAP_CATALOG gains (field names verified against CapInfo):
  send: {
    label: 'Send messages',
    description:
      'Can deliver outbound messages from its accounts — only after you ' +
      'confirm each one through the app’s send flow.',
    risk: 'elevated',
    icon: 'external',
  },
```

(`risk: 'elevated'` is deliberate — sending on the user's behalf sits with the elevated caps; `'external'` is an existing valid icon name.)

- [ ] **Step 1: Failing tests** — append to `manifest.test.ts`:

```ts
  it('accepts the send cap and contributes.senders', () => {
    const m = parseManifest({
      ...GOOD, // the file's valid-manifest fixture (manifest.test.ts:16)
      caps: ['net', 'send'],
      contributes: { sources: ['slack'], senders: ['slack'] },
    });
    expect(m.caps).toContain('send');
    expect(senderContributions(m)).toEqual(['slack']);
  });

  it('senders default to empty', () => {
    expect(senderContributions(parseManifest(GOOD))).toEqual([]);
  });
```

- [ ] **Step 2: FAIL** — `npx jest src/main/platform/__tests__/manifest.test.ts -v`.
- [ ] **Step 3: Implement** the declarations above. The two `satisfies`/`Record` exhaustiveness guards will FORCE the `CapSurfaces` and `cap-catalog` entries — that's the drift protection working; do not weaken it.
- [ ] **Step 4: PASS** — `npx jest src/main/platform -v` && `npm run typecheck`.
- [ ] **Step 5: Commit**

```bash
cd /Users/edjafarov/work/kiagent-core
git add src/shared/contracts.ts src/main/platform/manifest.ts src/renderer/components/cap-catalog.ts src/main/platform/__tests__/manifest.test.ts
git commit -m "feat(platform): 'send' cap + contributes.senders + SenderContext contract"
```

---

### Task 2: RPC — `send` namespace end to end

**Files:**
- Modify: `src/shared/extension-rpc.ts`, `src/main/platform/extension-host-entry.ts`, `src/main/platform/host-process.ts`
- Test: the existing host-process / entry test files (append; find them via `ls src/main/platform/__tests__`)

**Interfaces:**
- Consumes: `MainToChild` (`extension-rpc.ts:60+` — call ns currently `'source' | 'tool'`), `Contributions` (`extension-rpc.ts:42-49`), the child's `onCall` dispatcher (`extension-host-entry.ts:179-189`) and activation collection (`:158-172`), `host-process.ts` `callTool` (`:320-324`) as the pattern.
- Produces (used by Task 3):

```ts
// extension-rpc.ts:
export const PLATFORM_API_VERSION = '1.2.0'; // was 1.1.0 — additive
// MainToChild call ns: 'source' | 'tool' | 'send'
// Contributions gains:
  /** Source ids this extension provides a Sender for (declared AND returned
   *  from activate). Absent from pre-1.2 children — default []. */
  senders?: string[];

// host-process.ts — the handle gains (sibling of callTool, 320-324). It must
// ALSO be declared in createExtensionHost's inline return-type literal at
// 68-72 — the return type is an object literal type, not an exported interface:
    callSender(sourceId: string, intent: SendIntent, ctx: SenderContext) {
      if (!current)
        return Promise.reject(new Error('extension is not running'));
      return current.endpoint.call('send', sourceId, [intent, ctx]) as Promise<SendResult>;
    },

// extension-host-entry.ts — child side:
// (a) after activate(): const senders = new Map(Object.entries(result.senders ?? {}));
//     contributions.senders = [...senders.keys()];
// (b) in the onCall dispatcher, before the unexpected-namespace throw:
    if (ns === 'send') {
      const sender = senders.get(method);
      if (!sender) throw new Error(`unknown sender ${method}`);
      return sender.send(
        args[0] as SendIntent,
        args[1] as SenderContext | undefined,
      );
    }
```

Compat contract: an OLD child (bundled pre-1.2) that receives `ns: 'send'` hits its existing `unexpected main→child namespace` throw → arrives host-side as a clean `{ok:false,error}` rejection — the caller must treat that as "no sender", never crash. A NEW host reading old `Contributions` defaults `senders` to `[]` (so the situation never arises through the registry — the compat test pins the raw-RPC path anyway).

- [ ] **Step 1: Failing tests** — harness facts: `host-process.test.ts` builds deps around `createInMemoryHostPair()` + `runExtensionHost(pair.child, …)` (lines 13-30; `callTool` covered at 95). `extension-host-entry.test.ts` has a `boot()` helper (lines 19-33) returning `{ mainEp, exit, requireModule, waitFor }` with a `jest.fn()` `requireModule` — the natural place for the fixture-module tests below (no on-disk fixture needed):

1. A fixture module whose `activate` returns `senders: { fixsrc: { send: async (intent, ctx) => ({ externalMessageId: `sent:${ctx?.credentials?.password}:${(intent.outboundRef as { channel: string }).channel}` }) } }` → after activation, `Contributions.senders` equals `['fixsrc']`, and `handle.callSender('fixsrc', intent, { credentials: { password: 'tok' } })` resolves with the echoed id.
2. `callSender('unknown', …)` rejects with `/unknown sender/`.
3. A module returning NO senders → `Contributions.senders` is `[]` and a raw `endpoint.call('send', 'x', [...])` against it rejects cleanly (message match `/unknown sender|unexpected/`), the process stays alive (a follow-up `source`/`tool` call still works).

- [ ] **Step 2: FAIL.** — targeted jest on the touched test files.
- [ ] **Step 3: Implement** per the Produces block (version bump included).
- [ ] **Step 4: PASS** — `npx jest src/main/platform -v`.
- [ ] **Step 5: Commit**

```bash
git add src/shared/extension-rpc.ts src/main/platform/extension-host-entry.ts src/main/platform/host-process.ts src/main/platform/__tests__
git commit -m "feat(platform): send RPC namespace — child sender dispatch + host callSender (v1.2.0)"
```

---

### Task 3: Registration — `SenderRegistry`, gating, proxy

**Files:**
- Modify: `src/main/core/boot.ts`, `src/main/platform/extension-platform.ts`
- Create: `src/main/platform/__tests__/fixtures/ext-sender/{manifest.json,index.js}`, `src/main/platform/__tests__/fixtures/ext-sender-nocap/{manifest.json,index.js}`
- Test: `src/main/platform/__tests__/extension-platform.test.ts` (append; match its fixture-loading style)

**Interfaces:**
- Consumes: `SourceRegistry` (`boot.ts:44-48, 92-102`) as the model, `registerContributions` + the undeclared-source refusal (`extension-platform.ts:291-300`) + its disposer (`:347-359`), `senderContributions` (Task 1), `callSender` (Task 2), `deps.store.vault`.
- Produces (used by Task 4):

```ts
// boot.ts — mirror SourceRegistry; exposed on CorePlatform as `senders`:
export interface SenderRegistry {
  register(sourceId: string, sender: Sender): void;
  get(sourceId: string): Sender | undefined;
  ids(): string[];
  unregister(sourceId: string): void;
}
```

Registration contract (in `registerContributions`, beside the sources loop):
- For each id in `contributions.senders ?? []`: require (a) `e.manifest.caps.includes('send')`, (b) id ∈ `senderContributions(e.manifest)`, (c) id is one of this extension's CONTRIBUTED source ids. Any miss → `logSink.log('extension:<id>', 'warn', ...)` naming the missing prong, skip (exact tone of the undeclared-source warn).
- Registered value is a host-side proxy. Placement: the senders loop goes AFTER line 327's `e.sourceIds = registeredSources;` so prong (c) can test against the actually-registered source ids. The extension handle inside `registerContributions` is `e.host`, not a local `host` — the tools loop's `e.host!.callTool(t.name, args)` at line 335 is the precedent:

```ts
        deps.senders.register(id, {
          send: async (intent) => {
            const credentials = await deps.store.vault.load(intent.accountId);
            const call = e.host!.callSender(id, intent, { credentials });
            // The RPC has no timeout; a hung child must not wedge the
            // confirmation pipeline (the row would sit in 'sending').
            return await withTimeout(
              call,
              60_000,
              `extension sender '${id}' timed out after 60s`,
            );
          },
        });
```

  (`withTimeout` — no such helper exists anywhere in `src/` — add a tiny local one: `Promise.race` with a rejecting timer, timer cleared/`unref()`d. The timeout string `extension sender '<id>' timed out after 60s` deliberately classifies in `error-copy.ts` as `kind:'unknown'`/`canRetry:false` — the honest outcome for a timeout, since the child may have posted before hanging; do NOT phrase it to match the auth/transient markers.)
- The existing disposer path additionally calls `deps.senders.unregister(id)` for every registered sender id (same lifecycle as sources — including crash-respawn).
- `ExtensionPlatformDeps` (lines 115-157) gains `senders: SenderRegistry` — this breaks compilation at FIVE construction sites, all in this task's scope: `main.ts:792`, `extension-platform.test.ts:50` (the `makePlatform` helper), `extension-platform.test.ts:627` and `:753` (full literal deps — do NOT miss these two), `extension-e2e.test.ts:38`.
- This task owns ALL `main.ts` wiring (absorbed from Task 4): the outbound service construction at `main.ts:600-605` becomes `senders: composeSenders(buildBundledSenders({ store: p.store, logSink: p.logSink }), p.senders),` (`logSink` is REQUIRED by `buildBundledSenders` — the original plan snippet dropped it); the extension-platform deps at ~810 gain `senders: p.senders,` beside `sources: p.sources`; add `composeSenders` to the `./outbound/senders` import at line 55.

Fixtures (model on `fixtures/ext-basic`):
- `ext-sender/manifest.json`: `{ "id": "test.sender", "name": "Sender Fixture", "version": "1.0.0", "engine": "^1.0.0", "entry": "index.js", "caps": ["send"], "contributes": { "sources": ["fixsrc"], "senders": ["fixsrc"] } }` — `index.js` returns a minimal source (copy ext-basic's) plus `senders: { fixsrc: { send: async (intent) => ({ externalMessageId: 'fix-1' }) } }`.
- `ext-sender-nocap/`: identical but `"caps": []` — activation must WARN and register NO sender (the source still registers).

- [ ] **Step 1: Failing tests** — harness: `extension-platform.test.ts` uses a real `CoreStore` (`openStore(await openDb(...))`, lines 95-99 — `store.vault.load` is genuinely spy-able), a `logs: Array<{scope, level, msg}>` filled by the logSink fake (lines 45, 76-79) for warn assertions, and fixture install via `platform.installPreview(FIXTURE)` → `installCommit(preview.token)` with fixtures under `__tests__/fixtures/` (model: `ext-basic`). The consent-coverage check is at lines 273-278.

1. Activating `ext-sender` → `platform.senders.ids()` contains `'fixsrc'`; calling `platform.senders.get('fixsrc')!.send({...})` resolves `{ externalMessageId: 'fix-1' }` and the vault was consulted for that account id (spy on `store.vault.load`).
2. Activating `ext-sender-nocap` → `senders.ids()` does NOT contain `'fixsrc'`; a warn line was logged (match the harness's logSink capture).
3. Disposing/stopping the extension → `senders.get('fixsrc')` is `undefined`.
4. Consent: with a recorded consent for `ext-sender` v1.0.0 caps `[]`, `consentCovers` is false once the manifest declares `caps: ['send']` (append beside the existing consent tests if this exact shape isn't already covered).

- [ ] **Step 2: FAIL.** — `npx jest src/main/platform/__tests__/extension-platform.test.ts -v`.
- [ ] **Step 3: Implement** (registry in boot.ts + `CorePlatform.senders` + `createExtensionPlatform` deps gain `senders: SenderRegistry`; thread from `main.ts` where the platform is constructed).
- [ ] **Step 4: PASS** — `npx jest src/main/platform src/main/core -v` && `npm run typecheck`.
- [ ] **Step 5: Commit**

```bash
git add src/main/core/boot.ts src/main/platform/extension-platform.ts src/main/platform/__tests__ src/main/main.ts
git commit -m "feat(platform): SenderRegistry — cap-gated extension sender registration with timeout proxy"
```

---

### Task 4: Outbound service — `SenderLookup` + email-only compose guard

**Files:**
- Modify: `src/main/outbound/service.ts`, `src/main/outbound/senders/index.ts`, `src/main/outbound/identity.ts` — NO `main.ts` (Task 3 owns all `main.ts` wiring; `p.senders` doesn't exist yet in this wave)
- Test: `src/main/outbound/__tests__/service.test.ts`, `identity.test.ts`, `error-copy.test.ts` (append)

**Interfaces:**
- Consumes: Task 1's contracts (`SenderContext` — no service change needed for it; the service calls `sender.send(intent)` at `service.ts:366` and bundled senders ignore ctx while extension proxies inject it). Does NOT consume Task 3 — this task runs before it; tests use a structural lookup literal.
- Produces:

```ts
// senders/index.ts (define SenderLookup HERE; service.ts imports it — keeps
// the import edge one-directional, service → senders):
export interface SenderLookup {
  get(sourceId: string): Sender | undefined;
  ids(): string[];
}
// service.ts: createOutboundService deps.senders widens to
// Map<string, Sender> | SenderLookup — normalized internally (Map → lookup)
// so every existing call site keeps passing a Map unchanged (main.ts:603,
// service.test.ts ×6, outbound-tools.test.ts:81, outbound-routes.test.ts:104).
// accountFor's Map-only `.has()` at service.ts:179 becomes
// `!lookup.get(account.source)`. BOTH enumerating error sites (accountFor
// 176-186 and executeSend 326-334) keep the exact substring
// `is not supported yet` verbatim (error-copy.ts's UNSUPPORTED regex and
// service.test.ts:551 depend on it) and enumerate via `lookup.ids()`.

// senders/index.ts:
export function composeSenders(
  bundled: Map<string, Sender>,
  ext: { get(id: string): Sender | undefined; ids(): string[] },
): SenderLookup {
  return {
    get: (id) => bundled.get(id) ?? ext.get(id),
    ids: () => [...new Set([...bundled.keys(), ...ext.ids()])],
  };
}

// identity.ts — senderAddressFor (lines 24-35) gains an early guard: a source
// that is neither imap nor gmail throws
// `compose is email-only — '<source>' accounts are reply-only`
// (draft_message fail-fasts through senderAddressFor at service.ts:498; today
// slack falls through to the config-shaped "no usable From address" message.
// Safe for the gmail/smtp senders — they only ever run for their own sources.)

// service.ts draftReply — NEW reply-path guard (survey risk B): a doc whose
// account source is neither imap nor gmail and that lacks metadata.outbound
// currently falls to resolveImapReply (service.ts:471-475) and would surface
// the COMPOSE error on a REPLY. Before the imap fallback, throw reply-specific
// copy instead:
//   `this document has no reply target — it was indexed before its source ` +
//   `gained reply support; it gains one when its channel next syncs new ` +
//   `activity, or after a full account re-sync`
// (Pre-v2.1.0 Slack docs NEVER self-heal — the source doesn't re-emit old
// docs: latched backfill, 7-day delta window, no reconcile.)
```

(`main.ts` wiring moved to Task 3 — `buildBundledSenders` requires `{ store, logSink }` and `p.senders` only exists after Task 3.)

- [ ] **Step 1: Failing tests**

`service.test.ts` — a slack-shaped account + doc with the universality hook, sender supplied through a LOOKUP (not a Map):

```ts
  it('drafts replies for extension-sender sources via metadata.outbound', async () => {
    const slackSend = jest.fn(async () => ({ externalMessageId: '1719.42' }));
    const lookup = {
      get: (id: string) => (id === 'slack' ? { send: slackSend } : undefined),
      ids: () => ['slack'],
    };
    const svc = createOutboundService({
      store,
      prefs: fakePrefs(), // fakePrefs is a FUNCTION in this harness — call it
      senders: lookup,
      logSink,
    });
    svc.setBaseUrl('http://127.0.0.1:7421');
    const slackAccount = await store.createAccount({
      source: 'slack',
      identifier: 'T123:me',
      config: {},
    });
    await store.commit({
      account: slackAccount.id,
      documents: [
        {
          externalId: 'C9:1719',
          type: 'slack.thread',
          title: 'thread',
          markdown: 'hi',
          metadata: {
            outbound: {
              ref: { channel: 'C9', thread_ts: '1719.00' },
              display: '#general (thread)',
            },
          },
          createdAt: '2026-07-01T00:00:00Z',
        },
      ],
      cursor: null,
    });
    const slackHits = await store.read.search({
      account: slackAccount.id,
      type: 'slack.thread',
    });
    const slackDocId = slackHits[0].id as string;
    const r = await svc.draftReply({ documentId: slackDocId, body: 'On it!' });
    expect(r.recipient_display).toBe('#general (thread)');
    const out = await svc.confirmByToken(tokenOf(r)); // tokenOf helper, service.test.ts:470
    expect(out.kind).toBe('sent');
    expect(slackSend.mock.calls[0][0].outboundRef).toEqual({
      channel: 'C9',
      thread_ts: '1719.00',
    });
  });

  it('draft_message refuses non-email sources honestly', async () => {
    // same lookup/account as above:
    await expect(
      svc.draftMessage({
        accountId: slackAccount.id,
        to: ['x@y.com'],
        subject: 's',
        body: 'b',
      }),
    ).rejects.toThrow(/email-only.*reply-only/);
  });
```

`identity.test.ts` — `senderAddressFor` on a slack-source account throws `/email-only/`. NOTE: the file's `account()` helper hard-codes `source: 'imap'` (lines 5-15) — widen it first (e.g. an optional `Partial<Account>` overrides argument).

Also append: (a) a `service.test.ts` reply-guard test — a slack doc WITHOUT `metadata.outbound` → `draftReply` rejects `/no reply target/` (NOT `/email-only/`); (b) an `error-copy.test.ts` pin — `shapeOutboundError("extension sender 'slack' timed out after 60s")` → `kind: 'unknown'`, `canRetry: false` (Task 3 emits that string; this pins its deliberately-ambiguous classification).

- [ ] **Step 2: FAIL.** — `npx jest src/main/outbound -v`.
- [ ] **Step 3: Implement** (normalization helper at the top of `createOutboundService`; the two error-message sites that enumerate supported senders use `lookup.ids()`).
- [ ] **Step 4: PASS** — `npx jest src/main/outbound -v` && `npm run typecheck`.
- [ ] **Step 5: Commit**

```bash
git add src/main/outbound/service.ts src/main/outbound/senders/index.ts src/main/outbound/identity.ts src/main/outbound/__tests__
git commit -m "feat(outbound): SenderLookup — extension senders join the pipeline; compose stays email-only"
```

---

### Task 5: Core gates + handoff

This task owns the REPO-WIDE gates the parallel waves deliberately skipped.

- [ ] **Step 1:** `npm test` && `npm run lint` && `npm run typecheck` — all green.
- [ ] **Step 2:** Report; handoff to the connector tasks: kiagent-core must be released (or at least the vendored contracts snapshot taken from this commit) before Task 6 re-vendors.

---

### Task 6: Slack connector — vendor, manifest, outbound refs, scopes

**Repo:** `/Users/edjafarov/work/slack-kia-connector`.

**Files:**
- Modify: `src/kiagent-contracts.ts`, `manifest.json`, `src/messages.ts`, `src/source.ts`, `README.md`

- [ ] **Step 1: Re-vendor contracts — minimal curated additions, NOT a wholesale re-vendor.** The vendored file is a deliberately-lagging snapshot (@ `c6ee4e0`, 704 lines vs core's 948 — missing `unsafe.mainProcess`, `Manifest.icon`, `SourceContribution`, `activate`'s `extras`, `Credentials.scope`; leave ALL of that alone). Add ONLY, from the Task-1 core commit: `'send'` on the `Cap` union (connector lines 442-451), `send: {}` on `CapSurfaces` (499-521), the `SendIntent` / `SendResult` / `SenderContext` / `Sender` interfaces, `senders?: Record<string, Sender>` on the `activate()` return (539-547), and `senders?: string[]` on the vendored `Manifest.contributes`. Update the header comment's commit hash (lines 1-4) to the Task-1 core commit.

- [ ] **Step 2: Manifest** — and bump `package.json` `"version"` to `2.1.0` in the same step (the repo keeps the two equal):

```json
{
  "id": "kia.slack",
  "name": "Slack",
  "version": "2.1.0",
  "engine": "^1.0.0",
  "entry": "dist/index.js",
  "caps": ["net", "send"],
  "contributes": { "sources": ["slack"], "senders": ["slack"] },
  "icon": "icon.png"
}
```

- [ ] **Step 3: Outbound refs in `toDocument`** — in `src/messages.ts`, the day/thread builders both spread `baseMetadata(...)` (lines 84-97) and add one sibling key each (day: `conversation_type`, metadata block 113-116; thread: `slack_thread_ts`, block 137-140) — add `outbound` beside those keys. The in-scope variables are `item.channelId` / `item.channelName` / `item.threadTs` (the `slack_channel_*` names are metadata KEYS the builder writes, not variables). `item.channelName` ALREADY carries the `#` / `DM with …` / `Group DM: …` prefix from `conversationDisplayName` (source.ts:140-151) — add NO extra `#` (the original plan's template would ship `##general`):
  - day docs (`slack.day`): `outbound: { ref: { channel: item.channelId }, display: item.channelName }`
  - thread docs (`slack.thread`): `outbound: { ref: { channel: item.channelId, thread_ts: item.threadTs }, display: \`${item.channelName} (thread)\` }`
  - file docs (`fileToDocument`, 145-169 — doesn't use `baseMetadata`): NO outbound (files aren't a reply target).
  Test-first in the repo's own style (existing metadata assertions use `toMatchObject`, so adding `outbound` breaks none of them). NOTE in the report: only re-emitted (recently-active) docs gain `outbound` — the old corpus does not self-heal (latched backfill, no reconcile).

- [ ] **Step 4: Scopes + copy** — ONE code edit: append `'chat:write'` to `SLACK_USER_SCOPES` (source.ts:77-88). `SLACK_APP_MANIFEST` is GENERATED from it via `SCOPE_LINES` (line 93) — the manifest and the connect wizard's copyable block follow automatically, and the connect-time check (source.ts:857-874) then demands the new scope with error text that already reads correctly. Fallout to fix in the same step: (a) `ALL_SCOPES` in `src/__tests__/source.test.ts:235-236` must gain `chat:write` or every happy-path connect test fails; (b) README app-manifest scope list (lines 31-40, hand-maintained duplicate) — append `- chat:write` after `- files:read`; (c) two now-false "read-only" claims: README line 21 "(read-only scopes)" and the connect-prompt description at source.ts:819 ("…stays read-only") — reword both honestly (read scopes plus `chat:write`, used only for replies you confirm).

- [ ] **Step 5:** Run the connector's test suite + build (`package.json` scripts). Commit:

```bash
cd /Users/edjafarov/work/slack-kia-connector
git add src/kiagent-contracts.ts manifest.json package.json src/messages.ts src/source.ts src/__tests__ README.md
git commit -m "feat: send-capable manifest, outbound reply refs on day/thread docs, chat:write scope"
```

---

### Task 7: The Slack Sender

**Files:**
- Create: `src/sender.ts`
- Modify: `src/index.ts`
- Test: the repo's test convention (sibling `__tests__` or `.test.ts`) — mock the host `net.fetch`

**Interfaces:**
- Consumes: `SlackClient` (`src/client.ts` — deps object at 78-84 is `{ fetch: NetFetch; token: string; sleep?; now?; requestsPerMinute? }`; `call(method, params)` at 136-139 takes flat scalar `Params` that DROPS `undefined` values; 45 rpm sliding window, 429 Retry-After + transient 5xx/network backoff, and `SlackApiError` come free — `missing_scope` is in `AUTH_ERROR_CODES` and surfaces as message `slack chat.postMessage: missing_scope`, so `/missing_scope/i` on `e.message` works), `SenderContext` (token arrives as `ctx.credentials.password` — the xoxp token lives host-side in the vault; same delivery as `session.credentials()` during pulls).
- Produces: `createSlackSender(host)` returned from `activate` as `senders: { slack: … }`.

Implementation shape (adjust client construction to the real `client.ts` API):

```ts
/**
 * Slack Sender — chat.postMessage into the channel/thread the source doc
 * came from. Reply-only by design: the ref is the opaque metadata.outbound
 * the host round-trips verbatim; this module never receives a free-form
 * recipient. Reachable only from the host's confirmation-gated send
 * pipeline.
 */
import type { HostFor, SendIntent, SendResult, Sender, SenderContext } from './kiagent-contracts';
import { SlackClient, type NetFetch } from './client'; // match client.ts's real export style for NetFetch

interface OutboundRef {
  channel?: string;
  thread_ts?: string;
}

export function createSlackSender(host: HostFor<'net' | 'send'>): Sender {
  return {
    async send(intent: SendIntent, ctx?: SenderContext): Promise<SendResult> {
      const token = ctx?.credentials?.password;
      if (!token)
        throw new Error('no Slack credentials — reconnect the account in Settings');
      const ref = (intent.outboundRef ?? {}) as OutboundRef;
      if (!ref.channel)
        throw new Error(
          'this Slack draft has no reply target — draft from a fresher document (older docs gain reply targets on their next sync)',
        );
      const client = new SlackClient({ fetch: host.net.fetch as NetFetch, token }); // source.ts:771-777 precedent — the NetFetch cast is required
      try {
        const r = (await client.call('chat.postMessage', {
          channel: ref.channel,
          thread_ts: ref.thread_ts, // Params drops undefined values — no spread trick needed
          text: intent.bodyMarkdown,
        })) as { ts?: string };
        return { externalMessageId: r.ts };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/missing_scope/i.test(msg))
          throw new Error(
            'your Slack app token lacks chat:write — re-create the app from the README manifest, reinstall it to the workspace, then reconnect the account in Settings',
          );
        throw e;
      }
    },
  };
}
```

Both credential/scope strings END with `reconnect the account in Settings` — load-bearing (see Global Constraints: core's `AUTH_MARKERS` coupling).

`src/index.ts` (keep the existing default-export + `module.exports` interop pair — `bundle-load.test.ts` pins it):

```ts
const mod = {
  async activate(host) {
    return {
      sources: [createSlackSource(host)],
      senders: { slack: createSlackSender(host) },
    };
  },
} satisfies ExtensionModule<'net' | 'send'>;

export default mod;
module.exports = mod;
```

- [ ] **Step 1: Failing tests** — new `src/__tests__/sender.test.ts`, reusing `source.test.ts`'s patterns (`makeHost(fetchFn)` at 87-93 and `jsonResponse(status, json)` at 36 — they aren't exported, make small local copies): (1) happy path posts to `chat.postMessage` with channel+thread_ts+text and returns `externalMessageId` = ts; (2) missing token → `/reconnect the account in Settings/`; (3) missing ref → `/no reply target/`; (4) `missing_scope` API error → `/chat:write[\s\S]*in Settings/`. Also append to `src/__tests__/bundle-load.test.ts`: `expect(result.senders?.slack).toBeDefined()` (dist is rebuilt by that test itself).
- [ ] **Step 2: FAIL → implement → PASS**, run the connector's full suite + build.
- [ ] **Step 3: Commit**

```bash
git add src/sender.ts src/index.ts src/__tests__
git commit -m "feat: Slack sender — confirmation-gated chat.postMessage into the source channel/thread"
```

---

### Task 8: Connector gates + release handoff

- [ ] **Step 1:** Full connector suite + `npm run typecheck` + production build green. `dist/` is GITIGNORED — the build is a check only, nothing to commit; `bundle-load.test.ts` shells out to the build and (after Task 7) asserts `senders.slack`.
- [ ] **Step 2:** Report with the rollout story (this is the pilot — write it down):
  1. Publish v2.1.0 through the connector's existing release channel (marketplace TOFU pins the new version's bytes on first install).
  2. Existing installs: the update shows the FULL permission list including "Send messages" (consent invalidated by both the version bump and the new cap) — the user must approve before v2.1.0 activates. There is no "adds: send" delta UI; that's the platform's standing behavior.
  3. Existing Slack accounts: users must re-create the Slack app from the updated README manifest (adds `chat:write`), reinstall to the workspace, and reconnect. Until then: connect-time scope check fails on reconnect, and send-time fails with the chat:write guidance.
  4. Only freshly-active channels/days/threads gain `metadata.outbound` after the update — the source re-emits only recent content (latched backfill, 7-day delta window, no reconcile). Old docs stay reply-less (`draft_reply` refuses them with the "no reply target" copy) until a full account re-sync.
  5. Smoke: sync a channel **with NEW activity** (only re-emitted docs carry reply targets) → `draft_reply` on a fresh `slack.thread` doc → review page shows `#channel (thread)` → confirm → message lands in the right thread; `draft_reply` on a stale pre-update doc → "no reply target" refusal; `draft_message` on the slack account → email-only refusal.
- Spec cross-off: phase 8 of §12 — the Sender contract is proven plugin-universal; note any friction found for the next extension sender (that feedback was the point of the pilot).
