import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveDavTarget } from './dav.js'

test('resolveDavTarget: davUrl with explicit port and path', () => {
  const acct = {
    davUrl: 'https://dav.example.com:8080/dav/john',
    davUser: 'john@x.com',
    davPass: 'secret',
    imapUser: 'john@x.com',
    imapPass: 'imap-secret'
  }
  const t = resolveDavTarget(acct)
  assert.equal(t.hostname, 'dav.example.com')
  assert.equal(t.port, 8080)
  assert.equal(t.tls, true)
  assert.equal(t.basePath, '/dav/john')
  assert.equal(t.user, 'john@x.com')
  assert.equal(t.pass, 'secret')
})

test('resolveDavTarget: davUrl without port defaults to 443 over TLS', () => {
  const t = resolveDavTarget({ davUrl: 'https://dav.example.com/dav/john', imapUser: 'j', imapPass: 'p' })
  assert.equal(t.hostname, 'dav.example.com')
  assert.equal(t.port, 443)
  assert.equal(t.tls, true)
  assert.equal(t.basePath, '/dav/john')
  assert.equal(t.user, 'j')
  assert.equal(t.pass, 'p')
})

test('resolveDavTarget: davUrl http (no TLS) defaults port to 80', () => {
  const t = resolveDavTarget({ davUrl: 'http://dav.example.com/dav/john', imapUser: 'j', imapPass: 'p' })
  assert.equal(t.tls, false)
  assert.equal(t.port, 80)
  assert.equal(t.hostname, 'dav.example.com')
})

test('resolveDavTarget: no davUrl falls back to DAV_HOST env (default port 443)', () => {
  // DAV_HOST defaults to 'dav.example.com'; DAV_TLS defaults to false
  // (it only auto-enables when DAV_HOST is explicitly set via env)
  const t = resolveDavTarget({ imapUser: 'j', imapPass: 'p' })
  assert.equal(t.hostname, 'dav.example.com')
  assert.equal(t.port, 443)
  assert.equal(t.basePath, '/dav/j')
  assert.equal(t.user, 'j')
  assert.equal(t.pass, 'p')
})
