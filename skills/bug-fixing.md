---
name: bug-fixing
description: How to fix a bug so it stays fixed, and how to hunt the bugs nobody reported yet.
---

# Fixing bugs (and the ones next to them)

The owner does not want to report bugs one by one. A reported bug is a sample
of a class. Fix the class.

## Reactive: a bug was reported

1. **Reproduce first, against the real stack.** Write the e2e journey in
   `tests/e2e-real/` that does what the user did and asserts what the user
   expected — on the screen *and* on the server (`mailbox.messages(...)`,
   `smtpLog()`). Run it and watch it fail for the reported reason.
2. **Find the root cause.** Read the logs (`.e2e-real/results/`, server
   stdout). Name the cause with file:line. "It works now" without a cause is
   not a fix.
3. **Add the narrow regression test** at the layer where the cause lives
   (vitest for `src/`, `node --test` for `server/`). Watch it fail.
4. **Fix the cause.** Not the symptom, not the test.
5. **Fix the siblings.** Search for the same pattern elsewhere (same API
   helper, same unencoded parameter, same missing `await`, same Svelte
   pattern) and fix every instance, each with a test.
6. Run the full gate in `skills/verification.md`.

## Proactive: nothing is reported

Pick the riskiest area that has no real-stack journey yet and write the
journeys a user would do there. Ranking: sending and drafts (user data leaves
the machine), message rendering (untrusted HTML), folders and actions (data
moves on the server), accounts and secrets, desktop shell.

## The crash-freedom questions

Answer each with evidence (a test or a traced call), not "should be fine":

- **Errors:** is every `await`, `fetch` and IMAP/SMTP call handled? Does the
  user see a clear message instead of a stuck spinner or a raw stack trace?
- **Inputs:** empty, huge, unicode, `#`/`&`/`+`/`/`/`.` in folder names,
  malformed MIME, missing headers, both IMAP delimiters.
- **Lifecycle:** do listeners, timers, IDLE connections and drags end on every
  exit path (unmount, folder switch, window blur, pointer released elsewhere)?
- **Concurrency:** double click, rapid folder/message switching — can a stale
  response overwrite newer state, or can an action run twice?
- **Engines:** does it work in WebKitGTK (desktop) as well as Chromium?
- **Partial failure:** if the server call fails halfway, is the user's text
  (a draft, a composed mail) still there?

A defect found with these questions is a bug to fix now, with a test.

## Done means

- The e2e journey and the narrow regression test both fail without the fix
  and pass with it.
- Siblings are fixed or listed in `ROADMAP.md` with a reproduction.
- The full gate is green and the PR names the commands and pass counts.
