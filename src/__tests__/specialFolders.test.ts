import { describe, it, expect } from 'vitest'
import { specialFolderPath } from '../lib/specialFolders'

// The sidebar's fixed "Drafts" entry must open the server's real Drafts
// mailbox, found by its SPECIAL-USE flag: many servers call it INBOX.Drafts,
// "[Gmail]/Drafts" or a localized name, and the draft is APPENDed there.
describe('specialFolderPath', () => {
  it('resolves the mailbox flagged \\Drafts whatever it is called', () => {
    const folders = [
      { id: 'INBOX', name: 'INBOX', specialUse: '\\Inbox' },
      { id: 'INBOX.Entwürfe', name: 'Entwürfe', specialUse: '\\Drafts' },
    ]
    expect(specialFolderPath(folders, '\\Drafts', 'Drafts')).toBe('INBOX.Entwürfe')
  })

  it('falls back to the plain name when the server flags nothing (or folders are not loaded yet)', () => {
    expect(specialFolderPath([], '\\Drafts', 'Drafts')).toBe('Drafts')
    expect(specialFolderPath([{ id: 'Drafts', name: 'Drafts' }], '\\Drafts', 'Drafts')).toBe('Drafts')
  })

  it('resolves the other special-use mailboxes the same way', () => {
    const folders = [
      { id: '[Gmail]/Sent Mail', name: 'Sent Mail', specialUse: '\\Sent' },
      { id: '[Gmail]/Trash', name: 'Trash', specialUse: '\\Trash' },
    ]
    expect(specialFolderPath(folders, '\\Sent', 'Sent')).toBe('[Gmail]/Sent Mail')
    expect(specialFolderPath(folders, '\\Trash', 'Trash')).toBe('[Gmail]/Trash')
  })
})
