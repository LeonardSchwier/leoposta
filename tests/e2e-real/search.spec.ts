import { test, expect, mbox } from './fixtures'
import { folderButton, expectList, listSubjects, specialItem } from './helpers-folders'

// Search box (server /api/search) and the command palette, against a real
// Dovecot. Every result set is checked against what was seeded over IMAP.

const T0 = Date.now() - 3600_000
const at = (i: number) => new Date(T0 + i * 60_000)

async function seedInbox(mailbox: import('./fixtures').Mailbox) {
  await mailbox.seed('INBOX', [
    { subject: 'Quarterly report', from: 'Alice Example <alice@example.test>', text: 'Numbers attached.', date: at(1) },
    { subject: 'Lunch?', from: 'Bob Builder <bob@example.test>', text: 'The secret word is pineapple.', date: at(2) },
    { subject: 'Grüße aus Köln', from: 'Jörg <joerg@example.test>', text: 'Schöne Grüße!', date: at(3) },
    { subject: 'Re: Quarterly report', from: 'Carol <carol@example.test>', text: 'Thanks.', date: at(4) }
  ])
}

function searchBox(page: import('@playwright/test').Page) {
  return page.locator('[data-search-input]')
}

test.describe('search box', () => {
  test('finds by subject, sender, body text and unicode; newest first', async ({ mailbox, app }) => {
    await seedInbox(mailbox)
    await app.reload()
    await expectList(app, ['Re: Quarterly report', 'Grüße aus Köln', 'Lunch?', 'Quarterly report'])

    await searchBox(app).fill('quarterly')
    await expectList(app, ['Re: Quarterly report', 'Quarterly report'])
    await searchBox(app).fill('bob@example.test')
    await expectList(app, ['Lunch?'])
    await searchBox(app).fill('Alice')
    await expectList(app, ['Quarterly report'])
    await searchBox(app).fill('pineapple')
    await expectList(app, ['Lunch?'])
    await searchBox(app).fill('Grüße')
    await expectList(app, ['Grüße aus Köln'])
  })

  test('a result opens; no match shows the empty state; clearing returns to the folder', async ({ mailbox, app }) => {
    await seedInbox(mailbox)
    await app.reload()
    await searchBox(app).fill('pineapple')
    await expectList(app, ['Lunch?'])
    await app.locator('.message-row', { hasText: 'Lunch?' }).click()
    await expect(app.getByText('The secret word is pineapple.').last()).toBeVisible()
    // Opening marked it read on the server.
    await mailbox.waitFor('INBOX', (m) => m.find((x) => x.subject === 'Lunch?')?.flags.includes('\\Seen'))

    await searchBox(app).fill('nothing-matches-this-xyz')
    await expect(app.locator('.empty-state')).toContainText('No results')
    await expect(app.locator('.message-row')).toHaveCount(0)

    await searchBox(app).fill('')
    await expectList(app, ['Re: Quarterly report', 'Grüße aus Köln', 'Lunch?', 'Quarterly report'])
    await expect(app.locator('.folder-title')).toHaveText('INBOX')
  })

  test('searches inside the open folder, not the Inbox', async ({ mailbox, app }) => {
    await mailbox.createFolder('# Archive')
    await mailbox.seed('# Archive', [
      { subject: 'Old invoice 2019', date: at(1) },
      { subject: 'Old invoice 2020', date: at(2) },
      { subject: 'Something else', date: at(3) }
    ])
    await mailbox.seed('INBOX', [{ subject: 'New invoice', date: at(4) }])
    await mailbox.seed('Sent', [{ subject: 'Sent invoice', date: at(5) }])
    await app.reload()

    await folderButton(app, '# Archive').click()
    await expectList(app, ['Something else', 'Old invoice 2020', 'Old invoice 2019'])
    const req = app.waitForResponse((r) => r.url().includes('/api/search?'))
    await searchBox(app).fill('invoice')
    const res = await req
    expect(new URL(res.url()).searchParams.get('folder')).toBe(mbox('# Archive'))
    await expectList(app, ['Old invoice 2020', 'Old invoice 2019'])
    // A result opens from that folder.
    await app.locator('.message-row', { hasText: 'Old invoice 2019' }).click()
    await expect(app.locator('.message-view')).toContainText('Old invoice 2019')

    // Switching folders drops the search.
    await specialItem(app, 'Sent').click()
    await expect(searchBox(app)).toHaveValue('')
    await expectList(app, ['Sent invoice'])
    await searchBox(app).fill('invoice')
    await expectList(app, ['Sent invoice'])
  })

  test('typing fast does not let an older search overwrite the newer one', async ({ mailbox, app }) => {
    await seedInbox(mailbox)
    await app.reload()
    // Hold the first search's answer back until after the second one returned.
    let release!: () => void
    const held = new Promise<void>((r) => { release = r })
    let first = true
    await app.route('**/api/search?*', async (route) => {
      if (first) { first = false; await held }
      await route.continue()
    })
    await searchBox(app).fill('quarterly')
    await expect.poll(() => first).toBe(false)
    await searchBox(app).fill('pineapple')
    await expectList(app, ['Lunch?'])
    release()
    await app.waitForTimeout(1000)
    expect(await listSubjects(app)).toEqual(['Lunch?'])
  })
})

test.describe('command palette', () => {
  test('Ctrl+K opens it; "go to" a custom and a special folder; Escape closes', async ({ mailbox, app }) => {
    await mailbox.createFolder('Projects/Röntgen & Co')
    await mailbox.seed('Projects/Röntgen & Co', [{ subject: 'Palette target' }])
    await mailbox.seed('Trash', [{ subject: 'Trashed one' }])
    await app.reload()
    await expect(folderButton(app, 'Projects')).toBeVisible()

    await app.locator('body').press('Control+k')
    const input = app.locator('.palette .palette-input')
    await expect(input).toBeFocused()
    await input.fill('go to röntgen')
    await expect(app.locator('.palette-item').first()).toContainText('Röntgen & Co')
    await input.press('Enter')
    await expect(app.locator('.palette')).toHaveCount(0)
    await expectList(app, ['Palette target'])

    await app.locator('body').press('Control+k')
    await input.fill('go to trash')
    await input.press('Enter')
    await expectList(app, ['Trashed one'])
    await expect(specialItem(app, 'Trash')).toHaveClass(/active/)

    await app.locator('body').press('Control+k')
    await expect(input).toBeVisible()
    await input.press('Escape')
    await expect(app.locator('.palette')).toHaveCount(0)
  })

  test('a message entry in the palette opens that message', async ({ mailbox, app }) => {
    await mailbox.seed('INBOX', [
      { subject: 'First palette mail', text: 'body one', date: at(1) },
      { subject: 'Second palette mail', text: 'body two', date: at(2) }
    ])
    await app.reload()
    await expectList(app, ['Second palette mail', 'First palette mail'])
    await app.locator('body').press('Control+k')
    const input = app.locator('.palette .palette-input')
    await input.fill('First palette')
    await input.press('Enter')
    await expect(app.getByText('body one').last()).toBeVisible()
    await expect(app.locator('.message-row.selected')).toContainText('First palette mail')
  })
})
