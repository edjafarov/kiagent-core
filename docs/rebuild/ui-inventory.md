# KIAgent Renderer UI — Complete Inventory

This document is a rebuild-from-scratch spec for the KIAgent Electron renderer
UI (`src/renderer/**` + the shared design system in `src/shared/web-ui/**`).
It is meant to let someone reproduce the UI pixel-for-pixel with a brand-new
backend. Every field name is quoted exactly as it appears in the TypeScript
source (camelCase for JS objects, `snake_case` for the persisted/DB-shaped
`AppState` fields — the codebase mixes both deliberately, see §4).

Bonus resource: `docs/screens/*.html` in this repo contains ~25 static,
non-React HTML/CSS mockups (one per screen/dialog: `sources-list.html`,
`source-detail.html`, `logs.html`, `settings-*.html`, `signin.html`,
`mcp-hub.html`, `tray.html`, `add-source.html`, etc.) built from the same
`docs/screens/tokens.css` / `components.css`. They predate/parallel the React
implementation and are the fastest way to eyeball exact pixel layout without
running Electron.

---

## 1. App shell & navigation

### 1.1 Boot sequence

- `src/renderer/index.ejs:1` — the only static HTML. `<body style="background:#fafafa">` inlines `--bg-app` so the window isn't stark white while the JS bundle (which carries the real stylesheet) loads. CSP: `script-src 'self' 'unsafe-inline'`. Single `<div id="root"></div>`.
- `src/renderer/index.tsx:1` — entry point.
  - Imports, in order: `@shared/web-ui/tokens.css`, `@shared/web-ui/components.css`, `@shared/web-ui/Spark.css`, `./App.css` (side-effect CSS imports bundled by webpack), then calls `initLogStream()` (state/log-stream.ts) before first paint so log records accumulate from boot, then `root.render(<App/>)`.
  - **Preload-bridge race guard**: on dev hot-restart the sandboxed preload can fail to attach `window.kiagent`. `index.tsx` polls every `BRIDGE_POLL_MS=100` for up to `BRIDGE_WAIT_MS=3000`; if the bridge never appears it renders a hardcoded fallback screen (deep-violet `#2e1065` background, "Couldn't connect to KIAgent" message, a "Reload" button that calls `window.location.reload()`) instead of a blank/white-screen crash.
- `src/renderer/App.tsx:1` imports `'@renderer-ext'` as its first line (a side-effecting import resolved by the `@renderer-ext` tsconfig path alias to `src/renderer/ext-noop.ts` in OSS — see §5).

### 1.2 App shell structure (`App.tsx`)

Three gate states, always wrapped by `<TitleBar/>`:

1. **Loading** (`gate === null || resolved === null`): `<TitleBar/>` + a flex column `div.ac` containing only `<BootSplash/>` (branded boot screen — `Spark` in `state="blink"` size `"app"` + "KIAgent" wordmark text, see §3).
2. **Sign-in gate** (`!gate.signedIn && (!gate.localMode || showSignIn)`): `<TitleBar/>` + `<IconSprite/>` + `div.ac` containing `<SignIn onCancel=.../>` (Cancel only passed when `gate.localMode` is true, i.e. the user is re-invoking sign-in from inside the local-mode app).
3. **Main app**: `<ViewContext.Provider>` wraps `<TitleBar/>` + `<IconSprite/>` + `div.ac` containing, conditionally, `<TopBar/>` (only if `screenRegistry.usesTopBar(view)`) followed by the resolved screen element.

`gate` is computed via `useAppStateSelector(s => s===null ? null : {signedIn: s.auth.signedIn, localMode: s.auth.localMode})` — App only re-renders on this 2-field slice, never on account/backfill churn (App.tsx:65-69).

Navigation state is local to `App`, not the URL:
- `resolved: {view, params} | null`, a `historyRef` array-as-stack for `back()`.
- `navigate(to, params)` pushes the previous resolved view onto history and sets the new one (App.tsx:77-82).
- `back()` pops history, defaulting to `{view:'sources'}` if empty.
- `requestSignIn()` sets `showSignIn=true` (renderer-only, does not touch the persisted `usingLocally` pref).
- `ViewContext` (state/view.ts) exposes `{view, params, navigate, back, requestSignIn}` to the whole tree via `useView()`.

Deep-link routing: main process pushes a **path string** over `app:navigate` (e.g. from tray/menubar/notification clicks); `App.tsx` subscribes via `ipc().on('app:navigate', path => setResolved(pathToView(String(path))))`. `pathToView()` (App.tsx:28-54) maps:

| path | view |
|---|---|
| `/sources` | `sources` |
| `/connection` | `connection` |
| `/settings/account` | `settings:account` |
| `/settings/storage` | `settings:storage` |
| `/settings/local-processing` | `settings:local-processing` |
| `/settings/advanced` | `settings:advanced` |
| `/settings/about` | `settings:about` |
| `/logs` | `logs` |
| `/marketplace` | `marketplace` |
| `/dashboard` (legacy) | `sources` |
| `/settings/general` (legacy) | `settings:account` |
| `/settings/mcp` (legacy) | `settings:advanced` |
| `/settings/remote-mcp` (legacy) | `connection` |
| `/mcp` (legacy) | `connection` |
| anything else | `sources` (default) |

### 1.3 Screen registry (`screen-registry.tsx`)

- `View` union type (`state/view.ts:3-13`): `'sources' | 'sources:detail' | 'connection' | 'settings:account' | 'settings:storage' | 'settings:local-processing' | 'settings:advanced' | 'settings:about' | 'logs' | 'marketplace'`.
- `ViewParams`: `{accountId?: string; anchor?: string}`. `anchor: 'pick-folders'` is used to auto-open the folder-picker on `SourceDetail` right after connecting a folder-based connector.
- `ScreenFactory = {factory: (params, navigate) => ReactElement, usesTopBar: boolean}`. `ScreenDefinitions = Partial<Record<View, ScreenFactory>>`.
- `createScreenRegistry(screens)` returns `{get(view,params,navigate), usesTopBar(view)}` — `get` returns `null` for an unregistered view (App.tsx falls back to `<SourcesList/>`).
- `registerScreen(screens, view, factory, {usesTopBar})` — extension point for overlay code to add/replace a screen (not used by any OSS screen; exists for the proprietary overlay per the augmentable-registry pattern used throughout this codebase).
- `getDefaultScreens()` wires the 10 `View`s to their components (table below repeats this with `usesTopBar`).
- The 5 `settings:*` views all render the same `<SettingsShell selected=... onSelect=...>`; `onSelect` maps a clicked `SettingsKey` back to a `View` via `VIEW_TO_SETTINGS` and calls `navigate`.

### 1.4 Theming — design tokens

**Important**: `src/renderer/tokens.css` is a deliberately-emptied deprecated stub (kept only so a stray `import './tokens.css'` doesn't 404 — see file header). The **real** token source is `src/shared/web-ui/tokens.css`, imported as a JS module side-effect from `index.tsx` (not via `@import`, because webpack-dev-server HMR misses `@import`-chained CSS changes). Likewise `src/renderer/App.css` only contains renderer-specific chrome (titlebar, scrollbar, spin keyframe) — the actual button/pill/card/input primitives are in `src/shared/web-ui/components.css`.

Full token set (`src/shared/web-ui/tokens.css:14-125`), light-mode only — **there is no dark mode**: no `prefers-color-scheme` media query and no `.dark`/`[data-theme]` selector exists anywhere in the codebase. `AppPrefs.theme: 'light'|'system'|'dark'` is persisted (Settings → Account) but explicitly documented as inert (`src/main/prefs.ts:51-55`, `Settings/Account.tsx:204-208`): the app always renders light regardless of the stored value.

```
Surfaces:   --bg-canvas #fff  --bg-surface #fff  --bg-elevated #fff
            --bg-muted #f8fafc  --bg-app #fafafa
            --bg-sidebar #4c1d95 (violet)  --bg-rail #2e1065 (deep violet, titlebar)
            --bg-canvas-warm #f0eee9 (design-canvas mockup wrapper only)
Text:       --text-primary #0f172a  --text-secondary #64748b  --text-tertiary #9ca3af
            --text-on-sidebar #ede9fe  --text-on-rail #fff
Borders:    --border-subtle #e5e7eb  --border-strong #cbd5e1  --border-focus #a78bfa
Accent (violet brand): --accent-solid #7c3aed  --accent-solid-hover #6d28d9
            --accent-text #6d28d9  --accent-subtle #ede9fe  --accent-contrast #fff
Status:     --live-solid #0d9488 / --live-subtle #ccfbf1
            --working-solid #c2410c / --working-subtle #ffedd5
            --error-solid #e11d48 / --error-subtle #ffe4e6
            --paused-solid #64748b / --paused-subtle #f1f5f9
            --info-solid #0891b2 / --info-subtle #cffafe
Connector tag stripes: --tag-gmail #e11d48  --tag-google-docs #4285f4
            --tag-onedrive #094ab2  --tag-local #2563eb  --tag-notion #0f172a
            --tag-slack #7c3aed  --tag-browser #0891b2  --tag-whatsapp #25d366
            --tag-instagram #E1306C
Fonts:      --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif
            --font-mono: 'JetBrains Mono', ui-monospace, 'SF Mono', 'Cascadia Mono', 'Roboto Mono', Consolas, 'Liberation Mono', monospace
            (loaded via @import url(fonts.googleapis.com Inter 400/500/600/700 + JetBrains Mono 400/500) — hits network at startup, no offline .woff2 fallback shipped)
Type scale: --text-xxs 10/14  --text-xs 11/15  --text-sm 12/17  --text-base 13/18
            --text-md 14/20  --text-lg 17/22  --text-xl 19/24  --text-2xl 22/28  (size/line-height px)
Weights:    --weight-regular 400  --weight-medium 500  --weight-semibold 600
Spacing (4px base): --s-0 0  --s-1 4  --s-2 8  --s-3 12  --s-4 16  --s-5 20  --s-6 24  --s-8 32  --s-10 40  --s-12 48  --s-16 64  --s-20 80
Radius:     --radius-sm/md/lg/xl = 0 (ALL ZERO — "SHARP throughout. Do not soften." is the literal code comment)
Shadows:    --shadow-xs/sm/md/lg + --shadow-primary (violet-tinted, used on .btn.primary)
Motion:     --duration-fast 120ms  --duration-normal 200ms  --duration-slow 400ms
            --ease-out cubic-bezier(.16,1,.3,1)  --ease-in cubic-bezier(.7,0,.84,0)  --ease-in-out cubic-bezier(.65,0,.35,1)
            (all zeroed under prefers-reduced-motion)
```

Semantic type-role classes also live in tokens.css: `.kg-display .kg-h1 .kg-h2 .kg-h3 .kg-body .kg-meta .kg-tiny .kg-label .kg-code/.kg-mono .kg-num .kg-link`.

### 1.5 Component-primitive CSS (`src/shared/web-ui/components.css`)

One shared stylesheet used by the desktop renderer, the web SPA, and server-rendered HTML. Key classes an implementer must reproduce (all sharp-cornered, all token-driven):

- `.ac` — root font/color/background container; `.ac * {box-sizing:border-box}`.
- `.mac-window/.mac-titlebar/.mac-lights/.mac-title/.mac-body` — a **design-mockup-only** macOS window chrome (traffic lights `.l-red #ff5f57 / .l-yellow #febc2e / .l-green #28c840`); the real app doesn't render this (Electron's native frame + the app's own `.kg-titlebar` cover it — see §1.6), but it appears throughout `docs/screens/*.html` mockups and the design-canvas wrapper.
- `.btn` (26px h, sharp, 1px border, hover=`--bg-muted`); modifiers `.sm` (22px), `.lg` (32px), `.primary` (violet, `--shadow-primary`), `.ghost` (transparent/no border), `.destructive` (white bg, red border/text, red-subtle hover), `.icon-only` (22×22, no padding), `[disabled]/.disabled` → opacity .4.
- `.pill` (18px h, 10.5px text) + `.dot` (5×5) with variants `.live/.working/.error/.paused/.info` mapping to the status token pairs above.
- `.card` (white, 1px border, `--shadow-xs`, `overflow:hidden`, `position:relative`) + `.card.danger` (red border) + `.card .stripe` (4px left color bar, one class per connector: `.gmail/.google-docs/.onedrive/.local/.notion/.slack/.browser/.whatsapp/.instagram`) + `.card .card-inner {padding-left:20px}`.
- `.input` (26px h, sharp) + `.input.mono-text` + `.input.readonly` + `.input-group`.
- `.progress` (4px h bar) + `.progress > i` animated diagonal stripe fill (`--accent-solid`, `prog-stripes` keyframe, 8px tile, 1.2s linear) + `.progress.tray` (2px h).
- `.spinner` (1em circle, `border:2px solid currentColor` with transparent top, `spin` 0.8s linear) + `.busy` (spinner+label, 11px) — `<Busy>` component delays showing itself by `delayMs` (default 200ms) so instant IPC round-trips never flash.
- Typography helpers: `.lbl-section` (10px uppercase secondary), `.h-screen` (19px/600), `.h-section` (14px/600), `.t-meta` (11px secondary), `.t-tiny` (10px tertiary), `.div-h` (1px full-width divider).
- `.link` (underline-on-hover accent text button reset).
- `.toast` (320px, left-border-colored by kind: default teal `.attention` orange `.error` red `.info` cyan) — defined but no toast-rendering call site was found in the renderer source; likely reserved for future/overlay use.
- `.tbl` — "ghost header" dense table: no header background, no row borders, `tbody tr:hover td {background: var(--bg-muted)}`.
- `.kg-tab` / `.kg-tab.active` / `.tab-dot.on/.off` — TopBar's Sources/Marketplace/Connection nav pills.
- `.side-item` / `.side-item.active/.parent/.child` — Settings sidebar nav rows (on `--bg-sidebar` violet).
- `.tray-pop` / `.menu-row` / `.menu-divider` / `.kbd-chip` — popover chrome used both by the (unbuilt-here) tray popover mock AND by `RowMenu`'s kebab dropdown (`role="menu"`).
- `.conn-glyph` (22/26/34px icon tile sizes: default/`.lg`/`.xl`).
- `.wordmark` (mono, `BracketMark` + "KIAgent" text).
- `.prov-row` / `.prov-row.primary` / `.prov-row.google-signin` (exact Google brand spec: white bg, `#747775` border, `#1f1f1f` text, Roboto Medium 14px) / `.prov-row.microsoft-signin` (white bg, `#8c8c8c` border, Segoe UI 15px, `#5e5e5e` text) / `.prov-row.local-folder` — the SignIn screen's big provider buttons.
- `.onb-divider` — "or" divider row (SignIn).
- `.notion-n` — a plain "N" monogram glyph class (separate from `ConnectorBrandIcon`'s own inline Notion SVG monogram).
- `.dc-canvas/.dc-title/...` — the Figma-style grid-paper canvas wrapper used only by internal design-review pages, not the app itself.
- `.onb-shell/.onb-shell--brand/.onb-card/.onb-head/.onb-spark/.onb-title/.onb-sub/.onb-providers/.onb-footer` — the centered onboarding/sign-in card shell (shared between desktop `SignIn` and a web sign-in page not in this repo tree).

### 1.6 Window chrome actually rendered

- `TitleBar.tsx` — a 30px-high `.kg-titlebar` bar (background `--bg-rail`, 1px bottom border `rgba(0,0,0,.2)`, `-webkit-app-region: drag`), centered "KIAgent" label (`.kg-titlebar-title`, 13px/500, `rgba(255,255,255,.85)`). Padding is platform-conditional: on Mac (`/Mac/i.test(navigator.platform)`) `paddingLeft:76` (clears the native traffic-light buttons) `paddingRight:12`; elsewhere `paddingLeft:12 paddingRight:140` (clears Windows' native minimize/maximize/close cluster). No custom traffic lights are drawn — the OS chrome is used, this bar is purely a colored strip + centered title sitting above it.
- Below the titlebar: `div.ac` fills the rest of the window (`flex:1, display:flex, flexDirection:column, minHeight:0`), containing `TopBar` (conditionally) then the active screen.

---

## 2. Screens

Screens live in `src/renderer/screens/**`. Each subsection: purpose, exact visual layout, components used, state read, IPC used.

### 2.1 SignIn (`screens/SignIn.tsx` + `SignIn.css`)

**Purpose**: full-window gate shown when not signed in and not in local mode (or when the user explicitly re-requests sign-in).

**Layout** (`.si-canvas`, flex row filling the window):
- Left panel `.si-brand` (42% width, min 240px, `--bg-sidebar` violet background, `--text-on-sidebar`): a large `<Spark size="hero"/>` mark pinned toward the bottom (`.si-brand-copy {margin-top:auto}`) above two lines of copy — headline "Your knowledge,\nindexed locally." (20px/600 white) and a sub sentence (12px, 82% opacity).
- Right panel `.si-pane` (flex:1, centered vertically, 40px/44px padding): a header ("Sign in" 18px/600 + a `.t-meta` one-liner), then `.si-actions` (max-width 320px, column, gap 9px):
  1. `<ProvRow variant="google-signin">` — Google G glyph (18px multicolor SVG) + label "Sign in with Google & index Gmail" (busy → "Connecting Gmail…", glyph replaced by `null` while busy).
  2. A plain ghost small button "Sign in only — don't index Gmail" (self-aligned start).
  3. `<ProvRow variant="microsoft-signin">` — MS 4-square glyph + "Sign in with Microsoft" (busy → "Connecting Outlook…").
  4. Conditional error block `.si-error` (red text/border/bg) — "Couldn't sign you in — {message}".
  5. A top-bordered footer row containing exactly one button: if `onCancel` was passed, "Cancel — keep using kia locally"; else "Skip — use kia locally".
  - Bottom-of-pane footer `.si-foot`: shield icon (12px) + "No telemetry · your scopes" (10.5px tertiary).

**Components used**: `ProvRow`, `GoogleGlyph`, `MicrosoftGlyph`, `Spark`, `Icon` (all from `@shared/web-ui`).

**State read**: none from `AppState` directly — purely local `busy: Provider|null`, `error: string|null`.

**IPC**:
- `auth:sign-in` invoke, payload `{provider: 'google'|'microsoft', withGmail: boolean}` → `RunSignInResult` (`{ok:boolean; message?:string}` as consumed). On success the screen does *not* navigate itself — it waits for `push:state-updated` to flip `auth.signedIn=true`, which unmounts SignIn from `App.tsx`'s gate logic.
- `auth:use-locally` invoke, no payload → `{ok:boolean; error?:string}`. On success main persists `usingLocally=true` and pushes state; App's gate opens.

### 2.2 Sources — SourcesList (`screens/Sources/SourcesList.tsx` + `Sources.css`)

**Purpose**: the default/home screen — every connected account as a table, plus onboarding/idea panels below it, plus the "Add a source" picker.

**Layout** (`.dash-shell` > `.dash-body`, non-scrolling frame with one internal scroll region):
- Header row `.row-flex`: "Sources" (`.h-section`) + `t-meta` count "`N type(s)` · `M source(s)`" (unique `source` values vs. total accounts) + spacer + "Sync all" button (`refresh-cw` icon, disabled while `syncSpin` or zero accounts, spins for a fixed 700ms via `.kg-spin` class on click even if the IPC resolves instantly) + primary "Add" button (`plus` icon) that flips `adding=true`.
- If `adding`: renders `<AddSource>` **in place of** the rest of the body (not a modal — the screen becomes the add-source panel; a Cancel button therein returns to the list).
- Else, in order:
  1. One `<ErrorCard>` per account with `status==='error'||'needs_reauth'` (the "erroring" bucket, shown above the table, NOT inside it).
  2. `<SourceTable accounts={healthy}>` — the "healthy" bucket (`status` not error/needs_reauth). This table sits in `.dash-body > .tbl-container`, the ONE scrollable region (`flex:1 1 auto; min-height:120px; overflow-y:auto`), with a sticky `<thead>` (`position:sticky;top:0`) so the header stays visible while rows scroll.
  3. `<GetStartedPanel>` (3-step onboarding checklist — self-hides once dismissed/complete).
  4. `<IdeasPanel>` (4 prompt cards — self-hides if empty).
- On row click → `navigate('sources:detail', {accountId})`. After `AddSource`'s `onConnected` fires for a folder-based connector (`google-docs`/`onedrive`/`local-folder`), navigates straight to `sources:detail` with `anchor:'pick-folders'` so the folder picker auto-opens.

**Components used**: `AddSource`, `SourceTable`, `ErrorCard`, `GetStartedPanel`, `IdeasPanel`, `Icon`.

**State read** (`AppState`, whole object via `useAppState()`): `accounts[]` (every field — see §4 table), `auth.signedIn`, `auth.localMode`.

**IPC**: `connector:sync-now` invoke `{accountId: null}` ("Sync all" — `null` = every account).

#### 2.2.1 SourceTable (`screens/Sources/SourceTable.tsx`)

A `.tbl` inside `.tbl-container`. Columns: **Source** (110px, `ConnectorBrandIcon` 14px + label 11px secondary), **Account / path** (identifier/mono, truncated with ellipsis, plus a `.scope-chip` "Personal"/"Work/school" badge for onedrive/ms365 accounts carrying `tenant_kind`), **Status** (140px, `<StatusPill>`), **Indexed** (140px, `doc_count.toLocaleString()`, mono), **Last** (80px, relative time from `last_document_at`), **Actions** (36px, `<AccountRowActions>`, click stops propagation so it doesn't also navigate). Row click → `onRowClick(account.id)`. Rows are `React.memo`'d with a custom comparator (`accountRenderEqual`) checking `id, source, identifier, display_name, status, backfill_done_count, backfill_total_estimate, doc_count, last_document_at, tenant_kind`, plus each `tracked_roots[i].kind` — deliberately ignoring fields the row doesn't render (e.g. `last_error`) so unrelated state churn doesn't reflow the table.

`sourceLabel(a)`: local/local-folder → `a.display_name ?? machineLabel()` ("This Mac"/"This PC"/"This computer" by UA); browser → `a.display_name ?? connectorForSource(source).label`; else the connector registry label.

`identifierDisplay(a)`: browser → "`N` profile(s)" counted from `tracked_roots` where `kind==='browser'`; local(-folder) → "`N` folder(s)" (`kind==='fs'`); onedrive → "`identifier` · `N` folder(s)" (`kind==='ms-drive'`, omitted if 0); google-docs → same pattern with `kind==='drive'`; else the raw `identifier`.

#### 2.2.2 ErrorCard (`screens/Sources/ErrorCard.tsx`)

`.card.danger` with a left red border (from `.card.danger`) — NOT the colored connector stripe (that's only for the normal `.card .stripe.*` variant elsewhere). Header row: `ConnectorBrandIcon` (15px) + connector label (13px/600) + mono identifier (11px secondary) + spacer + a red `.pill.error` reading "Reconnect" (if `status==='needs_reauth'` and the connector registry has a `reauthChannel`) or "Error" + a primary small button: "Reconnect" (invokes `reauthChannel`) or "Retry" (invokes `connector:retry-backfill {accountId}`). Below: `.err-detail` block (red-subtle bg) with an alert-circle icon + "Reconnect required"/"Sync failed" title + mono `a.last_error ?? 'Unknown error'`. Footer `.err-links`: "Show logs" (`app:open-path {kind:'log-file'}`) and "Open data directory" (`app:open-path {kind:'data-folder'}`).

#### 2.2.3 GetStartedPanel (`screens/Sources/GetStartedPanel.tsx` + `onboarding-steps.ts`)

3-step checklist card (`.ob-panel > .ob-head + .ob-checklist`). Header: Spark-glyph + "Get started with kia" title, "Connect your LLM, then try a query — that's it." sub, and a "Skip" button (top-right) that persists `prefs:set {onboarding:{dismissedAt: nowIso}}`. Steps (`.ob-step`, each a checkbox-icon + label + meta line):
1. "Add a source" — meta from `step1Meta()`: done → "`N` source(s) connected"; backfilling → "Backfilling — `pct`%` · ~`eta` left" (via `formatDuration`); else "Setting up your first source…".
2. "Connect your LLM" — meta "LLM connected." when done, else "Point Claude · Cursor · VS Code at kia's MCP URL." plus a primary "Open Connection tab →" button calling `onOpenMcp` (navigates to `connection`).
3. "Try a query" — "First query received." / "Tap a prompt below to copy, then paste into your LLM."

Visibility rule (`deriveOnboarding`, pure): shown iff `(signedIn||localMode) && onboarding.dismissedAt==null && !(step1&&step2&&step3 all done)`. Step completion is purely a function of 3 persisted ISO timestamps on `AppPrefs.onboarding`: `sourceBackfilledAt`, `mcpConnectedAt`, `firstQueryAt`.

**IPC**: `prefs:get` invoke (load), `push:prefs-updated` subscribe (stay in sync — main latches these milestones itself), `prefs:set {onboarding:{dismissedAt}}` invoke (Skip).

#### 2.2.4 IdeasPanel (`screens/Sources/IdeasPanel.tsx`)

`.ob-panel` with a 2×2 `.ob-grid` of prompt cards (`.ob-prompt`, each a `<button>`: spark glyph + clamped-to-3-lines text with a "See more/less" toggle when it overflows, a source chip with the connector stripe color, an optional "`N` matching" note, and a copy icon that flips to "Copied" text for 1.2s on click). Header: "Ideas to try" + sub + a "Shuffle" ghost button (re-rolls the 4-of-N pick via a seeded Fisher–Yates, re-fetches suggestions on reroll).

Cards come from `suggestions:get` (server-computed `Suggestion[]`, each `{id, tier:'workflow'|'quick', title, text, source, matchCount}`) when non-empty; otherwise falls back to a static hardcoded `PROMPT_POOL` (19 canned prompts across gmail/google-docs/local/notion/onedrive) filtered to only the connectors the user has connected. Copy → `navigator.clipboard.writeText(text)`.

**IPC**: `suggestions:get` invoke, refetched on every Shuffle click.

### 2.3 Sources — SourceDetail (`screens/Sources/SourceDetail.tsx` + `sections/*.tsx`)

**Purpose**: per-account detail/management screen. Route `sources:detail`, param `{accountId}`.

**Layout**: `.dash-shell` > topbar (`.dash-topbar`) + `.detail-body` (scrollable column of `.detail-card` sections, 16/20px padding, 14px gap).

Topbar: "← Sources" ghost button (`navigate('sources')`), mono identifier (`.h-section`), optional `.scope-chip` (tenant_kind), `<StatusPill>`, spacer, conditional primary "Reconnect" button (only if `status==='needs_reauth'` and the connector has a `reauthChannel`), "Sync now"/"Syncing…" button (`connector:sync-now {accountId}`), Pause/Resume toggle button (`connector:pause`/`connector:resume {accountId}`, icon swaps play/pause), `<AccountRowActions hideSyncNow>` (kebab menu with just Re-run backfill + Remove, since Sync/Pause are already inline buttons here).

Body sections, each a `.detail-card` with a `.lbl-section` title, in fixed order:

1. **Overview** (`sections/Overview.tsx`) — a `dl.kv` definition list: Identifier (mono), Indexed (`doc_count` documents + inline "`X` of ~`Y` estimated" or unit-aware "processed" note while backfilling), Last sync (`formatRelative(last_sync_at)`), Last document (`formatRelative(last_document_at)`). If backfilling with a known total: a `.progress` bar (`<i style="width:{pct}%">`) + caption "Backfilling `Label` — `done/total` (`pct`%). Estimated `eta` remaining."
2. **TrackedContent** (`sections/TrackedContent.tsx`) — title "Tracked content". If the connector's manifest has a `resource-picker` step: renders `<AccountResourcePickers>` (folder rows + "add folder" button + the relevant folder-picker modal). Else if `tracked_roots.length>0`: a plain read-only list (link icon + mono `display_path`/`abs_path` + "`N` docs") — used for auto-detected, non-removable roots like browser profiles. Else: "All content is indexed automatically."
3. **Cadence** (`sections/Cadence.tsx`) — title "Sync frequency". Self-hides entirely (`return null`) unless `connectorForSource(source).pollable`. Two `<select>` rows ("Window focused" / "Window unfocused") from a fixed option list (30s/1m/2m/5m/15m/30m — `ms` values 30000..1800000), falling back to a synthesized "Every `N`s" option if the current value isn't one of the presets. Reads `state.cadence?.[accountId]` (defaults 30000/120000 while unloaded). On change → `connector:set-cadence {accountId, focusedMs, unfocusedMs}`.
4. **ConnectorConfig** (`sections/ConnectorConfig.tsx`) — title "Connector settings". Self-hides unless the manifest declares `configPanel` or `actions`. Renders `<BlockScopeWidgets>` (the browser-privacy config panel and/or one button per manifest action — see §5).
5. **RecentActivity** (`sections/RecentActivity.tsx`) — title "Recent activity", up to 3 rows built from `recent_documents` (per-doc "Indexed `X`" lines, connector-specific verbs/fallbacks — see the `INDEXED_LABEL`/`SYNC_LABEL`/`EMPTY_TITLE_FALLBACK` maps in source) plus one synthetic "Synced …" row if `last_sync_at` differs from the newest doc's timestamp, plus one red error row if currently erroring. Sorted newest-first, mono timestamp `YYYY-MM-DD HH:MM:SS` (local).
6. **DangerZone** (`sections/DangerZone.tsx`) — title "Danger zone" (red label). Pause/Resume, "Re-run backfill" (native `window.confirm`), "Remove…" (opens `<RemoveAccountModal>`).

**State read per account** (`AccountState`, all fields — see §4).

**IPC** (this screen + its sections): `connector:sync-now`, `connector:pause`, `connector:resume`, `connector:retry-backfill`, `connector:remove-account {accountId, purge?}`, `connector:set-cadence`, plus whichever reauth channel the connector registry names, plus the resource-picker/config-panel channels described in §5.

### 2.4 Connection (`screens/Connection/*.tsx` + `Connection.css`)

**Purpose**: "how do I plug an LLM client into kia" screen. Route `connection`.

**Layout** (`.dash-shell > .conn-body`, one scroll region, 16/20/22px padding):
1. `.conn-group` #1 — the **overlay's** `RemoteSection` component if registered via `registerRemoteSection` (OSS ships none, so this renders nothing — see §5), followed by `<ManualSetup summary="add the public URL to Claude.ai, ChatGPT & mobile">` (collapsed by default) whose body is one paragraph of instructions.
2. `.div-h` divider.
3. `.conn-group` #2 — `<LocalClients localPort={port}>` then `<ManualSetup summary="local URL {url} & config snippets">` whose body is a monospace `<pre class="code-block wrap">` HTTP snippet plus (if a stdio descriptor loaded) a second `<pre>` labelled "stdio entry ({MCP_SERVER_KEY}) for Claude Desktop / Codex".

`port` defaults to `7421` if `state.mcp.port` is null.

#### 2.4.1 LocalClients (`Connection/LocalClients.tsx`)

Section header: "Local" `.h-section` + `<Pill variant="live">Online</Pill>` + spacer + mono `127.0.0.1:{port}`. Sub-copy: "Connect AI apps on this Mac — toggle one on to wire it up to your digital memory." Body: while `clients===null`, `<Busy label="Detecting clients…">`; else a `.conn-list` of `.conn-row` — one per client (`connection:list-clients` result). Not-detected clients render dimmed (`.conn-row.dim`) with just a glyph + name + "Not detected" tag. Detected clients render a 2-letter mono glyph (`GLYPH` map: CD=claude-desktop accent, CC=claude-code accent, Cu=cursor, VS=vscode, Cx=codex; unknown → first 2 letters of label), name, description ("Connected to kia" or "`TRANSPORT` · ready to connect"), a `<Pill variant="live">Connected</Pill>` when connected, and a Connect/Disconnect button (primary when offering Connect).

**IPC**: `connection:list-clients` invoke (no payload) → `ClientInfo[]`; `connection:connect`/`connection:disconnect` invoke `{clientId}` → `ConnectionWriteResult`; refetches the list after every toggle (doesn't trust optimistic state).

#### 2.4.2 ManualSetup (`Connection/ManualSetup.tsx`)

A generic collapsible disclosure: a `.conn-manual-trigger` button (chevron rotates 90° when `aria-expanded=true`) reading "Manual setup — {summary}"; children render in `.conn-manual-body` only while open.

#### 2.4.3 snippets.ts (`screens/Mcp/snippets.ts`)

Pure function `buildSnippet(client, transport)` producing the exact copy-paste text per client:
- `claude-desktop` (stdio only) → JSON `{mcpServers: {[MCP_SERVER_KEY]: {command, args, env}}}`.
- `vscode` → JSON `{servers: {[MCP_SERVER_KEY]: {url, headers?}}}`.
- `claude-code` → shell command `claude mcp add {MCP_SERVER_KEY} --transport http --url {url}{ --header "Authorization: Bearer {bearer}"}`.
- `local`/`custom` → JSON `{url, headers?}`.
`MCP_SERVER_KEY = 'Kia'` (`src/shared/mcp-identity.ts`) — both the config-file key AND the MCP handshake's `serverInfo.title`.

### 2.5 Logs (`screens/Logs.tsx` + `Logs.css`)

**Purpose**: diagnostic log tail viewer. Route `logs`; **no TopBar** (`usesTopBar:false` in the registry) — it has its own dedicated top bar instead.

**Layout** (`.logs-shell` > `LogsTopBar` + `.logs-body`):
- `LogsTopBar`: "← Back" ghost button (`useView().back()`), `<Wordmark/>`, `<Pill variant="live">{live} live · {totalDocs} docs</Pill>` (from a narrow `AppState` selector), "Diagnostic log stream" caption, spacer, "Open log file" ghost button (`app:open-path {kind:'log-file'}`), settings-gear ghost button (`navigate('settings:advanced')`).
- `.logs-toolbar`: "Filter" label, Level `<select>` (`debug`→"All (debug+)" / `info+` / `warn+` / `error+`, default `info`), Source `<select>` ("All sources" + every distinct `sourceOf(rec)` seen, sorted), a search `<input>` with a magnifier icon (matches `msg`, source, or any extra field's stringified value, case-insensitive), a vertical divider, "tail" label, Pause/Resume button (freezes/thaws a snapshot — see below), Copy button (copies all currently-visible rows as plaintext to the clipboard), spacer, Clear button (wipes the ring buffer).
- `.logs-table` — one `.log-row` per visible record, **newest first**, CSS grid `130px 60px 110px 1fr` (timestamp / LEVEL / source / message+extra-fields). Level color: info=`--info-solid`, warn=`--working-solid`, error=`--error-solid`, debug=`--text-tertiary`. Error rows get a faint red row-tint, warn rows a faint orange tint. Extra (non-core) fields render inline after the message as `key=value` pairs. Empty states: "Waiting for log activity…" (buffer truly empty) vs "No records match the current filters." (filtered to zero).
- `.footbar`: mono log-file path, separator, "`visible` of `total` line(s)", spacer, a streaming/paused status pill with a colored dot (info-color when streaming, tertiary when paused).

**Data model**: not from `AppState` — a dedicated module-level ring buffer (`state/log-stream.ts`, capacity **1000** records) that survives navigation and is seeded from disk on boot (see §4.4). `Pause` doesn't stop the underlying stream; it freezes a `frozenRecords` snapshot for display while the buffer keeps growing in the background; `Resume` drops the snapshot.

**IPC**: `push:log` subscribe (array-batched log records, ~250ms windows), `app:read-recent-logs {limit:1000}` invoke (disk-seeded tail on boot), `app:get-log-path` invoke, `app:open-path {kind:'log-file'}` invoke.

### 2.6 Marketplace (`screens/Marketplace/Marketplace.tsx` + `Marketplace.css`)

**Purpose**: browse/install/update/uninstall third-party connector extensions from a GitHub-backed catalog. Route `marketplace`.

**Layout**: VS-Code-style two-pane `.dash-shell.mkt-shell` (flex row):
- `.mkt-left` (320px fixed, right-bordered): a search input, a filter-pill row (`All` / `Official store` / `user` / `Installed`), a scrollable `.mkt-list` (one `.mkt-row` per item: name + full `owner/repo` + badges — "⬆ Update" if in the `updates` set, "Installed", "Disabled" if installed-but-disabled, and for `origin==='user'` items an "✕" remove button), and a footer "add a repo" row (`owner/repo` text input + "＋ Add repo…" button, Enter submits too).
- `.mkt-right`: empty-state "Select a plugin to see details." when nothing selected; else `<DetailPane>` — title/full-name/version header, a version `<select>` (populated from `detail.releases`, defaulting to the first non-prerelease), a `<PrimaryAction>` button cluster (Install / Update+Disable-Enable / Installed+Enable-Disable+Uninstall / "No installable release yet" disabled state — chosen from installed-state + tarball-availability), an inline error line, and a 4-tab strip (Readme / Permissions / Changelog / Versions) rendering: Markdown readme (`react-markdown`), a permission bullet list (`describePermissions`, only after install), release notes Markdown, or a flat version list.

Install flow reuses `<InstallConsentModal>` (see §3): clicking Install/Update calls `extension:install-preview {ref: "github:{owner}/{repo}@{tag}"}`; if the preview succeeds the modal shows manifest/version/size/integrity/permissions and "Install & trust"/"Update"; confirming calls `extension:install-commit {token}`. **Update has a silent path**: if every permission the new version requests is already granted (`isSubset`), it commits directly with no consent modal at all.

**State read**: none from `AppState` — entirely its own local state fetched via marketplace-specific IPC.

**IPC**: `marketplace:list` (no payload → `MarketplaceListItem[]`), `marketplace:check-updates` (→ `UpdateInfo[]`, reduced to a `Set<id>`), `marketplace:detail {owner,repo}` (→ `PluginDetail`), `marketplace:add-source {owner,repo}`, `marketplace:remove-source {owner,repo}`, `extension:install-preview {ref}`, `extension:install-commit {token}`, `extension:uninstall {id}`, `extension:set-enabled {id, enabled}`.

### 2.7 AddSource (`screens/AddSource.tsx` + `AddSource.css`)

**Purpose**: in-place "add a connector" panel — swapped in over the Sources body (not a modal window), plus an optional inline "Install connector…" sub-panel.

**Layout** (`.as-panel`): header (`.as-head`: "Add a source" title + "Everything stays on this machine." sub + spacer + Cancel ghost button + "Install connector…"/"Done" toggle ghost button), then `.as-grid` (4-column grid of square `.as-tile` buttons, one per connector manifest where `inAddSource` OR `opensWizard(manifest)` is true — so wizard-driven connectors like WhatsApp that aren't in the curated `inAddSource` grid still get an entry point here since the old per-connector Settings screen is gone). Each tile: `ConnectorBrandIcon` (28px) + label (machine label for `local-folder`, else the registry label); non-actionable tiles (no channel and doesn't open a wizard) render dimmed with a "Soon" chip and are `disabled`.

`opensWizard(manifest)` = true when the manifest's first step is `input-fields`/`show-copyable`/`instruction`/`live-stream` (i.e. anything that isn't a direct OAuth/auto invoke) — these open `<ConnectorWizard>` in-place; everything else invokes its registry `addChannel` directly.

If "Install connector…" is toggled, `<InstallConnector>` renders below the grid (§2.8).

**IPC**: `connector:list-manifests` (via `useManifests` hook, seeded synchronously from the static `ALL_MANIFESTS` builtin list, then refreshed with the live builtins+installed set), plus whatever per-connector `addChannel` the clicked tile carries (`connector:add-gmail-account`, `connector:add-google-docs-account`, `connector:add-ms365-account`, `connector:add-onedrive-account`, `connector:ensure-local-account`, `connector:browser-detect-and-add`).

### 2.8 InstallConnector (`screens/InstallConnector.tsx` + `InstallConnector.css`)

**Purpose**: sideload a connector from an npm name or tarball URL. Embedded inside `AddSource`.

**Layout** (`.install-connector`): a form (`npm name or tarball URL` input, an optional integrity-hash input, a "Review" button), an inline error line, a list of already-installed connectors (`.ic-list > .ic-row`: name, version, optional `loadError`, Enable/Disable + Uninstall ghost buttons), and — after a successful preview — `<InstallConsentModal>`.

**IPC**: `connector:list-installed` (no payload), `connector:install-preview {ref, hash?}`, `connector:install-commit {token}`, `connector:set-connector-enabled {id, enabled}`, `connector:uninstall {id}`.

### 2.9 Settings (`screens/Settings/*.tsx` + `Settings.css`)

**Purpose**: 5-pane settings shell. Routes `settings:account|storage|local-processing|advanced|about`, all sharing `SettingsShell`.

**Layout** (`.set-shell`, flex row): `.set-sidebar` (168px, `--bg-sidebar` violet, "Settings" label + 5 `.side-item` buttons: Account/Storage/Local processing/Advanced/About, active one highlighted) + `.set-pane` (flex:1, scrollable, 14/20px padding).

#### 2.9.1 Account (`Settings/Account.tsx`)

Header "Account" + sub. Divider. Identity block: if signed in, `<IdentityCard>` — a `.acct-row` with a 32px `.avatar` (image or initial-letter fallback), name (or email) as primary line + email as secondary line (only when both differ), a green "Signed in" pill, and a "Sign out" button (`auth:sign-out`). If signed out, `<SignedOutCard>` — same row shape with a "?" avatar, "Using kia locally" + "Sign in to sync mail and enable a remote URL." copy, and a primary "Sign in" button (`useView().requestSignIn()`). Divider. `<PreferencesPanel>` (`.pref-list` of `.pref-row` toggle switches): "Launch at login", "Show in menu bar", "Hide Dock icon" (disabled unless "Show in menu bar" is on). (Theme and "Send anonymous diagnostics" toggles were deliberately removed from the UI while inert — see §1.4.)

**State read**: `auth` slice only (`useAppStateSelector(s=>s?.auth??null)`).
**IPC**: `prefs:get`, `push:prefs-updated` subscribe, `prefs:set {launchAtLogin|showInMenuBar|hideDockIcon}` (optimistic local update before the round-trip resolves), `auth:sign-out`.

#### 2.9.2 Storage (`Settings/Storage.tsx`)

Header "Storage" + "Where your indexed data lives." Sections, divider-separated:
1. `<MetricGrid>` — 5 `.metric-tile`s: **Total documents** (sum of all segment counts + "across N connector(s)"), **Database size** (formatted bytes), **Full-text index** (FTS5+trigram size, em-dash if ≤0), **Embeddings** (count or "not enabled", muted if 0), **Needs deeper processing** (deep-extraction backlog count + activity string, muted if idle).
2. `<DistributionPanel>` — a segmented "by count"/"by size" toggle (`.seg`), a horizontal stacked `.stor-bar` (one flex-sized div per non-zero segment, colored cyclically from `SEGMENT_COLORS = [--accent-solid, --info-solid, --working-solid]`), and a `.stor-legend` (swatch + label + value per segment). Empty state: "No documents indexed yet." (no bar/legend rendered).
3. `<DataFolderPanel>` — `.path-row`: "Location" label + mono absolute path + "Open" button (`app:open-path {kind:'data-folder'}`) + copy-path icon button (clipboard).
4. `<MaintenancePanel>` — three buttons, each behind a native `window.confirm()`: "Compact database" (`data:compact` → reports bytes reclaimed), "Rebuild full-text index" (`data:rebuild-fts` → reports docs reindexed), "Clear backfill cache" (`data:clear-backfill-cache` → reports accounts reset). Results/errors surface via native `window.alert()`.

**State read**: none from `AppState` directly; re-fetches `storage:get-stats` on a **10-second leading+trailing throttle** keyed off `push:state-updated` (a cheap "something changed" signal — `storage:get-stats` itself does a full documents-table scan in main, so it must not run on every push during a backfill).
**IPC**: `storage:get-stats`, `app:open-path`, `data:compact`, `data:rebuild-fts`, `data:clear-backfill-cache`.

#### 2.9.3 Local processing (`Settings/LocalProcessing.tsx` + helpers)

Header "Local processing" + "Read images & scanned PDFs on this Mac." Sections:
1. **Runtime hero** `.lp-status` — headline + optional status pill (`STATE_PILL` map: ready→live/"Active", standby→paused/"Standby", downloading/starting/checking→working/label, error→error/"Error"; disabled/unsupported show no pill) + detail text + a right-aligned action button whose label/handler depends on state (`enable`→"Enable" `deep-runtime:enable`; `cancel`→"Cancel" `deep-runtime:cancel`; `disable`→"Disable" `deep-runtime:disable`; `retry`→"Retry" `deep-runtime:enable`); while `downloading`, a `.stor-bar`-style 2-segment progress bar shows percent.
2. **Settings** `.pref-list`: a Model `<select>` (Auto + one option per `CURATED_TIERS` model, each labelled "`Name` — `X.X` GB" + " · installed" if already downloaded; disabled while the runtime is busy) invoking `deep-runtime:set-model {modelId}` then re-fetching status; a Schedule `<select>` (Always / When idle / At night 22:00–07:00) invoking `prefs:set {deepExtractionSchedule}`. A "Process now" button appears only when schedule≠'always' and no bypass is active yet (`deep-runtime:process-now`).
3. **Activity** — a one-line staged backlog ("`N` to read · `M` to describe" or "Up to date"/"Nothing to process yet.") plus a processed-total + live scheduler-activity string (e.g. "processing (2 in flight)", "waiting until the Mac is idle", "paused — Mac is running hot").
4. **Recently processed** `.pref-list` of `.lp-recent-row` (title, mono engine name, relative time) — up to the last 10 (`stats.deepExtractionRecent`).

**State read**: none from `AppState`; own local fetches of `deep-runtime:get-status` (+ `push:deep-runtime-status` subscribe), `prefs:get` (+ `push:prefs-updated`), and the same throttled `storage:get-stats` pattern as Storage.
**IPC**: `deep-runtime:get-status`, `deep-runtime:enable`, `deep-runtime:disable`, `deep-runtime:cancel`, `deep-runtime:set-model {modelId}`, `deep-runtime:process-now`, `prefs:get`, `prefs:set {deepExtractionSchedule}`, `storage:get-stats`, plus `push:deep-runtime-status` / `push:prefs-updated` / `push:state-updated` subscriptions.

#### 2.9.4 Advanced (`Settings/Advanced.tsx`)

Header "Advanced" + "Configuration, logs, and destructive actions." Sections:
1. **Diagnostics** — Log level `<select>` (debug/info/warn/error, `prefs:set {logLevel}`), "Enable developer tools" toggle (`devToolsEnabled`), "Verbose connector logs" toggle (`verboseConnectorLogs`), then "Open logs" (`navigate('logs')`) and "Export logs (.zip)" (`logs:export-zip`, alerts the resulting path/file-count or a cancel/failure message) buttons.
2. **Danger zone** (red label) — `.danger-list` of `.danger-item` rows: "Purge archived data" (confirm → `data:purge-archived`, alerts purged count) and "Erase all data" (confirm → `data:reset-all`, alerts a fixed "wiped + signed out" message).

**IPC**: `prefs:get`/`prefs:set`/`push:prefs-updated`, `logs:export-zip`, `data:purge-archived`, `data:reset-all`.

#### 2.9.5 About (`Settings/About.tsx`)

Centered `.about-shell`: `<Spark size="app"/>`, "KIAgent" name, mono version pill (`app:get-version`), tagline paragraph, an action row (GitHub link, Release notes link — both `window.open`, hardcoded to `github.com/edjafarov/alpha-cent`, and a "Check for updates" button), an update-status line, and a plain key/value list (Version, Repository) + a copyright footer.

**Note (surprising)**: this file is marked `// @ts-nocheck` and calls `update:get-state` / `update:check` / `update:quit-and-install` invoke channels and subscribes to `push:update-state` — **none of these exist in the OSS `BaseContractMap`/`BasePushMap`** (`src/main/ipc/channels.ts`). They are overlay-only channels (added by a proprietary `ipc-ext` module via declaration merging) that this screen assumes exist. In a plain OSS build these calls simply never resolve/fire (no handler registered), so the version line still renders but the update section is permanently inert. A from-scratch rebuild should either omit the updater section or implement its own `update:*` channel handlers.

### 2.10 Marketplace/Sources test note

`src/renderer/__tests__/marketplace-route.test.tsx` and `screens/Marketplace/__tests__/Marketplace.test.tsx` exist — confirms `marketplace` is a first-class routed screen (not experimental).

---

## 3. Reusable components (`src/renderer/components/**`)

| Component | File | Props | Visual role |
|---|---|---|---|
| `TitleBar` | `TitleBar.tsx` | none | 30px window titlebar strip, see §1.6 |
| `TopBar` | `TopBar.tsx` | none | App-wide nav bar under the titlebar: `Wordmark`, a status `Pill` ("N source(s) need attention" red, or "N live · M docs" green), spacer, `NavTab`s for Sources/Marketplace/Connection (Connection carries an on/off/pending dot badge reflecting `mcp.port`), a conditional "Sign in" button (only when loaded+signed-out), and a settings-gear icon button. Reads a narrow `AppState` selector (`loaded, signedIn, erroringCount, liveCount, totalDocs, mcpPort`). |
| `BootSplash` | `BootSplash.tsx`/`.css` | none | Full-flex centered `<Spark state="blink" size="app">` + "KIAgent" label, fade-in |
| `IconSprite` | `IconSprite.tsx` | none | Re-exports `@shared/web-ui/icon-sprite`'s `IconSprite`; mounted once per app render, holds ~25 hidden `<symbol>` defs (`i-refresh-cw, i-pause, i-play, i-settings, i-search, i-plus, i-trash, i-external, i-copy, i-eye, i-folder, i-file, i-mail, i-alert-circle, i-alert-triangle, i-check, i-check-circle, i-info, i-chev-down, i-chev-right, i-arrow-right, i-more, i-x, i-shield, i-database, i-spark, i-log, i-link`) referenced via `<Icon name="…">`'s `<use href="#i-…">` |
| `StatusPill` | `StatusPill.tsx` | `{account: AccountState}` | The ONE status-pill renderer, keyed only by `account.status` (never per-connector): working→orange "Working", paused→gray "Paused", error→red "Error", needs_reauth→red "Reconnect", backfilling→orange "Backfilling `X` (`pct`%)" (unit-aware via `backfillCountsLabel`) or bare "Backfilling" if no total, live/watching/default→teal "Live" |
| `RowMenu` | `RowMenu.tsx` | `{actions: RowMenuAction[]; ariaLabel?; buttonStyle?}` where `RowMenuAction = {label, icon?, onSelect, destructive?, confirm?}` | Kebab (`i-more`) icon-only button opening a fixed-position `.tray-pop` popover (180px wide, anchored bottom-right of the trigger, repositions on scroll/resize, dismisses on outside-click/Escape); each action row optionally gated by a native `window.confirm(action.confirm)` before firing |
| `AccountRowActions` | `AccountRowActions.tsx` | `{account: Pick<AccountState,'id'\|'identifier'>; buttonStyle?; hideSyncNow?}` | Wraps `RowMenu` + `RemoveAccountModal`: builds the standard 3-action menu (Sync now [omit via `hideSyncNow`], Re-run backfill [confirm-gated], Remove [opens the modal instead of confirming inline]) |
| `RemoveAccountModal` | `RemoveAccountModal.tsx` | `{identifier, onCancel, onKeep, onPurge}` | Centered dialog (`rgba(0,0,0,.35)` backdrop, click-outside/Escape to cancel): explains Remove-vs-Delete, then 3 destructive/ghost buttons — "Remove (keep indexed data)" → `onKeep`, "Remove and delete indexed data" → `onPurge`, "Cancel" |
| `InstallConsentModal` | `InstallConsentModal.tsx` + `folder-picker/FolderPicker.css` (backdrop) + `../screens/InstallConnector.css` (`.icm-*` dialog chrome) | `{preview: InstallPreview; busy; error?; source?: {label,value}; onCancel; onConfirm}` | Reused by both `InstallConnector` and `Marketplace`: shows manifest displayName + monogram glyph, an `Identifier/Version/Size/Source?/Integrity` meta grid, a bulleted permission list (`describePermissions`), a fixed trust disclaimer, an error banner, Cancel + "Install & trust"/"Installing…" buttons |
| `ConnectorBrandIcon` | `ConnectorBrandIcon.tsx` | `{icon: string\|null\|undefined; label: string; size?=24; className?; style?}` | 3-tier icon resolver: (1) a bundled brand SVG keyed by manifest `icon` string (`gmail, gdocs, ms365, onedrive, slack, notion, instagram, whatsapp, browser, imap, local` — full-color multi-path SVGs, notion is a bordered white "N" monogram tile, instagram uses a `userSpaceOnUse` gradient ring); (2) a sideloaded connector's own icon, only if it's an inert `data:image/*` URI or literal `<svg …>` markup (wrapped as a data-URI `<img>` — remote URLs/`javascript:` are rejected for security); (3) fallback: first-letter monogram of `label` |
| `DriveFolderPicker` | `DriveFolderPicker.tsx` | `{accountId, existingFolders?: {folderId,displayPath}[], onClose}` | Google Drive folder-tree modal (My Drive / Shared with me roots), lazy-expand, per-folder file counts fetched with a concurrency-4 worker pool, a debounced (250ms) search-by-name mode with All/My Drive/Shared source tabs, a chip tray of selections, footer "Add N folders" |
| `LocalFolderPicker` | `LocalFolderPicker.tsx` | `{accountId, existingFolders?: {path}[], onClose}` | Local filesystem folder-tree modal; two modes toggled by buttons — "Quick links" (Desktop/Documents/Downloads) vs "Browse from drive root…" (all drives); lazy recursive indexable-file counts per visible folder ("counting…" → "`N` file(s)"/"`N`+ files") |
| `OneDriveFolderPicker` | `OneDriveFolderPicker.tsx` | `{accountId, existingFolders?: {folderId,displayPath}[], onClose}` | Same shell as Drive's picker but simpler (no search, no counts fetch — `childCount` arrives inline from the list call); roots "My files"/"Shared with me" |
| `folder-picker/shell.tsx` | shared pieces | — | `FolderPickerModal` (backdrop+card+header+close), `FolderPickerFooter` (summary + Cancel + "Add N folders"), `FolderPickerErrors`, `ChipTray` (removable selection chips, tracked ones shown disabled-styled), `TreeNode<N>` (generic chevron+checkbox+folder-icon+name+trailing-count row, recursive), `CountBadge`, `splitDisplayPath`/`formatCount` helpers |
| `folder-picker/useLazyTree.ts` | hook | `{getKey, loadChildren, initial?}` | Shared lazy-tree state machine (tree array, loading-node Set, `mutate(key,fn)`, `toggleExpand` that fetches-on-first-expand then just toggles) reused verbatim by all 3 pickers |

**Wizard components** (`components/wizard/`):

| File | Role |
|---|---|
| `ConnectorWizard.tsx` | Generic manifest-driven multi-step modal (`.modal-backdrop > .card`). Renders one `StepView` per manifest step in order: `instruction` (title+body+optional link), `show-copyable` (title+body+readonly textarea+optional Copy button, 2s "Copied ✓" flash), `input-fields` (label+select/input per field, client-validated via `formIsValid`), `oauth` (a single "Sign in" button that calls `connector:add-account`), `auto` (invisible — fires `connector:add-account` once on mount), `live-stream` (delegates entirely to `LiveStreamView`, replacing the whole modal). A trailing Cancel/Connect footer appears only if the manifest declares `submit`. |
| `wizard-model.ts` | Pure helpers: `initialFormState(fields)`, `applyFieldRule`, `fieldValue` (coerces number inputs), `formIsValid` (a field is required iff no default and not a select), `FIELD_RULES` (currently one entry: `imap-port-default` sets port 993/143 from the security select), `STEP_CONTENT` (empty — hook for show-copyable dynamic content), `mapStreamEvent(payload, renderKeys)` (adapts a live-stream push payload `{qr?,status?,error?}` to `{state, qr?, error?}`) |
| `connector-catalog.ts` | `opensWizard(manifest)` (see §2.7), `useManifests(reloadKey?)` hook (`ALL_MANIFESTS` static seed → `connector:list-manifests` refresh, also populates the manifest cache) |
| `LiveStreamView` (inside `ConnectorWizard.tsx`) | QR/pairing modal: calls `connector:stream-begin {connectorId}` on mount, subscribes to the manifest-declared push channel (`step.channel`, cast as `PushChannel` — dynamically extension-declared), renders states per `step.render[state]` (`qr-image` → decodes the QR string via the `qrcode` package into a 264×264 data-URL image; `success` → checkmark + text, optional `autoCloseMs` auto-dismiss; `error`/`waiting`), an optional danger banner (`step.banner`), a `step.timeoutMs` fallback timer, and on unmount (unless already succeeded) calls `connector:account-action {action:'cancel-pairing'}` to abort a half-finished pairing |

**Connector-widget components** (`components/connector-widgets/`) — see §5.

---

## 4. State management

### 4.1 Mechanism: pull-then-push, single shared store

- The renderer never polls the UI-affecting state; it does one **pull** (`app:get-state` invoke) at first-subscriber attach, and thereafter is entirely **push**-driven over `push:state-updated`.
- Main also runs a defensive 5-second catch-up interval (`main.ts:1190-1197`) that only actually broadcasts if a "state gate" says the cached snapshot might be stale (`stateGate.isCachedFresh()`) — i.e. under normal conditions events (not this timer) drive UI freshness; the timer exists purely to guarantee eventual consistency if a discrete broadcast call site were ever missed.
- Every mutating action (`connector:*`, `auth:*`, etc.) is expected to be followed by main re-broadcasting `push:state-updated` with a full fresh snapshot — the renderer's optimistic UI (spinners, pending flags) is purely local component state that clears itself on the next render, not a merge into the shared store.

### 4.2 Module: `state/push-subscriptions.ts`

- Module-level singleton store: `appState: AppState|null`, a `Set<listener>` , `attach()/detach()` lifecycle tied to subscriber count (last unsubscribe drops the cached snapshot so a later remount doesn't serve stale data from a since-replaced `window.kiagent` bridge — relevant to tests and dev hot-restarts).
- `attach()` is idempotent and defends against a missing bridge (`window.kiagent` absent) by simply not attaching — the next subscriber retries.
- Race guard: `bridge.on('push:state-updated', …)` is wired **before** the initial `bridge.invoke('app:get-state')` resolves; a `gotPush` flag ensures a push that arrives first is never clobbered by a slow `get-state` response landing after it.
- `subscribeAppState(listener)` / `getAppState()` — the `useSyncExternalStore` plumbing.
- `useAppStateSelector(selector)` — the primary consumption API. Wraps `useSyncExternalStore` with a **shallow-equal cache**: a selector returning a fresh object every call (e.g. `s => ({signedIn: s.auth.signedIn})`) still bails out of re-rendering if every key's value is `Object.is`-equal to last time (`shallowEqual`, one-level, arrays compared by reference). This is the mechanism every screen uses to avoid re-rendering on unrelated state churn (e.g. `TopBar` only re-renders when its 6-field-derived slice changes, not on every backfill tick).
- `useAppState()` = `useAppStateSelector(s=>s)` (whole-object subscription; used by screens that read many fields, e.g. `SourcesList`, `SourceDetail`).

### 4.3 `AppState` shape (canonical types re-exported from `@main/snapshot`)

```ts
interface AppState {
  accounts: SnapshotAccount[];
  mcp: { port: number | null; bearer: string | null };
  auth: {
    signedIn: boolean;
    localMode: boolean;        // "use kia locally" persisted pref
    email: string | null;
    name?: string | null;      // best-effort profile; optional
    avatarUrl?: string | null; // data:image/... URL or null
  };
  cadence?: Record<string, CadenceConfig>; // keyed by String(account.id); sparse
}

interface SnapshotAccount {          // == "AccountState" in renderer imports
  id: string;
  source: string;                    // 'gmail'|'google-docs'|'ms365'|'onedrive'
                                      // |'local-folder'|'local'|'browser'|'imap'|...
  identifier: string;
  display_name: string | null;
  status: string | null;             // 'live'|'watching'|'working'|'backfilling'
                                      // |'paused'|'error'|'needs_reauth'|null
  backfill_done_count: number | null;
  backfill_total_estimate: number | null;
  backfill_eta_seconds?: number | null;
  doc_count: number;
  last_sync_at: string | null;       // ISO
  last_document_at: string | null;   // ISO
  last_document_title?: string | null;
  recent_documents?: { ts: string; title: string | null; from_address?: string | null }[]; // up to 5, newest-first
  last_error: string | null;
  tracked_roots: SnapshotTrackedRoot[];
  tenant_kind?: 'personal' | 'work';  // onedrive/ms365 only
}

interface SnapshotTrackedRoot {
  id: string;
  kind: string;               // 'drive'|'ms-drive'|'fs'|'browser'|...
  abs_path: string | null;
  external_id: string | null;
  display_path: string | null;
  last_full_scan_at: string | null;
  doc_count: number;
}

interface CadenceConfig {
  focused: number;             // ms
  unfocused: number;           // ms
  defaultFocused: number;      // ms (30_000)
  defaultUnfocused: number;    // ms (120_000)
}
```

**Field-by-field: what each screen actually reads** (exhaustive):

- `TopBar`: `auth.signedIn`, `accounts[].status` (counts `error`/`needs_reauth` and `live`/`backfilling`), `accounts[].doc_count` (summed), `mcp.port`.
- `SourcesList`: `accounts[]` wholesale (partitioned by `status`), `auth.signedIn`, `auth.localMode`.
- `SourceTable`/`SourceRow`: `id, source, identifier, display_name, status, backfill_done_count, backfill_total_estimate, doc_count, last_document_at, tenant_kind, tracked_roots[].kind`.
- `ErrorCard`: `source, identifier, status, last_error, id`.
- `GetStartedPanel`/`onboarding-steps.ts`: `accounts[0].status/backfill_total_estimate/backfill_done_count/backfill_eta_seconds`, `accounts.length` (plus `AppPrefs.onboarding.*`, not `AppState`).
- `IdeasPanel`: `accounts[].source` only (to know which connectors are "connected").
- `SourceDetail` + all its sections: the full `SnapshotAccount` for the matched `id` — `identifier, backfill_total_estimate, backfill_done_count, backfill_eta_seconds, doc_count, last_sync_at, last_document_at, status, source, tenant_kind, tracked_roots (all fields), recent_documents (all fields), last_error`. `Cadence.tsx` additionally reads `state.cadence?.[accountId]`.
- `ConnectionHub`: `mcp.port` (and `mcp.bearer` is read by the `snippets.ts` builder's `Transport` type but the current call sites always pass `bearer: null` for the local URL).
- `Settings/Account.tsx`: `auth.signedIn, auth.email, auth.name, auth.avatarUrl`.
- `AccountRowActions`/`RowMenu` consumers: `id, identifier` only (narrow `Pick<AccountState,...>`).
- `ResourcePicker`/`AccountResourcePickers`: `tracked_roots` (filtered by `kind`), `id`.
- Nothing in the renderer reads `mcp.bearer` for display; `Logs`, `Marketplace`, `InstallConnector` don't read `AppState` at all.

### 4.4 Other renderer-local stores (outside `AppState`)

- **Log stream** (`state/log-stream.ts`): independent module-level ring buffer, capacity 1000 `LogRecord {ts, level, msg, seq, [k:string]:unknown}` (`seq` is a renderer-assigned monotonic counter, never trusted from the wire). Boots once via `initLogStream()` (called from `index.tsx` before first paint, idempotent). Subscribes to `push:log` (main batches into arrays on a ~250ms window; single objects and legacy raw strings are also accepted for wire-compat) and seeds from `app:read-recent-logs {limit:1000}` on init (disk-persisted tail, prepended ahead of any already-captured live records). Exposes `subscribeLogStream`/`getLogRecords`/`clearLogStream` via `useSyncExternalStore` in `Logs.tsx`.
- **Manifest cache** (`connectors/manifest-cache.ts`): `latest: ConnectorManifest[]`, seeded with the static `ALL_MANIFESTS`, replaced wholesale whenever `connector:list-manifests` resolves (via `useManifests`/`setCachedManifests`). `cachedManifestById(id)` is a synchronous lookup used by `connectorForSource`/`manifestForSource` so components don't need to thread manifest-loading state everywhere.
- **Prefs** (`AppPrefs`, `src/main/prefs.ts`): NOT part of `AppState`; each settings screen independently does `prefs:get` + `push:prefs-updated` subscribe + optimistic `prefs:set` patches. Shape: `logLevel, verboseConnectorLogs, devToolsEnabled, launchAtLogin, showInMenuBar, hideDockIcon, theme, sendDiagnostics, remoteEnabled, usingLocally, remoteMigratedAt, onboarding:{sourceBackfilledAt,mcpConnectedAt,firstQueryAt,dismissedAt}, deepExtraction:{enabled}, deepExtractionSchedule:'always'|'idle'|'night', deepExtractionModelOverride:'auto'|string, browserHistory:{windowDays,blocklist}`.
- **Deep-runtime status** (`RuntimeStatus`, `src/main/inference/runtime/types.ts`): own `deep-runtime:get-status` + `push:deep-runtime-status` subscription in `LocalProcessing.tsx` only. Shape: `state: 'disabled'|'unsupported'|'checking'|'downloading'|'starting'|'ready'|'standby'|'error'`, plus conditional `reason, progress:{receivedBytes,totalBytes}, endpoint, modelName, accel:'metal'|'vulkan'|'cpu', slow, error, installedModelIds[]` (the last only populated by the get-status response, not by pushes — screens merge it in manually to avoid losing it on a push).
- **Storage stats** (`StorageStats`, `src/main/db/storage-stats.ts`): fetched independently by `Storage.tsx` and `LocalProcessing.tsx`, each with its own 10s throttle keyed off `push:state-updated`. Shape: `dbSizeBytes, ftsSizeBytes, embeddingCount, deepExtraction?:{pending,processing,done,skipped,failed,ocr_done?,scheduler?}, accountCount, segments:{label,source,count,contentBytes}[], dataFolder, deepExtractionRecent?:{id,title,engine,updatedAt}[]`.

---

## 5. Connector-specific UI

### 5.1 Static registry vs. manifest-driven

Two parallel sources of connector metadata, deliberately reconciled:

1. **`connectors-registry.ts`** — a hand-written `ConnectorDescriptor[]` (`CONNECTOR_REGISTRY`) for the 7 connectors that predate the manifest system: `gmail, google-docs, ms365, onedrive, local-folder, browser, imap`. Each descriptor: `{key, sources[], label, brandIcon, addChannel, addLabel, pollable, showWhenEmpty, inAddSource, reauthChannel?, scopeNote?}`. `sources[]` handles the `local`/`local-folder` alias (both persisted values map to one descriptor).
2. **Manifests** (`src/main/connectors/manifest.ts` schema + `src/main/connectors/manifests.ts` `ALL_MANIFESTS`) — the same 7 builtins are ALSO declared as manifests (declarative `steps[]`), plus any installed/sideloaded third-party connector arrives ONLY as a manifest (fetched via `connector:list-manifests`). `connectorForSource(source)` (registry lookup, falling back to `cachedManifestById` → `descriptorFromManifest`, falling back to a raw-string `DEFAULT_CONNECTOR`) is the single function every screen calls to resolve a persisted `account.source` to display metadata — never hardcode a connector's label/icon elsewhere.

The CSS/icon system (connector stripes, `ConnectorBrandIcon`'s `BRAND_ICONS` map, `--tag-*` tokens) already includes **Notion, Slack, WhatsApp, Instagram** — none of which are builtin manifests today (`ALL_MANIFESTS` has exactly gmail/google-docs/ms365/onedrive/imap/browser/local-folder). These are anticipated marketplace-installed extensions; a rebuild should keep the icon/stripe slots even though no first-party connector ships for them yet.

### 5.2 Manifest step types → wizard UI

`src/main/connectors/manifest.ts` (zod schema) defines the closed set of step types a connector can declare, each with a fixed renderer treatment (all in `ConnectorWizard.tsx`'s `StepView`):

| Step type | Fields | Renderer treatment |
|---|---|---|
| `instruction` | `title, body, link?` | Plain text block + optional "Open" link |
| `show-copyable` | `title, body, content: string \| {hook}, copyButton, link?` | Read-only textarea + optional Copy button (2s "Copied ✓") |
| `input-fields` | `fields: Field[], validate, note?` | One labeled `<select>`/`<input>` per field; `Field = {key,label,input:'text'\|'password'\|'number'\|'select'\|'textarea', options?, placeholder?, default?, onChange?}`; client-validated via `formIsValid` |
| `oauth` | `provider:'google'\|'microsoft', scopes[], identityFrom, tenantFrom?` | A single "Sign in"/"Signing in…" button invoking `connector:add-account` |
| `live-stream` | `start, channel, render: Record<string,RenderEntry>, onAbandon?, timeoutMs?, banner?` | Delegates to `LiveStreamView` — see §2 wizard row; `RenderEntry = {as:'qr-image'\|'success'\|'error'\|'waiting', from?, text?, autoCloseMs?}` |
| `resource-picker` | `tree, virtualRoots?, quickLinks?, showDrives?, multiSelect, writesTo:'tracked_roots', kind` | NOT rendered by the wizard — consumed post-connect by `ResourcePicker`/`AccountResourcePickers` on `SourceDetail`'s Tracked Content section; `tree` selects which picker component (`'drive-folders'`→`DriveFolderPicker`, `'ms-drive-items'`→`OneDriveFolderPicker`, `'local-fs'`→`LocalFolderPicker`) |
| `auto` | `run` | Invisible — fires `connector:add-account` once on mount, no user interaction |

Manifest-level fields beyond steps: `id, displayName, icon, capabilities:{multiAccount,requiresAuth,supportsBackfill,supportsDelta,supportsRealtime}, inAddSource, pollable, submit?, configPanel?:{fields}, actions?:{key,label,hook}[], permissions?, version?, hostApi?, entry?, scopeNote?, addLabel?` (the last 4 + `version/hostApi/entry` are external-connector-only fields, absent on builtins).

### 5.3 Per-account connector widgets (`components/connector-widgets/`)

- **`BlockScopeWidgets.tsx`** — rendered once per account inside `SourceDetail`'s ConnectorConfig section (only if the manifest declares `configPanel` and/or `actions`): renders `<ConfigPanelWidget manifest>` then one `<ConnectorActionButton>` per declared action.
- **`ConfigPanelWidget.tsx`** — today hardcoded to exactly one concrete panel, `BrowserPrivacyPanel` (selected purely by "does this manifest have a `configPanel`" — the general field-driven config-panel renderer is a documented future task, #80): a "History window" `<select>` (Last 30 days/90 days/1 year/Everything → `windowDays` 30/90/365/3650) and a "Blocked domains (one per line)" `<textarea>`, both disabled until the persisted config loads, saved via `connector:browser-set-privacy {windowDays, blocklist}` on change/blur, loaded via `connector:browser-get-privacy`.
- **`ConnectorActionButton.tsx`** — one button per manifest `action` (`{key,label,hook}`); clicking invokes `connector:account-action {connectorId, action: action.hook, payload:{accountId?}}`, shows "Importing…" while busy, then a success/failure text line from `genericActionResult` (`{ok,message}`→success text, `{ok:false,error:'cancelled'}`→silently nothing, else failure text). `ACTION_BEHAVIORS` (a per-hook behavior registry keyed by `action.hook`, `connector-actions.ts`) is currently **empty** — every action today falls through to the generic `connector:account-action` dispatch path; the registry exists as an extension point for a future hook needing bespoke request/response shaping.
- **`ResourcePicker.tsx`** — renders the tracked-root rows for one `resource-picker` step's `kind` (folder icon + leaf name + mono full path + doc count + a "Watching" live pill + a remove button invoking the kind-specific remove channel: `connector:remove-drive-folder`/`connector:remove-onedrive-folder`/`connector:remove-local-folder`) plus an icon-only "+" button that opens the matching picker modal (`DriveFolderPicker`/`OneDriveFolderPicker`/`LocalFolderPicker`, chosen by `step.tree`). Clicking a tracked-root row navigates to `sources:detail` for that account (a no-op if already there). `AccountResourcePickers` fans this out over every `resource-picker` step a manifest declares (today, always exactly one per connector) and can auto-open the first one's picker (`autoOpen` prop, driven by `ViewParams.anchor==='pick-folders'`).

### 5.4 OAuth flow

Handled entirely main-side (external browser or embedded flow — not in renderer scope); the renderer's only involvement is firing `connector:add-account {connectorId}` (or the legacy dedicated `connector:add-gmail-account` etc. channels) and waiting for the resulting `AddResult = {ok:true,accountId?} | {ok:false,error?,message?}` — there is no renderer-rendered OAuth consent screen; whatever browser/webview the OS opens is outside this UI.

### 5.5 QR pairing flow

Fully covered by `LiveStreamView` (§3, wizard components) — this is the mechanism a WhatsApp-style connector would use: `connector:stream-begin` kicks off pairing server-side, a per-connector push channel streams `{qr?|status?|error?}` events, the renderer renders a `qrcode`-encoded PNG data-URL, and an unmount-without-success calls `connector:account-action {action:'cancel-pairing'}` to clean up server-side pairing state.

### 5.6 Extension UI slots (`ext-slots.ts` / `ext-noop.ts`)

- `ext-slots.ts` is a tiny registry with exactly one slot today: `registerRemoteSection(component)` / `getRemoteSection(): ComponentType|null`. `ConnectionHub` calls `getRemoteSection()` and renders it (if non-null) as the first thing inside its first `.conn-group`, ahead of the local "Manual setup" disclosure. In OSS, nothing ever calls `registerRemoteSection`, so this is always `null` and the Connection screen shows only the Local section + a bare Manual-setup instructions paragraph in place of a public-URL/Remote card.
- `ext-noop.ts` is what the `@renderer-ext` tsconfig path alias resolves to in OSS (`tsconfig.json`: `"@renderer-ext": ["src/renderer/ext-noop.ts"]`). `App.tsx`'s very first import is `import '@renderer-ext'` — a pure side-effect import whose OSS implementation is an empty module (`export {}`). A proprietary overlay build swaps this alias to a module that calls `registerRemoteSection(...)` (and potentially `registerScreen`/other registry hooks) at import time, before `App` renders. This is the ONE extension seam in the whole renderer; everything else (manifests, marketplace extensions) is data-driven through IPC, not code-injected.

---

## 6. Complete IPC surface consumed by the renderer

All channels are declared in `src/main/ipc/channels.ts` (`BaseContractMap` for invoke, `BasePushMap` for push) and typed end-to-end: `window.kiagent.invoke<C>(channel, payload?): Promise<ChannelRes<C>>` / `window.kiagent.on<C>(channel, listener): ()=>void` (`src/renderer/ipc.ts`, `preload.ts`). The preload bridge runtime-validates every channel name against `InvokeChannels`/`PushChannels` allowlists (throws `unknown invoke/push channel` on anything not in the compile-time-synced arrays) — a rebuild's bridge must reproduce this allowlist gate, not just the type signature.

Legend: **invoke** = renderer `ipc().invoke(channel, req)` → `Promise<res>`; **on** = renderer `ipc().on(channel, cb)` one-way push from main.

| Channel | Dir | Request shape | Response / payload shape | Used by |
|---|---|---|---|---|
| `app:get-state` | invoke | `void` | `AppState` (§4.3) | `push-subscriptions.ts` (initial pull) |
| `app:get-version` | invoke | `void` | `string` | `Settings/About.tsx` |
| `app:get-log-path` | invoke | `void` | `string` | `Logs.tsx` |
| `app:read-recent-logs` | invoke | `{limit?: number}` | `unknown` (array of raw log records) | `state/log-stream.ts` (boot seed, `limit:1000`) |
| `app:open-path` | invoke | `{kind?: 'log-file'\|'data-folder'}` | `unknown` | `ErrorCard`, `Logs`, `Storage`, `Advanced` |
| `app:show-main-window` | invoke | `string` | `unknown` | not called from any renderer screen found (main/tray-triggered) |
| `app:quit` | invoke | `void` | `void` | not called from renderer UI |
| `app:navigate` | on | — | `string` (a path, see §1.2 `pathToView`) | `App.tsx` |
| `auth:sign-in` | invoke | `{provider?: string; withGmail?: boolean}` | `RunSignInResult` (`{ok:boolean; message?:string}` as consumed) | `SignIn.tsx` |
| `auth:sign-out` | invoke | `void` | `unknown` | `Settings/Account.tsx` |
| `auth:use-locally` | invoke | `undefined \| {}` | `{ok:boolean; error?:string}` | `SignIn.tsx` |
| `connector:list` | invoke | `void` | `unknown` | not called from any renderer screen found |
| `connector:sync-now` | invoke | `{accountId?: string\|null}` | `unknown` | `SourcesList` ("Sync all", `accountId:null`), `SourceDetail`, `AccountRowActions` |
| `connector:pause` | invoke | `{accountId?: string\|null}` | `unknown` | `SourceDetail`, `DangerZone` |
| `connector:resume` | invoke | `{accountId: string}` | `unknown` | `SourceDetail`, `DangerZone` |
| `connector:set-cadence` | invoke | `{accountId, focusedMs, unfocusedMs}` | `unknown` | `sections/Cadence.tsx` |
| `connector:remove-account` | invoke | `{accountId, purge?: boolean}` | `unknown` | `AccountRowActions`, `DangerZone` (via `RemoveAccountModal`) |
| `connector:retry-backfill` | invoke | `{accountId?: string}` | `unknown` | `ErrorCard`, `AccountRowActions`, `DangerZone` |
| `connector:add-gmail-account` | invoke | `void` | `unknown` | `AddSource` (Gmail tile), `ErrorCard`/`SourceDetail` reauth |
| `connector:add-google-docs-account` | invoke | `void` | `unknown` | `AddSource`, reauth |
| `connector:add-ms365-account` | invoke | `void` | `unknown` | `AddSource`, reauth |
| `connector:add-onedrive-account` | invoke | `void` | `unknown` | `AddSource`, reauth |
| `connector:list-manifests` | invoke | `void` | `ConnectorManifest[]` | `connector-catalog.ts` (`useManifests`) |
| `connector:add-account` | invoke | `{connectorId: string; payload?: Record<string,unknown>}` | `unknown` (`AddResult`-shaped) | `ConnectorWizard` (auto/oauth/submit steps), `AddSource` |
| `connector:account-action` | invoke | `{connectorId, action: string, payload?: Record<string,unknown>}` | `unknown` (`{ok,message}`/`{ok:false,error}`-shaped) | `ConnectorActionButton`, `LiveStreamView` (`action:'cancel-pairing'`) |
| `connector:stream-begin` | invoke | `{connectorId: string}` | `unknown` (`AddResult`-shaped) | `LiveStreamView` |
| `connector:install-preview` | invoke | `{ref: string; hash?: string}` | `{ok:true,token,manifest,version,integrity,sizeBytes,permissions}\|{ok:false,error}` | `InstallConnector` |
| `connector:install-commit` | invoke | `{token: string}` | `{ok:true,id}\|{ok:false,error}` | `InstallConnector` |
| `connector:list-installed` | invoke | `void` | `{id,version,ref,enabled,displayName,loadError?}[]` | `InstallConnector` |
| `connector:uninstall` | invoke | `{id: string}` | `{ok:boolean; error?}` | `InstallConnector` |
| `connector:set-connector-enabled` | invoke | `{id, enabled: boolean}` | `{ok:boolean; error?}` | `InstallConnector` |
| `extension:install-preview` | invoke | same as `connector:install-preview` | same | `Marketplace` |
| `extension:install-commit` | invoke | same as `connector:install-commit` | same | `Marketplace` |
| `extension:list-installed` | invoke | same as `connector:list-installed` | same | not called from any renderer screen found |
| `extension:uninstall` | invoke | same as `connector:uninstall` | same | `Marketplace` |
| `extension:set-enabled` | invoke | same as `connector:set-connector-enabled` | same | `Marketplace` |
| `connector:list-drive-folders` | invoke | `{accountId?, parentId?, pageToken?}` | `{ok,folders?:{id,name}[],error?}` | `DriveFolderPicker` |
| `connector:count-drive-folder-files` | invoke | `{accountId?, folderId?}` | `{ok,count?,capped?,error?}` | `DriveFolderPicker` |
| `connector:search-drive-folders` | invoke | `{accountId?, query?, sourceTab?:'all'\|'mydrive'\|'shared'}` | `{ok,hits?:{id,name,path:string[]}[],error?}` | `DriveFolderPicker` |
| `connector:add-drive-folder` | invoke | `{accountId?, folderId?, displayPath?}` | `{ok,error?}` | `DriveFolderPicker` |
| `connector:remove-drive-folder` | invoke | `{accountId?, rootId?}` | `unknown` | `ResourcePicker` (Drive) |
| `connector:list-onedrive-folders` | invoke | `{accountId?, parentId?, pageToken?}` | `{ok,folders?:{id,name,childCount?}[],error?}` | `OneDriveFolderPicker` |
| `connector:add-onedrive-folder` | invoke | `{accountId?, itemId?, displayPath?}` | `{ok,error?}` | `OneDriveFolderPicker` |
| `connector:remove-onedrive-folder` | invoke | `{accountId?, rootId?}` | `unknown` | `ResourcePicker` (OneDrive) |
| `connector:ensure-local-account` | invoke | `void` | `unknown` | `AddSource` (local-folder tile) |
| `connector:list-local-folders` | invoke | `{path?, special?:'quick'\|'drives'}` | `{ok,entries?:{path,name,hasChildren}[],error?}` | `LocalFolderPicker` |
| `connector:count-local-files` | invoke | `{path?}` | `{ok,count?,capped?}` | `LocalFolderPicker` |
| `connector:add-local-folder` | invoke | `{accountId?, path?}` | `{ok,error?}` | `LocalFolderPicker` |
| `connector:remove-local-folder` | invoke | `{accountId?, rootId?}` | `unknown` | `ResourcePicker` (local) |
| `connector:browser-detect-and-add` | invoke | `void` | `unknown` | `AddSource` (Browsers tile — also the manifest's `auto` step) |
| `connector:browser-get-privacy` | invoke | `void` | `BrowserHistoryPrefs` (`{windowDays,blocklist}`) | `ConfigPanelWidget` |
| `connector:browser-set-privacy` | invoke | `{windowDays?, blocklist?}` | `unknown` | `ConfigPanelWidget` |
| `mcp-stdio:get-config` | invoke | `void` | `StdioLaunchDescriptor` (`{command,args,env}`) | `ConnectionHub` |
| `connection:list-clients` | invoke | `void` | `ClientInfo[]` (`{id,label,transport,configPath,detected,connected}`) | `LocalClients` |
| `connection:connect` | invoke | `{clientId}` | `ConnectionWriteResult` (`{ok:true,path,backupPath}\|{ok:false,error}`) | `LocalClients` |
| `connection:disconnect` | invoke | `{clientId}` | `ConnectionWriteResult` | `LocalClients` |
| `mcp:activity:get` | invoke | `void` | `unknown` | not called from any renderer screen found |
| `suggestions:get` | invoke | `void` | `Suggestion[]` (`{id,tier,title,text,source,matchCount}`) | `IdeasPanel` |
| `storage:get-stats` | invoke | `void` | `StorageStats` (§4.4) | `Storage`, `LocalProcessing` |
| `data:purge-archived` | invoke | `void` | `{ok:true,purged:number}` | `Advanced` |
| `data:reset-all` | invoke | `void` | `unknown` | `Advanced` |
| `data:compact` | invoke | `void` | `{ok:true,beforeBytes,afterBytes}\|{ok:false,error}` | `Storage` |
| `data:rebuild-fts` | invoke | `void` | `{ok:true,indexed}\|{ok:false,error}` | `Storage` |
| `data:clear-backfill-cache` | invoke | `void` | `{ok:true,cleared}\|{ok:false,error}` | `Storage` |
| `prefs:get` | invoke | `void` | `AppPrefs\|null` | `Account`, `Advanced`, `LocalProcessing`, `GetStartedPanel` |
| `prefs:set` | invoke | `PrefsPatch` (partial `AppPrefs` + partial nested `onboarding`/`deepExtraction`) | `{ok:false,error}\|{ok:true,prefs:AppPrefs}` | same 4 screens |
| `push:prefs-updated` | on | — | `AppPrefs` | same 4 screens (stay-in-sync subscription) |
| `logs:export-zip` | invoke | `void` | `{ok:true,path,bytes,fileCount}\|{ok:false,canceled?,error?}` | `Advanced` |
| `deep-runtime:get-status` | invoke | `void` | `RuntimeStatus` | `LocalProcessing` |
| `deep-runtime:enable` | invoke | `void` | `void` | `LocalProcessing` |
| `deep-runtime:disable` | invoke | `void` | `void` | `LocalProcessing` |
| `deep-runtime:cancel` | invoke | `void` | `void` | `LocalProcessing` |
| `deep-runtime:set-model` | invoke | `{modelId?: string}` | `RuntimeStatus` | `LocalProcessing` |
| `deep-runtime:process-now` | invoke | `void` | `void` | `LocalProcessing` |
| `push:deep-runtime-status` | on | — | `RuntimeStatus` | `LocalProcessing` |
| `marketplace:list` | invoke | `void` | `MarketplaceListItem[]` | `Marketplace` |
| `marketplace:detail` | invoke | `{owner, repo}` | `PluginDetail` (`{listing,readmeMarkdown,releases:ReleaseInfo[]}`) | `Marketplace` |
| `marketplace:add-source` | invoke | `{owner, repo}` | `UserSource[]` | `Marketplace` |
| `marketplace:list-sources` | invoke | `void` | `UserSource[]` | not called from any renderer screen found (available, unused) |
| `marketplace:remove-source` | invoke | `{owner, repo}` | `UserSource[]` | `Marketplace` |
| `marketplace:check-updates` | invoke | `void` | `UpdateInfo[]` (reduced to a `Set<id>` in `Marketplace`) | `Marketplace` |
| `push:state-updated` | on | — | `AppState` | `push-subscriptions.ts` (fan-out to every screen via selectors) |
| `push:log` | on | — | `unknown` (array-batched `LogRecord`-ish objects, or a single object/string for wire-compat) | `state/log-stream.ts` |
| `push:connector-stream` | on | — | `unknown` (generic name; ACTUAL per-connector live-stream channels are the manifest-declared `step.channel` strings, e.g. a WhatsApp connector's own push channel — cast to `PushChannel` at the call site since they're not statically in `BasePushMap`) | `LiveStreamView` (dynamically, per manifest) |
| `push:mcp-activity` | on | — | `unknown` | not subscribed by any renderer screen found (reserved for a live MCP-activity indicator) |

Not in `BaseContractMap`/`BasePushMap` but called by renderer code anyway (overlay-only, OSS no-ops): `update:get-state` (invoke), `update:check` (invoke), `update:quit-and-install` (invoke), `push:update-state` (on) — all in `Settings/About.tsx`, which is `// @ts-nocheck` specifically because of this (see §2.9.5).

Channel-name **discovery mechanism** for third-party/live-stream connectors: a manifest's `live-stream` step names its own push channel (`step.channel`); the wizard subscribes to it via `ipc().on(channel as PushChannel, …)`, bypassing the compile-time exhaustiveness check that `BasePushMap` normally provides (overlay/extension push channels merge into `PushRegistry` via TypeScript declaration merging in `ipc-ext/*` modules, which core never statically imports).

---

## 7. Assets

- **Fonts**: Inter (400/500/600/700) + JetBrains Mono (400/500), loaded via a Google Fonts `@import` in `tokens.css` — network-dependent, no bundled `.woff2` fallback exists today (a rebuild wanting offline support should self-host these two families at those exact weights).
- **Icons**: no icon *files* — every glyph is an inline SVG. Two parallel icon systems exist:
  - `@shared/web-ui/icon-sprite.tsx` — a single `<symbol>`-sprite of ~27 Lucide-style outline icons (24×24 viewBox, `stroke="currentColor"`, `strokeWidth:1.5`, round caps/joins), consumed via `<Icon name="…">` → `<use href="#i-…">`. Exact id list: `refresh-cw, pause, play, settings, search, plus, trash, external, copy, eye, folder, file, mail, alert-circle, alert-triangle, check, check-circle, info, chev-down, chev-right, arrow-right, more, x, shield, database, spark, log, link`.
  - Brand marks are hand-drawn multi-color inline SVGs, duplicated in two places with the same paths: `ConnectorBrandIcon.tsx`'s `BRAND_ICONS` map (`gmail, gdocs, ms365, onedrive, slack, notion, instagram, whatsapp, browser, imap, local`) and `provider-glyphs.tsx`'s `GoogleGlyph`/`MicrosoftGlyph` (used specifically on the SignIn screen's provider buttons, which follow each vendor's official brand guidelines for colors/border/font — see §1.5).
- **Logo mark**: `spark-geometry.ts` (not read verbatim above, but referenced throughout) defines `SPARK_PATH`/`SPARK_VIEWBOX` (the bare 4-point star/astroid "Spark") and `BRACKET_PATHS`/`BRACKET_FRAME_COLOR`/`BRACKET_STROKE_WIDTH`/`BRACKET_SPARK_TRANSFORM` (the framed "Bracket" — the Spark inside a focus-reticle frame, `#a78bfa` stroke, used at ≥24px sizes only — see `Spark.tsx`/`Spark.css` and `BracketMark`/`SparkGlyph`/`Wordmark` in `components.tsx`). Four `SparkSize`s: `inline` (14px, wordmark), `tray` (28px), `app` (96px, About/BootSplash), `hero` (200px, SignIn) — framed reticle only renders at `app`/`hero`. Five `SparkState`s: `idle`, `blink` (dim-pulse 1.2s, "thinking"), `paused` (42% opacity), `mcp` (green badge, pop-in animation), `error` (red badge, static).
- **Images**: none — no raster image assets are referenced anywhere in `src/renderer` (the avatar `<img>` in `Settings/Account.tsx` renders a remote/data-URL `auth.avatarUrl` when present, not a bundled asset; installed-connector icons may load as `data:image/*` URIs at runtime — also not bundled files).
- **QR codes**: generated at runtime via the `qrcode` npm package (`LiveStreamView`, dynamic `import('qrcode')`), not a bundled image.
- **Reference mockups** (not code, but load-bearing for pixel fidelity): `docs/screens/*.html` — ~25 static pages (`sources-list.html`, `sources-list-onboarding.html`, `source-detail.html`, `source-detail-folders.html`, `signin.html`, `logs.html`, `add-source.html`, `mcp-hub.html`, `mcp-hub-active.html`, `mcp-connect-{claude-code,claude-desktop,custom,local,vscode}.html`, `settings-{account,storage,advanced,about,connectors}.html`, `tray.html`, plus a handful of `web-*.html` pages for a marketing/web variant) built against their own `docs/screens/tokens.css`/`components.css`/`shared.css`/`icons.js` — effectively a hand-authored HTML/CSS spec of every screen's exact layout, predating (and kept in sync with) the React implementation.
