# Get-Started Onboarding Checklist + Client Disconnect — Design

**Date:** 2026-07-06
**Status:** Approved (user confirmed: ship step 1 without %/ETA; disconnect does not un-check latches)
**Origin:** Port of alpha-cent main's "Get started with kia" panel
(`docs/superpowers/specs/2026-06-05-onboarding-get-started-design.md` in alpha-cent),
re-grounded on greenfield kiagent-core signals.

## Overview

A "Get started with KIAgent" 3-step checklist at the top of the Sources screen.
Each step self-checks off a **real observable signal**; the panel disappears
once all three complete (or on manual Skip). Plus: a **Disconnect** button on
the Connection screen's local-client rows (currently connect-only).

Steps:

1. **Add a source** — checks when any account's status reaches `live`
   (first backfill caught up). In-progress meta reflects live account status
   ("Backfilling…"); **no %/ETA** — greenfield has no total-estimate machinery
   (explicit non-goal, can be added later).
2. **Connect your LLM** — checks when the user connects an MCP client via the
   Connection screen's Connect button (`mcp:connect-client`). **Extensible by
   design:** the latch is set through a shared idempotent helper; a future
   remote-MCP OAuth grant handler calls the same helper and lands on the same
   latch.
3. **Try a query** — checks on the first successful `tools/call` served by the
   in-process MCP server. When it latches, all three are done → the panel
   collapses (auto-dismiss).

## Architecture (unchanged from alpha-cent)

**Main process owns detection; durable latches in prefs.** Four nullable
ISO-8601 timestamps in `AppPrefs.onboarding`:

```ts
export interface OnboardingPrefs {
  sourceBackfilledAt: string | null; // step 1 — any account reaches 'live'
  mcpConnectedAt: string | null;     // step 2 — first client connect (any transport, now or future)
  firstQueryAt: string | null;       // step 3 — first successful tools/call served
  dismissedAt: string | null;        // manual Skip
}
```

Latches are **"ever completed"**: disconnecting a client, removing a source,
or an account regressing to `backfilling` never un-checks a step.

One idempotent helper in `core/prefs.ts`:

```ts
markOnboardingOnce(prefs: Prefs, key: keyof OnboardingPrefs): Promise<boolean>
// writes now() only if the latch is still null; returns whether it wrote
```

`prefs.onChange` already patches `AppState.prefs` and broadcasts
`push:app-state` (main.ts), so the renderer live-updates with **zero new IPC
channels** for the checklist itself.

## Latch points

| Latch | Where | Startup reconciliation |
|---|---|---|
| `sourceBackfilledAt` | `p.engine.project(...)` callback in main.ts: any `state.accounts[].account.status === 'live'` | boot-time check of `p.store.read.accounts()` |
| `mcpConnectedAt` | `mcp:connect-client` IPC handler after successful `connectClient` | after `startMcp`: any `clients()` entry already `connected` |
| `firstQueryAt` | new optional `onCallOk` callback threaded `McpDeps.onToolCall` → `attachToolHandlers`, fired on successful tool call | none (in-memory event; pre-existing users latch on next query, and the step is skippable) |

**Known limitation (accepted):** stdio clients (Claude Desktop, Codex) query
through the separate `mcp/stdio-entry.ts` process, which cannot safely write
the main process's prefs.json — their queries do not latch step 3. HTTP
clients (Claude Code, Cursor, VS Code) latch it. The step remains skippable;
revisit if stdio-first users complain.

> **Update:** this limitation was removed by the 2026-07-06 MCP activity feed
> design (`2026-07-06-mcp-activity-feed-design.md`) — stdio queries now latch
> step 3 via the activity-file boot replay/tail watched in main.

## Renderer

`GetStartedPanel` (new, `src/renderer/screens/Sources/`) rendered at the top
of `SourcesList`. Pure derive logic in `onboarding-steps.ts` (unit-tested):

```
visible = dismissedAt == null && !(step1Done && step2Done && step3Done)
```

- Reads `useAppState(s => s.prefs.onboarding)` + `s.accounts`.
- Step 1 meta: done → "N source(s) connected"; no accounts → prompt to add
  one; account backfilling → "Backfilling — syncing your history…"; else
  "Setting up your first source…".
- Step 2 has an "Open Connection tab" button → shell `navigate('connection')`.
  Navigation is threaded: `screen-registry.tsx` passes `navigate` into
  `<Sources/>` → `SourcesList` → panel (registry factories already receive it).
- Skip button → `prefs:patch { onboarding: { ...current, dismissedAt: now } }`.
- CSS: `.ob-panel/.ob-head/.ob-title/.ob-sub/.ob-checklist/.ob-step*` ported
  from alpha-cent main's `Sources.css` (checklist subset only — no prompts
  grid; greenfield has no IdeasPanel). Done icon is a plain ✓ glyph (the
  greenfield sprite has no `check` icon).

## Disconnect (Connection screen)

- `ClientAdapter` (core/mcp/clients.ts) gains `disconnect(text): string` —
  removes the `KIAgent` entry from the JSON container / TOML `mcp_servers`,
  preserving everything else. Same `applyConfigChange` path (backup + atomic
  rename; malformed config → `{ok:false}`, file untouched).
- `McpServerHandle` gains `disconnectClient(id)`.
- New IPC channel `mcp:disconnect-client` (shared/ipc.ts + main.ts handler).
- `LocalClients.tsx`: connected rows show the "Connected" pill **plus a
  Disconnect button**; both actions share the busy/refresh flow.

## Non-goals

- Backfill %/ETA in step 1 (no estimate machinery in greenfield).
- Settings toggle to re-show after dismissal.
- Step-3 latch for out-of-process stdio queries. *(Since delivered by the
  2026-07-06 MCP activity feed design, `2026-07-06-mcp-activity-feed-design.md`.)*
- Telemetry on onboarding progression.

## Testing

- prefs: onboarding defaults, sanitize (garbage → null, legacy file without
  the block), patch deep-merge preserves sibling latches, `markOnboardingOnce`
  set-once semantics.
- registry: `onCallOk` fires on successful tool call only (not unknown tool,
  not thrown error).
- clients: per-adapter `disconnect(connect(null))` round-trip → not connected;
  foreign entries preserved; malformed config → isConnected false, disconnect
  transform throws inside applyConfigChange without clobbering.
- onboarding-steps: derive visibility/step states; step1Meta variants.
