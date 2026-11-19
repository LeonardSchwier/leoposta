# Review 2026-11-19: unsent outbox mail is invisible online, never sent at start-up and cannot be discarded

Review mode, unattended: `ROADMAP.md` has no open `[ ]` item (the only open line is the
owner's security audit, which needs an OS sandbox). The "Still open" lists of the
2026-11-17 and 2026-11-18 reviews were checked against the code. Two independent judges
(opus, sonnet) were shown six candidates and both ranked this one first (the outbox item,
(a) of the 2026-11-18 list); the sonnet judge found that it is worse than listed (no
flush at start-up). Both ranked `ContextMenu` keyboard support second; it stays open.
The tiny `computeVirtualRange` clamp rides along as a separate commit. No disagreement
between the judges needed deciding, except the size of the UI: both said "badge plus a
small list with Discard and Retry"; that is what is built, nothing more.

## Problem (verified in the code)

Mail written while offline is queued in IndexedDB (`src/lib/offlineQueue.ts`, store
`outbox`, written by `Compose.svelte` when the send request throws and
`navigator.onLine` is false). Then:

1. **It is only sent on an `online` event.** `flushQueue` has one caller, `handleOnline`
   in `App.svelte`, bound to `window` `online`. Write a message offline, close the app
   (or sleep the laptop) and open it again once the network is back: no `online` event
   fires, `onMount` never flushes, and the message stays in IndexedDB unsent. The user
   saw the compose window close as if the mail had been handled.
2. **It is invisible online.** The "N queued" badge is rendered only for
   `queuedCount > 0 && !navigator.onLine`. Online, a message that is stuck shows nothing.
3. **A refused message can never be removed.** `doFlush` counts any answer without
   `success` (an account that was removed answers `400 No account configured`, a bad
   recipient 500) as `failed` and leaves the message queued. Every reconnect shows a
   3 s toast "1 queued message failed" and nothing else; `removeQueuedMessage` and
   `clearQueue` have no caller outside `offlineQueue.ts`. The text the user wrote is
   trapped on the device, with no reason shown and no way out.

## Decision

- `offlineQueue.ts`: a failed attempt records `lastError` (the server's `error` text, else
  `HTTP <status>`, else "Could not reach the server") and `lastAttemptAt` on the queued
  record (a plain object store: no `DB_VERSION` bump). A message that is removed while a
  flush is running is not sent: the flush re-reads each record just before sending it, and
  the failure write only updates a record that still exists (so a discard is never undone).
  New `getQueuedMessage(id)` and `discardQueuedMessage(id)` (delete plus the
  `QUEUE_CHANGED` event the badge listens to).
- `App.svelte`: `drainOutbox()` (count, flush, toast) is what `handleOnline` ran, extracted
  and single-flight, and it also runs once at start-up when the browser is online and the
  accounts answered (a message queued before accounts were recorded goes out under the
  active account, which needs them loaded). The badge is shown whenever something is
  queued, as a button: offline it keeps its text ("N queued · will send when online"),
  online it reads "N unsent · Review", and "N sending…" while a drain is running (so a send
  that hangs is not hidden). It opens the outbox panel. The failure toast points at it.
- A message the server accepted but that could not be deleted from the outbox afterwards
  (an IndexedDB error) gets `sentAt`; the flush never sends such a record again, it only
  retries the delete (found by the independent review: it would have been re-sent at every
  launch).
- `Outbox.svelte` (new): a dialog listing each queued message (subject, recipients,
  account, when it was written, the last error, attachment count) with **Discard**
  (confirm, as Settings does for removals) and a panel-level **Retry now** (disabled
  offline), kept in sync through `QUEUE_CHANGED`. Escape and the Close button close it;
  focus moves into it and back to the badge.
- Not done: editing or re-targeting a refused message (the user can copy nothing out of the
  panel beyond reading it; a re-open-in-Compose action is the natural next step and is
  recorded as open), retry back-off, a real-stack journey (needs Docker/Dovecot).

## Assumptions (no interview possible)

- Discard is destructive and local: a confirm is enough, no undo.
- A start-up flush may send a message the user has forgotten about; that is the point of
  the outbox (they were told it would send when online).
- A send that succeeded on the server but whose answer was lost can still be sent twice
  (exists today; more flush points add a little exposure, not a new class).
