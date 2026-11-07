import DOMPurify from 'dompurify'

// Mail HTML is adversarial. Hooks only run when registered via addHook.
const purify = DOMPurify(window)
let allowRemote = false

purify.addHook('afterSanitizeAttributes', (node: Element) => {
  if (node.tagName === 'A') {
    node.setAttribute('rel', 'noopener noreferrer')
  }
  if (!allowRemote && node.tagName === 'IMG') {
    const src = node.getAttribute('src') || ''
    if (/^https?:/i.test(src)) {
      node.setAttribute('data-remote-src', src)
      node.removeAttribute('src')
    }
  }
  const style = node.getAttribute?.('style')
  if (style && /url\s*\(|image-set|image\s*\(|expression\s*\(|@import|\\/i.test(style)) {
    node.removeAttribute('style')
  }
})

const CONFIG = {
  ALLOWED_TAGS: [
    'a','b','blockquote','br','caption','code','div','em','h1','h2','h3','h4','h5','h6',
    'hr','i','img','li','ol','p','pre','small','span','strong','sub','sup','table',
    'tbody','td','tfoot','th','thead','tr','u','ul','del','ins','mark','figure','figcaption'
  ],
  ALLOWED_ATTR: [
    'align','alt','bgcolor','border','cellpadding','cellspacing','colspan','color','dir',
    'face','height','href','hreflang','lang','rel','role','scope','shape','size','span',
    'src','start','style','summary','target','title','valign','width','data-remote-src'
  ],
  FORBID_CONTENTS: ['style'],
  ADD_ATTR: ['target', 'rel'],
  FORBID_ATTR: ['srcset'],
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|cid:)\S*$/i
}

export function sanitizeHtml(html: string, opts: { allowRemoteImages?: boolean } = {}): string {
  if (!html) return ''
  allowRemote = !!opts.allowRemoteImages
  try {
    return (purify.sanitize(html, CONFIG as any) as unknown as string) || ''
  } finally {
    allowRemote = false
  }
}

export function hasRemoteImages(html: string): boolean {
  if (!html) return false
  return /<img\b[^>]*\bsrc\s*=\s*["']?\s*https?:/i.test(html)
}
