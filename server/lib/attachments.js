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
export async function parseMessageSource(source) {
  const parsed = await simpleParser(source)
  if (parsed.text || parsed.html || parsed.attachments?.length) return parsed
  const repaired = Buffer.isBuffer(source) ? repairBoundary(source) : null
  return repaired ? simpleParser(repaired) : parsed
}

/** A multipart message whose parts use another delimiter than the declared
 * boundary parses as all preamble: nothing to show. If the body opens with a
 * delimiter line, return the source with that boundary declared instead. */
export function repairBoundary(source) {
  const text = source.toString('latin1')
  const m = /\r?\n\r?\n/.exec(text)
  if (!m) return null
  const head = text.slice(0, m.index)
  const ct = /^content-type:[^\n]*(?:\r?\n[ \t][^\n]*)*/im.exec(head)
  if (!ct || !/^content-type:\s*multipart\//i.test(ct[0])) return null
  const declared = /boundary\s*=\s*(?:"([^"]*)"|([^\s;]+))/i.exec(ct[0])
  if (!declared) return null
  const used = /^--([^\r\n]{1,200}?)[ \t]*\r?$/m.exec(text.slice(m.index + m[0].length))
  const boundary = used?.[1].replace(/--$/, '')
  if (!boundary || boundary === (declared[1] ?? declared[2]) || boundary.includes('"')) return null
  const fixedCt = ct[0].replace(declared[0], `boundary="${boundary}"`)
  const fixedHead = head.slice(0, ct.index) + fixedCt + head.slice(ct.index + ct[0].length)
  return Buffer.concat([Buffer.from(fixedHead, 'latin1'), source.subarray(Buffer.byteLength(head, 'latin1'))])
}

/** An image embedded in the HTML body (multipart/related with a Content-ID):
 * mailparser already inlines it as a data: URI, so it is part of the body and
 * not a file the user was sent. */
function isEmbedded(att) {
  return att.related === true && !!att.contentId && att.contentDisposition !== 'attachment'
}

/** The attachments of a parsed message as the API shows them. Ids stay the
 * index in `parsed.attachments`; embedded images are marked `inline`. */
export function listAttachments(attachments = []) {
  return attachments.map((att, index) => ({
    id: String(index),
    filename: att.filename || `${FALLBACK_NAME}-${index + 1}`,
    contentType: att.contentType || '',
    size: att.content?.length ?? att.size ?? 0,
    contentId: att.contentId || undefined,
    ...(isEmbedded(att) ? { inline: true } : {})
  }))
}

/** Attachments found inside a PGP-decrypted message are appended with the id
 * "pgp-<n>" (their index in the decrypted message): the download route
 * decrypts again to serve them, so the plaintext is never stored. */
export function mergePgpAttachments(attachments, pgpAttachments = []) {
  const known = new Set(attachments.map((a) => a.filename))
  const extra = pgpAttachments
    .map((p, i) => ({ ...p, id: `pgp-${i}` }))
    .filter((p) => !known.has(p.filename))
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
  const walk = (node, inRelated = false) => {
    if (!node || typeof node !== 'object') return
    const type = String(node.type || '')
    if (type.startsWith('multipart/')) {
      for (const child of node.childNodes || []) walk(child, type === 'multipart/related')
      return
    }
    // An image embedded in the HTML body is not a file the user was sent.
    if (inRelated && node.id && node.disposition !== 'attachment') return
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
    // A lone surrogate (a broken encoded-word) makes encodeURIComponent throw.
    .toWellFormed()
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    // Bidi controls reorder what the user reads ("exe.pdf" shown as "fdp.exe").
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
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
