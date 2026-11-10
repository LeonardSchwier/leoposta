# Plan: review run 2026-11-10 (CI server tests, scheduler duplicates, /api/status)

Design: `docs/design/review-2026-11-10-ci-scheduler-status.md`. Baseline (before any change, Node 22.23): `npm run typecheck` clean; `npx vitest run` 117 pass / 0 fail (17 files); `npm run test:server` `# tests 1`; `node --test "server/**/*.test.js"` 109 pass; `npm run build` clean.

## Task 1: CI really runs the server tests
- RED: add `src/__tests__/serverTestScript.test.ts`. Verify: `npx vitest run src/__tests__/serverTestScript.test.ts` fails 2 of 2.
- GREEN: `package.json` `test:server` to `node --test "server/**/*.test.js"`. Verify: same command passes; `npm run test:server` prints `# tests` > 100.

## Task 2: no duplicate scheduled sends
- RED: add `server/scheduler.test.js` (slow send not re-dispatched, failure marks `failed` and is not retried, only due pending messages go out). Verify: `node --test server/scheduler.test.js` fails 3 of 3 (no injectable sender, race present).
- GREEN: in `server/routes/send.js` add the `inFlight` set and the `send` parameter. Verify: `node --test server/scheduler.test.js` passes 3 of 3.

## Task 3: /api/status behind the token
- RED: add the test to `server/server.test.js`. Verify: it fails with 200 where 401 is expected.
- GREEN: in `server/index.js` mount the route after `requireToken`. Verify: `node --test server/server.test.js` passes; `server/routes.snapshot.test.js` unchanged.

## Task 4: verification and delivery
- `npm run typecheck && npx vitest run && npm run test:server && npm run build`, ROADMAP entry with the counts, independent review of the diff, rebase on fresh `origin/main`, push to `main`.
