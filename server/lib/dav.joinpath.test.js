import { test } from 'node:test'
import assert from 'node:assert/strict'
import { joinDavPath } from './dav.js'

test('joinDavPath: joins and trims slashes as before', () => {
  assert.equal(joinDavPath('/dav/', 'cal/'), '/dav/cal')
  assert.equal(joinDavPath('/dav', 'cal//'), '/dav/cal')
  assert.equal(joinDavPath('/dav/', '/abs/path/'), '/abs/path')
  assert.equal(joinDavPath('/dav///', ''), '/dav')
  assert.equal(joinDavPath('', 'x'), '/x')
  assert.equal(joinDavPath(undefined, undefined), '')
})

test('joinDavPath: linear on a path of many slashes (no ReDoS)', () => {
  const evil = '/'.repeat(200_000) + 'x'
  const t = Date.now()
  joinDavPath(evil, evil.slice(1))
  joinDavPath('/dav', 'a' + '/'.repeat(200_000) + 'b')
  assert.ok(Date.now() - t < 500, 'took too long')
})
