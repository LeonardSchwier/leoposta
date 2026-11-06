# ROADMAP

Open work for **leoposta**. `AGENTS.md` and `PROGRESS.md` point here for "what's
still to build" — treat this file as the source of truth for product scope and
update it as each item lands.

> Legend: `[ ]` open · `[~]` in progress · `[x]` done
> Dates are 2026 (year omitted when obvious).

## Now (P0 — feature gaps, agreed 2026-11-06)

- [ ] **Multi-account support**
  - Frontend state is already multi-account-shaped (`src/store/index.ts:63`
    `accounts: MailAccount[]`, `:64` `activeAccountId`) but nothing populates
    it; backend + UI are single-account.
  - `server/index.js:20` `let account = null`; `server/index.js:267`
    `POST /api/account` overwrites the single object; `/api/folders`,
    `/api/messages`, `/api/send`, `/api/idle` all assume one pool of IMAP
    connections (`pool` at `server/index.js:163`).
  - Plan: `accounts.json` (array) + `active_account_id`; per-account IMAP pool,
    nodemailer transport, IDLE subscription; per-account folders/
    messages; sidebar "Account →" toggle; Settings "Accounts" list
    (add / remove / set-default); `/api/account` becomes a list API;
    `store/index.ts` tracks active account id; `api/index.ts` sends an
    `x-account` header (or path param).
  - Accept: two dummy accounts (see `scripts/dummy`) coexist; switching in
    the UI swaps folders/messages without a reload.

- [ ] **Email signature** (user-requested, 2026-11-06)
  - `Compose.svelte:11` seeds `composeBody` with `''`; `AGENTS.md:51` marks
    "Signature support" as a Core item; nothing in `Settings.svelte`
    persists a signature.
  - Plan: add settings `signature.html`, `signature.text`,
    `signaturePosition` (`above-body`/`below-body`), `signatureEnabled`;
    persist in `account.json` `signature` object (or new
    `settings.json`); `Compose.svelte` initialises with the signature +
    `-- -- ` separator; reply / reply-all / forward reuse the same
    pipeline; Settings screen gains a "Signature" tab (HTML / plain-
    text editor + preview + enable checkbox + position selector).
  - Accept: with a signature saved, new compose shows it below the
    body, disabled → empty body, reply inserts it above the quoted
    message, position switch persists across reloads.

## Next (P1 — in-flight or near-term)

- [ ] **Attachments on compose** — `Compose.svelte:153` `// TODO: Upload
  attachments`; needs upload endpoint, MIME assembly, preview in inbox
  (bodyStructure already walked at `server/index.js:339`), download
  (exists at `server/index.js:1316`).
- [ ] **Design-system restyle** — per standing rule (from
  `PROGRESS.md` / `AGENTS.md`): when
  `LeonardSchwier/design-system` (GitHub) lands design tokens + Preact
  components (warm editorial / Nordic themes), rebase leoposta's
  styling on it. Track the repo's commit count / first usable token
  release as the trigger.
- [ ] **Virtualised list** — `AGENTS.md:147` demands virtualized
  inbox; `MessageList.svelte` renders flat. Use `svelte-virtual` or
  hand-rolled for 100k+ inboxes.
- [ ] **Offline mail cache** — service worker exists (`sw.js`), but the
  read-cache in `store/index.ts` is per-session; move to IndexedDB
  (`idb-kv` / `dexie`) so the inbox survives reload + offline.
- [ ] **Filter / rules** — `AGENTS.md:47`; not present. Plan: rule
  list in `account.json.rules`, evaluated on FETCH path, action
  = move / flag / label.

## Later (P2)

- [x] Public GitHub repo + `MIT LICENSE` + leotheca-style README —
  in flight in the same session (tracked by `PROGRESS.md`).
- [ ] E2E tests (Playwright) — `AGENTS.md:142`.
- [ ] Mobile / touch refinements — `AGENTS.md:27`.
- [ ] Calendar + Contacts: already wired to CalDAV/CardDAV via
  `davRequest` (`server/index.js:741`) against `DAV_HOST` env —
  finish multi-account scoping and import validation.
- [ ] i18n (start en, add de/es/fr).

## Security audits (recurring)

- [~] **First security audit** — run-1 done 2026-11-06 (guidance mode,
  `~/.config/opencode/skills/security-audit/`). Result: 5 `needs_validation`
  + 1 `rejected`, 0 `confirmed` (no OS sandbox on this machine → skill keeps
  runtime-proven items at `needs_validation`). Artifacts:
  `~/security-audit-skill/leoposta/run-1/` (`findings.json` PASS, `REPORT.md`).
   Source fixes applied 2026-11-06:
   - [x] `server/index.js:43` write `account.json` with `{ mode: 0o600 }`
   - [x] `server/index.js:16` collapse wildcard `cors()` to an origin allowlist
   - [x] `MessageView.svelte:11` add URI-scheme forbid + `rel=noopener` hook
   - [x] outbound `bodyHtml` sanitize / force text/plain (server: `scrubOutboundHtml`)
- Re-run in full-audit mode after each P0 lands (multi-account, signature)
  and after provisioning an OS sandbox to flip `needs_validation` → confirmed.

## Standing rules

- Check this file before starting any feature; update as you go.
- Before merging anything that touches HTML rendering, credentials, or the
  REST API, run at least a guidance-mode `security-audit` pass and record
  any `needs_validation` item here.
- Never commit secrets; credentials live in untracked
  `server/account.json` + `server/scheduled.json` (already in
  `.gitignore` — keep there).
- Design-system work is **deferred** until the upstream repo publishes
  its first usable token set; do not re-style leoposta on speculation.
