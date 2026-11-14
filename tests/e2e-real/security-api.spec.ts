import http from 'node:http'
import { test, expect, TOKEN } from './fixtures'

// Audit run-2 (~/security-audit-skill/leoposta/run-2): the local server's
// browser-facing boundary, against the real single-port server.

function raw(baseURL: string, path: string, headers: Record<string, string>, method = 'GET', body?: string) {
  const u = new URL(baseURL)
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string }>((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: Number(u.port), path, method, headers }, (res) => {
      let text = ''
      res.on('data', (c) => (text += c))
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, text }))
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

test('DNS rebinding: a foreign Host header reaches neither the bundle nor the API', async ({ baseURL }) => {
  const host = { host: `rebind.attacker.example:${new URL(baseURL!).port}` }
  const doc = await raw(baseURL!, '/', host)
  expect(doc.status).toBe(403)
  const api = await raw(baseURL!, '/api/accounts', { ...host, 'x-leoposta-token': TOKEN })
  expect(api.status).toBe(403)
  expect(JSON.parse(api.text)).toEqual({ error: 'host_not_allowed' })
  // The app's own host still works.
  expect((await raw(baseURL!, '/api/accounts', { 'x-leoposta-token': TOKEN })).status).toBe(200)
})

test('a page on localhost:3000 is not trusted with the token or the API', async ({ baseURL }) => {
  const origin = { origin: 'http://localhost:3000' }
  const doc = await raw(baseURL!, '/', origin)
  expect(doc.status).toBe(403)
  expect(doc.headers['access-control-allow-origin']).toBeUndefined()
  const post = await raw(baseURL!, '/api/accounts', { ...origin, 'x-leoposta-token': TOKEN, 'content-type': 'application/json' }, 'POST', JSON.stringify({ email: 'evil@example.test' }))
  expect(post.status).toBe(403)
})

test('the app is served with a strict CSP and still works under it', async ({ app, mailbox, baseURL }) => {
  const doc = await raw(baseURL!, '/', {})
  const csp = String(doc.headers['content-security-policy'] || '')
  expect(csp).toContain("script-src 'self'")
  expect(csp).toContain("object-src 'none'")
  expect(csp).toContain("frame-ancestors 'none'")
  // The fixture fails the test on any console error, CSP violations included.
  await mailbox.seed('INBOX', [{ subject: 'CSP check', html: '<p>Rendered <b>under</b> the CSP</p>' }])
  await app.reload()
  await app.getByText('CSP check').first().click({ position: { x: 2, y: 2 } })
  await expect(app.locator('.message-content').getByText('under')).toBeVisible()
})
