# Review run 2026-11-11: SSE disconnect leak, CORS wildcard and stack traces, unlock throttling

Date: 2026-11-11 · Status: decided autonomously (unattended daily run, no user to interview). `ROADMAP.md` had no open `[ ]` item (the only `[~]` is the recurring security audit, which needs an OS sandbox), so this is review mode. It works through the leftovers the previous review run and the security audit recorded.

## Findings (each reproduced by a failing test before the fix)

1. **`GET /api/idle` leaks an IMAP session when the browser drops the stream early.** The handler awaited `client.connect()` and `client.getMailboxLock()` and only then registered `req.on('close')`. `close` fires once, so a stream dropped during those awaits (every change of inbox-sync mode or active account restarts the `EventSource`, and a connect takes seconds) never ran the cleanup. The logged-in IMAP session, the mailbox lock and the 25 s heartbeat timer then lived until the process ended, and providers cap concurrent IMAP sessions. A failed connect also left the half-open client unclosed, and an IDLE that rejected ended the response without logging out.
2. **`/api/idle` wrote `Access-Control-Allow-Origin: *` itself.** `res.writeHead` overrides the origin-specific header the `cors()` middleware had already set, so the one route that streams mailbox events answered for every site. It sits behind the token, which is why it was noted as low risk on 2026-11-10; it still defeats the allowlist.
3. **Errors leaked Express's HTML stack-trace page.** A request from a disallowed origin (checked before the token) and malformed JSON (`POST /api/accounts` with `{"email":`) both went to Express's default handler, which prints the stack with local file paths unless `NODE_ENV=production`. This server runs locally without it.
4. **`POST /api/pgp/unlock` had no attempt throttling** (open `needs_validation` item under Standing rules, review B5).

## Decisions

- Fix 1: register `close` on `res` (not `req`: it fires when the connection drops or the response ends and does not depend on how a request body is consumed) before the first await. A `ready` flag splits ownership: before the stream is ready, a drop calls `client.close()` to abort the pending connect or lock, and the awaiting code then cleans up (a client that is still connecting cannot be logged out, so the handler never calls `logout` until the connect settled); afterwards the close handler runs `teardown()`. `teardown()` is idempotent and releases only what was acquired. `createIdleRouter({ createClient, resolve, heartbeatMs })` makes the races testable with a fake client; the default export is unchanged, so `routes.snapshot.json` is unchanged.
- Fix 2: delete the header from the handler. The `cors()` middleware keeps answering for the allowlist.
- Judges (opus and sonnet, independent diff reviews): no Critical/High findings; their Medium/Low points (reserve the attempt before the await, drop the nonexistent `idle.stop()`, abort a pending connect with `close()`, 404 label, test sync points) are included.
- Fix 3: one `apiErrorHandler` (`server/lib/errors.js`) replaces the 413-only handler: 413 `too_large`, 400 `invalid_json`, 403 `origin_not_allowed` (the CORS callback now raises a coded error), other 4xx `bad_request`, anything else a generic 500 `internal_error` with the real error logged server side. It defers to Express when headers are already sent (SSE, half-sent files).
- Fix 4: a fixed-window attempt limiter (`server/lib/throttle.js`, `attempt()` counts synchronously before the decrypt is awaited, after the independent reviews showed a check-then-count design would let concurrent guesses through once the decrypt gets slower): 5 attempts lock the route for the rest of a 60 s window (429 `too_many_attempts` plus `Retry-After`), a success resets it, refused attempts do not extend it. In-memory and global: this is a local single-user server, so a per-client key would add nothing. Accepted trade-off: someone holding the API token can lock the owner out of unlock for a minute at a time; they could already read all mail with that token, and the lockout clears itself.

## Not done (recorded, no change)

- `?token=` on idle and attachment GETs may reach logs (open `needs_validation`, B1): fixing it needs a different EventSource auth scheme (short-lived ticket), which is a design change.
- End-to-end tests could not run here (Playwright browser download refused by the sandbox proxy); no browser code changed.
