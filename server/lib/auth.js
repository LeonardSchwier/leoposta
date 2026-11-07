import crypto from 'node:crypto'

// Express middleware: require header x-leoposta-token to equal `token`.
export function requireToken(token) {
  const expected = Buffer.from(String(token))
  return (req, res, next) => {
    // EventSource and <a href> downloads cannot set headers, so GET /api/idle
    // and attachment downloads may pass the token as ?token= instead.
    const queryOk = req.method === 'GET' && /^\/(idle|message\/[^/]+\/attachment\/[^/]+)$/.test(req.path)
    const fromQuery = queryOk && typeof req.query.token === 'string' ? req.query.token : ''
    const given = Buffer.from(String(req.get('x-leoposta-token') || fromQuery))
    const ok = given.length === expected.length && crypto.timingSafeEqual(given, expected)
    if (!ok) return res.status(401).json({ error: 'unauthorized' })
    next()
  }
}
