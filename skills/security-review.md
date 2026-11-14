---
name: security-review
description: When and how to run the security-audit skill and the security scanners, and what to do with findings. Read before changing a trust boundary and before every release.
---

# Security review

Leoposta reads untrusted mail, holds mail passwords and serves a local REST
API. A small mistake at one of those places is a stolen password or a read
mailbox. So security review is part of the normal workflow, not an event.

The audit tool is Cloudflare's `security-audit` skill, installed at
`~/.config/opencode/skills/security-audit/` (read its `SKILL.md`). Run output
goes to `~/security-audit-skill/leoposta/run-<N>/`; never commit it.

## Trust boundaries

A change "touches a trust boundary" if it changes any of these:

- HTML mail rendering: `src/lib/sanitizeHtml.ts`, `MessageView.svelte`
  (DOMPurify config, remote images, CID images, link clicks, CSS), PGP output.
- The local server's browser boundary: token auth, CORS / `ALLOWED_ORIGINS`,
  the Host check (DNS rebinding), CSP (`server/lib/csp.js`), static serving.
- Credentials: account files and the data dir (file modes), anything that
  logs, returns or sends a password or token; TLS/STARTTLS settings.
- The desktop shell `src-tauri/`: token injection, navigation and new-window
  handlers, the port check, `tauri.conf.json` CSP and capabilities.
- Outbound protocols: SMTP headers (CRLF), IMAP folder names, DAV URLs and
  the GOA import, attachment names and download paths.
- Resource limits: body sizes, attachment sizes, decompression (PGP).
- Supply chain: `package-lock.json`, `src-tauri/Cargo.lock`, CI workflows,
  `scripts/bundle-backend.sh` (what gets shipped).

## When

| Event | What to run | Record |
|---|---|---|
| Any change that touches a trust boundary | The skill in **guidance mode** on the changed files (e.g. "review the HTML rendering for XSS", "audit the REST endpoints") | Findings and verdicts in the PR description |
| Before every release, and at least monthly | The skill in **full audit mode** on the release commit | New `run-<N>`; re-check every open item of run-<N-1> |
| Every push / PR (CI) | `.github/workflows/security.yml` | Green check |

## Findings

- `confirmed` or `plausible` with a concrete impact: **fix it immediately**,
  smallest effective fix, with a regression test that fails without the fix
  (vitest in `src/__tests__`, `node --test` in `server/*.test.js`, `cargo test`
  in `src-tauri`, and a real-stack e2e in `tests/e2e-real/security-*.spec.ts`
  if a user can see it). Name the class and the finding fingerprint in the
  commit (`fix(security): ...`, `Audit run-N: <fingerprint>`).
- If it cannot be fixed now: add a ROADMAP bug with the fingerprint, the
  impact and the plan. Never leave a finding only in the run directory.
- Record the fix commit per finding in `run-<N>/FIXES.md`.
- Validate the artifacts:
  `node ~/.config/opencode/skills/security-audit/validate-findings.cjs run-<N>/findings.json`
  and `node ~/.config/opencode/skills/security-audit/validate-coverage-ledger.cjs run-<N>/coverage-ledger.json`.
- Follow the skill's execution-safety rules. Never probe the live server,
  the installed app or real mail accounts; demonstrate on the e2e stack
  (`tests/stack/`) instead.

## Scanners (same as CI)

Run locally from the repo root before pushing a trust-boundary change.

```sh
npm audit --omit=dev --audit-level=high

# Secrets in the full history (verified false positives: .gitleaksignore, with a reason)
podman run --rm -v "$PWD:/repo:ro,Z" \
  docker.io/zricethezav/gitleaks@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f \
  git /repo --redact --no-banner --exit-code 1 --gitleaks-ignore-path /repo/.gitleaksignore

# Static analysis (suppress a verified false positive inline with
# `// nosemgrep: <rule-id> -- <reason>`, never by excluding a file)
podman run --rm -v "$PWD:/src:ro,Z" -w /src \
  docker.io/semgrep/semgrep@sha256:67518c174185a2043fdbed16c70631b79209499b3671178e7194379b48295a0d \
  semgrep scan --error --metrics=off \
  --config p/javascript --config p/typescript --config p/nodejs --config p/secrets

# Rust dependencies of the desktop shell
(cd src-tauri && cargo audit)
```

gitleaks needs a full git checkout (in a linked worktree, scan a
`git clone` of the branch). CodeQL (javascript-typescript) runs in CI only.
A red scanner is a finding: fix it or document a verified false positive.
