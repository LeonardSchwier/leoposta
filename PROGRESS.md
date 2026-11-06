# PROGRESS — leoposta
task: P0 email signature (superpowers pipeline)
updated: 2026-11-06

## Done
- 4 security fixes from audit run-1 (server/index.js:43 mode:0o600, :16 CORS
  allowlist, MessageView.svelte URI-scheme forbid + rel=noopener hook,
  :1226 outbound scrub + sendScheduledMessage scrub). `node --check` OK.
- Security-audit run-1 artifacts at `~/security-audit-skill/leoposta/run-1/`
  (findings.json PASS: 6, REPORT.md).
- Brainstorming complete; spec written and approved:
  `docs/superpowers/specs/2026-11-06-email-signature-design.md`
  (per-account `signature:{enabled,text,position:'standard'|'after_quote'}`,
  backend-persisted on account via existing GET/POST /api/account,
  Settings tab, compose + reply/forward seeding, plain text only).

## Blocked
- (none)

## Next (in order)
1. git baseline check (status, tests green) in /home/leonard/opencode/leoposta.
2. `using-git-worktrees` skill → feature branch.
3. Baseline: `npm test` + `npm run build` (record failures if any), then
   `writing-plans` skill → `docs/plans/email-signature.md` with TDD tasks.
4. Execute plan (TDD RED→GREEN→REFACTOR): store shape + normalizeAccount,
   buildMessageBody pure fn + tests, Compose seeding, Settings tab,
   backend account.json read/write extension.
5. `requesting-code-review` → `finishing-a-development-branch` →
   flip ROADMAP P0 signature checkbox to [x].
6. THEN (new session): multi-account P0 — same pipeline.

## Context
- Repo `/home/leonard/opencode/leoposta`. NOT a git repo? — check `git status`.
- AGENTS.md mandates the full superpowers pipeline for every ROADMAP item;
  no skipping.
- `server/account.json.REAL.bak` at `/tmp/opencode/` — do NOT lose; current
  `server/account.json` may be a dummy. Restore before push.
- Baseline commands: `npm test` (vitest, 1 test: src/__tests__/store.test.ts),
  `npm run build` (tsc). No lint script.
- Vite dev port 3000. Backend `server/index.js` ~1413 lines, single-account.
- Design doc is the source of truth for shape/behaviour right now.
