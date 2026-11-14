/**
 * Reply, Reply All and Forward: who the answer goes to, its subject, the
 * quoted original and the threading headers. Pure functions; the store
 * wiring is `startReply` at the bottom.
 */
import type { MailMessage } from '../store'
import { getState, clearCompose, setComposeTo, setComposeCc, setComposeSubject, setComposeReplyTo, setComposeForward, setComposeOriginalMessage, setComposing } from '../store'
import { recipientAddress } from './recipients'
import { AccountAPI } from '../api'

export type ReplyMode = 'reply' | 'replyAll' | 'forward'

/** The fields of the original a reply needs (what /api/message/:id returns). */
export type Original = Pick<MailMessage, 'id' | 'from' | 'to' | 'subject' | 'body' | 'date'> &
  Partial<Pick<MailMessage, 'fromAddress' | 'cc' | 'bodyHtml' | 'messageId' | 'references' | 'replyTo' | 'attachments' | 'folder'>>

const PREFIX = { reply: 'Re:', replyAll: 'Re:', forward: 'Fwd:' } as const

/** "Re: x" / "Fwd: x", without stacking prefixes the subject already has. */
export function prefixSubject(subject: string, mode: ReplyMode): string {
  const s = (subject || '').trim()
  const already = mode === 'forward' ? /^(fwd?|wg):/i : /^(re|aw):/i
  return already.test(s) ? s : `${PREFIX[mode]} ${s}`.trim()
}

/** `Name <addr>`, the name quoted when it holds characters that would split it. */
export function formatAddress(name: string | undefined, address: string): string {
  const n = (name || '').trim()
  if (!n || n.toLowerCase() === address.toLowerCase()) return address
  return /[",;<>@()[\]\\:]/.test(n) ? `"${n.replace(/(["\\])/g, '\\$1')}" <${address}>` : `${n} <${address}>`
}

/** Recipients of a reply. Reply goes to Reply-To (else the sender); Reply All
 * also goes to every To and Cc of the original, except our own addresses and
 * duplicates. A reply to a mail we sent ourselves goes to its recipients. */
export function replyRecipients(msg: Original, mode: ReplyMode, own: string[]): { to: string[]; cc: string[] } {
  if (mode === 'forward') return { to: [], cc: [] }
  const mine = new Set(own.map((a) => a.toLowerCase()))
  const seen = new Set<string>()
  const take = (list: string[]) => list.filter((r) => {
    const a = recipientAddress(r).toLowerCase()
    if (!a || mine.has(a) || seen.has(a)) return false
    seen.add(a)
    return true
  })
  const senderAddr = msg.fromAddress || recipientAddress(msg.from || '')
  const sender = msg.replyTo && msg.replyTo.length ? msg.replyTo : [formatAddress(msg.from, senderAddr)]
  const fromMe = mine.has(senderAddr.toLowerCase())
  const to = take(fromMe ? [...(msg.to || [])] : sender)
  if (mode === 'reply') {
    // Our own mail: reply to its first recipient, like other mail clients.
    return { to: fromMe ? to.slice(0, 1) : to, cc: [] }
  }
  const moreTo = take(fromMe ? [] : [...(msg.to || [])])
  const cc = take([...(msg.cc || [])])
  return { to: [...to, ...moreTo], cc }
}

/** Plain text of an HTML body, for quoting a mail that has no text part. */
export function htmlToText(html: string): string {
  const doc = new DOMParser().parseFromString(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<(p|div|h[1-6]|li|tr|blockquote)[\s>]/gi, '\n$&')
      .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, '$&\n'),
    'text/html'
  )
  doc.querySelectorAll('script, style, head').forEach((n) => n.remove())
  return (doc.body.textContent || '').replace(/\n{3,}/g, '\n\n').trim()
}

function originalText(msg: Original): string {
  const text = msg.body || (msg.bodyHtml ? htmlToText(msg.bodyHtml) : '')
  return text.replace(/\r\n/g, '\n').replace(/\s+$/, '')
}

function when(date: string): string {
  const d = new Date(date)
  return Number.isNaN(d.getTime()) ? date : d.toLocaleString()
}

/** The quoted original: "On <date>, <sender> wrote:" and "> " lines for a
 * reply; a "Forwarded message" header block and the text for a forward. */
export function quoteOriginal(msg: Original, mode: ReplyMode): string {
  const sender = formatAddress(msg.from, msg.fromAddress || recipientAddress(msg.from || ''))
  const text = originalText(msg)
  if (mode === 'forward') {
    const head = [
      '---------- Forwarded message ----------',
      `From: ${sender}`,
      `Date: ${when(msg.date)}`,
      `Subject: ${msg.subject || ''}`,
      `To: ${(msg.to || []).join(', ')}`
    ]
    if (msg.cc && msg.cc.length) head.push(`Cc: ${msg.cc.join(', ')}`)
    return head.join('\n') + '\n\n' + text
  }
  const quoted = text.split('\n').map((l) => (l.startsWith('>') ? '>' + l : l ? '> ' + l : '>')).join('\n')
  return `On ${when(msg.date)}, ${sender} wrote:\n${quoted}`
}

/** In-Reply-To / References for a reply (RFC 5322 3.6.4). None for a forward. */
export function threadHeaders(msg: Original, mode: ReplyMode): { inReplyTo?: string; references?: string } {
  if (mode === 'forward' || !msg.messageId) return {}
  const refs = [...(msg.references || []), msg.messageId].filter((r, i, a) => r && a.indexOf(r) === i)
  return { inReplyTo: msg.messageId, references: refs.join(' ') }
}

/** Our own addresses (every configured account), so Reply All leaves them out. */
async function ownAddresses(): Promise<string[]> {
  const known = getState().accounts.map((a) => a.email)
  if (known.length) return known
  try {
    const list = await AccountAPI.list()
    return Array.isArray(list) ? list.map((a: { email: string }) => a.email) : []
  } catch {
    return []
  }
}

/** Open the compose window as a reply / reply all / forward of `msg`. */
export async function startReply(msg: MailMessage, mode: ReplyMode) {
  const own = mode === 'forward' ? [] : await ownAddresses()
  const { to, cc } = replyRecipients(msg, mode, own)
  clearCompose()
  setComposeTo(to)
  setComposeCc(cc)
  setComposeSubject(prefixSubject(msg.subject, mode))
  setComposeReplyTo(mode === 'forward' ? null : msg.id)
  setComposeForward(mode === 'forward')
  setComposeOriginalMessage(msg)
  setComposing(true)
}
