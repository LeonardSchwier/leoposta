# Review 2026-11-13: downloading a received attachment

Unattended review run (no open `[ ]` item). This takes the first item of the
"Still open" list from the 2026-11-12 review: received-attachment download is
broken at every layer. This is the first slice; the remainder stays on the
roadmap.

## Problems (all verified by reading the code and ImapFlow 1.7.8)

1. `MessageView.svelte` links `/api/attachment/:id?name=`. No such route
   exists (the real one is `/api/message/:id/attachment/:partId`), and a plain
   link carries neither the token header nor `x-account`.
2. The route calls `client.download(id, partId, { op: 'FETCH' })` without
   `uid: true` (so `id` is read as a sequence number) and reads `part.pipe`,
   `part.filename`, `part.size`, `part.contentType`. ImapFlow's `download()`
   resolves `{ meta, content }`, so `part.pipe` is not a function.
3. Attachment ids are `att.filename || 'attachment'` in the message view, and
   `struct.partSequence?.join('.') || ''` in the list. Neither is an IMAP part
   number, and file names collide.
4. The list walker reads `struct.parts`, `struct.filename`, `struct.contentType`,
   `struct.contentId`. ImapFlow's body structure uses `childNodes`,
   `dispositionParameters.filename` / `parameters.name`, `type`, `id`. So the
   list never shows a paperclip. (The shapes used in the new tests are produced
   by ImapFlow's own `parseBodystructure`, not written by hand.)
5. `Content-Disposition: attachment; filename="<encodeURIComponent(name)>"` shows
   `%C3%BC.pdf` to the user, and a name containing CR/LF makes `setHeader` throw.

## Decisions (assumptions made without the owner; judges are recorded in the PR/commit)

- **Ids are the index into mailparser's `attachments`** (`"0"`, `"1"`, ...), and
  the download route re-fetches the message source and parses it with the same
  helper the message view uses. Index ids are consistent with the list the user
  sees by construction, have no collisions, need no MIME part arithmetic, and are
  testable offline with real RFC 822 fixtures. The alternative (IMAP part numbers
  plus `client.download`) streams one part instead of the whole message but cannot
  be verified here against a real IMAP server. A message is already fetched whole
  by `GET /api/message/:id`, so the cost is the same order.
- **The client downloads with the authenticated `fetch`** (`apiFetch`: token and
  `x-account` headers), turns the response into a Blob and saves it through a
  temporary `<a download>`. The token never appears in a URL. The `?token=`
  allowance for attachment GETs in `server/lib/auth.js` is therefore removed;
  it stays for `/api/idle` (EventSource cannot set headers).
- **List entries carry no download id.** `GET /api/messages` only has the IMAP
  body structure, whose part numbers are not the download ids. Entries carry
  `filename`, `contentType`, `size`, and no `id`; the view disables the download
  button until the opened message has loaded and replaced them with entries that
  have an `id`.
- **Not in this slice:** attachments inside a PGP-decrypted message (their bytes
  exist only inside one decrypt call). They are listed without an `id`, so the
  button is disabled, instead of failing at click time.
- **Response hardening** (the server hands out attacker-controlled bytes):
  content type is passed through only when it is a plain `type/subtype`,
  otherwise `application/octet-stream`; `X-Content-Type-Options: nosniff`;
  `Content-Security-Policy: sandbox; default-src 'none'`; `Cache-Control:
  private, no-store`; `Content-Disposition` has an ASCII fallback plus an RFC 5987
  `filename*`.
- **The saved Blob is `application/octet-stream`**, whatever the server declared:
  a `blob:` URL has the app's origin, so if a browser ignored `download` and opened
  it, an HTML or SVG attachment would run there. (Added after judge review.)
- **The message is parsed outside `pool.run`**: a parser failure must not log the
  shared IMAP client out, and parsing a large message while holding the mailbox
  lock would block the account's other IMAP work. (Added after judge review.)
- **Message source is parsed as a Buffer** in both routes. The message route
  converted it to a UTF-8 string first, which corrupts bytes of 8bit bodies in
  other charsets. A regression test covers it.

## Behaviour

`GET /api/message/:id/attachment/:attachmentId?folder=F`

| Case | Response |
| --- | --- |
| `:id` not a positive integer UID, or `folder` given more than once / not a string (it defaults to `INBOX` when absent) | 400 `{error}` |
| no account | 404 |
| message not in the folder | 404 `{error:'message_not_found'}` (returned as a value, so the shared IMAP client is not logged out) |
| no attachment at that index, or an id that is not a plain index (`report.pdf`, `01`, `-1`) | 404 `{error:'attachment_not_found'}` |
| found | 200, the bytes, headers above |

## Out of scope / still open

PGP attachments; streaming a single MIME part; the remaining items of the
2026-11-12 "Still open" list.
