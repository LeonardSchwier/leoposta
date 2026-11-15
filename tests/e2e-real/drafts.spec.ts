import { test, expect, smtpLog, uniqueUser, Mailbox } from './fixtures'
import { openMailbox, row, toast } from './helpers-actions'
import type { Page } from '@playwright/test'

// Drafts end to end: Save Draft stores it in the server's \Drafts mailbox,
// reopening restores every field, saving again replaces it (no duplicates),
// sending it removes it from Drafts and delivers it, and closing a compose
// window with unsaved text asks first.

const compose = (page: Page) => page.locator('.modal.compose')

async function openCompose(page: Page) {
  await page.locator('.compose-btn').click()
  await expect(compose(page)).toBeVisible()
}

async function fillCompose(page: Page, f: { to?: string; cc?: string; bcc?: string; subject?: string; body?: string }) {
  const c = compose(page)
  if (f.to !== undefined) await c.locator('#compose-to').fill(f.to)
  if (f.cc !== undefined) {
    if (!(await c.locator('#compose-cc').isVisible())) await c.getByRole('button', { name: 'Add Cc' }).click()
    await c.locator('#compose-cc').fill(f.cc)
  }
  if (f.bcc !== undefined) {
    if (!(await c.locator('#compose-bcc').isVisible())) await c.getByRole('button', { name: 'Add Bcc' }).click()
    await c.locator('#compose-bcc').fill(f.bcc)
  }
  if (f.subject !== undefined) await c.locator('#compose-subject').fill(f.subject)
  if (f.body !== undefined) await c.locator('#compose-body').fill(f.body)
}

async function drafts(mailbox: Mailbox) {
  return mailbox.messages('Drafts')
}

test('Save Draft stores it in Drafts (\\Draft) and the open Drafts view shows it without a reload', async ({ mailbox, app }) => {
  await openMailbox(app, 'Drafts')
  await expect(app.locator('.empty-state')).toBeVisible()
  await openCompose(app)
  await fillCompose(app, { to: 'alice@example.test', subject: 'Plan A', body: 'half-written thoughts' })
  await compose(app).getByRole('button', { name: 'Save Draft' }).click()
  await expect(compose(app)).toHaveCount(0)
  await expect(toast(app)).toHaveText('Draft saved')
  const [d] = await mailbox.waitFor('Drafts', (m) => (m.length === 1 ? m : null))
  expect(d.subject).toBe('Plan A')
  expect(d.flags).toEqual(expect.arrayContaining(['\\Draft', '\\Seen']))
  expect(d.source).toContain('half-written thoughts')
  await expect(row(app, 'Plan A')).toBeVisible()
  expect(smtpLog().some((e) => e.raw.includes('Plan A'))).toBe(false)
})

test('a Drafts view opened before the folder list arrived still shows the saved draft', async ({ mailbox, app }) => {
  // With no folder list yet (cold start, a failed first LIST) the sidebar's
  // Drafts item falls back to the path "Drafts"; saving reports the real one
  // (INBOX.Drafts in the dot layout) and the open view must follow it.
  await app.route('**/api/folders**', (r) => r.fulfill({ json: { folders: [] } }), { times: 1 })
  await app.reload()
  await openMailbox(app, 'Drafts')
  await openCompose(app)
  await fillCompose(app, { to: 'alice@example.test', subject: 'First ever', body: 'folder list not there yet' })
  await compose(app).getByRole('button', { name: 'Save Draft' }).click()
  await expect(compose(app)).toHaveCount(0)
  await mailbox.waitFor('Drafts', (m) => (m.length === 1 ? m : null))
  await expect(row(app, 'First ever')).toBeVisible()
  await expect(app.locator('.folder-item.active .folder-name')).toHaveText('Drafts')
})

test('a reopened draft restores To/Cc/Bcc/Subject/Body/attachment; saving again replaces it', async ({ mailbox, app }) => {
  await openCompose(app)
  await fillCompose(app, { to: 'alice@example.test', cc: 'carol@example.test', bcc: 'bob@example.test', subject: 'Quarterly', body: 'first version' })
  await compose(app).locator('input[type=file]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('attached notes ✓') })
  await expect(compose(app).locator('.attachment-chip')).toContainText('notes.txt')
  await compose(app).getByRole('button', { name: 'Save Draft' }).click()
  await expect(compose(app)).toHaveCount(0)
  const [first] = await mailbox.waitFor('Drafts', (m) => (m.length === 1 ? m : null))

  await openMailbox(app, 'Drafts')
  await row(app, 'Quarterly').locator('.message-subject').click()
  await expect(compose(app)).toBeVisible()
  await expect(compose(app).locator('.compose-title')).toHaveText('Edit Draft')
  await expect(compose(app).locator('#compose-to')).toHaveValue('alice@example.test')
  await expect(compose(app).locator('#compose-cc')).toHaveValue('carol@example.test')
  await expect(compose(app).locator('#compose-bcc')).toHaveValue('bob@example.test')
  await expect(compose(app).locator('#compose-subject')).toHaveValue('Quarterly')
  await expect(compose(app).locator('#compose-body')).toHaveValue(/^first version\s*$/)
  await expect(compose(app).locator('.attachment-chip')).toContainText('notes.txt')

  // Closing an unchanged draft does not ask.
  await compose(app).getByRole('button', { name: 'Close compose (Esc)' }).click()
  await expect(compose(app)).toHaveCount(0)

  await row(app, 'Quarterly').locator('.message-subject').click()
  await expect(compose(app).locator('#compose-subject')).toHaveValue('Quarterly')
  await fillCompose(app, { subject: 'Quarterly v2', body: 'second version' })
  // Pin down where an edit could get lost (CI once stored the old text with
  // replaceUid): in the window, in the request, or on the server.
  await expect(compose(app).locator('#compose-subject')).toHaveValue('Quarterly v2')
  await expect(compose(app).locator('#compose-body')).toHaveValue(/^second version/)
  const saveReq = app.waitForRequest((r) => r.url().endsWith('/api/drafts') && r.method() === 'POST')
  await compose(app).getByRole('button', { name: 'Save Draft' }).click()
  const sent = (await saveReq).postDataJSON()
  expect(sent.subject).toBe('Quarterly v2')
  expect(String(sent.replaceUid)).toBe(String(first.uid))
  await expect(compose(app)).toHaveCount(0)
  const [second] = await mailbox.waitFor('Drafts', (m) => (m.length === 1 && m[0].subject === 'Quarterly v2' ? m : null))
  expect(second.uid).not.toBe(first.uid)
  expect(second.source).toContain('second version')
  expect(second.source).toMatch(/^Bcc: bob@example\.test/m)
  expect(second.source).toMatch(/^Cc: carol@example\.test/m)
  expect(second.source).toContain('filename=notes.txt')
  expect(second.source).toContain(Buffer.from('attached notes ✓').toString('base64'))
  await expect(row(app, 'Quarterly v2')).toBeVisible()
  await expect(app.locator('.message-row')).toHaveCount(1)
})

test('sending a reopened draft delivers it and removes it from Drafts', async ({ mailbox, app }) => {
  const rcpt = uniqueUser('rcpt')
  const rcptBox = new Mailbox(rcpt)
  await rcptBox.with(async () => {})
  await openCompose(app)
  await fillCompose(app, { to: rcpt, subject: 'Ship it', body: 'ready when you are' })
  await compose(app).getByRole('button', { name: 'Save Draft' }).click()
  await mailbox.waitFor('Drafts', (m) => m.length === 1)

  await openMailbox(app, 'Drafts')
  await row(app, 'Ship it').locator('.message-subject').click()
  await expect(compose(app).locator('#compose-subject')).toHaveValue('Ship it')
  await compose(app).getByRole('button', { name: 'Send', exact: true }).click()
  await expect(compose(app)).toHaveCount(0)

  await rcptBox.waitFor('INBOX', (m) => m.some((x) => x.subject === 'Ship it'))
  await mailbox.waitFor('Drafts', (m) => m.length === 0)
  await expect(app.locator('.empty-state')).toBeVisible()
  // The SMTP log is shared by both projects: count only this test's recipient.
  expect(smtpLog().filter((e) => e.to.includes(rcpt) && e.raw.includes('Subject: Ship it'))).toHaveLength(1)
})

test('the reading pane offers Edit draft when moving through Drafts with the keyboard', async ({ mailbox, app }) => {
  await mailbox.seed('Drafts', [{ subject: 'Keyboard draft', to: 'dave@example.test', text: 'kbd body', flags: ['\\Draft', '\\Seen'] }])
  await openMailbox(app, 'Drafts')
  await expect(row(app, 'Keyboard draft')).toBeVisible()
  await app.keyboard.press('j')
  await expect(app.locator('.message-view .message-subject')).toHaveText('Keyboard draft')
  await app.locator('.message-view').getByRole('button', { name: 'Edit draft' }).click()
  await expect(compose(app).locator('#compose-to')).toHaveValue('dave@example.test')
  await expect(compose(app).locator('#compose-body')).toHaveValue(/kbd body/)
})

test.describe('closing with unsaved changes', () => {
  test('an untouched compose window closes without asking', async ({ mailbox, app }) => {
    await openCompose(app)
    await app.keyboard.press('Escape')
    await expect(compose(app)).toHaveCount(0)
    expect(await drafts(mailbox)).toHaveLength(0)
  })

  test('Keep Editing keeps the text; Save Draft saves it; Discard drops it', async ({ mailbox, app }) => {
    await openCompose(app)
    await fillCompose(app, { subject: 'Unsaved idea', body: 'do not lose me' })
    await compose(app).getByRole('button', { name: 'Close compose (Esc)' }).click()
    const ask = compose(app).getByRole('alertdialog')
    await expect(ask).toContainText('Save this message as a draft')
    await ask.getByRole('button', { name: 'Keep Editing' }).click()
    await expect(ask).toHaveCount(0)
    await expect(compose(app).locator('#compose-body')).toHaveValue('do not lose me')

    // Escape asks too; Save Draft from the prompt stores it.
    await compose(app).locator('#compose-body').press('Escape')
    await ask.getByRole('button', { name: 'Save Draft' }).click()
    await expect(compose(app)).toHaveCount(0)
    await expect(toast(app)).toHaveText('Draft saved')
    await mailbox.waitFor('Drafts', (m) => m.some((x) => x.subject === 'Unsaved idea'))

    // Clicking outside asks; Discard closes without saving.
    await openCompose(app)
    await fillCompose(app, { subject: 'Throwaway' })
    await app.locator('.modal-back').click({ position: { x: 5, y: 5 } })
    await ask.getByRole('button', { name: 'Discard' }).click()
    await expect(compose(app)).toHaveCount(0)
    await app.waitForTimeout(500)
    expect((await drafts(mailbox)).map((d) => d.subject)).toEqual(['Unsaved idea'])
  })
})
