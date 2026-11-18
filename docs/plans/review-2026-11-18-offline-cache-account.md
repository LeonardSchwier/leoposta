# Plan: account-scoped offline cache (2026-11-18)

Design: `docs/design/review-2026-11-18-offline-cache-account.md`.

1. RED: extend `src/__tests__/offlineCache.test.ts` (fake-indexeddb): same folder and uid
   under two accounts stay apart; B's list does not prune A's rows; the offline list shows
   one account only; `clearAccountCache` removes one account; a pre-change entry is not
   served and is purged; the remembered account is used when none is active; no account
   means no read and no write; an explicit account pins the scope; overlapping
   `cacheFolderList` calls both persist. Run: `npx vitest run src/__tests__/offlineCache.test.ts`
   (new tests fail).
2. GREEN: `src/lib/offlineQueue.ts` (`cacheScope` for writes, `cacheReadScope` for reads, scoped functions, single-transaction
   `cacheFolderList`, `clearAccountCache`).
3. Wiring: `src/App.svelte` (capture the account in `loadMessages` and when a message is
   opened; drop the leaving-folder clear), `src/components/Settings.svelte` (call
   `clearAccountCache` after a removal). Source-level guard test in
   `src/__tests__/offlineCacheWiring.test.ts`.
4. Separate commit: `resolveAccount` answers "no account" for an unknown `?account=`
   (`server/lib/state.js`, tests in `server/lib/state.test.js` and `server/idle.test.js`),
   and `MailAPI.idle()` joins its query with `?` or `&`.
5. Verify: `npx vitest run`, the server tests, `npm run typecheck`, `npm run build`,
   `npm run check:redos`; ROADMAP.md entry with counts.
