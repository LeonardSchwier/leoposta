// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { indexedDB as fakeIndexedDB, IDBDatabase as FDBDatabase } from 'fake-indexeddb'
import { setActiveAccountEmail } from '../api'
import { addQueuedMessage, discardQueuedMessage, flushQueue, getQueuedMessages, queueCount, QUEUE_CHANGED } from '../lib/offlineQueue'

describe('offline outbox', () => {
  beforeEach(() => {
    ;(globalThis as any).indexedDB = new (fakeIndexedDB.constructor as any)()
    setActiveAccountEmail(null)
  })

  const draft = (extra: Record<string, unknown> = {}) => ({
    to: ['a@x.test'], subject: 's', body: 'b', createdAt: new Date().toISOString(), ...extra
  })

  /** A fetch that records the account header and body of every send. */
  function recordSends(answer: () => { ok: boolean; status: number; json: () => Promise<unknown> } = () => ({ ok: true, status: 200, json: async () => ({ success: true }) })) {
    const sends: Array<{ account: string | undefined; subject: string }> = []
    globalThis.fetch = vi.fn(async (_u: any, init?: any) => {
      sends.push({ account: init.headers['x-account'], subject: JSON.parse(init.body).subject })
      return answer()
    }) as any
    return sends
  }

  it('overlapping flushes send each queued message once', async () => {
    await addQueuedMessage({ to: ['a@x.test'], subject: 's', body: 'b', inReplyTo: '<p@x>', createdAt: new Date().toISOString() })
    const bodies: any[] = []
    globalThis.fetch = vi.fn(async (_u: any, init?: any) => {
      bodies.push(JSON.parse(init.body))
      await new Promise((r) => setTimeout(r, 20))
      return { ok: true, status: 200, json: async () => ({ success: true }) }
    }) as any
    const [a, b] = await Promise.all([flushQueue(), flushQueue()])
    expect(bodies).toHaveLength(1)
    expect(bodies[0].inReplyTo).toBe('<p@x>')
    expect(a).toEqual({ sent: 1, failed: 0 })
    expect(b).toEqual(a)
    expect(await queueCount()).toBe(0)
  })

  // A message queued offline belongs to the account it was written under. The
  // outbox is flushed later, when the active account may be another one, and
  // apiFetch scopes every request to the *active* account: without a recorded
  // account the mail left from the wrong address.
  it('remembers the account a message was queued under', async () => {
    setActiveAccountEmail('erika@example.test')
    await addQueuedMessage(draft())
    const [queued] = await getQueuedMessages()
    expect(queued!.account).toBe('erika@example.test')
  })

  it('sends a queued message from the account it was queued under, not the active one', async () => {
    setActiveAccountEmail('erika@example.test')
    await addQueuedMessage(draft({ subject: 'from erika' }))
    setActiveAccountEmail('max@example.test')
    await addQueuedMessage(draft({ subject: 'from max' }))
    // The user switches account while offline, then the network returns: the
    // active account now matches neither queued message's own account order.
    setActiveAccountEmail('lena@example.test')
    const sends = recordSends()
    expect(await flushQueue()).toEqual({ sent: 2, failed: 0 })
    expect(sends).toEqual([
      { account: 'erika@example.test', subject: 'from erika' },
      { account: 'max@example.test', subject: 'from max' }
    ])
    expect(sends.some((s) => s.account === 'lena@example.test')).toBe(false)
  })

  it('an explicit account on the message wins over the active one', async () => {
    setActiveAccountEmail('max@example.test')
    await addQueuedMessage(draft({ account: 'erika@example.test' }))
    const sends = recordSends()
    await flushQueue()
    expect(sends.map((s) => s.account)).toEqual(['erika@example.test'])
  })

  it('a message queued before accounts were recorded still goes out under the active account', async () => {
    await addQueuedMessage(draft()) // no account known: single-account setup
    setActiveAccountEmail('max@example.test')
    const sends = recordSends()
    expect(await flushQueue()).toEqual({ sent: 1, failed: 0 })
    expect(sends.map((s) => s.account)).toEqual(['max@example.test'])
  })

  it('keeps the message queued when its account is gone and the server refuses it', async () => {
    setActiveAccountEmail('erika@example.test')
    await addQueuedMessage(draft())
    setActiveAccountEmail('max@example.test')
    const sends = recordSends(() => ({ ok: false, status: 400, json: async () => ({ error: 'No account configured' }) }))
    expect(await flushQueue()).toEqual({ sent: 0, failed: 1 })
    expect(sends.map((s) => s.account)).toEqual(['erika@example.test']) // never retried as max
    expect(await queueCount()).toBe(1)
  })
})

// A message the server refuses stays queued. The user has to be able to see why
// and to get rid of it; before, it was retried and reported as "failed" in a
// 3 s toast on every reconnect and could never be removed.
describe('a queued message that fails', () => {
  beforeEach(() => {
    ;(globalThis as any).indexedDB = new (fakeIndexedDB.constructor as any)()
    setActiveAccountEmail(null)
  })
  const draft = (extra: Record<string, unknown> = {}) => ({
    to: ['a@x.test'], subject: 's', body: 'b', createdAt: new Date().toISOString(), ...extra
  })
  const answer = (status: number, body: unknown) => () => ({
    ok: status < 400, status, json: async () => body
  })
  function fetchReturns(make: () => unknown) {
    globalThis.fetch = vi.fn(async () => make()) as any
  }

  it("records the server's reason and when it was tried, and keeps the message", async () => {
    await addQueuedMessage(draft())
    fetchReturns(answer(400, { error: 'No account configured' }))
    expect(await flushQueue()).toEqual({ sent: 0, failed: 1 })
    const [m] = await getQueuedMessages()
    expect(m!.lastError).toBe('No account configured')
    expect(Number.isNaN(Date.parse(m!.lastAttemptAt!))).toBe(false)
  })

  it('names the HTTP status when the answer has no error text or is not JSON', async () => {
    await addQueuedMessage(draft())
    fetchReturns(() => ({ ok: false, status: 502, json: async () => { throw new SyntaxError('Unexpected token <') } }))
    await flushQueue()
    expect((await getQueuedMessages())[0]!.lastError).toBe('HTTP 502')
    fetchReturns(answer(500, {}))
    await flushQueue()
    expect((await getQueuedMessages())[0]!.lastError).toBe('HTTP 500')
  })

  it('says the server could not be reached when the request itself fails', async () => {
    await addQueuedMessage(draft())
    globalThis.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch') }) as any
    await flushQueue()
    expect((await getQueuedMessages())[0]!.lastError).toBe('Could not reach the server')
  })

  it('keeps an overlong server error readable', async () => {
    await addQueuedMessage(draft())
    fetchReturns(answer(500, { error: 'x'.repeat(5000) }))
    await flushQueue()
    expect((await getQueuedMessages())[0]!.lastError!.length).toBeLessThanOrEqual(300)
  })

  it('is sent and removed on a later try, with no error left behind', async () => {
    await addQueuedMessage(draft())
    fetchReturns(answer(500, { error: 'Temporary failure' }))
    await flushQueue()
    fetchReturns(answer(200, { success: true }))
    expect(await flushQueue()).toEqual({ sent: 1, failed: 0 })
    expect(await getQueuedMessages()).toEqual([])
  })

  it('says so when the server accepted it but the outbox could not be cleaned', async () => {
    await addQueuedMessage(draft())
    fetchReturns(answer(200, { success: true }))
    const realTransaction = FDBDatabase.prototype.transaction
    let refused = false
    // The first readwrite transaction after the send is the removal: refuse it.
    vi.spyOn(FDBDatabase.prototype, 'transaction').mockImplementation(function (this: any, store: any, mode?: any) {
      if (mode === 'readwrite' && !refused) {
        refused = true
        throw new DOMException('quota', 'QuotaExceededError')
      }
      return realTransaction.call(this, store, mode)
    } as any)
    try {
      expect(await flushQueue()).toEqual({ sent: 0, failed: 1 })
    } finally {
      vi.restoreAllMocks()
    }
    const [stuck] = await getQueuedMessages()
    expect(stuck!.lastError).toBe('Sent, but it could not be removed from the outbox')
    expect(Number.isNaN(Date.parse(stuck!.sentAt!))).toBe(false)
  })

  // The server has that mail. Sending it again at every start-up or reconnect
  // would deliver it again and again; the flush only tries to clean up.
  it('is never sent a second time once the server accepted it, and is cleaned up on the next flush', async () => {
    await addQueuedMessage(draft())
    fetchReturns(answer(200, { success: true }))
    const realTransaction = FDBDatabase.prototype.transaction
    let refused = false
    vi.spyOn(FDBDatabase.prototype, 'transaction').mockImplementation(function (this: any, store: any, mode?: any) {
      if (mode === 'readwrite' && !refused) {
        refused = true
        throw new DOMException('quota', 'QuotaExceededError')
      }
      return realTransaction.call(this, store, mode)
    } as any)
    try {
      await flushQueue()
    } finally {
      vi.restoreAllMocks()
    }
    expect((globalThis.fetch as any).mock.calls).toHaveLength(1)
    fetchReturns(answer(200, { success: true }))
    expect(await flushQueue()).toEqual({ sent: 0, failed: 0 })
    expect((globalThis.fetch as any).mock.calls).toHaveLength(0)
    expect(await getQueuedMessages()).toEqual([])
  })

  it('does not touch the other messages of the same flush', async () => {
    await addQueuedMessage(draft({ subject: 'bad' }))
    await addQueuedMessage(draft({ subject: 'good' }))
    globalThis.fetch = vi.fn(async (_u: any, init?: any) =>
      JSON.parse(init.body).subject === 'bad' ? answer(400, { error: 'Nope' })() : answer(200, { success: true })()) as any
    expect(await flushQueue()).toEqual({ sent: 1, failed: 1 })
    const left = await getQueuedMessages()
    expect(left.map((m) => m.subject)).toEqual(['bad'])
    expect(left[0]!.lastError).toBe('Nope')
  })
})

describe('discarding a queued message', () => {
  beforeEach(() => {
    ;(globalThis as any).indexedDB = new (fakeIndexedDB.constructor as any)()
    setActiveAccountEmail(null)
  })
  const draft = (subject: string) => ({
    to: ['a@x.test'], subject, body: 'b', createdAt: new Date().toISOString()
  })

  it('removes it and tells the badge', async () => {
    await addQueuedMessage(draft('one'))
    await addQueuedMessage(draft('two'))
    const [first] = await getQueuedMessages()
    const changed = vi.fn()
    ;(globalThis as any).window = new EventTarget()
    ;(globalThis as any).window.addEventListener(QUEUE_CHANGED, changed)
    try {
      await discardQueuedMessage(first!.id!)
    } finally {
      delete (globalThis as any).window
    }
    expect((await getQueuedMessages()).map((m) => m.subject)).toEqual(['two'])
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('is a no-op for an id that is already gone', async () => {
    await discardQueuedMessage(12345)
    expect(await queueCount()).toBe(0)
  })

  // The flush reads the whole outbox first and then sends one message at a time,
  // so a message discarded while an earlier one is in flight would still go out.
  it('is not sent by a flush that is already running', async () => {
    await addQueuedMessage(draft('first'))
    await addQueuedMessage(draft('second'))
    const [, second] = await getQueuedMessages()
    const sent: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    globalThis.fetch = vi.fn(async (_u: any, init?: any) => {
      const subject = JSON.parse(init.body).subject
      sent.push(subject)
      if (subject === 'first') await gate
      return { ok: true, status: 200, json: async () => ({ success: true }) }
    }) as any
    const flushing = flushQueue()
    await vi.waitFor(() => expect(sent).toEqual(['first']))
    await discardQueuedMessage(second!.id!)
    release()
    expect(await flushing).toEqual({ sent: 1, failed: 0 })
    expect(sent).toEqual(['first'])
  })

  it('is not undone by the failure of the attempt that was in flight', async () => {
    await addQueuedMessage(draft('only'))
    const [only] = await getQueuedMessages()
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    globalThis.fetch = vi.fn(async () => {
      await gate
      return { ok: false, status: 500, json: async () => ({ error: 'Boom' }) }
    }) as any
    const flushing = flushQueue()
    await vi.waitFor(() => expect((globalThis.fetch as any).mock.calls.length).toBe(1))
    await discardQueuedMessage(only!.id!)
    release()
    await flushing
    expect(await getQueuedMessages()).toEqual([])
  })
})
