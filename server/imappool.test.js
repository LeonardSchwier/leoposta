// The per-account pool must reuse its logged-in connection. It checked
// `client.user`, which ImapFlow does not have: every command opened a new
// IMAP connection and never closed the old one, until the server refused
// more ("Maximum number of connections from user+IP exceeded").
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'

const { getPoolFor, dropPool } = await import('./lib/imap.js')

/** Minimal IMAP server: accepts LOGIN, answers NOOP/LOGOUT, counts connections. */
async function fakeImap() {
  const box = { exists: 1 }
  let connections = 0
  let open = 0
  const sockets = new Set()
  const server = net.createServer((sock) => {
    connections++; open++
    sockets.add(sock)
    sock.on('close', () => { open-- })
    sock.write('* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] ready\r\n')
    let buf = ''
    sock.on('data', (d) => {
      buf += d.toString()
      let i
      while ((i = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2)
        const [tag, cmd] = line.split(' ')
        const c = (cmd || '').toUpperCase()
        if (c === 'CAPABILITY') sock.write('* CAPABILITY IMAP4rev1 AUTH=PLAIN\r\n' + `${tag} OK done\r\n`)
        else if (c === 'LOGIN') sock.write(`${tag} OK [CAPABILITY IMAP4rev1] logged in\r\n`)
        else if (c === 'SELECT' || c === 'EXAMINE') sock.write(`* ${box.exists} EXISTS\r\n* OK [UIDVALIDITY 1] ok\r\n* OK [UIDNEXT 100] ok\r\n${tag} OK [READ-WRITE] selected\r\n`)
        else if (c === 'NOOP') sock.write(`* ${box.exists} EXISTS\r\n${tag} OK done\r\n`)
        else if (c === 'LOGOUT') { sock.write(`* BYE\r\n${tag} OK bye\r\n`); sock.end() }
        else if (tag) sock.write(`${tag} OK done\r\n`)
      }
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { port: server.address().port, box, stats: () => ({ connections, open }), close: () => { for (const s of sockets) s.destroy(); return new Promise((r) => server.close(r)) } }
}

test('pool: many commands share one IMAP connection', async () => {
  const srv = await fakeImap()
  const acct = { email: 'pool@example.test', imapHost: '127.0.0.1', imapPort: srv.port, imapTls: false, imapUser: 'pool@example.test', imapPass: 'p' }
  try {
    const pool = getPoolFor(acct)
    for (let i = 0; i < 5; i++) await pool.run(async (c) => c.noop())
    await Promise.all([1, 2, 3].map(() => pool.run(async (c) => c.noop())))
    assert.equal(srv.stats().connections, 1)
  } finally {
    dropPool(acct.email)
    await new Promise((r) => setTimeout(r, 100))
    await srv.close()
  }
})

test('pool: a reused connection sees mail added by another client (fresh EXISTS)', async () => {
  const srv = await fakeImap()
  const acct = { email: 'pool2@example.test', imapHost: '127.0.0.1', imapPort: srv.port, imapTls: false, imapUser: 'pool2@example.test', imapPass: 'p' }
  try {
    const pool = getPoolFor(acct)
    const count = () => pool.run(async (c) => {
      const lock = await c.getMailboxLock('INBOX')
      try { return c.mailbox.exists } finally { lock.release() }
    })
    assert.equal(await count(), 1)
    srv.box.exists = 3 // another client appended two messages
    assert.equal(await count(), 3)
    assert.equal(srv.stats().connections, 1)
  } finally {
    dropPool(acct.email)
    await new Promise((r) => setTimeout(r, 100))
    await srv.close()
  }
})
