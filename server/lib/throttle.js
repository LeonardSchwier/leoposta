// A small in-memory failure limiter for one guarded action (a local,
// single-user server needs no per-client keys). Attempts are counted in a fixed
// window that starts at the first attempt; once `max` have been made the action
// is refused until that window ends. A success calls reset().
//
// attempt() checks and counts in one synchronous step, so callers must call it
// BEFORE awaiting the guarded work. Counting after the await would let any
// number of concurrent guesses pass the check first.
export function createAttemptLimiter({ max, windowMs, now = Date.now }) {
  let attempts = 0
  let windowStart = 0

  function expireIfDue() {
    if (attempts > 0 && now() - windowStart >= windowMs) attempts = 0
  }

  return {
    /** { ok: true } and the attempt is counted, or { ok: false, retryAfterMs } while locked out. */
    attempt() {
      expireIfDue()
      if (attempts >= max) return { ok: false, retryAfterMs: windowStart + windowMs - now() }
      if (attempts === 0) windowStart = now()
      attempts += 1
      return { ok: true }
    },
    reset() {
      attempts = 0
    }
  }
}
