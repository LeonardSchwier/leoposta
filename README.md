# Evolution Mail

A modern, web-based mail client with a clean, familiar native-mail UX.

## Features

- 📧 **IMAP/SMTP** - Connect to any mail provider
- 🎨 **Polished UX** - Clean, familiar interface
- 📱 **PWA** - Installable on mobile and desktop
- 🕐 **Scheduled Send** - Queue emails for later delivery
- 📎 **Attachments** - Full attachment support
- 🌙 **Dark Mode** - System-aware theming
- ⚡ **Fast** - Built with Svelte 5 and Vite
- 🔒 **Local-First** - Your mail stays on your device

## Tech Stack

- **Frontend**: Svelte 5, TypeScript, Tailwind CSS
- **Backend**: Node.js, Express, ImapFlow, Nodemailer
- **State**: Zustand
- **Build**: Vite

## Getting Started

### Prerequisites

- Node.js 18+
- npm 9+

### Installation

```bash
# Clone the repo
git clone <repo-url>
cd evolution-mail

# Install dependencies
npm install

# Configure your mail account
# (via the Settings panel in the UI)

# Start the backend
npm run server

# Start the frontend (in a new terminal)
npm run dev
```

### Production Build

```bash
npm run build
npm run preview
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/messages?folder=INBOX&limit=50` | List messages |
| GET | `/api/message/:id?folder=INBOX` | Get single message |
| POST | `/api/account` | Configure mail account |
| POST | `/api/send` | Send or schedule email |

## Development

### Testing

```bash
# Unit tests
npm test

# E2E tests
npm run test:e2e
```

### Code Quality

```bash
# Lint
npm run lint

# Type check
npx tsc --noEmit
```

## License

MIT
