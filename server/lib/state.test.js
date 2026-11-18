import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.LEOPOSTA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'leoposta-state-'))
const { state, addAccount, updateAccount, decodeAccountHeader, resolveAccount } = await import('./state.js')

beforeEach(() => { state.accounts = [] })

test('updateAccount: a partial body (e.g. DAV-only) does not blank mail fields it never mentioned', () => {
  addAccount({
    email: 'a@example.test', name: 'A',
    imapHost: 'imap.example.test', imapUser: 'a@example.test', imapPass: 'imap-secret',
    smtpHost: 'smtp.example.test', smtpUser: 'a@example.test', smtpPass: 'smtp-secret',
    signature: { enabled: true, text: 'Cheers', position: 'standard' }
  })

  // Exactly the shape the GOA "webdav"-type import sends: DAV fields only.
  updateAccount('a@example.test', {
    davUrl: 'https://dav.example.test/', davUser: 'a@example.test', davPass: 'dav-secret'
  })

  const acct = state.accounts[0]
  assert.equal(acct.imapHost, 'imap.example.test', 'imapHost must survive a DAV-only update')
  assert.equal(acct.imapUser, 'a@example.test')
  assert.equal(acct.imapPass, 'imap-secret')
  assert.equal(acct.smtpHost, 'smtp.example.test', 'smtpHost must survive a DAV-only update')
  assert.equal(acct.smtpPass, 'smtp-secret')
  assert.deepEqual(acct.signature, { enabled: true, text: 'Cheers', position: 'standard' },
    'signature must survive an update that does not mention it')
  assert.equal(acct.davUrl, 'https://dav.example.test/')
  assert.equal(acct.davUser, 'a@example.test')
  assert.equal(acct.davPass, 'dav-secret')
})

test('updateAccount: a field present in the body (even falsy, e.g. imapTls:false) does override', () => {
  addAccount({
    email: 'a@example.test', imapHost: 'imap.example.test', imapTls: true, imapPort: 993
  })
  updateAccount('a@example.test', { imapHost: 'imap.example.test', imapTls: false, imapPort: 143 })
  const acct = state.accounts[0]
  assert.equal(acct.imapTls, false)
  assert.equal(acct.imapPort, 143)
})

test('updateAccount: sending davUrl explicitly as "" clears it rather than keeping the old value', () => {
  addAccount({ email: 'a@example.test', davUrl: 'https://dav.example.test/' })
  updateAccount('a@example.test', { davUrl: '' })
  // '' and undefined are equivalent to every reader (lib/dav.js resolveDavTarget
  // and this module's own davFields both use a truthy check) — only falsy-ness
  // matters here, not the exact value.
  assert.ok(!state.accounts[0].davUrl, 'expected davUrl to be cleared (falsy)')
})

test('updateAccount: mail-only update (e.g. GOA imap_smtp import) does not blank an existing davUrl', () => {
  addAccount({
    email: 'a@example.test',
    davUrl: 'https://dav.example.test/', davUser: 'a@example.test', davPass: 'dav-secret'
  })
  updateAccount('a@example.test', {
    imapHost: 'imap.example.test', imapUser: 'a@example.test', imapPass: 'imap-secret',
    smtpHost: 'smtp.example.test', smtpUser: 'a@example.test', smtpPass: 'smtp-secret'
  })
  const acct = state.accounts[0]
  assert.equal(acct.davUrl, 'https://dav.example.test/', 'davUrl must survive a mail-only update')
  assert.equal(acct.davPass, 'dav-secret')
  assert.equal(acct.imapHost, 'imap.example.test')
})

test('updateAccount: a null password (e.g. GOA keyring lookup failed) keeps the stored one', () => {
  addAccount({ email: 'a@example.test', imapHost: 'imap', imapPass: 'keep-me', smtpPass: 'keep-smtp', davPass: 'keep-dav' })
  updateAccount('a@example.test', { imapPass: null, smtpPass: null, davPass: null, davUrl: 'https://dav.example.test/' })
  const acct = state.accounts[0]
  assert.equal(acct.imapPass, 'keep-me')
  assert.equal(acct.smtpPass, 'keep-smtp')
  assert.equal(acct.davPass, 'keep-dav')
})

test('updateAccount / removeAccount drop the account\'s cached DAV reads', async () => {
  const { removeAccount } = await import('./state.js')
  const a = addAccount({ email: 'a@example.test', davUrl: 'https://old.example.test/' })
  state.davCache.set(`books|${a.id}`, { addressBooks: [{ href: '/old/' }] })
  state.davCache.set(`contacts|${a.id}|/old/`, [])
  updateAccount('a@example.test', { davUrl: 'https://new.example.test/' })
  assert.equal(state.davCache.get(`books|${a.id}`), undefined)
  assert.equal(state.davCache.get(`contacts|${a.id}|/old/`), undefined)
  state.davCache.set(`books|${a.id}`, { addressBooks: [] })
  removeAccount('a@example.test')
  assert.equal(state.davCache.get(`books|${a.id}`), undefined)
})

test('resolveDataDir: env wins; legacy server/ state is kept; otherwise the per-user data dir, never the install dir', async () => {
  const { resolveDataDir } = await import('./state.js')
  const none = () => false
  assert.equal(resolveDataDir({ env: { LEOPOSTA_DATA_DIR: '/tmp/x' }, serverDir: '/opt/app/server', home: '/home/u', exists: none }), '/tmp/x')
  assert.equal(resolveDataDir({ env: {}, serverDir: '/opt/app/server', home: '/home/u', exists: none }), '/home/u/.local/share/leoposta')
  assert.equal(resolveDataDir({ env: { XDG_DATA_HOME: '/xdg' }, serverDir: '/opt/app/server', home: '/home/u', exists: none }), '/xdg/leoposta')
  assert.equal(resolveDataDir({ env: {}, serverDir: '/opt/app/server', home: '/home/u', exists: (p) => p === '/opt/app/server/pgp_private.asc' }), '/opt/app/server')
})

// The client names the account in `x-account`. A header value cannot carry a character
// above U+00FF, so the client sends such an address as `u8:` + encodeURIComponent(email)
// (src/lib/accountHeader.ts). Without the decode the account was "not found" (400).
const u8 = (email) => 'u8:' + encodeURIComponent(email)
const reqWith = (header) => ({ headers: header === undefined ? {} : { 'x-account': header }, query: {} })

test('decodeAccountHeader: only a "u8:" value is decoded, every other value is taken as written', () => {
  assert.equal(decodeAccountHeader('erika@example.test'), 'erika@example.test')
  assert.equal(decodeAccountHeader('a%41@example.test'), 'a%41@example.test', 'a percent sign in a plain address is not an escape')
  assert.equal(decodeAccountHeader('jörg@example.test'), 'jörg@example.test', 'Latin-1 headers sent by older clients still work')
  assert.equal(decodeAccountHeader(u8('erika@пример.test')), 'erika@пример.test')
  assert.equal(decodeAccountHeader(u8('łukasz@example.test')), 'łukasz@example.test')
  assert.equal(decodeAccountHeader('u8:%E0%A4%A'), null, 'a malformed escape is refused, not thrown')
})

test('resolveAccount: finds an account whose address needs the encoded header', () => {
  addAccount({ email: 'first@example.test', imapHost: 'imap.example.test' })
  addAccount({ email: 'erika@пример.test', imapHost: 'imap.example.test' })
  assert.equal(resolveAccount(reqWith(u8('erika@пример.test'))).email, 'erika@пример.test')
  assert.equal(resolveAccount(reqWith(u8('ERIKA@пример.test'))).email, 'erika@пример.test', 'case-insensitive like a plain address')
  assert.equal(resolveAccount(reqWith('first@example.test')).email, 'first@example.test')
})

test('resolveAccount: an unknown or malformed encoded header never falls back to the first account', () => {
  addAccount({ email: 'first@example.test', imapHost: 'imap.example.test' })
  assert.equal(resolveAccount(reqWith(u8('gone@пример.test'))), null)
  assert.equal(resolveAccount(reqWith('u8:%E0%A4%A')), null)
  assert.equal(resolveAccount(reqWith('u8:')), null)
  assert.equal(resolveAccount(reqWith(undefined)).email, 'first@example.test', 'no header still means the first account')
})

// The IDLE stream (SSE) cannot set headers, so it names the account in `?account=`.
// An address that is not an account (one that was removed while the page was open)
// used to fall back to the first account: the stream then watched another account's
// inbox. The header already answers "no account" for an unknown address.
const reqWithQuery = (account, headers = {}) => ({ headers, query: account === undefined ? {} : { account } })

test('resolveAccount: an unknown ?account= is no account, never the first one', () => {
  addAccount({ email: 'first@example.test', imapHost: 'imap.example.test' })
  addAccount({ email: 'second@example.test', imapHost: 'imap.example.test' })
  assert.equal(resolveAccount(reqWithQuery('gone@example.test')), null)
  assert.equal(resolveAccount(reqWithQuery(['first@example.test', 'second@example.test'])), null, 'a repeated parameter is not an address')
  assert.equal(resolveAccount(reqWithQuery({ email: 'first@example.test' })), null, 'a nested parameter is not an address')
})

test('resolveAccount: a known ?account= still resolves, and no hint still means the first account', () => {
  addAccount({ email: 'first@example.test', imapHost: 'imap.example.test' })
  addAccount({ email: 'second@example.test', imapHost: 'imap.example.test' })
  assert.equal(resolveAccount(reqWithQuery('SECOND@example.test')).email, 'second@example.test')
  assert.equal(resolveAccount(reqWithQuery(undefined)).email, 'first@example.test')
  assert.equal(resolveAccount(reqWithQuery('', {})).email, 'first@example.test', 'an empty hint is no hint')
  assert.equal(resolveAccount(reqWithQuery('second@example.test', { 'x-account': 'first@example.test' })).email, 'first@example.test', 'the header wins over the query')
})

test('GET /api/idle?account=<unknown> ends with "No account configured" and opens no IMAP session', async () => {
  const { default: express } = await import('express')
  const { createIdleRouter } = await import('../routes/idle.js')
  addAccount({ email: 'first@example.test', imapHost: 'imap.example.test' })
  let clients = 0
  const app = express()
  app.use('/api', createIdleRouter({ resolve: resolveAccount, createClient: () => { clients++; throw new Error('must not connect') } }))
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  try {
    const { port } = server.address()
    const gone = await (await fetch(`http://127.0.0.1:${port}/api/idle?account=gone%40example.test`)).text()
    assert.match(gone, /No account configured/)
    assert.doesNotMatch(gone, /ready/)
    assert.equal(clients, 0)
  } finally {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  }
})
