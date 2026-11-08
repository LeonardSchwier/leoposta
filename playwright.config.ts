import { defineConfig, devices } from '@playwright/test'

const TOKEN = 'test-token'
// Dedicated ports so e2e never collides with a running dev stack.
const IMAP_PORT = 1243
const API_PORT = 3101
const WEB_PORT = 3100

const SHOTS = process.env.SCREENSHOTS === '1'

export default defineConfig({
  testDir: SHOTS ? './tests/screenshots' : './tests/e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${WEB_PORT}`, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node scripts/dummy/imap.cjs',
      env: { LEO_IMAP_SEED: SHOTS ? 'tests/screenshots/seed.json' : 'tests/e2e/seed.json', IMAP_PORT: String(IMAP_PORT) },
      port: IMAP_PORT,
      reuseExistingServer: false
    },
    {
      command: 'rm -rf .e2e-data && mkdir -p .e2e-data && node server/index.js',
      env: { LEOPOSTA_TOKEN: TOKEN, LEOPOSTA_DATA_DIR: '.e2e-data', PORT: String(API_PORT), ALLOWED_ORIGINS: `http://127.0.0.1:${WEB_PORT}` },
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      reuseExistingServer: false
    },
    {
      command: `npx vite build && npx vite preview --port ${WEB_PORT} --host 127.0.0.1`,
      env: { VITE_LEOPOSTA_TOKEN: TOKEN, LEOPOSTA_API_URL: `http://127.0.0.1:${API_PORT}` },
      url: `http://127.0.0.1:${WEB_PORT}`,
      timeout: 120000,
      reuseExistingServer: false
    }
  ]
})
