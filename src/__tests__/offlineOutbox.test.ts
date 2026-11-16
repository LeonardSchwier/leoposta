// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { indexedDB as fakeIndexedDB } from 'fake-indexeddb'
import { setActiveAccountEmail } from '../api'
import { addQueuedMessage, flushQueue, getQueuedMessages, queueCount } from '../lib/offlineQueue'

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
