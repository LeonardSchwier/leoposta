# Evolution Mail

A standalone web-based mail client with Apple Mail UX.
Built with Svelte 5, Tailwind CSS, and a Node.js IMAP/SMTP backend.

## Features
- Complete mail client: IMAP/SMTP, multi-account, folders, threading
- Apple Mail UX: clean, minimal, dark mode, smooth animations
- PWA: offline reading, installable standalone app, scheduled send
- Search: full-text, command palette (Cmd+K), keyboard shortcuts
- Security: TLS, WebCrypto password storage, XSS sanitization

## Quick Start
```bash
npm install
npm run dev
# Open http://localhost:5173
```

## Tech Stack
- Svelte 5 + TypeScript
- Tailwind CSS v4
- Node.js (IMAP/SMTP backend)
- IndexedDB (offline cache)
- Service Worker (PWA)
- Vite 6

## Testing
```bash
npm test          # Unit
npm run test:e2e  # E2E (Playwright)
```

## License
MIT
