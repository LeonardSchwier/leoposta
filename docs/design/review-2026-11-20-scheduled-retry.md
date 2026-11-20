# Review 2026-11-20: a scheduled mail that hits one network error is lost, silently

Review mode, unattended: `ROADMAP.md` has no open `[ ]` item. Two independent judges
(opus, sonnet) were shown five candidates from the "Still open" lists plus new findings and
both ranked this one first; both independently found the persistence bug described under
"Problem 2". Their disagreement (strip a sent mail's body and attachments in the same change,
opus, or not, sonnet) is decided here: not in this change (see "Rejected").

## Problem 1 (verified in the code, reproduced with tests)

`processScheduledMessages` (`server/routes/send.js`) marks a due message `failed` on **any**
error from `sendScheduledMessage`, and only `status === 'pending'` is ever dispatched again.
So one DNS blip, a refused connection, a 4xx "try again later" (greylisting, rate limit) or a
timeout loses the mail for good. The desktop build makes this likely rather than rare: a
laptop wakes from sleep, the 30 s tick fires before Wi-Fi is back, and the mail scheduled for
08:00 is `failed`. Nothing in the UI shows it: `MailAPI.scheduled` and `cancelScheduled`
(`src/api/index.ts`) have no caller, so the user believes the mail went out. The test
"a failed send is marked failed, released, and not retried automatically" pinned the old
behaviour for every error; it still passes (a plain `Error` is a permanent failure now), and
new tests cover the retry.

## Problem 2: a persistence failure turns a delivered mail into a crash

In the same function the chain is `.then(mark sent + saveScheduled()).catch(mark failed +
saveScheduled()).finally(...)`. When `saveScheduled()` throws after a successful send (disk
full, EACCES, the data directory gone) the `.catch` marks a mail that was delivered as
`failed`, its own `saveScheduled()` throws again, and the rejection is unhandled. Nothing in
the repo handles `unhandledRejection`, so on Node 22 the server process dies. Disk says
`pending`, so after a restart the mail is sent a second time. Reproduced with a scratch
probe (`scheduled.json` made a directory, fake sender that succeeds).

## Decision

- `server/lib/sendRetry.js` (new, pure): `classifySendError(err)`, `retryDelayMs(n)`,
  `describeSendError(err)`, `newMessageId(address)`, `afterFailedAttempt(msg, err, nowMs)`.
- **Classification is an allowlist.** Transient: an SMTP reply code 400 to 499; nodemailer
  codes `ECONNECTION`, `ESOCKET`, `ETIMEDOUT`, `EDNS`; the raw system codes `ECONNREFUSED`,
  `ECONNRESET`, `ENOTFOUND`, `EAI_AGAIN`, `ENETUNREACH`, `EHOSTUNREACH`, `EPIPE`. A reply code
  wins over a code (`EMESSAGE` with 451 is transient). **Everything else is permanent**: 5xx,
  `EAUTH`, `EENVELOPE`, `EMESSAGE` without a reply code, `ECONFIG`, `ETLS` (a failed STARTTLS is
  far more often a setup mismatch than a blip), a certificate or TLS protocol problem on an
  implicit-TLS connection (`ESOCKET` with `CERT_*`, `ERR_TLS_CERT_*`, `ERR_SSL_*`,
  `DEPTH_ZERO_SELF_SIGNED_CERT` and similar in `originalCode`: a wrong host name or an expired
  or self-signed certificate will not fix itself), "No account configured", a plain `Error`, a
  non-Error value. Unknown means "do not send again", because sending twice is worse than
  reporting a failure.
- A transient failure keeps the message `pending` and records `attempts`, `firstAttemptAt`,
  `nextAttemptAt` and `lastError` (at most 300 characters, one line). Delays after the 1st, 2nd
  and 3rd failure: 1, 5, 15 minutes, then 60 minutes. The message is given up (`failed`) when the
  next try would fall more than 24 hours after the later of its scheduled time and its first
  attempt (so a mail that was already days late because the server was off, and meets a network
  that is not back yet at start-up, still gets its day), or at 30 attempts as a guard. A permanent
  failure is `failed` at once with `lastError`. Messages saved before this change have none of the
  fields (0 attempts).
- Due means `pending` and `nextAttemptAt` (else `scheduled`) not later than now.
- `processScheduledMessages(send, clock)` takes an injectable clock (milliseconds); the
  retry delay is counted from the moment the attempt failed, not from the tick that started it.
- **Duplicate risk.** A connection that drops after the message was transferred but before the
  server's `250` leaves the outcome unknown, and nodemailer reports it like any other connection
  error (`command` is `CONN`), so SMTP gives no way to tell. Two measures. (1) Such a failure
  (`isAmbiguousFailure`: a timeout, a dropped connection or a reset with no reply code and no sign
  that no connection was made) gets at most 3 attempts, and the message then says "the server may
  already have received this mail". A failure where nothing can have been delivered (DNS failure,
  connection refused, host or network unreachable, or a 4xx reply, the server having said no) keeps
  the full schedule. This was a finding of the independent review: without it a mail whose `250`
  never arrives could be delivered about 26 times in a day. (2) The Message-ID is created once,
  before the first attempt, saved in `scheduled.json` (`messageId`) and reused by every attempt and
  the Sent copy, so a receiving system that de-duplicates by Message-ID drops the extra copy (many
  do not; it then at least threads). Known limit: up to 3 copies in the worst case.
- **Outcome and persistence are separate.** The result of the send decides the status, which
  is set in memory first; every `saveScheduled()` here is guarded and logged, and a failure
  to save never changes the outcome, throws, or leaves a rejection unhandled. A delivered
  mail is never marked `failed`, and is not dispatched again in this process. (After a restart it
  is pending on disk and goes out again: with no durable store there is nothing better; this is
  now logged, not a crash.)

## Rejected

- Stripping `text`, `html` and `attachments` from a sent mail, and pruning old `sent` and
  `failed` entries (`scheduled.json` grows without bound and is rewritten whole, synchronously,
  at each status change). Real, but a different change; `tests/e2e-real/sending.spec.ts` reads
  `subject` and `status` after delivery, so a stub must keep them. Listed in `ROADMAP.md`.
- Showing scheduled and failed mail in the UI. Needs a design (where, and what "retry now" does);
  `lastError` and `attempts` are stored so that it can.
- Retrying a mail that was already `failed` before this change: it may be days old.
- Retrying a PGP mail: it cannot be scheduled (`pgp_not_schedulable`).
- Treating `EPROTOCOL` as transient: it is a protocol surprise mid-session, not a connectivity loss.
- Treating `EAUTH` with a 4xx reply as permanent: a provider that says "too many login attempts, try
  later" is right to be retried, at the hourly pace; the reply code wins over the code.

## Assumptions (no interview in an unattended run)

- A late mail is better than a lost one for up to 24 hours; beyond that it is reported failed.
- The server clock is right enough that "24 hours after the scheduled time" is meaningful.
- Not changed: a partly rejected recipient list resolves as a success in nodemailer
  (`info.rejected`) and is not retried or reported; `GET /api/scheduled` is not scoped to an
  account; a message without `accountId` falls back to the active account.
