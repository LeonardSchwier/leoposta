export interface AddressBook {
  uri: string
  name: string
}

export interface Contact {
  uid: string
  name: string
  email: string
  org?: string
}

export interface ContactFetcher {
  fetchBooks(): Promise<AddressBook[]>
  fetchContacts(uri: string): Promise<Contact[]>
}

export interface ContactsCache {
  addressBooks: AddressBook[]
  loadBooks(): Promise<void>
  loadContacts(uri: string): Promise<Contact[]>
  allContacts(): Contact[]
  matches(query: string, limit?: number): Contact[]
}

export interface ContactsCacheOptions {
  fetcher: ContactFetcher
}

const DEFAULT_LIMIT = 8

function dedupe(contacts: Contact[]): Contact[] {
  const seenUid = new Set<string>()
  const seenEmail = new Set<string>()
  const out: Contact[] = []
  for (const c of contacts) {
    const emailKey = c.email.toLowerCase()
    if (c.uid && seenUid.has(c.uid)) continue
    if (emailKey && seenEmail.has(emailKey)) continue
    if (c.uid) seenUid.add(c.uid)
    if (emailKey) seenEmail.add(emailKey)
    out.push(c)
  }
  return out
}

function matchesContact(c: Contact, q: string): boolean {
  const name = c.name.toLowerCase()
  const email = c.email.toLowerCase()
  const org = (c.org ?? '').toLowerCase()
  return name.startsWith(q) || email.includes(q) || org.includes(q)
}

export function createContactsCache({ fetcher }: ContactsCacheOptions): ContactsCache {
  const addressBooks: AddressBook[] = []
  const inFlight: Map<string, Promise<Contact[]>> = new Map()
  const loaded: Contact[] = []
  let booksPromise: Promise<void> | null = null

  function addContacts(cs: Contact[]): void {
    loaded.push(...cs)
  }

  async function loadBooks(): Promise<void> {
    if (!booksPromise) {
      booksPromise = fetcher.fetchBooks().then((books) => {
        for (const b of books) addressBooks.push(b)
      })
    }
    await booksPromise
  }

  function loadContacts(uri: string): Promise<Contact[]> {
    const existing = inFlight.get(uri)
    if (existing) return existing
    const p = fetcher.fetchContacts(uri).then((cs) => {
      addContacts(cs ?? [])
      return cs ?? []
    })
    inFlight.set(uri, p)
    return p
  }

  function allContacts(): Contact[] {
    return dedupe(loaded)
  }

  function matches(query: string, limit: number = DEFAULT_LIMIT): Contact[] {
    const q = query.trim().toLowerCase()
    if (!q) return []
    return allContacts()
      .filter((c) => matchesContact(c, q))
      .slice(0, limit)
  }

  return {
    get addressBooks() {
      return addressBooks
    },
    loadBooks,
    loadContacts,
    allContacts,
    matches,
  }
}
