import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { resolveDavTarget, resolveDavBase, extractResponseSet, clearDavBaseCache } from './dav.js'
import { accountPayloadFrom } from './state.js'

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

// ---- accountPayloadFrom threads davUrl/davUser/davPass through ----

test('accountPayloadFrom: passes through davUrl, davUser, davPass when present', () => {
  const p = accountPayloadFrom({
    email: 'j@x.com', imapHost: 'imap.x.com', imapPort: 993, imapTls: true,
    imapUser: 'j', imapPass: 'p', smtpHost: 'smtp.x.com', smtpPort: 465, smtpTls: true,
    smtpUser: 'j', smtpPass: 'p',
    davUrl: 'https://dav.x.com/dav/j', davUser: 'j', davPass: 'dav-secret'
  })
  assert.equal(p.davUrl, 'https://dav.x.com/dav/j')
  assert.equal(p.davUser, 'j')
  assert.equal(p.davPass, 'dav-secret')
})

test('accountPayloadFrom: omits dav fields when not in body', () => {
  const p = accountPayloadFrom({
    email: 'j@x.com', imapHost: 'imap.x.com', imapPort: 993, imapTls: true,
    imapUser: 'j', imapPass: 'p', smtpHost: 'smtp.x.com', smtpPort: 465, smtpTls: true,
    smtpUser: 'j', smtpPass: 'p'
  })
  assert.equal(p.davUrl, undefined)
  assert.equal(p.davUser, undefined)
  assert.equal(p.davPass, undefined)
})

// ---- resolveDavBase: home-set discovery (RFC 4791 / 6352) ----

function startFakeDavServer({ counts } = {}) {
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8')
      if (req.method === 'PROPFIND' && req.url === '/') {
        if (counts) counts.root++
        res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' })
        res.end(
          `<?xml version="1.0"?>` +
          `<D:multistatus xmlns:D="DAV:"><D:response><D:href>/</D:href><D:propstat><D:prop>` +
          `<D:current-user-principal><D:href>/principals/u/42</D:href></D:current-user-principal>` +
          `</D:prop></D:propstat></D:response></D:multistatus>`
        )
      } else if (req.method === 'PROPFIND' && req.url === '/principals/u/42') {
        if (counts) counts.principal++
        const isCal = /calendar-home-set/.test(body)
        res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' })
        res.end(
          `<?xml version="1.0"?>` +
          `<D:multistatus xmlns:D="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:crd="urn:ietf:params:xml:ns:carddav">` +
          `<D:response><D:href>/principals/u/42</D:href><D:propstat><D:prop>` +
          (isCal
            ? `<c:calendar-home-set><D:href>/caldav/</D:href></c:calendar-home-set>`
            : `<crd:address-book-home-set><D:href>/carddav/</D:href></crd:address-book-home-set>`) +
          `</D:prop></D:propstat></D:response></D:multistatus>`
        )
      } else {
        res.writeHead(404)
        res.end('nope')
      }
    })
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const port = server.address().port
    resolve({
      server,
      port,
      url: `http://127.0.0.1:${port}/`,
      close: () => new Promise(r => server.close(r))
    })
  }))
}

test('resolveDavBase: explicit davUrl sub-path is returned verbatim, no discovery request', async () => {
  clearDavBaseCache()
  // Bind a real local server that 404s everything. If resolveDavBase tried
  // discovery it would hit this server and throw; an explicit sub-path must
  // short-circuit before any network call.
  const counts = { root: 0, principal: 0, other: 0 }
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      if (req.url === '/') counts.root++
      else if (req.url === '/principals/u/42') counts.principal++
      else counts.other++
      res.writeHead(404); res.end('nope')
    })
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  try {
    const acct = {
      davUrl: `http://127.0.0.1:${port}/dav/john`,
      davUser: 'john@x.com', davPass: 'secret',
      imapUser: 'john@x.com', imapPass: 'p'
    }
    const r = await resolveDavBase(acct, 'calendar')
    assert.equal(r.basePath, '/dav/john')
    assert.equal(counts.root, 0)
    assert.equal(counts.principal, 0)
    assert.equal(counts.other, 0)
  } finally { await new Promise(res => server.close(res)) }
})

test('resolveDavBase: discoves principal + calendar-home-set when davUrl has no path', async () => {
  clearDavBaseCache()
  const counts = { root: 0, principal: 0 }
  const s = await startFakeDavServer({ counts })
  try {
    const acct = {
      davUrl: s.url, davUser: 'u@x.com', davPass: 'p',
      imapUser: 'u@x.com', imapPass: 'p'
    }
    const r = await resolveDavBase(acct, 'calendar')
    assert.equal(r.basePath, '/caldav/')
    assert.equal(counts.root, 1)
    assert.equal(counts.principal, 1)
  } finally { await s.close() }
})

test('resolveDavBase: cards kind hits address-book-home-set', async () => {
  clearDavBaseCache()
  const s = await startFakeDavServer()
  try {
    const acct = { davUrl: s.url, davUser: 'u@x.com', davPass: 'p', imapUser: 'u@x.com', imapPass: 'p' }
    const r = await resolveDavBase(acct, 'cards')
    assert.equal(r.basePath, '/carddav/')
  } finally { await s.close() }
})

test('resolveDavBase: caches per account+kind — second call does not re-propfind', async () => {
  clearDavBaseCache()
  const counts = { root: 0, principal: 0 }
  const s = await startFakeDavServer({ counts })
  try {
    const acct = { davUrl: s.url, davUser: 'u@x.com', davPass: 'p', imapUser: 'u@x.com', imapPass: 'p' }
    const r1 = await resolveDavBase(acct, 'calendar')
    const r2 = await resolveDavBase(acct, 'calendar')
    assert.equal(r1.basePath, r2.basePath)
    assert.equal(counts.root, 1)   // cached → no extra network
    assert.equal(counts.principal, 1)
  } finally { await s.close() }
})

test('resolveDavBase: clearDavBaseCache invalidates the cached home-set', async () => {
  clearDavBaseCache()
  const counts = { root: 0, principal: 0 }
  const s = await startFakeDavServer({ counts })
  try {
    const acct = { davUrl: s.url, davUser: 'u@x.com', davPass: 'p', imapUser: 'u@x.com', imapPass: 'p' }
    await resolveDavBase(acct, 'calendar')
    clearDavBaseCache()
    await resolveDavBase(acct, 'calendar')
    assert.equal(counts.root, 2)
    assert.equal(counts.principal, 2)
  } finally { await s.close() }
})

test('resolveDavBase: throws when server has no current-user-principal', async () => {
  clearDavBaseCache()
  const server = http.createServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      res.writeHead(207, { 'Content-Type': 'application/xml' })
      res.end('<D:multistatus xmlns:D="DAV:"></D:multistatus>')
    })
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  try {
    const acct = { davUrl: `http://127.0.0.1:${port}/`, davUser: 'u', davPass: 'p', imapUser: 'u', imapPass: 'p' }
    await assert.rejects(
      () => resolveDavBase(acct, 'calendar'),
      /current-user-principal/
    )
  } finally { await new Promise(r => server.close(r)) }
})

// ---- extractResponseSet: namespace-agnostic parsing ----

test('extractResponseSet: handles bare (unqualified) DAV tags', () => {
  const xml = `<?xml version="1.0"?>
<response><href>/calendars/a</href><propstat><prop><displayname>A</displayname><etag>"abc"</etag></prop></propstat></response>
<response><href>/calendars/b</href><propstat><prop><displayname>B</displayname></prop></propstat></response>`
  const r = extractResponseSet(xml)
  assert.equal(r.length, 2)
  assert.deepEqual(r[0], { href: '/calendars/a', displayname: 'A', etag: 'abc' })
  assert.deepEqual(r[1], { href: '/calendars/b', displayname: 'B', etag: '' })
})

test('extractResponseSet: handles D: namespace-prefixed DAV tags (Open-Xchange)', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response><D:href>/caldav/</D:href><D:propstat><D:prop><D:displayname>Calendars</D:displayname></D:prop></D:propstat></D:response>
  <D:response><D:href>/caldav/42/</D:href><D:propstat><D:prop><D:displayname>Birthdays</D:displayname><D:etag>"wxyz"</D:etag></D:prop></D:propstat></D:response>
</D:multistatus>`
  const r = extractResponseSet(xml)
  assert.equal(r.length, 2)
  assert.deepEqual(r[0], { href: '/caldav/', displayname: 'Calendars', etag: '' })
  assert.deepEqual(r[1], { href: '/caldav/42/', displayname: 'Birthdays', etag: 'wxyz' })
})

test('extractResponseSet: handles lowercase d: namespace (Radical / davserver)', () => {
  const xml = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
  <d:response><d:href>/dav/j/</d:href><d:propstat><d:prop><d:displayname>j</d:displayname></d:prop></d:propstat></d:response>
</d:multistatus>`
  const r = extractResponseSet(xml)
  assert.equal(r.length, 1)
  assert.equal(r[0].href, '/dav/j/')
  assert.equal(r[0].displayname, 'j')
})
