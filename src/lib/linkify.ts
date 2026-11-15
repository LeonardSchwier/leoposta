/**
 * Plain-text bodies as text and link segments. The segments are rendered by
 * Svelte as text nodes and <a> elements, never as HTML, so a body cannot
 * inject markup; only http(s), www. and mailto: become links.
 */
export type Segment = { text: string; href?: string }

// The old single regex ended in an email alternative,
// \b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b, which rescans a long
// local-part run from every word boundary inside it: 4 s for 100 KB of
// "a.a.a.", quadratic, so one mail could freeze the reading pane. The URL and
// mailto alternatives stay a regex (each start fails after a few characters);
// emails are found from each "@" instead. Matches are merged in the old
// regex's order: leftmost start first, a URL before an email at the same start.
const LINK_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+|\bmailto:[^\s<>"']+/gi
const DOMAIN_RE = /[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/y
const LOCAL = /[A-Za-z0-9._%+-]/
const WORD = /[A-Za-z0-9_]/

type Found = { index: number; text: string }

/** The first email match starting at or after `pos`, as the old regex found it. */
function nextEmail(text: string, pos: number): Found | null {
  for (let at = text.indexOf('@', pos + 1); at >= 0; at = text.indexOf('@', at + 1)) {
    // The local part: the run of local characters just before "@", from `pos` on.
    let runStart = at
    while (runStart > pos && LOCAL.test(text[runStart - 1])) runStart--
    // The leftmost word boundary (\b) in it: where the old regex started.
    let start = -1
    for (let s = runStart; s < at; s++) {
      const before = s > 0 && WORD.test(text[s - 1])
      if (before !== WORD.test(text[s])) { start = s; break }
    }
    if (start < 0) continue
    DOMAIN_RE.lastIndex = at + 1
    const d = DOMAIN_RE.exec(text)
    if (d) return { index: start, text: text.slice(start, at + 1 + d[0].length) }
  }
  return null
}

/** The next URL/mailto match at or after `pos`. */
function nextLink(text: string, pos: number): Found | null {
  LINK_RE.lastIndex = pos
  const m = LINK_RE.exec(text)
  return m ? { index: m.index, text: m[0] } : null
}

/** Every match of the old URL_RE, in order, without overlaps. */
function* findLinks(text: string): Generator<Found> {
  let pos = 0
  let link: Found | null | undefined
  let email: Found | null | undefined
  while (pos <= text.length) {
    if (link === undefined || (link && link.index < pos)) link = nextLink(text, pos)
    if (email === undefined || (email && email.index < pos)) email = nextEmail(text, pos)
    const pick = link && (!email || link.index <= email.index) ? link : email
    if (!pick) return
    yield pick
    pos = pick.index + pick.text.length
  }
}

// Punctuation that usually ends the sentence, not the URL.
const TRAILING_CHARS = new Set(['.', ',', ';', ':', '!', '?', ')', ']', '}', "'", '"', '»', '”', '’'])

function trimTrailing(url: string): string {
  // By index: the old /[...]+$/ was quadratic on a long run of ")".
  let end = url.length
  while (end > 0 && TRAILING_CHARS.has(url[end - 1])) end--
  let out = url.slice(0, end)
  // Keep a closing bracket that has its opening one inside the URL (Wikipedia links).
  const opens = (url.match(/\(/g) || []).length
  if (opens && url.slice(out.length).startsWith(')') && (out.match(/\)/g) || []).length < opens) out += ')'
  return out
}

export function linkify(text: string): Segment[] {
  const out: Segment[] = []
  let last = 0
  for (const m of findLinks(text)) {
    const raw = m.text
    const url = raw.includes('@') && !/^(https?:|www\.|mailto:)/i.test(raw) ? raw : trimTrailing(raw)
    if (!url) continue
    const start = m.index
    if (start > last) out.push({ text: text.slice(last, start) })
    let href: string
    if (/^www\./i.test(url)) href = `https://${url}`
    else if (/^(https?|mailto):/i.test(url)) href = url
    else href = `mailto:${url}`
    out.push({ text: url, href })
    last = start + url.length
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out
}
