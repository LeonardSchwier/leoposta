# Evolution Mail — Apple-Mail-inspired Web Mail Client

## Mission
Build a complete, standalone web-based mail client with Apple Mail UX.
It must work offline (PWA), support IMAP/SMTP, and include all mail features.

## Tech Stack
- **Frontend:** Svelte 5 + TypeScript (or React 18 + TypeScript — your choice)
- **Styling:** Tailwind CSS v4 (Apple-inspired: clean, minimal, SF Pro-like font stack)
- **State:** Zustand (or Redux Toolkit)
- **IMAP:** imapflow (Node.js IMAP client) running as a backend service
- **SMTP:** nodemailer for sending
- **Offline:** Service Worker + IndexedDB for offline reading
- **Scheduled Send:** Server-side cron + local notification
- **PWA:** vite-plugin-pwa for installable standalone app
- **Build:** Vite 6
- **Testing:** Vitest + Playwright (E2E)

## Apple Mail UX Requirements
- **Sidebar:** Clean folder list with icons, collapsible, subtle hover states
- **Message List:** Two-column (list + preview), smooth animations, swipe actions
- **Compose:** Clean modal/sheet, rich text editor (contenteditable or ProseMirror)
- **Search:** Command palette (Cmd+K) for searching mail, folders, contacts
- **Dark Mode:** System-aware, Apple-style dark palette
- **Typography:** -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif
- **Animations:** 200ms ease-in-out transitions, no jarring jumps
- **Touch:** Swipe to archive/delete, long-press for context menu
- **Keyboard:** Full keyboard navigation, shortcuts in Apple Mail style

## Feature Checklist (COMPLETE — build ALL)
### Core
- [ ] IMAP account setup wizard (server, port, TLS, username, password)
- [ ] Multi-account support
- [ ] Folder tree (INBOX, Sent, Drafts, Trash, Spam + custom)
- [ ] Message list with sender, subject, preview, date, unread indicator
- [ ] Message reading pane with HTML rendering (sanitized)
- [ ] Inline images (CID)
- [ ] Attachments: download, preview (PDF, images), file manager
- [ ] Reply, Reply All, Forward with proper threading
- [ ] Thread view (grouped by conversation)
- [ ] Compose: rich text, CC/BCC, priority, scheduled send
- [ ] Send immediately or schedule (pick date/time)
- [ ] Save to Drafts
- [ ] Archive, Delete, Move to folder
- [ ] Mark as Read/Unread, Star/Favorite
- [ ] Search (subject, from, to, body, date range)
- [ ] Filters/Rules (auto-move, auto-label)
- [ ] Labels/Tags (multi-label per message)
- [ ] Contact extraction from mail, address book
- [ ] Autocomplete for To/CC/BCC from contacts
- [ ] Signature support
- [ ] Keyboard shortcuts (Apple Mail style)

### Offline (PWA)
- [ ] Service Worker with precaching
- [ ] IndexedDB local cache of recent messages
- [ ] Offline reading (last N messages per folder)
- [ ] Offline compose (queue for send when online)
- [ ] Sync on reconnect (IMAP IDLE → fetch new)
- [ ] Install prompt, standalone mode, app icon

### UX Polish
- [ ] Dark mode (system + manual toggle)
- [ ] Responsive (mobile, tablet, desktop)
- [ ] Smooth animations (Framer Motion or CSS)
- [ ] Context menus (right-click)
- [ ] Command palette (Cmd+K)
- [ ] Empty states with illustrations
- [ ] Loading skeletons
- [ ] Error toasts (non-blocking)
- [ ] Settings page (account management, appearance, shortcuts)

### Security
- [ ] Password stored in browser (WebCrypto or keytar)
- [ ] TLS enforced (no plaintext)
- [ ] XSS sanitization of HTML mail
- [ ] CSRF protection on API endpoints
- [ ] No third-party trackers, no external fonts (system font stack)

## Architecture
```
evolution-mail/
├── src/
│   ├── app/              # Svelte/React app
│   │   ├── components/   # UI components
│   │   ├── pages/        # Routes
│   │   ├── stores/       # State management
│   │   ├── services/     # API clients
│   │   ├── workers/      # Service worker
│   │   └── utils/        # Helpers
│   ├── server/           # Node.js backend
│   │   ├── imap/         # IMAP client wrapper
│   │   ├── smtp/         # SMTP sending
│   │   ├── api/          # REST API routes
│   │   ├── scheduler/    # Scheduled send
│   │   └── storage/      # Account config storage
│   └── shared/           # Types, constants
├── public/
│   ├── icons/            # PWA icons
│   └── sw.js             # Service worker (if not generated)
├── tests/
│   ├── unit/
│   └── e2e/
├── package.json
├── vite.config.ts
├── svelte.config.js
└── README.md
```

## API Design
REST API served by the Node.js backend:
- `POST /api/accounts` — Create IMAP account
- `GET /api/folders` — List folders
- `GET /api/messages?folder=INBOX&limit=50&offset=0` — List messages
- `GET /api/messages/:id` — Get message
- `POST /api/messages/:id/reply` — Reply
- `POST /api/messages/:id/forward` — Forward
- `POST /api/messages` — Send (compose)
- `POST /api/messages/:id/move` — Move to folder
- `POST /api/messages/:id/star` — Toggle star
- `POST /api/search?q=...` — Search
- `GET /api/contacts` — List contacts
- `POST /api/scheduled` — List scheduled sends
- `DELETE /api/accounts/:id` — Remove account

## Build Commands
```bash
npm install
npm run dev          # Dev server (frontend + backend)
npm run build        # Production build
npm run test         # Unit tests
npm run test:e2e     # E2E tests
npm run lint         # ESLint + Prettier
```

## Testing
- Unit: Vitest for components, utilities, API handlers
- Integration: Supertest for API endpoints
- E2E: Playwright for full user flows
- Visual: Screenshot tests for key screens

## Important
- This is a STANDALONE app — no external dependencies except npm
- Offline-first: app must be fully usable without network (for reading cached mail)
- Apple Mail UX: clean, minimal, fast, intuitive
- Security: no plaintext passwords, TLS everywhere, sanitized HTML
- Performance: virtualized list for large inboxes, lazy loading
- Accessibility: ARIA labels, screen reader support, keyboard nav

## REA (Reverse Engineering) Integration
Use REA to analyze GNOME Evolution's architecture and Apple Mail's UX patterns.
REA is configured as an MCP server in OpenCode's config.
