import nodeFs from 'node:fs'
import path from 'node:path'

/**
 * Crash-safe reading and writing of the small JSON state files (accounts,
 * scheduled mail, rules). See docs/design/review-2026-11-21-state-files.md.
 */

/** Write all of `text`; `fs.writeSync` may stop short of the whole buffer. */
function writeAll(fs, fd, text) {
  const buf = Buffer.from(text, 'utf-8')
  let done = 0
  while (done < buf.length) {
    const n = fs.writeSync(fd, buf, done, buf.length - done)
    if (!(n > 0)) throw new Error('write made no progress')
    done += n
  }
}

/**
 * Where a write to `file` ends up: the file itself, or, when it is a symbolic link,
 * the end of the chain, also when that end does not exist yet (a state file kept in
 * a dotfiles repository). Not `realpath`, which fails on a link that points nowhere.
 */
export function resolveLink(file, fs = nodeFs) {
  let current = file
  for (let hops = 0; hops < 16; hops += 1) {
    let stat
    try { stat = fs.lstatSync(current) } catch { return current }
    if (!stat.isSymbolicLink()) return current
    current = path.resolve(path.dirname(current), fs.readlinkSync(current))
  }
  return file
}

// Errors that mean "no temp file and rename here, but writing the file itself may work":
// a single file bind-mounted into a container (EBUSY), another device (EXDEV), a directory
// that is read-only while the file is writable (EACCES, EPERM, EROFS).
const NO_REPLACE = new Set(['EBUSY', 'EXDEV', 'EACCES', 'EPERM', 'EROFS'])
// Some file systems (FUSE, network) cannot fsync; the data is written all the same.
const NO_FSYNC = new Set(['EINVAL', 'ENOTSUP', 'ENOSYS'])

/**
 * Replace `file` with `text` so that it is always either the old or the new
 * content, never a mix: write a temp file next to it (same file system), fsync it,
 * rename it over the target. A crash, a kill or a full disk part way leaves the
 * old file untouched; on a failure the temp file is removed and the error thrown.
 * A symbolic link is followed (see `resolveLink`), so a state file kept elsewhere
 * stays a link and its target is the file that gets replaced. Where a temp file cannot
 * be created or renamed into place (NO_REPLACE above) the file is written in place, as
 * `fs.writeFileSync` always did: not atomic, but not a failed save either. The `fs`
 * option is for tests.
 */
export function writeFileAtomic(file, text, { mode = 0o600, fs = nodeFs } = {}) {
  const target = resolveLink(file, fs)
  // The pid keeps two processes on one data directory from sharing a temp file.
  const tmp = `${target}.${process.pid}.tmp`
  let fd
  try {
    // A leftover with this name (a killed process, a reused pid) must not lend its mode or
    // its link to the new file: remove it and create the file exclusively.
    try { fs.unlinkSync(tmp) } catch (err) { if (!err || err.code !== 'ENOENT') throw err }
    fd = fs.openSync(tmp, 'wx', mode)
    fs.fchmodSync(fd, mode) // the umask only ever removes bits; this makes the mode exact
    writeAll(fs, fd, text)
    try { fs.fsyncSync(fd) } catch (err) { if (!err || !NO_FSYNC.has(err.code)) throw err }
    fs.closeSync(fd)
    fd = undefined
    fs.renameSync(tmp, target)
  } catch (err) {
    if (fd !== undefined) { try { fs.closeSync(fd) } catch { /* the original error matters */ } }
    try { fs.unlinkSync(tmp) } catch { /* nothing left to remove */ }
    if (err && NO_REPLACE.has(err.code)) {
      fs.writeFileSync(target, text, { mode })
      return
    }
    throw err
  }
  // Make the rename itself durable. Best effort: a directory cannot be opened on Windows.
  try {
    const dir = fs.openSync(path.dirname(target), 'r')
    try { fs.fsyncSync(dir) } finally { fs.closeSync(dir) }
  } catch { /* durability of the rename is a bonus, the data is already in place */ }
}

/**
 * Delete temp files that a killed process left beside a state file
 * (`<name>.<pid>.tmp`, with the whole file, passwords included, in it). One whose pid is
 * a live process is left alone, it may be another server on this directory mid-save.
 */
export function removeStaleTempFiles(dir, names, { fs = nodeFs, isAlive = pidIsAlive } = {}) {
  let entries
  try { entries = fs.readdirSync(dir) } catch { return 0 }
  let removed = 0
  for (const entry of entries) {
    const m = /^(.+)\.(\d+)\.tmp$/.exec(entry)
    if (!m || !names.includes(m[1])) continue
    if (isAlive(Number(m[2]))) continue
    try { fs.unlinkSync(path.join(dir, entry)); removed += 1 } catch { /* not ours to remove */ }
  }
  return removed
}

function pidIsAlive(pid) {
  if (pid === process.pid) return true
  try { process.kill(pid, 0); return true } catch (err) { return !!err && err.code === 'EPERM' }
}

const stamp = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')

/** A free `<file>.corrupt-<UTC time>` name (a counter is added when the second is taken). */
function asideName(fs, file) {
  const base = `${file}.corrupt-${stamp(new Date())}`
  let name = base
  for (let n = 2; fs.existsSync(name); n += 1) name = `${base}-${n}`
  return name
}

/**
 * Read and parse a JSON state file.
 * - no file: `fallback`.
 * - a file that is not JSON, or whose value `isValid` rejects: moved aside to
 *   `<file>.corrupt-<time>` (never deleted, so a person can recover it, and its mode
 *   stays, so a password in it stays private) and `fallback` returned, with one
 *   line to `log` that names the file and where it went. The parser's own message is
 *   left out on purpose: Node quotes the start of the text, and this text holds passwords.
 * - any other read error (EACCES, EISDIR, EIO ...) is thrown as it is. Moving a file
 *   aside because it could not be read right now would replace its data with
 *   `fallback` at the next save.
 * Callers that mutate the result should pass a fresh `fallback` each time.
 */
export function readJsonFile(file, { fallback, isValid = () => true, label = path.basename(file), log = console.error, fs = nodeFs } = {}) {
  let text
  try {
    text = fs.readFileSync(file, 'utf-8')
  } catch (err) {
    if (err && err.code === 'ENOENT') return fallback
    throw err
  }
  let ok = false
  let value
  try {
    // A byte order mark (an editor on Windows adds one) is not part of the JSON text.
    value = JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text)
    ok = isValid(value)
  } catch { ok = false }
  if (ok) return value
  // A link is left where it is and the file it points to is the one set aside, so the next
  // save writes to the same place again.
  const real = resolveLink(file, fs)
  const aside = asideName(fs, real)
  fs.renameSync(real, aside)
  log(`${label} is damaged (not valid JSON or not the expected shape) and was moved to ${aside}; starting without it.`)
  return fallback
}
