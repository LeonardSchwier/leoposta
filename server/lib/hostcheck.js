// DNS-rebinding guard. A web page whose own host name is re-pointed at
// 127.0.0.1 becomes same-origin with this server: its GET requests carry no
// Origin header, so the CORS check never runs, and it could read the PWA
// bundle (which holds the API token) and then the whole mailbox. Browsers
// always send the name the page used in the Host header, so only answering
// for loopback names and the hosts the operator configured closes that path.

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1'])

/** Host name (lower case, no port, no IPv6 brackets) of a Host header value. */
export function hostnameOf(value) {
  const v = String(value || '').trim().toLowerCase()
  if (v.startsWith('[')) {
    const end = v.indexOf(']')
    return end === -1 ? '' : v.slice(1, end)
  }
  const colon = v.indexOf(':')
  return colon === -1 ? v : v.slice(0, colon)
}

/** The host names allowed besides loopback: those of ALLOWED_ORIGINS, plus ALLOWED_HOSTS. */
export function configuredHosts(allowedOrigins = [], allowedHostsEnv = '') {
  const out = new Set()
  for (const o of allowedOrigins) {
    try { out.add(new URL(o).hostname.replace(/^\[|\]$/g, '').toLowerCase()) } catch {}
  }
  for (const h of String(allowedHostsEnv || '').split(',')) {
    const name = hostnameOf(h)
    if (name) out.add(name)
  }
  return out
}

export function isAllowedHost(hostHeader, extraHosts) {
  const name = hostnameOf(hostHeader)
  if (!name) return false
  return LOOPBACK.has(name) || name.endsWith('.localhost') || extraHosts.has(name)
}

/** Express middleware: 403 for a request whose Host is not loopback or configured. */
export function requireAllowedHost({ allowedOrigins = [], allowedHostsEnv = '' } = {}) {
  const extra = configuredHosts(allowedOrigins, allowedHostsEnv)
  return (req, res, next) => {
    // HTTP/1.0 clients may omit Host; browsers never do, so that is not the
    // rebinding path.
    if (req.headers.host === undefined) return next()
    if (isAllowedHost(req.headers.host, extra)) return next()
    res.status(403).json({ error: 'host_not_allowed' })
  }
}
