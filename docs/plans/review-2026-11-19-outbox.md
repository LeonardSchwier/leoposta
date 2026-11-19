# Plan: outbox visibility, start-up flush, discard (review 2026-11-19)

Design: `docs/design/review-2026-11-19-outbox.md`. Baseline on main 911bce2: `npx vitest run`
417 pass (54 files), `node --test` over every server test file except `starttls.test.js`
425 pass, `npm run typecheck` 0 errors, `npm run build` clean.

Each task is RED (test fails for the stated reason) then GREEN, then the verification command.

1. `src/__tests__/offlineOutbox.test.ts` (node): failed flush records `lastError` /
   `lastAttemptAt` (server error text, `HTTP 502` with a non-JSON body, network failure);
   success leaves nothing; `discardQueuedMessage` removes the record and fires
   `QUEUE_CHANGED`; a message discarded while an earlier one is being sent is not sent; a
   failure write never resurrects a discarded message. Then `src/lib/offlineQueue.ts`.
   Verify: `npx vitest run src/__tests__/offlineOutbox.test.ts`.
2. `src/__tests__/outbox.test.ts` (jsdom mount): `Outbox.svelte` lists subject, recipients,
   account and error; Discard asks first, removes and updates; Retry now flushes and is
   disabled offline; Escape and Close call `onClose`; focus moves in. Then the component.
3. `src/__tests__/outboxWiring.test.ts` (jsdom, App mount): online start with a queued
   message sends it once; a refused one shows the "unsent" badge online, opens the panel;
   the offline badge text is unchanged; `handleOnline` and the start-up drain do not both
   toast. Then `App.svelte`.
4. `src/__tests__/virtualList.test.ts`: a scroll position past the end still renders the
   last rows. Then `src/lib/virtualList.ts`. Separate commit.
5. Judge review of the diff; fix Critical/High; `ROADMAP.md` entry with the counts.
   Verify: `npx vitest run`, `node --test` server set, `npm run typecheck`, `npm run build`,
   `npm run check:redos`.
