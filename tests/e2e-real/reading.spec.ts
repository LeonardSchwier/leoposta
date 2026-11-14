// Reading and rendering messages against the real Dovecot: the list rows, the
// reading pane for every common MIME shape, attachments, \Seen on open, and
// the races of switching messages quickly.
import { test, expect, mbox, type Mailbox } from './fixtures'
import { appendRaw, openMessage, rawMessage, row } from './helpers-reading'

const DAY = 24 * 60 * 60 * 1000

test.describe('message list rows', () => {
  test('sender, subject, unread, starred and attachment indicators', async ({ mailbox, user, app }) => {
    await mailbox.seed('INBOX', [
      { from: 'Alice Example <alice@example.test>', subject: 'Unread plain', text: 'First line of the preview.\nSecond line.' },
      { from: 'bob@example.test', subject: 'Read and starred', text: 'x', flags: ['\\Seen', '\\Flagged'] },
      {
        from: 'Carol <carol@example.test>', subject: 'Has a file', text: 'see file',
        attachments: [{ filename: 'report.pdf', content: Buffer.from('%PDF-1.4 tiny'), contentType: 'application/pdf' }]
      }
    ])
    void user
    await app.reload()

    const unread = row(app, 'Unread plain')
    await expect(unread.locator('.sender-name')).toHaveText('Alice Example')
    await expect(unread).toHaveClass(/unread/)
    await expect(unread.locator('.message-preview')).toContainText('First line of the preview.')

    const starred = row(app, 'Read and starred')
    await expect(starred.locator('.sender-name')).toHaveText('bob@example.test')
    await expect(starred).not.toHaveClass(/unread/)
    await expect(starred.getByRole('button', { name: 'Unstar' })).toHaveAttribute('aria-pressed', 'true')

    const withFile = row(app, 'Has a file')
    await expect(withFile.getByLabel('Has attachments')).toBeVisible()
    await expect(unread.getByLabel('Has attachments')).toHaveCount(0)
  })

  test('missing subject, missing From, very long subject', async ({ mailbox, user, app }) => {
    const long = 'Long subject ' + 'word '.repeat(80) + 'END'
    await appendRaw(mailbox, 'INBOX', [
      rawMessage({ self: user, from: null, subject: 'No sender here', body: 'nobody sent this' }),
      rawMessage({ self: user, from: 'Dora <dora@example.test>', body: 'no subject line at all' }),
      rawMessage({ self: user, subject: long, body: 'long' })
    ])
    await app.reload()
    await expect(row(app, 'No sender here').locator('.sender-name')).not.toHaveText('')
    const noSubject = row(app, 'Dora')
    await expect(noSubject.locator('.message-subject')).toHaveText(/no subject/i)
    const longRow = row(app, 'Long subject')
    // The row keeps its fixed height (the list is virtualised) and truncates.
    const box = await longRow.boundingBox()
    expect(box?.height).toBeLessThanOrEqual(80)
    const content = await openMessage(app, 'Long subject', { reload: false })
    await expect(app.locator('.message-subject').last()).toContainText('END')
    void content
  })

  test('RFC 2047 encoded subjects and names (B, Q, ISO-8859-1, emoji)', async ({ mailbox, user, app }) => {
    await appendRaw(mailbox, 'INBOX', [
      rawMessage({
        self: user,
        from: '=?UTF-8?B?SsO8cmdlbiBNw7xsbGVy?= <juergen@example.test>',
        subject: '=?UTF-8?B?R3LDvMOfZSBhdXMgS8O2bG4g8J+Ojw==?=',
        body: 'b'
      }),
      rawMessage({
        self: user,
        from: '=?ISO-8859-1?Q?Fran=E7ois_B=E9rard?= <fb@example.test>',
        subject: '=?ISO-8859-1?Q?Caf=E9_cr=E8me?= und =?UTF-8?Q?=C3=84pfel?=',
        body: 'q'
      })
    ])
    await app.reload()
    await expect(row(app, 'Grüße aus Köln 🎏').locator('.sender-name')).toHaveText('Jürgen Müller')
    await expect(row(app, 'Café crème und Äpfel').locator('.sender-name')).toHaveText('François Bérard')
    await openMessage(app, 'Café crème', { reload: false })
    await expect(app.locator('.message-view .message-subject')).toHaveText('Café crème und Äpfel')
  })

  test('dates: today shows a time, yesterday says Yesterday, older shows the date', async ({ mailbox, app }) => {
    const now = new Date()
    const todayEarly = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 5)
    const yesterdayLate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 23, 55)
    const old = new Date(now.getTime() - 40 * DAY)
    await mailbox.seed('INBOX', [
      { subject: 'Dated today', text: 't', date: todayEarly },
      { subject: 'Dated yesterday', text: 'y', date: yesterdayLate },
      { subject: 'Dated old', text: 'o', date: old }
    ])
    await app.reload()
    await expect(row(app, 'Dated today').locator('.message-date')).toHaveText(/\d{1,2}:\d{2}/)
    await expect(row(app, 'Dated yesterday').locator('.message-date')).toHaveText('Yesterday')
    const oldText = old.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    await expect(row(app, 'Dated old').locator('.message-date')).toHaveText(oldText)
  })

  test('a date in another timezone is shown in local time', async ({ mailbox, user, app }) => {
    // 23:30 at -0800 is 07:30 UTC the next day.
    await appendRaw(mailbox, 'INBOX', [
      rawMessage({ self: user, subject: 'Pacific time', body: 'tz', headers: [] })
        .toString('utf8')
        .replace(/^Date: .*$/m, 'Date: Mon, 2 Mar 2026 23:30:00 -0800')
    ].map((s) => Buffer.from(s, 'utf8')))
    await app.reload()
    await openMessage(app, 'Pacific time', { reload: false })
    const expected = new Date('2026-03-03T07:30:00Z').toLocaleString()
    await expect(app.locator('.message-view .date')).toHaveText(expected)
  })
})

test.describe('reading pane', () => {
  test('plain text keeps line breaks and links URLs safely', async ({ mailbox, app }) => {
    await mailbox.seed('INBOX', [{ subject: 'Plain lines', text: 'Line one\nLine two\n\n  indented\nVisit https://example.org/path?a=1&b=2 now.' }])
    const content = await openMessage(app, 'Plain lines')
    const body = content.locator('.plain-body')
    await expect(body).toContainText('Line one')
    const text = await body.innerText()
    expect(text).toMatch(/Line one\nLine two\n\n {2}indented/)
    const link = body.getByRole('link', { name: 'https://example.org/path?a=1&b=2' })
    await expect(link).toHaveAttribute('href', 'https://example.org/path?a=1&b=2')
    await expect(link).toHaveAttribute('target', '_blank')
    await expect(link).toHaveAttribute('rel', /noopener/)
  })

  test('multipart/alternative shows the HTML part', async ({ mailbox, app }) => {
    await mailbox.seed('INBOX', [{ subject: 'Alt mail', text: 'PLAIN VERSION', html: '<p><b>HTML</b> version</p>' }])
    const content = await openMessage(app, 'Alt mail')
    await expect(content.locator('b', { hasText: 'HTML' })).toBeVisible()
    await expect(content).not.toContainText('PLAIN VERSION')
  })

  test('quoted-printable and base64 bodies, ISO-8859-1 and windows-1252', async ({ mailbox, user, app }) => {
    await appendRaw(mailbox, 'INBOX', [
      rawMessage({
        self: user, subject: 'QP latin1',
        headers: ['Content-Type: text/plain; charset=ISO-8859-1', 'Content-Transfer-Encoding: quoted-printable'],
        body: 'Gr=FC=DFe aus M=FCnchen, sch=F6n soft=\nbreak.\n'
      }),
      rawMessage({
        self: user, subject: 'B64 utf8',
        headers: ['Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64'],
        body: Buffer.from('<p>Base64 HTML: Ünïcödé ✓</p>').toString('base64') + '\r\n'
      }),
      rawMessage({
        self: user, subject: 'Win1252',
        headers: ['Content-Type: text/plain; charset=windows-1252', 'Content-Transfer-Encoding: 8bit'],
        body: Buffer.from([0x22, 0x93, 0x51, 0x75, 0x6f, 0x74, 0x65, 0x94, 0x20, 0x80, 0x35, 0x20, 0x96, 0x20, 0x65, 0x6e, 0x64, 0x0d, 0x0a])
      }),
      rawMessage({
        self: user, subject: 'Latin1 8bit',
        headers: ['Content-Type: text/plain; charset=iso-8859-1', 'Content-Transfer-Encoding: 8bit'],
        body: Buffer.from([0x4b, 0xf6, 0x6c, 0x6e, 0x20, 0xe4, 0xf6, 0xfc, 0xdf, 0x0d, 0x0a])
      })
    ])
    let content = await openMessage(app, 'QP latin1')
    await expect(content).toContainText('Grüße aus München, schön softbreak.')
    content = await openMessage(app, 'B64 utf8', { reload: false })
    await expect(content).toContainText('Base64 HTML: Ünïcödé ✓')
    content = await openMessage(app, 'Win1252', { reload: false })
    await expect(content).toContainText('"“Quote” €5 – end')
    content = await openMessage(app, 'Latin1 8bit', { reload: false })
    await expect(content).toContainText('Köln äöüß')
  })

  test('a 1.5 MB HTML mail renders without hanging', async ({ mailbox, app }) => {
    const para = '<p>Lorem ipsum dolor sit amet, <b>consectetur</b> adipiscing elit. 0123456789</p>\n'
    const html = '<div>START OF BIG</div>' + para.repeat(Math.ceil(1_500_000 / para.length)) + '<div>END OF BIG</div>'
    await mailbox.seed('INBOX', [{ subject: 'Big HTML', html }])
    const t0 = Date.now()
    const content = await openMessage(app, 'Big HTML')
    await expect(content.getByText('END OF BIG')).toBeAttached({ timeout: 20_000 })
    expect(Date.now() - t0).toBeLessThan(20_000)
    // The app stays responsive afterwards.
    await app.getByRole('button', { name: 'Back to message list' }).click()
    await expect(app.locator('.message-view')).toHaveCount(0)
  })

  test('inline CID images display and are not listed as downloads', async ({ mailbox, app }) => {
    // 1x1 red PNG
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64')
    await mailbox.seed('INBOX', [{
      subject: 'Inline image',
      html: '<p>Logo: <img alt="logo" src="cid:logo@x" width="20" height="20"></p>',
      attachments: [{ filename: 'logo.png', content: png, contentType: 'image/png', cid: 'logo@x' }]
    }])
    const content = await openMessage(app, 'Inline image')
    const img = content.locator('img[alt="logo"]')
    await expect(img).toBeVisible()
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(1)
    await expect(app.locator('.attachments')).toHaveCount(0)
  })

  test('remote images are blocked until the user loads them', async ({ mailbox, app }) => {
    let remoteHits = 0
    await app.route('https://images.example.test/**', (r) => { remoteHits++; return r.fulfill({ status: 204 }) })
    await mailbox.seed('INBOX', [{ subject: 'Remote pic', html: '<p>pic <img alt="remote" src="https://images.example.test/a.png"></p>' }])
    const content = await openMessage(app, 'Remote pic')
    await expect(app.getByText('Remote images blocked')).toBeVisible()
    await expect(content.locator('img[alt="remote"]')).not.toHaveAttribute('src', /./)
    expect(remoteHits).toBe(0)
    await app.getByRole('button', { name: 'Load images' }).click()
    await expect(content.locator('img[alt="remote"]')).toHaveAttribute('src', 'https://images.example.test/a.png')
    await expect.poll(() => remoteHits).toBeGreaterThan(0)
  })
})

test.describe('attachments', () => {
  test('list names and sizes; download returns the exact bytes and name', async ({ mailbox, user, app }) => {
    const bin = Buffer.alloc(3000)
    for (let i = 0; i < bin.length; i++) bin[i] = (i * 7) & 0xff
    // RFC 2231 encoded unicode filename, hand-written.
    const boundary = 'b1'
    const src = rawMessage({
      self: user, subject: 'Files',
      headers: [`Content-Type: multipart/mixed; boundary="${boundary}"`],
      body: Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: text/plain\r\n\r\nSee files.\r\n`),
        Buffer.from(`--${boundary}\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename*=UTF-8''%C3%9Cbersicht%20%E2%82%AC%202026.bin\r\nContent-Transfer-Encoding: base64\r\n\r\n`),
        Buffer.from(bin.toString('base64').replace(/(.{76})/g, '$1\r\n') + '\r\n'),
        Buffer.from(`--${boundary}\r\nContent-Type: text/plain; name="empty.txt"\r\nContent-Disposition: attachment; filename="empty.txt"\r\n\r\n\r\n`),
        Buffer.from(`--${boundary}--\r\n`)
      ])
    })
    await appendRaw(mailbox, 'INBOX', [src])
    await openMessage(app, 'Files')
    const items = app.locator('.attachment-item')
    await expect(items).toHaveCount(2)
    await expect(items.nth(0).locator('.att-name')).toHaveText('Übersicht € 2026.bin')
    await expect(items.nth(0).locator('.att-size')).toHaveText('2.9 KB')
    await expect(items.nth(1).locator('.att-name')).toHaveText('empty.txt')
    await expect(items.nth(1).locator('.att-size')).toHaveText('0 B')

    const [dl] = await Promise.all([app.waitForEvent('download'), items.nth(0).click()])
    expect(dl.suggestedFilename()).toBe('Übersicht € 2026.bin')
    const got = await new Promise<Buffer>((resolve, reject) => {
      dl.createReadStream().then((s) => {
        const chunks: Buffer[] = []
        s.on('data', (c: Buffer) => chunks.push(c)); s.on('end', () => resolve(Buffer.concat(chunks))); s.on('error', reject)
      }, reject)
    })
    expect(got.equals(bin)).toBe(true)

    const [dl2] = await Promise.all([app.waitForEvent('download'), items.nth(1).click()])
    expect(dl2.suggestedFilename()).toBe('empty.txt')
  })

  test('a mail with many attachments lists them all', async ({ mailbox, app }) => {
    const attachments = Array.from({ length: 25 }, (_, i) => ({ filename: `file-${String(i + 1).padStart(2, '0')}.txt`, content: `content ${i}` }))
    await mailbox.seed('INBOX', [{ subject: 'Many files', text: 'lots', attachments }])
    await openMessage(app, 'Many files')
    await expect(app.locator('.attachment-item')).toHaveCount(25)
    await expect(app.getByText('25 Attachments')).toBeVisible()
    const last = app.locator('.attachment-item').last()
    await last.scrollIntoViewIfNeeded()
    await expect(last).toBeInViewport()
  })

  test('forwarded-as-attachment message/rfc822 is listed and the outer body shows', async ({ mailbox, user, app }) => {
    const inner = rawMessage({ self: user, subject: 'Inner original', body: 'inner body text' })
    const src = rawMessage({
      self: user, subject: 'Fwd as attachment',
      headers: ['Content-Type: multipart/mixed; boundary="fw"'],
      body: Buffer.concat([
        Buffer.from('--fw\r\nContent-Type: text/plain\r\n\r\nOuter text here.\r\n--fw\r\nContent-Type: message/rfc822\r\nContent-Disposition: attachment; filename="original.eml"\r\n\r\n'),
        inner,
        Buffer.from('\r\n--fw--\r\n')
      ])
    })
    await appendRaw(mailbox, 'INBOX', [src])
    const content = await openMessage(app, 'Fwd as attachment')
    await expect(content).toContainText('Outer text here.')
    await expect(app.locator('.attachment-item .att-name')).toHaveText(['original.eml'])
    const [dl] = await Promise.all([app.waitForEvent('download'), app.locator('.attachment-item').click()])
    expect(dl.suggestedFilename()).toBe('original.eml')
  })
})

test.describe('state on the server', () => {
  test('opening an unread message sets \\Seen on the server and keeps the body shown', async ({ mailbox, app }) => {
    await mailbox.seed('INBOX', [{ subject: 'Mark me read', text: 'Body that must stay visible.' }])
    const content = await openMessage(app, 'Mark me read')
    await expect(content).toContainText('Body that must stay visible.')
    await mailbox.waitFor('INBOX', (m) => m.find((x) => x.subject === 'Mark me read')?.flags.includes('\\Seen'))
    // The IDLE refresh that follows the flag change must not wipe the open body.
    await app.waitForTimeout(2500)
    await expect(content).toContainText('Body that must stay visible.')
    await expect(row(app, 'Mark me read')).not.toHaveClass(/unread/)
  })
})

test.describe('a message deleted elsewhere', () => {
  // The 404 for the vanished message is the expected answer, not a failure
  // (Chromium also logs every 4xx response as a console error).
  test.use({ allowApiErrors: [/GET \/api\/message\/\d+\?folder=INBOX -> 404 .*message_not_found/, /Failed to load resource: .*status of 404/] })

  async function deleteOnServer(mailbox: Mailbox, subject: string) {
    await mailbox.with(async (c) => {
      const lock = await c.getMailboxLock(mbox('INBOX'))
      try {
        const uids = await c.search({ subject }, { uid: true })
        await c.messageDelete(uids as number[], { uid: true })
      } finally { lock.release() }
    })
  }

  test('clicking a row whose message was deleted on the server says so', async ({ mailbox, app }) => {
    // No refresh, so the list still shows the stale row.
    await app.evaluate(() => localStorage.setItem('leoposta:refreshInterval', 'off'))
    await mailbox.seed('INBOX', [{ subject: 'Vanishing', text: 'here now' }, { subject: 'Gone already', text: 'gone' }])
    await app.reload()
    await expect(row(app, 'Gone already')).toBeVisible()
    await deleteOnServer(mailbox, 'Gone already')
    await row(app, 'Gone already').click({ position: { x: 60, y: 30 } })
    await expect(app.locator('.message-view')).toContainText(/no longer on the server/i)
    // Another message still opens fine afterwards (the IMAP connection survived).
    const content = await openMessage(app, 'Vanishing', { reload: false })
    await expect(content).toContainText('here now')
  })

  test('the open message deleted on the server leaves a clear pane, not a blank one', async ({ mailbox, app }) => {
    await mailbox.seed('INBOX', [{ subject: 'Open then gone', text: 'about to vanish' }, { subject: 'Stays', text: 'still here' }])
    const content = await openMessage(app, 'Open then gone')
    await expect(content).toContainText('about to vanish')
    await deleteOnServer(mailbox, 'Open then gone')
    // IDLE refreshes the list: the row goes away and the pane says why.
    await expect(row(app, 'Open then gone')).toHaveCount(0)
    await expect(app.getByText(/no longer in this folder/i)).toBeVisible()
    await expect(row(app, 'Stays')).toBeVisible()
  })
})

test.describe('switching messages', () => {
  test('rapid switching never shows another message\'s body', async ({ mailbox, app }) => {
    const msgs = Array.from({ length: 8 }, (_, i) => ({ subject: `Quick ${i}`, text: `Body number ${i} unique`, date: new Date(Date.now() - i * 60_000) }))
    await mailbox.seed('INBOX', msgs)
    await app.reload()
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < 8; i++) await row(app, `Quick ${i}`).click({ position: { x: 60, y: 30 } })
    }
    await row(app, 'Quick 3').click({ position: { x: 60, y: 30 } })
    const content = app.locator('.message-view .message-content')
    await expect(content).toContainText('Body number 3 unique')
    await app.waitForTimeout(1500)
    await expect(app.locator('.message-view .message-subject')).toHaveText('Quick 3')
    await expect(content).toHaveText(/Body number 3 unique/)
  })

  test('a slow response from another folder does not land on a message with the same UID', async ({ mailbox, app }) => {
    await mailbox.seed('INBOX', [{ subject: 'Inbox uid one', text: 'INBOX BODY' }])
    await mailbox.createFolder('Archive')
    await mailbox.seed('Archive', [{ subject: 'Archive uid one', text: 'ARCHIVE BODY' }])
    await app.reload()
    // Hold the INBOX body until the Archive message is open.
    let release: () => void = () => {}
    const held = new Promise<void>((r) => { release = r })
    await app.route(/\/api\/message\/1\?folder=INBOX/, async (route) => { await held; await route.continue() })
    await row(app, 'Inbox uid one').click({ position: { x: 60, y: 30 } })
    await app.locator('.sidebar').getByText('Archive', { exact: true }).first().click()
    await openMessage(app, 'Archive uid one', { reload: false })
    release()
    await app.waitForTimeout(1500)
    await expect(app.locator('.message-view .message-content')).toContainText('ARCHIVE BODY')
    await expect(app.locator('.message-view .message-content')).not.toContainText('INBOX BODY')
  })
})

test.describe('malformed and special messages', () => {
  test('no Content-Type at all is read as plain text', async ({ mailbox, user, app }) => {
    const src = Buffer.from(`From: a@example.test\r\nTo: ${user}\r\nSubject: No type header\r\nDate: ${new Date().toUTCString()}\r\n\r\nJust <b>text</b> here.\r\n`)
    await appendRaw(mailbox, 'INBOX', [src])
    const content = await openMessage(app, 'No type header')
    await expect(content.locator('.plain-body')).toHaveText(/Just <b>text<\/b> here\./)
  })

  test('a broken MIME boundary still shows the text that is there', async ({ mailbox, user, app }) => {
    await appendRaw(mailbox, 'INBOX', [rawMessage({
      self: user, subject: 'Broken boundary',
      headers: ['Content-Type: multipart/mixed; boundary="declared"'],
      body: '--other\r\nContent-Type: text/plain\r\n\r\nVisible despite the wrong boundary.\r\n--other--\r\n'
    }), rawMessage({
      self: user, subject: 'Unterminated multipart',
      headers: ['Content-Type: multipart/alternative; boundary="b"'],
      body: '--b\r\nContent-Type: text/plain\r\n\r\nFirst part, no closing boundary.\r\n'
    })])
    let content = await openMessage(app, 'Broken boundary')
    await expect(content).toContainText('Visible despite the wrong boundary.')
    content = await openMessage(app, 'Unterminated multipart', { reload: false })
    await expect(content).toContainText('First part, no closing boundary.')
  })

  test('an S/MIME encrypted message explains that it cannot be shown', async ({ mailbox, user, app }) => {
    await appendRaw(mailbox, 'INBOX', [rawMessage({
      self: user, subject: 'SMIME secret',
      headers: ['Content-Type: application/pkcs7-mime; smime-type=enveloped-data; name="smime.p7m"', 'Content-Transfer-Encoding: base64', 'Content-Disposition: attachment; filename="smime.p7m"'],
      body: Buffer.from('not really cms data').toString('base64') + '\r\n'
    })])
    await openMessage(app, 'SMIME secret')
    await expect(app.locator('.message-view .message-content')).toContainText(/S\/MIME/)
  })

  test('a PGP/MIME encrypted message shows the PGP banner, not an empty pane', async ({ mailbox, user, app }) => {
    const armor = '-----BEGIN PGP MESSAGE-----\r\n\r\nhQEMA1234567890ABAQf/not-a-real-message\r\n=abcd\r\n-----END PGP MESSAGE-----\r\n'
    await appendRaw(mailbox, 'INBOX', [rawMessage({
      self: user, subject: 'PGP secret',
      headers: ['Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="pgp"'],
      body: `--pgp\r\nContent-Type: application/pgp-encrypted\r\n\r\nVersion: 1\r\n--pgp\r\nContent-Type: application/octet-stream; name="encrypted.asc"\r\n\r\n${armor}--pgp--\r\n`
    })])
    await openMessage(app, 'PGP secret')
    await expect(app.locator('.pgp-banner')).toContainText(/Encrypted message/)
  })

  test('a calendar invite shows its text and offers the .ics', async ({ mailbox, user, app }) => {
    const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'METHOD:REQUEST', 'BEGIN:VEVENT', 'UID:e1@example.test', 'DTSTART:20261201T100000Z', 'DTEND:20261201T110000Z', 'SUMMARY:Planning', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n')
    await appendRaw(mailbox, 'INBOX', [rawMessage({
      self: user, subject: 'Invite: Planning',
      headers: ['Content-Type: multipart/mixed; boundary="c"'],
      body: `--c\r\nContent-Type: multipart/alternative; boundary="a"\r\n\r\n--a\r\nContent-Type: text/plain\r\n\r\nYou are invited to Planning.\r\n--a\r\nContent-Type: text/calendar; method=REQUEST; charset=UTF-8\r\n\r\n${ics}--a--\r\n--c\r\nContent-Type: application/ics; name="invite.ics"\r\nContent-Disposition: attachment; filename="invite.ics"\r\n\r\n${ics}--c--\r\n`
    })])
    const content = await openMessage(app, 'Invite: Planning')
    await expect(content).toContainText('You are invited to Planning.')
    await expect(content).not.toContainText('BEGIN:VCALENDAR')
    await expect(app.locator('.attachment-item .att-name').filter({ hasText: 'invite.ics' })).toBeVisible()
  })
})
