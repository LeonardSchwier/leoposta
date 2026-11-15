---
name: verification
description: Which checks to run for which change, and the pre-push gate. Read before every push.
---

# Verification and the pre-push gate

Leoposta is a mail client. Its bugs live where the app meets a real mail
server, a real browser engine and a real user. Unit tests with mocks do not
reach those places. So **every change that touches something a user can
reach is verified end to end against the real stack** before it is pushed.

## The checks

| Command | What it proves | Time |
|---|---|---|
| `npm run typecheck` | `tsc` **and** `svelte-check` (0 errors). `tsc` alone does not read `.svelte` files. | ~30 s |
| `npm test` | Vitest: frontend logic and mounted components | ~10 s |
| `npm run test:server` | `node --test`: routes and libs against fakes | ~20 s |
| `npm run test:e2e:real` | Playwright: the real UI against a real Dovecot (IMAP), Radicale (CalDAV/CardDAV) and SMTP sink, in two IMAP layouts (`/` and `INBOX.`+`.`), as the PWA build **and** the desktop build | ~3–6 min |
| `tests/desktop/run-desktop-smoke.sh` | The bundled desktop backend in **WebKitGTK** (the engine the Tauri app really uses) mounts the app, loads folders and opens a message | ~1–2 min |

The stack needs `podman` or `docker`. `tests/stack/stack.sh up|down` starts or
stops it by hand; `KEEP_STACK=1` keeps it after a run; `E2E_STACK_ID=<n>` gives
parallel checkouts their own ports and containers.

## Which checks apply

| You changed | Run |
|---|---|
| Anything in `src/` or `server/` | all of: typecheck, `npm test`, `test:server`, `test:e2e:real` |
| `src-tauri/`, `scripts/bundle-backend.sh`, `vite.config.ts`, CORS / token / headers / CSP | the above **plus** the desktop smoke |
| Docs only | nothing, but do not claim behaviour you did not run |

## The gate (every push, no exceptions)

1. Run every applicable command above, in this session, on the exact tree
   you are about to push.
2. Read the real output. A command you did not run is not evidence.
3. If anything is red, fix the real cause and go back to step 1.
4. Push only when everything applicable is green. Name the commands and
   their pass counts in the PR description.

## Never

- Never write "works", "fixed" or "already handles" in a commit or PR unless
  you ran that exact case in this session and watched it pass.
- Never weaken, skip or `.only` a test to get green. Never widen
  `allowApiErrors` in an e2e test to hide an error the user would see.
- Never add `@ts-ignore`, `as any` or `// eslint-disable` to silence a check.
- Never push a second guess at a CI failure without quoting the failing
  job's real error first.

## Incidents this gate exists for (2026-11-13)

All of these shipped with green unit tests and were found by the owner:

- **Blank white desktop window.** The backend's CORS allowlist rejected the
  app's own `crossorigin` script on the desktop's random port. Only visible in
  WebKitGTK. Now caught by the desktop smoke.
- **"Cannot destructure property 'to' of req.body" on Send.** A header merge
  sent `Content-Type: application/json, application/json`. Unit tests mocked
  `fetch`; nothing sent a real request. Now caught by the e2e page guard
  (any failed `/api/` call fails the test).
- **Save Draft did nothing.** The button only closed the window; no route
  existed. No test ever checked the Drafts folder on a server.
- **"Command failed" on folder click.** Folder names were not URL-encoded; a
  `#` cut the query, the server sent `SELECT ""`. The fake IMAP server
  accepted it; real Dovecot does not.
- **Subfolders never expanded; the column divider stuck to the mouse.** A
  Svelte 5 reactivity bug and an assignment to an undeclared variable —
  `svelte-check` reported both, but `typecheck` did not run it.
