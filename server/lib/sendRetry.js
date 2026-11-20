// Retry policy for scheduled mail. Pure functions, no I/O, so the rules can be tested
// without a mail server. Design: docs/design/review-2026-11-20-scheduled-retry.md
import { randomUUID } from 'node:crypto'
import { domainToASCII } from 'node:url'

const MINUTE = 60_000

/** A scheduled mail that is still failing this long after its scheduled time is given up. */
export const RETRY_GIVE_UP_MS = 24 * 60 * MINUTE

/** Guard on the number of attempts (about 26 fit into the 24 hours with the delays below). */
export const MAX_SEND_ATTEMPTS = 30

/**
 * Attempts allowed after a failure that may have come after the server received the message
 * (see `isAmbiguousFailure`): every further attempt can deliver another copy.
 */
export const MAX_AMBIGUOUS_ATTEMPTS = 3

const RETRY_DELAYS_MS = [1 * MINUTE, 5 * MINUTE, 15 * MINUTE]
const RETRY_DELAY_CAP_MS = 60 * MINUTE

/** Longest `lastError` kept on a message. */
const MAX_ERROR_TEXT = 300

// Errors that say "the network or the server is not reachable right now". nodemailer
// reports its own code (`code`) and keeps a system error's in `originalCode`; the raw
// system codes are listed too in case an error reaches us unformatted. Anything not in
// this list is permanent: sending the same mail twice is worse than reporting a failure.
// ETLS (a failed STARTTLS) is left out on purpose: it is far more often a certificate or
// protocol mismatch than a network blip.
const TRANSIENT_CODES = new Set([
  'ECONNECTION', 'ESOCKET', 'ETIMEDOUT', 'EDNS',
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE'
])

// Failures before a connection existed: the message cannot have reached the server.
const NOT_CONNECTED_CODES = new Set(['EDNS', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH'])

// A certificate or TLS protocol problem on an implicit-TLS connection arrives as ESOCKET with
// the TLS code in `originalCode`. Retrying will not fix a wrong host name, an expired or
// self-signed certificate, or a plain-text port: a setup mistake, reported at once.
const TLS_SETUP_CODE = /^(CERT_|ERR_TLS_CERT_|ERR_SSL_|DEPTH_ZERO_SELF_SIGNED_CERT$|SELF_SIGNED_CERT_IN_CHAIN$|UNABLE_TO_)/

const codesOf = (err) => [err.code, err.originalCode].filter((c) => typeof c === 'string')

/**
 * Whether sending again later can succeed.
 * - An SMTP reply code decides first: 4xx is "try again later", 5xx is final.
 * - Else a connectivity code (see above) is transient.
 * - Everything else is permanent: authentication, a bad envelope, a refused message,
 *   configuration, a plain Error, a value that is not an error at all.
 * @returns {'transient' | 'permanent'}
 */
export function classifySendError(err) {
  if (!err || typeof err !== 'object') return 'permanent'
  const reply = Number(err.responseCode)
  if (Number.isInteger(reply)) {
    if (reply >= 400 && reply < 500) return 'transient'
    if (reply >= 500) return 'permanent'
  }
  const codes = codesOf(err)
  if (codes.some((code) => TLS_SETUP_CODE.test(code))) return 'permanent'
  return codes.some((code) => TRANSIENT_CODES.has(code)) ? 'transient' : 'permanent'
}

/**
 * A transient failure after which the server may nevertheless have received the whole
 * message: a timeout, a dropped connection or a reset, with no reply code and no sign that
 * no connection was made. SMTP has no way to ask, nodemailer reports them all alike (`command`
 * is `CONN`), and each further attempt can deliver another copy, so they get few retries.
 * A 4xx reply (the server said no) and a failure before a connection existed (DNS, refused,
 * unreachable) cannot have delivered anything and keep the full schedule.
 */
export function isAmbiguousFailure(err) {
  if (classifySendError(err) !== 'transient') return false
  const reply = Number(err.responseCode)
  if (Number.isInteger(reply) && reply >= 400 && reply < 500) return false
  return !codesOf(err).some((code) => NOT_CONNECTED_CODES.has(code))
}

/** Milliseconds to wait after the `failedAttempts`-th failure: 1, 5, 15 minutes, then an hour. */
export function retryDelayMs(failedAttempts) {
  const n = Number.isInteger(failedAttempts) && failedAttempts > 0 ? failedAttempts : 1
  return RETRY_DELAYS_MS[n - 1] ?? RETRY_DELAY_CAP_MS
}

/** One line of text for `lastError`: the code and message, then `note`, at most 300 characters. */
export function describeSendError(err, note = '') {
  let text = ''
  if (typeof err === 'string') {
    text = err
  } else if (err && typeof err === 'object' && typeof err.message === 'string') {
    const code = typeof err.code === 'string' ? err.code : ''
    text = code ? `${code}: ${err.message}` : err.message
  }
  text = text.replace(/\s+/g, ' ').trim()
  if (!text) text = 'Unknown error'
  const tail = note ? ` ${note}` : ''
  const room = MAX_ERROR_TEXT - tail.length
  return (text.length > room ? `${text.slice(0, room - 1)}…` : text) + tail
}

/**
 * A Message-ID for a scheduled mail, created once and reused by every attempt, so that a
 * retry after an attempt whose outcome is unknown (the connection dropped after the message
 * was transferred) carries the same Message-ID, which mail systems that de-duplicate use
 * to drop the second copy. The domain is the sender's, or `localhost`.
 */
export function newMessageId(address) {
  const at = typeof address === 'string' ? address.lastIndexOf('@') : -1
  // An internationalised domain goes in as punycode; domainToASCII answers '' for an invalid one.
  const domain = at >= 0 ? domainToASCII(address.slice(at + 1)).toLowerCase() : ''
  const usable = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(domain)
  return `<${randomUUID()}@${usable ? domain : 'localhost'}>`
}

/**
 * What to record on a scheduled message after one attempt failed at `nowMs`.
 * A transient failure stays `pending` with `nextAttemptAt`. It becomes `failed` when the
 * failure is permanent, when the next try would fall more than 24 hours after the later of the
 * scheduled time and the first attempt (a mail that was already overdue, the server having been
 * off, still gets its day), or at the attempt cap (a lower one after an ambiguous failure).
 * Returns the fields to merge; a `failed` result has no `nextAttemptAt` (the caller removes an old one).
 */
export function afterFailedAttempt(msg, err, nowMs) {
  const attempts = (Number.isInteger(msg.attempts) && msg.attempts > 0 ? msg.attempts : 0) + 1
  const firstParsed = Date.parse(msg.firstAttemptAt)
  const firstAttemptMs = Number.isFinite(firstParsed) ? firstParsed : nowMs
  const base = { attempts, firstAttemptAt: new Date(firstAttemptMs).toISOString() }

  const transient = classifySendError(err) === 'transient'
  const ambiguous = transient && isAmbiguousFailure(err)
  const cap = ambiguous ? MAX_AMBIGUOUS_ATTEMPTS : MAX_SEND_ATTEMPTS
  const scheduledMs = Date.parse(msg.scheduled)
  if (transient && attempts < cap && Number.isFinite(scheduledMs)) {
    const next = nowMs + retryDelayMs(attempts)
    if (next <= Math.max(scheduledMs, firstAttemptMs) + RETRY_GIVE_UP_MS) {
      return { status: 'pending', ...base, lastError: describeSendError(err), nextAttemptAt: new Date(next).toISOString() }
    }
  }
  const note = ambiguous ? '(giving up: the server may already have received this mail)' : ''
  return { status: 'failed', ...base, lastError: describeSendError(err, note) }
}
