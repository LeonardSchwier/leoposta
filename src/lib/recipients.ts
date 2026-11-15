/**
 * Recipient field parsing for the compose window.
 *
 * A recipient field holds addresses separated by "," or ";", each optionally
 * with a display name: `Anna Älter <anna@example.com>, "Doe, John" <j@x.y>`.
 * Separators inside quotes or angle brackets do not split. A segment made of
 * bare addresses only, separated by whitespace (`a@x.y b@x.y`, e.g. pasted),
 * is still split into its addresses.
 */
export function splitRecipients(value: string): string[] {
  const out: string[] = []
  for (const s of segments(value).parts) pushSegment(out, s)
  return out
}

/** The raw top-level segments of a field (untrimmed; the last one is what is
 * being typed, possibly ""), and whether the end of the text is inside quotes
 * or angle brackets (so a "," typed there is part of the name, not a separator). */
export function segments(value: string): { parts: string[]; open: boolean } {
  const parts: string[] = []
  let cur = ''
  let quoted = false
  let angle = false
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    if (ch === '\\' && quoted && i + 1 < value.length) { cur += ch + value[++i]; continue }
    if (ch === '"') quoted = !quoted
    else if (!quoted && ch === '<') angle = true
    else if (!quoted && ch === '>') angle = false
    if (!quoted && !angle && (ch === ',' || ch === ';')) { parts.push(cur); cur = ''; continue }
    cur += ch
  }
  parts.push(cur)
  return { parts, open: quoted || angle }
}

function pushSegment(out: string[], segment: string) {
  const s = segment.trim()
  if (!s) return
  const words = s.split(/\s+/)
  if (!/[<"]/.test(s) && words.length > 1 && words.every((w) => w.includes('@'))) out.push(...words)
  else out.push(s)
}

/** The address part of one recipient (`Anna <a@x.y>` → `a@x.y`). */
export function recipientAddress(recipient: string): string {
  // As /<([^>]*)>\s*$/ did (the leftmost "<" after the last ">" but one), by
  // index: that regex was quadratic on a long run of "<".
  const t = recipient.trimEnd()
  if (t.endsWith('>')) {
    const open = t.indexOf('<', t.lastIndexOf('>', t.length - 2) + 1)
    if (open >= 0 && open < t.length - 1) return t.slice(open + 1, -1).trim()
  }
  return recipient.trim()
}
