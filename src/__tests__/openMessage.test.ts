import { describe, it, expect, vi } from 'vitest'
import { loadMessageBody, keepLoadedBodies, GONE_TEXT, type OpenMessageDeps } from '../lib/openMessage'
import type { MailMessage } from '../store'

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function setup(fetchMessage: OpenMessageDeps['fetchMessage']) {
  const ctx = { activeFolder: 'INBOX', activeAccountId: 'a1' as string | null }
  const update = vi.fn()
  const deps: OpenMessageDeps = { fetchMessage, context: () => ctx, update, cachePut: vi.fn(async () => {}), cacheGet: vi.fn(async () => undefined) }
  return { ctx, update, deps }
}

const msg = (id: string, folder: string, extra: Partial<MailMessage> = {}): MailMessage =>
  ({ id, folder, from: 'a', to: [], subject: id, body: '', date: '', flags: [], headers: {}, ...extra })

describe('loadMessageBody', () => {
  it('applies the body and marks it loaded', async () => {
    const { update, deps } = setup(async () => ({ body: 'hi', bodyHtml: '', attachments: [], flags: ['\\Seen'] }))
    await loadMessageBody('1', deps)
    expect(update).toHaveBeenCalledWith('1', expect.objectContaining({ body: 'hi', bodyLoaded: true, flags: ['\\Seen'] }))
  })

  it('drops an answer that arrives after the user switched folder (same UID elsewhere)', async () => {
    const d = deferred<any>()
    const { ctx, update, deps } = setup(() => d.promise)
    const p = loadMessageBody('1', deps)
    ctx.activeFolder = 'Archive'
    d.resolve({ body: 'INBOX BODY' })
    await p
    expect(update).not.toHaveBeenCalled()
  })

  it('drops an answer that arrives after the user switched account', async () => {
    const d = deferred<any>()
    const { ctx, update, deps } = setup(() => d.promise)
    const p = loadMessageBody('1', deps)
    ctx.activeAccountId = 'a2'
    d.resolve({ body: 'other account' })
    await p
    expect(update).not.toHaveBeenCalled()
  })

  it('says the message is gone on a 404', async () => {
    const { update, deps } = setup(async () => { throw Object.assign(new Error('message_not_found'), { status: 404 }) })
    await loadMessageBody('1', deps)
    expect(update).toHaveBeenCalledWith('1', expect.objectContaining({ loadError: GONE_TEXT, bodyLoaded: true }))
  })

  it('falls back to the full cached copy when the server is unreachable', async () => {
    const { update, deps } = setup(async () => { throw new TypeError('Failed to fetch') })
    deps.cacheGet = async () => ({ full: true, message: { body: 'cached body' } })
    await loadMessageBody('1', deps)
    expect(update).toHaveBeenCalledWith('1', expect.objectContaining({ body: 'cached body', bodyLoaded: true }))
  })

  it('shows an error instead of an empty body when nothing is cached', async () => {
    const { update, deps } = setup(async () => { throw Object.assign(new Error('Command failed'), { status: 500 }) })
    await loadMessageBody('1', deps)
    expect(update).toHaveBeenCalledWith('1', expect.objectContaining({ loadError: expect.stringContaining('Command failed') }))
  })
})

describe('keepLoadedBodies', () => {
  it('a refreshed list keeps the body of an opened message', () => {
    const prev = [msg('1', 'INBOX', { body: 'opened', bodyLoaded: true, attachments: [{ id: '0', filename: 'a', contentType: '', size: 1 }] }), msg('2', 'INBOX')]
    const next = [msg('3', 'INBOX'), msg('1', 'INBOX', { flags: ['\\Seen'] }), msg('2', 'INBOX')]
    const out = keepLoadedBodies(prev, next)
    expect(out.map((m) => m.id)).toEqual(['3', '1', '2'])
    expect(out[1]).toMatchObject({ body: 'opened', bodyLoaded: true, flags: ['\\Seen'] })
    expect(out[1].attachments?.[0].id).toBe('0')
    expect(out[2].bodyLoaded).toBeUndefined()
  })

  it('does not carry a body to the same UID in another folder', () => {
    const out = keepLoadedBodies([msg('1', 'INBOX', { body: 'x', bodyLoaded: true })], [msg('1', 'Archive')])
    expect(out[0].body).toBe('')
  })
})

describe('loadMessageBody with onGone', () => {
  it('a 404 goes to onGone (the app drops the row) instead of the gone pane', async () => {
    const update = vi.fn()
    const onGone = vi.fn()
    await loadMessageBody('7', {
      fetchMessage: async () => { throw Object.assign(new Error('message_not_found'), { status: 404 }) },
      context: () => ({ activeFolder: 'INBOX', activeAccountId: 'a' }),
      update,
      onGone
    })
    expect(onGone).toHaveBeenCalledWith('7')
    expect(update).not.toHaveBeenCalled()
  })
})
