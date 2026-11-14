import DOMPurify from 'dompurify'

// Mail HTML is adversarial. Hooks only run when registered via addHook.
const purify = DOMPurify(window)
let allowRemote = false

// Characters a browser ignores in a URL (leading/trailing C0 controls and
// spaces are stripped, tab/CR/LF are removed anywhere) plus the Unicode
// spaces DOMPurify ignores when it checks the scheme. "ht\ttps://x" is
// fetched as https://x, so the remote-image test must see what the browser sees.
// eslint-disable-next-line no-control-regex
const URL_IGNORED = /[\u0000-\u0020\u007f-\u009f\u00a0\u1680\u180e\u2000-\u2029\u205f\u3000\ufeff]/g
const LOCAL_IMAGE = /^(?:cid:|data:)/i

purify.addHook('afterSanitizeAttributes', (node: Element) => {
  if (node.tagName === 'A') {
    node.setAttribute('rel', 'noopener noreferrer')
  }
  if (!allowRemote && node.tagName === 'IMG' && node.hasAttribute('src')) {
    // Only embedded images load before the user opts in; anything else,
    // however it is spelled, waits behind "Load images".
    const src = (node.getAttribute('src') || '').replace(URL_IGNORED, '')
    if (!LOCAL_IMAGE.test(src)) {
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

/** True when sanitizing held back at least one remote image (see the hook). */
export function hasRemoteImages(html: string): boolean {
  if (!html) return false
  const probe = document.createElement('div')
  probe.innerHTML = sanitizeHtml(html)
  return probe.querySelector('img[data-remote-src]') !== null
}
