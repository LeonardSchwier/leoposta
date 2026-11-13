import crypto from 'node:crypto'

// Express middleware: require header x-leoposta-token to equal `token`.
export function requireToken(token) {
  const expected = Buffer.from(String(token))
  return (req, res, next) => {
    // EventSource cannot set headers, so GET /api/idle may pass the token as
    // ?token= instead. Attachment downloads send the header (the client fetches
    // them), so their URLs, which end up in logs and history, carry no token.
    const queryOk = req.method === 'GET' && req.path === '/idle'
    const fromQuery = queryOk && typeof req.query.token === 'string' ? req.query.token : ''
    const given = Buffer.from(String(req.get('x-leoposta-token') || fromQuery))
    const ok = given.length === expected.length && crypto.timingSafeEqual(given, expected)
    if (!ok) return res.status(401).json({ error: 'unauthorized' })
    next()
  }
}
