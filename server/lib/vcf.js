import { unfoldLines, parseProperty, unescapeText } from './ics.js'

// Pure RFC 6350 vCard 3.0/4.0 parsing + validation helpers for
// /api/contacts/import and PUT /api/contact. No network, no I/O.

export const MAX_CARD_BYTES = 64 * 1024
export const MAX_CARDS_PER_IMPORT = 500

// Splits a vCard blob (text/vcard) into individual cards, validates each,
// and returns { cards, errors }.
//   cards:  Array<{ uid: string, raw: string }>  — usable cards (uid is the
//             card's own UID if present, otherwise a synthesized
//             `leoposta_<ts>_<idx>` id)
//   errors: string[] — per-reason rejection messages; empty if every card
//             is valid. An empty array for `cards` with a non-empty
//             `errors` means "reject the entire import / PUT".
export function parseVcf(blob) {
  const text = typeof blob === 'string' ? blob : String(blob ?? '')
  if (!text || !text.includes('BEGIN:VCARD')) {
    return { cards: [], errors: ['no cards found (empty or malformed vCard blob)'] }
  }

  // Walk the blob finding each BEGIN:VCARD…END:VCARD span in order. Any
  // junk between one card's END:VCARD and the next card's BEGIN:VCARD is
  // simply skipped (we jump directly to each BEGIN marker).
  const beginRe = /BEGIN:[ \t]*VCARD/gi
  const endRe = /END:[ \t]*VCARD/gi
  const cards = []
  const errors = []
  let cursor = 0
  while (cursor < text.length) {
    const beginM = beginRe.exec(text)
    if (!beginM || beginM.index < cursor) break
    const beginIdx = beginM.index
    endRe.lastIndex = beginIdx
    const endM = endRe.exec(text)
    if (!endM) {
      errors.push(`card #${cards.length + errors.length + 1}: unterminated (no END:VCARD)`)
      break
    }
    const spanEnd = endM.index + endM[0].length
    const raw = text.slice(beginIdx, spanEnd).trim()
    cursor = spanEnd
    if (!raw) continue
    if (!/^[ \t]*BEGIN:[ \t]*VCARD/.test(raw)) {
      errors.push(`card #${cards.length + errors.length + 1}: does not start with BEGIN:VCARD`)
      continue
    }
    const hasVersion = /(?:^|\r?\n)VERSION:[^\r\n]*/i.test(raw)
    if (!hasVersion) {
      errors.push(`card #${cards.length + errors.length + 1}: missing required VERSION line`)
      continue
    }
    if (Buffer.byteLength(raw, 'utf8') > MAX_CARD_BYTES) {
      errors.push(`card #${cards.length + errors.length + 1}: too large (${Buffer.byteLength(raw, 'utf8')} > ${MAX_CARD_BYTES} bytes)`)
      continue
    }
    const um = raw.replace(/\r?\n[ \t]/g, '').match(/^\s*(?:[\w-]+\.)?UID(?:;[^:\r\n]*)?:([^\r\n]+)/im)
    const uid = um ? um[1].trim().replace(/^urn:uuid:/i, '') : `leoposta_${Date.now()}_${cards.length}`
    // `raw` already ends with END:VCARD. Normalise to CRLF and give a card
    // without a UID the one we use for its file name (servers require one).
    let card = raw.replace(/\r?\n/g, '\r\n')
    if (!um) card = card.replace(/^(BEGIN:[ \t]*VCARD\r\n)/i, `$1UID:${uid}\r\n`)
    cards.push({ uid, raw: card + '\r\n' })
  }

  if (cards.length > MAX_CARDS_PER_IMPORT) {
    errors.push(`too many cards (${cards.length} > ${MAX_CARDS_PER_IMPORT})`)
    // Keep the first MAX_CARDS_PER_IMPORT cards so the caller can still
    // accept a truncated import if it prefers to; the error is surfaced
    // for the UI to report. (Callers that require zero-error semantics
    // will return 400 before ever iterating `cards`.)
    return { cards: cards.slice(0, MAX_CARDS_PER_IMPORT), errors }
  }
  return { cards, errors }
}

// ── Reading a card for the contact list ─────────────────────────────────────

/**
 * The fields the Contacts view and recipient autocomplete show, from one
 * vCard 3.0/4.0: folded lines, group prefixes (item1.EMAIL), parameters,
 * escapes and vCard 4 URI values (TEL:tel:+49…) handled.
 */
export function parseCard(vcf) {
  const c = { uid: '', name: '', emails: [], phones: [], org: '', notes: '', website: '', address: '' }
  let n = ''
  for (const line of unfoldLines(vcf)) {
    const p = parseProperty(line)
    if (!p) continue
    const v = p.value
    switch (p.name) {
      case 'UID': c.uid = v.trim().replace(/^urn:uuid:/i, ''); break
      case 'FN': c.name = unescapeText(v).trim(); break
      case 'N': n = v.split(';').map(unescapeText).map(x => x.trim()); break
      case 'EMAIL': if (v.trim()) c.emails.push(v.trim().replace(/^mailto:/i, '')); break
      case 'TEL': if (v.trim()) c.phones.push(v.trim().replace(/^tel:/i, '')); break
      case 'ORG': c.org = unescapeText(v.split(/(?<!\\);/)[0]).trim(); break
      case 'NOTE': c.notes = unescapeText(v).trim(); break
      case 'URL': if (!c.website) c.website = v.trim(); break
      case 'ADR':
        if (!c.address) c.address = v.split(/(?<!\\);/).map(unescapeText).map(x => x.trim()).filter(Boolean).join(', ')
        break
    }
  }
  if (!c.name && Array.isArray(n)) c.name = [n[3], n[1], n[2], n[0], n[4]].filter(Boolean).join(' ')
  return { ...c, email: c.emails[0] || '', phone: c.phones[0] || '' }
}
