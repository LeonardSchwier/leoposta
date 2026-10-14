import { describe, it, expect } from 'vitest'
import { store } from '../store'

describe('Mail Store', () => {
  it('should have initial state', () => {
    const state = store.getState()
    expect(state.currentView).toBe('inbox')
    expect(state.messages).toEqual([])
    expect(state.unreadCount).toBe(0)
  })

  it('should set messages', () => {
    const messages = [
      {
        id: '1',
        from: 'test@example.com',
        to: ['me@example.com'],
        cc: [],
        bcc: [],
        subject: 'Test',
        body: 'Hello',
        bodyHtml: '',
        date: new Date().toISOString(),
        flags: {},
        attachments: [],
        folder: 'INBOX',
        headers: {}
      }
    ]
    store.getState().setMessages(messages)
    expect(store.getState().messages).toHaveLength(1)
  })
})
