# Review 2026-11-18: the offline message cache is not scoped by account

Review mode, unattended: `ROADMAP.md` has no open `[ ]` item (the only open line is the
owner's security audit). The "Still open" lists of the 2026-11-16 and 2026-11-17 reviews
were checked against the code. Two independent judges (opus, sonnet) were shown five
candidates and both ranked this one first; both said to bundle the small SSE fix
(`?account=` unknown falls back to the first account) as a separate commit. Their one
disagreement, a schema version bump (opus) versus no bump (sonnet), is decided below: no
bump. The outbox without a way to discard a refused message needs new UI and a real-stack
journey this sandbox cannot run; it stays open.

## Problem (verified in the code)

`src/lib/offlineQueue.ts` keeps the offline reading cache in IndexedDB (`leoposta-queue`,
store `messages`). An entry is keyed `${folder}:${id}` and carries no account. The cache
is shared by every configured account, so:

1. The same folder and UID under two accounts is one entry: INBOX uid 5 of account A and
   uid 5 of account B overwrite each other, and `getMessageCache` returns whichever was
   written last. Offline, the pane then shows the other account's mail.
2. `cacheFolderList(folder, rows)` keeps only the entries of *other folders* plus the new
   rows, so listing `Sent` as B deletes A's cached `Sent` rows.
3. `cachedMessagesForFolder(folder)` filters by folder only, so offline B's `Sent` list
   shows A's mail (and the reverse). `App.svelte` clears one folder (the one that was open)
   when the account switches, which masks the INBOX case only.
4. Removing an account leaves its cached mail on disk.
5. `cacheFolderList` reads in one transaction and rewrites in another, and rewrites by
   `clear()`: two overlapping calls (a refresh and a folder switch) lose rows.

Items 1 and 3 show one account's mail under another account's name; item 4 is mail that
outlives its account.

## Decision

- Every entry gets `account` (the address, trimmed and lower-cased) and its key becomes
  `account \0 folder:id`. All reads, writes and clears are scoped to an account.
- The account is an optional last argument. A write or a clear uses the **active** account
  (`cacheScope()`), because that is the account every request is scoped to: with no active
  account a request carries no account header and the server answers for its first account,
  which need not be the remembered one, so nothing is written then. A read
  (`cacheReadScope()`) uses the active account, else the account the browser remembered
  (`activeAccountMemory.readLocal()`, so a PWA that starts offline, before the account list
  loads, still reads its own cache), else none; with no account nothing is read, because mail
  of an unknown owner is never shown. Callers that wait for a response (`loadMessages`,
  opening a message) capture the account before the request and pass it, so an answer that
  arrives after an account switch is cached under the account it was asked for. (The first
  version of this change let writes use the remembered account too; the independent review
  found that case and it is fixed and tested.)
- No `DB_VERSION` bump (the outbox store is untouched). An entry written before this change
  has no `account`: it is never served, and the next `cacheFolderList` deletes it. It is a
  cache, so nothing is lost.
- `cacheFolderList` does its read and its writes in one readwrite transaction and deletes
  stale keys one by one (no `clear()`), so concurrent calls and other accounts' rows
  survive. Behaviour that is deliberately kept: a list row replaces a cached full message of
  the same key (noted as open in `ROADMAP.md`).
- `clearMessageCache(folder)` clears that folder of one account; `clearMessageCache()` still
  wipes everything. New `clearAccountCache(email)` removes one account's entries; Settings
  calls it after a successful account removal.
- `App.svelte` no longer clears the leaving folder on an account switch. It ran after the
  switch, so with scoped reads it would wipe the *new* account's folder, and with scoped
  entries it is not needed.

## Known limits (left open)

- A body request that was already in flight when its account was removed can still write one
  entry after `clearAccountCache` has run; it is never served unless the same address is added
  again, when it is that address's own mail.
- `cacheFolderList` still replaces a cached full message with the list row of the same key, so
  an opened message loses its offline body after the next list refresh (unchanged behaviour,
  see `ROADMAP.md`).
- `cacheFolderList` reads every cached value to find stale keys; a key cursor would be cheaper.

## Not covered

No browser or real-stack run is possible in this sandbox (AGENTS.md gates 1 and 3 are not
met for the Settings and App wiring); the cache module is covered by fake-indexeddb tests
and the wiring by the source-level tests named in the plan.
