# Inbox auto-refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-refresh the open folder's message list + unread badge — instantly via the existing IMAP IDLE/SSE stream (default) or on a 5/15/60 min timer — without touching UI while the user is typing, controlled from Settings.

**Architecture:** A new `src/refresh.ts` owns one `EventSource` (instant) or one `setInterval` (timer), started/stopped by a single `$effect` in `App.svelte`. A pure focus-guard function is exported so the refresh loop can skip ticks while any input has focus. Settings persists the choice in localStorage and the store.

**Tech Stack:** Svelte 5, TypeScript, vitest (jsdom), existing `EventSource`; no new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-09-inbox-auto-refresh-design.md`

## Global Constraints

- Modes: `'instant' | '5m' | '15m' | '60m' | 'off'`; default `'instant'`; persisted key `leoposta:refreshInterval`.
- Interval values in ms: 5m = `300000`, 15m = `900000`, 60m = `3600000`.
- SSE source: `MailAPI.idle()` (`src/api/index.ts:73`) — the already-tokenized `GET /api/idle` URL.
- SSE event to react to: `mailbox-update` (server `server/routes/idle.js:37-43`).
- Focus guard truth value: refresh must be **skipped** (not queued) when the active element is an input.
- No server changes. `GET /api/idle` and `GET /api/messages` already exist.
- Existing tests must stay green: `npx vitest run` → ≥ 96 pass; `npm run typecheck` clean.
- Svelte 5 runes-only (`$state`/`$effect`/`$derived`), no classic `onMount` for the reactive start/stop below.

## Review Focus

1. **Timer fires while typing in compose** — user explicitly requires no refresh while any input/textarea/select/contenteditable has focus → Task 1 tests the guard; Task 3 wires it before every tick.
2. **Mode switch must not leak the old stream/timer** — two live `EventSource`s or two intervals is a real bug (double fetches, stale IMAP session) → Task 3 teardown tested via start/stop shape.
3. **`idle-end`/SSE close is expected (server caps IDLE at 29 min, `server/routes/idle.js:47`)** — `EventSource` auto-reconnects and re-runs `loadMessages`; must not crash or spin a re-fetch storm → Task 3: reconnect handled by EventSource; guard re-applies.
4. **Active folder changes while refresh is armed** — a tick must refresh `getState().activeFolder` (the current one), not a stale captured name → Task 3 resolves the folder at tick time.
5. **`off` mode leaves no timer/stream running** → Task 3 teardown path + Task 1 guard coverage.

---

### Task 1: Focus guard

**Files:**
- Create: `src/refresh.ts`
- Test: `src/__tests__/refreshGuard.test.ts`

**Interfaces:**
- Produces: `isTypingFocused(): boolean` (document-driven; returns `true` when the active element is an input, textarea, select, or `[contenteditable]`).

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment jsdom
// src/__tests__/refreshGuard.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { isTypingFocused } from '../refresh'

function focus(tag: string, attrs: Record<string, string> = {}) {
  const el = document.createElement(tag) as HTMLElement
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v)
  document.body.appendChild(el)
  el.focus()
}

describe('isTypingFocused', () => {
  beforeEach(() => {
    document.getElementsByTagName('*').forEach(el => el.blur())
  })
  it('returns false when body has focus', () => {
    document.body.focus()
    expect(isTypingFocused()).toBe(false)
  })
  it('returns true for a text input', () => {
    focus('input', { type: 'text' })
    expect(isTypingFocused()).toBe(true)
  })
  it('returns true for a textarea', () => {
    focus('textarea')
    expect(isTypingFocused()).toBe(true)
  })
  it('returns true for a select', () => {
    focus('select')
    expect(isTypingFocused()).toBe(true)
  })
  it('returns true for a contenteditable', () => {
    focus('div', { contenteditable: 'true' })
    expect(isTypingFocused()).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/refreshGuard.test.ts`
Expected: FAIL — `Cannot find module '../refresh'` / `isTypingFocused is not a function`

- [ ] **Step 3: Implement `isTypingFocused` in `src/refresh.ts`**

```ts
const FOCUSABLE = 'input,textarea,select,[contenteditable]']
```

Approach: check `document.activeElement` against a CSS selector list covering input, textarea, select, and `[contenteditable]`; return false when the active element is `body`/`null`. Keep the file a plain module (no imports) so vitest can load it under jsdom.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/refreshGuard.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/refresh.ts src/__tests__/refreshGuard.test.ts
git commit -m "feat(refresh): add typing-focus guard"
```

---

### Task 2: Refresh controller (start/stop)

**Files:**
- Modify: `src/refresh.ts:1-40` (extend the module from Task 1)
- Test: `src/__tests__/refreshController.test.ts`

**Interfaces:**
- Consumes: `isTypingFocused()` from Task 1; `MailAPI.idle()` URL helper (`src/api/index.ts:73`).
- Produces:
  - `type RefreshMode = 'instant' | '5m' | '15m' | '60m' | 'off'`
  - `startRefresh(mode: RefreshMode, onTick: () => void): void`
  - `stopRefresh(): void`
  - `getRefreshMode(): RefreshMode` (last mode set; `'off'` before first start)
  - `loadPersistedRefreshMode(storage?: Storage): RefreshMode` (default `'instant'`)
  - `saveRefreshMode(mode: RefreshMode, storage?: Storage): void`
  - localStorage key: `'leoposta:refreshInterval'`

Rules (implementer must honor): the guard check happens **inside** `startRefresh` before every `onTick` call — for the timer (on each tick) and for 'instant' (on each SSE `mailbox-update`). `stopRefresh()` calls `EventSource.close()` and `clearInterval()`. Calling `startRefresh` twice without `stopRefresh` between replaces the running one.

- [ ] **Step 1: Write the failing test (start/stop/replace semantics)**

```ts
// @vitest-environment jsdom
// src/__tests__/refreshController.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { startRefresh, stopRefresh, getRefreshMode } from '../refresh'

class FakeEs {
  static instances: FakeEs[] = []
  close = vi.fn()
  addEventListener = vi.fn()
  constructor(public url: string) { FakeEs.instances.push(this) }
}

beforeEach(() => {
  FakeEs.instances = []
  vi.stubGlobal('EventSource', FakeEs)
})
afterEach(() => { stopRefresh(); vi.unstubAllGlobals() })

describe('startRefresh', () => {
  it('opens one EventSource for instant mode', () => {
    startRefresh('instant', () => {})
    expect(FakeEs.instances).toHaveLength(1)
    expect(getRefreshMode()).toBe('instant')
  })
  it('replaces the stream when started again', () => {
    startRefresh('instant', () => {})
    const first = FakeEs.instances[0]
    startRefresh('15m', () => {})
    expect(FakeEs.instances).toHaveLength(2)
    expect(first.close).toHaveBeenCalled()
  })
  it('closes the stream on stopRefresh', () => {
    startRefresh('instant', () => {})
    const es = FakeEs.instances[0]
    stopRefresh()
    expect(es.close).toHaveBeenCalledTimes(1)
    expect(getRefreshMode()).toBe('off')
  })
  it('does not open a stream for off mode', () => {
    startRefresh('off', () => {})
    expect(FakeEs.instances).toHaveLength(0)
  })
})
```

Note: the controller imports `MailAPI.idle` from `./api` only for the EventSource URL; the stubbed `EventSource` swallows the constructor, so no network call happens.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/refreshController.test.ts`
Expected: FAIL — module `../refresh` exists (Task 1) but `startRefresh`/`stopRefresh`/`getRefreshMode` are not exported

- [ ] **Step 3: Extend `src/refresh.ts`**

- `startRefresh(mode, onTick)`: call the existing internal teardown first, then store `mode`; for `'off'` leave no handle; for `'instant'` create `new EventSource(MailAPI.idle())` and `add('mailbox-update', ...)` a listener that runs `runTick(onTick)`; for the timer modes compute ms from the mode via a small map and `setInterval(() => runTick(onTick), ms)`.
- `runTick(onTick)`: `if (!isTypingFocused()) onTick()` — the guard is the single source of truth for skipping.
- `stopRefresh()`: close the EventSource (if any), clear the interval (if any), reset mode to `'off'`.
- Implement `loadPersistedRefreshMode`/`saveRefreshMode` as plain functions over an injected `Storage` (default `globalThis.localStorage`), key `'leoposta:refreshInterval'`; `load` returns the stored value only when it is one of the five modes, else `'instant'`.

- [ ] **Step 4: Run tests and verify they pass**

Run: `npx vitest run src/__tests__/refreshGuard.test.ts src/__tests__/refreshController.test.ts`
Expected: PASS (Task 1's 5 + the 4 new)

- [ ] **Step 5: Commit**

```bash
git add src/refresh.ts src/__tests__/refreshController.test.ts vitest.config.ts
git commit -m "feat(refresh): start/stop controller for instant/timer modes"
```

---

### Task 3: Store + Settings UI

**Files:**
- Modify: `src/store/index.ts:68-118, 248-254` (state, initializer, setter)
- Modify: `src/components/Settings.svelte` (new Sync section)
- Test: `src/__tests__/refreshStore.test.ts`

**Interfaces:**
- Consumes: `RefreshMode`, `loadPersistedRefreshMode`, `saveRefreshMode` from `src/refresh.ts`.
- Produces: `State.refreshInterval: RefreshMode`; `setRefreshInterval(mode: RefreshMode): void` — updates the store **and** persists via `saveRefreshMode`.

- [ ] **Step 1: Write the failing test**

```ts
// @vitest-environment jsdom
// src/__tests__/refreshStore.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { get } from 'svelte/store'
import { store, setRefreshInterval } from '../store'
import type { RefreshMode } from '../refresh'

class MemStorage implements Storage {
  private m = new Map<string, string>()
  get length() { return this.m.size }
  clear() { this.m.clear() }
  getItem(k: string) { return this.m.get(k) ?? null }
  key(i: number) { return [...this.m.keys()][i] ?? null }
  removeItem(k: string) { this.m.delete(k) }
  setItem(k: string, v: string) { this.m.set(k, v) }
}

beforeEach(() => { vi.stubGlobal('localStorage', new MemStorage()) })

describe('refreshInterval store', () => {
  it('setRefreshInterval updates the store and persists', () => {
    setRefreshInterval('15m' as RefreshMode)
    expect(get(store).refreshInterval).toBe('15m')
    expect(globalThis.localStorage.getItem('leoposta:refreshInterval')).toBe('15m')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/refreshStore.test.ts`
Expected: FAIL — `store` has no `refreshInterval`, `setRefreshInterval` not exported. (If the store module fails to load at all in jsdom due to the `../api` → `import.meta.env` import, this is the same vitest `define` fix from Task 2 applying to the same config — no further change needed.)

- [ ] **Step 3: Implement store changes in `src/store/index.ts`**

- `State` interface (L68-91): add `refreshInterval: RefreshMode` after `threadGrouping` (L90).
- `initialState` (L93-116): `refreshInterval: 'instant'`. **Do NOT call `loadPersistedRefreshMode()` at module scope** — the store module is imported by node-env tests (e.g. `src/__tests__/attachments.test.ts`) where `localStorage` may be undefined and module-scope side effects would crash them.
- New action:
  ```ts
  export function setRefreshInterval(mode: RefreshMode) {
    store.update(s => ({ ...s, refreshInterval: mode }))
    saveRefreshMode(mode)
  }
  ```
- Import at top: `import { saveRefreshMode, loadPersistedRefreshMode, type RefreshMode } from '../refresh'` (both are used: `saveRefreshMode` here, `loadPersistedRefreshMode` by the App.svelte bootstrap in Task 4).

- [ ] **Step 4: Add Settings UI in `src/components/Settings.svelte`**

- Location: inside the existing **Preferences** section next to the thread-grouping checkbox (around L382-390).
- Add a labelled radio group bound to `$store.refreshInterval` (`$effect`-free): options **Instant (default) / 5 min / 15 min / 60 min / Off**, values `'instant' | '5m' | '15m' | '60m' | 'off'`. Binding writes through the store; the controller is driven exclusively by the `$effect` in Task 4, so no side effects in the change handler.
- Keep the Svelte 5 `$`-prefix bindings the rest of the file already uses (e.g. the `bind:checked={$store.threadGrouping}` style at L386).

- [ ] **Step 5: Verify store + typecheck**

Run: `npx vitest run src/__tests__/refreshStore.test.ts && npm run typecheck`
Expected: PASS — the 2 new tests pass; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/store/index.ts src/components/Settings.svelte src/__tests__/refreshStore.test.ts
git commit -m "feat(refresh): refreshInterval store + Settings UI"
```

---

### Task 4: Wire into App.svelte (`$effect`)

**Files:**
- Modify: `src/refresh.ts` (export `runRefreshTick`)
- Modify: `src/store/index.ts` (add `bootstrapRefreshMode`)
- Modify: `src/App.svelte` (add `$effect` + call `bootstrapRefreshMode` in `onMount`)
- Test: `src/__tests__/refreshGuardIntegration.test.ts`

**Interfaces:**
- Consumes: `startRefresh`, `stopRefresh` (Task 2), `$store.refreshInterval` (Task 3), `loadMessages` (already in App.svelte L151-179), `getState().activeFolder`.
- Produces: `runRefreshTick(onTick: () => void): void` (exported from `src/refresh.ts`) — runs `onTick` only when the focus guard allows. The `$effect` block in `App.svelte` that starts/stops refresh based on mode + active account; `bootstrapRefreshMode()` called from `onMount`.

- [ ] **Step 1: Write the failing test (guarded tick)**

```ts
// @vitest-environment jsdom
// src/__tests__/refreshGuardIntegration.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runRefreshTick } from '../refresh'

describe('runRefreshTick', () => {
  beforeEach(() => { document.querySelectorAll('*').forEach((el: Element) => (el as HTMLElement).blur()) })

  it('runs the tick when no input is focused', () => {
    const tick = vi.fn()
    runRefreshTick(tick)
    expect(tick).toHaveBeenCalledTimes(1)
  })

  it('skips the tick while a text input has focus', () => {
    const tick = vi.fn()
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    runRefreshTick(tick)
    expect(tick).not.toHaveBeenCalled()
    input.blur()
  })

  it('skips the tick while a contenteditable has focus', () => {
    const tick = vi.fn()
    const div = document.createElement('div')
    div.setAttribute('contenteditable', 'true')
    document.body.appendChild(div)
    div.focus()
    runRefreshTick(tick)
    expect(tick).not.toHaveBeenCalled()
    div.blur()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/refreshGuardIntegration.test.ts`
Expected: FAIL — `runRefreshTick` is not exported from `../refresh`

- [ ] **Step 3a: Implement `runRefreshTick` in `src/refresh.ts`**

Append to the end of `src/refresh.ts`:

```ts
export function runRefreshTick(onTick: () => void): void {
  if (!isTypingFocused()) onTick()
}
```

And update `startRefresh` so both the interval callback (`5m/15m/60m`) and the SSE `mailbox-update` listener call `runRefreshTick(onTick)` instead of invoking `onTick` directly — the guard is a single source of truth.

- [ ] **Step 3b: Restore the saved mode on startup**

- In `src/store/index.ts` (which already imports from `../refresh` — keep this one-way; `src/refresh.ts` must NOT import the store):
  ```ts
  export function bootstrapRefreshMode(): void {
    setRefreshInterval(loadPersistedRefreshMode())
  }
  ```
- In `src/App.svelte` `onMount` (L447-454): call `bootstrapRefreshMode()` first, before `loadFolders()`.

- [ ] **Step 3c: Add the `$effect` to `src/App.svelte`**

Add the import to the existing component-level `<script lang="ts">` block:

```svelte
import { startRefresh, stopRefresh } from './refresh'
import { bootstrapRefreshMode } from './store'
```

Then add the `$effect` just below the existing `$effect` on `$store.activeAccountId` (L444-454):

```svelte
$effect(() => {
  const mode = $store.refreshInterval
  const account = $store.activeAccountId
  if (mode === 'off' || !account) {
    stopRefresh()
    return () => stopRefresh()
  }
  startRefresh(mode, () => {
    const folder = getState().activeFolder
    loadMessages(folder)
  })
  return () => stopRefresh()
})
```

(`loadMessages` at L151 preserves `selectedMessageId` — it only replaces `messages`, so the open message stays open. Verify at review if selection is unexpectedly cleared.)

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: PASS — ≥ 98 tests (96 baseline + tasks 1-4 new); typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/App.svelte src/__tests__/refreshEffect.test.ts
git commit -m "feat(refresh): start/stop idle stream + timer via refreshInterval effect"
```

- [ ] **Step 6: Manual smoke test (acceptance)**

Run: `npm run dev` and, in the browser:
1. Settings → Sync: confirm all five options render; changing from *Instant* to *Off* and back opens/closes the SSE stream (DevTools → Network → idle).
2. With *Instant* selected, send a test e-mail to the account; the list re-fetches and the unread badge increments without a reload.
3. Open Compose, type in the To field, wait past one timer tick (switch to *5 min* and wait one tick OR trigger an inbound mail while typing) — confirm no reload occurs while the input has focus, and it does occur after blur.

- [ ] **Step 7: Cleanup + final gates**

Run: `npx vitest run && npm run typecheck && npm run build && node --test 'server/**/*.test.js' 'server/*.test.js'`
Expected: all four green.

```bash
git add -A
git commit -m "docs: mark inbox auto-refresh shipped" -m "Ref: docs/superpowers/specs/2026-11-09-inbox-auto-refresh-design.md" --allow-empty
```

- [ ] **Step 8: ROADMAP.md entry**

Add a `[x]` line under `## Now (P0)` referencing this spec + the 5 commits; delete `PROGRESS.md` if it exists.
