import { Router } from 'express'
import { isGoaAvailable, listGoaAccounts, resolveGoaImport } from '../lib/goa.js'
import { getAccount, addAccount, updateAccount } from '../lib/state.js'
import { dropPool } from '../lib/imap.js'
import { clearDavBaseCache } from '../lib/dav.js'

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

// POST /api/goa/import { goaId, importMail, importDav, targetEmail? } —
// resolves the GOA account (including its keyring password) and feeds it
// through the same addAccount/updateAccount path a manually-typed account
// uses. Re-importing updates the same account (matched by email).
//
// A WebDAV-only GOA account (no mail interface) carries no mail settings: it
// is attached to an existing mail account — the one with the same address,
// else `targetEmail` (Settings sends the active account) — instead of
// creating a half account that has a calendar but no IMAP server.
router.post('/goa/import', async (req, res) => {
  try {
    if (!await isGoaAvailable()) return res.status(503).json({ error: 'GNOME Online Accounts is not available on this system', code: 'goa_unavailable' })
    const { goaId, importMail = true, importDav = true, targetEmail } = req.body || {}
    if (!goaId) return res.status(400).json({ error: 'goaId is required' })
    const payload = await resolveGoaImport(goaId, { importMail, importDav })
    if (!payload || !payload.email) return res.status(404).json({ error: 'goa_account_not_found' })

    const hasMail = !!payload.imapHost
    if (hasMail && (!payload.imapPass || !payload.smtpPass)) {
      return res.status(502).json({ error: `GNOME Online Accounts returned no stored password for ${payload.email}. Open it in GNOME Settings → Online Accounts, sign in again, then retry.`, code: 'goa_no_password' })
    }
    if (!hasMail && payload.davUrl && !payload.davPass) {
      return res.status(502).json({ error: `GNOME Online Accounts returned no stored password for the WebDAV account ${payload.email}.`, code: 'goa_no_password' })
    }
    // Never let a missing value overwrite a stored one.
    for (const k of Object.keys(payload)) if (payload[k] === null || payload[k] === undefined) delete payload[k]

    let existing = getAccount(payload.email)
    if (!hasMail && !existing) {
      existing = targetEmail ? getAccount(targetEmail) : null
      if (!existing) {
        return res.status(409).json({ error: 'This GNOME account only has Calendar/Contacts. Add or select the mail account it belongs to first, then import it again.', code: 'goa_needs_mail_account' })
      }
    }
    if (existing && !hasMail) delete payload.email
    const acct = existing ? updateAccount(existing.email, payload) : addAccount(payload)
    dropPool(acct.email)
    clearDavBaseCache()
    res.json({ success: true, id: acct.id, email: acct.email })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router
