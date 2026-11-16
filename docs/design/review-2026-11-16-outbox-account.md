# Review 2026-11-16: an offline message left from the wrong account

Review mode, unattended: `ROADMAP.md` has no open `[ ]` item. The older "Still open" lists
there were checked against the current code first; most are fixed (the STARTTLS guard,
the `uid: true` fetches, the folder-name encoding, the real Trash path, the DAV
fallback). This run took a finding that is still open and reachable.

## Problem (verified in the code, then reproduced with a test)

`Compose.svelte` queues a message in the IndexedDB outbox (`src/lib/offlineQueue.ts`)
when sending fails while the browser is offline. `QueuedMessage` records the recipients,
subject, body, attachments and schedule, but **not the account it was written under**.
`flushQueue` later posts each message with `apiFetch('/api/send')`, and `apiFetch`
scopes every request to the account that is **active at that moment** (`x-account`
header from `activeAccountEmail`). The server (`resolveAccount`) honours the header.

So with two accounts, a message written under account A while offline is sent from
account B when the user switches to B before the network returns (the account
switcher works offline), or when the app is reopened with B remembered as active. The
mail goes out with the wrong From address and is saved in the wrong Sent folder; the
recipient sees another identity (work vs private). The send is not undoable.
Reproduced by the new test "sends a queued message from the account it was queued
under, not the active one": before the change both messages carry the active account's
header.

## Decision

- `QueuedMessage` gets an optional `account` (the account email). `addQueuedMessage`
  fills it from the active account when the caller gives none, at queue time, which is
  the moment the user pressed Send, so `Compose.svelte` needs no change.
- `flushQueue` sends `x-account: <message.account>` explicitly. A header passed to
  `apiFetch` overrides the active account (it merges `extra` last).
- A message queued under an account that has since been removed is refused by the
  server (`400 No account configured`, `resolveAccount` does not fall back when a header
  is given) and **stays queued**, counted as failed; it is never re-sent as another
  account. Pinned by a new server test.
- Messages queued before this change have no `account` and keep today's behaviour
  (sent under the active account): there is nothing better to use.
- Started offline with the accounts not loaded yet, no active account is known at queue
  time, so `account` stays empty and the old behaviour applies. Known limit, listed in
  `ROADMAP.md`.

## Rejected

- Scoping the offline message cache by account in the same change. The cache key is
  `folder:id` and App clears the leaving folder on an account switch, which hides most of
  the mixing; but scoping needs the account email at the time of an offline start, when
  the accounts have not loaded, and would empty the offline view for users who start
  offline. Needs the active email to be remembered locally first. Listed as open.
- Moving the queue per account into separate object stores: a schema migration for no
  gain over one field.

## Assumptions (no interview in an unattended run)

- One outbox shared by all accounts is intended (the status chip shows one count).
- Sending the message from its own account is always the intent; there is no UI to
  re-target a queued message.
