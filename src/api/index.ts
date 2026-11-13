import { attachmentPath } from '../lib/attachmentDownload'

const API_BASE = import.meta.env.VITE_API_URL || ''
const API_TOKEN: string = import.meta.env.VITE_LEOPOSTA_TOKEN || ''
const withToken = (url: string) => (API_TOKEN ? `${url}?token=${encodeURIComponent(API_TOKEN)}` : url)

/** Active account email; when set, every request is scoped to it via x-account. */
let activeAccountEmail: string | null = null
export function setActiveAccountEmail(email: string | null) {
  activeAccountEmail = email
}

function authHeaders(extra: HeadersInit = {}): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-leoposta-token': API_TOKEN,
    ...(activeAccountEmail ? { 'x-account': activeAccountEmail } : {}),
    ...Object.fromEntries(new Headers(extra))
  }
}

/** fetch() with the API token + account headers; use for raw stream calls. */
export function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  return fetch(input, { ...init, headers: authHeaders(init.headers) })
}

async function api(path: string, options: RequestInit = {}): Promise<any> {
  const res = await fetch(`${API_BASE}/api${path}`, {
    ...options,
    headers: authHeaders(options.headers)
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || `API error ${res.status}`)
  }
  return res.json()
}

export const AccountAPI = {
  list: () => api('/accounts'),
  add: (data: any) => api('/accounts', { method: 'POST', body: JSON.stringify(data) }),
  update: (email: string, data: any) =>
    api(`/accounts/${encodeURIComponent(email)}`, { method: 'PUT', body: JSON.stringify(data) }),
  remove: (email: string) =>
    api(`/accounts/${encodeURIComponent(email)}`, { method: 'DELETE' }),
}

export const MailAPI = {
  status: () => api('/status'),
  account: () => api('/account'),
  messages: (folder: string, limit = 50) => api(`/messages?folder=${folder}&limit=${limit}`),
  message: (id: string, folder: string) => api(`/message/${id}?folder=${folder}`),
  folders: () => api('/folders'),
  search: (query: string, folder = 'INBOX') => api(`/search?q=${encodeURIComponent(query)}&folder=${folder}`),
  send: (data: any) => api('/send', { method: 'POST', body: JSON.stringify(data) }),
  delete: (id: string, folder: string) => api(`/message/${id}?folder=${folder}`, { method: 'DELETE' }),
  move: (id: string, from: string, to: string) => api(`/message/${id}/move`, {
    method: 'POST', body: JSON.stringify({ from, to })
  }),
  setFlags: (id: string, folder: string, add: string[], remove: string[]) =>
    api(`/message/${id}/flags`, {
      method: 'POST', body: JSON.stringify({ folder, add, remove })
    }),
  addFolder: (name: string, parentId?: string) => api('/folder', {
    method: 'POST', body: JSON.stringify({ name, parentId })
  }),
  deleteFolder: (name: string) => api(`/folder?path=${encodeURIComponent(name)}`, { method: 'DELETE' }),
  renameFolder: (from: string, to: string) => api('/folder/rename', {
    method: 'POST', body: JSON.stringify({ from, to })
  }),
  /** Authenticated download of one received attachment (see lib/attachmentDownload). */
  attachment: (id: string, attachmentId: string, folder: string) =>
    apiFetch(`${API_BASE}${attachmentPath(id, attachmentId, folder)}`),
  scheduled: () => api('/scheduled'),
  cancelScheduled: (id: string) => api(`/scheduled/${id}`, { method: 'DELETE' }),
  idle: () => {
    const base = withToken(`${API_BASE}/api/idle`)
    return activeAccountEmail ? `${base}&account=${encodeURIComponent(activeAccountEmail)}` : base
  },
}

/** Map a DAV server entry ({href, displayname, etag}) to the UI shape ({uri, name}). */
function toCal(e: any) { return { uri: e.href ?? e.uri, name: e.displayname ?? e.name ?? '' } }

export const CalendarAPI = {
  calendars: () => api('/calendar/calendars').then((r: any) => ({
    calendars: (r.calendars || []).map(toCal)
  })),
  events: (calendar: string, start: string, end: string) =>
    api(`/calendar/events?calendar=${encodeURIComponent(calendar)}&start=${start}&end=${end}`),
  saveEvent: (calendar: string, ics: string, uid?: string) =>
    api('/calendar/event', { method: 'PUT', body: JSON.stringify({ calendar, ics, uid }) }),
  deleteEvent: (calendar: string, uid: string) =>
    api(`/calendar/event?calendar=${encodeURIComponent(calendar)}&uid=${encodeURIComponent(uid)}`, { method: 'DELETE' }),
  importICS: (calendar: string, ics: string) =>
    api('/calendar/import', { method: 'POST', body: JSON.stringify({ calendar, ics }) }),
}

export const ContactsAPI = {
  addressBooks: () => api('/contacts/calendars').then((r: any) => ({
    addressBooks: (r.addressBooks || r.calendars || []).map(toCal)
  })),
  contacts: (book: string, q?: string) =>
    api(`/contacts?book=${encodeURIComponent(book)}${q ? `&q=${encodeURIComponent(q)}` : ''}`),
  saveContact: (book: string, vcf: string) =>
    api('/contact', { method: 'PUT', body: JSON.stringify({ book, vcf }) }),
  deleteContact: (book: string, uid: string) =>
    api(`/contact?book=${encodeURIComponent(book)}&uid=${encodeURIComponent(uid)}`, { method: 'DELETE' }),
  importVCF: (book: string, vcf: string) =>
    api('/contacts/import', { method: 'POST', body: JSON.stringify({ book, vcf }) }),
}
