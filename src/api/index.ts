const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001'

async function api(path: string, options: RequestInit = {}): Promise<any> {
  const res = await fetch(`${API_BASE}/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers }
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
  setFlags: (id: string, folder: string, flags: string[]) => api(`/message/${id}/flags`, {
    method: 'POST', body: JSON.stringify({ folder, flags })
  }),
  addFolder: (name: string, parent?: string) => api('/folder', {
    method: 'POST', body: JSON.stringify({ name, parent })
  }),
  deleteFolder: (name: string) => api('/folder', { method: 'DELETE', body: JSON.stringify({ name }) }),
  attachmentUrl: (id: string, partId: string) =>
    `${API_BASE}/api/message/${id}/attachment/${partId}`,
  scheduled: () => api('/scheduled'),
  cancelScheduled: (id: string) => api(`/scheduled/${id}`, { method: 'DELETE' }),
  idle: () => `${API_BASE}/api/idle`,
}
