# Multi-Account Support — Design

**Date:** 2026-11-07
**Repo:** leoposta
**Priority:** P0 (last open P0 item)

## Intent

Let a user manage more than one IMAP/SMTP account in a single leoposta instance.
Switching the active account in the UI must swap the folder/message view without
reloading the page. Both accounts must be fully functional (read, send, receive)
while the other's IMAP connection is idle.

## Current state (why it is single-account)

| Artifact | Current value |
|---|---|
| `server/lib/state.js` | `state.account` is a single object loaded from `account.json` |
| `server/lib/imap.js` | One shared `pool` object; `createImapClient()` reads `state.account` directly |
| `server/routes/mail.js` | 11 handlers each call `pool.run(...)` with no account parameter |
| `server/routes/send.js` | `createSmtpTransporter()` reads `state.account`; scheduled sends use the single account |
| `server/routes/idle.js` | One SSE connection per request, bound to `state.account` |
| `src/store/index.ts` | `accounts: MailAccount[]` + `activeAccountId` are declared but **nothing populates them** |
| `src/api/index.ts` | No `x-account` header; no account parameter on any call |

## Goals

- **G1** — Persist N accounts (id, credentials, settings) in `accounts.json`
- **G2** — One IMAP pool per account; accounts don't block each other
- **G3** — Every mail/send/idle route resolves the target account from
  `x-account` header (email address); falls back to the first active account
- **G4** — `GET /api/accounts` returns the full list; `POST /api/accounts` adds;
  `DELETE /api/accounts/:email` removes; `PUT /api/accounts/:email` updates
- **G5** — Existing single-account `GET/POST/DELETE /api/account` routes
  continue working (compatibility shim — returns/sets the first account)
- **G6** — Frontend: active account is in the store; `apiFetch`/`api` send
  `x-account` header; Accounts tab in Settings lists accounts + add/remove
- **G7** — Idle SSE routes work per-account (one IMAP connection per active SSE stream)

## Non-goals

- Simultaneous read of two accounts in the UI (one active at a time)
- Cross-account search
- Per-account rules (rules stay global for now)
- Tauri keychain (deferred, already tracked as a follow-up in B6)

## Approach (chosen)

**Server-side multi-account pool keyed by email address.**

Each pool is a separate `ImapFlow` instance with its own serialization queue.
Pool state lives in a `Map<string, pool>` in `imap.js`. `createImapClient(acct)`
and `createSmtpTransporter(acct)` take the account object as a parameter.
Routes resolve the account object via a `resolveAccount(req)` helper that reads
`req.headers['x-account']`, looks up the account by email in `state.accounts`,
and falls back to `state.accounts[0]`.

This reuses the existing pool serialization/reconnect logic (just wrapped in a
map), keeps the HTTP API stable (new routes + shim for old ones), and requires
only a one-line header addition on the frontend.

**Rejected alternative:** subdirectory per account (`server/abc123/account.json`
separate Express app). Too complex: two servers, two tokens, two port numbers,
frontend has to manage two `apiFetch` bases. One process with a pool map is simpler
and gives the same isolation.

**Rejected alternative:** thread-per-account in libuv. Node doesn't do that;
`worker_threads` would be overkill for two IMAP connections.

## API shape

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/api/accounts` | — | `[{ id, email, name, ... }]` (no passwords) |
| POST | `/api/accounts` | account fields + `id` | `{ success: true }` |
| PUT | `/api/accounts/:email` | account fields | `{ success: true }` |
| DELETE | `/api/accounts/:email` | — | `{ success: true }` |
| GET | `/api/account` | — | first account (compat) |
| POST | `/api/account` | account fields (no id) | `{ success: true }` (sets/creates first) |
| DELETE | `/api/account` | — | removes first (compat) |
| GET | `/api/status` | — | `{ connected, account, accounts: string[], version }` |

All mail/send/idle routes accept `x-account: <email>` header and use that account;
`404` if no account matches and there is no fallback.

## Data layout

`accounts.json` (mode 0o600):

```json
[
  {
    "id": "acct-1",
    "email": "alice@example.com",
    "name": "Alice",
    "imapHost": "imap.example.com",
    "imapPort": 993,
    "imapTls": true,
    "imapUser": "alice@example.com",
    "imapPass": "secret",
    "smtpHost": "smtp.example.com",
    "smtpPort": 465,
    "smtpTls": true,
    "smtpUser": "alice@example.com",
    "smtpPass": "secret",
    "signature": { "enabled": false, "text": "", "position": "standard" }
  }
]
```

Migration: if `account.json` exists and `accounts.json` does not, `state.js`
imports it as `[account.json]` into `accounts.json` on first load and renames
the file. Existing `LEOPOSTA_IMAP_PASS` / `LEOPOSTA_SMTP_PASS` env vars continue
to override the first account's passwords (legacy behaviour).

## Files changed

| File | Change |
|---|---|
| `server/lib/state.js` | `ACCOUNT_FILE → ACCOUNTS_FILE`; `state.account → state.accounts`; `saveAccount → saveAccounts`; `applyEnvPasswords` patches first account |
| `server/lib/imap.js` | `createImapClient(acct)`, `createSmtpTransporter(acct)`, `pools: Map`, `getPoolFor(acctEmail)` |
| `server/routes/account.js` | Full CRUD for `/api/accounts/:email`; compat shims for `/api/account` |
| `server/routes/mail.js` | `resolveAccount(req)` helper; `getPoolFor(email).run(...)` |
| `server/routes/send.js` | `resolveAccount(req)`; `createSmtpTransporter(acct)` |
| `server/routes/idle.js` | `resolveAccount(req)`; `createImapClient(acct)` |
| `server/index.js` | `/api/status` reads `state.accounts` |
| `server/multi-account.test.js` | **new** — CRUD tests with node:test + createApp |
| `src/api/index.ts` | `x-account` header from active account email (injected by `api` helper) |
| `src/store/index.ts` | `loadAccounts()`, `setActiveAccount(email)` actions |
| `src/components/Settings.svelte` | Accounts tab: list, add, remove, set-active |
| `src/App.svelte` | `onMount` loads accounts before first folder fetch |

## What the builder still decides

- Whether scheduled sends store `accountId` on the message so `processScheduledMessages`
  can find the right account (vs. always using the first account). **Call:** store the
  email on the message; look up from `state.accounts` at send time; if missing, fall back
  to `state.accounts[0]`.
- `GET /api/accounts` never includes `imapPass`/`smtpPass`.
- `POST /api/accounts` generates `id` as `acct-` + `crypto.randomUUID().slice(0,8)`.
