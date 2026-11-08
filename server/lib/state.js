import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const SERVER_DIR = path.dirname(path.dirname(__filename))

export const DATA_DIR = process.env.LEOPOSTA_DATA_DIR || SERVER_DIR
export const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json')
export const LEGACY_ACCOUNT_FILE = path.join(DATA_DIR, 'account.json')
export const SCHEDULED_FILE = path.join(DATA_DIR, 'scheduled.json')
export const RULES_FILE = path.join(DATA_DIR, 'rules.json')
export const DEV_TOKEN_FILE = path.join(SERVER_DIR, '.dev-token')

// Read the shared local dev token (server/.dev-token) if present. Created once
// per machine (see scripts/dev-token.js) and shared with the Vite build so the
// backend and frontend agree on the token without extra env wiring.
function readDevTokenFile() {
  try {
    const v = fs.readFileSync(DEV_TOKEN_FILE, 'utf-8').trim()
    return v.length ? v : ''
  } catch { return '' }
}
function writeDevTokenFile(token) {
  try {
    fs.writeFileSync(DEV_TOKEN_FILE, token, { mode: 0o600, flag: 'wx' })
    return token
  } catch (e) {
    if (e && e.code === 'EEXIST') {
      const existing = readDevTokenFile()
      if (existing.length) return existing
    }
    return token
  }
}

// Token priority: LEOPOSTA_TOKEN env → server/.dev-token file → generate and
// persist a new one (shared with the Vite build so frontend + backend agree).
const fileToken = readDevTokenFile()
export const API_TOKEN = process.env.LEOPOSTA_TOKEN
  || fileToken
  || writeDevTokenFile(crypto.randomBytes(32).toString('hex'))
export const TOKEN_FROM_ENV = !!process.env.LEOPOSTA_TOKEN
export const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS
  || 'http://localhost:3000,http://127.0.0.1:3000,http://localhost:3001,http://127.0.0.1:3001')
  .split(',').map(s => s.trim()).filter(Boolean)

// Mutable shared state — every route module reads/writes through this.
export const state = {
  accounts: [],
  scheduledMessages: [],
  rules: []
}

// Load accounts: prefer accounts.json; fall back to legacy account.json
if (fs.existsSync(ACCOUNTS_FILE)) {
  state.accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf-8'))
} else if (fs.existsSync(LEGACY_ACCOUNT_FILE)) {
  const legacy = JSON.parse(fs.readFileSync(LEGACY_ACCOUNT_FILE, 'utf-8'))
  state.accounts = [{ ...legacy, id: legacy.id || 'acct-legacy' }]
  saveAccounts()
  try { fs.unlinkSync(LEGACY_ACCOUNT_FILE) } catch {}
}
if (fs.existsSync(SCHEDULED_FILE)) {
  state.scheduledMessages = JSON.parse(fs.readFileSync(SCHEDULED_FILE, 'utf-8'))
}
if (fs.existsSync(RULES_FILE)) {
  state.rules = JSON.parse(fs.readFileSync(RULES_FILE, 'utf-8'))
}

// ── Accessors ────────────────────────────────────────────────────────────────
export function getAccount(email) {
  if (!email || !state.accounts.length) return null
  return state.accounts.find(a => (a.email || '').toLowerCase() === String(email).toLowerCase()) || null
}

export function getActiveAccount() {
  return state.accounts[0] || null
}

/**
 * Resolve the account for an HTTP request.
 * x-account header (an email address) wins; otherwise the first account.
 * Returns null if no account is configured.
 */
export function resolveAccount(req) {
  const header = req && req.headers && req.headers['x-account']
  if (header) {
    return getAccount(header)
  }
  return getActiveAccount()
}

// ── Save helpers ─────────────────────────────────────────────────────────────
function stripEnvPasswordsBeforePersist(accounts) {
  return accounts.map((a, i) => {
    const cp = { ...a }
    if (i === 0) {
      if (process.env.LEOPOSTA_IMAP_PASS) delete cp.imapPass
      if (process.env.LEOPOSTA_SMTP_PASS) delete cp.smtpPass
    }
    return cp
  })
}

function restoreEnvPasswordsForRuntime(accounts) {
  return accounts.map((a, i) => {
    if (i !== 0) return a
    const out = { ...a }
    if (process.env.LEOPOSTA_IMAP_PASS) out.imapPass = process.env.LEOPOSTA_IMAP_PASS
    if (process.env.LEOPOSTA_SMTP_PASS) out.smtpPass = process.env.LEOPOSTA_SMTP_PASS
    return out
  })
}

export function saveAccounts() {
  fs.writeFileSync(ACCOUNTS_FILE,
    JSON.stringify(stripEnvPasswordsBeforePersist(state.accounts), null, 2),
    { mode: 0o600 }
  )
}

export function saveRules() {
  fs.writeFileSync(RULES_FILE, JSON.stringify(state.rules, null, 2), { mode: 0o600 })
}

export function saveScheduled() {
  fs.writeFileSync(SCHEDULED_FILE, JSON.stringify(state.scheduledMessages, null, 2), { mode: 0o600 })
}

// ── Payload builder ──────────────────────────────────────────────────────────
function accountPayloadFrom(body) {
  return {
    email: body.email,
    name: body.name || body.email,
    imapHost: body.imapHost,
    imapPort: Number(body.imapPort) || 993,
    imapTls: body.imapTls !== false,
    imapUser: body.imapUser,
    imapPass: body.imapPass,
    smtpHost: body.smtpHost,
    smtpPort: Number(body.smtpPort) || 465,
    smtpTls: body.smtpTls !== false,
    smtpUser: body.smtpUser,
    smtpPass: body.smtpPass,
    signature: body.signature || { enabled: false, text: '', position: 'standard' }
  }
}

// ── Account CRUD (persistence helpers used by routes) ────────────────────────
export function addAccount(body) {
  const acct = {
    id: body.id || `acct-${crypto.randomUUID().slice(0, 8)}`,
    ...accountPayloadFrom(body)
  }
  state.accounts.push(acct)
  saveAccounts()
  state.accounts[state.accounts.length - 1] = restoreEnvPasswordsForRuntime(state.accounts).pop()
  return state.accounts[state.accounts.length - 1]
}

export function updateAccount(email, body) {
  const idx = state.accounts.findIndex(a => (a.email || '').toLowerCase() === String(email).toLowerCase())
  if (idx === -1) return null
  const fresh = accountPayloadFrom(body)
  // Merge: fresh wins on email/name/etc. Password only comes from body (never
  // from the inherited in-memory first-slot env override, so we don't persist
  // a stale env secret to a non-first account).
  const cur = state.accounts[idx]
  const merged = {
    ...cur,
    ...fresh,
    email: cur.email,
    id: cur.id,
    imapPass: body.imapPass !== undefined ? body.imapPass : (cur.imapPass !== undefined ? cur.imapPass : undefined),
    smtpPass: body.smtpPass !== undefined ? body.smtpPass : (cur.smtpPass !== undefined ? cur.smtpPass : undefined)
  }
  delete merged.email
  merged.email = cur.email
  state.accounts[idx] = merged
  saveAccounts()
  state.accounts[idx] = restoreEnvPasswordsForRuntime(state.accounts)[idx]
  return state.accounts[idx]
}

export function removeAccount(email) {
  const before = state.accounts.length
  state.accounts = state.accounts.filter((a) => (a.email || '').toLowerCase() !== String(email).toLowerCase())
  if (state.accounts.length !== before) saveAccounts()
  return state.accounts.length !== before
}
