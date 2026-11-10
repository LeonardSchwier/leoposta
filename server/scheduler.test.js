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

const { state } = await import('./lib/state.js')
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
