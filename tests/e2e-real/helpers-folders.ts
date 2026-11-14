// Helpers for the folder / navigation / search specs (real stack).
import { expect, type Locator, type Page } from '@playwright/test'
import { mbox, type Mailbox } from './fixtures'

export const SPECIAL = [
  { name: 'Inbox', logical: 'INBOX', use: '\\Inbox' },
  { name: 'Sent', logical: 'Sent', use: '\\Sent' },
  { name: 'Drafts', logical: 'Drafts', use: '\\Drafts' },
  { name: 'Archive', logical: 'Archive', use: '\\Archive' },
  { name: 'Junk', logical: 'Junk', use: '\\Junk' },
  { name: 'Trash', logical: 'Trash', use: '\\Trash' }
] as const

/** The sidebar entry of a special mailbox ("Inbox", "Sent", ...). */
export function specialItem(page: Page, name: string): Locator {
  return page.locator('.sidebar .folder-item').filter({ has: page.locator('.folder-name', { hasText: new RegExp(`^${name}$`) }) })
}

/** The open button of a custom folder, by its server path (its title). */
export function folderButton(page: Page, logical: string): Locator {
  return page.locator(`.sidebar .folder-open[title="${cssEscape(mbox(logical))}"]`)
}

/** The tree row (li) of a custom folder, by server path. */
export function folderNode(page: Page, logical: string): Locator {
  return page.locator('.sidebar li.folder-node').filter({ has: page.locator(`> .folder-row .folder-open[title="${cssEscape(mbox(logical))}"]`) })
}

export function toggleOf(page: Page, logical: string): Locator {
  return folderNode(page, logical).locator('> .folder-row .folder-toggle')
}

function cssEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** Expand every ancestor of `logical` (logical "/"-separated path) in the tree. */
export async function revealFolder(page: Page, logical: string) {
  const parts = logical.split('/')
  for (let i = 1; i < parts.length; i++) {
    const anc = parts.slice(0, i).join('/')
    const t = toggleOf(page, anc)
    await expect(t).toBeVisible()
    if ((await t.getAttribute('aria-expanded')) !== 'true') await t.click()
    await expect(t).toHaveAttribute('aria-expanded', 'true')
  }
  await expect(folderButton(page, logical)).toBeVisible()
}

/** Visible subjects in the message list, top to bottom. */
export function listSubjects(page: Page): Promise<string[]> {
  return page.locator('.message-list .message-row .message-subject').allInnerTexts()
}

export async function expectList(page: Page, subjects: string[]) {
  await expect.poll(() => listSubjects(page)).toEqual(subjects)
}

/** Seed one message per folder whose subject names the folder. */
export async function seedTagged(mailbox: Mailbox, folders: string[]) {
  for (const f of folders) await mailbox.seed(f, [{ subject: `In ${f}` }])
}

export function rightClick(l: Locator) {
  return l.click({ button: 'right' })
}

/** Run `action`, answering the next window.prompt with `answer` (null = cancel). */
export async function withPrompt(page: Page, answer: string | null, action: () => Promise<void>, expectMessage?: RegExp): Promise<string> {
  let seen = ''
  const p = page.waitForEvent('dialog').then(async (d) => {
    seen = d.message()
    if (answer === null) await d.dismiss()
    else await d.accept(answer)
  })
  await action()
  await p
  if (expectMessage) expect(seen).toMatch(expectMessage)
  return seen
}

/** The next /api/messages response for `serverPath` (other folders' responses are ignored). */
export function waitMessages(page: Page, serverPath: string) {
  return page.waitForResponse((r) => r.url().includes('/api/messages?') && new URL(r.url()).searchParams.get('folder') === serverPath)
}

export async function folderPaths(mailbox: Mailbox): Promise<string[]> {
  return (await mailbox.folders()).map((f) => f.path).sort()
}
