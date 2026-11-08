# Contributing

## Setup

```bash
npm ci
npx playwright install chromium   # only for end-to-end tests
```

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
