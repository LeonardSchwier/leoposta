// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { indexedDB as fakeIndexedDB } from 'fake-indexeddb'
import { addQueuedMessage, flushQueue, queueCount } from '../lib/offlineQueue'

describe('offline outbox', () => {
  beforeEach(() => {
    ;(globalThis as any).indexedDB = new (fakeIndexedDB.constructor as any)()
  })

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
})
