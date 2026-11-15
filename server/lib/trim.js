// Linear-time trims. An end-anchored regex such as /\/+$/ or /\s+$/ is
// quadratic on a long run of the trimmed character followed by anything else
// (V8 retries the run from every start position), and much of this text comes
// from mail senders or servers.

/** `str` without trailing `ch` characters (one UTF-16 unit or a full code point). */
export function trimEndChar(str, ch) {
  let end = str.length
  while (end >= ch.length && str.startsWith(ch, end - ch.length)) end -= ch.length
  return str.slice(0, end)
}

/** `str` without leading `ch` characters. */
export function trimStartChar(str, ch) {
  let start = 0
  while (str.startsWith(ch, start)) start += ch.length
  return str.slice(start)
}
