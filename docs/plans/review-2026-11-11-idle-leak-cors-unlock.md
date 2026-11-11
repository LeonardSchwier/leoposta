# Plan: review 2026-11-11 (idle leak, CORS, error JSON, unlock throttle)

Design: `docs/design/review-2026-11-11-idle-leak-cors-unlock.md`. Baseline (Node 22.23.4): `npm run test:server` 114 pass / 0 fail; `npx vitest run` 119 pass (18 files); `npm run typecheck` and `npm run build` clean.

Each task is red first, then the minimal fix, then its verification command.

1. **Make the idle route testable (no behaviour change).** `server/routes/idle.js`: export `createIdleRouter({ createClient, resolve, heartbeatMs })`, default export `createIdleRouter()`. Verify: `npm run test:server` still 114 pass.
2. **RED: idle disconnect races.** `server/idle.test.js` with a fake ImapFlow (deferred `connect`, `getMailboxLock`, `idle`): drop the stream during connect, during the lock, during IDLE, and fail the connect. Test cleanup clears every interval the route creates so a regression fails instead of hanging. Verify on the old route: the connect-pending, lock-pending and failed-connect tests fail; the during-IDLE test passes (regression guard).
3. **GREEN: early `close` handlers and idempotent `teardown()`** in `server/routes/idle.js` (see design). Verify: `node --test server/idle.test.js` gives 6 pass (two extra tests cover a connect or lock that settles after the drop).
4. **RED then GREEN: CORS wildcard.** `server/cors.test.js` test 1 asserts the allowed origin is echoed, not `*`; drop the header from the handler. Verify: with the old route the test reads `*`.
5. **RED: error handler.** Tests 2-5 in `server/cors.test.js`: disallowed origin gives 403 JSON, malformed JSON gives 400 JSON, a throwing route gives generic 500 JSON, none with a stack trace. Verify before: 500 / text/html.
6. **GREEN: `server/lib/errors.js`**, wire it into `server/index.js` in place of the 413 handler; the CORS callback raises `originNotAllowedError()`. Verify: `node --test server/cors.test.js` gives 5 pass.
7. **RED then GREEN: unlock throttle.** `server/lib/throttle.test.js` (5 unit tests with an injected clock, one for concurrent callers), a route test at the end of `server/server.test.js` (5 wrong passphrases give 401, the 6th gives 429 with `Retry-After`, and the right passphrase is refused while locked out), then `server/lib/throttle.js` and the guard in `server/routes/pgp.js`.
8. **Verify and document.** `npm run check` (typecheck, vitest, server tests, build), ROADMAP entry with the counts, CHANGELOG lines.
