// OpenPGP against the real stack: store a passphrase-protected key through
// Settings (a wrong passphrase stores nothing), decrypt inline and PGP/MIME
// mail seeded encrypted to that key (with a verified signature and an
// encrypted attachment), lock / unlock from the message view, and the key
// files living in LEOPOSTA_DATA_DIR.
import fs from 'node:fs'
import path from 'node:path'
import { test, expect, TOKEN } from './fixtures'
import { makeKey, inlineEncrypted, pgpMimeEncrypted } from '../../server/fixtures/pgpMail.js'
import type { APIRequestContext, Page } from '@playwright/test'

const H = { 'x-leoposta-token': TOKEN }
const PASS = 'correct horse battery staple'

async function resetPgp(request: APIRequestContext, baseURL: string) {
  await request.delete(`${baseURL}/api/pgp`, { headers: H })
}

async function appendRaw(mailbox: { with: <T>(fn: (c: import('imapflow').ImapFlow) => Promise<T>) => Promise<T> }, raw: Buffer) {
  await mailbox.with(async (c) => { await c.append('INBOX', raw, [], new Date()) })
}

async function openPgpSettings(app: Page) {
  await app.locator('.settings-btn').click()
  await app.locator('#pgp-private').scrollIntoViewIfNeeded()
}

test.describe('pgp', () => {
  test.describe('key setup', () => {
    test.use({ allowApiErrors: [['PUT /api/pgp -> 400', /status of 400/], { scope: 'test' }] })
    test('wrong passphrase is a clear error and stores nothing; the right one stores the key in LEOPOSTA_DATA_DIR', async ({ app, request, baseURL }, info) => {
      await resetPgp(request, baseURL!)
      const key = await makeKey({ email: 'me@example.test', passphrase: PASS })
      await openPgpSettings(app)
      await app.locator('#pgp-private').fill(key.privateKey)
      await app.locator('#pgp-public').fill(key.publicKey)
      await app.locator('#pgp-passphrase').fill('not the passphrase')
      await app.getByRole('button', { name: /Save PGP|Save key/i }).click()
      await expect(app.locator('.pgp-err')).toContainText('Wrong passphrase for this private key')
      expect((await (await request.get(`${baseURL}/api/pgp/status`, { headers: H })).json()).hasPrivateKey).toBe(false)

      await app.locator('#pgp-passphrase').fill(PASS)
      await app.getByRole('button', { name: /Save PGP|Save key/i }).click()
      await expect(app.locator('.pgp-ok')).toContainText('PGP key saved and unlocked')
      await expect(app.getByTestId('pgp-state')).toContainText('unlocked')
      // Not passphrase in any file; files in the data dir, mode 0600.
      const dataDir = path.resolve(info.project.name === 'desktop' ? '.e2e-real/data-desktop' : '.e2e-real/data-pwa')
      const priv = path.join(dataDir, 'pgp_private.asc')
      expect(fs.existsSync(priv)).toBe(true)
      expect(fs.statSync(priv).mode & 0o777).toBe(0o600)
      for (const f of fs.readdirSync(dataDir)) {
        const p = path.join(dataDir, f)
        if (fs.statSync(p).isFile()) expect(fs.readFileSync(p, 'utf8')).not.toContain(PASS)
      }
      expect(fs.existsSync(path.resolve('server/pgp_private.asc'))).toBe(false)

      // Lock / unlock from Settings
      await app.getByTestId('pgp-state').getByRole('button', { name: 'Lock key' }).click()
      await expect(app.getByTestId('pgp-state')).toContainText('locked')
      await app.getByLabel('PGP key passphrase').fill(PASS)
      await app.getByTestId('pgp-state').getByRole('button', { name: 'Unlock' }).click()
      await expect(app.getByTestId('pgp-state')).toContainText('unlocked')
      await resetPgp(request, baseURL!)
    })
  })

  test.describe('reading encrypted mail', () => {
    test.use({ allowApiErrors: [['POST /api/pgp/unlock -> 401', /status of 401/], { scope: 'test' }] })
    test('inline and PGP/MIME messages decrypt; lock hides them; unlock in the message view (wrong passphrase first)', async ({ app, mailbox, request, baseURL, user }) => {
      await resetPgp(request, baseURL!)
      const me = await makeKey({ email: user, passphrase: PASS })
      const sender = await makeKey({ email: 'alice@example.test' })
      // Recipient key + the sender's public key (to verify her signature).
      expect((await request.put(`${baseURL}/api/pgp`, { headers: H, data: { privateAsc: me.privateKey, publicAsc: sender.publicKey, passphrase: PASS } })).status()).toBe(200)

      await appendRaw(mailbox, await inlineEncrypted({ from: 'Alice <alice@example.test>', to: user, subject: 'Inline secret', text: 'The inline plaintext — ünïcode ✓', publicKey: me.publicKey, signWith: sender.privateKey }))
      await appendRaw(mailbox, await pgpMimeEncrypted({
        from: 'Alice <alice@example.test>', to: user, subject: 'MIME secret', text: 'The PGP/MIME plaintext',
        attachments: [{ filename: 'plan.txt', content: 'attachment body', contentType: 'text/plain' }], publicKey: me.publicKey
      }))
      await app.reload()

      await app.getByText('Inline secret').first().click({ position: { x: 2, y: 2 } })
      await expect(app.locator('.pgp-banner')).toContainText('decrypted')
      await expect(app.locator('.pgp-chip')).toContainText('signature verified')
      await expect(app.locator('.message-content').getByText('The inline plaintext — ünïcode ✓')).toBeVisible()
      await expect(app.locator('.message-content')).not.toContainText('BEGIN PGP MESSAGE')

      await app.getByText('MIME secret').first().click({ position: { x: 2, y: 2 } })
      await expect(app.locator('.message-content').getByText('The PGP/MIME plaintext')).toBeVisible()
      await expect(app.getByText('plan.txt').first()).toBeVisible()
      await expect(app.getByText('encrypted.asc')).toHaveCount(0)

      // Lock: the plaintext disappears.
      await app.getByRole('button', { name: /Lock key/ }).click()
      await expect(app.locator('.message-content').getByText('The PGP/MIME plaintext')).toHaveCount(0)
      await app.getByText('Inline secret').first().click({ position: { x: 2, y: 2 } })
      await expect(app.locator('.pgp-banner')).toContainText('cannot decrypt')
      await expect(app.locator('.message-content').getByText('The inline plaintext — ünïcode ✓')).toHaveCount(0)

      // Unlock from the banner: wrong, then right.
      const pass = app.getByPlaceholder('Key passphrase')
      await pass.fill('wrong')
      await app.getByRole('button', { name: 'Unlock', exact: true }).click()
      await expect(app.locator('.pgp-unlock-err')).toContainText('Wrong passphrase. The key stays locked.')
      await pass.fill(PASS)
      await app.getByRole('button', { name: 'Unlock', exact: true }).click()
      await expect(app.locator('.message-content').getByText('The inline plaintext — ünïcode ✓')).toBeVisible()
      await resetPgp(request, baseURL!)
    })
  })

  test('without a key an encrypted message explains what to do', async ({ app, mailbox, request, baseURL, user }) => {
    await resetPgp(request, baseURL!)
    const other = await makeKey({ email: user })
    await appendRaw(mailbox, await inlineEncrypted({ from: 'alice@example.test', to: user, subject: 'No key here', text: 'unreadable', publicKey: other.publicKey }))
    await app.reload()
    await app.getByText('No key here').first().click({ position: { x: 2, y: 2 } })
    await expect(app.locator('.pgp-banner')).toContainText('No OpenPGP private key is set up')
    await expect(app.locator('.message-content').getByText('unreadable')).toHaveCount(0)
  })
})
