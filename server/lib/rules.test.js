import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchRule, runRulesOnNewMail } from './rules.js'

const msg = {
  id: '1',
  from: 'Alice',
  fromAddress: 'alice@example.com',
  to: ['me@example.com'],
  cc: [],
  subject: 'Urgent: Q3 Report',
  body: 'Please review the attached report',
  bodyHtml: '<p>Please review the attached report</p>',
  flags: [],
  folder: 'INBOX',
  labels: []
}

// --- matchRule ---

test('matchRule: contains from', () => {
  const rule = { conditions: [{ field: 'from', operator: 'contains', value: 'alice' }] }
  assert.equal(matchRule(msg, rule), true)
})

test('matchRule: contains from (case-insensitive)', () => {
  const rule = { conditions: [{ field: 'from', operator: 'contains', value: 'ALICE' }] }
  assert.equal(matchRule(msg, rule), true)
})

test('matchRule: contains from (no match)', () => {
  const rule = { conditions: [{ field: 'from', operator: 'contains', value: 'bob' }] }
  assert.equal(matchRule(msg, rule), false)
})

test('matchRule: equals subject (case-insensitive)', () => {
  const rule = { conditions: [{ field: 'subject', operator: 'equals', value: 'URGENT: Q3 REPORT' }] }
  assert.equal(matchRule(msg, rule), true)
})

test('matchRule: starts_with', () => {
  assert.equal(matchRule(msg, { conditions: [{ field: 'subject', operator: 'starts_with', value: 'urgent' }] }), true)
  assert.equal(matchRule(msg, { conditions: [{ field: 'subject', operator: 'starts_with', value: 'q3' }] }), false)
})

test('matchRule: ends_with', () => {
  assert.equal(matchRule(msg, { conditions: [{ field: 'subject', operator: 'ends_with', value: 'report' }] }), true)
  assert.equal(matchRule(msg, { conditions: [{ field: 'subject', operator: 'ends_with', value: 'urgent' }] }), false)
})

test('matchRule: regex', () => {
  assert.equal(matchRule(msg, { conditions: [{ field: 'subject', operator: 'regex', value: '^Urgent.*Report$' }] }), true)
  assert.equal(matchRule(msg, { conditions: [{ field: 'subject', operator: 'regex', value: '^zzz$' }] }), false)
})

test('matchRule: invalid regex does not match', () => {
  assert.equal(matchRule(msg, { conditions: [{ field: 'subject', operator: 'regex', value: '[broken' }] }), false)
})

test('matchRule: to field', () => {
  assert.equal(matchRule(msg, { conditions: [{ field: 'to', operator: 'contains', value: 'me@example.com' }] }), true)
  assert.equal(matchRule(msg, { conditions: [{ field: 'to', operator: 'contains', value: 'other@example.com' }] }), false)
})

test('matchRule: body field', () => {
  assert.equal(matchRule(msg, { conditions: [{ field: 'body', operator: 'contains', value: 'attached' }] }), true)
  assert.equal(matchRule(msg, { conditions: [{ field: 'body', operator: 'contains', value: 'not in body' }] }), false)
})

test('matchRule: multiple conditions (AND)', () => {
  const rule = { conditions: [
    { field: 'from', operator: 'contains', value: 'alice' },
    { field: 'subject', operator: 'contains', value: 'report' }
  ]}
  assert.equal(matchRule(msg, rule), true)
  const bad = { conditions: [
    { field: 'from', operator: 'contains', value: 'alice' },
    { field: 'subject', operator: 'contains', value: 'nonexistent' }
  ]}
  assert.equal(matchRule(msg, bad), false)
})

// --- runRulesOnNewMail: rules act on the server, on new Inbox mail ---

/** A fake ImapFlow client with INBOX selected. Follows ImapFlow 1.7.8: fetch by
 * UID range "n:*" also yields the last message when none is newer, and the
 * flag calls resolve false when the server refuses. */
function inbox(messages, { uidValidity = 7n, capabilities = ['MOVE'], refuseMove = false } = {}) {
  const calls = []
  const all = messages.map((m) => ({
    uid: m.uid,
    envelope: {
      subject: m.subject || '',
      from: [{ name: m.name || '', address: m.from || 'x@example.test' }],
      to: [{ address: 'me@example.test' }],
      cc: []
    },
    source: Buffer.from(`Subject: ${m.subject || ''}\r\nContent-Type: text/plain\r\n\r\n${m.body || ''}`)
  }))
  return {
    calls,
    capabilities: new Set(capabilities),
    mailbox: { path: 'INBOX', uidValidity, get exists() { return all.length } },
    fetch(range, query, opts) {
      calls.push(['fetch', range, Object.keys(query).filter((k) => query[k]).sort().join(','), opts])
      let out
      if (range === '*') out = all.slice(-1)
      else {
        const lo = Number(range.split(':')[0])
        out = all.filter((m) => m.uid >= lo)
        if (out.length === 0 && all.length) out = all.slice(-1)
      }
      return (async function* () { for (const m of out) yield { ...m, source: query.source ? m.source : undefined } })()
    },
    async messageMove(uid, dest) {
      calls.push(['messageMove', uid, dest])
      if (refuseMove) return false
      all.splice(all.findIndex((m) => m.uid === uid), 1)
      return { destination: dest }
    },
    async messageFlagsAdd(uid, flags) { calls.push(['messageFlagsAdd', uid, flags]); return true }
  }
}

function run(client, rules, cursors) {
  let saves = 0
  const p = runRulesOnNewMail(client, { key: 'me@example.test', rules, cursors, save: () => { saves++ } })
  return p.then((done) => ({ done, saves }))
}
const fromAcme = (action) => [{ enabled: true, conditions: [{ field: 'from', operator: 'contains', value: 'acme' }], action }]

test('runRules: the first run only records where new mail starts; nothing already there is touched', async () => {
  const c = inbox([{ uid: 3, from: 'bill@acme.test' }, { uid: 8, from: 'bill@acme.test' }])
  const cursors = {}
  const { done, saves } = await run(c, fromAcme({ type: 'move', value: 'Receipts' }), cursors)
  assert.deepEqual(done, [])
  assert.deepEqual(cursors['me@example.test'], { uidValidity: '7', lastUid: 8 })
  assert.equal(saves, 1)
  assert.ok(!c.calls.some((x) => x[0] === 'messageMove'))
})

test('runRules: a matching new message is MOVEd on the server; others stay', async () => {
  const c = inbox([{ uid: 8, from: 'old@acme.test' }, { uid: 9, from: 'bill@acme.test' }, { uid: 10, from: 'friend@example.test' }])
  const cursors = { 'me@example.test': { uidValidity: '7', lastUid: 8 } }
  const { done } = await run(c, fromAcme({ type: 'move', value: 'Receipts' }), cursors)
  assert.deepEqual(done, [{ uid: 9, moved: 'Receipts' }])
  assert.deepEqual(c.calls.filter((x) => x[0] === 'messageMove'), [['messageMove', 9, 'Receipts']])
  assert.equal(cursors['me@example.test'].lastUid, 10)
  assert.deepEqual(c.calls[0].slice(1, 2), ['9:*'], 'only mail after the cursor is fetched')
})

test('runRules: a message seen once is not processed again (moved back to INBOX by the user)', async () => {
  const c = inbox([{ uid: 9, from: 'bill@acme.test' }])
  const cursors = { 'me@example.test': { uidValidity: '7', lastUid: 9 } }
  const { done } = await run(c, fromAcme({ type: 'move', value: 'Receipts' }), cursors)
  assert.deepEqual(done, [])
  assert.ok(!c.calls.some((x) => x[0] === 'messageMove'), '"9+1:*" returning uid 9 again must be ignored')
})

test('runRules: flag adds \\Flagged on the server (not a made-up "starred" flag)', async () => {
  const c = inbox([{ uid: 2, from: 'bill@acme.test' }])
  const { done } = await run(c, fromAcme({ type: 'flag' }), { 'me@example.test': { uidValidity: '7', lastUid: 1 } })
  assert.deepEqual(done, [{ uid: 2, flagged: true }])
  assert.deepEqual(c.calls.find((x) => x[0] === 'messageFlagsAdd'), ['messageFlagsAdd', 2, ['\\Flagged']])
})

test('runRules: label adds an IMAP keyword; a label that is not a valid keyword does nothing', async () => {
  const c = inbox([{ uid: 2, from: 'bill@acme.test' }, { uid: 3, from: 'bob@acme.test' }])
  const cursors = { 'me@example.test': { uidValidity: '7', lastUid: 1 } }
  await run(c, fromAcme({ type: 'label', value: 'Work' }), cursors)
  assert.deepEqual(c.calls.filter((x) => x[0] === 'messageFlagsAdd').map((x) => x.slice(1)), [[2, ['Work']], [3, ['Work']]])
  const d = inbox([{ uid: 2, from: 'bill@acme.test' }])
  await run(d, fromAcme({ type: 'label', value: 'two words' }), { 'me@example.test': { uidValidity: '7', lastUid: 1 } })
  assert.ok(!d.calls.some((x) => x[0] === 'messageFlagsAdd'))
})

test('runRules: disabled rules do nothing; the first matching rule wins', async () => {
  const c = inbox([{ uid: 2, from: 'bill@acme.test' }])
  const rules = [
    { enabled: false, conditions: [], action: { type: 'move', value: 'Nope' } },
    { enabled: true, conditions: [], action: { type: 'flag' } },
    { enabled: true, conditions: [], action: { type: 'move', value: 'Archive' } }
  ]
  const { done } = await run(c, rules, { 'me@example.test': { uidValidity: '7', lastUid: 1 } })
  assert.deepEqual(done, [{ uid: 2, flagged: true }])
  assert.ok(!c.calls.some((x) => x[0] === 'messageMove'))
})

test('runRules: body conditions read the message text (fetched only when a rule needs it)', async () => {
  const c = inbox([{ uid: 2, body: 'your invoice is attached' }, { uid: 3, body: 'hello' }])
  const rules = [{ enabled: true, conditions: [{ field: 'body', operator: 'contains', value: 'invoice' }], action: { type: 'move', value: 'Bills' } }]
  const { done } = await run(c, rules, { 'me@example.test': { uidValidity: '7', lastUid: 1 } })
  assert.deepEqual(done, [{ uid: 2, moved: 'Bills' }])
  assert.match(c.calls[0][2], /source/)
  const d = inbox([{ uid: 2, from: 'bill@acme.test' }])
  await run(d, fromAcme({ type: 'flag' }), { 'me@example.test': { uidValidity: '7', lastUid: 1 } })
  assert.doesNotMatch(d.calls[0][2], /source/)
})

test('runRules: a refused move is logged and skipped; the Inbox still lists and the cursor moves on', async () => {
  const c = inbox([{ uid: 2, from: 'bill@acme.test' }], { refuseMove: true })
  const cursors = { 'me@example.test': { uidValidity: '7', lastUid: 1 } }
  const { done } = await run(c, fromAcme({ type: 'move', value: 'Missing' }), cursors)
  assert.deepEqual(done, [])
  assert.equal(cursors['me@example.test'].lastUid, 2)
})

test('runRules: a new UIDVALIDITY (mailbox recreated) starts over instead of using stale UIDs', async () => {
  const c = inbox([{ uid: 1, from: 'bill@acme.test' }], { uidValidity: 99n })
  const cursors = { 'me@example.test': { uidValidity: '7', lastUid: 500 } }
  const { done } = await run(c, fromAcme({ type: 'move', value: 'Receipts' }), cursors)
  assert.deepEqual(done, [])
  assert.deepEqual(cursors['me@example.test'], { uidValidity: '99', lastUid: 1 })
})

test('runRules: with no rules the cursor still advances, so a rule created later only sees later mail', async () => {
  const c = inbox([{ uid: 4 }, { uid: 5 }])
  const cursors = { 'me@example.test': { uidValidity: '7', lastUid: 3 } }
  await run(c, [], cursors)
  assert.equal(cursors['me@example.test'].lastUid, 5)
})
