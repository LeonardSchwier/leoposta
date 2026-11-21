// What the server does with damaged or half-written state files: it must start (the damaged file is
// set aside, never deleted), and a failed save must leave the previous file whole.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const STATE_URL = pathToFileURL(path.join(import.meta.dirname, 'lib', 'state.js')).href
const SECRET = 'hunter2-not-a-real-password'

const made = []
after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }) })

function dataDir(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leoposta-statefiles-'))
  made.push(dir)
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text, { mode: 0o600 })
  return dir
}

/** Import state.js in a fresh process, as the server does on start. */
function boot(dir) {
  const code = `
    const m = await import(${JSON.stringify(STATE_URL)})
    process.stdout.write(JSON.stringify({ accounts: m.state.accounts, scheduled: m.state.scheduledMessages, rules: m.state.rules, ruleCursors: m.state.ruleCursors }))
  `
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, LEOPOSTA_DATA_DIR: dir, LEOPOSTA_TOKEN: 'test-token' },
    encoding: 'utf8',
    timeout: 30000
  })
  return { ...run, state: run.status === 0 ? JSON.parse(run.stdout) : null }
}
const movedAside = (dir, base) => fs.readdirSync(dir).filter((n) => n.startsWith(`${base}.corrupt-`))

for (const [file, key] of [
  ['accounts.json', 'accounts'],
  ['scheduled.json', 'scheduled'],
  ['rules.json', 'rules']
]) {
  test(`${file}: a truncated file does not stop the server from starting; it is set aside intact`, () => {
    const damaged = `[\n  {\n    "id": "x",\n    "imapPass": "${SECRET}`
    const dir = dataDir({ [file]: damaged })
    const run = boot(dir)
    assert.equal(run.status, 0, `server must start, stderr: ${run.stderr.slice(0, 300)}`)
    assert.deepEqual(run.state[key], [])
    assert.ok(!fs.existsSync(path.join(dir, file)))
    const moved = movedAside(dir, file)
    assert.equal(moved.length, 1)
    assert.equal(fs.readFileSync(path.join(dir, moved[0]), 'utf8'), damaged)
    assert.ok(run.stderr.includes(moved[0]), 'the log names where the file went')
    assert.ok(!run.stderr.includes(SECRET) && !run.stdout.includes(SECRET), 'no secret from the file is printed')
  })

  test(`${file}: an empty file (what a crash during the write leaves) is set aside`, () => {
    const dir = dataDir({ [file]: '' })
    const run = boot(dir)
    assert.equal(run.status, 0, run.stderr.slice(0, 300))
    assert.deepEqual(run.state[key], [])
    assert.equal(movedAside(dir, file).length, 1)
  })

  test(`${file}: valid JSON of the wrong shape is set aside`, () => {
    // rules.json only has to be a list: the engine skips an entry that is not a rule.
    for (const text of file === 'rules.json' ? ['null', '{"a":1}', '42'] : ['null', '{"a":1}', '[null]', '[[]]']) {
      const dir = dataDir({ [file]: text })
      const run = boot(dir)
      assert.equal(run.status, 0, `${text}: ${run.stderr.slice(0, 300)}`)
      assert.deepEqual(run.state[key], [], text)
      assert.equal(movedAside(dir, file).length, 1, text)
    }
  })
}

test('healthy state files load as before and nothing is moved', () => {
  const accounts = [{ id: 'acct-1', email: 'erika@example.test', imapPass: SECRET }]
  const scheduled = [{ id: 's1', status: 'pending', subject: 'Hi', scheduled: '2030-01-01T00:00:00Z' }]
  const rules = [{ id: 'r1', enabled: true, when: [], do: [] }]
  const dir = dataDir({
    'accounts.json': JSON.stringify(accounts),
    'scheduled.json': JSON.stringify(scheduled),
    'rules.json': JSON.stringify(rules)
  })
  const run = boot(dir)
  assert.equal(run.status, 0, run.stderr.slice(0, 300))
  assert.deepEqual(run.state, { accounts, scheduled, rules, ruleCursors: {} })
  assert.deepEqual(fs.readdirSync(dir).sort(), ['accounts.json', 'rules.json', 'scheduled.json'])
  assert.doesNotMatch(run.stderr, /damaged|corrupt/)
})

test('a damaged legacy account.json is set aside and does not stop the server either', () => {
  const dir = dataDir({ 'account.json': `{"email": "erika@example.test", "imapPass": "${SECRET}` })
  const run = boot(dir)
  assert.equal(run.status, 0, run.stderr.slice(0, 300))
  assert.deepEqual(run.state.accounts, [])
  assert.equal(movedAside(dir, 'account.json').length, 1)
})

test('a healthy legacy account.json is still migrated', () => {
  const dir = dataDir({ 'account.json': JSON.stringify({ email: 'erika@example.test', imapHost: 'imap.example.test' }) })
  const run = boot(dir)
  assert.equal(run.status, 0, run.stderr.slice(0, 300))
  assert.equal(run.state.accounts.length, 1)
  assert.equal(run.state.accounts[0].email, 'erika@example.test')
  assert.ok(fs.existsSync(path.join(dir, 'accounts.json')))
  assert.ok(!fs.existsSync(path.join(dir, 'account.json')))
})

test('a file that cannot be read for another reason (a directory) still stops the start, loudly', () => {
  const dir = dataDir()
  fs.mkdirSync(path.join(dir, 'accounts.json'))
  const run = boot(dir)
  assert.notEqual(run.status, 0)
  assert.match(run.stderr, /EISDIR/)
  assert.ok(fs.statSync(path.join(dir, 'accounts.json')).isDirectory())
})

test('rules.json with a stray entry between rules is kept as it is: the engine skips what is not a rule', () => {
  const text = JSON.stringify([null, { id: 'r1', enabled: true, action: { type: 'flag' }, conditions: [] }, 5])
  const dir = dataDir({ 'rules.json': text })
  const run = boot(dir)
  assert.equal(run.status, 0, run.stderr.slice(0, 300))
  assert.equal(run.state.rules.length, 3)
  assert.deepEqual(fs.readdirSync(dir), ['rules.json'])
  assert.equal(fs.readFileSync(path.join(dir, 'rules.json'), 'utf8'), text)
})

test('a damaged accounts.json is not replaced by an old legacy account.json', () => {
  const legacy = JSON.stringify({ email: 'old@example.test', imapHost: 'imap.example.test' })
  const dir = dataDir({ 'accounts.json': '[{"id": "x"', 'account.json': legacy })
  const run = boot(dir)
  assert.equal(run.status, 0, run.stderr.slice(0, 300))
  assert.deepEqual(run.state.accounts, [])
  assert.equal(fs.readFileSync(path.join(dir, 'account.json'), 'utf8'), legacy, 'the legacy file is left alone')
  assert.equal(movedAside(dir, 'accounts.json').length, 1)
  assert.ok(!fs.existsSync(path.join(dir, 'accounts.json')))
})

test('rule-cursors.json that is valid JSON but not an object is ignored, so the INBOX list cannot throw on it', () => {
  for (const text of ['5', '"x"', 'true', '[1,2]', 'null', '{broken']) {
    const dir = dataDir({ 'rule-cursors.json': text })
    const run = boot(dir)
    assert.equal(run.status, 0, `${text}: ${run.stderr.slice(0, 300)}`)
    assert.deepEqual(run.state.ruleCursors, {}, text)
  }
  const dir = dataDir({ 'rule-cursors.json': '{"acct-1": 42}' })
  assert.deepEqual(boot(dir).state.ruleCursors, { 'acct-1': 42 })
})

test('a temp file that a killed process left behind is removed at start, one of a live process is not', () => {
  // The pid of a process that has exited.
  const dead = spawnSync(process.execPath, ['-e', '0']).pid
  const dir = dataDir({
    [`accounts.json.${dead}.tmp`]: `[{"imapPass": "${SECRET}"}]`,
    [`scheduled.json.${process.pid}.tmp`]: '[]' // this test process is alive
  })
  const run = boot(dir)
  assert.equal(run.status, 0, run.stderr.slice(0, 300))
  assert.deepEqual(fs.readdirSync(dir), [`scheduled.json.${process.pid}.tmp`])
})

// ── saves ────────────────────────────────────────────────────────────────────

const DIR = dataDir()
process.env.LEOPOSTA_DATA_DIR = DIR
process.env.LEOPOSTA_TOKEN = 'test-token'
const { state, saveAccounts, saveScheduled, saveRules, saveRuleCursors, setRememberedAccount } = await import('./lib/state.js')

const SAVERS = [
  ['accounts.json', () => saveAccounts(), () => { state.accounts = [{ id: 'a', email: 'new@example.test' }] }, '[{"id":"old"}]'],
  ['scheduled.json', () => saveScheduled(), () => { state.scheduledMessages = [{ id: 'new' }] }, '[{"id":"old"}]'],
  ['rules.json', () => saveRules(), () => { state.rules = [{ id: 'new' }] }, '[{"id":"old"}]'],
  ['rule-cursors.json', () => saveRuleCursors(), () => { state.ruleCursors = { a: 5 } }, '{"a":1}'],
  ['ui-state.json', () => setRememberedAccount('new@example.test'), () => {}, '{"activeAccount":"old@example.test"}']
]

for (const [file, save, change, oldText] of SAVERS) {
  test(`${file}: a save that fails leaves the previous file whole and no temp file behind`, () => {
    const target = path.join(DIR, file)
    fs.writeFileSync(target, oldText, { mode: 0o600 })
    change()
    const realRename = fs.renameSync
    fs.renameSync = () => { const e = new Error('ENOSPC: no space left on device, rename'); e.code = 'ENOSPC'; throw e }
    try {
      assert.throws(() => save(), { code: 'ENOSPC' })
    } finally {
      fs.renameSync = realRename
    }
    assert.equal(fs.readFileSync(target, 'utf8'), oldText)
    assert.deepEqual(fs.readdirSync(DIR).filter((n) => n.endsWith('.tmp')), [])
  })

  test(`${file}: a save that works replaces the file, keeps mode 0600 and leaves no temp file`, () => {
    const target = path.join(DIR, file)
    fs.writeFileSync(target, oldText, { mode: 0o644 })
    change()
    save()
    assert.notEqual(fs.readFileSync(target, 'utf8'), oldText)
    JSON.parse(fs.readFileSync(target, 'utf8'))
    assert.equal(fs.statSync(target).mode & 0o777, 0o600)
    assert.deepEqual(fs.readdirSync(DIR).filter((n) => n.endsWith('.tmp')), [])
  })
}
