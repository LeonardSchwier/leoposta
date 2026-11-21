import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeFileAtomic, readJsonFile, removeStaleTempFiles, resolveLink } from './jsonFile.js'

const made = []
function tmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leoposta-jsonfile-'))
  made.push(dir)
  return dir
}
after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }) })
const names = (dir) => fs.readdirSync(dir).sort()
const isArrayOfObjects = (v) => Array.isArray(v) && v.every((x) => x && typeof x === 'object' && !Array.isArray(x))

// ── writeFileAtomic ──────────────────────────────────────────────────────────

test('writeFileAtomic: creates the file with the requested mode and leaves no temp file', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'a.json')
  writeFileAtomic(file, '{"a":1}', { mode: 0o600 })
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}')
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.deepEqual(names(dir), ['a.json'])
})

test('writeFileAtomic: the mode is exactly the one asked for, whatever the umask removes', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'a.json')
  writeFileAtomic(file, 'x', { mode: 0o664 })
  assert.equal(fs.statSync(file).mode & 0o777, 0o664)
})

test('writeFileAtomic: replaces an existing file, also one with a looser mode', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'a.json')
  fs.writeFileSync(file, 'old', { mode: 0o644 })
  writeFileAtomic(file, 'new', { mode: 0o600 })
  assert.equal(fs.readFileSync(file, 'utf8'), 'new')
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.deepEqual(names(dir), ['a.json'])
})

test('writeFileAtomic: a write that fails half way leaves the old file whole and removes the temp file', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'a.json')
  fs.writeFileSync(file, '{"old":true}')
  // The real fs, except that the data write dies after a few bytes, like a full disk.
  const failing = {
    ...fs,
    writeSync(fd, data, ...rest) {
      fs.writeSync(fd, Buffer.from(String(data)).subarray(0, 3))
      const err = new Error('ENOSPC: no space left on device, write')
      err.code = 'ENOSPC'
      throw err
    }
  }
  assert.throws(() => writeFileAtomic(file, '{"new":"data that is long enough"}', { mode: 0o600, fs: failing }), { code: 'ENOSPC' })
  assert.equal(fs.readFileSync(file, 'utf8'), '{"old":true}')
  assert.deepEqual(names(dir), ['a.json'])
})

test('writeFileAtomic: a failing rename leaves the old file whole and removes the temp file', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'a.json')
  fs.writeFileSync(file, '{"old":true}')
  const failing = {
    ...fs,
    renameSync() {
      const err = new Error('EIO: i/o error, rename')
      err.code = 'EIO'
      throw err
    }
  }
  assert.throws(() => writeFileAtomic(file, '{"new":true}', { fs: failing }), { code: 'EIO' })
  assert.equal(fs.readFileSync(file, 'utf8'), '{"old":true}')
  assert.deepEqual(names(dir), ['a.json'])
})

test('writeFileAtomic: a file that is a symlink stays a symlink and its target gets the data', () => {
  const dir = tmpDir()
  const real = path.join(dir, 'real', 'accounts.json')
  fs.mkdirSync(path.dirname(real))
  fs.writeFileSync(real, '[]')
  const link = path.join(dir, 'accounts.json')
  fs.symlinkSync(real, link)
  writeFileAtomic(link, '[1]', { mode: 0o600 })
  assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the link must not be replaced by a plain file')
  assert.equal(fs.readFileSync(real, 'utf8'), '[1]')
  assert.deepEqual(names(path.dirname(real)), ['accounts.json'])
})

test('writeFileAtomic: writes everything when the file system takes only a few bytes per call', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'a.json')
  const text = JSON.stringify({ list: Array.from({ length: 50 }, (_, i) => `entry ${i} with a bit of text`) })
  const trickling = {
    ...fs,
    writeSync(fd, buf, offset, length) { return fs.writeSync(fd, buf, offset, Math.min(7, length)) }
  }
  writeFileAtomic(file, text, { fs: trickling })
  assert.equal(fs.readFileSync(file, 'utf8'), text)
})

test('writeFileAtomic: the temp file is named after the process, so two writers do not share one', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'a.json')
  const seen = []
  const spying = { ...fs, openSync(p, ...rest) { seen.push(path.basename(String(p))); return fs.openSync(p, ...rest) } }
  writeFileAtomic(file, 'x', { fs: spying })
  const temps = seen.filter((n) => n.endsWith('.tmp'))
  assert.equal(temps.length, 1)
  assert.ok(temps[0].includes(String(process.pid)), temps[0])
})

// Where a temp file cannot be renamed into place the old way of writing still works, and a save
// that worked before must not start to fail (a single file bind-mounted into a container, a
// read-only directory around a writable file).
for (const code of ['EBUSY', 'EXDEV', 'EACCES', 'EPERM', 'EROFS']) {
  test(`writeFileAtomic: ${code} on the rename falls back to writing the file in place`, () => {
    const dir = tmpDir()
    const file = path.join(dir, 'a.json')
    fs.writeFileSync(file, '{"old":true}', { mode: 0o600 })
    const failing = { ...fs, renameSync() { const e = new Error(code); e.code = code; throw e } }
    writeFileAtomic(file, '{"new":true}', { fs: failing })
    assert.equal(fs.readFileSync(file, 'utf8'), '{"new":true}')
    assert.deepEqual(names(dir), ['a.json'], 'no temp file left')
  })
}

test('writeFileAtomic: a directory that does not allow a temp file falls back to writing in place', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'a.json')
  fs.writeFileSync(file, '{"old":true}')
  const failing = { ...fs, openSync(p, ...rest) { if (String(p).endsWith('.tmp')) { const e = new Error('EACCES'); e.code = 'EACCES'; throw e } return fs.openSync(p, ...rest) } }
  writeFileAtomic(file, '{"new":true}', { fs: failing })
  assert.equal(fs.readFileSync(file, 'utf8'), '{"new":true}')
})

test('writeFileAtomic: an error that is not about replacing (EIO while writing) is thrown, never retried in place', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'a.json')
  fs.writeFileSync(file, '{"old":true}')
  const failing = { ...fs, writeSync() { const e = new Error('EIO'); e.code = 'EIO'; throw e } }
  assert.throws(() => writeFileAtomic(file, '{"new":true}', { fs: failing }), { code: 'EIO' })
  assert.equal(fs.readFileSync(file, 'utf8'), '{"old":true}')
})

test('writeFileAtomic: the data and the directory are fsynced, and a file system that cannot fsync is tolerated', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'a.json')
  let calls = 0
  writeFileAtomic(file, 'x', { fs: { ...fs, fsyncSync(fd) { calls += 1; return fs.fsyncSync(fd) } } })
  assert.equal(calls, 2, 'once for the file, once for the directory')
  const unsupported = { ...fs, fsyncSync() { const e = new Error('EINVAL'); e.code = 'EINVAL'; throw e } }
  writeFileAtomic(file, 'y', { fs: unsupported })
  assert.equal(fs.readFileSync(file, 'utf8'), 'y')
  const broken = { ...fs, fsyncSync() { const e = new Error('EIO'); e.code = 'EIO'; throw e } }
  assert.throws(() => writeFileAtomic(file, 'z', { fs: broken }), { code: 'EIO' })
  assert.equal(fs.readFileSync(file, 'utf8'), 'y')
})

test('writeFileAtomic: a leftover temp file does not lend its mode, and a temp name that is a symlink is not followed', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'a.json')
  const stale = `${file}.${process.pid}.tmp`
  fs.writeFileSync(stale, 'stale', { mode: 0o644 })
  writeFileAtomic(file, 'fresh', { mode: 0o600 })
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.equal(fs.readFileSync(file, 'utf8'), 'fresh')

  const victim = path.join(dir, 'victim.txt')
  fs.writeFileSync(victim, 'keep me')
  fs.symlinkSync(victim, stale)
  writeFileAtomic(file, 'again', { mode: 0o600 })
  assert.equal(fs.readFileSync(victim, 'utf8'), 'keep me')
  assert.equal(fs.readFileSync(file, 'utf8'), 'again')
  assert.deepEqual(names(dir), ['a.json', 'victim.txt'])
})

test('writeFileAtomic: a write that makes no progress fails instead of looping', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'a.json')
  fs.writeFileSync(file, 'old')
  assert.throws(() => writeFileAtomic(file, 'new', { fs: { ...fs, writeSync() { return 0 } } }), /no progress/)
  assert.equal(fs.readFileSync(file, 'utf8'), 'old')
  assert.deepEqual(names(dir), ['a.json'])
})

test('writeFileAtomic: a link that points nowhere is followed and its target created', () => {
  const dir = tmpDir()
  const real = path.join(dir, 'dotfiles', 'accounts.json')
  fs.mkdirSync(path.dirname(real))
  const link = path.join(dir, 'accounts.json')
  fs.symlinkSync(path.join('dotfiles', 'accounts.json'), link) // relative, and the target is missing
  writeFileAtomic(link, '[1]', { mode: 0o600 })
  assert.ok(fs.lstatSync(link).isSymbolicLink())
  assert.equal(fs.readFileSync(real, 'utf8'), '[1]')
})

test('resolveLink: follows a chain, stops at a plain file and gives up on a loop', () => {
  const dir = tmpDir()
  const plain = path.join(dir, 'plain')
  fs.writeFileSync(plain, '')
  fs.symlinkSync('plain', path.join(dir, 'one'))
  fs.symlinkSync('one', path.join(dir, 'two'))
  assert.equal(resolveLink(path.join(dir, 'two')), plain)
  assert.equal(resolveLink(plain), plain)
  assert.equal(resolveLink(path.join(dir, 'missing')), path.join(dir, 'missing'))
  fs.symlinkSync('b', path.join(dir, 'a'))
  fs.symlinkSync('a', path.join(dir, 'b'))
  assert.equal(resolveLink(path.join(dir, 'a')), path.join(dir, 'a'))
})

// ── removeStaleTempFiles ─────────────────────────────────────────────────────

test('removeStaleTempFiles: removes the temp file of a dead process, keeps a live one and everything else', () => {
  const dir = tmpDir()
  const write = (n) => fs.writeFileSync(path.join(dir, n), 'x')
  for (const n of ['accounts.json.4242.tmp', 'accounts.json.4243.tmp', 'rules.json.4242.tmp', 'other.json.4242.tmp', 'accounts.json', 'accounts.json.corrupt-20261121T000000Z', 'accounts.json.4242.tmp.bak']) write(n)
  const removed = removeStaleTempFiles(dir, ['accounts.json', 'rules.json'], { isAlive: (pid) => pid === 4243 })
  assert.equal(removed, 2)
  assert.deepEqual(names(dir), ['accounts.json', 'accounts.json.4242.tmp.bak', 'accounts.json.4243.tmp', 'accounts.json.corrupt-20261121T000000Z', 'other.json.4242.tmp'])
})

test('removeStaleTempFiles: a missing directory is not an error', () => {
  assert.equal(removeStaleTempFiles(path.join(tmpDir(), 'nope'), ['accounts.json']), 0)
})

test('removeStaleTempFiles: this very process counts as alive', () => {
  const dir = tmpDir()
  fs.writeFileSync(path.join(dir, `accounts.json.${process.pid}.tmp`), 'x')
  assert.equal(removeStaleTempFiles(dir, ['accounts.json']), 0)
})

// ── readJsonFile ─────────────────────────────────────────────────────────────

test('readJsonFile: no file gives the fallback and creates nothing', () => {
  const dir = tmpDir()
  const out = readJsonFile(path.join(dir, 'nope.json'), { fallback: [] })
  assert.deepEqual(out, [])
  assert.deepEqual(names(dir), [])
})

test('readJsonFile: a healthy file is returned and left where it is', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'a.json')
  fs.writeFileSync(file, '[{"id":1}]')
  assert.deepEqual(readJsonFile(file, { fallback: [], isValid: isArrayOfObjects }), [{ id: 1 }])
  assert.deepEqual(names(dir), ['a.json'])
})

for (const [label, text] of [
  ['an empty file', ''],
  ['a truncated file', '[\n  {\n    "id": "acct-1",\n    "imapPass": "hunter2-secret'],
  ['not JSON at all', 'this is not json hunter2-secret'],
  ['only NUL bytes (a file system that lost the data after a crash)', '\0\0\0\0\0\0']
]) {
  test(`readJsonFile: ${label} is moved aside, not thrown on, and its text is not logged`, () => {
    const dir = tmpDir()
    const file = path.join(dir, 'accounts.json')
    fs.writeFileSync(file, text, { mode: 0o600 })
    const lines = []
    const out = readJsonFile(file, { fallback: [], label: 'accounts', log: (m) => lines.push(m) })
    assert.deepEqual(out, [])
    assert.ok(!fs.existsSync(file), 'the damaged file must not stay under its own name')
    const moved = names(dir)
    assert.equal(moved.length, 1)
    assert.match(moved[0], /^accounts\.json\.corrupt-\d{8}T\d{6}Z/)
    assert.equal(fs.readFileSync(path.join(dir, moved[0]), 'utf8'), text, 'nothing is lost')
    assert.equal(fs.statSync(path.join(dir, moved[0])).mode & 0o777, 0o600, 'a password in it stays private')
    assert.equal(lines.length, 1)
    assert.match(lines[0], /accounts/)
    assert.ok(lines[0].includes(moved[0]), 'the log says where the file went')
    assert.ok(!/hunter2|secret|[{\["]/.test(lines[0].replace(moved[0], '')), `the log must not quote the file or the parser: ${lines[0]}`)
  })
}

test('readJsonFile: valid JSON of the wrong shape is moved aside too', () => {
  for (const text of ['null', '{}', '42', '"x"', '[null]', '[1,2]', '[[]]']) {
    const dir = tmpDir()
    const file = path.join(dir, 'scheduled.json')
    fs.writeFileSync(file, text)
    const out = readJsonFile(file, { fallback: [], isValid: isArrayOfObjects, log: () => {} })
    assert.deepEqual(out, [], text)
    assert.ok(!fs.existsSync(file), text)
    assert.equal(names(dir).length, 1, text)
  }
})

test('readJsonFile: a file that starts with a UTF-8 byte order mark is read, not set aside', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'a.json')
  fs.writeFileSync(file, '\uFEFF[{"id":1}]')
  assert.deepEqual(readJsonFile(file, { fallback: [], isValid: isArrayOfObjects }), [{ id: 1 }])
  assert.deepEqual(names(dir), ['a.json'])
})

test('readJsonFile: the fallback is returned as given, so a caller can pass a fresh one each time', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'a.json')
  fs.writeFileSync(file, '{')
  const fallback = { cursors: true }
  assert.equal(readJsonFile(file, { fallback, log: () => {} }), fallback)
})

test('readJsonFile: two damaged files in the same second get two names, none overwrites another', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'rules.json')
  for (const n of [1, 2, 3]) {
    fs.writeFileSync(file, `{broken ${n}`)
    readJsonFile(file, { fallback: [], log: () => {} })
  }
  const moved = names(dir)
  assert.equal(moved.length, 3)
  assert.deepEqual(moved.map((m) => fs.readFileSync(path.join(dir, m), 'utf8')).sort(), ['{broken 1', '{broken 2', '{broken 3'])
})

test('readJsonFile: an error other than "not there" or "not JSON" is thrown, and the file stays', () => {
  // A directory where the file should be: readFileSync fails with EISDIR. Moving it aside would
  // hide a real problem (and, for a file that is only unreadable right now, replace its data with
  // the fallback at the next save).
  const dir = tmpDir()
  const file = path.join(dir, 'accounts.json')
  fs.mkdirSync(file)
  assert.throws(() => readJsonFile(file, { fallback: [], log: () => {} }), { code: 'EISDIR' })
  assert.ok(fs.statSync(file).isDirectory())
  assert.deepEqual(names(dir), ['accounts.json'])
})

test('readJsonFile: when the file cannot be moved, the error is thrown, not swallowed', () => {
  const dir = tmpDir()
  const file = path.join(dir, 'a.json')
  fs.writeFileSync(file, '{')
  const failing = { ...fs, renameSync() { const e = new Error('EACCES'); e.code = 'EACCES'; throw e } }
  assert.throws(() => readJsonFile(file, { fallback: [], fs: failing, log: () => {} }), { code: 'EACCES' })
  assert.equal(fs.readFileSync(file, 'utf8'), '{')
})

test('readJsonFile: a damaged file behind a link is set aside where it lives, and the link stays for the next save', () => {
  const dir = tmpDir()
  const real = path.join(dir, 'dotfiles', 'rules.json')
  fs.mkdirSync(path.dirname(real))
  fs.writeFileSync(real, '{broken')
  const link = path.join(dir, 'rules.json')
  fs.symlinkSync(real, link)
  assert.deepEqual(readJsonFile(link, { fallback: [], log: () => {} }), [])
  assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the link is not moved')
  assert.ok(!fs.existsSync(real))
  assert.equal(names(path.dirname(real)).length, 1)
  assert.match(names(path.dirname(real))[0], /^rules\.json\.corrupt-/)
  writeFileAtomic(link, '[]')
  assert.ok(fs.lstatSync(link).isSymbolicLink())
  assert.equal(fs.readFileSync(real, 'utf8'), '[]')
})
