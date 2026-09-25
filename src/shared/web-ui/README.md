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

Contributed pages mount in the host document, so `tokens.css` and `ui.css`
reach them. Only these are stable for extensions:

- the tokens in `tokens.css`;
- `ui-card` (+ `ui-card-hd` for its header row, with `ui-card-lbl`);
- `ui-row` (inside a `ui-rows` list);
- `ui-btn` with `is-primary`, `is-secondary`, `is-ghost`, `is-danger`, `is-sm`;
- `ui-seg` with `ui-seg-i` items and `is-on` for the active one;
- `ui-status` with `is-ok`, `is-work`, `is-err`, `is-off`, `is-rec` and a `ui-dot` child.

Every other `ui-` class is internal and may change. React primitives are not
exported to extensions yet.
