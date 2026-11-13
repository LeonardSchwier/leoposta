import { describe, it, expect, vi, afterEach } from 'vitest'
import { apiFetch } from '../api/index'

// Regression: a caller-supplied 'Content-Type' (as Compose and the offline
// queue pass) used to be merged next to the default 'Content-Type' under a
// differently-cased key, so fetch sent "application/json, application/json".
// express.json() doesn't recognise that, req.body stayed undefined, and
// /api/send failed with "Cannot destructure property 'to' of req.body".
describe('apiFetch headers', () => {
  afterEach(() => vi.unstubAllGlobals())

  function sentHeaders(init: RequestInit): Headers {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)
    apiFetch('/api/send', init)
    return new Headers(fetchMock.mock.calls[0][1].headers)
  }

  it('sends a single JSON content type when the caller also sets one', () => {
    const h = sentHeaders({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    expect(h.get('content-type')).toBe('application/json')
  })

  it('lets a caller override the content type instead of appending to it', () => {
    const h = sentHeaders({ headers: { 'content-type': 'text/plain' } })
    expect(h.get('content-type')).toBe('text/plain')
  })

  it('always carries the API token', () => {
    const h = sentHeaders({})
    expect(h.has('x-leoposta-token')).toBe(true)
  })
})
