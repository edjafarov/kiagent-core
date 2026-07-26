# Outbound Remote Confirm Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Spec phase 4 — outbound drafting works over the remote MCP transport: remote tool calls mint `https://<device-subdomain>/outbox/confirm/<token>` links instead of being refused, and the confirm/cancel pages are served over the tunnel, so a send can be approved from a phone.

**Architecture:** Two-repo change. In **kiagent-core**: the outbound service becomes transport-aware (`setRemoteBaseUrl`; the phase-1 blanket remote refusal survives only as the no-base-url case; `createdVia: 'mcp-remote'`), the routes module gains a `handleRemote` that exposes ONLY confirm/cancel (never `/outbox/api`), and `MainProcessApi` gains an `outbound` member — the survey confirmed core has no seam for the device hostname, so the product extension must push it in and pull the request handler out. In **alpha-cent**: the `extensions/remote-mcp` privileged extension mounts `/outbox` on its 7422 Router (no auth "carve-out" needed — that Router applies JWT per-route to `/mcp` only, and the confirm pages are HMAC-token-gated by construction, same posture as the unauthenticated `/oauth/consent` page) and pushes `https://<hostname>` into core when the HTTPS server is up.

**Tech Stack:** TypeScript, AsyncLocalStorage transport seam (phase-1), Node http/https, jest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-23-unified-outbound-design.md` §5 (Confirm URLs — Routing), §12 phase 4.

## Global Constraints

- **Prerequisite:** the phase-1 outbound plan (`2026-07-23-unified-outbound-phase1.md`) fully landed in kiagent-core. Tasks 1–4 run in `/Users/edjafarov/work/kiagent-core` (branch `dev`); Tasks 5–6 run in `/Users/edjafarov/work/alpha-cent` (branch `dev`) and additionally require the Task-1–4 core to be staged there (bump `core.lock` to the new core commit, re-stage `build/.core` via `npm run start:product -- --force`).
- Never amend/rebase/reset; never bypass hooks; no `Co-Authored-By`/promo in commits. Subagents do NOT commit — orchestrator commits serially. No worktrees for jest.
- `/outbox/api` (the stdio-proxy JSON op endpoint) must NEVER be reachable remotely — it creates drafts without any token. `handleRemote` allowlists confirm/cancel paths only.
- GET never mutates; POST-behind-button holds on the remote pages exactly as on loopback (same `pages.ts` output).
- Confirm tokens appear in URL paths. Never log a full `/outbox/...` path on the remote server — log outcomes only.
- The remote server's rate limiter keys on a coarse client identity (tunnel makes all callers look alike — documented in `rate-limit.ts:32-42`); treat it as a throttle on the surface, not per-attacker.
- The extension must feature-detect `mainApi.outbound` (older core in `build/.core` → member absent → remote outbound simply off; nothing crashes).
- Final gates per repo: FULL `npm test` + `npm run lint` + `npm run typecheck` in kiagent-core; the alpha-cent equivalents (`npm test`, lint/typecheck scripts) plus the extension bundle rebuild.

## Parallel Execution Guide (subagent-driven)

Implementers on **sonnet**, one per task, same checkout:

- **Wave 1 (kiagent-core):** Task 1 (transport-aware service) ∥ Task 2 (`handleRemote` routes) — disjoint files
- **Wave 2 (kiagent-core):** Task 3 (MainProcessApi.outbound + wiring)
- **Wave 3 (kiagent-core):** Task 4 (core gates + staging handoff)
- **Wave 4 (alpha-cent, after core staged):** Task 5 (extension mount + lifecycle)
- **Wave 5 (alpha-cent):** Task 6 (gates + phone smoke)

## File Structure

| Repo | File | Change | Responsibility |
| --- | --- | --- | --- |
| core | `src/main/outbound/service.ts` | modify | `setRemoteBaseUrl`, transport-aware minting, `createdVia` |
| core | `src/main/outbound/routes.ts` | modify | `handleRemote` (confirm/cancel only) |
| core | `src/main/main-api.ts` | modify | `outbound` member |
| core | `src/main/main.ts` | modify | thread service + routes into the main API |
| alpha-cent | `extensions/remote-mcp/src/main-api.ts` | modify | type mirror + feature detect |
| alpha-cent | `extensions/remote-mcp/src/server/index.ts` | modify | mount `/outbox` GET+POST |
| alpha-cent | `extensions/remote-mcp/src/bootstrap.ts` | modify | push/clear the base URL |

---

### Task 1: Core service — transport-aware URL minting

**Files:**
- Modify: `src/main/outbound/service.ts`
- Test: `src/main/outbound/__tests__/service.test.ts` (append)

**Interfaces:**
- Consumes: `runWithTransport`/`currentTransport` from `@main/core/mcp/transport-context` (phase-1), the phase-1 `assertLocal` + URL-mint internals.
- Produces (used by Tasks 3, 5):

```ts
// OutboundService gains (beside setBaseUrl):
/** Product pushes the public device base URL (https://<device-subdomain>)
 *  when the remote HTTPS server is up, null when it goes down. */
setRemoteBaseUrl(url: string | null): void;
```

Behavior contract (encode in tests):
- Remove the blanket `assertLocal` refusal. Replace with a `baseFor()` helper used by EVERY confirm-URL mint (draft results AND `listOutbox` re-links): `currentTransport() === 'remote'` → the remote base, throwing when it is unset/null with: `Outbound drafting over the remote connection needs remote access fully set up on the KIAgent machine — or use an MCP client on that machine directly.`; `'local'` → the loopback base (unchanged).
- Draft rows created while `currentTransport() === 'remote'` get `createdVia: 'mcp-remote'`.
- The URL is chosen at MINT time, per call: a draft created locally but listed via `list_outbox` on the remote transport gets a remote URL (the user is on their phone), and vice versa. The token/signature is transport-independent — only the origin differs.
- If the mode-C plan has already landed (`sendDraft` exists): `sendDraft` mints no URLs and keeps working on both transports unchanged — do not add a gate to it.

- [ ] **Step 1: Write the failing tests**

Append to `src/main/outbound/__tests__/service.test.ts` (harness from phase-1; import `runWithTransport` from `../../core/mcp/transport-context`):

```ts
  describe('remote transport', () => {
    const REMOTE = 'https://ig6uj5qu.localkiagent.com';

    it('refuses remote drafting until a remote base url is pushed', async () => {
      await expect(
        runWithTransport('remote', () =>
          service.draftReply({ documentId: docId, body: 'Yo' }),
        ),
      ).rejects.toThrow(/remote access fully set up/i);
    });

    it('mints remote urls and tags createdVia once the base url is set', async () => {
      service.setRemoteBaseUrl(REMOTE);
      const r = await runWithTransport('remote', () =>
        service.draftReply({ documentId: docId, body: 'Yo' }),
      );
      expect(r.confirm_url).toMatch(
        /^https:\/\/ig6uj5qu\.localkiagent\.com\/outbox\/confirm\//,
      );
      expect((await store.outbox.get(r.draft_id))?.createdVia).toBe('mcp-remote');
    });

    it('list_outbox re-links per the CURRENT transport', async () => {
      service.setRemoteBaseUrl(REMOTE);
      const r = await service.draftReply({ documentId: docId, body: 'Yo' });
      expect(r.confirm_url).toContain('http://127.0.0.1');
      const remoteListing = await runWithTransport('remote', () =>
        service.listOutbox({}),
      );
      const item = remoteListing.find((x) => x.draft_id === r.draft_id);
      expect(item?.confirm_url).toContain('ig6uj5qu.localkiagent.com');
      const localListing = await service.listOutbox({});
      expect(
        localListing.find((x) => x.draft_id === r.draft_id)?.confirm_url,
      ).toContain('http://127.0.0.1');
    });

    it('clearing the remote base restores the refusal', async () => {
      service.setRemoteBaseUrl(REMOTE);
      service.setRemoteBaseUrl(null);
      await expect(
        runWithTransport('remote', () => service.listOutbox({})),
      ).rejects.toThrow(/remote access fully set up/i);
    });
  });
```

Also UPDATE the phase-1 remote-gate test (the one asserting the `local-only` refusal message) — its assertion becomes the new no-base-url message; keep the test, it now pins the unset-base behavior.

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/main/outbound/__tests__/service.test.ts -v`
Expected: FAIL — `setRemoteBaseUrl` missing; old refusal fires with the old message.

- [ ] **Step 3: Implement** per the behavior contract: add `let remoteBaseUrl: string | null = null;`, `setRemoteBaseUrl`, replace `assertLocal()` + the loopback-base read with one `baseFor()` used by every mint site, and compute `createdVia` from `currentTransport()` at row creation.

- [ ] **Step 4: Run the outbound suite, expect PASS**

Run: `npx jest src/main/outbound -v` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/edjafarov/work/kiagent-core
git add src/main/outbound/service.ts src/main/outbound/__tests__/service.test.ts
git commit -m "feat(outbound): transport-aware confirm urls — remote base + createdVia mcp-remote"
```

---

### Task 2: Core routes — `handleRemote` (confirm/cancel only)

**Files:**
- Modify: `src/main/outbound/routes.ts`
- Test: `src/main/core/mcp/__tests__/outbound-routes.test.ts` (append)

**Interfaces:**
- Consumes: the phase-1 route internals (`peekByToken`/`confirmByToken`/`cancelByToken` dispatch, `pages.ts` renderers).
- Produces (used by Task 3):

```ts
// createOutboundRoutes(outbound) additionally returns:
/** Remote-transport entry: serves ONLY GET/POST /outbox/confirm/<token>
 *  and POST /outbox/cancel/<token>. Everything else under /outbox/ —
 *  including /outbox/api — returns false (caller 404s). No Host/Origin
 *  loopback check: the remote server has real TLS Host semantics and the
 *  pages are HMAC-token-gated. */
handleRemote(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean>;
```

`handleRemote` parses the path itself (`new URL(req.url ?? '/', 'http://x')`) — the remote Router hands over a raw request with no pre-parsed URL. Internally it MUST reuse the exact same per-path handlers `handle` uses (extract shared functions if phase-1 landed them inline) — pages, outcomes, status codes byte-identical.

- [ ] **Step 1: Write the failing tests**

Append to `src/main/core/mcp/__tests__/outbound-routes.test.ts`. `handleRemote` takes raw req/res; test it through a throwaway plain-HTTP server (node `http`, port 0) whose listener is `(req, res) => void routes.handleRemote(req, res).then((h) => { if (!h) { res.writeHead(404); res.end(); } })` — build `routes = createOutboundRoutes(service)` in the test:

```ts
  describe('handleRemote', () => {
    let remoteBase: string;
    let remoteSrv: http.Server;

    beforeAll(async () => {
      const routes = createOutboundRoutes(service);
      remoteSrv = http.createServer((req, res) => {
        void routes.handleRemote(req, res).then((handled) => {
          if (!handled) {
            res.writeHead(404);
            res.end();
          }
        });
      });
      await new Promise<void>((r) => remoteSrv.listen(0, '127.0.0.1', r));
      const addr = remoteSrv.address() as net.AddressInfo;
      remoteBase = `http://127.0.0.1:${addr.port}`;
    });

    afterAll(() => remoteSrv.close());

    it('serves the review page and confirms via POST', async () => {
      const r = await service.draftReply({ documentId: docId, body: 'Remote!' });
      const token = r.confirm_url!.split('/outbox/confirm/')[1];
      const page = await fetch(`${remoteBase}/outbox/confirm/${token}`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('Remote!');
      const sent = await fetch(`${remoteBase}/outbox/confirm/${token}`, {
        method: 'POST',
      });
      expect(sent.status).toBe(200);
      expect((await store.outbox.get(r.draft_id))?.status).toBe('sent');
    });

    it('never exposes /outbox/api remotely', async () => {
      const res = await fetch(`${remoteBase}/outbox/api`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'ping' }),
      });
      expect(res.status).toBe(404);
    });

    it('cancel works and unknown outbox paths 404', async () => {
      const r = await service.draftReply({ documentId: docId, body: 'bye' });
      const token = r.confirm_url!.split('/outbox/confirm/')[1];
      const cancelled = await fetch(`${remoteBase}/outbox/cancel/${token}`, {
        method: 'POST',
      });
      expect(cancelled.status).toBe(200);
      expect((await store.outbox.get(r.draft_id))?.status).toBe('discarded');
      expect((await fetch(`${remoteBase}/outbox/bogus`)).status).toBe(404);
    });
  });
```

(Add `import http from 'http';` / `import net from 'net';` to the test file's imports. `sendMock` from the harness makes the confirm POST succeed.)

- [ ] **Step 2: Run to verify failure**

Run: `npx jest src/main/core/mcp/__tests__/outbound-routes.test.ts -v`
Expected: FAIL — `handleRemote` is not a function.

- [ ] **Step 3: Implement** in `routes.ts`: extract the per-path handlers (`getConfirm(token)`, `postConfirm(token)`, `postCancel(token)` → status + html) so `handle` (loopback) and `handleRemote` share them; `handleRemote` allowlists exactly `GET|POST /outbox/confirm/<token>` and `POST /outbox/cancel/<token>`, returns `false` otherwise.

- [ ] **Step 4: Run tests, expect PASS**

Run: `npx jest src/main/core/mcp src/main/outbound -v` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/outbound/routes.ts src/main/core/mcp/__tests__/outbound-routes.test.ts
git commit -m "feat(outbound): handleRemote — confirm/cancel over the remote transport, /outbox/api excluded"
```

---

### Task 3: Core — `MainProcessApi.outbound` + wiring

**Files:**
- Modify: `src/main/main-api.ts`, `src/main/main.ts`
- Test: extend the existing main-api test if one exists (`grep -rn "main-api" src/main/__tests__ src/main/*.test.ts`); otherwise the wiring is covered by typecheck + Task 4's suite.

**Interfaces:**
- Consumes: Task 1 (`setRemoteBaseUrl`), Task 2 (`handleRemote`).
- Produces (consumed by the alpha-cent extension, Task 5) — in `MainProcessApi` (`src/main/main-api.ts`, members currently `identity/vault/mcp/paths/app/ui`):

```ts
  /** Outbound confirm-over-tunnel seam (spec phase 4). Optional so older
   *  product bundles keep working against the type. */
  outbound?: {
    /** Push the public device base URL (https://<device-subdomain>) when the
     *  remote HTTPS server comes up; null when it goes down. */
    setRemoteBaseUrl(url: string | null): void;
    /** Serve an /outbox/* request that arrived over the tunnel. Only
     *  confirm/cancel are handled; false = not ours, caller 404s. */
    handleRequest(
      req: import('http').IncomingMessage,
      res: import('http').ServerResponse,
    ): Promise<boolean>;
  };
```

- [ ] **Step 1: Implement**

- `src/main/main-api.ts`: add the member to the interface and to the factory — the factory deps gain `outbound?: { service: OutboundService; routes: { handleRemote(req, res): Promise<boolean> } }` and the built object gains:

```ts
    outbound: deps.outbound
      ? {
          setRemoteBaseUrl: (url) => deps.outbound!.service.setRemoteBaseUrl(url),
          handleRequest: (req, res) => deps.outbound!.routes.handleRemote(req, res),
        }
      : undefined,
```

- `src/main/main.ts`: at the phase-1 `createOutboundService` site, additionally build `const outboundRoutes = createOutboundRoutes(outbound);` (import from `./outbound/routes`) and pass `outbound: { service: outbound, routes: outboundRoutes }` into the `createMainProcessApi(...)` deps (find the call site — it feeds privileged extensions' `extras.mainProcess`). NOTE: `createOutboundRoutes` is cheap (a closure over the service); the loopback server keeps building its OWN instance inside `startMcp` — the two instances share all state through the service, so this is safe.

- [ ] **Step 2: Gates**

Run: `npm run typecheck` — Expected: clean.
Run: `npx jest src/main -v --silent` (or the targeted main-api test if it exists) — Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/main/main-api.ts src/main/main.ts
git commit -m "feat(outbound): MainProcessApi.outbound — remote base-url push + tunnel request handler"
```

---

### Task 4: Core gates + staging handoff

- [ ] **Step 1:** Run `npm test` && `npm run lint` && `npm run typecheck` — all green.
- [ ] **Step 2:** Report, including the cross-repo handoff: in `/Users/edjafarov/work/alpha-cent`, bump `core.lock` to the new kiagent-core commit and re-stage `build/.core` (`npm run start:product -- --force`) BEFORE starting Task 5. No overlay IPC channels change in this plan.

---

### Task 5: alpha-cent extension — mount `/outbox`, push the base URL

**Repo:** `/Users/edjafarov/work/alpha-cent` (prereq: Task 4 handoff done).

**Files:**
- Modify: `extensions/remote-mcp/src/main-api.ts`, `extensions/remote-mcp/src/server/index.ts`, `extensions/remote-mcp/src/bootstrap.ts`, `extensions/remote-mcp/src/index.ts`
- Test: sibling `__tests__` files — mirror the harness of the nearest existing test (`extensions/remote-mcp/src/server/__tests__/` if present, else the `auth/__tests__` style)

**Interfaces:**
- Consumes: `MainProcessApi.outbound` (Task 3), the Router (`server/router.ts`), `createRateLimitMiddleware` (`server/middleware/rate-limit.ts`), the hostname available as `opts.hostname` inside `startRemoteHttpsServer` (`server/index.ts:19`) and via `certManager` meta (`cert/cert-manager.ts` `loadHostname`).
- Produces: `https://<device-subdomain>/outbox/confirm/<token>` reachable end to end; core told the base URL whenever the 7422 server is up.

Router gotchas (from `server/router.ts` — these WILL bite if ignored):
- Register the prefix as `'/outbox'` **with `{ exact: false }`** — bare `'/outbox'` defaults to exact-match and never matches `/outbox/confirm/<token>`; `'/outbox/'` is a different trap (`matching` tests `url === '/outbox/'` or `startsWith('/outbox//')`).
- Routes are method-scoped and a non-matching method is a 405 — register GET **and** POST.
- Handlers get a raw `IncomingMessage` (query already stripped, no body/param parsing) — `handleRequest` does its own path parsing, so just delegate.

- [ ] **Step 1: Write the failing tests** (mirror the nearest server/bootstrap test harness; the behaviors to pin):

1. With an `outboundHandler` provided, `GET /outbox/confirm/x` reaches it; when it resolves `false` the response is 404; `POST /outbox/confirm/x` also reaches it.
2. Without an `outboundHandler` (older core → `mainApi.outbound` undefined), `/outbox/*` 404s and nothing throws at startup.
3. POST `/outbox/*` is rate-limited (the `createRateLimitMiddleware` composition — assert a 429 after exhausting the window, same technique as the existing `/oauth/register` rate-limit test if one exists).
4. Bootstrap: when the HTTPS server comes up, `mainApi.outbound.setRemoteBaseUrl` is called with `https://<hostname>`; on stop it is called with `null`. (Fake `mainApi` object; assert call order.)

- [ ] **Step 2: Implement**

- `extensions/remote-mcp/src/main-api.ts`: extend the local `MainProcessApi` mirror with the OPTIONAL `outbound` member exactly as Task 3 declares it (same shape, `import('http')` types). `assertMainApi` keeps checking `apiVersion === 1` only — the member is feature-detected at use sites (`mainApi.outbound?.…`).
- `extensions/remote-mcp/src/server/index.ts`: `StartRemoteHttpsServerOpts` gains `outboundHandler?: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>;`. Inside `startRemoteHttpsServer`, after the `/healthz` registration (line ~43):

```ts
  // Outbound confirm pages (spec phase 4). Unauthenticated at the router —
  // like /oauth/consent — because each page is gated by its single-use
  // signed token; GET renders only, the send is always a POST. /outbox/api
  // is filtered out core-side (handleRemote). Never log the path: the
  // token IS the capability.
  if (opts.outboundHandler) {
    const outboundHandler = opts.outboundHandler;
    const serve: Handler = async (req, res) => {
      const handled = await outboundHandler(req, res);
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    };
    const limited = createRateLimitMiddleware({ max: 30, windowMs: 60_000 });
    router.on('GET', '/outbox', serve, { exact: false });
    router.on('POST', '/outbox', limited(serve), { exact: false });
  }
```

  (`limited(serve)` assumes the middleware is handler-wrapping — verify against the `/oauth/register` registration at lines ~55-68 and copy ITS composition shape exactly if it differs; do not invent a new one. GET stays un-throttled: page renders are read-only and a coarse limiter could lock a legitimate user out of viewing their own draft.)
- `extensions/remote-mcp/src/index.ts`: where `createRemoteMcpStack({ …, mcpHandler: mainApi.mcp.createMcpHandler(), … })` is built (~line 126), thread `outboundHandler: mainApi.outbound ? (req, res) => mainApi.outbound!.handleRequest(req, res) : undefined` through to `startRemoteHttpsServer` (via `bootstrap.ts` `startRemoteHttpsServer({ … })` at ~line 549 — add the field to the intermediate opts types along the way).
- `extensions/remote-mcp/src/bootstrap.ts`: immediately after the HTTPS server is up (the `[remote-mcp] https server up` point, ~line 576): `mainApi.outbound?.setRemoteBaseUrl(\`https://${hostname}\`);` — and in the transport stop/shutdown path (wherever the https listener is closed / the stack is stopped): `mainApi.outbound?.setRemoteBaseUrl(null);`. Thread `mainApi` (or just the `outbound` member) into bootstrap the same way `mcpHandler` already travels.

- [ ] **Step 3: Rebuild the extension bundle**

The loaded artifact is `extensions/remote-mcp/dist/index.js` — src edits are inert until rebuilt. Run the extension's build (check `extensions/remote-mcp/package.json` scripts; the repo's product staging also rebuilds — use whichever the repo's docs/scripts prescribe) and verify `dist/index.js` changed.

- [ ] **Step 4: Run the alpha-cent test suite**

Run: `npm test` (repo root) — Expected: PASS including the new extension tests.

- [ ] **Step 5: Commit**

```bash
cd /Users/edjafarov/work/alpha-cent
git add extensions/remote-mcp
git commit -m "feat(remote-mcp): serve outbound confirm pages over the tunnel + push device base url into core"
```

(Do NOT sweep the unrelated untracked `docs/*.md` files into this commit.)

---

### Task 6: alpha-cent gates + smoke

- [ ] **Step 1:** Full alpha-cent gates: `npm test`, lint, typecheck — green.
- [ ] **Step 2:** Report with the manual smoke checklist:
  1. Remote-enabled device, registered subdomain: connect claude.ai (remote MCP) → `draft_reply` → result URL is `https://<subdomain>.localkiagent.com/outbox/confirm/…`.
  2. Open that URL **on a phone** → review page renders → Confirm → "Message sent"; row `createdVia: 'mcp-remote'`.
  3. `curl -X POST https://<subdomain>/outbox/api -d '{"op":"ping"}'` → 404.
  4. Disable Remote in the app → remote drafting refuses with the not-set-up message; loopback drafting still works.
  5. Link pasted into a chat: verify the unfurler fetch (GET) does NOT send — row stays `draft` until the button POST.
- Known exposure to restate in the report (spec §5): the confirm URL lives in the conversation transcript; TTL + single-use + POST-behind-button bound it.
- Spec cross-off: phase 4 of §12.
