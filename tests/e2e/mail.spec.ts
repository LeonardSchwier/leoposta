import { test, expect } from './fixtures'
import type { APIRequestContext } from '@playwright/test'

const API = 'http://127.0.0.1:3101'
const TOKEN = 'test-token'

// Journeys 2 and 3 seed the account through the API so each starts from a
// configured mailbox; journey 1 covers the Settings form itself.
async function seedAccount(request: APIRequestContext) {
  const res = await request.post(`${API}/api/account`, {
    headers: { 'x-leoposta-token': TOKEN },
    data: {
      name: 'Dummy',
      email: 'me@example.test',
      imapHost: '127.0.0.1',
      imapPort: 1243,
      imapTls: false,
      smtpHost: '127.0.0.1',
      smtpPort: 2525,
      smtpTls: false,
      imapUser: 'me@example.test',
      imapPass: 'dummy',
      smtpUser: 'me@example.test',
      smtpPass: 'dummy'
    }
  })
  expect(res.status()).toBe(200)
}

test('adds the dummy account in Settings', async ({ page }) => {
  await page.goto('/')
  await page.getByText('Settings').first().click()
  await page.getByPlaceholder('you@example.com').fill('me@example.test')
  await page.locator('.form-section').filter({ hasText: 'IMAP (Incoming)' }).locator('input[type="text"]').fill('127.0.0.1')
  await page.locator('input[type="number"]').first().fill('1243')
  await page.getByRole('checkbox').first().uncheck()
  await page.getByPlaceholder('••••••••').fill('dummy')
  const saved = page.waitForResponse((r) => r.url().endsWith('/api/accounts') && r.request().method() === 'POST')
  await page.getByRole('button', { name: 'Add Account', exact: true }).click()
  expect((await saved).status()).toBe(200)
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeHidden()
})

test('folder list shows INBOX', async ({ page, request }) => {
  await seedAccount(request)
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'INBOX' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Inbox/ })).toBeVisible()
})

test('opening the first message shows its body', async ({ page, request }) => {
  await seedAccount(request)
  await page.goto('/')
  // Click the row's left edge: the hover action bar overlays the subject text.
  await page.getByText('Welcome to Leoposta').first().click({ position: { x: 2, y: 2 } })
  await expect(page.getByText('Hello from the e2e fixture mailbox.')).toBeVisible()
})
