import { test, expect } from './fixtures'

test('Settings → Language: click Deutsch, heading flips, <html lang> + localStorage persist', async ({ page }) => {
  await page.goto('/')
  // Open Settings
  await page.getByText('Settings').first().click()
  await expect(page.locator('.settings-modal')).toBeVisible()

  // Click the Language tab
  await page.getByRole('tab', { name: 'Language' }).click()
  await expect(page.locator('.lang-opt:has-text("English")')).toBeVisible()
  await expect(page.locator('.lang-opt:has-text("Deutsch")')).toBeVisible()

  // Click the Deutsch radio
  await page.locator('.lang-opt:has-text("Deutsch") input').check()

  // Heading, tab label, close button all re-render to German
  await expect(page.locator('.settings-modal h2')).toHaveText('Einstellungen')
  await expect(page.getByRole('tab', { name: 'Sprache' })).toBeVisible()
  await expect(page.locator('.modal-footer .btn-secondary')).toHaveText('Schließen')
  // Deutsch radio is now the checked one
  await expect(page.locator('.lang-opt:has-text("Deutsch") input')).toBeChecked()

  // Persistence: <html lang> + localStorage
  await expect(page.locator('html')).toHaveAttribute('lang', 'de')
  await expect(await page.evaluate(() => localStorage.getItem('leoposta.lang'))).toBe('de')

  // Reload — stays German
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('lang', 'de')
  await expect(await page.evaluate(() => localStorage.getItem('leoposta.lang'))).toBe('de')

  // Switch back to English
  await page.getByText('Settings').first().click()
  await page.getByRole('tab', { name: 'Sprache' }).click()
  await page.locator('.lang-opt:has-text("Englisch") input').check()
  await expect(page.locator('.settings-modal h2')).toHaveText('Settings')
  await expect(page.locator('html')).toHaveAttribute('lang', 'en')
  await expect(await page.evaluate(() => localStorage.getItem('leoposta.lang'))).toBe('en')
})
