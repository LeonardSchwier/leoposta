// Shared fixtures for the real-stack e2e suite (see playwright.real.config.ts).
//
// Every test gets:
//   user     a fresh, unique mailbox on the real Dovecot (password "pass")
//   mailbox  direct IMAP access to it: seed messages, inspect folders/flags
//   account  that mailbox configured as the app's only account (via the API)
//   page     the app, opened with the right token for the project (pwa or
//            desktop), with a guard that FAILS the test on any console error,
//            uncaught page error, or failed /api/ response (>= 400, network
//            failure) — unless the test declares it with `allowApiErrors`.
//   smtp     the SMTP sink's envelope log (what the app actually handed off)
import crypto from 'node:crypto'
import fs from 'node:fs'
import { test as base, expect, type Page } from '@playwright/test'
import { ImapFlow } from 'imapflow'
import MailComposer from 'nodemailer/lib/mail-composer/index.js'

export const TOKEN = 'e2e-real-token'
const SID = Number(process.env.E2E_STACK_ID || 0)
export const IMAP_PORT = 3143 + 10 * SID
export const SMTP_PORT = 3587 + 10 * SID
export const DAV_PORT = 5233 + 10 * SID
export const PASSWORD = 'pass'
export const LAYOUT = (process.env.E2E_LAYOUT || 'slash') as 'slash' | 'dot'

/** Server-side mailbox path for a logical name ("Projects/2026" → layout path). */
export function mbox(name: string): string {
  if (name.toUpperCase() === 'INBOX') return 'INBOX'
  return LAYOUT === 'dot' ? `INBOX.${name.split('/').join('.')}` : name
}

export interface SeedMessage {
  from?: string
  to?: string | string[]
  cc?: string | string[]
  subject: string
  text?: string
  html?: string
  date?: Date
  messageId?: string
  inReplyTo?: string
  references?: string
  attachments?: { filename: string; content: string | Buffer; contentType?: string; cid?: string }[]
  flags?: string[]
}

export class Mailbox {
  constructor(readonly email: string) {}

  async client(): Promise<ImapFlow> {
    const c = new ImapFlow({
      host: '127.0.0.1', port: IMAP_PORT, secure: false,
      auth: { user: this.email, pass: PASSWORD }, logger: false
    })
    await c.connect()
    return c
  }

  async with<T>(fn: (c: ImapFlow) => Promise<T>): Promise<T> {
    const c = await this.client()
    try { return await fn(c) } finally { await c.logout().catch(() => {}) }
  }

  /** Create a mailbox by logical name (e.g. "Projects/2026/Q1"), parents included. */
  async createFolder(name: string) {
    await this.with(async (c) => {
      const parts = name.split('/')
      for (let i = 1; i <= parts.length; i++) {
        await c.mailboxCreate(mbox(parts.slice(0, i).join('/'))).catch(() => {})
      }
    })
  }

  static async raw(m: SeedMessage, self: string): Promise<Buffer> {
    const mail = new MailComposer({
      from: m.from ?? 'Sender <sender@example.test>',
      to: m.to ?? self,
      cc: m.cc,
      subject: m.subject,
      text: m.text,
      html: m.html,
      date: m.date ?? new Date(),
      messageId: m.messageId,
      inReplyTo: m.inReplyTo,
      references: m.references,
      attachments: m.attachments
    })
    return mail.compile().build()
  }

  /** APPEND messages into a folder (logical name). Returns nothing; read back with `messages`. */
  async seed(folder: string, msgs: SeedMessage[]) {
    await this.with(async (c) => {
      for (const m of msgs) {
        await c.append(mbox(folder), await Mailbox.raw(m, this.email), m.flags ?? [], m.date ?? new Date())
      }
    })
  }

  async folders(): Promise<{ path: string; specialUse?: string; flags: string[] }[]> {
    return this.with(async (c) => (await c.list()).map((f) => ({ path: f.path, specialUse: f.specialUse, flags: [...f.flags] })))
  }

  /** Envelopes + flags of every message in a folder (logical name). */
  async messages(folder: string) {
    return this.with(async (c) => {
      const lock = await c.getMailboxLock(mbox(folder))
      try {
        const out: { uid: number; subject: string; from: string; to: string[]; flags: string[]; source?: string }[] = []
        if ((c.mailbox && typeof c.mailbox === 'object' ? c.mailbox.exists : 0) === 0) return out
        for await (const msg of c.fetch('1:*', { uid: true, envelope: true, flags: true, source: true })) {
          out.push({
            uid: msg.uid,
            subject: msg.envelope?.subject ?? '',
            from: msg.envelope?.from?.[0]?.address ?? '',
            to: (msg.envelope?.to ?? []).map((a) => a.address ?? ''),
            flags: [...(msg.flags ?? [])],
            source: msg.source?.toString('utf8')
          })
        }
        return out
      } finally { lock.release() }
    })
  }

  /** Poll until a folder satisfies `pred` (IMAP is the source of truth). */
  async waitFor<T>(folder: string, pred: (msgs: Awaited<ReturnType<Mailbox['messages']>>) => T, timeout = 15_000): Promise<T> {
    const end = Date.now() + timeout
    let last: unknown
    for (;;) {
      const msgs = await this.messages(folder).catch((e) => { last = e; return [] })
      const r = pred(msgs)
      if (r) return r
      if (Date.now() > end) throw new Error(`waitFor(${folder}) timed out; last error: ${last ?? 'none'}; have: ${JSON.stringify(msgs.map((m) => m.subject))}`)
      await new Promise((res) => setTimeout(res, 300))
    }
  }
}

export function uniqueUser(prefix = 'u'): string {
  return `${prefix}${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex').slice(0, 5)}@example.test`
}

export function smtpLog(): { from: string; to: string[]; raw: string }[] {
  const f = '.e2e-real/smtp.jsonl'
  if (!fs.existsSync(f)) return []
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

export function accountBody(email: string, extra: Record<string, unknown> = {}) {
  return {
    name: email.split('@')[0],
    email,
    imapHost: '127.0.0.1', imapPort: IMAP_PORT, imapTls: false,
    smtpHost: '127.0.0.1', smtpPort: SMTP_PORT, smtpTls: false,
    imapUser: email, imapPass: PASSWORD,
    smtpUser: email, smtpPass: PASSWORD,
    davUrl: `http://127.0.0.1:${DAV_PORT}/${encodeURIComponent(email)}/`,
    ...extra
  }
}

type Fixtures = {
  desktop: boolean
  allowApiErrors: (RegExp | string)[]
  user: string
  mailbox: Mailbox
  account: string
  /** The app, already loaded with the test account configured. */
  app: Page
}

export const test = base.extend<Fixtures>({
  desktop: [false, { option: true }],
  allowApiErrors: [[], { option: true }],

  user: async ({}, use) => { await use(uniqueUser()) },

  mailbox: async ({ user }, use) => {
    const mb = new Mailbox(user)
    await mb.with(async () => {}) // first login creates the mailbox + special folders
    await use(mb)
  },

  account: async ({ request, baseURL, user, mailbox }, use) => {
    void mailbox
    const h = { 'x-leoposta-token': TOKEN }
    const existing = await (await request.get(`${baseURL}/api/accounts`, { headers: h })).json()
    for (const a of existing) await request.delete(`${baseURL}/api/accounts/${encodeURIComponent(a.email)}`, { headers: h })
    const res = await request.post(`${baseURL}/api/accounts`, { headers: h, data: accountBody(user) })
    expect(res.status(), await res.text()).toBe(200)
    await use(user)
  },

  page: async ({ page, desktop, allowApiErrors }, use) => {
    if (desktop) {
      await page.addInitScript((t) => { (window as unknown as Record<string, string>).__LEOPOSTA_DESKTOP_TOKEN__ = t }, TOKEN)
    }
    const problems: string[] = []
    const allowed = (s: string) => allowApiErrors.some((p) => (typeof p === 'string' ? s.includes(p) : p.test(s)))
    page.on('console', (m) => { if (m.type() === 'error' && !allowed(m.text())) problems.push(`console.error: ${m.text()}`) })
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
    page.on('response', async (r) => {
      const u = r.url()
      if (!u.includes('/api/') || r.status() < 400) return
      const line = `${r.request().method()} ${u.replace(/^https?:\/\/[^/]+/, '')} -> ${r.status()} ${await r.text().catch(() => '')}`
      if (!allowed(line)) problems.push(`api: ${line}`)
    })
    page.on('requestfailed', (r) => {
      const line = `${r.method()} ${r.url()} failed: ${r.failure()?.errorText}`
      if (r.url().includes('/api/') && !/ERR_ABORTED/.test(line) && !allowed(line)) problems.push(`api: ${line}`)
    })
    await use(page)
    expect(problems, 'console/page/API errors during the test').toEqual([])
  },

  app: async ({ page, account }, use) => {
    void account
    await page.goto('/')
    await expect(page.locator('.sidebar')).toBeVisible()
    await use(page)
  }
})

export { expect }
