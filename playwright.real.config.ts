import { defineConfig, devices } from '@playwright/test'

// Real-stack e2e: the app against a real Dovecot (IMAP), Radicale (DAV) and an
// SMTP sink (tests/stack/). Run via `npm run test:e2e:real`, which builds both
// frontends and brings the stack up first (tests/stack/run-e2e.sh).
//
// Both projects use the production single-port layout (server/index.js serves
// the built app + API on one origin): "pwa" with the build-time token,
// "desktop" with the desktop build and the token injected like the Tauri
// shell does. Every test gets its own fresh mailbox (see fixtures.ts).
export const E2E_TOKEN = 'e2e-real-token'
const PWA_PORT = 3201
const DESKTOP_PORT = 3202

function server(port: number, dist: string, data: string) {
  return {
    command: `rm -rf ${data} && mkdir -p ${data} && node server/index.js`,
    env: {
      PORT: String(port),
      HOST: '127.0.0.1',
      LEOPOSTA_TOKEN: E2E_TOKEN,
      LEOPOSTA_DATA_DIR: data,
      LEOPOSTA_DIST_DIR: dist,
      ALLOWED_ORIGINS: `http://127.0.0.1:${port}`
    },
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    stdout: 'pipe' as const,
    stderr: 'pipe' as const
  }
}

export default defineConfig({
  testDir: './tests/e2e-real',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: '.e2e-real/report' }]],
  outputDir: '.e2e-real/results',
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'pwa', use: { ...devices['Desktop Chrome'], baseURL: `http://127.0.0.1:${PWA_PORT}`, desktop: false } },
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1180, height: 780 }, baseURL: `http://127.0.0.1:${DESKTOP_PORT}`, desktop: true } }
  ],
  webServer: [
    server(PWA_PORT, 'dist-e2e', '.e2e-real/data-pwa'),
    server(DESKTOP_PORT, 'dist-e2e-desktop', '.e2e-real/data-desktop')
  ]
})
