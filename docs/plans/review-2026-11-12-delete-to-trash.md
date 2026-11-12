# Plan: Delete moves to Trash (review 2026-11-12)

Design: `docs/design/review-2026-11-12-delete-to-trash.md`.

1. Baseline (done): `npm run typecheck` clean, `npx vitest run` 119 pass,
   `npm run test:server` 131 pass, `npm run build` clean.
2. RED: add `server/removal.test.js` (route-level, fake ImapFlow client). Run it
   against the current `mail.js`; the behaviour tests must fail.
   Verify: `node --test server/removal.test.js`.
3. GREEN: add `server/lib/removal.js` (`MailActionError`, `findTrashPath`,
   `moveChecked`, `removeMessage`); in `server/routes/mail.js` use it from
   `DELETE /message/:id` and `POST /message/:id/move`, validate the UID, and
   return failures as values from `pool.run`.
   Verify: `node --test server/removal.test.js`, then `npm run test:server`
   (route snapshot must be unchanged).
4. Docs: CHANGELOG entry, ROADMAP entry with evidence and "Still open".
5. Independent review of the diff (judge), fix Critical/High.
6. Final: `npm run typecheck && npx vitest run && npm run test:server &&
   npm run build`; rebase on origin/main; push.
