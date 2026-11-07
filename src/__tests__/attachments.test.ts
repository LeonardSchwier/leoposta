import { describe, it, expect } from 'vitest'
import {
  encodeBase64,
  fileToAttachment,
  AttachmentTooLargeError,
  MAX_ATTACHMENT_BYTES,
} from '../lib/attachments'

describe('encodeBase64', () => {
  it('encodes empty input', () => {
    expect(encodeBase64(new Uint8Array(0))).toBe('')
  })

  it('encodes a known byte sequence (hello)', () => {
    // "hello" = 68 65 6c 6c 6f
    const buf = new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f])
    expect(encodeBase64(buf)).toBe(Buffer.from('hello').toString('base64'))
  })

  it('encodes binary-safe (all 256 possible bytes)', () => {
    const bytes = new Uint8Array(256)
    for (let i = 0; i < 256; i++) bytes[i] = i
    expect(encodeBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'))
  })

  it('works for inputs larger than the 0x8000 chunk (forces the loop)', () => {
    const n = 0x8000 + 7
    const bytes = new Uint8Array(n)
    for (let i = 0; i < n; i++) bytes[i] = (i * 31 + 7) & 0xff
    expect(encodeBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'))
  })
})

describe('fileToAttachment', () => {
  function fakeFile(name: string, bytes: Uint8Array, type: string): File {
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type })
    const f = new File([blob], name, { type })
    return f
  }

  it('returns the /api/send shape', async () => {
    const f = fakeFile('note.txt', new Uint8Array([72, 105]), 'text/plain')
    const att = await fileToAttachment(f)
    expect(att.filename).toBe('note.txt')
    expect(att.contentType).toBe('text/plain')
    expect(att.content).toBe(Buffer.from([72, 105]).toString('base64'))
  })

  it('falls back to application/octet-stream and "file" when name/type are absent', async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])])
    const att = await fileToAttachment(blob)
    expect(att.filename).toBe('file')
    expect(att.contentType).toBe('application/octet-stream')
    expect(att.content).toBe(Buffer.from([1, 2, 3]).toString('base64'))
  })

  it('rejects files over MAX_ATTACHMENT_BYTES with AttachmentTooLargeError', async () => {
    const oversized = new Blob(['x'.repeat(MAX_ATTACHMENT_BYTES + 1)])
    const f = new File([oversized], 'big.bin', { type: 'application/octet-stream' })
    const p = fileToAttachment(f)
    await expect(p).rejects.toBeInstanceOf(AttachmentTooLargeError)
  })

  it('accepts files exactly at the boundary', async () => {
    // Don't allocate MBs in the test; just verify the comparison is inclusive.
    // Use a stubbed size via subclassing rather than a real 25 MiB blob.
    const fake = {
      name: 'edge.bin',
      type: 'application/octet-stream',
      size: MAX_ATTACHMENT_BYTES,
      // arrayBuffer returns a small buffer — the helper only cares about size
      // for the limit check and then calls arrayBuffer() for the bytes.
      arrayBuffer: async () => new Uint8Array([0]).buffer,
    }
    const att = await fileToAttachment(fake as unknown as File)
    expect(att.filename).toBe('edge.bin')
    expect(att.content).toBe(Buffer.from([0]).toString('base64'))
  })
})
