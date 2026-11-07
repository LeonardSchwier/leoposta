import { Router } from 'express'
import fs from 'node:fs'
import { state, ACCOUNT_FILE, applyEnvPasswords, saveAccount } from '../lib/state.js'
import { pool } from '../lib/imap.js'

const router = Router()

router.get('/account', (req, res) => {
  if (!state.account) return res.json({ connected: false })
  const { imapPass, smtpPass, ...safe } = state.account
  if (!safe.signature) safe.signature = { enabled: false, text: '', position: 'standard' }
  res.json(safe)
})

router.post('/account', (req, res) => {
  try {
    const { email, imapHost, imapPort, imapTls, imapUser, imapPass, smtpHost, smtpPort, smtpTls, smtpUser, smtpPass, name, signature } = req.body
    state.account = {
      email, name: name || email,
      imapHost, imapPort: Number(imapPort) || 993, imapTls: imapTls !== false,
      imapUser, imapPass,
      smtpHost, smtpPort: Number(smtpPort) || 465, smtpTls: smtpTls !== false,
      smtpUser, smtpPass,
      signature: signature || { enabled: false, text: '', position: 'standard' }
    }
    applyEnvPasswords()
    saveAccount()
    pool.reset().catch(() => {})
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.delete('/account', (req, res) => {
  state.account = null
  try { fs.unlinkSync(ACCOUNT_FILE) } catch {}
  pool.reset().catch(() => {})
  res.json({ success: true })
})

export default router
