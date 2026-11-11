import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from '../lib/state.js'
import { createAttemptLimiter } from '../lib/throttle.js'
import {
  pgpState, savePgp, deletePgp, unlockFromPassphrase, pgpLock
} from '../lib/pgp.js'

const router = Router()

// The API token already gates this route, but a leaked or shared token must not
// also allow unlimited passphrase guesses: 5 failures lock it for a minute.
const unlockLimiter = createAttemptLimiter({ max: 5, windowMs: 60_000 })
const PGP_PRIVATE_FILE = path.join(DATA_DIR, 'pgp_private.asc')

router.get('/pgp/status', async (req, res) => res.json(await pgpState()))

router.post('/pgp/unlock', async (req, res) => {
  if (!fs.existsSync(PGP_PRIVATE_FILE)) return res.status(404).json({ error: 'no_private_key' })
  // Counted before the await: concurrent guesses must not all pass the check
  // before the first failure is recorded. A success resets the count.
  const gate = unlockLimiter.attempt()
  if (!gate.ok) {
    res.set('Retry-After', String(Math.max(1, Math.ceil(gate.retryAfterMs / 1000))))
    return res.status(429).json({ error: 'too_many_attempts' })
  }
  try {
    await unlockFromPassphrase(req.body && req.body.passphrase)
    unlockLimiter.reset()
    res.json({ ok: true })
  } catch {
    res.status(401).json({ error: 'bad_passphrase' })
  }
})

router.post('/pgp/lock', (req, res) => { pgpLock(); res.json({ ok: true }) })

router.put('/pgp', async (req, res) => {
  try {
    const { privateAsc, publicAsc, passphrase } = req.body || {}
    if (!privateAsc && !publicAsc && passphrase === undefined) {
      return res.status(400).json({ error: 'Nothing to save' })
    }
    res.json({ success: true, state: await savePgp({ privateAsc, publicAsc, passphrase }) })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.delete('/pgp', async (req, res) => res.json({ success: true, state: await deletePgp() }))

export default router
