import { test, expect } from './fixtures'

// Audit run-2: untrusted mail content must stay inside the message pane of
// the app window (desktop shell and PWA). No external host is contacted:
// every request to the *.e2e.test names below is answered by page.route.

test('remote-image blocking cannot be bypassed by spelling the URL with a tab or control char', async ({ app, mailbox }) => {
  const hits: string[] = []
  await app.context().route(/tracker\.e2e\.test/, (route) => { hits.push(route.request().url()); return route.fulfill({ status: 204 }) })
  await mailbox.seed('INBOX', [{
    subject: 'Tracker mail',
    html: '<p>Hi</p><img src="ht&#x09;tps://tracker.e2e.test/tab.gif"><img src="&#x01;https://tracker.e2e.test/c0.gif"><img src="https&#x0A;://tracker.e2e.test/nl.gif">'
  }])
  await app.reload()
  await app.getByText('Tracker mail').first().click({ position: { x: 2, y: 2 } })
  await expect(app.locator('.message-content').getByText('Hi')).toBeVisible()
  await expect(app.locator('.remote-images-banner')).toBeVisible()
  await app.waitForTimeout(1000)
  expect(hits).toEqual([])
  // Opting in loads them.
  await app.locator('.remote-images-banner button').click()
  await expect.poll(() => hits.length).toBeGreaterThan(0)
})

test('a link in a mail opens outside the app and never replaces the app window', async ({ app, mailbox, baseURL }) => {
  await app.context().route(/phish\.e2e\.test/, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>phish</title>fake login' }))
  await mailbox.seed('INBOX', [{ subject: 'Invoice mail', html: '<p><a href="https://phish.e2e.test/login">Open invoice</a></p>' }])
  await app.reload()
  await app.getByText('Invoice mail').first().click({ position: { x: 2, y: 2 } })
  const popup = app.context().waitForEvent('page')
  await app.locator('.message-content').getByText('Open invoice').click()
  const opened = await popup
  expect(opened.url()).toContain('phish.e2e.test/login')
  expect(new URL(app.url()).origin).toBe(new URL(baseURL!).origin)
  await expect(app.locator('.sidebar')).toBeVisible()
  await opened.close()
})

test('position:fixed sender content cannot overlay the app', async ({ app, mailbox }) => {
  await mailbox.seed('INBOX', [{
    subject: 'Overlay mail',
    html: '<div style="position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:2147483647;background:#fff">Session expired, sign in again</div>'
  }])
  await app.reload()
  await app.getByText('Overlay mail').first().click({ position: { x: 2, y: 2 } })
  const overlay = app.locator('.message-content').getByText('Session expired, sign in again')
  await expect(overlay).toBeVisible()
  const pane = (await app.locator('.message-content').boundingBox())!
  const box = (await overlay.boundingBox())!
  expect(box.y).toBeGreaterThanOrEqual(pane.y - 1)
  expect(box.x).toBeGreaterThanOrEqual(pane.x - 1)
  // The sidebar stays on top and usable.
  const sidebar = (await app.locator('.sidebar').boundingBox())!
  const hit = await app.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('.sidebar'), [sidebar.x + sidebar.width / 2, sidebar.y + sidebar.height / 2])
  expect(hit).toBe(true)
})
