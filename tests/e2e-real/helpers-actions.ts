// UI helpers shared by drafts.spec.ts and actions.spec.ts.
import { expect, type Locator, type Page } from '@playwright/test'
import type { Mailbox } from './fixtures'

/** The list row showing `subject`. */
export function row(page: Page, subject: string): Locator {
  return page.locator('.message-row').filter({ hasText: subject })
}

/** Open a sidebar mailbox by its label ("Inbox", "Drafts", "Archive", ...). */
export async function openMailbox(page: Page, label: string) {
  await page.locator('.sidebar .folder-item').filter({ has: page.locator('.folder-name', { hasText: new RegExp(`^${label}$`) }) }).click()
  await expect(page.locator('.folder-title')).not.toHaveText('')
}

/** The unread badge of a sidebar mailbox, or null text when there is none. */
export function badge(page: Page, label: string): Locator {
  return page.locator('.sidebar .folder-item')
    .filter({ has: page.locator('.folder-name', { hasText: new RegExp(`^${label}$`) }) })
    .locator('.badge')
}

/** Right-click a row and pick a context-menu entry. */
export async function contextAction(page: Page, subject: string, item: string) {
  await row(page, subject).click({ button: 'right' })
  await page.locator('.context-menu .context-menu-item')
    .filter({ has: page.locator('.item-label', { hasText: new RegExp(`^${item}$`) }) }).click()
}

/** Click a row (opens it in the reading pane). */
export async function openRow(page: Page, subject: string) {
  await row(page, subject).locator('.message-subject').click()
  await expect(page.locator('.message-view .message-subject')).toHaveText(subject)
}

export const toast = (page: Page) => page.getByTestId('toast')

/** Flags of the message with `subject` in a folder, read from IMAP. */
export async function flagsOf(mailbox: Mailbox, folder: string, subject: string): Promise<string[]> {
  const m = (await mailbox.messages(folder)).find((x) => x.subject === subject)
  if (!m) throw new Error(`${subject} not in ${folder}`)
  return m.flags
}

export async function subjects(mailbox: Mailbox, folder: string): Promise<string[]> {
  return (await mailbox.messages(folder)).map((m) => m.subject).sort()
}
