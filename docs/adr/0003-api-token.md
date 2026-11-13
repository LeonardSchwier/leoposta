# 3. Shared API token, compared in constant time

Status: accepted

## Context
The backend listens on a local port. Without authentication, any local process or any web
page that can reach the port could read mail or send as the user.

## Decision
Every `/api` route except `GET /api/health` requires the header `x-leoposta-token`. The
value comes from `LEOPOSTA_TOKEN` or is generated randomly at start. The comparison uses
`crypto.timingSafeEqual` ([auth.js](../../server/lib/auth.js)). `EventSource` cannot set
headers, so `GET /api/idle` also accepts `?token=` (attachment downloads did too until
2026-11-13; the client now fetches them with the header and saves a Blob). CORS only
allows the origins in `ALLOWED_ORIGINS`.

## Consequences
- The frontend must know the token. It receives it at build time (`VITE_LEOPOSTA_TOKEN`);
  the container image substitutes it at start ([ADR 0005](0005-container-image.md)).
- The token is visible to anyone who can load the app, so the port must stay on loopback
  or behind a trusted proxy. It protects against other origins and processes, not against
  an untrusted network.
- `?token=` can appear in URLs and logs, so it is limited to the one route that needs it.
