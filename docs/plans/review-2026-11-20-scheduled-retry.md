# Plan: retry a scheduled mail after a transient failure, and keep persistence out of the outcome

Design: `docs/design/review-2026-11-20-scheduled-retry.md`. Baseline (main f68d7ca, Node
22.23.5): `npx vitest run` 458 pass (56 files); `node --test` over every server test file except
`server/starttls.test.js` (it hangs in this sandbox, `EAFNOSUPPORT ::ffff:127.0.0.1`, unrelated)
425 pass; `npm run typecheck` 0 errors; `npm run build` clean (there is no `lint` script).

1. Tests first (RED): `server/lib/sendRetry.test.js` (classification table, delays, error text,
   Message-ID, state transitions) and new cases in `server/scheduler.test.js` (transient retry and
   its timing, permanent failure, give-up after 24 h, fields saved to `scheduled.json`, Message-ID
   reused, a save that throws neither flips a sent mail to failed nor rejects, a failed save in
   the failure path does not reject). Run them: they fail (no module, old behaviour).
2. `server/lib/sendRetry.js` (pure functions only).
3. `server/routes/send.js`: `processScheduledMessages(send, clock)`, a guarded `persist()`,
   outcome handling through `afterFailedAttempt`, the Message-ID created before the first attempt,
   `sendScheduledMessage` passes `msg.messageId` on to nodemailer.
4. Verify: the new tests pass, the old scheduler tests pass unchanged, mutation checks (each
   killed by a test): classification default flipped to transient, no 24 h cap, the window counted
   from the scheduled time only, retry delay counted from the tick, Message-ID regenerated per attempt
   or not saved before the attempt, nextAttemptAt ignored, the old retry time kept on give-up, no
   ambiguous-failure cap, TLS setup errors or `ETLS` treated as transient, no punycode, an unguarded
   save together with no safety net (the single unguarded save alone is absorbed by the safety net,
   which is defence in depth), the old `.then().catch()` chain shape.
   After the independent review (no Critical or High): ambiguous-failure cap, TLS setup errors
   permanent, `ETLS` removed from the transient list, window from the first attempt, punycode
   Message-ID domain, and tests with real nodemailer error objects.
5. Whole suite: `npx vitest run`, `node --test` (server set), `npm run typecheck`, `npm run build`,
   `npm run check:redos`. `npm run test:e2e:real` cannot run here (no container runtime).
6. Independent diff review; fix Critical/High; `ROADMAP.md`, `CHANGELOG.md`; rebase on
   origin/main, re-run, push.
