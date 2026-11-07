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
    const um = raw.match(/^\s*UID:([^\r\n]+)/im)
    const uid = um ? um[1].trim() : `leoposta_${Date.now()}_${cards.length}`
    cards.push({ uid, raw: raw + '\r\nEND:VCARD\r\n' })
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
