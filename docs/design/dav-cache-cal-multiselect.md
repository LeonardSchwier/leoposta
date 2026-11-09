# DAV server cache + calendar multi-select — design

Date: 2026-11-09 · Status: decided (user sign-off in chat, driving autonomously)

## Intent & why
Three reported symptoms, one root area:
1. **Contacts show only "ein paar"** — OX (mailbox.org) intermittently answers a
   `addressbook-multiget` for the large book (`/carddav/32/`, ~2.716 cards) in
   >30s under load. `davRequest`'s hard 30s timeout (`server/lib/dav.js:65`)
   kills it → route 500s → `Contacts.svelte` keeps the 20 cards it already had
   and shows an error banner. Stale small result + error, not a real failure.
2. **Calendar appears to be missing 24.04.2027** — the event is present and the
   server serves it (verified in `/caldav/Y2FsOi8vMC8zMQ/`). `Calendar.svelte`
   holds a single `currentCal`; sidebar buttons *switch* the calendar rather
   than *select* it, so events in any other book are invisible while another
   book is active. UX gap, not a data bug.
3. **No caching anywhere** — every view load round-trips OX; cold loads are
   slow and put repeated load on the server (which is what caused #1).

Goal: make DAV reads reliable and fast without bloating the client, and make
the calendar show all selected books at once. Chosen scope is **B only**
(server-side cache) — **no client IndexedDB cache** (explicitly dropped).

## Decisions (fixed by user)
- **B alone**: server-side in-memory response cache for CardDAV + CalDAV reads.
  **Not C** (client-side IndexedDB). Confirmed by user.
- **TTLS**: 60s after a write (invalidation), 10min "idle" default. Confirmed.
- **Timeout**: read DAV requests → 120s. Writes (PUT/DELETE) stay at current 30s. Confirmed.
- **Retry**: on a read timeout, halve the multiget batch (500→250→…) and retry. Confirmed.
- **Calendar selection**: default = **all** books selected; user toggles are
  **persisted** (survive reload). Confirmed.

## Non-goals / anti-goals
- No client-side cache layer, no `idb` stores, no offline DAV fallback.
- No change to IMAP/mail paths (out of scope).
- No new npm dependencies.
- Do not change route signatures or JSON shapes for contacts/calendar
  (the existing routes snapshot must stay valid).

## Constraints
- `server/` is ESM (`node --test server`), pure-Node, no framework in `lib/`.
- Server tests use `node:test` + `fetch` against `createApp().listen(0)`
  (see `server/server.test.js`). `lib/` unit tests are pure and fast
  (see `server/lib/dav.test.js`).
- `src/` is Svelte 5 + TS; component UI logic that is pure can be extracted to
  `src/lib/*.ts` and unit-tested with Vitest (pattern: `src/__tests__/store.test.ts`).
- Design tokens only (no raw hex) — new calendar-multi-select UI reuses existing
  `var(--color-*)` variables already used in `Calendar.svelte`.
- `routes.snapshot.test.js` records 41 routes; keep that count and the set stable.

## Approaches considered
- **A. Client IndexedDB cache (C)** — rejected by user (drop); also the
  offline-fallback UX is a larger build than warranted now.
- **B. Server in-memory TTL cache + timeout/r retry** — **chosen**. Small, pure-Node,
  no deps, directly removes the repeated load that caused the timeout. Serves any
  client (web/tauri).
- **B' (variant). Per-card/etang cache with If-Match/If-Range** — more precise but
  needs etag plumbing on every DAV request and per-file accounting; overkill and
  still doesn't fix the 30s wall. Folded into B as: cache the *parsed* response.

## How each concern is solved (B)

### 1. Read timeout 30s → 120s (writes stay 30s)
- `davRequest` gains an explicit read-vs-write distinction. `lib/dav.js` adds
  `DAV_READ_TIMEOUT_MS` (120_000) and `DAV_WRITE_TIMEOUT_MS` (30_000) constants
  (env-overridable for tests: `DAV_TIMEOUT_READ_MS` / `DAV_TIMEOUT_WRITE_MS`).
- `davRequest` infers read vs write by method: `GET`, `PROPFIND`, `REPORT`,
  `OPTIONS` → read; `PUT`, `DELETE`, `MKCOL`, others mutable → write. Expose a
  testable helper `timeoutForMethod(method): number` in `lib/dav.js` and unit-test it
  (this is the unit-testable seam; the socket timeout itself is not unit-tested).
- `server/lib/dav.js:65` uses `req.setTimeout(timeoutForMethod(method), ...)`
  and the error message reports the actual ms.

### 2. Halving-retry on read timeout (contacts multiget)
- New pure helper in `lib/dav.js`:
  `export async function multigetWithRetry(urlPath, allHrefs, fetchBatch, acct, { maxBatch = 500, minBatch = 50 } = {})`
  where `fetchBatch(hrefs) → array-of-cards` does one REPORT. If a batch throws an
  error whose message matches the DAV timeout pattern (`/times out after \d+s/i`)
  **and** `hrefs.length > minBatch`, retry the same slice at `ceil(len/2)` batch
  size recursively. Otherwise propagate.
- `routes/carddav.js` `/contacts` uses it: replaces the 500-batch `for` loop.
  Non-timeout errors still propagate to the 500 handler.
- Unit-test the halving logic with a stub `fetchBatch` that (a) times out for
  `len > 200`, (b) succeeds otherwise; assert the call sizes shrink
  e.g. 500→250→125 and the union of results is complete & order-stable.

### 3. Server response cache (contacts + events) with invalidation
- New pure module `server/lib/davcache.js` (no framework). Generic TTL map:
  ```
  export function createCache(maxBytesOrEntries) {
    return { get(key), set(key, value, ttlMs), invalidatePrefix(prefix),
             invalidate(key), clear(), size() }
  }
  ```
  Keyed string map, FIFO-ish eviction by `size` when unbounded (`maxEntries`),
  lazy expiry on read. No timers (test-friendly). Export `TTL_SHORT=60_000`,
  `TTL_LONG=10*60*1000`.
- Wiring:
  - `routes/carddav.js` `/contacts`: key
    `` `contacts|${acct.id}|${book}` `` (cache the **parsed** `contacts` array
    before filtering/sort — the raw parsed list, not per-query). On hit:
    apply the same `q` filter + sort and return. TTL = `TTL_LONG`.
    The `/contacts/calendars` list is also cached: key
    `` `calendars|${acct.id}` ``, TTL `TTL_LONG`.
  - `routes/calendar.js` `/calendar/events`: key
    `` `events|${acct.id}|${calendar}|${start}|${end}` ``, TTL `TTL_LONG`.
  - Invalidation on write paths (per `acct.id` only):
    - `PUT /contact`, `DELETE /contact`, `POST /contacts/import`
      → `invalidatePrefix(`contacts|${acct.id}|`)` + `invalidate(`calendars|${acct.id}`)`.
    - `PUT /calendar/event`, `DELETE /calendar/event`, `POST /calendar/import`
      → `invalidatePrefix(`events|${acct.id}|`)` + `invalidate(`calendars|${acct.id}`)`.
  - Cache instance lives in `server/lib/state.js` (`state.davCache = createCache(...)`)
    so every route module and the tests share one instance; also export
    `invalidateAccountDavCache(acctId)` helper for routes.
- Unit-test `createCache` (expiry via a clock injection `now()` param, invalidation
  by prefix, eviction by size) in `server/lib/davcache.test.js`.
- Integration test `server/davcache.route.test.js`: with a stubbed `davRequest`
  (monkeypatch or a fake account pointing at a local stub server), assert the
  second identical `GET /contacts` does not re-hit the DAV layer (count DAV calls).
  Keep it minimal and deterministic. If stubbing `davRequest` is fragile, instead
  assert cache hit/miss via the exported helper in a focused unit test and add one
  route-level smoke test that a cached response matches a fresh one.

### 4. Calendar multi-select (default-all, persisted)
- Extract the pure selection logic to `src/lib/calSelection.ts`:
  ```
  export type CalSelection = { selected: string[] }   // uris
  export function defaultSelection(cals: {uri:string}[]): string[] // all uris
  export function loadSelection(storage: Pick<Storage,'getItem'|'setItem'>,
                                storageKey: string, cals: {uri:string}[]): string[]
  export function saveSelection(storage, storageKey, cals, selected)
  export function isCalSelected(selected: string[], uri: string): boolean
  ```
  Rules: on load, intersect persisted set with current uris (drop unknowns); if
  persisted is empty AND no persistence ever existed → default = all. If user
  selected none, that's a valid empty selection (persist it). New calendars that
  appear are NOT auto-checked (only the first-load default-all rule).
- `Calendar.svelte`:
  - `currentCal` → `selectedCals = $state<Set<string>>(new Set())`
  - on mount: `loadCalendars()` → seed `selectedCals` from `loadSelection(localStorage, …, calendars)` → `loadEvents()`.
  - `loadEvents()`: `Promise.all(selectedCals.map(uri => CalendarAPI.events(uri, s, e)))`
    → union, dedupe by `uid` (prefer first occurrence / keep `calendar` field).
    On a single calendar failure, show a banner naming that calendar but keep
    the others (graceful — mirrors the contacts "stale + banner" improvement).
  - Sidebar buttons → checkboxes (`bind:checked`), plus "All"/"None" quick
    actions. Persist via `saveSelection` on any change, then `loadEvents()`.
  - Create/save/delete/import target: the **first selected** calendar
    (documented in the editor as "target calendar: <name>") — single-target
    stays correct for writes.
  - Reuse existing `var(--color-*)` vars; no new hex.
- `src/api/index.ts` `CalendarAPI.events` already takes a calendar; no change
  needed (server unchanged for single-cal GET). Multi is composed client-side.
- Vitest `src/__tests__/calSelection.test.ts` (jsdom or node + a stub storage):
  default-all, persisted subset persists, unknown uris dropped, empty selection
  stays empty, new calendar not auto-added.

## Files touched
- `server/lib/dav.js` — timeout constants + `timeoutForMethod`, `multigetWithRetry`.
- `server/lib/davcache.js` (new) + `server/lib/state.js` (add `state.davCache`,
  `invalidateAccountDavCache`).
- `server/routes/carddav.js`, `server/routes/calendar.js` — cache wiring + retry.
- `server/lib/davcache.test.js`, `server/lib/dav.test.js` (extend),
  `server/davcache.route.test.js` (integration).
- `src/lib/calSelection.ts` (new), `src/components/Calendar.svelte`,
  `src/__tests__/calSelection.test.ts`.
- `ROADMAP.md` (new item, tick on merge), `PROGRESS.md` (delete at merge).

## Acceptance
1. `npm run typecheck`, `npm test`, `npm run test:server`, `npm run build` all green.
2. New unit tests for `createCache`, `timeoutForMethod`, `multigetWithRetry`,
   `calSelection` pass.
3. `routes.snapshot.test.js` still 41 routes (no signature change).
4. Manual (when OX reachable): calendar shows events across all selected books
   incl. the 2027-04-24 event; contacts page returns the full large book without
   the "ein paar" + banner (second load is served from cache).
