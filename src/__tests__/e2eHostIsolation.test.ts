// Every e2e server must run with LEOPOSTA_GOA=off. Otherwise it asks the
// host's session D-Bus and Settings lists the developer's own GNOME Online
// Accounts: the result of the run depends on the machine.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

type WebServer = { command: string, env?: Record<string, string> }

describe('e2e servers never read the host GNOME Online Accounts', () => {
  for (const config of ['playwright.config.ts', 'playwright.real.config.ts']) {
    it(`${config}: every backend web server sets LEOPOSTA_GOA=off`, async () => {
      const servers = ((await import(path.join(root, config))).default.webServer as WebServer[])
        .filter((s) => s.command.includes('server/index.js'))
      expect(servers.length).toBeGreaterThan(0)
      for (const s of servers) expect(s.env?.LEOPOSTA_GOA, s.command).toBe('off')
    })
  }

  it('every other place that starts the backend for a test sets it too', () => {
    const files = [
      ...fs.readdirSync(path.join(root, 'tests/e2e-real')).map((f) => `tests/e2e-real/${f}`),
      ...fs.readdirSync(path.join(root, 'tests/e2e')).map((f) => `tests/e2e/${f}`),
      ...fs.readdirSync(path.join(root, 'tests/desktop')).map((f) => `tests/desktop/${f}`)
    ]
    const starters = files.filter((f) => /server\/index\.js|target\/release\/leoposta/.test(fs.readFileSync(path.join(root, f), 'utf-8')))
    expect(starters).toEqual(expect.arrayContaining(['tests/e2e-real/accounts.spec.ts', 'tests/desktop/run-desktop-smoke.sh', 'tests/desktop/tauri-lifecycle.sh']))
    for (const f of starters) expect(fs.readFileSync(path.join(root, f), 'utf-8'), f).toMatch(/LEOPOSTA_GOA[=:]\s*'?off/)
  })
})
