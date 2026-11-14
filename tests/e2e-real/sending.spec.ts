import crypto from 'node:crypto'
import { simpleParser } from 'mailparser'
import { test, expect, TOKEN, accountBody } from './fixtures'
import {
  newRecipient, openCompose, typeRecipients, fillMessage, sendAndClose,
  waitParsed, sentPath, envelopesFor, addrs, names, unique, sha256, openMessage, waitSeeded
} from './helpers-sending'

// Sending & composing, end to end: everything is typed in the UI, and the
// truth is read back from the server (recipients' INBOX, Sent, SMTP log).

test('To/Cc/Bcc with display names: everyone gets it, Bcc stays hidden, unicode and lines intact', async ({ app, user }) => {
  const [to1, to2, cc1, bcc1] = await Promise.all([newRecipient('to'), newRecipient('to'), newRecipient('cc'), newRecipient('bcc')])
  const subject = unique('Grüße 🚀 Über')
  const body = 'Hallo Jürgen,\n\nZeile zwei mit Ümläuten äöüß und Emoji 🎉.\n  eingerückt\nAnna <anna@example.test> schrieb: <b>kein HTML</b>\n\nTschüss'

  await openCompose(app)
  await typeRecipients(app, 'to', `Anna Älter <${to1.email}>, ${to2.email}`)
  await typeRecipients(app, 'cc', cc1.email)
  await typeRecipients(app, 'bcc', bcc1.email)
  await fillMessage(app, subject, body)
  await sendAndClose(app)

  for (const r of [to1, to2, cc1, bcc1]) {
    const [m] = await waitParsed(r, 'INBOX')
    expect(m.subject).toBe(subject)
    expect(m.text?.replace(/\r\n/g, '\n').trimEnd()).toBe(body)
    // The editor is plain text: no invented HTML part.
    expect(m.html).toBe(false)
    expect(addrs(m.to).sort()).toEqual([to1.email, to2.email].sort())
    expect(names(m.to)).toContain('Anna Älter')
    expect(addrs(m.cc)).toEqual([cc1.email])
    expect(m.bcc).toBeUndefined()
    expect(m.headers.has('bcc')).toBe(false)
    expect(addrs(m.from)).toEqual([user])
  }

  const env = await envelopesFor(subject)
  expect(env).toHaveLength(1)
  expect(env[0].to.map((a) => a.toLowerCase()).sort()).toEqual([to1.email, to2.email, cc1.email, bcc1.email].sort())
  expect(env[0].raw).not.toMatch(/^bcc:/im)
})

test('a copy lands in the \\Sent mailbox, seen, with the same Message-ID (Bcc kept for the sender)', async ({ app, mailbox }) => {
  const [rcpt, hidden] = await Promise.all([newRecipient(), newRecipient('bcc')])
  const subject = unique('Sent copy')
  await openCompose(app)
  await typeRecipients(app, 'to', rcpt.email)
  await typeRecipients(app, 'bcc', hidden.email)
  await fillMessage(app, subject, 'Kept for the record.')
  await sendAndClose(app)

  const [delivered] = await waitParsed(rcpt, 'INBOX')
  await sentPath(mailbox)
  const copy = await mailbox.waitFor('Sent', (m) => m.find((x) => x.subject === subject))
  expect(copy.flags).toContain('\\Seen')
  const parsed = await simpleParser(copy.source ?? '')
  expect(parsed.messageId).toBe(delivered.messageId)
  expect(parsed.text?.trim()).toBe('Kept for the record.')
  expect(addrs(parsed.to)).toEqual([rcpt.email])
  expect(addrs(parsed.bcc)).toEqual([hidden.email])
  expect((await mailbox.messages('INBOX')).filter((m) => m.subject === subject)).toHaveLength(0)

  // ... and the app shows it in Sent.
  await app.locator('.sidebar').getByText('Sent', { exact: true }).first().click()
  await expect(app.locator('.message-list').getByText(subject)).toBeVisible()
})

test('attachments (text, binary PNG, ~5 MB) arrive byte for byte with name and type', async ({ app, mailbox }) => {
  test.setTimeout(120_000)
  const rcpt = await newRecipient()
  const subject = unique('Attachments')
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  const big = crypto.randomBytes(5 * 1024 * 1024)
  const files = [
    { name: 'notiz-ä.txt', mimeType: 'text/plain', buffer: Buffer.from('Grüße\nline 2\n', 'utf8') },
    { name: 'pixel.png', mimeType: 'image/png', buffer: png },
    { name: 'big.bin', mimeType: 'application/octet-stream', buffer: big }
  ]

  await openCompose(app)
  await typeRecipients(app, 'to', rcpt.email)
  await fillMessage(app, subject, 'See attached.')
  await app.locator('.modal.compose input[type=file]').setInputFiles(files)
  for (const f of files) await expect(app.locator('.attachment-chip').getByText(f.name)).toBeVisible()
  await sendAndClose(app)

  const [m] = await waitParsed(rcpt, 'INBOX', 1, 40_000)
  expect(m.subject).toBe(subject)
  expect(m.attachments.map((a) => a.filename)).toEqual(files.map((f) => f.name))
  for (const f of files) {
    const a = m.attachments.find((x) => x.filename === f.name)!
    expect(a.contentType).toBe(f.mimeType)
    expect(sha256(a.content)).toBe(sha256(f.buffer))
  }
  const copy = await mailbox.waitFor('Sent', (msgs) => msgs.find((x) => x.subject === subject), 40_000)
  const sent = await simpleParser(copy.source ?? '')
  expect(sent.attachments.map((a) => sha256(a.content))).toEqual(files.map((f) => sha256(f.buffer)))
})

test('Reply: to the sender, "Re:", threaded headers, quoted original', async ({ app, mailbox, user }) => {
  const ext = await newRecipient('ext')
  const subject = unique('Question')
  await mailbox.seed('INBOX', [{
    from: `Erika Muster <${ext.email}>`, to: user, subject,
    text: 'First line of the question?\nSecond line.',
    messageId: `<orig-${Date.now()}@example.test>`, references: '<root@example.test>'
  }])
  await app.reload()
  await openMessage(app, subject)
  await app.locator('.message-view').getByRole('button', { name: 'Reply', exact: true }).click()
  const compose = app.locator('.modal.compose')
  await expect(compose.locator('#compose-subject')).toHaveValue(`Re: ${subject}`)
  await waitSeeded(app)
  await expect(compose.locator('#compose-to')).toHaveValue(`Erika Muster <${ext.email}>`)
  const ta = compose.locator('#compose-body')
  await ta.press('Control+Home')
  await ta.pressSequentially('My answer.')
  await sendAndClose(app)

  const [m] = await waitParsed(ext, 'INBOX')
  expect(m.subject).toBe(`Re: ${subject}`)
  const orig = (await mailbox.messages('INBOX')).find((x) => x.subject === subject)!
  const origId = (await simpleParser(orig.source ?? '')).messageId!
  expect(m.inReplyTo).toBe(origId)
  expect(m.references).toEqual(['<root@example.test>', origId])
  const text = m.text!.replace(/\r\n/g, '\n')
  expect(text.startsWith('My answer.')).toBe(true)
  expect(text).toContain(`Erika Muster <${ext.email}> wrote:`)
  expect(text).toContain('> First line of the question?\n> Second line.')
  expect(addrs(m.to)).toEqual([ext.email])
})

test('Reply all: sender + other To in To, Cc kept, own address left out', async ({ app, mailbox, user }) => {
  const [ext, other, ccd] = await Promise.all([newRecipient('ext'), newRecipient('oth'), newRecipient('cc')])
  const subject = unique('Team thread')
  await mailbox.seed('INBOX', [{
    from: `Ext <${ext.email}>`, to: [user, other.email], cc: [ccd.email], subject, text: 'Hi all.',
    messageId: `<all-${Date.now()}@example.test>`
  }])
  await app.reload()
  await openMessage(app, subject)
  await app.locator('.message-view').getByRole('button', { name: 'Reply all' }).click()
  await waitSeeded(app)
  await sendAndClose(app)

  for (const r of [ext, other, ccd]) {
    const [m] = await waitParsed(r, 'INBOX')
    expect(m.subject).toBe(`Re: ${subject}`)
    expect(addrs(m.to).sort()).toEqual([ext.email, other.email].sort())
    expect(addrs(m.cc)).toEqual([ccd.email])
  }
  const env = await envelopesFor(`Re: ${subject}`)
  expect(env).toHaveLength(1)
  expect(env[0].to.map((a) => a.toLowerCase())).not.toContain(user.toLowerCase())
})

test('Forward: "Fwd:", forwarded header and text, original attachments included', async ({ app, mailbox, user }) => {
  const fwd = await newRecipient('fwd')
  const subject = unique('Report')
  const pdf = crypto.randomBytes(20_000)
  await mailbox.seed('INBOX', [{
    from: 'Boss <boss@example.test>', to: user, subject, text: 'Please read the report.',
    attachments: [{ filename: 'report.pdf', content: pdf, contentType: 'application/pdf' }]
  }])
  await app.reload()
  await openMessage(app, subject)
  await app.locator('.message-view').getByRole('button', { name: 'Forward' }).click()
  await expect(app.locator('.modal.compose #compose-subject')).toHaveValue(`Fwd: ${subject}`)
  await waitSeeded(app)
  await expect(app.locator('.attachment-chip').getByText('report.pdf')).toBeVisible()
  await typeRecipients(app, 'to', fwd.email)
  await sendAndClose(app)

  const [m] = await waitParsed(fwd, 'INBOX')
  expect(m.subject).toBe(`Fwd: ${subject}`)
  const text = m.text!.replace(/\r\n/g, '\n')
  expect(text).toContain('---------- Forwarded message ----------')
  expect(text).toContain('From: Boss <boss@example.test>')
  expect(text).toContain('Please read the report.')
  expect(m.inReplyTo).toBeUndefined()
  expect(m.attachments).toHaveLength(1)
  expect(m.attachments[0].filename).toBe('report.pdf')
  expect(m.attachments[0].contentType).toBe('application/pdf')
  expect(sha256(m.attachments[0].content)).toBe(sha256(pdf))
})

test('signature set in Settings is appended to a new mail', async ({ app }) => {
  const rcpt = await newRecipient()
  const subject = unique('Signed')
  await app.locator('.settings-btn').click()
  const settings = app.locator('.settings-modal')
  await settings.getByRole('button', { name: 'Edit' }).first().click()
  await settings.getByText('Append signature to new mail').click()
  await settings.locator('textarea[placeholder^="Best regards"]').fill('Beste Grüße\nLeo 🖋')
  await settings.getByRole('button', { name: 'Update' }).click()
  await expect(settings).toHaveCount(0)

  await openCompose(app)
  await waitSeeded(app)
  await expect(app.locator('#compose-body')).toHaveValue('Beste Grüße\nLeo 🖋')
  await typeRecipients(app, 'to', rcpt.email)
  await app.locator('#compose-subject').fill(subject)
  const ta = app.locator('#compose-body')
  await ta.press('Control+Home')
  await ta.pressSequentially('Body text.\n\n')
  await sendAndClose(app)

  const [m] = await waitParsed(rcpt, 'INBOX')
  expect(m.text!.replace(/\r\n/g, '\n').trimEnd()).toBe('Body text.\n\nBeste Grüße\nLeo 🖋')
})

test('scheduled send: not sent before its time, delivered by the server scheduler after', async ({ app, mailbox }) => {
  test.setTimeout(150_000)
  const rcpt = await newRecipient()
  const subject = unique('Later')
  await openCompose(app)
  await typeRecipients(app, 'to', rcpt.email)
  await fillMessage(app, subject, 'From the future.')
  await app.getByRole('button', { name: 'Schedule send' }).click()
  // The next whole minute at least 20 s away (the picker has minute precision).
  const at = new Date(Date.now() + 20_000)
  at.setSeconds(0, 0)
  at.setMinutes(at.getMinutes() + 1)
  const pad = (n: number) => String(n).padStart(2, '0')
  await app.getByLabel('Schedule date').fill(`${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`)
  await app.getByLabel('Schedule time').fill(`${pad(at.getHours())}:${pad(at.getMinutes())}`)
  await app.locator('.schedule-panel').getByRole('button', { name: 'Schedule', exact: true }).click()
  await expect(app.locator('.schedule-badge')).toBeVisible()
  await sendAndClose(app)

  const res = await app.request.get('/api/scheduled', { headers: { 'x-leoposta-token': TOKEN } })
  const pending = (await res.json()).messages.filter((m: { subject: string }) => m.subject === subject)
  expect(pending).toHaveLength(1)
  expect(pending[0].status).toBe('pending')
  expect(new Date(pending[0].scheduled).getTime()).toBe(at.getTime())

  // Nothing yet ...
  await new Promise((r) => setTimeout(r, 3000))
  expect(await envelopesFor(subject)).toHaveLength(0)
  expect(await rcpt.messages('INBOX')).toHaveLength(0)
  // ... then delivered once its time has come, and copied to Sent.
  const [m] = await waitParsed(rcpt, 'INBOX', 1, at.getTime() - Date.now() + 40_000)
  expect(Date.now()).toBeGreaterThanOrEqual(at.getTime())
  expect(m.subject).toBe(subject)
  expect(m.text?.trim()).toBe('From the future.')
  await mailbox.waitFor('Sent', (msgs) => msgs.find((x) => x.subject === subject))
  expect(await envelopesFor(subject)).toHaveLength(1)
  const after = (await (await app.request.get('/api/scheduled', { headers: { 'x-leoposta-token': TOKEN } })).json())
    .messages.find((x: { subject: string }) => x.subject === subject)
  expect(after.status).toBe('sent')
})

test('send with no recipient: a clear message, nothing sent, the text stays', async ({ app }) => {
  const subject = unique('No rcpt')
  await openCompose(app)
  await fillMessage(app, subject, 'Draft text that must survive.')
  const dialog = app.waitForEvent('dialog')
  await app.locator('.modal.compose').getByRole('button', { name: 'Send', exact: true }).click()
  const d = await dialog
  expect(d.message()).toMatch(/recipient/i)
  await d.dismiss()
  await expect(app.locator('.modal.compose #compose-body')).toHaveValue('Draft text that must survive.')
  expect(await envelopesFor(subject)).toHaveLength(0)
})

test.describe('SMTP failure', () => {
  test.use({ allowApiErrors: ['POST /api/send -> 500'] })
  test('shows the error, keeps the message, and sends once SMTP works again', async ({ app, user, request }) => {
    const rcpt = await newRecipient()
    const subject = unique('Retry')
    const h = { 'x-leoposta-token': TOKEN }
    // A dead SMTP port for this account.
    expect((await request.put(`/api/accounts/${encodeURIComponent(user)}`, { headers: h, data: accountBody(user, { smtpPort: 1 }) })).status()).toBe(200)

    await openCompose(app)
    await typeRecipients(app, 'to', rcpt.email)
    await fillMessage(app, subject, 'Do not lose me.')
    const dialog = app.waitForEvent('dialog')
    await app.locator('.modal.compose').getByRole('button', { name: 'Send', exact: true }).click()
    const d = await dialog
    expect(d.message()).toMatch(/fail|could not|ECONNREFUSED/i)
    await d.dismiss()
    const compose = app.locator('.modal.compose')
    await expect(compose).toBeVisible()
    await expect(compose.locator('#compose-subject')).toHaveValue(subject)
    await expect(compose.locator('#compose-body')).toHaveValue('Do not lose me.')
    await expect(compose.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
    expect(await envelopesFor(subject)).toHaveLength(0)

    expect((await request.put(`/api/accounts/${encodeURIComponent(user)}`, { headers: h, data: accountBody(user) })).status()).toBe(200)
    await sendAndClose(app)
    await waitParsed(rcpt, 'INBOX')
    expect(await envelopesFor(subject)).toHaveLength(1)
  })
})

test('double-clicking Send sends exactly once', async ({ app, mailbox }) => {
  const rcpt = await newRecipient()
  const subject = unique('Once')
  await openCompose(app)
  await typeRecipients(app, 'to', rcpt.email)
  await fillMessage(app, subject, 'Only one copy.')
  await app.locator('.modal.compose').getByRole('button', { name: 'Send', exact: true }).dblclick()
  await expect(app.locator('.modal.compose')).toHaveCount(0, { timeout: 30_000 })
  await waitParsed(rcpt, 'INBOX')
  await mailbox.waitFor('Sent', (m) => m.find((x) => x.subject === subject))
  await new Promise((r) => setTimeout(r, 2000))
  expect(await envelopesFor(subject)).toHaveLength(1)
  expect(await rcpt.messages('INBOX')).toHaveLength(1)
  expect((await mailbox.messages('Sent')).filter((x) => x.subject === subject)).toHaveLength(1)
})

test.describe('offline', () => {
  // Requests the test makes fail on purpose while the browser is offline.
  test.use({ allowApiErrors: [/ERR_INTERNET_DISCONNECTED/, /Failed to fetch/, /Failed to load/] })
  test('compose offline: queued, then sent exactly once when back online', async ({ app, context }) => {
    const rcpt = await newRecipient()
    const subject = unique('Offline')
    await openCompose(app)
    await waitSeeded(app)
    await typeRecipients(app, 'to', rcpt.email)
    await fillMessage(app, subject, 'Written on a train.')
    await context.setOffline(true)
    await app.locator('.modal.compose').getByRole('button', { name: 'Send', exact: true }).click()
    await expect(app.locator('.modal.compose')).toHaveCount(0)
    await expect(app.locator('.queue-badge')).toContainText('1 queued')
    await new Promise((r) => setTimeout(r, 1000))
    expect(await envelopesFor(subject)).toHaveLength(0)

    await context.setOffline(false)
    await expect(app.getByTestId('toast')).toContainText('1 queued message sent')
    const [m] = await waitParsed(rcpt, 'INBOX')
    expect(m.subject).toBe(subject)
    expect(m.text?.trim()).toBe('Written on a train.')
    // A second "online" (flaky network) does not send it again.
    await context.setOffline(true)
    await context.setOffline(false)
    await new Promise((r) => setTimeout(r, 2000))
    expect(await envelopesFor(subject)).toHaveLength(1)
    await expect(app.locator('.queue-badge')).toHaveCount(0)
  })
})
