// Direct access to the stack's Radicale (CalDAV/CardDAV) for the e2e suite:
// create collections, seed and read back resources, independent of the app.
// Radicale accepts any user/password; each test user has its own principal
// collection /<user>/ (the account's davUrl, see fixtures.ts accountBody).
import { DAV_PORT, PASSWORD } from './fixtures'

const ROOT = `http://127.0.0.1:${DAV_PORT}`

export class Dav {
  constructor(readonly user: string) {}

  get base(): string { return `/${encodeURIComponent(this.user)}/` }

  async req(method: string, path: string, body?: string, headers: Record<string, string> = {}): Promise<{ status: number, text: string }> {
    const r = await fetch(ROOT + path, {
      method,
      body,
      headers: { Authorization: 'Basic ' + Buffer.from(`${this.user}:${PASSWORD}`).toString('base64'), ...headers }
    })
    return { status: r.status, text: await r.text() }
  }

  private async ok(method: string, path: string, body?: string, headers?: Record<string, string>) {
    const r = await this.req(method, path, body, headers)
    if (r.status >= 300) throw new Error(`${method} ${path} -> ${r.status} ${r.text.slice(0, 300)}`)
    return r
  }

  /** Make sure the principal collection exists (Radicale creates it on first PROPFIND). */
  async init() {
    await this.ok('PROPFIND', this.base, undefined, { Depth: '0' })
  }

  async mkcalendar(slug: string, name: string): Promise<string> {
    await this.init()
    const path = `${this.base}${slug}/`
    await this.ok('MKCALENDAR', path, `<?xml version="1.0" encoding="utf-8"?>
<c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:set><d:prop>
<d:displayname>${name}</d:displayname>
<c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>
</d:prop></d:set></c:mkcalendar>`, { 'Content-Type': 'application/xml' })
    return path
  }

  async mkaddressbook(slug: string, name: string): Promise<string> {
    await this.init()
    const path = `${this.base}${slug}/`
    await this.ok('MKCOL', path, `<?xml version="1.0" encoding="utf-8"?>
<d:mkcol xmlns:d="DAV:" xmlns:cr="urn:ietf:params:xml:ns:carddav"><d:set><d:prop>
<d:resourcetype><d:collection/><cr:addressbook/></d:resourcetype>
<d:displayname>${name}</d:displayname>
</d:prop></d:set></d:mkcol>`, { 'Content-Type': 'application/xml' })
    return path
  }

  async put(path: string, body: string, type: 'text/calendar' | 'text/vcard') {
    await this.ok('PUT', path, body, { 'Content-Type': `${type}; charset=utf-8` })
  }

  /** Bodies of every resource in a collection, keyed by href. */
  async list(collection: string): Promise<Record<string, string>> {
    const r = await this.ok('PROPFIND', collection, `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/></d:prop></d:propfind>`, { Depth: '1', 'Content-Type': 'application/xml' })
    const hrefs = [...r.text.matchAll(/<(?:\w+:)?href>([^<]+)<\/(?:\w+:)?href>/g)].map(m => m[1]).filter(h => h.replace(/\/$/, '') !== collection.replace(/\/$/, ''))
    const out: Record<string, string> = {}
    for (const h of hrefs) out[h] = (await this.ok('GET', h)).text
    return out
  }
}

/** One VEVENT calendar object. */
export function ics(uid: string, props: string[]): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//e2e//EN', 'BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20260101T000000Z', ...props, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n')
}

/** YYYYMMDD of a local date. */
export function ymd(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}
