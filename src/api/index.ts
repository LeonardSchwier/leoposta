const API_BASE = import.meta.env.VITE_API_URL || ''
const API_TOKEN: string = import.meta.env.VITE_LEOPOSTA_TOKEN || ''
const withToken = (url: string) => (API_TOKEN ? `${url}?token=${encodeURIComponent(API_TOKEN)}` : url)

async function api(path: string, options: RequestInit = {}): Promise<any> {
  const res = await fetch(`${API_BASE}/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'x-leoposta-token': API_TOKEN, ...options.headers }
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(err.error || `API error ${res.status}`)
  }
  return res.json()
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
  attachmentUrl: (id: string, partId: string) =>
    withToken(`${API_BASE}/api/message/${id}/attachment/${partId}`),
  scheduled: () => api('/scheduled'),
  cancelScheduled: (id: string) => api(`/scheduled/${id}`, { method: 'DELETE' }),
  idle: () => withToken(`${API_BASE}/api/idle`),
}

export const CalendarAPI = {
  calendars: () => api('/calendar/calendars'),
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
  addressBooks: () => api('/contacts/calendars'),
  contacts: (book: string, q?: string) =>
    api(`/contacts?book=${encodeURIComponent(book)}${q ? `&q=${encodeURIComponent(q)}` : ''}`),
  saveContact: (book: string, vcf: string) =>
    api('/contact', { method: 'PUT', body: JSON.stringify({ book, vcf }) }),
  deleteContact: (book: string, uid: string) =>
    api(`/contact?book=${encodeURIComponent(book)}&uid=${encodeURIComponent(uid)}`, { method: 'DELETE' }),
  importVCF: (book: string, vcf: string) =>
    api('/contacts/import', { method: 'POST', body: JSON.stringify({ book, vcf }) }),
}
