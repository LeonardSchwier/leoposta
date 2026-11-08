import { describe, it, expect } from 'vitest'
import {
  DEFAULT_SIGNATURE,
  normalizeSignature,
  buildMessageBody,
  type Signature
} from '../lib/signature'

describe('normalizeSignature', () => {
  it('returns DEFAULT_SIGNATURE when null', () => {
    expect(normalizeSignature(null)).toEqual(DEFAULT_SIGNATURE)
  })

  it('returns DEFAULT_SIGNATURE when undefined', () => {
    expect(normalizeSignature(undefined)).toEqual(DEFAULT_SIGNATURE)
  })

  it('fills missing fields with defaults', () => {
    expect(normalizeSignature({ text: '— Leo' })).toEqual({
      enabled: false, text: '— Leo', position: 'standard'
    })
  })

  it('preserves all fields when given', () => {
    const sig = { enabled: true, text: '— Leo', position: 'after_quote' as const }
    expect(normalizeSignature(sig)).toEqual(sig)
  })
})

describe('buildMessageBody — new compose (original === null/undefined)', () => {
  const sig: Signature = { enabled: true, text: '— Leo', position: 'standard' }

  it('returns just the signature for a new compose', () => {
    expect(buildMessageBody(sig, '', null)).toBe('— Leo')
  })

  it('returns empty string for disabled signature', () => {
    const off: Signature = { enabled: false, text: '— Leo', position: 'standard' }
    expect(buildMessageBody(off, '', null)).toBe('')
  })

  it('returns empty string for whitespace-only text', () => {
    const ws: Signature = { enabled: true, text: '   ', position: 'standard' }
    expect(buildMessageBody(ws, '', null)).toBe('')
  })
})

describe('buildMessageBody — reply, position=standard', () => {
  const sig: Signature = { enabled: true, text: '— Leo', position: 'standard' }

  it('returns: replyText, blank line, signature, blank line, --, original', () => {
    const result = buildMessageBody(sig, 'Thanks!', 'Original body')
    expect(result).toBe('Thanks!\n\n— Leo\n\n--\nOriginal body')
  })

  it('returns: blank line, signature, blank line, --, original when replyText is empty', () => {
    const result = buildMessageBody(sig, '', 'Original body')
    expect(result).toBe('\n— Leo\n\n--\nOriginal body')
  })

  it('returns: blank line, --, original when signature disabled', () => {
    const off: Signature = { enabled: false, text: '— Leo', position: 'standard' }
    const result = buildMessageBody(off, 'Thanks!', 'Original body')
    expect(result).toBe('Thanks!\n\n--\nOriginal body')
  })
})

describe('buildMessageBody — reply, position=after_quote', () => {
  const sig: Signature = { enabled: true, text: '— Leo', position: 'after_quote' as const }

  it('returns: replyText, blank line, --, original, blank line, signature', () => {
    const result = buildMessageBody(sig, 'Thanks!', 'Original body')
    expect(result).toBe('Thanks!\n\n--\nOriginal body\n\n— Leo')
  })

  it('returns: blank line, --, original, blank line, signature when replyText is empty', () => {
    const result = buildMessageBody(sig, '', 'Original body')
    expect(result).toBe('\n--\nOriginal body\n\n— Leo')
  })
})

describe('buildMessageBody — original undefined', () => {
  it('same as original === null', () => {
    const sig: Signature = { enabled: true, text: '— Leo', position: 'standard' }
    expect(buildMessageBody(sig, '', undefined)).toBe('— Leo')
  })
})
