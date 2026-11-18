# Review 2026-11-18 (second run): an opened message loses its offline body, and the offline list is in the wrong order

Review mode, unattended: `ROADMAP.md` has no open `[ ]` item. The "Still open" lists of the
2026-11-17 and 2026-11-18 reviews were checked against the code. Two independent judges
(opus, sonnet) were shown eight candidates and both ranked (a) first and each found the same
extra bug (the offline list order). Their one disagreement is decided below: opus wanted an
explicit list position stored on each entry, sonnet a sort on the message date. Decision:
sort on the date, because the server sorts on exactly that and it needs no new field, no
schema change and works for entries that are already cached. Not taken this run: the outbox
without a way to discard a refused message (needs new UI and a real-stack journey), keyboard
navigation of `ContextMenu` (feature-sized), the cache scan cost, the in-flight body write
after an account removal (a stray entry of a removed account, never served), `parseAddr` (not
reachable: callers pass ImapFlow objects) and the account form (the browser trims an
`<input type="email">` value, and `accountSavePayload` trims too).

## Problem (verified in the code)

1. `cacheFolderList(folder, rows)` (`src/lib/offlineQueue.ts`) `put`s a `full: false` list
   row for every message of the list over whatever is stored under the same key. Opening a
   message stores a `full: true` entry with its body (`putMessageCache`, called from
   `App.svelte` and `openMessage.ts`). `loadMessages` calls `cacheFolderList` after every
   successful list fetch (folder switch, background refresh, reconnect), so the next refresh of
   that folder replaces the full entry with a body-less row. Offline, `loadMessageBody` only
   serves the cache when `cached?.full && cached.message` (`src/lib/openMessage.ts`), so a
   message the user had read shows "The message could not be loaded". Offline reading only
   works for a message until the next list refresh, usually minutes.
2. `cachedMessagesForFolder` sorts on `fetchedAt` only, and every row of one
   `cacheFolderList` call has the same `fetchedAt`. The sort is all ties, so the order is
   IndexedDB key order, a string order: UIDs 98, 99, 100, 101, 102 come out as 100, 101, 102,
   98, 99. The server answers newest first (`messages.sort(b.date - a.date)`), so offline the
   list is oldest-first and scrambled across digit boundaries, and a message the user opened
   (a newer `fetchedAt`) jumps to the top. The existing test sorted the ids before comparing,
   which hid it.

## Decision

- `cacheFolderList` does the merge inside its existing single readwrite transaction (a
  read before the transaction would bring back the overlapping-write race that the
  2026-11-18 change removed). When the entry stored under a row's key is a `full` entry of the
  same account, the written entry stays `full: true` and its `message` is the row (so the
  envelope fields that change on the server, such as flags, subject, date and thread, are
  fresh) with the stored value restored for every field a body load fills in: `body`,
  `bodyHtml`, `pgp`, `attachments`, `cc`, `bcc`, `headers`, and every key the row does not have
  (`messageId`, `references`, `replyTo`, ...). The stored value always wins for these, it is not
  only a fallback for an empty row value: the review of the first version showed that the row's
  `attachments` come from the IMAP body structure and have no `id` (the message view then says
  "Download is not available"; `server/lib/attachments.js` says so), and its `bcc` lacks the
  envelope fallback. The row's own value wins for everything else, flags included even when
  empty. Spreading the row over the stored message would be wrong: the row has `body: ''` and
  would blank the body.
- The merge only happens when the row and the stored message have the same `fromAddress` and
  `date` (both routes derive them from the same envelope). The cache does not know the folder's
  UIDVALIDITY; if the server renumbered the folder, UID 7 is another message and its row must not
  get the old body. A mismatch writes the row alone, which is what happened before this change.
- A `full` entry whose id is not in the new list is still deleted (the stale rule is
  unchanged), so the cache stays bounded by the newest page. A decrypted PGP message is never
  stored as full (`App.svelte`), so the merge cannot keep plaintext around.
- `cachedMessagesForFolder` sorts on the message `date` (newest first), then on the numeric
  UID (higher first), then on `fetchedAt`. A date that does not parse sorts last. This is the
  order the server answers in, so the offline list matches the online one.
- No `DB_VERSION` bump, no new field.

## Crash-freedom questions (`skills/bug-fixing.md`)

- Errors: both functions are cache paths that callers already `.catch`; the merge adds no
  new throw (a stored value that is not an object is replaced by the row).
- Boundary inputs: a stored `full` entry with a missing or non-object `message`, a row
  without `flags`, an unparsable or missing `date`, a non-numeric id (sorted as 0, then by
  `fetchedAt`).
- Lifecycle: no new listener or timer. Races: the read and the writes share one transaction.
- Partial failure: a transaction that aborts leaves the cache as it was.
- WebKitGTK as well as Chromium: only IndexedDB calls the code already makes.

## Not run in this sandbox

`npm run test:e2e:real` (needs podman or docker) and `tests/desktop/run-desktop-smoke.sh`
(needs WebKitGTK). AGENTS.md gates 1 and 3 are therefore not met for this change: there is no
real-stack journey that opens a message, refreshes the folder, goes offline and reads the
message. It is listed as open in `ROADMAP.md`.
