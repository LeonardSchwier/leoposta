import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// State isolation, same pattern as server.test.js: env first, then import.
const TOKEN = 'rules-test-token-0123456789abcdef'
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'leoposta-rules-'))
process.env.LEOPOSTA_TOKEN = TOKEN
process.env.LEOPOSTA_DATA_DIR = DATA_DIR

const { createApp } = await import('./index.js')

let server
let base
const headers = { 'x-leoposta-token': TOKEN, 'content-type': 'application/json' }
const put = (body) => fetch(`${base}/api/rules`, { method: 'PUT', headers, body: JSON.stringify(body) })
const get = async () => (await fetch(`${base}/api/rules`, { headers })).json()

const goodRule = {
  id: 'r1',
  enabled: true,
  conditions: [{ field: 'subject', operator: 'regex', value: '^\\[invoice\\]' }],
  action: { type: 'label', value: 'Billing' }
}

before(async () => {
  await new Promise((resolve) => { server = createApp().listen(0, '127.0.0.1', resolve) })
  base = `http://127.0.0.1:${server.address().port}`
})
after(async () => {
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(resolve))
  fs.rmSync(DATA_DIR, { recursive: true, force: true })
})

test('PUT /api/rules stores a valid list and GET returns it', async () => {
  const res = await put({ rules: [goodRule] })
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { success: true, count: 1 })
  assert.deepEqual((await get()).rules, [goodRule])
})

test('PUT /api/rules stores clean copies: unknown properties are dropped', async () => {
  const res = await put({ rules: [{ ...goodRule, junk: { deep: [1, 2, 3] }, conditions: [{ ...goodRule.conditions[0], extra: true }] }] })
  assert.equal(res.status, 200)
  assert.deepEqual((await get()).rules, [goodRule])
})

test('PUT /api/rules refuses malformed rules with a readable 400 and keeps the stored ones', async () => {
  const bad = [
    { rules: [null] },
    { rules: [{ ...goodRule, conditions: [null] }] },
    { rules: [{ ...goodRule, conditions: [{ field: 'subject', operator: 'regex', value: '(' }] }] },
    { rules: [{ ...goodRule, conditions: [{ field: 'subject', operator: 'contains', value: 5 }] }] },
    { rules: Array.from({ length: 201 }, () => goodRule) },
    { rules: 'nope' },
    {}
  ]
  for (const body of bad) {
    const res = await put(body)
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80))
    const json = await res.json()
    assert.equal(typeof json.error, 'string')
    assert.ok(json.error.length > 0 && json.error.length < 200)
  }
  assert.deepEqual((await get()).rules, [goodRule])
})

test('PUT /api/rules can still clear the list', async () => {
  const res = await put({ rules: [] })
  assert.equal(res.status, 200)
  assert.deepEqual((await get()).rules, [])
})
