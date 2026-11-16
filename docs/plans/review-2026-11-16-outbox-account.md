# Plan: send an offline-queued message from the account it was written under

Design: `docs/design/review-2026-11-16-outbox-account.md`. Baseline (main 4cc03e0, Node
22.23.4): `npx vitest run` 359 pass (51 files); `node --test "server/**/*.test.js"` 420
pass, 1 fail (`server/starttls.test.js` "SMTP with TLS off refuses to authenticate when
STARTTLS is missing": the sandbox has no IPv4-mapped IPv6 sockets, `connect EAFNOSUPPORT
::ffff:127.0.0.1`, and the IMAP case of that file then hangs until killed; unrelated);
`npm run typecheck` 0 errors, `npm run build` clean (there is no `lint` script).

1. Tests first, in `src/__tests__/offlineOutbox.test.ts` (4 fail on the old code):
   account recorded at queue time; two messages from two accounts keep their own
   `x-account` after the user switched; an explicit account wins; a message with no
   account still goes out under the active one; a refused (removed) account stays queued
   and is never retried as the active one.
2. `src/api/index.ts` exports `getActiveAccountEmail()`; `src/lib/offlineQueue.ts` adds
   `QueuedMessage.account`, fills it in `addQueuedMessage`, sends it in `doFlush`.
3. `server/server.test.js`: `/api/send` uses the account named by `x-account` and refuses
   an unknown one (pins the contract the client relies on).
4. Verify: `npx vitest run`, `node --test "server/**/*.test.js"`, `npm run typecheck`,
   `npm run build`. `npm run test:e2e:real` cannot run here (no container runtime).
5. Independent diff review, fix Critical/High, update `ROADMAP.md` and `CHANGELOG.md`,
   rebase on origin/main, re-run, push.
