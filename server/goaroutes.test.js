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

test('GET /api/goa/accounts: 503 + available:false when GOA is not reachable', async () => {
  _setExecFileForTest(fakeExecUnavailable())
  const res = await fetch(`${base}/api/goa/accounts`, { headers: authed })
  assert.equal(res.status, 503)
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
