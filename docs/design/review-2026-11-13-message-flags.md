# Review 2026-11-13: message flags (read, starred)

Found while checking ImapFlow 1.7.8's real shapes for the attachment work. Both
bugs are verified against the installed package, not assumed.

1. `POST /api/message/:id/flags` and the "mark as read when a message is opened"
   step call `client.messageFlags(...)`. ImapFlow has `messageFlagsAdd`,
   `messageFlagsRemove` and `messageFlagsSet`, and no `messageFlags`
   (`typeof new ImapFlow(...).messageFlags === 'undefined'`). Starring a message
   therefore answered 500 `client.messageFlags is not a function`, and because the
   TypeError was thrown inside `pool.run` the pool also logged the shared IMAP
   client out each time. Opening a message never marked it read (the error was
   swallowed).
2. `normalizeFlags` used `Object.keys(flags)` for anything that is not an array.
   ImapFlow reports `flags` as a `Set<string>`, whose `Object.keys` is `[]`, so the
   list and the message always came back with no flags: every message looked
   unread and unstarred whatever the server said.

## Decisions

- `normalizeFlags` accepts a Set (returns a copy as an array).
- The flags route uses `messageFlagsAdd` / `messageFlagsRemove` by UID. ImapFlow
  resolves `false` when the server refuses; that is answered as a 500 JSON error
  returned as a value out of `pool.run` (the same pattern as Delete), so a refusal
  does not log the connection out.
- The route validates its input before touching IMAP: `:id` is a positive integer
  UID, `add` / `remove` are arrays (at most 32) of plain flag names (`\Seen`,
  `$Work`; no spaces, parentheses or quotes, so a value cannot add tokens to the
  STORE command), `folder` is a string. The UI only sends `\Flagged`.
- A request with nothing to add or remove succeeds without contacting the server.
- Marking read on open stays best effort (the message is shown either way).

Not changed: the response of `GET /api/message/:id` carries the flags as fetched
(before marking it read); the list marks it locally.
