import { MailActionError, moveChecked } from './removal.js'
import { parseMessageSource } from './attachments.js'
import { safeRegexTest } from './safeRegex.js'

const FIELDS = ['from', 'to', 'cc', 'subject', 'body', 'folder']

function getField(msg, field) {
  switch (field) {
    case 'from': return msg.fromAddress || msg.from || ''
    case 'to': return (msg.to || []).join('; ')
    case 'cc': return (msg.cc || []).join('; ')
    case 'subject': return msg.subject || ''
    case 'body': return msg.body || ''
    case 'folder': return msg.folder || ''
    default: return ''
  }
}

export function matchRule(msg, rule) {
  // Not a rule object: matches nothing (a hand-edited rules.json must not take
  // the message list down).
  if (!rule || typeof rule !== 'object') return false
  const conditions = rule.conditions === undefined ? [] : rule.conditions
  if (!Array.isArray(conditions)) return false
  for (const c of conditions) {
    if (!c || typeof c !== 'object') return false
    const actual = getField(msg, c.field).toLowerCase()
    const value = String(c.value ?? '').toLowerCase()
    switch (c.operator) {
      case 'contains': if (!actual.includes(value)) return false; break
      case 'not_contains': if (actual.includes(value)) return false; break
      case 'equals': if (actual !== value) return false; break
      case 'not_equals': if (actual === value) return false; break
      case 'starts_with': if (!actual.startsWith(value)) return false; break
      case 'ends_with': if (!actual.endsWith(value)) return false; break
      case 'regex':
        // Bounded: a backtracking pattern must not freeze the server.
        if (!safeRegexTest(String(c.value ?? ''), getField(msg, c.field))) return false
        break
      default: return false
    }
  }
  return true
}

// ── Running rules on new mail ───────────────────────────────────────────────
//
// Rules act on the server, so the result is the same in every mail client:
// "move" is an IMAP MOVE, "flag" adds \Flagged, "label" adds an IMAP keyword.
// They run on mail that is new in INBOX: each account keeps a cursor (the
// highest INBOX UID the rules have seen, with the mailbox's UIDVALIDITY), so a
// message the user moves back to INBOX is not moved again, and creating a rule
// does not reshuffle mail that was already there.

// An IMAP keyword: an atom without the characters that would end it.
export const KEYWORD = /^[A-Za-z0-9$_.-]{1,64}$/

function addresses(list) {
  return (list || []).map((a) => a && a.address).filter(Boolean)
}

/** The fields a rule condition can look at, from an ImapFlow FETCH result. */
function ruleView(msg, body) {
  const from = msg.envelope?.from?.[0] || {}
  return {
    from: from.name || from.address || '',
    fromAddress: from.address || '',
    to: addresses(msg.envelope?.to),
    cc: addresses(msg.envelope?.cc),
    subject: msg.envelope?.subject || '',
    body,
    folder: 'INBOX'
  }
}

/** Perform one rule's action on a message by UID in the selected mailbox. */
async function act(client, uid, action) {
  if (action.type === 'move') {
    if (!action.value) return null
    await moveChecked(client, uid, action.value)
    return { uid, moved: action.value }
  }
  if (action.type === 'flag') {
    if ((await client.messageFlagsAdd(uid, ['\\Flagged'], { uid: true })) === false) {
      throw new MailActionError('The server refused to flag the message')
    }
    return { uid, flagged: true }
  }
  if (action.type === 'label') {
    if (!KEYWORD.test(action.value || '')) return null
    if ((await client.messageFlagsAdd(uid, [action.value], { uid: true })) === false) {
      throw new MailActionError(`The server refused to add the label ${action.value}`)
    }
    return { uid, label: action.value }
  }
  return null
}

/**
 * Apply the enabled rules to the mail that arrived in the selected INBOX since
 * the last run. `cursors` maps account key → { uidValidity, lastUid } and is
 * updated in place; `save` persists it. The first matching rule wins. A rule
 * that fails (unknown target folder, refused MOVE) is logged and skipped: it
 * must not keep the user from reading the Inbox. Returns what was done.
 */
export async function runRulesOnNewMail(client, { key, rules, cursors, save }) {
  const mailbox = client.mailbox || {}
  const uidValidity = String(mailbox.uidValidity ?? '')
  const exists = mailbox.exists || 0
  const cur = cursors[key]

  if (!cur || cur.uidValidity !== uidValidity) {
    // First run for this mailbox (or it was recreated): only mail from now on is new.
    let top = 0
    if (exists > 0) {
      for await (const m of client.fetch('*', { uid: true })) top = Math.max(top, m.uid || 0)
    }
    cursors[key] = { uidValidity, lastUid: top }
    save()
    return []
  }
  if (exists === 0) return []

  const enabled = (rules || []).filter((r) => r && r.enabled && r.action)
  const needBody = enabled.some((r) => (r.conditions || []).some((c) => c.field === 'body'))
  const fresh = []
  // "n:*" also returns the last message when nothing is newer than n.
  for await (const m of client.fetch(`${cur.lastUid + 1}:*`, { uid: true, envelope: true, source: needBody }, { uid: true })) {
    if (m.uid > cur.lastUid) fresh.push(m)
  }
  if (fresh.length === 0) return []

  const done = []
  for (const m of fresh.sort((a, b) => a.uid - b.uid)) {
    if (enabled.length > 0) {
      let body = ''
      if (needBody && m.source) {
        try { body = (await parseMessageSource(m.source)).text || '' } catch { body = '' }
      }
      const view = ruleView(m, body)
      const rule = enabled.find((r) => matchRule(view, r))
      if (rule) {
        try {
          const r = await act(client, m.uid, rule.action)
          if (r) done.push(r)
        } catch (err) {
          if (!(err instanceof MailActionError)) {
            // The connection broke: keep this message for the next run.
            cur.lastUid = Math.max(cur.lastUid, m.uid - 1)
            save()
            throw err
          }
          console.error(`[rules] ${rule.action.type} for uid ${m.uid} failed: ${err.message}`)
        }
      }
    }
    cur.lastUid = Math.max(cur.lastUid, m.uid)
  }
  save()
  return done
}
