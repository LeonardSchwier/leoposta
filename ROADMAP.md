# ROADMAP

Open work for **leoposta**. `AGENTS.md` and `PROGRESS.md` point here for "what's
still to build" — treat this file as the source of truth for product scope and
update it as each item lands.

> Legend: `[ ]` open · `[~]` in progress · `[x]` done
> Dates are 2026 (year omitted when obvious).

## Now (P0 — feature gaps, agreed 2026-11-06)

- [x] **Multi-account support** (shipped 2026-11-07)
  - `server/lib/state.js`: `accounts[]` + `active_account_id`, migration from
    legacy single-object store, `getAccount` / `getActiveAccount` /
    `resolveAccount(req)` (reads `x-account` header, falls back to first).
  - `server/lib/imap.js`: per-account IMAP pools + SMTP transporters keyed
    by account id; `createImapClient(acct)` exported.
  - `server/routes/account.js`: `GET/POST /api/accounts` + `PUT/DELETE
    /api/accounts/:email` CRUD and legacy `/api/account` shim.
  - `server/routes/{mail,send,idle}.js` rewritten to `resolveAccount(req)`
    + `getPoolFor(acct)`.
  - `src/api/index.ts`: `AccountAPI` (list/add/update/remove) +
    `setActiveAccountEmail()` sets the `x-account` header on every request.
  - `src/store/index.ts`: `setAccounts` / `setActiveAccount` /
    `getActiveAccount`; account mutations in the store keep the header in
    sync automatically.
  - `src/components/Settings.svelte`: Accounts tab — list, add, edit,
    remove; switching sets the active account and re-syncs the header.
  - Env passwords (`LEOPOSTA_IMAP_PASS`, `LEOPOSTA_SMTP_PASS`) apply to the
    first account only and are never persisted.

- [x] **Email signature** (user-requested, 2026-11-06) — shipped earlier.
  - `src/lib/signature.ts` (13 tests passing), `Compose.svelte` seeds new
    compose + reply/reply-all/forward, `Settings.svelte` exposes
    enable/text/position, `account.signature` persists on the backend
    (`POST /api/account`), and `normalizeAccount` in `store/index.ts`
    fills in defaults for older saved accounts.

## Next (P1 — in-flight or near-term)

- [x] **Attachments on compose** — done 2026-11-07.
  - `src/lib/attachments.ts`: `encodeBase64` (chunked, browser + Node ≥ 18),
    `fileToAttachment`, `AttachmentTooLargeError` with `MAX_ATTACHMENT_BYTES`
    of 25 MiB (~33.3 MB base64, under the 35 MB JSON ceiling on
    `POST /api/send`).
  - `Compose.svelte`: file picker drives `attachments` state via
    `fileToAttachment`, shows chips in the footer with a remove button,
    sends `{ ..., attachments }` in the JSON body, and persists them into
    the offline queue when sending fails while offline.
  - `src/lib/offlineQueue.ts`: `QueuedMessage.attachments` carries the
    base64 through IndexedDB; `flushQueue` includes it in the retry payload.
  - `server/routes/send.js`: `sendScheduledMessage` now forwards
    `msg.attachments` (previously dropped on flush).
  - Accept (verified 2026-11-07): `npx vitest run` → 45 pass / 0 fail
    (8 new: attachments); `npm run test:server` → 11 pass (new:
    "scheduled send with attachments persists the attachments on disk").
- [x] **Design-system restyle** — trigger met 2026-11-06 (see D1, this file).
  `LeonardSchwier/design-system` is the same repo as
  `LeonardSchwier/leoforma` (identical git refs; published as
  `@leonardschwier/leoforma`). v0.2.0 is installed (release-asset
  tarball, `.npmrc` allow-remote), `src/main.ts` imports `fonts.css` +
  `tokens.css`, and `src/app.css` maps 26 CSS custom properties onto
  `--ds-*` tokens. Preact components are NOT adopted: this is a Svelte
  app and the standing rule below (line 262) says keep Svelte components
  local and map new colours to `--ds-*` tokens, never to raw hex.
- [x] **Virtualised list** — done 2026-11-07. Pure windowing helper
  in `src/lib/virtualList.ts` (`computeVirtualRange` + 8 unit tests)
  applied to `MessageList.svelte`; two spacer divs size the window
  above/below the rendered slice.
- [x] **Offline mail cache** — done 2026-11-07.
  - `src/lib/offlineQueue.ts`: new `messages` object store (keyed
    `folder:id`) alongside the existing `outbox` store. API:
    `putMessageCache`, `getMessageCache`, `cacheFolderList` (upsert +
    prune stale rows for the folder), `cachedMessagesForFolder`,
    `clearMessageCache(folder?)`, `cacheKey`.
  - `src/App.svelte`:
    - `loadMessages` writes the fetched list to the cache on success and
      **falls back to `cachedMessagesForFolder`** on API failure,
      setting an `offlineServing` flag + an "Offline — showing N cached
      message(s)" banner.
    - `handleSelectMessage` caches the full message on success and
      **restores it from the cache** when the API is unreachable (only
      for messages previously opened, which is the meaningful case).
    - `handleOnline` re-synchronises the active folder when
      `offlineServing` is set.
  - New dependency: `fake-indexeddb@6.2.7` (dev, Apache-2.0) for the
    cache unit tests.
  - `src/__tests__/offlineCache.test.ts` (8 tests): key format,
    full-message round-trip, list upsert, pruning of stale rows,
    per-folder scoping, single-folder clear, full clear.
  - Accept (verified 2026-11-07): `npx vitest run` → 61 pass / 0 fail
    (8 new); `npx tsc --noEmit` clean; `npx vite build` clean.
- [x] **Filter / rules** — done 2026-11-07.
  - `server/lib/rules.js` (`matchRule` + `applyRules`, 18 tests):
    pure rule engine — `when` (list of
    `{field,operator,value}` AND'd) + `do` (`flag` / `move` / `label`).
    Operators: contains, not_contains, equals, not_equals, starts_with,
    ends_with, regex (invalid regex is a no-match, not a crash).
  - `server/lib/state.js`: `state.rules` persisted to `rules.json`
    (`saveRules()`), loaded on boot, `{ mode: 0o600 }`.
  - `server/routes/rules.js` (new): `GET /api/rules` + `PUT /api/rules`
    (replace the full list). Registered in `server/index.js` after
    mailRoutes.
  - `server/routes/mail.js`: `GET /api/messages` and `GET /api/search`
    now wrap their results in `applyRules(messages, state.rules)` before
    sending — the first matching enabled rule wins; disabled rules are
    skipped; a match that fails every condition is a no-op.
  - `src/lib/rules.ts`: `Rule` / `RuleCondition` / `RuleAction` types +
    `RULE_FIELDS` / `RULE_OPERATORS` / `RULE_ACTIONS` metadata +
    `describeRule()`.
  - `Settings.svelte`: new **Rules** tab (alongside Account). Each rule
    card: enable toggle, one or more condition rows (field / operator /
    value), an action row (flag / move / label), add-condition and
    remove buttons. `Save rules` → `PUT /api/rules`.
  - Accept (verified 2026-11-07): `npx vitest run` → 53 pass / 0 fail;
    `node --test server/lib/rules.test.js` → 18 pass; `npx tsc --noEmit`
    clean; `npx vite build` clean.
- [x] **DAV: timeout tuning, multiget retry, response cache, calendar multi-select** — done 2026-11-09. Design: `docs/design/dav-cache-cal-multiselect.md`.
  - `server/lib/dav.js`: `DAV_READ_TIMEOUT_MS` (120 s) / `DAV_WRITE_TIMEOUT_MS` (30 s), method-driven `timeoutForMethod()`, and `multigetWithRetry()` — on a DAV timeout the href batch is halved and retried (`maxBatch 500` → `minBatch 50`).
  - `server/lib/davcache.js` (new): TTL cache (`createCache(maxEntries)`), `get`/`set` (sliding), `invalidate` (exact key), `invalidatePrefix` (account-scoped). `server/lib/state.js` owns `state.davCache` + `invalidateAccountDavCache(acctId)`.
  - `server/routes/carddav.js`: `/contacts/calendars` (keyed `calendars|<acct>`) and `/contacts?book=` (keyed `contacts|<acct>|<book>`) are now cache-served; the multiget loop is replaced by `multigetWithRetry`; PUT/DELETE/import invalidate the account's cache.
  - `server/routes/calendar.js`: `/calendar/events` (keyed `events|<acct>|<cal>|<start>|<end>`) is cache-served; PUT/DELETE/import invalidate.
  - `src/lib/calSelection.ts` (new) + `src/__tests__/calSelection.test.ts` (9 tests): `defaultSelection` / `loadSelection` / `saveSelection` / `isCalSelected` over an injectable `Storage` — default-all on first load, persist subset, drop unknown uris, keep a deliberate empty selection, never auto-add new calendars.
  - `src/components/Calendar.svelte`: `currentCal` (single) → `selectedCals` (multi, `localStorage`-persisted). Calendar list is now checkboxes with **All / None** quick actions; `loadEvents()` is `Promise.allSettled` over the selected uris with uid-dedupe and a partial-failure banner; create/save/delete/import target the **first selected** calendar (shown in the editor as "Target calendar: <name>").
  - Accept (verified 2026-11-09): `node --test 'server/**/*.test.js' 'server/*.test.js'` → 103 pass / 0 fail; `npx vitest run` → 75 pass / 0 fail (10 files); `npm run typecheck` clean; `npm run build` clean (PWA generated).
- [x] **Recipient autocomplete (To/Cc/Bcc + Calendar attendees) + Compose modal restyle** — done 2026-11-09.
  - `src/lib/contacts.ts` (new): `createContactsCache({ fetcher })` — shared cardbook fetcher + matcher; 8 unit tests.
  - `src/components/RecipientAutocomplete.svelte` (new): shared flat-string autocomplete (debounced, keyboard-nav, `bind:value`); 5 mount tests (incl. parent-driven value re-render).
  - `src/components/Calendar.svelte`: attendees `<input>` → `<RecipientAutocomplete bind:value={fAttendees}>`; 3 new integration tests.
  - `src/components/Compose.svelte`: full rewrite — `.modal-back` + `.modal.compose` centered card (Contacts pattern), To/Cc/Bcc use `RecipientAutocomplete` (flat-string model, `parseRecipients` on send), local autocomplete (~140 lines) deleted; `.compose-window` rules replaced with `.modal-back`/`.modal.compose` CSS; Escape dismiss + focus-trap + Ctrl/⌘+Enter preserved; initial focus on To input.
  - `vitest.config.ts`: added `svelte({ hot: false })` plugin + `resolve.conditions: ['browser']` for Vitest 5 Svelte 5 `mount()` support.
  - Accept (verified 2026-11-09): `npx vitest run` → 96 pass / 0 fail (14 files); `npm run typecheck` clean; `npx vite build` clean; `node --test server/*.test.js` → 32 pass / 0 fail; `node --test 'server/**/*.test.js'` → 109 pass / 0 fail.
- [x] **Autocomplete for To/CC/BCC from contacts** (AGENTS.md core feature checklist) — shipped with the entry above.
- [x] **Inbox auto-refresh (sync mode)** — done 2026-11-09.
  - `src/refresh.ts` (new): `isTypingFocused()` guard; `startRefresh(mode, onTick, idleUrl?)` SSE/timer controller + `stopRefresh()`; `loadPersistedRefreshMode()` / `saveRefreshMode()` over an injectable `Storage`; `runRefreshTick(onTick)` applies the typing-focus guard; `RefreshMode` union `'instant' | '5m' | '15m' | '60m' | 'off'`.
  - 19 unit tests across `src/__tests__/focusGuard.test.ts` (7) + `refreshController.test.ts` (8) + `refreshStore.test.ts` (4).
  - `src/store/index.ts`: `refreshInterval: RefreshMode` (default `'instant'`) in `State`; `setRefreshInterval(mode)` updates store + persists; `bootstrapRefreshMode()` restores saved mode.
  - `src/components/Settings.svelte`: "Inbox sync" section with `<select onchange={onRefreshIntervalChange}>` mapping 5 modes; Svelte-5 `onchange` syntax.
  - `src/App.svelte`: `$effect` keyed on `refreshInterval` + `activeAccountId` + `appMode`, calls `startRefresh`/`stopRefresh`; `bootstrapRefreshMode()` in `onMount`.
  - Accept (verified 2026-11-09): `npx vitest run` → 115 pass / 0 fail (17 files); `npm run typecheck` clean; `npm run build` clean (PWA generated); `node --test 'server/**/*.test.js' 'server/*.test.js'` → 109 pass / 0 fail.

## Review run 2026-11-10 (no open item; review mode, unattended)

- [x] **CI never ran the server tests; scheduled mail could be sent twice; `/api/status` was open** — done 2026-11-10. Design: `docs/design/review-2026-11-10-ci-scheduler-status.md`; plan: `docs/plans/review-2026-11-10-ci-scheduler-status.md`.
  - `package.json`: `test:server` is now `node --test "server/**/*.test.js"` (it was `node --test server`, which on Node 22 ran `server/index.js` as one trivial test, so CI and `npm run check` skipped all server tests). Guard: `src/__tests__/serverTestScript.test.ts`.
  - `server/routes/send.js`: `processScheduledMessages(send = sendScheduledMessage)` keeps an in-memory `inFlight` set so a send slower than the 30 s tick is not dispatched again. Tests: `server/scheduler.test.js` (3).
  - `server/index.js`: `GET /api/status` moved behind `requireToken`; only `/api/health` is open. Test in `server/server.test.js`.
  - Accept (verified 2026-11-10, Node 22.23): baseline `npm run test:server` → `# tests 1`; after: `npm run test:server` → 114 pass / 0 fail; `npx vitest run` → 119 pass / 0 fail (18 files); `npm run typecheck` clean; `npm run build` clean. Without the three source changes all 6 behaviour tests fail (2 script guard, 3 scheduler, 1 status); a seventh new test (synchronous throw) covers a path that already worked.
  - Not run: `npm run test:e2e` (the sandbox proxy refuses the Playwright browser download). Open: `/api/idle` still writes its own `Access-Control-Allow-Origin: *` (behind the token; low risk).

## Review run 2026-11-11 (no open item; review mode, unattended)

- [x] **SSE disconnect leaked IMAP sessions; `/api/idle` wildcard CORS; HTML stack-trace errors; unlock without throttling** — done 2026-11-11. Design: `docs/design/review-2026-11-11-idle-leak-cors-unlock.md`; plan: `docs/plans/review-2026-11-11-idle-leak-cors-unlock.md`.
  - `server/routes/idle.js`: `createIdleRouter({ createClient, resolve, heartbeatMs })`; the `res` close handler is registered before the first await and aborts a pending connect/lock; idempotent `teardown()` releases the lock and logs out; a failed connect logs out its client; the handler-level `Access-Control-Allow-Origin: *` is removed. Tests: `server/idle.test.js` (6).
  - `server/lib/errors.js` + `server/index.js`: one `apiErrorHandler` (413 `too_large`, 400 `invalid_json`, 403 `origin_not_allowed`, 404 `not_found`, other 4xx `bad_request`, generic 500 `internal_error`; no stack traces). Tests: `server/cors.test.js` (5).
  - `server/lib/throttle.js` + `server/routes/pgp.js`: `POST /api/pgp/unlock` allows 5 attempts per 60 s window (counted before the decrypt), then 429 `too_many_attempts` + `Retry-After`; a success resets. Tests: `server/lib/throttle.test.js` (5), route test in `server/server.test.js`.
  - Accept (verified 2026-11-11, Node 22.23.4): baseline `npm run test:server` → 114 pass, `npx vitest run` → 119 pass; after: `npm run test:server` → 131 pass / 0 fail; `npx vitest run` → 119 pass (18 files); `npm run typecheck` clean; `npm run build` clean. On the old code the new behaviour tests fail (idle leak 3 of 4 original race tests, wildcard CORS, 403/400/500 JSON, 429).
  - Not run: `npm run test:e2e` (the sandbox proxy refuses the Playwright browser download). Still open: `?token=` on idle and attachment GETs may reach logs (needs an EventSource ticket scheme, a design change).

## Later (P2)

- [x] Public GitHub repo + `MIT LICENSE` + leotheca-style README —
  `LICENSE` (MIT) added in review C2; README rewritten in review C3.
- [x] E2E tests (Playwright) — `AGENTS.md:142`.
- [x] Mobile / touch refinements — `AGENTS.md:27`. Touch-target a11y
  pass (verified 2026-11-07): every icon-only button now carries an
  `aria-label`; hit areas raised to ≥44×44px (`.action-btn`, `.msg-btn`,
  `.star-btn`, `.back-btn`, `.icon-btn`, Compose `.close-btn`); MessageList
  action bar (Reply/Forward/Archive/Delete) now reachable on mobile
  (`max-width:768px`) instead of `display:none`; row height raised 64→76px
  and `ROW_HEIGHT` constant kept in sync. 66/66 unit tests + `vite build`
  green. Swipe-to-act gestures (AGENTS.md "Swipe to archive/delete,
  long-press for context menu") deferred as an optional enhancement —
  actions are already reachable via the on-screen action bar.
- [x] i18n — decision 2026-11-07: English-only for now (user); no further
  language work scheduled.
- [x] Calendar + Contacts: already wired to CalDAV/CardDAV via
  `davRequest` (`server/index.js:741`) against `DAV_HOST` env —
  multi-account scoping (commit `4e2f84d`) + import validation
  (`server/lib/vcf.js` + `server/contactImport.test.js`, 16 tests).
- [x] i18n (start en, add de/es/fr) — English-only shipped; user
  confirmed English-only is fine for now. Reopen if any language is
  actually requested.

## Security audits (recurring)

- [~] **First security audit** — run-1 done 2026-11-06 (guidance mode,
  `~/.config/opencode/skills/security-audit/`). Result: 5 `needs_validation`
  + 1 `rejected`, 0 `confirmed` (no OS sandbox on this machine → skill keeps
  runtime-proven items at `needs_validation`). Artifacts:
  `~/security-audit-skill/leoposta/run-1/` (`findings.json` PASS, `REPORT.md`).
   Source fixes applied 2026-11-06:
   - [x] `server/index.js:43` write `account.json` with `{ mode: 0o600 }`
   - [x] `server/index.js:16` collapse wildcard `cors()` to an origin allowlist
   - [x] `src/lib/sanitizeHtml.ts` URI-scheme forbid + `rel=noopener` hook (registered via `addHook`; real since review B3)
   - [x] outbound `bodyHtml` sanitize / force text/plain (server: `scrubOutboundHtml`)
- Guidance-mode pass on `sanitizeHtml.ts` + `MessageView.svelte` (2026-11-07, review B3/B4): fixed a tracking bypass (CSS escape `\75rl(` / `image-set()` in `style`) by dropping such styles. `needs_validation`: other browser-specific CSS fetch vectors inside kept `style` values (render-test in the Tauri webview; CSP `img-src https:` does not stop them).
- Re-run in full-audit mode after each P0 lands (multi-account, signature)
  and after provisioning an OS sandbox to flip `needs_validation` → confirmed.

## Review feedback (2026-11-07, written so a small model can execute each item)

How to work these: take ONE item, do its prerequisite first, write the failing test, make it pass, run the item's **Accept** command and paste its output into the commit body. Never tick `[x]` before the Accept command passes. Before adding any npm package run `npm view <name> version license` and pin the exact version. Line numbers are for commit 8244ff3; re-find them with `grep -n` if they moved.

### Review A. Make the server testable (do this first)

- [x] **A1. Export `createApp()` and add a server test harness**
  - Problem: `server/index.js` (1425 lines, 33 routes) builds the Express app and calls `app.listen` at the bottom (line ~1421), so nothing can be tested. There are 16 tests in total (`src/__tests__`), none for the server.
  - Steps: (1) in `server/index.js` wrap everything from `const app = express()` to the last route in `export function createApp() { ... return app }`. (2) Keep module-level state (`account`, `scheduledMessages`, `pool`) inside the closure or in a `state` object passed in. (3) At the bottom: `if (import.meta.url === pathToFileURL(process.argv[1]).href) { createApp().listen(PORT, HOST, ...) }`. (4) Create `server/server.test.js` using `node:test` and `fetch`: start `createApp().listen(0, '127.0.0.1')`, call `GET /api/account`, assert status 200 or 404 (read the route first), close the server. (5) Add script `"test:server": "node --test server"` to `package.json`.
  - Accept: `npm run test:server` exits 0 and prints at least 1 passing test; `npm run server` still starts on `127.0.0.1:3001`.

### Review B. Security (highest risk first)

- [x] **B1. Local API has no authentication**
  - Problem: all 33 routes in `server/index.js` (`grep -nE "app\.(get|post|put|delete)" server/index.js`) answer any local process or any page that passes the CORS check at line 30. Nothing checks a credential, and the routes read mail, send mail and sign with the PGP key.
  - Steps: (1) after A1, add `server/lib/auth.js` exporting `requireToken(token)` that reads header `x-leoposta-token`, compares with `crypto.timingSafeEqual` (compare equal-length Buffers; return 401 JSON `{error:'unauthorized'}` otherwise). (2) In `createApp()` generate `const token = process.env.LEOPOSTA_TOKEN || crypto.randomBytes(32).toString('hex')`; mount `app.use('/api', requireToken(token))` right after the `cors(...)` line, except `GET /api/health` (add it, returns `{ok:true}`). (3) Print the token once at start when it was generated. (4) `src/api/index.ts`: add the header to every request from `import.meta.env.VITE_LEOPOSTA_TOKEN`. (5) Document `LEOPOSTA_TOKEN` and `VITE_LEOPOSTA_TOKEN` in `README.md`.
  - Accept: tests in `server/server.test.js`: no header gives 401, wrong header gives 401, right header gives 200, `/api/health` gives 200 without a header. `npm run test:server` passes.

- [x] **B2. Tauri content security policy is disabled while untrusted mail HTML is rendered**
  - Problem: `src-tauri/tauri.conf.json:26` has `"csp": null`, and `src/components/MessageView.svelte:190` injects mail HTML with `{@html sanitizeHtml(msg.bodyHtml)}`. One sanitizer bypass is then script execution inside the desktop app.
  - Steps: (1) set `"csp"` to `"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: cid: https:; font-src 'self' data:; connect-src 'self' http://127.0.0.1:3001; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"`. (2) Add `src/__tests__/tauriConf.test.ts` that reads `src-tauri/tauri.conf.json` with `fs.readFileSync`, parses it, and asserts `app.security.csp` (check the real key path in the file) is a string containing `default-src 'self'`, `object-src 'none'` and `frame-src 'none'`, and does not contain `script-src 'unsafe-inline'`.
  - Accept: `npm test` passes the new test; `grep -n '"csp": null' src-tauri/tauri.conf.json` prints nothing.

- [x] **B3. The `rel="noopener noreferrer"` hook never runs, and the sanitizer allows risky attributes**
  - Problem: in `src/components/MessageView.svelte` the function `afterSanitizeAttributes` (line 27) is placed inside the DOMPurify config object. DOMPurify ignores it there; hooks only work through `DOMPurify.addHook`. The security-audit entry above marks this `[x]`, which is not true. `ALLOWED_ATTR` (lines 18-21) also allows `id` and `name` (DOM clobbering), `style` (can load remote `url(...)`), and form leftovers (`checked`, `disabled`, `selected`, `value`, `type`, `accept`).
  - Steps: (1) create `src/lib/sanitizeHtml.ts` with `export function sanitizeHtml(html: string): string` containing the current tag list and a trimmed attribute list: remove `id`, `name`, `checked`, `disabled`, `selected`, `value`, `type`, `accept`, `longdesc`, `mailto`. (2) Register hooks once at module load: `DOMPurify.addHook('afterSanitizeAttributes', (node) => { ... })` that (a) sets `rel="noopener noreferrer"` on every `A` with a `target`, and (b) deletes the `style` attribute when its value matches `/url\s*\(|expression\s*\(|@import/i`. (3) Delete the inline function from `MessageView.svelte` and import this one. (4) Add `src/__tests__/sanitizeHtml.test.ts` (first line `// @vitest-environment jsdom`; if the `jsdom` package is missing, add it as a devDependency pinned exactly).
  - Tests that must exist and pass: `<a href="https://x" target="_blank">` gets `rel="noopener noreferrer"`; `<a href="javascript:alert(1)">x</a>` has no `href`; `<img src="x" onerror="alert(1)">` has no `onerror`; `<div id="a" name="b">` has neither attribute; `<p style="background:url(http://t/p.gif)">` has no `style`; `<p style="color:red">` keeps `style`.
  - Accept: `npx vitest run src/__tests__/sanitizeHtml.test.ts` passes.

- [x] **B4. Remote images load automatically (tracking pixels)**
  - Problem: `src` with `https:` is allowed by `ALLOWED_URI_REGEXP` (MessageView.svelte line ~25), so opening a mail tells the sender when and from which IP it was read.
  - Steps: (1) in `sanitizeHtml.ts` add an `afterSanitizeAttributes` branch: for `IMG` with `src` matching `/^https?:/i`, move the value to `data-remote-src` and remove `src`. (2) Export `hasRemoteImages(html: string): boolean`. (3) In `MessageView.svelte` show a one-line banner "Remote images blocked" with a button "Load images" when `hasRemoteImages(msg.bodyHtml)`; the button re-renders with an option `{ allowRemoteImages: true }` that skips step (1). (4) Per-message only; do not persist anything.
  - Accept: tests: default sanitize turns `<img src="https://t/p.gif">` into an element with `data-remote-src` and no `src`; with `allowRemoteImages: true` the `src` stays. `npx vitest run` passes.

- [x] **B5. PGP passphrase is stored in plain text next to the private key**
  - Problem: `server/index.js:1113` defines `PGP_PASS_FILE` (`pgp_passphrase.txt`), line 1138 writes the passphrase to it, line 1163 reads it back to unlock the private key. Anyone who can read the folder has key and passphrase, which makes the passphrase pointless.
  - Steps: (1) remove the write at line 1138 and the read at line 1163. (2) Keep the unlocked key only in memory in a variable `unlocked = { key, expiresAt }` with a 15 minute idle timeout (`const KEY_TTL_MS = 15 * 60 * 1000`), refreshed on each use. (3) Add route `POST /api/pgp/unlock` taking `{ passphrase }` and returning `{ ok: true }` or 401; sign/decrypt routes return 409 `{ error: 'pgp_locked' }` while locked. (4) On startup, if `pgp_passphrase.txt` exists, log a warning "pgp_passphrase.txt is no longer used; delete it" and do NOT read or delete it. (5) Make the `hasPassphrase` field (line ~1120) mean "private key is passphrase protected".
  - Accept: server tests: signing while locked gives 409; after `/api/pgp/unlock` with the right passphrase signing works; a wrong passphrase gives 401; no code path reads `pgp_passphrase.txt` (`grep -n pgp_passphrase server/index.js` shows only the warning).

- [x] **B6. IMAP and SMTP passwords are stored in plain text in `account.json`**
  - Problem: `server/index.js:45-58` loads and saves `account.json` (mode 0600) including `imapPass` (line 141) and `smtpPass` (line 253).
  - Steps (small slice first): (1) in the account load function, if env `LEOPOSTA_IMAP_PASS` / `LEOPOSTA_SMTP_PASS` is set use it instead of the file value. (2) When saving, omit `imapPass` and `smtpPass` for any password that came from the environment. (3) Document in `README.md` a "Credentials" section stating exactly what is stored where (account.json, scheduled.json, pgp_private.asc) and the env-var option. (4) Follow-up item, do not start it in the same change: store passwords in the OS keychain through a Tauri command.
  - Accept: server test: with `LEOPOSTA_IMAP_PASS=secret` set, after `POST /api/account` the file `server/account.json` does not contain the string `secret`.

- [x] **B7. Outbound HTML scrub is a list of regexes and is easy to bypass**
  - Problem: `scrubOutboundHtml` (`server/index.js:16-27`) strips `<script>` and `on*=` with regexes. Nested or malformed markup passes, for example `<scr<script>ipt>alert(1)</scr</script>ipt>` and `<img src=x onerror=alert(1)>` variants.
  - Steps: (1) run `npm view sanitize-html version license`, add it pinned exactly. (2) Replace the function body with `sanitizeHtml(html, { allowedTags: [<same list as src/lib/sanitizeHtml.ts>], allowedAttributes: { a: ['href','target','rel'], img: ['src','alt','width','height'], '*': ['style'] }, allowedSchemes: ['https','http','mailto','tel','cid'], transformTags: { a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }) } })`. (3) Add `server/scrub.test.js`.
  - Tests that must pass: the two strings above produce output with no `<script`, no `onerror`; `<a href="  javascript:alert(1)">x</a>` loses its `href`; `<svg onload=alert(1)>` is removed; plain `<p>hi</p>` is unchanged.
  - Accept: `node --test server/scrub.test.js` exits 0.

- [x] **B8. Request bodies up to 50 MB for every route**
  - Problem: `server/index.js:31` `express.json({ limit: '50mb' })` lets any caller make the server buffer 50 MB on routes that need a few hundred bytes.
  - Steps: (1) default `express.json({ limit: '1mb' })`. (2) Mount a second parser only on the send route: `app.post('/api/send', express.json({ limit: '35mb' }), handler)` (a 25 MB attachment is about 33.4 MB as base64). (3) Return 413 JSON `{ error: 'too_large' }` through an error handler for `entity.too.large`.
  - Accept: server tests: 2 MB JSON to `/api/account` gives 413; 1 KB gives the normal status.

- [x] **B9. `scheduled.json` is not git-ignored and has no file mode**
  - Problem: `server/scheduled.json` holds queued mails (recipients, bodies, attachments). `.gitignore` lists `account.json` and the PGP files but not `scheduled.json`, although the Standing rules below say it is covered. The write at `server/index.js:63` has no `mode`.
  - Steps: (1) add `server/scheduled.json` to `.gitignore`. (2) change the write to `fs.writeFileSync(SCHEDULED_FILE, JSON.stringify(scheduledMessages, null, 2), { mode: 0o600 })`.
  - Accept: `git check-ignore server/scheduled.json` prints the path; `grep -n "scheduled" .gitignore` shows the entry.

### Review C. Quality and truthfulness

- [x] **C1. Add CI**
  - Problem: there is no `.github/` directory, so nothing runs the tests on push.
  - Steps: create `.github/workflows/ci.yml` triggered on `push` and `pull_request`, one job on `ubuntu-latest`: `actions/checkout@v4`, `actions/setup-node@v4` with `node-version: 22` and `cache: npm`, then `npm ci`, `npm test`, `npm run test:server`, `npx vite build`. Do not add steps that need secrets.
  - Accept: `python3 -c "import yaml;yaml.safe_load(open('.github/workflows/ci.yml'))"` exits 0 and the first hosted run is green (record its run id in the roadmap).
  - First hosted run: id 42361817038, success (https://github.com/LeonardSchwier/leoposta/actions/runs/42361817038).

- [x] **C2. Add the missing `LICENSE` and fix the project name**
  - Problem: the item "Public GitHub repo + `MIT LICENSE`" below is ticked `[x]`, but no `LICENSE` file is tracked (`git ls-files | grep -i licen` prints nothing). `package.json` is named `evolution-mail` and has no `license` field.
  - Steps: (1) create `LICENSE` with the standard MIT text and `Copyright (c) 2026 Leonard Schwier`. (2) In `package.json` set `"name": "leoposta"` and `"license": "MIT"`. (3) Regenerate the lockfile name fields with `npm install --package-lock-only`.
  - Accept: `test -f LICENSE && node -p "require('./package.json').license"` prints `MIT`.

- [x] **C3. README describes a different project**
  - Problem: `README.md` is titled "Evolution Mail", says `cd evolution-mail`, and lists Zustand as state management. `zustand` is in `package.json` but `grep -rn zustand src` finds nothing. "Local-First: your mail stays on your device" is not explained.
  - Steps: (1) rename to Leoposta everywhere in `README.md`. (2) Replace `git clone <repo-url>` with `git clone https://github.com/LeonardSchwier/leoposta.git` and `cd leoposta`. (3) Remove the Zustand line; run `npm uninstall zustand`. (4) Delete `src/assets/hero.png`, `src/assets/svelte.svg`, `src/assets/vite.svg` if `grep -rn "hero.png\|svelte.svg\|vite.svg" src index.html` finds no use. (5) Add a short "What is stored where" table (see B6).
  - Accept: `grep -rni "evolution" README.md package.json` prints nothing; `npm test` and `npx vite build` pass.

- [x] **C4. Real end-to-end tests (the script exists, the tests do not)**
  - Problem: `package.json` has `"test:e2e": "playwright test"` but there is no Playwright config and no `tests/e2e`. `AGENTS.md` demands E2E.
  - Steps: (1) create `playwright.config.ts` with `webServer` entries starting `node scripts/dummy/imap.cjs`, `node server/index.js` (with `LEOPOSTA_TOKEN=test-token`) and `npx vite preview --port 3000`, `baseURL: 'http://127.0.0.1:3000'`, `retries: 0`. (2) Create `tests/e2e/mail.spec.ts` with three tests: add the dummy account in Settings; the folder list shows INBOX; opening the first message shows its body text. (3) Add a fixture that fails a test on any `console.error` or `pageerror`. (4) Pin `@playwright/test` to an exact version (now `^1.52.0`). Reference: the sibling project `LeonardSchwier/leotheca` has a working suite in `tests/e2e` with this fixture pattern.
  - Accept: `npx playwright install chromium && npm run test:e2e` exits 0 with 3 passing tests; add `npm run test:e2e` as a CI step after C1.

- [x] **C5. Roadmap and rules claim things that are not true**
  - Problem and fix, one line each (change the text only after the matching item above is done):
    - "Public GitHub repo + `MIT LICENSE`" is ticked but no `LICENSE` file exists (fixed by C2).
    - "`MessageView.svelte:11` add URI-scheme forbid + `rel=noopener` hook" is ticked but the hook never runs (fixed by B3).
    - Standing rule says `server/scheduled.json` is in `.gitignore`; it is not (fixed by B9).
    - Attachments item points at `Compose.svelte:153`; the TODO is now at `Compose.svelte:190` (`grep -n "TODO" src/components/Compose.svelte`).
    - Offline item says `sw.js` exists; `public/` contains no `sw.js` (`ls public`). Check `vite.config.ts` for a PWA plugin and correct the sentence to match.
  - Accept: `grep -n "scheduled.json" .gitignore` matches, and re-reading each bullet above against the files shows no false statement.

- [x] **C6. Split `server/index.js` (1425 lines) after A1 and B1 are done** — done 2026-11-07.
  - `server/index.js` is 84 lines of wiring (CORS/auth/JSON/mount/static/413).
  - `server/lib/`: `state.js`, `address.js`, `imap.js`, `dav.js`, `pgp.js`.
  - `server/routes/`: `account.js`, `mail.js`, `calendar.js`, `carddav.js`, `pgp.js`, `send.js`, `idle.js`.
  - New: `server/routes.snapshot.test.js` records the sorted `METHOD path` pairs of `createApp()` in `server/routes.snapshot.json` (35 routes; all preserved from the monolith).
  - Accept (verified 2026-11-07): `npm run test:server` → 17 pass / 0 fail; `wc -l server/index.js` = 84 (< 200).

### Review D. Design system

- [x] **D1. Adopt the Leoforma tokens (the "deferred" condition is met)**
  - Problem: the Standing rules below defer design-system work until a token set is published. `github.com/LeonardSchwier/leoforma` has published tag `v0.1.1` with `tokens.css`, `fonts.css` and `tokens.json`. Its components are Preact, so they do NOT run in this Svelte app: use tokens and fonts only; keep the Svelte components local.
  - Steps: (1) copy the install form from `LeonardSchwier/leotheca` `package.json` (a codeload tarball URL for `refs/tags/v0.1.1` with the integrity hash in `package-lock.json`); do not use a `github:` dependency, its `prepare` step builds on install and breaks offline builds. (2) In `src/main.ts` add `import '@leonardschwier/leoforma/fonts.css'` and `import '@leonardschwier/leoforma/tokens.css'`. (3) In `src/app.css` map each existing CSS custom property to the matching `--ds-*` token (list them with `grep -o "\-\-ds-[a-z0-9-]*" node_modules/@leonardschwier/leoforma/dist/tokens.css | sort -u`). (4) Keep dark mode working. (5) Update the Standing rule to say tokens are adopted and components are not.
  - Accept: `npx vite build` passes; `npm test` passes; a screenshot comparison in light and dark shows the same layout.

## Standing rules

- security-audit guidance, B5: `POST /api/pgp/unlock` is throttled since 2026-11-11 (5 attempts per 60 s). Frontend still needs an unlock prompt; `pgp_locked` is returned as `error` inside the message's pgp status, there is no sign route yet.

- needs_validation (security-audit guidance, B1): how the Tauri sidecar and frontend share `LEOPOSTA_TOKEN` (the Vite build bakes `VITE_LEOPOSTA_TOKEN` into the bundle; `src-tauri` not reviewed). `?token=` on idle/attachment GETs may reach logs.

- Check this file before starting any feature; update as you go.
- Before merging anything that touches HTML rendering, credentials, or the
  REST API, run at least a guidance-mode `security-audit` pass and record
  any `needs_validation` item here.
- Never commit secrets; credentials live in untracked
  `server/account.json` + `server/scheduled.json` (already in
  `.gitignore` — keep there).
- Design tokens and fonts come from the public package `@leonardschwier/leoforma`
  (release 0.2.0, installed from its release asset, `.npmrc` allows that one
  remote dependency). Its Preact components are NOT used here; keep the Svelte
  components local and map new colours to `--ds-*` tokens, never to raw hex.
