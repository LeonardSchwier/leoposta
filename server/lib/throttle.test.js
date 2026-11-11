import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAttemptLimiter } from './throttle.js'

function clock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms } }
}

test('allows `max` attempts, then blocks and reports how long to wait', () => {
  const c = clock()
  const limiter = createAttemptLimiter({ max: 3, windowMs: 60_000, now: c.now })
  for (let i = 0; i < 3; i++) assert.deepEqual(limiter.attempt(), { ok: true })
  c.advance(10_000)
  assert.deepEqual(limiter.attempt(), { ok: false, retryAfterMs: 50_000 })
})

test('lets attempts through again once the window has passed', () => {
  const c = clock()
  const limiter = createAttemptLimiter({ max: 2, windowMs: 1000, now: c.now })
  limiter.attempt(); limiter.attempt()
  assert.equal(limiter.attempt().ok, false)
  c.advance(1000)
  assert.deepEqual(limiter.attempt(), { ok: true })
  assert.deepEqual(limiter.attempt(), { ok: true }, 'a new window starts at one attempt')
  assert.equal(limiter.attempt().ok, false)
})

test('a success clears the count', () => {
  const c = clock()
  const limiter = createAttemptLimiter({ max: 2, windowMs: 60_000, now: c.now })
  limiter.attempt(); limiter.attempt()
  limiter.reset()
  assert.deepEqual(limiter.attempt(), { ok: true })
  assert.deepEqual(limiter.attempt(), { ok: true })
  assert.equal(limiter.attempt().ok, false)
})

test('refused attempts do not extend the lockout', () => {
  const c = clock()
  const limiter = createAttemptLimiter({ max: 1, windowMs: 1000, now: c.now })
  limiter.attempt()
  c.advance(900)
  limiter.attempt(); limiter.attempt()
  assert.deepEqual(limiter.attempt(), { ok: false, retryAfterMs: 100 })
})

test('concurrent callers that all attempt before any result arrives are still capped', async () => {
  const limiter = createAttemptLimiter({ max: 5, windowMs: 60_000 })
  // Mimics the route: attempt first, then await slow work, never reset.
  const results = await Promise.all(
    Array.from({ length: 20 }, async () => {
      const gate = limiter.attempt()
      if (!gate.ok) return 'blocked'
      await new Promise((r) => setTimeout(r, 5))
      return 'tried'
    })
  )
  assert.equal(results.filter((r) => r === 'tried').length, 5)
  assert.equal(results.filter((r) => r === 'blocked').length, 15)
})
