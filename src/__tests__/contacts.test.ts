import { describe, it, expect } from 'vitest'
import { createContactsCache, type ContactFetcher, type AddressBook, type Contact } from '../lib/contacts'

const BOOKS: AddressBook[] = [
  { uri: 'dav://host/b1', name: 'Book 1' },
  { uri: 'dav://host/b2', name: 'Book 2' },
]

const CONTACTS_BY_BOOK: Record<string, Contact[]> = {
  'dav://host/b1': [
    { uid: 'u1', name: 'Jane Do', email: 'jane@doe.com', org: 'Corp' },
  ],
  'dav://host/b2': [
    { uid: 'u2', name: 'Bob', email: 'bob@corp.com' },
    { uid: 'u3', name: 'Jani', email: 'jani@example.com' },
    // same uid as u1 -> dedupe by uid
    { uid: 'u1', name: 'Jane Do (dup)', email: 'jane-dup@corp.com' },
    // same email as u1 -> dedupe by email
    { uid: 'u4', name: 'Jane Other', email: 'jane@doe.com' },
  ],
}

function makeFetcher() {
  let calls: { kind: 'books' | 'contacts'; uri?: string }[] = []
  const fetcher: ContactFetcher = {
    async fetchBooks() {
      calls.push({ kind: 'books' })
      return BOOKS
    },
    async fetchContacts(uri) {
      calls.push({ kind: 'contacts', uri })
      return CONTACTS_BY_BOOK[uri] ?? []
    },
  }
  return { fetcher, calls }
}

describe('createContactsCache', () => {
  it('loadBooks populates addressBooks from the fetcher', async () => {
    const { fetcher } = makeFetcher()
    const cache = createContactsCache({ fetcher })
    expect(cache.addressBooks).toEqual([])
    await cache.loadBooks()
    expect(cache.addressBooks).toEqual(BOOKS)
  })

  it('loadContacts caches by uri: second call does not re-invoke fetchContacts', async () => {
    const { fetcher, calls } = makeFetcher()
    const cache = createContactsCache({ fetcher })
    const first = await cache.loadContacts('dav://host/b1')
    const second = await cache.loadContacts('dav://host/b1')
    expect(second).toEqual(first)
    expect(calls.filter((c) => c.kind === 'contacts' && c.uri === 'dav://host/b1')).toHaveLength(1)
  })

  it('concurrent first calls to the same uri share a single fetch', async () => {
    const { fetcher, calls } = makeFetcher()
    const cache = createContactsCache({ fetcher })
    const [a, b] = await Promise.all([
      cache.loadContacts('dav://host/b2'),
      cache.loadContacts('dav://host/b2'),
    ])
    expect(a).toEqual(b)
    expect(calls.filter((c) => c.kind === 'contacts' && c.uri === 'dav://host/b2')).toHaveLength(1)
  })

  it('allContacts is the deduped union across books (by uid OR email)', async () => {
    const { fetcher } = makeFetcher()
    const cache = createContactsCache({ fetcher })
    await cache.loadBooks()
    await Promise.all(BOOKS.map((b) => cache.loadContacts(b.uri)))
    const all = cache.allContacts()
    expect(all).toHaveLength(3) // b1+raw = [u1, u2, u3, u1dup, u4]; u1dup deduped by uid, u4 deduped by email(u1)
    expect(all.filter((c) => c.email === 'jane@doe.com')).toHaveLength(1)
    expect(all.filter((c) => c.uid === 'u1')).toHaveLength(1)
  })

  it("matches('jane') is case-insensitive: name starts with / email contains / org contains", async () => {
    const { fetcher } = makeFetcher()
    const cache = createContactsCache({ fetcher })
    await cache.loadBooks()
    await Promise.all(BOOKS.map((b) => cache.loadContacts(b.uri)))

    // 'jane': name starts with 'jane' -> Jane Do; email contains 'jane' -> Jane Do (dup) but deduped
    const m = cache.matches('jane')
    expect(m).toHaveLength(1)
    expect(m[0].uid).toBe('u1')
    expect(m[0].name).toBe('Jane Do')

    // case-insensitive: 'JANE' matches the same
    expect(cache.matches('JANE').map((c) => c.uid)).toEqual(['u1'])

    // org-contains: 'corp' matches Jane Do (org=Corp) and Bob (email corp, not name/org; org undefined)
    // only Jane Do has org 'Corp'
    const byOrg = cache.matches('corp')
    expect(byOrg.map((c) => c.uid)).toContain('u1')

    // name-contains for a non-prefix: 'ani' matches Jani (name starts with 'jani' — not 'ani')
    // but 'ani' is contained in 'jani' email; spec says name starts with or email contains or org contains
    // so 'ani' also matches via 'jani@example.com'
    const byEmailContain = cache.matches('ani')
    expect(byEmailContain.map((c) => c.uid)).toContain('u3')
  })

  it("matches('', 8) returns no contacts — empty query is a no-op", async () => {
    const { fetcher } = makeFetcher()
    const cache = createContactsCache({ fetcher })
    await cache.loadBooks()
    await Promise.all(BOOKS.map((b) => cache.loadContacts(b.uri)))
    expect(cache.matches('', 8)).toEqual([])
    expect(cache.matches('   ')).toEqual([])
  })

  it("matches('a', 2) caps result at limit (default 8)", async () => {
    const { fetcher } = makeFetcher()
    const cache = createContactsCache({ fetcher })
    await cache.loadBooks()
    await Promise.all(BOOKS.map((b) => cache.loadContacts(b.uri)))
    const all = cache.allContacts()
    const matchesAll = cache.matches('a')
    expect(matchesAll.length).toBeLessThanOrEqual(8)
    const limited = cache.matches('a', 2)
    expect(limited.length).toBeLessThanOrEqual(2)
    expect(matchesAll.length).toBeGreaterThanOrEqual(limited.length)
  })
})
