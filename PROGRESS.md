# PROGRESS — leoposta open-todos batch

## Goal
Work through remaining open ROADMAP items independently, commit + push each, until done or blocked.

## Done (this batch)
- (none yet)

## Active
- C6 — Split server/index.js (1425 lines) → modules under `server/lib/`
  - Snapshot test first: capture HTTP behavior via `node:test` harness (A1 already added createApp)
  - Target: index.js under ~200 lines (wiring only)

## Blocked
- (none)

## Remaining backlog (in order)
1. C6 — split server/index.js  [ACTIVE]
2. C4 — Playwright E2E tests
3. Attachments on compose
4. Email signature
5. D1 — Leoforma tokens
6. Filter / rules
7. Attach on inbound (if missing)
8. Virtualised list
9. i18n
10. Offline mail cache
11. Multi-account
12. Mobile / touch refinements

## Context
- Repo: /home/leonard/opencode/leoposta
- Remotes: `github` (https://github.com/LeonardSchwier/leoposta.git)
- Parallel session is active — rebase/reset to `github/main` before each commit
- Node v22, `node:test` available, A1 already exported `createApp()`
- 32/32 vitest passing as of 5b3019a
- Commit style: `type(scope): summary (item)` with Accept: line
- Push after each verified commit
