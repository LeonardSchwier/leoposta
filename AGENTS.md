# Leoposta — web/desktop mail client with a clean, native-mail UX

## Mission
Build a complete, standalone web-based mail client with a clean, familiar
native-mail UX.
It must work offline (PWA), support IMAP/SMTP, and include all mail features.

## Quality gates (mandatory for every change — bug fix, feature, refactor)
The owner must never find a bug that a test could have found. These apply to
**every** change, including "small" fixes and changes outside ROADMAP.md, and
take precedence over speed:

1. **Real-stack end-to-end first.** Any change to a user-reachable path gets a
   Playwright journey in `tests/e2e-real/` that drives the real UI against a
   real Dovecot/Radicale/SMTP stack and asserts the result on the server too
   (did the mail arrive, is the draft in Drafts, did the message move).
   Mocked-fetch unit tests alone are never enough for these paths.
2. **Every bug fix ships a regression test that fails without the fix** —
   the e2e journey plus a narrow unit/server test where the cause lives.
   Follow [`skills/bug-fixing.md`](skills/bug-fixing.md): reproduce, root
   cause with file:line, fix the class (search for siblings), not the line.
3. **Pre-push gate:** read [`skills/verification.md`](skills/verification.md)
   before every push and run every applicable check in that session on that
   tree: `npm run typecheck` (tsc + svelte-check, 0 errors), `npm test`,
   `npm run test:server`, `npm run test:e2e:real`, and for desktop/packaging/
   CORS/token/header changes `tests/desktop/run-desktop-smoke.sh` (WebKitGTK).
   Name the commands and pass counts in the PR. Never claim "works" for a case
   you did not run.
4. **Never** weaken, skip or delete a failing test, widen `allowApiErrors` to
   hide an error a user would see, or silence a checker (`@ts-ignore`,
   `as any`). A red check is a bug report.
5. **No inert UI.** A button, menu item or setting that is visible must work
   end to end (tonight's incidents: "Save Draft" only closed the window;
   folder Rename/Delete were never wired). If it can't work yet, don't show it.
6. **Answer the crash-freedom questions** in `skills/bug-fixing.md` for every
   change (errors handled and shown, boundary inputs, lifecycle/teardown,
   double clicks and races, WebKitGTK as well as Chromium, partial failure).
7. CI (`.github/workflows/ci.yml`) runs all of the above; the nightly
   `scripts/auto-update.sh` runs them again before it deploys and keeps the
   current version if anything fails.

## Roadmap (source of truth for open work)
**Open features and their status: see [`ROADMAP.md`](./ROADMAP.md).**
Update it every time a P0/P1 item lands or a new item enters the backlog;
this file describes _how_ we build, `ROADMAP.md` describes _what_ is left
to build. Before starting any feature, check `ROADMAP.md` and move the
checkbox when done.

## Mandatory workflow for any ROADMAP.md item
This repo follows the **superpowers** methodology
(https://github.com/obra/superpowers). Superpowers is installed as an
opencode plugin under the V1 `plugin` key in
`~/.config/opencode/opencode.jsonc` (`superpowers@git+https://github.com/obra/superpowers.git`).
For every item picked up from `ROADMAP.md`, run the full pipeline —
no skipping, no "this is small" exceptions:

1. **brainstorming** — load the skill. Interview the user on intent and
   constraints until the spec is digestible in small chunks. Tiny items:
   agree the spec in chat. Anything bigger: write it to
   `docs/design/<slug>.md`.
2. **using-git-worktrees** — load the skill. Create the worktree + branch
   on top of a clean baseline. Confirm `npm run lint` and
   `npm run test` (or `npm test` / `node --test server`) pass before any
   code is written; record the failing-state baseline.
3. **writing-plans** — load the skill. Produce
   `docs/plans/<slug>.md` with 2–5 minute tasks, each carrying exact file
   paths, full diffs/snippets, and a verification command. No task may rely
   on the implementer's guess.
4. **executing-plans** _or_ **subagent-driven-development** — load one.
   Prefer subagent-driven-development for `server/index.js` and
   cross-cutting refactor work; use executing-plans for small, contained
   tasks. Either way, do **not** drift from the plan; if a task needs to
   change, update the plan file first and re-approve.
5. **test-driven-development** — load every time code is being written.
   RED (write the failing test, run it, watch it fail) → GREEN (minimal
   code that passes) → REFACTOR. Delete any code written before its test.
   If the project has no test for the area you're touching, the first task
   in the plan is "add the test harness / first test for X" — not
   "implement X".
6. **requesting-code-review** — load before marking a task done. Review
   the diff against the plan and the design doc; report findings by
   severity; Critical blocks.
7. **finishing-a-development-branch** — load when the last task is green.
   Verify tests + lint, present merge/PR/keep/discard options, then
   cleanup. Only then move the checkbox in `ROADMAP.md` to `[x]` and
   update `PROGRESS.md`.

Skill triggers are mandatory, not suggestions. If a skill is not yet
loaded in the session, invoke it before the corresponding step. If the
plugin is missing or skills fail to trigger, stop and tell the user
instead of falling back to ad-hoc work.

Local state lives in `PROGRESS.md` (per repo root, written by the
`context-budget` skill) **and** `docs/plans/<slug>.md` + the per-task
checklist. Delete `PROGRESS.md` when the task is fully merged; keep it
only when deliberately paused/blocked.
Currently open (P0): see the "Now" section of `ROADMAP.md` for the live
list. (Multi-account support and email signature are both shipped —
`[x]` in `ROADMAP.md`.)

## Tech Stack
- **Frontend:** Svelte 5 + TypeScript (or React 18 + TypeScript — your choice)
- **Styling:** Tailwind CSS v4 (clean, minimal, system-sans font stack)
- **State:** Zustand (or Redux Toolkit)
- **IMAP:** imapflow (Node.js IMAP client) running as a backend service
- **SMTP:** nodemailer for sending
- **Offline:** Service Worker + IndexedDB for offline reading
- **Scheduled Send:** Server-side cron + local notification
- **PWA:** vite-plugin-pwa for installable standalone app
- **Build:** Vite 6
- **Testing:** Vitest + Playwright (E2E)

## Native-mail UX Requirements
- **Sidebar:** Clean folder list with icons, collapsible, subtle hover states
- **Message List:** Two-column (list + preview), smooth animations, swipe actions
- **Compose:** Clean modal/sheet, rich text editor (contenteditable or ProseMirror)
- **Search:** Command palette (Cmd+K) for searching mail, folders, contacts
- **Dark Mode:** System-aware dark palette
- **Typography:** -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif
- **Animations:** 200ms ease-in-out transitions, no jarring jumps
- **Touch:** Swipe to archive/delete, long-press for context menu
- **Keyboard:** Full keyboard navigation, standard mail-client shortcuts

## Feature Checklist (COMPLETE — build ALL)
### Core
- [ ] IMAP account setup wizard (server, port, TLS, username, password)
- [ ] Multi-account support
- [ ] Folder tree (INBOX, Sent, Drafts, Trash, Spam + custom)
- [ ] Message list with sender, subject, preview, date, unread indicator
- [ ] Message reading pane with HTML rendering (sanitized)
- [ ] Inline images (CID)
- [ ] Attachments: download, preview (PDF, images), file manager
- [ ] Reply, Reply All, Forward with proper threading
- [ ] Thread view (grouped by conversation)
- [ ] Compose: rich text, CC/BCC, priority, scheduled send
- [ ] Send immediately or schedule (pick date/time)
- [ ] Save to Drafts
- [ ] Archive, Delete, Move to folder
- [ ] Mark as Read/Unread, Star/Favorite
- [ ] Search (subject, from, to, body, date range)
- [ ] Filters/Rules (auto-move, auto-label)
- [ ] Labels/Tags (multi-label per message)
- [ ] Contact extraction from mail, address book
- [ ] Autocomplete for To/CC/BCC from contacts
- [ ] Signature support
- [ ] Keyboard shortcuts (standard mail-client style)

### Offline (PWA)
- [ ] Service Worker with precaching
- [ ] IndexedDB local cache of recent messages
- [ ] Offline reading (last N messages per folder)
- [ ] Offline compose (queue for send when online)
- [ ] Sync on reconnect (IMAP IDLE → fetch new)
- [ ] Install prompt, standalone mode, app icon

### UX Polish
- [ ] Dark mode (system + manual toggle)
- [ ] Responsive (mobile, tablet, desktop)
- [ ] Smooth animations (Framer Motion or CSS)
- [ ] Context menus (right-click)
- [ ] Command palette (Cmd+K)
- [ ] Empty states with illustrations
- [ ] Loading skeletons
- [ ] Error toasts (non-blocking)
- [ ] Settings page (account management, appearance, shortcuts)

### Security
- [ ] Password stored in browser (WebCrypto or keytar)
- [ ] TLS enforced (no plaintext)
- [ ] XSS sanitization of HTML mail
- [ ] CSRF protection on API endpoints
- [ ] No third-party trackers, no external fonts (system font stack)

## Security audits (`security-audit` skill)
Leoposta is a mail client: HTML body rendering, IMAP/SMTP credentials on the
backend, and a REST API are the three trust boundaries to defend.

**When to run it, what to do with findings and the scanner commands:
[`skills/security-review.md`](skills/security-review.md).** CI runs the
scanners in `.github/workflows/security.yml`.

- Skill installed at `~/.config/opencode/skills/security-audit/` (Cloudflare
  `security-audit-skill`, MIT). It is an OpenCode agent skill — run it from
  the agent, not from the app; it is not a runtime dependency.
- **Trigger phrases** for guidance mode: "review the HTML rendering for XSS",
  "check the SMTP credential handling", "audit the REST endpoints".
- **Trigger phrases** for full audit mode: "security audit leoposta",
  "pen-test `./server`", "find vulnerabilities in `src/components/Message.svelte`".
- Output directory for leoposta runs: `~/security-audit-skill/leoposta/run-<N>`
  (skill default). Never commit the run output to the repo.
- The skill's two zero-dependency validators ship with it:
  `node ~/.config/opencode/skills/security-audit/validate-findings.cjs findings.json`
  and `node ~/.config/opencode/skills/security-audit/validate-coverage-ledger.cjs coverage-ledger.json` —
  run them after Phases 1 and 4 to keep the artifacts schema-clean.
- Sandboxing: this machine has no `doas`/`landlock`/firejail preinstalled.
  Until one is added, the skill's `needs_validation` verdict is the floor —
  do **not** execute candidate payloads against the running backend;
  read the code and stop.

## Architecture
```
evolution-mail/
├── src/
│   ├── app/              # Svelte/React app
│   │   ├── components/   # UI components
│   │   ├── pages/        # Routes
│   │   ├── stores/       # State management
│   │   ├── services/     # API clients
│   │   ├── workers/      # Service worker
│   │   └── utils/        # Helpers
│   ├── server/           # Node.js backend
│   │   ├── imap/         # IMAP client wrapper
│   │   ├── smtp/         # SMTP sending
│   │   ├── api/          # REST API routes
│   │   ├── scheduler/    # Scheduled send
│   │   └── storage/      # Account config storage
│   └── shared/           # Types, constants
├── public/
│   ├── icons/            # PWA icons
│   └── sw.js             # Service worker (if not generated)
├── tests/
│   ├── unit/
│   └── e2e/
├── package.json
├── vite.config.ts
├── svelte.config.js
└── README.md
```

## API Design
REST API served by the Node.js backend:
- `POST /api/accounts` — Create IMAP account
- `GET /api/folders` — List folders
- `GET /api/messages?folder=INBOX&limit=50&offset=0` — List messages
- `GET /api/messages/:id` — Get message
- `POST /api/messages/:id/reply` — Reply
- `POST /api/messages/:id/forward` — Forward
- `POST /api/messages` — Send (compose)
- `POST /api/messages/:id/move` — Move to folder
- `POST /api/messages/:id/star` — Toggle star
- `POST /api/search?q=...` — Search
- `GET /api/contacts` — List contacts
- `POST /api/scheduled` — List scheduled sends
- `DELETE /api/accounts/:id` — Remove account

## Build Commands
```bash
npm install
npm run dev            # Dev server (frontend + backend)
npm run build          # Production build
npm run typecheck      # tsc (app + node) and svelte-check — 0 errors required
npm test               # Vitest unit/component tests
npm run test:server    # node --test server tests
npm run test:e2e:real  # Playwright vs real Dovecot/Radicale/SMTP (podman/docker)
npm run test:e2e       # legacy fast e2e against the fake IMAP server
tests/desktop/run-desktop-smoke.sh   # WebKitGTK smoke of the desktop bundle
```

## Testing
See [`skills/verification.md`](skills/verification.md) for which checks apply
to which change and the pre-push gate.
- Unit: Vitest for logic and mounted components (`src/__tests__`)
- Server: `node --test` for routes and libs (`server/*.test.js`)
- **E2E (primary):** `tests/e2e-real/` — real UI, real mail servers, both IMAP
  layouts, PWA and desktop builds; the page guard fails a test on any console
  error or failed API call
- Desktop: `tests/desktop/` — WebKitGTK, the engine the Tauri app uses

## Important
- This is a STANDALONE app — no external dependencies except npm
- Offline-first: app must be fully usable without network (for reading cached mail)
- Native-mail UX: clean, minimal, fast, intuitive
- Security: no plaintext passwords, TLS everywhere, sanitized HTML
- Performance: virtualized list for large inboxes, lazy loading
- Accessibility: ARIA labels, screen reader support, keyboard nav

## REA (Reverse Engineering) Integration
Use REA to analyze GNOME Evolution's architecture and the UX patterns of
native desktop mail clients.
REA is configured as an MCP server in OpenCode's config.
