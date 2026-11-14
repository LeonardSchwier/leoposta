// Regression tests for the run-2 security audit (~/security-audit-skill/leoposta/run-2).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'

const TOKEN = 'security-test-token-0123456789abcdef'
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'leoposta-sec-'))
const DIST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'leoposta-sec-dist-'))
fs.writeFileSync(path.join(DIST_DIR, 'index.html'), '<!doctype html><title>t</title>')
fs.mkdirSync(path.join(DIST_DIR, 'assets'))
fs.writeFileSync(path.join(DIST_DIR, 'assets', 'index.js'), `const t="${TOKEN}"`)
process.env.LEOPOSTA_TOKEN = TOKEN
process.env.LEOPOSTA_DATA_DIR = DATA_DIR
process.env.LEOPOSTA_DIST_DIR = DIST_DIR
delete process.env.ALLOWED_ORIGINS
delete process.env.ALLOWED_HOSTS
delete process.env.PORT

const { createApp } = await import('./index.js')
const { isAllowedHost, configuredHosts, hostnameOf } = await import('./lib/hostcheck.js')

let server, port
before(async () => {
  await new Promise((resolve) => { server = createApp().listen(0, '127.0.0.1', resolve) })
  port = server.address().port
})
after(async () => {
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(resolve))
  fs.rmSync(DATA_DIR, { recursive: true, force: true })
  fs.rmSync(DIST_DIR, { recursive: true, force: true })
})

function request(method, urlPath, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}
const authed = { 'x-leoposta-token': TOKEN }

// leoposta.api.host-header-unchecked.dns-rebinding
test('DNS rebinding: a foreign Host gets neither the token-bearing bundle nor the API', async () => {
  const host = { host: `rebind.attacker.example:${port}` }
  for (const p of ['/', '/assets/index.js', '/api/health']) {
    const r = await request('GET', p, host)
    assert.equal(r.status, 403, p)
    assert.doesNotMatch(r.text, new RegExp(TOKEN), p)
  }
  const api = await request('GET', '/api/accounts', { ...host, ...authed })
  assert.equal(api.status, 403)
  assert.deepEqual(JSON.parse(api.text), { error: 'host_not_allowed' })
})

test('loopback Host names still work', async () => {
  for (const h of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, 'localhost']) {
    const r = await request('GET', '/api/accounts', { host: h, ...authed })
    assert.equal(r.status, 200, h)
  }
})

test('host names of ALLOWED_ORIGINS and ALLOWED_HOSTS are allowed, others are not', () => {
  const extra = configuredHosts(['http://mail.lan:3001', 'https://[fd00::1]:8443'], 'leo.box, other.example:80')
  assert.ok(isAllowedHost('mail.lan:3001', extra))
  assert.ok(isAllowedHost('MAIL.LAN', extra))
  assert.ok(isAllowedHost('[fd00::1]:8443', extra))
  assert.ok(isAllowedHost('leo.box', extra))
  assert.ok(isAllowedHost('other.example:3001', extra))
  assert.ok(!isAllowedHost('mail.lan.attacker.example', extra))
  assert.ok(!isAllowedHost('127.0.0.1.attacker.example', extra))
  assert.ok(!isAllowedHost('', extra))
  assert.equal(hostnameOf('[::1]:3001'), '::1')
})

// leoposta.api.cors-default-allows-port-3000
test('by default a page on localhost:3000 is not a trusted origin', async () => {
  for (const origin of ['http://localhost:3000', 'http://127.0.0.1:3000']) {
    const bundle = await request('GET', '/assets/index.js', { origin })
    assert.equal(bundle.status, 403, origin)
    assert.equal(bundle.headers['access-control-allow-origin'], undefined)
    const post = await request('POST', '/api/accounts', { origin, ...authed, 'content-type': 'application/json' }, JSON.stringify({ email: 'x@example.test' }))
    assert.equal(post.status, 403, origin)
  }
  const own = await request('GET', '/api/accounts', { origin: 'http://127.0.0.1:3001', ...authed })
  assert.equal(own.status, 200)
})
