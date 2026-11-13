import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  listGoaAccounts, getGoaPassword, resolveGoaImport,
  isGoaAvailable, _setExecFileForTest
} from './goa.js'

// --- fixtures -----------------------------------------------------------
// Shape matches `busctl --json=short call ... GetManagedObjects` against a
// real GNOME Online Accounts daemon (verified 2026-11 against a live
// leonard@schwier.org account of each type — see docs/design/goa-import.md).
// Every D-Bus value is wrapped as {type, data}.
const MAIL_PATH = '/org/gnome/OnlineAccounts/Accounts/account_mail1'
const DAV_PATH = '/org/gnome/OnlineAccounts/Accounts/account_dav1'

const MAIL_ACCOUNT = {
  type: 'a{oa{sa{sv}}}',
  data: [{
    [MAIL_PATH]: {
      'org.gnome.OnlineAccounts.Account': {
        Id: { type: 's', data: 'account_mail1' },
        ProviderType: { type: 's', data: 'imap_smtp' },
        ProviderName: { type: 's', data: 'IMAP and SMTP' },
        Identity: { type: 's', data: 'leonard@schwier.org' },
        PresentationIdentity: { type: 's', data: 'leonard@schwier.org' }
      },
      'org.gnome.OnlineAccounts.PasswordBased': {},
      'org.gnome.OnlineAccounts.Mail': {
        EmailAddress: { type: 's', data: 'leonard@schwier.org' },
        Name: { type: 's', data: 'Leonard Schwier' },
        ImapHost: { type: 's', data: 'imap.mailbox.org' },
        ImapUseSsl: { type: 'b', data: true },
        ImapUserName: { type: 's', data: 'leonard@schwier.org' },
        SmtpHost: { type: 's', data: 'smtp.mailbox.org' },
        SmtpUseSsl: { type: 'b', data: true },
        SmtpUserName: { type: 's', data: 'leonard@schwier.org' }
      }
    }
  }]
}

const DAV_ACCOUNT = {
  type: 'a{oa{sa{sv}}}',
  data: [{
    [DAV_PATH]: {
      'org.gnome.OnlineAccounts.Account': {
        Id: { type: 's', data: 'account_dav1' },
        ProviderType: { type: 's', data: 'webdav' },
        ProviderName: { type: 's', data: 'WebDAV' },
        Identity: { type: 's', data: 'leonard@schwier.org' },
        PresentationIdentity: { type: 's', data: 'leonard@schwier.org' }
      },
      'org.gnome.OnlineAccounts.PasswordBased': {},
      'org.gnome.OnlineAccounts.Calendar': {
        Uri: { type: 's', data: 'https://leonard%40schwier.org@dav.mailbox.org/caldav' }
      },
      'org.gnome.OnlineAccounts.Contacts': {
        Uri: { type: 's', data: 'https://leonard%40schwier.org@dav.mailbox.org/carddav' }
      }
    }
  }]
}

const EMPTY_MANAGER = {
  type: 'a{oa{sa{sv}}}',
  data: [{ '/org/gnome/OnlineAccounts/Manager': { 'org.gnome.OnlineAccounts.Manager': {} } }]
}

const MIXED_WITH_UNSUPPORTED = {
  type: 'a{oa{sa{sv}}}',
  data: [{
    '/org/gnome/OnlineAccounts/Accounts/account_google': {
      'org.gnome.OnlineAccounts.Account': {
        Id: { type: 's', data: 'account_google' },
        ProviderType: { type: 's', data: 'google' },
        Identity: { type: 's', data: 'someone@gmail.com' }
      }
    },
    [MAIL_PATH]: MAIL_ACCOUNT.data[0][MAIL_PATH]
  }]
}

// GOA's real error for a wrong GetPassword id: a non-zero exit, no stdout.
const BAD_PASSWORD_ID_ERR = Object.assign(
  new Error('Call failed: Did not find bogus-id with identity "leonard@schwier.org" in credentials'),
  { code: 1 }
)

// A fake `execFile` that answers by command + args, with configurable results.
function fakeExec({ getManagedObjects = null, gmoErr = null, pingErr = null, passwords = {} } = {}) {
  return (cmd, args, _opts, cb) => {
    if (cmd !== 'busctl') return cb(new Error(`unexpected command: ${cmd}`), '')
    if (args.includes('Ping')) return cb(pingErr || null, '')
    if (args.includes('GetManagedObjects')) {
      return cb(gmoErr, gmoErr ? '' : JSON.stringify(getManagedObjects))
    }
    if (args.includes('GetPassword')) {
      const objectPath = args[args.indexOf('call') + 2]
      const id = args[args.length - 1]
      const key = `${objectPath}|${id}`
      if (!(key in passwords)) return cb(BAD_PASSWORD_ID_ERR, '')
      return cb(null, JSON.stringify({ type: 's', data: [passwords[key]] }))
    }
    cb(new Error(`unexpected busctl args: ${args.join(' ')}`), '')
  }
}

test('isGoaAvailable: true when the session bus answers, false when it errors', async () => {
  _setExecFileForTest(fakeExec({}))
  assert.equal(await isGoaAvailable(), true)
  _setExecFileForTest(fakeExec({ pingErr: new Error('no bus') }))
  assert.equal(await isGoaAvailable(), false)
})

test('listGoaAccounts: empty manager -> empty list', async () => {
  _setExecFileForTest(fakeExec({ getManagedObjects: EMPTY_MANAGER }))
  assert.deepEqual(await listGoaAccounts(), [])
})

test('listGoaAccounts: busctl missing/erroring -> empty list, never throws', async () => {
  _setExecFileForTest(fakeExec({ gmoErr: new Error('command not found') }))
  assert.deepEqual(await listGoaAccounts(), [])
})

test('listGoaAccounts: surfaces an imap_smtp account with mail fields unwrapped', async () => {
  _setExecFileForTest(fakeExec({ getManagedObjects: MAIL_ACCOUNT }))
  const list = await listGoaAccounts()
  assert.equal(list.length, 1)
  assert.equal(list[0].goaId, 'account_mail1')
  assert.equal(list[0].providerType, 'imap_smtp')
  assert.equal(list[0].hasMail, true)
  assert.equal(list[0].hasDav, false)
  assert.equal(list[0].identity, 'leonard@schwier.org')
})

test('listGoaAccounts: surfaces a webdav account, reducing Calendar.Uri to the host root', async () => {
  _setExecFileForTest(fakeExec({ getManagedObjects: DAV_ACCOUNT }))
  const list = await listGoaAccounts()
  assert.equal(list.length, 1)
  assert.equal(list[0].providerType, 'webdav')
  assert.equal(list[0].hasDav, true)
  assert.equal(list[0].hasMail, false)
  assert.equal(list[0]._dav.davUrl, 'https://dav.mailbox.org/',
    'the concrete /caldav leaf must not become the shared basePath (lib/dav.js reuses it for contacts too)')
})

test('listGoaAccounts: filters out provider types leoposta does not support (e.g. google)', async () => {
  _setExecFileForTest(fakeExec({ getManagedObjects: MIXED_WITH_UNSUPPORTED }))
  const list = await listGoaAccounts()
  assert.equal(list.length, 1)
  assert.equal(list[0].goaId, 'account_mail1')
})

test('getGoaPassword: returns the password for a valid id', async () => {
  _setExecFileForTest(fakeExec({ passwords: { [`${MAIL_PATH}|imap-password`]: 'hunter2' } }))
  assert.equal(await getGoaPassword(MAIL_PATH, 'imap-password'), 'hunter2')
})

test('getGoaPassword: wrong id (GOA\'s "Did not find … in credentials") -> null, never throws', async () => {
  _setExecFileForTest(fakeExec({ passwords: {} }))
  assert.equal(await getGoaPassword(MAIL_PATH, 'bogus-id'), null)
})

test('resolveGoaImport: builds a mail payload, fetching imap-password and smtp-password separately', async () => {
  _setExecFileForTest(fakeExec({
    getManagedObjects: MAIL_ACCOUNT,
    passwords: { [`${MAIL_PATH}|imap-password`]: 'imap-secret', [`${MAIL_PATH}|smtp-password`]: 'smtp-secret' }
  }))
  const payload = await resolveGoaImport('account_mail1', { importMail: true, importDav: true })
  assert.equal(payload.email, 'leonard@schwier.org')
  assert.equal(payload.imapHost, 'imap.mailbox.org')
  assert.equal(payload.imapPort, 993)
  assert.equal(payload.imapTls, true)
  assert.equal(payload.imapPass, 'imap-secret')
  assert.equal(payload.smtpPass, 'smtp-secret')
  assert.equal(payload.davUrl, undefined)
})

test('resolveGoaImport: builds a DAV-only payload for a webdav-type account, password id ""', async () => {
  _setExecFileForTest(fakeExec({
    getManagedObjects: DAV_ACCOUNT,
    passwords: { [`${DAV_PATH}|`]: 'dav-secret' }
  }))
  const payload = await resolveGoaImport('account_dav1', { importMail: true, importDav: true })
  assert.equal(payload.davUrl, 'https://dav.mailbox.org/')
  assert.equal(payload.davUser, 'leonard@schwier.org')
  assert.equal(payload.davPass, 'dav-secret')
  assert.equal(payload.imapHost, undefined)
})

test('resolveGoaImport: unknown goaId -> null', async () => {
  _setExecFileForTest(fakeExec({ getManagedObjects: EMPTY_MANAGER }))
  assert.equal(await resolveGoaImport('does-not-exist'), null)
})

test('resolveGoaImport: a failed password lookup is an explicit null, not swallowed into the wrong shape', async () => {
  _setExecFileForTest(fakeExec({ getManagedObjects: MAIL_ACCOUNT, passwords: {} }))
  const payload = await resolveGoaImport('account_mail1', { importMail: true, importDav: false })
  assert.equal(payload.imapPass, null)
  assert.equal(payload.smtpPass, null)
})
