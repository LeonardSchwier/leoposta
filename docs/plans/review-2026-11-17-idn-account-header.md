# Plan: non-Latin-1 account addresses in the x-account header

Design: `docs/design/review-2026-11-17-idn-account-header.md`. Baseline (main 1c549ad, Node 22.23.4):
`npx vitest run` 364 pass (51 files); `node --test` over every server test file except
`starttls.test.js` 418 pass (`starttls.test.js` fails and hangs in this sandbox, unrelated);
`npm run typecheck` 0 errors; `npm run build` clean (there is no `lint` script).

1. RED, client: `src/__tests__/accountHeader.test.ts`: helper values, `apiFetch` with a Cyrillic
   and a Polish address does not throw and sends an ASCII `u8:` value that decodes back,
   a plain address is sent unchanged, an outbox flush and `pgpStatus` do the same, and a
   source scan fails when a file other than the helper names `'x-account'`.
   Run: `npx vitest run src/__tests__/accountHeader.test.ts` -> fails (module missing).
2. RED, server: `server/lib/state.test.js` (`decodeAccountHeader`, `resolveAccount`) and
   `server/server.test.js` (`/api/send` over real HTTP with an encoded header, a malformed
   one, an unknown one). Run `node --test server/lib/state.test.js server/server.test.js`
   -> new tests fail.
3. GREEN: `src/lib/accountHeader.ts`; use it in `src/api/index.ts`, `src/lib/offlineQueue.ts`,
   `src/lib/pgp.ts`, `src/components/Settings.svelte` (2 sites); `server/lib/state.js`.
4. Full gate: vitest, server tests, typecheck, build; re-run step 1 and 2 commands.
5. Independent review of the diff (judge), fix Critical/High; ROADMAP.md entry with evidence.
