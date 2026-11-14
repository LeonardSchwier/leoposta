// Contacts (CardDAV) against the stack's Radicale: discovery, list, create /
// edit / delete (checked on the server), .vcf import (3.0 + 4.0, unicode,
// several cards), search, recipient autocomplete in Compose, and the
// not-configured / unreachable states.
import { test, expect, TOKEN, accountBody } from './fixtures'
import { Dav } from './dav'
import type { Page } from '@playwright/test'

const H = { 'x-leoposta-token': TOKEN }

async function openContacts(app: Page) {
  await app.locator('.sidebar').getByRole('button', { name: /Contacts/ }).click()
  await expect(app.locator('.contacts')).toBeVisible()
}

const card = (uid: string, lines: string[], version = '3.0') =>
  ['BEGIN:VCARD', `VERSION:${version}`, `UID:${uid}`, ...lines, 'END:VCARD', ''].join('\r\n')

test.describe('contacts', () => {
  test('discovers address books, lists cards, creates / edits / deletes a contact on the server', async ({ app, user }) => {
    const dav = new Dav(user)
    const book = await dav.mkaddressbook('people', 'People')
    await dav.mkaddressbook('work', 'Work')
    await dav.put(`${book}seed.vcf`, card('seed-1', ['FN:Seeded Person', 'N:Person;Seeded;;;', 'EMAIL:seeded@example.test', 'BDAY:19800101']), 'text/vcard')

    await openContacts(app)
    await expect(app.locator('.c-item', { hasText: 'People' })).toBeVisible()
    await expect(app.locator('.c-item', { hasText: 'Work' })).toBeVisible()
    await app.locator('.c-item', { hasText: 'People' }).click()
    await expect(app.locator('.row .nm', { hasText: 'Seeded Person' })).toBeVisible()

    // Create
    await app.getByRole('button', { name: '+ New contact' }).click()
    await app.getByLabel('Create in').selectOption({ label: 'People' })
    await app.getByLabel('Name').fill('Zoë Example')
    await app.getByLabel('Email').fill('zoe@example.test')
    await app.getByLabel('Phone').fill('+49 30 1234')
    await app.getByLabel('Notes').fill('first line\nsecond line, with comma; and semicolon')
    await app.getByLabel('Street').fill('Hauptstraße 5')
    await app.getByLabel('City').fill('Köln')
    await app.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(app.locator('.row .nm', { hasText: 'Zoë Example' })).toBeVisible()

    let cards = Object.values(await dav.list(book))
    const created = cards.find((c) => c.includes('zoe@example.test'))!
    expect(created, JSON.stringify(cards)).toBeTruthy()
    const unfolded = created.replace(/\r?\n[ \t]/g, '')
    expect(unfolded).toContain('FN:Zoë Example')
    expect(unfolded).toContain('NOTE:first line\\nsecond line\\, with comma\\; and semicolon')
    expect(unfolded).toMatch(/ADR[^:]*:;;Hauptstraße 5;Köln;/)

    // Edit the seeded card: shown fields change, BDAY (not in the editor) survives.
    await app.locator('.row', { hasText: 'Seeded Person' }).click()
    await expect(app.getByLabel('Name')).toHaveValue('Seeded Person')
    await app.getByLabel('Name').fill('Seeded Renamed')
    await app.getByLabel('Organization').fill('ACME')
    await app.getByRole('button', { name: 'Save changes' }).click()
    await expect(app.locator('.row .nm', { hasText: 'Seeded Renamed' })).toBeVisible()
    cards = Object.values(await dav.list(book))
    expect(cards).toHaveLength(2) // edited in place, not duplicated
    const edited = cards.find((c) => c.includes('UID:seed-1'))!
    expect(edited).toContain('FN:Seeded Renamed')
    expect(edited).toContain('ORG:ACME')
    expect(edited).toContain('BDAY:19800101')

    // Delete
    app.once('dialog', (d) => d.accept())
    await app.getByRole('button', { name: 'Delete contact Zoë Example' }).click()
    await expect(app.locator('.row .nm', { hasText: 'Zoë Example' })).toHaveCount(0)
    cards = Object.values(await dav.list(book))
    expect(cards.some((c) => c.includes('zoe@example.test'))).toBe(false)
    expect(cards).toHaveLength(1)
  })

  test('imports a .vcf with several vCard 3.0 / 4.0 cards and unicode; search finds them', async ({ app, user }) => {
    const dav = new Dav(user)
    const book = await dav.mkaddressbook('people', 'People')
    const vcf = [
      card('imp-1', ['FN:Ærøskøbing Ånd', 'EMAIL;TYPE=INTERNET:aero@example.test']),
      card('imp-2', ['FN:Иван Петров', 'EMAIL:ivan@example.test', 'TEL;VALUE=uri:tel:+7-495-1'], '4.0'),
      card('imp-3', ['N:Suzuki;Hanako;;;', 'item1.EMAIL:hanako@example.test', 'ORG:株式会社テスト'])
    ].join('')
    await openContacts(app)
    await app.locator('input[type=file][accept*=".vcf"]').setInputFiles({ name: 'people.vcf', mimeType: 'text/vcard', buffer: Buffer.from(vcf, 'utf8') })
    await expect(app.locator('.toast, [role=status]').filter({ hasText: 'Imported 3 of 3' }).first()).toBeVisible()
    for (const n of ['Ærøskøbing Ånd', 'Иван Петров', 'Hanako Suzuki']) await expect(app.locator('.row .nm', { hasText: n })).toBeVisible()
    expect(Object.keys(await dav.list(book))).toHaveLength(3)

    await app.locator('.contacts input[type=search]').fill('иван')
    await expect(app.locator('.row .nm')).toHaveText(['Иван Петров'])
    await app.locator('.contacts input[type=search]').fill('テスト')
    await expect(app.locator('.row .nm')).toHaveText(['Hanako Suzuki'])
    await app.locator('.contacts input[type=search]').fill('')
    await expect(app.locator('.row .nm')).toHaveCount(3)
  })

  test('recipient autocomplete in Compose suggests contacts from every book and address', async ({ app, user }) => {
    const dav = new Dav(user)
    const a = await dav.mkaddressbook('a', 'A')
    const b = await dav.mkaddressbook('b', 'B')
    await dav.put(`${a}1.vcf`, card('ac-1', ['FN:Jane Doe', 'EMAIL:jane.work@example.test', 'EMAIL:jane.home@example.test']), 'text/vcard')
    await dav.put(`${b}2.vcf`, card('ac-2', ['FN:Bob Builder', 'EMAIL:bob@example.test']), 'text/vcard')
    await app.locator('.compose-btn').click()
    const to = app.locator('#compose-to')
    await to.fill('doe')
    const list = app.getByRole('listbox')
    await expect(list.getByText('jane.work@example.test')).toBeVisible()
    await expect(list.getByText('jane.home@example.test')).toBeVisible()
    await to.fill('bui')
    await expect(list.getByText('bob@example.test')).toBeVisible()
    await to.press('Enter')
    await expect(to).toHaveValue('bob@example.test')
  })

  test('an account without CardDAV shows "not set up" instead of errors', async ({ page, request, baseURL, user, mailbox }) => {
    void mailbox
    const existing = await (await request.get(`${baseURL}/api/accounts`, { headers: H })).json()
    for (const x of existing) await request.delete(`${baseURL}/api/accounts/${encodeURIComponent(x.email)}`, { headers: H })
    expect((await request.post(`${baseURL}/api/accounts`, { headers: H, data: accountBody(user, { davUrl: '' }) })).status()).toBe(200)
    await page.goto('/')
    await openContacts(page)
    await expect(page.getByTestId('dav-not-configured')).toContainText('Contacts are not set up')
    // Compose autocomplete stays quiet too.
    await page.locator('.compose-btn').click()
    await page.locator('#compose-to').fill('someone')
  })

  test.describe('unreachable server', () => {
    test.use({ allowApiErrors: [['/api/contacts/calendars -> 502', /status of 502/], { scope: 'test' }] })
    test('shows a clear message, no crash, and Retry recovers once the URL is fixed', async ({ page, request, baseURL, user, mailbox }) => {
      void mailbox
      const existing = await (await request.get(`${baseURL}/api/accounts`, { headers: H })).json()
      for (const x of existing) await request.delete(`${baseURL}/api/accounts/${encodeURIComponent(x.email)}`, { headers: H })
      expect((await request.post(`${baseURL}/api/accounts`, { headers: H, data: accountBody(user, { davUrl: 'http://127.0.0.1:9/' }) })).status()).toBe(200)
      const dav = new Dav(user)
      await dav.mkaddressbook('people', 'People')

      await page.goto('/')
      await openContacts(page)
      const err = page.locator('.c-err')
      await expect(err).toContainText('Cannot reach the CardDAV server 127.0.0.1:9')
      const good = accountBody(user).davUrl
      expect((await request.put(`${baseURL}/api/accounts/${encodeURIComponent(user)}`, { headers: H, data: { davUrl: good } })).status()).toBe(200)
      await err.getByRole('button', { name: 'Retry' }).click()
      await expect(err).toHaveCount(0)
      await expect(page.locator('.c-item', { hasText: 'People' })).toBeVisible()
    })
  })
})
