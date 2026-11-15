import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.LEOPOSTA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'leoposta-pgpblocks-'))
const { publicBlocks } = await import('./pgp.js')

const B = '-----BEGIN PGP PUBLIC KEY BLOCK-----'
const E = '-----END PGP PUBLIC KEY BLOCK-----'

test('publicBlocks: finds each armored block, ignores text around them', () => {
  const text = `hi\n${B}\nAAA\n${E}\nmiddle\n${B}\nBBB\n${E}\nbye`
  assert.deepEqual(publicBlocks(text), [`${B}\nAAA\n${E}`, `${B}\nBBB\n${E}`])
  assert.equal(publicBlocks('no key here'), null)
  assert.equal(publicBlocks(`${B}\nunterminated`), null)
  assert.deepEqual(publicBlocks(`${B}\nX\n${E}\n${B}\nunterminated`), [`${B}\nX\n${E}`])
})

test('publicBlocks: linear on many BEGIN lines without an END (no ReDoS)', () => {
  const evil = (B + '\n').repeat(50_000)
  const t = Date.now()
  assert.equal(publicBlocks(evil), null)
  assert.ok(Date.now() - t < 500, 'took too long')
})
