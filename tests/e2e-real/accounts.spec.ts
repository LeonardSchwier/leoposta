// Accounts & Settings against the real stack: first run without an account,
// adding one through the Settings form (verified login), wrong password,
// editing, signature round-trip, removal, two accounts side by side, and
// persistence of the account file across a server restart.
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect, Mailbox, uniqueUser, accountBody, smtpLog, TOKEN, IMAP_PORT, SMTP_PORT, PASSWORD, DAV_PORT } from './fixtures'
import type { APIRequestContext, Page } from '@playwright/test'

const H = { 'x-leoposta-token': TOKEN }

async function clearAccounts(request: APIRequestContext, baseURL: string) {
  const list = await (await request.get(`${baseURL}/api/accounts`, { headers: H })).json()
  for (const a of list) await request.delete(`${baseURL}/api/accounts/${encodeURIComponent(a.email)}`, { headers: H })
}

async function newMailbox(prefix: string): Promise<Mailbox> {
  const mb = new Mailbox(uniqueUser(prefix))
  await mb.with(async () => {})
  return mb
}

/** Fill the Settings "Add account" form for a stack mailbox. */
async function fillAccountForm(page: Page, email: string, password: string, name = 'Test Person') {
  await page.locator('#acct-name').fill(name)
  await page.locator('#acct-email').fill(email)
  await page.locator('#imap-host').fill('127.0.0.1')
  await page.locator('#imap-port').fill(String(IMAP_PORT))
  await page.getByLabel('IMAP SSL/TLS').uncheck()
  await page.locator('#smtp-host').fill('127.0.0.1')
  await page.locator('#smtp-port').fill(String(SMTP_PORT))
  await page.getByLabel('SMTP SSL/TLS').uncheck()
  await page.locator('#dav-url').fill(`http://127.0.0.1:${DAV_PORT}/${encodeURIComponent(email)}/`)
  await page.locator('#acct-pass').fill(password)
}

test.describe('accounts', () => {
  test('first run: no account -> guided empty state without failing API calls; add the account through Settings', async ({ page, request, baseURL }) => {
    await clearAccounts(request, baseURL!)
    const mb = await newMailbox('first')
    await mb.seed('INBOX', [{ subject: 'Welcome aboard', text: 'first mail' }])

    await page.goto('/')
    await expect(page.getByTestId('first-run')).toBeVisible()
    await expect(page.getByTestId('first-run')).toContainText('No mail account is set up yet')

    await page.getByRole('button', { name: 'Set up an account' }).click()
    await fillAccountForm(page, mb.email, PASSWORD, 'First Person')
    await page.locator('#sig-text').fill('Cheers\nFirst')
    await page.getByLabel('Append signature').check()
    await page.getByRole('button', { name: 'Add Account', exact: true }).click()

    await expect(page.locator('.settings-modal')).toHaveCount(0)
    await expect(page.getByTestId('first-run')).toHaveCount(0)
    await expect(page.getByText('Welcome aboard').first()).toBeVisible()

    // Stored settings, and no secret ever leaves the server.
    const list = await (await request.get(`${baseURL}/api/accounts`, { headers: H })).json()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ email: mb.email, name: 'First Person', imapPort: IMAP_PORT, imapTls: false, smtpPort: SMTP_PORT, smtpTls: false, signature: { enabled: true, text: 'Cheers\nFirst' } })
    for (const k of ['imapPass', 'smtpPass', 'davPass', 'password']) expect(list[0]).not.toHaveProperty(k)
    expect(JSON.stringify(list)).not.toContain(`"${PASSWORD}"`)
  })

  test.describe('wrong password', () => {
    // The expected 400 of the rejected save. (An array option value must be
    // wrapped: Playwright reads a bare array as a [value, options] tuple.)
    test.use({ allowApiErrors: [['POST /api/accounts -> 400', /status of 400/], { scope: 'test' }] })
    test('is a clear error next to Save and nothing is stored', async ({ page, request, baseURL }) => {
      await clearAccounts(request, baseURL!)
      const mb = await newMailbox('wrong')
      await page.goto('/')
      await page.getByRole('button', { name: 'Set up an account' }).click()
      await fillAccountForm(page, mb.email, 'definitely-wrong')
      await page.getByRole('button', { name: 'Add Account', exact: true }).click()
      const err = page.locator('.footer-error')
      await expect(err).toBeVisible()
      await expect(err).toContainText(/IMAP/i)
      await expect(err).toContainText(/password|login|auth/i)
      expect(await (await request.get(`${baseURL}/api/accounts`, { headers: H })).json()).toEqual([])
      // Correcting the password then works from the same form.
      await page.locator('#acct-pass').fill(PASSWORD)
      await page.getByRole('button', { name: 'Add Account', exact: true }).click()
      await expect(page.locator('.settings-modal')).toHaveCount(0)
      expect(await (await request.get(`${baseURL}/api/accounts`, { headers: H })).json()).toHaveLength(1)
    })
  })

  test('edit name, signature (enabled/text/position) and servers persists; delete returns to first run', async ({ app, request, baseURL, user }) => {
    await app.locator('.settings-btn').click()
    // The "Group messages by thread" checkbox did nothing (no conversation view) and is gone.
    await expect(app.locator('.settings-modal')).toBeVisible()
    await expect(app.locator('.settings-modal').getByText('Group messages by thread')).toHaveCount(0)
    await app.getByRole('button', { name: `Edit ${user}` }).click()
    await expect(app.locator('#acct-email')).toHaveValue(user)
    await expect(app.locator('#acct-email')).toBeDisabled()
    await app.locator('#acct-name').fill('Renamed Person')
    await app.getByLabel('Append signature').check()
    await app.locator('#sig-text').fill('-- \nRenamed')
    await app.locator('#sig-pos').selectOption('after_quote')
    // Password left empty on edit keeps the stored one (the save re-verifies the login).
    await app.getByRole('button', { name: 'Update', exact: true }).click()
    await expect(app.locator('.settings-modal')).toHaveCount(0)

    const [a] = await (await request.get(`${baseURL}/api/accounts`, { headers: H })).json()
    expect(a).toMatchObject({ name: 'Renamed Person', signature: { enabled: true, text: '-- \nRenamed', position: 'after_quote' } })

    await app.reload()
    await app.locator('.settings-btn').click()
    await app.getByRole('button', { name: `Edit ${user}` }).click()
    await expect(app.locator('#acct-name')).toHaveValue('Renamed Person')
    await expect(app.locator('#sig-text')).toHaveValue('-- \nRenamed')
    await expect(app.locator('#sig-pos')).toHaveValue('after_quote')
    await expect(app.getByLabel('Append signature')).toBeChecked()

    // Clearing the DAV URL switches Calendar/Contacts off (it used to be kept).
    await app.locator('#dav-url').fill('')
    await app.getByRole('button', { name: 'Update', exact: true }).click()
    await expect(app.locator('.settings-modal')).toHaveCount(0)
    const [b] = await (await request.get(`${baseURL}/api/accounts`, { headers: H })).json()
    expect(b.davUrl || '').toBe('')

    await app.locator('.settings-btn').click()
    app.once('dialog', (d) => d.accept())
    await app.getByRole('button', { name: `Remove ${user}` }).click()
    await expect.poll(async () => (await (await request.get(`${baseURL}/api/accounts`, { headers: H })).json()).length).toBe(0)
    await app.getByRole('button', { name: 'Close settings' }).click()
    await expect(app.getByTestId('first-run')).toBeVisible()
    await app.reload()
    await expect(app.getByTestId('first-run')).toBeVisible()
  })

  test('two accounts: switch between them, each shows its own mail, Send uses the selected From', async ({ app, mailbox, request, baseURL }) => {
    const second = await newMailbox('second')
    await mailbox.seed('INBOX', [{ subject: 'Only in the first mailbox' }])
    await second.seed('INBOX', [{ subject: 'Only in the second mailbox' }])
    const r = await request.post(`${baseURL}/api/accounts`, { headers: H, data: accountBody(second.email, { name: 'Second Person' }) })
    expect(r.status()).toBe(200)

    await app.reload()
    await expect(app.getByText('Only in the first mailbox').first()).toBeVisible()
    const switcher = app.getByLabel('Account', { exact: true })
    await expect(switcher).toBeVisible()
    const secondId = (await (await request.get(`${baseURL}/api/accounts`, { headers: H })).json()).find((a: { email: string }) => a.email === second.email).id
    await switcher.selectOption(secondId)
    await expect(app.getByText('Only in the second mailbox').first()).toBeVisible()
    await expect(app.getByText('Only in the first mailbox')).toHaveCount(0)

    const before = smtpLog().length
    await app.locator('.compose-btn').click()
    await app.locator('#compose-to').fill('someone@example.test')
    await app.getByPlaceholder('Subject').fill('From the second account')
    await app.getByPlaceholder('Write your message...').fill('hello')
    await app.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => smtpLog().slice(before).find((m) => m.raw.includes('From the second account'))?.from, { timeout: 20_000 }).toBe(second.email)
    const sent = smtpLog().slice(before).find((m) => m.raw.includes('From the second account'))!
    expect(sent.raw).toMatch(/^From: .*Second Person.*<[^>]*second/m)

    // Back to the first one.
    const firstId = (await (await request.get(`${baseURL}/api/accounts`, { headers: H })).json()).find((a: { email: string }) => a.email === mailbox.email).id
    await switcher.selectOption(firstId)
    await expect(app.getByText('Only in the first mailbox').first()).toBeVisible()
    await expect(app.getByText('Only in the second mailbox')).toHaveCount(0)
  })
})

// A separate server process (own port + data dir) so it can be restarted.
test.describe('persistence', () => {
  const SID = Number(process.env.E2E_STACK_ID || 0)
  const PORT = 3205 + 10 * SID

  function startServer(dataDir: string, out: string[]): Promise<ChildProcess> {
    const child = spawn(process.execPath, ['server/index.js'], {
      env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', LEOPOSTA_TOKEN: TOKEN, LEOPOSTA_DATA_DIR: dataDir, LEOPOSTA_DIST_DIR: 'dist-e2e', ALLOWED_ORIGINS: `http://127.0.0.1:${PORT}` },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stdout!.on('data', (d) => out.push(String(d)))
    child.stderr!.on('data', (d) => out.push(String(d)))
    return new Promise((resolve, reject) => {
      const t0 = Date.now()
      const poll = async () => {
        try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) return resolve(child) } catch { /* not up yet */ }
        if (Date.now() - t0 > 20_000) return reject(new Error('server did not start: ' + out.join('')))
        setTimeout(poll, 200)
      }
      poll()
    })
  }
  const stop = (c: ChildProcess) => new Promise<void>((r) => { c.once('exit', () => r()); c.kill('SIGTERM') })

  test('accounts survive a server restart; the file lives in LEOPOSTA_DATA_DIR (0600); passwords never reach the log', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'leoposta-e2e-persist-'))
    const out: string[] = []
    const mb = await newMailbox('persist')
    const secret = 'Wr0ng-S3cret-' + Date.now()
    let srv = await startServer(dataDir, out)
    try {
      const api = (p: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${PORT}${p}`, { ...init, headers: { ...H, 'content-type': 'application/json' } })
      // A failed verified save (wrong password) logs nothing secret and stores nothing.
      const bad = await api('/api/accounts', { method: 'POST', body: JSON.stringify({ ...accountBody(mb.email, { imapPass: secret, smtpPass: secret }), verify: true }) })
      expect(bad.status).toBe(400)
      expect(fs.existsSync(path.join(dataDir, 'accounts.json')) ? JSON.parse(fs.readFileSync(path.join(dataDir, 'accounts.json'), 'utf8')) : []).toEqual([])
      const ok = await api('/api/accounts', { method: 'POST', body: JSON.stringify({ ...accountBody(mb.email, { name: 'Persisted', signature: { enabled: true, text: 'Sig', position: 'standard' } }), verify: true }) })
      expect(ok.status).toBe(200)
      const file = path.join(dataDir, 'accounts.json')
      expect(fs.existsSync(file)).toBe(true)
      expect(fs.statSync(file).mode & 0o777).toBe(0o600)
      // Use it once so the IMAP login path runs and could log.
      expect((await api('/api/folders')).status).toBe(200)

      await stop(srv)
      srv = await startServer(dataDir, out)
      const list = await (await api('/api/accounts')).json()
      expect(list).toHaveLength(1)
      expect(list[0]).toMatchObject({ email: mb.email, name: 'Persisted', signature: { enabled: true, text: 'Sig' } })
      expect(list[0]).not.toHaveProperty('imapPass')
      expect((await api('/api/folders')).status).toBe(200)

      const log = out.join('')
      expect(log).not.toContain(secret)
      expect(log).not.toMatch(new RegExp(`(?:pass(?:word)?["':= ]+)${PASSWORD}\\b`, 'i'))
    } finally {
      await stop(srv)
      fs.rmSync(dataDir, { recursive: true, force: true })
    }
  })
})
