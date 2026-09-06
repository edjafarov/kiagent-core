# Extension platform track — sequencing and shared decisions (2026-09-06)

Milestone: **Extension platform: views, files, feed, lanes**.
Issues: #107, #112, #113, #106, #104, #105.

The six issue bodies ARE the specifications — surface, algorithm and acceptance
criteria live there and are not restated here. This document exists to answer
what they individually cannot: in what order the six land, which of them may
not be in flight at the same time, and the handful of decisions that either
span two issues or that an issue deliberately left open.

Base: `dev` at `8bc2c670` (v0.85.0). Every file reference below is against that
commit.

## What the track delivers

An extension today can read the corpus, own a private database, call inference
on the interactive lane, contribute a Source, contribute MCP tools and notify.
It cannot pace itself against the user, learn which model answered it, follow
the corpus as it changes, touch a user's files, or show a screen. This track
closes those five gaps and, along the way, gives one existing renderer surface
(the outbox) the listing shape a dashboard needs.

## Order, and why

Ordering is by what each issue unblocks, not by size.

| Wave | Issues | Release | Unblocks |
|---|---|---|---|
| 1 | **#107** lanes, deterministic profile, `describe()`, `countBy` · **#112** emitter identity on events · **#113** outbox listing, count, addresses, push | v0.86.0 | Consumers that classify at corpus scale can stop competing with the user, and can key a persisted result cache on a model identity they learn BEFORE the call. Peer-published items become attributable. A pending-draft badge and a drafts-backed dashboard row become exact instead of best-effort. |
| 2 | **#106** durable change feed | v0.87.0 | Any consumer that must see every document AND every revision — `query.search` orders by origin date with offsets and has no seq cursor, so it silently misses backfills, revisions and purges. |
| 3 | **#104** contributed views · **#105** `host.files` | v0.88.0 | Moves feature work out of the bundled tier: a screen and a file mutation without a build-time patch of core's channel lists. Nothing in the first shipping increment of the downstream product needs either. |

Three points about the order that are not obvious:

- **#112 precedes #106 for a security reason, not because it is small.** Feed
  batches are delivered as host events. Once a listener receives host-stamped
  emitter metadata, `feed.batch` arrives with `from === 'platform'`, which no
  extension can forge (`host-surfaces.ts:196-200` already reserves the name;
  #112 makes the stamping trustworthy). Shipping the feed first would ship a
  delivery path on which a peer extension can impersonate the host for one
  release.
- **#113 is in wave 1 although it is unrelated to the platform.** It touches
  `src/main/outbound/**`, `src/main/core/store/outbox.ts`, `src/shared/ipc.ts`
  and `src/main/main.ts` — disjoint from every file waves 1–3 touch elsewhere.
  It is therefore a parallel lane, and it unblocks downstream work earlier than
  #106 does.
- **#104 and #105 are last and their line-level plan is written when wave 2
  lands.** Both are migrations of an existing capability rather than new
  capability, and #104's broker design should be settled against a live feed
  consumer rather than in the abstract.

Out of this track, same milestone: #108 (`host.ui.attention`), #109
(grammar-constrained output, explicitly not a prerequisite for anything), #110
(platform docs and SDK), #111 (`host.schedule`). #108 in particular is
deliberately after #112: a host-aggregated attention surface is only worth
building once the host can tell listeners who published an item.

## Shared files — one PR at a time

Four of the six issues add rows to the same tables, and `cap-table-completeness.test.ts`
pins them against each other:

- `src/shared/contracts.ts` (`CapSurfaces`, `Inference`, `EventMeta`) — #107, #112, #106, #105
- `src/main/platform/host-surfaces.ts` — #107, #106, #105
- `src/main/platform/host-router.ts` (`NS_CAP`) — #106, #104
- `src/main/platform/extension-host-entry.ts` (`NS_METHODS`) — #107, #106, #104, #105
- `src/main/platform/manifest.ts` (`Cap`, `CAPS`) — #106, #104
- `src/renderer/components/cap-catalog.ts` — #106, #104, #105
- `src/shared/extension-rpc.ts` — #112, #104
- `docs/architecture/extension-platform.md` — all of them

**Rule:** at most one PR touching that set is open at a time. Within wave 1 that
means #107 merges before #112 opens; #113 may run in parallel throughout because
it touches none of them. Wave 2 and wave 3 are single-PR waves by construction.

## Decisions

**D1 — the deterministic profile keeps its 512-token ceiling.** A caller that
compiles a long free-text description into a policy needs several thousand
tokens, which the `deterministic` profile refuses. That is the correct outcome
and not a reason to raise the cap: the cap is a guard against greedy decoding
running away on a long generation, and long generations are exactly where it
runs away. Classification prompts — a fixed-order key/value answer whose budget
is a function of the number of response lines — sit two orders of magnitude
below the cap. A compile step is one user-triggered call per save and belongs on
the interactive lane with `profile: 'default'`; its repeatability comes from the
caller persisting the compiled artifact, which #107 already states is where
repeatability lives. #107's acceptance criterion (`maxTokens > 512` under
`deterministic` rejects before the request) stands unchanged.

**D2 — `platform.lane` is emitted from a plane callback, not from the caller of
`setBackgroundOpen`.** The plane holds no reference to the event bus, and today
the only writer is `src/main/main.ts:1088`, which re-evaluates
`backgroundLaneOpen(p)` on a schedule — so emitting there would fire on every
evaluation rather than on a transition, and would put platform knowledge in
`main.ts`. Instead `InferencePlane` gains `onLaneChange(cb: (state: LaneState) => void): () => void`,
invoked from inside `setBackgroundOpen` only when the boolean actually changed;
the extension platform subscribes once at boot and emits `platform.lane { state }`
through `bus.emit('platform', …)`. `host.inference.lane()` resolves through the
existing `backgroundLaneState(platform)` helper (`boot.ts:386-405`), so the
event and the query cannot disagree.

**D3 — `generation` starts at a random positive integer, and the seed is
injectable.** A restart must not be mistakable for continuity, which is why the
value is not persisted and does not start at 1. Tests need it fixed, so
`createInference(logs, opts?: { generationSeed?: number })`; production passes
nothing and gets the random start.

**D4 — #106's migration is ladder step v4, appended.** The ladder is currently
v1, v2, v3 (`schema.ts:429,584,685`). Wave 2 appends v4: three
`ALTER TABLE consumers ADD COLUMN` statements (`snapshot_cursor TEXT`,
`snapshot_high_water INTEGER`, `snapshot_generation INTEGER`). Existing steps are
never renumbered, merged or collapsed — a collapsed ladder has already cost one
shipped build a fail-closed boot with no window. `ALTER TABLE … ADD COLUMN` is
legal inside the per-version transaction `migrate()` already wraps each step in
(`schema.ts:793-794`), so this needs no separate step and no rebuild.

**D5 — extension consumer names are host-namespaced and never collide with
core's.** `consumers.name` is a bare primary key shared with the engine's own
workers (`workerConsumerName`, `engine.ts:1486`). The host writes
`ext:<extensionId>:<name>` and rejects any name from an extension that already
contains a colon, so no extension can address a core worker's cursor.

**D6 — wave 3 adds a scoped Windows CI job.** #105's name-collision criteria
(reserved names, trailing dot and space, case-insensitive collision) cannot run
on today's CI, which is a single `ubuntu-latest` job
(`.github/workflows/kiagent-core-ci.yml:28`). Wave 3 adds a `windows-latest` job
running typecheck plus the scoped-files suite only — not the full suite; the
native rebuild and the Electron-dependent suites are out of budget. If that job
is flaky across its first ten runs it becomes non-blocking and its criteria move
to a documented manual check, recorded in the wave 3 plan rather than silently
dropped.

**D7 — additive-only on the renderer wire.** #113 and #104 both add channels.
`INVOKE_CHANNELS` / `PUSH_CHANNELS` derive the preload allow-list, and a
downstream repo pins those lists in its own tests, so every channel added here
is additive and no existing channel's shape changes. `outbox:list` with today's
payload must return exactly what it returns today; wave 1 pins that as a
regression test rather than trusting the type.

## Downstream, at pin time

Consumers in the product repo move on their own schedule; each wave's release
notes name what became available.

- After v0.86.0: classification callers pass `lane: 'background'` and
  `profile: 'deterministic'` and start keying their persisted decisions on
  `describe().modelId`, replacing whatever placeholder they used; a compile step
  stays on `default`/interactive per D1. Extension-published items may be
  attributed. A pending-draft count stops being labelled as possibly incomplete.
- After v0.87.0: a consumer that needs every document and every revision
  switches from search paging to snapshot → ack → replay.
- After v0.88.0: a bundled screen and a bundled filesystem adapter can migrate
  to `contributes.views` and `host.files`. Migration is a downstream decision,
  not a deprecation here — the bundled tier keeps working.

## Gates

Every wave: `npm run typecheck && npm run lint && npm test` green, plus the
acceptance criteria listed in each issue, plus `cap-table-completeness.test.ts`
and the docs row in `docs/architecture/extension-platform.md`. A wave ships as
one `release-it` minor release; the changelog is generated, so each PR title
carries the issue's outcome in plain language.

## Plans

- `docs/superpowers/plans/2026-09-06-extension-platform-wave-1.md` — #107, #112, #113
- `docs/superpowers/plans/2026-09-06-extension-platform-wave-2.md` — #106
- `docs/superpowers/plans/2026-09-06-extension-platform-wave-3.md` — #104, #105
