# Import mail + WebDAV accounts from GNOME Online Accounts

## Motivation

Leoposta already asks for IMAP/SMTP/WebDAV host, port and credentials by
hand. On a GNOME desktop that's often a second copy of the same account the
user already added under **Settings → Online Accounts**. Reading it from
there instead removes a manual data-entry step and keeps the password out of
the API payload entirely — it stays in gnome-keyring and leoposta reads it at
import time only.

## Scope

- Linux + GNOME only, native (non-container) runs only. GOA talks to the
  session D-Bus bus and gnome-keyring; neither exists inside the Docker
  image's isolated network/user namespace, nor on Tauri builds for other
  OSes. The feature **feature-detects** `gdbus` + the session bus and simply
  reports itself unavailable everywhere else — never a hard error.
- Two GOA provider types, confirmed present and recognized on this machine
  (`IsSupportedProvider` → `true`) and matching what the user's GNOME Settings
  shows:
  - `imap_smtp` → "Mail (IMAP and SMTP)"
  - `webdav` → "Calendar, Contacts and Files (WebDAV)"
- Out of scope: creating/editing GOA accounts (GOA's own `AddAccount` D-Bus
  method exists, but driving it would mean handling the user's password
  ourselves, which defeats the point — account creation stays in GNOME
  Settings, where the password only ever touches the keyring).

## Design

- `server/lib/goa.js` — reads account objects via
  `org.gnome.OnlineAccounts` `ObjectManager.GetManagedObjects` (shelled out
  via `gdbus`, no native/compiled dependency — keeps the Docker image and
  non-Linux Tauri builds unaffected), filters to the two provider types, and
  resolves the matching keyring secret via the Secret Service API
  (`secret-tool`). No D-Bus/keyring library dependency added to package.json.
  Exported as a single `listGoaAccounts()` / `importGoaAccount(id, kinds)`
  pair so the HTTP layer stays thin.
- `server/routes/goa.js` — `GET /api/goa/accounts` (sanitized list: id,
  presentation identity, provider type, kind available), `POST
  /api/goa/import` (`{ goaId, importMail, importDav }`) → builds a payload
  and calls the existing `addAccount`/`updateAccount` from `lib/state.js`.
  Reuses all existing persistence/validation; GOA is just another credential
  source feeding the same account record.
- Both routes resolve to `503 { available: false }` when `gdbus`/the session
  bus/`secret-tool` aren't present, instead of a 500.
- Frontend: a "Import from GNOME Online Accounts" box in Settings, below the
  manual account form. Hidden content (not removed — `[hidden]`-style
  toggle) when the backend reports unavailable, so this never shows a dead
  button on non-Linux installs.

## Verification (done against a real account before merge)

A real `leonard@schwier.org` account was added via GNOME Settings → Online
Accounts (one `imap_smtp`, one `webdav`, pointing at mailbox.org) and
introspected with `busctl --user --json=short`. Two corrections to the
original design came out of that:

- **Password retrieval.** The design assumed reading the Secret Service
  directly (`secret-tool`, by a `goa-identity` keyring attribute). The real
  API is better: `org.gnome.OnlineAccounts.PasswordBased.GetPassword(id)`,
  a D-Bus method GOA itself exposes for exactly this. No keyring-attribute
  guessing needed. Confirmed ids: `"imap-password"` / `"smtp-password"` for
  an `imap_smtp` account, `""` for a `webdav` account. A wrong id fails
  clearly (`Did not find <id> with identity "…" in credentials"`), mapped
  to `null` here.
- **DAV URL.** `Calendar`/`Contacts` interfaces expose an already-resolved
  concrete `Uri` (e.g. `https://user%40example.test@dav.example.test/caldav`),
  not a discoverable base — and it has the username URL-encoded into the
  userinfo component. Taking it as-is for `davUrl` would make leoposta's own
  auto-discovery (`lib/dav.js` `resolveDavBase`) reuse that one concrete path
  for *both* calendar and contacts, which is wrong when they differ (as they
  do on mailbox.org: `/caldav` vs `/carddav`). Fixed by reducing the URI to
  its host root (`https://dav.example.test/`) and letting leoposta discover
  the calendar-home-set / addressbook-home-set itself, exactly as it would
  for a manually-typed root URL.

Mail property names (`EmailAddress`, `ImapHost`, `ImapUseSsl`,
`ImapUserName`, `SmtpHost`, `SmtpUseSsl`, `SmtpUserName`) matched the design
exactly.

**A second, pre-existing bug surfaced during this verification** (not a GOA
problem — a latent bug in `lib/state.js` `updateAccount` that this feature
was the first caller to ever trigger): importing the `webdav` account right
after the `imap_smtp` one (both resolve to the same email, so the second
import updates rather than duplicates) silently wiped `imapHost`/`imapUser`/
`smtpHost`/`smtpUser`/`signature` — any field the DAV-only payload didn't
mention — because `accountPayloadFrom(body)` always returns every field,
`undefined` for ones `body` omits, and the merge spread `fresh` over `cur`
without checking for that. The same thing would have happened to a
`webdav`-then-`imap_smtp` import, or any other future partial update. Fixed
in `lib/state.js` by computing `fresh` from `{ ...cur, ...body }` instead of
`body` alone, so an omitted field keeps its current value and only a field
actually present in the request (including an explicit `''`/`false` to
clear it) changes — see `server/lib/state.test.js` for the regression
coverage. Re-verified end to end after the fix: importing both accounts (in
the order that broke it) now leaves a complete record, and `GET
/api/messages` and `GET /api/calendar/calendars` both succeed against the
real mailbox.org servers with the imported passwords.

## Security

- No new secret storage. An imported password is persisted exactly like a
  manually-typed one today (plaintext in `accounts.json`, mode `0600`, or
  kept out of it via `LEOPOSTA_IMAP_PASS`/`LEOPOSTA_SMTP_PASS` for the first
  account) — see [README Credentials](../../README.md#credentials).
- The import endpoint never returns a password in its response body.
