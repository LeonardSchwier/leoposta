# Plan: keep the offline body across a list refresh, and list offline mail newest first (2026-11-18, second run)

Design: `docs/design/review-2026-11-18-offline-body-and-order.md`.

1. RED: extend `src/__tests__/offlineCache.test.ts` (fake-indexeddb): a full entry survives
   `cacheFolderList` with its body, html, attachments and headers and takes the row's flags,
   subject and date; a full entry whose id left the list is still pruned; a full entry of
   another account or folder is untouched; a list row replaces a list row as before; a stored
   full entry with a broken `message` does not throw; the offline list is newest first across
   a digit boundary (98 to 102), ignores `fetchedAt`, puts an unparsable date last, and keeps a
   message opened later in its place. Run `npx vitest run src/__tests__/offlineCache.test.ts`
   (the new tests fail).
2. GREEN: `src/lib/offlineQueue.ts`, `cacheFolderList` (merge in the transaction) and
   `cachedMessagesForFolder` (sort).
3. Mutation checks: drop the merge, spread the row over the stored message, keep a stale
   full entry, sort on `fetchedAt` again: each fails a test.
4. Verify: `npx vitest run`, the server tests, `npm run typecheck`, `npm run build`,
   `npm run check:redos`; independent review of the diff; ROADMAP.md entry with counts.
5. Review rework (the independent review of step 4 found two defects in the first merge):
   the stored `attachments` and `bcc` must win over the row's (the row's attachments have no
   `id`; its `bcc` lacks the envelope fallback), and the merge needs the sender and date guard
   against a renumbered folder. RED first: the fixtures use the real shapes, plus a guard
   test; then change `mergeStoredFull`; rerun the mutation checks (now also: attachments or
   bcc from the row, no guard, body not restored, UID compared as text, no non-object
   filter) and the full verification of step 4.
