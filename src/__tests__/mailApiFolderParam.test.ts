import { describe, it, expect, beforeEach } from 'vitest'
import { MailAPI } from '../api'

// Folder paths are free text on IMAP. A name like "# Archive" or "R&D" used to
// be spliced raw into the query string: "#" started a URL fragment, so the
// server saw folder="" and sent SELECT "" ("Invalid mailbox name: Name is
// empty"); "&" and "+" corrupted the name the same way.

let urls: string[] = []
beforeEach(() => {
  urls = []
  globalThis.fetch = (async (input: any) => {
    urls.push(String(input))
    return { ok: true, status: 200, json: async () => ({}) }
  }) as any
})

function folderOf(url: string): string | null {
  return new URL(url, 'http://x').searchParams.get('folder')
}

const awkward = ['# Archive', '#1 Projects', 'R&D', 'a+b', 'INBOX.Projects.2026', 'Ünïcode/Sub?x=1']

describe('MailAPI folder query parameter', () => {
  for (const name of awkward) {
    it(`round-trips ${JSON.stringify(name)}`, async () => {
      await MailAPI.messages(name)
      await MailAPI.message('7', name)
      await MailAPI.search('hello', name)
      await MailAPI.delete('7', name)
      expect(urls).toHaveLength(4)
      for (const u of urls) {
        expect(new URL(u, 'http://x').hash).toBe('')
        expect(folderOf(u)).toBe(name)
      }
    })
  }

  it('encodes the message id in the path', async () => {
    await MailAPI.message('a/b', 'INBOX')
    expect(new URL(urls[0], 'http://x').pathname).toBe('/api/message/a%2Fb')
  })
})
