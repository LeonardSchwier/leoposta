import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Isolate state: data files go to a temp dir, token is fixed. These env vars
// must be set before server/index.js is imported (it reads them at load).
const TOKEN = 'test-token-0123456789abcdef'
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'leoposta-test-'))
process.env.LEOPOSTA_TOKEN = TOKEN
process.env.LEOPOSTA_DATA_DIR = DATA_DIR
delete process.env.LEOPOSTA_IMAP_PASS
delete process.env.LEOPOSTA_SMTP_PASS

const { createApp } = await import('./index.js')

let server
let base
const authed = { 'x-leoposta-token': TOKEN }

before(async () => {
  await new Promise((resolve) => {
    server = createApp().listen(0, '127.0.0.1', resolve)
  })
  base = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve()))
  fs.rmSync(DATA_DIR, { recursive: true, force: true })
})

test('createApp() returns an Express app with a request handler', () => {
  const app = createApp()
  assert.equal(typeof app, 'function')
  assert.equal(typeof app.handle, 'function')
  assert.equal(typeof app.listen, 'function')
})

test('GET /api/account with the right token responds 200 JSON', async () => {
  const res = await fetch(`${base}/api/account`, { headers: authed })
  assert.equal(res.status, 200)
  assert.equal(typeof (await res.json()), 'object')
})

test('no token header gives 401', async () => {
  const res = await fetch(`${base}/api/account`)
  assert.equal(res.status, 401)
  assert.deepEqual(await res.json(), { error: 'unauthorized' })
})

test('wrong token gives 401', async () => {
  const res = await fetch(`${base}/api/account`, { headers: { 'x-leoposta-token': 'nope' } })
  assert.equal(res.status, 401)
  const res2 = await fetch(`${base}/api/account`, { headers: { 'x-leoposta-token': TOKEN + 'x' } })
  assert.equal(res2.status, 401)
})

test('GET /api/health is open without a header', async () => {
  const res = await fetch(`${base}/api/health`)
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true })
})

test('?token= works only for idle and attachment GETs', async () => {
  const bad = await fetch(`${base}/api/account?token=${TOKEN}`)
  assert.equal(bad.status, 401)
  const att = await fetch(`${base}/api/message/1/attachment/2?token=${TOKEN}`)
  assert.notEqual(att.status, 401)
})

test('body limits: 2 MB JSON to /api/account gives 413, 1 KB does not', async () => {
  const big = await fetch(`${base}/api/account`, {
    method: 'POST',
    headers: { ...authed, 'content-type': 'application/json' },
    body: JSON.stringify({ pad: 'x'.repeat(2 * 1024 * 1024) })
  })
  assert.equal(big.status, 413)
  assert.deepEqual(await big.json(), { error: 'too_large' })
  const small = await fetch(`${base}/api/account`, {
    method: 'POST',
    headers: { ...authed, 'content-type': 'application/json' },
    body: JSON.stringify({ pad: 'x'.repeat(1024) })
  })
  assert.notEqual(small.status, 413)
})

test('/api/send accepts bodies larger than the 1 MB default', async () => {
  const res = await fetch(`${base}/api/send`, {
    method: 'POST',
    headers: { ...authed, 'content-type': 'application/json' },
    body: JSON.stringify({ pad: 'x'.repeat(2 * 1024 * 1024) })
  })
  assert.notEqual(res.status, 413)
})
