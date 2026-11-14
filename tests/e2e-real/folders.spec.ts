import { test, expect, mbox } from './fixtures'
import {
  SPECIAL, specialItem, folderButton, folderNode, toggleOf, revealFolder,
  expectList, seedTagged, rightClick, withPrompt, folderPaths, waitMessages
} from './helpers-folders'

// Folder tree against a real Dovecot, in both layouts ("/" and "INBOX." + ".").
// Server truth is read back over IMAP (mailbox fixture).

const ODD = ['# Archive', 'R&D', 'C++ Notes', 'Ünïcödé Ordner', 'Party 🎉', 'Space Folder']
const DEEP = 'Projects/2026/Q1/Week 1'

test.describe('folder list', () => {
  test('special folders are listed once and open the right server mailbox', async ({ mailbox, app }) => {
    const server = await mailbox.folders()
    for (const s of SPECIAL) {
      const path = s.logical === 'INBOX' ? 'INBOX' : server.find((f) => f.specialUse === s.use)?.path
      expect(path, `server has ${s.use}`).toBe(mbox(s.logical))
    }
    await seedTagged(mailbox, SPECIAL.map((s) => s.logical))
    await app.reload()
    for (const s of SPECIAL) await expect(specialItem(app, s.name)).toHaveCount(1)
    // Not repeated in the custom tree.
    for (const s of SPECIAL.slice(1)) await expect(folderButton(app, s.logical)).toHaveCount(0)

    for (const s of SPECIAL) {
      const req = waitMessages(app, mbox(s.logical))
      await specialItem(app, s.name).click()
      expect((await req).status()).toBe(200)
      await expectList(app, [`In ${s.logical}`])
      await expect(specialItem(app, s.name)).toHaveClass(/active/)
    }
  })

  test('custom folders with special characters and deep nesting open with their messages', async ({ mailbox, app }) => {
    const all = [...ODD, 'Projects', 'Projects/2026', 'Projects/2026/Q1', DEEP]
    for (const f of [...ODD, DEEP]) await mailbox.createFolder(f)
    await seedTagged(mailbox, all)
    await app.reload()

    for (const f of all) {
      await revealFolder(app, f)
      const req = waitMessages(app, mbox(f))
      await folderButton(app, f).click()
      expect((await req).status()).toBe(200)
      await expectList(app, [`In ${f}`])
      await expect(folderNode(app, f).locator('> .folder-row')).toHaveClass(/active/)
    }
    // Unicode names are decoded from modified UTF-7 for display.
    await expect(folderButton(app, 'Ünïcödé Ordner')).toContainText('Ünïcödé Ordner')
    await expect(folderButton(app, 'Party 🎉')).toContainText('Party 🎉')
  })

  test('expand/collapse chevrons work and persist across reload', async ({ mailbox, app }) => {
    await mailbox.createFolder(DEEP)
    await app.reload()
    await expect(folderButton(app, 'Projects/2026')).toHaveCount(0)
    await toggleOf(app, 'Projects').click()
    await expect(folderButton(app, 'Projects/2026')).toBeVisible()
    await toggleOf(app, 'Projects/2026').click()
    await expect(folderButton(app, 'Projects/2026/Q1')).toBeVisible()
    await app.reload()
    await expect(folderButton(app, 'Projects/2026/Q1')).toBeVisible()
    await toggleOf(app, 'Projects').click()
    await expect(folderButton(app, 'Projects/2026')).toHaveCount(0)
    await app.reload()
    await expect(folderButton(app, 'Projects')).toBeVisible()
    await expect(folderButton(app, 'Projects/2026')).toHaveCount(0)
    // Re-expanding remembers the inner state.
    await toggleOf(app, 'Projects').click()
    await expect(folderButton(app, 'Projects/2026/Q1')).toBeVisible()
  })

  test('a \\Noselect parent only toggles and never SELECTs', async ({ mailbox, app }) => {
    // Creating "Ghost/Child" and deleting "Ghost" leaves a \Noselect parent.
    await mailbox.createFolder('Ghost/Child')
    await mailbox.seed('Ghost/Child', [{ subject: 'Ghost child mail' }])
    await mailbox.with((c) => c.mailboxDelete(mbox('Ghost')))
    const ghost = (await mailbox.folders()).find((f) => f.path === mbox('Ghost'))
    expect(ghost?.flags.some((x) => /noselect|nonexistent/i.test(x))).toBeTruthy()
    await app.reload()
    const requests: string[] = []
    app.on('request', (r) => { if (r.url().includes('/api/messages?')) requests.push(r.url()) })
    await folderButton(app, 'Ghost').click()
    await expect(folderButton(app, 'Ghost/Child')).toBeVisible()
    await folderButton(app, 'Ghost').click()
    await expect(folderButton(app, 'Ghost/Child')).toHaveCount(0)
    expect(requests).toEqual([])
    await revealFolder(app, 'Ghost/Child')
    await folderButton(app, 'Ghost/Child').click()
    await expectList(app, ['Ghost child mail'])
  })
})

test.describe('folder management', () => {
  test('create the first folder with the "+" button, then another from the context menu', async ({ mailbox, app }) => {
    // A fresh account has only special folders: the Folders section must still be there.
    await withPrompt(app, 'First One', async () => {
      await app.locator('.sidebar button[aria-label="New folder"]').click()
    }, /folder name/i)
    await expect.poll(() => folderPaths(mailbox)).toContain(mbox('First One'))
    await expect(folderButton(app, 'First One')).toBeVisible()

    await rightClick(app.locator('.sidebar .section-label', { hasText: 'Folders' }))
    await withPrompt(app, 'Brand New & Co', async () => {
      await app.locator('.context-menu').getByText('New Folder').click()
    })
    await expect.poll(() => folderPaths(mailbox)).toContain(mbox('Brand New & Co'))
    await expect(folderButton(app, 'Brand New & Co')).toBeVisible()
    // ...and it opens (empty).
    await folderButton(app, 'Brand New & Co').click()
    await expect(app.locator('.empty-state')).toContainText('No messages')
  })

  test('create a subfolder uses the server delimiter', async ({ mailbox, app }) => {
    await mailbox.createFolder('Parent')
    await app.reload()
    await rightClick(folderButton(app, 'Parent'))
    await withPrompt(app, 'Kid', async () => {
      await app.locator('.context-menu').getByText('New Subfolder').click()
    })
    await expect.poll(() => folderPaths(mailbox)).toContain(mbox('Parent/Kid'))
    // The parent was expanded for it, no reload needed.
    await expect(folderButton(app, 'Parent/Kid')).toBeVisible()
  })

  test('rename a folder, including a parent with children', async ({ mailbox, app }) => {
    await mailbox.createFolder('Old/Child')
    await mailbox.seed('Old/Child', [{ subject: 'Child mail' }])
    await app.reload()
    await revealFolder(app, 'Old/Child')
    await folderButton(app, 'Old/Child').click()
    await expectList(app, ['Child mail'])

    // Rename the child: it stays under its parent.
    await rightClick(folderButton(app, 'Old/Child'))
    await withPrompt(app, 'Kid', async () => {
      await app.locator('.context-menu').getByText('Rename').click()
    }, /Rename folder "Child"/)
    await expect.poll(() => folderPaths(mailbox)).toContain(mbox('Old/Kid'))
    await expect(folderButton(app, 'Old/Kid')).toBeVisible()
    // The open folder followed the rename.
    await expect(folderNode(app, 'Old/Kid').locator('> .folder-row')).toHaveClass(/active/)
    await expectList(app, ['Child mail'])

    // Rename the parent: children move along and stay expanded.
    await rightClick(folderButton(app, 'Old'))
    await withPrompt(app, 'Renamed', async () => {
      await app.locator('.context-menu').getByText('Rename').click()
    })
    await expect.poll(() => folderPaths(mailbox)).toContain(mbox('Renamed/Kid'))
    expect(await folderPaths(mailbox)).not.toContain(mbox('Old'))
    await expect(folderButton(app, 'Old')).toHaveCount(0)
    await expect(folderButton(app, 'Renamed/Kid')).toBeVisible()
    await expect(folderNode(app, 'Renamed/Kid').locator('> .folder-row')).toHaveClass(/active/)
    await expectList(app, ['Child mail'])
  })

  test('delete a folder after confirmation; cancel keeps it', async ({ mailbox, app }) => {
    await mailbox.createFolder('Doomed')
    await mailbox.seed('Doomed', [{ subject: 'Doomed mail' }])
    await mailbox.seed('INBOX', [{ subject: 'Inbox mail' }])
    await app.reload()
    await folderButton(app, 'Doomed').click()
    await expectList(app, ['Doomed mail'])
    // Cancel
    await rightClick(folderButton(app, 'Doomed'))
    await withPrompt(app, null, async () => {
      await app.locator('.context-menu').getByText('Delete Folder').click()
    }, /Delete folder "Doomed"/)
    expect(await folderPaths(mailbox)).toContain(mbox('Doomed'))
    await expectList(app, ['Doomed mail'])
    // Confirm
    await rightClick(folderButton(app, 'Doomed'))
    await withPrompt(app, '', async () => {
      await app.locator('.context-menu').getByText('Delete Folder').click()
    })
    await expect.poll(() => folderPaths(mailbox)).not.toContain(mbox('Doomed'))
    await expect(folderButton(app, 'Doomed')).toHaveCount(0)
    // It was open: the app is back in the Inbox, not showing a folder that is gone.
    await expect(specialItem(app, 'Inbox')).toHaveClass(/active/)
    await expectList(app, ['Inbox mail'])
  })

  test('delete a folder that has subfolders', async ({ mailbox, app }) => {
    await mailbox.createFolder('Tree/Leaf/Deeper')
    await mailbox.createFolder('Treehouse')
    await mailbox.seed('Tree/Leaf', [{ subject: 'Leaf mail' }])
    await app.reload()
    await rightClick(folderButton(app, 'Tree'))
    await withPrompt(app, '', async () => {
      await app.locator('.context-menu').getByText('Delete Folder').click()
    }, /subfolders/)
    await expect.poll(() => folderPaths(mailbox)).not.toContain(mbox('Tree'))
    const left = await folderPaths(mailbox)
    expect(left.filter((p) => p.startsWith(mbox('Tree')))).toEqual([mbox('Treehouse')])
    await expect(folderButton(app, 'Tree')).toHaveCount(0)
    await expect(folderButton(app, 'Treehouse')).toBeVisible()
  })
})
