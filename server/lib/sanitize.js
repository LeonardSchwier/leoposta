import sanitizeHtml from 'sanitize-html'

// Server-side scrub for outbound HTML (defense-in-depth; the client also
// sanitizes on render). Allow-list based, so nested or malformed markup cannot
// smuggle script, handlers or javascript: URLs to recipients.
const ALLOWED_TAGS = [
  'a','b','blockquote','br','caption','code','div','em','h1','h2','h3','h4','h5','h6',
  'hr','i','img','li','ol','p','pre','small','span','strong','sub','sup','table',
  'tbody','td','tfoot','th','thead','tr','u','ul','del','ins','mark','figure','figcaption'
]

export function scrubOutboundHtml(html) {
  if (typeof html !== 'string' || !html) return html
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: {
      a: ['href', 'target', 'rel'],
      img: ['src', 'alt', 'width', 'height'],
      '*': ['style']
    },
    allowedSchemes: ['https', 'http', 'mailto', 'tel', 'cid'],
    transformTags: { a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }) }
  })
}
