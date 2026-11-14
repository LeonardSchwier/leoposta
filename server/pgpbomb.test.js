// leoposta.pgp.decompression-bomb (audit run-2): a tiny compressed PGP
// message must not expand into hundreds of MB inside the backend.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as openpgp from 'openpgp'

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'leoposta-pgpbomb-'))
process.env.LEOPOSTA_DATA_DIR = DATA_DIR
process.env.LEOPOSTA_TOKEN = 'pgpbomb-test-token'
const { processPgp, MAX_DECRYPTED_BYTES } = await import('./lib/pgp.js')

const { privateKey, publicKey } = await openpgp.generateKey({ type: 'ecc', curve: 'curve25519', userIDs: [{ email: 'v@example.test' }], format: 'armored' })
fs.writeFileSync(path.join(DATA_DIR, 'pgp_private.asc'), privateKey)
const encryptionKeys = await openpgp.readKey({ armoredKey: publicKey })
const encrypt = async (text) => openpgp.encrypt({
  message: await openpgp.createMessage({ text }),
  encryptionKeys,
  config: { preferredCompressionAlgorithm: openpgp.enums.compression.zlib }
})

test('a compressed message larger than the limit is refused, not expanded', async () => {
  const bomb = await encrypt('Content-Type: text/plain\r\n\r\n' + 'A'.repeat(MAX_DECRYPTED_BYTES + 1024 * 1024))
  assert.ok(bomb.length < 200_000, `bomb is small (${bomb.length} B)`)
  const r = await processPgp(bomb)
  assert.equal(r.decrypted, false)
  assert.match(r.error, /decompressed/i)
  assert.equal(r.text, undefined)
})

test('a normal encrypted message still decrypts', async () => {
  const r = await processPgp(await encrypt('Content-Type: text/plain\r\n\r\nhello secret'))
  assert.equal(r.decrypted, true)
  assert.match(r.text, /hello secret/)
  fs.rmSync(DATA_DIR, { recursive: true, force: true })
})
