export interface AddressBook {
  uri: string
  name: string
}

export interface Contact {
  uid: string
  name: string
  email: string
  /** Every address of the card (the server sends them all; `email` is the first). */
  emails?: string[]
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

// Entry -> the card it came from (perAddress makes one entry per address).
const sourceCard = new WeakMap<Contact, Contact>()

function dedupe(contacts: Contact[]): Contact[] {
  // One entry per address. A UID already taken by another card (the same
  // contact copied into a second address book) is skipped; the further
  // addresses of one card are all kept.
  const cardOfUid = new Map<string, Contact>()
  const seenEmail = new Set<string>()
  const out: Contact[] = []
  for (const c of contacts) {
    const card = sourceCard.get(c) ?? c
    const emailKey = c.email.toLowerCase()
    if (!emailKey || seenEmail.has(emailKey)) continue
    if (c.uid && cardOfUid.has(c.uid) && cardOfUid.get(c.uid) !== card) continue
    if (c.uid) cardOfUid.set(c.uid, card)
    seenEmail.add(emailKey)
    out.push(c)
  }
  return out
}

function matchesContact(c: Contact, q: string): boolean {
  const name = (c.name || '').toLowerCase()
  const email = c.email.toLowerCase()
  const org = (c.org ?? '').toLowerCase()
  // Any word of the name: "doe" finds "Jane Doe".
  return name.startsWith(q) || name.split(/[\s,.-]+/).some((w) => w.startsWith(q)) || email.includes(q) || org.includes(q)
}

/** One suggestion per address; a card without any address is not a recipient. */
function perAddress(cs: Contact[]): Contact[] {
  const out: Contact[] = []
  for (const c of cs) {
    const all = (c.emails && c.emails.length ? c.emails : [c.email]).map((e) => (e || '').trim()).filter(Boolean)
    for (const e of all) {
      const entry = { ...c, email: e }
      sourceCard.set(entry, c)
      out.push(entry)
    }
  }
  return out
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
        loaded.push(...perAddress(cs ?? []))
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
