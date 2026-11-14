import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const TOKEN = 'goaroutes-token-0123456789abcdef'
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'leoposta-goaroutes-'))
process.env.LEOPOSTA_TOKEN = TOKEN
process.env.LEOPOSTA_DATA_DIR = DATA_DIR
delete process.env.LEOPOSTA_IMAP_PASS
delete process.env.LEOPOSTA_SMTP_PASS

const { createApp } = await import('./index.js')
const { state } = await import('./lib/state.js')
const { _setExecFileForTest } = await import('./lib/goa.js')

const authed = { 'x-leoposta-token': TOKEN }
const json = { ...authed, 'content-type': 'application/json' }

const MAIL_ACCOUNT_OBJECTS = {
  type: 'a{oa{sa{sv}}}',
  data: [{
    '/org/gnome/OnlineAccounts/Accounts/account_mail1': {
      'org.gnome.OnlineAccounts.Account': {
        Id: { type: 's', data: 'account_mail1' },
        ProviderType: { type: 's', data: 'imap_smtp' },
        ProviderName: { type: 's', data: 'IMAP and SMTP' },
        Identity: { type: 's', data: 'goa-import@example.test' },
        PresentationIdentity: { type: 's', data: 'goa-import@example.test' }
      },
      'org.gnome.OnlineAccounts.Mail': {
        EmailAddress: { type: 's', data: 'goa-import@example.test' },
        ImapHost: { type: 's', data: 'imap.example.test' },
        ImapUseSsl: { type: 'b', data: true },
        ImapUserName: { type: 's', data: 'goa-import@example.test' },
        SmtpHost: { type: 's', data: 'smtp.example.test' },
        SmtpUseSsl: { type: 'b', data: true },
        SmtpUserName: { type: 's', data: 'goa-import@example.test' }
      }
    }
  }]
}

function fakeExecAvailable({ busctlOut, password = 'hunter2' } = {}) {
  return (cmd, args, _opts, cb) => {
    if (cmd !== 'busctl') return cb(new Error(`unexpected command: ${cmd}`), '')
    if (args.includes('Ping')) return cb(null, '')
    if (args.includes('GetManagedObjects')) return cb(null, JSON.stringify(busctlOut))
    if (args.includes('GetPassword')) return cb(null, JSON.stringify({ type: 's', data: [password] }))
    cb(new Error(`unexpected busctl args: ${args.join(' ')}`), '')
  }
}
function fakeExecUnavailable() {
  return (cmd, args, _opts, cb) => cb(new Error('no session bus'), '')
}

let server, base

before(async () => {
  await new Promise((resolve) => { server = createApp().listen(0, '127.0.0.1', resolve) })
  base = `http://127.0.0.1:${server.address().port}`
})
after(() => server.close())
beforeEach(() => { state.accounts = [] })

test('GET /api/goa/accounts: 200 + available:false when GOA is not reachable (not 503 — a browser logs a console error on any non-2xx fetch, and this is the common case, not a server error)', async () => {
  _setExecFileForTest(fakeExecUnavailable())
  const res = await fetch(`${base}/api/goa/accounts`, { headers: authed })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { available: false, accounts: [] })
})

test('GET /api/goa/accounts: lists sanitized accounts, no password field anywhere in the body', async () => {
  _setExecFileForTest(fakeExecAvailable({ busctlOut: MAIL_ACCOUNT_OBJECTS }))
  const res = await fetch(`${base}/api/goa/accounts`, { headers: authed })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.available, true)
  assert.equal(body.accounts.length, 1)
  assert.equal(body.accounts[0].goaId, 'account_mail1')
  assert.equal(body.accounts[0].hasMail, true)
  assert.ok(!JSON.stringify(body).includes('hunter2'), 'password must never reach the accounts listing')
})

test('GET /api/goa/accounts: requires the API token like every other route', async () => {
  _setExecFileForTest(fakeExecAvailable({ busctlOut: MAIL_ACCOUNT_OBJECTS }))
  const res = await fetch(`${base}/api/goa/accounts`)
  assert.equal(res.status, 401)
})

test('POST /api/goa/import: 400 without goaId', async () => {
  _setExecFileForTest(fakeExecAvailable({ busctlOut: MAIL_ACCOUNT_OBJECTS }))
  const res = await fetch(`${base}/api/goa/import`, { method: 'POST', headers: json, body: '{}' })
  assert.equal(res.status, 400)
})

test('POST /api/goa/import: 404 for an unknown goaId', async () => {
  _setExecFileForTest(fakeExecAvailable({ busctlOut: MAIL_ACCOUNT_OBJECTS }))
  const res = await fetch(`${base}/api/goa/import`, { method: 'POST', headers: json, body: JSON.stringify({ goaId: 'nope' }) })
  assert.equal(res.status, 404)
})

test('POST /api/goa/import: creates the account with the keyring password, never echoes it back', async () => {
  _setExecFileForTest(fakeExecAvailable({ busctlOut: MAIL_ACCOUNT_OBJECTS }))
  const res = await fetch(`${base}/api/goa/import`, {
    method: 'POST', headers: json, body: JSON.stringify({ goaId: 'account_mail1' })
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.success, true)
  assert.ok(!JSON.stringify(body).includes('hunter2'))

  assert.equal(state.accounts.length, 1)
  assert.equal(state.accounts[0].email, 'goa-import@example.test')
  assert.equal(state.accounts[0].imapHost, 'imap.example.test')
  assert.equal(state.accounts[0].imapPass, 'hunter2')
})

test('POST /api/goa/import: importing the same goaId again updates rather than duplicating', async () => {
  _setExecFileForTest(fakeExecAvailable({ busctlOut: MAIL_ACCOUNT_OBJECTS }))
  await fetch(`${base}/api/goa/import`, { method: 'POST', headers: json, body: JSON.stringify({ goaId: 'account_mail1' }) })
  await fetch(`${base}/api/goa/import`, { method: 'POST', headers: json, body: JSON.stringify({ goaId: 'account_mail1' }) })
  assert.equal(state.accounts.length, 1)
})

test('POST /api/goa/import: 503 when GOA is not reachable', async () => {
  _setExecFileForTest(fakeExecUnavailable())
  const res = await fetch(`${base}/api/goa/import`, { method: 'POST', headers: json, body: JSON.stringify({ goaId: 'account_mail1' }) })
  assert.equal(res.status, 503)
})

// ── WebDAV import, the owner's case ─────────────────────────────────────────
import http from 'node:http'

function webdavObjects(identity, davPort) {
  return {
    type: 'a{oa{sa{sv}}}',
    data: [{
      '/org/gnome/OnlineAccounts/Accounts/account_dav1': {
        'org.gnome.OnlineAccounts.Account': {
          Id: { type: 's', data: 'account_dav1' },
          ProviderType: { type: 's', data: 'webdav' },
          ProviderName: { type: 's', data: 'WebDAV' },
          Identity: { type: 's', data: identity },
          PresentationIdentity: { type: 's', data: identity }
        },
        'org.gnome.OnlineAccounts.Calendar': { Uri: { type: 's', data: `http://${encodeURIComponent(identity)}@127.0.0.1:${davPort}/caldav` } },
        'org.gnome.OnlineAccounts.Contacts': { Uri: { type: 's', data: `http://127.0.0.1:${davPort}/carddav` } }
      }
    }]
  }
}

// A DAV server root that only answers discovery + a calendar listing, and
// records the Authorization it saw.
async function fakeDavRoot() {
  const seen = []
  const s = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization })
      res.writeHead(207, { 'content-type': 'application/xml' })
      if (req.url === '/') return res.end('<d:multistatus xmlns:d="DAV:"><d:response><d:href>/</d:href><d:propstat><d:prop><d:current-user-principal><d:href>/principals/me/</d:href></d:current-user-principal></d:prop></d:propstat></d:response></d:multistatus>')
      if (req.url === '/principals/me/') return res.end('<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/principals/me/</d:href><d:propstat><d:prop><c:calendar-home-set><d:href>/caldav/</d:href></c:calendar-home-set></d:prop></d:propstat></d:response></d:multistatus>')
      if (req.url === '/caldav/') return res.end('<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/caldav/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response><d:response><d:href>/caldav/work/</d:href><d:propstat><d:prop><d:displayname>Work</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype></d:prop></d:propstat></d:response></d:multistatus>')
      res.end('<d:multistatus xmlns:d="DAV:"/>')
    })
  })
  await new Promise(r => s.listen(0, '127.0.0.1', r))
  return { port: s.address().port, seen, close: () => new Promise(r => s.close(r)) }
}

test('GOA mail + WebDAV import (same identity; re-import is idempotent) gives one complete account whose Calendar works via discovery', async () => {
  const dav = await fakeDavRoot()
  try {
    const both = webdavObjects('goa-import@example.test', dav.port)
    both.data[0] = { ...MAIL_ACCOUNT_OBJECTS.data[0], ...both.data[0] }
    _setExecFileForTest(fakeExecAvailable({ busctlOut: both, password: 'dav-and-mail-pass' }))
    const first = await fetch(`${base}/api/goa/import`, { method: 'POST', headers: json, body: JSON.stringify({ goaId: 'account_dav1' }) })
    assert.equal(first.status, 409, 'WebDAV first: asks for the mail account instead of creating a mail-less one')
    assert.equal(state.accounts.length, 0)
    for (const goaId of ['account_mail1', 'account_dav1', 'account_dav1', 'account_mail1']) {
      const r = await fetch(`${base}/api/goa/import`, { method: 'POST', headers: json, body: JSON.stringify({ goaId }) })
      assert.equal(r.status, 200, await r.text())
    }
    assert.equal(state.accounts.length, 1)
    const a = state.accounts[0]
    assert.equal(a.imapHost, 'imap.example.test')
    assert.equal(a.davUrl, `http://127.0.0.1:${dav.port}/`, 'host root, so discovery finds both home sets')
    assert.equal(a.davUser, 'goa-import@example.test')
    assert.equal(a.davPass, 'dav-and-mail-pass')

    const cal = await fetch(`${base}/api/calendar/calendars`, { headers: authed })
    assert.equal(cal.status, 200)
    const body = await cal.json()
    assert.deepEqual(body.calendars.map(c => [c.href, c.displayname]), [['/caldav/work/', 'Work']])
    const expected = 'Basic ' + Buffer.from('goa-import@example.test:dav-and-mail-pass').toString('base64')
    assert.ok(dav.seen.length >= 3 && dav.seen.every(s => s.auth === expected))
  } finally { await dav.close() }
})

test('GOA WebDAV-only account with a different identity attaches to targetEmail, never creates a mail-less account', async () => {
  const dav = await fakeDavRoot()
  try {
    state.accounts = [{ id: 'acct-m', email: 'me@example.test', imapHost: 'imap.example.test', imapPass: 'x', smtpHost: 's', smtpPass: 'x' }]
    _setExecFileForTest(fakeExecAvailable({ busctlOut: webdavObjects('webdav-login', dav.port), password: 'dp' }))
    const no = await fetch(`${base}/api/goa/import`, { method: 'POST', headers: json, body: JSON.stringify({ goaId: 'account_dav1' }) })
    assert.equal(no.status, 409)
    assert.equal((await no.json()).code, 'goa_needs_mail_account')
    assert.equal(state.accounts.length, 1)
    const ok = await fetch(`${base}/api/goa/import`, { method: 'POST', headers: json, body: JSON.stringify({ goaId: 'account_dav1', targetEmail: 'me@example.test' }) })
    assert.equal(ok.status, 200)
    assert.equal(state.accounts.length, 1)
    assert.equal(state.accounts[0].email, 'me@example.test')
    assert.equal(state.accounts[0].imapHost, 'imap.example.test')
    assert.equal(state.accounts[0].davUser, 'webdav-login')
    assert.equal(state.accounts[0].davPass, 'dp')
  } finally { await dav.close() }
})

test('GOA import with no keyring password: 502, nothing created, an existing password is not wiped', async () => {
  const noPass = (cmd, args, _o, cb) => {
    if (args.includes('Ping')) return cb(null, '')
    if (args.includes('GetManagedObjects')) return cb(null, JSON.stringify(MAIL_ACCOUNT_OBJECTS))
    cb(new Error('Did not find imap-password'), '')
  }
  _setExecFileForTest(noPass)
  const r = await fetch(`${base}/api/goa/import`, { method: 'POST', headers: json, body: JSON.stringify({ goaId: 'account_mail1' }) })
  assert.equal(r.status, 502)
  assert.equal(state.accounts.length, 0)
  state.accounts = [{ id: 'acct-g', email: 'goa-import@example.test', imapHost: 'imap.example.test', imapPass: 'stored', smtpHost: 's', smtpPass: 'stored' }]
  await fetch(`${base}/api/goa/import`, { method: 'POST', headers: json, body: JSON.stringify({ goaId: 'account_mail1' }) })
  assert.equal(state.accounts[0].imapPass, 'stored')
})
