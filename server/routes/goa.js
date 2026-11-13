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
// Always 200: "not available on this platform" (container, non-Linux build,
// or just no session bus) is the common case, not a server error — a non-2xx
// here would make the browser itself log a console error on every Settings
// load even though the frontend handles it fine, which the e2e suite's
// zero-console-errors check (tests/e2e/fixtures.ts) correctly treats as a
// real problem. POST /goa/import below is a deliberate user action, not a
// background poll, so 503 there is fine.
router.get('/goa/accounts', async (req, res) => {
  if (!await isGoaAvailable()) return res.json({ available: false, accounts: [] })
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
