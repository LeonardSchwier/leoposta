# Review run 2026-11-10: CI server tests, scheduled-send duplicates, open /api/status

Date: 2026-11-10 · Status: decided autonomously (unattended daily run, no user to interview). No open `[ ]` roadmap item existed, so this is review mode.

## Findings (all reproduced before fixing)

1. **`npm run test:server` ran one test, not 109.** The script was `node --test server`. On Node 22 a bare path is run as a test file, so `server/index.js` was executed as a single "test" (it starts the app and exits 0). CI and `npm run check` therefore never ran any `server/**/*.test.js` file. Baseline evidence: `npm run test:server` printed `# tests 1`; `node --test "server/**/*.test.js"` printed `# tests 109`.
2. **Scheduled mail can be sent more than once.** `processScheduledMessages` runs every 30 s and selects `status === 'pending'`. The status only changes after `sendScheduledMessage` resolves, so an SMTP send slower than 30 s (large attachment, slow server, retries) is dispatched again by the next tick, and again, until the first resolves. Recipients get duplicates.
3. **`GET /api/status` answers without a token and lists the mailbox addresses.** Review B1 says only `/api/health` is open. `/api/status` sat before `requireToken`, so any local process, or a DNS-rebinding page, could read every configured address. The only front-end caller (`MailAPI.status`) already sends the token.

## Decisions

- Fix 1: `"test:server": "node --test \"server/**/*.test.js\""`. Escaped double quotes work in `sh` and `cmd`, and Node 22 expands the glob itself. Guard: `src/__tests__/serverTestScript.test.ts` fails if the script is a bare directory or if any `*.test.js` under `server/` is not matched by its patterns.
- Fix 2: an in-memory `inFlight` set, not a new persisted status. A message stays `pending` on disk until the send resolves, so a crash mid-send re-sends (at-least-once) instead of silently losing the mail; the set stops only the same-process double dispatch. `processScheduledMessages(send = sendScheduledMessage)` takes the sender as a default argument so the race is testable without an SMTP server; `setInterval(processScheduledMessages, 30000)` is unchanged.
- Fix 3: move the route behind `requireToken`. `/api/health` stays open (Docker healthcheck, e2e `webServer`, smoke script all use it).

## Not done (recorded, no change)

- `GET /api/idle` writes `Access-Control-Allow-Origin: *` itself. It sits behind the token and the `cors` middleware already answers for the allowlist, so it is not exploitable on its own; left alone to keep the change small.
- End-to-end tests could not run in this sandbox: `npx playwright install chromium` was refused by the egress proxy (`cdn.playwright.dev`). The change touches no browser code.
