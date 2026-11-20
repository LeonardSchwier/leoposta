import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import nodemailer from 'nodemailer'
import {
  classifySendError,
  isAmbiguousFailure,
  retryDelayMs,
  describeSendError,
  newMessageId,
  afterFailedAttempt,
  RETRY_GIVE_UP_MS,
  MAX_SEND_ATTEMPTS,
  MAX_AMBIGUOUS_ATTEMPTS
} from './sendRetry.js'

const MIN = 60_000
const HOUR = 60 * MIN
const err = (props, message = 'x') => Object.assign(new Error(message), props)

test('an SMTP reply code 4xx is transient, 5xx is permanent', () => {
  for (const responseCode of [400, 421, 450, 451, 452, 499]) {
    assert.equal(classifySendError(err({ responseCode })), 'transient', String(responseCode))
  }
  for (const responseCode of [500, 501, 503, 535, 550, 552, 554]) {
    assert.equal(classifySendError(err({ responseCode })), 'permanent', String(responseCode))
  }
})

test('connectivity errors are transient (nodemailer codes and raw system codes)', () => {
  for (const code of ['ECONNECTION', 'ESOCKET', 'ETIMEDOUT', 'EDNS']) {
    assert.equal(classifySendError(err({ code })), 'transient', code)
  }
  for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE']) {
    assert.equal(classifySendError(err({ code })), 'transient', code)
  }
  // nodemailer keeps the system code of a connection error in originalCode
  assert.equal(classifySendError(err({ code: 'ECONNECTION', originalCode: 'ECONNREFUSED' })), 'transient')
})

test('a reply code wins over the error code', () => {
  assert.equal(classifySendError(err({ code: 'EMESSAGE', responseCode: 451 })), 'transient')
  assert.equal(classifySendError(err({ code: 'EAUTH', responseCode: 454 })), 'transient')
  assert.equal(classifySendError(err({ code: 'ECONNECTION', responseCode: 550 })), 'permanent')
})

test('a certificate or TLS setup problem is permanent, also when nodemailer calls it a socket error', () => {
  for (const originalCode of ['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_SSL_WRONG_VERSION_NUMBER']) {
    assert.equal(classifySendError(err({ code: 'ESOCKET', originalCode })), 'permanent', originalCode)
  }
  // a failed STARTTLS is far more often a setup mismatch than a network blip
  assert.equal(classifySendError(err({ code: 'ETLS' })), 'permanent')
})

test('everything not known to be transient is permanent', () => {
  for (const code of ['EAUTH', 'ENOAUTH', 'EENVELOPE', 'EMESSAGE', 'ECONFIG', 'EREQUIRETLS', 'EPROTOCOL', 'ESTREAM', 'ETLS']) {
    assert.equal(classifySendError(err({ code })), 'permanent', code)
  }
  assert.equal(classifySendError(new Error('smtp down')), 'permanent')
  assert.equal(classifySendError(new Error('No account configured')), 'permanent')
  for (const value of [null, undefined, 'ECONNECTION', 42, {}, { code: 7 }, { responseCode: 'x' }]) {
    assert.equal(classifySendError(value), 'permanent', JSON.stringify(value))
  }
})

test('a failure that may have come after the server received the mail is told apart', () => {
  // timeouts, dropped connections and resets with no reply: the outcome is unknown
  for (const e of [
    err({ code: 'ETIMEDOUT' }),
    err({ code: 'ECONNECTION' }),
    err({ code: 'ESOCKET' }),
    err({ code: 'ESOCKET', originalCode: 'ECONNRESET' }),
    err({ code: 'EPIPE' })
  ]) {
    assert.equal(isAmbiguousFailure(e), true, `${e.code}/${e.originalCode}`)
  }
  // no connection was made, or the server answered "not now": nothing was delivered
  for (const e of [
    err({ code: 'EDNS' }),
    err({ code: 'ESOCKET', originalCode: 'ECONNREFUSED' }),
    err({ code: 'ESOCKET', originalCode: 'ENOTFOUND' }),
    err({ code: 'ECONNECTION', originalCode: 'EAI_AGAIN' }),
    err({ code: 'ESOCKET', originalCode: 'ENETUNREACH' }),
    err({ code: 'ESOCKET', originalCode: 'EHOSTUNREACH' }),
    err({ responseCode: 451 }),
    err({ code: 'ETIMEDOUT', responseCode: 421 })
  ]) {
    assert.equal(isAmbiguousFailure(e), false, `${e.code}/${e.originalCode}/${e.responseCode}`)
  }
  // not transient at all: not "ambiguous"
  for (const e of [err({ responseCode: 550 }), err({ code: 'EAUTH' }), new Error('x'), null]) {
    assert.equal(isAmbiguousFailure(e), false)
  }
})

// The real thing, not hand-made objects: what nodemailer 10 reports for a closed port and for
// a server that accepts the connection and hangs up.
test('real nodemailer errors: a closed port is transient and certain, a hang-up is transient and ambiguous', async () => {
  const closed = await new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port)) // a port nothing listens on any more
    })
  })
  const refused = await nodemailer
    .createTransport({ host: '127.0.0.1', port: closed, connectionTimeout: 3000 })
    .sendMail({ from: 'a@example.test', to: 'b@example.test', text: 'x' })
    .then(() => null, (e) => e)
  assert.ok(refused, 'sending to a closed port must fail')
  assert.equal(classifySendError(refused), 'transient', `${refused.code}/${refused.originalCode}`)
  assert.equal(isAmbiguousFailure(refused), false, 'nothing was connected, so nothing was delivered')

  const hangup = net.createServer((socket) => socket.destroy())
  await new Promise((resolve) => hangup.listen(0, '127.0.0.1', resolve))
  try {
    const dropped = await nodemailer
      .createTransport({ host: '127.0.0.1', port: hangup.address().port, connectionTimeout: 3000, greetingTimeout: 3000 })
      .sendMail({ from: 'a@example.test', to: 'b@example.test', text: 'x' })
      .then(() => null, (e) => e)
    assert.ok(dropped, 'a server that hangs up must fail the send')
    assert.equal(classifySendError(dropped), 'transient', `${dropped.code}/${dropped.originalCode}`)
    assert.equal(isAmbiguousFailure(dropped), true, 'a dropped connection may have come after DATA')
  } finally {
    hangup.close()
  }
})

test('the retry delay grows 1, 5, 15 minutes and then stays at an hour', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 20].map(retryDelayMs), [MIN, 5 * MIN, 15 * MIN, HOUR, HOUR, HOUR])
  assert.equal(retryDelayMs(0), MIN)
  assert.equal(retryDelayMs(-3), MIN)
  assert.equal(retryDelayMs(NaN), MIN)
})

test('the error text keeps the code, is one line, and is capped', () => {
  assert.equal(describeSendError(err({ code: 'EDNS' }, 'getaddrinfo EAI_AGAIN smtp.example.test')), 'EDNS: getaddrinfo EAI_AGAIN smtp.example.test')
  assert.equal(describeSendError(new Error('plain')), 'plain')
  assert.equal(describeSendError('just a string'), 'just a string')
  assert.equal(describeSendError(null), 'Unknown error')
  assert.equal(describeSendError(new Error('')), 'Unknown error')
  assert.equal(describeSendError(new Error('line one\r\nline two\n\nline three')), 'line one line two line three')
  const long = describeSendError(new Error('x'.repeat(5000)))
  assert.equal(long.length, 300)
  assert.ok(long.endsWith('…'))
  // a note is kept whole, the error text gives way to it
  const noted = describeSendError(new Error('x'.repeat(5000)), '(giving up)')
  assert.equal(noted.length, 300)
  assert.ok(noted.endsWith('… (giving up)'))
  assert.equal(describeSendError(new Error('short'), '(giving up)'), 'short (giving up)')
})

test('a Message-ID is unique and uses the sender domain, or localhost', () => {
  const a = newMessageId('erika@example.test')
  const b = newMessageId('erika@example.test')
  assert.match(a, /^<[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@example\.test>$/)
  assert.notEqual(a, b)
  for (const bad of [undefined, null, '', 'no-at-sign', 'a@', 'a@bad domain', 'a@x>y', 'a@<script>', 42]) {
    assert.match(newMessageId(bad), /@localhost>$/, String(bad))
  }
  assert.match(newMessageId('Erika@Example.TEST'), /@example\.test>$/)
  assert.match(newMessageId('erika@пример.test'), /@xn--e1afmkfd\.test>$/, 'an internationalised domain is sent as punycode')
})

test('a transient failure keeps the message pending and says when to try again', () => {
  const now = Date.parse('2026-11-20T08:00:10Z')
  const patch = afterFailedAttempt({ scheduled: '2026-11-20T08:00:00Z' }, err({ code: 'EDNS' }, 'dns down'), now)
  assert.deepEqual(patch, {
    status: 'pending',
    attempts: 1,
    firstAttemptAt: new Date(now).toISOString(),
    lastError: 'EDNS: dns down',
    nextAttemptAt: new Date(now + MIN).toISOString()
  })
})

test('the attempt count carries on from the message, and saved mail without one starts at zero', () => {
  const now = Date.parse('2026-11-20T08:00:10Z')
  const base = { scheduled: '2026-11-20T08:00:00Z' }
  const transient = err({ code: 'EDNS' })
  const third = afterFailedAttempt({ ...base, attempts: 3 }, transient, now)
  assert.equal(third.attempts, 4)
  assert.equal(third.nextAttemptAt, new Date(now + HOUR).toISOString())
  for (const attempts of [undefined, null, 'x', -2, 1.5, NaN]) {
    assert.equal(afterFailedAttempt({ ...base, attempts }, transient, now).attempts, 1, String(attempts))
  }
})

test('a permanent failure is failed at once, with the reason and no retry time', () => {
  const now = Date.parse('2026-11-20T08:00:10Z')
  const patch = afterFailedAttempt({ scheduled: '2026-11-20T08:00:00Z' }, err({ responseCode: 550 }, '550 no such user'), now)
  assert.equal(patch.status, 'failed')
  assert.equal(patch.attempts, 1)
  assert.match(patch.lastError, /550 no such user/)
  assert.doesNotMatch(patch.lastError, /may already have received/)
  assert.equal('nextAttemptAt' in patch, false)
})

test('no retry is planned after 24 hours past the scheduled time', () => {
  const scheduled = '2026-11-20T08:00:00Z'
  const at = (msAfter) => Date.parse(scheduled) + msAfter
  const transient = err({ code: 'EDNS' })
  const msg = { scheduled, firstAttemptAt: scheduled } // tried on time
  assert.equal(afterFailedAttempt(msg, transient, at(RETRY_GIVE_UP_MS - 2 * MIN)).status, 'pending')
  // the next try would fall exactly on the limit: still allowed
  assert.equal(afterFailedAttempt(msg, transient, at(RETRY_GIVE_UP_MS - MIN)).status, 'pending')
  // the next try would fall after it
  const late = afterFailedAttempt(msg, transient, at(RETRY_GIVE_UP_MS - MIN + 1))
  assert.equal(late.status, 'failed')
  assert.match(late.lastError, /EDNS/)
  assert.equal(afterFailedAttempt(msg, transient, at(RETRY_GIVE_UP_MS + HOUR)).status, 'failed')
})

test('a mail that was already overdue at its first attempt gets its 24 hours from that attempt', () => {
  // the server was off over a weekend: scheduled three days ago, first tried now
  const now = Date.parse('2026-11-23T09:00:00Z')
  const scheduled = '2026-11-20T17:00:00Z'
  const transient = err({ code: 'EDNS' })
  const first = afterFailedAttempt({ scheduled }, transient, now)
  assert.equal(first.status, 'pending', 'one network blip at start-up must not lose the mail')
  assert.equal(first.firstAttemptAt, new Date(now).toISOString())
  const kept = afterFailedAttempt({ scheduled, firstAttemptAt: first.firstAttemptAt, attempts: 1 }, transient, now + 2 * MIN)
  assert.equal(kept.firstAttemptAt, first.firstAttemptAt, 'the first attempt time is not moved by later ones')
  // after the 6th failure the next try is an hour away: exactly on the limit is allowed, a millisecond past it is not
  const sixth = { scheduled, firstAttemptAt: first.firstAttemptAt, attempts: 5 }
  assert.equal(afterFailedAttempt(sixth, transient, now + RETRY_GIVE_UP_MS - HOUR).status, 'pending')
  assert.equal(afterFailedAttempt(sixth, transient, now + RETRY_GIVE_UP_MS - HOUR + 1).status, 'failed')
  // an unreadable first-attempt time is treated as "now", not as an error
  assert.equal(afterFailedAttempt({ scheduled, firstAttemptAt: 'junk' }, transient, now).status, 'pending')
})

test('there is a cap on attempts as well', () => {
  const now = Date.parse('2026-11-20T08:00:10Z')
  const base = { scheduled: '2026-11-20T08:00:00Z' }
  const transient = err({ code: 'EDNS' })
  assert.equal(afterFailedAttempt({ ...base, attempts: MAX_SEND_ATTEMPTS - 2 }, transient, now).status, 'pending')
  assert.equal(afterFailedAttempt({ ...base, attempts: MAX_SEND_ATTEMPTS - 1 }, transient, now).status, 'failed')
})

test('after an ambiguous failure there are only a few attempts, and the reason says why it stopped', () => {
  const now = Date.parse('2026-11-20T08:00:10Z')
  const base = { scheduled: '2026-11-20T08:00:00Z' }
  const dropped = err({ code: 'ECONNECTION' }, 'Server closed the connection')
  for (let done = 0; done < MAX_AMBIGUOUS_ATTEMPTS - 1; done += 1) {
    assert.equal(afterFailedAttempt({ ...base, attempts: done }, dropped, now).status, 'pending', `after ${done + 1}`)
  }
  const last = afterFailedAttempt({ ...base, attempts: MAX_AMBIGUOUS_ATTEMPTS - 1 }, dropped, now)
  assert.equal(last.status, 'failed')
  assert.equal(last.attempts, MAX_AMBIGUOUS_ATTEMPTS)
  assert.match(last.lastError, /ECONNECTION: Server closed the connection \(giving up: the server may already have received this mail\)$/)
  // the same count after a failure where nothing was delivered carries on
  assert.equal(afterFailedAttempt({ ...base, attempts: MAX_AMBIGUOUS_ATTEMPTS - 1 }, err({ code: 'EDNS' }), now).status, 'pending')
})

test('a message with an unreadable scheduled time is not retried', () => {
  const now = Date.parse('2026-11-20T08:00:10Z')
  assert.equal(afterFailedAttempt({ scheduled: 'not a date' }, err({ code: 'EDNS' }), now).status, 'failed')
  assert.equal(afterFailedAttempt({}, err({ code: 'EDNS' }), now).status, 'failed')
})
