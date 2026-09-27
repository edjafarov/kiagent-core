# web-ui

Design tokens (`tokens.css`), legacy component CSS (`components.css`), the
icon sprite, and the `ui` primitives (`ui/`, styled by `ui.css`).

## Primitives

Screens import React components from `@shared/web-ui/ui` — never class
strings. Every primitive class starts with `ui-`; modifiers are `is-*`.
No legacy stylesheet styles `ui-*`. `ui.css` loads after `components.css` and
relies on its base: the `.ac` font and `border-box` sizing, and the sprite's
`.i` icon class. Floating surfaces (sheets, menus) mount inside `.ac`.

## Styling contract for extension pages

Contributed pages (an extension's `ui` screens) mount in the host document,
so `tokens.css` and `ui.css` reach them. This contract covers those pages
only — the server-rendered shells and the product's own web styles keep
their own stylesheets. Only these are stable for extensions:

<!-- stable-tokens -->
- `--text-primary`, `--text-secondary`, `--text-tertiary`
- `--bg-app`, `--bg-surface`, `--bg-elevated`, `--bg-muted`
- `--border-subtle`, `--border-strong`
- `--accent-solid`, `--accent-solid-hover`, `--accent-subtle`, `--accent-text`
- `--error-solid`, `--working-solid`, `--live-solid`
- `--radius-sm`, `--radius-md`
- `--shadow-sm`, `--shadow-md`, `--shadow-lg`
- `--font-sans`, `--font-mono`
<!-- /stable-tokens -->

<!-- stable-classes -->
- `ui-card`, with `ui-card-hd` for its header row and `ui-card-lbl` for the label
- `ui-rows` holding `ui-row` items
- `ui-btn` (the plain one is the secondary look), with `is-primary`, `is-ghost`, `is-danger`, `is-sm`; `ui-ibtn` makes it square for a glyph
- `ui-link` for a text action
- `ui-seg` with `ui-seg-i` items and `is-on` for the active one
- `ui-status` (the plain one is the off look) with `is-ok`, `is-work`, `is-err`, `is-rec` and a `ui-dot` child
<!-- /stable-classes -->

Every other token and `ui-` class is internal and may change. React
primitives are not exported to extensions yet. A test holds each name above
to a rule in `tokens.css` / `ui.css`.
