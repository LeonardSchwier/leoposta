import { test, expect, mbox } from './fixtures'
import { folderButton, expectList, listSubjects, specialItem, waitMessages } from './helpers-folders'
import type { Page, Locator } from '@playwright/test'

// Keyboard navigation, resizable columns, rapid folder switching, live
// updates (IDLE), unread counts and a large mailbox, against a real Dovecot.

const T0 = Date.now() - 24 * 3600_000
const at = (i: number) => new Date(T0 + i * 60_000)

async function width(l: Locator): Promise<number> {
  return (await l.boundingBox())!.width
}

async function drag(page: Page, handle: Locator, dx: number) {
  const b = (await handle.boundingBox())!
  const x = b.x + b.width / 2
  const y = b.y + b.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx / 2, y, { steps: 4 })
  await page.mouse.move(x + dx, y, { steps: 4 })
  await page.mouse.up()
  // After the release, moving the mouse must not keep resizing.
  await page.mouse.move(x + dx + 120, y + 40, { steps: 6 })
}

test.describe('keyboard', () => {
  test('j/k and arrows move through the list and open messages; Escape closes; / focuses search', async ({ mailbox, app }) => {
    await mailbox.seed('INBOX', [1, 2, 3].map((i) => ({ subject: `Key mail ${i}`, text: `Body of key mail ${i}`, date: at(i) })))
    await app.reload()
    await expectList(app, ['Key mail 3', 'Key mail 2', 'Key mail 1'])
    const view = app.locator('.message-view')

    await app.keyboard.press('j')
    await expect(view).toContainText('Body of key mail 3')
    await app.keyboard.press('j')
    await expect(view).toContainText('Body of key mail 2')
    await app.keyboard.press('ArrowDown')
    await expect(view).toContainText('Body of key mail 1')
    await app.keyboard.press('k')
    await expect(view).toContainText('Body of key mail 2')
    await app.keyboard.press('ArrowUp')
    await expect(view).toContainText('Body of key mail 3')
    await expect(app.locator('.message-row.selected')).toContainText('Key mail 3')
    // Opening via the keyboard marks read on the server too.
    await mailbox.waitFor('INBOX', (m) => ['Key mail 2', 'Key mail 3'].every((s) => m.find((x) => x.subject === s)?.flags.includes('\\Seen')))

    await app.keyboard.press('Escape')
    await expect(view).toHaveCount(0)

    await app.keyboard.press('/')
    await expect(app.locator('[data-search-input]')).toBeFocused()
    // Letters typed into the search box are text, not shortcuts.
    await app.keyboard.type('jk')
    await expect(app.locator('[data-search-input]')).toHaveValue('jk')
    await expect(view).toHaveCount(0)
  })

  test('n opens compose; Escape closes it', async ({ app }) => {
    await app.keyboard.press('n')
    await expect(app.locator('.modal.compose')).toBeVisible()
    await app.keyboard.press('Escape')
    await expect(app.locator('.modal.compose')).toHaveCount(0)
  })
})

test.describe('resizable columns', () => {
  test('folder and list columns resize by dragging, stop at mouse up, and persist', async ({ mailbox, app }) => {
    await mailbox.seed('INBOX', [{ subject: 'Resize mail' }])
    await app.reload()
    await app.locator('.message-row').first().click()
    const sidebar = app.locator('.sidebar')
    const list = app.locator('.message-list-container')
    const sideHandle = app.locator('[aria-label="Resize folder column"]')
    const listHandle = app.locator('[aria-label="Resize list column"]')

    const s0 = await width(sidebar)
    await drag(app, sideHandle, 60)
    const s1 = await width(sidebar)
    expect(Math.abs(s1 - (s0 + 60))).toBeLessThanOrEqual(4)

    const l0 = await width(list)
    await drag(app, listHandle, 80)
    const l1 = await width(list)
    expect(Math.abs(l1 - (l0 + 80))).toBeLessThanOrEqual(4)
    // The trailing mouse moves (no button) did not move them further.
    expect(await width(sidebar)).toBe(s1)

    await app.reload()
    await app.locator('.message-row').first().click()
    expect(Math.abs((await width(sidebar)) - s1)).toBeLessThanOrEqual(1)
    expect(Math.abs((await width(list)) - l1)).toBeLessThanOrEqual(1)
  })
})

test.describe('folder switching', () => {
  test('rapid switches end on the last folder, never a stale list', async ({ mailbox, app }) => {
    const folders = ['Alpha', 'Beta', 'Gamma', 'Delta']
    for (const f of folders) {
      await mailbox.createFolder(f)
      await mailbox.seed(f, [{ subject: `In ${f}` }])
    }
    await app.reload()
    // Make the first folder's answer arrive last.
    let release!: () => void
    const held = new Promise<void>((r) => { release = r })
    await app.route('**/api/messages?*', async (route) => {
      if (new URL(route.request().url()).searchParams.get('folder') === mbox('Alpha')) await held
      await route.continue()
    })
    for (const f of folders) await folderButton(app, f).click()
    await specialItem(app, 'Inbox').click()
    await folderButton(app, 'Gamma').click()
    await expectList(app, ['In Gamma'])
    const alpha = waitMessages(app, mbox('Alpha'))
    release()
    await alpha
    await app.waitForTimeout(500)
    expect(await listSubjects(app)).toEqual(['In Gamma'])
    await expect(folderButton(app, 'Gamma').locator('..')).toHaveClass(/active/)

    // Without artificial delay: many quick switches, then settle.
    await app.unroute('**/api/messages?*')
    for (let i = 0; i < 3; i++) for (const f of folders) await folderButton(app, f).click()
    await expectList(app, ['In Delta'])
  })
})

test.describe('unread counts and live updates', () => {
  test('per-folder unread badges are correct and follow reading', async ({ mailbox, app }) => {
    await mailbox.createFolder('Lists')
    await mailbox.seed('INBOX', [
      { subject: 'Unread A', date: at(1) },
      { subject: 'Unread B', date: at(2) },
      { subject: 'Read C', date: at(3), flags: ['\\Seen'] }
    ])
    await mailbox.seed('Lists', [{ subject: 'List 1', date: at(1) }, { subject: 'List 2', date: at(2) }, { subject: 'List 3', date: at(3) }])
    await app.reload()
    const inboxBadge = specialItem(app, 'Inbox').locator('.badge')
    const listsBadge = folderButton(app, 'Lists').locator('.badge')
    await expect(inboxBadge).toHaveText('2')
    await expect(listsBadge).toHaveText('3')

    await app.locator('.message-row', { hasText: 'Unread A' }).click()
    await expect(inboxBadge).toHaveText('1')
    await mailbox.waitFor('INBOX', (m) => m.find((x) => x.subject === 'Unread A')?.flags.includes('\\Seen'))

    await folderButton(app, 'Lists').click()
    await expectList(app, ['List 3', 'List 2', 'List 1'])
    await app.locator('.message-row', { hasText: 'List 2' }).click()
    await expect(listsBadge).toHaveText('2')
    // The other folder's badge is untouched by the open folder.
    await expect(inboxBadge).toHaveText('1')

    // Marked read elsewhere (another client): reflected after reload.
    await mailbox.with(async (c) => {
      const lock = await c.getMailboxLock(mbox('Lists'))
      try { await c.messageFlagsAdd('1:*', ['\\Seen']) } finally { lock.release() }
    })
    await app.reload()
    await expect(listsBadge).toHaveCount(0)
    await expect(inboxBadge).toHaveText('1')
  })

  test('new mail in the Inbox appears without reload and bumps the badge', async ({ mailbox, app }) => {
    await mailbox.seed('INBOX', [{ subject: 'Already here', flags: ['\\Seen'] }])
    await app.reload()
    await expectList(app, ['Already here'])
    // Let the IDLE stream settle before delivering.
    await app.waitForTimeout(1500)
    await mailbox.seed('INBOX', [{ subject: 'Fresh arrival' }])
    await expect.poll(() => listSubjects(app), { timeout: 20_000 }).toEqual(['Fresh arrival', 'Already here'])
    await expect(specialItem(app, 'Inbox').locator('.badge')).toHaveText('1')

    // While another folder is open, the Inbox badge still updates.
    await specialItem(app, 'Sent').click()
    await expect(app.locator('.empty-state')).toContainText('No messages')
    await mailbox.seed('INBOX', [{ subject: 'Second arrival' }])
    await expect(specialItem(app, 'Inbox').locator('.badge')).toHaveText('2', { timeout: 20_000 })
    await expect(app.locator('.empty-state')).toContainText('No messages')
  })

  test('recovers after the IMAP server restarts, without a page reload', async ({ mailbox, app }) => {
    test.setTimeout(120_000)
    await mailbox.seed('INBOX', [{ subject: 'Before restart', flags: ['\\Seen'] }])
    await app.reload()
    await expectList(app, ['Before restart'])
    const { execFileSync } = await import('node:child_process')
    execFileSync('podman', ['restart', '-t', '1', `leoposta-e2e-dovecot-${process.env.E2E_STACK_ID || 0}`], { stdio: 'ignore' })
    // Wait until IMAP accepts logins again.
    await expect.poll(() => mailbox.with(async () => true).catch(() => false), { timeout: 30_000 }).toBe(true)
    await mailbox.seed('INBOX', [{ subject: 'After restart' }])
    await expect.poll(() => listSubjects(app), { timeout: 45_000 }).toEqual(['After restart', 'Before restart'])
    // Folder clicks work again on the (re)pooled connection.
    await specialItem(app, 'Sent').click()
    await expect(app.locator('.empty-state')).toContainText('No messages')
    await specialItem(app, 'Inbox').click()
    await expectList(app, ['After restart', 'Before restart'])
  })
})

test.describe('large mailbox', () => {
  test('300 messages: newest first, load more reaches the oldest, no duplicates', async ({ mailbox, app }) => {
    test.setTimeout(150_000)
    const N = 300
    await mailbox.with(async (c) => {
      for (let i = 1; i <= N; i++) {
        const raw = await (await import('./fixtures')).Mailbox.raw({ subject: `Bulk ${String(i).padStart(3, '0')}`, date: at(i) }, mailbox.email)
        await c.append('INBOX', raw, ['\\Seen'], at(i))
      }
    })
    await app.reload()
    const list = app.locator('.message-list')
    await expect(app.locator('.message-row').first()).toContainText('Bulk 300')

    const seen: string[] = []
    const collect = async () => {
      for (const s of await listSubjects(app)) if (!seen.includes(s)) seen.push(s)
    }
    const more = app.getByRole('button', { name: /load more/i })
    for (let round = 0; round < 20; round++) {
      // Scroll to the bottom of the (virtualised) list, collecting rows on the way.
      for (let k = 0; k < 60; k++) {
        await collect()
        const atEnd = await list.evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 2)
        if (atEnd) break
        await list.evaluate((el) => { el.scrollTop += el.clientHeight * 0.8 })
        await app.waitForTimeout(30)
      }
      await collect()
      if (seen.includes('Bulk 001')) break
      await expect(more).toBeVisible()
      await more.click()
      await expect.poll(async () => (await list.evaluate((el) => el.scrollTop + el.clientHeight < el.scrollHeight - 2))).toBe(true)
    }
    const expected = Array.from({ length: N }, (_, i) => `Bulk ${String(N - i).padStart(3, '0')}`)
    expect(seen).toEqual(expected)
    await expect(more).toHaveCount(0)
    // Opening an old one works.
    await app.locator('.message-row', { hasText: 'Bulk 001' }).click()
    await expect(app.locator('.message-view')).toContainText('Bulk 001')
  })
})
