# Plan: bound rule regexes, validate rules on save

Design: `docs/design/review-2026-11-15-rules-regex-budget.md`. Baseline (main 111b841,
Node 22.23.4): `npx vitest run` 152 pass (20 files), `npm run test:server` 218 pass,
`npm run typecheck` and `npm run build` clean (there is no `lint` script).

1. Tests first (all must fail on the old code):
   - `server/lib/safeRegex.test.js`: match / case-insensitive / invalid / over-long
     pattern / non-string input; `(a+)+$` on 31 characters returns false in under
     2 s (old code: 10 to 65 s); a repeat of the same message is near-instant while other
     mail still matches; the skip lapses after 5 minutes; 40 different slow messages stay
     under one shared 250 ms window budget; text beyond the cap is not searched.
   - `server/lib/rules.hardening.test.js`: `matchRule` with the catastrophic pattern
     finishes quickly and does not match; `null` rule, `null` condition, numeric
     `value`, non-array `conditions` do not throw.
   - `server/lib/ruleSchema.test.js`: a valid UI-shaped rule is accepted and
     normalised; each invalid shape is rejected with a message that names its place.
   - `server/rulesroute.test.js`: `PUT /api/rules` with `[null]`, a bad regex, 201 rules
     answers 400 and leaves the stored rules as they were; a valid body answers 200
     and `GET /api/rules` returns the normalised rules.
2. `server/lib/safeRegex.js`, then `server/lib/ruleSchema.js`.
3. `server/lib/rules.js` `matchRule` uses them; `server/routes/rules.js` validates.
4. Verify: `node --test "server/**/*.test.js"`, `npx vitest run`, `npm run typecheck`,
   `npm run build`. Record counts in `ROADMAP.md`.
5. Independent diff review (opus), fix Critical/High, rebase on origin/main, push.
