import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import express from 'express'

// State isolation, same pattern as server.test.js: env first, then import.
const TOKEN = 'cors-test-token-0123456789abcdef'
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'leoposta-cors-'))
process.env.LEOPOSTA_TOKEN = TOKEN
process.env.LEOPOSTA_DATA_DIR = DATA_DIR
delete process.env.ALLOWED_ORIGINS

const { createApp } = await import('./index.js')
const { apiErrorHandler } = await import('./lib/errors.js')

let server
let port
before(async () => {
  await new Promise((resolve) => { server = createApp().listen(0, '127.0.0.1', resolve) })
  port = server.address().port
})
after(async () => {
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(resolve))
  fs.rmSync(DATA_DIR, { recursive: true, force: true })
})

// node:http rather than fetch: an Origin header is something fetch may drop.
function request(method, urlPath, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }))
      res.on('error', reject)
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

const authed = { 'x-leoposta-token': TOKEN }
// A leaked Express stack trace names a source file and line.
const STACK_RE = /\bat .*\(.*:\d+:\d+\)|node_modules|\/server\/.*\.js:\d+/

test('GET /api/idle answers for the requesting origin, never with a wildcard', async () => {
  const origin = 'http://localhost:3000'
  // No account is configured in the empty data dir, so the stream ends at once.
  const res = await request('GET', '/api/idle', { ...authed, origin })
  assert.equal(res.status, 200)
  assert.equal(res.headers['access-control-allow-origin'], origin)
})

test('GET /api/idle from an origin that is not allowed is rejected', async () => {
  const res = await request('GET', '/api/idle', { ...authed, origin: 'http://evil.example' })
  assert.equal(res.status, 403)
  assert.notEqual(res.headers['access-control-allow-origin'], '*')
})

test('a disallowed origin gets a 403 JSON error, not an Express stack trace', async () => {
  const res = await request('GET', '/api/status', { ...authed, origin: 'http://evil.example' })
  assert.equal(res.status, 403)
  assert.match(res.headers['content-type'], /application\/json/)
  assert.deepEqual(JSON.parse(res.text), { error: 'origin_not_allowed' })
  assert.doesNotMatch(res.text, STACK_RE)
})

test('malformed JSON gets a 400 JSON error, not an Express stack trace', async () => {
  const res = await request('POST', '/api/accounts', { ...authed, 'content-type': 'application/json' }, '{"email":')
  assert.equal(res.status, 400)
  assert.match(res.headers['content-type'], /application\/json/)
  assert.equal(JSON.parse(res.text).error, 'invalid_json')
  assert.doesNotMatch(res.text, STACK_RE)
})

test('an unexpected failure is a generic 500 JSON error that names no file', async () => {
  const app = express()
  app.get('/boom', () => { throw new Error('secret /home/leo/path.js:12:3 detail') })
  app.get('/teapot', (req, res, next) => next(Object.assign(new Error('x'), { status: 418 })))
  app.use(apiErrorHandler)
  const small = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  const prevError = console.error
  console.error = () => {}
  try {
    const get = async (p) => {
      const r = await fetch(`http://127.0.0.1:${small.address().port}${p}`)
      return { status: r.status, body: await r.text(), type: r.headers.get('content-type') }
    }
    const boom = await get('/boom')
    assert.equal(boom.status, 500)
    assert.match(boom.type, /application\/json/)
    assert.deepEqual(JSON.parse(boom.body), { error: 'internal_error' })
    assert.doesNotMatch(boom.body, /secret|path\.js/)
    const teapot = await get('/teapot')
    assert.equal(teapot.status, 418)
    assert.deepEqual(JSON.parse(teapot.body), { error: 'bad_request' })
  } finally {
    console.error = prevError
    small.closeAllConnections?.()
    await new Promise((resolve) => small.close(resolve))
  }
})
