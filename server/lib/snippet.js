// Preview text ("snippet") for the message list.
//
// The list fetch only has envelopes and body structures, so the preview line
// under each subject was always empty. For each message we pick the part a
// reader would see first (text/plain, else text/html, never an attachment or
// the inside of an attached message), fetch only its first bytes, and decode
// them with mailparser so transfer encodings and charsets are handled exactly
// as when the message is opened.

import { simpleParser } from 'mailparser'
import { trimEndChar } from './trim.js'

/** Bytes fetched per message: enough for a line of preview text. */
export const SNIPPET_BYTES = 2048
const SNIPPET_CHARS = 200

/** The body part to preview, or null when the message has no readable text.
 * `part` is the IMAP section ("1" for a single-part message). */
export function previewPart(root) {
  let html = null
  const walk = (node) => {
    if (!node || typeof node !== 'object') return null
    const type = String(node.type || '').toLowerCase()
    if (type.startsWith('multipart/')) {
      for (const child of node.childNodes || []) {
        const found = walk(child)
        if (found) return found
      }
      return null
    }
    if (node.disposition === 'attachment' || node.dispositionParameters?.filename) return null
    if (type !== 'text/plain' && type !== 'text/html') return null
    const info = {
      part: node.part || '1',
      type,
      charset: node.parameters?.charset || '',
      encoding: String(node.encoding || '7bit').toLowerCase()
    }
    if (type === 'text/plain') return info
    if (!html) html = info
    return null
  }
  return walk(root) || html
}

/** A base64 or quoted-printable prefix cut at a point where it still decodes. */
function trimEncoded(buf, encoding) {
  let s = buf.toString('latin1')
  if (encoding === 'base64') {
    s = s.replace(/[^A-Za-z0-9+/=]/g, '')
    s = s.slice(0, s.length - (s.length % 4))
  } else if (encoding === 'quoted-printable') {
    s = s.replace(/=[0-9A-Fa-f]?$/, '')
  }
  return Buffer.from(s, 'latin1')
}

/** Preview text from the first bytes of a part described by `previewPart`. */
export async function snippetFromPart(bytes, info) {
  if (!bytes || !info) return ''
  const charset = info.charset ? `; charset="${info.charset.replace(/["\\\r\n]/g, '')}"` : ''
  const encoding = /^[a-z0-9-]+$/.test(info.encoding) ? info.encoding : '7bit'
  const head = `Content-Type: ${info.type}${charset}\r\nContent-Transfer-Encoding: ${encoding}\r\n\r\n`
  const parsed = await simpleParser(Buffer.concat([Buffer.from(head, 'latin1'), trimEncoded(bytes, encoding)]), {
    skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true
  })
  return cleanSnippet(parsed.text || '')
}

/** One line of preview: no quoted lines, no PGP armor, collapsed whitespace. */
export function cleanSnippet(text) {
  if (/-----BEGIN PGP MESSAGE-----/.test(text)) return ''
  const lines = String(text)
    .split(/\r?\n/)
    .filter((l) => !/^\s*>/.test(l))
  return Array.from(trimEndChar(lines.join(' '), '\uFFFD').replace(/\s+/g, ' ').trim())
    .slice(0, SNIPPET_CHARS)
    .join('')
}

/** Fill `snippet` on list entries. `items` is [{ entry, uid, bodyStructure }].
 * One FETCH per distinct section keeps it to a handful of round trips. A
 * failure only leaves previews empty; it never fails the list. */
export async function addSnippets(client, items) {
  const groups = new Map()
  for (const it of items) {
    const info = previewPart(it.bodyStructure)
    if (!info || !it.uid) continue
    it.info = info
    if (!groups.has(info.part)) groups.set(info.part, [])
    groups.get(info.part).push(it)
  }
  for (const [part, group] of groups) {
    const byUid = new Map(group.map((it) => [it.uid, it]))
    try {
      const result = client.fetch(
        [...byUid.keys()].join(','),
        { uid: true, bodyParts: [{ key: part, maxLength: SNIPPET_BYTES }] },
        { uid: true }
      )
      for await (const msg of result) {
        const it = byUid.get(msg.uid)
        if (!it || !msg.bodyParts) continue
        const bytes = msg.bodyParts.get(part) ?? [...msg.bodyParts.values()][0]
        it.entry.snippet = await snippetFromPart(bytes, it.info).catch(() => '')
      }
    } catch (err) {
      console.error('Error fetching previews:', err.message)
    }
  }
}
