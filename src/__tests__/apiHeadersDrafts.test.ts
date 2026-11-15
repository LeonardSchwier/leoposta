import { describe, it, expect, afterEach } from 'vitest'
import { apiFetch, MailAPI, setActiveAccountEmail } from '../api'

// A caller passing its own Content-Type ({ 'Content-Type': 'application/json' },
// as Compose does) must not end up with "application/json, application/json":
// express.json() does not recognise that type and leaves req.body undefined.
describe('authHeaders merging', () => {
  const orig = globalThis.fetch
  afterEach(() => { globalThis.fetch = orig; setActiveAccountEmail(null) })

  function capture(): { headers: () => Headers } {
    let init: any
    globalThis.fetch = ((_: any, i?: any) => {
      init = i
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true }) })
    }) as any
    return { headers: () => new Headers(init.headers) }
  }

  it('a caller-supplied Content-Type replaces the default instead of being appended', async () => {
    const c = capture()
    await apiFetch('/api/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    expect(c.headers().get('content-type')).toBe('application/json')
  })

  it('keeps the token and account headers on the drafts call', async () => {
    setActiveAccountEmail('me@example.test')
    const c = capture()
    await MailAPI.saveDraft({ subject: 'x' })
    expect(c.headers().get('content-type')).toBe('application/json')
    expect(c.headers().get('x-account')).toBe('me@example.test')
    expect(c.headers().has('x-leoposta-token')).toBe(true)
  })
})
