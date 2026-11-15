import { Router } from 'express'
import { resolveAccount } from '../lib/state.js'
import { createAttemptLimiter } from '../lib/throttle.js'
import {
  pgpState, savePgp, deletePgp, unlockFromPassphrase, pgpLock, hasOwnKey,
  listPublicKeys, deletePublicKeys
} from '../lib/pgp.js'
import { lookupRecipientKeys } from '../lib/pgpSend.js'

const router = Router()

// Every route works on the private key of the request's account (x-account
// header, ?account=, else the first account); public keys are one keyring.

// The API token already gates this route, but a leaked or shared token must not
// also allow unlimited passphrase guesses: 5 failures lock it for a minute.
const unlockLimiter = createAttemptLimiter({ max: 5, windowMs: 60_000 })

router.get('/pgp/status', async (req, res) => res.json(await pgpState(resolveAccount(req))))

router.post('/pgp/unlock', async (req, res) => {
  const acct = resolveAccount(req)
  if (!hasOwnKey(acct)) return res.status(404).json({ error: 'no_private_key' })
  // Counted before the await: concurrent guesses must not all pass the check
  // before the first failure is recorded. A success resets the count.
  const gate = unlockLimiter.attempt()
  if (!gate.ok) {
    res.set('Retry-After', String(Math.max(1, Math.ceil(gate.retryAfterMs / 1000))))
    return res.status(429).json({ error: 'too_many_attempts' })
  }
  try {
    await unlockFromPassphrase(acct, req.body && req.body.passphrase)
    unlockLimiter.reset()
    res.json({ ok: true })
  } catch {
    res.status(401).json({ error: 'bad_passphrase' })
  }
})

router.post('/pgp/lock', async (req, res) => { await pgpLock(resolveAccount(req)); res.json({ ok: true }) })

router.put('/pgp', async (req, res) => {
  try {
    const { privateAsc, publicAsc, passphrase } = req.body || {}
    if (!privateAsc && !publicAsc && passphrase === undefined) {
      return res.status(400).json({ error: 'Nothing to save' })
    }
    res.json({ success: true, state: await savePgp(resolveAccount(req), { privateAsc, publicAsc, passphrase }) })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// The account's private key only; the keyring has its own routes.
router.delete('/pgp', async (req, res) => res.json({ success: true, state: await deletePgp(resolveAccount(req)) }))

router.get('/pgp/publics', async (req, res) => res.json({ keys: await listPublicKeys() }))

router.delete('/pgp/publics', async (req, res) => { await deletePublicKeys(); res.json({ success: true }) })

router.delete('/pgp/publics/:fingerprint', async (req, res) => {
  if (!/^[0-9A-Fa-f]{16,64}$/.test(req.params.fingerprint)) return res.status(400).json({ error: 'invalid fingerprint' })
  if (!await deletePublicKeys(req.params.fingerprint)) return res.status(404).json({ error: 'key not found' })
  res.json({ success: true })
})

// POST /api/pgp/lookup { recipients: [...] } -> { found: [addr], missing: [addr] }
// Compose asks before sending encrypted, so the user sees who has no key.
router.post('/pgp/lookup', async (req, res) => {
  const list = req.body && req.body.recipients
  if (!Array.isArray(list) || list.length > 500) return res.status(400).json({ error: 'recipients must be a list' })
  const { found, missing } = await lookupRecipientKeys(list.map(String))
  res.json({ found, missing })
})

export default router
