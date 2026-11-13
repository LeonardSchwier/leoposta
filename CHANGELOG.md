# Changelog

All notable changes. No tagged release has been published yet.

## Unreleased

### Fixed
- Delete destroyed mail: the Delete button sent `DELETE /api/message/:id` without `toTrash`, and the server then expunged the message, in every folder, with no way back. It now moves the message to the server's Trash (the mailbox flagged `\Trash`, else one called `Trash`, created if the server has none) and removes it for good only when the selected mailbox is that Trash (compared by the server's full path, so a namespace prefix such as `INBOX.Trash` is handled). A failed move or delete (ImapFlow answers `false` instead of throwing) is now a 500 the UI shows, not a silent success that dropped a message the server still had, and a refusal no longer logs the shared IMAP connection out. `toTrash` is ignored (`?toTrash=false` was the truthy string `"false"`). A message id that is not a positive integer is a 400.
- Archive and other moves (`POST /api/message/:id/move`) used ImapFlow's `messageMove`, which on a server without the MOVE extension copies and then expunges even when the copy failed. Moves now copy, check, and only then remove the original.
- `GET /api/idle` leaked a logged-in IMAP session, its mailbox lock and a heartbeat timer whenever the browser dropped the stream while the server was still connecting (every change of inbox-sync mode or active account restarts the stream); the close handler was only registered after the connect. It is now registered first and aborts the pending connect. A failed connect also logs out its half-open client.
- `GET /api/idle` wrote `Access-Control-Allow-Origin: *`, replacing the origin-specific answer of the CORS middleware; the header is gone.
- A request from a disallowed origin or with malformed JSON got Express's HTML stack-trace page (local file paths). Errors are now JSON: 403 `origin_not_allowed`, 400 `invalid_json`, 404 `not_found`, other 4xx `bad_request`, and a generic 500 `internal_error`; 413 `too_large` is unchanged.
- `npm run test:server` ran a single trivial test on Node 22 (`node --test server`), so CI skipped every server test; it now runs all of them (131 with the 2026-11-11 additions).
- A scheduled message whose SMTP send took longer than the 30 s scheduler tick was sent again on every tick until the first send finished; in-flight messages are now skipped.
- `GET /api/status` listed the configured mailbox addresses without the API token; it now requires the token (`/api/health` stays open).
- `openpgp` is imported by the backend but was a dev dependency, so a production install (`npm ci --omit=dev`) crashed at start; it is now a runtime dependency.
- Message dates came from a non-existent field and always showed the current time; they now use the envelope or internal date.
- CI: the route snapshot test no longer depends on whether `dist/` was built; typecheck and end-to-end tests match the current UI.

### Security
- `POST /api/pgp/unlock` locks for the rest of a 60 s window after 5 wrong passphrases (429 `too_many_attempts` with `Retry-After`); the attempt is counted before the decrypt, so concurrent guesses cannot all slip through.
- Upgraded `nodemailer` to 10.4.0 and `vitest` to 5.1.0 to clear audit findings.

### Added
- Import mail (IMAP/SMTP) and WebDAV (calendar/contacts) accounts from GNOME Online Accounts: a "Import from GNOME Online Accounts" box in Settings, hidden when unavailable. Linux + native (non-container) only. See [docs/design/goa-import.md](docs/design/goa-import.md).

### Fixed
- `updateAccount` (`PUT /api/accounts/:email`, and `POST /api/account` on an existing email) silently blanked any field a partial request body didn't mention — found by the GOA import above, which updates an existing account with DAV-only or mail-only fields. Omitted fields now keep their current value; a field sent explicitly (including `''`/`false`, to clear it) still overrides.

### Added
- Container image (`Dockerfile`, multi-arch CI workflow, release tarballs), smoke test script, `ARCHITECTURE.md`, `docs/` index, decision records, glossary, `.editorconfig`, `npm run setup` and `npm run check`.
- `npm run typecheck`, `npm run screenshots`, README screenshots (light and dark), `SECURITY.md`, `CONTRIBUTING.md`, issue and pull request templates, monthly Dependabot, pinned workflow actions.

### Earlier
- Multi-account support, signature, attachments on compose, offline cache and queue, filter rules, virtualised list, Leoforma design tokens, local API token, sanitised mail HTML, CI and end-to-end tests.
