# Changelog

All notable changes. No tagged release has been published yet.

## Unreleased

### Fixed
- `npm run test:server` ran a single trivial test on Node 22 (`node --test server`), so CI skipped every server test; it now runs all of them (114).
- A scheduled message whose SMTP send took longer than the 30 s scheduler tick was sent again on every tick until the first send finished; in-flight messages are now skipped.
- `GET /api/status` listed the configured mailbox addresses without the API token; it now requires the token (`/api/health` stays open).
- `openpgp` is imported by the backend but was a dev dependency, so a production install (`npm ci --omit=dev`) crashed at start; it is now a runtime dependency.
- Message dates came from a non-existent field and always showed the current time; they now use the envelope or internal date.
- CI: the route snapshot test no longer depends on whether `dist/` was built; typecheck and end-to-end tests match the current UI.

### Security
- Upgraded `nodemailer` to 10.4.0 and `vitest` to 5.1.0 to clear audit findings.

### Added
- Container image (`Dockerfile`, multi-arch CI workflow, release tarballs), smoke test script, `ARCHITECTURE.md`, `docs/` index, decision records, glossary, `.editorconfig`, `npm run setup` and `npm run check`.
- `npm run typecheck`, `npm run screenshots`, README screenshots (light and dark), `SECURITY.md`, `CONTRIBUTING.md`, issue and pull request templates, monthly Dependabot, pinned workflow actions.

### Earlier
- Multi-account support, signature, attachments on compose, offline cache and queue, filter rules, virtualised list, Leoforma design tokens, local API token, sanitised mail HTML, CI and end-to-end tests.
