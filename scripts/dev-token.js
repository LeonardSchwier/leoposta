import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// Repo root is one level up from scripts/.
export const ROOT_DIR = path.resolve(__dirname, '..')
export const DEV_TOKEN_FILE = path.join(ROOT_DIR, 'server', '.dev-token')

/**
 * Resolve the local dev API token.
 *
 * Priority: LEOPOSTA_TOKEN env → server/.dev-token file → (when persist=true)
 * generate and persist a new one → null.
 *
 * The server/.dev-token file is created once per machine and shared by both
 * the Node server (server/lib/state.js) and the Vite build (vite.config.ts),
 * so you can run `npm run server` and `npm run dev` in two separate terminal
 * windows without any extra env wiring.
 */
export function resolveDevToken({ persist = false } = {}) {
  if (process.env.LEOPOSTA_TOKEN && process.env.LEOPOSTA_TOKEN.length) {
    return process.env.LEOPOSTA_TOKEN
  }
  if (fs.existsSync(DEV_TOKEN_FILE)) {
    const v = fs.readFileSync(DEV_TOKEN_FILE, 'utf-8').trim()
    if (v.length) return v
  }
  if (!persist) return null
  const token = crypto.randomBytes(32).toString('hex')
  try {
    fs.mkdirSync(path.dirname(DEV_TOKEN_FILE), { recursive: true })
    // wx = exclusive create: exactly one of two concurrent writers wins.
    fs.writeFileSync(DEV_TOKEN_FILE, token, { mode: 0o600, flag: 'wx' })
    return token
  } catch (e) {
    if (e && e.code === 'EEXIST') {
      const existing = fs.readFileSync(DEV_TOKEN_FILE, 'utf-8').trim()
      if (existing.length) return existing
    }
    return token
  }
}

// When run directly (node scripts/dev-token.js), ensure the shared token file
// exists so the next command in the npm script can read it.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  resolveDevToken({ persist: true })
}
