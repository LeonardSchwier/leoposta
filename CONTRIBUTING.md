# Contributing

## Setup

```bash
npm run setup     # npm ci + Playwright Chromium for the end-to-end tests
npm run check     # typecheck, unit, server tests and build (same as CI, without e2e)
```

Layout and data flow: [ARCHITECTURE.md](ARCHITECTURE.md). Terms: [glossary](docs/glossary.md).
Larger design choices get a short record in [docs/adr](docs/adr) (context, decision,
consequences), numbered in order.

## Checks (all must pass, CI runs the same)

```bash
npm run typecheck
npm test
npm run test:server
npm run build
npm run test:e2e
```

## Workflow

- Work is tracked in [ROADMAP.md](ROADMAP.md). Write the failing test first,
  then the code. Tick a roadmap item only after its verification command passes.
- Keep commits small with a conventional prefix (`feat`, `fix`, `docs`, `chore`).
- Colours and fonts come from `@leonardschwier/leoforma` tokens (`--ds-*`),
  never raw hex. Svelte components stay local.
- Use fictional data (`example.test` addresses) in tests, fixtures and screenshots.
- Regenerate README screenshots with `npm run screenshots`; keep each under 300 KB.
- Never commit secrets or real mail.
- Editor settings come from [.editorconfig](.editorconfig).
- Image changes: build with `docker build -t leoposta .` and run `scripts/container-smoke.sh leoposta`.
