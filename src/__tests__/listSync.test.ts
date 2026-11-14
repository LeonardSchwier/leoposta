import { describe, it, expect } from 'vitest'
import { appendPage, createLatest, keepOlderPages, mergeRefreshed } from '../lib/listSync'

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

describe('paging', () => {
  const m = (id: number) => ({ id: String(id) })
  it('appendPage adds the older page without repeating a message', () => {
    // New mail arrived between the pages, so the next page overlaps by one.
    expect(appendPage([m(5), m(4), m(3)], [m(3), m(2), m(1)]).map((x) => x.id)).toEqual(['5', '4', '3', '2', '1'])
  })
  it('keepOlderPages keeps loaded older pages under a refreshed newest page', () => {
    const shown = [m(10), m(9), m(8), m(7), m(6), m(5)]
    // Refresh: 11 arrived, 9 was deleted; the page holds 3 of 10 messages.
    expect(keepOlderPages(shown, [m(11), m(10), m(8)], 10).map((x) => x.id)).toEqual(['11', '10', '8', '7', '6', '5'])
  })
  it('keepOlderPages takes the refreshed list as is when it is the whole folder', () => {
    expect(keepOlderPages([m(3), m(2), m(1)], [m(3), m(1)], 2).map((x) => x.id)).toEqual(['3', '1'])
  })
})
