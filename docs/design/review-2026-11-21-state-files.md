# Review 2026-11-21: a truncated state file stops the server from starting, and every save can truncate one

Review mode, unattended: `ROADMAP.md` has no open `[ ]` item. The 2026-11-20 run's
"Still open" list ranks this item (a) first; two independent judges (opus, sonnet) agreed on that order
then, and nothing in the code has changed it. Re-verified in the code and reproduced (below).

## Problem 1: one damaged state file and the server never starts again

`server/lib/state.js` reads `accounts.json`, `account.json` (legacy), `scheduled.json` and
`rules.json` at import with a bare `JSON.parse(fs.readFileSync(...))`. Only `rule-cursors.json`
is guarded. A file that is empty, cut short or not JSON throws while the module loads, so
`node server/index.js` and the desktop app's bundled backend exit before they listen, and every
start after that does the same until the user finds the data directory
(`~/.local/share/leoposta`) and deletes or repairs the file by hand. A file that is valid JSON of the
wrong shape (`null`, `{}`, an array holding `null`) loads, then `state.accounts.find(...)` or
`state.scheduledMessages.filter(...)` throws on the first request or the first 30 s scheduler tick.

## Problem 2: nothing makes a save atomic

`saveAccounts`, `saveScheduled`, `saveRules`, `saveRuleCursors` and `setRememberedAccount` call
`fs.writeFileSync(file, ...)`, which truncates the file and then writes it. A kill, a power loss,
a crash or a full disk (`ENOSPC`) between the two leaves a truncated file, which is exactly the input
of Problem 1. The desktop shell stops the backend when the window closes, and a scheduled send
rewrites the whole `scheduled.json` on every status change, so the window is not small. `lib/pgp.js`
already writes its private keys through a temp file and a rename (`writePrivate`), so the repository
has the right pattern in one place only.

## Decision

- New `server/lib/jsonFile.js` (no dependencies besides `node:fs` and `node:path`):
  - `writeFileAtomic(file, text, { mode, fs })`: resolves a symlink first (a state file kept in a
    dotfiles repo stays a symlink and its target is replaced), writes `<target>.<pid>.tmp` with the
    mode, `fsync`s it, renames it over the target, then `fsync`s the directory on a best-effort basis (not
    possible on Windows). On any failure the temp file is removed and the original error is thrown,
    so the old file is untouched. The `fs` option exists so a test can make the write fail half way.
  - `readJsonFile(file, { fallback, isValid, label, fs })`: no file gives `fallback`. A file that is
    not JSON, or whose parsed value fails `isValid`, is **moved aside** to `<file>.corrupt-<UTC time>` (never
    deleted, mode kept, so a password in it stays 0600) and `fallback` is returned, with one line on
    stderr that names the file and where it went but **not** the parser's message (Node 22 quotes the
    start of the text in it, and this text holds passwords). Any other read error (`EACCES`, `EISDIR`, `EIO`) is
    rethrown unchanged: moving a file aside because it could not be read this time would replace it
    with an empty list at the next save.
- `state.js` uses both for accounts, the legacy account, scheduled mail and rules (shape checks: a
  non-null array of non-null objects, `rules` the same), and `writeFileAtomic` for the five writers.
  Exports and behaviour for a healthy file stay the same, including mode `0o600`.

## Why not

- A `.bak` copy of the last good file: atomic writes remove the way this program itself corrupts a
  file, and the quarantined copy is the recovery path for a file damaged from outside. A second
  copy of a file with passwords in it is not free.
- Repair (best-effort parse of a truncated file): guesses at user data; the moved-aside file is
  there for a human.
- Telling the UI that a file was set aside: needs an API and a banner; recorded as open. The
  user sees the setup screen (accounts) or an empty list and the log line, where today they see a
  server that does not start.
- `lib/pgp.js` (`writePrivate` is atomic without `fsync`, the public key file is not atomic): left
  alone to keep this change reviewable; recorded as open.

## Assumptions (nobody to ask)

- Quarantining beats refusing to start: the data stays on disk and the app comes up.
- `fsync` costs a few milliseconds per save; saves are rare (account edits, scheduler status
  changes) and `scheduled.json` is small.
- One server process uses a data directory at a time apart from dev tooling; the pid in the temp
  name keeps two writers from sharing a temp file.

## Changes after the independent reviews (opus, sonnet; no Critical)

- Quarantined and temp files hold passwords: `server/*.corrupt-*` and `server/*.tmp` are git- and
  docker-ignored and the README says to delete a `.corrupt-*` copy once recovered.
- `rules.json` only has to be a list (the engine skips entries that are not rules), and
  `rule-cursors.json` has to be an object (a wrong type is ignored, as a parse error already was).
- A damaged `accounts.json` does not fall through to an old `account.json`.
- `writeFileAtomic` removes a leftover temp file and creates its own exclusively with an exact mode
  (a leftover could lend its mode, or as a symlink its target), follows a link that points nowhere,
  tolerates a file system that rejects `fsync` (`EINVAL`, `ENOTSUP`, `ENOSYS`), and throws on a write that
  makes no progress. Where a temp file cannot be created or renamed (`EBUSY`, `EXDEV`, `EACCES`,
  `EPERM`, `EROFS`: a single file mounted into a container, a read-only directory around a writable
  file) it writes the file in place, as `writeFileSync` did, so a save that worked before still works.
- A damaged file behind a link is set aside where it lives, so the link stays for the next save.
- Temp files of dead processes are removed at start (`removeStaleTempFiles`).
- Left open: telling the user (a banner), the read-then-rename race of two processes on one data
  directory, a rename that Windows refuses while a scanner holds the file (the in-place fallback
  covers `EPERM` and `EBUSY`).
