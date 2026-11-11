import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import express from 'express'
import { createIdleRouter } from './routes/idle.js'

// A browser that drops the SSE stream while the server is still connecting to
// IMAP must not leave a logged-in IMAP session behind: the 'close' event has
// already fired by the time the awaits resolve, so the handler has to notice.

function deferred() {
  let resolve, reject
  const promise = new Promise((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}

function makeFakeClient({ closeAborts = true } = {}) {
  const connectD = deferred()
  const lockD = deferred()
  const idleD = deferred()
  // close() rejects both; the one nobody awaits yet must not be an unhandled rejection.
  connectD.promise.catch(() => {})
  lockD.promise.catch(() => {})
  const calls = { connect: 0, getLock: 0, idle: 0, close: 0, logout: 0, release: 0 }
  const client = new EventEmitter()
  client.connect = () => { calls.connect++; return connectD.promise }
  client.getMailboxLock = () => { calls.getLock++; return lockD.promise }
  client.idle = () => { calls.idle++; return idleD.promise }
  // Like ImapFlow, close() drops the socket, which fails a pending connect or lock.
  client.close = () => {
    calls.close++
    if (closeAborts) {
      connectD.reject(new Error('closed'))
      lockD.reject(new Error('closed'))
    }
  }
  client.logout = () => { calls.logout++; return Promise.resolve() }
  const lock = { release: () => { calls.release++ } }
  return { client, calls, connectD, lockD, lock }
}

async function waitFor(cond, ms = 600) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, 10))
  }
  return cond()
}
const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms))

// The route owns a heartbeat interval. If a regression leaks it, it would keep
// this process alive and hang the run instead of failing it, so every interval
// created while a test runs is cleared in the cleanup below.
async function withIdleServer(fake, fn) {
  const realSetInterval = globalThis.setInterval
  const intervals = new Set()
  globalThis.setInterval = (...args) => {
    const handle = realSetInterval(...args)
    intervals.add(handle)
    return handle
  }
  const app = express()
  app.use('/api', createIdleRouter({
    createClient: () => fake.client,
    resolve: () => ({ email: 'a@example.com' }),
    heartbeatMs: 20
  }))
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  const port = server.address().port
  try {
    await fn(port)
  } finally {
    globalThis.setInterval = realSetInterval
    intervals.forEach((handle) => clearInterval(handle))
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  }
}

// Opens the SSE stream, resolves once headers arrive, returns the request so
// the test can drop it.
function openStream(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/idle' }, (res) => {
      res.on('data', () => {})
      res.on('error', () => {})
      resolve(req)
    })
    req.on('error', () => {})
    req.setTimeout(2000, () => reject(new Error('no response')))
  })
}

test('idle: disconnect while IMAP connect is pending aborts it, logs out and never idles', async () => {
  const fake = makeFakeClient()
  await withIdleServer(fake, async (port) => {
    const req = await openStream(port)
    assert.equal(await waitFor(() => fake.calls.connect === 1), true)
    req.destroy()
    assert.equal(await waitFor(() => fake.calls.close === 1), true, 'the pending connect must be aborted')
    assert.equal(await waitFor(() => fake.calls.logout >= 1), true, 'the IMAP session must be logged out')
    await settle()
    assert.equal(fake.calls.getLock, 0, 'no mailbox lock should be taken for a gone client')
    assert.equal(fake.calls.idle, 0)
  })
})

test('idle: a connect that finishes after the disconnect is still logged out', async () => {
  const fake = makeFakeClient({ closeAborts: false })
  await withIdleServer(fake, async (port) => {
    const req = await openStream(port)
    assert.equal(await waitFor(() => fake.calls.connect === 1), true)
    req.destroy()
    assert.equal(await waitFor(() => fake.calls.close === 1), true)
    await settle()
    fake.connectD.resolve()
    assert.equal(await waitFor(() => fake.calls.logout >= 1), true, 'the IMAP session must be logged out')
    await settle()
    assert.equal(fake.calls.getLock, 0)
    assert.equal(fake.calls.idle, 0)
  })
})

test('idle: disconnect while the mailbox lock is pending aborts it, logs out, never idles', async () => {
  const fake = makeFakeClient()
  await withIdleServer(fake, async (port) => {
    const req = await openStream(port)
    fake.connectD.resolve()
    assert.equal(await waitFor(() => fake.calls.getLock === 1), true)
    req.destroy()
    assert.equal(await waitFor(() => fake.calls.close === 1), true)
    assert.equal(await waitFor(() => fake.calls.logout >= 1), true)
    await settle()
    assert.equal(fake.calls.release, 0, 'no lock was ever granted')
    assert.equal(fake.calls.idle, 0)
  })
})

test('idle: a lock granted after the disconnect is released and the session logged out', async () => {
  const fake = makeFakeClient({ closeAborts: false })
  await withIdleServer(fake, async (port) => {
    const req = await openStream(port)
    fake.connectD.resolve()
    assert.equal(await waitFor(() => fake.calls.getLock === 1), true)
    req.destroy()
    assert.equal(await waitFor(() => fake.calls.close === 1), true)
    await settle()
    fake.lockD.resolve(fake.lock)
    assert.equal(await waitFor(() => fake.calls.release === 1), true, 'the lock must be released')
    assert.equal(await waitFor(() => fake.calls.logout >= 1), true)
    await settle()
    assert.equal(fake.calls.idle, 0)
  })
})

test('idle: disconnect during IDLE tears down exactly once', async () => {
  const fake = makeFakeClient()
  await withIdleServer(fake, async (port) => {
    const req = await openStream(port)
    fake.connectD.resolve()
    assert.equal(await waitFor(() => fake.calls.getLock === 1), true)
    fake.lockD.resolve(fake.lock)
    assert.equal(await waitFor(() => fake.calls.idle === 1), true)
    req.destroy()
    assert.equal(await waitFor(() => fake.calls.logout === 1), true)
    await settle()
    assert.equal(fake.calls.release, 1)
    assert.equal(fake.calls.logout, 1)
    assert.equal(fake.calls.close, 0, 'a ready stream is torn down by logout, not by close()')
  })
})

test('idle: a failed connect ends the stream with an error event and logs out', async () => {
  const fake = makeFakeClient()
  await withIdleServer(fake, async (port) => {
    const chunks = []
    const ended = deferred()
    const req = http.get({ host: '127.0.0.1', port, path: '/api/idle' }, (res) => {
      res.on('data', (c) => chunks.push(String(c)))
      res.on('end', ended.resolve)
      res.on('error', ended.resolve)
    })
    req.on('error', () => {})
    assert.equal(await waitFor(() => fake.calls.connect === 1), true)
    fake.connectD.reject(new Error('boom'))
    await Promise.race([ended.promise, settle(1000)])
    assert.match(chunks.join(''), /event: error\ndata: \{"error":"boom"\}/)
    assert.equal(fake.calls.logout >= 1, true, 'a half-open client must be closed after a failed connect')
  })
})
