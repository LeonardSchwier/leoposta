// Error handling shared by the API: every failure that reaches Express's error
// path becomes a small JSON body. Express's own handler answers with an HTML
// page that includes the stack trace (file paths and line numbers) whenever
// NODE_ENV is not "production", which is how this server runs locally.

/** The error the CORS origin check raises for an origin outside the allowlist. */
export function originNotAllowedError() {
  return Object.assign(new Error('Not allowed by CORS'), { code: 'ORIGIN_NOT_ALLOWED' })
}

export function apiErrorHandler(err, req, res, next) {
  // Headers are already out (an SSE stream, a half-sent file): leave it to
  // Express, which closes the connection.
  if (res.headersSent) return next(err)
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'too_large' })
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json' })
  if (err && err.code === 'ORIGIN_NOT_ALLOWED') return res.status(403).json({ error: 'origin_not_allowed' })
  const status = Number(err && (err.status || err.statusCode))
  if (status === 404) return res.status(404).json({ error: 'not_found' })
  if (status >= 400 && status < 500) return res.status(status).json({ error: 'bad_request' })
  console.error('[api]', req.method, req.path, err)
  res.status(500).json({ error: 'internal_error' })
}
