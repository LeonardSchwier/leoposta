import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Isolate state before the server modules read their env at load.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'leoposta-sched-'))
process.env.LEOPOSTA_TOKEN = 'sched-test-token-0123456789abcdef'
process.env.LEOPOSTA_DATA_DIR = DATA_DIR
delete process.env.LEOPOSTA_IMAP_PASS
delete process.env.LEOPOSTA_SMTP_PASS

const { state, SCHEDULED_FILE } = await import('./lib/state.js')
const { processScheduledMessages } = await import('./routes/send.js')

const past = () => new Date(Date.now() - 60_000).toISOString()
const queue = (id, extra = {}) => ({ id, status: 'pending', scheduled: past(), to: 'a@example.com', ...extra })
const tick = () => new Promise((resolve) => setImmediate(resolve))

beforeEach(() => { state.scheduledMessages = [] })
after(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }))

test('a send that outlives the 30 s tick is not sent a second time', async () => {
  const msg = queue('slow')
  state.scheduledMessages = [msg]
  let release
  const calls = []
  const slowSend = (m) => { calls.push(m.id); return new Promise((resolve) => { release = resolve }) }

  processScheduledMessages(slowSend)
  await tick()
  processScheduledMessages(slowSend) // next scheduler tick, first send still in flight
  await tick()
  assert.deepEqual(calls, ['slow'], 'the in-flight message must not be dispatched again')
  assert.equal(msg.status, 'pending', 'on disk it stays pending until the send resolves')

  release('<id@example.com>')
  await tick()
  assert.equal(msg.status, 'sent')
  processScheduledMessages(slowSend)
  await tick()
  assert.deepEqual(calls, ['slow'], 'a sent message is never dispatched again')
})

test('a failed send is marked failed, released, and not retried automatically', async () => {
  const msg = queue('bad')
  state.scheduledMessages = [msg]
  const calls = []
  const failing = async (m) => { calls.push(m.id); throw new Error('smtp down') }
  const origError = console.error
  console.error = () => {}
  try {
    processScheduledMessages(failing)
    await tick()
    await tick()
    assert.equal(msg.status, 'failed')
    processScheduledMessages(failing)
    await tick()
    assert.deepEqual(calls, ['bad'])
  } finally {
    console.error = origError
  }
})

test('a sender that throws synchronously marks the message failed and releases it', async () => {
  const msg = queue('throws')
  state.scheduledMessages = [msg]
  const origError = console.error
  console.error = () => {}
  try {
    processScheduledMessages(() => { throw new Error('boom') })
    await tick()
    await tick()
    assert.equal(msg.status, 'failed')
  } finally {
    console.error = origError
  }
})

test('only due pending messages are dispatched', async () => {
  const future = queue('future', { scheduled: new Date(Date.now() + 3_600_000).toISOString() })
  const sent = queue('done', { status: 'sent' })
  const due = queue('due')
  state.scheduledMessages = [future, sent, due]
  const calls = []
  processScheduledMessages(async (m) => { calls.push(m.id) })
  await tick()
  assert.deepEqual(calls, ['due'])
})

// ── Retry of transient failures, and persistence kept out of the outcome ────────────
// Design: docs/design/review-2026-11-20-scheduled-retry.md

const MIN = 60_000
const transientError = () => Object.assign(new Error('getaddrinfo EAI_AGAIN smtp.example.test'), { code: 'EDNS' })
const permanentError = () => Object.assign(new Error('550 5.1.1 no such user'), { responseCode: 550 })
const withFrom = (id, extra = {}) => queue(id, { from: { name: 'Erika Muster', address: 'erika@example.test' }, ...extra })
const quiet = async (fn) => {
  const origError = console.error
  console.error = () => {}
  try { return await fn() } finally { console.error = origError }
}
const readSaved = () => JSON.parse(fs.readFileSync(SCHEDULED_FILE, 'utf8'))

test('a transient failure keeps the message pending, records the attempt, and retries after the delay', async () => {
  const msg = withFrom('retry')
  state.scheduledMessages = [msg]
  let now = Date.now()
  const clock = () => now
  const calls = []
  let failing = true
  const send = async (m) => { calls.push(m.id); if (failing) throw transientError() }

  await quiet(async () => {
    processScheduledMessages(send, clock)
    await tick()
  })
  assert.equal(msg.status, 'pending', 'a connectivity error must not lose the mail')
  assert.equal(msg.attempts, 1)
  assert.match(msg.lastError, /EDNS: getaddrinfo EAI_AGAIN/)
  assert.equal(msg.nextAttemptAt, new Date(now + MIN).toISOString())

  now += MIN - 1
  processScheduledMessages(send, clock)
  await tick()
  assert.deepEqual(calls, ['retry'], 'not tried again before nextAttemptAt')

  now += 1
  failing = false
  processScheduledMessages(send, clock)
  await tick()
  assert.deepEqual(calls, ['retry', 'retry'])
  assert.equal(msg.status, 'sent')
  processScheduledMessages(send, clock)
  await tick()
  assert.equal(calls.length, 2, 'sent once it got through')
})

test('the retry delay counts from when the attempt failed, not from when the tick started', async () => {
  const msg = withFrom('slow-fail')
  state.scheduledMessages = [msg]
  let now = 1_000_000_000_000
  msg.scheduled = new Date(now - MIN).toISOString()
  const send = async () => { now += 90_000; throw transientError() } // fails 90 s after the tick began
  await quiet(async () => {
    processScheduledMessages(send, () => now)
    await tick()
  })
  assert.equal(msg.nextAttemptAt, new Date(now + MIN).toISOString())
})

test('a permanent failure is failed at once, keeps its reason, and is never retried', async () => {
  const msg = withFrom('refused')
  state.scheduledMessages = [msg]
  let now = Date.now()
  const calls = []
  const send = async (m) => { calls.push(m.id); throw permanentError() }
  await quiet(async () => {
    processScheduledMessages(send, () => now)
    await tick()
    now += 48 * 60 * MIN
    processScheduledMessages(send, () => now)
    await tick()
  })
  assert.deepEqual(calls, ['refused'])
  assert.equal(msg.status, 'failed')
  assert.equal(msg.attempts, 1)
  assert.match(msg.lastError, /550 5\.1\.1 no such user/)
  assert.equal('nextAttemptAt' in msg, false)
})

test('a mail that keeps failing for 24 hours is given up, and its retry time is removed', async () => {
  let now = Date.now()
  const msg = withFrom('gives-up', { scheduled: new Date(now).toISOString() })
  state.scheduledMessages = [msg]
  const calls = []
  const send = async (m) => { calls.push(m.id); throw transientError() }
  await quiet(async () => {
    processScheduledMessages(send, () => now) // attempt 1, next in 1 minute
    await tick()
    assert.equal(msg.status, 'pending')
    assert.ok(msg.nextAttemptAt)
    now += 24 * 60 * MIN - MIN // the machine slept; its next due attempt is the last minute of the day
    processScheduledMessages(send, () => now) // attempt 2: the next one, in 5 minutes, would pass the limit
    await tick()
  })
  assert.equal(calls.length, 2)
  assert.equal(msg.status, 'failed')
  assert.equal(msg.attempts, 2)
  assert.match(msg.lastError, /EDNS/)
  assert.equal('nextAttemptAt' in msg, false, 'the old retry time is removed')
  now += 2 * 24 * 60 * MIN
  processScheduledMessages(send, () => now)
  await tick()
  assert.equal(calls.length, 2, 'a failed mail stays failed')
})

test('a mail that was overdue at start-up (the server was off) gets its 24 hours from the first attempt', async () => {
  let now = Date.now()
  const msg = withFrom('overdue', { scheduled: new Date(now - 3 * 24 * 60 * MIN).toISOString() })
  state.scheduledMessages = [msg]
  let failing = true
  const calls = []
  const send = async (m) => { calls.push(m.id); if (failing) throw transientError() }
  await quiet(async () => {
    processScheduledMessages(send, () => now) // the network is not back yet at start-up
    await tick()
  })
  assert.equal(msg.status, 'pending', 'one blip at start-up must not lose a mail that is already days late')
  assert.equal(msg.firstAttemptAt, new Date(now).toISOString())
  now += 10 * 60 * MIN
  failing = false
  processScheduledMessages(send, () => now)
  await tick()
  assert.equal(msg.status, 'sent')
  assert.equal(calls.length, 2)
})

test('after a failure that may have come after the server got the mail there are only a few attempts', async () => {
  let now = Date.now()
  const msg = withFrom('maybe-delivered')
  state.scheduledMessages = [msg]
  const calls = []
  const send = async (m) => { calls.push(m.messageId); throw Object.assign(new Error('Server closed the connection'), { code: 'ECONNECTION' }) }
  await quiet(async () => {
    for (let i = 0; i < 6; i += 1) {
      processScheduledMessages(send, () => now)
      await tick()
      now += 2 * 60 * MIN // later than any retry delay
    }
  })
  assert.equal(calls.length, 3, 'three attempts, not twenty-six')
  assert.equal(new Set(calls).size, 1, 'all with the same Message-ID')
  assert.equal(msg.status, 'failed')
  assert.match(msg.lastError, /may already have received this mail/)
})

test('a mail deleted while it waits for its next attempt is not sent', async () => {
  let now = Date.now()
  const msg = withFrom('deleted-while-waiting')
  state.scheduledMessages = [msg]
  const calls = []
  const send = async (m) => { calls.push(m.id); throw transientError() }
  await quiet(async () => {
    processScheduledMessages(send, () => now)
    await tick()
  })
  assert.equal(msg.status, 'pending')
  state.scheduledMessages.splice(0, 1) // DELETE /api/scheduled/:id
  now += 5 * MIN
  processScheduledMessages(send, () => now)
  await tick()
  assert.deepEqual(calls, ['deleted-while-waiting'], 'only the first attempt happened')
})

test('attempts and the next try are saved, and a restarted server waits for them', async () => {
  const msg = withFrom('saved')
  state.scheduledMessages = [msg]
  const now = Date.now()
  await quiet(async () => {
    processScheduledMessages(async () => { throw transientError() }, () => now)
    await tick()
  })
  const [onDisk] = readSaved()
  assert.equal(onDisk.status, 'pending')
  assert.equal(onDisk.attempts, 1)
  assert.equal(onDisk.nextAttemptAt, new Date(now + MIN).toISOString())
  assert.match(onDisk.lastError, /EDNS/)

  // a restart: the list comes back from the file, with the scheduled time long past
  state.scheduledMessages = readSaved()
  const calls = []
  processScheduledMessages(async (m) => { calls.push(m.id) }, () => now + MIN - 1)
  await tick()
  assert.deepEqual(calls, [], 'not before nextAttemptAt')
  processScheduledMessages(async (m) => { calls.push(m.id) }, () => now + MIN)
  await tick()
  assert.deepEqual(calls, ['saved'])
})

test('mail saved before this change, with none of the new fields, is sent when due', async () => {
  const legacy = { id: 'legacy', status: 'pending', scheduled: past(), to: 'a@example.com', subject: 'Old' }
  state.scheduledMessages = [legacy]
  const calls = []
  processScheduledMessages(async (m) => { calls.push(m.id) })
  await tick()
  assert.deepEqual(calls, ['legacy'])
  assert.equal(legacy.status, 'sent')
})

test('every attempt reuses one Message-ID, created before the first and saved with the mail', async () => {
  const msg = withFrom('stable-id')
  state.scheduledMessages = [msg]
  let now = Date.now()
  const seen = []
  let failing = true
  const send = async (m) => {
    seen.push(m.messageId)
    assert.deepEqual(readSaved().map((x) => x.messageId), [m.messageId], 'saved before the attempt, so a restart reuses it')
    if (failing) throw transientError()
  }
  await quiet(async () => {
    processScheduledMessages(send, () => now)
    await tick()
  })
  now += MIN
  failing = false
  processScheduledMessages(send, () => now)
  await tick()
  assert.equal(seen.length, 2)
  assert.match(seen[0], /^<[0-9a-f-]{36}@example\.test>$/)
  assert.equal(seen[0], seen[1])
  assert.equal(msg.status, 'sent')
})

test('a Message-ID the mail already has is kept', async () => {
  const msg = withFrom('has-id', { messageId: '<fixed@example.test>' })
  state.scheduledMessages = [msg]
  const seen = []
  processScheduledMessages(async (m) => { seen.push(m.messageId) })
  await tick()
  assert.deepEqual(seen, ['<fixed@example.test>'])
})

// A scheduled.json that cannot be written (disk full, no permission, data directory gone)
// is simulated by making the path a directory, so writeFileSync fails with EISDIR.
const breakStateFile = () => {
  fs.rmSync(SCHEDULED_FILE, { recursive: true, force: true })
  fs.mkdirSync(SCHEDULED_FILE)
}
const repairStateFile = () => fs.rmSync(SCHEDULED_FILE, { recursive: true, force: true })
const watchRejections = () => {
  const seen = []
  const onRejection = (reason) => seen.push(reason)
  process.on('unhandledRejection', onRejection)
  return { seen, stop: () => process.off('unhandledRejection', onRejection) }
}

test('a mail that was sent is not marked failed, and nothing is left unhandled, when saving fails', async () => {
  const msg = withFrom('sent-unsaved')
  state.scheduledMessages = [msg]
  const watch = watchRejections()
  const calls = []
  breakStateFile()
  try {
    await quiet(async () => {
      processScheduledMessages(async (m) => { calls.push(m.id) })
      await tick()
      await tick()
      assert.equal(msg.status, 'sent', 'the send succeeded, whatever the disk says')
      processScheduledMessages(async (m) => { calls.push(m.id) })
      await tick()
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
  } finally {
    watch.stop()
    repairStateFile()
  }
  assert.deepEqual(calls, ['sent-unsaved'], 'not sent a second time by this process')
  assert.deepEqual(watch.seen, [], 'no unhandled rejection (it ends the server process)')
})

test('a failed attempt is still recorded in memory, and nothing is left unhandled, when saving fails', async () => {
  const msg = withFrom('failed-unsaved')
  state.scheduledMessages = [msg]
  const watch = watchRejections()
  const now = Date.now()
  breakStateFile()
  try {
    await quiet(async () => {
      processScheduledMessages(async () => { throw transientError() }, () => now)
      await tick()
      await tick()
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
  } finally {
    watch.stop()
    repairStateFile()
  }
  assert.equal(msg.status, 'pending')
  assert.equal(msg.attempts, 1)
  assert.equal(msg.nextAttemptAt, new Date(now + MIN).toISOString())
  assert.deepEqual(watch.seen, [])
})

test('a message deleted while its send is failing does not come back', async () => {
  const msg = withFrom('deleted')
  state.scheduledMessages = [msg]
  const send = async () => {
    state.scheduledMessages.splice(0, 1) // DELETE /api/scheduled/:id while the send is in flight
    throw transientError()
  }
  await quiet(async () => {
    processScheduledMessages(send)
    await tick()
  })
  assert.deepEqual(state.scheduledMessages, [])
  assert.deepEqual(readSaved(), [])
})
