# Per-Account DAV Endpoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow each leoposta account to specify its own CardDAV/CalDAV endpoint (`davUrl`) and optional credentials (`davUser`/`davPass`), so multiple accounts on different servers work out of the box. When absent, the existing global `DAV_HOST` env fallback is preserved.

**Architecture:** A new `resolveDavTarget(acct)` helper in `server/lib/dav.js` derives `{ hostname, port, tls, basePath, user, pass }` from `acct.davUrl` (when set) or the global env constants. All DAV route handlers call this helper for their `basePath` instead of using `DAV_PATH_PREFIX(acct.imapUser)` directly. `davRequest` is updated to accept a per-call target object so it no longer reads module-level globals. The frontend Settings form gains three optional fields sent with the account payload.

**Tech Stack:** Node (node:test + assert for server), Svelte 5 + `svelte/store`, TypeScript.

**Spec:** Brainstormed in-session 2025-07-11. Approach A (single `davUrl` string + optional `davUser`/`davPass`).

## Global Constraints

- No new npm dependencies.
- Node `node --test` for server tests, `vitest run` for frontend (no frontend changes needed in this feature — only Settings.svelte and store/index.ts).
- `davPass` must never appear in any API response (`sanitize()` in account.js).
- `updateAccount` must not clobber existing `davUrl`/`davUser`/`davPass` when the body omits them.

## Review Focus

1. **Account with no `davUrl`** — must behave exactly like today (global `DAV_HOST` fallback, IMAP creds). No regression.
2. **`davUrl` with no explicit port** — must default to 443 (TLS) or 80 (non-TLS per scheme).
3. **`davUser`/`davPass` absent but `davUrl` present** — must fall back to `imapUser`/`imapPass`, not send empty credentials.
4. **`davPass` in API response** — `/api/accounts` and `/api/account` must not leak it.
5. **`davUrl` with a path prefix** (e.g. `https://dav.example.com/dav/john`) — the resulting request path must use account-specific `basePath` derived from that URL, not `/dav/<imapUser>`.

---

### Task 1: Add `resolveDavTarget` to `server/lib/dav.js` and update `davRequest` to use it

**Files:**
- Modify: `server/lib/dav.js`
- Create: `server/lib/dav.test.js`

**Interfaces:**
- Consumes: `account` object (plain object with optional `davUrl`, `davUser`, `davPass`, `imapUser`, `imapPass`)
- Produces:
  - `resolveDavTarget(acct: object) → { hostname: string, port: number, tls: boolean, basePath: string, user: string, pass: string }`
  - `davRequest` now reads `acct.davUrl` via `resolveDavTarget` when provided, falling back to existing `DAV_HOST`/`DAV_PORT`/`DAV_TLS` otherwise. Signature unchanged: `davRequest(method, urlPath, body, contentType, acct)`.

- [ ] **Step 1: Write the failing test**

In `server/lib/dav.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveDavTarget } from './dav.js'

// ---- resolveDavTarget with davUrl ----

test('resolveDavTarget: davUrl with explicit port and path', () => {
  const acct = {
    davUrl: 'https://dav.example.com:8080/dav/john',
    davUser: 'john@x.com',
    davPass: 'secret',
    imapUser: 'john@x.com',
    imapPass: 'imap-secret'
  }
  const t = resolveDavTarget(acct)
  assert.equal(t.hostname, 'dav.example.com')
  assert.equal(t.port, 8080)
  assert.equal(t.tls, true)
  assert.equal(t.basePath, '/dav/john')
  assert.equal(t.user, 'john@x.com')
  assert.equal(t.pass, 'secret')
})

test('resolveDavTarget: davUrl without port defaults to 443 over TLS', () => {
  const t = resolveDavTarget({ davUrl: 'https://dav.example.com/dav/john', imapUser: 'j', imapPass: 'p' })
  assert.equal(t.hostname, 'dav.example.com')
  assert.equal(t.port, 443)
  assert.equal(t.tls, true)
  assert.equal(t.basePath, '/dav/john')
  assert.equal(t.user, 'j')
  assert.equal(t.pass, 'p')
})

test('resolveDavTarget: davUrl http (no TLS) defaults port to 80', () => {
  const t = resolveDavTarget({ davUrl: 'http://dav.example.com/dav/john', imapUser: 'j', imapPass: 'p' })
  assert.equal(t.tls, false)
  assert.equal(t.port, 80)
})

test('resolveDavTarget: no davUrl falls back to DAV_HOST env (defaults dav.example.com:443)', () => {
  const t = resolveDavTarget({ imapUser: 'j', imapPass: 'p' })
  // DAV_HOST defaults to 'dav.example.com', DAV_PORT 443, DAV_TLS true
  assert.equal(t.hostname, 'dav.example.com')
  assert.equal(t.port, 443)
  assert.equal(t.tls, true)
  assert.equal(t.basePath, '/dav/j')
  assert.equal(t.user, 'j')
  assert.equal(t.pass, 'p')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test server/lib/dav.test.js`
Expected: FAIL — `resolveDavTarget is not defined` or `is not a function`

- [ ] **Step 3: Implement `resolveDavTarget` in `server/lib/dav.js`**

Add after the existing `DAV_PATH_PREFIX` definition, before `davRequest`:

```js
import { URL } from 'node:url'

export function resolveDavTarget(acct) {
  const acct0 = acct || {}
  const user = acct0.davUser || acct0.imapUser || ''
  const pass = acct0.davPass || acct0.imapPass || ''

  if (acct0.davUrl) {
    try {
      const u = new URL(acct0.davUrl)
      const tls = u.protocol === 'https:'
      const port = tls ? (u.port ? parseInt(u.port, 10) : 443) : (u.port ? parseInt(u.port, 10) : 80)
      return { hostname: u.hostname, port, tls, basePath: u.pathname || '/', user, pass }
    } catch {}
  }

  return {
    hostname: DAV_HOST,
    port: DAV_PORT,
    tls: DAV_TLS,
    basePath: DAV_PATH_PREFIX(acct0.imapUser || ''),
    user,
    pass
  }
}
```

Then rewrite `davRequest` to use it:

```js
export function davRequest(method, urlPath, body, contentType, acct) {
  return new Promise((resolve, reject) => {
    const t = resolveDavTarget(acct)
    const token = Buffer.from(`${t.user}:${t.pass}`).toString('base64')
    const opts = {
      hostname: t.hostname,
      port: t.port,
      path: urlPath,
      method,
      headers: {
        'Authorization': `Basic ${token}`,
        'Content-Type': contentType || 'application/xml; charset="utf-8"',
        'Depth': '1'
      }
    }
    if (contentType === 'text/xml') opts.headers['Content-Type'] = contentType
    const lib = t.tls ? https : http
    // rest of function body unchanged (req/res handlers)
    const req = lib.request(opts, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf-8')
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ status: res.statusCode, body: data, headers: res.headers })
        } else {
          reject(new Error(`DAV ${method} ${urlPath} → ${res.statusCode}: ${data.slice(0, 300)}`))
        }
      })
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test server/lib/dav.test.js`
Expected: PASS (all 4 tests green)

- [ ] **Step 5: Run full server test suite**

Run: `node --test server`
Expected: No new failures (pre-existing tests unaffected)

- [ ] **Step 6: Commit**

```bash
git add server/lib/dav.js server/lib/dav.test.js
git commit -m "feat(dav): add resolveDavTarget for per-account endpoint resolution"
```

---

### Task 2: Update DAV route handlers to use `resolveDavTarget(acct).basePath`

**Files:**
- Modify: `server/routes/carddav.js`
- Modify: `server/routes/calendar.js`

**Interfaces:**
- Consumes: `resolveDavTarget(acct).basePath` from Task 1
- Produces: No new interfaces; route HTTP contracts unchanged.

The change pattern in **every** handler: replace
```js
const basePath = DAV_PATH_PREFIX(acct.imapUser)
```
with
```js
const basePath = resolveDavTarget(acct).basePath
```
Import `resolveDavTarget` (drop `DAV_PATH_PREFIX` from the import).

- [ ] **Step 1: Update `server/routes/carddav.js`**

Change the import line at the top:
```js
import { davRequest, DAV_PATH_PREFIX, extractResponseSet } from '../lib/dav.js'
```
to:
```js
import { davRequest, resolveDavTarget, extractResponseSet } from '../lib/dav.js'
```

In each of the 5 handlers (`/contacts/calendars`, `/contacts`, `PUT /contact`, `DELETE /contact`, `/contacts/import`), change:
```js
const basePath = DAV_PATH_PREFIX(acct.imapUser)
```
to:
```js
const basePath = resolveDavTarget(acct).basePath
```

- [ ] **Step 2: Update `server/routes/calendar.js`**

Same import change. In each of the 5 handlers (`/calendar/calendars`, `/calendar/events`, `PUT /calendar/event`, `DELETE /calendar/event`, `/calendar/import`), change `DAV_PATH_PREFIX(acct.imapUser)` to `resolveDavTarget(acct).basePath`.

- [ ] **Step 3: Run full server test suite**

Run: `node --test server`
Expected: No new failures

- [ ] **Step 4: Commit**

```bash
git add server/routes/carddav.js server/routes/calendar.js
git commit -m "feat(routes): use per-account basePath in CardDAV and CalDAV routes"
```

---

### Task 3: Thread `davUrl`/`davUser`/`davPass` through `state.js` and `account.js`

**Files:**
- Modify: `server/lib/state.js`
- Modify: `server/routes/account.js`
- Modify: `server/lib/dav.test.js` (add sanitization test)

**Interfaces:**
- Consumes: `accountPayloadFrom` in `state.js`
- Produces:
  - `accountPayloadFrom(body)` returns object with optional `davUrl`, `davUser`, `davPass` fields
  - `updateAccount` preserves existing dav fields when body omits them
  - `sanitize(acct)` strips `davPass` from responses

- [ ] **Step 1: Add a failing sanitization test**

In `server/lib/dav.test.js` (or a new test in `server/routes/account.test.js` — use whichever is simpler; `dav.test.js` is fine since we don't need express):

```js
import { accountPayloadFrom } from './state.js'

test('accountPayloadFrom: passes through davUrl, davUser, davPass when present', () => {
  const p = accountPayloadFrom({
    email: 'j@x.com', imapHost: 'imap.x.com', imapPort: 993, imapTls: true,
    imapUser: 'j', imapPass: 'p', smtpHost: 'smtp.x.com', smtpPort: 465, smtpTls: true,
    smtpUser: 'j', smtpPass: 'p',
    davUrl: 'https://dav.x.com/dav/j', davUser: 'j', davPass: 'dav-secret'
  })
  assert.equal(p.davUrl, 'https://dav.x.com/dav/j')
  assert.equal(p.davUser, 'j')
  assert.equal(p.davPass, 'dav-secret')
})

test('accountPayloadFrom: omits dav fields when not in body', () => {
  const p = accountPayloadFrom({
    email: 'j@x.com', imapHost: 'imap.x.com', imapPort: 993, imapTls: true,
    imapUser: 'j', imapPass: 'p', smtpHost: 'smtp.x.com', smtpPort: 465, smtpTls: true,
    smtpUser: 'j', smtpPass: 'p'
  })
  assert.equal(p.davUrl, undefined)
  assert.equal(p.davUser, undefined)
  assert.equal(p.davPass, undefined)
})
```

- [ ] **Step 2: Run new tests to verify they fail**

Run: `node --test server/lib/dav.test.js`
Expected: FAIL — `p.davUrl` is `undefined` (first test) — no wait, second test passes; first test fails because `accountPayloadFrom` doesn't include the fields.

- [ ] **Step 3: Update `accountPayloadFrom` in `server/lib/state.js`**

In `accountPayloadFrom`, after the `signature` line, add:
```js
davUrl: body.davUrl || undefined,
davUser: body.davUser || undefined,
davPass: body.davPass || undefined
```

(Using `|| undefined` so empty strings in requests don't persist as `''`)

- [ ] **Step 4: Update `updateAccount` merge in `server/lib/state.js`**

In the `merged` object construction, after the `smtpPass` line, add:
```js
davUrl: body.davUrl !== undefined ? body.davUrl : (cur.davUrl !== undefined ? cur.davUrl : undefined),
davUser: body.davUser !== undefined ? body.davUser : (cur.davUser !== undefined ? cur.davUser : undefined),
davPass: body.davPass !== undefined ? body.davPass : (cur.davPass !== undefined ? cur.davPass : undefined)
```

- [ ] **Step 5: Update `sanitize` in `server/routes/account.js`**

Change:
```js
function sanitize(acct) {
  const { imapPass, smtpPass, ...safe } = acct
```
to:
```js
function sanitize(acct) {
  const { imapPass, smtpPass, davPass, ...safe } = acct
  if (davPass !== undefined) delete safe.davPass  // already excluded by destructuring
```
(Just add `davPass` to the destructuring — the `delete` is belt-and-suspenders; in practice the destructuring handles it.)

So the final form is:
```js
function sanitize(acct) {
  const { imapPass, smtpPass, davPass, ...safe } = acct
  if (!safe.signature) safe.signature = { enabled: false, text: '', position: 'standard' }
  return safe
}
```

- [ ] **Step 6: Run tests**

Run: `node --test server/lib/dav.test.js`
Expected: PASS (all 6 tests)

- [ ] **Step 7: Run full server test suite**

Run: `node --test server`
Expected: No new failures

- [ ] **Step 8: Commit**

```bash
git add server/lib/state.js server/routes/account.js server/lib/dav.test.js
git commit -m "feat(state): persist per-account davUrl/davUser/davPass and strip davPass from responses"
```

---

### Task 4: Add DAV fields to frontend `MailAccount` type and Settings form

**Files:**
- Modify: `src/store/index.ts`
- Modify: `src/components/Settings.svelte`

**Interfaces:**
- Consumes: `MailAccount` interface from `src/store/index.ts`
- Produces: `MailAccount` with optional `davUrl?: string; davUser?: string; davPass?: string`

- [ ] **Step 1: Update `MailAccount` in `src/store/index.ts`**

After the `signature: Signature` line (line 55), add:
```ts
davUrl?: string
davUser?: string
davPass?: string
```

- [ ] **Step 2: Add DAV form state and inputs in `src/components/Settings.svelte`**

In the `<script>` section, after the `smtpTls` line (line 20), add:
```ts
let davUrl = $state('')
let davUser = $state('')
let davPass = $state('')
```

In `resetForm()`, add:
```ts
davUrl = ''; davUser = ''; davPass = ''
```

In `startEdit(a: MailAccount)`, after the `smtpHost`/`smtpPort` line (line 39), add:
```ts
davUrl = a.davUrl || ''; davUser = a.davUser || ''; davPass = ''
```

In the `saveAccount` payload (the object passed to `AccountAPI.add` or `AccountAPI.update`), after `smtpTls` add:
```ts
davUrl: davUrl.trim() || undefined,
davUser: davUser.trim() || undefined,
davPass: davPass || undefined
```

In the HTML template, after the SMTP TLS input block, add a new section:
```svelte
<div class="mt-3 pt-3 border-t border-neutral-200 dark:border-neutral-700">
  <p class="text-xs text-neutral-500 mb-1.5 uppercase tracking-wide font-medium">CardDAV / CalDAV</p>
  <p class="text-xs text-neutral-400 mb-2">Optional — leave blank to use global DAV_HOST env config.</p>
  <label class="block text-xs font-medium text-neutral-600 dark:text-neutral-300 mb-1">Base URL</label>
  <input type="url" placeholder="https://dav.example.com/dav/you" bind:value={davUrl}
         class="w-full px-3 py-2 text-sm rounded-lg border border-neutral-300 dark:border-neutral-600 bg-transparent focus:outline-none focus:ring-2 focus:ring-blue-500" />
  <div class="grid grid-cols-2 gap-2 mt-2">
    <div>
      <label class="block text-xs font-medium text-neutral-600 dark:text-neutral-300 mb-1">User</label>
      <input type="text" placeholder="leave blank for IMAP user" bind:value={davUser}
             class="w-full px-3 py-2 text-sm rounded-lg border border-neutral-300 dark:border-neutral-600 bg-transparent focus:outline-none focus:ring-2 focus:ring-blue-500" />
    </div>
    <div>
      <label class="block text-xs font-medium text-neutral-600 dark:text-neutral-300 mb-1">Password</label>
      <input type="password" placeholder="leave blank for IMAP pass" bind:value={davPass}
             class="w-full px-3 py-2 text-sm rounded-lg border border-neutral-300 dark:border-neutral-600 bg-transparent focus:outline-none focus:ring-2 focus:ring-blue-500" />
    </div>
  </div>
</div>
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/store/index.ts src/components/Settings.svelte
git commit -m "feat(settings): add optional per-account CardDAV/CalDAV endpoint fields"
```

---

### Task 5: Final verification

**Files:** none modified

- [ ] **Step 1: Run full server tests**

Run: `node --test server`
Expected: All tests pass, no failures.

- [ ] **Step 2: Run frontend tests**

Run: `npm run test`
Expected: All vitest tests pass.

- [ ] **Step 3: Run lint**

Run: `npm run lint`
Expected: No new errors.

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: No errors.
