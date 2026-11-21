# Plan: a damaged state file must not stop the server, and a save must not be able to damage one

Design: `docs/design/review-2026-11-21-state-files.md`. Baseline (main dce6928, Node 22.23.5):
`npx vitest run` 458 pass (56 files); `node --test` over every server test file except
`server/starttls.test.js` (it hangs in this sandbox, unrelated) 457 pass; `npm run typecheck`
0 errors (3 warnings); `npm run build` clean (there is no `lint` script).

1. Tests first (RED): `server/lib/jsonFile.test.js` (atomic write, failure half way, symlinks,
   set-aside of a damaged file, no text of the file in the log) and `server/stateFiles.test.js` (boot
   `state.js` in a child process against damaged, empty and wrong-shape `accounts.json`,
   `scheduled.json`, `rules.json`, a damaged legacy `account.json`; a failing save leaves each of the
   five files whole). Run them: `jsonFile.js` does not exist, 15 of 23 `stateFiles` tests fail.
2. `server/lib/jsonFile.js`: `writeFileAtomic`, `readJsonFile`.
3. `server/lib/state.js`: use them for the four loads and the five saves.
4. Mutation checks (each killed by a test): direct write instead of temp and rename, temp file not
   removed on failure, link not followed, the file's text in the log, shape ignored, every read
   error swallowed, delete instead of set aside, a same-second name reused, a short write not
   looped, no byte order mark handling, each saver and the rules load put back to the old call.
5. After two independent reviews (opus, sonnet; no Critical): quarantined and temp files git- and
   docker-ignored and mentioned in the README; `rules.json` only has to be a list; a temp file is
   removed first and created exclusively with an exact mode; stale temp files of dead processes swept
   at start; a link that points nowhere is followed, and a damaged file behind a link is set aside
   where it lives; a damaged `accounts.json` no longer falls through to an old `account.json`; a
   `rule-cursors.json` that is not an object is ignored; where a temp file cannot be created or
   renamed (bind-mounted single file, read-only directory) the file is written in place as before;
   an `fsync` the file system rejects is tolerated; a write that makes no progress throws. Each has
   a test, and mutations of them are killed too.
6. Whole suite: `npx vitest run`, `node --test` (server set), `npm run typecheck`, `npm run build`,
   `npm run check:redos`. `npm run test:e2e:real` and the desktop smoke cannot run here (no container
   runtime, no WebKitGTK).
7. `ROADMAP.md`, `CHANGELOG.md`; rebase on origin/main, re-run, push.
