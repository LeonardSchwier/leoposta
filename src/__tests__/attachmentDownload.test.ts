import { describe, it, expect, vi } from 'vitest'
import {
  AttachmentDownloadError,
  attachmentPath,
  downloadAttachment,
  saveBlob,
} from '../lib/attachmentDownload'

describe('attachmentPath', () => {
  it('addresses the download route and encodes every segment', () => {
    expect(attachmentPath('12', '0', 'INBOX')).toBe('/api/message/12/attachment/0?folder=INBOX')
    expect(attachmentPath('12', '3', 'INBOX/Sub folder&x')).toBe(
      '/api/message/12/attachment/3?folder=INBOX%2FSub%20folder%26x',
    )
  })

  it('never puts a token in the URL', () => {
    expect(attachmentPath('1', '0', 'INBOX')).not.toMatch(/token/i)
  })
})

describe('downloadAttachment', () => {
  it('saves the response body under the attachment file name', async () => {
    const save = vi.fn()
    const body = new Blob([new Uint8Array([1, 2, 3, 255])])
    await downloadAttachment(async () => new Response(body), 'report.pdf', save)
    expect(save).toHaveBeenCalledTimes(1)
    const [blob, filename] = save.mock.calls[0]
    expect(filename).toBe('report.pdf')
    expect(blob.size).toBe(4)
  })

  it('saves the bytes as octet-stream whatever type the server declared (a blob: URL has the app origin)', async () => {
    const save = vi.fn()
    const html = new Response('<script>1</script>', { headers: { 'Content-Type': 'text/html' } })
    await downloadAttachment(async () => html, 'page.html', save)
    const [blob] = save.mock.calls[0]
    expect(blob.type).toBe('application/octet-stream')
    expect(await blob.text()).toBe('<script>1</script>')
  })

  it('falls back to a generic name', async () => {
    const save = vi.fn()
    await downloadAttachment(async () => new Response('x'), '', save)
    expect(save.mock.calls[0][1]).toBe('attachment')
  })

  it.each([
    [404, { error: 'attachment_not_found' }, /no longer/i],
    [404, { error: 'message_not_found' }, /no longer/i],
    [401, { error: 'unauthorized' }, /not authori[sz]ed/i],
    [500, { error: 'boom' }, /could not be downloaded/i],
    [502, null, /could not be downloaded/i],
  ])('turns a %i answer into a readable error and saves nothing', async (status, json, message) => {
    const save = vi.fn()
    const respond = async () =>
      new Response(json ? JSON.stringify(json) : 'Bad Gateway', { status })
    await expect(downloadAttachment(respond, 'a.pdf', save)).rejects.toThrow(AttachmentDownloadError)
    await expect(downloadAttachment(respond, 'a.pdf', save)).rejects.toThrow(message)
    expect(save).not.toHaveBeenCalled()
  })

  it('reports an unreachable server', async () => {
    const save = vi.fn()
    const failing = async () => { throw new TypeError('fetch failed') }
    await expect(downloadAttachment(failing, 'a.pdf', save)).rejects.toThrow(/reach the server/i)
    expect(save).not.toHaveBeenCalled()
  })
})

describe('saveBlob', () => {
  function fakeDocument() {
    const anchor: Record<string, unknown> & { click: ReturnType<typeof vi.fn> } = { click: vi.fn() }
    const body = { appendChild: vi.fn(), removeChild: vi.fn() }
    return {
      anchor,
      body,
      doc: { createElement: vi.fn(() => anchor), body } as unknown as Document,
    }
  }

  it('clicks a temporary download link for an object URL, then cleans up', () => {
    const { anchor, body, doc } = fakeDocument()
    const urlApi = { createObjectURL: vi.fn(() => 'blob:abc'), revokeObjectURL: vi.fn() }
    const schedule = vi.fn((fn: () => void) => fn())
    saveBlob(new Blob(['x']), 'über.pdf', { doc, urlApi, schedule })
    expect(anchor.href).toBe('blob:abc')
    expect(anchor.download).toBe('über.pdf')
    expect(anchor.click).toHaveBeenCalledTimes(1)
    expect(body.appendChild).toHaveBeenCalledWith(anchor)
    expect(body.removeChild).toHaveBeenCalledWith(anchor)
    expect(urlApi.revokeObjectURL).toHaveBeenCalledWith('blob:abc')
  })

  it('revokes the object URL later, not before the browser has started the download', () => {
    const { doc } = fakeDocument()
    const urlApi = { createObjectURL: vi.fn(() => 'blob:abc'), revokeObjectURL: vi.fn() }
    const schedule = vi.fn()
    saveBlob(new Blob(['x']), 'a.pdf', { doc, urlApi, schedule })
    expect(urlApi.revokeObjectURL).not.toHaveBeenCalled()
    expect(schedule).toHaveBeenCalledTimes(1)
    expect(schedule.mock.calls[0][1]).toBeGreaterThanOrEqual(1000)
  })
})
