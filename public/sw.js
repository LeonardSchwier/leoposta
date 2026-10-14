const CACHE_NAME = 'leoposta-v1'
const QUEUE_NAME = 'leoposta-queue'
const urlsToCache = ['/', '/index.html']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(urlsToCache))
  )
})

// Queue failed POST/PUT requests (offline send)
async function addToQueue(request, body) {
  const db = await indexedDB.open('leoposta', 1)
  db.onupgradeneeded = (e) => {
    const store = e.target.result.createObjectStore('queue', { keyPath: 'id', autoIncrement: true })
  }
  const tx = db.transaction('queue', 'readwrite')
  tx.objectStore('queue').add({
    url: request.url,
    method: request.method,
    headers: Object.fromEntries(request.headers.entries()),
    body: body,
    timestamp: Date.now()
  })
  return new Promise((resolve) => {
    tx.oncomplete = resolve
    tx.onerror = () => resolve(null)
  })
}

async function processQueue() {
  const db = await indexedDB.open('leoposta', 1)
  const tx = db.transaction('queue', 'readwrite')
  const store = tx.objectStore('queue')
  
  const all = await new Promise((resolve) => {
    const req = store.getAll()
    req.onsuccess = () => resolve(req.result || [])
  })
  
  for (const item of all) {
    try {
      const res = await fetch(item.url, {
        method: item.method,
        headers: item.headers,
        body: item.body ? JSON.stringify(item.body) : undefined
      })
      if (res.ok) {
        store.delete(item.id)
      }
    } catch (e) {
      break // still offline, stop processing
    }
  }
}

// Process queue when online
self.addEventListener('online', () => {
  processQueue()
})

// Process queue on service worker start
self.addEventListener('activate', () => {
  processQueue()
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  
  // GET requests: cache-first
  if (request.method === 'GET') {
    event.respondWith(
      caches.match(request).then((cached) => {
        const fetched = fetch(request).catch(() => null)
        if (cached) return cached
        return fetched || Response.error()
      })
    )
    return
  }
  
  // POST/PUT/DELETE: network-first, queue on failure
  if (request.method === 'POST' || request.method === 'PUT' || request.method === 'DELETE') {
    event.respondWith(
      fetch(request)
        .catch(async (err) => {
          // Offline — queue the request
          const body = await request.clone().json().catch(() => null)
          await addToQueue(request, body)
          return new Response(JSON.stringify({
            queued: true,
            message: 'Message queued for offline sending. It will be sent when you are back online.',
            error: 'offline'
          }), {
            status: 202,
            headers: { 'Content-Type': 'application/json' }
          })
        })
    )
  }
})
