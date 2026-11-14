// OpenPGP on send against the real stack: keys per account, Sign + Encrypt
// in Compose (passphrase asked for a locked key), RFC 3156 PGP/MIME on the
// wire, the Sent copy decrypting with the sender's own key, the recipient
// account decrypting with its own key and verifying the signature, a third
// recipient known only from the keyring decrypting with openpgp; a missing
// recipient key sends nothing; sign-only mail verifies; the old global key
// is migrated to the accounts.
import fs from 'node:fs'
import path from 'node:path'
import * as openpgp from 'openpgp'
import { simpleParser } from 'mailparser'
import type { APIRequestContext, Page } from '@playwright/test'
import { test, expect, TOKEN, accountBody, smtpLog, type Mailbox } from './fixtures'
import { makeKey } from '../../server/fixtures/pgpMail.js'
import { newRecipient, openCompose, typeRecipients, fillMessage, sentPath, unique, openMessage } from './helpers-sending'
import { specialItem } from './helpers-folders'

const H = { 'x-leoposta-token': TOKEN }
const as = (email: string) => ({ ...H, 'x-account': email })
const PASS = 'Sender passphrase ✓'

async function accountId(request: APIRequestContext, baseURL: string, email: string): Promise<string> {
  const list = await (await request.get(`${baseURL}/api/accounts`, { headers: H })).json()
  return list.find((a: { email: string }) => a.email === email).id
}

async function resetKeyring(request: APIRequestContext, baseURL: string) {
  await request.delete(`${baseURL}/api/pgp/publics`, { headers: H })
}

async function waitSource(mb: Mailbox, folder: string, subject: string): Promise<string> {
  const msg = await mb.waitFor(folder, (m) => m.find((x) => x.subject === subject), 20_000)
  return msg.source ?? ''
}

async function decryptWith(raw: string, privateArmored: string, verifyArmored: string, passphrase?: string) {
  const parsed = await simpleParser(raw)
  const blob = parsed.attachments.find((a) => /-----BEGIN PGP MESSAGE-----/.test(a.content.toString()))
  expect(blob, 'the encrypted part').toBeTruthy()
  const { data, signatures } = await openpgp.decrypt({
    message: await openpgp.readMessage({ armoredMessage: blob!.content.toString() }),
    decryptionKeys: passphrase
      ? await openpgp.decryptKey({ privateKey: await openpgp.readPrivateKey({ armoredKey: privateArmored }), passphrase })
      : await openpgp.readPrivateKey({ armoredKey: privateArmored }),
    verificationKeys: await openpgp.readKey({ armoredKey: verifyArmored }),
    expectSigned: true
  })
  await signatures[0].verified
  return simpleParser(Buffer.from(String(data)))
}

async function switchTo(app: Page, request: APIRequestContext, baseURL: string, email: string) {
  await app.getByLabel('Account', { exact: true }).selectOption(await accountId(request, baseURL, email))
}

test.describe('pgp send', () => {
  test.describe('sign + encrypt', () => {
    test.use({ allowApiErrors: [['POST /api/pgp/unlock -> 401', /status of 401/], { scope: 'test' }] })
    test('signed + encrypted mail: passphrase asked, PGP/MIME on the wire, Sent copy, recipient account and keyring recipient decrypt and verify', async ({ app, request, baseURL, user, mailbox }) => {
      test.setTimeout(120_000)
      await resetKeyring(request, baseURL!)
      const bobMb = await newRecipient('bob')
      const carolMb = await newRecipient('carol')
      const [meKey, bobKey, carolKey] = await Promise.all([
        makeKey({ email: user, passphrase: PASS }),
        makeKey({ email: bobMb.email }),
        makeKey({ email: carolMb.email })
      ])
      // Bob is a second account of the app with his own key; Carol is only in the keyring.
      expect((await request.post(`${baseURL}/api/accounts`, { headers: H, data: accountBody(bobMb.email, { name: 'Bob' }) })).status()).toBe(200)
      expect((await request.put(`${baseURL}/api/pgp`, { headers: as(bobMb.email), data: { privateAsc: bobKey.privateKey } })).status()).toBe(200)
      // My key: stored locked (no passphrase given).
      expect((await request.put(`${baseURL}/api/pgp`, { headers: as(user), data: { privateAsc: meKey.privateKey } })).status()).toBe(200)
      await app.reload()

      // Carol's public key through Settings → PGP.
      await app.locator('.settings-btn').click()
      await app.locator('#pgp-public').fill(carolKey.publicKey)
      await app.getByRole('button', { name: 'Save PGP key' }).click()
      await expect(app.locator('.pgp-ok')).toContainText('Public key added')
      await expect(app.getByTestId('pgp-publics')).toContainText(carolMb.email)
      await app.getByRole('button', { name: 'Close settings' }).click()

      const subject = unique('Encrypted')
      await openCompose(app)
      await typeRecipients(app, 'to', `Bob <${bobMb.email}>`)
      await typeRecipients(app, 'cc', carolMb.email)
      await fillMessage(app, subject, 'Streng geheim — ünïcode ✓\nZweite Zeile')
      const compose = app.locator('.modal.compose')
      await compose.locator('label.pgp-toggle', { hasText: 'Sign' }).locator('input').check()
      await compose.locator('label.pgp-toggle', { hasText: 'Encrypt' }).locator('input').check()
      await compose.locator('input[type=file]').setInputFiles({ name: 'plan.txt', mimeType: 'text/plain', buffer: Buffer.from('the secret plan') })
      await expect(compose.locator('.attachment-chip')).toContainText('plan.txt')
      await expect(compose.getByTestId('pgp-missing')).toHaveCount(0)

      const before = smtpLog().length
      await compose.getByRole('button', { name: 'Send', exact: true }).click()
      // The key is locked: the window asks for the passphrase, nothing is sent yet.
      const pass = compose.locator('#compose-pgp-pass')
      await expect(pass).toBeVisible()
      expect(smtpLog().length).toBe(before)
      await pass.fill('wrong')
      await compose.getByRole('button', { name: 'Unlock and send' }).click()
      await expect(compose.locator('.pgp-pass [role=alert]')).toContainText('Wrong passphrase')
      expect(smtpLog().length).toBe(before)
      await pass.fill(PASS)
      await compose.getByRole('button', { name: 'Unlock and send' }).click()
      await expect(app.locator('.modal.compose')).toHaveCount(0, { timeout: 30_000 })

      // On the wire: RFC 3156 multipart/encrypted, nothing in clear.
      await expect.poll(() => smtpLog().slice(before).length, { timeout: 20_000 }).toBeGreaterThan(0)
      const wire = smtpLog().slice(before)
      expect(wire).toHaveLength(1)
      expect(wire[0].to.sort()).toEqual([bobMb.email, carolMb.email].sort())
      expect(wire[0].raw.replace(/\r\n[ \t]+/g, ' ')).toMatch(/Content-Type: multipart\/encrypted; protocol="application\/pgp-encrypted"/)
      expect(wire[0].raw).not.toContain('Streng geheim')
      expect(wire[0].raw).not.toContain('plan.txt')

      // Carol (keyring only) decrypts with her key; the signature is mine.
      const carolMail = await decryptWith(await waitSource(carolMb, 'INBOX', subject), carolKey.privateKey, meKey.publicKey)
      expect(carolMail.text?.trim()).toBe('Streng geheim — ünïcode ✓\nZweite Zeile')
      expect(carolMail.attachments.map((a) => a.filename)).toEqual(['plan.txt'])

      // The Sent copy on the server is the encrypted message, readable in the app.
      await sentPath(mailbox) // asserts the \Sent mailbox is the layout's "Sent"
      const sentSrc = await waitSource(mailbox, 'Sent', subject)
      expect(sentSrc).toMatch(/multipart\/encrypted/)
      expect(sentSrc).not.toContain('Streng geheim')
      expect((await decryptWith(sentSrc, meKey.privateKey, meKey.publicKey, PASS)).text).toContain('Streng geheim')
      await specialItem(app, 'Sent').click()
      await openMessage(app, subject)
      await expect(app.locator('.pgp-banner')).toContainText('decrypted')
      await expect(app.locator('.pgp-chip')).toContainText('signature verified')
      await expect(app.locator('.message-content').getByText('Streng geheim — ünïcode ✓')).toBeVisible()
      await expect(app.locator('.attachment-item', { hasText: 'plan.txt' })).toBeVisible()
      await expect(app.getByText('encrypted.asc')).toHaveCount(0)

      // Bob reads it in his account, with his own key.
      await switchTo(app, request, baseURL!, bobMb.email)
      await openMessage(app, subject)
      await expect(app.locator('.pgp-banner')).toContainText('decrypted')
      await expect(app.locator('.pgp-chip')).toContainText('signature verified')
      await expect(app.locator('.message-content').getByText('Streng geheim — ünïcode ✓')).toBeVisible()
      const [dl] = await Promise.all([app.waitForEvent('download'), app.locator('.attachment-item', { hasText: 'plan.txt' }).click()])
      const file = await dl.path()
      expect(fs.readFileSync(file!, 'utf8')).toBe('the secret plan')
      await resetKeyring(request, baseURL!)
    })
  })

  test('a recipient without a key: named in Compose, Send refuses, nothing reaches SMTP', async ({ app, request, baseURL, user }) => {
    await resetKeyring(request, baseURL!)
    const me = await makeKey({ email: user })
    expect((await request.put(`${baseURL}/api/pgp`, { headers: as(user), data: { privateAsc: me.privateKey } })).status()).toBe(200)
    await app.reload()
    const subject = unique('NoKey')
    await openCompose(app)
    await typeRecipients(app, 'to', 'stranger@example.test')
    await fillMessage(app, subject, 'must not go out')
    const compose = app.locator('.modal.compose')
    await compose.locator('label.pgp-toggle', { hasText: 'Encrypt' }).locator('input').check()
    await expect(compose.getByTestId('pgp-missing')).toContainText('stranger@example.test')
    const before = smtpLog().length
    await compose.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(compose.locator('.send-error')).toContainText('No PGP public key for stranger@example.test')
    await expect(compose).toBeVisible()
    // Turning Encrypt off is the explicit way to send it in clear.
    await app.waitForTimeout(500)
    expect(smtpLog().slice(before).filter((m) => m.raw.includes(subject))).toHaveLength(0)
  })

  test('sign only: multipart/signed on the wire, the recipient account sees a verified signature and no signature.asc', async ({ app, request, baseURL, user, mailbox }) => {
    test.setTimeout(90_000)
    await resetKeyring(request, baseURL!)
    const bobMb = await newRecipient('bob')
    const me = await makeKey({ email: user })
    expect((await request.post(`${baseURL}/api/accounts`, { headers: H, data: accountBody(bobMb.email, { name: 'Bob' }) })).status()).toBe(200)
    expect((await request.put(`${baseURL}/api/pgp`, { headers: as(user), data: { privateAsc: me.privateKey } })).status()).toBe(200)
    await app.reload()
    const subject = unique('Signed')
    await openCompose(app)
    await typeRecipients(app, 'to', bobMb.email)
    await fillMessage(app, subject, 'Signed, not secret — Grüße')
    const compose = app.locator('.modal.compose')
    await compose.locator('label.pgp-toggle', { hasText: 'Sign' }).locator('input').check()
    await compose.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(app.locator('.modal.compose')).toHaveCount(0, { timeout: 30_000 })

    const src = await waitSource(bobMb, 'INBOX', subject)
    expect(src.replace(/\r\n[ \t]+/g, ' ')).toMatch(/Content-Type: multipart\/signed; micalg=pgp-sha\d+; protocol="application\/pgp-signature"/)
    await sentPath(mailbox)
    expect(await waitSource(mailbox, 'Sent', subject)).toMatch(/multipart\/signed/)

    await switchTo(app, request, baseURL!, bobMb.email)
    await openMessage(app, subject)
    await expect(app.getByTestId('pgp-signed')).toContainText('signature verified')
    await expect(app.locator('.message-content').getByText('Signed, not secret — Grüße')).toBeVisible()
    await expect(app.locator('.message-view').getByText('signature.asc')).toHaveCount(0)
  })

  test('the old global key (pgp_private.asc) is moved to the account and still decrypts', async ({ app, request, baseURL, user }, info) => {
    const legacy = await makeKey({ email: user })
    const dataDir = path.resolve(info.project.name === 'desktop' ? '.e2e-real/data-desktop' : '.e2e-real/data-pwa')
    const id = await accountId(request, baseURL!, user)
    fs.rmSync(path.join(dataDir, 'pgp-keys', `${id}.asc`), { force: true })
    fs.writeFileSync(path.join(dataDir, 'pgp_private.asc'), legacy.privateKey, { mode: 0o600 })
    await app.locator('.settings-btn').click()
    await expect(app.getByTestId('pgp-state')).toContainText(user)
    await expect(app.getByTestId('pgp-state')).toContainText('not passphrase-protected')
    expect(fs.existsSync(path.join(dataDir, 'pgp_private.asc'))).toBe(false)
    expect(fs.readFileSync(path.join(dataDir, 'pgp-keys', `${id}.asc`), 'utf8')).toBe(legacy.privateKey)
  })
})
