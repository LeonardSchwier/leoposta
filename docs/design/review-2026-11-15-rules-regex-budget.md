# Review 2026-11-15: rule regexes can freeze the server; `PUT /api/rules` stores anything

Review mode, unattended (no open `[ ]` item in `ROADMAP.md`). The open pull request
\#12 (the owner's QA branch) rewrites most of `server/`, so this slice was chosen to
sit in files it barely touches: `server/lib/rules.js` `matchRule` (unchanged by that PR,
and the function its new `runRulesOnNewMail` also calls), `server/routes/rules.js`, and
new files.

## Problems (verified, not assumed)

1. **A rule with the `regex` operator can block the whole server.** `matchRule` runs
   `new RegExp(c.value, 'i').test(field)` on the main thread. A backtracking-prone pattern
   (`(a+)+$`, `(.*)*x`, `^(\w+\s?)+$`, all easy to write by accident) takes exponential
   time on the right input: on Node 22.23, `(a+)+$` against a 31-character subject
   blocks for 10 s once V8 has compiled the regex natively and for about 65 s in a
   fresh process (the first runs use the interpreter), and every added character
   doubles it. The server is a single
   Node process, so every API call, IDLE stream and scheduled send stalls with it. The
   tested text is the incoming mail's subject, sender, recipients or body, which the
   sender controls: one mail is enough to freeze the user's mail server for as long as
   the rule exists, and it re-runs on every list and search.
2. **`PUT /api/rules` stores any array.** `[null]`, a condition that is `null`, or a
   numeric `value` all pass the route, are written to `rules.json`, and then make the
   next `GET /api/messages` throw (`Cannot read properties of null (reading 'enabled')`,
   `(c.value || "").toLowerCase is not a function`), so the inbox list answers 500
   until the rules are fixed over the API. Nothing bounds the number of rules,
   conditions or the length of a pattern.

## Decisions

- **Bounded regex execution, no new dependency.** `server/lib/safeRegex.js` runs the
  match inside a reusable `node:vm` context with a 25 ms `timeout`. V8 aborts a runaway
  backtracking regex at that point (measured: `(a+)+$`, `(a|a)*$`, `(.*)*x`,
  `^(([a-z])+.)+[A-Z]([a-z])+$` and `a*a*a*a*b` on a 100 000-character text all abort at
  the budget; a normal pattern costs about 0.09 ms per call). Three limits, added after
  the independent review of the first version:
  1. a match that spends the budget counts as "no match";
  2. that message (pattern plus a digest of the exact text) is remembered for 5 minutes,
     so reloading the list does not pay again, while other mail the same rule matches is
     unaffected (a first version blacklisted the pattern, so one crafted mail switched
     the rule off for everyone until restart, and a GC pause or laptop sleep could do the
     same by accident);
  3. a pattern that never times out but costs 1 ms or more per message (a sender can
     size a subject to stay just under the budget; `GET /api/messages` allows 200 rows
     and each message is tried against every rule) is charged to a shared budget of
     250 ms per 2 s window. When it is spent, the remaining regex conditions of that
     window count as "no match" and one warning is logged. Calls under 1 ms are not
     charged, so ordinary rules never reach the cap.
  Rejected alternatives: a static "nested quantifier" check (misses `(a|a)*`, `(a|aa)+`
  and rejects safe patterns), the `re2` native module (new dependency that must build
  offline for the Tauri bundle), a worker thread per match (heavy, still needs a
  timeout).
- **Input and pattern caps.** The tested text is cut to its first 100 000 characters
  (so a legitimate pattern on a very large body stays well inside the budget; the list
  and search endpoints pass an empty body, so there it bounds subject, to and cc),
  patterns are limited to 256 characters. A match that would only occur after the first
  100 000 characters is not found. The limit is recorded in the changelog and the
  roadmap; the Rules tab text is not changed here because `Settings.svelte` is rewritten
  by #12.
- **Validate on save, tolerate on read.** `server/lib/ruleSchema.js` `validateRules`
  accepts only the shape the UI sends (`{ id?, enabled, conditions: [{ field, operator,
  value }], action: { type, value? } }`), at most 200 rules and 20 conditions per rule,
  value at most 500 characters, `action.value` at most 200, and for `regex` a pattern
  that compiles and is at most 256 characters. Rules saved before this check are
  tolerated rather than blocking the whole list: a missing or `null` `value` reads as
  empty, `enabled` is read as a truth value, and an `id` that is not short text is
  dropped. It returns normalised copies (unknown properties dropped) or a
  human-readable message naming the rule and condition, which the Rules tab already
  shows (`d.error`). The route answers 400 and keeps the stored rules untouched.
  `matchRule` also tolerates a `null` rule or condition and a non-string `value` (a
  rule that is not an object matches nothing), so a hand-edited `rules.json` cannot
  take the list down through that path.
- An invalid regex that is already stored keeps its old meaning: no match.
- Empty `value` and a `move` or `label` action without a value stay allowed (the engine
  ignores them), so no rule the UI could save before is refused now.

## Not changed (recorded)

- The Rules tab shows the 400 message in the banner at the top of the modal while the
  Save button is at the bottom, and the rule cards are not numbered although the message
  says "Rule 3, condition 2". Left for after #12 (it rewrites `Settings.svelte`).

- `applyRules` still filters with `r.enabled`; a `null` entry in a hand-edited
  `rules.json` still throws there. That function is deleted by #12, so it is left alone
  rather than guaranteeing a merge conflict. The route validation means the API can no
  longer write such a file.
- Other user-supplied regex entry points: none found (`grep -rn "new RegExp" server src`).
