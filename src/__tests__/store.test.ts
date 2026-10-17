import { describe, it, expect } from 'vitest'
import { get } from 'svelte/store'
import { store, setMessages, setActiveFolder, getState } from '../store'
import type { MailMessage } from '../store'

describe('Mail Store', () => {
  it('should have initial state', () => {
    const state = get(store)
    expect(state.activeFolder).toBe('INBOX')
    expect(state.messages).toEqual([])
    expect(state.unreadCount).toBe(0)
  })

  it('should set messages', () => {
    const message: MailMessage = {
      id: '1',
      from: 'test@example.com',
      to: ['me@example.com'],
      cc: [],
      bcc: [],
      subject: 'Test',
      body: 'Hello',
      bodyHtml: '',
      date: new Date().toISOString(),
      flags: [],
      attachments: [],
      folder: 'INBOX',
      headers: {}
    }
    setMessages([message])
    expect(get(store).messages).toHaveLength(1)
    expect(getState().messages).toHaveLength(1)
  })

  it('should switch active folder and clear messages', () => {
    setMessages(
      [
        {
          id: '1',
          from: 'test@example.com',
          to: ['me@example.com'],
          subject: 'Test',
          body: 'Hello',
          date: new Date().toISOString(),
          flags: [],
          folder: 'INBOX',
          headers: {}
        }
      ] as MailMessage[]
    )
    setActiveFolder('Sent')
    const state = get(store)
    expect(state.activeFolder).toBe('Sent')
    expect(state.messages).toEqual([])
  })
})
