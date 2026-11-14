import { describe, it, expect } from 'vitest'
import { createLatest, mergeRefreshed } from '../lib/listSync'

describe('createLatest', () => {
  it('only the newest load may apply, whatever order responses arrive in', async () => {
    const latest = createLatest()
    const list: string[] = []
    const load = (folder: string, ms: number) => {
      const current = latest.begin()
      return new Promise<void>((r) => setTimeout(() => { if (current()) list.splice(0, list.length, folder); r() }, ms))
    }
    // Slow folder A, then a quick switch to B: A's late answer must not win.
    await Promise.all([load('A', 30), load('B', 5)])
    expect(list).toEqual(['B'])
  })
})

describe('mergeRefreshed', () => {
  it('keeps the loaded body of messages still in the list and adds new ones', () => {
    const prev = [
      { id: '1', subject: 'Old', body: 'loaded body', bodyHtml: '<p>x</p>', flags: [] as string[] },
      { id: '2', subject: 'Other', body: '', bodyHtml: '', flags: [] as string[] }
    ]
    const fresh = [
      { id: '3', subject: 'New', body: '', bodyHtml: '', flags: [] as string[] },
      { id: '1', subject: 'Old', body: '', bodyHtml: '', flags: ['\\Seen'] }
    ]
    const out = mergeRefreshed(prev, fresh)
    expect(out.map((m) => m.id)).toEqual(['3', '1'])
    expect(out[1].body).toBe('loaded body')
    expect(out[1].bodyHtml).toBe('<p>x</p>')
    expect(out[1].flags).toEqual(['\\Seen']) // server flags win
    expect(out[0].body).toBe('')
  })
})
