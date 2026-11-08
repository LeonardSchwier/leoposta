/**
 * Outbound attachment helpers for /api/send.
 *
 * The server route (server/routes/send.js) expects:
 *   { filename: string, content: string /* base64 *\/, contentType: string }
 * per attachment, up to a 35 MB JSON body ceiling — which is the size
 * envelope we also enforce client-side as MAX_ATTACHMENT_BYTES.
 */

export interface OutboundAttachment {
  filename: string
  /** base64-encoded bytes (no data: URL prefix) */
  content: string
  contentType: string
}

/** 25 MiB raw bytes => ~33.3 MB base64 => under the 35 MB JSON ceiling. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024

/**
 * Encode an ArrayBuffer (or Uint8Array) to a base64 string using the native
 * `btoa`. Chunks the write so very large buffers don't overflow the call
 * stack via a spread. Works in every browser + Node >= 18.
 */
export function encodeBase64(input: Uint8Array | ArrayBuffer): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)))
  }
  return btoa(binary)
}

/**
 * Convert a File/Blob into the shape /api/send expects.
 * Rejects files exceeding MAX_ATTACHMENT_BYTES with a typed error so the
 * UI can surface a consistent message instead of waiting for a 413.
 */
export async function fileToAttachment(
  file: File | (Blob & { name?: string; type?: string })
): Promise<OutboundAttachment> {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentTooLargeError(file)
  }
  const buf = await file.arrayBuffer()
  return {
    filename: (file as File).name || 'file',
    content: encodeBase64(buf),
    contentType: (file as File).type || 'application/octet-stream',
  }
}

export class AttachmentTooLargeError extends Error {
  constructor(readonly file: Blob & { name?: string }) {
    super(`${file.name || 'file'} is ${(file.size / 1024 / 1024).toFixed(1)} MB; the limit is ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`)
    this.name = 'AttachmentTooLargeError'
  }
}
