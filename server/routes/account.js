import { Router } from 'express'
import {
  state, getAccount, getActiveAccount,
  addAccount, updateAccount, removeAccount, accountPayloadFrom, mergeAccount,
  getRememberedAccount, setRememberedAccount
} from '../lib/state.js'
import { dropPool, verifyAccount } from '../lib/imap.js'
import { clearDavBaseCache } from '../lib/dav.js'

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

// The account last chosen in the UI, so a reload (or the next desktop launch,
// which has a fresh origin and so an empty localStorage) opens it again.
// `email` is null when none was chosen or it has been removed since.
router.get('/active-account', (req, res) => {
  const acct = getAccount(getRememberedAccount())
  res.json({ email: acct ? acct.email : null })
})

router.put('/active-account', (req, res) => {
  const acct = getAccount(req.body && req.body.email)
  if (!acct) return res.status(404).json({ error: 'account not found' })
  setRememberedAccount(acct.email)
  res.json({ email: acct.email })
})

// A DAV URL, when given, must be an http(s) URL ('' clears it).
function badDavUrl(body) {
  const v = body && body.davUrl
  if (v === undefined || v === null || v === '') return null
  try {
    const u = new URL(String(v).trim())
    if (u.protocol === 'http:' || u.protocol === 'https:') return null
  } catch {}
  return 'CalDAV/CardDAV URL must start with https:// (or http://)'
}

// `verify: true` (what Settings sends): log in to IMAP and SMTP with the
// new settings first and save nothing if that fails. API clients that only
// want to store settings (tests, scripts) leave it out.
async function verifyOr400(res, candidate) {
  try {
    await verifyAccount(candidate)
    return true
  } catch (err) {
    res.status(400).json({ error: err.message, field: err.field || null, code: 'verify_failed' })
    return false
  }
}

router.post('/accounts', async (req, res) => {
  try {
    const { email } = req.body || {}
    if (!email) return res.status(400).json({ error: 'email is required' })
    if (getAccount(email)) return res.status(409).json({ error: 'account already exists' })
    const davErr = badDavUrl(req.body)
    if (davErr) return res.status(400).json({ error: davErr, field: 'dav' })
    if (req.body.verify === true && !await verifyOr400(res, accountPayloadFrom(req.body))) return
    if (getAccount(email)) return res.status(409).json({ error: 'account already exists' })
    const acct = addAccount(req.body)
    dropPool(email) // start with a fresh pool
    res.json({ success: true, id: acct.id })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.put('/accounts/:email', async (req, res) => {
  try {
    const existing = getAccount(req.params.email)
    if (!existing) return res.status(404).json({ error: 'account not found' })
    const body = req.body || {}
    const davErr = badDavUrl(body)
    if (davErr) return res.status(400).json({ error: davErr, field: 'dav' })
    if (body.verify === true && !await verifyOr400(res, mergeAccount(existing, body))) return
    const merged = updateAccount(req.params.email, body)
    dropPool(req.params.email)
    clearDavBaseCache()
    res.json({ success: true, id: merged.id })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.delete('/accounts/:email', (req, res) => {
  const removed = removeAccount(req.params.email)
  dropPool(req.params.email)
  clearDavBaseCache()
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
