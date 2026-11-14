// PWA / offline: the service worker is registered in the PWA build only, and
// a mailbox visited once stays readable offline (app shell from the SW
// precache, list + opened messages from the IndexedDB cache in
// src/lib/offlineQueue.ts), then re-syncs when the network comes back.
import { test, expect } from './fixtures'

test('service worker registers in the PWA build and not in the desktop build', async ({ app, desktop }) => {
  if (desktop) {
    await app.waitForTimeout(1500)
    const regs = await app.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)
    expect(regs, 'desktop build registered a service worker').toBe(0)
    expect(await app.locator('script[src*="registerSW"], link[rel=manifest]').count()).toBe(0)
    return
  }
  const scope = await app.evaluate(async () => (await navigator.serviceWorker.ready).scope)
  expect(new URL(scope).pathname).toBe('/')
})

test.describe('offline', () => {
  // While the network is down, the browser itself reports every refused
  // /api/ request; those are the condition under test, not app errors.
  test.use({ allowApiErrors: [[/ERR_INTERNET_DISCONNECTED/, /net::ERR_FAILED/], { scope: 'test' }] })

  test('after one visit the shell and cached messages work offline, and it re-syncs online', async ({ app, mailbox, desktop, context }) => {
    test.skip(desktop, 'the desktop build has no service worker (always served by its own local backend)')
    await mailbox.seed('INBOX', [
      { subject: 'Read me offline', text: 'This body was cached when opened.' },
      { subject: 'Second message', text: 'Not opened before going offline.' }
    ])
    await app.evaluate(async () => { await navigator.serviceWorker.ready })
    await app.reload() // now controlled by the SW
    await expect.poll(() => app.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true)
    await app.locator('.message-row', { hasText: 'Read me offline' }).click()
    await expect(app.locator('.message-view')).toContainText('This body was cached when opened.')

    await context.setOffline(true)
    await app.reload()
    await expect(app.locator('.sidebar')).toBeVisible()
    await expect(app.locator('.message-row', { hasText: 'Read me offline' })).toBeVisible()
    await expect(app.locator('.message-row', { hasText: 'Second message' })).toBeVisible()
    await expect(app.getByText(/Offline — showing 2 cached messages/)).toBeVisible()
    await app.screenshot({ path: '.e2e-real/ui/pwa/offline-list.png' })
    await app.locator('.message-row', { hasText: 'Read me offline' }).click()
    await expect(app.locator('.message-view')).toContainText('This body was cached when opened.')

    // New mail arrives while offline; it shows once the network is back.
    await mailbox.seed('INBOX', [{ subject: 'Arrived while offline', text: 'hi' }])
    await context.setOffline(false)
    await expect(app.locator('.message-row', { hasText: 'Arrived while offline' })).toBeVisible()
    await expect(app.getByText(/Offline — showing/)).toHaveCount(0)
  })
})
