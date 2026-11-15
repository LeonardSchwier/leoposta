// Helpers for the reading / rendering specs: hand-crafted RFC 822 sources,
// opening a message in the UI, and reading back what the server stored.
import crypto from 'node:crypto'
import { expect, type Locator, type Page } from '@playwright/test'
import { mbox, type Mailbox } from './fixtures'

/** Join header/body lines with CRLF, as a message on the wire. */
export function rfc822(lines: string[]): Buffer {
  return Buffer.from(lines.join('\r\n'), 'utf8')
}

/** A raw message: headers (From/To/Subject/Date/Message-ID defaulted) + body. */
export function rawMessage(opts: {
  self: string
  subject?: string
  from?: string | null
  date?: Date
  headers?: string[]
  body: string | Buffer
  messageId?: string
}): Buffer {
  const head: string[] = []
  if (opts.from !== null) head.push(`From: ${opts.from ?? 'Sender <sender@example.test>'}`)
  head.push(`To: ${opts.self}`)
  if (opts.subject !== undefined) head.push(`Subject: ${opts.subject}`)
  head.push(`Date: ${(opts.date ?? new Date()).toUTCString().replace('GMT', '+0000')}`)
  head.push(`Message-ID: ${opts.messageId ?? `<${crypto.randomBytes(8).toString('hex')}@example.test>`}`)
  head.push('MIME-Version: 1.0')
  head.push(...(opts.headers ?? []))
  const headBuf = Buffer.from(head.join('\r\n') + '\r\n\r\n', 'utf8')
  const bodyBuf = typeof opts.body === 'string' ? Buffer.from(opts.body.replace(/\r?\n/g, '\r\n'), 'utf8') : opts.body
  return Buffer.concat([headBuf, bodyBuf])
}

/** APPEND raw sources to a folder (logical name). */
export async function appendRaw(mailbox: Mailbox, folder: string, sources: Buffer[], flags: string[] = []) {
  await mailbox.with(async (c) => {
    for (const s of sources) await c.append(mbox(folder), s, flags)
  })
}

/** The list row for a subject. */
export function row(page: Page, subject: string | RegExp): Locator {
  return page.locator('.message-row').filter({ hasText: subject }).first()
}

/** Reload so the list shows what was seeded, then open the message and wait
 * until its full body has arrived. */
export async function openMessage(page: Page, subject: string | RegExp, opts: { reload?: boolean } = {}) {
  if (opts.reload !== false) await page.reload()
  const r = row(page, subject)
  await expect(r).toBeVisible()
  const done = page.waitForResponse((res) => /\/api\/message\/\d+\?/.test(res.url()) && res.request().method() === 'GET')
  await r.click({ position: { x: 60, y: 30 } })
  await done
  await expect(page.locator('.message-view')).toBeVisible()
  return page.locator('.message-view .message-content')
}

/** The marker our XSS payloads try to set; must stay undefined. */
export async function pwned(page: Page): Promise<unknown> {
  return page.evaluate(() => (window as unknown as { __pwned?: unknown }).__pwned)
}
