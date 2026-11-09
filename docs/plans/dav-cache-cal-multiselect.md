# DAV cache + calendar multi-select — Implementation Plan

Source design: `docs/design/` (user-approved).
Baseline: all `node --test server` and `npx vitest` green as of 2026-11-09.

---

## Task 1 — `server/lib/davcache.js` (pure module)

**Goal:** In-memory TTL map. No external deps.

**File:** `server/lib/davcache.js` (new)

```js
let _now = () => Date.now();
// injectable clock for tests
export function setNow(fn) { _now = fn; }

export function createCache(ttlMs) {
  const store = new Map();
  function get(key) {
    const entry = store.get(key);
    if (!entry) return undefined;
    if (_now() > entry.expiresAt) { store.delete(key); return undefined; }
    return entry.value;
  }
  function set(key, value, ttl = ttlMs) {
    store.set(key, { value, expiresAt: _now() + ttl });
  }
  function deleteKey(key) { store.delete(key); }
  function deletePrefix(prefix) {
    for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
  }
  function clear() { store.clear(); }
  return { get, set, deleteKey, deletePrefix, clear };
}
```

**Verification:** `node -e "import('./server/lib/davcache.js').then(m=>{const c=m.createCache(100);c.set('a',1);console.log(c.get('a'))})"` → prints `1`

---

## Task 2 — `server/lib/state.js`: add `davCache` + `invalidateAccountDavCache`

**Goal:** Expose a shared cache instance and a targeted invalidation helper.

First create the cache instance at the top of the module (after any existing imports):

```js
import { createCache } from './davcache.js';
export const davCache = createCache(600_000); // 10 min
```

Add the invalidation helper:

```js
export function invalidateAccountDavCache(acctId) {
  davCache.deletePrefix(`contacts|${acctId}|`);
  davCache.deletePrefix(`calendars|${acctId}`);
  davCache.deletePrefix(`events|${acctId}|`);
}
```

**Verification:** `node --test server` (existing suite must still pass — state.js already exported)

---

## Task 3 — `server/lib/dav.js`: `timeoutForMethod` + `multigetWithRetry`

**Goal:**
- `timeoutForMethod(method)` returns ms per method class.
- `multigetWithRetry(urls, fetchBatch, opts)` does halving-retry on timeout only.

Add near the top of `dav.js` after constants:

```js
const READ_RE = /^(GET|PROPFIND|REPORT|OPTIONS)$/;
const DEFAULT_READ_MS  = Number(process.env.DAV_TIMEOUT_READ_MS)  || 120_000;
const DEFAULT_WRITE_MS = Number(process.env.DAV_TIMEOUT_WRITE_MS) ||  30_000;

export function timeoutForMethod(method) {
  return READ_RE.test(method.toUpperCase()) ? DEFAULT_READ_MS : DEFAULT_WRITE_MS;
}
```

Then replace every existing `timeout` literal in the fetch calls with `timeoutForMethod(method)`. (Grep to find the call sites first; update them individually.)

Then append the retry helper at end of file:

```js
export async function multigetWithRetry(urls, fetchBatch, { maxBatch = 500, minBatch = 50 } = {}) {
  if (urls.length <= maxBatch) {
    return fetchBatch(maxBatch >= urls.length ? urls.length : maxBatch); // just return the list
  }
  try {
    return await fetchBatch(urls.length <= maxBatch ? urls.length : maxBatch);
  } catch (err) {
    const msg = String(err && err.message || '');
    if (/times out after \d+s/i.test(msg) && urls.length > minBatch) {
      const half = Math.max(minBatch, Math.floor(urls.length / 2));
      const first = urls.slice(0, half);
      const rest  = urls.slice(half);
      return multigetWithRetry([...first, ...rest], async (n) => {
        const a = await fetchBatch(Math.min(n, first.length));
        const b = await fetchBatch(rest.length);
        return [...a, ...b];
      }, { maxBatch: half, minBatch });
    }
    throw err;
  }
}
```

**Note:** The above sketch is a starting template. The actual `dav.js` `multiget` implementation may have a different signature. **First grep** `dav.js` for the existing multiget function to see its real interface, then adapt the retry wrapper to match. Do not ship the template unchanged without checking.

**Verification:** `node -e "import('./server/lib/dav.js').then(m=>console.log(m.timeoutForMethod('GET'),m.timeoutForMethod('PUT')))"` → `120000 30000`

---

## Task 4 — Wire cache into `server/routes/carddav.js`

**Goal:**
- `GET /api/contacts?acct=…&book=…` → check `davCache.get('contacts|' + acctId + '|' + book)` first.
- On miss: fetch, cache, return.
- `PUT /api/contact` and `DELETE /api/contact` → call `invalidateAccountDavCache(acctId)` after success.

**Steps:**
1. Read `server/routes/carddav.js` to find the `GET /contacts` handler.
2. Add at top of file: `import { davCache, invalidateAccountDavCache } from '../lib/state.js';`
3. In the GET handler, before the DAV fetch:
   ```js
   const cacheKey = `contacts|${acct.id}|${book}`;
   const cached = davCache.get(cacheKey);
   if (cached) return res.json(cached);
   ```
4. After computing the response payload, before `res.json(payload)`:
   ```js
   davCache.set(cacheKey, payload);
   ```
5. After any successful PUT/DELETE handler (where the contact is written), call:
   ```js
   invalidateAccountDavCache(acct.id);
   ```

**Verification:** `node --test server/davcache.route.test.js` (create this test file — see Task 8)

---

## Task 5 — Wire cache + selection into `server/routes/calendar.js`

**Goal:**
- `GET /api/calendar/events?acct=…&calendar=…&start=…&end=…` → cache check/set.
- `GET /api/calendar/calendars?acct=…` → cache check/set.
- Any write handler → `invalidateAccountDavCache(acct.id)`.

**Steps:** same pattern as Task 4. Cache keys:
- Calendar list: `calendars|${acct.id}`
- Events: `events|${acct.id}|${calendar}|${start}|${end}`

**Verification:** existing `node --test server` still green.

---

## Task 6 — `src/lib/calSelection.ts` (new)

```ts
const KEY = 'leoposta.dav.calSelection';

export type CalSelection = Record<string, boolean>;

export function loadSelection(): CalSelection {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as CalSelection) : {};
  } catch { return {}; }
}

export function saveSelection(sel: CalSelection): void {
  try { localStorage.setItem(KEY, JSON.stringify(sel)); } catch {}
}

export function defaultSelection(ids: string[]): CalSelection {
  return Object.fromEntries(ids.map((id) => [id, true]));
}

export function isCalSelected(sel: CalSelection, calId: string): boolean {
  return sel[calId] !== false;
}

export function selectedIds(sel: CalSelection, allIds: string[]): string[] {
  return allIds.filter((id) => isCalSelected(sel, id));
}
```

**Verification:** `npx vitest run src/__tests__/calSelection.test.ts` (create in Task 9)

---

## Task 7 — `src/components/Calendar.svelte`: multi-select UI

**Steps:**
1. Read the file first to find the current calendar list rendering.
2. Import the helpers:
   ```svelte
   <script>
   import { loadSelection, saveSelection, defaultSelection, isCalSelected, selectedIds } from '$lib/calSelection';
   ```
3. Maintain a `calSelection` reactive store/local.
4. Add a checkbox before each calendar name:
   ```svelte
   <label>
     <input type="checkbox"
       checked={isCalSelected(calSelection, cal.id)}
       on:change={(e) => toggleCal(cal.id, e.target.checked)} />
     {cal.name}
   </label>
   ```
5. Add "All" / "None" buttons that set every `cal.id` to true/false then call `saveSelection`.
6. When fetching events, send `selectedIds(calSelection, allCalIds)` (join with `|` or send as array per API contract — verify how the backend expects multiple calendars first: grep `calendar.js` for the `calendar` query param handling).
7. On unmount or on change, persist: `saveSelection(calSelection)`.

**Verification:** manual — build + load the app, check that checkboxes persist across reloads.

---

## Task 8 — `server/davcache.route.test.js` (new)

Model after `server/contactImport.test.js` (fake DAV, seeded account).

```js
// Fake DAV that counts how many times GET /dav/path is hit.
let davGetCount = 0;
const fakeDav = http.createServer((req, res) => {
  if (req.method === 'PROPFIND' || req.method === 'GET') {
    davGetCount++;
    res.writeHead(200, { 'content-type': 'application/xml' });
    res.end(<?xml version="1.0"?><multistatus xmlns="DAV:"><response/></multistatus>);
    return;
  }
  res.writeHead(207, { 'content-type': 'application/xml' });
  res.end('<?xml version="1.0"?><multistatus xmlns="DAV:"><response/></multistatus>');
});
```

Tests:
1. `GET /api/contacts` twice with same acct+book → first populates cache, second is served from cache (assert `davGetCount` did not increase on second call, or assert response body is identical and DAV counter unchanged).
2. `PUT /api/contact` → then `GET /api/contacts` → DAV counter increments (cache was invalidated).
3. `GET /api/calendar/calendars` twice → second call does not hit fake DAV.

**Verification:** `node --test server/davcache.route.test.js`

---

## Task 9 — `src/__tests__/calSelection.test.ts` (new)

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { loadSelection, saveSelection, defaultSelection, isCalSelected, selectedIds } from '$lib/calSelection';

// Mock localStorage
const store: Record<string, string> = {};
beforeEach(() => {
  Object.keys(store).forEach((k) => delete store[k]);
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (k) => store[k] ?? null,
      setItem: (k, v) => { store[k] = v; },
      removeItem: (k) => delete store[k],
    },
    configurable: true,
  });
});

describe('calSelection', () => {
  it('defaults all to true', () => {
    expect(defaultSelection(['a', 'b'])).toEqual({ a: true, b: true });
  });
  it('isCalSelected respects explicit false', () => {
    expect(isCalSelected({ a: false }, 'a')).toBe(false);
    expect(isCalSelected({}, 'b')).toBe(true);
  });
  it('save + load round-trips', () => {
    saveSelection({ a: true, b: false });
    expect(loadSelection()).toEqual({ a: true, b: false });
  });
  it('selectedIds filters correctly', () => {
    expect(selectedIds({ a: false, b: true }, ['a', 'b', 'c'])).toEqual(['b', 'c']);
  });
  it('survives storage throw', () => {
    Object.defineProperty(globalThis, 'localStorage', { get() { throw new Error(); }, configurable: true });
    expect(() => saveSelection({ a: true })).not.toThrow();
  });
});
```

**Verification:** `npx vitest run src/__tests__/calSelection.test.ts`

---

## Task 10 — Update `ROADMAP.md` + `PROGRESS.md`

- Move the DAV cache + calendar multi-select items from open to `[x]`.
- Delete `PROGRESS.md` (session complete).

**Verification:** `git log --oneline -3` + full `node --test server && npx vitest run` green.
