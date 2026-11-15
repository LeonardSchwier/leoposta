import { test, expect, TOKEN } from './fixtures'

// The e2e servers run with LEOPOSTA_GOA=off (playwright.real.config.ts): they
// must never ask the host's session D-Bus, or Settings would offer the
// developer's real GNOME Online Accounts for import.

test('the e2e server reports GNOME Online Accounts as unavailable, with no accounts', async ({ request, baseURL }) => {
  const res = await request.get(`${baseURL}/api/goa/accounts`, { headers: { 'x-leoposta-token': TOKEN } })
  expect(res.status()).toBe(200)
  expect(await res.json()).toEqual({ available: false, accounts: [] })
  const imp = await request.post(`${baseURL}/api/goa/import`, { headers: { 'x-leoposta-token': TOKEN }, data: { goaId: 'account_1' } })
  expect(imp.status()).toBe(503)
  expect((await imp.json()).code).toBe('goa_unavailable')
})

test('Settings shows no GNOME Online Accounts import list', async ({ app }) => {
  const goaAnswer = app.waitForResponse((r) => r.url().includes('/api/goa/accounts'))
  await app.locator('.sidebar').getByRole('button', { name: /settings/i }).click()
  await expect(app.getByRole('dialog', { name: 'Settings' })).toBeVisible()
  expect(await (await goaAnswer).json()).toEqual({ available: false, accounts: [] })
  await expect(app.locator('.goa-import-sec')).toHaveCount(0)
})
