import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONF_PATH = path.resolve(__dirname, '../../src-tauri/tauri.conf.json')
const config = JSON.parse(fs.readFileSync(CONF_PATH, 'utf-8')) as {
  app: { security: { csp: string | null } }
}
const csp: string = config.app.security.csp

describe('tauri.conf.json CSP', () => {
  it('is a non-null string', () => {
    expect(typeof csp).toBe('string')
    expect(csp!.length).toBeGreaterThan(0)
  })

  it('contains default-src self', () => {
    expect(csp).toContain("default-src 'self'")
  })

  it('disables object-src', () => {
    expect(csp).toContain("object-src 'none'")
  })

  it('disables frame-src', () => {
    expect(csp).toContain("frame-src 'none'")
  })

  it('does not allow unsafe-inline scripts', () => {
    expect(csp).not.toContain("script-src 'unsafe-inline'")
  })
})
