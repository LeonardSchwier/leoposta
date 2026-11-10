import express from 'express'
import cors from 'cors'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { requireToken } from './lib/auth.js'
import { API_TOKEN, TOKEN_FROM_ENV, ALLOWED_ORIGINS, state } from './lib/state.js'

import accountRoutes from './routes/account.js'
import mailRoutes from './routes/mail.js'
import rulesRoutes from './routes/rules.js'
import calendarRoutes from './routes/calendar.js'
import carddavRoutes from './routes/carddav.js'
import pgpRoutes from './routes/pgp.js'
import sendRoutes, { processScheduledMessages } from './routes/send.js'
import idleRoutes from './routes/idle.js'

import { processPgp } from './lib/pgp.js'

const app = express()

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true)
    cb(new Error('Not allowed by CORS'), false)
  }
}))

app.get('/api/health', (req, res) => res.json({ ok: true }))
app.use('/api', requireToken(API_TOKEN))

// Behind the token: it lists the configured mailbox addresses. Only /api/health is open.
app.get('/api/status', (req, res) => {
  const accounts = state.accounts || []
  res.json({
    connected: accounts.length > 0,
    account: accounts.length > 0 ? accounts[0].email : null,
    accounts: accounts.map(a => a.email),
    version: '0.1.0'
  })
})

const defaultJson = express.json({ limit: '1mb' })
// /api/send carries attachments (25 MB is ~33.4 MB as base64): it gets its own parser inline.
app.use((req, res, next) => (req.path === '/api/send' ? next() : defaultJson(req, res, next)))

app.use('/api', accountRoutes)
app.use('/api', mailRoutes)
app.use('/api', rulesRoutes)
app.use('/api', calendarRoutes)
app.use('/api', carddavRoutes)
app.use('/api', pgpRoutes)
app.use('/api', sendRoutes)
app.use('/api', idleRoutes)

// Serve the pre-built PWA (dist/) when present — single-port deploy.
const DIST_DIR = path.resolve(new URL('..', import.meta.url).pathname, 'dist')
if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR, { maxAge: '1h' }))
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(DIST_DIR, 'index.html')))
  console.log(`Serving PWA from ${DIST_DIR}`)
}

// Body-too-large -> 413 JSON
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'too_large' })
  next(err)
})

export { processPgp }
export { processScheduledMessages }

export function createApp() {
  return app
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  setInterval(processScheduledMessages, 30000)

  const PORT = parseInt(process.env.PORT || '3001', 10)
  const HOST = process.env.HOST || '127.0.0.1'
  app.listen(PORT, HOST, () => {
    if (!TOKEN_FROM_ENV) console.log(`API token (send as x-leoposta-token): ${API_TOKEN}`)
    console.log(`Mail server running on http://${HOST}:${PORT}`)
    console.log(`Accounts: ${state.accounts.length ? state.accounts.map(a => a.email).join(', ') : 'not configured'}`)
    console.log(`Scheduled messages: ${state.scheduledMessages.length}`)
  })
}
