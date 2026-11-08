import https from 'node:https'
import http from 'node:http'
import { state } from './state.js'

export const DAV_HOST = process.env.DAV_HOST || 'dav.example.com'
export const DAV_PORT = parseInt(process.env.DAV_PORT || '443', 10)
export const DAV_TLS = (process.env.DAV_TLS || (process.env.DAV_HOST ? 'true' : 'false')) === 'true'
export const DAV_PATH_PREFIX = (user) => (process.env.DAV_PREFIX || '/dav/' + user)

export function resolveDavTarget(acct) {
  const a = acct || {}
  const user = a.davUser || a.imapUser || ''
  const pass = a.davPass || a.imapPass || ''
  if (a.davUrl) {
    try {
      const u = new URL(a.davUrl)
      const tls = u.protocol === 'https:'
      const port = u.port
        ? parseInt(u.port, 10)
        : (tls ? 443 : 80)
      return { hostname: u.hostname, port, tls, basePath: u.pathname || '/', user, pass }
    } catch {}
  }
  return {
    hostname: DAV_HOST,
    port: DAV_PORT,
    tls: DAV_TLS,
    basePath: DAV_PATH_PREFIX(a.imapUser || ''),
    user,
    pass
  }
}

export function davRequest(method, urlPath, body, contentType, acct) {
  return new Promise((resolve, reject) => {
    const account = acct || state.accounts[0] || {}
    const t = resolveDavTarget(account)
    const token = Buffer.from(`${t.user}:${t.pass}`).toString('base64')
    const opts = {
      hostname: t.hostname,
      port: t.port,
      path: urlPath,
      method,
      headers: {
        'Authorization': `Basic ${token}`,
        'Content-Type': contentType || 'application/xml; charset="utf-8"',
        'Depth': '1'
      }
    }
    if (contentType === 'text/xml') opts.headers['Content-Type'] = contentType
    const lib = t.tls ? https : http
    const req = lib.request(opts, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf-8')
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ status: res.statusCode, body: data, headers: res.headers })
        } else {
          reject(new Error(`DAV ${method} ${urlPath} → ${res.statusCode}: ${data.slice(0, 300)}`))
        }
      })
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

export function xmlParseNodes(xml, parentTag, childTag) {
  const results = []
  const re = new RegExp(`<${parentTag}[\\s>][\\s\\S]*?<${childTag}[^>]*>([\\s\\S]*?)</${childTag}>`, 'g')
  let m
  while ((m = re.exec(xml)) !== null) results.push(m[1].trim())
  if (results.length) return results
  const re2 = new RegExp(`<${parentTag}[^>]*>([\\s\\S]*?)</${parentTag}>`, 'g')
  while ((m = re2.exec(xml)) !== null) {
    const inner = m[1]
    const cm = inner.match(new RegExp(`<${childTag}[^>]*>([\\s\\S]*?)</${childTag}>`))
    if (cm) results.push(cm[1].trim())
  }
  return results
}

export function extractResponseSet(xml) {
  const responses = []
  const respRe = /<response>([\s\S]*?)<\/response>/g
  let m
  while ((m = respRe.exec(xml)) !== null) {
    const inner = m[1]
    const href = (inner.match(/<href>([\s\S]*?)<\/href>/) || [])[1] || ''
    const displayname = (inner.match(/<displayname[^>]*>([\s\S]*?)<\/displayname>/) || [])[1] || ''
    const etag = (inner.match(/<etag>([\s\S]*?)<\/etag>/) || [])[1] || ''
    if (href) responses.push({ href: href.trim(), displayname: displayname.trim(), etag: (etag.trim() || '').replace(/"/g, '') })
  }
  return responses
}
