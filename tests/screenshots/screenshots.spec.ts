import { test, expect } from '../e2e/fixtures'
import type { APIRequestContext } from '@playwright/test'

// Regenerates the README screenshots from the fictional fixture mailbox:
//   npm run screenshots
const API = 'http://127.0.0.1:3101'

async function seedAccount(request: APIRequestContext) {
  const res = await request.post(`${API}/api/account`, {
    headers: { 'x-leoposta-token': 'test-token' },
    data: {
      name: 'Demo', email: 'me@example.test',
      imapHost: '127.0.0.1', imapPort: 1243, imapTls: false,
      smtpHost: '127.0.0.1', smtpPort: 2525, smtpTls: false,
      imapUser: 'me@example.test', imapPass: 'dummy',
      smtpUser: 'me@example.test', smtpPass: 'dummy'
    }
  })
  expect(res.status()).toBe(200)
}

for (const scheme of ['light', 'dark'] as const) {
  test(`inbox with an open message (${scheme})`, async ({ page, request }) => {
    await page.emulateMedia({ colorScheme: scheme })
    await page.setViewportSize({ width: 1280, height: 760 })
    await seedAccount(request)
    await page.goto('/')
    await page.getByText('Quarterly planning notes').first().click({ position: { x: 2, y: 2 } })
    await expect(page.getByText('draft notes for the planning session').first()).toBeVisible()
    await page.mouse.move(0, 0)
    await page.screenshot({ path: `assets/screenshots/inbox-${scheme}.png` })
  })
}
