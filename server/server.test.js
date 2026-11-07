import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createApp } from './index.js'

// Minimal harness for the Express app: bind to an ephemeral port on loopback,
// assert the account route answers, then close. Importing index.js must not
// itself bind a port or start the scheduler (guarded by the main-module check).
let server
let base

before(async (t) => {
  const app = createApp()
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  base = `http://127.0.0.1:${port}`
})

after(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()))
})

test('createApp() returns an Express app with a request handler', () => {
  assert.equal(typeof createApp, 'function')
  const app = createApp()
  assert.equal(typeof app, 'function') // Express 4/5 apps are callable
  assert.equal(typeof app.handle, 'function')
  assert.equal(typeof app.listen, 'function')
})

test('GET /api/account responds 200 with a JSON body', async () => {
  const res = await fetch(`${base}/api/account`, { method: 'GET' })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(typeof body, 'object')
  assert.ok(body !== null)
})
