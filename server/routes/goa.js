import { Router } from 'express'
import { isGoaAvailable, listGoaAccounts, resolveGoaImport } from '../lib/goa.js'
import { getAccount, addAccount, updateAccount } from '../lib/state.js'
import { dropPool } from '../lib/imap.js'

const router = Router()

function publicFields(a) {
  return {
    goaId: a.goaId,
    providerType: a.providerType,
    providerName: a.providerName,
    identity: a.identity,
    hasMail: a.hasMail,
    hasDav: a.hasDav
  }
}

// GET /api/goa/accounts — list GOA accounts leoposta could import from.
// 503 (not 500) when GOA/the session bus/keyring tooling isn't present at
// all, e.g. inside the container or on a non-Linux build.
router.get('/goa/accounts', async (req, res) => {
  if (!await isGoaAvailable()) return res.status(503).json({ available: false, accounts: [] })
  const accounts = await listGoaAccounts()
  res.json({ available: true, accounts: accounts.map(publicFields) })
})

// POST /api/goa/import { goaId, importMail, importDav } — resolves the GOA
// account (including its keyring password) and feeds it through the same
// addAccount/updateAccount path a manually-typed account uses.
router.post('/goa/import', async (req, res) => {
  try {
    if (!await isGoaAvailable()) return res.status(503).json({ error: 'goa_unavailable' })
    const { goaId, importMail = true, importDav = true } = req.body || {}
    if (!goaId) return res.status(400).json({ error: 'goaId is required' })
    const payload = await resolveGoaImport(goaId, { importMail, importDav })
    if (!payload || !payload.email) return res.status(404).json({ error: 'goa_account_not_found' })

    const existing = getAccount(payload.email)
    const acct = existing ? updateAccount(payload.email, payload) : addAccount(payload)
    dropPool(payload.email)
    res.json({ success: true, id: acct.id })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router
