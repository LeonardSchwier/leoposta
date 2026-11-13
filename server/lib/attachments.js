// Received attachments: listing them and serving one for download.
//
// Ids. The message view lists attachments from mailparser, and the download
// route parses the same message source with the same helper, so an attachment's
// id is simply its index in `parsed.attachments`. Indexes cannot collide (file
// names can) and need no MIME part arithmetic. The list that comes with
// GET /api/messages only has the IMAP body structure, whose part numbers are not
// those ids, so its entries deliberately carry no `id`.

import { simpleParser } from 'mailparser'

const INDEX = /^(0|[1-9]\d{0,5})$/
const MAX_FILENAME_CHARS = 200
const FALLBACK_NAME = 'attachment'
const GENERIC_TYPE = 'application/octet-stream'

/** Parse a raw message. Pass the Buffer: converting it to a string first mangles
 * the bytes of 8bit and binary parts. */
export function parseMessageSource(source) {
  return simpleParser(source)
}

/** The attachments of a parsed message as the API shows them. */
export function listAttachments(attachments = []) {
  return attachments.map((att, index) => ({
    id: String(index),
    filename: att.filename || `${FALLBACK_NAME}-${index + 1}`,
    contentType: att.contentType || '',
    size: att.content?.length ?? att.size ?? 0,
    contentId: att.contentId || undefined
  }))
}

/** Attachments found inside a PGP-decrypted message are appended without an id:
 * their bytes exist only inside one decrypt call, so they cannot be downloaded
 * yet, and the client disables the button for an entry that has no id. */
export function mergePgpAttachments(attachments, pgpAttachments = []) {
  const known = new Set(attachments.map((a) => a.filename))
  const extra = pgpAttachments
    .filter((p) => !known.has(p.filename))
    .map(({ id, ...rest }) => rest)
  return [...attachments, ...extra]
}

/** The attachment a client asked for, or null for any id that is not an
 * in-range index. */
export function attachmentAt(attachments, id) {
  if (typeof id !== 'string' || !INDEX.test(id)) return null
  return attachments[Number(id)] ?? null
}

/** Attachments seen in an ImapFlow body structure, for the message list. Matches
 * what mailparser reports for the opened message (named parts, parts marked as
 * attachments, attached messages) without looking inside an attached message.
 * No ids: see the note at the top of this file. */
export function bodyStructureAttachments(root) {
  const found = []
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    const type = String(node.type || '')
    if (type.startsWith('multipart/')) {
      for (const child of node.childNodes || []) walk(child)
      return
    }
    const filename = node.dispositionParameters?.filename || node.parameters?.name
    if (filename || node.disposition === 'attachment' || type === 'message/rfc822') {
      found.push({
        filename: filename || FALLBACK_NAME,
        contentType: type,
        size: node.size || 0,
        contentId: node.id || undefined
      })
    }
  }
  walk(root)
  return found
}

/** A file name that is safe to put in a header and to offer to a browser. */
function safeFilename(name) {
  const cleaned = String(name ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]/g, '_')
    .trim()
  const bounded = Array.from(cleaned).slice(0, MAX_FILENAME_CHARS).join('')
  return bounded || FALLBACK_NAME
}

/** `Content-Disposition` for a download: a quoted ASCII name that older clients
 * read, plus the exact name as RFC 5987 `filename*` when it is not plain ASCII.
 * (encodeURIComponent in the quoted name shows "%C3%BC" to the user, and a CR or
 * LF in the name makes Node refuse to set the header.) */
export function contentDispositionHeader(name) {
  const filename = safeFilename(name)
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  if (ascii === filename) return `attachment; filename="${ascii}"`
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  )
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

/** The declared media type when it is a plain type/subtype, else a generic one.
 * The bytes come from a stranger, so nothing but a token pair is echoed back. */
export function safeContentType(value) {
  if (typeof value !== 'string') return GENERIC_TYPE
  const base = value.split(';')[0].trim().toLowerCase()
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(base) ? base : GENERIC_TYPE
}
