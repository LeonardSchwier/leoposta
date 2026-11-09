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

export interface ContactsFetcher {
  fetchBooks(): Promise<AddressBook[]>
  fetchContacts(uri: string): Promise<Contact[]>
}

// Backwards-compat alias so existing imports keep working.
export type ContactFetcher = ContactsFetcher

export interface ContactsCache {
  addressBooks: AddressBook[]
  loadBooks(): Promise<void>
  loadContacts(uri: string): Promise<Contact[]>
  allContacts(): Contact[]
  matches(query: string, limit?: number): Contact[]
}

export interface ContactsCacheOptions {
  fetcher: ContactsFetcher
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

  async function loadBooks(): Promise<void> {
    if (!booksPromise) {
      booksPromise = fetcher
        .fetchBooks()
        .then((books) => {
          for (const b of books) addressBooks.push(b)
        })
        .catch((err) => {
          booksPromise = null
          throw err
        })
    }
    await booksPromise
  }

  function loadContacts(uri: string): Promise<Contact[]> {
    const existing = inFlight.get(uri)
    if (existing) return existing
    const p = fetcher
      .fetchContacts(uri)
      .then((cs) => {
        loaded.push(...(cs ?? []))
        return cs ?? []
      })
      .catch((err) => {
        inFlight.delete(uri)
        throw err
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
