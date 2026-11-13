import { test, expect, mbox } from './fixtures'

// Harness smoke: the app loads against the real stack, lists the special
// folders, opens INBOX and shows a seeded message.
test('loads, lists folders and opens a seeded message', async ({ mailbox, app }) => {
  await mailbox.seed('INBOX', [{ subject: 'Smoke hello', text: 'Body of the smoke message.' }])
  await app.reload()
  for (const name of ['Inbox', 'Sent', 'Drafts', 'Trash']) {
    await expect(app.locator('.sidebar').getByText(name, { exact: true }).first()).toBeVisible()
  }
  await app.getByText('Smoke hello').first().click({ position: { x: 2, y: 2 } })
  await expect(app.getByText('Body of the smoke message.').last()).toBeVisible()
  expect(mbox('Drafts')).toBeTruthy()
})
