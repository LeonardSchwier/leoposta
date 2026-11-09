import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createCache, setNow, resetClock, TTL_SHORT, TTL_LONG } from './davcache.js'

beforeEach(() => resetClock())

test('set/get round-trips a value', () => {
  const c = createCache(10)
  c.set('a', { x: 1 }, TTL_LONG)
  assert.deepEqual(c.get('a'), { x: 1 })
})

test('get misses for unknown key', () => {
  const c = createCache(10)
  assert.equal(c.get('nope'), undefined)
})

test('entry expires after its ttl', () => {
  const BASE = 1_000_000
  setNow(() => BASE)
  const c = createCache(10)
  c.set('a', 1, 1000)
  assert.equal(c.get('a'), 1)
  setNow(() => BASE + 1001)
  assert.equal(c.get('a'), undefined)
})

test('short and long TTL constants are exported', () => {
  assert.equal(TTL_SHORT, 60_000)
  assert.equal(TTL_LONG, 600_000)
})

test('invalidate removes exactly one key', () => {
  const c = createCache(10)
  c.set('k1', 1, TTL_LONG)
  c.set('k2', 2, TTL_LONG)
  c.invalidate('k1')
  assert.equal(c.get('k1'), undefined)
  assert.equal(c.get('k2'), 2)
})

test('invalidatePrefix removes all keys under a prefix', () => {
  const c = createCache(10)
  c.set('contacts|acct1|b1', 1, TTL_LONG)
  c.set('contacts|acct1|b2', 2, TTL_LONG)
  c.set('contacts|acct2|b1', 3, TTL_LONG)
  c.invalidatePrefix('contacts|acct1|')
  assert.equal(c.get('contacts|acct1|b1'), undefined)
  assert.equal(c.get('contacts|acct1|b2'), undefined)
  assert.equal(c.get('contacts|acct2|b1'), 3)
})

test('clear empties the cache', () => {
  const c = createCache(10)
  c.set('a', 1, TTL_LONG)
  c.set('b', 2, TTL_LONG)
  c.clear()
  assert.equal(c.size(), 0)
})

test('refreshing a key moves it to the back (FIFO order)', () => {
  const c = createCache(2)
  c.set('a', 1, TTL_LONG)
  c.set('b', 2, TTL_LONG)
  c.set('a', 1, TTL_LONG) // refresh → a becomes most-recent
  c.set('c', 3, TTL_LONG) // over limit → evicts oldest (b)
  assert.equal(c.get('b'), undefined)
  assert.equal(c.get('a'), 1)
  assert.equal(c.get('c'), 3)
})

test('evicts oldest key once over maxEntries', () => {
  const c = createCache(2)
  c.set('a', 1, TTL_LONG)
  c.set('b', 2, TTL_LONG)
  c.set('c', 3, TTL_LONG)
  assert.equal(c.get('a'), undefined) // a was oldest
  assert.equal(c.size(), 2)
})
