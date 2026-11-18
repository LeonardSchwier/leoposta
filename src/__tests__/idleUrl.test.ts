import { describe, it, expect, vi, afterEach } from 'vitest'

// The IDLE stream cannot send headers, so its URL carries the token and the
// account as query parameters. The account was appended with `&`, which is only
// right when the token already started the query string.
describe('MailAPI.idle() URL', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })

  async function idleUrl(token: string, account: string | null) {
    vi.stubEnv('VITE_LEOPOSTA_TOKEN', token)
    vi.resetModules()
    const api = await import('../api/index')
    api.setActiveAccountEmail(account)
    return api.MailAPI.idle()
  }

  it('starts the query string with ? for the account when there is no token', async () => {
    expect(await idleUrl('', 'erika@example.test')).toBe('/api/idle?account=erika%40example.test')
  })

  it('adds the account after the token with &', async () => {
    expect(await idleUrl('t0k', 'erika@example.test')).toBe('/api/idle?token=t0k&account=erika%40example.test')
  })

  it('has no account parameter without an active account', async () => {
    expect(await idleUrl('t0k', null)).toBe('/api/idle?token=t0k')
    expect(await idleUrl('', null)).toBe('/api/idle')
  })
})
