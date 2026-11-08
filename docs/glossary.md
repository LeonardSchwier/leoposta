# Glossary

| Term | Meaning |
|------|---------|
| Account | One IMAP/SMTP mailbox configuration. Several can exist; the `x-account` header picks one per request. |
| API token | Shared secret in the `x-leoposta-token` header that every `/api` call except `GET /api/health` must carry. See [ADR 0003](adr/0003-api-token.md). |
| Backend | The Node.js/Express server in `server/`. Speaks IMAP/SMTP, serves the built app. |
| Data directory | Where the backend keeps JSON state and PGP keys (`LEOPOSTA_DATA_DIR`, default `server/`; `/data` in the container). |
| `dist/` | Output of `npm run build`: the static PWA served by the backend. |
| Fixture mailbox | The fictional mailbox served by `scripts/dummy/imap.cjs` for tests and screenshots. |
| Leoforma | The shared design-token package `@leonardschwier/leoforma`; tokens appear as `--ds-*` CSS variables. |
| Outbox | IndexedDB queue of messages composed offline, sent when the connection returns. |
| PWA | Progressive web app: installable, with a service worker that caches the app shell. |
| Rule | A user-defined filter (conditions and actions) evaluated by `server/lib/rules.js`. |
| Scheduled send | A message stored by the backend and sent at a chosen time by a 30-second timer. |
| Tauri shell | The Rust desktop wrapper in `src-tauri/` that starts the backend and shows the app in a webview. |
