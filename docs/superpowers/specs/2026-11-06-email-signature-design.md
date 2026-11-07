# Design: Per-account email signature

**Status:** approved 2026-11-06 by @leonard
**Picked approach:** A — backend-persisted on the account
**Size:** small change

## Intent / why

Leoposta is a mail client; real users expect a signature under their
 outgoing mail, in the usual native-mail style, editable from Settings, applied both to
new compose and to replies. It is currently listed as P0 in ROADMAP.md.
Storing it **per account** (not as a global localStorage key) is a firm
user decision: multi-account is the next P0 item, and this shape drops in
without a migration.

## Goals

- Plain-text signature, editable in Settings → Signature tab.
- Inserted at the bottom of a **new** compose body (before the user types,
  user types above).
- On **reply** / **forward**, placed per the user's `position` setting:
  - `standard` — user's reply, signature, blank line, `--` separator,
     quoted original. (Default in most mail clients.)
  - `after_quote` — user's reply, blank line, `--` separator, quoted
    original, blank line, signature at the very bottom.
- Optional. Empty text or `enabled: false` ⇒ no signature inserted, not
  even an empty line.
- Account A and Account B can have different signatures, independently.

## Non-goals / anti-goals

- **No HTML / rich-text signatures** — compose pane is plain text today;
  upgrading it is its own P1 item. If the user wants HTML, that's a
  separate roadmap line.
- **No drag-to-reorder, no templates, no per-folder overrides.**
- **No signature injection on the wire/server.** The backend remains
  stateless for outbound body; the frontend always composes the final
  body before `POST /api/send`. No `x-signature` header.
- **No signature in scheduled-send queue entries.** Offline queue already
  stores the final composed body, so the signature is baked in at the
  moment of enqueue. Acceptable.

## Constraints

- Repo has no `npm run lint` script (the "lint" line in AGENTS.md is a
  placeholder). Baseline = `npm test` (vitest) + `npm run build` (tsc).
- One existing test: `src/__tests__/store.test.ts`. Tests must stay
  green before the work starts and after.
- Backend is a single 1413-line Express file; signature work must not
  touch the IMAP pool, transport, or scheduler — only the account
  persistence shape and the two `/api/account` routes.
- `account.json` on disk currently holds exactly one key, `id`, plus
  IMAP/SMTP fields. Adding a nested `signature` object is a
  backward-compatible shape extension; a missing key ⇒ `{ enabled:
  false, text: '' }` default.

## Approaches (already discussed with user)

| # | Approach | Trade-off | Verdict |
|---|----------|-----------|---------|
| A | Backend-persisted on the account object in `account.json`, exposed via the existing `GET/POST /api/account` routes, read into the store from the account row, consumed in `Compose.svelte` and edited in `Settings.svelte`. | Small surface, multi-account-ready, no migrations. | **Picked** |
| B | Frontend-only `localStorage` keyed by account id. | Minimum code, but per-browser, wiped on clear-data, incompatible with the PWA/multi-device mission. | Rejected |

## Decisions locked in

- `signature.text` is a plain string, newline-preserving.
- `signature.enabled: boolean`, independent of empty text (a user can
  disable a non-empty signature without editing the text).
- `signature.position: 'standard' | 'after_quote'`, default `standard`.
- A **new compose** (no original message) seeds the body with the
  signature text only; the user's caret is at the top, so they type
  above it.
- A **reply or forward** inserts the signature per the `position`
  setting. Two options, named by where the signature ends up on screen:

| Value | Layout | Use case |
|-------|--------|----------|
 | `standard` (default) | your reply text, then the signature, a blank line, the `--` separator, the quoted original. Outlook / Gmail and most native clients default to this. | 95 % of users |
| `after_quote` | your reply text, a blank line, the `--` separator, the quoted original, a blank line, then the signature. | users who want the sign-off at the very bottom of the message, after the quote |

Unambiguous ASCII view:

```
standard:                        after_quote:
<your reply>                     <your reply>
<blank line>                     <blank line>
<signature>                      --
<blank line>                     <quoted original>
--                               <blank line>
<quoted original>                <signature>
```

## API surface

- **Shape extension** on the account object returned by `GET
  /api/account` and accepted by `POST /api/account`:
  ```ts
   signature?: {
     enabled: boolean
     text: string
     position: 'standard' | 'after_quote'
   }
   ```
   Optional — missing ⇒ default `{ enabled: false, text: '', position:
   'standard' }` applied both on backend read and frontend
   normalization.
- **No new routes.** `GET /api/account` returns the account (signature
  included); `POST /api/account` accepts it. No `PUT /api/account/
  signature` — the existing save path is sufficient for a single-user
  app.

## Frontend shape

- `MailAccount` in `src/store/index.ts` gains `signature: Signature`
  (non-optional, always present after normalization).
- `normalizeAccount(input)` helper — takes a raw account JSON and
  returns a fully-populated `MailAccount`. Used in `Settings.svelte`
  save path (after POST), in `App.svelte`/`Sidebar.svelte` load path,
  and in new-account creation.
- Compose seeding:
  - New compose: `if (sig.enabled && sig.text) body = sig.text`.
  - Reply/forward: see `buildMessageBody(sig, replyText, original)`
    (small pure function — easy to unit-test).
- Settings → new "Signature" tab:
  - Textarea bound to `sig.text`.
  - Checkbox "Use signature".
  - Radio group "In replies, place my signature: above the quoted original
    (`standard`) / below the quoted original (`after_quote`)".
  - Save button persists via the same `POST /api/account` path.

## Parts left to the builder

- Exact placement of the "Signature" tab in the existing Settings UI
  (top of the modal body, after PGP, or as the 5th tab — pick based
  on what's consistent with the 4 existing tabs).
- Wording of labels (default to the ones above; tweak if the user
  prefers).
- Test placement: `src/__tests__/signature.test.ts` for the
  `buildMessageBody` pure function is enough for the TDD requirement;
  the store normalization test is trivial and lives next to it.
  Backend round-trip test (POST signature → GET returns it) — add
  if a backend test harness already exists; otherwise cover it via
  `vitest + node:test` integration test against a mocked Express app
  only if the existing infra makes it cheap. The signature is purely
  data; the round-trip is `assert account.signature === saved`.

## What's verifiable

- `npm test` passes (existing `store.test.ts` + new signature tests).
- `npm run build` (tsc clean).
- Manual: open Settings → Signature, type "— Leo", enable, save.
  Compose new mail → body starts with "— Leo". Reply to an
  existing mail → signature sits between your reply and the quoted
  original.
