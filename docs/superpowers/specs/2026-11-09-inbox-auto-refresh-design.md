# Inbox auto-refresh — design

Date: 2026-11-09
Status: approved in chat by user (approaches + design, "ok")

## Intent + why

With INBOX open, a stale message list stays stale until the user re-navigates
or reloads. The user wants background refresh of the *message list* only,
at a configurable interval, with **no interference while typing** in any
compose/event/contact form or any focused input. Options: 5/15/60 min,
plus an "Instant" (push) option the user approved after being told the
server already exposes IMAP IDLE via SSE.

## Goals

- `Settings` exposes a refresh-interval picker: **Instant (default) / 5 min /
  15 min / 60 min / Off**, persisted (localStorage), applied live (no app
  reload).
- Timer mode: re-fetch `loadMessages(activeFolder)` every N minutes —
  message list + unread badge only.
- Instant mode: consume the existing `GET /api/idle` SSE stream; on
  `new-messages` / `expunge` / `fetch` frames, re-fetch the active folder's
  list.
- **Guard:** skip a refresh if `document.activeElement` is
  `input | textarea | select | [contenteditable]`.
- Detail pane stays put when a list refresh happens (existing
  `loadMessages` already preserves selection — verify, don't rewrite it).

## Non-goals

- No desktop notifications, no sound.
- No per-folder intervals.
- No "last synced at" indicator in the UI (console/log only, if at all).
- No server changes: `server/routes/idle.js` (IMAP IDLE + SSE) and
  `GET /api/messages` already exist and are covered by server tests.

## Approaches considered

1. **Timer-only `setInterval`** (5/15/60 min). Simple; up to 60 min stale.
2. **SSE/IMAP IDLE push** (Instant). Zero wasted requests, instant; needs a
   small `EventSource` glue and reconnect.
3. **Do both** (chosen): Instant as default, timer options for users who
   prefer low-churn, `Off` for those who want manual only.
   - Why not push-only: some IMAP providers cap IDLE (server already caps at
     29 min) and disconnects happen under load; a timer is a cheap fallback
     and also covers the "server IDLE died" case.

## Decisions (user-approved)

- D1: 4 options + Off, default **Instant**.
- D2: typing/focus guard applies to timers and push events alike.
- D3: no new server code; frontend-only change.

## Where things go

| File | Change |
|---|---|
| `src/store/index.ts` | `refreshInterval: 'instant' \| '5m' \| '15m' \| '60m' \| 'off'` state + setter; localStorage read/write |
| `src/refresh.ts` (new) | `startRefresh(mode, onTick)` — owns the `EventSource` / `setInterval`; auto-teardown; focus guard exported as `isTypingFocused()` |
| `src/App.svelte` | `$effect` on `$store.refreshInterval` to start/stop; pass `loadMessages(activeFolder)` as `onTick`; teardown on unmount |
| `src/components/Settings.svelte` | "Sync" section: radio group + persisted binding |
| `src/__tests__/refresh.test.ts` (new) | focus-guard unit tests + start/stop shape tests (with a fake EventSource) |

## Verification

- `npx vitest run` (new tests + existing 96)
- `npm run typecheck`
- Manual: switch settings live; confirm no fetch while typing in compose
  (DevTools Network tab); confirm badge increments on a test mail delivery.

## Builder notes

- `appFetch` base is already in `src/api/index.ts` (L21-23) — reuse it to
  build the `/api/idle` URL; open it with `new EventSource(url)`; listen to
  `mailbox-update` (the only event name with payload — see
  `server/routes/idle.js` L36-44).
- SSE `EventSource` auto-reconnects natively; no custom backoff needed.
- `server/routes/idle.js` holds one IMAP session per open stream; the
  frontend must call `close()` on the old `EventSource` before opening a
  new one when the user switches modes or accounts.
- Multi-account: when `activeAccountId` changes, close and
  re-open the SSE stream (the server binds to the active account at
  connect time).
