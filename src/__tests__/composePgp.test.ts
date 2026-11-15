// @vitest-environment jsdom
// Compose → Sign / Encrypt: the send carries pgp: { sign, encrypt }; a
// missing recipient key or no own key stops it before /api/send with a clear
// message; a locked key asks for the passphrase, unlocks, then sends.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount, unmount, flushSync } from 'svelte'
import Compose from '../components/Compose.svelte'
import { clearCompose, setComposeTo } from '../store'
import { pgpSendProblem, type PgpStatus } from '../lib/pgp'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Call { url: string, method: string, body: unknown, account: string | null }

function stub(opts: { status: PgpStatus, missing?: string[], unlockOk?: (pass: string) => boolean }) {
  const calls: Call[] = []
  let status = { ...opts.status }
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input)
    const headers = new Headers(init.headers)
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, method: init.method || 'GET', body, account: headers.get('x-account') })
    const ok = (data: unknown, s = 200) => ({ ok: s < 400, status: s, json: async () => data }) as Response
    if (url.includes('/api/pgp/status')) return ok(status)
    if (url.includes('/api/pgp/lookup')) {
      const missing = (opts.missing || []).filter(m => (body as { recipients: string[] }).recipients.includes(m))
      return ok({ found: [], missing })
    }
    if (url.includes('/api/pgp/unlock')) {
      if (opts.unlockOk?.((body as { passphrase: string }).passphrase)) { status = { ...status, unlocked: true }; return ok({ ok: true }) }
      return ok({ error: 'bad_passphrase' }, 401)
    }
    if (url.includes('/api/account')) return ok({ connected: true, signature: { enabled: false, text: '' } })
    if (url.includes('/api/send')) return ok({ success: true, messageId: '<m@x>' })
    return ok({}, 404)
  }) as typeof fetch
  return calls
}

const KEY: PgpStatus = { hasPrivateKey: true, hasPublicKey: true, hasPassphrase: true, unlocked: true }

let target: HTMLDivElement
beforeEach(() => {
  clearCompose()
  target = document.createElement('div')
  document.body.appendChild(target)
})
afterEach(() => target.remove())

function check(label: 'Sign' | 'Encrypt') {
  const box = Array.from(target.querySelectorAll('label.pgp-toggle')).find(l => l.textContent?.trim() === label)!.querySelector('input') as HTMLInputElement
  box.click()
  flushSync()
}
const sendBtn = () => Array.from(target.querySelectorAll('button')).find(b => b.textContent?.trim() === 'Send') as HTMLButtonElement
const sends = (calls: Call[]) => calls.filter(c => c.url.includes('/api/send'))

describe('Compose with Sign / Encrypt', () => {
  it('sends pgp: { sign: true, encrypt: true } once the keys check out', async () => {
    const calls = stub({ status: KEY })
    setComposeTo(['bob@example.test'])
    const c = mount(Compose, { target, props: { onClose: () => {} } })
    await sleep(50)
    check('Sign'); check('Encrypt')
    sendBtn().click()
    await sleep(50)
    expect(sends(calls)).toHaveLength(1)
    expect((sends(calls)[0].body as { pgp: unknown }).pgp).toEqual({ sign: true, encrypt: true })
    unmount(c)
  })

  it('a recipient without a key: clear error, nothing sent; the live hint names them', async () => {
    const calls = stub({ status: KEY, missing: ['nokey@example.test'] })
    setComposeTo(['bob@example.test', 'nokey@example.test'])
    const c = mount(Compose, { target, props: { onClose: () => {} } })
    await sleep(50)
    check('Encrypt')
    await sleep(400)
    expect(target.querySelector('[data-testid="pgp-missing"]')?.textContent).toContain('nokey@example.test')
    sendBtn().click()
    await sleep(50)
    expect(sends(calls)).toHaveLength(0)
    expect(target.querySelector('.send-error')?.textContent).toMatch(/No PGP public key for nokey@example\.test/)
    unmount(c)
  })

  it('a locked key: asks for the passphrase (wrong one stays), then unlocks and sends', async () => {
    const calls = stub({ status: { ...KEY, unlocked: false }, unlockOk: (p) => p === 'right' })
    setComposeTo(['bob@example.test'])
    const c = mount(Compose, { target, props: { onClose: () => {} } })
    await sleep(50)
    check('Sign')
    sendBtn().click()
    await sleep(50)
    expect(sends(calls)).toHaveLength(0)
    const pass = target.querySelector('#compose-pgp-pass') as HTMLInputElement
    expect(pass).not.toBeNull()
    const submit = () => (Array.from(target.querySelectorAll('button')).find(b => b.textContent?.trim() === 'Unlock and send') as HTMLButtonElement).click()
    pass.value = 'wrong'; pass.dispatchEvent(new Event('input')); flushSync()
    submit()
    await sleep(50)
    expect(target.querySelector('.pgp-pass .send-error')?.textContent).toMatch(/Wrong passphrase/)
    expect(sends(calls)).toHaveLength(0)
    pass.value = 'right'; pass.dispatchEvent(new Event('input')); flushSync()
    submit()
    await sleep(100)
    expect(sends(calls)).toHaveLength(1)
    expect((sends(calls)[0].body as { pgp: unknown }).pgp).toEqual({ sign: true, encrypt: false })
    unmount(c)
  })

  it('without Sign/Encrypt nothing PGP is sent', async () => {
    const calls = stub({ status: KEY })
    setComposeTo(['bob@example.test'])
    const c = mount(Compose, { target, props: { onClose: () => {} } })
    await sleep(50)
    sendBtn().click()
    await sleep(50)
    expect(sends(calls)).toHaveLength(1)
    expect((sends(calls)[0].body as { pgp?: unknown }).pgp).toBeUndefined()
    unmount(c)
  })
})

describe('pgpSendProblem', () => {
  const on = { sign: true, encrypt: true }
  it('nothing to check when both are off', () => {
    expect(pgpSendProblem({ sign: false, encrypt: false }, null, ['x'])).toBeNull()
  })
  it('scheduled, no own key, missing keys, locked, ok', () => {
    expect(pgpSendProblem(on, KEY, [], { scheduled: true })).toMatch(/cannot be scheduled/)
    expect(pgpSendProblem({ sign: false, encrypt: true }, { ...KEY, hasPrivateKey: false }, [], { accountEmail: 'me@x' })).toMatch(/No PGP key is set up for me@x.*copy in Sent/)
    expect(pgpSendProblem(on, KEY, ['a@x', 'b@x'])).toMatch(/No PGP public key for a@x, b@x/)
    expect(pgpSendProblem(on, { ...KEY, unlocked: false }, [])).toBe('locked')
    expect(pgpSendProblem({ sign: false, encrypt: true }, { ...KEY, unlocked: false }, [])).toBeNull()
    expect(pgpSendProblem(on, { ...KEY, hasPassphrase: false, unlocked: false }, [])).toBeNull()
    expect(pgpSendProblem(on, KEY, [])).toBeNull()
  })
})
