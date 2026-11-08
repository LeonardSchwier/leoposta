import { Router } from 'express'
import {
  state, getAccount, getActiveAccount,
  addAccount, updateAccount, removeAccount
} from '../lib/state.js'
import { dropPool } from '../lib/imap.js'

const router = Router()

function sanitize(acct) {
  const { imapPass, smtpPass, davPass, ...safe } = acct
  if (!safe.signature) safe.signature = { enabled: false, text: '', position: 'standard' }
  return safe
}

// ── Multi-account API ────────────────────────────────────────────────────────

router.get('/accounts', (req, res) => {
  res.json(state.accounts.map(sanitize))
})

router.post('/accounts', (req, res) => {
  try {
    const { email } = req.body || {}
    if (!email) return res.status(400).json({ error: 'email is required' })
    if (getAccount(email)) return res.status(409).json({ error: 'account already exists' })
    const acct = addAccount(req.body)
    dropPool(email) // start with a fresh pool
    res.json({ success: true, id: acct.id })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.put('/accounts/:email', (req, res) => {
  try {
    const existing = getAccount(req.params.email)
    if (!existing) return res.status(404).json({ error: 'account not found' })
    const merged = updateAccount(req.params.email, req.body)
    dropPool(req.params.email)
    res.json({ success: true, id: merged.id })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.delete('/accounts/:email', (req, res) => {
  const removed = removeAccount(req.params.email)
  dropPool(req.params.email)
  if (!removed) return res.status(404).json({ error: 'account not found' })
  res.json({ success: true })
})

// ── Compat (single-account API — reads/writes accounts[0]) ──────────────────

router.get('/account', (req, res) => {
  const acct = getActiveAccount()
  if (!acct) return res.json({ connected: false })
  res.json(sanitize(acct))
})

router.post('/account', (req, res) => {
  try {
    const { email } = req.body || {}
    if (email && getAccount(email)) {
      // Update existing
      const merged = updateAccount(email, req.body)
      dropPool(email)
      return res.json({ success: true, id: merged.id })
    }
    if (!email) return res.status(400).json({ error: 'email is required' })
    const acct = addAccount(req.body)
    dropPool(email)
    res.json({ success: true, id: acct.id })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.delete('/account', (req, res) => {
  const first = getActiveAccount()
  if (!first) return res.status(404).json({ error: 'no account' })
  removeAccount(first.email)
  dropPool(first.email)
  res.json({ success: true })
})

export default router
