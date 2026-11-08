# 4. Offline cache and outbox in IndexedDB

Status: accepted

## Context
The app should list and read recent mail and accept new mail without a connection, and
installing it should feel like a native client.

## Decision
A service worker (vite-plugin-pwa) caches the app shell and never caches `/api` calls
(`NetworkOnly`). Message summaries and bodies are cached in IndexedDB (`leoposta-queue`
database, `messages` store), and composed messages go to an `outbox` store when sending
fails ([offlineQueue.ts](../../src/lib/offlineQueue.ts)). Tests use `fake-indexeddb`.

## Consequences
- Mail content is stored in the browser profile in plain form; clearing site data removes it.
- The outbox is per browser, not per account on the server.
- Cache invalidation is simple (replace on fetch) but not conflict-aware.
