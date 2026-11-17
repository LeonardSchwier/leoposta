// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { indexedDB as fakeIndexedDB } from 'fake-indexeddb'
import { accountHeaderValue, accountHeaders } from '../lib/accountHeader'
import { apiFetch, setActiveAccountEmail } from '../api'
import { addQueuedMessage, flushQueue } from '../lib/offlineQueue'
import { pgpStatus } from '../lib/pgp'

// Every API call names its account in the `x-account` header. A header value is a
// ByteString: a character above U+00FF (Cyrillic, CJK, Polish ł, ...) made
// `new Headers().set(...)` throw, so with such an account active no request could
// be made at all, not even the one that removes the account.
const CYRILLIC = 'erika@пример.test'
const POLISH = 'łukasz@example.test'
const LATIN1 = 'jörg@example.test'
const PLAIN = 'erika@example.test'

const isAscii = (s: string) => /^[\x20-\x7e]*$/.test(s)
const decoded = (value: string) => decodeURIComponent(value.slice('u8:'.length))

describe('accountHeaderValue', () => {
  it('leaves a printable ASCII address exactly as it is', () => {
    expect(accountHeaderValue(PLAIN)).toBe(PLAIN)
    expect(accountHeaderValue('a+tag@example.test')).toBe('a+tag@example.test')
  })

  it('does not decode or re-encode a plain address that contains a percent sign', () => {
    expect(accountHeaderValue('a%41@example.test')).toBe('a%41@example.test')
  })

  it('encodes an address that itself starts with the prefix, so the server cannot misread it', () => {
    const value = accountHeaderValue('u8:x@example.test')
    expect(value).toBe('u8:u8%3Ax%40example.test')
    expect(decoded(value)).toBe('u8:x@example.test')
  })

  it.each([CYRILLIC, POLISH, LATIN1])('encodes %s as an ASCII "u8:" value that decodes back', (email) => {
    const value = accountHeaderValue(email)
    expect(value.startsWith('u8:')).toBe(true)
    expect(isAscii(value)).toBe(true)
    expect(decoded(value)).toBe(email)
    expect(() => new Headers().set('x-account', value)).not.toThrow()
  })

  it('refuses nothing: control characters and astral characters survive the round trip', () => {
    for (const email of ['a\tb@example.test', '😀@example.test']) {
      expect(decoded(accountHeaderValue(email))).toBe(email)
    }
  })

  it('accountHeaders is empty without an account', () => {
    expect(accountHeaders(null)).toEqual({})
    expect(accountHeaders(undefined)).toEqual({})
    expect(accountHeaders('')).toEqual({})
    expect(accountHeaders(PLAIN)).toEqual({ 'x-account': PLAIN })
  })
})

describe('the account header on the wire', () => {
  beforeEach(() => {
    ;(globalThis as any).indexedDB = new (fakeIndexedDB.constructor as any)()
    setActiveAccountEmail(null)
  })
  afterEach(() => {
    setActiveAccountEmail(null)
    vi.unstubAllGlobals()
  })

  function stubFetch() {
    const fetchMock = vi.fn(async (_u: any, _init?: any) =>
      ({ ok: true, status: 200, json: async () => ({ success: true }) }) as unknown as Response)
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }
  const sentAccount = (fetchMock: ReturnType<typeof stubFetch>, call = 0): string | undefined =>
    new Headers(fetchMock.mock.calls[call]![1].headers).get('x-account') ?? undefined

  it.each([CYRILLIC, POLISH])('apiFetch works while %s is the active account', async (email) => {
    const fetchMock = stubFetch()
    setActiveAccountEmail(email)
    await expect(apiFetch('/api/folders')).resolves.toBeDefined()
    const value = sentAccount(fetchMock)!
    expect(isAscii(value)).toBe(true)
    expect(decoded(value)).toBe(email)
  })

  it('apiFetch still sends a plain address unchanged', async () => {
    const fetchMock = stubFetch()
    setActiveAccountEmail(PLAIN)
    await apiFetch('/api/folders')
    expect(sentAccount(fetchMock)).toBe(PLAIN)
  })

  it('a caller-supplied header for another account is encoded too', async () => {
    const fetchMock = stubFetch()
    setActiveAccountEmail(PLAIN)
    await apiFetch('/api/pgp/status', { headers: accountHeaders(CYRILLIC) })
    expect(decoded(sentAccount(fetchMock)!)).toBe(CYRILLIC)
  })

  it('the outbox flushes a message queued under such an account', async () => {
    setActiveAccountEmail(CYRILLIC)
    await addQueuedMessage({ to: ['a@x.test'], subject: 's', body: 'b', createdAt: new Date().toISOString() })
    setActiveAccountEmail(PLAIN)
    const fetchMock = stubFetch()
    expect(await flushQueue()).toEqual({ sent: 1, failed: 0 })
    expect(decoded(sentAccount(fetchMock)!)).toBe(CYRILLIC)
  })

  it('a PGP call for such an account does not throw', async () => {
    const fetchMock = stubFetch()
    await pgpStatus(POLISH)
    expect(decoded(sentAccount(fetchMock)!)).toBe(POLISH)
  })
})

// A caller that sets the header itself brings the bug back, so only the helper may
// name it (the comments that explain it are fine).
describe('no raw x-account header outside the helper', () => {
  const root = join(__dirname, '..')
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sources(path)
      return /\.(ts|svelte)$/.test(name) ? [path] : []
    })
  }

  it('only src/lib/accountHeader.ts sets it', () => {
    const offenders = sources(root)
      .filter((file) => !file.endsWith(join('lib', 'accountHeader.ts')))
      .filter((file) => /['"`]x-account['"`]/i.test(readFileSync(file, 'utf8')))
    expect(offenders).toEqual([])
  })
})
