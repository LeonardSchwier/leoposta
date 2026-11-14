// Compute the IMAP sequence range for one page of a folder, newest first:
// the `limit` messages that come after the newest `offset` ones. Returns an
// `empty` flag so callers can short-circuit the FETCH when there is nothing
// left (an inverted "start>end" range is rejected by IMAP servers).
//
// Page n+1 starts exactly where page n ended (offset = messages already
// shown), so "load more" neither repeats nor skips a message.

export function messageRange(exists, limitN, offsetN = 0) {
  const end = exists - offsetN
  if (end <= 0) return { empty: true, start: 1, end: 0 }
  const start = Math.max(1, end - limitN + 1)
  return { empty: false, start, end }
}
