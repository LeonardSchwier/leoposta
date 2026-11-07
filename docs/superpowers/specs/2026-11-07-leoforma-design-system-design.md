# Leoposta × Leoforma — design system integration

Date: 2026-11-07
Status: approved
Approaches: A1 (CSS-first component mapping) + B1 (Vite playground in leoforma)

## Intent and why

Leoposta currently carries a hand-rolled design system:
- `src/app.css` defines a `:root` block of `--color-*` tokens (sage/greige palette, Inter) and a `.dark {…}` block.
- 10 Svelte files (App, Sidebar, MessageList, MessageView, Compose, Contacts, Calendar, CommandPalette, ContextMenu, Settings) use literal class names and a small number of Tailwind utilities (3 total utility uses across all 10 files).
- The result is a bespoke look that doesn't share design tokens, contrast-tested roles, or component behaviour with other Leo apps.

Leoforma is the Leo design system: CSS custom-property tokens generated from `src/tokens/index.ts` (contrast-tested, two themes — Folio default, Nordic — via `data-palette` + `data-theme` attributes on `<html>`), plus accessible CSS classes (`ds-btn`, `ds-input`, `ds-dialog`, `ds-menu-item`, `ds-tab`, `ds-segmented-option`, `ds-card`, `ds-toast`, `ds-tooltip`, `ds-spinner`, `ds-icon-btn`, `ds-select`, `ds-textarea`) that read only from those tokens.

Goal: leoposta looks and behaves like a Leo app (Nordic theme, per user's call), consumes leoforma's tokens and component classes, and leoforma gains a live playground so every component can be seen at any theme/variant without writing app code first.

## Goals

1. Leoposta UI is reskinned to leoforma: same component set, same behaviour, but every visual property resolves through `--ds-*` tokens and leoforma's `ds-*` classes. Default theme is **Nordic**; dark mode is a toggleable override.
2. Leoforma ships a dev-only, in-repo Vite+Preact playground at `playground/` that renders every component with all variants/states, includes a Folio/Nordic × light/dark switcher, and a token swatch grid.
3. Leoforma is tagged `v0.1.1` after the playground lands; leoposta pins to that tag.
4. Leoforma's `npm run check` (tsc, eslint, vitest, axe) still passes; leoforma publishes no new runtime code beyond the playground files (which are excluded from `dist/`).
5. Leposta's `npm test` and `npm run build` still pass after the reskin.

## Non-goals / anti-goals

- **No Preact in leoposta.** Leoposta stays Svelte 5. Only leoforma's CSS and tokens enter the bundle; no Preact components, no `@preact/signals`, no hydration.
- **No new leoforma components.** Button, IconButton, fields, Dialog, Menu, Tabs, Segmented, Spinner, Toast, Tooltip, surfaces — that's the existing set. If leoposta has a pattern with no leoforma equivalent (recipient chips, drag-drop, keyboard focus traps), we keep the hand-rolled markup, re-coloured with `--ds-*` tokens.
- **No new a11y audits on leoposta.** Leoforma already runs axe on every component; leoposta gains parity by virtue of using the classes.
- **No Tailwind removal as a deliverable.** Only removed as a side-effect of the reskin (only 3 usages in src). If a removal creates friction, keep it — the point is a coherent look, not a dependency purge.
- **No rebranding.** Logo, name, favicon, PWA manifest, Tauri shell all stay.
- **No feature work.** Signature, offline queue, calendar, contacts, command palette — behaviour unchanged.

## Constraints

- Leoforma's **Rules** section (README): "Tokens and components change here first; apps consume a tagged release. Do not fork component code into an app." The playground respects this — it's a dev-only fixture, not a new component.
- Leoforma's contrast tests are already green; new tokens added here would need to pass WCAG AA on both palettes × light/dark. We are **not** adding tokens.
- The published `dist/` must not include `playground/`. Build script (`scripts/build.mjs`) already excludes it by construction (only copies `src/` + writes to `dist/`); we'll add a guard in `package.json` `files` if needed.
- Leoforma is MIT; leoposta is MIT. No licence friction.
- Two machines, one user. No CI.

## Approach — chosen

**A1 + B1.**

- **A1 — CSS-first.** Leoposta consumes `@leonardschwier/leoforma`'s tokens and component classes. No Preact components rendered inside Svelte. Svelte's own event/state logic and the recipient-chip / focus-trap / drag-drop logic stay. Only class names, colour references, and font references change, plus the theme-switch wiring on `<html>`.
- **B1 — Vite playground in leoforma.** A small dev server, no build output, tagged alongside the library so leoposta pins to it.

Reconsidered and dropped:
- **A2 — Full Preact component swap in leoposta.** Rejected. Two frameworks in one DOM, two reactive systems, and leoposta's interactive bits (chips, focus trap, drag/drop) fight the Preact lifecycle. Only worth it if leoforma's CSS can't express a pattern — and nothing we need is like that today.
- **B2 — Storybook.** Rejected. Storybook 8 + Preact + git-tagged local package is a fiddly setup; for one app's needs the token + variant grids it adds are not worth the machinery. B1 gives 90% of the value at 10% of the weight.

## What goes where

### 1) Leoforma — the playground

Location: `playground/` inside the leoforma repo. Gitignored out of `dist/`.

Contents:
- `playground/vite.config.ts` — minimal Vite config with `@vitejs/plugin-react` (Preact mode), `root: playground`, `server.open: false`.
- `playground/index.html` — minimal shell, `<script type="module" src="/main.tsx">`.
- `playground/main.tsx` — imports `@leonardschwier/leoforma/styles.css` (which is `tokens.css + fonts.css + components.css`), sets `data-palette="nordic"` on `<html>`, renders the fixture tree.
- `playground/fixtures/ThemeSwitcher.tsx` — two `ds-segmented` controls: "Folio / Nordic" (palette) and "Light / Dark / OS" (mode). Writes `data-palette` / `data-theme` on `<html>`.
- `playground/fixtures/stories/Button.tsx` — grid: variant (primary/secondary/ghost/danger) × size (sm/md) × state (default, hover, focus-visible — force-renderable via `a11y-variant` attr or a small CSS override in the playground — disabled, loading).
- `playground/fixtures/stories/IconButton.tsx` — 4 variants, 2 sizes, disabled, loading, with accessible name variations (aria-label vs visible text).
- `playground/fixtures/stories/Fields.tsx` — `ds-input`, `ds-select`, `ds-textarea` in each state (empty, with value, with error, disabled, readonly), with and without label, with and without hint text.
- `playground/fixtures/stories/Dialog.tsx` — open/close button, focus trap demo, ESC, backdrop click.
- `playground/fixtures/stories/Menu.tsx` — basic menu, nested submenu, disabled items, roving Tab.
- `playground/fixtures/stories/Tabs.tsx`, `SegmentedControl.tsx`, `Spinner.tsx`, `Toast.tsx` (with a "show" button), `Tooltip.tsx`.
- `playground/fixtures/stories/Surfaces.tsx` — card, panel, well — to confirm raised/panel/sunken contrast.
- `playground/fixtures/Tokens.tsx` — imports `tokens.json`, renders a swatch grid: for each token name (colours, spacings, radii, font sizes, motion), a label + hex/px value + a small visual box where applicable. Two columns, one per palette × mode.
- `playground/fixtures/README.md` — how to add a story for a new component (3 bullets).

Dev script:
- `"playground": "vite playground"` (Vite handles root + config discovery; `vite playground` sets the root to `./playground` when a `vite.config.ts` is found there). Add `vite` and `@vitejs/plugin-react` (or the Preact equivalent) to devDependencies. `preact` is already a peer dep.

Guards:
- `package.json` `files` field explicitly excludes `playground` from the published artifact (if one exists). Add if not.
- `.gitignore` — no change (playground is committed, not ignored).

Verification (in leoforma):
- `npm run check` (tsc, eslint, vitest, build) — unchanged, must still pass.
- Manual: `npm run playground`, click through every fixture under all 4 theme × mode cells, confirm no contrast violations, no missing assets.
- `npm pack --dry-run` — confirm no `playground/` files in the tarball.

### 2) Leposta — the reskin

Dependency:
```
npm i --save-exact github:LeonardSchwier/leoforma#v0.1.1
```

`src/app.css` — rewrite:
- **Keep `@import "tailwindcss";`** at the top. Reason: leoposta has many
  unstyled local elements (`.action-btn`, `.msg-btn`, `.search-input`,
  `.recipient-input`, `.palette-input`, chip containers, empty states) that
  depend on Preflight's global element reset (inherit font, strip borders,
  normalize box-sizing). Removing it would ship a visual regression.
- Add `@import "@leonardschwier/leoforma/styles.css";` immediately after —
  leoforma loads tokens, fonts, and `ds-*` component styles. Because CSS
  imports declare order and `styles.css` uses the same `body { font: inherit; }`
  reset as Preflight, no rule wins by accident; the two coexist cleanly.
- **Override `--ds-font-sans` to keep Inter.** Leoforma's design face is
   Figtree+Literata+Source Code Pro. Leoposta is a mail client and its
   body text should stay neutral (Inter / system-sans). Keep Inter for body, use leoforma for
  everything else. In the leoposta-specific block:
  ```css
  :root {
    --ds-font-sans: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI",
                    Roboto, sans-serif;
    --ds-font-serif: inherit; /* body text stays sans even where leoforma
                                 would reach for a serif display face */
  }
  ```
  Rationale: the point of a shared design system is shared tokens, spacing,
  motion, colour — not forcing a different letterform into a context where
  it was never intended. We take the system, not the serif.
- Remove the old `:root { --color-*; --radius-*; --shadow-*; }` block.
- Remove the `.dark { … }` block.
- A `body { background: var(--ds-color-canvas); color: var(--ds-color-text); font-size: var(--ds-font-size-md); line-height: var(--ds-line-height-normal); }` block so the host surface matches the tokens.
- Keep the `@media (prefers-reduced-motion: reduce)` override if it's there.
- Any old `@keyframes` in `app.css` that duplicate leoforma's motion tokens — drop.

Svelte components (10 files) — class name mapping (verified against the
actual leoposta inventory and leoforma's dist/components.css):

| Current leoposta pattern           | Becomes                                                        |
|------------------------------------|----------------------------------------------------------------|
| `<button class="btn-primary">`     | `<button class="ds-btn ds-btn-primary">`                       |
| `<button class="btn-secondary">`   | `<button class="ds-btn ds-btn-secondary">`                     |
| `<button class="action-btn">`      | `<button class="ds-btn ds-btn-ghost">`                         |
| `<button class="msg-btn">`         | `<button class="ds-btn ds-btn-secondary ds-btn-sm">`           |
| `<button class="star-btn">`        | `<button class="ds-icon-btn" style="color: var(--ds-color-ornament)">` |
| `<button class="danger-btn">`      | `<button class="ds-btn ds-btn-danger">`                        |
| `<input class="search-input">`     | `<input class="ds-input ds-input-sm">`                         |
| `<input class="palette-input">`    | `<input class="ds-input">`                                     |
| `<input class="field-label">`      | remains local wrapper; inner input → `ds-input`                |
| `<input class="recipient-*">`      | remains local (chip layout); styling → `--ds-*` tokens         |
| `<textarea class="message-body">`  | `<textarea class="ds-textarea">`                               |
| `<select class="...">`             | `<select class="ds-select">`                                   |
| Modal/panel backdrop               | `ds-dialog-backdrop` + `ds-dialog` (aria-modal, aria-labelledby)|
| Menu / context menu item           | `<button class="ds-menu-item">` (+ `aria-disabled` as needed)  |
| Tab (in MessageList, App)          | `ds-tab` with `role="tab"` + **`aria-selected`** on active (no `ds-tab-active` class — state is ARIA) |
| Segmented (in Settings)            | `ds-segmented` + `ds-segmented-option` with `role="radio"` + **`aria-checked`** on active |
| Card / message row container       | `ds-card` or `ds-card-raised` (no `ds-panel` — doesn't exist)  |
| Empty state                        | `ds-empty` + `ds-empty-title` / `ds-empty-description`         |
| Status badge (schedule, unread)    | `ds-badge` / `ds-badge-accent` / `ds-badge-success` / `ds-badge-warning` / `ds-badge-danger` (real in leoforma) |
| Checkbox (Settings)                | `ds-checkbox-input` + wrapper label                            |
| Switch/toggle (Settings)           | `ds-switch-input` + wrapper label                              |
| Loading spinner                    | `<span class="ds-spinner" role="status" aria-label="Loading">` (CSS-only since no Preact) |
| Star colour (`--color-star`)       | `color: var(--ds-color-ornament);` (gold/frost ribbon)         |
| Danger text (`--color-danger`)     | `color: var(--ds-color-danger);`                                |
| Success text (`--color-success`)   | `color: var(--ds-color-success);`                               |

State model: leoforma drives interactive state via **ARIA attributes, not
state classes** (Tabs use `aria-selected`, Segmented uses
`aria-checked`, Menus use `aria-expanded`/`aria-disabled`, Switch uses
`aria-checked`). Where leoposta currently toggles a `.active` local class,
the reskin adds the corresponding ARIA attribute and drops the local state
class. The Svelte `:class` bindings become `attribute` bindings.
`<button class="ds-btn">` and its variant/size modifiers (`ds-btn-primary`,
`ds-btn-sm`, …) are the only exception — Button is styled by modifier class.

Where leoposta's own classes do something the `ds-*` set doesn't (e.g. a specific row layout, a chip pill with drag), the `*.svelte` file keeps its local class but the colour/spacing/radius all reference `--ds-*` tokens — no hard-coded hex anywhere in `src/**/*.svelte` after the reskin. Grep gate: `grep -rEn '#[0-9a-fA-F]{3,6}\b|rgba?\(' src/ --include='*.svelte'` must return only a few explicit exceptions documented in `app.css`.

Theme wiring in `src/App.svelte`:
- On `onMount`: read `localStorage.leopostaTheme` (values `"system" | "light" | "dark"`, default `"system"`); read `localStorage.leopostaPalette` (`"folio" | "nordic"`, default `"nordic"` per user's call). Apply to `<html>`: `data-theme` (omit when system), `data-palette`.
- When user toggles dark mode, write to localStorage and update `<html>`; when they pick a palette, same.
- Expose a small helper `src/lib/theme.ts` with `setTheme(mode)`, `setPalette(p)`, `applyStoredTheme()`, `subscribeTheme(fn)`.
- Settings.svelte picks up the two new controls (Segmented for palette, Segmented for mode). Replaces the current hand-rolled dark toggle.

Removals (in leoposta):
- None in package.json. Tailwind is retained for Preflight (see above).
- Hand-rolled `--color-*` / `--radius-*` / `--shadow-*` tokens in `app.css` that duplicate `--ds-*` tokens.
- Any inline `style="…--color-…"` references in `src/**/*.svelte` — grep and rewrite to `--ds-*`.

Keep in leoposta (untouched):
- PWA, Tauri, store, offline queue, signature feature.
- All Svelte state/event logic (chips, focus trap, drag-drop, keyboard nav).
- Tailwind (for Preflight only — no utility-class usages remain).

Verification (in leoposta):
- `npm test` — all 16 existing tests pass (they don't assert UI).
- `npm run build` — clean.
- Manual: `npm run dev`, walk Inbox/Compose/Settings/Contacts/Calendar under all 4 theme × mode cells, confirm every button/input/dialog/menu/row renders with leoforma styles, no flash of old palette, focus rings visible, keyboard Tab through a dialog traps correctly.
- `grep -rEn 'class="[^"]*\b(bg-|text-|border-|rounded-|px-|py-|flex|grid|gap-)' src/` returns no real Tailwind utilities (the current grep hits are local classes like `.grid`, `.text-btn`, `.context-menu` — false positives of the pattern). After the reskin, these local classes remain, so the grep result looks unchanged — that is fine.
- No hard-coded hex/rgba left in Svelte component files: `grep -rEn '#[0-9a-fA-F]{6}\b|rgba?\(' src/components/ src/App.svelte` returns at most a documented exception list.

## Order of work

1. Leoforma: scaffold `playground/`, wire up the 10 stories, ThemeSwitcher, token grid.
2. Leoforma: add `playground` to `package.json` devDeps, add `playground` script, exclude from `files`, `npm run check`, tag `v0.1.1`, push to `github/leonard/leoforma` (or wherever leoforma lives).
3. Leposta: `npm i --save-exact github:LeonardSchwier/leoforma#v0.1.1`.
4. Leposta: rewrite `src/app.css` to import leoforma + a small leoposta-specific block.
5. Leposta: rewrite the 10 Svelte components class by class; add the missing ARIA state attributes (Tabs `aria-selected`, Segmented `aria-checked`, etc.); run the hard-coded-hex grep gate.
6. Leposta: wire `src/lib/theme.ts`, update Settings.svelte with the ds-segmented palette/mode controls (using `ds-segmented` + `ds-segmented-option` with `aria-checked`), apply in App.
7. Leposta: `npm test` + `npm run build`. Walk the UI in all 4 theme × mode cells.
8. Leposta: commit on a feature branch, merge to main, push to `github/leonard/leoposta`.

Risks and mitigations
- **Preact peer dep pulled in via `styles.css` import?** No — CSS imports don't pull JS. Only `npm i` adds peer deps. Confirm with `npm ls preact` that Preact is in node_modules if and only if something else in leoposta already uses it.
- **Fonts.** We override `--ds-font-sans` to Inter in the leoposta-specific block, so only Inter is actually rendered. The Figtree + Literata + Source Code Pro woff2 files still ship in `dist/fonts/` (they're in the package, not importable individually) and will land in the PWA precache. Cost: a few hundred KB of unused woff2 in the SW cache. Mitigation: if bundle size matters, we can patch the CSS import with Vite `css` transform to strip `@font-face` rules for fonts we don't use. Decision: accept for now, revisit if the PWA size grows > 1 MB.
- **Tailwind is kept** for Preflight — see `src/app.css` rewrite section. Removing it is out of scope for this change.
- **ARIA state model.** Tabs and Segmented require the ARIA attributes to work visually. The reskin adds them; missing `aria-selected` etc. on any interactive control blocks the merge.
- **Focus rings.** `ds-*` components read `--ds-color-focus`; leoforma's contrast tests cover it against both palettes.

## Builder notes

- This is a small-to-medium change. Total code touched is ~250 lines of Svelte class renames, ~40 lines of new `src/lib/theme.ts`, ~10 lines of rewritten `app.css`, and a new `playground/` folder of ~400–600 lines of Preact fixtures.
- The `builder-check` subagent is the only gate before plan writing; the plan itself is a list of steps matching "Order of work" above, in PR-sized chunks.
