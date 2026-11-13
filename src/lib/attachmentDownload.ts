/**
 * Downloading a received attachment.
 *
 * The bytes are fetched with the authenticated request helper (token and
 * x-account headers), so the token never appears in a URL, then handed to the
 * browser as a Blob through a temporary <a download>. A plain link could carry
 * neither header, so it always pointed at the first account and, with a token in
 * the URL, put the token into logs and history.
 */

export class AttachmentDownloadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AttachmentDownloadError'
  }
}

/** Path of the download route; the server's attachment ids are opaque strings. */
export function attachmentPath(messageId: string, attachmentId: string, folder: string): string {
  return (
    `/api/message/${encodeURIComponent(messageId)}` +
    `/attachment/${encodeURIComponent(attachmentId)}` +
    `?folder=${encodeURIComponent(folder)}`
  )
}

function explain(status: number, code: unknown): string {
  if (status === 404 || code === 'attachment_not_found' || code === 'message_not_found') {
    return 'This attachment is no longer on the server.'
  }
  if (status === 401) return 'Not authorised to download this attachment.'
  return 'The attachment could not be downloaded.'
}

interface BrowserDeps {
  doc: Document
  urlApi: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>
  schedule: (fn: () => void, ms: number) => unknown
}

// Revoking at once can cancel the download in some browsers, so wait.
const REVOKE_AFTER_MS = 30_000

export function saveBlob(
  blob: Blob,
  filename: string,
  deps: BrowserDeps = { doc: document, urlApi: URL, schedule: (fn, ms) => setTimeout(fn, ms) },
): void {
  const { doc, urlApi, schedule } = deps
  const url = urlApi.createObjectURL(blob)
  const a = doc.createElement('a')
  a.href = url
  a.download = filename
  doc.body.appendChild(a)
  a.click()
  doc.body.removeChild(a)
  schedule(() => urlApi.revokeObjectURL(url), REVOKE_AFTER_MS)
}

/** Fetch an attachment and save it. `fetchBytes` is the authenticated request. */
export async function downloadAttachment(
  fetchBytes: () => Promise<Response>,
  filename: string,
  save: (blob: Blob, filename: string) => void = saveBlob,
): Promise<void> {
  let res: Response
  try {
    res = await fetchBytes()
  } catch {
    throw new AttachmentDownloadError('Could not reach the server to download the attachment.')
  }
  if (!res.ok) {
    const detail = await res.json().catch(() => null)
    throw new AttachmentDownloadError(explain(res.status, detail?.error))
  }
  // Not res.blob(): that keeps the server's Content-Type, and a blob: URL has this
  // app's origin, so a browser that ignored `download` and opened an HTML or SVG
  // attachment would run it here. The server's CSP sandbox does not follow the bytes.
  const bytes = await res.arrayBuffer()
  save(new Blob([bytes], { type: 'application/octet-stream' }), filename || 'attachment')
}
