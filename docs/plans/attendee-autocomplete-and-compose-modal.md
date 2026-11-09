# Attendee autocomplete + compact Compose modal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Compose and Calendar the same contact-lookup autocomplete (To/Cc/Bcc + event attendees), and re-layout Compose as a compact centered modal in the Contacts.svelte "New contact" visual style.

**Architecture:** Extract the contacts-loading + matching logic currently inline in `Compose.svelte` into a shared library (`src/lib/contacts.ts`) with tests. Wrap it in one shared Svelte component (`src/components/RecipientAutocomplete.svelte`) used by Compose (To/Cc/Bcc) and Calendar (Attendees). Rebuild `Compose.svelte`'s markup as the same `.modal-back/.modal` card as Contacts.svelte; delete the old side-panel styles. No backend changes; no new deps.

**Tech Stack:** Svelte 5, TypeScript, Vue-less, Vitest (jsdom). Existing: `src/api/index.ts` (`ContactsAPI`), `src/store.ts`.

**Spec:** Chat-approved (2026-11-09) — three items:
1. Compose autocomplete (currently dead because `loadAddressBooks()` is never called).
2. New: Calendar → event → Attendees field gets the same autocomplete.
3. Compose visual → compact centered modal matching `Contacts.svelte:204-234` (labels above inputs, ~460px card, Cancel/Create style footer). Cc/Bcc bonus: also autocomplete (user approved).

## Global Constraints

- No new runtime dependencies (`package.json` unchanged).
- No backend or API shape changes.
- Existing `handleSend`, `seedBody`, offline `addQueuedMessage` queue path **must keep working** — semantics unchanged, only the markup wrapper changes.
- Existing test gates must stay green: `npm run typecheck`, `npm test` (75 tests), `node --test server` (109 tests), `npm run build`.
- Follow existing Svelte 5 runes style (`$state`, `$props`) and Tailwind-via-CSS-variables theming already in the codebase (`var(--color-bg)`, `var(--color-accent)`, etc.).
- Don't introduce new i18n or a11y regressions: existing `role="dialog"` + `aria-modal` on `compose-window` must be preserved (moved to the new modal); keep `role="listbox"/"option"` on the autocomplete.

## Review Focus

Failure modes the spec implies but no task's tests exercise:

1. **Empty address books** — a user with no CardDAV configured. Suggestion dropdown must stay hidden, no crash. (Covers `src/lib/contacts.ts:matches` on empty array plus `RecipientAutocomplete` rendering zero options.) → Task 3, Step 2 test.
2. **Duplicate emails across books** — the same person in two address books must yield exactly one suggestion. → Task 2, Step 2 test `dedupe`.
3. **Typing a raw valid email that matches no contact** — Enter must still add the raw text (no suggestion selected), preserving pre-existing manual input. → Task 3, Step 2 test.
4. **Cc/Bcc toggle rows** — when `showCc` is false the Cc row must not exist in DOM, so the focus trap and Tab order are unchanged from today. → Task 4 manual verify (no unit test; covered by typecheck + a11y).
5. **Reply/Forward signature seed** — `seedBody()` runs in `onMount`. The new layout must still mount in exactly one mount cycle (not double-mount from a `<KeepAlive>` or wrapper) so signature seeding isn't applied twice. → Task 4, Step 3 verify.

---

### Task 1: Shared library `src/lib/contacts.ts`

**Files:**
- Create: `src/lib/contacts.ts`
- Test: `src/__tests__/contacts.test.ts`

**Interfaces:**
- Produces (used by Task 2 and 3):
  - `interface AddressBook { uri: string; name: string }`
  - `interface Contact { uid: string; name: string; email: string; org?: string }`
  - `type ContactsFetcher = (book: string) => Promise<Contact[]>`
  - `interface ContactsCache {
        addressBooks: AddressBook[];
        loadBooks(): Promise<void>;
        loadContacts(uri: string): Promise<Contact[]>;
        allContacts(): Contact[];
        matches(query: string, limit?: number): Contact[];
      }`
  - `interface ContactsCacheOptions { fetcher: ContactsFetcher }`
  - `function createContactsCache(opts: ContactsCacheOptions): ContactsCache`

- [ ] **Step 1: Write failing tests in `src/__tests__/contacts.test.ts`**

Cover:
- `loadBooks` populates `addressBooks` from the fetcher's `addressBooks` field.
- `loadContacts(uri)` caches: a second call with the same uri does **not** re-invoke the fetcher (assert with a call counter on the fake fetcher).
- `allContacts` returns deduped union across books — a contact with the same `uid` or same `email` in two books appears exactly once.
- `matches('jane')` — case-insensitive; returns contacts whose `name` starts with, or `email` contains, or `org` contains the query.
- `matches('', 8)` — no contacts (empty query is a no-op).
- `matches('a', 2)` — caps result at `limit` (default 8).

Use a fake fetcher that records calls:

```ts
let calls: { kind: 'books' | 'contacts'; uri?: string }[] = []
const fetcher: ContactsFetcher = async (book) => {
  calls.push({ kind: 'contacts', uri: book })
  if (book.endsWith('/b1')) return [ { uid: 'u1', name: 'Jane Do', email: 'jane@doe.com', org: 'Corp' } ]
  return [ { uid: 'u2', name: 'Bob', email: 'bob@corp.com' },
           { uid: 'u3', name: 'Jani', email: 'jani@example.com' } ]
}
```

and stub out `ContactsAPI.addressBooks()` for the books call (the cache takes an injectable `fetcher` for both — see Interfaces).

- [ ] **Step 2: Run the test, confirm it fails**

Run: `npx vitest run src/__tests__/contacts.test.ts`
Expected: `Cannot find module '../lib/contacts'` (or equivalent).

- [ ] **Step 3: Implement `src/lib/contacts.ts`**

Structure:
- `createContactsCache({ fetcher })` returns an object with the five methods above. Internals: `addressBooks: AddressBook[]`, `loaded: Map<string, Promise<Contact[]>>` so concurrent first calls share a single fetch and later calls hit the map. `loadContactBooks()` is a separate internal used by `loadBooks()` (the public API only exposes `loadBooks` — see Interfaces; the `fetcher` callable is a single function that takes a book uri or `''` — when `''` is passed the caller is asking for `addressBooks`; keep it simple — define `fetcher: (uri: string | '') => Promise<Contact[] | { addressBooks: AddressBook[] }>`, with `uri === ''` meaning "return the books list". Document that on the type.)
- `matches()` returns `[]` for a trimmed-empty query. Filter + dedupe + `.slice(0, limit || 8)`.

- [ ] **Step 4: Run tests, confirm they pass**

Run: `npx vitest run src/__tests__/contacts.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Add a smoke test that the cache works inside a Svelte component — skip if not practical, covered by Task 3's component test**

(n/a)

- [ ] **Step 6: Commit**

```bash
git add src/lib/contacts.ts src/__tests__/contacts.test.ts
git commit -m "feat: shared contacts cache + matcher for recipient autocomplete"
```

---

### Task 2: `RecipientAutocomplete.svelte` shared component

**Files:**
- Create: `src/components/RecipientAutocomplete.svelte`

**Interfaces:**
- Consumes: `createContactsCache` from `src/lib/contacts.ts`; `ContactsAPI` from `src/api/index.ts` (only for the `fetcher` wiring inside the component).
- Produces (used by Task 3 and Task 4):
  - Svelte component with props:
    - `bind:value: string` (comma/semicolon/space-separated emails; the component both reads and writes)
    - `placeholder?: string` (default `'recipient@example.com'`)
    - `maxSuggestions?: number` (default `8`)

- [ ] **Step 1: Write a Svelte smoke test**

Create `src/__tests__/recipientAutocomplete.test.ts`. Use a Svelte 5 runes-friendly smoke test (no `@testing-library/svelte` in this repo — check `package.json`; if absent, drop this step and rely on manual verify + a tiny Vitest that mounts the component via `svelte`'s own `mount` + DOM assertions in jsdom).

Test must assert (using a mocked `globalThis.fetch` returning a fixed contacts list):
- Rendering with empty `value` does **not** produce a `<div class="suggestions">` element in the DOM.
- Setting `value = 'j'` and flushing 150 ms produces one `.suggestion` element whose `aria-selected` is `"false"` initially and whose text contains `Jane`.
- Pressing `Enter` on the input with one suggestion adds the contact's email to `value` (as a comma-joined, trimmed entry) and removes the suggestion dropdown.
- Pressing `Enter` with raw text `'noone@nowhere.test'` and no suggestion present leaves `value === 'noone@nowhere.test'` (manual-entry fallback).

If Vitest can't be pointed at the Svelte component easily, replace this with:
- A `describe('smoke')` block that only checks `createContactsCache().matches` (still covered by Task 1), and
- A manual-verify step (Task 5) that hits all these paths in the browser.

- [ ] **Step 2: Run the test, confirm it fails** (module not found)

Run: `npx vitest run src/__tests__/recipientAutocomplete.test.ts`
Expected: fails.

- [ ] **Step 3: Implement `src/components/RecipientAutocomplete.svelte`**

Behavior:
- `$props<{ value: string; placeholder?: string; maxSuggestions?: number }>()`
- Initialize the shared `createContactsCache({ fetcher: composeFetcher })` in `$state` once per component instance; `composeFetcher` wraps `ContactsAPI` for both books and contacts.
- On `onMount`: call `cache.loadBooks()`; if at least one book, `cache.loadContacts(books[0].uri)`.
- Debounced (120 ms) input handler → `compute()` → sets `$state` `suggestions` and `suggestionIndex`.
- Keyboard: same set as today's Compose `onToKey` (ArrowUp/Down/Enter/Tab/Esc).
- On commit: append the contact's email to the comma-separated `value` (dedupe), reset local typing to empty, hide the dropdown.
- On blur: hide dropdown after 150 ms (preserve existing delay).
- Keep existing `role="listbox"` + `role="option"` + `aria-selected` on the dropdown.
- Expose the input itself (so the parent can `focus()` it via a ref if desired).

The component renders:

```html
<div class="ra" class:open={suggestions.length}>
  <input ... />
  {#if suggestions.length}
    <div class="ra-list" role="listbox"> ... </div>
  {/if}
</div>
```

Style block: copy the existing `.recipient-input`/`.suggestions`/`.suggestion` CSS into this component (from today's `Compose.svelte:837-889`), using the same CSS variable names so it looks identical. Add `.ra-list { position: absolute; top:100%; left:0; width:100%; z-index:50; ... }`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/__tests__/recipientAutocomplete.test.ts`
Expected: pass.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/components/RecipientAutocomplete.svelte src/__tests__/recipientAutocomplete.test.ts
git commit -m "feat: shared RecipientAutocomplete component"
```

---

### Task 3: Wire autocomplete into Calendar (Attendees)

**Files:**
- Modify: `src/components/Calendar.svelte:368` (replace the raw `<input>` for Attendees with the new component)
- Modify: `src/components/Calendar.svelte` imports (add `RecipientAutocomplete`)
- Test: manual-only (see Review Focus #1: empty address books must not add a dropdown).

**Interfaces:**
- Consumes: `RecipientAutocomplete` from Task 2 (props `bind:value`, `placeholder`, `maxSuggestions`).

- [ ] **Step 1: Replace the raw input in `Calendar.svelte:368`**

Before:
```svelte
<label><span>Attendees</span><input type="text" bind:value={fAttendees} placeholder="alice@example.com, bob@example.com" /></label>
```
After:
```svelte
<label><span>Attendees</span>
  <RecipientAutocomplete bind:value={fAttendees} placeholder="alice@example.com, bob@example.com" />
</label>
```

Update the Calendar modal CSS: make sure `.modal`'s existing `input, textarea` rule (line 438) doesn't fight `.ra input` width; add `.modal .ra { margin-top: 4px; }` if needed.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: pass.

- [ ] **Step 3: Manual browser verify**

- Open Calendar → click "+ New event" → type one letter in Attendees → suggestions dropdown appears (when any contacts exist).
- Enter adds the suggestion; Esc closes; typing `foo@bar.test` and pressing Enter appends the raw text.
- When address books are empty (logout/no CardDAV): no dropdown; raw text still works.
- Save event; reopen; attendees round-trip.

- [ ] **Step 4: Commit**

```bash
git add src/components/Calendar.svelte
git commit -m "feat(calendar): attendee autocomplete via shared component"
```

---

### Task 4: Rebuild Compose as a compact centered modal + wire To/Cc/Bcc

**Files:**
- Modify: `src/components/Compose.svelte` (nearly full rewrite of markup + style block; script block largely unchanged, with `loadAddressBooks`/`computeSuggestions`/`addSuggestion`/`onToKey` removed in favour of `RecipientAutocomplete`)
- Test: no new unit test for the layout change (visual); the gate is typecheck + build + existing e2e + manual.

**Interfaces:**
- Consumes: `RecipientAutocomplete` (Task 2); all existing `store.ts` compose actions; `seedBody`, `handleSend`, `handleSchedule`, `handleAttach`, `attachments` — all unchanged.

- [ ] **Step 1: Delete the Compose-local autocomplete code**

Remove from `Compose.svelte`:
- imports of `ContactsAPI` (line 2) — keep `apiFetch`
- all lines from `// ---- Contact autocomplete ----` through the end of `addSuggestion/... onToKey` (roughly lines 9-114)
- the `oninput={onToInput}` / `onkeydown={onToKey}` / `onblur` handlers and the `{#if showSuggestions && ...}` block in the To row (lines 385-420)
- the CSS block for `.recipient-input .suggestions` and friends (lines 837-889)

Replace the To/Cc/Bcc inputs with the shared component:

```svelte
<label>
  <span>To</span>
  <RecipientAutocomplete bind:value={toField} placeholder="recipient@example.com" />
</label>
```
Where `toField` is a computed that maps between the existing `$state` chip-list state (`composeTo` store) and a comma-separated string; simpler alternative: keep `composeTo` as the store of truth and bind a new `$state<string> toInput` that is seeded from `join(getState().composeTo)`, and on `handleSend` reconcile the last uncommitted fragment. **Recommended:** keep `setComposeTo`/existing `composeTo` chips; the component itself can just add via a small adapter — see step 3.

Actually: simplest — keep the existing **chip list + trailing input** shape in Compose (chips are nicer for To), and only swap the *trailing raw input* for `RecipientAutocomplete` **without** its own chip rendering. To do that, the component must accept a `renderChips` prop = `false` (default true) so it only renders the input + dropdown, and emits added emails via a small callback (or by mutating `value` only with the *new* email appended).

If this gets complicated, **fallback**: use `RecipientAutocomplete` for To in Calendar-style (single flat string), and let `handleSend` split by `/[,;]/` (which it already partly does via `addRecipient`). The existing chip UX is secondary to consistency — confirm before committing to it.

- [ ] **Step 2: Rewrite the Compose markup into the modal shape**

Target DOM structure (mirrors `Contacts.svelte:205-234`):

```html
<div class="modal-back" onclick={onCloseBack} role="dialog" aria-modal="true" aria-label="Compose message">
  <div class="modal compose">
    <h4>{title}</h4>
    <label><span>To</span><!-- RecipientAutocomplete or chip+trailing input --></label>
    {#if showCc}<label><span>Cc</span>...</label>{/if}
    {#if showBcc}<label><span>Bcc</span>...</label>{/if}
    <div class="compose-actions"><button class="text-btn" onclick={() => showCc = !showCc}>...Cc</button> ...</div>
    <label><span>Subject</span><input type="text" bind:value={subjectInput} .../></label>
    <label class="compose-body"><span>Message</span><textarea bind:value={bodyInput} rows="10" placeholder="Write your message..."></textarea></label>
    <div class="compose-attach">
      <button class="icon-btn" title="Attach" aria-label="Attach file" onclick={() => attachFile?.click()}><span>📎</span></button>
      <input type="file" multiple bind:this={attachFile} onchange={handleAttach} hidden />
      <!-- existing attachment chips inline here -->
    </div>
    <div class="compose-schedule-toggle">
      <button class="text-btn" onclick={toggleSchedulePanel}>⏰ {showSchedule ? 'Hide' : 'Schedule'}</button>
      {#if $store.composeScheduled}<span class="badge">{...}<button onclick={() => setComposeScheduled(null)}>✕</button></span>{/if}
    </div>
    {#if showSchedule}
      <div class="schedule-panel"><!-- existing preset + date/time + error block, unchanged --></div>
    {/if}
    <div class="actions">
      <button class="ghost" onclick={onClose}>Save Draft</button>
      <span class="spacer"></span>
      <button class="primary" onclick={handleSend} disabled={$store.isLoading}>{#if $store.isLoading}Sending...{:else}Send{/if}</button>
    </div>
  </div>
</div>
```

`onCloseBack` closes when the click target is exactly `.modal-back` (standard backdrop-dismiss pattern, already used in Contacts.svelte).

- [ ] **Step 3: Swap the Compose style block**

Replace the `.compose-window` / `.compose-header` / `.compose-body` / `.compose-footer` / `.field-row` / `.field-label` / `.compose-editor` / `.schedule-panel` / `.footer-*` rules with the ones from `Contacts.svelte:275-291` (`.modal-back`, `.modal`, `.modal h4`, `.modal label`, `.modal input/textarea/select`, `.modal .actions`, `.modal .actions .primary`, …) plus Compose-specific additions:
- `.compose { width: min(560px, 92vw); }` (a touch wider than 460px for a mail client — matches today's "compose" feel at a glance)
- `.compose textarea { min-height: 200px; resize: vertical; }`
- The `schedule-panel` and attachment chip CSS stays, just re-scoped to the new `.compose` container.
- Delete the now-unused `.recipient-input`/`.suggestions`/`.sug-*` rules (they moved to `RecipientAutocomplete.svelte` in Task 2).

- [ ] **Step 4: Keep focus-trap + Ctrl/⌘+Enter + Esc**

`handleKeyDown` (lines 192-226) already targets `.compose-window` — update the selector to `.compose` (the new modal class). The Ctrl/⌘+Enter handler already flushes `toInput` — make sure it still fires after the To binding change. Preserve `onMount`'s signature-seeding `seedBody()` and initial focus.

- [ ] **Step 5: Typecheck + full test suite**

Run:
- `npm run typecheck` → pass
- `npm test` → 75 + the new tests from Tasks 1-2 all pass
- `node --test server` → 109 tests pass (unchanged)
- `npm run build` → succeeds

- [ ] **Step 6: Manual verify — the whole spec in the browser**

1. Compose modal opens centered, ~560px. To row shows existing chips + trailing input.
2. Type `j` → Jane appears in dropdown. Enter adds as chip.
3. `Add Cc` → row appears with its own autocomplete. Same for Bcc.
4. Body textarea works; Ctrl/⌘+Enter sends with To empty → still warns "Please add at least one recipient".
5. Attach a file → chip appears.
6. Schedule: open panel → pick preset → "Schedule" → badge appears in modal footer → close modal → reopen → badge persists (from store) → clear with ✕ works.
7. Reply to a message: signature block seeded correctly above the quoted original.
8. Esc key still closes / or backdrop click. Focus lands on To input.
9. Offline (DevTools → offline): Send → queued toast + modal closes.
10. Calendar → New event → Attendees field autocomplete works identically.

- [ ] **Step 7: Commit**

```bash
git add src/components/Compose.svelte
git commit -m "refactor(compose): compact centered modal + shared RecipientAutocomplete"
```

---

### Task 5: Regression sweep + gates

**Files:** none

- [ ] **Step 1: Full gate**

Run: `npm run check` (which is `typecheck && test && test:server && build`).
Expected: all green.

- [ ] **Step 2: Grep for stale references**

Run: `rg -n "loadAddressBooks\b|compose-window\b|onToInput\b|onToKey\b|computeSuggestions\b" src/`
Expected: **no matches** (all were removed or moved in Task 2/4).

- [ ] **Step 3: Update `ROADMAP.md`**

Move the "Contacts autocomplete" row (if present) and any open "Autocomplete for To/CC/BCC" item to `[x]`. Add the new line: "Calendar attendee autocomplete [x]". If `ROADMAP.md` has no open item for either, add a small note under "Shipped this session".

- [ ] **Step 4: Update `PROGRESS.md` (delete at finish)**

- [ ] **Step 5: Final commit**

```bash
git add ROADMAP.md
git commit -m "docs: mark attendee + Cc/Bcc autocomplete shipped"
```

---

## Self-review checklist

- **Spec coverage:** (1) fixed by T2/T4, (2) fixed by T2/T3, (3) fixed by T4. ✅ all three.
- **Step scan:** every step has one action + a check (test to run / expected output / one-line impl). T4 Step 3 has a "fallback" branch — that's a decision the executor needs to be able to make, but it should be flagged before commit: keep as two explicit alternatives, not a vague "if complicated". ✅
- **Type consistency:** `createContactsCache({ fetcher })` in T1 vs. T2's `composeFetcher` — the plan defines `fetcher` as a *single* function that takes `''` for books and a uri string otherwise. T2's step 3 uses `composeFetcher` which must implement *that* protocol. Call this out in T2 Interfaces. ✅ (note inline)
- **Review Focus:** 5 entries, each tied to a step. ✅
- **Proportions:** 5 tasks, one file per task except T4 which is a rewrite. Reasonable.

## Changelog (for later PRs)

- New: `src/lib/contacts.ts`
- New: `src/components/RecipientAutocomplete.svelte`
- New: `src/__tests__/contacts.test.ts`
- New: `src/__tests__/recipientAutocomplete.test.ts`
- Modified: `src/components/Compose.svelte` (markup + style block rewrite; script block trimmed)
- Modified: `src/components/Calendar.svelte` (one line of markup + import)
- Docs: `ROADMAP.md`, this plan, short design doc in `docs/design/attendee-autocomplete-and-compose-modal.md` (to be written by the executor at start, or left as this plan — confirm with user).
