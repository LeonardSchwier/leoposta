// Helpers for sending.spec.ts: drive the compose window like a user and read
// back what really arrived (recipient mailboxes, the Sent folder, SMTP log).
import crypto from 'node:crypto'
import { simpleParser, type ParsedMail } from 'mailparser'
import { expect, type Page } from '@playwright/test'
import { Mailbox, uniqueUser, smtpLog, mbox } from './fixtures'

/** A second, fresh mailbox on the test server (logged in once so it exists). */
export async function newRecipient(prefix = 'r'): Promise<Mailbox> {
  const mb = new Mailbox(uniqueUser(prefix))
  await mb.with(async () => {})
  return mb
}

export function sha256(b: Buffer | string): string {
  return crypto.createHash('sha256').update(b).digest('hex')
}

export async function openCompose(app: Page) {
  await app.locator('.sidebar .compose-btn').click()
  await expect(app.locator('.modal.compose')).toBeVisible()
}

/** Type into a recipient field key by key, as a user would (commas included). */
export async function typeRecipients(app: Page, field: 'to' | 'cc' | 'bcc', text: string) {
  const compose = app.locator('.modal.compose')
  if (field === 'cc' && !(await compose.locator('#compose-cc').isVisible())) {
    await compose.getByRole('button', { name: 'Add Cc' }).click()
  }
  if (field === 'bcc' && !(await compose.locator('#compose-bcc').isVisible())) {
    await compose.getByRole('button', { name: 'Add Bcc' }).click()
  }
  const input = compose.locator(`#compose-${field}`)
  await input.click()
  await input.pressSequentially(text)
}

/** Wait until the compose window has filled in signature / quote / forwarded attachments. */
export async function waitSeeded(app: Page) {
  await expect(app.locator('.modal.compose #compose-body')).toHaveAttribute('data-seeded', 'true')
}

export async function fillMessage(app: Page, subject: string, body: string) {
  const compose = app.locator('.modal.compose')
  await waitSeeded(app)
  await compose.locator('#compose-subject').fill(subject)
  const ta = compose.locator('#compose-body')
  // Keep whatever the app seeded (signature, quote) after the typed text.
  const seeded = await ta.inputValue()
  await ta.fill(body + seeded)
}

/** Click Send and wait until the compose window has closed. */
export async function sendAndClose(app: Page) {
  await app.locator('.modal.compose').getByRole('button', { name: 'Send', exact: true }).click()
  await expect(app.locator('.modal.compose')).toHaveCount(0, { timeout: 30_000 })
}

/** Messages (parsed) in a mailbox folder, waiting until `count` have arrived. */
export async function waitParsed(mb: Mailbox, folder: string, count = 1, timeout = 20_000): Promise<ParsedMail[]> {
  const msgs = await mb.waitFor(folder, (m) => (m.length >= count ? m : null), timeout)
  return Promise.all(msgs.map((m) => simpleParser(m.source ?? '')))
}

/** The path of the mailbox the server flags \Sent (both layouts). */
export async function sentPath(mb: Mailbox): Promise<string> {
  const f = (await mb.folders()).find((x) => x.specialUse === '\\Sent')
  if (!f) throw new Error('no \\Sent mailbox')
  expect(f.path).toBe(mbox('Sent'))
  return f.path
}

/** SMTP envelopes whose raw message carries `subject` (decoded). */
export async function envelopesFor(subject: string) {
  const out: { from: string; to: string[]; raw: string; parsed: ParsedMail }[] = []
  for (const e of smtpLog()) {
    const parsed = await simpleParser(e.raw)
    if (parsed.subject === subject) out.push({ ...e, parsed })
  }
  return out
}

export function addrs(v: ParsedMail['to']): string[] {
  if (!v) return []
  const list = Array.isArray(v) ? v : [v]
  return list.flatMap((a) => a.value.map((x) => (x.address ?? '').toLowerCase()))
}

export function names(v: ParsedMail['to']): string[] {
  if (!v) return []
  const list = Array.isArray(v) ? v : [v]
  return list.flatMap((a) => a.value.map((x) => x.name ?? ''))
}

/** Open a message in the list by its subject. */
export async function openMessage(app: Page, subject: string) {
  await app.locator('.message-list').getByText(subject, { exact: true }).first().click({ position: { x: 2, y: 2 } })
  await expect(app.locator('.message-view .message-subject')).toHaveText(subject)
}

export function unique(label: string): string {
  return `${label} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}
