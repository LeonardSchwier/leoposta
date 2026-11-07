# Leoforma Design System — Leoposta Restyle Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement task-by-task.

**Goal:** Re-skin leoposta on the leoforma design system (Nordic palette, Inter font, ds-* classes), wire the four-palette/mode switch, and ship a clean build.

**Architecture:** Replace hand-rolled CSS tokens with leoforma's token+component styles. Keep Tailwind only for Preflight (element reset). Keep all Svelte event/state logic untouched.

**Tech Stack:** Svelte 5, TypeScript, Vite 7, Tailwind 4 (Preflight only), @leonardschwier/leoforma@v0.1.1

**Spec:** `docs/superpowers/specs/2026-11-07-leoforma-design-system-design.md`

## Global Constraints
- No hard-coded hex or rgba() in `src/**/*.svelte` after restyle (except documented exceptions).
- All interactive controls use ARIA state attributes (not local state classes) for visual state.
- `--ds-font-sans` override to Inter in the leoposta-specific block.
- Nordic palette is the default; Folio is the secondary option.
- `npm test` (16 tests) + `npm run build` must pass after each task.

## Review Focus
1. **Focus ring visibility** — `--ds-color-focus` contrast on Nordic light (dark text on light bg) and dark modes.
2. **Tab / Segmented active state** — `aria-selected` / `aria-checked` must be set on the active item in every cell; a missing attribute means the active tab is invisible to CSS.
3. **Dialog focus trap** — `ds-dialog` assumes the caller manages focus; leoposta's existing `onclick={e => e.stopPropagation()}` pattern must stay.
4. **Inline `--color-*` variable references** in Svelte `style="…"` attributes (Compose chips, Calendar dots) must be rewritten to `--ds-*`.
5. **Spinner accessibility** — `ds-spinner` has no `role`; the caller must supply `role="status" aria-label="…"`.

---

### Task 1: Install leoforma + rewrite `src/app.css`

**Files:**
- Modify: `src/app.css` (full rewrite of the token blocks, keep Preflight)
- Modify: `package.json` — add `"@leonardschwier/leoforma": "0.1.1"` to `dependencies`

**Interfaces:**
- Produces: `var(--ds-color-canvas)`, `var(--ds-color-text)`, `var(--ds-color-accent)`, `var(--ds-color-ornament)`, `var(--ds-font-sans)`, `var(--ds-radius-md)`, etc. available globally after import. `ds-btn`, `ds-input`, `ds-select`, `ds-textarea`, `ds-dialog`, `ds-menu-item`, `ds-tab`, `ds-segmented-option`, `ds-spinner`, `ds-empty`, `ds-badge-*`, `ds-card` classes available.

- [ ] **Step 1: Add leoforma dependency**

Run:
```bash
npm install --save-exact github:LeonardSchwier/leoforma#v0.1.1
```
Verify: `npm ls @leonardschwier/leoforma` shows `0.1.1`.

- [ ] **Step 2: Rewrite `src/app.css`**

Replace the `:root { --font-sans; --color-*; --radius-*; --shadow-*; --transition; }` block (lines 4-30) and the `.dark { … }` block (lines 33-79) with:

```css
@import "tailwindcss";
@import "@leonardschwier/leoforma/styles.css";

/* Leoposta overrides */
:root {
  --ds-font-sans: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  --ds-font-serif: inherit;
}

body {
  background: var(--ds-color-canvas);
  color: var(--ds-color-text);
}
```

Keep the `@media (prefers-reduced-motion: reduce)` block (line 84+) unchanged.
Delete all `:root { --color-*; --radius-*; --shadow-*; }` and `.dark { … }` blocks.

- [ ] **Step 3: Verify no build errors from the import**

Run: `npm run build 2>&1 | head -30`
Expected: clean build or CSS warning (acceptable) — no errors.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src/app.css
git commit -m "feat: install leoforma tokens, rewrite app.css to ds-* tokens"
```

---

### Task 2: Re-style Sidebar.svelte + App.svelte

**Files:**
- Modify: `src/components/Sidebar.svelte`
- Modify: `src/App.svelte`

**Key mappings (Sidebar):**
| Current | New |
|---------|-----|
| `class="compose-btn"` | `class="ds-btn ds-btn-primary ds-btn-sm"` |
| `class="folder-item"` with `class:active` | `class="ds-menu-item"` with `class:active` kept for selection highlight; add `aria-current` for a11y |
| `class="settings-btn"` | `class="ds-icon-btn"` |
| `class="badge"` | `class="ds-badge ds-badge-accent"` |
| `class="section-label"` | keep local (layout-only) |
| `--color-sidebar` references in style attrs | `var(--ds-color-panel)` |

**Key mappings (App.svelte):**
| Current | New |
|---------|-----|
| `class="toast"` | `class="ds-toast ds-toast-success"` (or `ds-toast-danger` for errors; check which variant applies) |
| `class="queue-badge"` | `class="ds-badge ds-badge-warning"` |
| any `--color-*` in `style="…"` | `var(--ds-color-*)` |

- [ ] **Step 1: Update Sidebar.svelte**

Apply the mappings above. Keep all `onclick`, `class:active`, `class:expanded` logic unchanged.
In the `folder-item` buttons, add `role="menuitem"` and `aria-current={active ? 'page' : undefined}`.

- [ ] **Step 2: Update App.svelte**

Apply the mappings above. Grep for `--color-` in `style="…"` and replace with `--ds-color-`.

- [ ] **Step 3: Build check**

Run: `npm run build 2>&1 | grep -E 'error|Error' | head -5`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/Sidebar.svelte src/App.svelte
git commit -m "feat: re-style Sidebar and App with ds-* classes"
```

---

### Task 3: Re-style MessageList.svelte + MessageView.svelte

**Files:**
- Modify: `src/components/MessageList.svelte`
- Modify: `src/components/MessageView.svelte`

**Key mappings (MessageList):**
| Current | New |
|---------|-----|
| `class="search-input"` | `class="ds-input ds-input-sm"` |
| `class="action-btn"` (new message) | `class="ds-btn ds-btn-ghost ds-btn-icon"` |
| `class="spinner"` | `class="ds-spinner" role="status" aria-label="Loading"` |
| `class="empty-state"` | `class="ds-empty"` + child `.empty-icon` → `.ds-empty-icon` |
| `class="star-btn"` with `class:active` | `class="ds-icon-btn"` keep `class:starred` for gold fill; remove local active state, add `aria-pressed={message.starred}` |
| `class="msge-btn"` (reply/forward/archive) | `class="ds-btn ds-btn-ghost ds-btn-icon ds-btn-sm"` |
| `class="msg-btn danger"` | `class="ds-btn ds-btn-danger ds-btn-icon ds-btn-sm"` |
| `class="message-row"` with `class:active`/`class:unread` | `class="ds-card"` keep local classes |

**Key mappings (MessageView):**
| Current | New |
|---------|-----|
| `class="back-btn"` | `class="ds-icon-btn"` |
| `class="action-btn"` (reply/fwd/archive) | `class="ds-btn ds-btn-ghost ds-btn-sm"` |
| `class="action-btn danger"` | `class="ds-btn ds-btn-danger ds-btn-sm"` |
| `class="att-download"` icon span | keep local, style with `color: var(--ds-color-accent)` |

- [ ] **Step 1: Update MessageList.svelte**

Apply mappings. The star button: `:class` active → `aria-pressed` binding.

- [ ] **Step 2: Update MessageView.svelte**

Apply mappings. PGP banner (`.pgp-banner-*`) is a custom component — keep local classes, just change `--color-*` variable references to `--ds-color-*`.

- [ ] **Step 3: Build check + commit**

```bash
npm run build 2>&1 | grep -E 'error|Error' | head -5
git add src/components/MessageList.svelte src/components/MessageView.svelte
git commit -m "feat: re-style MessageList and MessageView with ds-* classes"
```

---

### Task 4: Re-style Compose.svelte + CommandPalette.svelte + ContextMenu.svelte

**Files:**
- Modify: `src/components/Compose.svelte`
- Modify: `src/components/CommandPalette.svelte`
- Modify: `src/components/ContextMenu.svelte`

**Key mappings (Compose):**
| Current | New |
|---------|-----|
| `class="compose-window"` | keep local (layout) + add `ds-dialog` background |
| `class="close-btn"` | `class="ds-icon-btn"` |
| `class="btn-primary"` | `class="ds-btn ds-btn-primary"` |
| `class="btn-secondary"` | `class="ds-btn ds-btn-secondary"` |
| `class="icon-btn"` (attach/schedule) | `class="ds-icon-btn"` |
| `class="text-btn"` (cc/bcc toggle) | `class="ds-btn ds-btn-ghost ds-btn-sm"` |
| `class="schedule-badge"` | `class="ds-badge ds-badge-warning"` |
| `class="subject-input"` if present | `class="ds-input"` |
| `class="compose-editor"` body | keep local; `font-family: var(--ds-font-sans)` |
| chip `✕` buttons | `class="ds-icon-btn ds-btn-sm"` |
| any `style="…--color-…"` inline | `style="…--ds-color-…"` |

**Key mappings (CommandPalette):**
| Current | New |
|---------|-----|
| `class="palette"` (the box) | `class="ds-dialog"` on wrapper; inner box keeps local `.palette` classes |
| `class="palette-input"` | `class="ds-input"` |
| `class="palette-item"` | `class="ds-menu-item"` |
| `class="palette-empty"` | `class="ds-empty"` |

**Key mappings (ContextMenu):**
| Current | New |
|---------|-----|
| `class="context-menu"` (container) | `class="ds-menu"` if it exists in leoforma, else keep local |
| `class="context-menu-item"` | `class="ds-menu-item"` |
| `class="context-menu-divider"` | keep local |

- [ ] **Step 1: Update Compose.svelte**

Apply all mappings. Recipient chip layout is custom — keep `.chip` classes and just update `--color-*` to `--ds-color-*` in any `style` attributes.

- [ ] **Step 2: Update CommandPalette.svelte**

Apply mappings.

- [ ] **Step 3: Update ContextMenu.svelte**

Apply mappings.

- [ ] **Step 4: Build check + commit**

```bash
npm run build 2>&1 | grep -E 'error|Error' | head -5
git add src/components/Compose.svelte src/components/CommandPalette.svelte src/components/ContextMenu.svelte
git commit -m "feat: re-style Compose, CommandPalette, ContextMenu with ds-* classes"
```

---

### Task 5: Re-style Settings.svelte + Contacts.svelte + Calendar.svelte

**Files:**
- Modify: `src/components/Settings.svelte`
- Modify: `src/components/Contacts.svelte`
- Modify: `src/components/Calendar.svelte`

**Key mappings (Settings):**
| Current | New |
|---------|-----|
| `class="settings-modal"` | keep local (layout) |
| `class="close-btn"` | `class="ds-icon-btn"` |
| `class="error-banner"` | `class="ds-toast ds-toast-danger"` (inline block) |
| `class="form-group"` inputs | wrap: `<label class="ds-input-label">…<input class="ds-input">…</label>` or keep form-group and update inner inputs |
| all `<input>` not already mapped | `class="ds-input"` |
| all `<textarea>` | `class="ds-textarea"` |
| all `<select>` | `class="ds-select"` |
| `class="btn-primary"` | `class="ds-btn ds-btn-primary"` |
| `class="btn-secondary"` | `class="ds-btn ds-btn-secondary"` |
| `class="btn-danger"` | `class="ds-btn ds-btn-danger"` |
| `class="pgp-err"` span | `class="ds-badge ds-badge-danger"` or `style="color:var(--ds-color-danger)"` |
| `class="pgp-ok"` span | `style="color: var(--ds-color-success)"` |
| checkbox `.form-group.checkbox input` | `class="ds-checkbox-input"` |
| switch/toggle (if any) | `class="ds-switch-input"` |
| NEW: palette + mode controls | `class="ds-segmented"` with `role="radiogroup"`; each option `class="ds-segmented-option" role="radio" aria-checked={selected}` |

**Key mappings (Contacts):**
| Current | New |
|---------|-----|
| `class="add-c"` | `class="ds-btn ds-btn-primary ds-btn-sm"` |
| `class="c-item"` with `class:active` | `class="ds-menu-item"` + `aria-current` |
| `class="search"` (contacts search) | `class="ds-input"` |
| `class="del"` (delete contact) | `class="ds-btn ds-btn-danger ds-btn-icon ds-btn-sm"` |
| `class="modal"` (contact editor) | `class="ds-dialog"` on wrapper |
| `class="actions"` buttons | appropriate `ds-btn ds-btn-*` |

**Key mappings (Calendar):**
| Current | New |
|---------|-----|
| `class="add-evt"` | `class="ds-btn ds-btn-primary ds-btn-sm"` |
| `class="cal-item"` with `class:active` | `class="ds-menu-item"` + `aria-current` |
| `class="chip"` (event chips) | keep local; update `style="background:…"` to use `var(--ds-color-accent-soft)` or palette-specific variable |
| `class="import-btn"` labels | `class="ds-btn ds-btn-secondary"` |
| `class="modal"` (event editor) | `class="ds-dialog"` on wrapper |
| inline `style="background:{cal.color}"` | keep (dynamic per-calendar color, not a token); no change needed |

- [ ] **Step 1: Update Settings.svelte**

Apply mappings. Add the new appearance section at the top of the form (above account fields):

```svelte
<div class="form-section">
  <h3 class="section-title">Appearance</h3>
  <div class="form-row">
    <div class="form-group">
      <label class="ds-input-label">Palette</label>
      <div class="ds-segmented" role="radiogroup" aria-label="Theme palette">
        <button class="ds-segmented-option" role="radio"
          aria-checked={palette === 'nordic'}
          onclick={() => setPalette('nordic')}>Nordic</button>
        <button class="ds-segmented-option" role="radio"
          aria-checked={palette === 'folio'}
          onclick={() => setPalette('folio')}>Folio</button>
      </div>
    </div>
    <div class="form-group">
      <label class="ds-input-label">Mode</label>
      <div class="ds-segmented" role="radiogroup" aria-label="Color mode">
        <button class="ds-segmented-option" role="radio"
          aria-checked={theme === 'light'}
          onclick={() => setThemeMode('light')}>Light</button>
        <button class="ds-segmented-option" role="radio"
          aria-checked={theme === 'dark'}
          onclick={() => setThemeMode('dark')}>Dark</button>
      </div>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Update Contacts.svelte**

Apply all mappings.

- [ ] **Step 3: Update Calendar.svelte**

Apply mappings. The dynamic per-calendar `style="background:{cal.color}"` stays as-is (user-set colors, not tokens).

- [ ] **Step 4: Build check + commit**

```bash
npm run build 2>&1 | grep -E 'error|Error' | head -5
git add src/components/Settings.svelte src/components/Contacts.svelte src/components/Calendar.svelte
git commit -m "feat: re-style Settings, Contacts, Calendar; add palette/mode controls"
```

---

### Task 6: Wire theme persistence with `src/lib/theme.ts`

**Files:**
- Create: `src/lib/theme.ts`
- Modify: `src/App.svelte` — call `applyStoredTheme()` on mount, add `data-palette` + `data-theme` to `<html>`
- Modify: `src/components/Settings.svelte` — replace the static palette/mode segment with the reactive version using `useTheme()` store

**Interfaces:**
- Produces: `applyStoredTheme(): void` — reads localStorage, sets `<html>` attrs, no return.
- Produces: `setThemeMode('light'|'dark')` — persists to localStorage, updates `<html>`.
- Produces: `setPalette('folio'|'nordic')` — persists to localStorage, updates `<html>`.
- Consumes: localStorage keys `leopostaTheme` and `leopostaPalette`.

- [ ] **Step 1: Create `src/lib/theme.ts`**

```ts
const THEME_KEY = 'leopostaTheme'
const PALETTE_KEY = 'leopostaPalette'
export type ThemeMode = 'light' | 'dark'
export type Palette = 'folio' | 'nordic'

function apply(mode?: ThemeMode, palette?: Palette) {
  const html = document.documentElement
  if (mode) {
    html.setAttribute('data-theme', mode)
    localStorage.setItem(THEME_KEY, mode)
  } else {
    html.removeAttribute('data-theme')
  }
  if (palette) {
    html.setAttribute('data-palette', palette)
    localStorage.setItem(PALETTE_KEY, palette)
  }
}

export function applyStoredTheme() {
  const theme = localStorage.getItem(THEME_KEY) as ThemeMode | null
  const palette = (localStorage.getItem(PALETTE_KEY) || 'nordic') as Palette
  apply(theme && (theme === 'light' || theme === 'dark') ? theme : undefined, palette)
}

export function setThemeMode(mode: ThemeMode) { apply(mode) }
export function setPalette(p: Palette) { apply(undefined, p) }

export function getThemeMode(): ThemeMode {
  return (localStorage.getItem(THEME_KEY) as ThemeMode) ||
    (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
}
export function getPalette(): Palette {
  return (localStorage.getItem(PALETTE_KEY) as Palette) || 'nordic'
}
```

- [ ] **Step 2: Update App.svelte**

Add to `<script>`:
```ts
import { applyStoredTheme } from './lib/theme.js'
import { onMount } from 'svelte'
onMount(() => applyStoredTheme())
```

- [ ] **Step 3: Update Settings.svelte**

Import `setThemeMode, setPalette` from `../lib/theme.js`.
Add reactive state:
```ts
import { setThemeMode, setPalette, getThemeMode, getPalette } from '../lib/theme.js'
let theme = $state(getThemeMode())
let palette = $state(getPalette())
```
Update the Segmented buttons to call `setThemeMode` and `setPalette` and also update local state.

- [ ] **Step 4: Build check + commit**

```bash
npm run build 2>&1 | grep -E 'error|Error' | head -5
npm test 2>&1 | tail -5
git add src/lib/theme.ts src/App.svelte src/components/Settings.svelte
git commit -m "feat: wire theme/palette persistence and Settings appearance controls"
```

---

### Task 7: Grep gate + final test + build + tag

**Files:** none changed — verification only.

- [ ] **Step 1: Hard-coded hex/rgba grep gate**

```bash
grep -rEn '#[0-9a-fA-F]{6}\b|rgba?\(' src/components/ src/App.svelte
```
Review each hit. Accept: dynamic per-calendar colors, inline icon fills (≤2 hits). Anything else must be fixed.

- [ ] **Step 2: Old token variable reference gate**

```bash
grep -rn 'var(--color-\|var(--radius-\|var(--shadow-\|var(--font-sans' src/
```
Expected: 0 hits (all should now be `--ds-*`).

- [ ] **Step 3: Full test suite**

```bash
npm test
```
Expected: 16/16 pass. (Tests don't assert UI, so class changes shouldn't break them.)

- [ ] **Step 4: Full build**

```bash
npm run build
```
Expected: clean build. Check `dist/` for the leoforma CSS bundle or separate file.

- [ ] **Step 5: Final commit if any fixes made**

```bash
git add -A && git diff --staged --stat
git commit -m "chore: fix remaining hard-coded values after grep gate"
```

- [ ] **Step 6: Tag v0.1.1 on leoposta**

```bash
git tag leoposta-v0.1.1
```
