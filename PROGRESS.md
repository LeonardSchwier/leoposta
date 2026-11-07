# PROGRESS — leoposta open-todos batch

## Goal
Work through remaining open ROADMAP items independently, commit + push each, until done or blocked.

## Done (this batch)
- C4 — Playwright E2E journeys (56920ab)
- C5 — docs(roadmap): correct false claims + record first CI run (5b3019a)
- D1 — Leoforma design tokens + fonts (ae026c1)
- C6 — Split `server/index.js` → `server/lib/` + `server/routes/`; 84 lines of wiring (84931ac)
- C6 — Routes snapshot test (`server/routes.snapshot.json`, 35 routes) (2a4788d)
- ROADMAP — mark Email signature as shipped (it landed earlier and was un-ticked) (ac97523)
- Compose attachments: `src/lib/attachments.ts` (25 MiB ceiling, chunked btoa, typed
  `AttachmentTooLargeError`), 8 new tests; wired into `Compose.svelte` (chip UI,
  send payload, offline queue); `offlineQueue.ts` carries `attachments` through
  IndexedDB; fixed `sendScheduledMessage()` to forward `msg.attachments` (was a
  latent bug — scheduled sends with attachments lost them). New server test
  "scheduled send with attachments persists the attachments on disk" (79126f1)
- Virtualised list: `src/lib/virtualList.ts` (pure `computeVirtualRange` +
  8 unit tests), `MessageList.svelte` renders only the visible slice between
  two spacers; row height fixed at 64px (mobile actions moved to context menu)
- Filter / rules (P1): `server/lib/rules.js` (matchRule/applyRules, 18 tests),
  rules persisted to `rules.json`, `GET/PUT /api/rules`, applied in mail.js
  list + search; `src/lib/rules.ts` types; `Settings.svelte` Rules tab
  (add/remove conditions + actions) (538c0d9)
- Offline mail cache (P1): `offlineQueue.ts` `messages` store (folder:id key),
  cache-aside in `App.svelte` (list fallback on API failure + full-message
  restore + resync on reconnect); `fake-indexeddb@6.2.7` dev dep;
  `src/__tests__/offlineCache.test.ts` (8 tests)

## Active
- Multi-account support (P0 — next)

## Blocked
- (none)

## Remaining backlog (in order)
1. Multi-account support (P0 — cross-cutting; needs its own session)
2. ~~Filter / rules (P1)~~ — done 538c0d9
3. ~~Virtualised list (P1)~~ — done 261ac09
4. Design-system restyle (P1, gated on `LeonardSchwier/design-system` repo)
5. ~~Offline mail cache (P1)~~ — done (this batch)
6. Mobile / touch refinements (P2)
7. Calendar + Contacts polish (P2)
8. i18n (P2)

## Context
- Repo: /home/leonard/opencode/leoposta
- Remote: `github` (https://github.com/LeonardSchwier/leoposta.git)
- Node v22; `node:test` + vitest dual harness
- Commit style: `type(scope): summary (item)` + brief body listing Accept + evidence
- AGENTS.md mandates superpowers pipeline (brainstorming → plan → TDD → review)
  for every ROADMAP item
