import DOMPurify from 'dompurify'

// Mail HTML is adversarial. Hooks only run when registered via addHook.
const purify = DOMPurify(window)

purify.addHook('afterSanitizeAttributes', (node: Element) => {
  if (node.tagName === 'A') {
    node.setAttribute('rel', 'noopener noreferrer')
  }
  const style = node.getAttribute?.('style')
  if (style && /url\s*\(|expression\s*\(|@import/i.test(style)) {
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
    'src','start','style','summary','target','title','valign','width'
  ],
  FORBID_CONTENTS: ['style'],
  ADD_ATTR: ['target', 'rel'],
  FORBID_ATTR: ['srcset'],
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|cid:)\S*$/i
}

export function sanitizeHtml(html: string): string {
  if (!html) return ''
  return purify.sanitize(html, CONFIG as any) as unknown as string || ''
}
