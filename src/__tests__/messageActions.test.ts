import { describe, it, expect, beforeEach, vi } from 'vitest'
import { runMessageAction, isBusy } from '../lib/messageActions'
import { moveTargets } from '../lib/moveTargets'
import { getState, setActiveFolder, setFolders, setMessages, selectMessage, type MailMessage } from '../store'

// Message actions name the message they act on, update the list at once,
// roll back when the server refuses, drop a message that is gone (404), never
// run twice at once, and archive / junk through the server's special-use
// mailbox instead of a hard-coded "Archive".

type Call = { url: string, method: string, body: any }
let calls: Call[]
let respond: (c: Call) => { status: number, body: any }

function msg(id: string, flags: string[] = []): MailMessage {
  return { id, from: 'a', to: [], subject: `S${id}`, body: '', date: '2026-11-01T00:00:00Z', flags, folder: 'INBOX', headers: {} }
}

beforeEach(() => {
  calls = []
  respond = () => ({ status: 200, body: { success: true, trashed: true, folder: 'INBOX.Archive' } })
  globalThis.fetch = vi.fn(async (input: any, init?: any) => {
    const c = { url: String(input), method: init?.method || 'GET', body: init?.body ? JSON.parse(init.body) : undefined }
    calls.push(c)
    const r = respond(c)
    return { ok: r.status < 400, status: r.status, statusText: 'x', json: async () => r.body } as any
  }) as any
  setActiveFolder('INBOX')
  setFolders([
    { id: 'INBOX', name: 'INBOX' },
    { id: 'INBOX.Archive', name: 'Archive', specialUse: '\\Archive', parentId: 'INBOX', delimiter: '.' },
    { id: 'INBOX.Junk', name: 'Junk', specialUse: '\\Junk', parentId: 'INBOX', delimiter: '.' }
  ])
  setMessages([msg('1', ['\\Seen']), msg('2'), msg('3')])
  selectMessage('1')
})

const hooks = () => ({ notify: vi.fn(), changed: vi.fn() })
const ids = () => getState().messages.map((m) => m.id)

describe('runMessageAction', () => {
  it('stars the message it is given, not the selected one', async () => {
    const h = hooks()
    expect(await runMessageAction('2', 'star', h)).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain('/api/message/2/flags')
    expect(calls[0].body).toEqual({ folder: 'INBOX', add: ['\\Flagged'], remove: [] })
    expect(getState().messages.find((m) => m.id === '2')!.flags).toContain('\\Flagged')
    expect(getState().messages.find((m) => m.id === '1')!.flags).not.toContain('\\Flagged')
    expect(h.changed).toHaveBeenCalled()
  })

  it('toggleRead marks a read message unread by removing \\Seen', async () => {
    await runMessageAction('1', 'toggleRead', hooks())
    expect(calls[0].body).toEqual({ folder: 'INBOX', add: [], remove: ['\\Seen'] })
    expect(getState().messages.find((m) => m.id === '1')!.flags).not.toContain('\\Seen')
  })

  it('a flag change the message already has sends nothing', async () => {
    expect(await runMessageAction('1', 'read', hooks())).toBe(true)
    expect(calls).toHaveLength(0)
  })

  it('archive asks for the \\Archive special-use mailbox (never a hard-coded "Archive" path)', async () => {
    const h = hooks()
    await runMessageAction('2', 'archive', h)
    expect(calls[0].url).toContain('/api/message/2/move')
    expect(calls[0].body).toEqual({ from: 'INBOX', toSpecialUse: '\\Archive' })
    expect(ids()).toEqual(['1', '3'])
    expect(h.notify).toHaveBeenCalledWith('Archived to Archive')
  })

  it('junk and not-junk use \\Junk and \\Inbox; move uses the picked path', async () => {
    await runMessageAction('2', 'junk', hooks())
    expect(calls[0].body).toEqual({ from: 'INBOX', toSpecialUse: '\\Junk' })
    await runMessageAction('3', 'notJunk', hooks())
    expect(calls[1].body).toEqual({ from: 'INBOX', toSpecialUse: '\\Inbox' })
    respond = () => ({ status: 200, body: { success: true, folder: 'INBOX.Projects.2026' } })
    await runMessageAction('1', { moveTo: 'INBOX.Projects.2026' }, hooks())
    expect(calls[2].body).toEqual({ from: 'INBOX', to: 'INBOX.Projects.2026' })
  })

  it('delete on the open message closes the reading pane and says where it went', async () => {
    const h = hooks()
    await runMessageAction('1', 'delete', h)
    expect(calls[0].method).toBe('DELETE')
    expect(getState().selectedMessageId).toBeNull()
    expect(h.notify).toHaveBeenCalledWith('Moved to Trash')
  })

  it('a refused move puts the message back where it was (and reopens it)', async () => {
    respond = () => ({ status: 500, body: { error: 'Over quota' } })
    const h = hooks()
    expect(await runMessageAction('1', 'archive', h)).toBe(false)
    expect(ids()).toEqual(['1', '2', '3'])
    expect(getState().selectedMessageId).toBe('1')
    expect(h.notify).toHaveBeenCalledWith(expect.stringContaining('Over quota'))
  })

  it('a refused flag change restores the flags', async () => {
    respond = () => ({ status: 500, body: { error: 'nope' } })
    await runMessageAction('2', 'star', hooks())
    expect(getState().messages.find((m) => m.id === '2')!.flags).toEqual([])
  })

  it('a message gone on the server (404) is dropped with a notice, not restored', async () => {
    respond = () => ({ status: 404, body: { error: 'message_not_found' } })
    for (const action of ['star', 'archive'] as const) {
      const h = hooks()
      const id = action === 'star' ? '2' : '3'
      expect(await runMessageAction(id, action, h)).toBe(false)
      expect(ids()).not.toContain(id)
      expect(h.notify).toHaveBeenCalledWith('That message no longer exists on the server')
    }
  })

  it('a second action on a message while the first runs is not sent (double click)', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const orig = globalThis.fetch
    globalThis.fetch = vi.fn(async (...a: any[]) => { await gate; return (orig as any)(...a) }) as any
    const first = runMessageAction('2', 'toggleStar', hooks())
    expect(isBusy('2')).toBe(true)
    expect(await runMessageAction('2', 'toggleStar', hooks())).toBe(false)
    release()
    expect(await first).toBe(true)
    expect(calls).toHaveLength(1)
    expect(isBusy('2')).toBe(false)
  })

  it('an unknown message id does nothing', async () => {
    expect(await runMessageAction('99', 'delete', hooks())).toBe(false)
    expect(calls).toHaveLength(0)
  })
})

describe('moveTargets', () => {
  const folders = [
    { id: 'INBOX', name: 'INBOX' },
    { id: 'Archive', name: 'Archive', specialUse: '\\Archive' },
    { id: 'Projects', name: 'Projects', noselect: true },
    { id: 'Projects/2026', name: '2026', parentId: 'Projects', delimiter: '/' },
    { id: 'INBOX.Clients', name: 'Clients', parentId: 'INBOX', delimiter: '.' }
  ]
  it('lists Inbox, special mailboxes and nested folders, without \\Noselect parents or the current folder', () => {
    expect(moveTargets(folders, 'INBOX')).toEqual([
      { path: 'Archive', label: 'Archive', depth: 0 },
      { path: 'Projects/2026', label: '2026', depth: 1 },
      { path: 'INBOX.Clients', label: 'Clients', depth: 0 }
    ])
    expect(moveTargets(folders, 'Archive').map((t) => t.path)).toEqual(['INBOX', 'Projects/2026', 'INBOX.Clients'])
  })
  it('filters by label or path', () => {
    expect(moveTargets(folders, 'INBOX', 'proj').map((t) => t.path)).toEqual(['Projects/2026'])
  })
})
