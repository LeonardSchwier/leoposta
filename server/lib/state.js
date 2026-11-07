import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const SERVER_DIR = path.dirname(path.dirname(__filename))

export const DATA_DIR = process.env.LEOPOSTA_DATA_DIR || SERVER_DIR
export const ACCOUNT_FILE = path.join(DATA_DIR, 'account.json')
export const SCHEDULED_FILE = path.join(DATA_DIR, 'scheduled.json')
export const RULES_FILE = path.join(DATA_DIR, 'rules.json')

export const API_TOKEN = process.env.LEOPOSTA_TOKEN
  || crypto.randomBytes(32).toString('hex')
export const TOKEN_FROM_ENV = !!process.env.LEOPOSTA_TOKEN
export const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS
  || 'http://localhost:3000,http://127.0.0.1:3000,http://localhost:3001,http://127.0.0.1:3001')
  .split(',').map(s => s.trim()).filter(Boolean)

// Mutable shared state — every route module reads/writes through this.
export const state = {
  account: null,
  scheduledMessages: [],
  rules: []
}

if (fs.existsSync(ACCOUNT_FILE)) {
  state.account = JSON.parse(fs.readFileSync(ACCOUNT_FILE, 'utf-8'))
}
if (fs.existsSync(SCHEDULED_FILE)) {
  state.scheduledMessages = JSON.parse(fs.readFileSync(SCHEDULED_FILE, 'utf-8'))
}
if (fs.existsSync(RULES_FILE)) {
  state.rules = JSON.parse(fs.readFileSync(RULES_FILE, 'utf-8'))
}

export function saveRules() {
  fs.writeFileSync(RULES_FILE, JSON.stringify(state.rules, null, 2), { mode: 0o600 })
}

export function applyEnvPasswords() {
  if (!state.account) return
  if (process.env.LEOPOSTA_IMAP_PASS) state.account.imapPass = process.env.LEOPOSTA_IMAP_PASS
  if (process.env.LEOPOSTA_SMTP_PASS) state.account.smtpPass = process.env.LEOPOSTA_SMTP_PASS
}
applyEnvPasswords()

export function saveAccount() {
  if (!state.account) return
  const toSave = { ...state.account }
  if (process.env.LEOPOSTA_IMAP_PASS) delete toSave.imapPass
  if (process.env.LEOPOSTA_SMTP_PASS) delete toSave.smtpPass
  fs.writeFileSync(ACCOUNT_FILE, JSON.stringify(toSave, null, 2), { mode: 0o600 })
}

export function saveScheduled() {
  fs.writeFileSync(SCHEDULED_FILE, JSON.stringify(state.scheduledMessages, null, 2), { mode: 0o600 })
}
