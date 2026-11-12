# Review 2026-11-12: Delete must not destroy mail

Unattended review run (ROADMAP has no open item). No user interview: the
assumptions below were decided with two independent judge reviews (opus and
sonnet) and are recorded here.

## Problem

`src/App.svelte` `handleDelete()` calls `MailAPI.delete(id, folder)`, which sends
`DELETE /api/message/:id?folder=...` and nothing else. In `server/routes/mail.js`
the handler only moves the message to a mailbox when `toTrash` is truthy, and
then to the literal name `Trash`; otherwise it calls `client.messageDelete()`,
which flags `\Deleted` and expunges. The UI never sends `toTrash`, so every
Delete in every folder, INBOX included, **permanently destroys the mail** with no
confirmation and no undo. Related defects in the same code:

- `toTrash` is read from the query string, so `?toTrash=false` is the truthy
  string `"false"`.
- `'Trash'` is hard-coded; servers call it `Deleted Items`, `INBOX.Trash`,
  `[Gmail]/Trash` and so on. ImapFlow's `client.list()` already reports the
  special-use `\Trash` mailbox, from the server flag or a localized-name list.
- ImapFlow's `messageMove`, `messageCopy` and `messageDelete` return `false` on
  failure instead of throwing. Every route answers `success: true` anyway, so the
  UI drops a message that is still on the server.
- When the server lacks the MOVE extension, ImapFlow emulates a move as COPY then
  `messageDelete`, and runs the delete **even when the copy failed**
  (`node_modules/imapflow/lib/commands/move.js`). `POST /api/message/:id/move`
  (the Archive button) can therefore destroy mail when the destination does not
  exist.
- Any error thrown inside `pool.run()` logs out the shared IMAP client, so a
  logical failure such as "could not move" also drops the connection.

## Decision (judges: both ranked this first; they split on one detail)

Delete moves to the server's Trash. It is permanent only for a message that is
already in Trash. Nothing is ever deleted as a fallback.

1. Trash is the first `client.list()` entry with `specialUse === '\\Trash'`,
   else a mailbox called `Trash` (matched case-insensitively).
   A mailbox flagged `\Noselect` (a bare parent, or one that does not exist) is
   never chosen.
2. If the mailbox the server actually selected is exactly that path, expunge
   (this is how "empty trash" works today and in other clients). "Selected"
   means the `path` of the mailbox lock, not the raw name the client sent:
   ImapFlow adds the namespace prefix and folds INBOX, so the UI's `Trash` is
   `INBOX.Trash` on some servers. (The first version compared the raw name; the
   independent review caught that it would then move `INBOX.Trash` into itself
   and report success. Fixed, with a namespace test.) The comparison is exact, so
   only the real Trash is ever expunged.
3. No Trash mailbox exists: create `Trash` (the name the sidebar already uses),
   then move. If the create fails, answer 500 and touch nothing.
   Judge A preferred a 409 here; judge B preferred creating. Creating wins: with
   a 409 the UI offers no way to delete at all for such an account, and the app's
   own Trash view already points at `Trash`.
4. `toTrash` is ignored (no client sends it; ending the string trap).
5. A `false` from the library is an error: 500 JSON, the UI keeps the message.
   The error is returned as a value out of `pool.run` so the shared IMAP
   connection is not torn down.
6. Without MOVE, do `messageCopy`, check it, and only then `messageDelete`.
7. `POST /api/message/:id/move` uses the same checked move.
8. A non-numeric or non-positive id is a 400 before any IMAP call.

Response stays backward compatible: `{ success: true }` plus `trashed` (boolean)
and `folder` (where the message is now, or where it was permanently removed).

## Out of scope (recorded in ROADMAP "Still open")

- Attachment download is broken at every layer (UI link has no matching route and
  no token; the route misuses ImapFlow's `download()` result; attachment ids are
  not IMAP part numbers). Larger change, next run.
- The sidebar and App hard-code `Trash`/`Archive` instead of using special-use
  folders, so on a server whose trash is `Deleted Items` the in-app Trash view is
  empty although the mail is safe in the real trash.
- No confirmation or undo for a permanent delete inside Trash; no Empty Trash.
- `GET /api/message/:id` fetches every UID of the mailbox per open; STARTTLS is
  opportunistic when TLS is off; the DAV fallback host `dav.example.com` is
  plaintext; a saved DAV URL cannot be cleared; folder names are not URL-encoded
  in `MailAPI` query strings.

## Tests

`server/removal.test.js`: route-level through `createApp()` with a fake ImapFlow
client seeded into the account pool. The fake follows ImapFlow's return shapes
(`false` on failure, COPY then delete without MOVE) and its path normalization
(namespace prefix, INBOX in any case, `{ path, release }` from the lock). It does
not model IMAP4rev2 capability folding or UIDPLUS: MOVE is read from the
advertised capabilities, so a rev2-only server gets COPY, check, remove (checked,
not atomic). The e2e dummy IMAP server supports no MOVE,
COPY or EXPUNGE and no e2e test deletes, so e2e coverage is unchanged (and
cannot run in this sandbox).

## Independent review (opus), 2026-11-12

Medium (fixed): raw-name comparison with the Trash path, see decision 2.
Low (fixed): `\Noselect` mailboxes could be picked as Trash. Low (documented):
MOVE detection ignores IMAP4rev2 folding. Low (pre-existing, listed in ROADMAP):
without UIDPLUS, ImapFlow's `messageDelete` sends a plain `EXPUNGE` that also
removes other clients' `\Deleted` messages; bad input such as a non-string
`folder` still makes `pool.run` log the shared client out.
