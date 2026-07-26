# Slack Pilot Extension Sender Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Spec phase 8 — third-party extensions can ship Senders: a `send` capability + `contributes.senders`, sender calls over the existing extension RPC, piloted in the Slack connector (`chat.postMessage`, reply-only via `metadata.outbound`).

**Architecture:** The survey corrected the spec on three points this plan encodes. (1) There is no per-method permission map to extend — host→extension calls are cap-ungated by design (`HostRouter` gates the other direction only), so the `send` cap is enforced at REGISTRATION time (`registerContributions`, the same place undeclared sources are refused) plus the standing rule that senders are reachable only from the confirmation-gated send pipeline. (2) There is no "permission-delta" machinery — consent is an exact-version + cap-superset coverage check; adding `send` invalidates consent by BOTH prongs, and the ConsentModal shows the full cap list. That satisfies the spec's intent; no delta UX is built here (YAGNI). (3) A manifest section alone silently no-ops (`workers`/`providers` prove it) — `senders` must thread through `Contributions`, the `activate()` return slot, and the child dispatcher, with `PLATFORM_API_VERSION` bumped to 1.2.0 (old children answer an unknown `send` namespace with a clean error; old manifests with `engine: ^1.0.0` keep loading). Credentials reach the extension sender as an explicit `SenderContext` second argument (same trust boundary as `session.credentials()` during pulls — the extension already sees the token). The Slack connector writes `metadata.outbound = { ref: {channel, thread_ts?}, display }` from `toDocument`, which the phase-1 service already honors verbatim end to end (ingestion applies no metadata filtering — verified).

**Tech Stack:** TypeScript, zod (manifest), the existing `RpcEndpoint` transport, jest; Slack Web API via the connector's own rate-limited `SlackClient`.

**Spec:** `docs/superpowers/specs/2026-07-23-unified-outbound-design.md` §6, §12 phase 8.

## Global Constraints

- **Prerequisite:** the phase-1 outbound plan fully landed in kiagent-core. Tasks 1–5: `/Users/edjafarov/work/kiagent-core` (dev). Tasks 6–8: `/Users/edjafarov/work/slack-kia-connector` (its default branch), which vendors the platform contracts (`src/kiagent-contracts.ts`) — the connector compiles only after Task 6 re-vendors.
- Never amend/rebase/reset; never bypass hooks; no `Co-Authored-By`/promo. Subagents do NOT commit. No worktrees for jest.
- Extension senders are reachable ONLY from the send pipeline (after a confirmation gate) — never registered as MCP tools, never callable from the MCP plane. The registry key is the SOURCE id, which preserves "a reply goes back through the same extension that ingested the document" automatically.
- The RPC has NO call timeout (a hung child pends forever) — the host-side sender proxy MUST impose its own (60 s).
- An extension gets a sender registered only when ALL THREE hold: manifest `caps` includes `'send'`, the source id is listed in `contributes.senders`, and the extension actually contributes that source. Anything else → warn + skip (mirror the undeclared-source precedent).
- `metadata.outbound` changes every adopting source's `contentHash` → one-time full-corpus rewrite for Slack docs on next pull. Expected; note it in reports.
- Slack scope reality: adding `chat:write` to the connector's required scopes means EVERY existing Slack account fails the connect-time scope check until the user re-creates the app from the README manifest, reinstalls it, and reconnects. The send path must also fail with that guidance (`missing_scope` at send time).
- Final gates per repo: kiagent-core FULL `npm test` + lint + typecheck; slack-kia-connector's own test/build scripts.

## Parallel Execution Guide (subagent-driven)

Implementers on **sonnet**, one per task:

- **Wave 1 (core):** Task 1 (contracts + manifest + catalog)
- **Wave 2 (core):** Task 2 (RPC + child + host-process) ∥ Task 4 (service lookup + identity guard) — disjoint files
- **Wave 3 (core):** Task 3 (platform registration + SenderRegistry)
- **Wave 4 (core):** Task 5 (core gates)
- **Wave 5 (connector):** Task 6 (vendor + manifest + outbound metadata + scopes)
- **Wave 6 (connector):** Task 7 (the sender)
- **Wave 7 (connector):** Task 8 (gates + release handoff)

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
- Consumes: the `Cap` union (`contracts.ts:511-525`), `CAPS` mirror with its `satisfies readonly Cap[]` drift guard (`manifest.ts:28-38`), `CapSurfaces` (`contracts.ts:608-632` — exhaustive, `HostFor` indexes it), `CAP_CATALOG: Record<Cap, CapInfo>` (`cap-catalog.ts:18` — exhaustive), the `contributes` zod schema (`manifest.ts:69-99`), `ExtensionModule.activate()` return (`contracts.ts:658-663`).
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

// manifest.ts — CAPS gains 'send'; contributes schema gains:
      senders: z.array(z.string()).optional(),
// plus the normalizer (beside sourceContributions):
export function senderContributions(m: Manifest): string[] {
  return m.contributes.senders ?? [];
}

// cap-catalog.ts — CAP_CATALOG gains:
  send: {
    title: 'Send messages',
    detail:
      'Can deliver outbound messages from its accounts — only after you confirm each one through the app’s send flow.',
  },
```

(Match `CapInfo`'s real field names — read the file; `title`/`detail` above are placeholders for whatever the existing entries use.)

- [ ] **Step 1: Failing tests** — append to `manifest.test.ts`:

```ts
  it('accepts the send cap and contributes.senders', () => {
    const m = parseManifest({
      ...VALID_BASE, // the file's existing valid-manifest fixture
      caps: ['net', 'send'],
      contributes: { sources: ['slack'], senders: ['slack'] },
    });
    expect(m.caps).toContain('send');
    expect(senderContributions(m)).toEqual(['slack']);
  });

  it('senders default to empty', () => {
    expect(senderContributions(parseManifest(VALID_BASE))).toEqual([]);
  });
```

(Adapt `parseManifest`/`VALID_BASE` to the file's real helper names.)

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

// host-process.ts — the handle gains (sibling of callTool):
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

- [ ] **Step 1: Failing tests** (in the existing harness style — fake transports/`createInMemoryHostPair` are already used by platform tests):

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
- Registered value is a host-side proxy:

```ts
        deps.senders.register(id, {
          send: async (intent) => {
            const credentials = await deps.store.vault.load(intent.accountId);
            const call = host.callSender(id, intent, { credentials });
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

  (`withTimeout` — add a tiny local helper if the file has none: `Promise.race` with a rejecting timer, timer `unref()`d/cleared.)
- The existing disposer path additionally calls `deps.senders.unregister(id)` for every registered sender id (same lifecycle as sources — including crash-respawn).

Fixtures (model on `fixtures/ext-basic`):
- `ext-sender/manifest.json`: `{ "id": "test.sender", "name": "Sender Fixture", "version": "1.0.0", "engine": "^1.0.0", "entry": "index.js", "caps": ["send"], "contributes": { "sources": ["fixsrc"], "senders": ["fixsrc"] } }` — `index.js` returns a minimal source (copy ext-basic's) plus `senders: { fixsrc: { send: async (intent) => ({ externalMessageId: 'fix-1' }) } }`.
- `ext-sender-nocap/`: identical but `"caps": []` — activation must WARN and register NO sender (the source still registers).

- [ ] **Step 1: Failing tests**

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
- Modify: `src/main/outbound/service.ts`, `src/main/outbound/senders/index.ts`, `src/main/outbound/identity.ts`, `src/main/main.ts`
- Test: `src/main/outbound/__tests__/service.test.ts`, `identity.test.ts` (append)

**Interfaces:**
- Consumes: Task 1's contracts (`SenderContext` — no service change needed for it; the service calls `sender.send(intent)` and bundled senders ignore ctx while extension proxies inject it), `SenderRegistry` (Task 3).
- Produces:

```ts
// service.ts:
export interface SenderLookup {
  get(sourceId: string): Sender | undefined;
  ids(): string[];
}
// createOutboundService deps.senders: Map<string, Sender> | SenderLookup —
// normalized internally (Map → lookup) so every existing phase-1 test and
// call site keeps passing a Map unchanged.

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

// identity.ts — senderAddressFor for a source that is neither imap nor
// gmail throws: `compose is email-only — '<source>' accounts are reply-only`
// (draft_message goes through senderAddressFor, so slack compose fails
// with an honest message instead of a config-shaped one; draft_reply is
// untouched — it rides metadata.outbound).
```

`main.ts`: the service construction becomes `senders: composeSenders(buildBundledSenders({ store: p.store }), p.senders)`.

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
      prefs: fakePrefs,
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
    const slackDocId = /* fetch via store.read.search as the harness does */;
    const r = await svc.draftReply({ documentId: slackDocId, body: 'On it!' });
    expect(r.recipient_display).toBe('#general (thread)');
    const out = await svc.confirmByToken(
      r.confirm_url!.split('/outbox/confirm/')[1],
    );
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

`identity.test.ts` — `senderAddressFor({ source: 'slack', … })` throws `/email-only/`.

- [ ] **Step 2: FAIL.** — `npx jest src/main/outbound -v`.
- [ ] **Step 3: Implement** (normalization helper at the top of `createOutboundService`; the two error-message sites that enumerate supported senders use `lookup.ids()`).
- [ ] **Step 4: PASS** — `npx jest src/main/outbound -v` && `npm run typecheck`.
- [ ] **Step 5: Commit**

```bash
git add src/main/outbound/service.ts src/main/outbound/senders/index.ts src/main/outbound/identity.ts src/main/outbound/__tests__ src/main/main.ts
git commit -m "feat(outbound): SenderLookup — extension senders join the pipeline; compose stays email-only"
```

---

### Task 5: Core gates + handoff

- [ ] **Step 1:** `npm test` && `npm run lint` && `npm run typecheck` — all green.
- [ ] **Step 2:** Report; handoff to the connector tasks: kiagent-core must be released (or at least the vendored contracts snapshot taken from this commit) before Task 6 re-vendors.

---

### Task 6: Slack connector — vendor, manifest, outbound refs, scopes

**Repo:** `/Users/edjafarov/work/slack-kia-connector`.

**Files:**
- Modify: `src/kiagent-contracts.ts`, `manifest.json`, `src/messages.ts`, `src/source.ts`, `README.md`

- [ ] **Step 1: Re-vendor contracts** — copy from the Task-1 core commit into `src/kiagent-contracts.ts`: the widened `Cap` union (+`'send'`), `SendIntent`, `SendResult`, `SenderContext`, `Sender`, and the `senders?` slot on `ExtensionModule.activate`'s return. Keep the file's existing vendoring conventions (it is a curated copy, not an import).

- [ ] **Step 2: Manifest** —

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

- [ ] **Step 3: Outbound refs in `toDocument`** — in `src/messages.ts`, extend the metadata builders (test-first in the repo's own test style: assert the exact `outbound` object on a built day doc and thread doc):
  - day docs (`slack.day`): `outbound: { ref: { channel: channelId }, display: \`#${channelName}\` }`
  - thread docs (`slack.thread`): `outbound: { ref: { channel: channelId, thread_ts: threadTs }, display: \`#${channelName} (thread)\` }`
  - file docs: NO outbound (files aren't a reply target).
  Use the exact variable names in scope at each builder (`slack_channel_id`/`slack_channel_name` sources). NOTE in the report: this changes contentHash for every Slack doc → one-time corpus rewrite on next pull.

- [ ] **Step 4: Scopes** — add `chat:write` to `SLACK_USER_SCOPES` and to the user-token scopes in `SLACK_APP_MANIFEST` (`src/source.ts`), and update the README's app-manifest snippet. The existing connect-time check then demands it (its error text already tells users to re-create the app from the README manifest and reinstall — verify the wording still reads correctly).

- [ ] **Step 5:** Run the connector's test suite + build (`package.json` scripts). Commit:

```bash
cd /Users/edjafarov/work/slack-kia-connector
git add src/kiagent-contracts.ts manifest.json src/messages.ts src/source.ts README.md
git commit -m "feat: send-capable manifest, outbound reply refs on day/thread docs, chat:write scope"
```

---

### Task 7: The Slack Sender

**Files:**
- Create: `src/sender.ts`
- Modify: `src/index.ts`
- Test: the repo's test convention (sibling `__tests__` or `.test.ts`) — mock the host `net.fetch`

**Interfaces:**
- Consumes: `SlackClient` (`src/client.ts` — rate limiting, 429/5xx backoff, `SlackApiError` come free; match its REAL constructor signature when wiring `token` + the host fetch), `SenderContext` (token arrives as `ctx.credentials.password` — the xoxp token lives host-side in the vault; same delivery as `session.credentials()` during pulls).
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
import { SlackClient } from './client';

interface OutboundRef {
  channel?: string;
  thread_ts?: string;
}

export function createSlackSender(host: HostFor<'net' | 'send'>): Sender {
  return {
    async send(intent: SendIntent, ctx?: SenderContext): Promise<SendResult> {
      const token = ctx?.credentials?.password;
      if (!token)
        throw new Error('no Slack credentials — reconnect the account');
      const ref = (intent.outboundRef ?? {}) as OutboundRef;
      if (!ref.channel)
        throw new Error(
          'this Slack draft has no reply target — draft from a fresher document (older docs gain reply targets on their next sync)',
        );
      const client = new SlackClient(/* token + host.net fetch, per client.ts */);
      try {
        const r = (await client.call('chat.postMessage', {
          channel: ref.channel,
          ...(ref.thread_ts ? { thread_ts: ref.thread_ts } : {}),
          text: intent.bodyMarkdown,
        })) as { ts?: string };
        return { externalMessageId: r.ts };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/missing_scope/i.test(msg))
          throw new Error(
            'your Slack app token lacks chat:write — re-create the app from the README manifest, reinstall it to the workspace, and reconnect the account',
          );
        throw e;
      }
    },
  };
}
```

`src/index.ts`:

```ts
const mod = {
  async activate(host) {
    return {
      sources: [createSlackSource(host)],
      senders: { slack: createSlackSender(host) },
    };
  },
} satisfies ExtensionModule<'net' | 'send'>;
```

- [ ] **Step 1: Failing tests** — mock host fetch: (1) happy path posts to `chat.postMessage` with channel+thread_ts+text and returns `externalMessageId` = ts; (2) missing token → `/reconnect/`; (3) missing ref → `/no reply target/`; (4) `missing_scope` API error → `/chat:write/`.
- [ ] **Step 2: FAIL → implement → PASS**, run the connector's full suite + build.
- [ ] **Step 3: Commit**

```bash
git add src/sender.ts src/index.ts src/__tests__
git commit -m "feat: Slack sender — confirmation-gated chat.postMessage into the source channel/thread"
```

---

### Task 8: Connector gates + release handoff

- [ ] **Step 1:** Full connector suite + production build green; verify `dist/index.js` rebuilt.
- [ ] **Step 2:** Report with the rollout story (this is the pilot — write it down):
  1. Publish v2.1.0 through the connector's existing release channel (marketplace TOFU pins the new version's bytes on first install).
  2. Existing installs: the update shows the FULL permission list including "Send messages" (consent invalidated by both the version bump and the new cap) — the user must approve before v2.1.0 activates. There is no "adds: send" delta UI; that's the platform's standing behavior.
  3. Existing Slack accounts: users must re-create the Slack app from the updated README manifest (adds `chat:write`), reinstall to the workspace, and reconnect. Until then: connect-time scope check fails on reconnect, and send-time fails with the chat:write guidance.
  4. Slack corpus rewrites once (metadata.outbound → new contentHash) on the first pull after update.
  5. Smoke: sync a channel → `draft_reply` on a `slack.thread` doc → review page shows `#channel (thread)` → confirm → message lands in the right thread; `draft_message` on the slack account → email-only refusal.
- Spec cross-off: phase 8 of §12 — the Sender contract is proven plugin-universal; note any friction found for the next extension sender (that feedback was the point of the pilot).
