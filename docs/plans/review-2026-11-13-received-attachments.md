# Plan: review-2026-11-13 received attachments

Design: `docs/design/review-2026-11-13-received-attachments.md`. Baseline
(2026-11-13, Node 22.23.4): `npx vitest run` 119 pass (18 files),
`npm run test:server` 150 pass, `npm run typecheck` and `npm run build` clean.
There is no `lint` script.

Each task is test first: write the test, run it, watch it fail, then write the
minimum code.

1. `server/lib/attachments.test.js` then `server/lib/attachments.js`:
   `listAttachments`, `attachmentAt`, `bodyStructureAttachments`,
   `contentDispositionHeader`, `safeContentType`, `parseMessageSource`.
   Verify: `node --test server/lib/attachments.test.js`.
2. `server/mailroutes.test.js` (fake ImapFlow client) then `server/routes/mail.js`: new download
   route, message route and list route use the helpers; PGP attachments have no
   id. Verify: `node --test server/mailroutes.test.js`.
3. `server/server.test.js` + `server/lib/auth.js`: `?token=` only for `/api/idle`.
   Verify: `node --test server/server.test.js`.
4. `src/__tests__/attachmentDownload.test.ts` then `src/lib/attachmentDownload.ts`,
   `src/api/index.ts` (`MailAPI.attachment`, drop `attachmentUrl`),
   `src/store/index.ts` (`Attachment.id` optional), `MessageView.svelte`.
   Verify: `npx vitest run src/__tests__/attachmentDownload.test.ts`.
5. Full gate: `npx vitest run`, `npm run test:server`, `npm run typecheck`,
   `npm run build`. Then each new behaviour test is run against the old code
   (stash the source change) to confirm it fails there.
6. Independent review of the diff (two judges), fix Critical/High, update
   `ROADMAP.md` with the evidence, push to main.
