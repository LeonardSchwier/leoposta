/**
 * Plain-text bodies as text and link segments. The segments are rendered by
 * Svelte as text nodes and <a> elements, never as HTML, so a body cannot
 * inject markup; only http(s), www. and mailto: become links.
 */
export type Segment = { text: string; href?: string }

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+|\bmailto:[^\s<>"']+|\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gi
// Punctuation that usually ends the sentence, not the URL.
const TRAILING = /[.,;:!?)\]}'"»”’]+$/

function trimTrailing(url: string): string {
  let out = url.replace(TRAILING, '')
  // Keep a closing bracket that has its opening one inside the URL (Wikipedia links).
  const opens = (url.match(/\(/g) || []).length
  if (opens && url.slice(out.length).startsWith(')') && (out.match(/\)/g) || []).length < opens) out += ')'
  return out
}

export function linkify(text: string): Segment[] {
  const out: Segment[] = []
  let last = 0
  for (const m of text.matchAll(URL_RE)) {
    const raw = m[0]
    const url = raw.includes('@') && !/^(https?:|www\.|mailto:)/i.test(raw) ? raw : trimTrailing(raw)
    if (!url) continue
    const start = m.index ?? 0
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
