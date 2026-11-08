// Compute the IMAP sequence range for the newest `limit` messages, with an
// optional offset. Returns an `empty` flag so callers can short-circuit the
// FETCH when the mailbox has zero messages (an inverted "start>end" range
// is rejected by IMAP servers).

export function messageRange(exists, limitN, offsetN) {
  if (exists <= 0) return { empty: true, start: 1, end: 0 }
  const end = exists
  const start = Math.max(1, end - (limitN + offsetN))
  return { empty: false, start, end }
}
