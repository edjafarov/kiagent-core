# Renderer performance: push re-renders, hidden-window timers, bundle, lists (#142, alpha-cent #271)

Status: APPROVED rev 4 (2026-10-09), astra r3 + fable r3 SATISFIED. This revision addresses round-1 reviews
from fable and codex astra, plus round 2 from both.

- Issues: kiagent-core #142, alpha-cent #271. Tracking: core #138.
- Base: core v0.106.0 and alpha-cent 0057c0bd.

Two repos are involved:

- core: `~/work/kcore-ui`, branch `opt/ui`;
- the alpha-cent product overlay: `~/work/ac-ui`, branch `opt/ui`.

The overlay *shadows* some core renderer files, which `build/apply-overlay.mjs`
`copyShadows` overwrites. A core change to a shadowed file never reaches the
product. The shadowed files are:

- `App.tsx`
- `screen-registry.tsx`
- `components/Sidebar.tsx`
- a few screens

The file that matters most here is not shadowed: core
`renderer/state/app-state.ts`.

## Already done (verified on the bases)

- **Core:**
  - Logs has stable keys, a memoised `LogRow` and deferred search (e66106f3).
  - The only react-markdown use (`InstallSheet`) is already lazy.
- **alpha-cent:**
  - Incoming caps `CouldntSort`, `ParkedPile` and `PutBack` at 200 rows
    (651dd59f, f26b3e05).
  - Home has a single 10 s clock.
- **Bounded at the source, so not in scope:**
  - Incoming `SortedMoves` uses the `moves-list` default of 8 rows, max 50.
  - Child lists in `SortedFolders` are bounded by `sorted-tree`: at most
    500 entries per directory, depth 2, and only opened nodes render.

#138 dropped the claim that "the Sidebar re-renders every sync". That was
true only of *core's* Sidebar (`selectSidebarSlice`). The product's Sidebar
is the overlay shadow, and it selects `s.accounts` directly, so the problem
is back there.

## Problems

1. **Every push re-renders the App shell and every subscriber, whatever
   changed.**
   - Main sends the whole `AppState` over IPC, throttled to 100 ms, after
     each feed diff (`main.ts` `engine.project` → `schedulePush`).
   - IPC structured-clones it. So even though main keeps unchanged objects
     stable, the renderer gets **new references for everything**:
     `identity`, `extensions`, every account.
   - `app-state.ts apply()` replaces the state wholesale, so `shallowEqual`
     selectors on any object or array fail on every push.
   - Both App shells (core `App.tsx:57`, overlay `App.tsx:83`) subscribe to
     the whole state with raw `useSyncExternalStore`.
   - Nothing in the overlay tree is memoised. During a backfill, the entire
     visible UI re-renders up to 10×/s.
2. **Timers keep refreshing UI in a hidden window.** Chromium throttles
   hidden timers (1 Hz, then about one per minute after 5 minutes), so this
   is smaller than issue #271 implies, but it is still real:
   - `useNow` (10 s, core `shared/web-ui/ui/time.ts`) re-renders Home.
   - Home's 60 s added-in-24 h poll (`home-data.ts:52`) re-fetches and sets
     state.
   - The recorder widget's 1 s display clock re-renders while recording.
3. **react-markdown is in the first-paint bundle.** The overlay
   `Transcripts/MeetingSummary.tsx` imports it eagerly, and the overlay
   registry imports `Transcripts` statically.
4. **Source maps ship.** All four prod webpack configs (renderer and main, in
   both repos) emit `*.map`. electron-builder `files` is `["dist",
   "node_modules", "package.json"]`, so they are packed. The maps stay
   useful for symbolicating minified stacks that `crash-handlers.ts` writes
   into user logs, so they should stay in the build output but not in the
   package.
5. **Two unbounded Incoming lists:**
   - `HowToSort` "Try on N waiting" renders one row per waiting job, which
     can be thousands.
   - The `SortedFolders` root list can render up to 500 folders at once.

## Goals and acceptance

- **Feed-only push.** A push that changes only `accounts[i].docCount` and
  `recent` re-renders:
  - neither App shell;
  - not the overlay Sidebar, unless a number it displays changed;
  - not Home on a structurally equal push. Home *does* re-render when an
    account it reads changed: it displays per-source counts, `newest` and
    `lastSyncAt`, so that render is correct. `useAddedLastDay` alone no
    longer re-renders on such a push.

  Measured with render counters in tests. In the dev app, counted with a
  Profiler over 60 s of backfill on the **Settings** screen, recording
  App/Sidebar commits; Home is recorded separately.
- **Hidden window.** No timer-driven state updates for `useNow`, the Home
  poll or the recorder display clock.
- **Bundle.** `renderer.js` no longer contains react-markdown, remark or
  micromark. A test inspects the built bundle or the webpack stats.
- **Package.** The packaged app contains no `*.map`.
- **Lists.** HowToSort try rows and the SortedFolders root list are capped
  at 200, with "Show more".

## Design

### A. Renderer-side structural sharing (core, `renderer/state/app-state.ts`)

`apply(next)` reconciles against the previous state before notifying:

```ts
state = reconcile(prev, next)
```

- `reconcile` keeps the previous reference for every value that is deeply
  equal (structural equality on JSON-shaped data).
- It recurses into arrays by index and into objects by key.
- It returns `prev` itself when nothing changed, and skips the notify in
  that case.

After this, every existing `useAppState` selector becomes cheap and correct.
`s.identity`, `s.extensions` and unchanged accounts keep their identity
across pushes. Only the changed account object and the containing `accounts`
array are new.

- **Cost:** one walk of the state per push. The state is small: accounts ×
  (scalars + `recent` ≤ RECENT_MAX).
- **Tests:**
  - unchanged sub-trees keep identity;
  - a changed leaf gives new references on its path only;
  - a structurally equal push does not notify;
  - push snapshots are delivered as **fresh clones** through the real store.
    `structuredClone` is undefined under jest 29 / jsdom 20, so the tests
    clone with `node:v8` `deserialize(serialize(x))`.

This is core-only. The overlay uses core's `app-state.ts`, so the fix reaches
the product with the core bump.

### B. Shells and Sidebar/Home select what they render

**App gates.** `useAppState` keeps its non-null selector signature, so
existing callers in both repos are untouched. A new
`useAppGate<T>(select: (s: AppState | null) => T)` is added beside it, with
the same `shallowEqual` snapshot cache. It is used only by the App shells.
The `app-state.ts` doc comment is updated.

| Shell | Selected fields |
|---|---|
| Core `App.tsx` | `{loaded, signedIn, extensions}` |
| Overlay `App.tsx` (shadow) | `{loaded, signedIn, ready, principal, extensions}` |

Raw `useSyncExternalStore` is removed from both. With A in place,
`extensions` keeps its reference across feed pushes.

**Overlay Sidebar** (shadow). It selects the derived scalars it displays
(error count, live/syncing count, the health tone and label it shows)
instead of `s.accounts` plus a render-time `selectHomeHealth`.

**Overlay Home.**

- `useHomeHealth` is **unchanged**. It already selects
  `{accounts, extensions, ready}` (`home-data.ts`) and memoises
  `selectHomeHealth` on that slice. Once A is in place, the slice is
  shallow-equal unless an account changed, and in that case Home displays the
  change. Pulling `HomeHealthData` into the selector is explicitly **not**
  done: it holds fresh arrays and objects, which would miss the one-level
  `shallowEqual` cache on every `getSnapshot` call and loop under React 19.
- `useAddedLastDay` selects only the stable account metadata
  `addedBySource` reads: `{id, source}` pairs, as a selector that returns the
  previous array when the pairs are unchanged. Its per-source counts come
  from its own fetch.
- **Tests** mount the real Home with cloned pushes:
  - a structurally equal push does not re-render Home;
  - a `docCount`-only push re-renders Home exactly once;
  - `useAddedLastDay`'s consumer does not re-render on that push.

### C. Visibility-gated refresh

1. **Core `useNow`.** It pauses while `document.visibilityState ===
   'hidden'`, updates immediately on becoming visible, and shares one
   module-level ticker per interval, so N consumers mean one timer.
2. **Overlay `home-data.ts` 60 s poll.** It skips fetches while hidden and
   refetches immediately on becoming visible.
3. **Overlay `RecorderWidget` display clock.** It pauses its 1 s display
   tick while hidden. Recording itself lives in main and is unaffected.

The other polls are left as they are: Settings 2 s panes and similar, which
are only mounted on their screens. Tests mount the real consumers, not only
the hook.

### D. Split only the Transcripts screen (overlay)

The overlay registry loads `Transcripts` with `React.lazy`:

- created at **module scope**, not inside `factory()`;
- with a `<Suspense>` fallback using the existing 200 ms-delayed
  `role="status"` pattern.

`MeetingSummary` keeps its eager react-markdown import. The library then
lives in the Transcripts chunk, and `useIsCut` keeps measuring
synchronously-rendered content (no cold-load measurement hazard).

- **Rule for other screens:** first record `ANALYZE=true` sizes per screen.
  Split another screen only if it is above 50 KB minified and has no eager
  importers. The plan records the sizes.
- **Eager-import audit:** nothing outside the Transcripts tree may import
  from it. The plan greps for imports of `screens/Transcripts` from App,
  Home, Sidebar and Recorder. Any shared helper is moved to a neutral module.
  The bundle test (Acceptance) proves the result.
- **Core registry:** unchanged. Core has no heavy secondary screen, and
  InstallSheet is already lazy.
- **Chunk loading under CSP** (`script-src 'self' … blob:`) and `file://` is
  already proven by core's lazy InstallSheet and qrcode chunks. One
  packaged smoke opening Transcripts confirms it.

### E. Maps stay in the build, not in the package (both repos)

`devtool` is unchanged. Each repo's `package.json` `build.files` gains
`"!**/*.map"`. A test reads `package.json` and asserts the exclusion. After
packaging, the plan checks the `app.asar` listing for no `.map` files.

### F. Bound HowToSort try rows and the SortedFolders root list (overlay)

Both use the existing `cappedRows(rows, LIST_CAP, pinned?)` and the "Show
more · N not shown" pattern. `cappedRows` requires `{id}`, but
`SortedTreeNodeWire` keys on `relPath`, so the helper gains an optional key
accessor (`key = (r) => r.id`), and SortedFolders passes `(n) => n.relPath`. Tests follow `incoming-list-cap.test.tsx`,
including the root list with more than 200 folders.

## Out of scope

- Virtualisation.
- The main-process 100 ms push and structured-clone cost.
- Splitting core screens.
- Lazy-loading inside `MeetingSummary`.

## Testing summary

- **Core:**
  - `reconcile` identity tests;
  - App render counter with cloned pushes;
  - `useNow` hidden/visible and shared-timer tests;
  - `package.json` map exclusion.
- **alpha-cent:**
  - App and Sidebar render counters under a cloned `docCount`-only push;
  - Home re-render counts (equal push: 0; `docCount` push: 1);
  - home poll and recorder clock gating;
  - lazy Transcripts renders through Suspense;
  - bundle test: no react-markdown in `renderer.js`;
  - Incoming caps;
  - map exclusion;
  - shadow baselines regenerated after the core bump.

## Release order

1. Release core:
   - A;
   - B-core: core `App.tsx` uses `useAppGate`;
   - C1;
   - E-core.
2. In alpha-cent, bump `core.lock`, regenerate the shadow baselines, and land
   the overlay changes: B, C2–C3, D, E-alpha-cent and F.
