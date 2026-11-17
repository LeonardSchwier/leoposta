# Review 2026-11-17: an account address with a non-Latin-1 character breaks every API call

Review mode, unattended: `ROADMAP.md` has no open `[ ]` item. The "Still open" list of the
2026-11-16 review names this as its item (4); two independent judges (opus, sonnet) were
shown five candidates from those lists, read the code, and both ranked this one first
(deterministic, whole-app failure, small, fully provable here). The runners-up (the outbox
that keeps a refused message forever, the offline cache that is not scoped by account, the
context menu without keyboard navigation) stay open in `ROADMAP.md`.

## Problem (verified in the code, then reproduced with a test)

Every API call is scoped to the active account by a request header,
`x-account: <email>` (`src/api/index.ts` `authHeaders`; also the offline outbox in
`src/lib/offlineQueue.ts`, `src/lib/pgp.ts` and two calls in `Settings.svelte`). Header
values must be ByteStrings: `new Headers().set('x-account', 'łukasz@example.test')` throws
`TypeError: Cannot convert argument to a ByteString ... value of 322 which is greater than
255` (checked in Node; browsers throw the same). The server accepts any non-empty email
when an account is added, so an address with a character above U+00FF (Cyrillic, CJK,
Polish ł, Czech š, Turkish ş and every internationalised domain) can be saved, and from
then on every request made while that account is active throws before it is sent. The
account list, folders, messages, sending and even `DELETE /api/accounts/:email` (which
also goes through `authHeaders`) are unreachable, so with one account the user cannot
repair it in the UI.

Latin-1 characters (ö, é) happen to work today: the browser sends the byte and Node reads
headers as Latin-1. The SSE route (`?account=`) and the account paths already use
`encodeURIComponent`; only the header is unsafe.

## Decision

- New `src/lib/accountHeader.ts`: `accountHeaderValue(email)` returns the address unchanged
  when it is printable ASCII, else `u8:` + `encodeURIComponent(email)`; `accountHeaders(email)`
  is the `{ 'x-account': ... }` object (empty for no account). It is the only place in
  `src` that names the header; a test fails when another file does.
- All five call sites use it. The queued message keeps the raw address (it is shown and
  compared as an address); the flush encodes it.
- `server/lib/state.js` `decodeAccountHeader(value)`: a `u8:` value is percent-decoded; a
  malformed one gives `null`. `resolveAccount` uses it. A header that is present but
  unusable never falls through to `accounts[0]` (that would send as the wrong account),
  exactly like an unknown address today: `getAccount(null)` is `null`, the route answers
  `400 No account configured`.
- Unprefixed values keep today's behaviour, byte for byte (older clients, the test
  suites, `curl`). A `%` is legal in a local part, so decoding must not be guessed: only
  the `u8:` prefix triggers it. An address that itself starts with `u8:` (not valid per
  RFC 5322, but the account form does not reject it) is encoded by the client too, so the
  prefix is never ambiguous.
- Latin-1 addresses (`jörg@...`) used to work raw and are now encoded as well. A new
  client against a server that was not updated with it (a separate `VITE_API_URL`
  deployment) therefore gets `400 No account configured` for those accounts; client and
  server ship from this repository together, so this is accepted.

## Rejected

- Encoding every value: churns every existing request and test for no gain.
- A second marker header (`x-account-enc`): one more header to allow and to forget; the
  prefix travels with the value.
- Base64 or RFC 2047 words: percent-encoding is already what the SSE query and the account
  paths use, and `decodeURIComponent` is built in on both sides.
- Refusing such addresses when an account is added: they are valid addresses (RFC 6531)
  and a user who already saved one would stay locked out.

## Assumptions (no interview in an unattended run)

- The account form is not asked to reject odd addresses: the helper and the server cope with
  any string a user managed to save, except a lone surrogate (`encodeURIComponent` throws
  there; such an address is malformed text, and it fails as it did before).
- The `?account=` query of the SSE route is unchanged: it was already percent-encoded, and its
  fallback to the first account for an unknown value is the existing behaviour (listed in
  `ROADMAP.md` as still open).
- Test fixtures use fictional addresses only (`erika@пример.test`, `łukasz@example.test`).
