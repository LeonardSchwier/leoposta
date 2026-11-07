import { Router } from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from '../lib/state.js'
import {
  pgpState, savePgp, deletePgp, unlockFromPassphrase, pgpLock
} from '../lib/pgp.js'

const router = Router()
const PGP_PRIVATE_FILE = path.join(DATA_DIR, 'pgp_private.asc')

router.get('/pgp/status', async (req, res) => res.json(await pgpState()))

router.post('/pgp/unlock', async (req, res) => {
  if (!fs.existsSync(PGP_PRIVATE_FILE)) return res.status(404).json({ error: 'no_private_key' })
  try {
    await unlockFromPassphrase(req.body && req.body.passphrase)
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
