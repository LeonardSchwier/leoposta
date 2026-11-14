// Reads mail + WebDAV accounts from GNOME Online Accounts (GOA) so Settings
// can offer "import" instead of hand-typing host/port/username again.
//
// Linux + native (non-container) runs only: this talks to the session D-Bus
// bus via `busctl`, which doesn't exist inside the Docker image's namespace
// or on non-Linux Tauri builds. Every export here fails soft —
// `null`/`[]`/`false`, never a thrown error — so the route layer can turn
// "not available" into a quiet 503 instead of a 500.
//
// Verified against a real `leonard@schwier.org` account (one `imap_smtp`,
// one `webdav`) added through GNOME Settings → Online Accounts — see
// docs/design/goa-import.md for how.
import { execFile } from 'node:child_process'

const SUPPORTED_PROVIDER_TYPES = new Set(['imap_smtp', 'webdav'])
const EXEC_OPTS = { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }

// Swappable for tests — avoids a real child_process / D-Bus in CI.
let _execFile = execFile
export function _setExecFileForTest(fn) { _execFile = fn || execFile }

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    _execFile(cmd, args, EXEC_OPTS, (err, stdout) => {
      if (err) return reject(err)
      resolve(String(stdout))
    })
  })
}

/**
 * LEOPOSTA_GOA=off: never touch the session D-Bus (GOA reports "not
 * available"). The e2e and test servers set it, so a test run on a desktop
 * cannot read, show or import the host user's real GNOME Online Accounts.
 */
export function isGoaDisabled() {
  return /^(off|0|false|no)$/i.test(String(process.env.LEOPOSTA_GOA || '').trim())
}

function busctl(args) {
  if (isGoaDisabled()) return Promise.reject(Object.assign(new Error('GNOME Online Accounts disabled (LEOPOSTA_GOA=off)'), { code: 'GOA_DISABLED' }))
  return run('busctl', ['--user', '--json=short', ...args])
}

// busctl's `--json=short` wraps every D-Bus value as {type, data}; unwrap
// recursively so callers see plain JS values.
function unwrap(v) {
  if (v && typeof v === 'object' && 'type' in v && 'data' in v) return unwrap(v.data)
  if (Array.isArray(v)) return v.map(unwrap)
  if (v && typeof v === 'object') {
    const out = {}
    for (const [k, val] of Object.entries(v)) out[k] = unwrap(val)
    return out
  }
  return v
}

export async function isGoaAvailable() {
  try {
    await busctl(['call', 'org.gnome.OnlineAccounts', '/org/gnome/OnlineAccounts',
      'org.freedesktop.DBus.Peer', 'Ping'])
    return true
  } catch {
    return false
  }
}

function mailFields(ifaces) {
  const m = ifaces['org.gnome.OnlineAccounts.Mail']
  if (!m) return null
  return {
    email: m.EmailAddress,
    imapHost: m.ImapHost,
    imapPort: m.ImapUseSsl ? 993 : 143,
    imapTls: !!m.ImapUseSsl,
    imapUser: m.ImapUserName || m.EmailAddress,
    smtpHost: m.SmtpHost,
    smtpPort: m.SmtpUseSsl ? 465 : 587,
    smtpTls: !!m.SmtpUseSsl,
    smtpUser: m.SmtpUserName || m.EmailAddress
  }
}

// GOA's Calendar/Contacts `Uri` is an already-resolved concrete collection
// (e.g. `https://user%40example.test@dav.example.test/caldav`), not a
// discoverable base — and leoposta's own DAV auto-discovery
// (lib/dav.js resolveDavBase, RFC 4791/6352) reuses one `davUrl` basePath
// for both calendar and contacts. So: take the host only and let leoposta
// discover the calendar-home-set / addressbook-home-set itself, same as a
// manually-entered "https://dav.example.test/" would.
function davFields(ifaces) {
  const uri = ifaces['org.gnome.OnlineAccounts.Calendar']?.Uri
    || ifaces['org.gnome.OnlineAccounts.Contacts']?.Uri
  if (!uri) return null
  try {
    const u = new URL(uri)
    return { davUrl: `${u.protocol}//${u.host}/` }
  } catch {
    return null
  }
}

/**
 * List GOA accounts of the two provider types leoposta can use. Returns a
 * sanitized summary (no passwords) per account: the raw interface data is
 * kept internally for import, not serialized to callers.
 */
export async function listGoaAccounts() {
  let raw
  try {
    raw = await busctl(['call', 'org.gnome.OnlineAccounts', '/org/gnome/OnlineAccounts',
      'org.freedesktop.DBus.ObjectManager', 'GetManagedObjects'])
  } catch {
    return []
  }
  let parsed
  try { parsed = JSON.parse(raw) } catch { return [] }
  const objects = unwrap(parsed.data?.[0]) || {}
  const out = []
  for (const [path, ifaces] of Object.entries(objects)) {
    const acct = ifaces['org.gnome.OnlineAccounts.Account']
    if (!acct || !SUPPORTED_PROVIDER_TYPES.has(acct.ProviderType)) continue
    const mail = mailFields(ifaces)
    const dav = davFields(ifaces)
    if (!mail && !dav) continue
    out.push({
      goaId: acct.Id || path.split('/').pop(),
      path,
      providerType: acct.ProviderType,
      providerName: acct.ProviderName,
      identity: acct.PresentationIdentity || acct.Identity,
      hasMail: !!mail,
      hasDav: !!dav,
      _mail: mail,
      _dav: dav
    })
  }
  return out
}

/**
 * GetPassword over `org.gnome.OnlineAccounts.PasswordBased` — the GOA
 * daemon's own, keyring-mediated channel (no direct libsecret/attribute
 * guessing). `id` is `"imap-password"`/`"smtp-password"` for a mail
 * account, `""` for a webdav account (both confirmed against a live
 * account; a mismatched id raises "Did not find <id> with identity … in
 * credentials", caught here and turned into `null`).
 */
export async function getGoaPassword(objectPath, id) {
  try {
    const raw = await busctl(['call', 'org.gnome.OnlineAccounts', objectPath,
      'org.gnome.OnlineAccounts.PasswordBased', 'GetPassword', 's', id])
    const parsed = JSON.parse(raw)
    const pass = unwrap(parsed.data?.[0])
    return typeof pass === 'string' && pass.length ? pass : null
  } catch {
    return null
  }
}

function sameAddress(a, b) {
  return !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase()
}

/**
 * Resolve one GOA account to a leoposta account payload (shape expected by
 * `accountPayloadFrom` in lib/state.js).
 */
export async function resolveGoaImport(goaId, { importMail = true, importDav = true } = {}) {
  const accounts = await listGoaAccounts()
  const acct = accounts.find(a => a.goaId === goaId)
  if (!acct) return null

  const payload = {}
  if (importMail && acct._mail) {
    Object.assign(payload, acct._mail)
    const [imapPass, smtpPass] = await Promise.all([
      getGoaPassword(acct.path, 'imap-password'),
      getGoaPassword(acct.path, 'smtp-password')
    ])
    payload.imapPass = imapPass
    payload.smtpPass = smtpPass
  }
  // GNOME keeps mail and Calendar/Contacts as two separate accounts
  // (imap_smtp + webdav). Importing the mail account also takes the WebDAV
  // account of the same address, so one "Import" gives working mail,
  // Calendar and Contacts (importing only the mail account used to leave
  // davUrl empty).
  const davSource = acct._dav ? acct
    : (importDav && acct._mail ? accounts.find(o => o._dav && !o._mail && sameAddress(o.identity, acct._mail.email)) : null)
  if (importDav && davSource) {
    Object.assign(payload, davSource._dav)
    payload.davUser = davSource.identity
    payload.davPass = await getGoaPassword(davSource.path, '')
  }
  if (!payload.email) payload.email = acct.identity
  return payload
}
