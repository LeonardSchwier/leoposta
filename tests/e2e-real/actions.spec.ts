import { test, expect, mbox, TOKEN } from './fixtures'
import { badge, contextAction, flagsOf, openMailbox, openRow, row, subjects, toast } from './helpers-actions'

// Message actions through every UI entry point (list row star, context menu,
// reading-pane toolbar, keyboard), asserted on the real IMAP server and in the
// UI. Both layouts: "/" and "INBOX." + "." (special-use paths differ).

const SEEN = '\\Seen'
const FLAGGED = '\\Flagged'

test.describe('flags', () => {
  test('the row star acts on that row, not on the open message', async ({ mailbox, app }) => {
    await mailbox.seed('INBOX', [{ subject: 'Open me' }, { subject: 'Star me' }])
    await app.reload()
    await openRow(app, 'Open me')
    await row(app, 'Star me').getByRole('button', { name: 'Star' }).click()
    await expect(row(app, 'Star me').getByRole('button', { name: 'Unstar' })).toBeVisible()
    await expect.poll(() => flagsOf(mailbox, 'INBOX', 'Star me')).toContain(FLAGGED)
    expect(await flagsOf(mailbox, 'INBOX', 'Open me')).not.toContain(FLAGGED)
    // And off again.
    await row(app, 'Star me').getByRole('button', { name: 'Unstar' }).click()
    await expect.poll(() => flagsOf(mailbox, 'INBOX', 'Star me')).not.toContain(FLAGGED)
    await expect(row(app, 'Star me').getByRole('button', { name: 'Star' })).toBeVisible()
  })

  test('context menu: mark read / unread and star act on the right-clicked row; the unread badge follows', async ({ mailbox, app }) => {
    await mailbox.seed('INBOX', [{ subject: 'Alpha' }, { subject: 'Beta' }, { subject: 'Gamma', flags: [SEEN] }])
    await app.reload()
    await expect(badge(app, 'Inbox')).toHaveText('2')
    await openRow(app, 'Gamma')

    await contextAction(app, 'Alpha', 'Mark as Read')
    await expect.poll(() => flagsOf(mailbox, 'INBOX', 'Alpha')).toContain(SEEN)
    await expect(row(app, 'Alpha')).not.toHaveClass(/unread/)
    await expect(badge(app, 'Inbox')).toHaveText('1')

    await contextAction(app, 'Gamma', 'Mark as Unread')
    await expect.poll(() => flagsOf(mailbox, 'INBOX', 'Gamma')).not.toContain(SEEN)
    await expect(row(app, 'Gamma')).toHaveClass(/unread/)
    await expect(badge(app, 'Inbox')).toHaveText('2')

    await contextAction(app, 'Beta', 'Star')
    await expect.poll(() => flagsOf(mailbox, 'INBOX', 'Beta')).toContain(FLAGGED)
    await contextAction(app, 'Beta', 'Unstar')
    await expect.poll(() => flagsOf(mailbox, 'INBOX', 'Beta')).not.toContain(FLAGGED)
    expect(await flagsOf(mailbox, 'INBOX', 'Gamma')).not.toContain(FLAGGED)
  })

  test('opening a message marks it read on the server and lowers the badge; the toolbar marks it unread again', async ({ mailbox, app }) => {
    await mailbox.seed('INBOX', [{ subject: 'Read me', text: 'body text' }, { subject: 'Other' }])
    await app.reload()
    await expect(badge(app, 'Inbox')).toHaveText('2')
    await openRow(app, 'Read me')
    await expect.poll(() => flagsOf(mailbox, 'INBOX', 'Read me')).toContain(SEEN)
    await expect(badge(app, 'Inbox')).toHaveText('1')
    await app.locator('.message-view').getByRole('button', { name: 'Mark as unread' }).click()
    await expect.poll(() => flagsOf(mailbox, 'INBOX', 'Read me')).not.toContain(SEEN)
    await expect(badge(app, 'Inbox')).toHaveText('2')
    await expect(app.locator('.message-view').getByRole('button', { name: 'Mark as read' })).toBeVisible()
  })

  test('keyboard: s stars, u toggles read, on the open message', async ({ mailbox, app }) => {
    await mailbox.seed('INBOX', [{ subject: 'Keys' }])
    await app.reload()
    await openRow(app, 'Keys')
    await app.locator('.message-view .message-subject').click() // focus off any input
    await app.keyboard.press('s')
    await expect.poll(() => flagsOf(mailbox, 'INBOX', 'Keys')).toContain(FLAGGED)
    await expect(app.locator('.message-view').getByRole('button', { name: 'Unstar' })).toBeVisible()
    await expect.poll(() => flagsOf(mailbox, 'INBOX', 'Keys')).toContain(SEEN)
    await app.keyboard.press('u')
    await expect.poll(() => flagsOf(mailbox, 'INBOX', 'Keys')).not.toContain(SEEN)
    await app.keyboard.press('s')
    await expect.poll(() => flagsOf(mailbox, 'INBOX', 'Keys')).not.toContain(FLAGGED)
  })

  test('a starred message seeded on the server shows as starred', async ({ mailbox, app }) => {
    await mailbox.seed('INBOX', [{ subject: 'Pre-starred', flags: [FLAGGED, SEEN] }])
    await app.reload()
    await expect(row(app, 'Pre-starred').getByRole('button', { name: 'Unstar' })).toBeVisible()
  })
})

test.describe('moves', () => {
  test('toolbar Archive moves to the \\Archive mailbox, closes the pane and shows a toast', async ({ mailbox, app }) => {
    await mailbox.seed('INBOX', [{ subject: 'Archive me' }, { subject: 'Stay' }])
    await app.reload()
    await openRow(app, 'Archive me')
    await app.locator('.message-view').getByRole('button', { name: 'Archive' }).click()
    await expect(row(app, 'Archive me')).toHaveCount(0)
    await expect(app.locator('.message-view')).toHaveCount(0)
    await expect(toast(app)).toContainText('Archived')
    await mailbox.waitFor('Archive', (m) => m.some((x) => x.subject === 'Archive me'))
    expect(await subjects(mailbox, 'INBOX')).toEqual(['Stay'])
    // The archived message is in the app's Archive view.
    await openMailbox(app, 'Archive')
    await expect(row(app, 'Archive me')).toBeVisible()
    // There is no Archive action inside Archive.
    await openRow(app, 'Archive me')
    await expect(app.locator('.message-view').getByRole('button', { name: 'Archive' })).toHaveCount(0)
  })

  test('keyboard a archives and d deletes the open message', async ({ mailbox, app }) => {
    await mailbox.seed('INBOX', [{ subject: 'Key archive' }, { subject: 'Key delete' }])
    await app.reload()
    await openRow(app, 'Key archive')
    await app.keyboard.press('a')
    await mailbox.waitFor('Archive', (m) => m.some((x) => x.subject === 'Key archive'))
    await openRow(app, 'Key delete')
    await app.keyboard.press('d')
    await mailbox.waitFor('Trash', (m) => m.some((x) => x.subject === 'Key delete'))
    await expect(app.locator('.empty-state')).toBeVisible()
  })

  test('context-menu Archive / Delete act on the right-clicked row, not the open message', async ({ mailbox, app }) => {
    await mailbox.seed('INBOX', [{ subject: 'Opened' }, { subject: 'Row archive' }, { subject: 'Row delete' }])
    await app.reload()
    await openRow(app, 'Opened')
    await contextAction(app, 'Row archive', 'Archive')
    await mailbox.waitFor('Archive', (m) => m.some((x) => x.subject === 'Row archive'))
    await contextAction(app, 'Row delete', 'Delete')
    await mailbox.waitFor('Trash', (m) => m.some((x) => x.subject === 'Row delete'))
    expect(await subjects(mailbox, 'INBOX')).toEqual(['Opened'])
    // The open message is still open.
    await expect(app.locator('.message-view .message-subject')).toHaveText('Opened')
  })

  test('Delete moves to Trash; Delete inside Trash removes it for good', async ({ mailbox, app }) => {
    await mailbox.seed('INBOX', [{ subject: 'Doomed' }])
    await app.reload()
    await openRow(app, 'Doomed')
    await app.locator('.message-view').getByRole('button', { name: 'Delete' }).click()
    await expect(toast(app)).toContainText('Moved to Trash')
    await mailbox.waitFor('Trash', (m) => m.some((x) => x.subject === 'Doomed'))
    // Acting on the last message leaves the empty state.
    await expect(app.locator('.empty-state')).toContainText('No messages')

    await openMailbox(app, 'Trash')
    await contextAction(app, 'Doomed', 'Delete Permanently')
    await expect(toast(app)).toContainText('Deleted permanently')
    await mailbox.waitFor('Trash', (m) => m.length === 0)
    await expect(app.locator('.empty-state')).toBeVisible()
    for (const f of ['INBOX', 'Archive', 'Junk']) expect(await subjects(mailbox, f)).toEqual([])
  })

  test('Mark as Junk moves to \\Junk; Not Junk in Junk moves back to the Inbox', async ({ mailbox, app }) => {
    await mailbox.seed('INBOX', [{ subject: 'Buy now' }])
    await app.reload()
    await contextAction(app, 'Buy now', 'Mark as Junk')
    await expect(toast(app)).toContainText('Marked as junk')
    await mailbox.waitFor('Junk', (m) => m.some((x) => x.subject === 'Buy now'))
    await openMailbox(app, 'Junk')
    await expect(row(app, 'Buy now')).toBeVisible()
    await openRow(app, 'Buy now')
    await app.locator('.message-view').getByRole('button', { name: 'Not junk' }).click()
    await mailbox.waitFor('INBOX', (m) => m.some((x) => x.subject === 'Buy now'))
    expect(await subjects(mailbox, 'Junk')).toEqual([])
  })

  test('Move to… a nested folder via context menu, toolbar and keyboard', async ({ mailbox, app }) => {
    await mailbox.createFolder('Projects/2026')
    await mailbox.createFolder('Clients')
    await mailbox.seed('INBOX', [{ subject: 'Via menu' }, { subject: 'Via toolbar' }, { subject: 'Via key' }])
    await app.reload()

    await contextAction(app, 'Via menu', 'Move to…')
    const picker = app.getByRole('dialog', { name: 'Move to folder' })
    await expect(picker).toBeVisible()
    await expect(picker.getByRole('button', { name: 'Inbox', exact: true })).toHaveCount(0) // already there
    await picker.getByRole('button', { name: '2026', exact: true }).click()
    await expect(picker).toHaveCount(0)
    await expect(toast(app)).toContainText('Moved to 2026')
    await mailbox.waitFor('Projects/2026', (m) => m.some((x) => x.subject === 'Via menu'))

    await openRow(app, 'Via toolbar')
    await app.locator('.message-view').getByRole('button', { name: 'Move to folder' }).click()
    await picker.getByRole('textbox', { name: 'Filter folders' }).fill('clie')
    await picker.getByRole('textbox', { name: 'Filter folders' }).press('Enter')
    await mailbox.waitFor('Clients', (m) => m.some((x) => x.subject === 'Via toolbar'))

    await openRow(app, 'Via key')
    await app.keyboard.press('v')
    await expect(picker).toBeVisible()
    await picker.getByRole('button', { name: 'Projects', exact: true }).click()
    await mailbox.waitFor('Projects', (m) => m.some((x) => x.subject === 'Via key'))

    expect(await subjects(mailbox, 'INBOX')).toEqual([])
    // Escape closes the picker without moving anything.
    await mailbox.seed('INBOX', [{ subject: 'Not moved' }])
    await openMailbox(app, 'Inbox')
    await contextAction(app, 'Not moved', 'Move to…')
    await app.keyboard.press('Escape')
    await expect(picker).toHaveCount(0)
    expect(await subjects(mailbox, 'INBOX')).toEqual(['Not moved'])
  })

  test('unread counts of other folders update when unread mail is moved there', async ({ mailbox, app }) => {
    await mailbox.createFolder('Later')
    await mailbox.seed('INBOX', [{ subject: 'Unread one' }, { subject: 'Unread two' }])
    await app.reload()
    await expect(badge(app, 'Inbox')).toHaveText('2')
    await contextAction(app, 'Unread one', 'Move to…')
    await app.getByRole('dialog', { name: 'Move to folder' }).getByRole('button', { name: 'Later', exact: true }).click()
    await expect(badge(app, 'Inbox')).toHaveText('1')
    await expect(app.locator('.folder-tree .folder-open', { hasText: 'Later' }).locator('.badge')).toHaveText('1')
    await contextAction(app, 'Unread two', 'Mark as Junk')
    await expect(badge(app, 'Inbox')).toHaveCount(0)
    await expect(badge(app, 'Junk')).toHaveText('1')
  })

  test('rapid repeated clicks on Delete move the message once, without errors', async ({ mailbox, app }) => {
    await mailbox.seed('INBOX', [{ subject: 'Click storm' }, { subject: 'Bystander' }])
    await app.reload()
    await openRow(app, 'Click storm')
    const del = app.locator('.message-view').getByRole('button', { name: 'Delete' })
    await del.click()
    await del.click({ timeout: 500 }).catch(() => {}) // the pane may already be gone
    await app.keyboard.press('d')
    await app.keyboard.press('d')
    await mailbox.waitFor('Trash', (m) => m.some((x) => x.subject === 'Click storm'))
    await app.waitForTimeout(500)
    expect(await subjects(mailbox, 'Trash')).toEqual(['Click storm'])
    expect(await subjects(mailbox, 'INBOX')).toEqual(['Bystander'])

    // The row star, hammered: ends in a consistent state on screen and server.
    for (let i = 0; i < 5; i++) await row(app, 'Bystander').locator('.star-btn').click()
    await app.waitForTimeout(800)
    const starred = (await flagsOf(mailbox, 'INBOX', 'Bystander')).includes(FLAGGED)
    await expect(row(app, 'Bystander').getByRole('button', { name: starred ? 'Unstar' : 'Star' })).toBeVisible()
  })
})

test.describe('message deleted by another client', () => {
  test.use({ allowApiErrors: [/-> 404 \{"error":"message_not_found"\}/] })

  test('acting on it drops it with a notice; opening it does too', async ({ mailbox, app }) => {
    await mailbox.seed('INBOX', [{ subject: 'Ghost' }, { subject: 'Ghost two' }, { subject: 'Alive' }])
    await app.reload()
    await expect(row(app, 'Ghost two')).toBeVisible()
    // Another client expunges both.
    await mailbox.with(async (c) => {
      const lock = await c.getMailboxLock('INBOX')
      try {
        for await (const m of c.fetch('1:*', { uid: true, envelope: true })) {
          if (m.envelope?.subject?.startsWith('Ghost')) await c.messageDelete(String(m.uid), { uid: true })
        }
      } finally { lock.release() }
    })
    await contextAction(app, 'Ghost', 'Archive')
    await expect(toast(app)).toContainText('no longer exists')
    await expect(row(app, 'Ghost')).toHaveCount(0)
    expect(await subjects(mailbox, 'Archive')).toEqual([])

    await row(app, 'Ghost two').locator('.message-subject').click()
    await expect(row(app, 'Ghost two')).toHaveCount(0)
    await expect(app.locator('.message-view')).toHaveCount(0)
    // The app still works: the pooled connection was not dropped.
    await openRow(app, 'Alive')
    await contextAction(app, 'Alive', 'Star')
    await expect.poll(() => flagsOf(mailbox, 'INBOX', 'Alive')).toContain(FLAGGED)
  })
})

test.describe('rules', () => {
  // Rules are server-wide state: every test starts from none.
  test.beforeEach(async ({ request, baseURL }) => {
    const res = await request.put(`${baseURL}/api/rules`, { headers: { 'x-leoposta-token': TOKEN }, data: { rules: [] } })
    expect(res.status()).toBe(200)
  })

  test('a rule "from contains X → move to folder" moves new matching mail on the server and persists', async ({ mailbox, app }) => {
    await mailbox.createFolder('Receipts')
    await mailbox.seed('INBOX', [{ subject: 'Old acme mail', from: 'Acme <billing@acme.test>' }])
    await app.reload()
    await expect(row(app, 'Old acme mail')).toBeVisible()

    await app.locator('.settings-btn').click()
    await app.getByRole('button', { name: 'Rules', exact: true }).click()
    await app.getByRole('button', { name: '+ Add rule' }).click()
    const card = app.locator('.rule-card').last()
    await card.getByLabel('Condition field').selectOption('from')
    await card.getByLabel('Condition operator').selectOption('contains')
    await card.getByLabel('Condition value').fill('acme.test')
    await card.getByLabel('Rule action').selectOption('move')
    await card.getByLabel('Move to folder').selectOption(mbox('Receipts'))
    await app.getByRole('button', { name: 'Save rules' }).click()
    await expect(app.getByText('Saved 1 rule')).toBeVisible()

    // Persists across a reload.
    await app.reload()
    await app.locator('.settings-btn').click()
    await app.getByRole('button', { name: 'Rules', exact: true }).click()
    await expect(app.locator('.rule-card').last().getByLabel('Condition value')).toHaveValue('acme.test')
    await expect(app.locator('.rule-card').last().getByLabel('Move to folder')).toHaveValue(mbox('Receipts'))
    await app.getByRole('button', { name: 'Close settings' }).click()
    await app.reload()

    // New mail arrives.
    await mailbox.seed('INBOX', [
      { subject: 'Invoice 42', from: 'Acme <billing@acme.test>' },
      { subject: 'Hello friend', from: 'Friend <friend@example.test>' }
    ])
    await openMailbox(app, 'Inbox') // a fetch; IDLE would trigger the same
    await mailbox.waitFor('Receipts', (m) => m.some((x) => x.subject === 'Invoice 42'))
    expect(await subjects(mailbox, 'INBOX')).toEqual(['Hello friend', 'Old acme mail'])
    await expect(row(app, 'Hello friend')).toBeVisible()
    await expect(row(app, 'Invoice 42')).toHaveCount(0)
    // A message the user keeps in the Inbox is not moved again later.
    await openMailbox(app, 'Inbox')
    expect(await subjects(mailbox, 'INBOX')).toContain('Old acme mail')
  })

  test('a rule "subject contains X → flag" stars new mail on the server', async ({ mailbox, app }) => {
    await app.locator('.settings-btn').click()
    await app.getByRole('button', { name: 'Rules', exact: true }).click()
    await app.getByRole('button', { name: '+ Add rule' }).click()
    const card = app.locator('.rule-card').last()
    await card.getByLabel('Condition field').selectOption('subject')
    await card.getByLabel('Condition value').fill('urgent')
    await card.getByLabel('Rule action').selectOption('flag')
    await app.getByRole('button', { name: 'Save rules' }).click()
    await expect(app.getByText('Saved 1 rule')).toBeVisible()
    await app.getByRole('button', { name: 'Close settings' }).click()
    await app.reload()

    await mailbox.seed('INBOX', [{ subject: 'URGENT: server down' }, { subject: 'Lunch?' }])
    await openMailbox(app, 'Inbox')
    await expect.poll(() => flagsOf(mailbox, 'INBOX', 'URGENT: server down')).toContain(FLAGGED)
    await app.reload()
    await expect(row(app, 'URGENT: server down').getByRole('button', { name: 'Unstar' })).toBeVisible()
    expect(await flagsOf(mailbox, 'INBOX', 'Lunch?')).not.toContain(FLAGGED)
  })
})
